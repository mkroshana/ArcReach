/**
 * Why a campaign is Paused. The send engine pauses an Active campaign for an
 * hour when ACS refuses a send for a quota or rate limit ('quota'), refuses
 * every send until the host clock is fixed, like the clock-skew check
 * ('systemic'), or no send can go out until the Azure settings or the sender's
 * domain are fixed ('config': missing settings, a connection string that
 * cannot be decrypted, a refused access key or an unverified domain). It sets
 * pausedUntil and resumes the campaign then. A user pause ('user') never
 * resumes on its own. Pure so the campaign pages can use it.
 */
export type PauseReason = 'quota' | 'systemic' | 'config' | 'user';

/**
 * The pause columns written with a status a user sets: the user's choice
 * cancels any auto-resume the send engine scheduled, and a user pause is
 * recorded as one.
 */
export function userStatusPause(status: unknown): { pausedUntil: null; pauseReason: PauseReason | null } {
  return { pausedUntil: null, pauseReason: status === 'Paused' ? 'user' : null };
}

const AUTO_PAUSE_REASONS: Record<string, string> = {
  quota: 'sending quota or rate limit reached',
  systemic: 'server clock out of sync with Azure',
  config: 'Azure settings or sender domain not accepted',
};

/**
 * "Auto-resumes at HH:MM (reason)", in local 24-hour time, for a campaign the
 * send engine paused, or null when the campaign will not resume on its own.
 */
export function autoResumeNote(campaign: {
  status?: string;
  pausedUntil?: string | Date | null;
  pauseReason?: string | null;
}): string | null {
  if (campaign.status !== 'Paused' || !campaign.pausedUntil) return null;
  const resumesAt = new Date(campaign.pausedUntil);
  if (Number.isNaN(resumesAt.getTime())) return null;
  const time = resumesAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const reason = campaign.pauseReason ? AUTO_PAUSE_REASONS[campaign.pauseReason] : undefined;
  return reason ? `Auto-resumes at ${time} (${reason})` : `Auto-resumes at ${time}`;
}
