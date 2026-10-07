import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { UnauthorizedError, unauthorizedResponse } from '@/lib/sessionError';
import { checkCampaignSenders } from '@/lib/senderOwnership';
import { MAILBOX_SECRET_OMIT } from '@/lib/mailboxSecrets';
import { checkAudienceCohort, syncCohortEnrollments } from '@/lib/campaignCohort';
import { activationBlocker, changesStepStructure, matchStoredSteps, STEP_STRUCTURE_LOCKED_ERROR } from '@/lib/campaignSteps';
import { CAMPAIGN_OWNER_DISABLED_ERROR, CAMPAIGN_STATUSES, userStatusPause } from '@/lib/campaignPause';
import { CAMPAIGN_STOPPED_ERROR, isStopped } from '@/lib/campaignStop';
import { CAMPAIGN_CHANGED_ERROR, nextCampaignVersion, parseCampaignVersion, sameCampaignVersion } from '@/lib/campaignVersion';
import { SCHEDULE_REQUIRED_ERROR, hasSendingSchedule, parseSendSchedule, sendScheduleError, timezoneError } from '@/lib/sendSchedule';
import { fieldRules } from '@/lib/updateAllowList';
import { emailsLeft } from '@/lib/campaignProgress';
import {
  type MetricsScope,
  campaignLeadTotals,
  countReplies,
  countSendAttempts,
  dailyEngagement,
  deliveryBreakdown,
  engagementFunnel,
  healthSummary,
  mailboxMetrics,
  metricsWindow,
  percent,
  sendSummary,
  stepMetrics,
} from '@/lib/engagementMetrics';

/** Days the campaign page's engagement trend covers, today included. */
const TREND_DAYS = 7;

/** The statuses a save may set, as the collection PUT allows. */
const STATUS_RULE = fieldRules.oneOf(CAMPAIGN_STATUSES);

/** Thrown inside the save transaction when another write changed the campaign first. */
class CampaignChangedError extends Error {}

function campaignChangedResponse() {
  // `stale` tells the campaign page to offer a reload rather than a plain error.
  return NextResponse.json({ error: CAMPAIGN_CHANGED_ERROR, stale: true }, { status: 409 });
}

/**
 * Whether the campaign has started sending: a lead has moved past step 1 or
 * the campaign has a dispatch. From then on its steps may only be edited in
 * place or added after the last one (see STEP_STRUCTURE_LOCKED_ERROR).
 */
