/**
 * How the campaign page and the Accounts page show delivered emails (counted
 * in lib/engagementMetrics). Delivery reports were connected long after many
 * emails went out, and Azure does not report on an email sent before then, so
 * a delivery rate is of the emails a report arrived for, and where none did the
 * page says why rather than showing 0. Pure so the pages can use it and tests
 * can check each case.
 */

/** A campaign's accepted emails by delivery report, as GET /api/campaigns/[id] gives them (deliveryBreakdown). */
export type DeliveryReportCounts = {
  /** Emails a delivery report arrived for. */
  reported: number;
  /** No report, sent since delivery reports were connected, or at any time when no report has arrived for any email. */
  noReport: number;
  /** No report, sent before delivery reports were connected. */
  sentBeforeReports?: number;
  /** When the first email any delivery report arrived for was sent; null when none has, or when every email has one. */
  reportsSince?: string | Date | null;
};

/** Why there are no delivery figures while no report has arrived for any email. */
export const NO_REPORTS_NOTE =
  'No delivery reports have arrived for these emails. Deliveries, bounces and spam filtering show here once Azure sends delivery reports to ArcReach (Event Grid).';

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
 * The day delivery reports were connected, as the notes say it: '30 Sep 2026',
 * in UTC like the page's other dated notes (lib/botFilter, lib/campaignProgress).
 */
function connectedOn(reportsSince: string | Date): string {
  return new Date(reportsSince).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** What the page says where no delivery report arrived for the emails it counts. */
export type NoReportsNotes = {
  /** A report has arrived for some email, so delivery reports are connected and no note says "yet". */
  connected: boolean;
  /** The line under a tile that shows '—'. */
  short: string;
  /** Why the campaign's emails have no delivery figures: for its tiles and the Delivery Reports panel. */
  campaign: string;
  /** Why a step's or mailbox's emails have none: for its cells. */
  row: string;
};

/**
 * What the page says about a campaign's emails no delivery report arrived for:
 * - no report has arrived for any email: none yet, and they show once Azure sends them;
 * - every one of the campaign's emails has a report, so when delivery reports were
 *   connected was not looked up: only a step or mailbox that sent none has no report;
 * - all of them were sent before delivery reports were connected: Azure will not report on them;
 * - some were sent since: no report was received, and those sent before never get one.
 */
export function noReportsNotes(delivery: DeliveryReportCounts): NoReportsNotes {
  if (!delivery.reportsSince) {
    if (delivery.reported > 0) {
      const none = 'No delivery report has arrived for these emails.';
      return { connected: true, short: 'No delivery reports received', campaign: none, row: none };
    }
    return { connected: false, short: 'No delivery reports yet', campaign: NO_REPORTS_NOTE, row: NO_REPORTS_NOTE };
  }
  const since = connectedOn(delivery.reportsSince);
  if (delivery.noReport === 0) {
    const sentBefore = `These emails were sent before delivery reports were connected on ${since}, so Azure will not report on them: how many were delivered, bounced or filtered as spam is not known.`;
    return { connected: true, short: 'Sent before delivery reports', campaign: sentBefore, row: sentBefore };
  }
  const before = delivery.sentBeforeReports ?? 0;
  return {
    connected: true,
    short: 'No delivery reports received',
    campaign: 'No delivery report has arrived for these emails.' +
      (before > 0 ? ` ${count(before)} of them were sent before delivery reports were connected on ${since}, so Azure will not report on those.` : ''),
    row: `No delivery report has arrived for these emails. Those sent before delivery reports were connected on ${since} never get one.`,
  };
}

/**
 * Why a campaign's delivery rate leaves out the emails sent before delivery
 * reports were connected, or null when there are none.
 */
export function deliveryRateNote(delivery: DeliveryReportCounts): string | null {
  const before = delivery.sentBeforeReports ?? 0;
  if (before === 0 || !delivery.reportsSince) return null;
  return `The rate is of the emails a delivery report arrived for. The ${count(before)} sent before delivery reports were connected on ${connectedOn(delivery.reportsSince)} never get one, so they are left out.`;
}

/**
 * Why the campaign's Conversion Funnel has no Delivered stage while some of its
 * emails were sent before delivery reports were connected (GET
 * /api/campaigns/[id] leaves it out: those never get a report, so Delivered
 * would read far below Opened), or null when none were.
 */
export function funnelDeliveredNote(delivery: DeliveryReportCounts): string | null {
  const before = delivery.sentBeforeReports ?? 0;
  if (before === 0) return null;
  return `Delivered is left out: ${count(before)} ${before === 1 ? 'email was' : 'emails were'} sent before delivery reports were connected.`;
}

/**
 * The Delivery Reports panel's rows for the emails no report arrived for,
 * counted apart from its shares of the reported ones: those sent before
 * delivery reports were connected, when there are any, and those sent since
 * that no report was received for.
 */
export function noReportRows(delivery: DeliveryReportCounts): Array<{ key: string; label: string; description: string; value: number }> {
  const before = delivery.sentBeforeReports ?? 0;
  return [
    ...(before > 0 && delivery.reportsSince ? [{
      key: 'before',
      label: 'Sent Before Delivery Reports',
      description: `Sent before delivery reports were connected on ${connectedOn(delivery.reportsSince)}, so Azure will not report on it.`,
      value: before,
    }] : []),
    { key: 'none', label: 'No Report Received', description: 'No delivery report has arrived for it.', value: delivery.noReport },
  ];
}
