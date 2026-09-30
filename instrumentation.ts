export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // A production server with a missing, short or published secret, or no public https
    // APP_URL, fails to start here rather than on the first request or send that needs it.
    const { checkProductionEnv } = await import('./lib/productionEnv');
    checkProductionEnv();

    const { startBackgroundWorker } = await import('./lib/workerDaemon');
    startBackgroundWorker();
  }
}
