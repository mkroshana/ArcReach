import { describe, it, expect } from 'vitest';
import { NO_REPORTS_NOTE, deliveryRateNote, deliveryRateText, funnelDeliveredNote, noReportRows, noReportsNotes } from '../../lib/deliveryStats';

/**
 * How the campaign page and the Accounts page show delivered emails (stats A3).
 * JPM Cold Outreach: 187,800 emails sent before delivery reports were
 * connected, which Azure never reports on.
 */
const SINCE = '2026-09-30T19:22:59.000Z';
/** The day the notes name, as the page writes it: in UTC, like its other dated notes. */
const SINCE_DAY = new Date(SINCE).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** No report has arrived for any email. */
const NOT_CONNECTED = { reported: 0, noReport: 187_800, sentBeforeReports: 0, reportsSince: null };
/** Every email was sent before delivery reports were connected. */
const ALL_BEFORE = { reported: 0, noReport: 0, sentBeforeReports: 187_800, reportsSince: SINCE };
/** The campaign resumed: 1,000 new emails reported, 30 not yet, and the old ones never. */
const RESUMED = { reported: 1_000, noReport: 30, sentBeforeReports: 187_800, reportsSince: SINCE };

describe('deliveryRateText: the tile, step rows, mailbox rows, Sequence strip and Accounts page (stats A3)', () => {
  it('names the emails the rate is of', () => {
    expect(deliveryRateText(97, 1_000)).toBe('97% of 1,000 reported');
    // A measured 0%: one email reported, and it was not delivered.
    expect(deliveryRateText(0, 1)).toBe('0% of 1 reported');
  });

  it('shows no rate when no email was reported, rather than a 0% never measured', () => {
    // A step whose attempts all failed, or a mailbox that sent nothing.
    expect(deliveryRateText(0, 0)).toBe('None reported');
    expect(deliveryRateText(undefined, undefined)).toBe('None reported');
  });
});

describe('noReportsNotes (stats A3)', () => {
  it('keeps the wait-for-reports note while no report has arrived for any email', () => {
    expect(noReportsNotes(NOT_CONNECTED)).toEqual({
      connected: false, short: 'No delivery reports yet', campaign: NO_REPORTS_NOTE, row: NO_REPORTS_NOTE,
    });
    // As the page reads it before the campaign loads.
    expect(noReportsNotes({ reported: 0, noReport: 0 })).toMatchObject({ connected: false, short: 'No delivery reports yet' });
  });

  it('says emails sent before delivery reports were connected will not get one, without "yet"', () => {
    const notes = noReportsNotes(ALL_BEFORE);
    const sentBefore = `These emails were sent before delivery reports were connected on ${SINCE_DAY}, so Azure will not report on them: how many were delivered, bounced or filtered as spam is not known.`;
    expect(notes).toEqual({ connected: true, short: 'Sent before delivery reports', campaign: sentBefore, row: sentBefore });
    // A Date, as deliveryBreakdown gives it before JSON.
    expect(noReportsNotes({ ...ALL_BEFORE, reportsSince: new Date(SINCE) })).toEqual(notes);
  });

  it('says no report was received for emails sent since, and how many of them were sent before', () => {
    const missing = { reported: 0, noReport: 30, sentBeforeReports: 12, reportsSince: SINCE };
    expect(noReportsNotes(missing)).toEqual({
      connected: true,
      short: 'No delivery reports received',
      campaign: `No delivery report has arrived for these emails. 12 of them were sent before delivery reports were connected on ${SINCE_DAY}, so Azure will not report on those.`,
      row: `No delivery report has arrived for these emails. Those sent before delivery reports were connected on ${SINCE_DAY} never get one.`,
    });
    expect(noReportsNotes({ ...missing, sentBeforeReports: 0 }).campaign).toBe('No delivery report has arrived for these emails.');
  });

  it("names the day in UTC, as the page's other dated notes do, whatever the viewer's time zone", () => {
    const day = (noonUtc: string) => new Date(noonUtc).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    // Just before and just after midnight UTC: east of UTC the first is the next day locally, west of it the second the day before.
    expect(noReportsNotes({ ...ALL_BEFORE, reportsSince: '2026-09-30T23:30:00.000Z' }).row).toContain(`connected on ${day('2026-09-30T12:00:00.000Z')},`);
    expect(noReportsNotes({ ...ALL_BEFORE, reportsSince: '2026-10-01T00:30:00.000Z' }).row).toContain(`connected on ${day('2026-10-01T12:00:00.000Z')},`);
  });

  it('counts reports as connected when every email has one, so its cutoff was not looked up', () => {
    const allReported = { reported: 1_000, noReport: 0, sentBeforeReports: 0, reportsSince: null };
    expect(noReportsNotes(allReported)).toEqual({
      connected: true,
      short: 'No delivery reports received',
      campaign: 'No delivery report has arrived for these emails.',
      row: 'No delivery report has arrived for these emails.',
    });
  });

  it('never says "yet" once a report has arrived for any email', () => {
    for (const delivery of [ALL_BEFORE, RESUMED, { ...RESUMED, sentBeforeReports: 0 }, { ...RESUMED, noReport: 0, sentBeforeReports: 0, reportsSince: null }]) {
      const { short, campaign, row } = noReportsNotes(delivery);
      expect([short, campaign, row].join(' ')).not.toMatch(/\byet\b/);
    }
  });
});

