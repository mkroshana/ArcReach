import { prisma } from './db';
import { checkGlobalRateLimits } from './rateLimits';
import { applyEmailTracking } from './emailTracking';
import nodemailer from 'nodemailer';

/**
 * Custom validation helper to ensure send limits (minuteLimit, hourlyLimit, dailyLimit) are not exceeded
 * before triggering automated outgoing emails.
 */
export function validateSendingFrequency(senderAccount: {
  minuteLimit: number;
  hourlyLimit: number;
  dailyLimit: number;
  emailsSentLastMinute: number;
  emailsSentLastHour: number;
  emailsSentToday: number;
}): { allowed: boolean; reason?: string } {
  if (senderAccount.emailsSentLastMinute >= senderAccount.minuteLimit) {
    return { allowed: false, reason: `Sending frequency limit reached: Max ${senderAccount.minuteLimit} per minute.` };
  }
  if (senderAccount.emailsSentLastHour >= senderAccount.hourlyLimit) {
    return { allowed: false, reason: `Sending frequency limit reached: Max ${senderAccount.hourlyLimit} per hour.` };
  }
  if (senderAccount.emailsSentToday >= senderAccount.dailyLimit) {
    return { allowed: false, reason: `Sending limit reached: Max ${senderAccount.dailyLimit} per day.` };
  }
  return { allowed: true };
}

/**
 * Main entry point for the background sending loop.
 */
