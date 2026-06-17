import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function POST(req: NextRequest) {
  try {
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
            
            if (status === 'Failed') {
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
                data: { status: 'Bounced', nextActionDate: null }
              });
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
            console.log('Engagement Report Received:', data);
            const rawType = data.engagementType || data.engagement; // "View" (Open) or "Click"
            const eventType = (rawType && (rawType.toLowerCase() === 'view' || rawType.toLowerCase() === 'open')) ? 'open' : 'click';
            
            // Log click URL details if present
            await prisma.emailEvent.create({
              data: {
                messageId: dispatch.messageId, // Use the matched case-sensitive messageId from the db
                eventType,
                clickedUrl: data.linkUri || data.engagementContext || null
              }
            });
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
