import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { setSession } from '@/lib/session';
import { verifyPassword, needsRehash, hashPassword } from '@/lib/auth';

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

    if (user.disabledAt) {
      return NextResponse.json({ error: 'This account has been disabled. Ask an admin to enable it.' }, { status: 403 });
    }

    // Transparently upgrade legacy / low-cost hashes to the current work factor.
    if (needsRehash(user.passwordHash)) {
      try {
        await prisma.user.update({
          where: { id: user.id },
          data: { passwordHash: hashPassword(password) },
        });
      } catch (rehashErr) {
        // Non-fatal: the login still succeeds even if the upgrade write fails.
        console.error('[Login] Password rehash failed:', rehashErr);
      }
    }

    const sessionData = {
      id: user.id,
      name: user.name || 'User',
      email: user.email,
      role: user.role
    };

    await setSession({ ...sessionData, tokenVersion: user.tokenVersion });

    return NextResponse.json({ success: true, user: sessionData });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
