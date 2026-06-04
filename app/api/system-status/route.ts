import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';

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

    const globalSettings = await prisma.globalSettings.findFirst();
    const smtpConfigured = !!(globalSettings?.smtpHost && globalSettings?.smtpUser);

    // 2. Computed dynamic status
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
      deliveryStatus,
      smtpConfigured,
      accountsCount,
      activeCampaignsCount,
      leadsCount
    });
  } catch (error: any) {
    return NextResponse.json({
      database: 'DOWN',
      deliveryStatus: 'INACTIVE',
      smtpConfigured: false,
      accountsCount: 0,
      activeCampaignsCount: 0,
      leadsCount: 0,
      error: error.message
    }, { status: 500 });
  }
}
