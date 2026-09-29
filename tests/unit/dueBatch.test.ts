import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * In-memory campaigns, leads and enrollments. The fake findMany evaluates the
 * where, orderBy and take the send engine builds, so the tests check which
 * enrollments one send cycle really loads.
 */
const fake = vi.hoisted(() => ({
  campaignEnrollment: { findMany: vi.fn() },
}));

vi.mock('../../lib/db', () => ({ prisma: fake }));

import { loadDueEnrollments, DUE_BATCH_SIZE, DUE_BATCH_PER_CAMPAIGN } from '../../lib/sendEngine';

type CampaignRow = { id: string; status: string; steps: Array<{ stepOrder: number }> };
type LeadRow = { id: string; email: string; status: string; validationStatus: string; isArchived: boolean };
type EnrollmentRow = { id: string; leadId: string; campaignId: string; status: string; nextActionDate: Date | null };

const NOW = new Date('2026-06-10T12:00:00Z');
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);

let campaigns: Map<string, CampaignRow>;
let leads: Map<string, LeadRow>;
let enrollments: EnrollmentRow[];

function addCampaign(id: string, overrides: Partial<CampaignRow> = {}) {
  campaigns.set(id, { id, status: 'Active', steps: [{ stepOrder: 1 }], ...overrides });
}

/** Enrolls `count` new leads in a campaign, due `due(i)` minutes ago (negative: not yet due). */
function enroll(campaignId: string, count: number, due: (i: number) => number | null, lead: Partial<LeadRow> = {}) {
  const start = enrollments.filter((e) => e.campaignId === campaignId).length;
  for (let i = 0; i < count; i++) {
    const id = `${campaignId}-${String(start + i).padStart(4, '0')}`;
    leads.set(id, { id, email: `${id}@prospect.test`, status: 'Neutral', validationStatus: 'Valid', isArchived: false, ...lead });
    const minutes = due(i);
    enrollments.push({ id: `enr-${id}`, leadId: id, campaignId, status: 'Active', nextActionDate: minutes === null ? null : minutesAgo(minutes) });
  }
}

/** Evaluates one Prisma scalar filter; throws on shapes it doesn't model so a changed query can't silently match. */
function matchesValue(value: any, cond: any): boolean {
  if (cond === null || typeof cond !== 'object') return value === cond;
  if ('notIn' in cond) return !cond.notIn.includes(value);
  if ('lte' in cond) return value !== null && value <= cond.lte;
  if ('some' in cond && Object.keys(cond.some).length === 0) return value.length > 0;
  throw new Error(`Unmodelled filter: ${JSON.stringify(cond)}`);
}

function matchesFields(row: any, where: Record<string, any>): boolean {
  return Object.entries(where).every(([key, cond]) => matchesValue(row[key], cond));
}

function matchesEnrollment(e: EnrollmentRow, where: Record<string, any>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'AND') return cond.every((w: any) => matchesEnrollment(e, w));
    if (key === 'campaign') return matchesFields(campaigns.get(e.campaignId), cond);
    if (key === 'lead') return matchesFields(leads.get(e.leadId), cond);
    return matchesValue((e as any)[key], cond);
  });
}

/** Sorts by an orderBy list of { field: 'asc' } entries, the only direction the engine uses. */
function compareBy(orderBy: Array<Record<string, string>>) {
  return (a: any, b: any) => {
    for (const entry of orderBy) {
      const [[field, direction]] = Object.entries(entry);
      if (direction !== 'asc') throw new Error(`Unmodelled order: ${JSON.stringify(entry)}`);
      if (a[field] < b[field]) return -1;
      if (a[field] > b[field]) return 1;
    }
    return 0;
  };
}

const byDue = compareBy([{ nextActionDate: 'asc' }, { id: 'asc' }]);

/** The batch the engine should load: the oldest due rows, skipping a campaign's rows once it has its share. */
function expectedBatch(): string[] {
  const perCampaign = new Map<string, number>();
  const batch: string[] = [];
  for (const e of [...enrollments].sort(byDue)) {
    const taken = perCampaign.get(e.campaignId) ?? 0;
    if (batch.length === DUE_BATCH_SIZE || taken === DUE_BATCH_PER_CAMPAIGN) continue;
    perCampaign.set(e.campaignId, taken + 1);
    batch.push(e.id);
  }
  return batch;
}

