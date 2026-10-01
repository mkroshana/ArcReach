/**
 * Where a campaign's leads are in its sequence, as the campaign page's
 * Analytics tab shows it. Each enrollment has one status: Active leads are
 * still to get a step (currentSequenceStep, from nextActionDate on); the
 * others have left the sequence. Pure so the page can use it.
 */

/** An enrollment status the Analytics tab shows, with what puts a lead there. */
export type EnrollmentState = { status: string; label: string; description: string };

/** Enrollment statuses in the order the Lead Progress card lists them. */
export const ENROLLMENT_STATES: EnrollmentState[] = [
  { status: 'Active', label: 'In Sequence', description: 'Still to get a step.' },
  { status: 'Completed', label: 'Completed', description: 'Got every step.' },
  {
    status: 'Paused', label: 'Paused',
    description: 'Replied, unsubscribed, went on the suppression list, left the audience group or was paused in Unibox.',
  },
  { status: 'Bounced', label: 'Bounced', description: 'A delivery report said the address does not exist.' },
  { status: 'Failed', label: 'Failed', description: 'Azure refused the address or sending errored on every retry, or the address bounced when sent.' },
  { status: 'Removed', label: 'Removed', description: 'Left the audience after the campaign had emailed them.' },
];

/**
 * The Active state as a stopped campaign shows it: its Active leads get nothing
 * until a restart, which continues each from its step.
 */
export const STOPPED_ACTIVE_STATE: EnrollmentState = {
  status: 'Active', label: 'Stopped', description: 'Still to get a step. A restart continues each from the step it was on.',
};

/**
 * The emails a campaign's Active leads are still to get: a lead waiting for
 * step s gets it and every step after it. An upper bound, since a reply,
 * unsubscribe or bounce ends a lead early, and a lead waiting for a step the
 * campaign no longer has gets none.
 */
export function emailsLeft(stepOrders: number[], waitingByStep: Array<{ stepOrder: number; waiting: number }>): number {
  return waitingByStep.reduce(
    (total, { stepOrder, waiting }) => total + waiting * stepOrders.filter((order) => order >= stepOrder).length,
    0,
  );
}

/**
 * When the next email of a campaign is due, for its Sequence Progress:
 * 'Due now' once the earliest Active lead's send date has passed (the send
 * engine sends it inside the sending window and limits), else that date and
 * time, or why nothing is due: no lead is waiting, or the campaign is not
 * Active. `format` renders a future date.
 */
export function nextSendText(
  campaign: { status?: string | null },
  nextDueAt: string | Date | null | undefined,
  now: Date,
  format: (at: Date) => string,
): string {
  if (campaign.status === 'Stopped') return 'None while stopped';
  if (campaign.status === 'Paused') return 'None while paused';
  if (campaign.status !== 'Active') return 'Not published';
  const at = nextDueAt ? new Date(nextDueAt) : null;
  if (!at || Number.isNaN(at.getTime())) return 'No lead waiting';
  return at.getTime() <= now.getTime() ? 'Due now' : format(at);
}
