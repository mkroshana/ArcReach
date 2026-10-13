import { describe, it, expect } from 'vitest';
import { nextStepToSend, sendStepConfirmMessage, sequenceCounts, sequenceHeadline, stepRowState, stepWaitText } from '../../lib/campaignListPanel';

/**
 * The campaigns list's expanded panel: what each step's row says, which step
 * goes out next, and the headline and counts above the rows.
 */
const NOW = new Date('2026-10-13T14:00:00.000Z');
const send = (at: string) => ({ at, zone: 'CDT', offsetMinutes: -300 });
const format = (s: { at: string }) => `on ${s.at}`;
const STEPS = [
  { stepOrder: 1, waitDays: 0 },
  { stepOrder: 2, waitDays: 3 },
  { stepOrder: 3, waitDays: 1 },
  { stepOrder: 4, waitDays: 0 },
];

describe('stepRowState', () => {
  it('is waiting while leads wait for the step, sent once it went out and none do, else upcoming', () => {
    expect(stepRowState({ active: 5, sent: 0 })).toBe('waiting');
    // Still going out: some got it, others wait.
    expect(stepRowState({ active: 5, sent: 40 })).toBe('waiting');
    expect(stepRowState({ active: 0, sent: 40 })).toBe('sent');
    expect(stepRowState({ active: 0, sent: 0 })).toBe('upcoming');
    expect(stepRowState(undefined)).toBe('upcoming');
  });
});

describe('stepWaitText', () => {
  it('says when a step is sent, by its wait days after the step before it', () => {
    expect(stepWaitText(STEPS, 1)).toBe('On enrollment');
    expect(stepWaitText(STEPS, 2)).toBe('3 days after step 1');
    expect(stepWaitText(STEPS, 3)).toBe('1 day after step 2');
    expect(stepWaitText(STEPS, 4)).toBe('Same day as step 3');
  });

  it('names the step before it by its own number where the numbers have a gap', () => {
    expect(stepWaitText([{ stepOrder: 2, waitDays: 0 }, { stepOrder: 5, waitDays: 2 }], 5)).toBe('2 days after step 2');
    expect(stepWaitText([{ stepOrder: 2, waitDays: 4 }], 2)).toBe('On enrollment');
  });
});

describe('nextStepToSend', () => {
  it('is the waiting step whose leads go out first, whatever its place in the sequence', () => {
    const stats = [
      { stepOrder: 1, active: 4, sent: 10, nextSend: send('2026-10-15T10:00:00.000Z') },
      { stepOrder: 2, active: 6, sent: 0, nextSend: send('2026-10-14T10:00:00.000Z') },
      { stepOrder: 3, active: 0, sent: 0, nextSend: null },
    ];
    expect(nextStepToSend(stats)?.stepOrder).toBe(2);
  });

  it('is the first waiting step when none has a send time, and null when no lead waits', () => {
    expect(nextStepToSend([{ stepOrder: 3, active: 2, sent: 0 }, { stepOrder: 2, active: 1, sent: 0, nextSend: null }])?.stepOrder).toBe(2);
    expect(nextStepToSend([{ stepOrder: 1, active: 0, sent: 9 }])).toBeNull();
    expect(nextStepToSend([])).toBeNull();
  });
});

