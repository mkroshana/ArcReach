import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { promises as dnsPromises } from 'dns';
// The Prisma client reads .env when it is first imported and sets what is missing, so it is
// imported here: left to the route's first load, it would put back a setting a test removed.
import '@prisma/client';

/** The one lead query, shared by every load of the route so a test sees whether any load reached the database. */
const findLeads = vi.hoisted(() => vi.fn());

vi.mock('../../lib/db', () => ({
  prisma: { lead: { findMany: findLeads } },
}));

vi.mock('../../lib/session', () => ({
  getSession: vi.fn(async () => ({ id: 'admin-1', name: 'Admin', email: 'admin@example.com', role: 'ADMIN' })),
}));

/** The value the developer's own .env gives the setting, put back after each test. */
const ownDnsServers = process.env.DOMAIN_CHECK_DNS_SERVERS;

/** Sets the setting, or removes it for undefined. */
function setDnsServers(dnsServers: string | undefined) {
  if (dnsServers === undefined) delete process.env.DOMAIN_CHECK_DNS_SERVERS;
  else process.env.DOMAIN_CHECK_DNS_SERVERS = dnsServers;
}

/**
 * The route reads DOMAIN_CHECK_DNS_SERVERS once, when it is loaded, so each
 * test loads it again with its own value. The resolver is Node's own: naming
 * its servers makes no lookup.
 */
async function loadRoute(dnsServers: string | undefined) {
  setDnsServers(dnsServers);
  vi.resetModules();
  return import('../../app/api/leads/verify/route');
}

function checkRequest(): NextRequest {
  return new NextRequest('http://localhost/api/leads/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: ['lead-1'] }),
  });
}

describe('DOMAIN_CHECK_DNS_SERVERS', () => {
  let setServers: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    setServers = vi.spyOn(dnsPromises.Resolver.prototype, 'setServers');
  });

  afterEach(() => {
    setServers.mockRestore();
    setDnsServers(ownDnsServers);
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['only separators', ' , '],
  ])('leaves the resolver on the system DNS servers when it is %s', async (_label, value) => {
    await loadRoute(value);

    expect(setServers).not.toHaveBeenCalled();
  });

  it('points the check at the servers it names, trimmed and in order', async () => {
    await loadRoute(' 10.10.10.1 ,1.1.1.1:53, [2606:4700:4700::1111]:53 ,');

    expect(setServers).toHaveBeenCalledTimes(1);
    expect(setServers).toHaveBeenCalledWith(['10.10.10.1', '1.1.1.1:53', '[2606:4700:4700::1111]:53']);
    expect((setServers.mock.contexts[0] as InstanceType<typeof dnsPromises.Resolver>).getServers()).toEqual([
      '10.10.10.1', '1.1.1.1', '2606:4700:4700::1111',
    ]);
  });

  it.each(['router.local', '10.10.10', '10.10.10.1, dns.google'])('answers every check a 500 naming the setting, looking nothing up, when it is %j', async (value) => {
    const { POST } = await loadRoute(value);

    const res = await POST(checkRequest());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'DOMAIN_CHECK_DNS_SERVERS must be DNS server IP addresses separated by commas.' });
    expect(findLeads).not.toHaveBeenCalled();
  });
});
