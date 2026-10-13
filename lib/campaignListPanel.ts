/**
 * What the campaigns list's expanded panel says about a campaign's sequence:
 * the state each step's row shows, which step goes out next, the headline and
 * the lead counts under it. Pure so the page can use it.
 */
import type { NextSend } from './campaignTiming';

export type PanelStep = { stepOrder: number; waitDays: number };
export type PanelStepStats = { stepOrder: number; active: number; sent: number; nextSend?: NextSend | null };

/** A step's row: leads are waiting for it, it has gone out and none are, or the sequence has not reached it. */
export type StepRowState = 'waiting' | 'sent' | 'upcoming';

export function stepRowState(stats: { active?: number; sent?: number } | undefined): StepRowState {
  if ((stats?.active ?? 0) > 0) return 'waiting';
  return (stats?.sent ?? 0) > 0 ? 'sent' : 'upcoming';
}

/** When a step is sent, as its wait days say: "On enrollment", "3 days after step 2". */
export function stepWaitText(steps: PanelStep[], stepOrder: number): string {
  const index = steps.findIndex((step) => step.stepOrder === stepOrder);
  if (index <= 0) return 'On enrollment';
  const days = Number(steps[index].waitDays) || 0;
  const previous = steps[index - 1].stepOrder;
  if (days === 0) return `Same day as step ${previous}`;
  return `${days} ${days === 1 ? 'day' : 'days'} after step ${previous}`;
}

/**
 * The step whose waiting leads go out first: the one with the earliest
 * nextSend, or the first waiting step when none has one. Null when no lead is
 * waiting.
 */
export function nextStepToSend<T extends PanelStepStats>(stepStats: T[]): T | null {
  const waiting = stepStats.filter((stats) => stats.active > 0).sort((a, b) => a.stepOrder - b.stepOrder);
  if (waiting.length === 0) return null;
  return waiting.reduce((first, stats) => {
    if (!stats.nextSend) return first;
    return !first.nextSend || stats.nextSend.at < first.nextSend.at ? stats : first;
  });
}

/**
 * The panel's headline: which step goes out next and when, or why nothing
 * does. `format` writes a send time still to come.
 */
export function sequenceHeadline(
  campaign: {
    status: string;
    hasSendingSchedule?: boolean;
    steps?: PanelStep[];
    stepStats?: PanelStepStats[];
    enrollmentSummary?: { total: number };
  },
  now: Date,
  format: (send: NextSend) => string,
): string {
  if (campaign.status === 'Stopped') return 'Nothing goes out while stopped';
  if (campaign.status === 'Paused') return 'Nothing goes out while paused';
  if (campaign.status !== 'Active') return 'Not published, so nothing goes out';
  const steps = campaign.steps ?? [];
  const next = nextStepToSend(campaign.stepStats ?? []);
  if (!next) return (campaign.enrollmentSummary?.total ?? 0) === 0 ? 'No leads enrolled' : 'No lead is waiting for a step';
  const step = `Step ${steps.findIndex((s) => s.stepOrder === next.stepOrder) + 1} of ${steps.length}`;
  if (!next.nextSend) return campaign.hasSendingSchedule === false ? `${step} is held until a sending schedule is saved` : `${step} is next`;
  return new Date(next.nextSend.at).getTime() <= now.getTime() ? `${step} is due now` : `${step} goes out ${format(next.nextSend)}`;
}

/**
 * What Send Step asks before it queues a step's waiting leads, since it sends
 * to all of them now whatever is left of their wait. `when` is the time the
 * step would otherwise go out, when that is still to come.
 */
export function sendStepConfirmMessage(name: string, stepOrder: number, waiting: number, when: string | null): string {
  const leads = `${waiting.toLocaleString()} waiting ${waiting === 1 ? 'lead gets' : 'leads get'}`;
  const effect = when
    ? `Its ${leads} it now instead of ${when}.`
    : `Its ${leads} it now, including any still waiting out the step's wait days.`;
  return `Send step ${stepOrder} of "${name}" now? ${effect} ` +
    "Sending starts within 30 seconds, inside the campaign's sending window. Emails that have gone out can't be recalled.";
}

/** The line under the headline: "1,104 leads in sequence · 0 completed · 81 no longer mailable". */
export function sequenceCounts(
  stepStats: PanelStepStats[],
  summary: { completed?: number; notMailable?: number } | undefined,
): string {
  const inSequence = stepStats.reduce((total, stats) => total + stats.active, 0);
  const notMailable = summary?.notMailable ?? 0;
  return [
    `${inSequence.toLocaleString()} ${inSequence === 1 ? 'lead' : 'leads'} in sequence`,
    `${(summary?.completed ?? 0).toLocaleString()} completed`,
    ...(notMailable > 0 ? [`${notMailable.toLocaleString()} no longer mailable`] : []),
  ].join(' · ');
}
