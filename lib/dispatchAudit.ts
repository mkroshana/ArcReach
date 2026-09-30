/**
 * Rules for scripts/audit-dispatches.ts, which reports and cleans up
 * EmailDispatch rows written before the send engine recorded each dispatch's
 * step and status, and any duplicate sends that slipped past its per-step guard.
 *
 * A duplicate is a second 'Sent' dispatch for the same campaign, lead and
 * stored stepOrder. Failed, Sending and Unknown rows are attempts, not
 * duplicates: a quota or soft retry leaves a Failed row before the step's Sent
 * row, and both stay. Of a lead's Sent rows for a step, the one kept is the one
 * with events (opens, clicks, an unsubscribe or a bounce), else with a delivery
 * report, else with a provider id, else the earliest. Any other Sent row with
 * events is kept too.
 *
 * Legacy rows have no stored stepOrder. Their step can only be inferred from
 * the subject, which can mistake a follow-up for step 1, so they are never
 * duplicates. A step is backfilled only when the subject matches exactly one
 * step and no other row of the lead has or infers that step, so a backfilled
 * row never shares a step with another row; the send engine never sends a step
 * a lead already has a Sent row for, so a later --fix finds nothing to delete.
 */

export type AuditDispatchRow = {
  id: string;
  leadId: string | null;
  subject: string | null;
  stepOrder: number | null;
  status: string;
  sentAt: Date;
  messageId: string;
  operationId: string | null;
  deliveredAt: Date | null;
  deliveryStatus: string | null;
  bouncedAt: Date | null;
  /** EmailEvent rows (opens, clicks, unsubscribes, bounces) recorded for the dispatch. */
  eventCount: number;
};

export type InferredStep = { row: AuditDispatchRow; stepOrder: number };

export type DuplicateGroup = {
  leadId: string;
  stepOrder: number;
  /** The Sent row --fix keeps. */
  keep: AuditDispatchRow;
  /** What set the kept row above the next best one. */
  keepReason: 'has events' | 'has a delivery report' | 'has a provider id' | 'earliest';
  /** The lead's other Sent rows for the step with no events: --fix deletes these. */
  remove: AuditDispatchRow[];
  /** The lead's other Sent rows for the step with events: never deleted. */
  keepWithEvents: AuditDispatchRow[];
};

export type DispatchAuditPlan = {
  /** Rows with no stored step whose subject matches exactly one step no other row of the lead has: --backfill sets it. */
  backfill: InferredStep[];
  /** Rows with no stored step whose subject matches more than one step: left alone. */
  ambiguous: AuditDispatchRow[];
  /** Rows with no stored step whose inferred step another row of the lead has or infers: left alone. */
  inferredCollisions: InferredStep[];
  /** Leads with more than one Sent row for a stored step. */
  duplicates: DuplicateGroup[];
};

/**
 * Whether a dispatch subject was sent from a step subject: the matcher the
 * campaign pages used to attribute dispatches to steps before dispatches
 * recorded their stepOrder. Placeholders match anything and spintax any option.
 */
export function isDispatchForStep(dispatchSubject: string, stepSubject: string): boolean {
  if (!dispatchSubject || !stepSubject) return false;
  const cleanStep = stepSubject.trim().toLowerCase();
  const cleanDispatch = dispatchSubject.trim().toLowerCase();
  if (cleanDispatch === cleanStep) return true;
  let pattern = cleanStep.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  pattern = pattern.replace(/\s+/g, '(?:\\s+|\\b)');
  pattern = pattern.replace(/\\\{\\\{[^}]+\\\}\\\}/g, '.*');
  pattern = pattern.replace(/\\\{([^{}]+)\\\}/g, (_m, optionsEscaped: string) => {
    const options = optionsEscaped.replace(/\\\|/g, '|');
    return `(${options})`;
  });
  try {
    const regex = new RegExp(`^${pattern}\\s*\\.*\\!*\\??$`);
    return regex.test(cleanDispatch);
  } catch {
    return cleanDispatch.includes(cleanStep.replace(/\{\{[^}]+\}\}/g, '').replace(/\{[^}]+\}/g, '').trim());
  }
}

