import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import nodemailer from 'nodemailer';

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

    // Fetch the sender account
    const senderAccount = await prisma.senderAccount.findUnique({
      where: { id: senderAccountId },
    });

    if (!senderAccount) {
      return NextResponse.json({ success: false, error: 'Sender account not found.' }, { status: 404 });
    }

    // Fetch global settings
    const settings = await prisma.globalSettings.findFirst();
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

    // Handle MOCK provider
    if (provider === 'MOCK') {
      console.log(`[Test Email - Mock] From: ${senderAccount.emailAddress} → To: ${recipientEmail}`);
      return NextResponse.json({
        success: true,
        message: `Test email simulated (Mock mode). Would send from ${senderAccount.emailAddress} to ${recipientEmail}.`,
        messageId: `mock-test-${Date.now()}-${Math.random().toString(36).substring(7)}`,
        recipient: recipientEmail,
      });
    }

    // Handle AZURE provider
    if (provider === 'AZURE') {
      console.log(`[Test Email - Azure] From: ${senderAccount.emailAddress} → To: ${recipientEmail}`);
      return NextResponse.json({
        success: true,
        message: `Test email sent via Azure Communication Services (Simulated) to ${recipientEmail}.`,
        messageId: `azure-test-${Date.now()}-${Math.random().toString(36).substring(7)}`,
        recipient: recipientEmail,
      });
    }

    // SMTP-based delivery: prefer individual account credentials, fallback to global
    let smtpHost = settings?.smtpHost;
    let smtpPort = settings?.smtpPort || 587;
    let smtpUser = settings?.smtpUser;
    let smtpPass = settings?.smtpPass;

    if (senderAccount.smtpHost && senderAccount.smtpUser && senderAccount.smtpPass) {
      smtpHost = senderAccount.smtpHost;
      smtpPort = senderAccount.smtpPort || 587;
      smtpUser = senderAccount.smtpUser;
      smtpPass = senderAccount.smtpPass;
    }

    if (!smtpHost || !smtpUser || !smtpPass) {
      return NextResponse.json({
        success: false,
        error: 'SMTP configuration is missing. Please configure SMTP credentials for this sender account or set global SMTP settings.',
      }, { status: 400 });
    }

    // Send the real test email
    const portNum = Number(smtpPort) || 587;
    const transport = nodemailer.createTransport({
      host: smtpHost,
      port: portNum,
      secure: portNum === 465,
      auth: {
        user: smtpUser,
        pass: smtpPass,
      },
    });

    const info = await transport.sendMail({
      from: `"${senderDisplayName}" <${smtpUser}>`,
      to: recipientEmail,
      subject,
      text: bodyText,
    });

    console.log(`[Test Email - SMTP Success] Message ID: ${info.messageId} | From: ${senderAccount.emailAddress} → To: ${recipientEmail}`);

    return NextResponse.json({
      success: true,
      message: `Test email successfully sent to ${recipientEmail}.`,
      messageId: info.messageId,
      recipient: recipientEmail,
    });
  } catch (error: any) {
    console.error('[Test Email Error]', error);
    return NextResponse.json({ success: false, error: error.message || 'Failed to send test email.' }, { status: 500 });
  }
}
