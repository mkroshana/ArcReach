import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { db, prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { passwordPolicyError } from '@/lib/passwordPolicy';

class AdminConflictError extends Error {}

/**
 * Runs `write` (a demotion or deletion of user `id`) only if another ADMIN would remain, so the
 * workspace always keeps someone who can manage users. A non-admin target can not lower the admin
 * count, so its write runs directly. For an admin target the count and the write share one
 * serializable transaction, so two admins demoting each other at once can not both pass it; the
 * timeout is raised because deleting a user cascades through all of their campaign history.
 */
async function keepAnotherAdmin<T>(
  id: string,
  message: string,
  write: (client: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const current = await prisma.user.findUnique({ where: { id }, select: { role: true } });
  if (current?.role !== 'ADMIN') return write(prisma);

  try {
    return await prisma.$transaction(async (tx) => {
      const target = await tx.user.findUnique({ where: { id }, select: { role: true } });
      if (target?.role === 'ADMIN' && (await tx.user.count({ where: { role: 'ADMIN' } })) <= 1) {
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

export async function GET() {
  try {
    const session = await getSession();
    if (session.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Forbidden. Admin role required.' }, { status: 403 });
    }

    const users = await db.getUsers();
    return NextResponse.json(users);
  } catch (error: any) {
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
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const session = await getSession();
    if (session.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Forbidden. Admin role required.' }, { status: 403 });
    }

    const { id, role, password } = await req.json();
    if (!id) {
      return NextResponse.json({ error: 'User ID is required' }, { status: 400 });
    }
    if (!role && password === undefined) {
      return NextResponse.json({ error: 'A role or password is required' }, { status: 400 });
    }
    const passwordError = password !== undefined ? passwordPolicyError(password) : null;
    if (passwordError) {
      return NextResponse.json({ error: passwordError }, { status: 400 });
    }

    const demoting = !!role && role !== 'ADMIN';
    if (demoting && id === session.id) {
      return NextResponse.json({ error: 'You cannot remove your own admin role. Ask another admin to change it.' }, { status: 409 });
    }

    let updated;
    if (role) {
      updated = demoting
        ? await keepAnotherAdmin(id, 'Cannot demote the last remaining admin. Promote another user to admin first.', (tx) => db.updateUserRole(id, role, tx))
        : await db.updateUserRole(id, role);
    }
    if (password) {
      updated = await db.updateUserPassword(id, password);
    }
    if (!updated) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    return NextResponse.json(updated);
  } catch (error: any) {
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

    const deleted = await keepAnotherAdmin(id, 'Cannot delete the last remaining admin. Promote another user to admin first.', (tx) => db.deleteUser(id, tx));
    if (!deleted) {
      return NextResponse.json({ error: 'Failed to delete user or user not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    if (error instanceof AdminConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
