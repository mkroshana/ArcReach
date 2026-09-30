import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { UnauthorizedError, unauthorizedResponse } from '@/lib/sessionError';
import { deleteLeads } from '@/lib/leadDelete';
import { enrollGroupJoiners } from '@/lib/campaignCohort';

/** Campaign names the in-use 409 spells out; any beyond this are only counted, so the toast stays readable. */
const MAX_LISTED_CAMPAIGNS = 5;

/** 409 text for a group that `total` campaigns still target, naming the ones in `visibleNames`. */
function groupInUseMessage(total: number, visibleNames: string[]): string {
  const listed = visibleNames.slice(0, MAX_LISTED_CAMPAIGNS).map((n) => `"${n}"`);
  const unlisted = total - listed.length;
  const detail = listed.length === 0 ? '' : `: ${listed.join(', ')}${unlisted > 0 ? ` and ${unlisted} more` : ''}`;
  const one = total === 1;
  return `Cannot delete this group while ${one ? 'a campaign targets' : `${total} campaigns target`} it${detail}. ` +
    `Point ${one ? 'that campaign' : 'those campaigns'} at another audience or delete ${one ? 'it' : 'them'} first.`;
}

export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    
    const groups = await prisma.leadGroup.findMany({
      include: {
        _count: {
          select: { leads: true }
        }
      },
      orderBy: { name: 'asc' }
    });
    
    return NextResponse.json(groups);
  } catch (error: any) {
    if (error instanceof UnauthorizedError) return unauthorizedResponse();
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    const data = await req.json();
    const { name, description } = data;

    if (!name) {
      return NextResponse.json({ error: 'Group name is required.' }, { status: 400 });
    }

    const existing = await prisma.leadGroup.findUnique({
      where: { name }
    });

    if (existing) {
      return NextResponse.json({ error: 'A lead group with this name already exists.' }, { status: 400 });
    }

    const created = await prisma.leadGroup.create({
      data: {
        name,
        description: description || null
      }
    });

    return NextResponse.json(created);
  } catch (error: any) {
    if (error instanceof UnauthorizedError) return unauthorizedResponse();
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const session = await getSession();
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');
    const leadAction = searchParams.get('leadAction') || 'KEEP'; // KEEP, DELETE, MOVE
    const targetGroupId = searchParams.get('targetGroupId');

    // Deleting the group's leads cascades to every user's history, so it is admin-only.
    if (leadAction === 'DELETE' && session.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Forbidden. Admin role required.' }, { status: 403 });
    }

    if (!id) {
      return NextResponse.json({ error: 'Group ID is required.' }, { status: 400 });
    }

    // Refuse, deleting nothing, while any campaign targets this group as its audience; the
    // enrollment sync would otherwise find no eligible leads and drop every enrollment. The sync
    // also accepts a `group_` prefix on the id. Non-admins only get the names of their own campaigns.
    const dependents = await prisma.campaign.findMany({
      where: { audienceCohort: { in: [id, `group_${id}`] } },
      select: { name: true, userId: true },
      orderBy: { name: 'asc' },
    });
    if (dependents.length > 0) {
      const visibleNames = dependents
        .filter((c) => session.role === 'ADMIN' || c.userId === session.id)
        .map((c) => c.name);
      return NextResponse.json({ error: groupInUseMessage(dependents.length, visibleNames) }, { status: 409 });
    }

    // Retrieve memberships to check which leads are associated with the group
    const memberships = await prisma.leadGroupMembership.findMany({
      where: { groupId: id },
      select: { leadId: true }
    });
    const leadIds = memberships.map(m => m.leadId);

    if (leadIds.length > 0) {
      if (leadAction === 'DELETE') {
        // Delete all leads associated with this group, keeping the ids of emailed ones for their unsubscribe links
        await deleteLeads(prisma, { id: { in: leadIds } });
      } else if (leadAction === 'MOVE' && targetGroupId) {
        // Transfer memberships to the target group, skipping duplicates
        await prisma.leadGroupMembership.createMany({
          data: leadIds.map(leadId => ({
            leadId,
            groupId: targetGroupId
          })),
          skipDuplicates: true
        });
        // and enroll them in the campaigns targeting the target group, whatever their status
        await enrollGroupJoiners(prisma, leadIds, [targetGroupId]);
      }
    }

    // Finally delete the group itself
    await prisma.leadGroup.delete({
      where: { id }
    });

    return NextResponse.json({ success: true });
  } catch (error: any) {
    if (error instanceof UnauthorizedError) return unauthorizedResponse();
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
