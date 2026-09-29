import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getGlobalSettings } from '@/lib/settings';
import { getSession } from '@/lib/session';
import { applyEmailTracking } from '@/lib/emailTracking';
import { checkGlobalRateLimits } from '@/lib/rateLimits';
import { resolveCampaignSenders, pickSender, handleSendFailure } from '@/lib/sendEngine';
import { sendMessage, sendingDisabledReason } from '@/lib/emailProvider';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSession();
    const { id } = await params;

    // 1. Fetch the campaign, its steps, and sender account
    const campaign = await prisma.campaign.findUnique({
      where: { id },
      include: {
        steps: {
          orderBy: { stepOrder: 'asc' }
        },
        senderAccount: true,
        senders: {
          include: {
            senderAccount: true
          }
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
      }, { status: 400 });
    }

    // With no steps every enrollment would look finished and be marked Completed
    // unsent, so refuse before any enrollment moves.
    if (campaign.steps.length === 0) {
      return NextResponse.json({
        success: false,
        error: 'This campaign has no steps. Add at least one step with a subject and body before running it.'
      }, { status: 400 });
    }

    // Only Azure Communication Services sends; refuse before any dispatch is
    // recorded or any enrollment moves.
    const settings = await getGlobalSettings();
    const sendingDisabled = sendingDisabledReason(settings);
    if (sendingDisabled) {
      return NextResponse.json({ success: false, error: sendingDisabled }, { status: 409 });
    }

    // Check global outbound rate limits before initiating the manual execution cycle
    const rateCheck = await checkGlobalRateLimits();
    if (!rateCheck.allowed) {
      return NextResponse.json({ success: false, error: rateCheck.reason }, { status: 429 });
    }

    const { searchParams } = new URL(req.url);
    const stepOrderParam = searchParams.get('stepOrder');
    const stepOrderFilter = stepOrderParam ? parseInt(stepOrderParam) : null;

    // 2. Fetch active enrollments for this campaign
    const enrollments = await prisma.campaignEnrollment.findMany({
      where: {
        campaignId: id,
        status: 'Active',
        ...(stepOrderFilter !== null ? { currentSequenceStep: stepOrderFilter } : {}),
        // Send guards: skip leads that should not receive emails
        lead: {
          isArchived: false,
          status: { notIn: ['Bounced', 'Unsubscribed'] },
          validationStatus: { notIn: ['Invalid'] },
        },
      },
      include: {
        lead: true
      }
    });

    if (enrollments.length === 0) {
      return NextResponse.json({ 
        success: true, 
        message: 'No active enrollments to process in this campaign.',
        dispatchedCount: 0
      });
    }

    // Build map of sent counts today for each unique sender in the batch/pool
    const senderIds = new Set<string>();
    if (campaign.senderAccountId) {
      senderIds.add(campaign.senderAccountId);
    }
    if (campaign.senders) {
      for (const poolItem of campaign.senders) {
        if (poolItem.senderAccountId) {
          senderIds.add(poolItem.senderAccountId);
        }
      }
    }
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const senderSentToday = new Map<string, number>();
    for (const senderId of senderIds) {
      const count = await prisma.emailDispatch.count({
        where: {
          senderAccountId: senderId,
          sentAt: {
            gte: startOfToday
          }
        }
      });
      senderSentToday.set(senderId, count);
    }

    let dispatchedCount = 0;
    const errors = [];
    const now = new Date();

    // 4. Process each enrollment
    for (const enrollment of enrollments) {
      const lead = enrollment.lead;
      const currentStepOrder = enrollment.currentSequenceStep;

      // Double check global rate limits dynamically for each email in the batch
      const incrementalRateCheck = await checkGlobalRateLimits();
      if (!incrementalRateCheck.allowed) {
        return NextResponse.json({
          success: false,
          error: incrementalRateCheck.reason,
          dispatchedCount,
          errors
        }, { status: 429 });
      }

      // Find step matching the current step order
      const step = campaign.steps.find(s => s.stepOrder === currentStepOrder);
      if (!step) {
        // Enrollment completed the sequence
        await prisma.campaignEnrollment.update({
          where: { id: enrollment.id },
          data: { status: 'Completed', nextActionDate: null }
        });
        continue;
      }

      // Idempotency guard: never send the same step to the same lead twice.
      // Without this, repeated manual runs re-create dispatch rows for leads that
      // were already emailed this step, inflating the "sent" metrics.
      const alreadySent = await prisma.emailDispatch.findFirst({
        where: {
          campaignId: campaign.id,
          leadId: lead.id,
          stepOrder: currentStepOrder,
          status: 'Sent',
        },
      });
      if (alreadySent) {
        // Advance the enrollment past this already-sent step without re-dispatching.
        const nextStepOrder = currentStepOrder + 1;
        const nextStep = campaign.steps.find(s => s.stepOrder === nextStepOrder);
        if (nextStep) {
          const nextActionDate = new Date();
          nextActionDate.setDate(nextActionDate.getDate() + nextStep.waitDays);
          await prisma.campaignEnrollment.update({
            where: { id: enrollment.id },
            data: { currentSequenceStep: nextStepOrder, nextActionDate },
          });
        } else {
          await prisma.campaignEnrollment.update({
            where: { id: enrollment.id },
            data: { status: 'Completed', nextActionDate: null },
          });
        }
        continue;
      }

      // Resolve the pool and pick a sender per send (least-loaded under cap)
      const senderPool = resolveCampaignSenders(campaign);
      const chosenSender = pickSender(senderPool, senderSentToday, now);

      if (!chosenSender) {
        console.log(`[Campaign Run] All senders in pool for campaign "${campaign.name}" are at cap. Deferring lead ${lead.email} to tomorrow.`);
        const nextDay = new Date();
        nextDay.setDate(nextDay.getDate() + 1);
        nextDay.setHours(0, 0, 0, 0);
        await prisma.campaignEnrollment.update({
          where: { id: enrollment.id },
          data: { nextActionDate: nextDay }
        });
        continue;
      }

      // Personalize copy (Spintax, Lead variables)
      const subject = personalizeText(step.subject, lead);
      const bodyText = personalizeText(step.body, lead);
      const isHtml = /<[a-z][\s\S]*>/i.test(bodyText);
      let syntheticMessageId = `${campaign.id}-${lead.id}-${currentStepOrder}-${Date.now()}`;

      // Wrap HTML body to support tracking pixel injection requirements
      let baseBody = bodyText;
      if (isHtml && !bodyText.toLowerCase().includes('<html') && !bodyText.toLowerCase().includes('<body')) {
        baseBody = `<html><head><meta charset="utf-8"></head><body>${bodyText}</body></html>`;
      }

      let dispatch: { id: string } | null = null;
      try {
        // 5. Create dispatch record FIRST so we have a dispatchId for tracking URLs
        dispatch = await prisma.emailDispatch.create({
          data: {
            leadId: lead.id,
            campaignId: campaign.id,
            senderAccountId: chosenSender.id,
            messageId: syntheticMessageId,
            subject,
            body: baseBody,
            stepOrder: currentStepOrder,
            status: 'Sent',
          }
        });

        // 6. Apply self-hosted tracking (pixel + link rewriting + unsubscribe link)
        const finalBody = applyEmailTracking(
          baseBody,
          dispatch.id,
          isHtml,
          campaign.trackOpens,
          campaign.trackClicks,
          lead.id
        );

        // 7. Send email via the active provider
        const { providerMessageId } = await sendMessage(
          {
            to: lead.email,
            subject,
            body: finalBody,
            isHtml,
            sender: chosenSender,
            trackOpens: campaign.trackOpens,
          },
          settings
        );

        // 8. Update dispatch with provider messageId and final tracked body
        const updateData: any = { body: finalBody };
        if (providerMessageId) {
          updateData.messageId = providerMessageId;
        }
        await prisma.emailDispatch.update({
          where: { id: dispatch.id },
          data: updateData,
        });

        // 9. Advance enrollment to the next step
        const nextStepOrder = currentStepOrder + 1;
        const nextStep = campaign.steps.find(s => s.stepOrder === nextStepOrder);

        if (nextStep) {
          const nextActionDate = new Date();
          nextActionDate.setDate(nextActionDate.getDate() + nextStep.waitDays);

          await prisma.campaignEnrollment.update({
            where: { id: enrollment.id },
            data: {
              currentSequenceStep: nextStepOrder,
              nextActionDate,
            }
          });
        } else {
          // No next step, sequence completed
          await prisma.campaignEnrollment.update({
            where: { id: enrollment.id },
            data: {
              status: 'Completed',
              nextActionDate: null,
            }
          });
        }

        dispatchedCount++;

        // Increment warmupSent counter if warmup is enabled
        if (chosenSender.warmupEnabled) {
          await prisma.senderAccount.update({
            where: { id: chosenSender.id },
            data: { warmupSent: { increment: 1 } }
          });
        }

        // Update local sent count tracking
        senderSentToday.set(chosenSender.id, (senderSentToday.get(chosenSender.id) || 0) + 1);
      } catch (err: any) {
        console.error(`[Campaign Run Error] Failed to process lead ${lead.email}:`, err);
        errors.push({ email: lead.email, error: err.message || err });
        const result = await handleSendFailure(enrollment, lead, dispatch, err, campaign.name, campaign.id);
        if (result.action === 'break') {
          break;
        }
      }
    }

    return NextResponse.json({
      success: errors.length === 0,
      message: `Campaign execution cycle complete. Sent: ${dispatchedCount}, Errors: ${errors.length}`,
      dispatchedCount,
      errors
    });

  } catch (error: any) {
    console.error('[Campaign Run Route Error]', error);
    return NextResponse.json({ success: false, error: error.message || 'Failed to run campaign.' }, { status: 500 });
  }
}

