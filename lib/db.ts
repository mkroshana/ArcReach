import { PrismaClient, type Prisma } from '@prisma/client';
import { hashPassword } from '@/lib/auth';
import { stepMetrics } from '@/lib/engagementMetrics';
import { devSeedRefusal } from '@/lib/devSeed';
import type { PauseReason } from '@/lib/campaignPause';
import { hasSendingSchedule } from '@/lib/sendSchedule';

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

let initialized = false;

export async function ensureDefaultUsers() {
  // Check if admin exists
  const adminExists = await prisma.user.findUnique({
    where: { email: 'admin@arcreach.com' }
  });
  if (!adminExists) {
    await prisma.user.create({
      data: {
        id: 'admin-id-999',
        email: 'admin@arcreach.com',
        name: 'ArcReach Admin',
        passwordHash: await hashPassword(process.env.ADMIN_PASSWORD || 'securepassword123'),
        role: 'ADMIN'
      }
    });
  }

  // Check if standard user exists
  const userExists = await prisma.user.findUnique({
    where: { email: 'mkroshana@gmail.com' }
  });
  if (!userExists) {
    await prisma.user.create({
      data: {
        id: 'user-id-111',
        email: 'mkroshana@gmail.com',
        name: 'Standard Marketer',
        passwordHash: await hashPassword(process.env.DEMO_USER_PASSWORD || 'securepassword123'),
        role: 'USER'
      }
    });
  }
}

async function ensureInit() {
  if (initialized) return;
  // Automatic dev seeding runs only outside production and against a local or test database,
  // so `npm run dev` pointed at a shared database never adds users with the default password.
  if (!devSeedRefusal(process.env)) {
    try {
      await ensureDefaultUsers();
    } catch (error) {
      console.error('Failed to initialize default users:', error);
    }
  }
  initialized = true;
}

