import { NextRequest, NextResponse } from 'next/server';
import { db, prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { UnauthorizedError, unauthorizedResponse } from '@/lib/sessionError';
import { checkCampaignSenders, checkReassignedCampaignSenders } from '@/lib/senderOwnership';
import { checkAudienceCohort, cohortLeadWhere } from '@/lib/campaignCohort';
import { activationBlocker } from '@/lib/campaignSteps';
import { CAMPAIGN_STATUSES, userStatusPause } from '@/lib/campaignPause';
import { isValidTimezone } from '@/lib/sendSchedule';
import { findEnrollableLeadIds } from '@/lib/sendEligibility';
import { type FieldRule, fieldRules, isPlainObject, pickUpdateFields } from '@/lib/updateAllowList';

/** Scalar columns the collection PUT may write. Sender mailboxes, audience and
 *  steps are edited through /api/campaigns/[id]; pausedUntil and pauseReason
 *  are set by the send engine and cleared by a status the caller sets. */
const CAMPAIGN_UPDATE_FIELDS: Record<string, FieldRule> = {
  name: fieldRules.nonEmptyString,
  status: fieldRules.oneOf(CAMPAIGN_STATUSES),
  // The send engine keeps a window in an unknown timezone closed, as PUT /api/campaigns/[id] checks.
  timezone: { expected: 'a valid timezone such as America/New_York or UTC', valid: isValidTimezone },
  stopOnReply: fieldRules.boolean,
  trackOpens: fieldRules.boolean,
  trackClicks: fieldRules.boolean,
  userId: fieldRules.nonEmptyString,
};

export async function GET() {
  try {
    const session = await getSession();
    
    // Fetch campaigns matching constraints - admins see all, users only see theirs
    const campaigns = await db.getCampaigns(session.id, session.role);
    return NextResponse.json(campaigns);
  } catch (error: any) {
    if (error instanceof UnauthorizedError) return unauthorizedResponse();
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    const data = await req.json();
    const { name, status, senderAccountId, userId, audienceCohort, senderAccountIds } = data;

    if (!name || !senderAccountId) {
      return NextResponse.json({ error: 'Name and sender mailbox are required.' }, { status: 400 });
    }

    // A new campaign has no steps, and only one with complete steps may be Active.
    if (status !== undefined && status !== 'Draft') {
      return NextResponse.json({ error: 'New campaigns start as Draft. Add complete steps, then publish the campaign.' }, { status: 400 });
    }

    // Standard users can only create campaigns owned by themselves
    const targetUserId = session.role === 'ADMIN' ? (userId || session.id) : session.id;
    if (typeof targetUserId !== 'string') {
      return NextResponse.json({ error: 'userId must be a user ID.' }, { status: 400 });
    }

    // Every sender mailbox must belong to the campaign owner
    const senderError = await checkCampaignSenders(targetUserId, senderAccountId, senderAccountIds);
    if (senderError) {
      return NextResponse.json({ error: senderError.error }, { status: senderError.status });
    }

    const selectedCohort = audienceCohort || 'Valid';
    const cohortError = await checkAudienceCohort(selectedCohort);
    if (cohortError) {
      return NextResponse.json({ error: cohortError }, { status: 400 });
    }

    const newCampaign = await db.createCampaign({
      name,
      status: 'Draft',
      senderAccountId,
      userId: targetUserId,
      audienceCohort: selectedCohort,
      senders: senderAccountIds && Array.isArray(senderAccountIds) ? {
        create: senderAccountIds.map((id: string) => ({
          senderAccountId: id
        }))
      } : undefined
    });

    // Auto-enroll the chosen cohort's leads that may be emailed
    const eligibleLeadIds = await findEnrollableLeadIds(prisma, cohortLeadWhere(selectedCohort));

    if (eligibleLeadIds.length > 0) {
      await prisma.campaignEnrollment.createMany({
        data: eligibleLeadIds.map(leadId => ({
          leadId,
          campaignId: newCampaign.id,
          status: 'Active',
          currentSequenceStep: 1,
          nextActionDate: new Date()
        })),
        skipDuplicates: true
      });
    }

    return NextResponse.json(newCampaign);
  } catch (error: any) {
    if (error instanceof UnauthorizedError) return unauthorizedResponse();
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const session = await getSession();
    const data = await req.json();
    if (!isPlainObject(data)) {
      return NextResponse.json({ error: 'Request body must be a JSON object.' }, { status: 400 });
    }
    const { id, ...fields } = data;

    if (!id || typeof id !== 'string') {
      return NextResponse.json({ error: 'Campaign ID is required.' }, { status: 400 });
    }

    // Only listed scalar columns reach Prisma; object values would be nested writes.
    const picked = pickUpdateFields(fields, CAMPAIGN_UPDATE_FIELDS);
    if (!picked.ok) {
      return NextResponse.json({ error: picked.error }, { status: 400 });
    }
    const updates = picked.data;

    // Verify ownership (admins may modify any campaign), loading only what the
    // checks below read rather than the whole campaigns list with its stats.
    const target = await prisma.campaign.findFirst({
      where: session.role === 'ADMIN' ? { id } : { id, userId: session.id },
      select: {
        userId: true,
        updatedAt: true,
        senderAccountId: true,
        senderAccount: { select: { emailAddress: true } },
        senders: { select: { senderAccountId: true, senderAccount: { select: { emailAddress: true } } } },
        steps: { orderBy: { stepOrder: 'asc' }, select: { subject: true, body: true } },
      },
    });

    if (!target) {
      return NextResponse.json({ error: 'Unauthorized to modify this campaign.' }, { status: 403 });
    }

    // An Active campaign mails every step as stored, so it needs complete steps.
    if (updates.status === 'Active') {
      const stepsError = activationBlocker(target.steps);
      if (stepsError) {
        return NextResponse.json({ error: stepsError }, { status: 400 });
      }
    }

    // Callers send only the fields they change, so a status here is the user's
    // choice and cancels any auto-resume the send engine scheduled. Sending
    // Paused for a campaign the engine paused is Keep Paused.
    if (updates.status !== undefined) {
      Object.assign(updates, userStatusPause(updates.status));
    }

    if (updates.userId !== undefined) {
      if (session.role !== 'ADMIN') {
        delete updates.userId;
      } else {
        const owner = await prisma.user.findUnique({ where: { id: updates.userId as string }, select: { id: true } });
        if (!owner) {
          return NextResponse.json({ error: 'Assigned user does not exist.' }, { status: 400 });
        }
        // The campaign keeps its sender mailboxes, which must belong to the new owner too.
        if (updates.userId !== target.userId) {
          const senderError = await checkReassignedCampaignSenders(updates.userId as string, target);
          if (senderError) {
            return NextResponse.json({ error: senderError.error }, { status: senderError.status });
          }
        }
      }
    }

    const updated = await db.updateCampaign(id, updates);
    // previousUpdatedAt is the version this change replaced: the campaign page
    // takes on the new version only when that is the one it loaded, so its next
    // Save still refuses to overwrite a change made elsewhere.
    return NextResponse.json({ ...updated, previousUpdatedAt: target.updatedAt });
  } catch (error: any) {
    if (error instanceof UnauthorizedError) return unauthorizedResponse();
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const session = await getSession();
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json({ error: 'Campaign ID is required.' }, { status: 400 });
    }

    // Verify ownership (admins may delete any campaign)
    const target = await prisma.campaign.findFirst({
      where: session.role === 'ADMIN' ? { id } : { id, userId: session.id },
      select: { id: true },
    });

    if (!target) {
      return NextResponse.json({ error: 'Unauthorized to delete this campaign.' }, { status: 403 });
    }

    await db.deleteCampaign(id);
    return NextResponse.json({ success: true });
  } catch (error: any) {
    if (error instanceof UnauthorizedError) return unauthorizedResponse();
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
