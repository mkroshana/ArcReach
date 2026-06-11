import { describe, it, expect, beforeAll } from 'vitest';

const BASE_URL = 'http://localhost:3000';

const testFetch = (url: string, options: any = {}) => {
  return fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      'x-integration-test': 'true',
    },
  });
};

describe('ArcReach Live API Integration Tests', () => {
  
  // Ensure Next.js dev server is reachable
  beforeAll(async () => {
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

    it('should allow toggling global active provider between MOCK and AZURE and reject invalid values', async () => {
      // 1. Toggle active provider to MOCK
      const mockRes = await testFetch(`${BASE_URL}/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activeProvider: 'MOCK' })
      });
      expect(mockRes.status).toBe(200);
      const mockData = await mockRes.json();
      expect(mockData.success).toBe(true);
      expect(mockData.settings.activeProvider).toBe('MOCK');

      // Verify GET returns MOCK
      const getMockRes = await testFetch(`${BASE_URL}/api/settings`);
      expect((await getMockRes.json()).settings.activeProvider).toBe('MOCK');

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

      // 3. Try setting an invalid active provider (should fail with 400)
      const invalidRes = await testFetch(`${BASE_URL}/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activeProvider: 'SMTP' })
      });
      expect(invalidRes.status).toBe(400);
      const invalidData = await invalidRes.json();
      expect(invalidData.error).toContain('Only AZURE or MOCK delivery providers are supported.');
    });

    it('should test SMTP authentication logging', async () => {
      const payload = {
        smtpHost: 'smtp.sendgrid.net',
        smtpPort: '587',
        smtpUser: 'apikey',
        smtpPass: 'SG.placeholder'
      };
      const testRes = await testFetch(`${BASE_URL}/api/settings/test-smtp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      expect(testRes.status).toBe(200);
      const testData = await testRes.json();
      expect(testData).toHaveProperty('success');
      expect(Array.isArray(testData.logs)).toBe(true);
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
        emailAddress: `test-sender-${Date.now()}@arcreach-test.io`,
        name: 'Test Outbound Sender',
        provider: 'Google Workspace',
        minuteLimit: 5,
        hourlyLimit: 100,
        dailyLimit: 500,
        warmupEnabled: false
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
      createdAccountId = created.id;

      // Update limits and reputation status
      const updatePayload = {
        id: createdAccountId,
        name: 'Updated Test Sender',
        warmupEnabled: true,
        minuteLimit: 10
      };
      const updateRes = await testFetch(`${BASE_URL}/api/accounts`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatePayload)
      });
      expect(updateRes.status).toBe(200);
      const updated = await updateRes.json();
      expect(updated.warmupEnabled).toBe(true);

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
      expect(Array.isArray(verification.verifiedLeads)).toBe(true);

      // Delete Lead
      const deleteRes = await testFetch(`${BASE_URL}/api/leads?id=${createdLeadId}`, {
        method: 'DELETE'
      });
      expect(deleteRes.status).toBe(200);
    });
  });

  describe('Campaigns & Sequence Steps Lifecycle API', () => {
    let createdAccountId: string;
    let createdCampaignId: string;

    // Create a temporary sender account since campaigns require a linked account
    beforeAll(async () => {
      const senderPayload = {
        emailAddress: `campaign-sender-${Date.now()}@arcreach-test.io`,
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
      const replies = await res.json();
      expect(Array.isArray(replies)).toBe(true);
    }, 60000);
  });
});