describe('deliveryRateNote (stats A3)', () => {
  it('says the rate leaves out the emails sent before delivery reports were connected', () => {
    expect(deliveryRateNote(RESUMED)).toBe(
      `The rate is of the emails a delivery report arrived for. The 187,800 sent before delivery reports were connected on ${SINCE_DAY} never get one, so they are left out.`,
    );
  });

  it('needs none when every email was sent since', () => {
    expect(deliveryRateNote({ ...RESUMED, sentBeforeReports: 0 })).toBeNull();
    expect(deliveryRateNote(NOT_CONNECTED)).toBeNull();
  });
});

describe('funnelDeliveredNote: the Conversion Funnel (stats A3)', () => {
  it('says why Delivered is left out while some emails were sent before delivery reports were connected', () => {
    expect(funnelDeliveredNote(RESUMED)).toBe('Delivered is left out: 187,800 emails were sent before delivery reports were connected.');
    expect(funnelDeliveredNote(ALL_BEFORE)).toBe('Delivered is left out: 187,800 emails were sent before delivery reports were connected.');
    expect(funnelDeliveredNote({ ...RESUMED, sentBeforeReports: 1 })).toBe('Delivered is left out: 1 email was sent before delivery reports were connected.');
  });

  it('needs none when every email was sent since, or no report has arrived for any', () => {
    expect(funnelDeliveredNote({ ...RESUMED, sentBeforeReports: 0 })).toBeNull();
    expect(funnelDeliveredNote(NOT_CONNECTED)).toBeNull();
    expect(funnelDeliveredNote({ reported: 0, noReport: 0 })).toBeNull();
  });
});

describe('noReportRows: the Delivery Reports panel (stats A3)', () => {
  it('splits the emails with no report into those sent before delivery reports were connected and those with none received', () => {
    expect(noReportRows(RESUMED)).toEqual([
      {
        key: 'before', label: 'Sent Before Delivery Reports',
        description: `Sent before delivery reports were connected on ${SINCE_DAY}, so Azure will not report on it.`, value: 187_800,
      },
      { key: 'none', label: 'No Report Received', description: 'No delivery report has arrived for it.', value: 30 },
    ]);
  });

  it('shows only the emails with none received when none were sent before', () => {
    expect(noReportRows({ ...RESUMED, sentBeforeReports: 0 })).toEqual([
      { key: 'none', label: 'No Report Received', description: 'No delivery report has arrived for it.', value: 30 },
    ]);
  });
});
