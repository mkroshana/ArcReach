import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    const events = await req.json();

    for (const event of events) {
      // Azure Event Grid Validation Handshake
      if (event.eventType === 'Microsoft.EventGrid.SubscriptionValidationEvent') {
        return NextResponse.json({ validationResponse: event.data.validationCode });
      }

      // Process Communication Services Events
      switch (event.eventType) {
        case 'Microsoft.Communication.EmailDeliveryReportReceived':
          console.log('Delivery Report Received:', event.data);
          // TODO: Update database with delivery status (Delivered, Bounced, etc.)
          // Example: db.campaigns.updateStatus(event.data.messageId, event.data.deliveryStatus)
          break;

        case 'Microsoft.Communication.EmailEngagementTrackingReportReceived':
          console.log('Engagement Report Received:', event.data);
          // TODO: Update database with open/click metrics
          // Example:
          // if (event.data.engagementContext.engagementType === 'View') { ... increment opens ... }
          // if (event.data.engagementContext.engagementType === 'Click') { ... increment clicks ... }
          break;

        default:
          console.log('Unhandled event type:', event.eventType);
      }
    }

    return NextResponse.json({ status: 'success' }, { status: 200 });
  } catch (error) {
    console.error('Webhook processing error:', error);
    return NextResponse.json({ status: 'error' }, { status: 500 });
  }
}
