import { describe, it, expect, beforeAll } from 'vitest';
import { SignJWT } from 'jose';
import { PrismaClient } from '@prisma/client';
import { getVerifiedDomains } from '../../lib/azureDomains';

const BASE_URL = 'http://localhost:3000';

// Resolve the signing secret exactly like lib/sessionSecret.ts so the cookies we mint
// here verify against the running dev server. Signing is done inline (not via lib/session)
// to avoid importing next/headers into the test runtime.
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev_session_secret_jwt_32_chars_long_placeholder';
const secretKey = new TextEncoder().encode(SESSION_SECRET);

interface TestSession {
  id: string;
  name: string;
  email: string;
  role: 'ADMIN' | 'USER';
}

/** DEFAULT_ADMIN's User.tokenVersion, read before the tests: the server refuses a cookie signed under any other (H26). */
let adminTokenVersion = 0;

async function signSession(session: TestSession, tokenVersion = adminTokenVersion): Promise<string> {
  return new SignJWT({ ...session, tokenVersion })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secretKey);
}

const DEFAULT_ADMIN: TestSession = {
  id: 'admin-id-999',
  name: 'ArcReach Admin',
  email: 'admin@arcreach.com',
  role: 'ADMIN',
};

const testFetch = async (url: string, options: any = {}) => {
  const token = await signSession(DEFAULT_ADMIN);
  return fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      Cookie: `user_session=${token}`,
    },
  });
};

/**
 * A domain the running server accepts mailboxes on. POST /api/accounts refuses
 * any sender address whose domain is not a verified Azure sender domain, so
 * the mailbox tests need one saved in Settings.
 */
const verifiedSenderDomain = async (): Promise<string> => {
  const res = await testFetch(`${BASE_URL}/api/settings`);
  const [domain] = getVerifiedDomains((await res.json()).settings);
  if (!domain) {
    throw new Error('Save at least one verified Azure sender domain in Settings before running the integration tests: POST /api/accounts refuses every sender address until then.');
  }
  return domain;
};

