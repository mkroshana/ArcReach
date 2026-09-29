import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getGlobalSettings } from '@/lib/settings';
import { applyEmailTracking } from '@/lib/emailTracking';
import { checkGlobalRateLimits } from '@/lib/rateLimits';
import { getSession } from '@/lib/session';
import { sendMessage, sendingDisabledReason, EmailConfigError, EmailSendError } from '@/lib/emailProvider';
import { findDirectSender } from '@/lib/senderOwnership';

export async function POST(req: NextRequest) {
  try {
    // Authorize the caller (consistent with all sibling routes; middleware also gates this).
    const session = await getSession();

    const body = await req.json();
    const { campaignId, senderAccountId, leadData, subject, bodyText } = body;

    if (!leadData || !leadData.email) {
      return NextResponse.json({ success: false, error: 'Recipient lead details are required.' }, { status: 400 });
    }

    // Check global outbound rate limits
    const rateCheck = await checkGlobalRateLimits();
    if (!rateCheck.allowed) {
      return NextResponse.json({ success: false, error: rateCheck.reason }, { status: 429 });
    }

    // 1. Fetch global settings from the database
    const settings = await getGlobalSettings();

    // 2. Fetch sender account if available
    let targetSenderAccountId = senderAccountId;
    if (campaignId) {
      const campaign = await prisma.campaign.findUnique({
        where: { id: campaignId },
        select: { userId: true, senderAccountId: true }
      });
      // Non-admins may only send inside their own campaigns; unknown IDs fail the same way
      if (session.role === 'ADMIN' && !campaign) {
        return NextResponse.json({ success: false, error: 'Campaign not found.' }, { status: 404 });
      }
      if (!campaign || (session.role !== 'ADMIN' && campaign.userId !== session.id)) {
        return NextResponse.json({ success: false, error: 'Campaign does not belong to you.' }, { status: 403 });
      }
      if (!targetSenderAccountId) {
        targetSenderAccountId = campaign.senderAccountId;
      }
    }

    // Non-admins may only send from their own mailboxes
    let activeSenderAccount = null;
    if (targetSenderAccountId) {
      const found = await findDirectSender(session, targetSenderAccountId);
      if ('error' in found) {
        return NextResponse.json({ success: false, error: found.error }, { status: found.status });
      }
      activeSenderAccount = found.account;
    }

    // 3. Only Azure Communication Services sends; refuse before any lead or dispatch is written
    const sendingDisabled = sendingDisabledReason(settings);
    if (sendingDisabled) {
      return NextResponse.json({ success: false, error: sendingDisabled }, { status: 409 });
    }
    const provider = settings?.activeProvider;

    const isHtml = bodyText ? /<[a-z][\s\S]*>/i.test(bodyText) : false;
    let baseBody = bodyText || '';
    if (isHtml && !baseBody.toLowerCase().includes('<html') && !baseBody.toLowerCase().includes('<body')) {
      baseBody = `<html><head><meta charset="utf-8"></head><body>${baseBody}</body></html>`;
    }

    // Fetch tracking preferences from campaign if available
    let trackOpens = true;
    let trackClicks = true;
    if (campaignId) {
      const campaign = await prisma.campaign.findUnique({
        where: { id: campaignId },
        select: { trackOpens: true, trackClicks: true }
      });
      if (campaign) {
        trackOpens = campaign.trackOpens;
        trackClicks = campaign.trackClicks;
      }
    }

    // Find or create lead record for dispatch tracking
    let lead = await prisma.lead.findUnique({
      where: { email: leadData.email }
    });
    if (!lead) {
      lead = await prisma.lead.create({
        data: {
          email: leadData.email,
          name: leadData.name || null,
          company: leadData.company || null,
        }
      });
    }

    // Create dispatch record FIRST to get dispatchId for tracking URLs
    const syntheticMessageId = `manual-${lead.id}-${Date.now()}`;
    const dispatch = await prisma.emailDispatch.create({
      data: {
        leadId: lead.id,
        campaignId: campaignId || null,
        senderAccountId: targetSenderAccountId || null,
        messageId: syntheticMessageId,
        subject: subject || 'Outreach from ArcReach',
        body: baseBody,
      }
    });

    // Apply self-hosted tracking (pixel + link rewriting + unsubscribe link)
    const finalBody = applyEmailTracking(baseBody, dispatch.id, isHtml, trackOpens, trackClicks, lead.id);

    if (provider === 'AZURE' && !activeSenderAccount) {
      return NextResponse.json({
        success: false,
        error: 'Active sender account is required to determine the from address for Azure Communication Services.'
      }, { status: 400 });
    }

    // For SMTP fallback without a sender account, synthesize one from global SMTP creds.
    const senderForSend = activeSenderAccount || {
      emailAddress: settings?.smtpUser || 'sender@arcreach.com',
      replyTo: null,
      name: 'ArcReach Outreach',
      smtpHost: null, smtpPort: null, smtpUser: null, smtpPass: null,
    };

    const finalSubject = subject || 'Outreach from ArcReach';

    try {
      const { providerMessageId } = await sendMessage(
        {
          to: leadData.email,
          subject: finalSubject,
          body: finalBody,
          isHtml,
          sender: senderForSend,
          fromName: activeSenderAccount ? undefined : 'ArcReach Outreach',
          trackOpens,
        },
        settings
      );

      await prisma.emailDispatch.update({
        where: { id: dispatch.id },
        data: {
          messageId: providerMessageId || syntheticMessageId,
          body: finalBody,
        }
      });

      return NextResponse.json({
        success: true,
        message: `Email successfully sent via ${provider === 'AZURE' ? 'Azure Communication Services' : 'SMTP'}.`,
        messageId: providerMessageId || syntheticMessageId,
      });
    } catch (err: any) {
      if (err instanceof EmailConfigError) {
        return NextResponse.json({ success: false, error: err.message }, { status: 400 });
      }
      if (err instanceof EmailSendError) {
        const label = provider === 'AZURE' ? 'Azure Communication Services' : 'SMTP';
        return NextResponse.json({
          success: false,
          error: `${label} failed to send email: ${err.message}`,
        }, { status: 550 });
      }
      throw err;
    }
  } catch (error: any) {
    console.error('Error sending email:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
