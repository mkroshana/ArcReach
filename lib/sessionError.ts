import { NextResponse } from 'next/server';

/**
 * Thrown by getSession when a request has no session, or its session cookie is invalid or was
 * revoked. Every API route answers it with unauthorizedResponse() instead of a 500.
 *
 * Lives apart from lib/session.ts so routes can check for it while tests mock getSession.
 */
export class UnauthorizedError extends Error {
  constructor() {
    super('Unauthorized');
    this.name = 'UnauthorizedError';
  }
}

/** The 401 an API route returns when getSession throws UnauthorizedError. */
export function unauthorizedResponse(): NextResponse {
  return NextResponse.json({ error: 'Your session has ended. Sign in again.' }, { status: 401 });
}
