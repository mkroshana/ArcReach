import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { db, prisma } from '@/lib/db';
import { getSession, setSession } from '@/lib/session';
import { UnauthorizedError, unauthorizedResponse } from '@/lib/sessionError';
import { passwordPolicyError } from '@/lib/passwordPolicy';

class AdminConflictError extends Error {}

/**
 * Runs `write` (a demotion, disable or deletion of user `id`) only if another active (not disabled)
 * ADMIN would remain, so the workspace always keeps someone who can manage users. A target that is
 * not an active admin can not lower that count, so its write runs directly. For an active admin
 * target the count and the write share one serializable transaction, so two admins demoting each
 * other at once can not both pass it.
 */
async function keepAnotherAdmin<T>(
  id: string,
  message: string,
  write: (client: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const current = await prisma.user.findUnique({ where: { id }, select: { role: true, disabledAt: true } });
  if (current?.role !== 'ADMIN' || current.disabledAt) return write(prisma);

  try {
    return await prisma.$transaction(async (tx) => {
      const target = await tx.user.findUnique({ where: { id }, select: { role: true, disabledAt: true } });
      if (
        target?.role === 'ADMIN' && !target.disabledAt &&
        (await tx.user.count({ where: { role: 'ADMIN', disabledAt: null } })) <= 1
      ) {
        throw new AdminConflictError(message);
      }
      return write(tx);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10_000, timeout: 60_000 });
  } catch (error) {
    // P2034: the serializable transaction lost to a concurrent write (e.g. another admin change).
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
      throw new AdminConflictError('Another change to admin roles happened at the same time. Please retry.');
    }
    throw error;
  }
}

/** 409 text for a user who still owns `mailboxes` sender mailboxes and `campaigns` campaigns. */
function userOwnsWorkMessage(mailboxes: number, campaigns: number): string {
  const owned = [
    mailboxes > 0 ? `${mailboxes} ${mailboxes === 1 ? 'mailbox' : 'mailboxes'}` : '',
    campaigns > 0 ? `${campaigns} ${campaigns === 1 ? 'campaign' : 'campaigns'}` : '',
  ].filter(Boolean).join(' and ');
  const it = mailboxes + campaigns === 1 ? 'it' : 'them';
  return `Cannot remove this user while they own ${owned}. Reassign ${it} to another user or delete ${it} first.`;
}

export async function GET() {
  try {
    const session = await getSession();
    if (session.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Forbidden. Admin role required.' }, { status: 403 });
    }

    const users = await db.getUsers();
    return NextResponse.json(users);
  } catch (error: any) {
    if (error instanceof UnauthorizedError) return unauthorizedResponse();
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (session.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Forbidden. Admin role required.' }, { status: 403 });
    }

    const { name, email, role, password } = await req.json();
    if (!email || !role) {
      return NextResponse.json({ error: 'Email and role are required' }, { status: 400 });
    }
    const passwordError = passwordPolicyError(password);
    if (passwordError) {
      return NextResponse.json({ error: passwordError }, { status: 400 });
    }

    const newUser = await db.createUser({
      name: name || '',
      email,
      role: role as 'ADMIN' | 'USER',
      password,
    });

    return NextResponse.json(newUser);
  } catch (error: any) {
    if (error instanceof UnauthorizedError) return unauthorizedResponse();
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const session = await getSession();
    if (session.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Forbidden. Admin role required.' }, { status: 403 });
    }

    const { id, role, password, disabled } = await req.json();
    if (!id) {
      return NextResponse.json({ error: 'User ID is required' }, { status: 400 });
    }
    if (!role && password === undefined && disabled === undefined) {
      return NextResponse.json({ error: 'A role, password or disabled flag is required' }, { status: 400 });
    }
    if (disabled !== undefined && typeof disabled !== 'boolean') {
      return NextResponse.json({ error: 'disabled must be true or false' }, { status: 400 });
    }
    const passwordError = password !== undefined ? passwordPolicyError(password) : null;
    if (passwordError) {
      return NextResponse.json({ error: passwordError }, { status: 400 });
    }

    const demoting = !!role && role !== 'ADMIN';
    if (demoting && id === session.id) {
      return NextResponse.json({ error: 'You cannot remove your own admin role. Ask another admin to change it.' }, { status: 409 });
    }
    if (disabled === true && id === session.id) {
      return NextResponse.json({ error: 'You cannot disable your own account. Ask another admin to do it.' }, { status: 409 });
    }

    let updated;
    if (role) {
      updated = demoting
        ? await keepAnotherAdmin(id, 'Cannot demote the last remaining admin. Promote another user to admin first.', (tx) => db.updateUserRole(id, role, tx))
        : await db.updateUserRole(id, role);
    }
    if (password) {
      const { tokenVersion, ...user } = await db.updateUserPassword(id, password);
      // The reset ends every session of the user. Resetting your own keeps you signed in here.
      if (id === session.id) await setSession({ ...session, tokenVersion });
      updated = user;
    }
    if (disabled !== undefined) {
      updated = disabled
        ? await keepAnotherAdmin(id, 'Cannot disable the last active admin. Promote another user to admin first.', (tx) => db.setUserDisabled(id, true, tx))
        : await db.setUserDisabled(id, false);
    }
    if (!updated) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    return NextResponse.json(updated);
  } catch (error: any) {
    if (error instanceof UnauthorizedError) return unauthorizedResponse();
    if (error instanceof AdminConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const session = await getSession();
    if (session.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Forbidden. Admin role required.' }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');
    if (!id) {
      return NextResponse.json({ error: 'User ID is required' }, { status: 400 });
    }

    // Protect currently logged in admin from deletion
    if (id === session.id) {
      return NextResponse.json({ error: 'Cannot delete your own active session.' }, { status: 400 });
    }

    // Refuse, deleting nothing, while the user still owns mailboxes or campaigns, so removing a
    // user never takes their work and its history with it.
    const [mailboxes, campaigns] = await Promise.all([
      prisma.senderAccount.count({ where: { userId: id } }),
      prisma.campaign.count({ where: { userId: id } }),
    ]);
    if (mailboxes > 0 || campaigns > 0) {
      return NextResponse.json({ error: userOwnsWorkMessage(mailboxes, campaigns), mailboxes, campaigns }, { status: 409 });
    }

    const deleted = await keepAnotherAdmin(id, 'Cannot delete the last remaining admin. Promote another user to admin first.', (tx) => db.deleteUser(id, tx));
    if (!deleted) {
      return NextResponse.json({ error: 'Failed to delete user or user not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    if (error instanceof UnauthorizedError) return unauthorizedResponse();
    if (error instanceof AdminConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    // P2003: the user was given a mailbox or campaign after the check above, and the Restrict
    // foreign keys refused the delete.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
      return NextResponse.json({
        error: 'Cannot remove this user while they own mailboxes or campaigns. Reassign them to another user or delete them first.',
      }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
