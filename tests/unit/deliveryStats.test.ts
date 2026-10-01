import { describe, it, expect } from 'vitest';
import { NO_REPORTS_NOTE, NO_REPORT_YET_NOTE, deliveryRateText, noReportsNote } from '../../lib/deliveryStats';

/** How the campaign page and the Accounts page show delivered emails (stats A3). */

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

describe('noReportsNote (stats A3)', () => {
  it("keeps the wait-for-reports note while no report has arrived for any of the campaign's emails", () => {
    expect(noReportsNote({ reported: 0 })).toBe(NO_REPORTS_NOTE);
    expect(NO_REPORTS_NOTE).toBe(
      'No delivery reports have arrived for these emails. Deliveries, bounces and spam filtering show here once Azure sends delivery reports to ArcReach (Event Grid).',
    );
  });

  it("says a step's or mailbox's emails have no report yet once some of the campaign's have one", () => {
    expect(noReportsNote({ reported: 1 })).toBe(NO_REPORT_YET_NOTE);
    expect(noReportsNote({ reported: 1_000 })).toBe('No delivery report has arrived for these emails yet.');
  });
});
