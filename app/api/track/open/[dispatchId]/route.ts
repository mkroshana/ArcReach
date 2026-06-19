import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { shouldDropEvent } from '@/lib/botFilter';

// 1×1 transparent PNG pixel (68 bytes)
const TRACKING_PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB' +
  'Nl7BcQAAAABJRU5ErkJggg==',
  'base64'
);

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ dispatchId: string }> }
) {
  try {
    const { dispatchId } = await params;

    // Look up the dispatch record
    const dispatch = await prisma.emailDispatch.findUnique({
      where: { id: dispatchId },
    });

    if (dispatch) {
      const userAgent = req.headers.get('user-agent');
      const botFilter = shouldDropEvent(dispatch.sentAt, userAgent, 'open');

      if (botFilter.drop) {
        console.log(`[Track Open] Bot filter: ${botFilter.reason || 'dropped'} for dispatch ${dispatchId} (UA: ${userAgent})`);
      } else {
        // Record the open event (fire-and-forget — don't block the pixel response)
        await prisma.emailEvent.create({
          data: {
            messageId: dispatch.messageId,
            eventType: 'open',
          },
        }).catch((err) => {
          console.error('[Track Open] Failed to record open event:', err);
        });
      }
    } else {
      console.log(`[Track Open] Dispatch not found: ${dispatchId}`);
    }
  } catch (err) {
    console.error('[Track Open] Error:', err);
  }

  // Always return the pixel, even if recording failed
  return new NextResponse(TRACKING_PIXEL, {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Content-Length': String(TRACKING_PIXEL.length),
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    },
  });
}
