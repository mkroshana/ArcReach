import { PrismaClient, type Prisma } from '@prisma/client';
import { hashPassword } from '@/lib/auth';
import { MAILBOX_SECRET_OMIT } from '@/lib/mailboxSecrets';
import { stepMetrics } from '@/lib/engagementMetrics';

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
  // Automatic dev seeding is skipped in production
  if (process.env.NODE_ENV !== 'production') {
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
   * response per request). Four groupBy queries total, regardless of volume.
   * Step sends count as on the campaign page (lib/engagementMetrics).
   */
  async getCampaigns(userId: string, role: string) {
    await ensureInit();
    const campaigns = await prisma.campaign.findMany({
      where: role === 'ADMIN' ? undefined : { userId },
      include: {
        senderAccount: { omit: MAILBOX_SECRET_OMIT },
        senders: { include: { senderAccount: { omit: MAILBOX_SECRET_OMIT } } },
        user: { select: { id: true, name: true, email: true } },
        steps: { orderBy: { stepOrder: 'asc' } },
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
      stepMetrics(prisma, ids),
    ]);

    return campaigns.map((c) => {
      const enrollments = enrollByStatus.filter((e) => e.campaignId === c.id);
      const stepStats = c.steps.map((s) => {
        const active = activeByStep.find((a) => a.campaignId === c.id && a.currentSequenceStep === s.stepOrder)?._count.id || 0;
        const { sent, delivered, failed } = stepCounts(c.id, s.stepOrder);
        return { stepOrder: s.stepOrder, active, sent, delivered, failed };
      });
      return {
        ...c,
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
   */
  async setUserDisabled(id: string, disabled: boolean, client: Prisma.TransactionClient = prisma) {
    await ensureInit();
    return client.user.update({
      where: { id },
      data: disabled ? { disabledAt: new Date(), tokenVersion: { increment: 1 } } : { disabledAt: null },
      select: { id: true, email: true, name: true, role: true, createdAt: true, disabledAt: true }
    });
  },

  async deleteUser(id: string, client: Prisma.TransactionClient = prisma) {
    await ensureInit();
    return client.user.delete({
      where: { id }
    });
  }
};

