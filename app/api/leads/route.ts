import { NextRequest, NextResponse } from 'next/server';
import { LeadValidationStatus, type LeadStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { UnauthorizedError, unauthorizedResponse } from '@/lib/sessionError';
import { CAMPAIGN_LABEL_SELECT, dispatchScope, replyScope } from '@/lib/leadHistoryScope';
import { type FieldRule, fieldRules, isPlainObject, pickUpdateFields } from '@/lib/updateAllowList';
import { leadEmailIn, normalizeEmail, parseLeadEmail } from '@/lib/leadEmail';
import { findEnrollableLeadIds } from '@/lib/sendEligibility';
import {
  CRM_STATUSES, liftsSuppression, suppressedLeadFields, suppressionEntries, suppressionReasons, withSuppression,
} from '@/lib/suppression';
import { deleteLeads } from '@/lib/leadDelete';

/** Scalar columns the lead PUT may write, in single and bulk updates. Email and
 *  customVariables are not editable here; group membership goes through groupIds
 *  on a single-lead update. The status is CRM sentiment only: Bounced and
 *  Unsubscribed come with a suppression, never from an edit. */
const LEAD_UPDATE_FIELDS: Record<string, FieldRule> = {
  name: fieldRules.nullableString,
  company: fieldRules.nullableString,
  jobTitle: fieldRules.nullableString,
  status: fieldRules.oneOf(CRM_STATUSES),
  validationStatus: fieldRules.oneOf(Object.values(LeadValidationStatus)),
  isArchived: fieldRules.boolean,
};

function isIdArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string' && v !== '');
}

/** Addresses the suppressed-update 409 spells out; any beyond this are only counted, so the toast stays readable. */
const MAX_LISTED_ADDRESSES = 5;

/**
 * 409 message when `updates` would give any of `leadIds` on the suppression
 * list as a hard bounce or failed verification a validation status it could be
 * mailed with (see liftsSuppression), or null. The suppression list outlives
 * every edit, so such a lead would look deliverable and never be emailed. A
 * status edit is never refused: the status is CRM sentiment and leaves the
 * suppression in place. For several leads it names those on the list, so they
 * can be deselected.
 */
async function suppressedUpdateError(leadIds: string[], updates: Record<string, unknown>): Promise<string | null> {
  if (updates.validationStatus === undefined) return null;
  const leads = await prisma.lead.findMany({ where: { id: { in: leadIds } }, select: { email: true } });
  const reasons = await suppressionReasons(prisma, leads.map((lead) => lead.email));
  const blocked = [...reasons].filter(([, reason]) => liftsSuppression(updates, reason)).map(([email]) => email);
  if (blocked.length === 0) return null;
  const listed = blocked.slice(0, MAX_LISTED_ADDRESSES);
  const unlisted = blocked.length - listed.length;
  const which = leadIds.length === 1
    ? 'This lead\'s address is on the suppression list (hard-bounced or failed verification). '
    : `${blocked.length} of these ${leadIds.length} leads ${blocked.length === 1 ? 'is' : 'are'} on the suppression list ` +
      `(hard-bounced or failed verification): ${listed.join(', ')}${unlisted > 0 ? ` and ${unlisted} more` : ''}. `;
  return which + 'A suppressed address stays Invalid and is never emailed again unless an admin removes it from the list, ' +
    'so nothing was updated.';
}

/**
 * Restarts the Bounced and Failed enrollments of those of `leadIds` that may be
 * emailed at step 1, due now, after an edit sets them Valid. A lead that may
 * not (archived, unsubscribed, bounced, invalid or on the suppression list)
 * keeps them as they are, since the send engine would never send them. A
 * status edit never restarts them: the status is CRM sentiment.
 */
async function reactivateEnrollments(leadIds: string[]): Promise<void> {
  const enrollable = await findEnrollableLeadIds(prisma, { id: { in: leadIds } });
  if (enrollable.length === 0) return;
  await prisma.campaignEnrollment.updateMany({
    where: {
      leadId: { in: enrollable },
      status: { in: ['Bounced', 'Failed'] }
    },
    data: {
      status: 'Active',
      currentSequenceStep: 1,
      nextActionDate: new Date(),
      retryCount: 0
    }
  });
}

