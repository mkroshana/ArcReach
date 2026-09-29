import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * In-memory leads, campaigns, enrollments, dispatches, deleted lead ids and the
 * suppression list. The fake models evaluate the where clauses the lead, group,
 * import, verify and unsubscribe routes build (throwing on filters they don't
 * model), enforce the unique keys, fill the relations a read selects and
 * cascade a lead delete, so the tests check the rows really left behind.
 */
const db = vi.hoisted(() => {
  type Row = Record<string, any>;
  const tables: Record<string, Row[]> = {
    lead: [], leadAlias: [], leadGroup: [], leadGroupMembership: [], campaign: [], campaignEnrollment: [], emailDispatch: [],
    deletedLead: [], suppressedEmail: [],
  };
  const uniqueKeys: Record<string, string[]> = {
    lead: ['email'],
    leadGroupMembership: ['leadId', 'groupId'],
    campaignEnrollment: ['leadId', 'campaignId'],
    suppressedEmail: ['email'],
    deletedLead: ['id'],
  };
  const withoutId = ['leadGroupMembership', 'suppressedEmail'];
  const leadChildren = ['leadAlias', 'leadGroupMembership', 'campaignEnrollment', 'emailDispatch'];
  let seq = 0;

  function matchesValue(value: any, cond: any): boolean {
    if (cond === null || typeof cond !== 'object') return value === cond;
    const fold = (v: any) => (cond.mode === 'insensitive' && typeof v === 'string' ? v.toLowerCase() : v);
    if ('in' in cond) return cond.in.map(fold).includes(fold(value));
    if ('notIn' in cond) return !cond.notIn.includes(value);
    throw new Error(`Unmodelled filter: ${JSON.stringify(cond)}`);
  }

  function matches(table: string, row: Row, where: Row | undefined): boolean {
    if (!where) return true;
    return Object.entries(where).every(([key, cond]: [string, any]) => {
      if (key === 'AND') return cond.every((w: Row) => matches(table, row, w));
      if (table === 'campaignEnrollment' && key === 'campaign') {
        const campaign = tables.campaign.find((c) => c.id === row.campaignId);
        return !!campaign && matches('campaign', campaign, cond);
      }
      if (table === 'lead' && key === 'groups') {
        return tables.leadGroupMembership.some((m) => m.leadId === row.id && m.groupId === cond.some.groupId);
      }
      return matchesValue(row[key], cond);
    });
  }

  /** A copy of `row` with the relations `select` names: a lead's aliases and dispatch count, an alias's lead. */
  function withRelations(table: string, row: Row, select: Row | undefined): Row {
    const out = { ...row };
    if (table === 'lead' && select?.aliases) {
      out.aliases = tables.leadAlias.filter((a) => a.leadId === row.id).map((a) => ({ id: a.id }));
    }
    if (table === 'lead' && select?._count) {
      out._count = { dispatches: tables.emailDispatch.filter((d) => d.leadId === row.id).length };
    }
    if (table === 'leadAlias' && select?.lead) {
      const lead = tables.lead.find((l) => l.id === row.leadId);
      return { lead: lead ? { ...lead } : null };
    }
    return out;
  }

  function insert(table: string, data: Row, skipDuplicates = false): Row | null {
    const row = { ...data };
    if (!withoutId.includes(table) && row.id === undefined) row.id = `${table}-${++seq}`;
    const key = uniqueKeys[table];
    if (key && tables[table].some((other) => key.every((k) => other[k] === row[k]))) {
      if (skipDuplicates) return null;
      throw new Error(`Unique constraint failed on ${table}`);
    }
    tables[table].push(row);
    return row;
  }

  function model(table: string) {
    const find = (where: Row | undefined) => tables[table].filter((r) => matches(table, r, where));
    return {
      findMany: async (args: any = {}) => find(args.where).slice(0, args.take).map((r) => withRelations(table, r, args.select)),
      findFirst: async (args: any = {}) => {
        const row = find(args.where)[0];
        return row ? withRelations(table, row, args.select) : null;
      },
      findUnique: async ({ where, select }: any) => {
        const row = find(where)[0];
        return row ? withRelations(table, row, select) : null;
      },
      create: async ({ data }: any) => {
        const { groups, ...fields } = data;
        const row = insert(table, fields)!;
        for (const g of groups?.create || []) insert('leadGroupMembership', { leadId: row.id, groupId: g.groupId });
        return { ...row, groups: [] };
      },
      createMany: async ({ data, skipDuplicates }: any) => ({
        count: data.filter((d: Row) => insert(table, d, skipDuplicates)).length,
      }),
      update: async ({ where, data }: any) => {
        const row = find(where)[0];
        if (!row) throw new Error(`No ${table} row to update`);
        const { groups, ...fields } = data;
        if (groups) throw new Error('Unmodelled nested groups write');
        Object.assign(row, fields);
        return { ...row };
      },
      updateMany: async ({ where, data }: any) => {
        const rows = find(where);
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
      },
      delete: async ({ where }: any) => {
        const row = find(where)[0];
        if (!row) throw new Error(`No ${table} row to delete`);
        tables[table] = tables[table].filter((r) => r !== row);
        return { ...row };
      },
      deleteMany: async (args: any = {}) => {
        const gone = find(args.where);
        tables[table] = tables[table].filter((r) => !gone.includes(r));
        if (table === 'lead') {
          const ids = new Set(gone.map((r) => r.id));
          for (const child of leadChildren) tables[child] = tables[child].filter((r) => !ids.has(r.leadId));
        }
        return { count: gone.length };
      },
    };
  }

  const client: Record<string, any> = {};
  for (const table of Object.keys(tables)) client[table] = model(table);
  // An interactive transaction runs on the same tables; the array form's writes have already run.
  client.$transaction = async (arg: any) => (typeof arg === 'function' ? arg(client) : Promise.all(arg));

  return {
    client,
    tables,
    reset() {
      for (const table of Object.keys(tables)) tables[table] = [];
      seq = 0;
    },
  };
});

