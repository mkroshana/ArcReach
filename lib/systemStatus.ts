import type { PauseReason } from './campaignPause';

/**
 * The system status the sidebar and dashboard show, from real signals only:
 * the saved Azure settings (never probed, so 'CONFIGURED' does not mean Azure
 * accepts the access key) and the send worker's heartbeat on its WorkerLease
 * row. Pure so the client can word it.
 */

/** 'DISABLED' when Azure is not the selected provider. */
export type AzureStatus = 'DISABLED' | 'UNCONFIGURED' | 'CONFIGURED';

/**
 * The send worker, from its lease and heartbeat: 'NOT_RUNNING' when no process
 * holds the lease, 'FAILING' when its last send cycle threw, 'STALLED' when it
 * holds the lease but no send cycle has finished for WORKER_STALL_MS.
 */
export type WorkerStatus = 'NOT_RUNNING' | 'FAILING' | 'STALLED' | 'RUNNING';

/** Whether campaign email goes out: 'DISABLED' when the settings refuse every send, else the worker's status. */
export type DeliveryStatus = WorkerStatus | 'DISABLED';

/** Send cycles start every 30 seconds and send one batch, so this long without one finishing means one is stuck. */
export const WORKER_STALL_MS = 15 * 60 * 1000;

/** Pauses the send engine makes because nothing can be sent until someone fixes the setup. */
export const SETUP_PAUSE_REASONS: PauseReason[] = ['config', 'systemic'];

type Instant = Date | string;

export interface WorkerHeartbeat {
  lastTickAt: Instant | null;
  lastSuccessAt: Instant | null;
  lastError: string | null;
}

export function workerStatus(
  lease: (WorkerHeartbeat & { expiresAt: Instant }) | null,
  now: Date = new Date(),
): WorkerStatus {
  if (!lease || new Date(lease.expiresAt).getTime() <= now.getTime()) return 'NOT_RUNNING';
  if (lease.lastError) return 'FAILING';
  if (lease.lastSuccessAt && now.getTime() - new Date(lease.lastSuccessAt).getTime() > WORKER_STALL_MS) return 'STALLED';
  return 'RUNNING';
}

/** "just now", "5 min ago", "3 h ago" or "2 days ago". */
export function timeAgo(at: Instant, now: Date = new Date()): string {
  const minutes = Math.floor((now.getTime() - new Date(at).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** One sentence on the send worker, e.g. "Worker running, last send cycle 3 min ago." */
export function workerStatusText(
  status: WorkerStatus,
  heartbeat: WorkerHeartbeat | null,
  now: Date = new Date(),
): string {
  switch (status) {
    case 'RUNNING':
      return heartbeat?.lastSuccessAt
        ? `Worker running, last send cycle ${timeAgo(heartbeat.lastSuccessAt, now)}.`
        : 'Worker running, no send cycle finished yet.';
    case 'STALLED':
      return `Worker running, but its last send cycle finished ${heartbeat?.lastSuccessAt ? timeAgo(heartbeat.lastSuccessAt, now) : 'a while ago'}; cycles normally run every 30 seconds.`;
    case 'FAILING':
      return heartbeat?.lastError
        ? `Worker running, but its last send cycle failed: ${heartbeat.lastError}`
        : 'Worker running, but its last send cycle failed.';
    case 'NOT_RUNNING':
      return `Worker not running${heartbeat?.lastTickAt ? ` (last send cycle ${timeAgo(heartbeat.lastTickAt, now)})` : ''}. One app instance must run with SEND_WORKER_ENABLED=true to send campaign email.`;
  }
}

/** One sentence on whether campaign email goes out: why sending is disabled, or the worker's status. */
export function deliveryStatusText(
  status: DeliveryStatus,
  sendingProblem: string | null,
  heartbeat: WorkerHeartbeat | null,
  now: Date = new Date(),
): string {
  if (status === 'DISABLED') return sendingProblem || 'Sending is disabled.';
  return workerStatusText(status, heartbeat, now);
}
