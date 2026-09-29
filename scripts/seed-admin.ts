import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../lib/auth';

const prisma = new PrismaClient();

async function main() {
  const email = process.env.ADMIN_EMAIL || 'admin@arcreach.com';
  const password = process.env.ADMIN_PASSWORD || 'securepassword123';
  const name = process.env.ADMIN_NAME || 'ArcReach Admin';

  console.log(`[Seed] Checking if admin user "${email}" exists...`);
  
  const existingUser = await prisma.user.findUnique({
    where: { email }
  });

  if (existingUser) {
    console.log(`[Seed] Admin user "${email}" already exists. Updating password and ensuring ADMIN role...`);
    if (existingUser.disabledAt) {
      console.log(`[Seed] Admin user "${email}" was disabled. Enabling it again...`);
    }
    await prisma.user.update({
      where: { email },
      data: {
        name,
        passwordHash: hashPassword(password),
        role: 'ADMIN',
        disabledAt: null,
        // A reset password ends every session signed before it, as in the app's own password changes
        tokenVersion: { increment: 1 }
      }
    });
  } else {
    console.log(`[Seed] Creating new admin user "${email}"...`);
    await prisma.user.create({
      data: {
        email,
        name,
        passwordHash: hashPassword(password),
        role: 'ADMIN'
      }
    });
  }
  
  console.log('[Seed] Admin user seeded successfully.');
}

main()
  .catch((e) => {
    console.error('[Seed] Error during seeding:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
