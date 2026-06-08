import { syncMailboxReplies } from '../lib/imapService';
import { prisma } from '../lib/db';

async function test() {
  console.log('Starting IMAP sync test...');
  try {
    const res = await syncMailboxReplies('556d2347-de42-42d7-ae93-d4c7a699c6c6');
    console.log('Sync result:', res);
  } catch (err) {
    console.error('Error during sync test:', err);
  } finally {
    await prisma.$disconnect();
  }
}

test();
