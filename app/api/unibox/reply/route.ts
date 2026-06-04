import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    const body = await req.json();
    const { leadId, subject, body: replyBody, senderAccountId } = body;

    if (!leadId || !replyBody) {
      return NextResponse.json({ error: 'leadId and body copy are required.' }, { status: 400 });
    }

    // Generate a unique message ID (e.g. simulating mail SMTP routing headers)
    const randomHex = Array.from({ length: 16 }, () => Math.random().toString(16)[2]).join('');
    const messageId = `msg_${randomHex}@arcreach-relay.net`;

    // 1. Create a dispatch record to trace this sent reply
    const dispatch = await prisma.emailDispatch.create({
      data: {
        leadId,
        messageId,
        sentAt: new Date()
      }
    });

    console.log(`[Outbound Reply Dispatch] SenderAccount: ${senderAccountId || 'Default'}, Lead: ${leadId}, Subject: ${subject}`);

    return NextResponse.json({ success: true, dispatch });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
