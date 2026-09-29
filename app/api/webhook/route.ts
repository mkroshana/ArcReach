import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import crypto from 'crypto';

const SECRET_HEADER = 'x-arcreach-webhook-secret';

/**
 * Constant-time secret comparison. Returns false on length mismatch (which
 * itself is timing-safe because the slow path never runs).
 */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  try {
    const expectedSecret = process.env.WEBHOOK_SECRET;
    if (!expectedSecret) {
      console.error('[Webhook] WEBHOOK_SECRET is not configured. Rejecting request.');
      return NextResponse.json({ error: 'Webhook secret is not configured.' }, { status: 500 });
    }

    // Auth lives in a request header (configure as an Event Grid delivery property)
    // so the secret never reaches access logs or URL telemetry.
    const provided = req.headers.get(SECRET_HEADER);
    if (!provided) {
      return NextResponse.json({ error: 'Unauthorized: Webhook secret header missing.' }, { status: 401 });
    }
    if (!secretMatches(provided, expectedSecret)) {
      return NextResponse.json({ error: 'Unauthorized: Webhook secret invalid.' }, { status: 401 });
    }

    const events = await req.json();

    for (const event of events) {
      try {
        // Azure Event Grid Validation Handshake
        if (event.eventType === 'Microsoft.EventGrid.SubscriptionValidationEvent') {
          return NextResponse.json({ validationResponse: event.data.validationCode });
        }

        const data = event.data || {};
        const rawMessageId = data.messageId || data.messageid;

        if (!rawMessageId) continue;

        // Clean message ID of any wrapping angle brackets and whitespace
        let messageId = rawMessageId.trim();
        if (messageId.startsWith('<') && messageId.endsWith('>')) {
          messageId = messageId.slice(1, -1).trim();
        }

        // Find the email dispatch linked to the messageId (with case-insensitive fallback)
        let dispatch = await prisma.emailDispatch.findUnique({
          where: { messageId }
        });

        if (!dispatch) {
          dispatch = await prisma.emailDispatch.findFirst({
            where: {
              messageId: {
                equals: messageId,
                mode: 'insensitive'
              }
            }
          });
        }

        if (!dispatch) {
          console.log(`[Webhook] Dispatch log not found for Message ID: ${messageId}`);
          continue;
        }

        // Process Communication Services Events
        switch (event.eventType) {
          case 'Microsoft.Communication.EmailDeliveryReportReceived':
            console.log('Delivery Report Received:', data);
            const status = data.status; // "Delivered" or "Failed" (Bounce)

            if (status === 'Delivered') {
              // Record the confirmed-delivery timestamp for accurate "Delivered" metrics.
              await prisma.emailDispatch.update({
                where: { id: dispatch.id },
                data: { deliveredAt: new Date() },
              });
            } else if (status === 'Failed') {
              // A mailbox test send went to the testing user, so there is no lead to mark
              if (dispatch.leadId) {
                // Update Lead: mark as Bounced + Invalid deliverability
                await prisma.lead.update({
                  where: { id: dispatch.leadId },
                  data: {
                    status: 'Bounced',
                    validationStatus: 'Invalid',
                  }
                });
                // Update active enrollments to Bounced
                await prisma.campaignEnrollment.updateMany({
                  where: { leadId: dispatch.leadId, status: 'Active' },
                  data: {
                    status: 'Bounced',
                    nextActionDate: null,
                    lastError: 'Azure webhook delivery report: Failed',
                    lastBounceType: 'hard'
                  }
                });
              }
              // Create an audit trail EmailEvent for the bounce
              await prisma.emailEvent.create({
                data: {
                  messageId: dispatch.messageId,
                  eventType: 'bounce',
                }
              });
            }
            break;

          case 'Microsoft.Communication.EmailEngagementTrackingReportReceived':
            console.log('[Webhook] EmailEngagementTrackingReportReceived case ignored to prevent double-tracking. Self-hosted endpoints serve as the single source of truth.', data);
            break;

          default:
            console.log('Unhandled event type:', event.eventType);
        }
      } catch (err: any) {
        console.error(`[Webhook] Error processing individual Event Grid event:`, err);
      }
    }

    return NextResponse.json({ status: 'success' }, { status: 200 });
  } catch (error: any) {
    console.error('Webhook processing error:', error);
    return NextResponse.json({ status: 'error', error: error.message }, { status: 500 });
  }
}
