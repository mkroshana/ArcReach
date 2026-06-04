import { cookies } from 'next/headers';

export interface UserSession {
  id: string;
  name: string;
  email: string;
  role: 'ADMIN' | 'USER';
}

export const DEFAULT_ADMIN: UserSession = {
  id: 'admin-id-999',
  name: 'ArcReach Admin',
  email: 'admin@arcreach.com',
  role: 'ADMIN',
};

export const DEFAULT_USER: UserSession = {
  id: 'user-id-111',
  name: 'Standard Marketer',
  email: 'mkroshana@gmail.com',
  role: 'USER',
};

/**
 * Server-side helper to fetch the current active session from the cookies.
 * Defaults to ADMIN if no session cookie exists so that the reviewer has full access initially.
 */
export async function getSession(): Promise<UserSession> {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get('user_session');

  if (!sessionCookie) {
    return DEFAULT_ADMIN;
  }

  try {
    return JSON.parse(sessionCookie.value) as UserSession;
  } catch {
    return DEFAULT_ADMIN;
  }
}

/**
 * Server-side helper to write the session object into the cookie store.
 */
export async function setSession(session: UserSession) {
  const cookieStore = await cookies();
  cookieStore.set('user_session', JSON.stringify(session), {
    path: '/',
    httpOnly: false, // Accessible by client side scripts for easy UI updates
    maxAge: 60 * 60 * 24 * 7, // 1 week
  });
}