async function hasSequenceStarted(campaignId: string): Promise<boolean> {
  const advanced = await prisma.campaignEnrollment.count({
    where: { campaignId, currentSequenceStep: { gt: 1 } }
  });
  if (advanced > 0) return true;
  const dispatched = await prisma.emailDispatch.count({ where: { campaignId } });
  return dispatched > 0;
}

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
    // Active enrollments are the leads still in the sequence; Paused, Completed,
    // Failed, Bounced and Removed ones are not counted.
    const activeEnrollmentsCount = await prisma.campaignEnrollment.count({
      where: { campaignId: id, status: 'Active' }
    });

    // Sends, opens, clicks, bounces, failed attempts and unsubscribes of this
    // campaign's sequence sends, defined in lib/engagementMetrics as on the
    // dashboard and the Accounts page, and counted in the database.
    // Total Sent Requests counts every attempt, retries and failures included.
    // Delivery rate: delivered emails of those a delivery report arrived for,
    // so emails whose report has not arrived never dilute it.
    // Bounced: hard bounces, reported by the delivery webhook or at send time,
    // and their rate of the emails whose outcome is known (bounceBase).
    // Failed: send attempts the provider refused or that errored.
    // Unsubscribed: this campaign's emails whose unsubscribe link was used.
    // Opened and clicked emails, and the leads they came from (campaignLeadTotals),
    // since a lead often opens several of the campaign's emails.
    // Replies: the human replies the campaign received. Reply rate: the leads
    // who replied of the leads contacted, as Lead Progress and the step and
    // mailbox rows count it, so a lead who replies twice counts once.
    // The steps and mailboxes break the same sends down with every measure,
    // and the delivery breakdown says what delivery reports said about them.
    const scope: MetricsScope = { kind: 'campaign', campaignId: id };
    const [sends, health, sentRequestsCount, repliesCount, trend, stepCounts, delivery, leadTotals, mailboxes] = await Promise.all([
      sendSummary(prisma, scope),
      healthSummary(prisma, scope),
      countSendAttempts(prisma, scope),
      countReplies(prisma, scope),
      dailyEngagement(prisma, scope, metricsWindow(TREND_DAYS)),
      stepMetrics(prisma, [id], { engagement: true, health: true, leads: true, replies: true }),
      deliveryBreakdown(prisma, scope),
      campaignLeadTotals(prisma, id),
      mailboxMetrics(prisma, id),
    ]);

    const validLeadsCount = await prisma.lead.count({
      where: { validationStatus: 'Valid' }
    });

    const unverifiedLeadsCount = await prisma.lead.count({
      where: { validationStatus: 'Unverified' }
    });

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

    // Delivered is a stage only once a delivery report arrived for one of the
    // campaign's emails; until then its 0 is not a measurement, so it is left out.
    const funnel = engagementFunnel({
      sent: sends.sent,
      delivered: delivery.reported > 0 ? sends.delivered : undefined,
      opened: sends.opened,
      clicked: sends.clicked,
      replies: repliesCount,
      meetingsBooked: meetingBookedCount
    });

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

    // Where the campaign's leads are: every enrollment by status, and the Active
    // ones (still to get a step) by the step they wait for, with the earliest
    // and latest next send date and how many are due now.
    const now = new Date();
    const [enrollmentsByStatus, activeByStep, dueByStep] = await Promise.all([
      prisma.campaignEnrollment.groupBy({
        by: ['status'],
        where: { campaignId: id },
        _count: { id: true },
      }),
      prisma.campaignEnrollment.groupBy({
        by: ['currentSequenceStep'],
        where: { campaignId: id, status: 'Active' },
        _count: { id: true },
        _min: { nextActionDate: true },
        _max: { nextActionDate: true },
      }),
      prisma.campaignEnrollment.groupBy({
        by: ['currentSequenceStep'],
        where: { campaignId: id, status: 'Active', nextActionDate: { lte: now } },
        _count: { id: true },
      }),
    ]);

    // Per-step breakdown by the dispatch's recorded stepOrder, with the same
    // definitions as the totals above, and the Active leads waiting for it.
    const stepStats = campaign.steps.map((s: any) => {
      const waiting = activeByStep.find((a) => a.currentSequenceStep === s.stepOrder);
      return {
        stepOrder: s.stepOrder,
        subject: s.subject,
        waitDays: s.waitDays,
        active: waiting?._count.id ?? 0,
        due: dueByStep.find((d) => d.currentSequenceStep === s.stepOrder)?._count.id ?? 0,
        nextDueAt: waiting?._min.nextActionDate ?? null,
        // The latest of them, from which the page works out the earliest the sequence can finish.
        lastDueAt: waiting?._max.nextActionDate ?? null,
        ...stepCounts(id, s.stepOrder),
      };
    });

    const progress = {
      enrolled: enrollmentsByStatus.reduce((total, g) => total + g._count.id, 0),
      byStatus: Object.fromEntries(enrollmentsByStatus.map((g) => [g.status, g._count.id])),
      contacted: leadTotals.contacted,
      repliedLeads: leadTotals.replied,
      emailsLeft: emailsLeft(
        campaign.steps.map((s) => s.stepOrder),
        activeByStep.map((a) => ({ stepOrder: a.currentSequenceStep, waiting: a._count.id })),
      ),
      dueNow: dueByStep.reduce((total, d) => total + d._count.id, 0),
      nextDueAt: activeByStep.reduce<Date | null>((earliest, a) => {
        const at = a._min.nextActionDate;
        return at && (!earliest || at < earliest) ? at : earliest;
      }, null),
      firstSentAt: leadTotals.firstSentAt,
      lastSentAt: leadTotals.lastSentAt,
    };

    // The mailboxes' addresses, including any since taken out of the sender pool.
    const mailboxIds = mailboxes.flatMap((m) => (m.senderAccountId ? [m.senderAccountId] : []));
    const mailboxAccounts = mailboxIds.length > 0
      ? await prisma.senderAccount.findMany({ where: { id: { in: mailboxIds } }, select: { id: true, emailAddress: true, name: true } })
      : [];
    const mailboxStats = mailboxes.map((m) => {
      const account = mailboxAccounts.find((a) => a.id === m.senderAccountId);
      return { ...m, emailAddress: account?.emailAddress ?? null, name: account?.name ?? null };
    });

    const telemetry = {
      activeEnrollments: activeEnrollmentsCount,
      validLeadsCount,
      unverifiedLeadsCount,
      sentRequests: sentRequestsCount,
      sent: sends.sent,
      delivered: sends.delivered,
      opens: sends.opened,
      clicks: sends.clicked,
      openedLeads: leadTotals.opened,
      clickedLeads: leadTotals.clicked,
      replies: repliesCount,
      bounced: health.bounced,
      failed: health.failed,
      unsubscribed: health.unsubscribed,
      deliveryRate: sends.deliveryRate,
      openRate: sends.openRate,
      clickRate: sends.clickRate,
      replyRate: percent(leadTotals.replied, leadTotals.contacted),
      bounceRate: health.bounceRate,
      bounceBase: health.bounceBase,
      trend,
      funnel,
      sentiment: sentimentBreakdown,
      stepStats,
      progress,
      delivery,
      mailboxes: mailboxStats
    };

    return NextResponse.json({
      ...campaign,
      // The campaign page disables removing steps and Use Template while this is true.
      stepsLocked: await hasSequenceStarted(id),
      telemetry
    });
  } catch (error: any) {
    if (error instanceof UnauthorizedError) return unauthorizedResponse();
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSession();
    const { id } = await params;

    const campaign = await prisma.campaign.findUnique({
      where: { id },
      include: { user: { select: { disabledAt: true } } }
    });

    if (!campaign) {
      return NextResponse.json({ error: 'Campaign not found.' }, { status: 404 });
    }

    if (session.role !== 'ADMIN' && campaign.userId !== session.id) {
      return NextResponse.json({ error: 'Unauthorized modification attempt.' }, { status: 403 });
    }

    // A stopped campaign can't be edited until it is restarted (lib/campaignStop).
    if (isStopped(campaign)) {
      return NextResponse.json({ error: CAMPAIGN_STOPPED_ERROR }, { status: 409 });
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
      senderAccountIds,
      updatedAt
    } = body;

    if (status !== undefined && !STATUS_RULE.valid(status)) {
      return NextResponse.json({ error: `Field "status" must be ${STATUS_RULE.expected}.` }, { status: 400 });
    }

    // Nothing is sent for a disabled user, so Publish Sequence may not make
    // their campaign Active.
    if (status === 'Active' && campaign.user?.disabledAt) {
      return NextResponse.json({ error: CAMPAIGN_OWNER_DISABLED_ERROR }, { status: 409 });
    }

    // A save names the version (updatedAt) it edited and is refused once the
    // campaign has changed since, so it never overwrites a change its editor
    // has not seen. The write below re-checks it atomically.
    const loadedVersion = parseCampaignVersion(updatedAt);
    if (!loadedVersion) {
      return NextResponse.json({ error: 'updatedAt is required: send the updatedAt of the campaign you edited.' }, { status: 400 });
    }
    if (!sameCampaignVersion(campaign.updatedAt, loadedVersion)) {
      return campaignChangedResponse();
    }

    // Every sender mailbox must belong to the campaign owner (also for admins)
    const senderError = await checkCampaignSenders(campaign.userId, senderAccountId, senderAccountIds);
    if (senderError) {
      return NextResponse.json({ error: senderError.error }, { status: senderError.status });
    }

    // The send engine keeps an incomplete window or unknown timezone closed, so neither is saved.
    // A campaign that is not Active and not being made Active may be saved with no
    // schedule (null); it then sends nothing and can't be made Active until one is set.
    const clearsSchedule = sendSchedule === null && (status ?? campaign.status) !== 'Active';
    const windowError = (timezone !== undefined ? timezoneError(timezone) : null)
      ?? (sendSchedule !== undefined && !clearsSchedule ? sendScheduleError(sendSchedule) : null);
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

    // A campaign sends only inside its sending window, so Publish Sequence needs
    // a complete one, submitted (checked above) or stored; without it the campaign stays Draft.
    if (status === 'Active' && !hasSendingSchedule(
      timezone !== undefined ? timezone : campaign.timezone,
      sendSchedule !== undefined ? sendSchedule : campaign.sendSchedule,
    )) {
      return NextResponse.json({ error: SCHEDULE_REQUIRED_ERROR }, { status: 400 });
    }

    // Steps are saved over the stored ones by id, keeping their ids and
    // stepOrder. Once the campaign has started sending, a save may only edit
    // stored steps in place and add new ones after them.
    let storedStepIds: string[] = [];
    if (steps && Array.isArray(steps)) {
      const storedSteps = await prisma.campaignStep.findMany({
        where: { campaignId: id },
        orderBy: { stepOrder: 'asc' },
        select: { id: true }
      });
      storedStepIds = storedSteps.map((s) => s.id);
      if (changesStepStructure(storedStepIds, steps) && await hasSequenceStarted(id)) {
        return NextResponse.json({ error: STEP_STRUCTURE_LOCKED_ERROR }, { status: 409 });
      }
    }

    const updates: any = {};
    if (name !== undefined) updates.name = name;
    if (status !== undefined) updates.status = status;
    // The page's Save never sends a status; Publish Sequence sends Active. A
    // status other than the stored one cancels the send engine's auto-resume,
    // like any status a user sets.
    if (status !== undefined && status !== campaign.status) Object.assign(updates, userStatusPause(status));
    if (senderAccountId !== undefined) updates.senderAccountId = senderAccountId;
    if (timezone !== undefined) updates.timezone = timezone;
    if (sendSchedule !== undefined) updates.sendSchedule = clearsSchedule ? Prisma.DbNull : parseSendSchedule(sendSchedule);
    if (stopOnReply !== undefined) updates.stopOnReply = !!stopOnReply;
    if (trackOpens !== undefined) updates.trackOpens = !!trackOpens;
    if (trackClicks !== undefined) updates.trackClicks = !!trackClicks;
    if (audienceCohort !== undefined) updates.audienceCohort = audienceCohort;

    // Enrollments are synced when the audience changed, when the campaign has
    // none yet (e.g. published while its group was empty), or when an earlier
    // save's sync did not finish. The save stores its version as the sync's
    // request with the audience, and the sync runs after the save commits.
    const version = nextCampaignVersion(loadedVersion);
    const syncCohort = cohortChanged
      || campaign.cohortSyncRequestedAt != null
      || (await prisma.campaignEnrollment.count({ where: { campaignId: id } })) === 0;
    if (syncCohort) updates.cohortSyncRequestedAt = version;

    // Use a transaction to ensure atomic updates of campaign config and sequence
    // steps. It holds no enrollment work, so it stays short whatever the audience's size.
    await prisma.$transaction(async (tx) => {
      // 1. Update the campaign record, only while it is still the version the
      // save edited: if another write landed since the check above, nothing is saved.
      const { count } = await tx.campaign.updateMany({
        where: { id, updatedAt: loadedVersion },
        data: { ...updates, updatedAt: version }
      });
      if (count === 0) throw new CampaignChangedError();

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

      // 2. If steps are provided, save them at their positions: a stored step is
      // updated in place, a new one created and a stored one left out deleted
      if (steps && Array.isArray(steps)) {
        const matchedIds = matchStoredSteps(storedStepIds, steps);
        const removedIds = storedStepIds.filter((storedId) => !matchedIds.includes(storedId));
        if (removedIds.length > 0) {
          await tx.campaignStep.deleteMany({
            where: { campaignId: id, id: { in: removedIds } }
          });
        }

        const newSteps: any[] = [];
        for (let index = 0; index < steps.length; index++) {
          const step = steps[index];
          const data = {
            stepOrder: index + 1,
            // Step 1 is sent on enrollment, so no wait is ever applied before it.
            waitDays: index === 0 ? 0 : Number(step.waitDays) || 0,
            subject: step.subject || '',
            body: step.body || ''
          };
          const storedId = matchedIds[index];
          if (storedId) {
            await tx.campaignStep.update({ where: { id: storedId }, data });
          } else {
            newSteps.push({ campaignId: id, ...data });
          }
        }
        if (newSteps.length > 0) {
          await tx.campaignStep.createMany({ data: newSteps });
        }
      }
    });

    // 3. Sync enrollments to the saved audience in short batches. The save
    // above stands if this fails, and the next save runs the sync again.
    if (syncCohort) {
      try {
        await syncCohortEnrollments(id, cohortChanged ? audienceCohort : campaign.audienceCohort || 'Valid', version);
      } catch (error: any) {
        console.error(`[Campaigns] Enrollment sync for campaign ${id} did not finish:`, error?.message || error);
        // `saved` tells the campaign page to load the saved version, so its next Save runs the sync again.
        return NextResponse.json({
          error: `The campaign was saved, but enrolling its audience did not finish (${error?.message || 'unknown error'}). Save again to finish it.`,
          saved: true
        }, { status: 500 });
      }
    }

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
    if (error instanceof UnauthorizedError) return unauthorizedResponse();
    if (error instanceof CampaignChangedError) return campaignChangedResponse();
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
