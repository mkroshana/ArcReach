import { PrismaClient } from '@prisma/client';
import { hashPassword } from '@/lib/auth';

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
        passwordHash: hashPassword(process.env.ADMIN_PASSWORD || 'securepassword123'),
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
        passwordHash: hashPassword(process.env.DEMO_USER_PASSWORD || 'securepassword123'),
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
   */
  async getCampaigns(userId: string, role: string) {
    await ensureInit();
    const campaigns = await prisma.campaign.findMany({
      where: role === 'ADMIN' ? undefined : { userId },
      include: {
        senderAccount: true,
        senders: { include: { senderAccount: true } },
        user: { select: { id: true, name: true, email: true } },
        steps: { orderBy: { stepOrder: 'asc' } },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (campaigns.length === 0) return campaigns;
    const ids = campaigns.map((c) => c.id);

    const [enrollByStatus, activeByStep, dispatchByStep, deliveredByStep] = await Promise.all([
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
      prisma.emailDispatch.groupBy({
        by: ['campaignId', 'stepOrder', 'status'],
        where: { campaignId: { in: ids }, stepOrder: { not: null } },
        _count: { id: true },
      }),
      prisma.emailDispatch.groupBy({
        by: ['campaignId', 'stepOrder'],
        where: { campaignId: { in: ids }, stepOrder: { not: null }, status: 'Sent', deliveredAt: { not: null } },
        _count: { id: true },
      }),
    ]);

    return campaigns.map((c) => {
      const enrollments = enrollByStatus.filter((e) => e.campaignId === c.id);
      const stepStats = c.steps.map((s) => {
        const active = activeByStep.find((a) => a.campaignId === c.id && a.currentSequenceStep === s.stepOrder)?._count.id || 0;
        const sent = dispatchByStep.find((d) => d.campaignId === c.id && d.stepOrder === s.stepOrder && d.status === 'Sent')?._count.id || 0;
        const failed = dispatchByStep.find((d) => d.campaignId === c.id && d.stepOrder === s.stepOrder && d.status === 'Failed')?._count.id || 0;
        const delivered = deliveredByStep.find((d) => d.campaignId === c.id && d.stepOrder === s.stepOrder)?._count.id || 0;
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
        createdAt: true
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
        passwordHash: hashPassword(data.password)
      },
      // Never return the password hash to the client.
      select: { id: true, email: true, name: true, role: true, createdAt: true }
    });
  },

  async updateUserRole(id: string, role: 'ADMIN' | 'USER') {
    await ensureInit();
    return prisma.user.update({
      where: { id },
      data: { role },
      select: { id: true, email: true, name: true, role: true, createdAt: true }
    });
  },

  async updateUserPassword(id: string, password: string) {
    await ensureInit();
    return prisma.user.update({
      where: { id },
      data: { passwordHash: hashPassword(password) },
      select: { id: true, email: true, name: true, role: true, createdAt: true }
    });
  },

  async deleteUser(id: string) {
    await ensureInit();
    return prisma.user.delete({
      where: { id }
    });
  }
};

