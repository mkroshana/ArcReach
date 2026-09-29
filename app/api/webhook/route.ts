import { NextRequest, NextResponse } from 'next/server';
import { applyDeliveryReport, findReportedDispatch, reportedAt } from '@/lib/deliveryReport';
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
    // Events that could not be processed. Any at all fails the response, so
    // Event Grid redelivers the batch with backoff; the events that were
    // applied change nothing the second time (see applyDeliveryReport).
    let failed = 0;

    for (const event of events) {
      try {
        // Azure Event Grid Validation Handshake
        if (event.eventType === 'Microsoft.EventGrid.SubscriptionValidationEvent') {
          return NextResponse.json({ validationResponse: event.data.validationCode });
        }

        const data = event.data || {};
        const rawMessageId = data.messageId || data.messageid;

        if (typeof rawMessageId !== 'string' || !rawMessageId.trim()) continue;

        // Clean message ID of any wrapping angle brackets and whitespace
        let messageId = rawMessageId.trim();
        if (messageId.startsWith('<') && messageId.endsWith('>')) {
          messageId = messageId.slice(1, -1).trim();
        }

        // ACS reports under the send's Operation-Id, stored on campaign sends before the provider call.
        const dispatch = await findReportedDispatch(messageId);

        if (!dispatch) {
          // Acknowledged, not retried. A campaign send's dispatch holds its
          // operation id before the email leaves, so a report for it cannot
          // arrive first; an unknown id is mail this app did not send (another
          // sender on the same ACS resource) or a dispatch deleted with its
          // lead, and no retry will find it. Failing it would only keep Event
          // Grid redelivering the batch for 24 hours and delay the reports
          // behind it. Only a Unibox reply or mailbox test, recorded once ACS
          // accepted it, could in theory be reported in the moment before its
          // row is written.
          console.warn(`[Webhook] No dispatch for message ${messageId} (${event.eventType}); acknowledged without changes.`);
          continue;
        }

        // Process Communication Services Events
        switch (event.eventType) {
          case 'Microsoft.Communication.EmailDeliveryReportReceived': {
            const statusMessage = data.deliveryStatusDetails?.statusMessage;
            await applyDeliveryReport(dispatch, {
              status: data.status,
              statusMessage: typeof statusMessage === 'string' ? statusMessage : null,
              at: reportedAt(data.deliveryAttemptTimeStamp, event.eventTime),
            });
            break;
          }

          case 'Microsoft.Communication.EmailEngagementTrackingReportReceived':
            console.log('[Webhook] EmailEngagementTrackingReportReceived case ignored to prevent double-tracking. Self-hosted endpoints serve as the single source of truth.', data);
            break;

          default:
            console.log('Unhandled event type:', event.eventType);
        }
      } catch (err: any) {
        failed++;
        console.error(`[Webhook] Error processing individual Event Grid event:`, err);
      }
    }

    if (failed > 0) {
      return NextResponse.json({ status: 'error', failed }, { status: 500 });
    }
    return NextResponse.json({ status: 'success' }, { status: 200 });
  } catch (error: any) {
    console.error('Webhook processing error:', error);
    return NextResponse.json({ status: 'error', error: error.message }, { status: 500 });
  }
}
