/**
 * Eagerly seeds the dev default users (admin-id-999, user-id-111) so CI and
 * fresh databases don't depend on the lazy ensureInit() path that only fires
 * when a db.* helper is called. Idempotent.
 *
 * Both users get a published default password, so the script refuses to run
 * with NODE_ENV=production or when DATABASE_URL is not a local or test
 * database (lib/devSeed). Pass --force to seed such a database anyway.
 *
 * Usage:
 *   npm run seed:dev
 *   npm run seed:dev -- --force   # seed a non-local database or NODE_ENV=production anyway
 */
import { ensureDefaultUsers, prisma } from '../lib/db';
import { devSeedRefusal } from '../lib/devSeed';

const FORCE = process.argv.slice(2).includes('--force');

async function main() {
  // Checked after lib/db's PrismaClient has loaded .env, so this is the DATABASE_URL it connects to.
  const refusal = devSeedRefusal(process.env);
  if (refusal) {
    if (!FORCE) {
      console.error(`[Seed] Refusing to seed the dev users: ${refusal} Pass --force to seed this database anyway.`);
      process.exitCode = 1;
      return;
    }
    console.warn(`[Seed] --force: seeding the dev users although ${refusal}`);
  }
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
