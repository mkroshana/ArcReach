/**
 * How the campaign page and the Accounts page show delivered emails (counted
 * in lib/engagementMetrics). A delivery report arrives some time after Azure
 * accepts an email, so a delivery rate is of the emails a report arrived for,
 * and where none did the page says so rather than showing 0. Pure so the pages
 * can use it and tests can check each case.
 */

/** Why there are no delivery figures while no report has arrived for any of the campaign's emails. */
export const NO_REPORTS_NOTE =
  'No delivery reports have arrived for these emails. Deliveries, bounces and spam filtering show here once Azure sends delivery reports to ArcReach (Event Grid).';

/** Why a step's or mailbox's emails have no delivery figures while some of the campaign's others have a report. */
export const NO_REPORT_YET_NOTE = 'No delivery report has arrived for these emails yet.';

/** A count as the pages show it: 1,284. */
const count = (value: number) => value.toLocaleString();

/**
 * A delivery rate as the pages show it, with its base: '97% of 1,000 reported'.
 * With no email reported there is no rate to show, so it says so rather than '0%'.
 */
export function deliveryRateText(rate: number | null | undefined, reported: number | null | undefined): string {
  if (!reported) return 'None reported';
  return `${rate ?? 0}% of ${count(reported)} reported`;
}

/**
 * What the page says where no delivery report has arrived for the emails a
 * figure counts, by how many of the campaign's emails one arrived for
 * (deliveryBreakdown's `reported`):
 * - none: none yet, and the figures show once Azure sends delivery reports;
 * - some: these emails have none yet.
 */
export function noReportsNote(delivery: { reported: number }): string {
  return delivery.reported > 0 ? NO_REPORT_YET_NOTE : NO_REPORTS_NOTE;
}
