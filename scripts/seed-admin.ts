/**
 * Create the first admin user.
 *
 * Creates ADMIN_EMAIL (default admin@arcreach.com) as an ADMIN only when the
 * database has no admin at all (lib/seedAdmin). Once one exists the script
 * changes nothing, so running it again after a schema push is harmless: it
 * never updates an existing user's password, role or sessions. Change
 * passwords in the app instead (Users Admin > Reset password, or Settings
 * for your own).
 *
 * The password comes from ADMIN_PASSWORD or, when that is unset or empty, a
 * prompt in the terminal. There is no default, and the password the repo used
 * to publish as one is refused.
 *
 * Usage:
 *   npm run seed                            # prompts for the password
 *   ADMIN_PASSWORD='<password>' npm run seed # no prompt, e.g. without a terminal
 */
import { PrismaClient } from '@prisma/client';
import { seedAdmin } from '../lib/seedAdmin';

const prisma = new PrismaClient();

/** Reads one line from the terminal without echoing it. Ctrl+C cancels. */
function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  return new Promise((resolve, reject) => {
    const chars: string[] = [];
    const finish = (error?: Error) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(chars.join(''));
    };
    const onData = (chunk: string) => {
      // Arrow and other escape-sequence keys are ignored rather than typed into the password.
      if (chunk.startsWith('\u001b')) return;
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish();
        if (ch === '\u0003') return finish(new Error('Cancelled.'));
        if (ch === '\u007f' || ch === '\b') chars.pop();
        else chars.push(ch);
      }
    };
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    stdin.on('data', onData);
  });
}

async function readAdminPassword(): Promise<string> {
  if (process.env.ADMIN_PASSWORD) {
    console.log('[Seed] Using the password in ADMIN_PASSWORD.');
    return process.env.ADMIN_PASSWORD;
  }
  if (!process.stdin.isTTY) {
    throw new Error('ADMIN_PASSWORD is not set and there is no terminal to ask for the password. Set ADMIN_PASSWORD or run the script in a terminal.');
  }
  const password = await promptHidden('[Seed] Password for the new admin: ');
  const confirmation = await promptHidden('[Seed] Repeat the password: ');
  if (password !== confirmation) {
    throw new Error('The passwords do not match. Nothing was created.');
  }
  return password;
}

async function main() {
  const email = process.env.ADMIN_EMAIL || 'admin@arcreach.com';
  const name = process.env.ADMIN_NAME || 'ArcReach Admin';

  console.log('[Seed] Checking whether the database has an admin...');
  const result = await seedAdmin(prisma, { email, name }, readAdminPassword);

  switch (result.outcome) {
    case 'admin-exists':
      console.log(
        `[Seed] An admin (${result.email}) already exists. Nothing changed: the seed never updates existing users. ` +
        'Change passwords in the app (Users Admin > Reset password, or Settings for your own).'
      );
      break;
    case 'email-taken':
      console.error(
        `[Seed] No admin exists, but "${result.email}" already belongs to a user, who was left unchanged. ` +
        'Set ADMIN_EMAIL to an address no user has and run the seed again.'
      );
      process.exitCode = 1;
      break;
    case 'invalid-password':
      console.error(`[Seed] ${result.error} Nothing was created.`);
      process.exitCode = 1;
      break;
    case 'created':
      console.log(`[Seed] Created admin "${result.email}".`);
      break;
  }
}

main()
  .catch((e) => {
    console.error('[Seed] Error during seeding:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
