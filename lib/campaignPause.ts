import { hasSendingSchedule } from './sendSchedule';

/**
 * Why a campaign is Paused. The send engine pauses an Active campaign for an
 * hour when ACS refuses a send for a quota or rate limit ('quota'), refuses
 * every send until the host clock is fixed, like the clock-skew check, or the
 * campaign has no sender mailbox its owner owns ('systemic'), or no send can go
 * out until the Azure settings or the sender's domain are fixed ('config':
 * missing settings, a connection string that cannot be decrypted, a refused
 * access key or an unverified domain). It sets pausedUntil and resumes the
 * campaign then, or sets it to Draft when it has no complete sending schedule.
 * A user pause ('user') never resumes on its own. Disabling a
 * user pauses their Active campaigns and cancels any auto-resume of their
 * campaigns ('owner_disabled'); enabling them again resumes nothing. Pure so
 * the campaign pages can use it.
 */
export type PauseReason = 'quota' | 'systemic' | 'config' | 'user' | 'owner_disabled';

/** Campaign statuses the app sets and the UI offers. */
export const CAMPAIGN_STATUSES = ['Draft', 'Active', 'Paused'];

/**
 * The pause columns written with a status a user sets: the user's choice
 * cancels any auto-resume the send engine scheduled, and a user pause is
 * recorded as one.
 */
export function userStatusPause(status: unknown): { pausedUntil: null; pauseReason: PauseReason | null } {
  return { pausedUntil: null, pauseReason: status === 'Paused' ? 'user' : null };
}

const AUTO_PAUSE_REASONS: Record<string, string> = {
  quota: 'sending quota or rate limit reached',
  systemic: 'server clock out of sync with Azure, or no sender mailbox owned by the campaign owner',
  config: 'Azure settings or sender domain not accepted',
};

/** When the send engine ends a campaign's pause, or null when it stays Paused until a user changes it. */
function autoResumeAt(campaign: { status?: string; pausedUntil?: string | Date | null }): Date | null {
  if (campaign.status !== 'Paused' || !campaign.pausedUntil) return null;
  const resumesAt = new Date(campaign.pausedUntil);
  return Number.isNaN(resumesAt.getTime()) ? null : resumesAt;
}

/**
 * "Auto-resumes at HH:MM (reason)", in local 24-hour time, for a campaign the
 * send engine paused, or "Goes to Draft at HH:MM (no sending schedule)" when it
 * has no complete sending schedule, as the auto-resume then sets it to Draft
 * instead of Active. Null when the campaign will not leave Paused on its own.
 */
export function autoResumeNote(campaign: {
  status?: string;
  pausedUntil?: string | Date | null;
  pauseReason?: string | null;
  hasSendingSchedule: boolean;
}): string | null {
  const resumesAt = autoResumeAt(campaign);
  if (!resumesAt) return null;
  const time = resumesAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  if (!campaign.hasSendingSchedule) return `Goes to Draft at ${time} (no sending schedule)`;
  const reason = campaign.pauseReason ? AUTO_PAUSE_REASONS[campaign.pauseReason] : undefined;
  return reason ? `Auto-resumes at ${time} (${reason})` : `Auto-resumes at ${time}`;
}

/**
 * What happens to a campaign without a complete sending schedule, which sends
 * nothing, as a clause ending in `fix` (e.g. "you set one on the Schedule tab"):
 * a Draft stays Draft, a Paused campaign the send engine will auto-resume goes
 * to Draft at that time instead, another Paused one stays Paused, and the send
 * engine sets an Active one back to Draft when its next email is due.
 */
export function noScheduleOutcome(campaign: { status?: string; pausedUntil?: string | Date | null }, fix: string): string {
  if (campaign.status === 'Paused') {
    return autoResumeAt(campaign)
      ? `goes to Draft instead of resuming when its auto-resume time arrives, unless ${fix} before then`
      : `stays Paused and can't be made Active until ${fix}`;
  }
  if (campaign.status === 'Active') return `goes back to Draft when its next email is due, unless ${fix} before then`;
  return `stays Draft until ${fix}`;
}

/**
 * The campaign page's note on a saved sending window that is missing or
 * incomplete, saying what then happens to the campaign, or null when the saved
 * window (a JSON value, or legacy JSON text) and timezone are complete.
 */
export function savedScheduleNote(campaign: {
  status?: string;
  pausedUntil?: string | Date | null;
  timezone?: unknown;
  sendSchedule?: unknown;
}): string | null {
  if (hasSendingSchedule(campaign.timezone, campaign.sendSchedule)) return null;
  if (campaign.sendSchedule == null) {
    return `No sending window is saved, so this campaign sends nothing and ${noScheduleOutcome(campaign, 'you choose days and times and save')}.`;
  }
  return `The saved sending window is incomplete or its timezone is unknown, so this campaign sends nothing and ${noScheduleOutcome(campaign, 'you fix it and save')}.`;
}

/** Why a campaign whose owner is disabled may not be made Active or have its leads queued. */
export const CAMPAIGN_OWNER_DISABLED_ERROR = 'The campaign owner is disabled.';

/**
 * "Paused: owner disabled" for a campaign paused because its owner was
 * disabled, which stays paused until an admin or its owner activates it, or
 * null otherwise.
 */
export function ownerDisabledNote(campaign: { status?: string; pauseReason?: string | null }): string | null {
  return campaign.status === 'Paused' && campaign.pauseReason === 'owner_disabled' ? 'Paused: owner disabled' : null;
}
