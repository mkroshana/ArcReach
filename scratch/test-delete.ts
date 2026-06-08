import { prisma } from '../lib/db';

async function run() {
  console.log('Running delete campaign test...');
  try {
    // 1. Find or create a sender account
    let sender = await prisma.senderAccount.findFirst();
    if (!sender) {
      const user = await prisma.user.findFirst() || await prisma.user.create({
        data: {
          email: 'test-admin@arcreach.com',
          name: 'Test Admin',
          passwordHash: 'dummy',
          role: 'ADMIN'
        }
      });
      sender = await prisma.senderAccount.create({
        data: {
          emailAddress: 'test-sender@arcreach.io',
          name: 'Test Sender',
          provider: 'Custom SMTP',
          userId: user.id
        }
      });
    }

    // 2. Create a Campaign
    const campaign = await prisma.campaign.create({
      data: {
        name: 'Delete Test Campaign',
        status: 'Active',
        userId: sender.userId,
        senderAccountId: sender.id,
        audienceCohort: 'Valid'
      }
    });
    console.log('Created campaign:', campaign.id);

    // 3. Create a step
    await prisma.campaignStep.create({
      data: {
        campaignId: campaign.id,
        stepOrder: 1,
        subject: 'Subject',
        body: 'Body'
      }
    });

    // 4. Create a lead and enroll it
    const lead = await prisma.lead.findFirst() || await prisma.lead.create({
      data: {
        email: `test-lead-${Date.now()}@example.com`,
        validationStatus: 'Valid'
      }
    });

    await prisma.campaignEnrollment.create({
      data: {
        leadId: lead.id,
        campaignId: campaign.id,
        status: 'Active'
      }
    });
    console.log('Created enrollment');

    // 5. Let's delete the campaign and see what happens
    console.log('Attempting to delete campaign...');
    await prisma.campaign.delete({
      where: { id: campaign.id }
    });
    console.log('Successfully deleted campaign!');

  } catch (err: any) {
    console.error('Error occurred:', err);
  } finally {
    await prisma.$disconnect();
  }
}

run();
