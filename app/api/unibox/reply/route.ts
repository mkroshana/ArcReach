import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getGlobalSettings } from '@/lib/settings';
import { getSession } from '@/lib/session';
import { UnauthorizedError, unauthorizedResponse } from '@/lib/sessionError';
import { checkGlobalRateLimits } from '@/lib/rateLimits';
import { sendMessage, sendingDisabledReason } from '@/lib/emailProvider';
import { findDirectSender } from '@/lib/senderOwnership';
import { senderCapReachedReason } from '@/lib/sendEngine';
import { normalizeEmail } from '@/lib/leadEmail';
import { replyScope } from '@/lib/leadHistoryScope';
import { replySubject, replyThreadingHeaders } from '@/lib/replyThreading';

/**
 * POST /api/unibox/reply answers one of a lead's replies (`responseId`) with
 * `body` as plain text, from the mailbox `senderAccountId` names. It goes out
 * under "Re: " and the answered reply's subject, with In-Reply-To and
 * References naming that reply so the lead's mail client threads it, and is
 * recorded against the mailbox and the answered reply's campaign.
 */
export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    const body = await req.json();
    const { responseId, body: replyBody, senderAccountId } = body;

    if (!responseId || typeof responseId !== 'string' || !replyBody) {
      return NextResponse.json({ error: 'responseId and body copy are required.' }, { status: 400 });
    }

    // A reply always goes out from a mailbox, never from the caller's login address
    if (!senderAccountId) {
      return NextResponse.json({ error: 'senderAccountId is required: name the mailbox the reply is sent from.' }, { status: 400 });
    }

    // Check global outbound rate limits
    const rateCheck = await checkGlobalRateLimits();
    if (!rateCheck.allowed) {
      return NextResponse.json({ error: rateCheck.reason }, { status: 429 });
    }

    // The reply being answered, with its lead's address. Non-admins may only answer
    // replies that reached one of their own mailboxes; others fail like unknown IDs.
    const answered = await prisma.inboundResponse.findFirst({
      where: { id: responseId, ...replyScope(session) },
      select: {
        leadId: true, campaignId: true, subject: true, messageId: true, references: true,
        lead: { select: { email: true } }
      }
    });

    if (!answered) {
      return NextResponse.json({ error: 'Reply not found.' }, { status: 404 });
    }

    // Fetch global settings; only Azure Communication Services sends
    const settings = await getGlobalSettings();
    const sendingDisabled = sendingDisabledReason(settings);
    if (sendingDisabled) {
      return NextResponse.json({ error: sendingDisabled }, { status: 409 });
    }

    // The mailbox the reply goes out from; non-admins may only use their own
    const found = await findDirectSender(session, senderAccountId);
    if ('error' in found) {
      return NextResponse.json({ error: found.error }, { status: found.status });
    }
    const senderAccount = found.account;

    // A reply counts toward the mailbox's daily and warmup caps like any engine send
    const capReached = await senderCapReachedReason(senderAccount, new Date());
    if (capReached) {
      return NextResponse.json({ error: capReached }, { status: 429 });
    }

    const subject = replySubject(answered.subject);

    // Generate a fallback message ID; the provider's ID wins when available.
    const randomHex = Array.from({ length: 16 }, () => Math.random().toString(16)[2]).join('');
    const fallbackMessageId = `msg_${randomHex}@arcreach-relay.net`;

    const { providerMessageId } = await sendMessage(
      {
        to: normalizeEmail(answered.lead.email),
        subject,
        body: replyBody,
        isHtml: false,
        sender: senderAccount,
        // In-Reply-To and References thread it under the lead's message in their mail client
        headers: replyThreadingHeaders(answered),
      },
      settings
    );

    const messageId = providerMessageId || fallbackMessageId;

    // Create a dispatch record to trace this sent reply (the mailbox's caps count it)
    const dispatch = await prisma.emailDispatch.create({
      data: {
        leadId: answered.leadId,
        // The campaign of the reply it answers
        campaignId: answered.campaignId,
        senderAccountId: senderAccount.id,
        messageId,
        sentAt: new Date(),
        subject,
        body: replyBody,
        // Recorded only after the provider accepted it.
        status: 'Sent'
      }
    });

    // A warming mailbox's reply counts toward its ramp, as engine sends do
    if (senderAccount.warmupEnabled) {
      await prisma.senderAccount.updateMany({
        where: { id: senderAccount.id },
        data: { warmupSent: { increment: 1 } }
      });
    }

    console.log(`[Outbound Reply Dispatch] SenderAccount: ${senderAccount.id}, Lead: ${answered.leadId}, Subject: ${subject}`);

    return NextResponse.json({ success: true, dispatch });
  } catch (error: any) {
    if (error instanceof UnauthorizedError) return unauthorizedResponse();
    console.error('[Unibox Reply Error]', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
