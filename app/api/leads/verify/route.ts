import { NextRequest, NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { UnauthorizedError, unauthorizedResponse } from '@/lib/sessionError';
import { findEnrollableLeadIds } from '@/lib/sendEligibility';
import { liftsSuppression, suppressEmails, suppressionReasons } from '@/lib/suppression';
import { normalizeEmail } from '@/lib/leadEmail';
import { REMOVED_ENROLLMENT_STATUS } from '@/lib/campaignCohort';
import {
  checkDomains,
  DOMAIN_CHECK_BATCH_SIZE,
  emailDomain,
  type DomainCheckCounts,
  type DomainCheckStatus,
} from '@/lib/domainCheck';
import { promises as dnsPromises } from 'dns';

/**
 * The domain MX check's lookups (see lib/domainCheck): 3 seconds for the first
 * try and one retry per name server, so a failing resolver makes a domain
 * Risky in seconds, and a batch of distinct domains, looked up
 * DOMAIN_CHECK_CONCURRENCY at a time, stays well inside the request timeout.
 */
const resolver = new dnsPromises.Resolver({ timeout: 3000, tries: 2 });

/** The deduplicated lead ids of `ids`, or null unless it is an array of 1 to DOMAIN_CHECK_BATCH_SIZE non-empty strings. */
function parseIds(ids: unknown): string[] | null {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > DOMAIN_CHECK_BATCH_SIZE) return null;
  if (!ids.every((id) => typeof id === 'string' && id !== '')) return null;
  return Array.from(new Set(ids as string[]));
}

/** The leads `{ all: true }` checks: never checked, or checked without a certain answer. */
const UNCHECKED_WHERE: Prisma.LeadWhereInput = { validationStatus: { in: ['Unverified', 'Risky'] } };

/**
 * Runs the domain MX check on one batch of leads and answers how many it set
 * Valid, Risky and Invalid. The batch is `ids` (at most
 * DOMAIN_CHECK_BATCH_SIZE), or with `{ all: true, after }` the next
 * DOMAIN_CHECK_BATCH_SIZE Unverified and Risky leads in address order after
 * `after`, so the leads page never sends every lead's id; that answer adds
 * `next`, the `after` of the following batch (null when none is left), and how
 * many such leads come after it (`remaining`). Stepping by address checks each
 * lead once, even one the check leaves Risky. An Invalid domain puts the
 * address on the suppression list; the lead's enrollments are left as they
 * are, since the send engine never sends to an Invalid or suppressed lead.
 */
export async function POST(req: NextRequest) {
  try {
    await getSession();
    const body = await req.json().catch(() => ({}));
    const all = body?.all === true;
    const after: unknown = body?.after ?? null;
    if (all && after !== null && (typeof after !== 'string' || after === '')) {
      return NextResponse.json({ error: 'after must be the address the previous batch answered as next.' }, { status: 400 });
    }
    const ids = all ? [] : parseIds(body?.ids);
    if (!ids) {
      return NextResponse.json(
        { error: `ids must be an array of 1 to ${DOMAIN_CHECK_BATCH_SIZE} lead ids.` },
        { status: 400 },
      );
    }

    const targetLeads = await prisma.lead.findMany({
      where: all ? { ...UNCHECKED_WHERE, ...(after !== null ? { email: { gt: after as string } } : {}) } : { id: { in: ids } },
      ...(all ? { orderBy: { email: 'asc' as const }, take: DOMAIN_CHECK_BATCH_SIZE } : {}),
      select: { id: true, email: true },
    });

    // Each distinct domain is looked up once, however many leads share it
    const domainStatuses = await checkDomains(
      resolver,
      targetLeads.map((lead) => emailDomain(lead.email)).filter((domain): domain is string => domain !== null),
    );
    // Suppression reasons of the target addresses, so a re-check never lifts one (see liftsSuppression)
    const suppression = await suppressionReasons(prisma, targetLeads.map((lead) => lead.email));

    const results = targetLeads.map((lead) => {
      const domain = emailDomain(lead.email);
      // A malformed address is Invalid without a lookup
      const checked: DomainCheckStatus = domain === null ? 'Invalid' : domainStatuses.get(domain)!;
      // An address suppressed as a hard bounce or a failed verification stays
      // Invalid, the validation status that shows its suppression
      const reason = suppression.get(normalizeEmail(lead.email));
      const validationStatus: DomainCheckStatus = reason && liftsSuppression({ validationStatus: checked }, reason) ? 'Invalid' : checked;
      return { id: lead.id, email: lead.email, validationStatus, failedCheck: checked === 'Invalid' };
    });
    const idsWith = (status: DomainCheckStatus) => results.filter((r) => r.validationStatus === status).map((r) => r.id);
    const validIds = idsWith('Valid');

    await prisma.$transaction(async (tx) => {
      for (const status of ['Valid', 'Risky', 'Invalid'] as const) {
        const leadIds = idsWith(status);
        if (leadIds.length > 0) {
          await tx.lead.updateMany({ where: { id: { in: leadIds } }, data: { validationStatus: status } });
        }
      }

      // An address whose domain does not exist, or that is malformed, stays
      // suppressed even if its lead is deleted and imported again
      await suppressEmails(
        tx,
        results.filter((r) => r.failedCheck).map((r) => ({ email: r.email, reason: 'Invalid' as const })),
        'verification',
      );

      if (validIds.length > 0) {
        // A Valid lead leaves the Unverified cohort: its Active enrollments in
        // Unverified campaigns stop (Removed, as the cohort sync marks leads
        // that left), and every other enrollment is kept as it is
        await tx.campaignEnrollment.updateMany({
          where: { leadId: { in: validIds }, status: 'Active', campaign: { audienceCohort: 'Unverified' } },
          data: { status: REMOVED_ENROLLMENT_STATUS, nextActionDate: null },
        });

        // Enroll in Valid campaigns, unless it may not be emailed (unsubscribed, bounced, archived or suppressed)
        const validCampaigns = await tx.campaign.findMany({
          where: { audienceCohort: 'Valid' },
          select: { id: true },
        });
        const enrollableLeadIds = validCampaigns.length > 0 ? await findEnrollableLeadIds(tx, { id: { in: validIds } }) : [];
        if (enrollableLeadIds.length > 0) {
          await tx.campaignEnrollment.createMany({
            data: enrollableLeadIds.flatMap((leadId) => validCampaigns.map((c) => ({
              leadId,
              campaignId: c.id,
              status: 'Active',
              currentSequenceStep: 1,
              nextActionDate: new Date(),
            }))),
            skipDuplicates: true,
          });
        }
      }
    });

    const counts: DomainCheckCounts = {
      valid: validIds.length,
      risky: idsWith('Risky').length,
      invalid: idsWith('Invalid').length,
    };
    // A full batch of { all: true } may have more after it
    const last = all && targetLeads.length === DOMAIN_CHECK_BATCH_SIZE ? targetLeads[targetLeads.length - 1].email : null;
    const remaining = last === null ? 0 : await prisma.lead.count({ where: { ...UNCHECKED_WHERE, email: { gt: last } } });
    return NextResponse.json({
      success: true,
      checked: results.length,
      counts,
      results: results.map(({ id, validationStatus }) => ({ id, validationStatus })),
      ...(all ? { next: remaining > 0 ? last : null, remaining } : {}),
    });
  } catch (error: any) {
    if (error instanceof UnauthorizedError) return unauthorizedResponse();
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
