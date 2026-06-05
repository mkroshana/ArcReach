import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import nodemailer from 'nodemailer';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { campaignId, senderAccountId, leadData, subject, bodyText } = body;

    if (!leadData || !leadData.email) {
      return NextResponse.json({ success: false, error: 'Recipient lead details are required.' }, { status: 400 });
    }

    // 1. Fetch global settings from the database
    const settings = await prisma.globalSettings.findFirst();

    // 2. Fetch sender account if available
    let targetSenderAccountId = senderAccountId;
    if (!targetSenderAccountId && campaignId) {
      const campaign = await prisma.campaign.findUnique({
        where: { id: campaignId },
        select: { senderAccountId: true }
      });
      if (campaign) {
        targetSenderAccountId = campaign.senderAccountId;
      }
    }

    let activeSenderAccount = null;
    if (targetSenderAccountId) {
      activeSenderAccount = await prisma.senderAccount.findUnique({
        where: { id: targetSenderAccountId }
      });
    }

    // 3. Determine active provider and SMTP settings to use
    const provider = settings?.activeProvider || 'MOCK';
    
    if (provider === 'MOCK') {
      console.log(`[Mock Send Relay] Campaign: ${campaignId || 'manual'}, Lead: ${leadData.email}`);
      return NextResponse.json({ 
        success: true, 
        message: 'Email queued for sending (Mock relay fallback).',
        messageId: `mock-msg-${Date.now()}-${Math.random().toString(36).substring(7)}` 
      });
    }

    if (provider === 'AZURE') {
      console.log(`[Azure Communication Services Send] Campaign: ${campaignId || 'manual'}, Lead: ${leadData.email}`);
      return NextResponse.json({ 
        success: true, 
        message: 'Email successfully sent via Azure Communication Services (Simulated).', 
        messageId: `azure-msg-${Date.now()}-${Math.random().toString(36).substring(7)}` 
      });
    }

    // SMTP settings selection: prefer individual sender account details, fallback to global
    let smtpHost = settings?.smtpHost;
    let smtpPort = settings?.smtpPort || 587;
    let smtpUser = settings?.smtpUser;
    let smtpPass = settings?.smtpPass;

    if (activeSenderAccount && activeSenderAccount.smtpHost && activeSenderAccount.smtpUser && activeSenderAccount.smtpPass) {
      smtpHost = activeSenderAccount.smtpHost;
      smtpPort = activeSenderAccount.smtpPort || 587;
      smtpUser = activeSenderAccount.smtpUser;
      smtpPass = activeSenderAccount.smtpPass;
    }

    // SMTP-based delivery (SMTP, GOOGLE, MICROSOFT)
    if (!smtpHost || !smtpUser || !smtpPass) {
      return NextResponse.json({ success: false, error: 'Active provider requires SMTP configuration but details are missing.' }, { status: 400 });
    }

    // 4. Dispatch real outbound email using SMTP relay credentials
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
      from: `"ArcReach Outreach" <${smtpUser}>`,
      to: leadData.email,
      subject: subject || 'Outreach from ArcReach',
      text: bodyText || '',
    });

    console.log(`[SMTP Send Success] Message ID: ${info.messageId} sent to ${leadData.email} via ${smtpUser}`);

    return NextResponse.json({ 
      success: true, 
      message: 'Email successfully sent via SMTP.', 
      messageId: info.messageId 
    });
  } catch (error: any) {
    console.error('Error sending email:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
