import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkGlobalRateLimits } from '../../lib/rateLimits';
import { prisma } from '../../lib/db';

vi.mock('../../lib/db', () => {
  return {
    prisma: {
      globalSettings: {
        findFirst: vi.fn(),
      },
      emailDispatch: {
        count: vi.fn(),
      },
    },
  };
});

describe('checkGlobalRateLimits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should allow sending when global settings are not found', async () => {
    vi.mocked(prisma.globalSettings.findFirst).mockResolvedValue(null);

    const result = await checkGlobalRateLimits();
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('should allow sending when limits are not configured', async () => {
    vi.mocked(prisma.globalSettings.findFirst).mockResolvedValue({
      id: 'settings-id',
      activeProvider: 'AZURE',
      azureConnString: null,
      azureSenderDomain: null,
      azureSenderDomains: null,
      smtpHost: null,
      smtpPort: null,
      smtpUser: null,
      smtpPass: null,
      imapHost: null,
      imapPort: null,
      imapUser: null,
      imapPass: null,
      rateLimitMinute: null,
      rateLimitHour: null,
      updatedAt: new Date(),
    });

    const result = await checkGlobalRateLimits();
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('should restrict sending when global minute limit is exceeded', async () => {
    vi.mocked(prisma.globalSettings.findFirst).mockResolvedValue({
      id: 'settings-id',
      activeProvider: 'AZURE',
      azureConnString: 'something',
      azureSenderDomain: 'something',
      azureSenderDomains: ['something'],
      smtpHost: null,
      smtpPort: null,
      smtpUser: null,
      smtpPass: null,
      imapHost: null,
      imapPort: null,
      imapUser: null,
      imapPass: null,
      rateLimitMinute: 5,
      rateLimitHour: 100,
      updatedAt: new Date(),
    });

    // Mock count for minute check
    vi.mocked(prisma.emailDispatch.count).mockResolvedValue(5);

    const result = await checkGlobalRateLimits();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Global outbound rate limit reached: Max 5 emails per minute');
  });

  it('should restrict sending when global hourly limit is exceeded', async () => {
    vi.mocked(prisma.globalSettings.findFirst).mockResolvedValue({
      id: 'settings-id',
      activeProvider: 'AZURE',
      azureConnString: 'something',
      azureSenderDomain: 'something',
      azureSenderDomains: ['something'],
      smtpHost: null,
      smtpPort: null,
      smtpUser: null,
      smtpPass: null,
      imapHost: null,
      imapPort: null,
      imapUser: null,
      imapPass: null,
      rateLimitMinute: 10,
      rateLimitHour: 50,
      updatedAt: new Date(),
    });

    // First call (minute check): under limit
    // Second call (hourly check): at/over limit
    vi.mocked(prisma.emailDispatch.count)
      .mockResolvedValueOnce(2)   // sentLastMinute
      .mockResolvedValueOnce(50); // sentLastHour

    const result = await checkGlobalRateLimits();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Global outbound rate limit reached: Max 50 emails per hour');
  });

  it('should allow sending when all limits are within boundaries', async () => {
    vi.mocked(prisma.globalSettings.findFirst).mockResolvedValue({
      id: 'settings-id',
      activeProvider: 'AZURE',
      azureConnString: 'something',
      azureSenderDomain: 'something',
      azureSenderDomains: ['something'],
      smtpHost: null,
      smtpPort: null,
      smtpUser: null,
      smtpPass: null,
      imapHost: null,
      imapPort: null,
      imapUser: null,
      imapPass: null,
      rateLimitMinute: 10,
      rateLimitHour: 50,
      updatedAt: new Date(),
    });

    vi.mocked(prisma.emailDispatch.count)
      .mockResolvedValueOnce(2)   // sentLastMinute
      .mockResolvedValueOnce(20); // sentLastHour

    const result = await checkGlobalRateLimits();
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('should restrict sending and log error on database failure', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(prisma.globalSettings.findFirst).mockRejectedValue(new Error('DB Connection Failed'));

    const result = await checkGlobalRateLimits();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Database error while checking global rate limits');
    consoleErrorSpy.mockRestore();
  });
});
