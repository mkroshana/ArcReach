import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const sessionCookie = request.cookies.get('user_session');
  let role = 'ADMIN'; // Default matching getSession server-side behavior for demo convenience

  if (sessionCookie) {
    try {
      const session = JSON.parse(sessionCookie.value);
      role = session?.role || 'ADMIN';
    } catch {
      // JSON parse fail fallback
    }
  }

  const { pathname } = request.nextUrl;

  // Protect /admin paths
  if (pathname.startsWith('/admin')) {
    if (role !== 'ADMIN') {
      // Redirect standard users to /dashboard
      const url = request.nextUrl.clone();
      url.pathname = '/dashboard';
      return NextResponse.redirect(url);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/admin/:path*'],
};
