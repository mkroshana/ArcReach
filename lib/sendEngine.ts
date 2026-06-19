import { prisma } from './db';
import { checkGlobalRateLimits } from './rateLimits';
import { applyEmailTracking } from './emailTracking';
import nodemailer from 'nodemailer';

// Memory store for campaigns paused due to quota limits
export const quotaPausedCampaigns = new Map<string, Date>();

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
 * Calculates the daily limit for a sender based on the warmup volume ramp
 */
export function getEffectiveDailyCap(
  senderAccount: {
    warmupEnabled: boolean;
    warmupStartedAt: Date | string | null;
    dailyLimit: number;
    warmupLimit: number;
    warmupRamp: number;
  },
  now: Date
): number {
  if (!senderAccount.warmupEnabled || !senderAccount.warmupStartedAt) {
    return senderAccount.dailyLimit;
  }
  const startedAt = new Date(senderAccount.warmupStartedAt);
  const elapsedMs = now.getTime() - startedAt.getTime();
  const daysActive = Math.max(0, Math.floor(elapsedMs / 86400000));
  const currentCap = senderAccount.warmupLimit + senderAccount.warmupRamp * daysActive;
  return Math.min(senderAccount.dailyLimit, currentCap);
}

/**
 * Resolves the pool of senders for a campaign, defaulting to the primary sender if pool is empty.
 */
export function resolveCampaignSenders(campaign: {
  senderAccount: any;
  senders?: Array<{ senderAccount: any }>;
}): any[] {
  if (campaign.senders && campaign.senders.length > 0) {
    return campaign.senders.map(s => s.senderAccount);
  }
  return [campaign.senderAccount];
}

/**
 * Picks the sender with the maximum remaining daily capacity (least-loaded under cap).
 * Returns null if all senders in the pool are at cap.
 */
export function pickSender(
  pool: Array<any>,
  sentToday: Map<string, number>,
  now: Date
): any | null {
  let selectedSender: any | null = null;
  let maxRemaining = -1;

  for (const sender of pool) {
    const cap = getEffectiveDailyCap(sender, now);
    const sent = sentToday.get(sender.id) || 0;
    const remaining = cap - sent;

    if (remaining > 0 && remaining > maxRemaining) {
      maxRemaining = remaining;
      selectedSender = sender;
    }
  }

  return selectedSender;
}

/**
 * Main entry point for the background sending loop.
 */
