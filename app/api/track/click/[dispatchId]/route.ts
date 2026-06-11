import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ dispatchId: string }> }
) {
  const { searchParams } = new URL(req.url);
  const targetUrl = searchParams.get('url');

  // Fallback destination if URL param is missing or invalid
  const fallbackUrl = process.env.APP_URL || 'http://localhost:3000';

  if (!targetUrl) {
    return NextResponse.redirect(fallbackUrl);
  }

  try {
    const { dispatchId } = await params;

    // Look up the dispatch record
    const dispatch = await prisma.emailDispatch.findUnique({
      where: { id: dispatchId },
    });

    if (dispatch) {
      // A click implies the email was opened — record an implicit open
      // if one hasn't been recorded yet for this dispatch.
      // Many email clients block remote images (the tracking pixel),
      // but a click proves the email was opened.
      const existingOpen = await prisma.emailEvent.findFirst({
        where: {
          messageId: dispatch.messageId,
          eventType: 'open',
        },
      });

      if (!existingOpen) {
        await prisma.emailEvent.create({
          data: {
            messageId: dispatch.messageId,
            eventType: 'open',
          },
        }).catch((err) => {
          console.error('[Track Click] Failed to record implicit open event:', err);
        });
      }

      // Record the click event
      await prisma.emailEvent.create({
        data: {
          messageId: dispatch.messageId,
          eventType: 'click',
          clickedUrl: targetUrl,
        },
      }).catch((err) => {
        console.error('[Track Click] Failed to record click event:', err);
      });
    } else {
      console.log(`[Track Click] Dispatch not found: ${dispatchId}`);
    }
  } catch (err) {
    console.error('[Track Click] Error:', err);
  }

  // Always redirect to the target URL, even if recording failed
  return NextResponse.redirect(targetUrl);
}
