import { prisma } from './db';
import { getGlobalSettings } from './settings';
import { getAzureSendStatus, sendingDisabledReason, EmailSendError, type AzureSendStatus } from './emailProvider';
import { advanceAfterSentStep, handleSendFailure, recordAcceptedSend } from './sendEngine';
import { RELEASED_CLAIM, SEND_CLAIM_TTL_MS } from './sendEligibility';

/** A dispatch still 'Sending' this long after it was recorded was interrupted by a crash or restart. */
export const STALE_SENDING_MS = 10 * 60 * 1000;
/** How often the worker reconciles stale Sending dispatches. */
export const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
/** Most stale dispatches checked with ACS per pass. */
export const RECONCILE_BATCH = 25;
/**
 * A 404 from ACS only proves the send never arrived while the dispatch is
 * younger than this. An older one may have outlived ACS's record of the
 * operation, so it is marked Unknown instead of being sent again.
 */
export const NOT_FOUND_RETRY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Settles dispatches left 'Sending' by a send that was interrupted (process
 * crash, restart or deploy between recording the dispatch and recording the
 * outcome). Each one older than STALE_SENDING_MS is checked with ACS under its
 * stored operation id:
 *  - NotStarted, Running or Succeeded: ACS has it, so it is recorded Sent and
 *    the enrollment advanced exactly as after a normal send.
 *  - Failed or Canceled: handled as a failed send (retry, bounce or pause).
 *  - 404: ACS never received it, so the dispatch is deleted and the step is
 *    sent again by the next cycle.
 *  - no answer, a timeout or any other status: left for the next pass.
 * Rows recorded before operation ids were stored cannot be checked; they are
 * marked 'Unknown' and never sent again. Unknown rows count toward caps and
 * rate limits but not as sent. Never throws.
 */
export async function reconcileStaleSendingDispatches(now: Date = new Date()): Promise<void> {
  try {
    const staleBefore = new Date(now.getTime() - STALE_SENDING_MS);

    const legacy = await prisma.emailDispatch.updateMany({
      where: { status: 'Sending', operationId: null, sentAt: { lt: staleBefore } },
      data: { status: 'Unknown' },
    });
    if (legacy.count > 0) {
      console.warn(`[SendReconciler] Marked ${legacy.count} interrupted dispatch(es) with no ACS operation id Unknown; they will not be sent again.`);
    }

    const settings = await getGlobalSettings();
    const sendingDisabled = sendingDisabledReason(settings);
    if (sendingDisabled) {
      console.warn(`[SendReconciler] ${sendingDisabled} Interrupted sends are left Sending until ACS is configured.`);
      return;
    }

    const stale = await prisma.emailDispatch.findMany({
      where: { status: 'Sending', operationId: { not: null }, sentAt: { lt: staleBefore } },
      orderBy: { sentAt: 'asc' },
      take: RECONCILE_BATCH,
      select: {
        id: true,
        messageId: true,
        operationId: true,
        sentAt: true,
        stepOrder: true,
        leadId: true,
        campaignId: true,
        lead: { select: { id: true, email: true } },
        senderAccount: { select: { id: true, warmupEnabled: true } },
        campaign: { select: { id: true, name: true, steps: { select: { stepOrder: true, waitDays: true } } } },
      },
    });
    if (stale.length === 0) return;

    const outcomes: Record<string, number> = {};
    for (const dispatch of stale) {
      const operationId = dispatch.operationId!;

      let acs: AzureSendStatus;
      try {
        acs = await getAzureSendStatus(operationId, settings!);
      } catch (err: any) {
        // ACS is unreachable or erroring; the rest will likely fail the same way.
        console.warn(`[SendReconciler] Could not read the status of operation ${operationId}; leaving it and the rest of this batch for the next pass:`, err?.message || err);
        break;
      }

      try {
        // Campaign sends always have a lead; only mailbox test sends have none.
        const enrollment = dispatch.campaignId && dispatch.leadId
          ? await prisma.campaignEnrollment.findFirst({
              where: { campaignId: dispatch.campaignId, leadId: dispatch.leadId },
              select: { id: true, retryCount: true, quotaFailures: true, status: true, currentSequenceStep: true },
            })
          : null;
        // The enrollment is still waiting on this dispatch's step.
        const waiting =
          enrollment && dispatch.stepOrder !== null && enrollment.status === 'Active' && enrollment.currentSequenceStep === dispatch.stepOrder
            ? enrollment
            : null;

        let outcome: string;
        if (acs.status === 'NotStarted' || acs.status === 'Running' || acs.status === 'Succeeded') {
          // ACS uses the operation id as the message id, so the delivery webhook matches it.
          const recorded = await recordAcceptedSend({
            dispatchId: dispatch.id,
            operationId,
            providerMessageId: operationId,
            enrollmentId: waiting?.id ?? null,
            // Advanced only while it is still Active on this step.
            enrollmentWhere: waiting ? { status: 'Active', currentSequenceStep: waiting.currentSequenceStep } : undefined,
            enrollmentAdvance: waiting
              ? advanceAfterSentStep(dispatch.campaign?.steps ?? [], waiting.currentSequenceStep, dispatch.sentAt)
              : {},
            sender: dispatch.senderAccount,
          });
          outcome = recorded ? 'sent' : 'unrecorded';
        } else if (acs.status === 'Failed' || acs.status === 'Canceled') {
          const err = new EmailSendError(
            acs.error?.message || `Azure Communication Services reported send status: ${acs.status}.`,
            { code: acs.error?.code }
          );
          if (waiting && dispatch.campaign && dispatch.lead) {
            await handleSendFailure(waiting, dispatch.lead, dispatch, err, dispatch.campaign.name, dispatch.campaign.id);
          } else {
            await prisma.emailDispatch.updateMany({ where: { id: dispatch.id, status: 'Sending' }, data: { status: 'Failed' } });
          }
          outcome = 'failed';
        } else if (now.getTime() - dispatch.sentAt.getTime() > NOT_FOUND_RETRY_MAX_AGE_MS) {
          // 404 on an old dispatch: it may have been sent, so never send it again.
          await prisma.emailDispatch.updateMany({ where: { id: dispatch.id, status: 'Sending' }, data: { status: 'Unknown' } });
          outcome = 'unknown';
        } else {
          // 404: never sent. Drop the dispatch and any abandoned claim so the step is due again.
          await prisma.$transaction([
            prisma.emailDispatch.deleteMany({ where: { id: dispatch.id, status: 'Sending' } }),
            ...(enrollment && dispatch.stepOrder !== null
              ? [
                  prisma.campaignEnrollment.updateMany({
                    where: {
                      id: enrollment.id,
                      currentSequenceStep: dispatch.stepOrder,
                      claimedAt: { lt: new Date(now.getTime() - SEND_CLAIM_TTL_MS) },
                    },
                    data: RELEASED_CLAIM,
                  }),
                ]
              : []),
          ]);
          outcome = 'retried';
        }

        outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
        console.log(`[SendReconciler] Dispatch ${dispatch.id} (operation ${operationId}): ACS reports ${acs.status}; ${outcome}.`);
      } catch (err: any) {
        console.error(`[SendReconciler] Could not settle dispatch ${dispatch.id} (operation ${operationId}); it stays Sending for the next pass:`, err?.message || err);
      }
    }

    if (Object.keys(outcomes).length > 0) {
      console.log(`[SendReconciler] Settled interrupted sends: ${JSON.stringify(outcomes)}.`);
    }
  } catch (err) {
    console.error('[SendReconciler] Error during reconciliation:', err);
  }
}
