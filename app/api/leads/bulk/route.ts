import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { UnauthorizedError, unauthorizedResponse } from '@/lib/sessionError';
import { leadEmailIn, normalizeEmail, parseLeadEmail } from '@/lib/leadEmail';
import { LEAD_IMPORT_BATCH_SIZE, type LeadImportOutcome, countLeadImport, leadTextField } from '@/lib/leadImport';
import { isPlainObject } from '@/lib/updateAllowList';
import { findEnrollableLeadIds } from '@/lib/sendEligibility';
import { suppressedLeadFields, suppressionReasons } from '@/lib/suppression';
import { enrollGroupJoiners } from '@/lib/campaignCohort';

/** The text fields a row may carry besides its email, each a string, null or absent. */
const LEAD_TEXT_FIELDS = ['name', 'company', 'jobTitle'];

function isIdArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string' && v !== '');
}

/**
 * Imports `leads` and answers with each row's outcome (see LeadImportOutcome),
 * in the order sent, and their counts. A row whose email is not one valid
 * address is refused and the rest are imported. Every imported address, new
 * or already in the CRM, joins `groupIds` and the campaigns targeting those
 * groups (enrollGroupJoiners). Every write happens in one transaction, so a
 * request that fails imports none of its rows and the page can say so and
 * send them again.
 */
export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    const data = await req.json();
    if (!isPlainObject(data)) {
      return NextResponse.json({ error: 'Request body must be a JSON object.' }, { status: 400 });
    }
    const { leads, groupIds = [] } = data;

    if (!leads || !Array.isArray(leads) || leads.length === 0) {
      return NextResponse.json({ error: 'Leads array is required.' }, { status: 400 });
    }
    if (leads.length > LEAD_IMPORT_BATCH_SIZE) {
      return NextResponse.json({ error: `At most ${LEAD_IMPORT_BATCH_SIZE} leads can be imported per request.` }, { status: 400 });
    }
    const badRow = leads.findIndex((l) => !isPlainObject(l) ||
      LEAD_TEXT_FIELDS.some((field) => l[field] !== undefined && l[field] !== null && typeof l[field] !== 'string'));
    if (badRow !== -1) {
      return NextResponse.json({ error: `Lead ${badRow + 1} must be an object whose name, company and jobTitle are text or null.` }, { status: 400 });
    }
    if (!isIdArray(groupIds)) {
      return NextResponse.json({ error: 'groupIds must be an array of lead group IDs.' }, { status: 400 });
    }

    // A missing group would fail the membership write, so it is refused before anything is imported
    const targetGroupIds = Array.from(new Set(groupIds));
    if (targetGroupIds.length > 0) {
      const found = await prisma.leadGroup.findMany({ where: { id: { in: targetGroupIds } }, select: { id: true } });
      if (found.length !== targetGroupIds.length) {
        return NextResponse.json({ error: 'The lead group to import into does not exist.' }, { status: 400 });
      }
    }

    // Emails are stored trimmed and lowercased, and blank text fields as null; the first row for each address wins
    const outcomes: LeadImportOutcome[] = new Array(leads.length);
    const seenEmails = new Set<string>();
    const incoming: { row: number; email: string; name: string | null; company: string | null; jobTitle: string | null }[] = [];
    leads.forEach((l: Record<string, any>, row: number) => {
      const email = parseLeadEmail(l.email);
      if (!email) {
        outcomes[row] = 'invalid';
      } else if (seenEmails.has(email)) {
        outcomes[row] = 'duplicate';
      } else {
        seenEmails.add(email);
        incoming.push({ row, email, name: leadTextField(l.name), company: leadTextField(l.company), jobTitle: leadTextField(l.jobTitle) });
      }
    });

    if (incoming.length > 0) {
      await prisma.$transaction(async (tx) => {
        // 1. Fetch existing leads matching these emails, under any capitalisation, to filter out duplicates
        const existingLeads = await tx.lead.findMany({
          where: leadEmailIn(incoming.map(l => l.email)),
          select: { email: true }
        });
        const existingEmails = new Set(existingLeads.map(l => normalizeEmail(l.email)));

        // Filter leads to create
        const leadsToCreate = incoming.filter(l => !existingEmails.has(l.email));
        for (const l of incoming) {
          if (existingEmails.has(l.email)) outcomes[l.row] = 'existing';
        }

        if (leadsToCreate.length > 0) {
          // Addresses on the suppression list are still created, with their suppressed status, and never enrolled
          const suppression = await suppressionReasons(tx, leadsToCreate.map(l => l.email));
          for (const l of leadsToCreate) {
            outcomes[l.row] = suppression.has(l.email) ? 'suppressed' : 'created';
          }

          // 2. Perform bulk insertion of new leads
          await tx.lead.createMany({
            data: leadsToCreate.map(l => {
              const reason = suppression.get(l.email);
              return {
                email: l.email,
                name: l.name,
                company: l.company,
                jobTitle: l.jobTitle,
                status: 'Neutral',
                validationStatus: 'Unverified',
                ...(reason ? suppressedLeadFields(reason) : {}),
                isArchived: false
              };
            }),
            skipDuplicates: true
          });
        }

        // 3. Fetch every imported lead, new or already in the CRM, to link relationships (group membership & campaign enrollment)
        const importedLeads = await tx.lead.findMany({
          where: leadEmailIn(incoming.map(l => l.email)),
          select: { id: true, email: true }
        });
        const createdEmails = new Set(leadsToCreate.map(l => l.email));
        const newlyCreatedLeads = importedLeads.filter(l => createdEmails.has(l.email));

        // 4. Put every imported lead in the groups, including leads already in the CRM, and enroll
        // those that may be emailed in the campaigns targeting those groups, whatever their status
        if (targetGroupIds.length > 0 && importedLeads.length > 0) {
          const memberships = [];
          for (const lead of importedLeads) {
            for (const gId of targetGroupIds) {
              memberships.push({
                leadId: lead.id,
                groupId: gId
              });
            }
          }
          await tx.leadGroupMembership.createMany({
            data: memberships,
            skipDuplicates: true
          });
          await enrollGroupJoiners(tx, importedLeads.map(l => l.id), targetGroupIds);
        }

        // 5. Enroll newly created leads that may be emailed in all active campaigns targeting the Unverified cohort
        const unverifiedCampaigns = await tx.campaign.findMany({
          where: { audienceCohort: 'Unverified' },
          select: { id: true }
        });

        if (unverifiedCampaigns.length > 0 && newlyCreatedLeads.length > 0) {
          const enrollableLeadIds = await findEnrollableLeadIds(tx, { id: { in: newlyCreatedLeads.map(l => l.id) } });
          const enrollments = [];
          for (const leadId of enrollableLeadIds) {
            for (const campaign of unverifiedCampaigns) {
              enrollments.push({
                leadId,
                campaignId: campaign.id,
                status: 'Active',
                currentSequenceStep: 1,
                nextActionDate: new Date()
              });
            }
          }
          if (enrollments.length > 0) {
            await tx.campaignEnrollment.createMany({
              data: enrollments,
              skipDuplicates: true
            });
          }
        }
      }, { timeout: 30_000 });
    }

    // outcomes has one entry per row of `leads`, in order, so the page can say what happened to each
    return NextResponse.json({ success: true, counts: countLeadImport(outcomes), outcomes });
  } catch (error: any) {
    if (error instanceof UnauthorizedError) return unauthorizedResponse();
    console.error('Failed bulk ingestion:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
