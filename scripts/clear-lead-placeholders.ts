/**
 * Clear the stand-in names and companies the leads page used to store.
 *
 * Background: CSV import stored a lead with no name under its address's local
 * part ('info' for info@acme.com) and one with no company as 'Unknown', and
 * Add Lead stored a blank company as 'Self Employed' (and, briefly, a click on
 * the import area stored a typed address with company 'External Node').
 * personalizeEmail only falls back to 'there' or 'your company' when the field
 * is empty, so emails went out as 'Hi info, I noticed Unknown is hiring'. The
 * app now stores null for a missing name, company or job title; this script
 * sets to null, using the rules in lib/leadPlaceholders:
 *   - a name that is exactly the local part of the lead's email;
 *   - a company that is exactly 'Unknown', 'Self Employed' or 'External Node'.
 * The import wrote the name exactly as the email's local part was stored, so
 * run this BEFORE `scripts/normalize-lead-emails.ts --apply`, which lowercases
 * stored emails. Run after it, 'John.Smith' for john.smith@acme.com no longer
 * matches exactly, and a merge that kept one lead's placeholder over a
 * duplicate's real name or company has already deleted the duplicate, so
 * clearing the placeholder loses that value for good. Run before it, the merge
 * fills the cleared fields from the duplicates.
 * A name that matches the local part only once letter case or spaces are
 * ignored ('John' for john@acme.com) may be a real first name: it is listed
 * and left alone unless --include-case-variants is passed. A name someone
 * typed identical to the local part ('john' for john@acme.com) is cleared
 * too, so review the dry-run list before --apply. Each name is cleared only if
 * it is still the value read, so an edit made mid-run is kept. Running it
 * again is safe; a second run finds nothing to do.
 *
 * Usage:
 *   npx tsx scripts/clear-lead-placeholders.ts                                  # dry-run report only (default, no writes)
 *   npx tsx scripts/clear-lead-placeholders.ts --apply                          # clear exact placeholders (writes)
 *   npx tsx scripts/clear-lead-placeholders.ts --apply --include-case-variants  # also clear case-variant names (writes)
 */
import { PrismaClient } from '@prisma/client';
import { type LeadPlaceholderRow, PLACEHOLDER_COMPANIES, planLeadPlaceholders } from '../lib/leadPlaceholders';

const prisma = new PrismaClient();

const args = process.argv.slice(2);
const DO_APPLY = args.includes('--apply');
const INCLUDE_CASE_VARIANTS = args.includes('--include-case-variants');
const LIST_LIMIT = 50;
/** Name updates sent to the database in one transaction. */
const UPDATE_CHUNK = 500;

function listRows(rows: LeadPlaceholderRow[], describe: (row: LeadPlaceholderRow) => string): void {
  for (const row of rows.slice(0, LIST_LIMIT)) console.log(`  ${describe(row)}`);
  if (rows.length > LIST_LIMIT) console.log(`  ... and ${rows.length - LIST_LIMIT} more.`);
}

async function main() {
  console.log(
    `[Lead Placeholders] Mode: ${DO_APPLY ? 'APPLY' : 'DRY-RUN (no changes)'}` +
    `${INCLUDE_CASE_VARIANTS ? ', including case-variant names' : ''}`
  );

  const leads = await prisma.lead.findMany({ select: { id: true, email: true, name: true, company: true } });
  const plan = planLeadPlaceholders(leads);
  const names = INCLUDE_CASE_VARIANTS ? [...plan.names, ...plan.caseVariantNames] : plan.names;

  console.log(
    `[Lead Placeholders] Leads: ${leads.length}. Names that are the email's local part: ${plan.names.length}. ` +
    `Names that match it only ignoring case or spaces: ${plan.caseVariantNames.length}` +
    `${INCLUDE_CASE_VARIANTS ? ' (cleared)' : ' (left alone)'}. ` +
    `Companies ${PLACEHOLDER_COMPANIES.map((c) => `'${c}'`).join(' or ')}: ${plan.companies.length}.`
  );
  if (plan.names.length > 0) console.log('[Lead Placeholders] Names to clear:');
  listRows(plan.names, (row) => `${row.email}: name "${row.name}"`);
  if (plan.caseVariantNames.length > 0) {
    console.log(`[Lead Placeholders] Case-variant names${INCLUDE_CASE_VARIANTS ? ' to clear' : ', left alone (pass --include-case-variants to clear)'}:`);
  }
  listRows(plan.caseVariantNames, (row) => `${row.email}: name "${row.name}"`);
  if (plan.companies.length > 0) console.log('[Lead Placeholders] Companies to clear:');
  listRows(plan.companies, (row) => `${row.email}: company "${row.company}"`);

  if (!DO_APPLY) {
    if (names.length > 0 || plan.companies.length > 0) console.log('[Lead Placeholders] Dry run. Re-run with --apply to write these changes.');
    return;
  }

  let namesCleared = 0;
  for (let i = 0; i < names.length; i += UPDATE_CHUNK) {
    const results = await prisma.$transaction(
      names.slice(i, i + UPDATE_CHUNK).map((row) =>
        prisma.lead.updateMany({ where: { id: row.id, name: row.name }, data: { name: null } })
      )
    );
    namesCleared += results.reduce((n, result) => n + result.count, 0);
  }

  const { count: companiesCleared } = await prisma.lead.updateMany({
    where: { company: { in: [...PLACEHOLDER_COMPANIES] } },
    data: { company: null },
  });

  console.log(`[Lead Placeholders] Cleared ${namesCleared} name(s) and ${companiesCleared} company value(s).`);
}

main()
  .catch((e) => {
    console.error('[Lead Placeholders] Error:', e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
