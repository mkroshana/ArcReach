import { NextRequest, NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getGlobalSettings } from '@/lib/settings';
import { getSession } from '@/lib/session';
import { sendingDisabledReason } from '@/lib/emailProvider';
import { sendableEnrollmentWhere } from '@/lib/sendEligibility';

/** Most enrollments one queueing write names by id. */
const QUEUE_WRITE_CHUNK = 1000;

/**
 * Run Now (leads that are due, or that this campaign has not emailed yet) and
 * Send Step (?stepOrder=N, every lead at that step) queue leads; they never
 * send. Eligible enrollments are marked due now and the background worker
 * sends them, in batches, inside the campaign's sending window and under the
 * rate limits, sender caps and send claims every send goes through.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSession();
    const { id } = await params;

    const campaign = await prisma.campaign.findUnique({
      where: { id },
      include: {
        steps: {
          orderBy: { stepOrder: 'asc' }
        }
      }
    });

    if (!campaign) {
      return NextResponse.json({ success: false, error: 'Campaign not found.' }, { status: 404 });
    }

    if (session.role !== 'ADMIN' && campaign.userId !== session.id) {
      return NextResponse.json({ success: false, error: 'Unauthorized access.' }, { status: 403 });
    }

    if (campaign.status !== 'Active') {
      return NextResponse.json({
        success: false,
        error: 'Campaign is not active. Please publish the sequence before executing a manual run.'
      }, { status: 409 });
    }

    // With no steps every enrollment would look finished and be marked Completed
    // unsent, so refuse before any enrollment moves.
    if (campaign.steps.length === 0) {
      return NextResponse.json({
        success: false,
        error: 'This campaign has no steps. Add at least one step with a subject and body before running it.'
      }, { status: 400 });
    }

    // Only Azure Communication Services sends; queuing leads that can't be sent
    // would only mislead, so refuse before any enrollment moves.
    const settings = await getGlobalSettings();
    const sendingDisabled = sendingDisabledReason(settings);
    if (sendingDisabled) {
      return NextResponse.json({ success: false, error: sendingDisabled }, { status: 409 });
    }

    const stepOrders = campaign.steps.map((s) => s.stepOrder);
    const stepOrderParam = new URL(req.url).searchParams.get('stepOrder');
    const stepOrder = stepOrderParam ? Number(stepOrderParam) : null;
    if (stepOrder !== null && !stepOrders.includes(stepOrder)) {
      return NextResponse.json({ success: false, error: 'This campaign has no such step.' }, { status: 400 });
    }

    // Leads in soft-failure backoff keep their retry time. Run Now never pulls
    // a follow-up forward: it queues leads already due and leads with no
    // Sent, Sending or Unknown dispatch in this campaign (a first email held
    // back by the sending window or a sender cap), so a lead waiting out a
    // step's wait days stays put. Send Step queues every lead at its step;
    // skipping the wait is its purpose. Sendable leads are read with
    // sendableEnrollmentWhere(), which filters on the campaign and lead; each
    // write then re-checks only the enrollment's own columns, including the
    // step it was read at, which Postgres re-evaluates on each row it locks,
    // so an enrollment the worker sends, advances or backs off meanwhile is not
    // queued. The send claim re-checks the campaign and lead before anything
    // is sent.
    const now = new Date();
    const due: Prisma.CampaignEnrollmentWhereInput[] = [{ nextActionDate: null }, { nextActionDate: { lte: now } }];
    const queueable: Prisma.CampaignEnrollmentWhereInput = {
      campaignId: id,
      status: 'Active',
      OR: [{ retryCount: 0 }, ...due],
    };
    const selected: Prisma.CampaignEnrollmentWhereInput[] = stepOrder !== null
      ? [{ currentSequenceStep: stepOrder }]
      : [
        { currentSequenceStep: { in: stepOrders } },
        { OR: [...due, { lead: { dispatches: { none: { campaignId: id, status: { in: ['Sent', 'Sending', 'Unknown'] } } } } }] },
      ];
    const sendable = await prisma.campaignEnrollment.findMany({
      where: { AND: [queueable, ...selected, sendableEnrollmentWhere()] },
      select: { id: true, currentSequenceStep: true },
    });
    const idsByStep = new Map<number, string[]>();
    for (const e of sendable) {
      const ids = idsByStep.get(e.currentSequenceStep) ?? [];
      ids.push(e.id);
      idsByStep.set(e.currentSequenceStep, ids);
    }
    // In chunks, so a large campaign's id list stays under Postgres's bind-parameter limit.
    let queued = 0;
    for (const [step, ids] of idsByStep) {
      for (let i = 0; i < ids.length; i += QUEUE_WRITE_CHUNK) {
        const { count } = await prisma.campaignEnrollment.updateMany({
          where: { ...queueable, currentSequenceStep: step, id: { in: ids.slice(i, i + QUEUE_WRITE_CHUNK) } },
          data: { nextActionDate: now },
        });
        queued += count;
      }
    }

    return NextResponse.json({ queued });

  } catch (error: any) {
    console.error('[Campaign Run Route Error]', error);
    return NextResponse.json({ success: false, error: error.message || 'Failed to run campaign.' }, { status: 500 });
  }
}
