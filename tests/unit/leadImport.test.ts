import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * In-memory leads, groups, campaigns, enrollments and the suppression list.
 * The fake models evaluate the where clauses the Add Lead and import routes
 * build (throwing on filters they don't model) and enforce the unique keys. An
 * interactive transaction puts every table back when its callback throws, as
 * Postgres rolls one back, and `failures` makes the next call of a model
 * method throw, so the tests check the rows really left behind.
 */
const db = vi.hoisted(() => {
  type Row = Record<string, any>;
  const tables: Record<string, Row[]> = {
    lead: [], leadGroup: [], leadGroupMembership: [], campaign: [], campaignEnrollment: [], suppressedEmail: [],
  };
  const uniqueKeys: Record<string, string[]> = {
    lead: ['email'],
    leadGroupMembership: ['leadId', 'groupId'],
    campaignEnrollment: ['leadId', 'campaignId'],
    suppressedEmail: ['email'],
  };
  const withoutId = ['leadGroupMembership', 'suppressedEmail'];
  const failures: Record<string, Error> = {};
  let seq = 0;

  function matchesValue(value: any, cond: any): boolean {
    if (cond === null || typeof cond !== 'object') return value === cond;
    const fold = (v: any) => (cond.mode === 'insensitive' && typeof v === 'string' ? v.toLowerCase() : v);
    if ('in' in cond) return cond.in.map(fold).includes(fold(value));
    if ('notIn' in cond) return !cond.notIn.includes(value);
    throw new Error(`Unmodelled filter: ${JSON.stringify(cond)}`);
  }

  function matches(row: Row, where: Row | undefined): boolean {
    if (!where) return true;
    return Object.entries(where).every(([key, cond]: [string, any]) =>
      key === 'AND' ? cond.every((w: Row) => matches(row, w)) : matchesValue(row[key], cond));
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
    const method = (name: string, run: (args: any) => unknown) => async (args: any = {}) => {
      const failure = failures[`${table}.${name}`];
      if (failure) {
        delete failures[`${table}.${name}`];
        throw failure;
      }
      return run(args);
    };
    return {
      findMany: method('findMany', (args) => tables[table].filter((r) => matches(r, args.where)).map((r) => ({ ...r }))),
      findFirst: method('findFirst', (args) => {
        const row = tables[table].find((r) => matches(r, args.where));
        return row ? { ...row } : null;
      }),
      create: method('create', ({ data }) => {
        const { groups, ...fields } = data;
        const row = insert(table, fields)!;
        for (const g of groups?.create || []) insert('leadGroupMembership', { leadId: row.id, groupId: g.groupId });
        return { ...row, groups: [] };
      }),
      createMany: method('createMany', ({ data, skipDuplicates }) => ({
        count: data.filter((d: Row) => insert(table, d, skipDuplicates)).length,
      })),
    };
  }

  const client: Record<string, any> = {};
  for (const table of Object.keys(tables)) client[table] = model(table);
  client.$transaction = async (fn: (tx: any) => Promise<unknown>) => {
    const snapshot = Object.fromEntries(Object.entries(tables).map(([t, rows]) => [t, rows.map((r) => ({ ...r }))]));
    try {
      return await fn(client);
    } catch (err) {
      Object.assign(tables, snapshot);
      throw err;
    }
  };

  return {
    client,
    tables,
    failures,
    reset() {
      for (const table of Object.keys(tables)) tables[table] = [];
      for (const key of Object.keys(failures)) delete failures[key];
      seq = 0;
    },
  };
});

vi.mock('../../lib/db', () => ({ prisma: db.client }));

vi.mock('../../lib/session', () => ({
  getSession: vi.fn(),
}));

import { getSession } from '../../lib/session';
import { parseLeadEmail } from '../../lib/leadEmail';
import { LEAD_IMPORT_BATCH_SIZE, countLeadImport, describeLeadImport, emptyLeadImportCounts } from '../../lib/leadImport';
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

const emails = () => db.tables.lead.map((l) => l.email);
const enrolled = () => db.tables.campaignEnrollment.map((e) => db.tables.lead.find((l) => l.id === e.leadId)?.email);

beforeEach(() => {
  db.reset();
  vi.mocked(getSession).mockResolvedValue(USER as any);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.tables.campaign.push({ id: 'cmp-unverified', audienceCohort: 'Unverified', status: 'Active' });
  db.tables.leadGroup.push({ id: 'group-1', name: 'June Leads' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseLeadEmail', () => {
  it('accepts one plain address and gives its stored form', () => {
    expect(parseLeadEmail('  Jane.Doe@Acme.COM ')).toBe('jane.doe@acme.com');
    expect(parseLeadEmail("o'brien@acme.ie")).toBe("o'brien@acme.ie");
    expect(parseLeadEmail('jane+tag@mail.acme.co.uk')).toBe('jane+tag@mail.acme.co.uk');
    expect(parseLeadEmail('first_last-1@sub-domain.example.org')).toBe('first_last-1@sub-domain.example.org');
    expect(parseLeadEmail('info@xn--mller-kva.de')).toBe('info@xn--mller-kva.de');
    expect(parseLeadEmail(`${'a'.repeat(64)}@acme.com`)).toBe(`${'a'.repeat(64)}@acme.com`);
  });

  it.each([
    ['a display name', 'John <john@acme.com>'],
    ['a semicolon list', 'a@x.com; b@x.com'],
    ['a comma list', 'a@x.com,b@x.com'],
    ['a semicolon-delimited row', 'john@acme.com;John;Acme'],
    ['a mailto link', 'mailto:jane@acme.com'],
    ['a space in the address', 'jane doe@acme.com'],
    ['a quoted local part', '"jane doe"@acme.com'],
    ['a leading dot', '.jane@acme.com'],
    ['a trailing dot before the @', 'jane.@acme.com'],
    ['a doubled dot', 'jane..doe@acme.com'],
    ['no domain dot', 'jane@acme'],
    ['a one-letter top-level domain', 'jane@acme.c'],
    ['an IPv4 address', 'jane@192.168.0.1'],
    ['a domain literal', 'jane@[192.168.0.1]'],
    ['a label starting with a hyphen', 'jane@-acme.com'],
    ['a label ending with a hyphen', 'jane@acme-.com'],
    ['an empty label', 'jane@acme..com'],
    ['a trailing dot', 'jane@acme.com.'],
    ['a non-ASCII local part', 'josé@acme.com'],
    ['a non-ASCII domain', 'info@müller.de'],
    ['no local part', '@acme.com'],
    ['no domain', 'jane@'],
    ['no @', 'jane.acme.com'],
    ['a local part over 64 characters', `${'a'.repeat(65)}@acme.com`],
    ['an address over 254 characters', `jane@${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.com`],
  ])('refuses %s', (_, value) => {
    expect(parseLeadEmail(value)).toBeNull();
  });

  it('refuses blanks and anything that is not text', () => {
    expect(parseLeadEmail('   ')).toBeNull();
    expect(parseLeadEmail(undefined)).toBeNull();
    expect(parseLeadEmail(null)).toBeNull();
    expect(parseLeadEmail(42)).toBeNull();
    expect(parseLeadEmail(['jane@acme.com'])).toBeNull();
  });
});

describe('describeLeadImport', () => {
  const totals = (fields: Partial<ReturnType<typeof emptyLeadImportCounts> & { blank: number; failed: number }>) =>
    ({ ...emptyLeadImportCounts(), blank: 0, failed: 0, ...fields });

  it('counts the outcomes the server reports for each row', () => {
    expect(countLeadImport(['created', 'invalid', 'created', 'existing', 'suppressed', 'duplicate'])).toEqual({
      created: 2, suppressed: 1, existing: 1, duplicate: 1, invalid: 1,
    });
  });

  it('says how many leads were imported when every row was', () => {
    expect(describeLeadImport(totals({ created: 1 }))).toBe('Imported 1 new lead.');
    expect(describeLeadImport(totals({ created: 4000 }))).toBe('Imported 4000 new leads.');
  });

  it('counts suppressed leads among the new ones and names every row skipped', () => {
    expect(describeLeadImport(totals({ created: 5, suppressed: 2, existing: 3, duplicate: 1, invalid: 4, blank: 2 }))).toBe(
      'Imported 7 new leads, 2 of them on the suppression list (unsubscribed, bounced or invalid) and never emailed. ' +
      "Skipped 3 already in the CRM, 1 repeating an earlier row's address, 4 with an email that is not one valid address, 2 with no email.",
    );
    expect(describeLeadImport(totals({ existing: 12 }))).toBe('No new leads were imported. Skipped 12 already in the CRM.');
  });

  it('reports rows of failed batches with the error and never as imported', () => {
    expect(describeLeadImport(totals({ created: 4000, failed: 1000 }), 'the server answered 500')).toBe(
      'Imported 4000 new leads. 1000 rows could not be imported (the server answered 500). ' +
      'The file is still loaded, so Confirm & Import again to retry them.',
    );
    expect(describeLeadImport(totals({ failed: 1 }))).toBe(
      'No new leads were imported. 1 row could not be imported. The file is still loaded, so Confirm & Import again to retry them.',
    );
  });
});

describe('POST /api/leads/bulk (M62, M63)', () => {
  it('refuses rows whose email is not one plain address, imports the rest and reports each row in order', async () => {
    const res = await postBulk(makeReq('/api/leads/bulk', {
      leads: [
        { email: 'John <john@acme.com>', name: 'John' },
        { email: 'a@x.com; b@x.com' },
        { email: ' Jane@Acme.com ', name: 'Jane' },
        { email: 'bob@acme.com;Bob;Acme' },
        { email: 'jane@acme.com', name: 'Jane Again' },
        { name: 'No email' },
      ],
      groupIds: ['group-1'],
    }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      counts: { created: 1, suppressed: 0, existing: 0, duplicate: 1, invalid: 4 },
      outcomes: ['invalid', 'invalid', 'created', 'invalid', 'duplicate', 'invalid'],
    });
    expect(db.tables.lead.map((l) => [l.email, l.name])).toEqual([['jane@acme.com', 'Jane']]);
    expect(db.tables.leadGroupMembership).toEqual([{ leadId: db.tables.lead[0].id, groupId: 'group-1' }]);
    expect(enrolled()).toEqual(['jane@acme.com']);
  });

  it('reports addresses already in the CRM and on the suppression list apart from the new leads', async () => {
    db.tables.lead.push({ id: 'old', email: 'old@acme.com', status: 'Neutral', validationStatus: 'Valid', isArchived: false });
    db.tables.suppressedEmail.push({ email: 'gone@acme.com', reason: 'Unsubscribed', source: 'unsubscribe-link' });

    const res = await postBulk(makeReq('/api/leads/bulk', {
      leads: [{ email: 'Old@Acme.com' }, { email: 'gone@acme.com' }, { email: 'new@acme.com' }],
    }));

    expect(await res.json()).toMatchObject({
      counts: { created: 1, suppressed: 1, existing: 1, duplicate: 0, invalid: 0 },
      outcomes: ['existing', 'suppressed', 'created'],
    });
    expect(emails()).toEqual(['old@acme.com', 'gone@acme.com', 'new@acme.com']);
    expect(enrolled()).toEqual(['new@acme.com']);
  });

  it('imports none of a batch whose write fails, so every row the page reports as failed really is missing', async () => {
    db.failures['leadGroupMembership.createMany'] = new Error('connection reset');

    const res = await postBulk(makeReq('/api/leads/bulk', {
      leads: [{ email: 'jane@acme.com' }, { email: 'bob@acme.com' }],
      groupIds: ['group-1'],
    }));

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('connection reset');
    expect(db.tables.lead).toHaveLength(0);
    expect(db.tables.campaignEnrollment).toHaveLength(0);

    // Sent again, the same rows import and join the group
    const retry = await postBulk(makeReq('/api/leads/bulk', {
      leads: [{ email: 'jane@acme.com' }, { email: 'bob@acme.com' }],
      groupIds: ['group-1'],
    }));
    expect((await retry.json()).outcomes).toEqual(['created', 'created']);
    expect(db.tables.leadGroupMembership).toHaveLength(2);
  });

  it.each([
    ['a body that is not an object', [{ email: 'jane@acme.com' }], 'Request body must be a JSON object.'],
    ['no leads', { leads: [] }, 'Leads array is required.'],
    ['a row that is not an object', { leads: [{ email: 'jane@acme.com' }, 'bob@acme.com'] },
      'Lead 2 must be an object whose name, company and jobTitle are text or null.'],
    ['a name that is not text', { leads: [{ email: 'jane@acme.com', name: { set: 'Jane' } }] },
      'Lead 1 must be an object whose name, company and jobTitle are text or null.'],
    ['groupIds that are not an array', { leads: [{ email: 'jane@acme.com' }], groupIds: 'group-1' },
      'groupIds must be an array of lead group IDs.'],
    ['a group that does not exist', { leads: [{ email: 'jane@acme.com' }], groupIds: ['group-1', 'deleted-group'] },
      'The lead group to import into does not exist.'],
  ])('refuses %s with a 400 and writes nothing', async (_, body, error) => {
    const res = await postBulk(makeReq('/api/leads/bulk', body));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(error);
    expect(db.tables.lead).toHaveLength(0);
    expect(db.tables.leadGroupMembership).toHaveLength(0);
  });

  it(`refuses more than ${LEAD_IMPORT_BATCH_SIZE} rows in one request`, async () => {
    const leads = Array.from({ length: LEAD_IMPORT_BATCH_SIZE + 1 }, (_, i) => ({ email: `lead${i}@acme.com` }));

    const res = await postBulk(makeReq('/api/leads/bulk', { leads }));

    expect(res.status).toBe(400);
    expect(db.tables.lead).toHaveLength(0);
  });
});

describe('POST /api/leads (Add Lead)', () => {
  it.each(['John <john@acme.com>', 'a@x.com; b@x.com', 'jane@acme', 'josé@acme.com'])(
    'refuses %s as the email and writes nothing',
    async (email) => {
      const res = await postLead(makeReq('/api/leads', { name: 'Jane', email }));

      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('Email address must be one valid address, like name@example.com.');
      expect(db.tables.lead).toHaveLength(0);
    },
  );

  it('still asks for an email when it is missing or blank', async () => {
    const res = await postLead(makeReq('/api/leads', { name: 'Jane', email: '  ' }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Email address is required.');
  });

  it.each([
    ['a name that is not text', { name: 42 }, 'name must be text or null.'],
    ['a company that is an object', { company: { set: 'Acme' } }, 'company must be text or null.'],
    ['a status that is not one of the CRM statuses', { status: ['Neutral'] },
      'status must be one of Neutral, Interested, Not_Interested, Meeting_Booked, Out_of_Office.'],
    ['an unknown validation status', { validationStatus: 'Deliverable' },
      'validationStatus must be one of Valid, Invalid, Risky, Unverified.'],
    ['groupIds that are not an array of ids', { groupIds: 'group-1' }, 'groupIds must be an array of lead group IDs.'],
    ['groupIds holding a non-id', { groupIds: [{ connect: { id: 'group-1' } }] }, 'groupIds must be an array of lead group IDs.'],
  ])('refuses %s with a 400 and writes nothing', async (_, fields, error) => {
    const res = await postLead(makeReq('/api/leads', { name: 'Jane', email: 'jane@acme.com', ...fields }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(error);
    expect(db.tables.lead).toHaveLength(0);
    expect(db.tables.leadGroupMembership).toHaveLength(0);
  });

  it('creates a lead from checked fields, in its group and enrolled', async () => {
    const res = await postLead(makeReq('/api/leads', {
      name: 'Jane', email: ' Jane@Acme.com ', company: null, jobTitle: 'CEO', status: 'Neutral',
      validationStatus: 'Unverified', groupIds: ['group-1'],
    }));

    expect(res.status).toBe(200);
    expect(db.tables.lead).toEqual([expect.objectContaining({
      email: 'jane@acme.com', name: 'Jane', company: null, jobTitle: 'CEO', status: 'Neutral', validationStatus: 'Unverified',
    })]);
    expect(db.tables.leadGroupMembership).toEqual([{ leadId: db.tables.lead[0].id, groupId: 'group-1' }]);
    expect(enrolled()).toEqual(['jane@acme.com']);
  });
});
