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
