import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { checkGlobalRateLimits } from '@/lib/rateLimits';
import { sendMessage } from '@/lib/emailProvider';

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    const body = await req.json();
    const { leadId, subject, body: replyBody, senderAccountId } = body;

    if (!leadId || !replyBody) {
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

    // Fetch global settings
    const settings = await prisma.globalSettings.findFirst();

    // Fetch the sender account if provided
    let senderAccount = null;
    if (senderAccountId) {
      senderAccount = await prisma.senderAccount.findUnique({
        where: { id: senderAccountId }
      });
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

    // Create a dispatch record to trace this sent reply
    const dispatch = await prisma.emailDispatch.create({
      data: {
        leadId,
        messageId,
        sentAt: new Date(),
        subject: subject || 'Re: Outreach',
        body: replyBody
      }
    });

    console.log(`[Outbound Reply Dispatch] SenderAccount: ${senderAccountId || 'Default'}, Lead: ${leadId}, Subject: ${subject}`);

    return NextResponse.json({ success: true, dispatch });
  } catch (error: any) {
    console.error('[Unibox Reply Error]', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
