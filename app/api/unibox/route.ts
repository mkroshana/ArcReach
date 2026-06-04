import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';

export async function GET() {
  try {
    const session = await getSession();
    
    let inboundWhere = {};
    if (session.role !== 'ADMIN') {
      inboundWhere = {
        senderAccount: {
          userId: session.id
        }
      };
    }

    const replies = await prisma.inboundResponse.findMany({
      where: inboundWhere,
      include: {
        lead: {
          include: {
            enrollments: true
          }
        },
        senderAccount: true
      },
      orderBy: { receivedAt: 'desc' }
    });

    return NextResponse.json(replies);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const session = await getSession();
    const data = await req.json();
    const { responseId, leadId, unread, leadStatus, enrollmentStatus } = data;

    if (!responseId && !leadId) {
      return NextResponse.json({ error: 'Either responseId or leadId is required.' }, { status: 400 });
    }

    // 1. Update unread status on InboundResponse
    if (responseId && unread !== undefined) {
      await prisma.inboundResponse.update({
        where: { id: responseId },
        data: { unread: !!unread }
      });
    }

    // 2. Update Lead CRM status
    if (leadId && leadStatus !== undefined) {
      await prisma.lead.update({
        where: { id: leadId },
        data: { status: leadStatus }
      });
    }

    // 3. Update CampaignEnrollment status (e.g. pause/resume all enrollments for this lead)
    if (leadId && enrollmentStatus !== undefined) {
      await prisma.campaignEnrollment.updateMany({
        where: { leadId },
        data: { status: enrollmentStatus } // 'Active' or 'Paused'
      });
    }

    // Return the updated reply details if responseId is provided
    if (responseId) {
      const updatedReply = await prisma.inboundResponse.findUnique({
        where: { id: responseId },
        include: {
          lead: {
            include: {
              enrollments: true
            }
          },
          senderAccount: true
        }
      });
      return NextResponse.json(updatedReply);
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
