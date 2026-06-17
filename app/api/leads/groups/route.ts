import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';

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

    if (!id) {
      return NextResponse.json({ error: 'Group ID is required.' }, { status: 400 });
    }

    // Retrieve memberships to check which leads are associated with the group
    const memberships = await prisma.leadGroupMembership.findMany({
      where: { groupId: id },
      select: { leadId: true }
    });
    const leadIds = memberships.map(m => m.leadId);

    if (leadIds.length > 0) {
      if (leadAction === 'DELETE') {
        // Delete all leads associated with this group
        await prisma.lead.deleteMany({
          where: { id: { in: leadIds } }
        });
      } else if (leadAction === 'MOVE' && targetGroupId) {
        // Transfer memberships to the target group, skipping duplicates
        await prisma.leadGroupMembership.createMany({
          data: leadIds.map(leadId => ({
            leadId,
            groupId: targetGroupId
          })),
          skipDuplicates: true
        });
      }
    }

    // Finally delete the group itself
    await prisma.leadGroup.delete({
      where: { id }
    });

    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