vi.mock('../../lib/db', () => ({ prisma: db.client }));

vi.mock('../../lib/session', () => ({
  getSession: vi.fn(),
}));

vi.mock('../../lib/imapService', () => ({
  syncMailboxReplies: vi.fn(),
  getActiveImapAccounts: vi.fn(),
}));

// acme.com has an MX record; etimeout.test and eservfail.test fail the lookup
// with that error code; any other lookup fails as ENOTFOUND does.
vi.mock('dns', () => {
  const resolveMx = (domain: string, cb: (err: Error | null, records?: unknown[]) => void) => {
    const code = ['etimeout.test', 'eservfail.test'].includes(domain) ? domain.split('.')[0].toUpperCase() : 'ENOTFOUND';
    if (domain === 'acme.com') cb(null, [{ exchange: 'mx.acme.com', priority: 10 }]);
    else cb(Object.assign(new Error(`queryMx ${code} ${domain}`), { code }));
  };
  return { default: { resolveMx }, resolveMx };
});

import { getSession } from '../../lib/session';
import { GET as unsubscribe } from '../../app/api/unsubscribe/route';
import { GET as getLeads, POST as postLead, PUT as putLead, DELETE as deleteLeads } from '../../app/api/leads/route';
import { POST as postBulk } from '../../app/api/leads/bulk/route';
import { POST as postVerify } from '../../app/api/leads/verify/route';
import { POST as postReactivate } from '../../app/api/leads/reactivate/route';
import { DELETE as deleteSuppression } from '../../app/api/leads/suppression/route';
import { DELETE as deleteGroup } from '../../app/api/leads/groups/route';
import { PUT as putUnibox } from '../../app/api/unibox/route';
import { liftsSuppression, suppressEmails, suppressedLeadFields } from '../../lib/suppression';
import { findEnrollableLeadIds } from '../../lib/sendEligibility';

const ADMIN = { id: 'admin-1', name: 'Admin', email: 'admin@example.com', role: 'ADMIN' as const };
const USER = { id: 'user-1', name: 'User', email: 'user@example.com', role: 'USER' as const };

