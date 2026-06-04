import { NextRequest, NextResponse } from 'next/server';
import { getSession, setSession, DEFAULT_ADMIN, DEFAULT_USER } from '@/lib/session';

export async function GET() {
  const session = await getSession();
  return NextResponse.json(session);
}

export async function POST(req: NextRequest) {
  try {
    const { action } = await req.json();
    let newSession = DEFAULT_ADMIN;

    if (action === 'set_user') {
      newSession = DEFAULT_USER;
    } else if (action === 'set_admin') {
      newSession = DEFAULT_ADMIN;
    } else {
      return NextResponse.json({ error: 'Invalid session action' }, { status: 400 });
    }

    await setSession(newSession);
    return NextResponse.json({ success: true, session: newSession });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
