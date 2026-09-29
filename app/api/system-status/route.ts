import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getGlobalSettings } from '@/lib/settings';
import { getSession } from '@/lib/session';
import { getVerifiedDomains } from '@/lib/azureDomains';

export async function GET() {
  try {
    const session = await getSession();
    
    // Check if database is operational
    await prisma.user.findFirst();

    // Filter scopes based on permissions
    let filterScope = {};
    if (session.role !== 'ADMIN') {
      filterScope = { userId: session.id };
    }

    // 1. Get counts
    const accountsCount = await prisma.senderAccount.count({
      where: filterScope
    });

    const activeCampaignsCount = await prisma.campaign.count({
      where: {
        ...filterScope,
        status: 'Active'
      }
    });

    const leadsCount = await prisma.lead.count();

    const globalSettings = await getGlobalSettings();
    const smtpConfigured = !!(globalSettings?.smtpHost && globalSettings?.smtpUser);

    // 2. Compute Azure API status
    let azureStatus = 'NOT_ACTIVE';
    const activeProvider = globalSettings?.activeProvider || 'DISABLED';
    if (activeProvider === 'AZURE') {
      const connString = globalSettings?.azureConnString;
      if (!connString || getVerifiedDomains(globalSettings).length === 0) {
        azureStatus = 'UNCONFIGURED';
      } else {
        azureStatus = 'OPERATIONAL';
        const parts = connString.split(';');
        const endpointPart = parts.find(p => p.trim().startsWith('endpoint='));
        if (endpointPart) {
          const endpointUrl = endpointPart.split('=')[1]?.trim();
          if (endpointUrl) {
            try {
              const controller = new AbortController();
              const timeoutId = setTimeout(() => controller.abort(), 2500);
              await fetch(endpointUrl, { method: 'HEAD', signal: controller.signal });
              clearTimeout(timeoutId);
            } catch (e: any) {
              azureStatus = 'UNREACHABLE';
            }
          }
        }
      }
    }

    // 3. Computed dynamic status
    let deliveryStatus = 'INACTIVE'; // No sender accounts and no SMTP
    if (accountsCount > 0 || smtpConfigured) {
      if (activeCampaignsCount > 0) {
        deliveryStatus = 'OPERATIONAL';
      } else {
        deliveryStatus = 'STANDBY'; // Configured but outbox is idle
      }
    }

    return NextResponse.json({
      database: 'OPERATIONAL',
      azureStatus,
      deliveryStatus,
      smtpConfigured,
      accountsCount,
      activeCampaignsCount,
      leadsCount,
      activeProvider
    });
  } catch (error: any) {
    return NextResponse.json({
      database: 'DOWN',
      azureStatus: 'UNCONFIGURED',
      deliveryStatus: 'INACTIVE',
      smtpConfigured: false,
      accountsCount: 0,
      activeCampaignsCount: 0,
      leadsCount: 0,
      activeProvider: 'DISABLED',
      error: error.message
    }, { status: 500 });
  }
}
