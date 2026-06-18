import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import dns from 'dns';
import { promisify } from 'util';

const resolveMx = promisify(dns.resolveMx);

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    const body = await req.json().catch(() => ({}));
    const { ids } = body;

    let targetLeads;
    if (ids && Array.isArray(ids)) {
      targetLeads = await prisma.lead.findMany({
        where: { id: { in: ids } }
      });
    } else {
      targetLeads = await prisma.lead.findMany({
        where: { 
          validationStatus: { 
            in: ['Unverified', 'Risky'] 
          } 
        }
      });
    }

    const verifiedLeads = [];

    for (const lead of targetLeads) {
      const email = lead.email;
      const parts = email.split('@');
      if (parts.length !== 2) {
        const updated = await prisma.lead.update({
          where: { id: lead.id },
          data: { validationStatus: 'Invalid' }
        });
        verifiedLeads.push(updated);
        continue;
      }

      const domain = parts[1].trim();
      let status: 'Valid' | 'Invalid' | 'Risky' = 'Invalid';

      try {
        // Run DNS MX record lookup
        const mxRecords = await resolveMx(domain);
        if (mxRecords && mxRecords.length > 0) {
          status = 'Valid';
        } else {
          status = 'Invalid';
        }
      } catch (err: any) {
        // ENOTFOUND or ENODATA means no MX records or domain invalid
        status = 'Invalid';
      }

      const updated = await prisma.lead.update({
        where: { id: lead.id },
        data: { validationStatus: status }
      });

      if (status === 'Valid') {
        // Remove from Unverified campaigns
        await prisma.campaignEnrollment.deleteMany({
          where: {
            leadId: lead.id,
            campaign: {
              audienceCohort: 'Unverified'
            }
          }
        });
        
        // Enroll in Valid campaigns
        const validCampaigns = await prisma.campaign.findMany({
          where: {
            audienceCohort: 'Valid'
          },
          select: { id: true }
        });
        
        if (validCampaigns.length > 0) {
          await prisma.campaignEnrollment.createMany({
            data: validCampaigns.map(c => ({
              leadId: lead.id,
              campaignId: c.id,
              status: 'Active',
              currentSequenceStep: 1,
              nextActionDate: new Date()
            })),
            skipDuplicates: true
          });
        }
      } else if (status === 'Invalid') {
        // Delete enrollments for invalid leads
        await prisma.campaignEnrollment.deleteMany({
          where: { leadId: lead.id }
        });
      }

      verifiedLeads.push(updated);
    }

    return NextResponse.json({ success: true, verifiedLeads });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
