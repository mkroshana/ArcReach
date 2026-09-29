/**
 * A mailbox's reply sync (IMAP) as the Accounts and campaign pages show it. Kept free
 * of server imports so client pages can use it with the mailboxes GET /api/accounts returns.
 */

/**
 * 'off': no complete IMAP details, or the mailbox is not Active, so it is never synced.
 * 'failing': the latest sync failed. 'ok': a sync succeeded since the details were
 * saved. 'waiting': the details are saved but no sync has finished yet.
 */
export type ImapSyncState = 'off' | 'waiting' | 'ok' | 'failing';

/** The mailbox columns the reply-sync state is read from (dates as the API sends them). */
export interface ImapSyncFields {
  emailAddress?: string | null;
  replyTo?: string | null;
  status?: string | null;
  imapHost?: string | null;
  imapPort?: number | null;
  imapUser?: string | null;
  imapPass?: string | null;
  imapLastSyncAt?: string | Date | null;
  imapLastSyncError?: string | null;
}

export function imapSyncState(mailbox: ImapSyncFields): ImapSyncState {
  if (!mailbox.imapHost || !mailbox.imapPort || !mailbox.imapUser || !mailbox.imapPass) return 'off';
  if (mailbox.status && mailbox.status !== 'Active') return 'off';
  if (mailbox.imapLastSyncError) return 'failing';
  return mailbox.imapLastSyncAt ? 'ok' : 'waiting';
}

export const IMAP_SYNC_LABELS: Record<ImapSyncState, string> = {
  off: 'Reply Sync Off',
  waiting: 'Reply Sync Pending',
  ok: 'Reply Sync OK',
  failing: 'Reply Sync Failing',
};

/** Microsoft 365 and Outlook.com IMAP hosts, which refuse password (LOGIN) sign-in. */
export function isMicrosoftImapHost(host: string | null | undefined): boolean {
  return /(^|\.)(office365\.com|office\.com|outlook\.com)$/i.test((host ?? '').trim());
}

export const MICROSOFT_IMAP_NOTE =
  'Microsoft 365 and Outlook.com no longer accept password sign-in over IMAP, so reply sync cannot log in to them.';

/**
 * Why a campaign that pauses leads on reply would never pause anyone: no mailbox that
 * receives its replies has a working reply sync, so no reply is ever read. Replies go
 * to the sender pool's mailboxes, and for one with a Reply-To, to the mailbox (among
 * `mailboxes`) with that address. Null when one of them syncs, when the campaign
 * doesn't pause on reply, or when it has no sender yet.
 */
export function stopOnReplyWarning(stopOnReply: boolean, pool: ImapSyncFields[], mailboxes: ImapSyncFields[] = pool): string | null {
  if (!stopOnReply || pool.length === 0) return null;
  const receivers = pool.flatMap((mailbox) => {
    const replyTo = mailbox.replyTo?.trim().toLowerCase();
    const target = replyTo ? mailboxes.find((m) => m.emailAddress?.trim().toLowerCase() === replyTo) : undefined;
    return target ? [mailbox, target] : [mailbox];
  });
  const states = receivers.map(imapSyncState);
  if (states.includes('ok')) return null;
  const effect = 'so replies are not read and Pause Sequence on Reply cannot pause anyone';
  if (states.includes('failing')) {
    return `Reply sync is failing on every mailbox that receives this campaign's replies and has IMAP set up, ${effect}. See the error on the Accounts page.`;
  }
  if (states.includes('waiting')) {
    return `No mailbox that receives this campaign's replies has finished a reply sync yet, ${effect} until one does.`;
  }
  return `No mailbox that receives this campaign's replies has IMAP set up, ${effect}. Add IMAP details to a sender mailbox on the Accounts page.`;
}
