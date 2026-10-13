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
 * Active enrollments whose lead may no longer be emailed (lib/sendableLead).
 * The send engine passes them over, so the Lead Progress card lists them apart
 * from the leads still to get a step, when there are any.
 */
export const NOT_MAILABLE_STATE: EnrollmentState = {
  status: 'NotMailable', label: 'No Longer Mailable',
  description: 'Archived, unsubscribed, bounced or found invalid since they were enrolled, so they get no more steps.',
};

/**
 * The Lead Progress rows: every enrollment status in a fixed order, zeros
 * included, then any status the page does not describe. A stopped campaign's
 * Active leads show as Stopped. The Active row holds only the leads still to
 * get a step; those of `notMailable` follow it in a row of their own.
 */
export function leadProgressRows(
  byStatus: Record<string, number>,
  notMailable: number,
  stopped: boolean,
): Array<EnrollmentState & { value: number }> {
  const known = new Set(ENROLLMENT_STATES.map((state) => state.status));
  const held = Math.min(Math.max(0, notMailable), byStatus.Active ?? 0);
  return [
    ...ENROLLMENT_STATES.map((state) => (stopped && state.status === 'Active' ? STOPPED_ACTIVE_STATE : state)),
    ...Object.keys(byStatus).filter((status) => !known.has(status))
      .map((status) => ({ status, label: status, description: 'An enrollment status this page does not describe.' })),
  ].flatMap((state) => {
    const value = byStatus[state.status] ?? 0;
    return state.status === 'Active' && held > 0
      ? [{ ...state, value: value - held }, { ...NOT_MAILABLE_STATE, value: held }]
      : [{ ...state, value }];
  });
}

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
