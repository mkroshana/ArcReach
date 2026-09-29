import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * In-memory leads and the rows that hang off them. The fake models evaluate the
 * where clauses the lead routes and lib/leadEmailMerge build (an insensitive
 * `in` compares lowercased values, as Postgres's lower(email) IN (lower(...))
 * does), enforce the schema's unique keys and cascade a lead delete, so the
 * tests check the rows really left behind.
 */
const fake = vi.hoisted(() => {
  type Row = Record<string, any>;
  const tables: Record<string, Row[]> = {
    lead: [], campaign: [], campaignEnrollment: [], emailDispatch: [], inboundResponse: [], leadGroupMembership: [], leadAlias: [],
    suppressedEmail: [],
  };
  const uniqueKeys: Record<string, string[][]> = {
    lead: [['id'], ['email']],
    campaignEnrollment: [['id'], ['leadId', 'campaignId']],
    leadGroupMembership: [['leadId', 'groupId']],
    leadAlias: [['id']],
    suppressedEmail: [['email']],
  };
  const leadChildren = ['campaignEnrollment', 'emailDispatch', 'inboundResponse', 'leadGroupMembership', 'leadAlias'];
  let seq = 0;

  function matches(row: Row, where: any): boolean {
    if (!where) return true;
    return Object.entries(where).every(([key, cond]: [string, any]) => {
      if (key === 'OR') return cond.some((w: any) => matches(row, w));
      if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
        const fold = (v: any) => (cond.mode === 'insensitive' && typeof v === 'string' ? v.toLowerCase() : v);
        if ('in' in cond) return cond.in.map(fold).includes(fold(row[key]));
        throw new Error(`Unsupported filter on ${key}: ${JSON.stringify(cond)}`);
      }
      return row[key] === cond;
    });
  }

  function clash(table: string, row: Row): boolean {
    return (uniqueKeys[table] || []).some((key) =>
      tables[table].some((other) => other !== row && key.every((k) => other[k] === row[k])));
  }

  function insert(table: string, data: Row, skipDuplicates = false): Row | null {
    const row = { ...data };
    if (uniqueKeys[table]?.[0]?.[0] === 'id' && row.id === undefined) row.id = `${table}-auto-${++seq}`;
    tables[table].push(row);
    if (clash(table, row)) {
      tables[table].pop();
      if (skipDuplicates) return null;
      throw new Error(`Unique constraint failed on ${table}`);
    }
    return row;
  }

  function write(table: string, rows: Row[], data: Row) {
    const before = rows.map((r) => ({ ...r }));
    rows.forEach((r) => Object.assign(r, data));
    if (rows.some((r) => clash(table, r))) {
      rows.forEach((r, i) => Object.assign(r, before[i]));
      throw new Error(`Unique constraint failed on ${table}`);
    }
  }

  function model(table: string) {
    return {
      findMany: async (args: any = {}) => tables[table].filter((r) => matches(r, args.where)).map((r) => ({ ...r })),
      findFirst: async (args: any = {}) => {
        const row = tables[table].find((r) => matches(r, args.where));
        return row ? { ...row } : null;
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
        const row = tables[table].find((r) => matches(r, where));
        if (!row) throw new Error(`No ${table} row to update`);
        write(table, [row], data);
        return { ...row };
      },
      updateMany: async ({ where, data }: any) => {
        const rows = tables[table].filter((r) => matches(r, where));
        write(table, rows, data);
        return { count: rows.length };
      },
      deleteMany: async ({ where }: any) => {
        const gone = tables[table].filter((r) => matches(r, where));
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

  return {
    client,
    tables,
    reset() {
      for (const table of Object.keys(tables)) tables[table] = [];
      seq = 0;
    },
  };
});

vi.mock('../../lib/db', () => ({ prisma: fake.client }));

vi.mock('../../lib/session', () => ({
  getSession: vi.fn(),
}));

import { getSession } from '../../lib/session';
import { leadEmailIn, normalizeEmail } from '../../lib/leadEmail';
import {
  LEAD_STATUS_ORDER,
  VALIDATION_STATUS_ORDER,
  type LeadEmailRow,
  mergeLeadGroup,
  mostRestrictive,
  planLeadEmails,
  resolveEnrollments,
} from '../../lib/leadEmailMerge';
import { SEND_CLAIM_TTL_MS } from '../../lib/sendEligibility';
import { POST as postLead } from '../../app/api/leads/route';
import { POST as postBulk } from '../../app/api/leads/bulk/route';

const USER = { id: 'user-1', name: 'User', email: 'user@example.com', role: 'USER' as const };

function makeReq(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function leadRow(fields: Partial<LeadEmailRow> & { id: string; email: string }): LeadEmailRow {
  return {
    name: null, company: null, jobTitle: null, status: 'Neutral', validationStatus: 'Unverified',
    isArchived: false, customVariables: null, history: 0, ...fields,
  };
}

function storedLead(fields: Record<string, any>) {
  return {
    name: null, company: null, jobTitle: null, status: 'Neutral', validationStatus: 'Unverified',
    isArchived: false, customVariables: null, ...fields,
  };
}

beforeEach(() => {
  fake.reset();
  vi.mocked(getSession).mockResolvedValue(USER as any);
});

describe('normalizeEmail and leadEmailIn', () => {
  it('trims and lowercases an address, and gives an empty string for anything else', () => {
    expect(normalizeEmail('  John.Smith@Acme.COM \t')).toBe('john.smith@acme.com');
    expect(normalizeEmail('jane@acme.com')).toBe('jane@acme.com');
    expect(normalizeEmail('   ')).toBe('');
    expect(normalizeEmail(undefined)).toBe('');
    expect(normalizeEmail(42)).toBe('');
  });

  it('matches with an insensitive `in` of the distinct normalised addresses, never an ILIKE equals', () => {
    expect(leadEmailIn(['John_Smith@Acme.com', ' john_smith@acme.com ', '', 'Jane@Acme.com'])).toEqual({
      email: { in: ['john_smith@acme.com', 'jane@acme.com'], mode: 'insensitive' },
    });
  });
});

describe('POST /api/leads', () => {
  it('stores the email trimmed and lowercased', async () => {
    const res = await postLead(makeReq('/api/leads', { name: 'Jane', email: '  Jane.Doe@Acme.COM ' }));
    expect(res.status).toBe(200);
    expect((await res.json()).email).toBe('jane.doe@acme.com');
    expect(fake.tables.lead.map((l) => l.email)).toEqual(['jane.doe@acme.com']);
  });

  it('refuses a case variant of a lead stored before emails were normalised', async () => {
    fake.tables.lead.push(storedLead({ id: 'lead-1', email: 'Jane.Doe@Acme.com' }));

    const res = await postLead(makeReq('/api/leads', { name: 'Jane', email: 'jane.doe@acme.com' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Lead with this email address already exists.');
    expect(fake.tables.lead).toHaveLength(1);
  });

  it('refuses an email that is blank once trimmed', async () => {
    const res = await postLead(makeReq('/api/leads', { name: 'Jane', email: '   ' }));
    expect(res.status).toBe(400);
    expect(fake.tables.lead).toHaveLength(0);
  });
});

describe('POST /api/leads/bulk', () => {
  it('creates each address once, lowercased, skipping case variants in the batch and in the database', async () => {
    fake.tables.lead.push(storedLead({ id: 'lead-1', email: 'John.Smith@Acme.com' }));

    const res = await postBulk(makeReq('/api/leads/bulk', {
      leads: [
        { email: 'JOHN.SMITH@acme.com', name: 'John' },
        { email: 'Jane@Acme.com', name: 'Jane First' },
        { email: ' jane@acme.com ', name: 'Jane Second' },
        { email: 'New_User@Example.com', name: 'New' },
        { email: '   ', name: 'Blank' },
      ],
      groupIds: ['group-1'],
    }));

    expect(res.status).toBe(200);
    expect((await res.json()).count).toBe(2);
    expect(fake.tables.lead.map((l) => [l.email, l.name])).toEqual([
      ['John.Smith@Acme.com', null],
      ['jane@acme.com', 'Jane First'],
      ['new_user@example.com', 'New'],
    ]);
    const created = fake.tables.lead.slice(1).map((l) => l.id);
    expect(fake.tables.leadGroupMembership.map((m) => m.leadId)).toEqual(created);
  });

  it('refuses a batch with no usable address', async () => {
    const res = await postBulk(makeReq('/api/leads/bulk', { leads: [{ email: '  ' }, { name: 'No email' }] }));
    expect(res.status).toBe(400);
  });
});

describe('merge rules', () => {
  it('ranks unsubscribe above bounce above the CRM statuses, and Invalid validation highest', () => {
    expect(mostRestrictive(LEAD_STATUS_ORDER, ['Interested', 'Unsubscribed', 'Bounced'])).toBe('Unsubscribed');
    expect(mostRestrictive(LEAD_STATUS_ORDER, ['Meeting_Booked', 'Not_Interested', 'Neutral'])).toBe('Not_Interested');
    expect(mostRestrictive(LEAD_STATUS_ORDER, ['Neutral', 'Out_of_Office'])).toBe('Out_of_Office');
    expect(mostRestrictive(VALIDATION_STATUS_ORDER, ['Valid', 'Risky', 'Unverified'])).toBe('Risky');
    expect(mostRestrictive(VALIDATION_STATUS_ORDER, ['Invalid', 'Valid'])).toBe('Invalid');
  });

  it('plans a merge per case-variant group, a rename for a lone mixed-case row, and leaves the rest alone', () => {
    const { plans, blank } = planLeadEmails([
      leadRow({ id: 'a', email: 'Jane@Acme.com', status: 'Interested', validationStatus: 'Valid', history: 9, name: 'Jane', company: 'Acme' }),
      leadRow({ id: 'b', email: 'jane@acme.com', status: 'Unsubscribed', validationStatus: 'Valid', history: 1, isArchived: true }),
      leadRow({ id: 'c', email: 'Solo@Example.com' }),
      leadRow({ id: 'd', email: 'ok@example.com' }),
      leadRow({ id: 'e', email: '   ' }),
      leadRow({ id: 'f', email: 'Bob@X.com', history: 1, customVariables: { tier: 'gold' } }),
      leadRow({ id: 'g', email: ' BOB@x.com', history: 4, validationStatus: 'Risky', isArchived: true }),
      leadRow({ id: 'h', email: 'bob@X.COM', history: 4, isArchived: true }),
    ]);

    expect(blank.map((r) => r.id)).toEqual(['e']);
    expect(plans.map((p) => [p.email, p.keep.id, p.duplicates.map((d) => d.id)])).toEqual([
      // The row already stored normalised is kept even with less history.
      ['jane@acme.com', 'b', ['a']],
      ['solo@example.com', 'c', []],
      // Otherwise the most history, then the lowest id.
      ['bob@x.com', 'g', ['h', 'f']],
    ]);

    expect(plans[0].data).toEqual({
      email: 'jane@acme.com', status: 'Unsubscribed', validationStatus: 'Valid',
      isArchived: false, name: 'Jane', company: 'Acme', jobTitle: null,
    });
    expect(plans[1].data).toMatchObject({ email: 'solo@example.com', status: 'Neutral' });
    expect(plans[2].data).toMatchObject({
      email: 'bob@x.com', validationStatus: 'Risky', isArchived: false, customVariables: { tier: 'gold' },
    });
  });

  it('keeps one enrollment per campaign: a stopped one first, else the one further along, at the furthest step', () => {
    const e = (id: string, leadId: string, campaignId: string, status: string, currentSequenceStep: number) =>
      ({ id, leadId, campaignId, status, currentSequenceStep });

    const resolution = resolveEnrollments('keep', [
      e('k1', 'keep', 'cmp-1', 'Active', 1), e('d1', 'dup', 'cmp-1', 'Active', 3),
      e('k2', 'keep', 'cmp-2', 'Active', 3), e('d2', 'dup', 'cmp-2', 'Paused', 1),
      e('d3', 'dup', 'cmp-3', 'Active', 2),
      e('k4', 'keep', 'cmp-4', 'Active', 1),
      e('k5', 'keep', 'cmp-5', 'Completed', 2), e('d5', 'dup', 'cmp-5', 'Completed', 2),
    ]);

    expect(resolution.deleteIds.sort()).toEqual(['d5', 'k1', 'k2']);
    expect(resolution.moveIds.sort()).toEqual(['d1', 'd2', 'd3']);
    expect(resolution.stepUpdates).toEqual([{ id: 'd2', currentSequenceStep: 3 }]);
  });
});

describe('mergeLeadGroup', () => {
  function seedCaseVariants(dupStatus = 'Unsubscribed') {
    fake.tables.lead.push(
      storedLead({ id: 'keep', email: 'jane@acme.com', status: 'Neutral', validationStatus: 'Valid', name: 'Jane' }),
      storedLead({ id: 'dup', email: 'Jane@Acme.com', status: dupStatus, validationStatus: 'Valid', company: 'Acme' }),
    );
    fake.tables.campaignEnrollment.push(
      { id: 'enr-k1', leadId: 'keep', campaignId: 'cmp-1', status: 'Active', currentSequenceStep: 1, claimedAt: null },
      { id: 'enr-d1', leadId: 'dup', campaignId: 'cmp-1', status: 'Active', currentSequenceStep: 3, claimedAt: null },
      { id: 'enr-d2', leadId: 'dup', campaignId: 'cmp-2', status: 'Paused', currentSequenceStep: 2, claimedAt: null },
    );
    fake.tables.emailDispatch.push({ id: 'dsp-1', leadId: 'keep' }, { id: 'dsp-2', leadId: 'dup' }, { id: 'dsp-3', leadId: 'dup' });
    fake.tables.inboundResponse.push({ id: 'rep-1', leadId: 'dup' });
    fake.tables.leadGroupMembership.push(
      { leadId: 'keep', groupId: 'g1' }, { leadId: 'dup', groupId: 'g1' }, { leadId: 'dup', groupId: 'g2' },
    );
    // An id merged into `dup` by an earlier run.
    fake.tables.leadAlias.push({ id: 'older', leadId: 'dup' });

    const { plans } = planLeadEmails(fake.tables.lead.map((l) => leadRow({ ...l, history: 0 } as any)));
    expect(plans).toHaveLength(1);
    return plans[0];
  }

  it('moves every enrollment, dispatch, reply, membership and alias to the kept lead and deletes the duplicate', async () => {
    const plan = seedCaseVariants();

    await mergeLeadGroup(fake.client as any, plan);

    expect(fake.tables.lead).toEqual([
      storedLead({ id: 'keep', email: 'jane@acme.com', status: 'Unsubscribed', validationStatus: 'Valid', name: 'Jane', company: 'Acme' }),
    ]);
    expect(fake.tables.campaignEnrollment.map((e) => [e.id, e.leadId, e.currentSequenceStep])).toEqual([
      ['enr-d1', 'keep', 3],
      ['enr-d2', 'keep', 2],
    ]);
    expect(fake.tables.emailDispatch.every((d) => d.leadId === 'keep')).toBe(true);
    expect(fake.tables.inboundResponse).toEqual([{ id: 'rep-1', leadId: 'keep' }]);
    expect(fake.tables.leadGroupMembership.map((m) => m.groupId).sort()).toEqual(['g1', 'g2']);
    expect(fake.tables.leadGroupMembership.every((m) => m.leadId === 'keep')).toBe(true);
    expect(fake.tables.leadAlias.map((a) => [a.id, a.leadId]).sort()).toEqual([['dup', 'keep'], ['older', 'keep']]);
  });

  it('changes nothing when another case variant appeared since the plan was made', async () => {
    const plan = seedCaseVariants();
    fake.tables.lead.push(storedLead({ id: 'late', email: 'JANE@acme.com' }));

    await expect(mergeLeadGroup(fake.client as any, plan)).rejects.toThrow(/changed since they were read/);
    expect(fake.tables.lead).toHaveLength(3);
    expect(fake.tables.emailDispatch.filter((d) => d.leadId === 'dup')).toHaveLength(2);
  });

  /** The fake client, with `change` applied right after the merge reads `table`, as a write from another request landing mid-merge would be. */
  function changeAfterRead(table: string, change: () => void) {
    const model = fake.client[table];
    return {
      ...fake.client,
      [table]: {
        ...model,
        findMany: async (args: any) => {
          const rows = await model.findMany(args);
          change();
          return rows;
        },
      },
    };
  }

  const leadChanges: [string, string, Record<string, string>][] = [
    ['the kept lead unsubscribes', 'keep', { status: 'Unsubscribed' }],
    ['a duplicate bounces', 'dup', { status: 'Bounced', validationStatus: 'Invalid' }],
  ];

  it.each(leadChanges)('refuses a plan made before %s, leaving that status in place', async (_, id, change) => {
    const plan = seedCaseVariants('Neutral');
    expect(plan.data).toMatchObject({ status: 'Neutral', validationStatus: 'Valid' });
    Object.assign(fake.tables.lead.find((l) => l.id === id)!, change);

    await expect(mergeLeadGroup(fake.client as any, plan)).rejects.toThrow(/changed since they were read/);
    expect(fake.tables.lead.map((l) => l.id)).toEqual(['keep', 'dup']);
    expect(fake.tables.lead.find((l) => l.id === id)).toMatchObject(change);
    expect(fake.tables.campaignEnrollment.find((e) => e.id === 'enr-d1')).toMatchObject({ leadId: 'dup', status: 'Active' });
  });

  it('refuses before writing anything when the kept lead unsubscribes after the merge read it', async () => {
    const plan = seedCaseVariants('Neutral');
    const tx = changeAfterRead('lead', () => { fake.tables.lead.find((l) => l.id === 'keep')!.status = 'Unsubscribed'; });

    await expect(mergeLeadGroup(tx as any, plan)).rejects.toThrow(/changed since they were read/);
    expect(fake.tables.lead.map((l) => [l.id, l.email, l.status])).toEqual([
      ['keep', 'jane@acme.com', 'Unsubscribed'],
      ['dup', 'Jane@Acme.com', 'Neutral'],
    ]);
    expect(fake.tables.campaignEnrollment.map((e) => [e.id, e.leadId])).toEqual([
      ['enr-k1', 'keep'], ['enr-d1', 'dup'], ['enr-d2', 'dup'],
    ]);
  });

  it('refuses to delete a duplicate that bounces after the merge read it, so the transaction rolls back', async () => {
    const plan = seedCaseVariants('Neutral');
    const tx = changeAfterRead('lead', () => {
      Object.assign(fake.tables.lead.find((l) => l.id === 'dup')!, { status: 'Bounced', validationStatus: 'Invalid' });
    });

    // The fake has no rollback, so only the refused delete is checked here; Prisma rolls back the earlier writes.
    await expect(mergeLeadGroup(tx as any, plan)).rejects.toThrow(/changed since they were read/);
    expect(fake.tables.lead.find((l) => l.id === 'dup')).toMatchObject({ status: 'Bounced', validationStatus: 'Invalid' });
  });

  it('refuses when an enrollment it read is paused before the merge writes it', async () => {
    const plan = seedCaseVariants('Neutral');
    // enr-k1 would be dropped for enr-d1, which is further along in the same campaign, while both are Active.
    const tx = changeAfterRead('campaignEnrollment', () => {
      fake.tables.campaignEnrollment.find((e) => e.id === 'enr-k1')!.status = 'Paused';
    });

    await expect(mergeLeadGroup(tx as any, plan)).rejects.toThrow(/changed since they were read/);
    expect(fake.tables.campaignEnrollment.find((e) => e.id === 'enr-k1')).toMatchObject({ leadId: 'keep', status: 'Paused' });
    expect(fake.tables.lead).toHaveLength(2);
  });

  it('refuses while a send holds a live claim, and goes ahead once the claim is stale', async () => {
    const plan = seedCaseVariants();
    const now = new Date('2026-09-29T12:00:00Z');
    const claimed = fake.tables.campaignEnrollment.find((e) => e.id === 'enr-d1')!;

    claimed.claimedAt = new Date(now.getTime() - 60_000);
    await expect(mergeLeadGroup(fake.client as any, plan, now)).rejects.toThrow(/send is in progress/);
    expect(fake.tables.lead).toHaveLength(2);

    claimed.claimedAt = new Date(now.getTime() - SEND_CLAIM_TTL_MS - 1);
    await mergeLeadGroup(fake.client as any, plan, now);
    expect(fake.tables.lead.map((l) => l.id)).toEqual(['keep']);
  });
});
