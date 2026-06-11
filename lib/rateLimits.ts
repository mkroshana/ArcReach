import { prisma } from './db';

export async function checkGlobalRateLimits(): Promise<{ allowed: boolean; reason?: string }> {
  try {
    const settings = await prisma.globalSettings.findFirst();
    if (!settings) {
      return { allowed: true };
    }

    const { rateLimitMinute, rateLimitHour } = settings;

    // If limits are not defined, allow sending
    if (!rateLimitMinute && !rateLimitHour) {
      return { allowed: true };
    }

    const now = new Date();

    // 1. Check Requests Per Minute (RPM)
    if (rateLimitMinute && rateLimitMinute > 0) {
      const oneMinuteAgo = new Date(now.getTime() - 60000);
      const sentLastMinute = await prisma.emailDispatch.count({
        where: {
          sentAt: { gte: oneMinuteAgo }
        }
      });

      if (sentLastMinute >= rateLimitMinute) {
        return {
          allowed: false,
          reason: `Global outbound rate limit reached: Max ${rateLimitMinute} emails per minute (Sent: ${sentLastMinute}).`
        };
      }
    }

    // 2. Check Requests Per Hour (RPH)
    if (rateLimitHour && rateLimitHour > 0) {
      const oneHourAgo = new Date(now.getTime() - 3600000);
      const sentLastHour = await prisma.emailDispatch.count({
        where: {
          sentAt: { gte: oneHourAgo }
        }
      });

      if (sentLastHour >= rateLimitHour) {
        return {
          allowed: false,
          reason: `Global outbound rate limit reached: Max ${rateLimitHour} emails per hour (Sent: ${sentLastHour}).`
        };
      }
    }

    return { allowed: true };
  } catch (err: any) {
    console.error('[Rate Limits] Error checking global rate limits:', err);
    // In case of database error, fail-safe to block sending rather than spamming
    return { allowed: false, reason: 'Database error while checking global rate limits.' };
  }
}
