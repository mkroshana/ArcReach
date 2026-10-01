import { NextRequest, NextResponse } from 'next/server';
import type { Lead } from '@prisma/client';
import { prisma } from '@/lib/db';
import { leadEmailIn } from '@/lib/leadEmail';
import { suppressEmails } from '@/lib/suppression';
import { SEQUENCE_SEND, UNSUBSCRIBE_EVENT } from '@/lib/engagementMetrics';
import { verifyUnsubscribeToken } from '@/lib/unsubscribeLink';

// The page is self-contained: inline styles and inline SVG only, no scripts,
// external resources or framing. Its one form posts back to this endpoint.
const HTML_HEADERS = {
  'Content-Type': 'text/html',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

/**
 * The lead id a link names, the dispatch it was sent in (null for the raw lead
 * id of links sent before tokens) and the query that names them again: a
 * signed token (lib/unsubscribeLink), or the raw lead id. 'missing' when the
 * link names neither, 'invalid' when its token is not one this app signed.
 */
function linkTarget(req: NextRequest): { leadId: string; dispatchId: string | null; query: string } | 'missing' | 'invalid' {
  const { searchParams } = new URL(req.url);
  const token = searchParams.get('token');
  if (token) {
    const signed = verifyUnsubscribeToken(token);
    return signed
      ? { leadId: signed.leadId, dispatchId: signed.dispatchId, query: `token=${encodeURIComponent(token)}` }
      : 'invalid';
  }
  const leadId = searchParams.get('id');
  return leadId ? { leadId, dispatchId: null, query: `id=${encodeURIComponent(leadId)}` } : 'missing';
}

/**
 * Records the unsubscribe on the email it came from, where the Unsubscribed
 * metrics count it by that email's campaign and the time it happened
 * (lib/engagementMetrics): the dispatch a signed link names, or for a link
 * sent before tokens, the lead's latest campaign email. Nothing when that
 * email no longer exists.
 */
async function recordUnsubscribeEvent(leadId: string, dispatchId: string | null): Promise<void> {
  const dispatch = dispatchId
    ? await prisma.emailDispatch.findUnique({ where: { id: dispatchId }, select: { messageId: true } })
    : await prisma.emailDispatch.findFirst({
        where: { leadId, status: 'Sent', ...SEQUENCE_SEND },
        orderBy: { sentAt: 'desc' },
        select: { messageId: true },
      });
  if (!dispatch) return;
  await prisma.emailEvent.create({ data: { messageId: dispatch.messageId, eventType: UNSUBSCRIBE_EVENT } });
}

/**
 * The lead a link's lead id names and its address, or null when there is
 * none. The id of a lead merged into another (a case variant of its email)
 * resolves to the kept lead. The id of a deleted lead that was emailed
 * resolves to the address it had (lib/leadDelete), and to the lead imported
 * again for that address, if there is one.
 */
async function findSubscriber(leadId: string): Promise<{ lead: Lead | null; email: string } | null> {
  let lead =
    (await prisma.lead.findUnique({ where: { id: leadId } })) ??
    (await prisma.leadAlias.findUnique({ where: { id: leadId }, select: { lead: true } }))?.lead ??
    null;

  const deletedEmail = lead ? null : (await prisma.deletedLead.findUnique({ where: { id: leadId } }))?.email ?? null;
  if (deletedEmail) {
    lead = await prisma.lead.findFirst({ where: leadEmailIn([deletedEmail]) });
  }
  const email = lead?.email ?? deletedEmail;
  return email ? { lead, email } : null;
}

/** The error page for a link that names no lead, or whose lead or address cannot be found. */
function linkError(target: 'missing' | 'invalid' | 'not-found'): NextResponse {
  const [status, title, message] =
    target === 'missing'
      ? [400, 'Invalid Request', 'No lead identifier was provided.']
      : target === 'invalid'
        ? [400, 'Invalid Link', 'This unsubscribe link is incomplete or was not issued by us.']
        : [404, 'Not Found', 'We could not find your subscription record.'];
  return new NextResponse(renderPage(title, message, 'error'), { status, headers: HTML_HEADERS });
}

function serverError(error: unknown): NextResponse {
  console.error('[Unsubscribe] Error:', error);
  return new NextResponse(
    renderPage('Something Went Wrong', 'We were unable to process your unsubscribe request. Please try again later.', 'error'),
    {
      status: 500,
      headers: HTML_HEADERS,
    }
  );
}

/**
 * GET /api/unsubscribe?token=<token>  (links sent before tokens: ?id=<leadId>)
 *
 * Public endpoint (no auth required). Shows a confirmation page whose button
 * POSTs back here, and changes nothing: mail-security gateways fetch every link
 * in an email, and that must not unsubscribe the recipient.
 */
export async function GET(req: NextRequest) {
  try {
    const target = linkTarget(req);
    if (typeof target === 'string') return linkError(target);

    const subscriber = await findSubscriber(target.leadId);
    if (!subscriber) return linkError('not-found');

    return new NextResponse(
      renderPage(
        'Confirm Unsubscribe',
        'will stop receiving our emails once you confirm below.',
        'confirm',
        subscriber.email,
        `/api/unsubscribe?${target.query}`
      ),
      {
        status: 200,
        headers: HTML_HEADERS,
      }
    );
  } catch (error: any) {
    return serverError(error);
  }
}

/**
 * POST /api/unsubscribe?token=<token>  (links sent before tokens: ?id=<leadId>)
 *
 * Public endpoint (no auth required) that puts the lead's address on the
 * suppression list, marks the lead as Unsubscribed, pauses all their active
 * campaign enrollments and records the unsubscribe on the email it came from
 * (recordUnsubscribeEvent). Posted by the confirmation page's button, and by mail
 * clients' RFC 8058 one-click unsubscribe (body 'List-Unsubscribe=One-Click',
 * offered by the List-Unsubscribe-Post header of campaign emails); the body is
 * not needed, so either is accepted. A deleted lead's address still goes on
 * the suppression list, and a lead imported again for it is unsubscribed too.
 * Idempotent. Returns a styled HTML confirmation page.
 */
export async function POST(req: NextRequest) {
  try {
    const target = linkTarget(req);
    if (typeof target === 'string') return linkError(target);

    const subscriber = await findSubscriber(target.leadId);
    if (!subscriber) return linkError('not-found');
    const { lead, email } = subscriber;

    // The suppression list outlives the lead, so the opt-out holds even if the
    // lead is deleted and imported again. Also written for a lead already
    // Unsubscribed, which may predate the list.
    await suppressEmails(prisma, [{ email, reason: 'Unsubscribed' }], 'unsubscribe-link');

    // Idempotent — skip if already unsubscribed or the lead is gone
    if (lead && lead.status !== 'Unsubscribed') {
      // Changes the status only if it is still not Unsubscribed: of two POSTs
      // at once (the button and a mail client's one-click), Postgres re-checks
      // the status under the row lock, so only one of them changes it.
      const { count: changed } = await prisma.lead.updateMany({
        where: { id: lead.id, status: { not: 'Unsubscribed' } },
        data: { status: 'Unsubscribed' },
      });

      // Pause all active campaign enrollments for this lead
      await prisma.campaignEnrollment.updateMany({
        where: {
          leadId: lead.id,
          status: 'Active',
        },
        data: {
          status: 'Paused',
          nextActionDate: null,
        },
      });

      // Counted once, when the lead's status changes to Unsubscribed: a second
      // click, or a mail client's one-click POST after the button, records
      // nothing. Not when the address first goes on the list: one already
      // listed for another reason, such as a hard bounce, is not added again
      // but still opts out here. A metrics write never fails the unsubscribe
      // itself.
      if (changed > 0) {
        await recordUnsubscribeEvent(lead.id, target.dispatchId).catch((error) =>
          console.error('[Unsubscribe] Could not record the unsubscribe event:', error)
        );
      }
    }

    return new NextResponse(
      renderPage(
        'Unsubscribed Successfully',
        'has been removed from all future mailings. You will no longer receive emails from us.',
        'success',
        email
      ),
      {
        status: 200,
        headers: HTML_HEADERS,
      }
    );
  } catch (error: any) {
    return serverError(error);
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const ACCENT_COLORS = { confirm: '#2563eb', success: '#10b981', error: '#ef4444' };

/**
 * Renders a self-contained styled HTML page. Every caller-supplied value is
 * HTML-escaped; `highlight` (e.g. the lead's email) is shown in bold before the
 * message. A confirm page shows an Unsubscribe button that POSTs to `action`.
 */
function renderPage(
  title: string,
  message: string,
  variant: 'confirm' | 'success' | 'error',
  highlight?: string,
  action?: string
): string {
  const accentColor = ACCENT_COLORS[variant];
  const iconPaths = {
    confirm: '<path d="M22 13V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h9"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/><path d="m17 17 4 4"/><path d="m21 17-4 4"/>',
    success: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
    error: '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',
  }[variant];
  const icon = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="${accentColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${iconPaths}</svg>`;
  const form =
    variant === 'confirm' && action
      ? `\n    <form method="post" action="${escapeHtml(action)}"><button type="submit">Unsubscribe</button></form>`
      : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
      background: #0a0a0a;
      color: #e5e5e5;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      padding: 1rem;
    }
    .card {
      background: #171717;
      border: 1px solid #262626;
      border-radius: 16px;
      padding: 3rem 2.5rem;
      max-width: 480px;
      text-align: center;
      box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5);
    }
    .icon { margin-bottom: 1.5rem; }
    h1 {
      font-size: 1.5rem;
      font-weight: 700;
      margin-bottom: 0.75rem;
      color: #fafafa;
    }
    p {
      font-size: 0.95rem;
      line-height: 1.6;
      color: #a3a3a3;
    }
    p strong { color: #fafafa; }
    button {
      margin-top: 1.75rem;
      padding: 0.75rem 1.75rem;
      border: 0;
      border-radius: 10px;
      background: ${accentColor};
      color: #ffffff;
      font: inherit;
      font-weight: 600;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h1>${escapeHtml(title)}</h1>
    <p>${highlight ? `<strong>${escapeHtml(highlight)}</strong> ` : ''}${escapeHtml(message)}</p>${form}
  </div>
</body>
</html>`;
}
