import { prisma } from '../lib/db';

async function run() {
  try {
    const accounts = await prisma.senderAccount.findMany({
      where: {
        status: 'Active',
        imapHost: { not: null },
        imapPass: { not: null }
      }
    });
    console.log(`Found ${accounts.length} active IMAP accounts:`);
    for (const acc of accounts) {
      console.log(`- ${acc.emailAddress} (${acc.imapHost}:${acc.imapPort})`);
    }
  } catch (err) {
    console.error(err);
  } finally {
    await prisma.$disconnect();
  }
}
run();
