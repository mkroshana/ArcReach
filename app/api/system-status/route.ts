import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getGlobalSettings } from '@/lib/settings';
import { getSession } from '@/lib/session';
import { UnauthorizedError, unauthorizedResponse } from '@/lib/sessionError';
import { azureSettingsProblem } from '@/lib/emailProvider';
import { SEND_WORKER_LEASE } from '@/lib/workerLease';
import { SETUP_PAUSE_REASONS, workerStatus, type AzureStatus, type DeliveryStatus } from '@/lib/systemStatus';

/** How many setup-paused campaigns are listed by name; the rest are counted. */
const SETUP_PAUSED_LIST_LIMIT = 5;

export async function GET() {
  try {
    const session = await getSession();
    const isAdmin = session.role === 'ADMIN';

    // Check if database is operational
    await prisma.user.findFirst();

    // Filter scopes based on permissions
    let filterScope = {};
    if (!isAdmin) {
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
    const activeProvider = globalSettings?.activeProvider || 'DISABLED';

    // 2. Azure status from the saved settings, with the connection string
    // decrypted. Nothing calls Azure, so 'CONFIGURED' only means sends will be
    // attempted; a refused key shows up as campaigns paused for 'config' below.
    const sendingProblem = azureSettingsProblem(globalSettings);
    const azureStatus: AzureStatus =
      activeProvider !== 'AZURE' ? 'DISABLED' : sendingProblem ? 'UNCONFIGURED' : 'CONFIGURED';

    // 3. Delivery status from the send worker's heartbeat on its lease row.
    const lease = await prisma.workerLease.findUnique({ where: { name: SEND_WORKER_LEASE } });
    const worker = workerStatus(lease);
    const deliveryStatus: DeliveryStatus = sendingProblem ? 'DISABLED' : worker;

    // 4. Campaigns the send engine paused because nothing can be sent until
    // the Azure settings, sender domain, senders or server clock are fixed.
    const setupPausedWhere = { ...filterScope, status: 'Paused', pauseReason: { in: SETUP_PAUSE_REASONS } };
    const [setupPausedCampaigns, setupPausedCount] = await Promise.all([
      prisma.campaign.findMany({
        where: setupPausedWhere,
        select: { id: true, name: true, status: true, pauseReason: true, pausedUntil: true },
        orderBy: { updatedAt: 'desc' },
        take: SETUP_PAUSED_LIST_LIMIT,
      }),
      prisma.campaign.count({ where: setupPausedWhere }),
    ]);

    return NextResponse.json({
      database: 'OPERATIONAL',
      azureStatus,
      sendingProblem,
      workerStatus: worker,
      // The error can name hosts or tables, so only admins see it.
      workerHeartbeat: lease
        ? { lastTickAt: lease.lastTickAt, lastSuccessAt: lease.lastSuccessAt, lastError: isAdmin ? lease.lastError : null }
        : null,
      deliveryStatus,
      setupPausedCampaigns,
      setupPausedCount,
      accountsCount,
      activeCampaignsCount,
      leadsCount,
      activeProvider
    });
  } catch (error: any) {
    if (error instanceof UnauthorizedError) return unauthorizedResponse();
    return NextResponse.json({
      database: 'DOWN',
      azureStatus: 'UNKNOWN',
      sendingProblem: null,
      workerStatus: 'UNKNOWN',
      workerHeartbeat: null,
      deliveryStatus: 'UNKNOWN',
      setupPausedCampaigns: [],
      setupPausedCount: 0,
      accountsCount: 0,
      activeCampaignsCount: 0,
      leadsCount: 0,
      activeProvider: null,
      error: error.message
    }, { status: 500 });
  }
}
