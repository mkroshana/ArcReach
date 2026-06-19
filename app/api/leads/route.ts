import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';

export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');
    
    if (id) {
      const lead = await prisma.lead.findUnique({
        where: { id },
        include: {
          dispatches: {
            include: {
              campaign: true,
              events: true
            },
            orderBy: { sentAt: 'desc' }
          },
          replies: {
            include: {
              campaign: true
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
    const { name, email, company, jobTitle, status, validationStatus, groupIds } = data;

    if (!email) {
      return NextResponse.json({ error: 'Email address is required.' }, { status: 400 });
    }

    // Check if lead already exists
    const existing = await prisma.lead.findUnique({
      where: { email }
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
    const { id, ids, groupId, groupIds, ...updates } = data;

    // 1. Bulk Update by Lead IDs
    if (ids && Array.isArray(ids)) {
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
    if (groupId) {
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
    if (!id) {
      return NextResponse.json({ error: 'Lead ID, ids array, or groupId is required.' }, { status: 400 });
    }

    const dataObj: any = { ...updates };
    if (groupIds !== undefined) {
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
