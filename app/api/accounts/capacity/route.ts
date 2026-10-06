import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { UnauthorizedError, unauthorizedResponse } from '@/lib/sessionError';
import { getGlobalDailyAllowance } from '@/lib/rateLimits';

/**
 * The daily allowance every mailbox shares while a global rate limit is set: how many emails
 * it allows in any 24 hours and how many are left. `globalDaily` is null when no global limit
 * is set, which is when each mailbox is held to its own daily limit instead. Any signed-in
 * user may read it, since it is what holds their own mailboxes' sends.
 */
export async function GET() {
  try {
    await getSession();
    return NextResponse.json({ globalDaily: await getGlobalDailyAllowance(new Date()) });
  } catch (error: any) {
    if (error instanceof UnauthorizedError) return unauthorizedResponse();
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
