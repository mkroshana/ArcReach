import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { leadEmailIn, normalizeEmail } from '@/lib/leadEmail';
import { unsuppressEmail } from '@/lib/suppression';

/**
 * DELETE /api/leads/suppression  { email }
 *
 * Takes one address off the suppression list, so campaigns may enroll and
 * email it again. Admins only, one address at a time: the leads page shows the
 * reason and asks to confirm first. Its lead goes back to Neutral and, if it
 * bounced or failed verification, to Unverified to be verified again (see
 * unsuppressEmail). Each removal is logged with the admin and the entry
 * removed. Returns the removed entry and the lead, if there is one.
 */
export async function DELETE(req: NextRequest) {
  try {
    const session = await getSession();
    if (session.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Forbidden. Admin role required.' }, { status: 403 });
    }

    const body = await req.json().catch(() => null);
    const email = normalizeEmail(body?.email);
    if (!email) {
      return NextResponse.json({ error: 'email must be the address to remove from the suppression list.' }, { status: 400 });
    }

    const removed = await prisma.$transaction((tx) => unsuppressEmail(tx, email));
    if (!removed) {
      return NextResponse.json({ error: 'This address is not on the suppression list.' }, { status: 404 });
    }
    console.info(
      `[Suppression] ${session.email} (${session.id}) removed ${email} from the suppression list ` +
      `(reason ${removed.reason}, source ${removed.source}, added ${removed.createdAt.toISOString()}).`,
    );

    const lead = await prisma.lead.findFirst({
      where: leadEmailIn([email]),
      include: { groups: { include: { group: true } } },
    });
    return NextResponse.json({ success: true, removed, lead: lead ? { ...lead, suppression: null } : null });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