function personalizeText(template: string, lead: any): string {
  if (!template) return '';
  let result = template;

  const getFirstName = (fullName: string | null | undefined, fallback: string = 'there') => {
    if (!fullName) return fallback;
    return fullName.trim().split(/\s+/)[0] || fallback;
  };

  // Replace {{firstName}}
  result = result.replace(/\{\{firstName\}\}/g, getFirstName(lead.name, 'there'));

  // Replace {{company}}
  result = result.replace(/\{\{company\}\}/g, lead.company || 'your company');

  // Replace {{name}} (full name)
  result = result.replace(/\{\{name\}\}/g, lead.name || 'there');

  // Replace {{jobTitle}}
  result = result.replace(/\{\{jobTitle\}\}/g, lead.jobTitle || 'professional');

  // Replace {{email}}
  result = result.replace(/\{\{email\}\}/g, lead.email || '');

  // Replace n8n/json style name variable with fallback: {{ $json.name || 'there' }}
  result = result.replace(/\{\{\s*\$json\.name\s*\|\|\s*'([^']*)'\s*\}\}/g, (match, fallback) => {
    return getFirstName(lead.name, fallback || 'there');
  });

  // Replace n8n/json style name variable without fallback: {{ $json.name }}
  result = result.replace(/\{\{\s*\$json\.name\s*\}\}/g, getFirstName(lead.name, 'there'));

  // Also support single braces versions just in case: { $json.name || 'there' }
  result = result.replace(/\{\s*\$json\.name\s*\|\|\s*'([^']*)'\s*\}/g, (match, fallback) => {
    return getFirstName(lead.name, fallback || 'there');
  });
  result = result.replace(/\{\s*\$json\.name\s*\}/g, getFirstName(lead.name, 'there'));

  // Support n8n/json style company variable: {{ $json.company || 'your company' }}
  result = result.replace(/\{\{\s*\$json\.company\s*\|\|\s*'([^']*)'\s*\}\}/g, (match, fallback) => {
    return lead.company || fallback || 'your company';
  });
  result = result.replace(/\{\{\s*\$json\.company\s*\}\}/g, lead.company || 'your company');

  // Single braces version: { $json.company || 'your company' }
  result = result.replace(/\{\s*\$json\.company\s*\|\|\s*'([^']*)'\s*\}/g, (match, fallback) => {
    return lead.company || fallback || 'your company';
  });
  result = result.replace(/\{\s*\$json\.company\s*\}/g, lead.company || 'your company');

  // Basic Spintax: {Hi|Hello|Hey}
  const spintaxRegex = /\{([^{}]+)\}/g;
  result = result.replace(spintaxRegex, (match, options) => {
    const choices = options.split('|');
    return choices[Math.floor(Math.random() * choices.length)];
  });

  return result;
}
