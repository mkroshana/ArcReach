import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { engagementBotReason, MACHINE_EVENT_TYPE } from '@/lib/botFilter';

// 1×1 transparent PNG pixel (68 bytes)
const TRACKING_PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB' +
  'Nl7BcQAAAABJRU5ErkJggg==',
  'base64'
);

function pixelResponse(): NextResponse {
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
      // An automated open (a scanner, Apple Mail Privacy Protection, a
      // prefetch) is kept as a machine open, which metrics never count.
      const userAgent = req.headers.get('user-agent');
      const botReason = engagementBotReason(dispatch, userAgent, 'open');
      if (botReason) {
        console.log(`[Track Open] Bot filter: ${botReason} for dispatch ${dispatchId} (UA: ${userAgent}); recorded as a machine open.`);
      }
      const eventType = botReason ? MACHINE_EVENT_TYPE.open : 'open';

      // Dedupe: one 'open' and one machine open per dispatch (repeated pixel loads shouldn't pile up rows).
      const existingOpen = await prisma.emailEvent.findFirst({
        where: { messageId: dispatch.messageId, eventType },
      });
      if (!existingOpen) {
        await prisma.emailEvent.create({
          data: {
            messageId: dispatch.messageId,
            eventType,
            ...(botReason ? { botReason } : {}),
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
  return pixelResponse();
}

/**
 * HEAD returns the pixel's headers but never records an open: link checkers
 * and proxies send HEAD, a mail client loading the image never does.
 */
export async function HEAD() {
  return pixelResponse();
}
