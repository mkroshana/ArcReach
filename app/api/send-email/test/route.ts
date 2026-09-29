import { NextRequest, NextResponse } from 'next/server';
import { getGlobalSettings } from '@/lib/settings';
import { getSession } from '@/lib/session';
import { sendMessage, EmailConfigError, EmailSendError } from '@/lib/emailProvider';
import { findDirectSender } from '@/lib/senderOwnership';

/**
 * POST /api/send-email/test
 * 
 * Sends a test email from a specific sender account to the current user's email address.
 * Used to validate that SMTP credentials are correctly configured for an individual account.
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

    // Fetch global settings
    const settings = await getGlobalSettings();
    const provider = settings?.activeProvider || 'MOCK';

    // Build the test email content
    const recipientEmail = session.email;
    const senderDisplayName = senderAccount.name || 'ArcReach Sender';
    const now = new Date().toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' });

    const subject = `✅ ArcReach Test — ${senderAccount.emailAddress} is connected`;
    const bodyText = [
      `Hi ${session.name},`,
      '',
      `This is a test email sent from ArcReach to verify that the sender mailbox "${senderAccount.emailAddress}" is configured correctly and able to dispatch outbound emails.`,
      '',
      `Sender: ${senderAccount.emailAddress}`,
      `Display Name: ${senderDisplayName}`,
      `Provider: ${senderAccount.provider}`,
      `Sent At: ${now}`,
      '',
      'If you received this email, the SMTP connection for this sender account is working as expected.',
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
          fromName: senderDisplayName,
        },
        settings
      );

      const fallbackId = `mock-test-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const messageId = providerMessageId || (provider === 'MOCK' ? fallbackId : fallbackId);
      const label = provider === 'AZURE' ? ' via Azure Communication Services' : provider === 'MOCK' ? ' (Mock mode)' : '';

      return NextResponse.json({
        success: true,
        message: `Test email successfully sent${label} to ${recipientEmail}.`,
        messageId,
        recipient: recipientEmail,
      });
    } catch (err: any) {
      if (err instanceof EmailConfigError) {
        return NextResponse.json({ success: false, error: err.message }, { status: 400 });
      }
      if (err instanceof EmailSendError) {
        const label = provider === 'AZURE' ? 'Azure Communication Services' : 'SMTP';
        return NextResponse.json({
          success: false,
          error: `${label} failed to send: ${err.message}`,
        }, { status: 550 });
      }
      throw err;
    }
  } catch (error: any) {
    console.error('[Test Email Error]', error);
    return NextResponse.json({ success: false, error: error.message || 'Failed to send test email.' }, { status: 500 });
  }
}
