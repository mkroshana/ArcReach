export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startBackgroundWorker } = await import('./lib/workerDaemon');
    startBackgroundWorker();
  }
}
