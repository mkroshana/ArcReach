import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

// The page is self-contained: inline styles and inline SVG only, no scripts,
// external resources, forms or framing.
const HTML_HEADERS = {
  'Content-Type': 'text/html',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

/**
 * GET /api/unsubscribe?id=<leadId>
 * 
 * Public endpoint (no auth required) that marks a lead as Unsubscribed
 * and pauses all their active campaign enrollments. The id of a lead merged
 * into another (a case variant of its email) resolves to the kept lead.
 * Returns a styled HTML confirmation page.
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const leadId = searchParams.get('id');

    if (!leadId) {
      return new NextResponse(renderPage('Invalid Request', 'No lead identifier was provided.', false), {
        status: 400,
        headers: HTML_HEADERS,
      });
    }

    const lead =
      (await prisma.lead.findUnique({ where: { id: leadId } })) ??
      (await prisma.leadAlias.findUnique({ where: { id: leadId }, select: { lead: true } }))?.lead;

    if (!lead) {
      return new NextResponse(renderPage('Not Found', 'We could not find your subscription record.', false), {
        status: 404,
        headers: HTML_HEADERS,
      });
    }

    // Idempotent — skip if already unsubscribed
    if (lead.status !== 'Unsubscribed') {
      await prisma.lead.update({
        where: { id: lead.id },
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
    }

    return new NextResponse(
      renderPage(
        'Unsubscribed Successfully',
        'has been removed from all future mailings. You will no longer receive emails from us.',
        true,
        lead.email
      ),
      {
        status: 200,
        headers: HTML_HEADERS,
      }
    );
  } catch (error: any) {
    console.error('[Unsubscribe] Error:', error);
    return new NextResponse(
      renderPage('Something Went Wrong', 'We were unable to process your unsubscribe request. Please try again later.', false),
      {
        status: 500,
        headers: HTML_HEADERS,
      }
    );
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

/**
 * Renders a self-contained styled HTML confirmation page. Every caller-supplied
 * value is HTML-escaped; `highlight` (e.g. the lead's email) is shown in bold
 * before the message.
 */
function renderPage(title: string, message: string, success: boolean, highlight?: string): string {
  const accentColor = success ? '#10b981' : '#ef4444';
  const icon = success
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="${accentColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`
    : `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="${accentColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`;

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
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h1>${escapeHtml(title)}</h1>
    <p>${highlight ? `<strong>${escapeHtml(highlight)}</strong> ` : ''}${escapeHtml(message)}</p>
  </div>
</body>
</html>`;
}
