import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

let initialized = false;

async function ensureDefaultUsers() {
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
        passwordHash: 'dummy-hash',
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
        passwordHash: 'dummy-hash',
        role: 'USER'
      }
    });
  }
}

async function ensureInit() {
  if (initialized) return;
  try {
    await ensureDefaultUsers();
    initialized = true;
  } catch (error) {
    console.error('Failed to initialize default users:', error);
  }
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

  async getCampaigns(userId: string, role: string) {
    await ensureInit();
    if (role === 'ADMIN') {
      return prisma.campaign.findMany({
        include: { senderAccount: true },
        orderBy: { createdAt: 'desc' }
      });
    }
    return prisma.campaign.findMany({
      where: { userId },
      include: { senderAccount: true },
      orderBy: { createdAt: 'desc' }
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

  async createUser(data: { name: string; email: string; role: 'ADMIN' | 'USER' }) {
    await ensureInit();
    return prisma.user.create({
      data: {
        ...data,
        passwordHash: 'dummy-hash'
      }
    });
  },

  async updateUserRole(id: string, role: 'ADMIN' | 'USER') {
    await ensureInit();
    return prisma.user.update({
      where: { id },
      data: { role }
    });
  },

  async deleteUser(id: string) {
    await ensureInit();
    return prisma.user.delete({
      where: { id }
    });
  }
};

