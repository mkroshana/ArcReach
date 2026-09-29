import { NextRequest, NextResponse } from 'next/server';
import { LeadStatus, LeadValidationStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { CAMPAIGN_LABEL_SELECT, dispatchScope, replyScope } from '@/lib/leadHistoryScope';
import { type FieldRule, fieldRules, isPlainObject, pickUpdateFields } from '@/lib/updateAllowList';
import { leadEmailIn, normalizeEmail } from '@/lib/leadEmail';

/** Scalar columns the lead PUT may write, in single and bulk updates. Email and
 *  customVariables are not editable here; group membership goes through groupIds
 *  on a single-lead update. */
const LEAD_UPDATE_FIELDS: Record<string, FieldRule> = {
  name: fieldRules.nullableString,
  company: fieldRules.nullableString,
  jobTitle: fieldRules.nullableString,
  status: fieldRules.oneOf(Object.values(LeadStatus)),
  validationStatus: fieldRules.oneOf(Object.values(LeadValidationStatus)),
  isArchived: fieldRules.boolean,
};

function isIdArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string' && v !== '');
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
      
      return NextResponse.json(lead);
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
    
    return NextResponse.json(leads);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    const data = await req.json();
    const { name, company, jobTitle, status, validationStatus, groupIds } = data;
    const email = normalizeEmail(data.email);

    if (!email) {
      return NextResponse.json({ error: 'Email address is required.' }, { status: 400 });
    }

    // Check if lead already exists, under any capitalisation
    const existing = await prisma.lead.findFirst({
      where: leadEmailIn([email]),
      select: { id: true }
    });

    if (existing) {
      return NextResponse.json({ error: 'Lead with this email address already exists.' }, { status: 400 });
    }

    const created = await prisma.lead.create({
      data: {
        email,
        name: name || null,
        company: company || null,
        jobTitle: jobTitle || null,
        status: status || 'Neutral',
        validationStatus: validationStatus || 'Unverified',
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

    // If validationStatus is Valid or Unverified, enroll in all matching campaigns
    if (created.validationStatus === 'Valid' || created.validationStatus === 'Unverified') {
      const campaigns = await prisma.campaign.findMany({
        where: {
          audienceCohort: created.validationStatus === 'Unverified' ? 'Unverified' : 'Valid'
        },
        select: { id: true }
      });
      if (campaigns.length > 0) {
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

    return NextResponse.json(created);
  } catch (error: any) {
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
      const result = await prisma.lead.updateMany({
        where: { id: { in: ids } },
        data: updates
      });
      if (updates.status === 'Neutral' || updates.validationStatus === 'Valid') {
        await prisma.campaignEnrollment.updateMany({
          where: {
            leadId: { in: ids },
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
        const result = await prisma.lead.updateMany({
          where: { id: { in: leadIds } },
          data: updates
        });
        if (updates.status === 'Neutral' || updates.validationStatus === 'Valid') {
          await prisma.campaignEnrollment.updateMany({
            where: {
              leadId: { in: leadIds },
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

    const updated = await prisma.lead.update({
      where: { id },
      data: dataObj,
      include: {
        groups: {
          include: { group: true }
        }
      }
    });

    if (updates.status === 'Neutral' || updates.validationStatus === 'Valid') {
      await prisma.campaignEnrollment.updateMany({
        where: {
          leadId: id,
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

    return NextResponse.json(updated);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const session = await getSession();
    // Leads are shared and a delete cascades to every user's enrollments,
    // dispatches, events and replies, so only admins may delete them.
    if (session.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Forbidden. Admin role required.' }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');
    const all = searchParams.get('all');

    // 1. Delete All Leads
    if (all === 'true') {
      await prisma.lead.deleteMany({});
      return NextResponse.json({ success: true });
    }

    // 2. Single Delete (via query parameter)
    if (id) {
      await prisma.lead.delete({
        where: { id }
      });
      return NextResponse.json({ success: true });
    }

    // 3. Bulk Delete (via request body list of ids)
    const data = await req.json().catch(() => ({}));
    const { ids } = data;

    if (ids && Array.isArray(ids) && ids.length > 0) {
      await prisma.lead.deleteMany({
        where: { id: { in: ids } }
      });
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: 'Lead ID, ids array, or all parameter is required.' }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
