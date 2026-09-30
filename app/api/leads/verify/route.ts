import { NextRequest, NextResponse } from 'next/server';
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

/**
 * Runs the domain MX check on one batch of leads (`ids`, at most
 * DOMAIN_CHECK_BATCH_SIZE) and answers how many it set Valid, Risky and
 * Invalid. An Invalid domain puts the address on the suppression list; the
 * lead's enrollments are left as they are, since the send engine never sends
 * to an Invalid or suppressed lead.
 */
export async function POST(req: NextRequest) {
  try {
    await getSession();
    const body = await req.json().catch(() => ({}));
    const ids = parseIds(body?.ids);
    if (!ids) {
      return NextResponse.json(
        { error: `ids must be an array of 1 to ${DOMAIN_CHECK_BATCH_SIZE} lead ids.` },
        { status: 400 },
      );
    }

    const targetLeads = await prisma.lead.findMany({
      where: { id: { in: ids } },
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
    return NextResponse.json({
      success: true,
      checked: results.length,
      counts,
      results: results.map(({ id, validationStatus }) => ({ id, validationStatus })),
    });
  } catch (error: any) {
    if (error instanceof UnauthorizedError) return unauthorizedResponse();
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
