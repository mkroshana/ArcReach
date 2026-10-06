import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getGlobalSettings } from '@/lib/settings';
import { getSession } from '@/lib/session';
import { UnauthorizedError, unauthorizedResponse } from '@/lib/sessionError';
import { checkGlobalRateLimits } from '@/lib/rateLimits';
import { sendMessage, sendingDisabledReason, EmailConfigError, EmailSendError } from '@/lib/emailProvider';
import { findDirectSender } from '@/lib/senderOwnership';
import { senderCapReachedReason } from '@/lib/sendEngine';
import { normalizeEmail } from '@/lib/leadEmail';

/**
 * POST /api/send-email/test
 * 
 * Sends a test email from a specific sender account to the current user's email address.
 * Used to validate that Azure Communication Services can send from an individual account.
 * The test counts toward the global rate limits and the mailbox's caps like any other send.
 */
export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    const body = await req.json();
    const { senderAccountId } = body;

    if (!senderAccountId) {
      return NextResponse.json({ success: false, error: 'Sender account ID is required.' }, { status: 400 });
    }

    // Fetch the sender account; non-admins may only test their own mailboxes
    const found = await findDirectSender(session, senderAccountId);
    if ('error' in found) {
      return NextResponse.json({ success: false, error: found.error }, { status: found.status });
    }
    const senderAccount = found.account;

    // Fetch global settings; only Azure Communication Services sends, so past
    // this check every send below goes through it
    const settings = await getGlobalSettings();
    const sendingDisabled = sendingDisabledReason(settings);
    if (sendingDisabled) {
      return NextResponse.json({ success: false, error: sendingDisabled }, { status: 409 });
    }

    // Check global outbound rate limits and the mailbox's own cap: its warmup ramp, and its daily
    // limit when no global rate limit is set
    const rateCheck = await checkGlobalRateLimits();
    if (!rateCheck.allowed) {
      return NextResponse.json({ success: false, error: rateCheck.reason }, { status: 429 });
    }
    const capReached = await senderCapReachedReason(senderAccount, new Date(), { minute: settings?.rateLimitMinute, hour: settings?.rateLimitHour });
    if (capReached) {
      return NextResponse.json({ success: false, error: capReached }, { status: 429 });
    }

    // Build the test email content. ACS takes the From name from the sender
    // username configured in Azure, so the mailbox name is only an internal label.
    const recipientEmail = normalizeEmail(session.email);
    const now = new Date().toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' });

    const subject = `ArcReach Test: ${senderAccount.emailAddress} is connected`;
    const bodyText = [
      `Hi ${session.name},`,
      '',
      `This is a test email sent from ArcReach to verify that the sender mailbox "${senderAccount.emailAddress}" is configured correctly and able to dispatch outbound emails.`,
      '',
      `Sender: ${senderAccount.emailAddress}`,
      `Internal Label: ${senderAccount.name || '(not set)'}`,
      'Provider: Azure Communication Services',
      `Sent At: ${now}`,
      '',
      'The From name on this email comes from the sender username configured in Azure Communication Services. The internal label is shown only in ArcReach.',
      '',
      'If you received this email, Azure Communication Services can send from this sender account as expected.',
      '',
      '— ArcReach Deliverability Engine',
    ].join('\n');

    try {
      const { providerMessageId } = await sendMessage(
        {
          to: recipientEmail,
          subject,
          body: bodyText,
          isHtml: false,
          sender: senderAccount,
        },
        settings
      );

      const fallbackId = `mock-test-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const messageId = providerMessageId || fallbackId;

      // Record the test (it has no lead or campaign) so the global rate limits
      // and the mailbox's caps count it
      await prisma.emailDispatch.create({
        data: {
          senderAccountId: senderAccount.id,
          messageId,
          sentAt: new Date(),
          subject,
          body: bodyText,
          // Recorded only after the provider accepted it.
          status: 'Sent',
        },
      });
      if (senderAccount.warmupEnabled) {
        await prisma.senderAccount.updateMany({
          where: { id: senderAccount.id },
          data: { warmupSent: { increment: 1 } },
        });
      }

      return NextResponse.json({
        success: true,
        message: `Test email successfully sent via Azure Communication Services to ${recipientEmail}.`,
        messageId,
        recipient: recipientEmail,
      });
    } catch (err: any) {
      if (err instanceof EmailConfigError) {
        return NextResponse.json({ success: false, error: err.message }, { status: 400 });
      }
      if (err instanceof EmailSendError) {
        return NextResponse.json({
          success: false,
          error: `Azure Communication Services failed to send: ${err.message}`,
        }, { status: 550 });
      }
      throw err;
    }
  } catch (error: any) {
    if (error instanceof UnauthorizedError) return unauthorizedResponse();
    console.error('[Test Email Error]', error);
    return NextResponse.json({ success: false, error: error.message || 'Failed to send test email.' }, { status: 500 });
  }
}
