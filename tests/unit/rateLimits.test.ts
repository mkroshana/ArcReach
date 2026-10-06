import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkGlobalRateLimits, getGlobalDailyAllowance } from '../../lib/rateLimits';
import { prisma } from '../../lib/db';

vi.mock('../../lib/db', () => {
  return {
    prisma: {
      globalSettings: {
        findUnique: vi.fn(),
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
    vi.mocked(prisma.globalSettings.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.globalSettings.findFirst).mockResolvedValue(null);

    const result = await checkGlobalRateLimits();
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('should allow sending when limits are not configured', async () => {
    vi.mocked(prisma.globalSettings.findUnique).mockResolvedValue({
      id: 'global',
      activeProvider: 'AZURE',
      azureConnString: null,
      azureSenderDomain: null,
      azureSenderDomains: null,
      rateLimitMinute: null,
      rateLimitHour: null,
      updatedAt: new Date(),
    });

    const result = await checkGlobalRateLimits();
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('should restrict sending when global minute limit is exceeded', async () => {
    vi.mocked(prisma.globalSettings.findUnique).mockResolvedValue({
      id: 'global',
      activeProvider: 'AZURE',
      azureConnString: 'something',
      azureSenderDomain: 'something',
      azureSenderDomains: ['something'],
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
    vi.mocked(prisma.globalSettings.findUnique).mockResolvedValue({
      id: 'global',
      activeProvider: 'AZURE',
      azureConnString: 'something',
      azureSenderDomain: 'something',
      azureSenderDomains: ['something'],
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
    vi.mocked(prisma.globalSettings.findUnique).mockResolvedValue({
      id: 'global',
      activeProvider: 'AZURE',
      azureConnString: 'something',
      azureSenderDomain: 'something',
      azureSenderDomains: ['something'],
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
    vi.mocked(prisma.globalSettings.findUnique).mockRejectedValue(new Error('DB Connection Failed'));

    const result = await checkGlobalRateLimits();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Database error while checking global rate limits');
    consoleErrorSpy.mockRestore();
  });
});

describe('getGlobalDailyAllowance', () => {
  const NOW = new Date('2026-10-06T12:00:00Z');
  const settings = (rateLimitMinute: number | null, rateLimitHour: number | null) => ({
    id: 'global', activeProvider: 'AZURE', azureConnString: null, azureSenderDomain: null, azureSenderDomains: null,
    rateLimitMinute, rateLimitHour, updatedAt: new Date(),
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is 24 times the hourly limit, less every dispatch of the last 24 hours', async () => {
    vi.mocked(prisma.globalSettings.findUnique).mockResolvedValue(settings(80, 800));
    vi.mocked(prisma.emailDispatch.count).mockResolvedValue(6);

    expect(await getGlobalDailyAllowance(NOW)).toEqual({ limit: 19200, per: 'hour', sent: 6, remaining: 19194 });
    // Counted as the hourly and per-minute checks count: any mailbox, any outcome.
    expect(prisma.emailDispatch.count).toHaveBeenCalledWith({ where: { sentAt: { gte: new Date('2026-10-05T12:00:00Z') } } });
  });

  it('is 1,440 times the per-minute limit when that allows less', async () => {
    vi.mocked(prisma.globalSettings.findUnique).mockResolvedValue(settings(10, 800));
    vi.mocked(prisma.emailDispatch.count).mockResolvedValue(0);

    expect(await getGlobalDailyAllowance(NOW)).toEqual({ limit: 14400, per: 'minute', sent: 0, remaining: 14400 });
  });

  it('never has less than nothing left', async () => {
    vi.mocked(prisma.globalSettings.findUnique).mockResolvedValue(settings(null, 20));
    vi.mocked(prisma.emailDispatch.count).mockResolvedValue(500);

    expect(await getGlobalDailyAllowance(NOW)).toEqual({ limit: 480, per: 'hour', sent: 500, remaining: 0 });
  });

  it('is null with neither limit set or no settings yet, without counting anything', async () => {
    vi.mocked(prisma.globalSettings.findUnique).mockResolvedValue(settings(null, 0));
    expect(await getGlobalDailyAllowance(NOW)).toBeNull();

    vi.mocked(prisma.globalSettings.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.globalSettings.findFirst).mockResolvedValue(null);
    expect(await getGlobalDailyAllowance(NOW)).toBeNull();
    expect(prisma.emailDispatch.count).not.toHaveBeenCalled();
  });
});
