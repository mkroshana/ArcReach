import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { checkGlobalRateLimits } from '@/lib/rateLimits';
import { getVerifiedDomains, resolveAzureFromAddress } from '@/lib/azureDomains';
import nodemailer from 'nodemailer';

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
    const provider = settings?.activeProvider || 'MOCK';

    // Fetch the sender account if provided
    let senderAccount = null;
    if (senderAccountId) {
      senderAccount = await prisma.senderAccount.findUnique({
        where: { id: senderAccountId }
      });
    }

    const senderName = senderAccount?.name || session.name || 'ArcReach';
    const senderEmail = senderAccount?.emailAddress || session.email;

    // Generate a unique message ID
    const randomHex = Array.from({ length: 16 }, () => Math.random().toString(16)[2]).join('');
    let messageId = `msg_${randomHex}@arcreach-relay.net`;

    // Send the email based on the active provider
    if (provider === 'MOCK') {
      console.log(`[Unibox Reply - Mock] From: ${senderEmail} → To: ${lead.email} | Subject: ${subject}`);
      console.log(`[Unibox Reply - Mock] Body: ${replyBody.substring(0, 100)}...`);
    } else if (provider === 'AZURE') {
      const connString = settings?.azureConnString;
      if (!connString || getVerifiedDomains(settings).length === 0) {
        throw new Error('Azure Communication Services is active, but Connection String or verified domains are missing.');
      }

      const { EmailClient } = require("@azure/communication-email");
      const emailClient = new EmailClient(connString);
      const fromAddress = resolveAzureFromAddress(senderEmail, settings);

      const message = {
        senderAddress: fromAddress,
        content: {
          subject: subject || 'Re: Outreach',
          plainText: replyBody,
        },
        recipients: {
          to: [{ address: lead.email }],
        },
        replyTo: [
          { address: senderAccount?.replyTo || senderEmail }
        ],
      };

      console.log(`[Unibox Reply - Azure Sending] From: ${fromAddress} → To: ${lead.email} | Subject: ${subject}`);
      const poller = await emailClient.beginSend(message);
      const result = await poller.pollUntilDone();
      
      if (result.status === 'Failed') {
        throw new Error(result.error?.message || 'Azure Communication Services reported send status: Failed.');
      }

      messageId = result.id || messageId;
      console.log(`[Unibox Reply - Azure Success] Message ID: ${messageId} | From: ${fromAddress} → To: ${lead.email}`);
    } else {
      // SMTP-based delivery: prefer individual sender account credentials, fallback to global
      let smtpHost = settings?.smtpHost;
      let smtpPort = settings?.smtpPort || 587;
      let smtpUser = settings?.smtpUser;
      let smtpPass = settings?.smtpPass;

      if (senderAccount?.smtpHost && senderAccount?.smtpUser && senderAccount?.smtpPass) {
        smtpHost = senderAccount.smtpHost;
        smtpPort = senderAccount.smtpPort || 587;
        smtpUser = senderAccount.smtpUser;
        smtpPass = senderAccount.smtpPass;
      }

      if (!smtpHost || !smtpUser || !smtpPass) {
        return NextResponse.json({
          error: 'SMTP configuration is missing. Configure SMTP credentials for the sender account or set global SMTP settings.'
        }, { status: 400 });
      }

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
        from: `"${senderName}" <${smtpUser}>`,
        to: lead.email,
        replyTo: senderAccount?.replyTo || senderEmail,
        subject: subject || 'Re: Outreach',
        text: replyBody,
      });

      messageId = info.messageId || messageId;
      console.log(`[Unibox Reply - SMTP Success] Message ID: ${messageId} | From: ${smtpUser} → To: ${lead.email}`);
    }

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
