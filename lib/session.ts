import * as jose from 'jose';
import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';
import { prisma } from './db';
import { sessionSecretKey } from './sessionSecret';
import { UnauthorizedError } from './sessionError';

export interface UserSession {
  id: string;
  name: string;
  email: string;
  role: 'ADMIN' | 'USER';
}

/**
 * What the session cookie signs: the user plus the User.tokenVersion it was issued under.
 * Bumping the user's tokenVersion (logout, password or role change, disable) ends every session
 * signed under an older one.
 */
export interface SessionClaims extends UserSession {
  tokenVersion: number;
}

const secretKey = sessionSecretKey;

/**
 * Server-side helper to fetch the current session for an API route. Verifies the cookie's
 * signature, then loads the user: the session is refused when the user no longer exists, is
 * disabled, or has moved to a newer tokenVersion. Name, email and role come from the database,
 * never from the token. Throws UnauthorizedError (clearing the dead cookie) when refused.
 */
export async function getSession(): Promise<UserSession> {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get('user_session');

  if (!sessionCookie || !sessionCookie.value) {
    throw new UnauthorizedError();
  }

  /**
   * Clears the refused cookie so the login page is reachable again, then refuses. Accepted race: a
   * request still in flight with the old cookie when the user changes their own password can land
   * its deletion after the re-issued cookie and sign them out; they sign in with the new password.
   */
  const refuse = (): never => {
    cookieStore.delete('user_session');
    throw new UnauthorizedError();
  };

  let payload: jose.JWTPayload;
  try {
    ({ payload } = await jose.jwtVerify(sessionCookie.value, secretKey));
  } catch {
    return refuse();
  }
  if (typeof payload.id !== 'string') return refuse();

  const user = await prisma.user.findUnique({
    where: { id: payload.id },
    select: { id: true, name: true, email: true, role: true, tokenVersion: true, disabledAt: true },
  });
  // Sessions signed before tokenVersion existed carry none and count as version 0.
  const tokenVersion = typeof payload.tokenVersion === 'number' ? payload.tokenVersion : 0;
  if (!user || user.disabledAt || user.tokenVersion !== tokenVersion) return refuse();

  return {
    id: user.id,
    name: user.name || 'User',
    email: user.email,
    role: user.role,
  };
}

/**
 * Whether a request carries a validly signed session cookie, i.e. comes from a
 * signed-in user of the app. Reads the request's own cookies, for public
 * routes such as the tracking endpoints, where no session is required. Checks
 * the signature only, with no database read: it decides whether a tracking hit
 * is counted and never grants access.
 */
export async function hasValidSession(req: NextRequest): Promise<boolean> {
  const sessionCookie = req.cookies.get('user_session');
  if (!sessionCookie || !sessionCookie.value) return false;

  try {
    await jose.jwtVerify(sessionCookie.value, secretKey);
    return true;
  } catch {
    return false;
  }
}

/**
 * Server-side helper to write the session object into the cookie store.
 */
export async function setSession(session: SessionClaims) {
  const jwt = await new jose.SignJWT({ ...session })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secretKey);

  const cookieStore = await cookies();
  cookieStore.set('user_session', jwt, {
    path: '/',
    httpOnly: true, // Hardened
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 7, // 1 week
  });
}

/**
 * Generates a signed JWT session cookie for testing purposes.
 */
export async function signSession(session: SessionClaims): Promise<string> {
  return new jose.SignJWT({ ...session })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secretKey);
}