function hasDeliveryReport(row: AuditDispatchRow): boolean {
  return row.deliveredAt !== null || row.deliveryStatus !== null || row.bouncedAt !== null;
}

/**
 * Whether ACS knows the send by an id: the Operation-Id it was sent under, or
 * a messageId the provider returned. The send engine records a campaign send
 * under the stand-in messageId `${campaignId}-${leadId}-${step}-${time}` and
 * replaces it with the provider's id once the send is accepted.
 */
function hasProviderId(campaignId: string, row: AuditDispatchRow): boolean {
  return row.operationId !== null || !row.messageId.startsWith(`${campaignId}-${row.leadId}-`);
}

/** Best row to keep first. */
function compareKeep(campaignId: string, a: AuditDispatchRow, b: AuditDispatchRow): number {
  return (
    Number(b.eventCount > 0) - Number(a.eventCount > 0) ||
    Number(hasDeliveryReport(b)) - Number(hasDeliveryReport(a)) ||
    Number(hasProviderId(campaignId, b)) - Number(hasProviderId(campaignId, a)) ||
    a.sentAt.getTime() - b.sentAt.getTime() ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

function keepReason(campaignId: string, keep: AuditDispatchRow, next: AuditDispatchRow): DuplicateGroup['keepReason'] {
  if ((keep.eventCount > 0) !== (next.eventCount > 0)) return 'has events';
  if (hasDeliveryReport(keep) !== hasDeliveryReport(next)) return 'has a delivery report';
  if (hasProviderId(campaignId, keep) !== hasProviderId(campaignId, next)) return 'has a provider id';
  return 'earliest';
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** What the audit reports, backfills and deletes among one campaign's dispatches. */
export function planDispatchAudit(
  campaignId: string,
  steps: { stepOrder: number; subject: string | null }[],
  rows: AuditDispatchRow[]
): DispatchAuditPlan {
  const stepKey = (leadId: string, stepOrder: number) => `${leadId}:${stepOrder}`;
  const stored = new Map<string, AuditDispatchRow[]>();
  const inferred = new Map<string, InferredStep[]>();
  const ambiguous: AuditDispatchRow[] = [];

  for (const row of rows) {
    if (row.leadId === null) continue;
    if (row.stepOrder !== null) {
      push(stored, stepKey(row.leadId, row.stepOrder), row);
      continue;
    }
    const subject = row.subject || '';
    const matches = steps.filter((step) => isDispatchForStep(subject, step.subject || ''));
    if (matches.length > 1) ambiguous.push(row);
    else if (matches.length === 1) push(inferred, stepKey(row.leadId, matches[0].stepOrder), { row, stepOrder: matches[0].stepOrder });
  }

  const backfill: InferredStep[] = [];
  const inferredCollisions: InferredStep[] = [];
  for (const [key, list] of inferred) {
    if (list.length === 1 && !stored.has(key)) backfill.push(list[0]);
    else inferredCollisions.push(...list);
  }

  const duplicates: DuplicateGroup[] = [];
  for (const list of stored.values()) {
    const sent = list.filter((row) => row.status === 'Sent').sort((a, b) => compareKeep(campaignId, a, b));
    if (sent.length < 2) continue;
    const [keep, ...others] = sent;
    duplicates.push({
      leadId: keep.leadId as string,
      stepOrder: keep.stepOrder as number,
      keep,
      keepReason: keepReason(campaignId, keep, others[0]),
      remove: others.filter((row) => row.eventCount === 0),
      keepWithEvents: others.filter((row) => row.eventCount > 0),
    });
  }

  return { backfill, ambiguous, inferredCollisions, duplicates };
}
