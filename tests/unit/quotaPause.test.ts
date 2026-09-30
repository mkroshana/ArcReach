import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * An in-memory Campaign table. The fake client applies the where clauses,
 * order and limit the auto-resume builds and moves updatedAt on every write, as
 * Prisma's @updatedAt does, so the tests see which pauses it really ends.
 */
const fake = vi.hoisted(() => ({
  campaign: { findMany: vi.fn(), updateMany: vi.fn() },
}));

vi.mock('../../lib/db', () => ({ prisma: fake }));

import { AUTO_RESUME_BATCH_SIZE, autoResumeQuotaPausedCampaigns } from '../../lib/sendEngine';
import { matchesWhere } from './helpers/prismaWhere';

type Row = {
  id: string; name: string; status: string; pausedUntil: Date | null; pauseReason: string | null;
  timezone: string; sendSchedule: unknown; updatedAt: Date;
};

const NOW = new Date('2026-06-25T12:00:00Z');
const MINUTE_MS = 60_000;
const OFFICE_HOURS = { days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], window: { start: '09:00', end: '17:00' } };

let rows: Row[];
let warn: ReturnType<typeof vi.spyOn>;

/** A campaign the send engine paused for a quota error, due to resume a minute ago, with a complete schedule. */
function addCampaign(id: string, fields: Partial<Row> = {}): Row {
  const row: Row = {
    id, name: `Campaign ${id}`, status: 'Paused', pausedUntil: new Date(NOW.getTime() - MINUTE_MS), pauseReason: 'quota',
    timezone: 'UTC', sendSchedule: OFFICE_HOURS, updatedAt: new Date('2026-06-25T11:00:00Z'), ...fields,
  };
  rows.push(row);
  return row;
}

const row = (id: string) => rows.find((r) => r.id === id)!;

/** Writes `data` to the row, moving updatedAt on as Prisma does. */
function write(target: Row, data: Partial<Row>) {
  Object.assign(target, data, { updatedAt: new Date(target.updatedAt.getTime() + 1000) });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  rows = [];

  fake.campaign.findMany.mockImplementation(async ({ where, select, orderBy, take }: any) => {
    expect(orderBy).toEqual([{ pausedUntil: 'asc' }, { id: 'asc' }]);
    return rows
      .filter((r) => matchesWhere(r, where))
      .sort((a, b) => a.pausedUntil!.getTime() - b.pausedUntil!.getTime() || a.id.localeCompare(b.id))
      .slice(0, take)
      .map((r) => Object.fromEntries(Object.keys(select).map((key) => [key, structuredClone((r as any)[key])])));
  });
  fake.campaign.updateMany.mockImplementation(async ({ where, data }: any) => {
    const hit = rows.filter((r) => matchesWhere(r, where));
    hit.forEach((r) => write(r, data));
    return { count: hit.length };
  });
});

