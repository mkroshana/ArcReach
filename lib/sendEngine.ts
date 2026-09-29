import { randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from './db';
import { getGlobalSettings } from './settings';
import { checkGlobalRateLimits } from './rateLimits';
import { applyEmailTracking } from './emailTracking';
import { sendMessage, sendingDisabledReason } from './emailProvider';
import { sendableEnrollmentWhere, claimEnrollmentForSend, releaseEnrollmentClaim, RELEASED_CLAIM } from './sendEligibility';
import { type SendSchedule, SCHEDULE_DAYS, isValidTimezone, minutesOfDay, parseSendSchedule } from './sendSchedule';

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

  // Always mark the pre-created Sending dispatch as Failed so it isn't counted in metrics
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
          data: { nextActionDate: resumeTime, ...RELEASED_CLAIM },
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
          lastBounceType: 'soft',
          ...RELEASED_CLAIM
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
          lastBounceType: 'soft',
          ...RELEASED_CLAIM
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
      lastBounceType: 'hard',
      ...RELEASED_CLAIM
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
 * Status of the dispatch already recorded for this (campaign, lead, step):
 * 'Sent' once the provider accepted it, 'Sending' while a send is in flight or
 * was interrupted, 'Unknown' when an interrupted send could not be checked
 * with ACS (it may have gone out, so it is never sent again), or null when the
 * step has not been sent. Failed attempts don't count.
 */
export async function findStepDispatchStatus(
  campaignId: string,
  leadId: string,
  stepOrder: number
): Promise<'Sent' | 'Sending' | 'Unknown' | null> {
  for (const status of ['Sent', 'Sending', 'Unknown'] as const) {
    const dispatch = await prisma.emailDispatch.findFirst({
      where: { campaignId, leadId, stepOrder, status },
      select: { id: true },
    });
    if (dispatch) return status;
  }
  return null;
}

/** Retries of recordAcceptedSend's transaction after its first attempt fails. */
export const BOOKKEEPING_RETRIES = 3;
const BOOKKEEPING_RETRY_DELAY_MS = 250;

/**
 * Records a send the provider accepted: marks the dispatch Sent with the final
 * body and provider message id, advances the enrollment and releases its
 * claim, and counts the send toward the sender's warmup, in one transaction
 * retried up to BOOKKEEPING_RETRIES times. It never throws: the email is out,
 * so a database error here must not mark the dispatch Failed or queue the step
 * again. If every attempt fails, the dispatch stays 'Sending' with its
 * operationId, which keeps the step from being sent again, and the failure is
 * logged for reconciliation. Returns whether the send was recorded.
 */
export async function recordAcceptedSend(send: {
  dispatchId: string;
  operationId: string;
  /** Final tracked body. Omitted when reconciling, which keeps the recorded body. */
  finalBody?: string;
  providerMessageId: string | null;
  /** Null when the dispatch has no enrollment to advance. */
  enrollmentId: string | null;
  enrollmentAdvance: Prisma.CampaignEnrollmentUpdateManyMutationInput;
  /** Further conditions the enrollment must still meet to be advanced. */
  enrollmentWhere?: Prisma.CampaignEnrollmentWhereInput;
  sender: { id: string; warmupEnabled: boolean } | null;
}): Promise<boolean> {
  const dispatchData: Prisma.EmailDispatchUpdateManyMutationInput = { status: 'Sent' };
  if (send.finalBody !== undefined) {
    dispatchData.body = send.finalBody;
  }
  if (send.providerMessageId) {
    dispatchData.messageId = send.providerMessageId;
  }

  for (let attempt = 0; ; attempt++) {
    try {
      await prisma.$transaction(async (tx) => {
        // Only a dispatch still 'Sending' is recorded, so a retry after an
        // attempt that committed but lost its reply changes nothing twice.
        const { count } = await tx.emailDispatch.updateMany({
          where: { id: send.dispatchId, status: 'Sending' },
          data: dispatchData,
        });
        if (count === 0) return;
        // updateMany: an enrollment deleted during the send (lead verification
        // drops enrollments) must not stop the send itself being recorded.
        if (send.enrollmentId) {
          await tx.campaignEnrollment.updateMany({
            where: { ...send.enrollmentWhere, id: send.enrollmentId },
            data: send.enrollmentAdvance,
          });
        }
        if (send.sender?.warmupEnabled) {
          await tx.senderAccount.updateMany({
            where: { id: send.sender.id },
            data: { warmupSent: { increment: 1 } },
          });
        }
      });
      return true;
    } catch (err: any) {
      if (attempt >= BOOKKEEPING_RETRIES) {
        console.error(
          `[SendEngine] ACCEPTED SEND NOT RECORDED after ${attempt + 1} attempts: ACS accepted operation ${send.operationId}, but dispatch ${send.dispatchId} stays Sending and enrollment ${send.enrollmentId} did not advance. The step will not be sent again; reconcile this dispatch.`,
          err?.message || err
        );
        return false;
      }
      console.warn(
        `[SendEngine] Recording accepted send ${send.dispatchId} failed (attempt ${attempt + 1}); retrying:`,
        err?.message || err
      );
      await new Promise((resolve) => setTimeout(resolve, BOOKKEEPING_RETRY_DELAY_MS * 2 ** attempt));
    }
  }
}

/** Most enrollments one send cycle loads. */
export const DUE_BATCH_SIZE = 100;
/** Most of one cycle's enrollments a single campaign may take, so a large campaign cannot starve the others. */
export const DUE_BATCH_PER_CAMPAIGN = 25;

type DueEnrollment = Prisma.CampaignEnrollmentGetPayload<{ include: { lead: true } }>;

/**
 * Loads the enrollments due at `now` with their leads, longest waiting first
 * (by nextActionDate, then id), at most DUE_BATCH_PER_CAMPAIGN from any one
 * campaign and DUE_BATCH_SIZE in all. Campaigns with no steps are left out:
 * they have nothing to send.
 */
export async function loadDueEnrollments(now: Date): Promise<DueEnrollment[]> {
  const dueWhere: Prisma.CampaignEnrollmentWhereInput = {
    // Send guards: Active enrollment and campaign, lead still sendable.
    // Each send re-checks them when it claims the enrollment.
    ...sendableEnrollmentWhere(),
    nextActionDate: { lte: now },
    AND: [{ campaign: { steps: { some: {} } } }],
  };

  // Each pass takes the oldest due rows not yet in the batch. Rows past a
  // campaign's share are dropped and that campaign is left out of the next
  // pass, which fills the freed places from the other campaigns. Another pass
  // only runs when a campaign reached its share in this one, so there are at
  // most DUE_BATCH_SIZE / DUE_BATCH_PER_CAMPAIGN + 1, and the batch stays in
  // due order.
  const batch: DueEnrollment[] = [];
  const perCampaign = new Map<string, number>();
  while (batch.length < DUE_BATCH_SIZE) {
    const full = [...perCampaign].filter(([, n]) => n >= DUE_BATCH_PER_CAMPAIGN).map(([id]) => id);
    const take = DUE_BATCH_SIZE - batch.length;
    // Only the lead rides along per row. The campaign (whose steps carry
    // large HTML bodies) is fetched ONCE per distinct id by the caller —
    // including it here serialized every step body once per enrollment row,
    // which at volume produced multi-hundred-MB Prisma responses each 30s
    // cycle and OOM'd the server.
    const rows = await prisma.campaignEnrollment.findMany({
      where: { ...dueWhere, id: { notIn: batch.map((e) => e.id) }, campaignId: { notIn: full } },
      orderBy: [{ nextActionDate: 'asc' }, { id: 'asc' }],
      include: { lead: true },
      take,
    });
    let capped = false;
    for (const row of rows) {
      const taken = perCampaign.get(row.campaignId) ?? 0;
      if (taken >= DUE_BATCH_PER_CAMPAIGN) {
        capped = true;
        continue;
      }
      perCampaign.set(row.campaignId, taken + 1);
      batch.push(row);
    }
    if (!capped || rows.length < take) break;
  }
  return batch;
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

    // Only Azure Communication Services sends. Without it nothing is dispatched
    // and no enrollment moves, so campaigns pick up where they were once it is.
    const settings = await getGlobalSettings();
    const sendingDisabled = sendingDisabledReason(settings);
    if (sendingDisabled) {
      console.warn(`[SendEngine] ${sendingDisabled} Skipping this cycle.`);
      return;
    }

    // 1. Fetch leads that are due for action (enrolled in campaigns with nextActionDate in the past)
    const dueEnrollments = await loadDueEnrollments(now);

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

    // Sends still in flight ('Sending') or never confirmed ('Unknown') count
    // toward the cap as well as 'Sent' ones.
    const senderSentToday = new Map<string, number>();
    for (const senderId of senderIds) {
      const count = await prisma.emailDispatch.count({
        where: {
          senderAccountId: senderId,
          status: { in: ['Sending', 'Sent', 'Unknown'] },
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

      // 4. Check Timezone & Sending Schedule restrictions. Outside the window
      // the enrollment waits until it next opens: left due, it would come back
      // at the front of every batch ahead of campaigns that can send.
      const windowCheckedAt = new Date();
      const isWithinSendingWindow = checkSendingWindow(campaign.timezone, campaign.sendSchedule, windowCheckedAt);
      if (!isWithinSendingWindow) {
          let opensAt = nextWindowOpening(campaign.timezone, campaign.sendSchedule, windowCheckedAt);
          if (opensAt) {
            console.log(`[SendEngine] Lead ${lead.email} is outside the sending window for ${campaign.timezone}; waiting until ${opensAt.toISOString()}.`);
          } else {
            opensAt = new Date(windowCheckedAt);
            opensAt.setDate(opensAt.getDate() + 1);
            console.warn(`[SendEngine] Campaign "${campaign.name}" (${campaign.id}) has a sending window that never opens (no days, a bad time or an unknown timezone). Checking lead ${lead.email} again in a day.`);
          }
          await prisma.campaignEnrollment.updateMany({
            // Only while it is still due on this step, so a date set since the batch loaded stands.
            where: { id: enrollment.id, currentSequenceStep: enrollment.currentSequenceStep, nextActionDate: { lte: now } },
            data: { nextActionDate: opensAt },
          });
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

      // Claim the enrollment for this step. The claim re-checks, right before
      // the send, that the enrollment and campaign are still Active and the
      // lead still sendable, and keeps any other send path off this row.
      const claimToken = await claimEnrollmentForSend(enrollment.id, currentStepOrder);
      if (!claimToken) {
        console.log(`[SendEngine] Lead ${lead.email} skipped (paused, suppressed, moved on or claimed by another send since this batch was loaded).`);
        continue;
      }

      // Idempotency guard: never send the same step to the same lead twice.
      const priorDispatch = await findStepDispatchStatus(campaign.id, lead.id, currentStepOrder);
      if (priorDispatch === 'Sending') {
        // Another send of this step is in flight or was interrupted; leave it alone.
        console.log(`[SendEngine] Lead ${lead.email} skipped (step ${currentStepOrder} already has a dispatch in Sending).`);
        await releaseEnrollmentClaim(enrollment.id, claimToken);
        continue;
      }
      if (priorDispatch === 'Sent' || priorDispatch === 'Unknown') {
        // Advance the enrollment past this already-sent step without re-dispatching.
        // An 'Unknown' send may have gone out, so it is never sent again either.
        const nextStepOrder = currentStepOrder + 1;
        const nextStep = campaign.steps.find((s: any) => s.stepOrder === nextStepOrder);
        if (nextStep) {
          const nextDate = new Date();
          nextDate.setDate(now.getDate() + nextStep.waitDays);
          await prisma.campaignEnrollment.update({
            where: { id: enrollment.id },
            data: { currentSequenceStep: nextStepOrder, nextActionDate: nextDate, ...RELEASED_CLAIM },
          });
        } else {
          await prisma.campaignEnrollment.update({
            where: { id: enrollment.id },
            data: { status: 'Completed', nextActionDate: null, ...RELEASED_CLAIM },
          });
        }
        continue;
      }

      // Create dispatch record FIRST so we have a dispatchId for tracking URLs.
      // It stays 'Sending' until the provider accepts the message, and carries
      // the ACS Operation-Id the send is made under.
      const operationId = randomUUID();
      let dispatch: { id: string };
      try {
        dispatch = await prisma.emailDispatch.create({
          data: {
            leadId: lead.id,
            campaignId: campaign.id,
            senderAccountId: chosenSender.id,
            messageId: syntheticMessageId,
            operationId,
            subject,
            body: baseBody,
            stepOrder: currentStepOrder,
            status: 'Sending',
          }
        });
      } catch (err: any) {
        // Nothing was sent, and a database error says nothing about the lead,
        // so it isn't classified: release the claim and leave the step due.
        console.error(`[SendEngine] Could not record a dispatch for ${lead.email}; nothing was sent:`, err.message || err);
        await releaseEnrollmentClaim(enrollment.id, claimToken);
        continue;
      }

      // Apply self-hosted tracking (pixel + link rewriting + unsubscribe link)
      const finalBody = applyEmailTracking(
        baseBody,
        dispatch.id,
        isHtml,
        campaign.trackOpens,
        campaign.trackClicks,
        lead.id
      );

      // Send Email. Only the provider call is failure-classified.
      let providerMessageId: string | null;
      try {
        ({ providerMessageId } = await sendMessage(
          {
            to: lead.email,
            subject,
            body: finalBody,
            isHtml,
            sender: chosenSender,
            trackOpens: campaign.trackOpens,
            operationId,
          },
          settings
        ));
      } catch (err: any) {
        console.error(`[SendEngine Failure] Could not send to ${lead.email}:`, err.message || err);

        // Soft/hard bounce classification + retry/backoff (shared with the send reconciler).
        const result = await handleSendFailure(enrollment, lead, dispatch, err, campaign.name, campaign.id);
        if (result.action === 'break') {
          // Quota limit hit — any further sends this cycle will also fail.
          break;
        }
        continue;
      }

      // 7. Advance enrollment to the next step since send succeeded
      const nextStepOrder = currentStepOrder + 1;
      const nextStep = campaign.steps.find(s => s.stepOrder === nextStepOrder);

      let enrollmentAdvance;
      if (nextStep) {
        const nextDate = new Date();
        nextDate.setDate(now.getDate() + nextStep.waitDays);

        enrollmentAdvance = {
          currentSequenceStep: nextStepOrder,
          nextActionDate: nextDate,
          ...RELEASED_CLAIM,
        };
      } else {
        // Completed sequence
        enrollmentAdvance = {
          status: 'Completed',
          nextActionDate: null,
          ...RELEASED_CLAIM,
        };
      }

      // The provider accepted the message: mark the dispatch Sent, advance the
      // enrollment and release its claim in one retried transaction. A failure
      // here never marks the send Failed or queues the step again.
      await recordAcceptedSend({
        dispatchId: dispatch.id,
        operationId,
        finalBody,
        providerMessageId,
        enrollmentId: enrollment.id,
        enrollmentAdvance,
        sender: chosenSender,
      });

      // Update local sent count tracking
      senderSentToday.set(chosenSender.id, (senderSentToday.get(chosenSender.id) || 0) + 1);
    }

    console.log('[SendEngine] Cycle completed.');

  } catch (error) {
    console.error('[SendEngine] Error during processing cycle:', error);
  }
}

const MINUTE_MS = 60_000;
const MINUTES_PER_DAY = 24 * 60;

type LocalTime = { day: string; minute: number };

/** Reads an instant's weekday ('Mon'..'Sun') and minute of the day in `timezone`, or null for an unknown timezone. */
function localClock(timezone: unknown): ((at: number) => LocalTime) | null {
  if (!isValidTimezone(timezone)) return null;
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  return (at) => {
    const parts = format.formatToParts(at);
    const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return { day: part('weekday'), minute: (Number(part('hour')) % 24) * 60 + Number(part('minute')) };
  };
}

/** A stored schedule (a JSON value, or legacy JSON text) as a complete window, or null when it is not one. */
function storedSchedule(schedule: unknown): SendSchedule | null {
  return parseSendSchedule(typeof schedule === 'string' ? JSON.parse(schedule) : schedule);
}

/**
 * Whether the window is open at a local weekday and minute; both bounds are
 * inclusive to the minute. A window running past midnight belongs to the day
 * it opens on: Mon 22:00-06:00 sends from Monday 22:00 until Tuesday 06:00.
 */
function windowOpenAt(sched: SendSchedule, local: LocalTime): boolean {
  const start = minutesOfDay(sched.window.start);
  const end = minutesOfDay(sched.window.end);
  if (start <= end) {
    return local.minute >= start && local.minute <= end && sched.days.includes(local.day);
  }
  if (local.minute >= start) return sched.days.includes(local.day);
  if (local.minute <= end) {
    const previousDay = SCHEDULE_DAYS[(SCHEDULE_DAYS.indexOf(local.day) + 6) % 7];
    return sched.days.includes(previousDay);
  }
  return false;
}

/**
 * Whether `now` is inside the campaign's sending window in its timezone. A
 * campaign with no saved schedule may send at any time. A schedule with no
 * days or a missing or malformed HH:MM time, an unknown timezone, or any
 * error keeps the window closed.
 */
export function checkSendingWindow(timezone: string, schedule: unknown, now: Date = new Date()): boolean {
  if (schedule === null || schedule === undefined) return true;
  try {
    const sched = storedSchedule(schedule);
    const clock = localClock(timezone);
    if (!sched || !clock) return false;
    return windowOpenAt(sched, clock(now.getTime()));
  } catch (err) {
    console.error('[SendEngine] Error in checkSendingWindow:', err);
    return false; // fail closed: never send on a window that could not be checked
  }
}

/**
 * The first moment at or after `from` when checkSendingWindow is open: `from`
 * itself when the window is open then, otherwise the minute it next opens in
 * the campaign's timezone, across daylight-saving changes. Null when the
 * schedule or timezone is invalid, so the window never opens.
 */
export function nextWindowOpening(timezone: string, schedule: unknown, from: Date): Date | null {
  if (schedule === null || schedule === undefined) return from;
  try {
    const sched = storedSchedule(schedule);
    const clock = localClock(timezone);
    if (!sched || !clock) return null;
    if (windowOpenAt(sched, clock(from.getTime()))) return from;

    const start = minutesOfDay(sched.window.start);
    let t = Math.floor(from.getTime() / MINUTE_MS) * MINUTE_MS;
    // Each pass jumps to the next time the local clock reads the start time.
    // The window only opens there, so a week of passes (plus one for a
    // daylight-saving change) always reaches a permitted day.
    for (let pass = 0; pass < 10; pass++) {
      const wait = (start - clock(t).minute + MINUTES_PER_DAY) % MINUTES_PER_DAY || MINUTES_PER_DAY;
      const next = t + wait * MINUTE_MS;
      if (clock(next).minute !== start) {
        // A daylight-saving change moved the clock on the way, possibly past the
        // start time, so find the first open minute one at a time.
        for (let at = t + MINUTE_MS; at <= next; at += MINUTE_MS) {
          if (windowOpenAt(sched, clock(at))) return new Date(at);
        }
      } else if (windowOpenAt(sched, clock(next))) {
        return new Date(next);
      }
      t = next;
    }
    return null;
  } catch (err) {
    console.error('[SendEngine] Error in nextWindowOpening:', err);
    return null;
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
