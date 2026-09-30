/**
 * Optimistic concurrency for campaign saves. The campaign page sends the
 * updatedAt of the campaign it loaded, and PUT /api/campaigns/[id] refuses the
 * save with a 409 once the campaign has changed since (another save, a status
 * change, or a send engine pause or resume), so a save never overwrites a
 * change its editor has not seen. Pure so the campaign page can use it.
 */

export const CAMPAIGN_CHANGED_ERROR =
  'This campaign changed after you opened it: it was saved elsewhere or its status changed. Reload it to see the latest version, then make your changes again.';

/** The version (updatedAt) a save names, or null when it is not a timestamp. */
export function parseCampaignVersion(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const version = new Date(value);
  return Number.isNaN(version.getTime()) ? null : version;
}

/** Whether two versions, as Dates or the ISO strings the API sends, are the same. */
export function sameCampaignVersion(a: string | Date | null | undefined, b: string | Date | null | undefined): boolean {
  if (a == null || b == null) return false;
  const time = new Date(a).getTime();
  return !Number.isNaN(time) && time === new Date(b).getTime();
}

/**
 * The updatedAt a save writes: now, but always later than the version it
 * replaces, so every save changes the version, even within the same
 * millisecond or on a server whose clock runs behind.
 */
export function nextCampaignVersion(loaded: Date, now: Date = new Date()): Date {
  return new Date(Math.max(now.getTime(), loaded.getTime() + 1));
}