export async function processDueEmails() {
  console.log('[SendEngine] Starting processing cycle...');

  // Auto-resume campaigns paused due to quota limits after their reset time has passed
  const nowTime = new Date();
  for (const [campaignId, resumeAt] of quotaPausedCampaigns.entries()) {
    if (nowTime >= resumeAt) {
      try {
        const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
        if (campaign && campaign.status === 'Paused') {
          await prisma.campaign.update({
            where: { id: campaignId },
            data: { status: 'Active' }
          });
          console.log(`[SendEngine] Auto-resumed campaign "${campaign.name}" (${campaignId}) after quota reset.`);
        }
      } catch (err) {
        console.error(`[SendEngine] Failed to auto-resume campaign ${campaignId}:`, err);
      }
      quotaPausedCampaigns.delete(campaignId);
    }
  }
  
  try {
    const now = new Date();

    // 1. Fetch leads that are due for action (enrolled in campaigns with nextActionDate in the past)
    const dueEnrollments = await prisma.campaignEnrollment.findMany({
      where: {
        status: 'Active',
        nextActionDate: {
          lte: now,
        },
        campaign: {
          status: 'Active',
        },
        // Send guards: skip leads that should not receive emails
        lead: {
          isArchived: false,
          status: { notIn: ['Bounced', 'Unsubscribed'] },
          validationStatus: { notIn: ['Invalid'] },
        },
      },
      include: {
        lead: true,
        campaign: {
          include: {
            steps: {
              orderBy: { stepOrder: 'asc' }
            },
            senderAccount: true,
            senders: {
              include: {
                senderAccount: true
              }
            }
          }
        }
      },
      take: 100, // Batch limit to prevent timeouts
    });

    if (dueEnrollments.length === 0) {
      console.log('[SendEngine] No emails due in this cycle.');
      return;
    }

    // Build map of sent counts today for each unique sender in the batch
    const senderIds = new Set<string>();
    for (const enrollment of dueEnrollments) {
      const campaign = enrollment.campaign;
      if (campaign.senderAccountId) {
        senderIds.add(campaign.senderAccountId);
      }
      if (campaign.senders) {
        for (const poolItem of campaign.senders) {
          if (poolItem.senderAccountId) {
            senderIds.add(poolItem.senderAccountId);
          }
        }
      }
    }

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const senderSentToday = new Map<string, number>();
    for (const senderId of senderIds) {
      const count = await prisma.emailDispatch.count({
        where: {
          senderAccountId: senderId,
          sentAt: {
            gte: startOfToday
          }
        }
      });
      senderSentToday.set(senderId, count);
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

      // Resolve the pool and pick a sender per send (least-loaded under cap)
      const senderPool = resolveCampaignSenders(campaign);
      const chosenSender = pickSender(senderPool, senderSentToday, now);

      if (!chosenSender) {
        console.log(`[SendEngine] All senders in pool for campaign "${campaign.name}" are at cap. Deferring lead ${lead.email} to tomorrow.`);
        const nextDay = new Date();
        nextDay.setDate(nextDay.getDate() + 1);
        nextDay.setHours(0, 0, 0, 0);
        await prisma.campaignEnrollment.update({
          where: { id: enrollment.id },
          data: { nextActionDate: nextDay }
        });
        continue;
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
          // If the campaign has no steps defined yet, skip processing for now instead of completing
          if (campaign.steps.length === 0) {
            console.log(`[SendEngine] Campaign "${campaign.name}" (${campaign.id}) has no steps. Skipping.`);
            continue;
          }
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

      // Idempotency guard: never send the same step to the same lead twice.
      const alreadySent = await prisma.emailDispatch.findFirst({
        where: {
          campaignId: campaign.id,
          leadId: lead.id,
          stepOrder: currentStepOrder,
          status: 'Sent',
        },
      });
      if (alreadySent) {
        // Advance the enrollment past this already-sent step without re-dispatching.
        const nextStepOrder = currentStepOrder + 1;
        const nextStep = campaign.steps.find((s: any) => s.stepOrder === nextStepOrder);
        if (nextStep) {
          const nextDate = new Date();
          nextDate.setDate(now.getDate() + nextStep.waitDays);
          await prisma.campaignEnrollment.update({
            where: { id: enrollment.id },
            data: { currentSequenceStep: nextStepOrder, nextActionDate: nextDate },
          });
        } else {
          await prisma.campaignEnrollment.update({
            where: { id: enrollment.id },
            data: { status: 'Completed', nextActionDate: null },
          });
        }
        continue;
      }

      let dispatch: { id: string } | null = null;
      try {
        // Create dispatch record FIRST so we have a dispatchId for tracking URLs
        dispatch = await prisma.emailDispatch.create({
          data: {
            leadId: lead.id,
            campaignId: campaign.id,
            senderAccountId: chosenSender.id,
            messageId: syntheticMessageId,
            subject,
            body: baseBody,
            stepOrder: currentStepOrder,
            status: 'Sent',
          }
        });

        // Apply self-hosted tracking (pixel + link rewriting + unsubscribe link)
        const finalBody = applyEmailTracking(
          baseBody,
          dispatch.id,
          isHtml,
          campaign.trackOpens,
          campaign.trackClicks,
          lead.id
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
          const [username] = chosenSender.emailAddress.split('@');
          const fromAddress = `${username}@${senderDomain}`;

          const message = {
            senderAddress: fromAddress,
            content: isHtml 
              ? { subject, html: finalBody }
              : { subject, plainText: finalBody },
            recipients: {
              to: [{ address: lead.email }],
            },
            replyTo: [
              { address: chosenSender.replyTo || chosenSender.emailAddress }
            ],
            userEngagementTrackingDisabled: !campaign.trackOpens,
          };

          const poller = await emailClient.beginSend(message);
          const result = await poller.pollUntilDone();
          if (result && result.id) {
            providerMessageId = result.id;
          }
          if (result && result.status === 'Failed') {
            throw new Error(result.error?.message || 'Azure Communication Services reported send status: Failed.');
          }
          console.log(`[SendEngine - Azure Success] Message ID: ${providerMessageId || syntheticMessageId} | To: ${lead.email}`);
        } else {
          // SMTP Fallback
          let smtpHost = settings?.smtpHost;
          let smtpPort = settings?.smtpPort || 587;
          let smtpUser = settings?.smtpUser;
          let smtpPass = settings?.smtpPass;

          if (chosenSender.smtpHost && chosenSender.smtpUser && chosenSender.smtpPass) {
            smtpHost = chosenSender.smtpHost;
            smtpPort = chosenSender.smtpPort || 587;
            smtpUser = chosenSender.smtpUser;
            smtpPass = chosenSender.smtpPass;
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
            from: `"${chosenSender.name || 'ArcReach Sender'}" <${smtpUser}>`,
            to: lead.email,
            replyTo: chosenSender.replyTo || chosenSender.emailAddress,
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

        // Increment warmupSent counter if warmup is enabled
        if (chosenSender.warmupEnabled) {
          await prisma.senderAccount.update({
            where: { id: chosenSender.id },
            data: { warmupSent: { increment: 1 } }
          });
        }

        // Update local sent count tracking
        senderSentToday.set(chosenSender.id, (senderSentToday.get(chosenSender.id) || 0) + 1);

      } catch (err: any) {
        console.error(`[SendEngine Failure] Could not send to ${lead.email}:`, err.message || err);

        const errStr = (err.message || String(err)).toLowerCase();
        const isQuotaError = errStr.includes('quota') || errStr.includes('limit') || errStr.includes('rate') || errStr.includes('exceeded');

        if (isQuotaError) {
          try {
            console.log(`[SendEngine] Quota limit hit. Pausing campaign "${campaign.name}" (${campaign.id}) for 1 hour.`);

            // The send never went out — mark the pre-created dispatch as Failed so it
            // is not counted as sent. The enrollment retries later and creates a new row.
            if (dispatch) {
              await prisma.emailDispatch.update({
                where: { id: dispatch.id },
                data: { status: 'Failed' },
              });
            }

            // 1. Pause the campaign in database
            await prisma.campaign.update({
              where: { id: campaign.id },
              data: { status: 'Paused' }
            });

            // 2. Schedule auto-resume
            const resumeTime = new Date();
            resumeTime.setHours(resumeTime.getHours() + 1);
            quotaPausedCampaigns.set(campaign.id, resumeTime);

            // 3. Postpone next action date of the enrollment so it retries later
            await prisma.campaignEnrollment.update({
              where: { id: enrollment.id },
              data: { nextActionDate: resumeTime }
            });
          } catch (pauseErr: any) {
            console.error('[SendEngine] Failed to pause campaign on quota limit:', pauseErr.message);
          }
          // Break the loop since any further sends in the current cycle will fail
          break;
        }

        // Mark enrollment as Failed to stop infinite retry loops
        try {
          await prisma.campaignEnrollment.update({
            where: { id: enrollment.id },
            data: { status: 'Failed', nextActionDate: null }
          });

          // Only mark lead as Bounced + Invalid if the error is not a sender-side or system-level error
          const isSenderOrSystemError = 
            errStr.includes('auth') || 
            errStr.includes('credentials') || 
            errStr.includes('login') || 
            errStr.includes('timeout') || 
            errStr.includes('connect') || 
            errStr.includes('dns') || 
            errStr.includes('unauthorized') || 
            errStr.includes('forbidden') || 
            errStr.includes('configured');

          if (!isSenderOrSystemError) {
            await prisma.lead.update({
              where: { id: lead.id },
              data: {
                status: 'Bounced',
                validationStatus: 'Invalid',
              }
            });
          }

          // Mark the dispatch row (created before the send) as Failed so it is not
          // counted as an actually-sent email, and log an audit-trail event.
          if (dispatch) {
            const failedDispatch = await prisma.emailDispatch.update({
              where: { id: dispatch.id },
              data: { status: 'Failed' },
            });
            await prisma.emailEvent.create({
              data: {
                messageId: failedDispatch.messageId,
                eventType: 'send_failed',
              }
            });
          }
        } catch (updateErr: any) {
          console.error(`[SendEngine] Failed to update status for ${lead.email}:`, updateErr.message);
        }
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

    // Replace {{name}} (full name)
    result = result.replace(/\{\{name\}\}/g, lead.name || 'there');

    // Replace {{jobTitle}}
    result = result.replace(/\{\{jobTitle\}\}/g, lead.jobTitle || 'professional');

    // Replace {{email}}
    result = result.replace(/\{\{email\}\}/g, lead.email || '');

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
