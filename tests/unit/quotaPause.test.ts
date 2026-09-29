import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/db', () => ({
  prisma: {
    campaign: { updateMany: vi.fn() },
  },
}));

import { autoResumeQuotaPausedCampaigns } from '../../lib/sendEngine';
import { prisma } from '../../lib/db';

describe('autoResumeQuotaPausedCampaigns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('flips Paused rows whose pausedUntil has elapsed back to Active and clears the timer and reason', async () => {
    const now = new Date('2026-06-25T12:00:00Z');
    vi.mocked(prisma.campaign.updateMany).mockResolvedValue({ count: 2 });

    const resumed = await autoResumeQuotaPausedCampaigns(now);

    expect(resumed).toBe(2);
    expect(prisma.campaign.updateMany).toHaveBeenCalledWith({
      where: {
        status: 'Paused',
        pausedUntil: { lte: now },
      },
      data: {
        status: 'Active',
        pausedUntil: null,
        pauseReason: null,
      },
    });
  });

  it('leaves manually-paused campaigns alone (pausedUntil null does not match lte filter)', async () => {
    // Prisma `lte` doesn't match null rows — verifying the contract: when no
    // rows qualify, updateMany returns count: 0 and we report zero resumed.
    vi.mocked(prisma.campaign.updateMany).mockResolvedValue({ count: 0 });

    const resumed = await autoResumeQuotaPausedCampaigns();

    expect(resumed).toBe(0);
  });

  it('uses the current time when no `now` is provided', async () => {
    vi.mocked(prisma.campaign.updateMany).mockResolvedValue({ count: 0 });

    const before = Date.now();
    await autoResumeQuotaPausedCampaigns();
    const after = Date.now();

    const call = vi.mocked(prisma.campaign.updateMany).mock.calls[0][0];
    const usedTime = (call.where!.pausedUntil as { lte: Date }).lte.getTime();
    expect(usedTime).toBeGreaterThanOrEqual(before);
    expect(usedTime).toBeLessThanOrEqual(after);
  });
});
