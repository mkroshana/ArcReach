import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { jwtVerify } from 'jose';
import { sessionSecretKey as secretKey } from './lib/sessionSecret';
import { unauthorizedResponse } from './lib/sessionError';

/**
 * Checks only the session cookie's signature: the Edge runtime has no Prisma. It redirects pages
 * and turns away API calls with no or a badly signed cookie. Whether a signed session is still
 * live (user exists, not disabled, current tokenVersion) is decided by getSession in each API route.
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isApi = pathname.startsWith('/api/');

  // 1. Allow auth APIs, webhook, tracking, and unsubscribe without authentication
  if (
    pathname.startsWith('/api/auth') ||
    pathname.startsWith('/api/track') ||
    pathname.startsWith('/api/unsubscribe') ||
    pathname === '/api/webhook'
  ) {
    return NextResponse.next();
  }

  const sessionCookie = request.cookies.get('user_session');

  // 2. Redirect unauthenticated users to /login (allow /login itself to render); API calls get a 401
  if (!sessionCookie || !sessionCookie.value) {
    if (pathname === '/login') {
      return NextResponse.next();
    }
    if (isApi) {
      return unauthorizedResponse();
    }
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }

  let role = 'USER';
  try {
    const { payload } = await jwtVerify(sessionCookie.value, secretKey);
    role = (payload.role as string) || 'USER';
  } catch {
    // Malformed or expired session cookie
    if (pathname === '/login') {
      const response = NextResponse.next();
      response.cookies.delete('user_session');
      return response;
    }
    const response = isApi ? unauthorizedResponse() : NextResponse.redirect(new URL('/login', request.url));
    response.cookies.delete('user_session');
    return response;
  }

  // 3. Redirect logged-in users away from /login
  if (pathname === '/login') {
    const url = request.nextUrl.clone();
    url.pathname = '/';
    return NextResponse.redirect(url);
  }

  // 4. Protect /admin paths. The token's role only steers the redirect; the admin APIs check the
  // role stored in the database.
  if (pathname.startsWith('/admin')) {
    if (role !== 'ADMIN') {
      const url = request.nextUrl.clone();
      url.pathname = '/';
      return NextResponse.redirect(url);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
