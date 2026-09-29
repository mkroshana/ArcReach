import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { setSession } from '@/lib/session';
import { verifyLoginPassword, needsRehash, hashPassword } from '@/lib/auth';
import { beginLoginAttempt, clientIp } from '@/lib/loginThrottle';

export async function POST(req: NextRequest) {
  try {
    const { email, password } = await req.json();

    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
      return NextResponse.json({ error: 'Email and password are required.' }, { status: 400 });
    }

    // Refused before the database or PBKDF2 is touched, so a flood of guesses costs neither.
    const attempt = beginLoginAttempt(clientIp(req.headers), email);
    if (!attempt.allowed) {
      const minutes = Math.ceil(attempt.retryAfterSeconds / 60);
      return NextResponse.json(
        { error: `Too many sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.` },
        { status: 429, headers: { 'Retry-After': String(attempt.retryAfterSeconds) } }
      );
    }

    const user = await prisma.user.findUnique({
      where: { email }
    });

    // An unknown email is verified against a dummy hash, so it takes as long as a wrong password.
    const passwordValid = await verifyLoginPassword(password, user?.passwordHash);
    if (!user || !passwordValid) {
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
          data: { passwordHash: await hashPassword(password) },
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
    attempt.succeeded();

    return NextResponse.json({ success: true, user: sessionData });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
