import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('../../lib/db', () => ({
  db: {
    getAccounts: vi.fn(),
    updateAccount: vi.fn(),
  },
  prisma: {
    senderAccount: { findUnique: vi.fn() },
    emailDispatch: { count: vi.fn() },
    inboundResponse: { count: vi.fn() },
  },
}));

vi.mock('../../lib/session', () => ({
  getSession: vi.fn(),
}));

import { db, prisma } from '../../lib/db';
import { getSession } from '../../lib/session';
import { MASKED_SECRET } from '../../lib/secrets';
import { GET as getAccounts, PUT as putAccount } from '../../app/api/accounts/route';
import { MAX_MAILBOX_LIMIT, MailboxSettingsSaves, mailboxLimitInputValue } from '../../lib/mailboxSettingsSave';

const mockedDb = db as any;
const mockedPrisma = prisma as any;

const DAY = 86400000;
const NOW = new Date('2026-09-30T12:00:00Z');

/** A stored mailbox row as Prisma returns it. */
const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'mb-1', emailAddress: 'sales@example.com', userId: 'user-1',
  dailyLimit: 500, warmupEnabled: false, warmupStartedAt: null as Date | null, warmupLimit: 50, warmupRamp: 2, warmupSent: 0,
  imapPass: 'encrypted', ...overrides,
});

function putReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/accounts', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

describe('PUT /api/accounts answers with the effective cap GET shows, so the page can merge it in (M70)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    vi.mocked(getSession).mockResolvedValue({ id: 'user-1', name: 'User', email: 'user@example.com', role: 'USER' } as any);
    mockedPrisma.emailDispatch.count.mockResolvedValue(0);
    mockedPrisma.inboundResponse.count.mockResolvedValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['warmup just turned on (Day 1)', { warmupEnabled: true, warmupStartedAt: NOW }, 50],
    ['warmup on its third day', { warmupEnabled: true, warmupStartedAt: new Date(NOW.getTime() - 2 * DAY) }, 54],
    ['warmup off', { warmupEnabled: false }, 500],
    ['a daily limit below the ramp', { warmupEnabled: true, warmupStartedAt: new Date(NOW.getTime() - 40 * DAY), dailyLimit: 100 }, 100],
  ])('with %s', async (_label, saved, cap) => {
    const stored = row(saved);
    mockedDb.getAccounts.mockResolvedValue([row()]);
    mockedPrisma.senderAccount.findUnique.mockResolvedValue(row());
    mockedDb.updateAccount.mockResolvedValue(stored);

    const res = await putAccount(putReq({ id: 'mb-1', warmupEnabled: stored.warmupEnabled }));
    expect(res.status).toBe(200);
    const answer = await res.json();
    expect(answer.effectiveDailyCap).toBe(cap);
    expect(answer.imapPass).toBe(MASKED_SECRET);

    // GET computes the same cap for the stored row, and only GET counts the stats the page keeps.
    mockedDb.getAccounts.mockResolvedValue([stored]);
    const [listed] = await (await getAccounts()).json();
    expect(listed.effectiveDailyCap).toBe(cap);
    for (const stat of ['sentLast24Hours', 'sentTotal', 'delivered', 'opens', 'clicks', 'replies', 'bounced']) {
      expect(listed).toHaveProperty(stat);
      expect(answer).not.toHaveProperty(stat);
    }
  });
});

describe('mailboxLimitInputValue only lets whole numbers the field allows be saved (M71)', () => {
  it('reads whole numbers at or above the field minimum', () => {
    expect(mailboxLimitInputValue('dailyLimit', '500')).toEqual({ value: 500, error: null });
    expect(mailboxLimitInputValue('dailyLimit', ' 10 ')).toEqual({ value: 10, error: null });
    expect(mailboxLimitInputValue('warmupLimit', '1')).toEqual({ value: 1, error: null });
    expect(mailboxLimitInputValue('warmupRamp', '0')).toEqual({ value: 0, error: null });
    expect(mailboxLimitInputValue('warmupRamp', String(MAX_MAILBOX_LIMIT))).toEqual({ value: MAX_MAILBOX_LIMIT, error: null });
  });

  it('refuses a cleared field instead of saving NaN, and fractions, negatives, values below the minimum or too large', () => {
    for (const [field, text] of [
      ['dailyLimit', ''], ['dailyLimit', '  '], ['dailyLimit', '9'], ['dailyLimit', '12.5'], ['dailyLimit', 'abc'],
      ['warmupLimit', '0'], ['warmupRamp', '-1'], ['warmupRamp', String(MAX_MAILBOX_LIMIT + 1)],
    ] as const) {
      const result = mailboxLimitInputValue(field, text);
      expect(result.value).toBeNull();
      expect(result.error).toMatch(/must be a whole number from \d+ to 2,147,483,647\.$/);
    }
    expect(mailboxLimitInputValue('dailyLimit', '').error).toBe('Per Day must be a whole number from 10 to 2,147,483,647.');
  });
});

