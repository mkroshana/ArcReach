import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getGlobalSettings } from '@/lib/settings';
import { getSession } from '@/lib/session';
import { checkGlobalRateLimits } from '@/lib/rateLimits';
import { sendMessage, sendingDisabledReason } from '@/lib/emailProvider';
import { findDirectSender } from '@/lib/senderOwnership';

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    const body = await req.json();
    const { leadId, subject, body: replyBody, senderAccountId } = body;

    if (!leadId || typeof leadId !== 'string' || !replyBody) {
      return NextResponse.json({ error: 'leadId and body copy are required.' }, { status: 400 });
    }

    // Check global outbound rate limits
    const rateCheck = await checkGlobalRateLimits();
    if (!rateCheck.allowed) {
      return NextResponse.json({ error: rateCheck.reason }, { status: 429 });
    }

    // Fetch the lead's email address
    const lead = await prisma.lead.findUnique({
      where: { id: leadId },
      select: { email: true, name: true }
    });

    if (!lead) {
      return NextResponse.json({ error: 'Lead not found.' }, { status: 404 });
    }

    // Fetch global settings; only Azure Communication Services sends
    const settings = await getGlobalSettings();
    const sendingDisabled = sendingDisabledReason(settings);
    if (sendingDisabled) {
      return NextResponse.json({ error: sendingDisabled }, { status: 409 });
    }

    // Non-admins may only reply to leads that wrote to one of their own mailboxes
    if (session.role !== 'ADMIN') {
      const ownInbound = await prisma.inboundResponse.findFirst({
        where: { leadId, senderAccount: { userId: session.id } },
        select: { id: true }
      });
      if (!ownInbound) {
        return NextResponse.json({ error: 'This lead has not replied to any of your mailboxes.' }, { status: 403 });
      }
    }

    // Fetch the sender account if provided; non-admins may only use their own
    let senderAccount = null;
    let campaignId: string | null = null;
    if (senderAccountId) {
      const found = await findDirectSender(session, senderAccountId);
      if ('error' in found) {
        return NextResponse.json({ error: found.error }, { status: found.status });
      }
      senderAccount = found.account;

      // Attribute the reply to the campaign of the lead's latest reply on this mailbox
      const inbound = await prisma.inboundResponse.findFirst({
        where: { leadId, senderAccountId: senderAccount.id },
        orderBy: { receivedAt: 'desc' },
        select: { campaignId: true }
      });
      campaignId = inbound?.campaignId ?? null;
    }

    const senderName = senderAccount?.name || session.name || 'ArcReach';
    const senderEmail = senderAccount?.emailAddress || session.email;

    // Generate a fallback message ID; the provider's ID wins when available.
    const randomHex = Array.from({ length: 16 }, () => Math.random().toString(16)[2]).join('');
    const fallbackMessageId = `msg_${randomHex}@arcreach-relay.net`;

    // Build a sender shape compatible with sendMessage when no SenderAccount is selected.
    const senderForSend = senderAccount || {
      emailAddress: senderEmail,
      replyTo: null,
      name: senderName,
      smtpHost: null, smtpPort: null, smtpUser: null, smtpPass: null,
    };

    const { providerMessageId } = await sendMessage(
      {
        to: lead.email,
        subject: subject || 'Re: Outreach',
        body: replyBody,
        isHtml: false,
        sender: senderForSend,
        fromName: senderName,
      },
      settings
    );

    const messageId = providerMessageId || fallbackMessageId;

    // Create a dispatch record to trace this sent reply (the mailbox's caps count it)
    const dispatch = await prisma.emailDispatch.create({
      data: {
        leadId,
        campaignId,
        senderAccountId: senderAccount?.id ?? null,
        messageId,
        sentAt: new Date(),
        subject: subject || 'Re: Outreach',
        body: replyBody,
        // Recorded only after the provider accepted it.
        status: 'Sent'
      }
    });

    console.log(`[Outbound Reply Dispatch] SenderAccount: ${senderAccountId || 'Default'}, Lead: ${leadId}, Subject: ${subject}`);

    return NextResponse.json({ success: true, dispatch });
  } catch (error: any) {
    console.error('[Unibox Reply Error]', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
