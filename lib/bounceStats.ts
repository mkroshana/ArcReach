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
 * so a rate with a bounce in it never reads '0%'.
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
   * rate; else null.
   */
  note: 'noReports' | 'sendTimeOnly' | null;
};

/**
 * What the page shows for a campaign's, step's or mailbox's hard bounces:
 * - no delivery report arrived for its emails: '—' when nothing bounced when
 *   sending, else the bounces found when sending, with no rate;
 * - no email a delivery report arrived for (as when Azure accepted none of
 *   them): the count, with no rate, so bounces found when sending never read
 *   as 100%;
 * - else the count and its rate, of the emails whose outcome is known.
 */
export function bounceFigure(row: BounceCounts, campaign: { noDeliveryReports: boolean }): BounceFigure {
  const bounced = row.bounced ?? 0;
  const noReports = noReportsFor(row, campaign);
  if (noReports || !row.reported || !row.bounceBase) {
    if (bounced > 0) return { count: bounced, rate: null, note: 'sendTimeOnly' };
    return noReports ? { count: null, rate: null, note: 'noReports' } : { count: 0, rate: null, note: null };
  }
  return { count: bounced, rate: bounceRateText(bounced, row.bounceRate), note: null };
}
