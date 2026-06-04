import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getSession } from '@/lib/session';

export async function GET() {
  try {
    const session = await getSession();
    
    // Fetch campaigns matching constraints - admins see all, users only see theirs
    const campaigns = await db.getCampaigns(session.id, session.role);
    return NextResponse.json(campaigns);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    const data = await req.json();

    const { name, status, senderAccountId, userId } = data;

    if (!name || !senderAccountId) {
      return NextResponse.json({ error: 'Name and sender mailbox are required.' }, { status: 400 });
    }

    // Standard users can only create campaigns owned by themselves
    const targetUserId = session.role === 'ADMIN' ? (userId || session.id) : session.id;

    const newCampaign = await db.createCampaign({
      name,
      status: status || 'Draft',
      senderAccountId,
      userId: targetUserId,
    });

    return NextResponse.json(newCampaign);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const session = await getSession();
    const data = await req.json();
    const { id, ...updates } = data;

    if (!id) {
      return NextResponse.json({ error: 'Campaign ID is required.' }, { status: 400 });
    }

    // Verify ownership
    const campaignsList = await db.getCampaigns(session.id, session.role);
    const hasAccess = campaignsList.some(cmp => cmp.id === id);

    if (!hasAccess) {
      return NextResponse.json({ error: 'Unauthorized to modify this campaign.' }, { status: 403 });
    }

    if (session.role !== 'ADMIN') {
      delete updates.userId;
    }

    const updated = await db.updateCampaign(id, updates);
    return NextResponse.json(updated);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const session = await getSession();
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json({ error: 'Campaign ID is required.' }, { status: 400 });
    }

    // Verify ownership
    const campaignsList = await db.getCampaigns(session.id, session.role);
    const hasAccess = campaignsList.some(cmp => cmp.id === id);

    if (!hasAccess) {
      return NextResponse.json({ error: 'Unauthorized to delete this campaign.' }, { status: 403 });
    }

    await db.deleteCampaign(id);
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
