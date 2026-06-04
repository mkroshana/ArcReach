import { describe, it, expect, beforeAll } from 'vitest';

const BASE_URL = 'http://localhost:3000';

describe('ArcReach Live API Integration Tests', () => {
  
  // Ensure the Next.js dev server is reachable
  beforeAll(async () => {
    try {
      await fetch(`${BASE_URL}/api/system-status`);
    } catch (e) {
      throw new Error(`The local Next.js server is not running on ${BASE_URL}. Please start it using 'npm run dev' before running integration tests.`);
    }
  });

  describe('GET /api/system-status', () => {
    it('should return 200 and have the correct system metrics schema', async () => {
      const res = await fetch(`${BASE_URL}/api/system-status`);
      expect(res.status).toBe(200);
      
      const data = await res.json();
      expect(data).toHaveProperty('database');
      expect(data).toHaveProperty('deliveryStatus');
      expect(data).toHaveProperty('smtpConfigured');
      expect(data).toHaveProperty('accountsCount');
      expect(data).toHaveProperty('activeCampaignsCount');
      expect(data).toHaveProperty('leadsCount');
      
      expect(['OPERATIONAL', 'STANDBY', 'INACTIVE']).toContain(data.deliveryStatus);
      expect(typeof data.smtpConfigured).toBe('boolean');
      expect(typeof data.accountsCount).toBe('number');
      expect(typeof data.activeCampaignsCount).toBe('number');
      expect(typeof data.leadsCount).toBe('number');
    });
  });

  describe('GET /api/dashboard-stats', () => {
    it('should return 200 and return analytics counters and weekly buckets', async () => {
      const res = await fetch(`${BASE_URL}/api/dashboard-stats`);
      expect(res.status).toBe(200);
      
      const data = await res.json();
      expect(data).toHaveProperty('stats');
      expect(data).toHaveProperty('trends');
      
      expect(data.stats).toHaveProperty('totalSent');
      expect(data.stats).toHaveProperty('totalReplies');
      expect(data.stats).toHaveProperty('averageOpenRate');
      expect(data.stats).toHaveProperty('averageClickRate');
      
      expect(Array.isArray(data.trends)).toBe(true);
      if (data.trends.length > 0) {
        const item = data.trends[0];
        expect(item).toHaveProperty('name');
        expect(item).toHaveProperty('sent');
        expect(item).toHaveProperty('opens');
        expect(item).toHaveProperty('clicks');
      }
    });
  });

  describe('Templates CRUD Lifecycle API', () => {
    let createdTemplateId: string;

    it('should retrieve templates list with seeded items', async () => {
      const res = await fetch(`${BASE_URL}/api/templates`);
      expect(res.status).toBe(200);
      
      const templates = await res.json();
      expect(Array.isArray(templates)).toBe(true);
      expect(templates.length).toBeGreaterThan(0);
      
      // Look for default seeded templates keys
      const sample = templates[0];
      expect(sample).toHaveProperty('id');
      expect(sample).toHaveProperty('name');
      expect(sample).toHaveProperty('subject');
      expect(sample).toHaveProperty('body');
      expect(sample).toHaveProperty('category');
    });

    it('should successfully create a new template (POST)', async () => {
      const payload = {
        name: 'Automated Test Template',
        subject: 'Vitest Test Subject line',
        body: 'Hello {{firstName}}, this is a test from Vitest framework.',
        category: 'Cold Outreach'
      };

      const res = await fetch(`${BASE_URL}/api/templates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      expect(res.status).toBe(200);

      const created = await res.json();
      expect(created).toHaveProperty('id');
      expect(created.name).toBe(payload.name);
      expect(created.subject).toBe(payload.subject);
      expect(created.body).toBe(payload.body);
      expect(created.category).toBe(payload.category);

      createdTemplateId = created.id; // Save for updates and deletion
    });

    it('should successfully update an existing template (PUT)', async () => {
      expect(createdTemplateId).toBeDefined();

      const payload = {
        id: createdTemplateId,
        name: 'Updated Test Template',
        subject: 'Updated Subject Line',
        body: 'Hello {{firstName}}, updated test body.',
        category: 'Follow Up'
      };

      const res = await fetch(`${BASE_URL}/api/templates`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      expect(res.status).toBe(200);

      const updated = await res.json();
      expect(updated.id).toBe(createdTemplateId);
      expect(updated.name).toBe(payload.name);
      expect(updated.subject).toBe(payload.subject);
      expect(updated.category).toBe(payload.category);
    });

    it('should successfully delete the template (DELETE)', async () => {
      expect(createdTemplateId).toBeDefined();

      const res = await fetch(`${BASE_URL}/api/templates?id=${createdTemplateId}`, {
        method: 'DELETE'
      });
      expect(res.status).toBe(200);

      const result = await res.json();
      expect(result.success).toBe(true);

      // Verify template no longer exists in list
      const listRes = await fetch(`${BASE_URL}/api/templates`);
      const templates = await listRes.json();
      const match = templates.find((t: any) => t.id === createdTemplateId);
      expect(match).toBeUndefined();
    });
  });
});