export async function processDueEmails() {
  console.log('[SendEngine] Starting processing cycle...');
  
  try {
    const now = new Date();

    // 1. Fetch leads that are due for action (enrolled in campaigns with nextActionDate in the past)
    const dueEnrollments = await prisma.campaignEnrollment.findMany({
      where: {
        status: 'Active',
        nextActionDate: {
          lte: now,
        },
      },
      include: {
        lead: true,
        campaign: {
          include: {
            steps: {
              orderBy: { stepOrder: 'asc' }
            },
            senderAccount: true
          }
        }
      },
      take: 100, // Batch limit to prevent timeouts
    });

    if (dueEnrollments.length === 0) {
      console.log('[SendEngine] No emails due in this cycle.');
      return;
    }

    // 2. Validate global rate limits before processing any sends
    const rateCheck = await checkGlobalRateLimits();
    if (!rateCheck.allowed) {
      console.log(`[SendEngine] Global rate limit restriction hit: ${rateCheck.reason}. Aborting current cycle.`);
      return;
    }

    // 3. Fetch global settings
    const settings = await prisma.globalSettings.findFirst();
    const provider = settings?.activeProvider || 'MOCK';

    for (const enrollment of dueEnrollments) {
      const campaign = enrollment.campaign;
      const lead = enrollment.lead;
      
      // Double check global rate limits dynamically for each email in the batch
      const incrementalRateCheck = await checkGlobalRateLimits();
      if (!incrementalRateCheck.allowed) {
        console.log(`[SendEngine] Global rate limit hit mid-cycle: ${incrementalRateCheck.reason}. Pausing remaining batch.`);
        break;
      }

      // 4. Check Timezone & Sending Schedule restrictions
      const isWithinSendingWindow = checkSendingWindow(campaign.timezone, campaign.sendSchedule);
      if (!isWithinSendingWindow) {
          console.log(`[SendEngine] Lead ${lead.email} skipped (outside campaign schedule window for ${campaign.timezone}).`);
          continue;
      }

      // 5. Find the specific SequenceStep content
      const currentStepOrder = enrollment.currentSequenceStep;
      const stepContent = campaign.steps.find((s: any) => s.stepOrder === currentStepOrder);
      
      if (!stepContent) {
          // Lead has finished the sequence or has invalid sequence pointer
          await prisma.campaignEnrollment.update({
            where: { id: enrollment.id },
            data: { status: 'Completed', nextActionDate: null }
          });
          continue;
      }

      // 6. Personalize the email (Spintax, Variables)
      const subject = personalizeEmail(stepContent.subject, lead);
      const bodyText = personalizeEmail(stepContent.body, lead);
      const isHtml = /<[a-z][\s\S]*>/i.test(bodyText);
      let syntheticMessageId = `${campaign.id}-${lead.id}-${currentStepOrder}-${Date.now()}`;

      let baseBody = bodyText;
      if (isHtml && !bodyText.toLowerCase().includes('<html') && !bodyText.toLowerCase().includes('<body')) {
        baseBody = `<html><head><meta charset="utf-8"></head><body>${bodyText}</body></html>`;
      }

      try {
        // Create dispatch record FIRST so we have a dispatchId for tracking URLs
        const dispatch = await prisma.emailDispatch.create({
          data: {
            leadId: lead.id,
            campaignId: campaign.id,
            messageId: syntheticMessageId,
            subject,
            body: baseBody,
          }
        });

        // Apply self-hosted tracking (pixel + link rewriting)
        const finalBody = applyEmailTracking(
          baseBody,
          dispatch.id,
          isHtml,
          campaign.trackOpens,
          campaign.trackClicks
        );

        // Send Email
        let providerMessageId: string | null = null;

        if (provider === 'MOCK') {
          console.log(`[SendEngine - Mock Send Success] To: ${lead.email} | Subject: ${subject}`);
        } else if (provider === 'AZURE') {
          const connString = settings?.azureConnString;
          const senderDomain = settings?.azureSenderDomain;
          if (!connString || !senderDomain) {
            throw new Error('Azure Communication Services connection string or domain is not configured.');
          }

          const { EmailClient } = require("@azure/communication-email");
          const emailClient = new EmailClient(connString);
          const [username] = campaign.senderAccount.emailAddress.split('@');
          const fromAddress = `${username}@${senderDomain}`;

          const message = {
            senderAddress: fromAddress,
            content: isHtml 
              ? { subject, html: finalBody }
              : { subject, plainText: finalBody },
            recipients: {
              to: [{ address: lead.email }],
            },
            userEngagementTrackingDisabled: !campaign.trackOpens,
          };

          const poller = await emailClient.beginSend(message);
          const result = await poller.pollUntilDone();
          if (result && result.id) {
            providerMessageId = result.id;
          }
          console.log(`[SendEngine - Azure Success] Message ID: ${providerMessageId || syntheticMessageId} | To: ${lead.email}`);
        } else {
          // SMTP Fallback
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
            throw new Error('SMTP credentials are missing.');
          }

          const portNum = Number(smtpPort) || 587;
          const transport = nodemailer.createTransport({
            host: smtpHost,
            port: portNum,
            secure: portNum === 465,
            auth: { user: smtpUser, pass: smtpPass },
          });

          const mailOptions: any = {
            from: `"${campaign.senderAccount.name || 'ArcReach Sender'}" <${smtpUser}>`,
            to: lead.email,
            subject,
          };

          if (isHtml) {
            mailOptions.html = finalBody;
          } else {
            mailOptions.text = finalBody;
          }

          const info = await transport.sendMail(mailOptions);
          if (info && info.messageId) {
            providerMessageId = info.messageId;
          }
          console.log(`[SendEngine - SMTP Success] Message ID: ${providerMessageId || syntheticMessageId} | To: ${lead.email}`);
        }

        // Update dispatch with the final tracked body and messageId
        const updateData: any = { body: finalBody };
        if (providerMessageId) {
          updateData.messageId = providerMessageId;
        }
        await prisma.emailDispatch.update({
          where: { id: dispatch.id },
          data: updateData,
        });

        // 7. Advance enrollment to the next step since send succeeded
        const nextStepOrder = currentStepOrder + 1;
        const nextStep = campaign.steps.find(s => s.stepOrder === nextStepOrder);

        if (nextStep) {
          const nextDate = new Date();
          nextDate.setDate(now.getDate() + nextStep.waitDays);

          await prisma.campaignEnrollment.update({
            where: { id: enrollment.id },
            data: {
              currentSequenceStep: nextStepOrder,
              nextActionDate: nextDate,
            }
          });
        } else {
          // Completed sequence
          await prisma.campaignEnrollment.update({
            where: { id: enrollment.id },
            data: {
              status: 'Completed',
              nextActionDate: null,
            }
          });
        }

      } catch (err: any) {
        console.error(`[SendEngine Failure] Could not send to ${lead.email}:`, err.message || err);
        // Do NOT update enrollment nextActionDate or step.
        // It remains in the past, causing it to be retried in the next background loop.
      }
    }

    console.log('[SendEngine] Cycle completed.');

  } catch (error) {
    console.error('[SendEngine] Error during processing cycle:', error);
  }
}

