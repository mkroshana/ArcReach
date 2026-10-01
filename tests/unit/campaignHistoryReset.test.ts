import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';
import { matchesWhere } from './helpers/prismaWhere';
import {
  type FlagEnrollment,
  type LeadSends,
  type ResetOptions,
  type SafetyState,
  KEPT_DISPATCH_WHERE,
  KEPT_TABLES,
  ORPHAN_SEQUENCE_DISPATCH_WHERE,
  RESET_DISPATCH_WHERE,
  RESET_TABLES,
  afterResetProblems,
  appliedLeadFlagChanges,
  applyLeadFlagChanges,
  applyRefusals,
  campaignProgress,
  databaseHost,
  enrollmentExportRows,
  expectedLeadBreakdown,
  leadFlagExportRows,
  outDirRefusal,
  parseResetArgs,
  planLeadFlagChanges,
  planProgressGroups,
  safetyChecks,
  saveProgressGroups,
  summarizeLeadSends,
} from '../../lib/campaignHistoryReset';

/**
 * The selection rules of scripts/reset-campaign-history.ts over in-memory
 * rows: which emails it deletes and keeps, which leads get their flags fixed
 * and which go in the progress groups, what it exports, and when --apply
 * refuses. The writes run against a fake client that evaluates the real where
 * clauses (helpers/prismaWhere) and enforces the unique keys, so the tests
 * check the rows really left behind.
 */
type Row = Record<string, any>;

const AZURE_ERROR = 'The long-running operation has failed. EmailDroppedAllRecipientsSuppressed. Message dropped because all recipients were suppressed';
const CLOCK_ERROR = 'The request time is invalid: the time difference between the originating client and the server exceeds 5 minutes';

function enrollment(leadId: string, lastError: string | null, lead: Partial<FlagEnrollment['lead']> = {}, status = 'Failed', campaignName = 'JPM Cold Outreach'): FlagEnrollment {
  return {
    leadId,
    campaignName,
    status,
    lastError,
    lead: { email: `${leadId}@acme.com`, status: 'Neutral', validationStatus: 'Risky', ...lead },
  };
}