type Fields = Record<string, unknown>;
type Call = { field: string; value: unknown; resolve: (answer: Fields) => void; reject: (error: unknown) => void };

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The page's use of MailboxSettingsSaves: show the value at once, queue the PUT, merge the answer or restore on failure. */
function harness(initial: Fields) {
  const shown: Fields = { ...initial };
  const server: Fields = { ...initial };
  const calls: Call[] = [];
  const failures: Fields[] = [];
  const saves = new MailboxSettingsSaves();
  const save = (field: string, value: unknown) => {
    const before = { ...shown };
    shown[field] = value;
    void saves.enqueue({
      accountId: 'mb-1', field, shown: before,
      send: () => new Promise<Fields>((resolve, reject) => calls.push({ field, value, resolve, reject })),
      onSaved: (fields) => Object.assign(shown, fields),
      onFailed: (restore) => { failures.push(restore); Object.assign(shown, restore); },
    });
  };
  /** The server stores PUT number `i` (and any columns it changes with it) and answers with the whole row. */
  const answer = async (i: number, serverColumns: Fields = {}) => {
    Object.assign(server, { [calls[i].field]: calls[i].value }, serverColumns);
    calls[i].resolve({ ...server, effectiveDailyCap: `cap after PUT ${i}` });
    await flush();
  };
  const refuse = async (i: number) => {
    calls[i].reject(new Error('refused'));
    await flush();
  };
  return { shown, server, calls, failures, saves, save, answer, refuse };
}

describe('MailboxSettingsSaves stores the last value made and never shows a stale answer (M71)', () => {
  it('sends one save at a time in the order made, so an earlier value can not be stored last', async () => {
    const h = harness({ dailyLimit: 500 });
    h.save('dailyLimit', 5);
    h.save('dailyLimit', 50);
    h.save('dailyLimit', 300);
    await flush();
    expect(h.calls.map((c) => c.value)).toEqual([5]);

    await h.answer(0);
    expect(h.calls.map((c) => c.value)).toEqual([5, 50]);
    // The answer to 5 does not replace the 300 still queued.
    expect(h.shown.dailyLimit).toBe(300);

    await h.answer(1);
    await h.answer(2);
    expect(h.server.dailyLimit).toBe(300);
    expect(h.shown).toMatchObject({ dailyLimit: 300, effectiveDailyCap: 'cap after PUT 2' });
    expect(h.failures).toEqual([]);
  });

  it("keeps another setting's queued value while an earlier save's answer is merged", async () => {
    const h = harness({ dailyLimit: 500, warmupLimit: 50 });
    h.save('dailyLimit', 300);
    h.save('warmupLimit', 60);
    await flush();

    await h.answer(0);
    // The answer still holds warmupLimit 50; its other columns and the recomputed cap are merged.
    expect(h.shown).toEqual({ dailyLimit: 300, warmupLimit: 60, effectiveDailyCap: 'cap after PUT 0' });

    await h.answer(1);
    expect(h.shown).toEqual({ dailyLimit: 300, warmupLimit: 60, effectiveDailyCap: 'cap after PUT 1' });
  });

  it('restores the value the server holds when the last save fails', async () => {
    const h = harness({ dailyLimit: 500 });
    h.save('dailyLimit', 50);
    h.save('dailyLimit', 70);
    await flush();

    await h.answer(0);
    await h.refuse(1);
    expect(h.failures).toEqual([{ dailyLimit: 50 }]);
    expect(h.shown.dailyLimit).toBe(h.server.dailyLimit);
    expect(h.shown.dailyLimit).toBe(50);
  });

  it('restores the value from before every failed save, reporting only the last failure', async () => {
    const h = harness({ dailyLimit: 500 });
    h.save('dailyLimit', 50);
    h.save('dailyLimit', 70);
    await flush();

    await h.refuse(0);
    expect(h.failures).toEqual([]);
    expect(h.shown.dailyLimit).toBe(70);

    await h.refuse(1);
    expect(h.failures).toEqual([{ dailyLimit: 500 }]);
    expect(h.shown.dailyLimit).toBe(500);
  });

  it('leaves a failure superseded by a later save that succeeds unreported', async () => {
    const h = harness({ dailyLimit: 500 });
    h.save('dailyLimit', 50);
    h.save('dailyLimit', 70);
    await flush();

    await h.refuse(0);
    expect(h.calls).toHaveLength(2);
    await h.answer(1);
    expect(h.failures).toEqual([]);
    expect(h.shown.dailyLimit).toBe(70);
    expect(h.server.dailyLimit).toBe(70);
  });

  it("treats the ramp restart columns as part of a warmup toggle's save", async () => {
    const h = harness({ warmupEnabled: false, warmupStartedAt: '2026-01-01T00:00:00.000Z', warmupSent: 3000 });
    h.save('warmupEnabled', true);
    h.save('warmupEnabled', false);
    await flush();

    await h.answer(0, { warmupStartedAt: '2026-09-30T12:00:00.000Z', warmupSent: 0 });
    // The queued toggle decides warmupEnabled, so the answer's toggle columns are not merged.
    expect(h.shown).toMatchObject({ warmupEnabled: false, warmupStartedAt: '2026-01-01T00:00:00.000Z', warmupSent: 3000 });

    await h.refuse(1);
    expect(h.failures).toEqual([{ warmupEnabled: true, warmupStartedAt: '2026-09-30T12:00:00.000Z', warmupSent: 0 }]);
    expect(h.shown).toMatchObject({ warmupEnabled: true, warmupStartedAt: '2026-09-30T12:00:00.000Z', warmupSent: 0 });
  });

  it('filters only the mailbox whose saves are queued, as the credentials save uses it', async () => {
    const h = harness({ dailyLimit: 500 });
    h.save('dailyLimit', 300);
    const answer = { dailyLimit: 500, imapHost: 'imap.example.com', imapPass: MASKED_SECRET };

    expect(h.saves.withoutQueuedFields('mb-1', answer)).toEqual({ imapHost: 'imap.example.com', imapPass: MASKED_SECRET });
    expect(h.saves.withoutQueuedFields('mb-2', answer)).toEqual(answer);

    await flush();
    await h.answer(0);
    expect(h.saves.withoutQueuedFields('mb-1', answer)).toEqual(answer);
  });
});
