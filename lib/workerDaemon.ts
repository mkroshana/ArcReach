import { processDueEmails } from './sendEngine';

const globalForWorker = globalThis as unknown as { workerStarted: boolean | undefined };

export function startBackgroundWorker() {
  if (globalForWorker.workerStarted) {
    console.log('[Background Worker] Outbound service is already active on this process.');
    return;
  }

  globalForWorker.workerStarted = true;
  console.log('[Background Worker] Starting 24/7 outbound service...');

  // Run immediately on startup
  setTimeout(async () => {
    try {
      await processDueEmails();
    } catch (err) {
      console.error('[Background Worker] Initial execution error:', err);
    }
  }, 1000);

  // Set interval to run every 30 seconds
  setInterval(async () => {
    try {
      console.log('[Background Worker] Checking for due emails...');
      await processDueEmails();
    } catch (err) {
      console.error('[Background Worker] Loop tick execution error:', err);
    }
  }, 30000);
}
