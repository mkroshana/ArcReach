import { prisma } from '../lib/db';

async function run() {
  console.log('Inserting mock reply...');
  try {
    const reply = await prisma.inboundResponse.create({
      data: {
        leadId: 'ca15c371-55d3-47a8-9aa9-7d8607173f63',
        senderAccountId: '556d2347-de42-42d7-ae93-d4c7a699c6c6',
        subject: 'Re: Test',
        body: 'afsawfa',
        receivedAt: new Date(),
        unread: true
      }
    });
    console.log('Mock reply inserted:', reply);
  } catch (err) {
    console.error('Error inserting mock reply:', err);
  } finally {
    await prisma.$disconnect();
  }
}

run();
