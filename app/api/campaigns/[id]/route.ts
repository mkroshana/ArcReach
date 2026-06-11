import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSession();
    const { id } = await params;

    const campaign = await prisma.campaign.findUnique({
      where: { id },
      include: {
        steps: {
          orderBy: { stepOrder: 'asc' }
        },
        senderAccount: true
      }
    });

    if (!campaign) {
      return NextResponse.json({ error: 'Campaign not found.' }, { status: 404 });
    }

    if (session.role !== 'ADMIN' && campaign.userId !== session.id) {
      return NextResponse.json({ error: 'Unauthorized access to this campaign.' }, { status: 403 });
    }

    // Calculate real campaign telemetry metrics
    let enrollmentsCount = await prisma.campaignEnrollment.count({
      where: { campaignId: id }
    });

    // Auto-migrate: if no enrollments exist, populate with eligible leads matching selected cohort
    if (enrollmentsCount === 0) {
      const selectedCohort = campaign.audienceCohort || 'Valid';
      const eligibleLeads = await prisma.lead.findMany({
        where: {
          validationStatus: selectedCohort === 'Unverified' ? 'Unverified' : 'Valid'
        }
      });
      if (eligibleLeads.length > 0) {
        await prisma.campaignEnrollment.createMany({
          data: eligibleLeads.map(lead => ({
            leadId: lead.id,
            campaignId: id,
            status: 'Active',
            currentSequenceStep: 1,
            nextActionDate: new Date()
          })),
          skipDuplicates: true
        });
        enrollmentsCount = await prisma.campaignEnrollment.count({
          where: { campaignId: id }
        });
      }
    }

    const sentCount = await prisma.emailDispatch.count({
      where: { campaignId: id }
    });

    const opensCount = await prisma.emailDispatch.count({
      where: {
        campaignId: id,
        events: {
          some: { eventType: 'open' }
        }
      }
    });

    const clicksCount = await prisma.emailDispatch.count({
      where: {
        campaignId: id,
        events: {
          some: { eventType: 'click' }
        }
      }
    });

    const repliesCount = await prisma.inboundResponse.count({
      where: { campaignId: id }
    });

    const validLeadsCount = await prisma.lead.count({
      where: { validationStatus: 'Valid' }
    });

    const unverifiedLeadsCount = await prisma.lead.count({
      where: { validationStatus: 'Unverified' }
    });

    const telemetry = {
      enrollments: enrollmentsCount,
      validLeadsCount,
      unverifiedLeadsCount,
      sent: sentCount,
      opens: opensCount,
      clicks: clicksCount,
      replies: repliesCount,
      openRate: sentCount > 0 ? Number(((opensCount / sentCount) * 100).toFixed(1)) : 0,
      clickRate: sentCount > 0 ? Number(((clicksCount / sentCount) * 100).toFixed(1)) : 0,
      replyRate: sentCount > 0 ? Number(((repliesCount / sentCount) * 100).toFixed(1)) : 0
    };

    return NextResponse.json({
      ...campaign,
      telemetry
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSession();
    const { id } = await params;

    const campaign = await prisma.campaign.findUnique({
      where: { id }
    });

    if (!campaign) {
      return NextResponse.json({ error: 'Campaign not found.' }, { status: 404 });
    }

    if (session.role !== 'ADMIN' && campaign.userId !== session.id) {
      return NextResponse.json({ error: 'Unauthorized modification attempt.' }, { status: 403 });
    }

    const body = await req.json();
    const { 
      name, 
      status, 
      senderAccountId, 
      timezone, 
      sendSchedule, 
      stopOnReply, 
      trackOpens, 
      trackClicks,
      audienceCohort,
      steps 
    } = body;

    const updates: any = {};
    if (name !== undefined) updates.name = name;
    if (status !== undefined) updates.status = status;
    if (senderAccountId !== undefined) updates.senderAccountId = senderAccountId;
    if (timezone !== undefined) updates.timezone = timezone;
    if (sendSchedule !== undefined) updates.sendSchedule = sendSchedule;
    if (stopOnReply !== undefined) updates.stopOnReply = !!stopOnReply;
    if (trackOpens !== undefined) updates.trackOpens = !!trackOpens;
    if (trackClicks !== undefined) updates.trackClicks = !!trackClicks;
    if (audienceCohort !== undefined) updates.audienceCohort = audienceCohort;

    // Use a transaction to ensure atomic updates of campaign config and sequence steps
    await prisma.$transaction(async (tx) => {
      // 1. Update the campaign record
      await tx.campaign.update({
        where: { id },
        data: updates
      });

      // 2. If steps are provided, delete and recreate campaign step items
      if (steps && Array.isArray(steps)) {
        await tx.campaignStep.deleteMany({
          where: { campaignId: id }
        });

        if (steps.length > 0) {
          await tx.campaignStep.createMany({
            data: steps.map((step: any, index: number) => ({
              campaignId: id,
              stepOrder: index + 1,
              waitDays: Number(step.waitDays) || 0,
              subject: step.subject || '',
              body: step.body || '',
              isABTest: !!step.isABTest
            }))
          });
        }
      }

      // 3. Sync/enroll matching leads
      const selectedCohort = audienceCohort || campaign.audienceCohort || 'Valid';
      
      // Delete old enrollments to prevent mixing cohorts
      await tx.campaignEnrollment.deleteMany({
        where: {
          campaignId: id
        }
      });

      const eligibleLeads = await tx.lead.findMany({
        where: {
          validationStatus: selectedCohort === 'Unverified' ? 'Unverified' : 'Valid'
        }
      });

      if (eligibleLeads.length > 0) {
        await tx.campaignEnrollment.createMany({
          data: eligibleLeads.map(lead => ({
            leadId: lead.id,
            campaignId: id,
            status: 'Active',
            currentSequenceStep: 1,
            nextActionDate: new Date()
          })),
          skipDuplicates: true
        });
      }
    });

    const updatedCampaign = await prisma.campaign.findUnique({
      where: { id },
      include: {
        steps: {
          orderBy: { stepOrder: 'asc' }
        },
        senderAccount: true
      }
    });

    return NextResponse.json(updatedCampaign);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