describe('ArcReach Live API Integration Tests', () => {
  
  // Ensure Next.js dev server is reachable
  beforeAll(async () => {
    const prisma = new PrismaClient();
    try {
      const admin = await prisma.user.findUnique({ where: { id: DEFAULT_ADMIN.id }, select: { tokenVersion: true } });
      if (!admin) {
        throw new Error(`The integration tests sign in as ${DEFAULT_ADMIN.id}; create that admin in the dev database first.`);
      }
      adminTokenVersion = admin.tokenVersion;
    } finally {
      await prisma.$disconnect();
    }

    try {
      await testFetch(`${BASE_URL}/api/system-status`);
    } catch (e) {
      throw new Error(`The local Next.js server is not running on ${BASE_URL}. Please start it using 'npm run dev' before running integration tests.`);
    }
  });

  describe('GET /api/system-status', () => {
    it('should return 200 and have the correct system metrics schema', async () => {
      const res = await testFetch(`${BASE_URL}/api/system-status`);
      expect(res.status).toBe(200);
      
      const data = await res.json();
      expect(data).toHaveProperty('database');
      expect(data).toHaveProperty('deliveryStatus');
      expect(data).toHaveProperty('smtpConfigured');
      expect(data).toHaveProperty('accountsCount');
      expect(data).toHaveProperty('activeCampaignsCount');
      expect(data).toHaveProperty('leadsCount');
      
      expect(['OPERATIONAL', 'STANDBY', 'INACTIVE']).toContain(data.deliveryStatus);
    });
  });

  describe('GET /api/dashboard-stats', () => {
    it('should return 200 and return analytics counters and weekly buckets', async () => {
      const res = await testFetch(`${BASE_URL}/api/dashboard-stats`);
      expect(res.status).toBe(200);
      
      const data = await res.json();
      expect(data).toHaveProperty('stats');
      expect(data).toHaveProperty('trends');
      expect(Array.isArray(data.trends)).toBe(true);
    });
  });

  describe('GET /api/settings & PUT /api/settings', () => {
    it('should retrieve and update global SMTP settings successfully', async () => {
      // 1. Get settings
      const getRes = await testFetch(`${BASE_URL}/api/settings`);
      expect(getRes.status).toBe(200);
      const originalSettings = await getRes.json();
      expect(originalSettings).toHaveProperty('user');
      expect(originalSettings).toHaveProperty('settings');
      expect(originalSettings.settings).toHaveProperty('rateLimitMinute');
      expect(originalSettings.settings).toHaveProperty('rateLimitHour');

      // 2. Update settings
      const payload = {
        name: 'Standard Marketer',
        smtpHost: 'smtp.sendgrid.net',
        smtpPort: 587,
        smtpUser: 'apikey',
        smtpPass: 'SG.placeholder',
        rateLimitMinute: 120,
        rateLimitHour: 2500
      };
      const putRes = await testFetch(`${BASE_URL}/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      expect(putRes.status).toBe(200);
      const putData = await putRes.json();
      expect(putData.success).toBe(true);
      expect(putData.settings.rateLimitMinute).toBe(120);
      expect(putData.settings.rateLimitHour).toBe(2500);

      // 3. Confirm GET updates are persistent
      const confirmRes = await testFetch(`${BASE_URL}/api/settings`);
      expect(confirmRes.status).toBe(200);
      const confirmData = await confirmRes.json();
      expect(confirmData.settings.rateLimitMinute).toBe(120);
      expect(confirmData.settings.rateLimitHour).toBe(2500);
    });

    it('should allow toggling global active provider between DISABLED and AZURE and reject invalid values', async () => {
      // 1. Toggle active provider to DISABLED
      const disabledRes = await testFetch(`${BASE_URL}/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activeProvider: 'DISABLED' })
      });
      expect(disabledRes.status).toBe(200);
      const disabledData = await disabledRes.json();
      expect(disabledData.success).toBe(true);
      expect(disabledData.settings.activeProvider).toBe('DISABLED');

      // Verify GET returns DISABLED
      const getDisabledRes = await testFetch(`${BASE_URL}/api/settings`);
      expect((await getDisabledRes.json()).settings.activeProvider).toBe('DISABLED');

      // 2. Toggle active provider to AZURE
      const azureRes = await testFetch(`${BASE_URL}/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activeProvider: 'AZURE' })
      });
      expect(azureRes.status).toBe(200);
      const azureData = await azureRes.json();
      expect(azureData.success).toBe(true);
      expect(azureData.settings.activeProvider).toBe('AZURE');

      // Verify GET returns AZURE
      const getAzureRes = await testFetch(`${BASE_URL}/api/settings`);
      expect((await getAzureRes.json()).settings.activeProvider).toBe('AZURE');

      // 3. Try setting an invalid or retired active provider (should fail with 400)
      for (const activeProvider of ['SMTP', 'MOCK']) {
        const invalidRes = await testFetch(`${BASE_URL}/api/settings`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ activeProvider })
        });
        expect(invalidRes.status).toBe(400);
        const invalidData = await invalidRes.json();
        expect(invalidData.error).toContain('Delivery provider must be AZURE or DISABLED.');
      }
    });
  });

  describe('Templates CRUD Lifecycle API', () => {
    let createdTemplateId: string;

    it('should retrieve templates list with seeded items', async () => {
      const res = await testFetch(`${BASE_URL}/api/templates`);
      expect(res.status).toBe(200);
      const templates = await res.json();
      expect(Array.isArray(templates)).toBe(true);
      expect(templates.length).toBeGreaterThan(0);
    });

    it('should successfully create, update, and delete a template', async () => {
      // Create
      const payload = {
        name: 'Automated Test Template',
        subject: 'Vitest Test Subject line',
        body: 'Hello {{firstName}}, this is a test from Vitest framework.',
        category: 'Cold Outreach'
      };
      const createRes = await testFetch(`${BASE_URL}/api/templates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      expect(createRes.status).toBe(200);
      const created = await createRes.json();
      createdTemplateId = created.id;

      // Update
      const updatePayload = {
        id: createdTemplateId,
        name: 'Updated Test Template',
        subject: 'Updated Subject Line',
        body: 'Hello {{firstName}}, updated test body.',
        category: 'Follow Up'
      };
      const updateRes = await testFetch(`${BASE_URL}/api/templates`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatePayload)
      });
      expect(updateRes.status).toBe(200);

      // Delete
      const deleteRes = await testFetch(`${BASE_URL}/api/templates?id=${createdTemplateId}`, {
        method: 'DELETE'
      });
      expect(deleteRes.status).toBe(200);
    });
  });

  describe('Accounts CRUD Lifecycle API', () => {
    let createdAccountId: string;

    it('should successfully create, update, and delete a sender account', async () => {
      const payload = {
        emailAddress: `test-sender-${Date.now()}@${await verifiedSenderDomain()}`,
        name: 'Test Outbound Sender',
        provider: 'Google Workspace',
        minuteLimit: 5,
        hourlyLimit: 100,
        dailyLimit: 500,
        warmupEnabled: false,
        replyTo: 'reply-test@arcreach-test.io'
      };

      // Create
      const createRes = await testFetch(`${BASE_URL}/api/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      expect(createRes.status).toBe(200);
      const created = await createRes.json();
      expect(created).toHaveProperty('id');
      expect(created.replyTo).toBe('reply-test@arcreach-test.io');
      createdAccountId = created.id;

      // Update limits and reputation status
      const updatePayload = {
        id: createdAccountId,
        name: 'Updated Test Sender',
        warmupEnabled: true,
        minuteLimit: 10,
        replyTo: 'reply-updated@arcreach-test.io'
      };
      const updateRes = await testFetch(`${BASE_URL}/api/accounts`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatePayload)
      });
      expect(updateRes.status).toBe(200);
      const updated = await updateRes.json();
      expect(updated.warmupEnabled).toBe(true);
      expect(updated.replyTo).toBe('reply-updated@arcreach-test.io');

      // Clean up / Delete
      const deleteRes = await testFetch(`${BASE_URL}/api/accounts?id=${createdAccountId}`, {
        method: 'DELETE'
      });
      expect(deleteRes.status).toBe(200);
    });
  });

  describe('Leads CRUD & Verification Lifecycle API', () => {
    let createdLeadId: string;
    const testEmail = `test-lead-${Date.now()}@gmail.com`;

    it('should successfully create, verify, and delete a CRM lead', async () => {
      const payload = {
        name: 'CRM Lead Test',
        email: testEmail,
        company: 'Automated CRM Inc',
        status: 'Neutral',
        validationStatus: 'Unverified'
      };

      // Create Lead
      const createRes = await testFetch(`${BASE_URL}/api/leads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      expect(createRes.status).toBe(200);
      const created = await createRes.json();
      createdLeadId = created.id;

      // Verify lead domain DNS records
      const verifyRes = await testFetch(`${BASE_URL}/api/leads/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [createdLeadId] })
      });
      expect(verifyRes.status).toBe(200);
      const verification = await verifyRes.json();
      expect(verification.success).toBe(true);
      expect(Array.isArray(verification.results)).toBe(true);

      // Get single lead details
      const getDetailRes = await testFetch(`${BASE_URL}/api/leads?id=${createdLeadId}`);
      expect(getDetailRes.status).toBe(200);
      const leadDetail = await getDetailRes.json();
      expect(leadDetail.id).toBe(createdLeadId);
      expect(leadDetail.name).toBe(payload.name);
      expect(leadDetail).toHaveProperty('dispatches');
      expect(leadDetail).toHaveProperty('replies');
      expect(Array.isArray(leadDetail.dispatches)).toBe(true);
      expect(Array.isArray(leadDetail.replies)).toBe(true);

      // Delete Lead
      const deleteRes = await testFetch(`${BASE_URL}/api/leads?id=${createdLeadId}`, {
        method: 'DELETE'
      });
      expect(deleteRes.status).toBe(200);
    });

    it('should successfully import leads in bulk and filter duplicates', async () => {
      const uniqueSuffix = Date.now();
      const bulkPayload = {
        leads: [
          { name: 'Bulk Lead 1', email: `bulk-1-${uniqueSuffix}@gmail.com`, company: 'Bulk Corp', jobTitle: 'Manager' },
          { name: 'Bulk Lead 2', email: `bulk-2-${uniqueSuffix}@gmail.com`, company: 'Bulk LLC', jobTitle: 'VP' }
        ],
        groupIds: []
      };

      // 1. Bulk Ingest
      const bulkRes = await testFetch(`${BASE_URL}/api/leads/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bulkPayload)
      });
      expect(bulkRes.status).toBe(200);
      const bulkResult = await bulkRes.json();
      expect(bulkResult.success).toBe(true);
      expect(bulkResult.counts.created).toBe(2);

      // 2. Re-ingest same payload to verify duplicate filtering (both rows come back as existing)
      const duplicateRes = await testFetch(`${BASE_URL}/api/leads/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bulkPayload)
      });
      expect(duplicateRes.status).toBe(200);
      const duplicateResult = await duplicateRes.json();
      expect(duplicateResult.success).toBe(true);
      expect(duplicateResult.counts.created).toBe(0);
      expect(duplicateResult.outcomes).toEqual(['existing', 'existing']);

      // 3. Clean up created leads
      // The list comes a page at a time: search for this test's leads
      const getLeadsRes = await testFetch(`${BASE_URL}/api/leads?q=${encodeURIComponent(`-${uniqueSuffix}@gmail.com`)}`);
      const { leads } = await getLeadsRes.json();
      const createdLeads = leads.filter((l: any) => l.email.includes(`-${uniqueSuffix}@gmail.com`));
      expect(createdLeads.length).toBe(2);

      for (const lead of createdLeads) {
        const delRes = await testFetch(`${BASE_URL}/api/leads?id=${lead.id}`, {
          method: 'DELETE'
        });
        expect(delRes.status).toBe(200);
      }
    });

    it('should successfully support bulk updates and bulk deletes via array of IDs', async () => {
      const uniqueSuffix = Date.now();
      
      const lead1Res = await testFetch(`${BASE_URL}/api/leads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Lead 1', email: `bulk-a-${uniqueSuffix}@gmail.com`, company: 'Inc' })
      });
      const lead1 = await lead1Res.json();

      const lead2Res = await testFetch(`${BASE_URL}/api/leads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Lead 2', email: `bulk-b-${uniqueSuffix}@gmail.com`, company: 'LLC' })
      });
      const lead2 = await lead2Res.json();

      const ids = [lead1.id, lead2.id];

      // 1. Bulk Update (archive them)
      const archiveRes = await testFetch(`${BASE_URL}/api/leads`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, isArchived: true })
      });
      expect(archiveRes.status).toBe(200);

      const check1 = await (await testFetch(`${BASE_URL}/api/leads?id=${lead1.id}`)).json();
      const check2 = await (await testFetch(`${BASE_URL}/api/leads?id=${lead2.id}`)).json();
      expect(check1.isArchived).toBe(true);
      expect(check2.isArchived).toBe(true);

      // 2. Bulk Delete
      const deleteRes = await testFetch(`${BASE_URL}/api/leads`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids })
      });
      expect(deleteRes.status).toBe(200);

      const check1Deleted = await testFetch(`${BASE_URL}/api/leads?id=${lead1.id}`);
      const check2Deleted = await testFetch(`${BASE_URL}/api/leads?id=${lead2.id}`);
      expect(check1Deleted.status).toBe(404);
      expect(check2Deleted.status).toBe(404);
    });

    it('should show a confirmation on GET /api/unsubscribe and unsubscribe only on POST', async () => {
      const uniqueSuffix = Date.now();

      // Create a lead
      const createRes = await testFetch(`${BASE_URL}/api/leads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Unsub Lead', email: `unsub-${uniqueSuffix}@gmail.com`, company: 'Corp' })
      });
      const lead = await createRes.json();
      expect(lead.status).toBe('Neutral');

      // Opening the link (as a mail-security scanner does) only shows the confirmation page
      const pageRes = await fetch(`${BASE_URL}/api/unsubscribe?id=${lead.id}`);
      expect(pageRes.status).toBe(200);
      const page = await pageRes.text();
      expect(page).toContain('Confirm Unsubscribe');
      expect(page).toContain(`<form method="post" action="/api/unsubscribe?id=${lead.id}">`);
      const unchanged = await (await testFetch(`${BASE_URL}/api/leads?id=${lead.id}`)).json();
      expect(unchanged.status).toBe('Neutral');

      // The confirmation button POSTs the same link, without a session
      const unsubRes = await fetch(`${BASE_URL}/api/unsubscribe?id=${lead.id}`, { method: 'POST' });
      expect(unsubRes.status).toBe(200);
      const html = await unsubRes.text();
      expect(html).toContain('Unsubscribed Successfully');

      // Verify lead status changed to Unsubscribed
      const checkRes = await testFetch(`${BASE_URL}/api/leads?id=${lead.id}`);
      const updatedLead = await checkRes.json();
      expect(updatedLead.status).toBe('Unsubscribed');

      // An RFC 8058 one-click POST again is idempotent
      const resubRes = await fetch(`${BASE_URL}/api/unsubscribe?id=${lead.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'List-Unsubscribe=One-Click',
      });
      expect(resubRes.status).toBe(200);

      // A link whose token was not signed by the server is refused
      const forgedRes = await fetch(`${BASE_URL}/api/unsubscribe?token=${Buffer.from(lead.id).toString('base64url')}.eA.eA`, { method: 'POST' });
      expect(forgedRes.status).toBe(400);

      // Clean up
      await testFetch(`${BASE_URL}/api/leads?id=${lead.id}`, { method: 'DELETE' });
    });
  });

  describe('Campaigns & Sequence Steps Lifecycle API', () => {
    let createdAccountId: string;
    let createdCampaignId: string;

    // Create a temporary sender account since campaigns require a linked account
    beforeAll(async () => {
      const senderPayload = {
        emailAddress: `campaign-sender-${Date.now()}@${await verifiedSenderDomain()}`,
        name: 'Campaign Sender',
        provider: 'Custom SMTP',
        minuteLimit: 5,
        hourlyLimit: 50,
        dailyLimit: 200,
        warmupEnabled: false
      };
      const res = await testFetch(`${BASE_URL}/api/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(senderPayload)
      });
      const created = await res.json();
      createdAccountId = created.id;
    });

    it('should successfully create, detail, update steps, and delete a campaign', async () => {
      expect(createdAccountId).toBeDefined();

      // 1. Create Campaign (Draft)
      const campaignPayload = {
        name: 'Automated Outreach Campaign',
        status: 'Draft',
        senderAccountId: createdAccountId
      };
      const createRes = await testFetch(`${BASE_URL}/api/campaigns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(campaignPayload)
      });
      expect(createRes.status).toBe(200);
      const createdCmp = await createRes.json();
      createdCampaignId = createdCmp.id;

      // 2. Get Campaign Details & Verify Telemetry structures
      const getRes = await testFetch(`${BASE_URL}/api/campaigns/${createdCampaignId}`);
      expect(getRes.status).toBe(200);
      const detail = await getRes.json();
      expect(detail).toHaveProperty('telemetry');
      expect(detail.telemetry).toHaveProperty('opens');
      expect(detail.telemetry).toHaveProperty('trend');
      expect(Array.isArray(detail.telemetry.trend)).toBe(true);
      expect(detail.telemetry.trend.length).toBe(7);
      expect(detail.telemetry.trend[0]).toHaveProperty('name');
      expect(detail.telemetry.trend[0]).toHaveProperty('opens');
      expect(detail.telemetry.trend[0]).toHaveProperty('clicks');

      // 3. Update campaign details and steps transactionally (PUT)
      const updatePayload = {
        name: 'Updated Campaign Name',
        status: 'Active',
        timezone: 'America/New_York',
        stopOnReply: true,
        steps: [
          { waitDays: 0, subject: 'Welcome {{firstName}}!', body: 'Hi {{firstName}}, check out {{company}}.' },
          { waitDays: 3, subject: 'Quick Bump', body: 'Hey {Hi|Hey}, just bumping this.' }
        ]
      };
      const updateRes = await testFetch(`${BASE_URL}/api/campaigns/${createdCampaignId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatePayload)
      });
      expect(updateRes.status).toBe(200);
      const updatedDetail = await updateRes.json();
      expect(updatedDetail.name).toBe(updatePayload.name);
      expect(updatedDetail.status).toBe(updatePayload.status);
      expect(updatedDetail.timezone).toBe(updatePayload.timezone);
      expect(updatedDetail.steps.length).toBe(2);

      const deleteRes = await testFetch(`${BASE_URL}/api/campaigns?id=${createdCampaignId}`, {
        method: 'DELETE'
      });
      if (deleteRes.status !== 200) {
        console.error('DELETE CAMPAIGN FAILED:', deleteRes.status, await deleteRes.text());
      }
      expect(deleteRes.status).toBe(200);

      // Cleanup Sender Account
      await testFetch(`${BASE_URL}/api/accounts?id=${createdAccountId}`, {
        method: 'DELETE'
      });
    }, 30000);
  });

  describe('Unibox Live API Interactions', () => {
    it('should fetch inbound replies list', async () => {
      const res = await testFetch(`${BASE_URL}/api/unibox`);
      expect(res.status).toBe(200);
      const page = await res.json();
      expect(Array.isArray(page.threads)).toBe(true);
      expect(typeof page.total).toBe('number');
    }, 60000);
  });

  describe('Lead Groups, Archiving & Deduplication API Lifecycle', () => {
    let createdGroupId: string;
    let createdLeadId: string;
    const groupName = `Test Group ${Date.now()}`;
    const testEmail = `overlap-lead-${Date.now()}@arcreach-test.io`;

    it('should successfully manage lead groups and associations', async () => {
      // 1. Create a Lead Group
      const createGroupRes = await testFetch(`${BASE_URL}/api/leads/groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: groupName,
          description: 'A group created during integration testing'
        })
      });
      expect(createGroupRes.status).toBe(200);
      const group = await createGroupRes.json();
      expect(group).toHaveProperty('id');
      expect(group.name).toBe(groupName);
      createdGroupId = group.id;

      // 2. Create a lead and assign it to the group
      const leadPayload = {
        name: 'Overlap Test Lead',
        email: testEmail,
        company: 'Overlap Corp',
        groupIds: [createdGroupId]
      };
      const createLeadRes = await testFetch(`${BASE_URL}/api/leads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(leadPayload)
      });
      expect(createLeadRes.status).toBe(200);
      const lead = await createLeadRes.json();
      expect(lead).toHaveProperty('id');
      createdLeadId = lead.id;

      // Verify lead belongs to the group on query
      const getLeadRes = await testFetch(`${BASE_URL}/api/leads?id=${createdLeadId}`);
      expect(getLeadRes.status).toBe(200);
      const queriedLead = await getLeadRes.json();
      expect(queriedLead.groups.length).toBe(1);
      expect(queriedLead.groups[0].groupId).toBe(createdGroupId);

      // 3. Mark the lead as archived
      const archiveRes = await testFetch(`${BASE_URL}/api/leads`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: createdLeadId,
          isArchived: true
        })
      });
      expect(archiveRes.status).toBe(200);
      const archivedLead = await archiveRes.json();
      expect(archivedLead.isArchived).toBe(true);

      // Restore it back
      const restoreRes = await testFetch(`${BASE_URL}/api/leads`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: createdLeadId,
          isArchived: false
        })
      });
      expect(restoreRes.status).toBe(200);
      expect((await restoreRes.json()).isArchived).toBe(false);

      // 4. Remove lead from group
      const removeRes = await testFetch(`${BASE_URL}/api/leads/groups/memberships?groupId=${createdGroupId}&leadId=${createdLeadId}`, {
        method: 'DELETE'
      });
      expect(removeRes.status).toBe(200);

      // Verify lead group memberships are empty
      const leadAfterRemoveRes = await testFetch(`${BASE_URL}/api/leads?id=${createdLeadId}`);
      const leadAfterRemove = await leadAfterRemoveRes.json();
      expect(leadAfterRemove.groups.length).toBe(0);

      // 5. Clean up Lead & Group
      const deleteLeadRes = await testFetch(`${BASE_URL}/api/leads?id=${createdLeadId}`, {
        method: 'DELETE'
      });
      expect(deleteLeadRes.status).toBe(200);

      const deleteGroupRes = await testFetch(`${BASE_URL}/api/leads/groups?id=${createdGroupId}`, {
        method: 'DELETE'
      });
      expect(deleteGroupRes.status).toBe(200);
    });

    it('should successfully support group deletion disposal actions (KEEP, DELETE, MOVE)', async () => {
      // Create two temporary groups: Group A and Group B
      const uniqueSuffix = Date.now();
      const groupARes = await testFetch(`${BASE_URL}/api/leads/groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `Group A ${uniqueSuffix}` })
      });
      const groupA = await groupARes.json();

      const groupBRes = await testFetch(`${BASE_URL}/api/leads/groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `Group B ${uniqueSuffix}` })
      });
      const groupB = await groupBRes.json();

      // Create a lead in Group A
      const leadRes = await testFetch(`${BASE_URL}/api/leads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `Disposal Lead ${uniqueSuffix}`,
          email: `disposal-${uniqueSuffix}@gmail.com`,
          groupIds: [groupA.id]
        })
      });
      const lead = await leadRes.json();

      // 1. Verify bulk archiving by group ID
      const archiveRes = await testFetch(`${BASE_URL}/api/leads`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId: groupA.id, isArchived: true })
      });
      expect(archiveRes.status).toBe(200);

      // Verify lead is archived
      const checkArchivedRes = await testFetch(`${BASE_URL}/api/leads?id=${lead.id}`);
      expect((await checkArchivedRes.json()).isArchived).toBe(true);

      // Restore
      await testFetch(`${BASE_URL}/api/leads`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId: groupA.id, isArchived: false })
      });

      // 2. Test MOVE disposal action: Delete Group A and move leads to Group B
      const moveRes = await testFetch(`${BASE_URL}/api/leads/groups?id=${groupA.id}&leadAction=MOVE&targetGroupId=${groupB.id}`, {
        method: 'DELETE'
      });
      expect(moveRes.status).toBe(200);

      // Verify lead is now in Group B
      const checkMoveRes = await testFetch(`${BASE_URL}/api/leads?id=${lead.id}`);
      const checkMoveLead = await checkMoveRes.json();
      expect(checkMoveLead.groups.length).toBe(1);
      expect(checkMoveLead.groups[0].groupId).toBe(groupB.id);

      // 3. Test DELETE disposal action: Delete Group B and delete all leads inside it
      const deleteActionRes = await testFetch(`${BASE_URL}/api/leads/groups?id=${groupB.id}&leadAction=DELETE`, {
        method: 'DELETE'
      });
      expect(deleteActionRes.status).toBe(200);

      // Verify lead is deleted
      const checkDeletedRes = await testFetch(`${BASE_URL}/api/leads?id=${lead.id}`);
      expect(checkDeletedRes.status).toBe(404);
    });
  });

  describe('User Roster API (/api/users)', () => {
    it('should retrieve corporate user roster', async () => {
      const res = await testFetch(`${BASE_URL}/api/users`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThan(0);
    });

    it('should prevent the logged-in admin from demoting themselves', async () => {
      const res = await testFetch(`${BASE_URL}/api/users`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: DEFAULT_ADMIN.id, role: 'USER' }),
      });
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.error).toContain('cannot remove your own admin role');
    });

    it('should prevent deleting the currently logged-in admin user via cookie session', async () => {
      const res = await testFetch(`${BASE_URL}/api/users?id=${DEFAULT_ADMIN.id}`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('Cannot delete your own active session');
    });

    it('should refuse a validly signed session for a user who does not exist', async () => {
      // Sign a valid session cookie for "temp-admin-123", who is not in the database
      const token = await signSession({
        id: 'temp-admin-123',
        name: 'Temporary Admin',
        email: 'temp@arcreach.com',
        role: 'ADMIN',
      }, 0);

      const res = await fetch(`${BASE_URL}/api/users?id=temp-admin-123`, {
        method: 'DELETE',
        headers: {
          'Cookie': `user_session=${token}`,
        },
      });
      expect(res.status).toBe(401);
    });

    it('should successfully create, toggle role, and delete a temporary user', async () => {
      // 1. Create a user
      const createRes = await testFetch(`${BASE_URL}/api/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Integration Test User',
          email: 'test-user-api@arcreach.com',
          role: 'USER',
          password: 'integration-test-pw-123',
        }),
      });
      expect(createRes.status).toBe(200);
      const createdUser = await createRes.json();
      expect(createdUser.name).toBe('Integration Test User');
      expect(createdUser.role).toBe('USER');

      // 2. Toggle role to ADMIN
      const toggleAdminRes = await testFetch(`${BASE_URL}/api/users`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: createdUser.id,
          role: 'ADMIN',
        }),
      });
      expect(toggleAdminRes.status).toBe(200);
      expect((await toggleAdminRes.json()).role).toBe('ADMIN');

      // 3. Toggle role back to USER
      const toggleUserRes = await testFetch(`${BASE_URL}/api/users`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: createdUser.id,
          role: 'USER',
        }),
      });
      expect(toggleUserRes.status).toBe(200);
      expect((await toggleUserRes.json()).role).toBe('USER');

      // 4. Delete the user
      const deleteRes = await testFetch(`${BASE_URL}/api/users?id=${createdUser.id}`, {
        method: 'DELETE',
      });
      expect(deleteRes.status).toBe(200);
      expect((await deleteRes.json()).success).toBe(true);
    });
  });
});
