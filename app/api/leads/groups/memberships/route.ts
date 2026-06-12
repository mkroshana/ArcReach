import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    const data = await req.json();
    const { groupId, leadIds } = data;

    if (!groupId || !leadIds || !Array.isArray(leadIds)) {
      return NextResponse.json({ error: 'Group ID and Lead IDs array are required.' }, { status: 400 });
    }

    // Add leads to group memberships
    await prisma.leadGroupMembership.createMany({
      data: leadIds.map((leadId: string) => ({ groupId, leadId })),
      skipDuplicates: true
    });

    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const session = await getSession();
    const { searchParams } = new URL(req.url);
    const groupId = searchParams.get('groupId');
    const leadId = searchParams.get('leadId');

    if (!groupId || !leadId) {
      return NextResponse.json({ error: 'Both groupId and leadId are required.' }, { status: 400 });
    }

    await prisma.leadGroupMembership.delete({
      where: {
        leadId_groupId: { leadId, groupId }
      }
    });

    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