export const db = {
  async getAccounts(userId: string, role: string) {
    await ensureInit();
    if (role === 'ADMIN') {
      return prisma.senderAccount.findMany({
        orderBy: { emailAddress: 'asc' }
      });
    }
    return prisma.senderAccount.findMany({
      where: { userId },
      orderBy: { emailAddress: 'asc' }
    });
  },

  async createAccount(data: any) {
    await ensureInit();
    return prisma.senderAccount.create({
      data
    });
  },

  async updateAccount(id: string, updates: any) {
    await ensureInit();
    return prisma.senderAccount.update({
      where: { id },
      data: updates
    });
  },

  async deleteAccount(id: string) {
    await ensureInit();
    return prisma.senderAccount.delete({
      where: { id }
    });
  },

  /**
   * Campaign list with per-step/per-campaign stats computed via DB aggregation.
   * Never ships raw enrollment/dispatch rows — with tens of thousands of rows
   * those payloads OOM'd the server (Prisma JSON.parse of a multi-MB engine
   * response per request). Five groupBy queries and one grouped lead count
   * total, regardless of volume.
   * Step sends count as on the campaign page (lib/engagementMetrics), with
   * the leads each step reached, which its Progress counts, and how many of
   * its emails a delivery report arrived for: with none, Delivered is unknown.
   * Selects only what the campaigns list shows: step bodies, the sender pool
   * and mailbox rows stay with the campaign page, which loads one campaign.
   */
  async getCampaigns(userId: string, role: string) {
    await ensureInit();
    const campaigns = await prisma.campaign.findMany({
      where: role === 'ADMIN' ? undefined : { userId },
      select: {
        id: true,
        name: true,
        status: true,
        pausedUntil: true,
        pauseReason: true,
        stoppedAt: true,
        timezone: true,
        sendSchedule: true,
        userId: true,
        createdAt: true,
        senderAccount: { select: { emailAddress: true } },
        user: { select: { id: true, name: true, email: true } },
        steps: { orderBy: { stepOrder: 'asc' }, select: { id: true, stepOrder: true, waitDays: true, subject: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (campaigns.length === 0) return campaigns;
    const ids = campaigns.map((c) => c.id);

    const [enrollByStatus, activeByStep, stepCounts] = await Promise.all([
      prisma.campaignEnrollment.groupBy({
        by: ['campaignId', 'status'],
        where: { campaignId: { in: ids } },
        _count: { id: true },
      }),
      prisma.campaignEnrollment.groupBy({
        by: ['campaignId', 'currentSequenceStep'],
        where: { campaignId: { in: ids }, status: 'Active' },
        _count: { id: true },
      }),
      stepMetrics(prisma, ids, { leads: true, reports: true }),
    ]);

    return campaigns.map(({ timezone, sendSchedule, ...c }) => {
      const enrollments = enrollByStatus.filter((e) => e.campaignId === c.id);
      const stepStats = c.steps.map((s) => {
        const active = activeByStep.find((a) => a.campaignId === c.id && a.currentSequenceStep === s.stepOrder)?._count.id || 0;
        const { sent, delivered, reported, failed, leads } = stepCounts(c.id, s.stepOrder);
        return { stepOrder: s.stepOrder, active, sent, delivered, reported, failed, leads };
      });
      return {
        ...c,
        // Only whether the saved window is complete, not the window: without
        // one the auto-resume sets the campaign to Draft instead of Active.
        hasSendingSchedule: hasSendingSchedule(timezone, sendSchedule),
        stepStats,
        enrollmentSummary: {
          total: enrollments.reduce((n, e) => n + e._count.id, 0),
          active: enrollments.find((e) => e.status === 'Active')?._count.id || 0,
          completed: enrollments.find((e) => e.status === 'Completed')?._count.id || 0,
        },
      };
    });
  },

  async createCampaign(data: any) {
    await ensureInit();
    return prisma.campaign.create({
      data
    });
  },

  async updateCampaign(id: string, updates: any) {
    await ensureInit();
    return prisma.campaign.update({
      where: { id },
      data: updates
    });
  },

  async deleteCampaign(id: string) {
    await ensureInit();
    return prisma.campaign.delete({
      where: { id }
    });
  },

  async getUsers() {
    await ensureInit();
    return prisma.user.findMany({
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        createdAt: true,
        disabledAt: true
      },
      orderBy: { createdAt: 'desc' }
    });
  },

  async createUser(data: { name: string; email: string; role: 'ADMIN' | 'USER'; password: string }) {
    await ensureInit();
    return prisma.user.create({
      data: {
        name: data.name,
        email: data.email,
        role: data.role,
        passwordHash: await hashPassword(data.password)
      },
      // Never return the password hash to the client.
      select: { id: true, email: true, name: true, role: true, createdAt: true }
    });
  },

  async updateUserRole(id: string, role: 'ADMIN' | 'USER', client: Prisma.TransactionClient = prisma) {
    await ensureInit();
    return client.user.update({
      where: { id },
      // Bumping tokenVersion ends the user's sessions, so they sign in again under the new role.
      data: { role, tokenVersion: { increment: 1 } },
      select: { id: true, email: true, name: true, role: true, createdAt: true }
    });
  },

  async updateUserPassword(id: string, password: string) {
    await ensureInit();
    return prisma.user.update({
      where: { id },
      // Bumping tokenVersion ends every session signed in with the old password.
      data: { passwordHash: await hashPassword(password), tokenVersion: { increment: 1 } },
      select: { id: true, email: true, name: true, role: true, createdAt: true, tokenVersion: true }
    });
  },

  /**
   * Disables (sign-in refused, every session ended by bumping tokenVersion) or re-enables user `id`.
   * Re-enabling leaves tokenVersion alone, so sessions from before the disable stay dead.
   * Disabling also stops the user's campaigns, so run it in a transaction: it first clears the
   * auto-resume time of each campaign the send engine paused, so no timer can make it Active
   * again, then pauses every Active campaign, both recorded as 'owner_disabled'. Drafts stay
   * Draft, and re-enabling resumes nothing: an admin or the owner activates the campaigns again.
   * `pausedCampaigns` counts the Active campaigns the disable paused.
   */
  async setUserDisabled(id: string, disabled: boolean, client: Prisma.TransactionClient = prisma) {
    await ensureInit();
    const user = await client.user.update({
      where: { id },
      data: disabled ? { disabledAt: new Date(), tokenVersion: { increment: 1 } } : { disabledAt: null },
      select: { id: true, email: true, name: true, role: true, createdAt: true, disabledAt: true }
    });
    if (!disabled) return user;
    const pauseReason: PauseReason = 'owner_disabled';
    await client.campaign.updateMany({
      where: { userId: id, status: 'Paused', pausedUntil: { not: null } },
      data: { pausedUntil: null, pauseReason }
    });
    const { count } = await client.campaign.updateMany({
      where: { userId: id, status: 'Active' },
      data: { status: 'Paused', pausedUntil: null, pauseReason }
    });
    return { ...user, pausedCampaigns: count };
  },

  async deleteUser(id: string, client: Prisma.TransactionClient = prisma) {
    await ensureInit();
    return client.user.delete({
      where: { id }
    });
  }
};

