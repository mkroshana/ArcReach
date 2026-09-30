import { emailBodyToText } from '@/lib/emailText';

/**
 * A campaign may only be Active when it has at least one step and every step
 * has a subject and a body: the send engine mails each step exactly as stored.
 * Drafts may be saved incomplete. Pure string work so the campaign page runs
 * the same check before it publishes.
 */

export type StepContent = { subject?: unknown; body?: unknown };

/** A step missing its subject, body or both, numbered from 1 as the campaign page shows it. */
export type IncompleteStep = { stepNumber: number; missing: Array<'subject' | 'body'> };

/** Steps whose subject is blank, or whose body is empty once HTML tags are stripped. */
export function findIncompleteSteps(steps: StepContent[]): IncompleteStep[] {
  const incomplete: IncompleteStep[] = [];
  steps.forEach((step, index) => {
    const missing: Array<'subject' | 'body'> = [];
    if (typeof step.subject !== 'string' || step.subject.trim() === '') missing.push('subject');
    if (typeof step.body !== 'string' || emailBodyToText(step.body) === '') missing.push('body');
    if (missing.length > 0) incomplete.push({ stepNumber: index + 1, missing });
  });
  return incomplete;
}

/** Why a campaign with these steps (in send order) cannot be Active, or null when it can. */
export function activationBlocker(steps: StepContent[]): string | null {
  if (steps.length === 0) {
    return 'Add at least one step with a subject and body before activating this campaign.';
  }
  const incomplete = findIncompleteSteps(steps);
  if (incomplete.length === 0) return null;
  const details = incomplete.map((s) => `Step ${s.stepNumber} has no ${s.missing.join(' or ')}`).join('; ');
  return `${details}. Complete every step before activating this campaign.`;
}

/**
 * Days from a lead's first step to its last: the wait days of the steps after
 * the first. Step 1 is sent on enrollment, so its waitDays is never applied
 * (and PUT /api/campaigns/[id] stores it as 0).
 */
export function sequenceDurationDays(steps: Array<{ waitDays?: unknown }>): number {
  return steps.slice(1).reduce<number>((days, step) => days + (Number(step.waitDays) || 0), 0);
}

/**
 * Enrollments, dispatches and per-step stats point at a step by its stepOrder.
 * Once a campaign has started sending (a lead is past step 1 or it has any
 * dispatch), a save may only edit stored steps in place and add steps after
 * them: removing, reordering or inserting would move leads onto the wrong step.
 */
export const STEP_STRUCTURE_LOCKED_ERROR =
  "This campaign has started sending, so its steps can't be removed, reordered or inserted before existing ones. Edit steps in place or add new steps at the end.";

/**
 * The stored step each of `steps` saves over, matched by id, or null for a
 * new step. A stored id matches once, so a repeat of it is a new step.
 */
export function matchStoredSteps(storedIds: string[], steps: Array<{ id?: unknown } | null | undefined>): Array<string | null> {
  const stored = new Set(storedIds);
  const matched = new Set<string>();
  return steps.map((step) => {
    const id = step?.id;
    if (typeof id !== 'string' || !stored.has(id) || matched.has(id)) return null;
    matched.add(id);
    return id;
  });
}

/**
 * Whether saving `steps` over the stored steps (ids in stepOrder) removes,
 * reorders or inserts before a stored step, rather than keeping every stored
 * step at its position and adding any new ones after them.
 */
export function changesStepStructure(storedIds: string[], steps: Array<{ id?: unknown } | null | undefined>): boolean {
  const matched = matchStoredSteps(storedIds, steps);
  return storedIds.some((id, index) => matched[index] !== id);
}

/**
 * What Run Now (no `stepOrder`: it queues due leads) and Send Step (`stepOrder`)
 * report once the run route has queued `queued` leads for the worker to send.
 */
export function queuedLeadsMessage(queued: number, stepOrder?: number): string {
  const leads = `lead${queued === 1 ? '' : 's'}`;
  const sending = "Sending starts within 30 seconds, inside the campaign's sending window.";
  if (stepOrder !== undefined) {
    if (queued === 0) return `No leads to queue at step ${stepOrder}.`;
    return `Queued ${queued} ${leads} at step ${stepOrder}. ${sending}`;
  }
  if (queued === 0) return 'No leads are due. Follow-ups are sent once their wait days pass.';
  return `Queued ${queued} due ${leads}. ${sending}`;
}
