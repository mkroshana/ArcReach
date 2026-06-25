/**
 * Eagerly seeds the dev default users (admin-id-999, user-id-111) so CI and
 * fresh databases don't depend on the lazy ensureInit() path that only fires
 * when a db.* helper is called. Idempotent.
 */
import { ensureDefaultUsers, prisma } from '../lib/db';

async function main() {
  await ensureDefaultUsers();
  console.log('[Seed] Default dev users present.');
}

main()
  .catch((e) => {
    console.error('[Seed] Failed to seed default dev users:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
