import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { UnauthorizedError, unauthorizedResponse } from '@/lib/sessionError';
import { findEnrollableLeadIds } from '@/lib/sendEligibility';
import { liftsSuppression, suppressEmail, suppressionReasons } from '@/lib/suppression';
import { normalizeEmail } from '@/lib/leadEmail';
import dns from 'dns';
import { promisify } from 'util';

const resolveMx = promisify(dns.resolveMx);

/**
 * Resolver errors that say the domain does not exist or has no MX records. Any
 * other (a timeout, SERVFAIL, a refused query) only says the lookup failed.
 */
const NO_MX_ERRORS = ['ENOTFOUND', 'ENODATA'];

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
    // Suppression reasons of the target addresses, so a re-check never lifts one (see liftsSuppression)
    const suppression = await suppressionReasons(prisma, targetLeads.map(l => l.email));

    for (const lead of targetLeads) {
      const email = lead.email;
      const parts = email.split('@');
      if (parts.length !== 2) {
        const updated = await prisma.lead.update({
          where: { id: lead.id },
          data: { validationStatus: 'Invalid' }
        });
        // An invalid address stays suppressed even if its lead is deleted and imported again
        await suppressEmail(prisma, lead.email, 'Invalid', 'verification');
        verifiedLeads.push(updated);
        continue;
      }

      const domain = parts[1].trim();
      let status: 'Valid' | 'Invalid' | 'Risky' = 'Invalid';
      // Whether an Invalid result is certain rather than a failed lookup
      let certain = true;

      try {
        // Run DNS MX record lookup
        const mxRecords = await resolveMx(domain);
        if (mxRecords && mxRecords.length > 0) {
          status = 'Valid';
        } else {
          status = 'Invalid';
        }
      } catch (err: any) {
        // ENOTFOUND or ENODATA means no MX records or domain invalid. Any other
        // error still marks the lead Invalid, but not certainly so, so its
        // address is not suppressed and the lead can be re-activated.
        status = 'Invalid';
        certain = NO_MX_ERRORS.includes(err?.code);
      }

      // An address suppressed as a hard bounce or a failed verification stays
      // Invalid, the validation status that shows its suppression
      const reason = suppression.get(normalizeEmail(email));
      if (reason && liftsSuppression({ validationStatus: status }, reason)) {
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
        
        // Enroll in Valid campaigns, unless it may not be emailed (unsubscribed, bounced, archived or suppressed)
        const validCampaigns = await prisma.campaign.findMany({
          where: {
            audienceCohort: 'Valid'
          },
          select: { id: true }
        });
        
        if (validCampaigns.length > 0 && (await findEnrollableLeadIds(prisma, { id: lead.id })).length > 0) {
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
        // A certainly invalid address stays suppressed even if its lead is deleted and imported again
        if (certain) {
          await suppressEmail(prisma, lead.email, 'Invalid', 'verification');
        }
        // Delete enrollments for invalid leads
        await prisma.campaignEnrollment.deleteMany({
          where: { leadId: lead.id }
        });
      }

      verifiedLeads.push(updated);
    }

    return NextResponse.json({ success: true, verifiedLeads });
  } catch (error: any) {
    if (error instanceof UnauthorizedError) return unauthorizedResponse();
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
