import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getGlobalSettings } from '@/lib/settings';
import { getSession } from '@/lib/session';
import { sendingDisabledReason } from '@/lib/emailProvider';
import { sendableEnrollmentWhere } from '@/lib/sendEligibility';

/**
 * Run Now (every lead's current step) and Send Step (?stepOrder=N) queue leads;
 * they never send. Eligible enrollments are marked due now and the background
 * worker sends them, in batches, inside the campaign's sending window and under
 * the rate limits, sender caps and send claims every send goes through.
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

    // One conditional write, so an enrollment the worker advances meanwhile is
    // only queued if it still matches. Leads in soft-failure backoff keep their
    // retry time.
    const now = new Date();
    const { count } = await prisma.campaignEnrollment.updateMany({
      where: {
        campaignId: id,
        currentSequenceStep: stepOrder !== null ? stepOrder : { in: stepOrders },
        AND: [
          sendableEnrollmentWhere(),
          { OR: [{ retryCount: 0 }, { nextActionDate: null }, { nextActionDate: { lte: now } }] },
        ],
      },
      data: { nextActionDate: now },
    });

    return NextResponse.json({ queued: count });

  } catch (error: any) {
    console.error('[Campaign Run Route Error]', error);
    return NextResponse.json({ success: false, error: error.message || 'Failed to run campaign.' }, { status: 500 });
  }
}