describe('autoResumeQuotaPausedCampaigns', () => {
  it('resumes due campaigns with a complete sending schedule to Active and clears the timer and reason', async () => {
    addCampaign('quota');
    addCampaign('systemic', { pauseReason: 'systemic', timezone: 'America/New_York' });
    addCampaign('config', { pauseReason: 'config' });
    // A schedule stored as JSON text by an older version.
    addCampaign('legacy-text', { sendSchedule: JSON.stringify(OFFICE_HOURS) });
    addCampaign('due-now', { pausedUntil: NOW });

    expect(await autoResumeQuotaPausedCampaigns(NOW)).toBe(5);

    for (const r of rows) expect(r).toMatchObject({ status: 'Active', pausedUntil: null, pauseReason: null });
    expect(warn).not.toHaveBeenCalled();
  });

  it.each<[string, Partial<Row>]>([
    ['no saved schedule', { sendSchedule: null }],
    ['no sending days', { sendSchedule: { days: [], window: OFFICE_HOURS.window } }],
    ['no end time', { sendSchedule: { days: ['Mon'], window: { start: '09:00' } } }],
    ['unreadable JSON text', { sendSchedule: '{"days": ["Mon"' }],
    ['an unknown timezone', { timezone: 'America/NewYork' }],
  ])('sets a due campaign with %s to Draft instead of Active and says so', async (_label, fields) => {
    addCampaign('no-schedule', fields);

    expect(await autoResumeQuotaPausedCampaigns(NOW)).toBe(0);

    expect(row('no-schedule')).toMatchObject({ status: 'Draft', pausedUntil: null, pauseReason: null });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('Campaign "Campaign no-schedule" (no-schedule) has no complete sending schedule');
    expect(warn.mock.calls[0][0]).toContain('set it to Draft instead of Active');
  });

  it('counts only the campaigns it resumed to Active', async () => {
    addCampaign('scheduled');
    addCampaign('unscheduled', { sendSchedule: null });

    expect(await autoResumeQuotaPausedCampaigns(NOW)).toBe(1);

    expect(row('scheduled').status).toBe('Active');
    expect(row('unscheduled').status).toBe('Draft');
  });

  it('leaves pauses not due yet, user and owner-disabled pauses, Drafts and Active campaigns alone', async () => {
    addCampaign('not-due', { pausedUntil: new Date(NOW.getTime() + MINUTE_MS) });
    addCampaign('not-due-no-schedule', { pausedUntil: new Date(NOW.getTime() + MINUTE_MS), sendSchedule: null });
    addCampaign('user-paused', { pausedUntil: null, pauseReason: 'user' });
    addCampaign('owner-disabled', { pausedUntil: null, pauseReason: 'owner_disabled', sendSchedule: null });
    addCampaign('draft', { status: 'Draft', pausedUntil: null, pauseReason: null });
    addCampaign('active', { status: 'Active', pausedUntil: null, pauseReason: null });
    const before = structuredClone(rows);

    expect(await autoResumeQuotaPausedCampaigns(NOW)).toBe(0);

    expect(rows).toEqual(before);
    expect(fake.campaign.updateMany).not.toHaveBeenCalled();
  });

  it.each<[string, Partial<Row>, Partial<Row>, Partial<Row>]>([
    ['the page saved it without a schedule', { sendSchedule: null }, { status: 'Paused', pauseReason: 'quota', sendSchedule: null }, { status: 'Draft' }],
    ['Keep Paused made it a user pause', { pausedUntil: null, pauseReason: 'user' }, { status: 'Paused', pausedUntil: null, pauseReason: 'user' }, { status: 'Paused', pauseReason: 'user' }],
    ['the user moved it to Draft', { status: 'Draft', pausedUntil: null, pauseReason: null }, { status: 'Draft' }, { status: 'Draft' }],
  ])('does not overwrite a scheduled campaign changed after it was read: %s', async (_label, change, afterRace, afterNextCall) => {
    const target = addCampaign('raced');
    const readDue = fake.campaign.findMany.getMockImplementation()!;
    fake.campaign.findMany.mockImplementationOnce(async (args: any) => {
      const due = await readDue(args);
      write(target, change);
      return due;
    });

    expect(await autoResumeQuotaPausedCampaigns(NOW)).toBe(0);
    expect(target).toMatchObject(afterRace);
    expect(warn).not.toHaveBeenCalled();

    // The next call reads the campaign as it now is.
    await autoResumeQuotaPausedCampaigns(NOW);
    expect(target).toMatchObject({ ...afterNextCall, pausedUntil: null });
  });

  it('does not set a campaign to Draft when a schedule was saved after it was read, and resumes it on the next call', async () => {
    const target = addCampaign('raced', { sendSchedule: null });
    const readDue = fake.campaign.findMany.getMockImplementation()!;
    fake.campaign.findMany.mockImplementationOnce(async (args: any) => {
      const due = await readDue(args);
      write(target, { sendSchedule: OFFICE_HOURS });
      return due;
    });

    expect(await autoResumeQuotaPausedCampaigns(NOW)).toBe(0);
    expect(target).toMatchObject({ status: 'Paused', pauseReason: 'quota', sendSchedule: OFFICE_HOURS });

    expect(await autoResumeQuotaPausedCampaigns(NOW)).toBe(1);
    expect(target).toMatchObject({ status: 'Active', pausedUntil: null, pauseReason: null });
  });

  it('ends each pause once when two workers run it at the same time', async () => {
    addCampaign('one');
    addCampaign('two');
    addCampaign('three', { sendSchedule: null });

    const counts = await Promise.all([autoResumeQuotaPausedCampaigns(NOW), autoResumeQuotaPausedCampaigns(NOW)]);

    expect(counts[0] + counts[1]).toBe(2);
    expect(fake.campaign.updateMany).toHaveBeenCalledTimes(6);
    expect(rows.map((r) => r.status)).toEqual(['Active', 'Active', 'Draft']);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it(`ends at most ${AUTO_RESUME_BATCH_SIZE} pauses per call, longest due first, and the rest on the next call`, async () => {
    for (let i = 0; i < AUTO_RESUME_BATCH_SIZE + 2; i++) {
      addCampaign(`c-${String(i).padStart(3, '0')}`, { pausedUntil: new Date(NOW.getTime() - (AUTO_RESUME_BATCH_SIZE + 2 - i) * MINUTE_MS) });
    }

    expect(await autoResumeQuotaPausedCampaigns(NOW)).toBe(AUTO_RESUME_BATCH_SIZE);
    expect(rows.filter((r) => r.status === 'Paused').map((r) => r.id)).toEqual([
      `c-${String(AUTO_RESUME_BATCH_SIZE).padStart(3, '0')}`,
      `c-${String(AUTO_RESUME_BATCH_SIZE + 1).padStart(3, '0')}`,
    ]);

    expect(await autoResumeQuotaPausedCampaigns(NOW)).toBe(2);
    expect(rows.every((r) => r.status === 'Active')).toBe(true);
  });

  it('uses the current time when no `now` is provided', async () => {
    addCampaign('due', { pausedUntil: new Date(Date.now() - MINUTE_MS) });
    addCampaign('later', { pausedUntil: new Date(Date.now() + 60 * MINUTE_MS) });

    const before = Date.now();
    expect(await autoResumeQuotaPausedCampaigns()).toBe(1);
    const after = Date.now();

    const usedTime = fake.campaign.findMany.mock.calls[0][0].where.pausedUntil.lte.getTime();
    expect(usedTime).toBeGreaterThanOrEqual(before);
    expect(usedTime).toBeLessThanOrEqual(after);
    expect(row('due').status).toBe('Active');
    expect(row('later').status).toBe('Paused');
  });
});