const countByCampaign = (rows: Array<{ campaignId: string }>) =>
  Object.fromEntries([...new Set(rows.map((r) => r.campaignId))].map((id) => [id, rows.filter((r) => r.campaignId === id).length]));

beforeEach(() => {
  vi.clearAllMocks();
  campaigns = new Map();
  leads = new Map();
  enrollments = [];

  fake.campaignEnrollment.findMany.mockImplementation(async ({ where, orderBy, take, include }: any) =>
    enrollments
      .filter((e) => matchesEnrollment(e, where))
      .sort(compareBy(orderBy))
      .slice(0, take)
      .map((e) => ({ ...e, ...(include?.lead ? { lead: { ...leads.get(e.leadId)! } } : {}) })),
  );
});

describe('loadDueEnrollments shares each send cycle between campaigns (H10)', () => {
  it('limits a campaign with an older backlog to its share, so a later campaign still sends', async () => {
    addCampaign('cmp-a');
    addCampaign('cmp-b');
    enroll('cmp-a', 5000, (i) => 10_000 - i); // due long before any of B
    enroll('cmp-b', 10, (i) => 60 - i);

    const batch = await loadDueEnrollments(NOW);

    expect(countByCampaign(batch)).toEqual({ 'cmp-a': DUE_BATCH_PER_CAMPAIGN, 'cmp-b': 10 });
    expect(batch.map((e) => e.id)).toEqual(expectedBatch());
    expect(batch[0]).toMatchObject({ id: 'enr-cmp-a-0000', lead: { email: 'cmp-a-0000@prospect.test' } });
  });

  it('gives a lone campaign only its share of a cycle', async () => {
    addCampaign('cmp-a');
    enroll('cmp-a', 300, (i) => 1000 - i);

    const batch = await loadDueEnrollments(NOW);

    expect(batch.map((e) => e.id)).toEqual(expectedBatch());
    expect(batch).toHaveLength(DUE_BATCH_PER_CAMPAIGN);
  });

  it('fills the batch with the oldest due rows across many campaigns, in due order, in a few queries', async () => {
    // Deterministic pseudo-random due times, with ties broken by id.
    let seed = 42;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let c = 0; c < 8; c++) {
      addCampaign(`cmp-${c}`);
      enroll(`cmp-${c}`, 20 + c * 15, () => Math.floor(random() * 300));
    }

    const batch = await loadDueEnrollments(NOW);

    expect(batch).toHaveLength(DUE_BATCH_SIZE);
    expect(batch.map((e) => e.id)).toEqual(expectedBatch());
    expect(Math.max(...Object.values(countByCampaign(batch)))).toBeLessThanOrEqual(DUE_BATCH_PER_CAMPAIGN);
    expect(fake.campaignEnrollment.findMany.mock.calls.length).toBeLessThanOrEqual(DUE_BATCH_SIZE / DUE_BATCH_PER_CAMPAIGN + 1);
    // Only the lead rides along per row, never the campaign and its step bodies.
    for (const [args] of fake.campaignEnrollment.findMany.mock.calls) {
      expect(args.include).toEqual({ lead: true });
    }
  });

  it('leaves out campaigns with no steps or not Active, rows not yet due and leads that must not be sent', async () => {
    addCampaign('cmp-stepless', { steps: [] });
    addCampaign('cmp-paused', { status: 'Paused' });
    addCampaign('cmp-live');
    enroll('cmp-stepless', 200, (i) => 5000 - i);
    enroll('cmp-paused', 200, (i) => 5000 - i);
    enroll('cmp-live', 3, (i) => 30 - i);
    enroll('cmp-live', 2, () => -30); // due in half an hour
    enroll('cmp-live', 1, () => null);
    enroll('cmp-live', 1, () => 90, { status: 'Unsubscribed' });
    enroll('cmp-live', 1, () => 90, { status: 'Bounced' });
    enroll('cmp-live', 1, () => 90, { validationStatus: 'Invalid' });
    enroll('cmp-live', 1, () => 90, { isArchived: true });
    enrollments.push({ id: 'enr-paused', leadId: 'cmp-live-0000', campaignId: 'cmp-live', status: 'Paused', nextActionDate: minutesAgo(90) });

    const batch = await loadDueEnrollments(NOW);

    expect(batch.map((e) => e.id)).toEqual(['enr-cmp-live-0000', 'enr-cmp-live-0001', 'enr-cmp-live-0002']);
  });
});
