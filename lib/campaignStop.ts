/**
 * Stopping a campaign. A user stops an Active or Paused campaign to end its
 * sending: a Stopped campaign sends nothing (the send engine and Run Now only
 * send for Active campaigns), the send engine never resumes it, and it can't
 * be edited until it is restarted, which makes it Active again after the
 * checks publishing runs (complete steps, a sending schedule, an enabled owner).
 *
 * Stop changes only the campaign, never its enrollments: each lead keeps its
 * step and next send date, so a restart continues every lead where it was,
 * and a reply, unsubscribe, bounce or audience change while the campaign is
 * stopped still pauses or ends that lead as it would while Paused. Pure so the
 * campaign pages can use it.
 */

export const STOPPED_STATUS = 'Stopped';

/** The statuses a campaign may be stopped from. */
export const STOPPABLE_STATUSES = ['Active', 'Paused'];

/** Why a stopped campaign refuses a change other than a restart. */
export const CAMPAIGN_STOPPED_ERROR = "This campaign is stopped, so it can't be edited or have its status changed. Restart it first.";

/** Why a Draft (or an already Stopped campaign) can't be stopped. */
export const NOT_STOPPABLE_ERROR = 'Only an Active or Paused campaign can be stopped. A Draft sends nothing, so delete it if it is no longer needed.';

export function isStopped(campaign: { status?: string | null } | null | undefined): boolean {
  return campaign?.status === STOPPED_STATUS;
}

/**
 * Why the collection PUT refuses `updates` (the fields it picked) for a
 * campaign whose status is `current`, as far as stopping goes, or null. A
 * stopped campaign accepts exactly one change, `{ status: 'Active' }` (a
 * restart), and only an Active or Paused campaign may be stopped.
 */
export function stopChangeError(current: string, updates: Record<string, unknown>): string | null {
  if (current === STOPPED_STATUS) {
    const keys = Object.keys(updates);
    return keys.length === 1 && updates.status === 'Active' ? null : CAMPAIGN_STOPPED_ERROR;
  }
  if (updates.status === STOPPED_STATUS && !STOPPABLE_STATUSES.includes(current)) return NOT_STOPPABLE_ERROR;
  return null;
}

/**
 * The stoppedAt a status change from `current` to `next` writes: now when it
 * stops the campaign, null when it restarts one, or nothing (undefined) when
 * neither, so every other status change leaves the column alone.
 */
export function stoppedAtChange(current: string, next: unknown, now: Date = new Date()): Date | null | undefined {
  if (next === STOPPED_STATUS) return current === STOPPED_STATUS ? undefined : now;
  if (current === STOPPED_STATUS && typeof next === 'string') return null;
  return undefined;
}

/**
 * What Stop asks before it stops `name`, with how many leads are still in its
 * sequence (Active enrollments), which keep their place for a restart.
 */
export function stopConfirmMessage(name: string, leadsInSequence: number): string {
  const place = leadsInSequence === 0
    ? 'No lead is still in its sequence.'
    : leadsInSequence === 1
      ? 'Its 1 lead still in the sequence keeps its place, so a restart continues it from the step it was on.'
      : `Its ${leadsInSequence.toLocaleString()} leads still in the sequence keep their place, so a restart continues each from the step it was on.`;
  return `Stop "${name}"? It sends nothing more until you restart it, and it can't be edited while stopped. ${place} ` +
    'An email already being sent when you stop still goes out.';
}

/** What Restart asks before it makes the stopped campaign `name` Active again. */
export function restartConfirmMessage(name: string): string {
  return `Restart "${name}"? It becomes Active and sends its saved steps again inside its sending window. ` +
    'Each lead continues from the step it was on, and leads whose next email came due while it was stopped get it as soon as the sending window and limits allow.';
}

/**
 * "Stopped on 30 Sep 2026, 14:02", in local 24-hour time, for a stopped
 * campaign; "Stopped" when it has no stop time; null when it is not stopped.
 */
export function stoppedNote(campaign: { status?: string | null; stoppedAt?: string | Date | null }): string | null {
  if (!isStopped(campaign)) return null;
  const at = campaign.stoppedAt ? new Date(campaign.stoppedAt) : null;
  if (!at || Number.isNaN(at.getTime())) return 'Stopped';
  const date = at.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return `Stopped on ${date}, ${time}`;
}
