import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';

/** The request's cookie store, as next/headers hands it to lib/session. */
const jar = vi.hoisted(() => {
  const values = new Map<string, string>();
  return {
    values,
    store: {
      get: (name: string) => (values.has(name) ? { name, value: values.get(name)! } : undefined),
      set: vi.fn((name: string, value: string) => { values.set(name, value); }),
      delete: vi.fn((name: string) => { values.delete(name); }),
    },
  };
});

vi.mock('next/headers', () => ({
  cookies: async () => jar.store,
}));

vi.mock('../../lib/db', () => ({
  db: {
    updateUserRole: vi.fn(),
  },
  prisma: {
    user: { findUnique: vi.fn() },
    lead: { deleteMany: vi.fn(), findMany: vi.fn() },
  },
}));

import { prisma, db } from '../../lib/db';
import { signSession } from '../../lib/session';
import * as accounts from '../../app/api/accounts/route';
import * as campaigns from '../../app/api/campaigns/route';
import * as campaign from '../../app/api/campaigns/[id]/route';
import * as campaignRun from '../../app/api/campaigns/[id]/run/route';
import * as dashboardStats from '../../app/api/dashboard-stats/route';
import * as leads from '../../app/api/leads/route';
import * as leadsBulk from '../../app/api/leads/bulk/route';
import * as leadGroups from '../../app/api/leads/groups/route';
import * as leadGroupMemberships from '../../app/api/leads/groups/memberships/route';
import * as leadsReactivate from '../../app/api/leads/reactivate/route';
import * as leadsSuppression from '../../app/api/leads/suppression/route';
import * as leadsVerify from '../../app/api/leads/verify/route';
import * as sendEmailTest from '../../app/api/send-email/test/route';
import * as session from '../../app/api/session/route';
import * as settings from '../../app/api/settings/route';
import * as settingsTestSmtp from '../../app/api/settings/test-smtp/route';
import * as systemStatus from '../../app/api/system-status/route';
import * as templates from '../../app/api/templates/route';
import * as unibox from '../../app/api/unibox/route';
import * as uniboxReply from '../../app/api/unibox/reply/route';
import * as users from '../../app/api/users/route';

const mockedPrisma = prisma as any;
const mockedDb = db as any;

type Handler = (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

/** Every session-protected API handler, by route and method. */
const ROUTES: Record<string, Record<string, unknown>> = {
  '/api/accounts': accounts,
  '/api/campaigns': campaigns,
  '/api/campaigns/[id]': campaign,
  '/api/campaigns/[id]/run': campaignRun,
  '/api/dashboard-stats': dashboardStats,
  '/api/leads': leads,
  '/api/leads/bulk': leadsBulk,
  '/api/leads/groups': leadGroups,
  '/api/leads/groups/memberships': leadGroupMemberships,
  '/api/leads/reactivate': leadsReactivate,
  '/api/leads/suppression': leadsSuppression,
  '/api/leads/verify': leadsVerify,
  '/api/send-email/test': sendEmailTest,
  '/api/session': session,
  '/api/settings': settings,
  '/api/settings/test-smtp': settingsTestSmtp,
  '/api/system-status': systemStatus,
  '/api/templates': templates,
  '/api/unibox': unibox,
  '/api/unibox/reply': uniboxReply,
  '/api/users': users,
};

const HANDLERS = Object.entries(ROUTES).flatMap(([path, mod]) =>
  ['GET', 'POST', 'PUT', 'DELETE']
    .filter((method) => typeof mod[method] === 'function')
    .map((method) => [`${method} ${path}`, method, mod[method] as Handler] as const),
);

function request(method: string, url = 'http://localhost/api/x'): NextRequest {
  return new NextRequest(url, {
    method,
    ...(method === 'GET' ? {} : { headers: { 'content-type': 'application/json' }, body: '{}' }),
  });
}

const ctx = () => ({ params: Promise.resolve({ id: 'cmp-1' }) });

beforeEach(() => {
  vi.clearAllMocks();
  jar.values.clear();
  mockedPrisma.user.findUnique.mockResolvedValue({
    id: 'admin-1', name: 'Ada', email: 'admin@example.com', role: 'ADMIN', tokenVersion: 5, disabledAt: null,
  });
});

describe('every API route answers a missing or revoked session with 401 (H26)', () => {
  it('covers every route that calls getSession', () => {
    const apiDir = path.resolve(__dirname, '../../app/api');
    const protectedRoutes = fs.readdirSync(apiDir, { recursive: true, encoding: 'utf8' })
      .filter((file) => path.basename(file) === 'route.ts')
      .filter((file) => fs.readFileSync(path.join(apiDir, file), 'utf8').includes('await getSession()'))
      .map((file) => `/api/${path.dirname(file).split(path.sep).join('/')}`)
      .filter((route) => route !== '/api/auth/logout'); // signs out whether or not the session is live
    expect(Object.keys(ROUTES).sort()).toEqual(protectedRoutes.sort());
    expect(HANDLERS.length).toBe(41);
  });

  it.each(HANDLERS)('%s returns 401, not 500, with no session cookie', async (_label, method, handler) => {
    const res = await handler(request(method), ctx());
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'Your session has ended. Sign in again.' });
  });

  it.each(HANDLERS)('%s returns 401 for a session signed under an old tokenVersion', async (_label, method, handler) => {
    jar.values.set('user_session', await signSession({ id: 'admin-1', name: 'Ada', email: 'admin@example.com', role: 'ADMIN', tokenVersion: 4 }));
    const res = await handler(request(method), ctx());
    expect(res.status).toBe(401);
  });

  it('refuses a deleted user\'s still-signed cookie before DELETE /api/leads?all=true deletes anything', async () => {
    jar.values.set('user_session', await signSession({ id: 'admin-1', name: 'Ada', email: 'admin@example.com', role: 'ADMIN', tokenVersion: 5 }));
    mockedPrisma.user.findUnique.mockResolvedValue(null);

    const res = await leads.DELETE(request('DELETE', 'http://localhost/api/leads?all=true'));

    expect(res.status).toBe(401);
    expect(mockedPrisma.lead.deleteMany).not.toHaveBeenCalled();
  });

  it('answers a demoted admin whose cookie still says ADMIN with 403, from the role in the database', async () => {
    jar.values.set('user_session', await signSession({ id: 'admin-1', name: 'Ada', email: 'admin@example.com', role: 'ADMIN', tokenVersion: 5 }));
    mockedPrisma.user.findUnique.mockResolvedValue({
      id: 'admin-1', name: 'Ada', email: 'admin@example.com', role: 'USER', tokenVersion: 5, disabledAt: null,
    });

    const res = await users.PUT(new NextRequest('http://localhost/api/users', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'admin-1', role: 'ADMIN' }),
    }));

    expect(res.status).toBe(403);
    expect(mockedDb.updateUserRole).not.toHaveBeenCalled();
  });
});
