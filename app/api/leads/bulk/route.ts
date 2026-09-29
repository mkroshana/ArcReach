import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { leadEmailIn, normalizeEmail } from '@/lib/leadEmail';
import { findEnrollableLeadIds } from '@/lib/sendEligibility';
import { suppressedLeadFields, suppressionReasons } from '@/lib/suppression';

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    const data = await req.json();
    const { leads, groupIds } = data;

    if (!leads || !Array.isArray(leads) || leads.length === 0) {
      return NextResponse.json({ error: 'Leads array is required.' }, { status: 400 });
    }

    // Emails are stored trimmed and lowercased; the first row for each address wins
    const seenEmails = new Set<string>();
    const incoming = [];
    for (const l of leads) {
      const email = normalizeEmail(l?.email);
      if (!email || seenEmails.has(email)) continue;
      seenEmails.add(email);
      incoming.push({ ...l, email });
    }
    if (incoming.length === 0) {
      return NextResponse.json({ error: 'No valid email addresses provided.' }, { status: 400 });
    }

    // 1. Fetch existing leads matching these emails, under any capitalisation, to filter out duplicates
    const existingLeads = await prisma.lead.findMany({
      where: leadEmailIn(incoming.map(l => l.email)),
      select: { email: true }
    });
    const existingEmails = new Set(existingLeads.map(l => normalizeEmail(l.email)));

    // Filter leads to create
    const leadsToCreate = incoming.filter(l => !existingEmails.has(l.email));

    if (leadsToCreate.length === 0) {
      return NextResponse.json({ success: true, count: 0, suppressed: 0, message: 'All leads already exist.' });
    }

    // Addresses on the suppression list are still created, with their suppressed status, and never enrolled
    const suppression = await suppressionReasons(prisma, leadsToCreate.map(l => l.email));

    // 2. Perform bulk insertion of new leads
    await prisma.lead.createMany({
      data: leadsToCreate.map(l => {
        const reason = suppression.get(l.email);
        return {
          email: l.email,
          name: l.name || null,
          company: l.company || null,
          jobTitle: l.jobTitle || null,
          status: 'Neutral',
          validationStatus: 'Unverified',
          ...(reason ? suppressedLeadFields(reason) : {}),
          isArchived: false
        };
      }),
      skipDuplicates: true
    });

    // 3. Fetch newly created leads to link relationships (group membership & campaign enrollment)
    const newlyCreatedLeads = await prisma.lead.findMany({
      where: { email: { in: leadsToCreate.map(l => l.email) } },
      select: { id: true, email: true }
    });

    // 4. Create group memberships in bulk if groupIds are provided
    if (groupIds && Array.isArray(groupIds) && groupIds.length > 0 && newlyCreatedLeads.length > 0) {
      const memberships = [];
      for (const lead of newlyCreatedLeads) {
        for (const gId of groupIds) {
          memberships.push({
            leadId: lead.id,
            groupId: gId
          });
        }
      }
      if (memberships.length > 0) {
        await prisma.leadGroupMembership.createMany({
          data: memberships,
          skipDuplicates: true
        });
      }
    }

    // 5. Enroll newly created leads that may be emailed in all active campaigns targeting the Unverified cohort
    const unverifiedCampaigns = await prisma.campaign.findMany({
      where: { audienceCohort: 'Unverified' },
      select: { id: true }
    });

    if (unverifiedCampaigns.length > 0 && newlyCreatedLeads.length > 0) {
      const enrollableLeadIds = await findEnrollableLeadIds(prisma, { id: { in: newlyCreatedLeads.map(l => l.id) } });
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
        await prisma.campaignEnrollment.createMany({
          data: enrollments,
          skipDuplicates: true
        });
      }
    }

    // How many of the new leads are on the suppression list, so the import can say they will not be emailed
    const suppressed = newlyCreatedLeads.filter(l => suppression.has(normalizeEmail(l.email))).length;

    return NextResponse.json({ success: true, count: newlyCreatedLeads.length, suppressed });
  } catch (error: any) {
    console.error('Failed bulk ingestion:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
