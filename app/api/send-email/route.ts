import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import nodemailer from 'nodemailer';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { campaignId, leadData, subject, bodyText } = body;

    if (!leadData || !leadData.email) {
      return NextResponse.json({ success: false, error: 'Recipient lead details are required.' }, { status: 400 });
    }

    // 1. Fetch global settings from the database
    const settings = await prisma.globalSettings.findFirst();
    
    // 2. If SMTP details are not configured, fall back to mock relay (development sandbox mode)
    if (!settings || !settings.smtpHost || !settings.smtpUser || !settings.smtpPass) {
      console.log(`[Mock Send Relay] Campaign: ${campaignId || 'manual'}, Lead: ${leadData.email}`);
      return NextResponse.json({ 
        success: true, 
        message: 'Email queued for sending (Mock relay fallback).',
        messageId: `mock-msg-${Date.now()}-${Math.random().toString(36).substring(7)}` 
      });
    }

    // 3. Dispatch real outbound email using configured SMTP relay credentials
    const portNum = Number(settings.smtpPort) || 587;
    const transport = nodemailer.createTransport({
      host: settings.smtpHost,
      port: portNum,
      secure: portNum === 465,
      auth: {
        user: settings.smtpUser,
        pass: settings.smtpPass,
      },
    });

    const info = await transport.sendMail({
      from: `"ArcReach Outreach" <${settings.smtpUser}>`,
      to: leadData.email,
      subject: subject || 'Outreach from ArcReach',
      text: bodyText || '',
    });

    console.log(`[SMTP Send Success] Message ID: ${info.messageId} sent to ${leadData.email}`);

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
