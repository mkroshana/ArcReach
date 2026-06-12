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
    const { id, groupIds, ...updates } = data;

    if (!id) {
      return NextResponse.json({ error: 'Lead ID is required.' }, { status: 400 });
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

    if (!id) {
      return NextResponse.json({ error: 'Lead ID is required.' }, { status: 400 });
    }

    await prisma.lead.delete({
      where: { id }
    });

    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