export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');
    
    if (id) {
      // The lead row is shared; its dispatches and replies are limited to the caller's own.
      const lead = await prisma.lead.findUnique({
        where: { id },
        include: {
          dispatches: {
            where: dispatchScope(session),
            include: {
              campaign: { select: CAMPAIGN_LABEL_SELECT },
              events: true
            },
            orderBy: { sentAt: 'desc' }
          },
          replies: {
            where: replyScope(session),
            include: {
              campaign: { select: CAMPAIGN_LABEL_SELECT }
            },
            orderBy: { receivedAt: 'desc' }
          },
          groups: {
            include: {
              group: true
            }
          }
        }
      });
      
      if (!lead) {
        return NextResponse.json({ error: 'Lead not found.' }, { status: 404 });
      }
      
      // suppression: the address's suppression-list entry, shown whatever the lead's status says
      const [withEntry] = await withSuppression(prisma, [lead]);
      return NextResponse.json(withEntry);
    }
    
    // In a corporate campaign tool, leads are shared across the CRM.
    const leads = await prisma.lead.findMany({
      include: {
        groups: {
          include: {
            group: true
          }
        }
      },
      orderBy: { email: 'asc' }
    });
    
    return NextResponse.json(await withSuppression(prisma, leads));
  } catch (error: any) {
    if (error instanceof UnauthorizedError) return unauthorizedResponse();
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    const data = await req.json();
    if (!isPlainObject(data)) {
      return NextResponse.json({ error: 'Request body must be a JSON object.' }, { status: 400 });
    }
    if (!normalizeEmail(data.email)) {
      return NextResponse.json({ error: 'Email address is required.' }, { status: 400 });
    }
    // The same check as the CSV import: one plain address, stored trimmed and lowercased
    const email = parseLeadEmail(data.email);
    if (!email) {
      return NextResponse.json({ error: 'Email address must be one valid address, like name@example.com.' }, { status: 400 });
    }

    // Only text, known statuses and group ids reach Prisma; anything else would fail the create or be a nested write
    for (const field of ['name', 'company', 'jobTitle']) {
      if (data[field] != null && typeof data[field] !== 'string') {
        return NextResponse.json({ error: `${field} must be text or null.` }, { status: 400 });
      }
    }
    // The status is CRM sentiment only: Bounced and Unsubscribed come with a suppression
    if (data.status != null && !(CRM_STATUSES as unknown[]).includes(data.status)) {
      return NextResponse.json({ error: `status must be one of ${CRM_STATUSES.join(', ')}.` }, { status: 400 });
    }
    const validationStatuses = Object.values(LeadValidationStatus);
    if (data.validationStatus != null && !(validationStatuses as unknown[]).includes(data.validationStatus)) {
      return NextResponse.json({ error: `validationStatus must be one of ${validationStatuses.join(', ')}.` }, { status: 400 });
    }
    if (data.groupIds != null && !isIdArray(data.groupIds)) {
      return NextResponse.json({ error: 'groupIds must be an array of lead group IDs.' }, { status: 400 });
    }
    const { name, company, jobTitle, status, validationStatus, groupIds } = data as {
      name?: string | null; company?: string | null; jobTitle?: string | null;
      status?: LeadStatus | null; validationStatus?: LeadValidationStatus | null; groupIds?: string[] | null;
    };

    // Check if lead already exists, under any capitalisation
    const existing = await prisma.lead.findFirst({
      where: leadEmailIn([email]),
      select: { id: true }
    });

    if (existing) {
      return NextResponse.json({ error: 'Lead with this email address already exists.' }, { status: 400 });
    }

    // An address on the suppression list comes back with its suppressed status
    const suppression = (await suppressionEntries(prisma, [email])).get(email) ?? null;

    const created = await prisma.lead.create({
      data: {
        email,
        name: name || null,
        company: company || null,
        jobTitle: jobTitle || null,
        status: status || 'Neutral',
        validationStatus: validationStatus || 'Unverified',
        ...(suppression ? suppressedLeadFields(suppression.reason) : {}),
        isArchived: false,
        groups: {
          create: (groupIds || []).map((gId: string) => ({ groupId: gId }))
        }
      },
      include: {
        groups: {
          include: { group: true }
        }
      }
    });

    // If validationStatus is Valid or Unverified, enroll in all matching campaigns, unless it may not be emailed
    if (created.validationStatus === 'Valid' || created.validationStatus === 'Unverified') {
      const campaigns = await prisma.campaign.findMany({
        where: {
          audienceCohort: created.validationStatus === 'Unverified' ? 'Unverified' : 'Valid'
        },
        select: { id: true }
      });
      if (campaigns.length > 0 && (await findEnrollableLeadIds(prisma, { id: created.id })).length > 0) {
        await prisma.campaignEnrollment.createMany({
          data: campaigns.map(c => ({
            leadId: created.id,
            campaignId: c.id,
            status: 'Active',
            currentSequenceStep: 1,
            nextActionDate: new Date()
          })),
          skipDuplicates: true
        });
      }
    }

    // suppression tells the leads page the address is on the suppression list
    return NextResponse.json({ ...created, suppression });
  } catch (error: any) {
    if (error instanceof UnauthorizedError) return unauthorizedResponse();
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const session = await getSession();
    const data = await req.json();
    if (!isPlainObject(data)) {
      return NextResponse.json({ error: 'Request body must be a JSON object.' }, { status: 400 });
    }
    const { id, ids, groupId, groupIds, ...fields } = data;

    if (groupIds !== undefined && (ids !== undefined || groupId !== undefined)) {
      return NextResponse.json({ error: 'groupIds can only be set when updating a single lead.' }, { status: 400 });
    }

    // Only listed scalar columns reach Prisma; object values would be nested writes.
    const picked = pickUpdateFields(fields, LEAD_UPDATE_FIELDS);
    if (!picked.ok) {
      return NextResponse.json({ error: picked.error }, { status: 400 });
    }
    const updates = picked.data;

    // 1. Bulk Update by Lead IDs
    if (ids !== undefined) {
      if (!isIdArray(ids)) {
        return NextResponse.json({ error: 'ids must be an array of lead IDs.' }, { status: 400 });
      }
      const suppressedError = await suppressedUpdateError(ids, updates);
      if (suppressedError) {
        return NextResponse.json({ error: suppressedError }, { status: 409 });
      }
      const result = await prisma.lead.updateMany({
        where: { id: { in: ids } },
        data: updates
      });
      if (updates.validationStatus === 'Valid') {
        await reactivateEnrollments(ids);
      }
      return NextResponse.json({ success: true, count: result.count });
    }

    // 2. Bulk Update by Group ID
    if (groupId !== undefined) {
      if (typeof groupId !== 'string' || groupId === '') {
        return NextResponse.json({ error: 'groupId must be a lead group ID.' }, { status: 400 });
      }
      const memberships = await prisma.leadGroupMembership.findMany({
        where: { groupId },
        select: { leadId: true }
      });
      const leadIds = memberships.map(m => m.leadId);
      if (leadIds.length > 0) {
        const suppressedError = await suppressedUpdateError(leadIds, updates);
        if (suppressedError) {
          return NextResponse.json({ error: suppressedError }, { status: 409 });
        }
        const result = await prisma.lead.updateMany({
          where: { id: { in: leadIds } },
          data: updates
        });
        if (updates.validationStatus === 'Valid') {
          await reactivateEnrollments(leadIds);
        }
        return NextResponse.json({ success: true, count: result.count });
      }
      return NextResponse.json({ success: true, count: 0 });
    }

    // 3. Fallback to Single Update
    if (!id || typeof id !== 'string') {
      return NextResponse.json({ error: 'Lead ID, ids array, or groupId is required.' }, { status: 400 });
    }

    const dataObj: any = { ...updates };
    if (groupIds !== undefined) {
      if (!isIdArray(groupIds)) {
        return NextResponse.json({ error: 'groupIds must be an array of lead group IDs.' }, { status: 400 });
      }
      dataObj.groups = {
        deleteMany: {},
        create: groupIds.map((gId: string) => ({ groupId: gId }))
      };
    }

    const suppressedError = await suppressedUpdateError([id], updates);
    if (suppressedError) {
      return NextResponse.json({ error: suppressedError }, { status: 409 });
    }

    const updated = await prisma.lead.update({
      where: { id },
      data: dataObj,
      include: {
        groups: {
          include: { group: true }
        }
      }
    });

    if (updates.validationStatus === 'Valid') {
      await reactivateEnrollments([id]);
    }

    const [withEntry] = await withSuppression(prisma, [updated]);
    return NextResponse.json(withEntry);
  } catch (error: any) {
    if (error instanceof UnauthorizedError) return unauthorizedResponse();
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const session = await getSession();
    // Leads are shared and a delete cascades to every user's enrollments,
    // dispatches, events and replies, so only admins may delete them. The
    // suppression list has no relation to Lead, so no delete lifts it, and
    // deleteLeads keeps the ids of emailed leads so their unsubscribe links still work.
    if (session.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Forbidden. Admin role required.' }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');
    const all = searchParams.get('all');

    // 1. Delete All Leads
    if (all === 'true') {
      await deleteLeads(prisma, {});
      return NextResponse.json({ success: true });
    }

    // 2. Single Delete (via query parameter)
    if (id) {
      if ((await deleteLeads(prisma, { id })) === 0) {
        return NextResponse.json({ error: 'Lead not found.' }, { status: 404 });
      }
      return NextResponse.json({ success: true });
    }

    // 3. Bulk Delete (via request body list of ids)
    const data = await req.json().catch(() => ({}));
    const { ids } = data;

    if (ids && Array.isArray(ids) && ids.length > 0) {
      await deleteLeads(prisma, { id: { in: ids } });
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: 'Lead ID, ids array, or all parameter is required.' }, { status: 400 });
  } catch (error: any) {
    if (error instanceof UnauthorizedError) return unauthorizedResponse();
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
