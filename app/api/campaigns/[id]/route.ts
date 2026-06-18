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
      let eligibleLeads: any[] = [];
      if (selectedCohort === 'Unverified') {
        eligibleLeads = await prisma.lead.findMany({
          where: { validationStatus: 'Unverified', isArchived: false }
        });
      } else if (selectedCohort === 'Valid') {
        eligibleLeads = await prisma.lead.findMany({
          where: { validationStatus: 'Valid', isArchived: false }
        });
      } else if (selectedCohort === 'HighIntent') {
        eligibleLeads = [];
      } else {
        // Assume selectedCohort is a groupId
        const groupId = selectedCohort.startsWith('group_') ? selectedCohort.replace('group_', '') : selectedCohort;
        eligibleLeads = await prisma.lead.findMany({
          where: {
            isArchived: false,
            groups: {
              some: {
                groupId: groupId
              }
            }
          }
        });
      }

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

    // Deliverability health for this campaign.
    // Bounced: enrollments flagged by the Azure delivery webhook on a hard bounce.
    // Failed: enrollments the send engine could not dispatch (SMTP/Azure send errors).
    // Unsubscribed: enrolled leads who opted out via the unsubscribe link.
    const bouncedCount = await prisma.campaignEnrollment.count({
      where: { campaignId: id, status: 'Bounced' }
    });

    const failedCount = await prisma.campaignEnrollment.count({
      where: { campaignId: id, status: 'Failed' }
    });

    const unsubscribedCount = await prisma.campaignEnrollment.count({
      where: { campaignId: id, lead: { status: 'Unsubscribed' } }
    });

    const validLeadsCount = await prisma.lead.count({
      where: { validationStatus: 'Valid' }
    });

    const unverifiedLeadsCount = await prisma.lead.count({
      where: { validationStatus: 'Unverified' }
    });

    // Fetch daily trends for the last 7 days
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    sevenDaysAgo.setHours(0, 0, 0, 0);

    const trendDispatches = await prisma.emailDispatch.findMany({
      where: {
        campaignId: id,
        sentAt: { gte: sevenDaysAgo }
      },
      include: {
        events: true
      }
    });

    // Generate daily buckets
    const dailyBuckets: Record<string, { name: string; opens: number; clicks: number }> = {};
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const label = d.toLocaleDateString('en-US', { day: '2-digit', month: 'short' });
      dailyBuckets[label] = { name: label, opens: 0, clicks: 0 };
    }

    trendDispatches.forEach(dispatch => {
      const label = new Date(dispatch.sentAt).toLocaleDateString('en-US', { day: '2-digit', month: 'short' });
      if (dailyBuckets[label]) {
        if (dispatch.events.some(e => e.eventType === 'open')) {
          dailyBuckets[label].opens++;
        }
        if (dispatch.events.some(e => e.eventType === 'click')) {
          dailyBuckets[label].clicks++;
        }
      }
    });

    const trend = Object.values(dailyBuckets);

    const meetingBookedCount = await prisma.campaignEnrollment.count({
      where: {
        campaignId: id,
        lead: {
          status: 'Meeting_Booked',
          isArchived: false
        }
      }
    });

    const sentimentGroups = await prisma.lead.groupBy({
      by: ['status'],
      where: {
        isArchived: false,
        enrollments: {
          some: {
            campaignId: id
          }
        }
      },
      _count: {
        id: true
      }
    });

    const funnel = [
      { name: 'Sent', value: sentCount },
      { name: 'Opened', value: opensCount },
      { name: 'Clicked', value: clicksCount },
      { name: 'Replied', value: repliesCount },
      { name: 'Meeting Booked', value: meetingBookedCount }
    ];

    const sentimentBreakdown = [
      { name: 'Neutral', value: 0 },
      { name: 'Interested', value: 0 },
      { name: 'Not Interested', value: 0 },
      { name: 'Meeting Booked', value: 0 },
      { name: 'Out of Office', value: 0 },
      { name: 'Bounced', value: 0 },
      { name: 'Unsubscribed', value: 0 }
    ];

    sentimentGroups.forEach(g => {
      const nameMap: Record<string, string> = {
        'Neutral': 'Neutral',
        'Interested': 'Interested',
        'Not_Interested': 'Not Interested',
        'Meeting_Booked': 'Meeting Booked',
        'Out_of_Office': 'Out of Office',
        'Bounced': 'Bounced',
        'Unsubscribed': 'Unsubscribed'
      };
      const mappedName = nameMap[g.status] || g.status;
      const item = sentimentBreakdown.find(item => item.name === mappedName);
      if (item) {
        item.value = g._count.id;
      }
    });

    const telemetry = {
      enrollments: enrollmentsCount,
      validLeadsCount,
      unverifiedLeadsCount,
      sent: sentCount,
      opens: opensCount,
      clicks: clicksCount,
      replies: repliesCount,
      bounced: bouncedCount,
      failed: failedCount,
      unsubscribed: unsubscribedCount,
      openRate: sentCount > 0 ? Number(((opensCount / sentCount) * 100).toFixed(1)) : 0,
      clickRate: sentCount > 0 ? Number(((clicksCount / sentCount) * 100).toFixed(1)) : 0,
      replyRate: sentCount > 0 ? Number(((repliesCount / sentCount) * 100).toFixed(1)) : 0,
      bounceRate: sentCount > 0 ? Number(((bouncedCount / sentCount) * 100).toFixed(1)) : 0,
      trend,
      funnel,
      sentiment: sentimentBreakdown
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
      
      let eligibleLeads: any[] = [];
      if (selectedCohort === 'Unverified') {
        eligibleLeads = await tx.lead.findMany({
          where: { validationStatus: 'Unverified', isArchived: false }
        });
      } else if (selectedCohort === 'Valid') {
        eligibleLeads = await tx.lead.findMany({
          where: { validationStatus: 'Valid', isArchived: false }
        });
      } else if (selectedCohort === 'HighIntent') {
        eligibleLeads = [];
      } else {
        // Assume selectedCohort is a groupId
        const groupId = selectedCohort.startsWith('group_') ? selectedCohort.replace('group_', '') : selectedCohort;
        eligibleLeads = await tx.lead.findMany({
          where: {
            isArchived: false,
            groups: {
              some: {
                groupId: groupId
              }
            }
          }
        });
      }

      // Get existing enrollments for this campaign
      const existingEnrollments = await tx.campaignEnrollment.findMany({
        where: { campaignId: id }
      });

      // Delete enrollments that are no longer eligible (e.g. if the cohort changed)
      const eligibleLeadIds = new Set(eligibleLeads.map(lead => lead.id));
      const enrollmentsToDelete = existingEnrollments.filter(env => !eligibleLeadIds.has(env.leadId));

      if (enrollmentsToDelete.length > 0) {
        await tx.campaignEnrollment.deleteMany({
          where: {
            id: { in: enrollmentsToDelete.map(env => env.id) }
          }
        });
      }

      // Add new enrollments only for eligible leads that aren't already enrolled
      const enrolledLeadIds = new Set(existingEnrollments.map(env => env.leadId));
      const newLeadsToEnroll = eligibleLeads.filter(lead => !enrolledLeadIds.has(lead.id));

      if (newLeadsToEnroll.length > 0) {
        await tx.campaignEnrollment.createMany({
          data: newLeadsToEnroll.map(lead => ({
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
