import { prisma } from './db';
import { checkGlobalRateLimits } from './rateLimits';
import { applyEmailTracking } from './emailTracking';
import { sendMessage } from './emailProvider';

/**
 * Auto-resumes campaigns whose quota-driven pause has elapsed. Idempotent and
 * safe to run concurrently — `updateMany` is row-level atomic, so each due row
 * flips to Active exactly once even if multiple workers race.
 *
 * Returns the number of campaigns resumed.
 */
export async function autoResumeQuotaPausedCampaigns(now: Date = new Date()): Promise<number> {
  const { count } = await prisma.campaign.updateMany({
    where: {
      status: 'Paused',
      pausedUntil: { lte: now },
    },
    data: {
      status: 'Active',
      pausedUntil: null,
    },
  });
  if (count > 0) {
    console.log(`[SendEngine] Auto-resumed ${count} campaign(s) after quota reset.`);
  }
  return count;
}

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

export const MAX_SEND_ATTEMPTS = 3;
export const RETRY_BACKOFF_HOURS = [1, 6, 24]; // hour mapping: attempt 1 -> +1h, 2 -> +6h, 3 -> +24h

/**
 * Classifies an email sending error into quota limits, hard bounce, or soft transient failure.
 */
export function classifyFailure(err: any): 'quota' | 'hard' | 'soft' {
  const errStr = (err.message || String(err)).toLowerCase();

  // 0. Systemic provider outages — nothing is wrong with the lead, and every
  // send this cycle will fail identically, so treat like quota: pause the
  // campaign and auto-resume later instead of burning per-lead retries (which
  // would eventually mark innocent leads Failed/Risky).
  //  - Azure HMAC clock-skew rejection: host clock drifted >5 min, needs an
  //    App Service restart; requests recover after resync.
  if (errStr.includes('time difference between the originating client')) {
    return 'quota';
  }

  // 1. Quota check
  if (errStr.includes('quota') || errStr.includes('limit') || errStr.includes('rate') || errStr.includes('exceeded')) {
    return 'quota';
  }

  // Sender/system configuration or connection error check (e.g. SMTP auth failure is 5xx but is not a hard bounce for the recipient)
  if (/auth|credential|login|unauthorized|forbidden|not configured|missing|econnrefused|econnreset|enotfound|dns/i.test(errStr)) {
    return 'soft';
  }

  // 2. Hard check (permanent, 5.x.x response code or specific user/mailbox invalid pattern)
  if (err.responseCode && Number(err.responseCode) >= 500 && Number(err.responseCode) <= 559 && Number(err.responseCode) !== 552) {
    return 'hard';
  }

  const hardPatterns = [
    'no such user',
    'user unknown',
    'mailbox unavailable',
    'does not exist',
    'invalid recipient',
    'address rejected',
    'recipient rejected',
    'domain not found',
    'nxdomain',
    'no mx',
    '5\\.1\\.1'
  ];
  const hardRegex = new RegExp(hardPatterns.join('|'), 'i');
  if (hardRegex.test(errStr)) {
    return 'hard';
  }

  // 3. Soft check (transient, 4.x.x response code or network patterns or 552 mailbox full)
  if (
    (err.responseCode && Number(err.responseCode) >= 400 && Number(err.responseCode) <= 499) ||
    Number(err.responseCode) === 552 ||
    errStr.includes('timeout') ||
    errStr.includes('timed out') ||
    errStr.includes('econnreset') ||
    errStr.includes('econnrefused') ||
    errStr.includes('etimedout') ||
    errStr.includes('greylist') ||
    errStr.includes('temporar') ||
    errStr.includes('try again') ||
    errStr.includes('mailbox full')
  ) {
    return 'soft';
  }

  // 4. Default fall safe: Unknown/unmatched -> soft
  return 'soft';
}

/**
 * Shared error handler for email dispatches. Resolves failure category (quota, soft, hard)
 * and updates enrollment retry/backoff parameters, lead deliverability indicators,
 * and tracks dispatch statuses.
 */
