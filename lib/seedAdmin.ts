import type { PrismaClient } from '@prisma/client';
import { hashPassword } from '@/lib/auth';
import { passwordPolicyError } from '@/lib/passwordPolicy';

/**
 * Passwords this repo has published: the old seed default, which .env.example and the README
 * printed and the dev users in lib/db still use. The first admin may never be given one.
 */
export const PUBLISHED_PASSWORDS: readonly string[] = ['securepassword123'];

/** Why `password` can not be the first admin's password, or null when it can. */
export function seedAdminPasswordError(password: string): string | null {
  const policyError = passwordPolicyError(password);
  if (policyError) return policyError;
  if (PUBLISHED_PASSWORDS.includes(password)) {
    return 'That password is a published default. Choose another.';
  }
  return null;
}

export type SeedAdminResult =
  | { outcome: 'created'; email: string }
  /** An ADMIN user (disabled or not) already exists, so nothing was written. */
  | { outcome: 'admin-exists'; email: string }
  /** No admin exists but `email` belongs to a user, who is left as they are. */
  | { outcome: 'email-taken'; email: string }
  | { outcome: 'invalid-password'; error: string };

/**
 * Creates the first admin (`email`, `name`, the password `readPassword` returns) only when the
 * database has no ADMIN user at all. It never updates a user: an existing admin's password, role,
 * name and sessions stay as they are, and an `email` that already belongs to a user is refused
 * rather than promoted or given a new password. `readPassword` is called only once the admin will
 * be created, so a run against a database that has an admin asks for nothing.
 */
export async function seedAdmin(
  client: Pick<PrismaClient, 'user'>,
  { email, name }: { email: string; name: string },
  readPassword: () => Promise<string>,
): Promise<SeedAdminResult> {
  const admin = await client.user.findFirst({
    where: { role: 'ADMIN' },
    select: { email: true },
    orderBy: { createdAt: 'asc' },
  });
  if (admin) return { outcome: 'admin-exists', email: admin.email };

  if (await client.user.findUnique({ where: { email }, select: { id: true } })) {
    return { outcome: 'email-taken', email };
  }

  const password = await readPassword();
  const error = seedAdminPasswordError(password);
  if (error) return { outcome: 'invalid-password', error };

  await client.user.create({
    data: { email, name, passwordHash: await hashPassword(password), role: 'ADMIN' },
  });
  return { outcome: 'created', email };
}