/**
 * Helper to check if current time is within the campaign's allowed schedule in its timezone.
 */
export function checkSendingWindow(timezone: string, schedule: any): boolean {
    if (!schedule) return true;
    try {
      const sched = typeof schedule === 'string' ? JSON.parse(schedule) : schedule;
      if (!sched || !sched.days || !sched.window) return true;
      
      const now = new Date();
      // Format current time in campaign timezone
      const targetTimeStr = now.toLocaleTimeString('en-US', { timeZone: timezone, hour12: false }); // e.g. "14:30:22"
      const targetDayStr = now.toLocaleDateString('en-US', { timeZone: timezone, weekday: 'short' }); // e.g. "Mon"
      
      // Verify Day
      const allowedDays = sched.days || [];
      if (allowedDays.length > 0 && !allowedDays.includes(targetDayStr)) {
        return false;
      }
      
      // Verify Time Window (HH:MM)
      const start = sched.window.start;
      const end = sched.window.end;
      if (start && end) {
        const currentTime = targetTimeStr.substring(0, 5); // e.g. "14:30"
        if (currentTime < start || currentTime > end) {
          return false;
        }
      }
      return true;
    } catch (err) {
      console.error('[SendEngine] Error in checkSendingWindow:', err);
      return true; // fail-safe to allow sending
    }
}

/**
 * Replace variables like {{firstName}} and resolve {A|B} Spintax
 */
export function personalizeEmail(template: string, lead: any): string {
    if (!template) return '';
    let result = template;
    
    const getFirstName = (fullName: string | null | undefined, fallback: string = 'there') => {
        if (!fullName) return fallback;
        return fullName.trim().split(/\s+/)[0] || fallback;
    };

    // Replace {{firstName}}
    result = result.replace(/\{\{firstName\}\}/g, getFirstName(lead.name || lead.firstName, 'there'));

    // Replace {{company}}
    result = result.replace(/\{\{company\}\}/g, lead.company || 'your company');

    // Replace n8n/json style name variable with fallback: {{ $json.name || 'there' }}
    result = result.replace(/\{\{\s*\$json\.name\s*\|\|\s*'([^']*)'\s*\}\}/g, (match, fallback) => {
        return getFirstName(lead.name || lead.firstName, fallback || 'there');
    });

    // Replace n8n/json style name variable without fallback: {{ $json.name }}
    result = result.replace(/\{\{\s*\$json\.name\s*\}\}/g, getFirstName(lead.name || lead.firstName, 'there'));

    // Also support single braces versions just in case: { $json.name || 'there' }
    result = result.replace(/\{\s*\$json\.name\s*\|\|\s*'([^']*)'\s*\}/g, (match, fallback) => {
        return getFirstName(lead.name || lead.firstName, fallback || 'there');
    });
    result = result.replace(/\{\s*\$json\.name\s*\}/g, getFirstName(lead.name || lead.firstName, 'there'));

    // Support n8n/json style company variable: {{ $json.company || 'your company' }}
    result = result.replace(/\{\{\s*\$json\.company\s*\|\|\s*'([^']*)'\s*\}\}/g, (match, fallback) => {
        return lead.company || fallback || 'your company';
    });
    result = result.replace(/\{\{\s*\$json\.company\s*\}\}/g, lead.company || 'your company');

    // Single braces version: { $json.company || 'your company' }
    result = result.replace(/\{\s*\$json\.company\s*\|\|\s*'([^']*)'\s*\}/g, (match, fallback) => {
        return lead.company || fallback || 'your company';
    });
    result = result.replace(/\{\s*\$json\.company\s*\}/g, lead.company || 'your company');

    // Basic Spintax: {Hi|Hello|Hey}
    const spintaxRegex = /\{([^{}]+)\}/g;
    result = result.replace(spintaxRegex, (match, options) => {
        const choices = options.split('|');
        return choices[Math.floor(Math.random() * choices.length)];
    });

    return result;
}
