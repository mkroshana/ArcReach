/**
 * Encrypt legacy plaintext mailbox passwords (SenderAccount.smtpPass / imapPass).
 *
 * Background: mailboxes saved before lib/secrets existed store their passwords
 * as plaintext. decryptSecret passes such values through, so they keep working,
 * but they stay unencrypted at rest until the mailbox is re-saved. This script
 * encrypts them in place with the key the app uses. Values that are already
 * encrypted are left alone, so running it again is safe.
 *
 * SECRETS_KEY must be set to the same key the app runs with. Without it
 * lib/secrets falls back to the dev key and the app could not decrypt the
 * result, so the script refuses to run. It also stops before writing anything
 * if an already-encrypted value does not decrypt with the given key.
 *
 * Usage:
 *   npx tsx scripts/encrypt-mailbox-secrets.ts            # dry-run report only (default, no writes)
 *   npx tsx scripts/encrypt-mailbox-secrets.ts --write    # encrypt the plaintext values (writes)
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DO_WRITE = process.argv.slice(2).includes('--write');
const FIELDS = ['smtpPass', 'imapPass'] as const;

async function main() {
  if (!process.env.SECRETS_KEY) {
    throw new Error('SECRETS_KEY must be set to the key the app runs with.');
  }
  // Loaded after the check: lib/secrets derives its key when the module loads.
  const { encryptSecret, decryptSecret, isEncrypted } = await import('../lib/secrets');

  console.log(`[Mailbox Secrets] Mode: ${DO_WRITE ? 'WRITE' : 'DRY-RUN (no changes)'}`);

  const rows = await prisma.senderAccount.findMany({
    where: { OR: [{ smtpPass: { not: null } }, { imapPass: { not: null } }] },
    select: { id: true, emailAddress: true, smtpPass: true, imapPass: true },
  });

  const pending: { row: (typeof rows)[number]; fields: (typeof FIELDS)[number][] }[] = [];
  const undecryptable: string[] = [];
  let alreadyEncrypted = 0;

  for (const row of rows) {
    const fields: (typeof FIELDS)[number][] = [];
    for (const field of FIELDS) {
      const value = row[field];
      if (!value) continue;
      if (isEncrypted(value)) {
        alreadyEncrypted++;
        try {
          decryptSecret(value);
        } catch {
          undecryptable.push(`${row.emailAddress} (${field})`);
        }
      } else {
        fields.push(field);
      }
    }
    if (fields.length > 0) pending.push({ row, fields });
  }

  const plaintextCount = pending.reduce((n, p) => n + p.fields.length, 0);
  console.log(`[Mailbox Secrets] Already encrypted: ${alreadyEncrypted}. Plaintext: ${plaintextCount} in ${pending.length} mailbox(es).`);
  for (const p of pending) console.log(`  ${p.row.emailAddress}: ${p.fields.join(', ')}`);

  if (undecryptable.length > 0) {
    throw new Error(
      `${undecryptable.length} encrypted value(s) do not decrypt with this SECRETS_KEY: ${undecryptable.join(', ')}. ` +
      'Nothing was written. Use the key the app runs with.'
    );
  }

  if (!DO_WRITE) {
    if (plaintextCount > 0) console.log('[Mailbox Secrets] Dry run. Re-run with --write to encrypt these values.');
    return;
  }

  let updated = 0;
  let skipped = 0;
  for (const { row, fields } of pending) {
    const data: { smtpPass?: string; imapPass?: string } = {};
    for (const field of fields) {
      const plain = row[field] as string;
      const ciphertext = encryptSecret(plain);
      if (decryptSecret(ciphertext) !== plain) {
        throw new Error(`Round-trip check failed for ${row.emailAddress} (${field}).`);
      }
      data[field] = ciphertext;
    }
    // Match the values read above so a password changed in the meantime is not overwritten.
    const res = await prisma.senderAccount.updateMany({
      where: { id: row.id, smtpPass: row.smtpPass, imapPass: row.imapPass },
      data,
    });
    if (res.count === 1) {
      updated++;
    } else {
      skipped++;
      console.log(`  ${row.emailAddress}: changed since it was read, skipped (re-run to pick it up).`);
    }
  }

  console.log(`[Mailbox Secrets] Encrypted ${updated} mailbox(es)${skipped > 0 ? `, skipped ${skipped}` : ''}.`);
}

main()
  .catch((e) => {
    console.error('[Mailbox Secrets] Error:', e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
