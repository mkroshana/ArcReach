import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session';

export async function GET() {
  try {
    const session = await getSession();
    return NextResponse.json(session);
  } catch (e) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
}
