import { describe, it, expect } from 'vitest';
import { planDispatchAudit, type AuditDispatchRow } from '../../lib/dispatchAudit';

const CAMPAIGN = 'camp-1';
const LEAD = 'lead-1';

let seq = 0;
function row(overrides: Partial<AuditDispatchRow> & { at: string }): AuditDispatchRow {
  const { at, ...rest } = overrides;
  seq++;
  return {
    id: `d${seq}`,
    leadId: LEAD,
    subject: 'Quick question',
    stepOrder: 1,
    status: 'Sent',
    sentAt: new Date(`2026-06-01T${at}:00Z`),
    // The send engine's stand-in id, kept when no provider id replaced it
    messageId: `${CAMPAIGN}-${LEAD}-1-${seq}`,
    operationId: null,
    deliveredAt: null,
    deliveryStatus: null,
    bouncedAt: null,
    eventCount: 0,
    ...rest,
  };
}

const steps = [
  { stepOrder: 1, subject: 'Quick question for {{company}}' },
  { stepOrder: 2, subject: 'Following up' },
];

describe('planDispatchAudit duplicates', () => {
  it('keeps a retried step: a Failed attempt then the Sent row with its events is not a duplicate', () => {
    const failed = row({ at: '09:00', status: 'Failed' });
    const sent = row({ at: '10:00', operationId: 'op-1', messageId: 'op-1', eventCount: 2 });
    const plan = planDispatchAudit(CAMPAIGN, steps, [failed, sent]);
    expect(plan.duplicates).toEqual([]);
  });

  it('never counts Sending, Unknown or Failed rows as duplicates of a Sent row', () => {
    const plan = planDispatchAudit(CAMPAIGN, steps, [
      row({ at: '09:00' }),
      row({ at: '09:05', status: 'Sending' }),
      row({ at: '09:10', status: 'Unknown' }),
      row({ at: '09:15', status: 'Failed' }),
    ]);
    expect(plan.duplicates).toEqual([]);
  });

  it('keeps the earliest of two plain Sent rows and deletes the later one', () => {
    const first = row({ at: '09:00' });
    const second = row({ at: '10:00' });
    const [group] = planDispatchAudit(CAMPAIGN, steps, [second, first]).duplicates;
    expect(group.keep.id).toBe(first.id);
    expect(group.keepReason).toBe('earliest');
    expect(group.remove.map((r) => r.id)).toEqual([second.id]);
    expect(group.keepWithEvents).toEqual([]);
  });

  it('keeps the Sent row with events over an earlier one without', () => {
    const early = row({ at: '09:00' });
    const opened = row({ at: '10:00', eventCount: 1 });
    const [group] = planDispatchAudit(CAMPAIGN, steps, [early, opened]).duplicates;
    expect(group.keep.id).toBe(opened.id);
    expect(group.keepReason).toBe('has events');
    expect(group.remove.map((r) => r.id)).toEqual([early.id]);
  });

  it('never deletes a Sent row with events, even when another row is kept', () => {
    const a = row({ at: '09:00', eventCount: 1 });
    const b = row({ at: '10:00', eventCount: 3 });
    const c = row({ at: '11:00' });
    const [group] = planDispatchAudit(CAMPAIGN, steps, [a, b, c]).duplicates;
    expect(group.keep.id).toBe(a.id);
    expect(group.keepWithEvents.map((r) => r.id)).toEqual([b.id]);
    expect(group.remove.map((r) => r.id)).toEqual([c.id]);
  });

  it('prefers a delivery report, then a provider id, over the earliest row', () => {
    const early = row({ at: '09:00' });
    const delivered = row({ at: '10:00', deliveredAt: new Date('2026-06-01T10:01:00Z'), deliveryStatus: 'Delivered' });
    const [byReport] = planDispatchAudit(CAMPAIGN, steps, [early, delivered]).duplicates;
    expect(byReport.keep.id).toBe(delivered.id);
    expect(byReport.keepReason).toBe('has a delivery report');

    const stale = row({ at: '09:00' });
    const accepted = row({ at: '10:00', messageId: '0f3c2b1a-acs-message-id' });
    const [byProvider] = planDispatchAudit(CAMPAIGN, steps, [stale, accepted]).duplicates;
    expect(byProvider.keep.id).toBe(accepted.id);
    expect(byProvider.keepReason).toBe('has a provider id');

    const withOperation = row({ at: '10:00', operationId: 'op-2' });
    const [byOperation] = planDispatchAudit(CAMPAIGN, steps, [row({ at: '09:00' }), withOperation]).duplicates;
    expect(byOperation.keep.id).toBe(withOperation.id);
  });

  it('groups by lead and stored step only', () => {
    const plan = planDispatchAudit(CAMPAIGN, steps, [
      row({ at: '09:00', stepOrder: 1 }),
      row({ at: '10:00', stepOrder: 2 }),
      row({ at: '11:00', stepOrder: 1, leadId: 'lead-2' }),
      row({ at: '12:00', stepOrder: null, subject: 'Quick question for Acme' }),
    ]);
    expect(plan.duplicates).toEqual([]);
  });
});

describe('planDispatchAudit legacy rows', () => {
  const legacy = (at: string, subject: string, extra: Partial<AuditDispatchRow> = {}) =>
    row({ at, subject, stepOrder: null, ...extra });

  it('backfills a row whose subject matches exactly one step no other row of the lead has', () => {
    const r = legacy('09:00', 'Quick question for Acme');
    const plan = planDispatchAudit(CAMPAIGN, steps, [r]);
    expect(plan.backfill).toEqual([{ row: r, stepOrder: 1 }]);
    expect(plan.duplicates).toEqual([]);
  });

  it('leaves a row whose subject matches several steps alone', () => {
    const sameSubject = [
      { stepOrder: 1, subject: 'Quick question' },
      { stepOrder: 2, subject: 'Quick question' },
    ];
    const followUp = legacy('09:00', 'Quick question');
    const plan = planDispatchAudit(CAMPAIGN, sameSubject, [followUp]);
    expect(plan.backfill).toEqual([]);
    expect(plan.ambiguous).toEqual([followUp]);
  });

  it('never backfills or deletes legacy rows that infer the same step', () => {
    const failedAttempt = legacy('09:00', 'Quick question for Acme');
    const sent = legacy('10:00', 'Quick question for Acme', { eventCount: 1 });
    const plan = planDispatchAudit(CAMPAIGN, steps, [failedAttempt, sent]);
    expect(plan.backfill).toEqual([]);
    expect(plan.inferredCollisions.map((c) => c.row.id)).toEqual([failedAttempt.id, sent.id]);
    expect(plan.duplicates).toEqual([]);
  });

  it('never backfills a step the lead already has a stored row for', () => {
    const stored = row({ at: '09:00', stepOrder: 1 });
    const inferred = legacy('10:00', 'Quick question for Acme');
    const plan = planDispatchAudit(CAMPAIGN, steps, [stored, inferred]);
    expect(plan.backfill).toEqual([]);
    expect(plan.inferredCollisions).toEqual([{ row: inferred, stepOrder: 1 }]);
    expect(plan.duplicates).toEqual([]);
  });

  it('skips rows with no lead or no matching step', () => {
    const plan = planDispatchAudit(CAMPAIGN, steps, [
      legacy('09:00', 'Quick question for Acme', { leadId: null }),
      legacy('10:00', 'Something else'),
      legacy('11:00', ''),
    ]);
    expect(plan).toEqual({ backfill: [], ambiguous: [], inferredCollisions: [], duplicates: [] });
  });
});
