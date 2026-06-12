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

    if (!id) {
      return NextResponse.json({ error: 'Group ID is required.' }, { status: 400 });
    }

    await prisma.leadGroup.delete({
      where: { id }
    });

    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
