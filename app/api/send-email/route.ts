import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { applyEmailTracking } from '@/lib/emailTracking';
import { checkGlobalRateLimits } from '@/lib/rateLimits';
import nodemailer from 'nodemailer';

export async function POST(req: NextRequest) {
  try {
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
        messageId: syntheticMessageId,
        subject: subject || 'Outreach from ArcReach',
        body: baseBody,
      }
    });

    // Apply self-hosted tracking (pixel + link rewriting)
    const finalBody = applyEmailTracking(baseBody, dispatch.id, isHtml, trackOpens, trackClicks);

    if (provider === 'AZURE') {
      const connString = settings?.azureConnString;
      const senderDomain = settings?.azureSenderDomain;

      if (!connString || !senderDomain) {
        return NextResponse.json({
          success: false,
          error: 'Azure Communication Services is active, but Connection String or Sender Domain is not configured in settings.'
        }, { status: 400 });
      }

      if (!activeSenderAccount) {
        return NextResponse.json({
          success: false,
          error: 'Active sender account is required to determine the from username for Azure Communication Services.'
        }, { status: 400 });
      }

      try {
        const { EmailClient } = require("@azure/communication-email");
        const emailClient = new EmailClient(connString);

        const [username] = activeSenderAccount.emailAddress.split('@');
        const fromAddress = `${username}@${senderDomain}`;

        const message = {
          senderAddress: fromAddress,
          content: isHtml 
            ? { subject: subject || 'Outreach from ArcReach', html: finalBody }
            : { subject: subject || 'Outreach from ArcReach', plainText: finalBody },
          recipients: {
            to: [{ address: leadData.email }],
          },
          replyTo: [
            { address: activeSenderAccount.replyTo || activeSenderAccount.emailAddress }
          ],
          userEngagementTrackingDisabled: !trackOpens,
        };

        const poller = await emailClient.beginSend(message);
        const result = await poller.pollUntilDone();

        // Update dispatch with provider messageId and tracked body
        await prisma.emailDispatch.update({
          where: { id: dispatch.id },
          data: {
            messageId: result.id || syntheticMessageId,
            body: finalBody,
          }
        });

        console.log(`[Azure Send Success] Message ID: ${result.id} | From: ${fromAddress} → To: ${leadData.email}`);

        return NextResponse.json({ 
          success: true, 
          message: 'Email successfully sent via Azure Communication Services.', 
          messageId: result.id 
        });
      } catch (err: any) {
        console.error('[Azure Send Error]', err);
        return NextResponse.json({
          success: false,
          error: `Azure Communication Services failed to send email: ${err.message || err}`
        }, { status: 550 });
      }
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

    const mailOptions: any = {
      from: `"ArcReach Outreach" <${smtpUser}>`,
      to: leadData.email,
      subject: subject || 'Outreach from ArcReach',
    };
    if (activeSenderAccount) {
      mailOptions.replyTo = activeSenderAccount.replyTo || activeSenderAccount.emailAddress;
    }

    if (isHtml) {
      mailOptions.html = finalBody;
    } else {
      mailOptions.text = finalBody;
    }

    const info = await transport.sendMail(mailOptions);

    // Update dispatch with provider messageId and tracked body
    await prisma.emailDispatch.update({
      where: { id: dispatch.id },
      data: {
        messageId: info.messageId || syntheticMessageId,
        body: finalBody,
      }
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
