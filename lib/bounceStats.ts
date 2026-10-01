/**
 * How the campaign page shows hard bounces (counted in lib/engagementMetrics)
 * for the campaign, a step or a mailbox. A bounce is known two ways: a
 * delivery report says so, or Azure refused the address when sending. Pure so
 * the page can use it and tests can check each case.
 */

/** A campaign's, step's or mailbox's counts, as GET /api/campaigns/[id] gives them. */
export type BounceCounts = {
  sent: number;
  /** Sent emails a delivery report arrived for. */
  reported: number;
  bounced?: number | null;
  bouncedInRate?: number | null;
  bounceRate?: number | null;
  bounceBase?: number | null;
};

/**
 * Whether no delivery report has arrived for a step's or mailbox's sent
 * emails, or for any of the campaign's, so its delivered count, and a bounce
 * count of 0, say nothing yet. The page's Delivered cells use it too.
 */
export function noReportsFor(row: { sent: number; reported: number }, campaign: { noDeliveryReports: boolean }): boolean {
  return campaign.noDeliveryReports || (row.sent > 0 && row.reported === 0);
}

/**
 * A bounce rate (to two decimals, from lib/engagementMetrics) as the page
 * shows it: '0.03%', or '<0.01%' for bounces too few to show at two decimals,
 * so a rate with a bounce in it never reads '0%'. `bounced` is the bounces
 * the rate counts.
 */
export function bounceRateText(bounced: number | null | undefined, rate: number | null | undefined): string {
  return (bounced ?? 0) > 0 && (rate ?? 0) < 0.01 ? '<0.01%' : `${rate ?? 0}%`;
}

export type BounceFigure = {
  /** The hard bounces, or null when the count is unknown and shows as '—'. */
  count: number | null;
  /** The rate as bounceRateText shows it, or null when there is none to show. */
  rate: string | null;
  /**
   * What the page says about the figure: 'noReports' when the count is
   * unknown (no delivery report arrived, and nothing bounced when sending);
   * 'sendTimeOnly' when only bounces found when sending are counted, with no
   * rate; 'leftOutOfRate' when the rate leaves out some bounces found when
   * sending, from before delivery reports arrived; else null.
   */
  note: 'noReports' | 'sendTimeOnly' | 'leftOutOfRate' | null;
  /** With a rate, how many of the bounces it leaves out; else 0. */
  leftOutOfRate: number;
};

/**
 * What the page shows for a campaign's, step's or mailbox's hard bounces:
 * - no delivery report arrived for its emails: '—' when nothing bounced when
 *   sending, else the bounces found when sending, with no rate;
 * - no email whose outcome is known (bounceBase 0, as when Azure accepted
 *   none of them): the count, with no rate;
 * - else the count and its rate, of the emails whose outcome is known.
 */
export function bounceFigure(row: BounceCounts, campaign: { noDeliveryReports: boolean }): BounceFigure {
  const bounced = row.bounced ?? 0;
  const noReports = noReportsFor(row, campaign);
  if (noReports || !row.bounceBase) {
    if (bounced > 0) return { count: bounced, rate: null, note: 'sendTimeOnly', leftOutOfRate: 0 };
    return noReports
      ? { count: null, rate: null, note: 'noReports', leftOutOfRate: 0 }
      : { count: 0, rate: null, note: null, leftOutOfRate: 0 };
  }
  const inRate = row.bouncedInRate ?? 0;
  const leftOutOfRate = Math.max(0, bounced - inRate);
  return {
    count: bounced,
    rate: bounceRateText(inRate, row.bounceRate),
    note: leftOutOfRate > 0 ? 'leftOutOfRate' : null,
    leftOutOfRate,
  };
}
