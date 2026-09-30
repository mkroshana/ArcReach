import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { UnauthorizedError, unauthorizedResponse } from '@/lib/sessionError';
import { pauseGroupLeavers } from '@/lib/campaignCohort';

export async function DELETE(req: NextRequest) {
  try {
    const session = await getSession();
    const { searchParams } = new URL(req.url);
    const groupId = searchParams.get('groupId');
    const leadId = searchParams.get('leadId');

    if (!groupId || !leadId) {
      return NextResponse.json({ error: 'Both groupId and leadId are required.' }, { status: 400 });
    }

    // The lead's sequence stops in the campaigns targeting the group, kept Paused at its step
    await prisma.$transaction(async (tx) => {
      await tx.leadGroupMembership.delete({
        where: {
          leadId_groupId: { leadId, groupId }
        }
      });
      await pauseGroupLeavers(tx, [leadId], [groupId]);
    });

    return NextResponse.json({ success: true });
  } catch (error: any) {
    if (error instanceof UnauthorizedError) return unauthorizedResponse();
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
