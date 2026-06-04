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
    const enrollmentsCount = await prisma.campaignEnrollment.count({
      where: { campaignId: id }
    });

    const sentCount = await prisma.emailDispatch.count({
      where: {
        lead: {
          enrollments: {
            some: { campaignId: id }
          }
        }
      }
    });

    const opensCount = await prisma.emailDispatch.count({
      where: {
        lead: {
          enrollments: {
            some: { campaignId: id }
          }
        },
        events: {
          some: { eventType: 'open' }
        }
      }
    });

    const clicksCount = await prisma.emailDispatch.count({
      where: {
        lead: {
          enrollments: {
            some: { campaignId: id }
          }
        },
        events: {
          some: { eventType: 'click' }
        }
      }
    });

    const repliesCount = await prisma.inboundResponse.count({
      where: {
        lead: {
          enrollments: {
            some: { campaignId: id }
          }
        }
      }
    });

    const telemetry = {
      enrollments: enrollmentsCount,
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
