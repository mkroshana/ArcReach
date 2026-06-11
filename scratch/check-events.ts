import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const dispatches = await prisma.emailDispatch.findMany({
    select: {
      id: true,
      leadId: true,
      campaignId: true,
      messageId: true,
      sentAt: true,
      subject: true,
    },
    orderBy: { sentAt: 'desc' },
  });

  console.log('--- ALL DISPATCHES ---');
  console.dir(dispatches, { depth: null });
}

main().catch(console.error);