export async function handleSendFailure(
  enrollment: { id: string; retryCount: number },
  lead: { id: string; email: string },
  dispatch: any,
  err: any,
  campaignName: string,
  campaignId: string
): Promise<{ action: 'break' | 'continue' }> {
  const classification = classifyFailure(err);
  const errMsg = err.message || String(err);
  console.log(`[SendFailureHandler] Lead: ${lead.email} | Type: ${classification} | Error: ${errMsg}`);

  // Always mark the pre-created dispatch as Failed so it isn't counted in metrics
  if (dispatch) {
    try {
      await prisma.emailDispatch.update({
        where: { id: dispatch.id },
        data: { status: 'Failed' }
      });
    } catch (dispatchErr: any) {
      console.error(`[SendFailureHandler] Failed to mark dispatch ${dispatch.id} failed:`, dispatchErr.message);
    }
  }

  if (classification === 'quota') {
    try {
      console.log(`[SendFailureHandler] Quota limit hit. Pausing campaign "${campaignName}" (${campaignId}) for 1 hour.`);

      const resumeTime = new Date();
      resumeTime.setHours(resumeTime.getHours() + 1);

      // Atomically pause the campaign with its scheduled resume time and
      // postpone the enrollment so it retries after the reset.
      await prisma.$transaction([
        prisma.campaign.update({
          where: { id: campaignId },
          data: { status: 'Paused', pausedUntil: resumeTime },
        }),
        prisma.campaignEnrollment.update({
          where: { id: enrollment.id },
          data: { nextActionDate: resumeTime },
        }),
      ]);
    } catch (pauseErr: any) {
      console.error('[SendFailureHandler] Failed to pause campaign on quota limit:', pauseErr.message);
    }
    return { action: 'break' };
  }

  if (classification === 'soft') {
    const attempts = enrollment.retryCount + 1;
    if (attempts < MAX_SEND_ATTEMPTS) {
      const backoffHours = RETRY_BACKOFF_HOURS[enrollment.retryCount] ?? 24;
      const nextActionDate = new Date();
      nextActionDate.setHours(nextActionDate.getHours() + backoffHours);

      console.log(`[SendFailureHandler] Soft failure (attempt ${attempts}/${MAX_SEND_ATTEMPTS}). Backing off for ${backoffHours} hours. Next action: ${nextActionDate.toISOString()}`);

      await prisma.campaignEnrollment.update({
        where: { id: enrollment.id },
        data: {
          nextActionDate,
          retryCount: { increment: 1 },
          lastError: errMsg,
          lastBounceType: 'soft'
        }
      });
    } else {
      console.log(`[SendFailureHandler] Soft failure retries exhausted (${attempts}/${MAX_SEND_ATTEMPTS}) for lead ${lead.email}. Marking enrollment Failed and lead validationStatus Risky.`);
      
      await prisma.campaignEnrollment.update({
        where: { id: enrollment.id },
        data: {
          status: 'Failed',
          nextActionDate: null,
          lastError: errMsg,
          lastBounceType: 'soft'
        }
      });

      await prisma.lead.update({
        where: { id: lead.id },
        data: {
          validationStatus: 'Risky'
        }
      });

      if (dispatch) {
        await prisma.emailEvent.create({
          data: {
            messageId: dispatch.messageId,
            eventType: 'send_failed'
          }
        });
      }
    }
    return { action: 'continue' };
  }

  // classification === 'hard'
  console.log(`[SendFailureHandler] Hard bounce detected for lead ${lead.email}. Permanently failing enrollment and lead.`);

  await prisma.campaignEnrollment.update({
    where: { id: enrollment.id },
    data: {
      status: 'Failed',
      nextActionDate: null,
      lastError: errMsg,
      lastBounceType: 'hard'
    }
  });

  await prisma.lead.update({
    where: { id: lead.id },
    data: {
      status: 'Bounced',
      validationStatus: 'Invalid'
    }
  });

  if (dispatch) {
    await prisma.emailEvent.create({
      data: {
        messageId: dispatch.messageId,
        eventType: 'bounce'
      }
    });
  }

  return { action: 'continue' };
}

/**
 * Main entry point for the background sending loop.
 */
export async function processDueEmails() {
  console.log('[SendEngine] Starting processing cycle...');

  // Auto-resume campaigns whose quota-driven pause has elapsed. Restart-safe:
  // pause state lives in the DB, so a process recycle doesn't strand campaigns.
  try {
    await autoResumeQuotaPausedCampaigns();
  } catch (err) {
    console.error('[SendEngine] Failed to auto-resume quota-paused campaigns:', err);
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
      // Only the lead rides along per row. The campaign (whose steps carry
      // large HTML bodies) is fetched ONCE per distinct id below — including
      // it here serialized every step body once per enrollment row, which at
      // volume produced multi-hundred-MB Prisma responses each 30s cycle and
      // OOM'd the server.
      include: {
        lead: true,
      },
      take: 100, // Batch limit to prevent timeouts
    });

    if (dueEnrollments.length === 0) {
      console.log('[SendEngine] No emails due in this cycle.');
      return;
    }

    // Fetch each distinct campaign once and join in memory.
    const campaignIds = [...new Set(dueEnrollments.map((e) => e.campaignId))];
    const dueCampaigns = await prisma.campaign.findMany({
      where: { id: { in: campaignIds } },
      include: {
        steps: { orderBy: { stepOrder: 'asc' } },
        senderAccount: true,
        senders: { include: { senderAccount: true } },
      },
    });
    const campaignMap = new Map(dueCampaigns.map((c) => [c.id, c]));

    // Build map of sent counts today for each unique sender in the batch
    const senderIds = new Set<string>();
    for (const campaign of dueCampaigns) {
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

    for (const enrollment of dueEnrollments) {
      const campaign = campaignMap.get(enrollment.campaignId);
      const lead = enrollment.lead;
      if (!campaign) continue; // campaign deleted between queries
      
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
        const { providerMessageId } = await sendMessage(
          {
            to: lead.email,
            subject,
            body: finalBody,
            isHtml,
            sender: chosenSender,
            trackOpens: campaign.trackOpens,
          },
          settings
        );

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

        // Soft/hard bounce classification + retry/backoff (shared with the manual run route).
        const result = await handleSendFailure(enrollment, lead, dispatch, err, campaign.name, campaign.id);
        if (result.action === 'break') {
          // Quota limit hit — any further sends this cycle will also fail.
          break;
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
