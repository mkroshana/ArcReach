import * as jose from 'jose';
import { cookies } from 'next/headers';
import { sessionSecretKey } from './sessionSecret';

export interface UserSession {
  id: string;
  name: string;
  email: string;
  role: 'ADMIN' | 'USER';
}

const secretKey = sessionSecretKey;

/**
 * Server-side helper to fetch the current active session from the cookies.
 */
export async function getSession(): Promise<UserSession> {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get('user_session');

  if (!sessionCookie || !sessionCookie.value) {
    throw new Error('Unauthorized');
  }

  try {
    const { payload } = await jose.jwtVerify(sessionCookie.value, secretKey);
    return {
      id: payload.id as string,
      name: payload.name as string,
      email: payload.email as string,
      role: payload.role as 'ADMIN' | 'USER',
    };
  } catch {
    throw new Error('Unauthorized');
  }
}

/**
 * Server-side helper to write the session object into the cookie store.
 */
export async function setSession(session: UserSession) {
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
export async function signSession(session: UserSession): Promise<string> {
  return new jose.SignJWT({ ...session })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secretKey);
}
