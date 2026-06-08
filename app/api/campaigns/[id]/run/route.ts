import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import nodemailer from 'nodemailer';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSession();
    const { id } = await params;

    // 1. Fetch the campaign, its steps, and sender account
    const campaign = await prisma.campaign.findUnique({
      where: { id },
      include: {
        steps: {
          orderBy: { stepOrder: 'asc' }
        },
        senderAccount: true
      }
    });

    if (!campaign) {
      return NextResponse.json({ success: false, error: 'Campaign not found.' }, { status: 404 });
    }

    if (session.role !== 'ADMIN' && campaign.userId !== session.id) {
      return NextResponse.json({ success: false, error: 'Unauthorized access.' }, { status: 403 });
    }

    if (campaign.status !== 'Active') {
      return NextResponse.json({ 
        success: false, 
        error: 'Campaign is not active. Please publish the sequence before executing a manual run.' 
      }, { status: 400 });
    }

    // 2. Fetch all active enrollments for this campaign
    const enrollments = await prisma.campaignEnrollment.findMany({
      where: {
        campaignId: id,
        status: 'Active'
      },
      include: {
        lead: true
      }
    });

    if (enrollments.length === 0) {
      return NextResponse.json({ 
        success: true, 
        message: 'No active enrollments to process in this campaign.',
        dispatchedCount: 0
      });
    }

    // 3. Fetch global settings for delivery configuration
    const settings = await prisma.globalSettings.findFirst();
    const provider = settings?.activeProvider || 'MOCK';

    let dispatchedCount = 0;
    const errors = [];

    // 4. Process each enrollment
    for (const enrollment of enrollments) {
      const lead = enrollment.lead;
      const currentStepOrder = enrollment.currentSequenceStep;

      // Find step matching the current step order
      const step = campaign.steps.find(s => s.stepOrder === currentStepOrder);
      if (!step) {
        // Enrollment completed the sequence
        await prisma.campaignEnrollment.update({
          where: { id: enrollment.id },
          data: { status: 'Completed', nextActionDate: null }
        });
        continue;
      }

      // Personalize copy (Spintax, Lead variables)
      const subject = personalizeText(step.subject, lead);
      const bodyText = personalizeText(step.body, lead);
      const messageId = `${campaign.id}-${lead.id}-${currentStepOrder}-${Date.now()}`;

      try {
        // Send email based on active provider
        if (provider === 'MOCK') {
          console.log(`[Campaign Run - Mock] To: ${lead.email} | Subject: ${subject}`);
          // Simulated delay
        } else if (provider === 'AZURE') {
          const connString = settings?.azureConnString;
          const senderDomain = settings?.azureSenderDomain;
          if (!connString || !senderDomain) {
            throw new Error('Azure Communication Services is active, but Connection String or Sender Domain is missing.');
          }

          const { EmailClient } = require("@azure/communication-email");
          const emailClient = new EmailClient(connString);
          const [username] = campaign.senderAccount.emailAddress.split('@');
          const fromAddress = `${username}@${senderDomain}`;

          const message = {
            senderAddress: fromAddress,
            content: {
              subject,
              plainText: bodyText,
            },
            recipients: {
              to: [{ address: lead.email }],
            },
          };

          const poller = await emailClient.beginSend(message);
          await poller.pollUntilDone();
          console.log(`[Campaign Run - Azure Success] From: ${fromAddress} → To: ${lead.email}`);
        } else {
          // SMTP-based delivery (SMTP, GOOGLE, MICROSOFT fallback)
          let smtpHost = settings?.smtpHost;
          let smtpPort = settings?.smtpPort || 587;
          let smtpUser = settings?.smtpUser;
          let smtpPass = settings?.smtpPass;

          if (campaign.senderAccount.smtpHost && campaign.senderAccount.smtpUser && campaign.senderAccount.smtpPass) {
            smtpHost = campaign.senderAccount.smtpHost;
            smtpPort = campaign.senderAccount.smtpPort || 587;
            smtpUser = campaign.senderAccount.smtpUser;
            smtpPass = campaign.senderAccount.smtpPass;
          }

          if (!smtpHost || !smtpUser || !smtpPass) {
            throw new Error('SMTP credentials are missing for this campaign.');
          }

          const portNum = Number(smtpPort) || 587;
          const transport = nodemailer.createTransport({
            host: smtpHost,
            port: portNum,
            secure: portNum === 465,
            auth: { user: smtpUser, pass: smtpPass },
          });

          await transport.sendMail({
            from: `"${campaign.senderAccount.name || 'ArcReach Sender'}" <${smtpUser}>`,
            to: lead.email,
            subject,
            text: bodyText,
          });
          console.log(`[Campaign Run - SMTP Success] To: ${lead.email}`);
        }

        // 5. Log successfully sent dispatch to database
        await prisma.emailDispatch.create({
          data: {
            leadId: lead.id,
            messageId,
          }
        });

        // 6. Advance enrollment to the next step
        const nextStepOrder = currentStepOrder + 1;
        const nextStep = campaign.steps.find(s => s.stepOrder === nextStepOrder);

        if (nextStep) {
          const nextActionDate = new Date();
          nextActionDate.setDate(nextActionDate.getDate() + nextStep.waitDays);

          await prisma.campaignEnrollment.update({
            where: { id: enrollment.id },
            data: {
              currentSequenceStep: nextStepOrder,
              nextActionDate,
            }
          });
        } else {
          // No next step, sequence completed
          await prisma.campaignEnrollment.update({
            where: { id: enrollment.id },
            data: {
              status: 'Completed',
              nextActionDate: null,
            }
          });
        }

        dispatchedCount++;
      } catch (err: any) {
        console.error(`[Campaign Run Error] Failed to process lead ${lead.email}:`, err);
        errors.push({ email: lead.email, error: err.message || err });
      }
    }

    return NextResponse.json({
      success: errors.length === 0,
      message: `Campaign execution cycle complete. Sent: ${dispatchedCount}, Errors: ${errors.length}`,
      dispatchedCount,
      errors
    });

  } catch (error: any) {
    console.error('[Campaign Run Route Error]', error);
    return NextResponse.json({ success: false, error: error.message || 'Failed to run campaign.' }, { status: 500 });
  }
}

function personalizeText(template: string, lead: any): string {
  let result = template;
  result = result.replace(/\{\{firstName\}\}/g, lead.name || 'there');
  result = result.replace(/\{\{company\}\}/g, lead.company || 'your company');

  const spintaxRegex = /\{([^{}]+)\}/g;
  result = result.replace(spintaxRegex, (match, options) => {
    const choices = options.split('|');
    return choices[Math.floor(Math.random() * choices.length)];
  });

  return result;
}
