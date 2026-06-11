import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const settings = await prisma.globalSettings.findFirst();
  console.log('--- GLOBAL SETTINGS ---');
  console.dir(settings, { depth: null });
}

main().catch(console.error);