function makeReq(method: string, path: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function addLead(id: string, email: string, fields: Record<string, unknown> = {}) {
  db.tables.lead.push({
    id, email, name: null, company: null, jobTitle: null, status: 'Neutral', validationStatus: 'Unverified', isArchived: false,
    ...fields,
  });
}

function enroll(leadId: string, campaignId: string, status = 'Active') {
  db.tables.campaignEnrollment.push({
    id: `env-${leadId}-${campaignId}`, leadId, campaignId, status, currentSequenceStep: 1, nextActionDate: null, retryCount: 0,
  });
}

function suppress(email: string, reason: string, source = 'unsubscribe-link') {
  db.tables.suppressedEmail.push({ email, reason, source });
}

/** Records a dispatch to the lead, as a campaign send does, so its unsubscribe link is in an inbox. */
function emailed(leadId: string) {
  db.tables.emailDispatch.push({ id: `dispatch-${leadId}`, leadId });
}

const deletedIds = () => db.tables.deletedLead.map(({ id, email }) => ({ id, email }));

const leadById = (id: string) => db.tables.lead.find((l) => l.id === id);
const leadByEmail = (email: string) => db.tables.lead.find((l) => l.email === email);
/** Ids of the leads a campaign cohort may enroll: sendable and not on the suppression list. */
const findEnrollable = () => findEnrollableLeadIds(db.client as any, {});
const enrolledIn = (campaignId: string) =>
  db.tables.campaignEnrollment.filter((e) => e.campaignId === campaignId).map((e) => db.tables.lead.find((l) => l.id === e.leadId)?.email);

beforeEach(() => {
  db.reset();
  vi.mocked(getSession).mockResolvedValue(ADMIN as any);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.tables.campaign.push(
    { id: 'cmp-unverified', audienceCohort: 'Unverified', status: 'Active' },
    { id: 'cmp-valid', audienceCohort: 'Valid', status: 'Active' },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the suppression list outlives the lead (H18)', () => {
  it('keeps an unsubscribed address suppressed through Delete All and a re-import, which reports it', async () => {
    addLead('jane', 'jane@acme.com');
    enroll('jane', 'cmp-unverified');

    expect((await unsubscribe(makeReq('GET', '/api/unsubscribe?id=jane'))).status).toBe(200);
    expect(db.tables.suppressedEmail).toEqual([{ email: 'jane@acme.com', reason: 'Unsubscribed', source: 'unsubscribe-link' }]);

    expect((await deleteLeads(makeReq('DELETE', '/api/leads?all=true'))).status).toBe(200);
    expect(db.tables.lead).toHaveLength(0);
    expect(db.tables.campaignEnrollment).toHaveLength(0);
    expect(db.tables.suppressedEmail).toHaveLength(1);

    const res = await postBulk(makeReq('POST', '/api/leads/bulk', {
      leads: [{ email: 'Jane@Acme.com', name: 'Jane' }, { email: 'bob@acme.com', name: 'Bob' }],
    }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, count: 2, suppressed: 1 });
    // Still created, but as Unsubscribed, and enrolled nowhere.
    expect(leadByEmail('jane@acme.com')).toMatchObject({ status: 'Unsubscribed', validationStatus: 'Unverified' });
    expect(leadByEmail('bob@acme.com')).toMatchObject({ status: 'Neutral', validationStatus: 'Unverified' });
    expect(enrolledIn('cmp-unverified')).toEqual(['bob@acme.com']);
  });

  it('re-imports a hard-bounced address as Bounced and Invalid', async () => {
    suppress('old@acme.com', 'HardBounce', 'delivery-webhook');

    const res = await postBulk(makeReq('POST', '/api/leads/bulk', { leads: [{ email: 'old@acme.com' }] }));

    expect((await res.json()).suppressed).toBe(1);
    expect(leadByEmail('old@acme.com')).toMatchObject({ status: 'Bounced', validationStatus: 'Invalid' });
    expect(db.tables.campaignEnrollment).toHaveLength(0);
  });

  it.each([
    ['Unsubscribed', { status: 'Unsubscribed', validationStatus: 'Unverified' }],
    ['HardBounce', { status: 'Bounced', validationStatus: 'Invalid' }],
    ['Invalid', { status: 'Neutral', validationStatus: 'Invalid' }],
  ])('Add Lead gives an address suppressed as %s its suppressed status, enrolls it nowhere and says so', async (reason, fields) => {
    suppress('old@acme.com', reason);

    const res = await postLead(makeReq('POST', '/api/leads', {
      name: 'Old', email: ' Old@Acme.com', status: 'Neutral', validationStatus: 'Unverified',
    }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ email: 'old@acme.com', suppression: { reason }, ...fields });
    expect(db.tables.campaignEnrollment).toHaveLength(0);
  });

  it('Add Lead still enrolls an address that is not suppressed', async () => {
    const res = await postLead(makeReq('POST', '/api/leads', { name: 'New', email: 'new@acme.com' }));

    expect(await res.json()).toMatchObject({ status: 'Neutral', validationStatus: 'Unverified', suppression: null });
    expect(enrolledIn('cmp-unverified')).toEqual(['new@acme.com']);
  });
});

describe('unsubscribe links of deleted leads (H18)', () => {
  it('suppresses the address when the link of a lead removed by Delete All is clicked, so a re-import comes back Unsubscribed', async () => {
    addLead('jane', 'jane@acme.com');
    enroll('jane', 'cmp-unverified');
    emailed('jane');
    db.tables.leadAlias.push({ id: 'jane-merged', leadId: 'jane' });
    addLead('bob', 'bob@acme.com'); // never emailed

    expect((await deleteLeads(makeReq('DELETE', '/api/leads?all=true'))).status).toBe(200);
    expect(db.tables.lead).toHaveLength(0);
    expect(db.tables.leadAlias).toHaveLength(0);
    // Only the emailed lead, and the lead merged into it, leave their ids behind
    expect(deletedIds()).toEqual([
      { id: 'jane', email: 'jane@acme.com' },
      { id: 'jane-merged', email: 'jane@acme.com' },
    ]);

    const res = await unsubscribe(makeReq('GET', '/api/unsubscribe?id=jane'));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<strong>jane@acme.com</strong> has been removed');
    expect(db.tables.suppressedEmail).toEqual([{ email: 'jane@acme.com', reason: 'Unsubscribed', source: 'unsubscribe-link' }]);
    // The merged lead's link from older mail works too
    expect((await unsubscribe(makeReq('GET', '/api/unsubscribe?id=jane-merged'))).status).toBe(200);

    const imported = await postBulk(makeReq('POST', '/api/leads/bulk', {
      leads: [{ email: 'Jane@Acme.com', name: 'Jane' }, { email: 'bob@acme.com', name: 'Bob' }],
    }));
    expect(await imported.json()).toEqual({ success: true, count: 2, suppressed: 1 });
    expect(leadByEmail('jane@acme.com')).toMatchObject({ status: 'Unsubscribed' });
    expect(enrolledIn('cmp-unverified')).toEqual(['bob@acme.com']);
  });

  it('unsubscribes the lead imported again when the old link is clicked after the re-import', async () => {
    addLead('jane', 'jane@acme.com');
    emailed('jane');
    expect((await deleteLeads(makeReq('DELETE', '/api/leads?id=jane'))).status).toBe(200);
    await postBulk(makeReq('POST', '/api/leads/bulk', { leads: [{ email: 'jane@acme.com' }] }));
    const again = leadByEmail('jane@acme.com')!;
    expect(enrolledIn('cmp-unverified')).toEqual(['jane@acme.com']);

    const res = await unsubscribe(makeReq('GET', '/api/unsubscribe?id=jane'));

    expect(res.status).toBe(200);
    expect(leadById(again.id)!.status).toBe('Unsubscribed');
    expect(db.tables.campaignEnrollment).toEqual([
      expect.objectContaining({ leadId: again.id, status: 'Paused', nextActionDate: null }),
    ]);
    expect(db.tables.suppressedEmail).toEqual([{ email: 'jane@acme.com', reason: 'Unsubscribed', source: 'unsubscribe-link' }]);
  });

  it('keeps the ids of emailed leads deleted by selection or with their group', async () => {
    addLead('picked', 'picked@acme.com');
    emailed('picked');
    addLead('grouped', 'grouped@acme.com');
    emailed('grouped');
    db.tables.leadGroup.push({ id: 'g1', name: 'Group 1' });
    db.tables.leadGroupMembership.push({ leadId: 'grouped', groupId: 'g1' });

    expect((await deleteLeads(makeReq('DELETE', '/api/leads', { ids: ['picked'] }))).status).toBe(200);
    expect((await deleteGroup(makeReq('DELETE', '/api/leads/groups?id=g1&leadAction=DELETE'))).status).toBe(200);

    expect(db.tables.lead).toHaveLength(0);
    expect(db.tables.leadGroup).toHaveLength(0);
    expect(deletedIds()).toEqual([
      { id: 'picked', email: 'picked@acme.com' },
      { id: 'grouped', email: 'grouped@acme.com' },
    ]);
    expect((await unsubscribe(makeReq('GET', '/api/unsubscribe?id=grouped'))).status).toBe(200);
    expect(db.tables.suppressedEmail.map((row) => row.email)).toEqual(['grouped@acme.com']);
  });

  it('keeps nothing for a lead that was never emailed, whose id then finds no record', async () => {
    addLead('never', 'never@acme.com');

    expect((await deleteLeads(makeReq('DELETE', '/api/leads?id=never'))).status).toBe(200);

    expect(db.tables.deletedLead).toHaveLength(0);
    expect((await unsubscribe(makeReq('GET', '/api/unsubscribe?id=never'))).status).toBe(404);
    expect(db.tables.suppressedEmail).toHaveLength(0);
  });
});

describe('a lead update cannot lift a suppression (H18, H17)', () => {
  beforeEach(() => {
    addLead('opted-out', 'opted-out@acme.com', { status: 'Unsubscribed' });
    suppress('opted-out@acme.com', 'Unsubscribed');
    enroll('opted-out', 'cmp-unverified', 'Failed');
    // Bounced from before the suppression list existed, so not on it.
    addLead('marked', 'marked@acme.com', { status: 'Bounced', validationStatus: 'Invalid' });
    enroll('marked', 'cmp-unverified', 'Bounced');
    addLead('bounced', 'bounced@acme.com', { status: 'Bounced', validationStatus: 'Invalid' });
    suppress('bounced@acme.com', 'HardBounce', 'delivery-webhook');
    db.tables.leadGroupMembership.push({ leadId: 'opted-out', groupId: 'g1' }, { leadId: 'marked', groupId: 'g1' });
  });

  it('lets a status edit change only the CRM status of an unsubscribed lead, which stays suppressed and shows it', async () => {
    const res = await putLead(makeReq('PUT', '/api/leads', { id: 'opted-out', status: 'Not_Interested' }));

    expect(res.status).toBe(200);
    // The response carries the suppression, so the leads page keeps its Unsubscribed chip
    expect(await res.json()).toMatchObject({ status: 'Not_Interested', suppression: { reason: 'Unsubscribed' } });
    expect(leadById('opted-out')!.status).toBe('Not_Interested');
    expect(db.tables.suppressedEmail.map((row) => row.email)).toContain('opted-out@acme.com');
    expect(db.tables.campaignEnrollment.find((e) => e.leadId === 'opted-out')).toMatchObject({ status: 'Failed' });

    const leads = await (await getLeads(makeReq('GET', '/api/leads'))).json();
    expect(leads.find((l: any) => l.id === 'opted-out')).toMatchObject({ status: 'Not_Interested', suppression: { reason: 'Unsubscribed' } });
    expect(leads.find((l: any) => l.id === 'marked').suppression).toBeNull();
    const detail = await (await getLeads(makeReq('GET', '/api/leads?id=opted-out'))).json();
    expect(detail.suppression).toMatchObject({ reason: 'Unsubscribed', source: 'unsubscribe-link' });
  });

  it('never restarts enrollments on a status edit, even to Neutral', async () => {
    const res = await putLead(makeReq('PUT', '/api/leads', { groupId: 'g1', status: 'Neutral' }));

    expect(res.status).toBe(200);
    expect(leadById('opted-out')!.status).toBe('Neutral');
    expect(leadById('marked')!.status).toBe('Neutral');
    expect(db.tables.campaignEnrollment.map((e) => e.status)).toEqual(['Failed', 'Bounced']);
    expect(db.tables.suppressedEmail.map((row) => row.email)).toEqual(['opted-out@acme.com', 'bounced@acme.com']);
  });

  it.each([
    ['a single lead', { id: 'marked', status: 'Unsubscribed' }],
    ['a selection', { ids: ['marked'], status: 'Bounced' }],
    ['a group', { groupId: 'g1', status: 'Unsubscribed' }],
  ])('refuses Bounced or Unsubscribed as a status edit to %s, which only a bounce or unsubscribe sets', async (_label, body) => {
    const before = structuredClone(db.tables);

    const res = await putLead(makeReq('PUT', '/api/leads', body));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      'Field "status" must be one of Neutral, Interested, Not_Interested, Meeting_Booked, Out_of_Office.',
    );
    expect(db.tables).toEqual(before);
  });

  it('refuses Unsubscribed as the status of a new lead, so an opt-out never lives in the status alone', async () => {
    const before = structuredClone(db.tables);

    const res = await postLead(makeReq('POST', '/api/leads', { name: 'New', email: 'new@acme.com', status: 'Unsubscribed' }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('status must be one of Neutral, Interested, Not_Interested, Meeting_Booked, Out_of_Office.');
    expect(db.tables).toEqual(before);
  });

  it('refuses to set a hard-bounced address Valid with a 409 and writes nothing', async () => {
    const before = structuredClone(db.tables);

    const res = await putLead(makeReq('PUT', '/api/leads', { ids: ['bounced', 'marked'], validationStatus: 'Valid' }));

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(
      '1 of these 2 leads is on the suppression list (hard-bounced or failed verification): bounced@acme.com. ' +
      'A suppressed address stays Invalid and is never emailed again unless an admin removes it from the list, so nothing was updated.',
    );
    expect(db.tables).toEqual(before);
  });

  it('still restarts the enrollments of a lead set Valid that is not on the suppression list', async () => {
    const res = await putLead(makeReq('PUT', '/api/leads', { ids: ['marked'], status: 'Neutral', validationStatus: 'Valid' }));

    expect(res.status).toBe(200);
    expect(leadById('marked')).toMatchObject({ status: 'Neutral', validationStatus: 'Valid' });
    expect(db.tables.campaignEnrollment.find((e) => e.leadId === 'marked')).toMatchObject({ status: 'Active', currentSequenceStep: 1 });
  });

  it('allows an edit that keeps the suppressed status, without restarting its enrollments (M23)', async () => {
    const res = await putLead(makeReq('PUT', '/api/leads', { id: 'opted-out', validationStatus: 'Valid' }));

    expect(res.status).toBe(200);
    expect(leadById('opted-out')).toMatchObject({ status: 'Unsubscribed', validationStatus: 'Valid' });
    // Restarted, it would sit Active and queued forever: the send engine never mails it.
    expect(db.tables.campaignEnrollment.find((e) => e.leadId === 'opted-out')).toMatchObject({ status: 'Failed' });
  });
});

describe('verification (H18, M23)', () => {
  it('puts an address that fails verification on the suppression list', async () => {
    addLead('gone', 'someone@no-mx.test');
    enroll('gone', 'cmp-unverified');

    const res = await postVerify(makeReq('POST', '/api/leads/verify', { ids: ['gone'] }));

    expect(res.status).toBe(200);
    expect(leadById('gone')!.validationStatus).toBe('Invalid');
    expect(db.tables.suppressedEmail).toEqual([{ email: 'someone@no-mx.test', reason: 'Invalid', source: 'verification' }]);
  });

  it.each(['ETIMEOUT', 'ESERVFAIL'])('marks a lead Invalid on a failed %s lookup without suppressing it, so it can be re-activated', async (code) => {
    addLead('flaky', `someone@${code.toLowerCase()}.test`);
    enroll('flaky', 'cmp-unverified', 'Failed');

    const res = await postVerify(makeReq('POST', '/api/leads/verify', { ids: ['flaky'] }));

    expect(res.status).toBe(200);
    expect(leadById('flaky')!.validationStatus).toBe('Invalid');
    expect(db.tables.suppressedEmail).toHaveLength(0);

    const reactivated = await postReactivate(makeReq('POST', '/api/leads/reactivate', { ids: ['flaky'] }));
    expect(await reactivated.json()).toEqual({ reactivated: 1, unsubscribed: 0, suppressed: 0, notSuppressed: 0 });
    expect(leadById('flaky')).toMatchObject({ status: 'Neutral', validationStatus: 'Unverified' });
  });

  it.each([
    ['a failed verification', 'Invalid', {}],
    ['a hard bounce', 'HardBounce', { status: 'Bounced' }],
  ])('keeps a lead whose address is suppressed as %s Invalid when its domain now has an MX record', async (_label, reason, fields) => {
    addLead('listed', 'listed@acme.com', { validationStatus: 'Invalid', ...fields });
    suppress('listed@acme.com', reason, 'verification');

    const res = await postVerify(makeReq('POST', '/api/leads/verify', { ids: ['listed'] }));

    expect(res.status).toBe(200);
    expect(leadById('listed')!.validationStatus).toBe('Invalid');
    expect(db.tables.campaignEnrollment).toHaveLength(0);
    expect(db.tables.suppressedEmail).toEqual([{ email: 'listed@acme.com', reason, source: 'verification' }]);
  });

  it('enrolls a lead verified Valid in the Valid campaigns only when it may be emailed', async () => {
    addLead('fine', 'fine@acme.com');
    addLead('opted-out', 'opted-out@acme.com', { status: 'Unsubscribed' });
    addLead('listed', 'listed@acme.com'); // re-imported before the suppression was applied to its status
    suppress('listed@acme.com', 'Unsubscribed');

    const res = await postVerify(makeReq('POST', '/api/leads/verify', {}));

    expect(res.status).toBe(200);
    expect(db.tables.lead.map((l) => l.validationStatus)).toEqual(['Valid', 'Valid', 'Valid']);
    expect(enrolledIn('cmp-valid')).toEqual(['fine@acme.com']);
  });
});

describe('suppression list helpers', () => {
  it('stores addresses normalised, once, keeping the first reason recorded', async () => {
    expect(await suppressEmails(db.client as any, [
      { email: ' Jane@Acme.com ', reason: 'Invalid' },
      { email: 'jane@acme.com', reason: 'Unsubscribed' },
      { email: '   ', reason: 'Unsubscribed' },
    ], 'verification')).toBe(1);
    expect(await suppressEmails(db.client as any, [{ email: 'JANE@acme.com', reason: 'Unsubscribed' }], 'unsubscribe-link')).toBe(0);

    expect(db.tables.suppressedEmail).toEqual([{ email: 'jane@acme.com', reason: 'Invalid', source: 'verification' }]);
  });

  it('shows each reason on the lead, and refuses only validation changes that would make it look deliverable', () => {
    expect(suppressedLeadFields('Unsubscribed')).toEqual({ status: 'Unsubscribed' });
    expect(suppressedLeadFields('Complaint')).toEqual({ status: 'Unsubscribed' });
    expect(suppressedLeadFields('HardBounce')).toEqual({ status: 'Bounced', validationStatus: 'Invalid' });
    expect(suppressedLeadFields('Invalid')).toEqual({ validationStatus: 'Invalid' });

    expect(liftsSuppression({ validationStatus: 'Valid' }, 'Unsubscribed')).toBe(false);
    expect(liftsSuppression({ validationStatus: 'Valid' }, 'Complaint')).toBe(false);
    expect(liftsSuppression({ validationStatus: 'Valid' }, 'HardBounce')).toBe(true);
    expect(liftsSuppression({ validationStatus: 'Invalid' }, 'HardBounce')).toBe(false);
    expect(liftsSuppression({ validationStatus: 'Risky' }, 'Invalid')).toBe(true);
    expect(liftsSuppression({}, 'HardBounce')).toBe(false);
  });
});

describe('Re-activate on the Suppressed tab (M76)', () => {
  beforeEach(() => {
    addLead('opted-out', 'opted-out@acme.com', { status: 'Unsubscribed' });
    suppress('opted-out@acme.com', 'Unsubscribed');
    enroll('opted-out', 'cmp-unverified', 'Paused');
    addLead('complained', 'complained@acme.com', { status: 'Interested' });
    suppress('complained@acme.com', 'Complaint', 'delivery-webhook');
    addLead('legacy-unsub', 'legacy-unsub@acme.com', { status: 'Unsubscribed' });
    addLead('hard', 'hard@acme.com', { status: 'Bounced', validationStatus: 'Invalid' });
    suppress('hard@acme.com', 'HardBounce', 'send-engine');
    addLead('no-domain', 'someone@no-domain.test', { validationStatus: 'Invalid' });
    suppress('someone@no-domain.test', 'Invalid', 'verification');
    addLead('marked', 'marked@acme.com', { status: 'Bounced', validationStatus: 'Invalid' });
    enroll('marked', 'cmp-valid', 'Bounced');
    addLead('flaky', 'flaky@acme.com', { status: 'Interested', validationStatus: 'Invalid' });
    addLead('fine', 'fine@acme.com', { validationStatus: 'Valid' });
  });

  it('skips unsubscribed and listed addresses, moves the rest back to Unverified and restarts nothing', async () => {
    const listed = structuredClone(db.tables.suppressedEmail);
    const enrollments = structuredClone(db.tables.campaignEnrollment);
    const ids = db.tables.lead.map((l) => l.id);

    const res = await postReactivate(makeReq('POST', '/api/leads/reactivate', { ids }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reactivated: 2, unsubscribed: 3, suppressed: 2, notSuppressed: 1 });
    expect(db.tables.lead.map(({ id, status, validationStatus }) => ({ id, status, validationStatus }))).toEqual([
      { id: 'opted-out', status: 'Unsubscribed', validationStatus: 'Unverified' },
      { id: 'complained', status: 'Interested', validationStatus: 'Unverified' },
      { id: 'legacy-unsub', status: 'Unsubscribed', validationStatus: 'Unverified' },
      { id: 'hard', status: 'Bounced', validationStatus: 'Invalid' },
      { id: 'no-domain', status: 'Neutral', validationStatus: 'Invalid' },
      // Never set Valid: verified again first
      { id: 'marked', status: 'Neutral', validationStatus: 'Unverified' },
      { id: 'flaky', status: 'Interested', validationStatus: 'Unverified' },
      { id: 'fine', status: 'Neutral', validationStatus: 'Valid' },
    ]);
    expect(db.tables.suppressedEmail).toEqual(listed);
    expect(db.tables.campaignEnrollment).toEqual(enrollments);
  });

  it('leaves setting a lead Valid to verification, which keeps a hard-bounced address Invalid', async () => {
    await postReactivate(makeReq('POST', '/api/leads/reactivate', { ids: ['marked', 'hard'] }));
    expect(leadById('marked')!.validationStatus).toBe('Unverified');

    await postVerify(makeReq('POST', '/api/leads/verify', { ids: ['marked', 'hard'] }));

    expect(leadById('marked')!.validationStatus).toBe('Valid');
    expect(leadById('hard')!.validationStatus).toBe('Invalid');
    // Its old campaign sequence is not restarted, but campaigns may enroll it again
    expect(db.tables.campaignEnrollment.find((e) => e.leadId === 'marked')).toMatchObject({ campaignId: 'cmp-valid', status: 'Bounced' });
    const enrollable = await findEnrollable();
    expect(enrollable).toContain('marked');
    expect(enrollable).not.toContain('hard');
  });

  it.each([{}, { ids: [] }, { ids: 'marked' }, { ids: [{ not: 'x' }] }])('refuses %j', async (body) => {
    const res = await postReactivate(makeReq('POST', '/api/leads/reactivate', body));

    expect(res.status).toBe(400);
    expect(leadById('marked')!.status).toBe('Bounced');
  });
});

describe('removing an address from the suppression list (H17)', () => {
  const ADDED = new Date('2026-08-01T09:00:00Z');

  beforeEach(() => {
    addLead('opted-out', 'opted-out@acme.com', { status: 'Unsubscribed', validationStatus: 'Valid' });
    db.tables.suppressedEmail.push({ email: 'opted-out@acme.com', reason: 'Unsubscribed', source: 'unsubscribe-link', createdAt: ADDED });
    enroll('opted-out', 'cmp-valid', 'Paused');
    addLead('bounced', 'bounced@acme.com', { status: 'Interested', validationStatus: 'Invalid' });
    db.tables.suppressedEmail.push({ email: 'bounced@acme.com', reason: 'HardBounce', source: 'delivery-webhook', createdAt: ADDED });
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  it('refuses a non-admin with a 403 and changes nothing', async () => {
    vi.mocked(getSession).mockResolvedValue(USER as any);
    const before = structuredClone(db.tables);

    const res = await deleteSuppression(makeReq('DELETE', '/api/leads/suppression', { email: 'opted-out@acme.com' }));

    expect(res.status).toBe(403);
    expect(db.tables).toEqual(before);
  });

  it('removes an opt-out for an admin, puts the lead back to Neutral, leaves its enrollments and logs who did it', async () => {
    const res = await deleteSuppression(makeReq('DELETE', '/api/leads/suppression', { email: ' Opted-Out@Acme.com ' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true,
      removed: { reason: 'Unsubscribed', source: 'unsubscribe-link' },
      lead: { id: 'opted-out', status: 'Neutral', validationStatus: 'Valid', suppression: null },
    });
    expect(db.tables.suppressedEmail.map((row) => row.email)).toEqual(['bounced@acme.com']);
    expect(db.tables.campaignEnrollment).toEqual([expect.objectContaining({ leadId: 'opted-out', status: 'Paused' })]);
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining(
      'admin@example.com (admin-1) removed opted-out@acme.com from the suppression list (reason Unsubscribed, source unsubscribe-link',
    ));

    // A new Valid-cohort campaign may now enroll it
    expect(await findEnrollable()).toEqual(['opted-out']);
  });

  it('sends a hard-bounced lead back to Unverified, keeping its CRM status, so it is verified again', async () => {
    const res = await deleteSuppression(makeReq('DELETE', '/api/leads/suppression', { email: 'bounced@acme.com' }));

    expect(res.status).toBe(200);
    expect(leadById('bounced')).toMatchObject({ status: 'Interested', validationStatus: 'Unverified' });
    expect(db.tables.suppressedEmail.map((row) => row.email)).toEqual(['opted-out@acme.com']);

    await postVerify(makeReq('POST', '/api/leads/verify', { ids: ['bounced'] }));
    expect(leadById('bounced')!.validationStatus).toBe('Valid');
    expect(enrolledIn('cmp-valid')).toEqual(['opted-out@acme.com', 'bounced@acme.com']);
  });

  it.each([
    ['an address not on the list', { email: 'nobody@acme.com' }, 404],
    ['no address', {}, 400],
  ])('answers %s without writing', async (_label, body, status) => {
    const before = structuredClone(db.tables);

    const res = await deleteSuppression(makeReq('DELETE', '/api/leads/suppression', body));

    expect(res.status).toBe(status);
    expect(db.tables).toEqual(before);
  });
});

describe('Unibox status edits (H17)', () => {
  beforeEach(() => {
    addLead('opted-out', 'opted-out@acme.com', { status: 'Unsubscribed' });
    suppress('opted-out@acme.com', 'Unsubscribed');
    enroll('opted-out', 'cmp-unverified', 'Paused');
  });

  it('sets the CRM status of an unsubscribed lead without taking it off the suppression list', async () => {
    const res = await putUnibox(makeReq('PUT', '/api/unibox', { leadId: 'opted-out', leadStatus: 'Not_Interested' }));

    expect(res.status).toBe(200);
    expect(leadById('opted-out')!.status).toBe('Not_Interested');
    expect(db.tables.suppressedEmail).toEqual([{ email: 'opted-out@acme.com', reason: 'Unsubscribed', source: 'unsubscribe-link' }]);
    // Its status no longer says so, but the address still may not be enrolled
    expect(await findEnrollable()).toEqual([]);
  });

  it.each(['Unsubscribed', 'Bounced', 'Active', { set: 'Neutral' }])('refuses leadStatus %j and writes nothing', async (leadStatus) => {
    const before = structuredClone(db.tables);

    const res = await putUnibox(makeReq('PUT', '/api/unibox', { leadId: 'opted-out', leadStatus }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('leadStatus must be one of Neutral, Interested, Not_Interested, Meeting_Booked, Out_of_Office.');
    expect(db.tables).toEqual(before);
  });
});