/** A fake client over `tables` for the lead flag and progress group writes. */
function fakeClient(tables: Record<string, Row[]>) {
  const uniqueKeys: Record<string, string[]> = { suppressedEmail: ['email'], leadGroup: ['name'], leadGroupMembership: ['leadId', 'groupId'] };
  const key = (table: string, row: Row) => JSON.stringify((uniqueKeys[table] ?? ['id']).map((field) => row[field]));
  const createMany = (table: string) => async ({ data, skipDuplicates }: Row) => {
    let count = 0;
    for (const row of data) {
      if (tables[table].some((existing) => key(table, existing) === key(table, row))) {
        if (skipDuplicates) continue;
        throw new Error(`Unique constraint failed on ${table}`);
      }
      tables[table].push({ ...row });
      count++;
    }
    return { count };
  };
  let seq = 0;
  return {
    lead: {
      updateMany: async ({ where, data }: Row) => {
        const rows = tables.lead.filter((row) => matchesWhere(row, where));
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
    },
    suppressedEmail: { createMany: createMany('suppressedEmail') },
    leadGroup: {
      findUnique: async ({ where }: Row) => tables.leadGroup.find((row) => row.name === where.name) ?? null,
      create: async ({ data }: Row) => {
        if (tables.leadGroup.some((row) => row.name === data.name)) throw new Error('Unique constraint failed on leadGroup');
        const row = { id: `group-${++seq}`, ...data };
        tables.leadGroup.push(row);
        return { id: row.id };
      },
    },
    leadGroupMembership: { createMany: createMany('leadGroupMembership') },
  } as any;
}

describe('parseResetArgs', () => {
  it('defaults to a dry run that needs only --out', () => {
    const parsed = parseResetArgs(['--out=C:/exports']);
    expect(parsed).toEqual({
      ok: true,
      options: { apply: false, out: 'C:/exports', expectDispatches: null, azureDropped: null, clockSkew: null, saveProgressGroups: null },
    });
  });

  it('refuses a run without --out', () => {
    expect(parseResetArgs([])).toMatchObject({ ok: false, error: expect.stringContaining('--out') });
    expect(parseResetArgs(['--out='])).toMatchObject({ ok: false });
  });

  it('refuses --apply until every decision flag and the expected count are given', () => {
    const parsed = parseResetArgs(['--out=/x', '--apply']);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    for (const flag of ['--expect-dispatches', '--azure-dropped', '--clock-skew', '--save-progress-groups']) {
      expect(parsed.error).toContain(flag);
    }
    expect(parseResetArgs(['--out=/x', '--apply', '--expect-dispatches=5', '--azure-dropped=suppress', '--clock-skew=reset']))
      .toMatchObject({ ok: false, error: expect.stringContaining('--save-progress-groups') });
  });

  it('reads every flag, a bare --save-progress-groups as yes and each keep or no alternative', () => {
    expect(parseResetArgs(['--out=/x', '--apply', '--expect-dispatches=213966', '--azure-dropped=suppress', '--clock-skew=reset', '--save-progress-groups']))
      .toEqual({
        ok: true,
        options: { apply: true, out: '/x', expectDispatches: 213966, azureDropped: 'suppress', clockSkew: 'reset', saveProgressGroups: true },
      });
    expect(parseResetArgs(['--apply', '--out=/x', '--expect-dispatches=0', '--azure-dropped=keep', '--clock-skew=keep', '--save-progress-groups=no']))
      .toEqual({
        ok: true,
        options: { apply: true, out: '/x', expectDispatches: 0, azureDropped: 'keep', clockSkew: 'keep', saveProgressGroups: false },
      });
  });

  it('refuses unknown, repeated and out-of-range arguments, so a typo never runs with a default', () => {
    expect(parseResetArgs(['--out=/x', '--azure-droped=suppress'])).toMatchObject({ ok: false, error: expect.stringContaining('Unknown') });
    expect(parseResetArgs(['--out=/x', '--azure-dropped'])).toMatchObject({ ok: false, error: expect.stringContaining('Unknown') });
    expect(parseResetArgs(['--out=/x', '--apply=yes'])).toMatchObject({ ok: false, error: expect.stringContaining('Unknown') });
    expect(parseResetArgs(['--out=/x', '--clock-skew=reset', '--clock-skew=keep'])).toMatchObject({ ok: false, error: expect.stringContaining('more than once') });
    expect(parseResetArgs(['--out=/x', '--azure-dropped=yes'])).toMatchObject({ ok: false });
    expect(parseResetArgs(['--out=/x', '--clock-skew=suppress'])).toMatchObject({ ok: false });
    expect(parseResetArgs(['--out=/x', '--save-progress-groups=true'])).toMatchObject({ ok: false });
    expect(parseResetArgs(['--out=/x', '--expect-dispatches=213,966'])).toMatchObject({ ok: false });
    expect(parseResetArgs(['--out=/x', '--expect-dispatches=-1'])).toMatchObject({ ok: false });
  });
});

describe('outDirRefusal', () => {
  const main = path.join(os.tmpdir(), 'ArcReach');
  const worktree = path.join(main, '.claude', 'worktrees', 'stats-fixes');

  it('refuses the repository, a folder inside it, and the checkout a worktree sits in', () => {
    expect(outDirRefusal(worktree, [worktree, main])).toContain('outside the repository');
    expect(outDirRefusal(path.join(worktree, 'exports'), [worktree, main])).toContain(worktree);
    expect(outDirRefusal(path.join(main, 'exports'), [worktree, main])).toContain(main);
  });

  it('accepts a folder outside, including a sibling whose name starts with the repository name', () => {
    expect(outDirRefusal(path.join(os.tmpdir(), 'reset-export'), [worktree, main])).toBeNull();
    expect(outDirRefusal(`${main}-exports`, [worktree, main])).toBeNull();
  });
});

describe('databaseHost', () => {
  it('gives only the host, never the user, password or database', () => {
    const host = databaseHost('postgresql://arcadmin:s3cret@arcreach-db.postgres.database.azure.com:5432/arcreach?sslmode=require');
    expect(host).toBe('arcreach-db.postgres.database.azure.com');
  });

  it('reads ?host= as Prisma does, and gives null when there is no URL', () => {
    expect(databaseHost('postgresql://postgres@localhost/arcreach?host=/var/run/postgresql')).toBe('/var/run/postgresql');
    expect(databaseHost(undefined)).toBeNull();
    expect(databaseHost('not a url')).toBeNull();
  });
});

describe('which emails the reset deletes', () => {
  const campaignEmail = { campaignId: 'cmp-1', leadId: 'lead-1', stepOrder: 2 };
  const orphanStep = { campaignId: null, leadId: 'lead-1', stepOrder: 1 };
  const mailboxTest = { campaignId: null, leadId: null, stepOrder: null };
  const uniboxReply = { campaignId: null, leadId: 'lead-1', stepOrder: null };
  const legacyNoStep = { campaignId: 'cmp-1', leadId: 'lead-1', stepOrder: null };

  it('deletes every email with a campaign or a step and keeps mailbox tests and Unibox replies', () => {
    expect([campaignEmail, orphanStep, mailboxTest, uniboxReply, legacyNoStep].map((row) => matchesWhere(row, RESET_DISPATCH_WHERE)))
      .toEqual([true, true, false, false, true]);
    expect([campaignEmail, orphanStep, mailboxTest, uniboxReply, legacyNoStep].map((row) => matchesWhere(row, KEPT_DISPATCH_WHERE)))
      .toEqual([false, false, true, true, false]);
  });

  it('sweeps only sequence emails whose campaign is gone after the per-campaign batches', () => {
    expect([campaignEmail, orphanStep, mailboxTest, uniboxReply].map((row) => matchesWhere(row, ORPHAN_SEQUENCE_DISPATCH_WHERE)))
      .toEqual([false, true, false, false]);
  });
});

describe('planLeadFlagChanges', () => {
  it('plans a hard bounce for each lead ACS refused as suppressed, whatever its enrollment status, keeping Unsubscribed', () => {
    const changes = planLeadFlagChanges([
      enrollment('risky', AZURE_ERROR),
      enrollment('completed', 'emaildroppedallrecipientssuppressed', { validationStatus: 'Unverified' }, 'Completed'),
      enrollment('optout', AZURE_ERROR, { status: 'Unsubscribed', validationStatus: 'Unverified' }, 'Paused'),
      enrollment('other', 'Mailbox unavailable'),
    ], new Map([['optout@acme.com', 'Unsubscribed']]));

    expect(changes.map((c) => [c.kind, c.leadId, c.planned, c.changes])).toEqual([
      ['azure-dropped', 'completed', { status: 'Bounced', validationStatus: 'Invalid', suppression: 'HardBounce' }, true],
      // An address already on the list keeps its first reason
      ['azure-dropped', 'optout', { status: 'Unsubscribed', validationStatus: 'Invalid', suppression: 'Unsubscribed' }, true],
      ['azure-dropped', 'risky', { status: 'Bounced', validationStatus: 'Invalid', suppression: 'HardBounce' }, true],
    ]);
    expect(changes[0].current).toEqual({ status: 'Neutral', validationStatus: 'Unverified', suppression: null });
    expect(changes[0].enrollmentStatuses).toEqual(['Completed']);
  });

  it('resets only clock-skew leads still Risky, and never one ACS also refused', () => {
    const changes = planLeadFlagChanges([
      enrollment('skewed', CLOCK_ERROR),
      enrollment('recovered', CLOCK_ERROR, { validationStatus: 'Unverified' }, 'Completed'),
      enrollment('both', CLOCK_ERROR, {}, 'Failed', 'HR Leads Initial'),
      enrollment('both', AZURE_ERROR),
    ], new Map());

    expect(changes.map((c) => [c.kind, c.leadId])).toEqual([['azure-dropped', 'both'], ['clock-skew', 'skewed']]);
    expect(changes[1].planned).toEqual({ status: 'Neutral', validationStatus: 'Unverified', suppression: null });
  });

  it('lists a lead once with every matching enrollment, and marks one a run before fixed as changing nothing', () => {
    const changes = planLeadFlagChanges([
      enrollment('twice', AZURE_ERROR, {}, 'Failed', 'A'),
      enrollment('twice', AZURE_ERROR, {}, 'Completed', 'B'),
      enrollment('done', AZURE_ERROR, { status: 'Bounced', validationStatus: 'Invalid' }),
    ], new Map([['done@acme.com', 'HardBounce']]));

    expect(changes.map((c) => [c.leadId, c.campaigns, c.enrollmentStatuses, c.changes])).toEqual([
      ['done', ['JPM Cold Outreach'], ['Failed'], false],
      ['twice', ['A', 'B'], ['Failed', 'Completed'], true],
    ]);
  });
});

describe('applyLeadFlagChanges', () => {
  function seed() {
    return {
      lead: [
        { id: 'risky', email: 'risky@acme.com', status: 'Neutral', validationStatus: 'Risky' },
        { id: 'optout', email: 'optout@acme.com', status: 'Unsubscribed', validationStatus: 'Unverified' },
        { id: 'skewed', email: 'skewed@acme.com', status: 'Neutral', validationStatus: 'Risky' },
        { id: 'bystander', email: 'bystander@acme.com', status: 'Neutral', validationStatus: 'Risky' },
      ],
      suppressedEmail: [{ email: 'optout@acme.com', reason: 'Unsubscribed', source: 'backfill' }],
      leadGroup: [],
      leadGroupMembership: [],
    } as Record<string, Row[]>;
  }
  const enrollments = (tables: Record<string, Row[]>): FlagEnrollment[] => [
    { leadId: 'risky', error: AZURE_ERROR },
    { leadId: 'optout', error: AZURE_ERROR },
    { leadId: 'skewed', error: CLOCK_ERROR },
  ].map(({ leadId, error }) => {
    const lead = tables.lead.find((row) => row.id === leadId)!;
    return enrollment(leadId, error, { email: lead.email, status: lead.status, validationStatus: lead.validationStatus });
  });
  const suppression = (tables: Record<string, Row[]>) => new Map(tables.suppressedEmail.map((row) => [row.email, row.reason]));

  it('suppresses azure-dropped addresses as HardBounce from the backfill and fixes the leads, leaving the rest alone', async () => {
    const tables = seed();
    const changes = planLeadFlagChanges(enrollments(tables), suppression(tables));
    const written = await applyLeadFlagChanges(fakeClient(tables), changes, { azureDropped: 'suppress', clockSkew: 'reset' });

    expect(written).toEqual({ suppressed: 1, bounced: 1, invalidOnly: 1, unverified: 1 });
    expect(tables.suppressedEmail).toEqual([
      { email: 'optout@acme.com', reason: 'Unsubscribed', source: 'backfill' },
      { email: 'risky@acme.com', reason: 'HardBounce', source: 'backfill' },
    ]);
    expect(tables.lead.map((l) => [l.id, l.status, l.validationStatus])).toEqual([
      ['risky', 'Bounced', 'Invalid'],
      ['optout', 'Unsubscribed', 'Invalid'],
      ['skewed', 'Neutral', 'Unverified'],
      ['bystander', 'Neutral', 'Risky'],
    ]);
    expect(appliedLeadFlagChanges(changes, { azureDropped: 'suppress', clockSkew: 'reset' }).map((c) => c.leadId)).toEqual(['optout', 'risky', 'skewed']);
  });

  it('changes nothing when run again from the state it left', async () => {
    const tables = seed();
    await applyLeadFlagChanges(fakeClient(tables), planLeadFlagChanges(enrollments(tables), suppression(tables)), { azureDropped: 'suppress', clockSkew: 'reset' });
    const after = JSON.stringify(tables);

    const again = planLeadFlagChanges(enrollments(tables), suppression(tables));
    expect(again.every((change) => !change.changes)).toBe(true);
    const written = await applyLeadFlagChanges(fakeClient(tables), again, { azureDropped: 'suppress', clockSkew: 'reset' });
    expect(written).toEqual({ suppressed: 0, bounced: 0, invalidOnly: 0, unverified: 0 });
    expect(JSON.stringify(tables)).toBe(after);
  });

  it('writes nothing with keep', async () => {
    const tables = seed();
    const before = JSON.stringify(tables);
    const changes = planLeadFlagChanges(enrollments(tables), suppression(tables));
    expect(await applyLeadFlagChanges(fakeClient(tables), changes, { azureDropped: 'keep', clockSkew: 'keep' }))
      .toEqual({ suppressed: 0, bounced: 0, invalidOnly: 0, unverified: 0 });
    expect(JSON.stringify(tables)).toBe(before);
    expect(appliedLeadFlagChanges(changes, { azureDropped: 'keep', clockSkew: 'keep' })).toEqual([]);
  });
});

describe('progress groups', () => {
  const at = (iso: string) => new Date(`2026-09-${iso}Z`);
  function group(campaignId: string | null, leadId: string | null, status: string, count: number, stepOrder: number | null, sentAt: Date | null) {
    return { campaignId, leadId, status, _count: { _all: count }, _max: { stepOrder, sentAt } };
  }
  const sends = summarizeLeadSends([
    group('jpm', 'done', 'Sent', 13, 13, at('20T10:00:00')),
    group('jpm', 'last-step', 'Sent', 3, 13, at('21T10:00:00')),
    group('jpm', 'last-step', 'Failed', 2, 4, at('19T10:00:00')),
    group('jpm', 'partway', 'Sent', 2, 2, at('22T10:00:00')),
    group('jpm', 'partway', 'Sending', 1, 3, at('29T10:00:00')),
    group('jpm', 'failed-only', 'Failed', 4, 1, at('10T10:00:00')),
    group('jpm', 'no-enrollment', 'Sent', 1, 1, at('11T10:00:00')),
    group('jpm', 'unknown-only', 'Unknown', 1, 1, at('12T10:00:00')),
    group('hr', 'hr-1', 'Sent', 1, 1, at('01T10:00:00')),
    group(null, 'orphan', 'Sent', 1, 1, at('01T10:00:00')),
  ]);
  const enrollments = [
    { campaignId: 'jpm', leadId: 'done', status: 'Completed' },
    { campaignId: 'jpm', leadId: 'last-step', status: 'Failed' },
    { campaignId: 'jpm', leadId: 'partway', status: 'Active' },
    { campaignId: 'jpm', leadId: 'failed-only', status: 'Failed' },
    { campaignId: 'jpm', leadId: 'never-sent', status: 'Active' },
    { campaignId: 'jpm', leadId: 'completed-no-sends', status: 'Completed' },
    { campaignId: 'jpm', leadId: 'unknown-only', status: 'Active' },
    { campaignId: 'hr', leadId: 'hr-1', status: 'Paused' },
  ];

  it('sums what each campaign sent each lead from Sent and Failed rows only', () => {
    expect(sends.get('jpm')?.get('last-step')).toEqual({ sent: 3, failed: 2, highestStepSent: 13, lastSentAt: at('21T10:00:00') });
    expect(sends.get('jpm')?.get('partway')).toEqual({ sent: 2, failed: 0, highestStepSent: 2, lastSentAt: at('22T10:00:00') });
    expect(sends.get('jpm')?.get('failed-only')).toEqual({ sent: 0, failed: 4, highestStepSent: null, lastSentAt: null });
    expect([...sends.keys()]).toEqual(['jpm', 'hr']);
  });

  it('counts a lead finished when its enrollment completed or it was sent the last step, and contacted when sent anything else', () => {
    expect(campaignProgress(13, enrollments.filter((e) => e.campaignId === 'jpm'), sends.get('jpm')!)).toEqual({
      finished: ['completed-no-sends', 'done', 'last-step'],
      contacted: ['no-enrollment', 'partway'],
    });
    // With no steps, only a completed enrollment finishes a lead
    expect(campaignProgress(null, [{ leadId: 'a', status: 'Active' }], new Map<string, LeadSends>([['a', { sent: 1, failed: 0, highestStepSent: 1, lastSentAt: null }]])))
      .toEqual({ finished: [], contacted: ['a'] });
  });

  it('names the groups after the campaign and leaves out an empty one', () => {
    const plans = planProgressGroups(
      [{ id: 'jpm', name: 'JPM Cold Outreach', lastStep: 13 }, { id: 'hr', name: 'HR Leads Initial', lastStep: 5 }, { id: 'draft', name: 'Draft', lastStep: 1 }],
      enrollments,
      sends,
      '2026-10-01',
    );
    expect(plans.map((p) => [p.name, p.leadIds])).toEqual([
      ['JPM Cold Outreach - Finished', ['completed-no-sends', 'done', 'last-step']],
      ['JPM Cold Outreach - Contacted, not finished', ['no-enrollment', 'partway']],
      ['HR Leads Initial - Contacted, not finished', ['hr-1']],
    ]);
    expect(plans[0].description).toContain('2026-10-01');
  });

  it('creates a group or reuses the one with its name, and adds each lead once however often it runs', async () => {
    const tables: Record<string, Row[]> = {
      lead: [], suppressedEmail: [],
      leadGroup: [{ id: 'existing', name: 'JPM Cold Outreach - Finished', description: 'made by hand' }],
      leadGroupMembership: [{ leadId: 'done', groupId: 'existing' }],
    };
    const plans = planProgressGroups([{ id: 'jpm', name: 'JPM Cold Outreach', lastStep: 13 }], enrollments, sends, '2026-10-01');

    expect(await saveProgressGroups(fakeClient(tables), plans)).toEqual([
      { name: 'JPM Cold Outreach - Finished', created: false, added: 2 },
      { name: 'JPM Cold Outreach - Contacted, not finished', created: true, added: 2 },
    ]);
    expect(tables.leadGroup.map((g) => [g.name, g.description])).toEqual([
      ['JPM Cold Outreach - Finished', 'made by hand'],
      ['JPM Cold Outreach - Contacted, not finished', plans[1].description],
    ]);
    expect(tables.leadGroupMembership).toHaveLength(5);

    expect(await saveProgressGroups(fakeClient(tables), plans)).toEqual([
      { name: 'JPM Cold Outreach - Finished', created: false, added: 0 },
      { name: 'JPM Cold Outreach - Contacted, not finished', created: false, added: 0 },
    ]);
    expect(tables.leadGroup).toHaveLength(2);
    expect(tables.leadGroupMembership).toHaveLength(5);
  });
});

describe('the export', () => {
  it('gives each enrollment what its campaign sent the lead, and adds a row for a lead it emailed without one', () => {
    const sends = summarizeLeadSends([
      { campaignId: 'jpm', leadId: 'a', status: 'Sent', _count: { _all: 2 }, _max: { stepOrder: 2, sentAt: new Date('2026-09-01T00:00:00Z') } },
      { campaignId: 'jpm', leadId: 'a', status: 'Failed', _count: { _all: 1 }, _max: { stepOrder: 3, sentAt: new Date('2026-09-02T00:00:00Z') } },
      { campaignId: 'jpm', leadId: 'gone', status: 'Sent', _count: { _all: 1 }, _max: { stepOrder: 1, sentAt: new Date('2026-08-01T00:00:00Z') } },
    ]);
    const rows = enrollmentExportRows(
      [
        { leadId: 'a', campaignId: 'jpm', status: 'Active', currentSequenceStep: 3, retryCount: 1, lastError: AZURE_ERROR, lastBounceType: 'soft', enrolledAt: new Date('2026-07-01T00:00:00Z'), lead: { email: 'a@acme.com' } },
        { leadId: 'b', campaignId: 'jpm', status: 'Active', currentSequenceStep: 1, retryCount: 0, lastError: null, lastBounceType: null, enrolledAt: new Date('2026-07-01T00:00:00Z'), lead: { email: 'b@acme.com' } },
      ],
      sends,
      new Map([['jpm', 'JPM Cold Outreach']]),
      new Map([['gone', 'gone@acme.com']]),
    );
    expect(rows).toEqual([
      expect.objectContaining({ leadId: 'a', email: 'a@acme.com', campaign: 'JPM Cold Outreach', enrollmentStatus: 'Active', currentStep: 3, retryCount: 1, lastError: AZURE_ERROR, lastBounceType: 'soft', sentEmails: 2, failedEmails: 1, highestStepSent: 2, lastSentAt: new Date('2026-09-01T00:00:00Z') }),
      expect.objectContaining({ leadId: 'b', sentEmails: 0, failedEmails: 0, highestStepSent: null, lastSentAt: null }),
      { leadId: 'gone', email: 'gone@acme.com', campaignId: 'jpm', campaign: 'JPM Cold Outreach', sentEmails: 1, failedEmails: 0, highestStepSent: 1, lastSentAt: new Date('2026-08-01T00:00:00Z') },
    ]);
  });

  it('says on each lead flag row what the run was told to do with it', () => {
    const changes = planLeadFlagChanges([enrollment('a', AZURE_ERROR), enrollment('b', CLOCK_ERROR)], new Map());
    expect(leadFlagExportRows(changes, { azureDropped: 'suppress', clockSkew: null }).map((row) => [row.change, row.flag, row.plannedValidationStatus, row.changes]))
      .toEqual([['azure-dropped', '--azure-dropped=suppress', 'Invalid', 'yes'], ['clock-skew', 'not given', 'Unverified', 'yes']]);
  });
});

describe('when --apply refuses', () => {
  const options: ResetOptions = { apply: true, out: '/x', expectDispatches: 213966, azureDropped: 'suppress', clockSkew: 'reset', saveProgressGroups: true };
  const quiet: SafetyState = {
    campaigns: [{ name: 'JPM Cold Outreach', status: 'Paused', pausedUntil: null }, { name: 'HR Leads Initial', status: 'Stopped', pausedUntil: null }],
    sendingEmails: 0,
    recentClaims: 0,
    campaignReplies: 0,
  };
  const refusals = (state: SafetyState, overrides: Partial<Parameters<typeof applyRefusals>[0]> = {}) =>
    applyRefusals({ options, exportWritten: true, resetDispatches: 213966, campaignCount: state.campaigns.length, checks: safetyChecks(state), ...overrides });

  it('runs when every check passes and the expected count matches', () => {
    expect(safetyChecks(quiet).every((check) => check.ok)).toBe(true);
    expect(refusals(quiet)).toEqual([]);
  });

  it('refuses while a campaign is Active or due to auto-resume, an email is Sending, a claim is fresh or a reply has a campaign', () => {
    const resumes = new Date('2026-10-01T13:00:00Z');
    expect(refusals({ ...quiet, campaigns: [{ name: 'JPM Cold Outreach', status: 'Active', pausedUntil: null }] })).toEqual([
      'No campaign is Active or has an auto-resume time: "JPM Cold Outreach" Active.',
    ]);
    expect(refusals({ ...quiet, campaigns: [{ name: 'JPM Cold Outreach', status: 'Paused', pausedUntil: resumes }] })[0])
      .toContain('resumes 2026-10-01T13:00:00.000Z');
    expect(refusals({ ...quiet, sendingEmails: 3 })).toEqual(['No campaign email is Sending: 3 Sending.']);
    expect(refusals({ ...quiet, recentClaims: 1 })).toEqual(['No enrollment has a send claim from the last 10 minutes: 1 claimed.']);
    expect(refusals({ ...quiet, campaignReplies: 2 })).toEqual(['No reply (InboundResponse) belongs to a campaign: 2 with a campaign.']);
  });

  it('refuses when the expected count differs from the emails to delete now, or the export was not written', () => {
    expect(refusals(quiet, { resetDispatches: 213970 })[0]).toContain('does not match the 213970 campaign emails');
    expect(refusals(quiet, { options: { ...options, expectDispatches: null } })[0]).toContain('(missing)');
    expect(refusals(quiet, { exportWritten: false })).toEqual(['The export was not written in this run.']);
    expect(refusals(quiet, { options: { ...options, clockSkew: null } })[0]).toContain('--clock-skew');
  });

  it('does nothing, without refusing, once no campaign and no campaign email is left', () => {
    expect(refusals({ ...quiet, campaigns: [] }, { resetDispatches: 0 })).toEqual([]);
    // Campaigns still there after a crash need the new count
    expect(refusals(quiet, { resetDispatches: 0 })).toHaveLength(1);
  });
});

describe('the check after the reset', () => {
  const kept = Object.fromEntries(KEPT_TABLES.map((table, i) => [table, 100 + i]));
  const emptied = Object.fromEntries(RESET_TABLES.map((table) => [table, 0]));

  it('passes when the reset tables are empty and the kept ones grew only by what the flag step added', () => {
    const after = { reset: emptied, kept: { ...kept, SuppressedEmail: kept.SuppressedEmail + 61, LeadGroup: kept.LeadGroup + 2 } };
    expect(afterResetProblems({ kept }, after, { SuppressedEmail: 61, LeadGroup: 2 })).toEqual([]);
  });

  it('fails on anything left to delete and on any other change to a kept table', () => {
    const after = {
      reset: { ...emptied, Campaign: 1 },
      kept: { ...kept, Lead: kept.Lead - 1, 'EmailDispatch (no campaign or step)': 0, SuppressedEmail: kept.SuppressedEmail + 62 },
    };
    expect(afterResetProblems({ kept }, after, { SuppressedEmail: 61 })).toEqual([
      'Campaign: 1 left (expected 0)',
      `Lead: ${kept.Lead - 1} (expected ${kept.Lead})`,
      `SuppressedEmail: ${kept.SuppressedEmail + 62} (expected ${kept.SuppressedEmail + 61})`,
      `EmailDispatch (no campaign or step): 0 (expected ${kept['EmailDispatch (no campaign or step)']})`,
    ]);
  });

  it('expects each applied change to move one lead from its current to its planned status', () => {
    const changes = planLeadFlagChanges([
      enrollment('a', AZURE_ERROR),
      enrollment('b', AZURE_ERROR, { status: 'Unsubscribed', validationStatus: 'Unverified' }),
      enrollment('c', CLOCK_ERROR),
    ], new Map());
    expect(expectedLeadBreakdown({ 'Neutral/Risky': 2, 'Unsubscribed/Unverified': 1, 'Neutral/Unverified': 10 }, changes)).toEqual({
      'Neutral/Unverified': 11,
      'Bounced/Invalid': 1,
      'Unsubscribed/Invalid': 1,
    });
  });
});