describe('sequenceHeadline', () => {
  const campaign = (over: Record<string, unknown> = {}) => ({
    status: 'Active', hasSendingSchedule: true, steps: STEPS, enrollmentSummary: { total: 20 },
    stepStats: [
      { stepOrder: 1, active: 0, sent: 20 },
      { stepOrder: 2, active: 0, sent: 18 },
      { stepOrder: 3, active: 18, sent: 0, nextSend: send('2026-10-15T10:00:00.000Z') },
      { stepOrder: 4, active: 0, sent: 0 },
    ],
    ...over,
  });

  it('names the step that goes out next and when', () => {
    expect(sequenceHeadline(campaign(), NOW, format)).toBe('Step 3 of 4 goes out on 2026-10-15T10:00:00.000Z');
  });

  it('says a step is due once its send time has come', () => {
    const due = campaign({ stepStats: [{ stepOrder: 2, active: 3, sent: 0, nextSend: send(NOW.toISOString()) }] });
    expect(sequenceHeadline(due, NOW, format)).toBe('Step 2 of 4 is due now');
  });

  it('says why nothing goes out from a campaign that is not Active', () => {
    expect(sequenceHeadline(campaign({ status: 'Stopped' }), NOW, format)).toBe('Nothing goes out while stopped');
    expect(sequenceHeadline(campaign({ status: 'Paused' }), NOW, format)).toBe('Nothing goes out while paused');
    expect(sequenceHeadline(campaign({ status: 'Draft' }), NOW, format)).toBe('Not published, so nothing goes out');
  });

  it('says so when no lead waits for a step, or none is enrolled', () => {
    const done = [{ stepOrder: 1, active: 0, sent: 20 }];
    expect(sequenceHeadline(campaign({ stepStats: done }), NOW, format)).toBe('No lead is waiting for a step');
    expect(sequenceHeadline(campaign({ stepStats: [], enrollmentSummary: { total: 0 } }), NOW, format)).toBe('No leads enrolled');
    expect(sequenceHeadline({ status: 'Active' }, NOW, format)).toBe('No leads enrolled');
  });

  it('names the step without a time when none could be worked out, and says when a schedule is missing', () => {
    const waiting = [{ stepOrder: 2, active: 3, sent: 0, nextSend: null }];
    expect(sequenceHeadline(campaign({ stepStats: waiting }), NOW, format)).toBe('Step 2 of 4 is next');
    expect(sequenceHeadline(campaign({ stepStats: waiting, hasSendingSchedule: false }), NOW, format))
      .toBe('Step 2 of 4 is held until a sending schedule is saved');
  });
});

describe('sequenceCounts', () => {
  const stats = [{ stepOrder: 1, active: 0, sent: 1176 }, { stepOrder: 3, active: 1104, sent: 0 }];
  const text = (...args: Parameters<typeof sequenceCounts>) => sequenceCounts(...args).split(' · ');

  it('counts the leads still to get a step, the completed, and those no longer mailable when there are any', () => {
    expect(text(stats, { completed: 0, notMailable: 81 })).toEqual([
      `${(1104).toLocaleString()} leads in sequence`, '0 completed', '81 no longer mailable',
    ]);
    expect(text(stats, { completed: 12, notMailable: 0 })).toEqual([`${(1104).toLocaleString()} leads in sequence`, '12 completed']);
  });

  it('reads one lead in the singular, and nothing as zeros', () => {
    expect(text([{ stepOrder: 1, active: 1, sent: 0 }], { completed: 1 })).toEqual(['1 lead in sequence', '1 completed']);
    expect(text([], undefined)).toEqual(['0 leads in sequence', '0 completed']);
  });
});

describe('sendStepConfirmMessage', () => {
  const tail = "Sending starts within 30 seconds, inside the campaign's sending window. Emails that have gone out can't be recalled.";

  it('says how many leads get the step now and when it would otherwise have gone out', () => {
    expect(sendStepConfirmMessage('Win-Back', 3, 1104, 'Thu, Oct 15, 05:00 CDT'))
      .toBe(`Send step 3 of "Win-Back" now? Its ${(1104).toLocaleString()} waiting leads get it now instead of Thu, Oct 15, 05:00 CDT. ${tail}`);
  });

  it('says the leads still waiting out the wait are sent too when the step is already due', () => {
    expect(sendStepConfirmMessage('Win-Back', 2, 1, null))
      .toBe(`Send step 2 of "Win-Back" now? Its 1 waiting lead gets it now, including any still waiting out the step's wait days. ${tail}`);
  });
});
