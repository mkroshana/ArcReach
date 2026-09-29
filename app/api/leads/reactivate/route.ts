import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { UnauthorizedError, unauthorizedResponse } from '@/lib/sessionError';
import { normalizeEmail } from '@/lib/leadEmail';
import { suppressionReasons } from '@/lib/suppression';

/**
 * POST /api/leads/reactivate  { ids }
 *
 * Re-activate on the Suppressed Leads tab. Of the selected leads:
 *   - an unsubscribed one (on the suppression list as an opt-out or spam
 *     complaint, or with status Unsubscribed) is skipped;
 *   - one whose address is on the suppression list as a hard bounce or failed
 *     verification is skipped: only an admin removes an address from the list
 *     (DELETE /api/leads/suppression);
 *   - one that is Bounced or Invalid without a suppression (a DNS lookup that
 *     failed rather than found no domain, or a status set before the list
 *     existed) goes back to Unverified, and from Bounced to Neutral, to be
 *     verified again. It is never set Valid, and its enrollments are left as
 *     they are;
 *   - any other is left alone.
 * Returns how many leads fell in each group, so the page can say what happened.
 */
export async function POST(req: NextRequest) {
  try {
    await getSession();
    const body = await req.json().catch(() => null);
    const ids = body?.ids;
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === 'string' && id !== '')) {
      return NextResponse.json({ error: 'ids must be a non-empty array of lead IDs.' }, { status: 400 });
    }

    const leads = await prisma.lead.findMany({
      where: { id: { in: ids } },
      select: { id: true, email: true, status: true, validationStatus: true },
    });
    const reasons = await suppressionReasons(prisma, leads.map((lead) => lead.email));

    const reactivate: string[] = [];
    let unsubscribed = 0;
    let suppressed = 0;
    let notSuppressed = 0;
    for (const lead of leads) {
      const reason = reasons.get(normalizeEmail(lead.email));
      if (lead.status === 'Unsubscribed' || reason === 'Unsubscribed' || reason === 'Complaint') unsubscribed++;
      else if (reason) suppressed++;
      else if (lead.status === 'Bounced' || lead.validationStatus === 'Invalid') reactivate.push(lead.id);
      else notSuppressed++;
    }

    if (reactivate.length > 0) {
      await prisma.$transaction([
        prisma.lead.updateMany({ where: { id: { in: reactivate }, status: 'Bounced' }, data: { status: 'Neutral' } }),
        prisma.lead.updateMany({ where: { id: { in: reactivate } }, data: { validationStatus: 'Unverified' } }),
      ]);
    }

    return NextResponse.json({ reactivated: reactivate.length, unsubscribed, suppressed, notSuppressed });
  } catch (error: any) {
    if (error instanceof UnauthorizedError) return unauthorizedResponse();
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
