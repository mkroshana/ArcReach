import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { UnauthorizedError } from '@/lib/sessionError';

/** Clears this browser's session cookie. */
async function clearSessionCookie() {
  const cookieStore = await cookies();
  cookieStore.delete('user_session');
  return NextResponse.json({ success: true });
}

/**
 * Signs the user out: bumps their tokenVersion, so every session they hold (this cookie and any
 * copy of it) stops working, then clears this browser's cookie.
 */
export async function POST() {
  try {
    const session = await getSession();
    await prisma.user.update({ where: { id: session.id }, data: { tokenVersion: { increment: 1 } } });
  } catch (error) {
    // No valid session means nothing to revoke. A failed write still clears the cookie below.
    if (!(error instanceof UnauthorizedError)) console.error('[Logout] Could not revoke sessions:', error);
  }

  return clearSessionCookie();
}

/**
 * Clears only this browser's cookie and leaves the user's other sessions alone. The cookie is
 * SameSite=Lax, so any cross-site link can trigger a GET; revoking every session is POST-only.
 */
export async function GET() {
  return clearSessionCookie();
}
