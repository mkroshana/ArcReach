import { randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from './db';
import { getGlobalSettings } from './settings';
import { checkGlobalRateLimits } from './rateLimits';
import { applyEmailTracking } from './emailTracking';
import { listUnsubscribeHeaders, signUnsubscribeToken } from './unsubscribeLink';
import { personalizeEmail, renderEmailBody } from './personalize';
import { sendMessage, sendingDisabledReason } from './emailProvider';
import { sendableEnrollmentWhere, claimEnrollmentForSend, releaseEnrollmentClaim, RELEASED_CLAIM } from './sendEligibility';
import { suppressEmail } from './suppression';
import { type SendSchedule, SCHEDULE_DAYS, hasSendingSchedule, isValidTimezone, minutesOfDay, parseSendSchedule } from './sendSchedule';
import type { PauseReason } from './campaignPause';

/** Most due auto-resumes one call ends; any others are ended by the next send cycle's call. */
export const AUTO_RESUME_BATCH_SIZE = 100;

/**
 * Ends the send engine's pauses whose pausedUntil has elapsed, longest due
 * first and at most AUTO_RESUME_BATCH_SIZE per call. A campaign with a complete
 * sending schedule (sending days, a start and end time and a valid timezone)
 * resumes to Active; one without goes to Draft instead, as only a campaign with
 * one may be Active. Each campaign is written only while it is still Paused,
 * due and unchanged since this call read it, so a status or schedule a user
 * saved meanwhile stands (the next call looks at it again) and concurrent
 * workers end each pause once. Any status a user sets clears pausedUntil, so a
 * user's pause is never ended here.
 *
 * Returns the number of campaigns resumed to Active.
 */
export async function autoResumeQuotaPausedCampaigns(now: Date = new Date()): Promise<number> {
  const due = await prisma.campaign.findMany({
    where: { status: 'Paused', pausedUntil: { lte: now } },
    select: { id: true, name: true, timezone: true, sendSchedule: true, updatedAt: true },
    orderBy: [{ pausedUntil: 'asc' }, { id: 'asc' }],
    take: AUTO_RESUME_BATCH_SIZE,
  });
  let resumed = 0;
  for (const campaign of due) {
    const scheduled = hasSendingSchedule(campaign.timezone, campaign.sendSchedule);
    const { count } = await prisma.campaign.updateMany({
      where: { id: campaign.id, status: 'Paused', pausedUntil: { lte: now }, updatedAt: campaign.updatedAt },
      data: { status: scheduled ? 'Active' : 'Draft', pausedUntil: null, pauseReason: null },
    });
    if (count === 0) continue;
    if (scheduled) {
      resumed++;
    } else {
      console.warn(`[SendEngine] Campaign "${campaign.name}" (${campaign.id}) has no complete sending schedule, so it never sends. Its auto-resume set it to Draft instead of Active until a schedule is saved and it is published again.`);
    }
  }
  if (resumed > 0) {
    console.log(`[SendEngine] Auto-resumed ${resumed} campaign(s) after quota reset.`);
  }
  return resumed;
}

/**
 * Pauses every Active campaign whose owner is disabled, as disabling the user
 * does ('owner_disabled', never resumed on its own). Disabling pauses them in
 * its own transaction; this catches one a write racing it left Active. Nothing
 * is sent for them meanwhile either: sendableEnrollmentWhere leaves them out.
 *
 * Returns the number of campaigns paused.
 */
export async function pauseCampaignsOfDisabledOwners(): Promise<number> {
  const pauseReason: PauseReason = 'owner_disabled';
  const { count } = await prisma.campaign.updateMany({
    where: { status: 'Active', user: { disabledAt: { not: null } } },
    data: { status: 'Paused', pausedUntil: null, pauseReason },
  });
  if (count > 0) {
    console.warn(`[SendEngine] Paused ${count} Active campaign(s) whose owner is disabled.`);
  }
  return count;
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

/** A mailbox's daily and warmup caps limit its sends in any rolling 24 hours, not per calendar day. */
export const SENDER_CAP_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The dispatches a mailbox's daily and warmup caps count: its sends in the 24
 * hours before `now` that are in flight ('Sending'), accepted ('Sent') or
 * never confirmed ('Unknown'). A 'Failed' attempt sent nothing and does not
 * count. Each send stops counting exactly 24 hours after it was made.
 */
export function senderCapDispatchWhere(senderAccountId: string, now: Date): Prisma.EmailDispatchWhereInput {
  return {
    senderAccountId,
    status: { in: ['Sending', 'Sent', 'Unknown'] },
    sentAt: { gt: new Date(now.getTime() - SENDER_CAP_WINDOW_MS) },
  };
}

/**
 * Why a mailbox may not make one more send outside the engine (a Unibox reply
 * or a mailbox test), or null when it may. Its sends are counted against its
 * daily or warmup cap exactly as the engine counts them.
 */
export async function senderCapReachedReason(
  sender: Parameters<typeof getEffectiveDailyCap>[0] & { id: string; emailAddress: string },
  now: Date
): Promise<string | null> {
  const cap = getEffectiveDailyCap(sender, now);
  const sent = await prisma.emailDispatch.count({ where: senderCapDispatchWhere(sender.id, now) });
  if (sent < cap) return null;
  // The effective cap is below the daily limit only while the warmup ramp holds it back.
  const capName = cap < sender.dailyLimit ? 'warmup' : 'daily';
  return `${sender.emailAddress} has reached its ${capName} cap of ${cap} emails in the last 24 hours. Nothing was sent; it can send again as those sends pass 24 hours old.`;
}

/**
 * When a mailbox at its cap can send again: once its cap-th newest counted
 * send leaves the 24-hour window, fewer than cap sends remain in it. `now`
 * when fewer than cap sends count (it is under its cap already), and null for
 * a cap of 0, which no send leaving the window lifts.
 */
async function senderCapacityFreesAt(
  sender: Parameters<typeof getEffectiveDailyCap>[0] & { id: string },
  now: Date
): Promise<Date | null> {
  const cap = getEffectiveDailyCap(sender, now);
  if (cap <= 0) return null;
  const capthNewest = await prisma.emailDispatch.findFirst({
    where: senderCapDispatchWhere(sender.id, now),
    orderBy: { sentAt: 'desc' },
    skip: cap - 1,
    select: { sentAt: true },
  });
  return capthNewest ? new Date(capthNewest.sentAt.getTime() + SENDER_CAP_WINDOW_MS) : now;
}

/**
 * When the first mailbox in a pool that is at its caps can send again, or null
 * when no send leaving the window frees any of them. Each mailbox is looked up
 * once per cycle through `cache`: at its cap, it sends nothing more that cycle.
 */
async function poolCapacityFreesAt(
  pool: Array<any>,
  now: Date,
  cache: Map<string, Date | null>
): Promise<Date | null> {
  let earliest: Date | null = null;
  for (const sender of pool) {
    if (!cache.has(sender.id)) cache.set(sender.id, await senderCapacityFreesAt(sender, now));
    const freesAt = cache.get(sender.id) ?? null;
    if (freesAt && (!earliest || freesAt < earliest)) earliest = freesAt;
  }
  return earliest;
}

/**
 * Resolves the pool of senders for a campaign, defaulting to the primary sender if pool is empty.
 * A campaign only ever sends from mailboxes its owner owns: other users'
 * mailboxes are left out of the pool (before falling back to the primary
 * sender) and returned in `foreign`. An empty pool means the campaign has no
 * mailbox it may send from.
 */
export function resolveCampaignSenders(campaign: {
  userId: string;
  senderAccount: any;
  senders?: Array<{ senderAccount: any }>;
}): { pool: any[]; foreign: any[] } {
  const ownedByOwner = (account: any) => account?.userId === campaign.userId;
  const listed = (campaign.senders ?? []).map(s => s.senderAccount);
  const pool = listed.filter(ownedByOwner);
  const foreign = listed.filter(account => !ownedByOwner(account));
  if (pool.length === 0) {
    if (ownedByOwner(campaign.senderAccount)) {
      pool.push(campaign.senderAccount);
    } else if (!foreign.some(account => account?.id === campaign.senderAccount?.id)) {
      foreign.push(campaign.senderAccount);
    }
  }
  return { pool, foreign };
}

/**
 * Pauses an Active campaign that has no sender mailbox its owner owns, as a
 * systemic pause: nothing can be sent until its senders are changed. Like the
 * other engine pauses it resumes after an hour, when the senders are checked
 * again. Never throws, so one campaign cannot stop the cycle.
 */
async function pauseCampaignWithoutOwnedSender(campaign: { id: string; name: string; userId: string }): Promise<void> {
  try {
    const resumeTime = new Date();
    resumeTime.setHours(resumeTime.getHours() + 1);
    const pauseReason: PauseReason = 'systemic';
    const { count } = await prisma.campaign.updateMany({
      where: { id: campaign.id, status: 'Active' },
      data: { status: 'Paused', pausedUntil: resumeTime, pauseReason },
    });
    const problem = `Campaign "${campaign.name}" (${campaign.id}) has no sender mailbox owned by its owner (user ${campaign.userId}), so nothing can be sent from it. Choose mailboxes the owner owns as its senders.`;
    if (count > 0) {
      console.warn(`[SendEngine] ${problem} Paused the campaign for 1 hour.`);
    } else {
      console.warn(`[SendEngine] ${problem} It is no longer Active, so it was not paused.`);
    }
  } catch (err: any) {
    console.error(`[SendEngine] Failed to pause campaign "${campaign.name}" (${campaign.id}) that has no sender mailbox owned by its owner:`, err?.message || err);
  }
}

/**
 * Sets an Active campaign with no complete sending schedule (sending days, a
 * start and end time and a valid timezone) back to Draft: its window never
 * opens, so its leads would only be rescheduled every day, and it may not be
 * made Active again without one. Only while it is still Active and unchanged
 * since this cycle loaded it, so a schedule saved meanwhile stands. Never
 * throws, so one campaign cannot stop the cycle.
 */
async function draftCampaignWithoutSchedule(campaign: { id: string; name: string; updatedAt: Date }): Promise<void> {
  try {
    const { count } = await prisma.campaign.updateMany({
      where: { id: campaign.id, status: 'Active', updatedAt: campaign.updatedAt },
      data: { status: 'Draft', pausedUntil: null, pauseReason: null },
    });
    const problem = `Campaign "${campaign.name}" (${campaign.id}) has no complete sending schedule, so it never sends.`;
    if (count > 0) {
      console.warn(`[SendEngine] ${problem} Set it back to Draft until a schedule is saved and it is published again.`);
    } else {
      console.warn(`[SendEngine] ${problem} It is no longer Active or has changed since this cycle loaded it, so it was left as it is.`);
    }
  } catch (err: any) {
    console.error(`[SendEngine] Failed to set campaign "${campaign.name}" (${campaign.id}) with no complete sending schedule back to Draft:`, err?.message || err);
  }
}

/**
 * Picks the sender with the maximum remaining capacity under its cap over the
 * last 24 hours (least-loaded under cap).
 * Returns null if all senders in the pool are at cap.
 */
export function pickSender(
  pool: Array<any>,
  sentLast24Hours: Map<string, number>,
  now: Date
): any | null {
  let selectedSender: any | null = null;
  let maxRemaining = -1;

  for (const sender of pool) {
    const cap = getEffectiveDailyCap(sender, now);
    const sent = sentLast24Hours.get(sender.id) || 0;
    const remaining = cap - sent;

    if (remaining > 0 && remaining > maxRemaining) {
      maxRemaining = remaining;
      selectedSender = sender;
    }
  }

  return selectedSender;
}

export const RETRY_BACKOFF_HOURS = [1, 6, 24]; // hour mapping: attempt 1 -> +1h, 2 -> +6h, 3 -> +24h
// The first send plus one retry per backoff: a soft failure after the last backoff fails the enrollment.
export const MAX_SEND_ATTEMPTS = RETRY_BACKOFF_HOURS.length + 1;

/**
 * Azure HMAC clock-skew rejection: host clock drifted >5 min, needs an App
 * Service restart; requests recover after resync.
 */
function isClockSkewError(message: string): boolean {
  return message.toLowerCase().includes('time difference between the originating client');
}

/**
 * Quota refusals matched only by their wording that one enrollment may get in
 * a row. The next one is handled as a soft failure of that lead instead of
 * pausing the campaign again. Each refusal pauses the campaign for an hour, by
 * which time ACS's hourly quota has reset, so a real quota rarely refuses the
 * same enrollment this often. ACS's own 429 or quota code never counts: it is
 * about the resource, never the lead.
 */
export const MAX_CONSECUTIVE_QUOTA_FAILURES = 5;

/** ACS error codes that refuse every send until the configuration is fixed (the sender's domain is not linked to the resource). */
const SYSTEMIC_ERROR_CODES = ['DomainNotLinked'];
/** ACS error codes for its sending quota or rate limit. */
const QUOTA_ERROR_CODES = ['TooManyRequests', 'QuotaExceeded'];
/** Sending-quota and rate-limit wording, matched as whole words. */
const SENDING_QUOTA_PATTERN =
  /\btoo many requests\b|\brate[- ]?limit(s|ed|ing)?\b|\bthrottl(e|ed|ing)\b|\bsend(ing)? (quota|limits?|rate)\b|\b(daily|hourly) (sending )?(quota|limits?)\b/;
/** A recipient's mailbox being full or over its storage quota: about the lead, not the campaign's sending quota. */
const RECIPIENT_MAILBOX_FULL_PATTERN = /\b(mailbox|inbox|recipient)\b[^.;]*\b(quota|full)\b|\bover quota\b|\b[45]\.2\.2\b/;

/** ACS itself refused the send for its quota or rate limit (a 429 or a quota error code). */
function isProviderQuotaRefusal(err: any): boolean {
  return Number(err?.statusCode) === 429 || (typeof err?.code === 'string' && QUOTA_ERROR_CODES.includes(err.code));
}

/** ACS's error code for a send it dropped because every recipient is on its managed suppression list, lower-cased. */
const RECIPIENTS_SUPPRESSED_CODE = 'emaildroppedallrecipientssuppressed';
/**
 * The same refusal in a lower-cased error message: the code inside the old
 * engine's "The long-running operation has failed.
 * EmailDroppedAllRecipientsSuppressed. Message dropped because all recipients
 * were suppressed", or ACS's own wording that the provider now passes on.
 */
const RECIPIENTS_SUPPRESSED_PATTERN = /emaildroppedallrecipientssuppressed|\brecipients were suppressed\b/;

/**
 * ACS refused the send because the address is on its managed suppression list
 * (it hard-bounced on Azure email), known by its error code or its wording.
 */
function isRecipientSuppressedRefusal(code: string, errStr: string): boolean {
  return code.toLowerCase() === RECIPIENTS_SUPPRESSED_CODE || RECIPIENTS_SUPPRESSED_PATTERN.test(errStr);
}

/**
 * Classifies an email sending error:
 *  - 'systemic': no send can go out until the Azure settings, the sender's
 *    domain or the host clock are fixed. Nothing is wrong with the lead.
 *  - 'quota': ACS's sending quota or rate limit.
 *  - 'hard': the recipient address is permanently undeliverable, or ACS
 *    refused it as suppressed.
 *  - 'soft': anything else, retried with backoff.
 */
export function classifyFailure(err: any): 'systemic' | 'quota' | 'hard' | 'soft' {
  const errStr = (err.message || String(err)).toLowerCase();
  const statusCode = Number(err?.statusCode);
  const code = typeof err?.code === 'string' ? err.code : '';

  // 0. Systemic: every send fails the same way until someone fixes the setup,
  // so the campaign pauses and auto-resumes later instead of burning per-lead
  // retries (which would eventually mark innocent leads Failed/Risky). ACS
  // answers 401/403 for a regenerated access key or a clock-skewed signature.
  if (
    err?.name === 'EmailConfigError' ||
    statusCode === 401 ||
    statusCode === 403 ||
    SYSTEMIC_ERROR_CODES.includes(code) ||
    isClockSkewError(errStr)
  ) {
    return 'systemic';
  }

  // 1. Quota check: ACS's 429 first, then its quota wording. A full recipient
  // mailbox is the lead's problem, not the campaign's quota.
  if (isProviderQuotaRefusal(err) || SENDING_QUOTA_PATTERN.test(errStr)) {
    return 'quota';
  }
  if (RECIPIENT_MAILBOX_FULL_PATTERN.test(errStr)) {
    return 'soft';
  }
  if (/\bquota\b/.test(errStr)) {
    return 'quota';
  }

  // ACS dropped the send because the address is on its managed suppression
  // list, which holds addresses that hard-bounced on Azure email. It is a hard
  // bounce, as a 'Suppressed' delivery report is (lib/deliveryReport.ts), so
  // the address is suppressed instead of retried; each retry would only extend
  // Azure's block. Checked before the wording checks below.
  if (isRecipientSuppressedRefusal(code, errStr)) {
    return 'hard';
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
 * Shared error handler for email dispatches. Resolves failure category (systemic, quota,
 * soft, hard) and updates enrollment retry/backoff parameters, lead deliverability
 * indicators, and tracks dispatch statuses. A systemic or quota failure pauses the
 * campaign and leaves the enrollment's retries and the lead's status alone.
 */
export async function handleSendFailure(
  enrollment: { id: string; retryCount: number; quotaFailures: number },
  lead: { id: string; email: string },
  dispatch: any,
  err: any,
  campaignName: string,
  campaignId: string
): Promise<{ action: 'break' | 'continue' }> {
  let classification = classifyFailure(err);
  const errMsg = err.message || String(err);
  // Quota refusals matched only by their wording that keep landing on this one
  // enrollment are about the lead, not the campaign's quota: past
  // MAX_CONSECUTIVE_QUOTA_FAILURES in a row they are retried and failed like
  // soft failures. ACS's own 429 or quota code always pauses the campaign.
  const wordedQuota = classification === 'quota' && !isProviderQuotaRefusal(err);
  const escalated = wordedQuota && enrollment.quotaFailures >= MAX_CONSECUTIVE_QUOTA_FAILURES;
  if (escalated) {
    classification = 'soft';
  }
  console.log(`[SendFailureHandler] Lead: ${lead.email} | Type: ${classification}${escalated ? ` (after ${enrollment.quotaFailures} quota failures in a row)` : ''} | Error: ${errMsg}`);

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

  if (classification === 'quota' || classification === 'systemic') {
    try {
      const resumeTime = new Date();
      resumeTime.setHours(resumeTime.getHours() + 1);
      const pauseReason: PauseReason =
        classification === 'quota' ? 'quota' : isClockSkewError(errMsg) ? 'systemic' : 'config';

      // Atomically pause the campaign with its scheduled resume time and
      // postpone the enrollment so it retries after the reset. Only an Active
      // campaign is paused: a status a user set since the send began stands,
      // and the timer never resumes it. The enrollment's retries are left
      // alone; a quota refusal matched by its wording only counts toward its
      // quota streak.
      const [paused] = await prisma.$transaction([
        prisma.campaign.updateMany({
          where: { id: campaignId, status: 'Active' },
          data: { status: 'Paused', pausedUntil: resumeTime, pauseReason },
        }),
        prisma.campaignEnrollment.update({
          where: { id: enrollment.id },
          data: {
            nextActionDate: resumeTime,
            ...(wordedQuota ? { quotaFailures: { increment: 1 } } : {}),
            ...RELEASED_CLAIM,
          },
        }),
      ]);
      const cause = pauseReason === 'quota' ? 'Quota limit hit' : 'Systemic send failure';
      if (paused.count > 0) {
        console.log(`[SendFailureHandler] ${cause}. Paused campaign "${campaignName}" (${campaignId}) for 1 hour.`);
      } else {
        console.log(`[SendFailureHandler] ${cause}. Campaign "${campaignName}" (${campaignId}) is no longer Active, so it was not paused.`);
      }
    } catch (pauseErr: any) {
      console.error(`[SendFailureHandler] Failed to pause campaign on ${classification} failure:`, pauseErr.message);
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
          // An escalated quota refusal continues the streak; any other soft failure ends it.
          quotaFailures: escalated ? { increment: 1 } : 0,
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
          quotaFailures: 0,
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
      quotaFailures: 0,
      lastError: errMsg,
      lastBounceType: 'hard',
      ...RELEASED_CLAIM
    }
  });

  // The suppression list outlives the lead, so the address is never mailed again
  await suppressEmail(prisma, lead.email, 'HardBounce', 'send-engine');

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

/**
 * The enrollment update once step `stepOrder` was sent at `sentAt`: on to the
 * next step `waitDays` days after the send, or Completed after the last one.
 * The send ends any quota streak, resets the retry budget (which is per step)
 * and releases the claim.
 */
export function advanceAfterSentStep(
  steps: Array<{ stepOrder: number; waitDays: number }>,
  stepOrder: number,
  sentAt: Date
): Prisma.CampaignEnrollmentUpdateManyMutationInput {
  const settled = { retryCount: 0, lastError: null, quotaFailures: 0, ...RELEASED_CLAIM };
  const nextStep = steps.find((s) => s.stepOrder === stepOrder + 1);
  if (nextStep) {
    // Days are added to the send time's own date. Mixing in a date read earlier
    // (a cycle that crossed midnight) moves the step a day, or at a month end a month.
    const nextActionDate = new Date(sentAt);
    nextActionDate.setDate(nextActionDate.getDate() + nextStep.waitDays);
    return { currentSequenceStep: stepOrder + 1, nextActionDate, ...settled };
  }
  return { status: 'Completed', nextActionDate: null, ...settled };
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
  // acceptedAt starts the bot filter's prefetch window (lib/botFilter); the
  // row's sentAt was set before the send, often long before delivery.
  const dispatchData: Prisma.EmailDispatchUpdateManyMutationInput = { status: 'Sent', acceptedAt: new Date() };
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
    await pauseCampaignsOfDisabledOwners();
  } catch (err) {
    console.error('[SendEngine] Failed to pause campaigns whose owner is disabled:', err);
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

    // Each campaign's sender pool, from the mailboxes its owner owns. Other
    // users' mailboxes are skipped, and a campaign left without any is paused
    // and has no pool, so its enrollments are passed over this cycle. A campaign
    // with no complete sending schedule goes back to Draft and has no pool either.
    const senderPools = new Map<string, any[]>();
    for (const campaign of dueCampaigns) {
      if (!hasSendingSchedule(campaign.timezone, campaign.sendSchedule)) {
        await draftCampaignWithoutSchedule(campaign);
        continue;
      }
      const { pool, foreign } = resolveCampaignSenders(campaign);
      if (foreign.length > 0) {
        const mailboxes = foreign.map((account) => `${account.emailAddress} (${account.id})`).join(', ');
        console.warn(`[SendEngine] Campaign "${campaign.name}" (${campaign.id}) skips sender mailbox(es) ${mailboxes}: they do not belong to its owner (user ${campaign.userId}).`);
      }
      if (pool.length === 0) {
        await pauseCampaignWithoutOwnedSender(campaign);
        continue;
      }
      senderPools.set(campaign.id, pool);
    }

    // Build map of sent counts over the last 24 hours for each unique sender in the batch
    const senderIds = new Set<string>();
    for (const pool of senderPools.values()) {
      for (const sender of pool) {
        senderIds.add(sender.id);
      }
    }

    // Sends still in flight ('Sending') or never confirmed ('Unknown') count
    // toward the cap as well as 'Sent' ones; 'Failed' attempts do not.
    const senderSentLast24Hours = new Map<string, number>();
    for (const senderId of senderIds) {
      const count = await prisma.emailDispatch.count({
        where: senderCapDispatchWhere(senderId, now)
      });
      senderSentLast24Hours.set(senderId, count);
    }
    // When each mailbox found at its cap this cycle can send again.
    const senderCapacityFreesAtCache = new Map<string, Date | null>();

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

      // Pick a sender from the campaign's pool per send (least-loaded under cap)
      const senderPool = senderPools.get(campaign.id);
      if (!senderPool) continue; // set back to Draft (no complete schedule) or paused (no sender mailbox its owner owns) above
      const chosenSender = pickSender(senderPool, senderSentLast24Hours, now);

      if (!chosenSender) {
        // Wait until the first mailbox in the pool drops under its cap as its
        // sends leave the 24-hour window; with every cap at 0, check in a day.
        const freesAt = await poolCapacityFreesAt(senderPool, now, senderCapacityFreesAtCache);
        const deferUntil = freesAt ?? new Date(now.getTime() + SENDER_CAP_WINDOW_MS);
        console.log(`[SendEngine] All senders in pool for campaign "${campaign.name}" are at cap. Deferring lead ${lead.email} until ${deferUntil.toISOString()}.`);
        await prisma.campaignEnrollment.update({
          where: { id: enrollment.id },
          data: { nextActionDate: deferUntil }
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
            // A campaign without a complete schedule went back to Draft above, so
            // this is only an error working out the opening.
            opensAt = new Date(windowCheckedAt);
            opensAt.setDate(opensAt.getDate() + 1);
            console.warn(`[SendEngine] Campaign "${campaign.name}" (${campaign.id}): the next opening of its sending window could not be worked out. Checking lead ${lead.email} again in a day.`);
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

      // 6. Personalize the email (Spintax, Variables). Whether the body is HTML
      // is decided from the step's template, and an HTML body gets the lead's
      // values escaped.
      const subject = personalizeEmail(stepContent.subject, lead);
      const { isHtml, body: baseBody } = renderEmailBody(stepContent.body, lead);
      let syntheticMessageId = `${campaign.id}-${lead.id}-${currentStepOrder}-${Date.now()}`;

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
        await prisma.campaignEnrollment.update({
          where: { id: enrollment.id },
          data: advanceAfterSentStep(campaign.steps, currentStepOrder, new Date()),
        });
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

      // Apply self-hosted tracking (pixel + link rewriting + unsubscribe link).
      // The unsubscribe link is signed for this lead and dispatch, and also goes
      // in the List-Unsubscribe headers for mail clients' one-click unsubscribe.
      const unsubscribeToken = signUnsubscribeToken(lead.id, dispatch.id);
      const finalBody = applyEmailTracking(
        baseBody,
        dispatch.id,
        isHtml,
        campaign.trackOpens,
        campaign.trackClicks,
        unsubscribeToken
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
            operationId,
            headers: listUnsubscribeHeaders(unsubscribeToken),
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

      // 7. Advance enrollment to the next step since send succeeded, counting its wait days from now
      const enrollmentAdvance = advanceAfterSentStep(campaign.steps, currentStepOrder, new Date());

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
      senderSentLast24Hours.set(chosenSender.id, (senderSentLast24Hours.get(chosenSender.id) || 0) + 1);
    }

    console.log('[SendEngine] Cycle completed.');

  } catch (error) {
    console.error('[SendEngine] Error during processing cycle:', error);
    // Rethrown so the worker records the failed cycle in its heartbeat
    // (WorkerLease.lastError), which the system status shows.
    throw error;
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
 * Whether `now` is inside the campaign's sending window in its timezone. No
 * saved schedule, a schedule with no days or a missing or malformed HH:MM
 * time, an unknown timezone, or any error keeps the window closed.
 */
export function checkSendingWindow(timezone: string, schedule: unknown, now: Date = new Date()): boolean {
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
 * the campaign's timezone, across daylight-saving changes. Null when there is
 * no schedule or the schedule or timezone is invalid, so the window never opens.
 */
export function nextWindowOpening(timezone: string, schedule: unknown, from: Date): Date | null {
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
