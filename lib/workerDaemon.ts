import { processDueEmails } from './sendEngine';
import { reconcileStaleSendingDispatches, RECONCILE_INTERVAL_MS } from './sendReconciler';
import { syncAllActiveMailboxes } from './imapService';
import { createLeasedTick } from './workerLease';

const globalForWorker = globalThis as unknown as { workerStarted: boolean | undefined };

export function startBackgroundWorker() {
  // Opt-in, so a local `npm run dev` pointed at a shared database never sends.
  if (process.env.SEND_WORKER_ENABLED !== 'true') {
    console.log('[Background Worker] Disabled: SEND_WORKER_ENABLED is not "true", so this process will not send campaign email or sync IMAP replies.');
    return;
  }

  if (globalForWorker.workerStarted) {
    console.log('[Background Worker] Outbound service is already active on this process.');
    return;
  }

  globalForWorker.workerStarted = true;
  console.log('[Background Worker] Starting 24/7 outbound service...');

  // Both loops run only in the process holding the worker lease, and each
  // skips a tick while its previous one is still running.
  // Sends interrupted by a crash or restart are reconciled with ACS on the
  // first send tick this process runs, then at most every RECONCILE_INTERVAL_MS.
  let lastReconcileAt: number | null = null;
  const sendTick = createLeasedTick('send', async () => {
    if (lastReconcileAt === null || Date.now() - lastReconcileAt >= RECONCILE_INTERVAL_MS) {
      lastReconcileAt = Date.now();
      await reconcileStaleSendingDispatches();
    }
    console.log('[Background Worker] Checking for due emails...');
    await processDueEmails();
  }, { heartbeat: true });

  const imapTick = createLeasedTick('IMAP sync', async () => {
    console.log('[Background Worker] Running periodic IMAP mailbox sync...');
    await syncAllActiveMailboxes();
  });

  // Run immediately on startup
  setTimeout(sendTick, 1000);
  setTimeout(imapTick, 5000);

  // Set interval to run every 30 seconds
  setInterval(sendTick, 30000);

  // Set interval to sync IMAP replies every 3 minutes
  setInterval(imapTick, 180000);
}
