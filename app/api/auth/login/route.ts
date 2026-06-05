import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { setSession } from '@/lib/session';
import { verifyPassword } from '@/lib/auth';

export async function POST(req: NextRequest) {
  try {
    const { email, password } = await req.json();

    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password are required.' }, { status: 400 });
    }

    const user = await prisma.user.findUnique({
      where: { email }
    });

    if (!user || !verifyPassword(password, user.passwordHash)) {
      return NextResponse.json({ error: 'Invalid email or password.' }, { status: 401 });
    }

    const sessionData = {
      id: user.id,
      name: user.name || 'User',
      email: user.email,
      role: user.role
    };

    await setSession(sessionData);

    return NextResponse.json({ success: true, user: sessionData });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
