import { describe, it, expect } from 'vitest';
import { bounceFigure, bounceRateText, noReportsFor } from '../../lib/bounceStats';

/** How the campaign page shows its hard bounces (stats A5); a campaign some delivery report arrived for, or none. */
const WITH_REPORTS = { noDeliveryReports: false };
const NO_REPORTS = { noDeliveryReports: true };

describe('bounceFigure: the tile, step rows, mailbox rows and Sequence strip (stats A5)', () => {
  it('is unknown, not 0, while no delivery report arrived and nothing bounced when sending', () => {
    const row = { sent: 187_852, reported: 0, bounced: 0, bounceBase: 0, bounceRate: 0 };
    expect(bounceFigure(row, NO_REPORTS)).toEqual({ count: null, rate: null, note: 'noReports' });
    // Counts the API did not give are unknown too.
    expect(bounceFigure({ sent: 3, reported: 0 }, NO_REPORTS)).toMatchObject({ count: null, note: 'noReports' });
  });

  it('counts the bounces found when sending with no rate while no delivery report arrived', () => {
    // The API's rate is 52 of the 52 refused; with no report, the page shows none.
    const row = { sent: 187_852, reported: 0, bounced: 52, bounceBase: 52, bounceRate: 100 };
    expect(bounceFigure(row, NO_REPORTS)).toEqual({ count: 52, rate: null, note: 'sendTimeOnly' });
  });

  it('treats a step or mailbox no report arrived for as unreported, though the campaign has reports', () => {
    const unreported = { sent: 40, reported: 0, bounced: 0, bounceBase: 0, bounceRate: 0 };
    expect(bounceFigure(unreported, WITH_REPORTS)).toMatchObject({ count: null, rate: null, note: 'noReports' });
    expect(bounceFigure({ ...unreported, bounced: 2, bounceBase: 2, bounceRate: 100 }, WITH_REPORTS))
      .toEqual({ count: 2, rate: null, note: 'sendTimeOnly' });
  });

  it('shows every bounce and its rate of the emails whose outcome is known once reports arrive, with no note', () => {
    // 4 bounces, 1 of them found when sending before the first report, in the
    // 99 reported emails and that 1: the rate counts it, and nothing is left out.
    expect(bounceFigure({ sent: 187_952, reported: 99, bounced: 4, bounceBase: 100, bounceRate: 4 }, WITH_REPORTS))
      .toEqual({ count: 4, rate: '4%', note: null });
    // A measured 0 once reports arrive.
    expect(bounceFigure({ sent: 10, reported: 10, bounced: 0, bounceBase: 10, bounceRate: 0 }, WITH_REPORTS))
      .toEqual({ count: 0, rate: '0%', note: null });
  });

  it('gives no rate where nothing was accepted, so bounces found when sending never read 100%', () => {
    const refused = { sent: 0, reported: 0, bounced: 3, bounceBase: 3, bounceRate: 100 };
    expect(bounceFigure(refused, WITH_REPORTS)).toEqual({ count: 3, rate: null, note: 'sendTimeOnly' });
    expect(bounceFigure({ sent: 0, reported: 0, bounced: 0, bounceBase: 0, bounceRate: 0 }, WITH_REPORTS))
      .toEqual({ count: 0, rate: null, note: null });
  });
});

describe('noReportsFor (stats A1, A5)', () => {
  it('is true when the campaign has no reports, or the row sent emails none of which got one', () => {
    expect(noReportsFor({ sent: 5, reported: 5 }, NO_REPORTS)).toBe(true);
    expect(noReportsFor({ sent: 5, reported: 0 }, WITH_REPORTS)).toBe(true);
    expect(noReportsFor({ sent: 5, reported: 1 }, WITH_REPORTS)).toBe(false);
    expect(noReportsFor({ sent: 0, reported: 0 }, WITH_REPORTS)).toBe(false);
  });
});

describe('bounceRateText (stats A5)', () => {
  it('shows the rate to two decimals', () => {
    expect(bounceRateText(52, 0.03)).toBe('0.03%');
    expect(bounceRateText(1, 33.33)).toBe('33.33%');
    expect(bounceRateText(3, 100)).toBe('100%');
  });

  it('never reads 0% with a bounce in it', () => {
    // 1 bounce in 200,000 emails rounds to 0.00.
    expect(bounceRateText(1, 0)).toBe('<0.01%');
    expect(bounceFigure({ sent: 200_000, reported: 200_000, bounced: 1, bounceBase: 200_000, bounceRate: 0 }, WITH_REPORTS))
      .toMatchObject({ rate: '<0.01%' });
  });

  it('reads 0% when nothing bounced', () => {
    expect(bounceRateText(0, 0)).toBe('0%');
    expect(bounceRateText(undefined, undefined)).toBe('0%');
  });
});
