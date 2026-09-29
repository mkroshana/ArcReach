import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { checkCampaignSenders } from '@/lib/senderOwnership';
import { MAILBOX_SECRET_OMIT } from '@/lib/mailboxSecrets';
import { checkAudienceCohort, REMOVED_ENROLLMENT_STATUS, syncCohortEnrollments } from '@/lib/campaignCohort';
import { activationBlocker } from '@/lib/campaignSteps';
import { userStatusPause } from '@/lib/campaignPause';
import { parseSendSchedule, sendScheduleError, timezoneError } from '@/lib/sendSchedule';

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
        senderAccount: { omit: MAILBOX_SECRET_OMIT },
        senders: {
          include: {
            senderAccount: { omit: MAILBOX_SECRET_OMIT }
          }
        }
      }
    });

    if (!campaign) {
      return NextResponse.json({ error: 'Campaign not found.' }, { status: 404 });
    }

    if (session.role !== 'ADMIN' && campaign.userId !== session.id) {
      return NextResponse.json({ error: 'Unauthorized access to this campaign.' }, { status: 403 });
    }

    // Calculate real campaign telemetry metrics. GET is read-only: leads are
    // enrolled when the campaign is created (POST) or saved (PUT), never on view.
    // Removed enrollments belong to leads that have left the audience.
    const enrollmentsCount = await prisma.campaignEnrollment.count({
      where: { campaignId: id, status: { not: REMOVED_ENROLLMENT_STATUS } }
    });

    // Total send *attempts* (includes retries and failed sends).
    const sentRequestsCount = await prisma.emailDispatch.count({
      where: { campaignId: id }
    });

    // Emails actually handed off to the provider (failed attempts excluded).
    const sentCount = await prisma.emailDispatch.count({
      where: { campaignId: id, status: 'Sent' }
    });

    // Emails confirmed delivered by the provider's delivery webhook.
    const deliveredCount = await prisma.emailDispatch.count({
      where: { campaignId: id, status: 'Sent', deliveredAt: { not: null } }
    });

    const opensCount = await prisma.emailDispatch.count({
      where: {
        campaignId: id,
        status: 'Sent',
        events: {
          some: { eventType: 'open' }
        }
      }
    });

    const clicksCount = await prisma.emailDispatch.count({
      where: {
        campaignId: id,
        status: 'Sent',
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

    // Select ONLY what the bucketing needs — full rows carry each dispatch's
    // HTML body (~100KB), which at volume produced GB-scale payloads and OOMs.
    const trendDispatches = await prisma.emailDispatch.findMany({
      where: {
        campaignId: id,
        sentAt: { gte: sevenDaysAgo }
      },
      select: {
        sentAt: true,
        events: { select: { eventType: true } },
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
      { name: 'Delivered', value: deliveredCount },
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

    // Per-step breakdown. One query, aggregated in memory by stepOrder
    // (uses the dispatch's recorded stepOrder — accurate, not subject-matched).
    const stepDispatchRows = await prisma.emailDispatch.findMany({
      where: { campaignId: id, stepOrder: { not: null } },
      select: {
        stepOrder: true,
        status: true,
        deliveredAt: true,
        events: { select: { eventType: true } },
      },
    });

    // Active leads currently sitting at each step (waiting to be sent).
    const activeByStep = await prisma.campaignEnrollment.groupBy({
      by: ['currentSequenceStep'],
      where: { campaignId: id, status: 'Active' },
      _count: { id: true },
    });
    const activeStepMap = new Map(activeByStep.map((a) => [a.currentSequenceStep, a._count.id]));

    const stepStats = campaign.steps.map((s: any) => {
      const rows = stepDispatchRows.filter((r) => r.stepOrder === s.stepOrder);
      const sent = rows.filter((r) => r.status === 'Sent').length;
      const failed = rows.filter((r) => r.status === 'Failed').length;
      const delivered = rows.filter((r) => r.status === 'Sent' && r.deliveredAt).length;
      const opened = rows.filter((r) => r.status === 'Sent' && r.events.some((e) => e.eventType === 'open')).length;
      const clicked = rows.filter((r) => r.status === 'Sent' && r.events.some((e) => e.eventType === 'click')).length;
      const active = activeStepMap.get(s.stepOrder) || 0;
      const base = delivered > 0 ? delivered : sent;
      return {
        stepOrder: s.stepOrder,
        subject: s.subject,
        waitDays: s.waitDays,
        active,
        sent,
        delivered,
        opened,
        clicked,
        failed,
        deliveryRate: sent > 0 ? Number(((delivered / sent) * 100).toFixed(1)) : 0,
        openRate: base > 0 ? Number(((opened / base) * 100).toFixed(1)) : 0,
        clickRate: base > 0 ? Number(((clicked / base) * 100).toFixed(1)) : 0,
      };
    });

    // Engagement rates are measured against delivered mail when delivery
    // confirmations are available, otherwise against actual sends.
    const engagementBase = deliveredCount > 0 ? deliveredCount : sentCount;

    const telemetry = {
      enrollments: enrollmentsCount,
      validLeadsCount,
      unverifiedLeadsCount,
      sentRequests: sentRequestsCount,
      sent: sentCount,
      delivered: deliveredCount,
      opens: opensCount,
      clicks: clicksCount,
      replies: repliesCount,
      bounced: bouncedCount,
      failed: failedCount,
      unsubscribed: unsubscribedCount,
      deliveryRate: sentCount > 0 ? Number(((deliveredCount / sentCount) * 100).toFixed(1)) : 0,
      openRate: engagementBase > 0 ? Number(((opensCount / engagementBase) * 100).toFixed(1)) : 0,
      clickRate: engagementBase > 0 ? Number(((clicksCount / engagementBase) * 100).toFixed(1)) : 0,
      replyRate: sentCount > 0 ? Number(((repliesCount / sentCount) * 100).toFixed(1)) : 0,
      bounceRate: sentCount > 0 ? Number(((bouncedCount / sentCount) * 100).toFixed(1)) : 0,
      trend,
      funnel,
      sentiment: sentimentBreakdown,
      stepStats
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
      steps,
      senderAccountIds
    } = body;

    // Every sender mailbox must belong to the campaign owner (also for admins)
    const senderError = await checkCampaignSenders(campaign.userId, senderAccountId, senderAccountIds);
    if (senderError) {
      return NextResponse.json({ error: senderError.error }, { status: senderError.status });
    }

    // The send engine keeps an incomplete window or unknown timezone closed, so neither is saved.
    const windowError = (timezone !== undefined ? timezoneError(timezone) : null)
      ?? (sendSchedule !== undefined ? sendScheduleError(sendSchedule) : null);
    if (windowError) {
      return NextResponse.json({ error: windowError }, { status: 400 });
    }

    // The page sends the stored audience on every save, so only a different value
    // is validated and re-synced; a status change or step edit leaves enrollments alone.
    const cohortChanged = audienceCohort !== undefined && audienceCohort !== campaign.audienceCohort;
    if (cohortChanged) {
      const cohortError = await checkAudienceCohort(audienceCohort);
      if (cohortError) {
        return NextResponse.json({ error: cohortError }, { status: 400 });
      }
    }

    // An Active campaign mails every step as stored, so publishing it, or saving
    // steps while it stays Active, needs complete steps. Drafts may be incomplete.
    if ((status ?? campaign.status) === 'Active' && (status !== undefined || Array.isArray(steps))) {
      const stepsToCheck = Array.isArray(steps)
        ? steps
        : await prisma.campaignStep.findMany({ where: { campaignId: id }, orderBy: { stepOrder: 'asc' } });
      const stepsError = activationBlocker(stepsToCheck);
      if (stepsError) {
        return NextResponse.json({ error: stepsError }, { status: 400 });
      }
    }

    const updates: any = {};
    if (name !== undefined) updates.name = name;
    if (status !== undefined) updates.status = status;
    // The page resends its status with every save, so only a status other than
    // the stored one is a user change. Like any, it cancels the send engine's
    // auto-resume; saving a campaign the engine paused keeps its timer.
    if (status !== undefined && status !== campaign.status) Object.assign(updates, userStatusPause(status));
    if (senderAccountId !== undefined) updates.senderAccountId = senderAccountId;
    if (timezone !== undefined) updates.timezone = timezone;
    if (sendSchedule !== undefined) updates.sendSchedule = parseSendSchedule(sendSchedule);
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

      // Sync sender pool
      if (senderAccountIds && Array.isArray(senderAccountIds)) {
        await tx.campaignSenderAccount.deleteMany({
          where: { campaignId: id }
        });
        if (senderAccountIds.length > 0) {
          await tx.campaignSenderAccount.createMany({
            data: senderAccountIds.map((sid: string) => ({
              campaignId: id,
              senderAccountId: sid
            }))
          });
        }
      }

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

      // 3. Sync enrollments when the audience changed, or enroll the cohort when
      // the campaign has none yet (e.g. published while its group was empty)
      const firstEnrollment = !cohortChanged && (await tx.campaignEnrollment.count({ where: { campaignId: id } })) === 0;
      if (cohortChanged || firstEnrollment) {
        await syncCohortEnrollments(tx, id, cohortChanged ? audienceCohort : campaign.audienceCohort || 'Valid');
      }
    });

    const updatedCampaign = await prisma.campaign.findUnique({
      where: { id },
      include: {
        steps: {
          orderBy: { stepOrder: 'asc' }
        },
        senderAccount: { omit: MAILBOX_SECRET_OMIT },
        senders: {
          include: {
            senderAccount: { omit: MAILBOX_SECRET_OMIT }
          }
        }
      }
    });

    return NextResponse.json(updatedCampaign);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
