/**
 * A mailbox's reply sync (IMAP) as the Accounts and campaign pages show it. Kept free
 * of server imports so client pages can use it with the mailboxes GET /api/accounts returns.
 */

/**
 * 'off': no complete IMAP details, or the mailbox is not Active, so it is never synced.
 * 'failing': the latest sync failed, or skipped a message it could not record (until
 * the next sync). 'ok': a sync succeeded since the details were saved. 'waiting': the
 * details are saved but no sync has finished yet.
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
 * The reply-sync states of the mailboxes that receive a campaign's replies: the sender
 * pool's mailboxes, and for one with a Reply-To, the mailbox (among `mailboxes`) with
 * that address.
 */
function replyReceiverStates(pool: ImapSyncFields[], mailboxes: ImapSyncFields[]): ImapSyncState[] {
  const receivers = pool.flatMap((mailbox) => {
    const replyTo = mailbox.replyTo?.trim().toLowerCase();
    const target = replyTo ? mailboxes.find((m) => m.emailAddress?.trim().toLowerCase() === replyTo) : undefined;
    return target ? [mailbox, target] : [mailbox];
  });
  return receivers.map(imapSyncState);
}

/**
 * Whether a campaign's replies are read: 'ok' when a mailbox that receives them has a
 * working reply sync, else the best of the others ('waiting', then 'failing'), or 'off'
 * when none has IMAP set up or the campaign has no sender.
 */
export function replySyncState(pool: ImapSyncFields[], mailboxes: ImapSyncFields[] = pool): ImapSyncState {
  const states = replyReceiverStates(pool, mailboxes);
  return (['ok', 'waiting', 'failing'] as const).find((state) => states.includes(state)) ?? 'off';
}

/**
 * Whether a reply count is unknown rather than 0, by the reply-sync state of the
 * mailboxes that receive the replies: with it off no reply is ever read, so a 0
 * says nothing. Replies recorded before reply sync was turned off are still a
 * count, as opens are once tracking is off.
 */
export function replyCountUnknown(sync: ImapSyncState | null | undefined, replies: number | null | undefined): boolean {
  return sync === 'off' && !replies;
}

/** A mailbox as GET /api/accounts lists it: its reply sync, its Reply-To and its reply figures. */
export interface MailboxReplyFields extends ImapSyncFields {
  /** The human replies that arrived in this mailbox, whichever mailbox's email they answer. */
  replies?: number | null;
  /** The campaign emails it sent that ACS accepted. */
  sentTotal?: number | null;
  /** `replies` per 100 of those emails; null when it sent none. */
  repliesPer100Sent?: number | null;
}

/** The Accounts page's Replies figure for a mailbox: the count (null where it is unknown), the line under it and a caveat. */
export type MailboxRepliesFigure = { count: number | null; sub: string; caveat: string | null };

/** Why a mailbox's reply count may be short, by its reply-sync state, as the campaign page's Replies tile says it. */
const MAILBOX_REPLY_SYNC_NOTES: Record<Exclude<ImapSyncState, 'ok'>, { short: string; long: string }> = {
  off: { short: 'Reply sync off', long: 'Reply sync is off on this mailbox, so replies to it are not read and may be missing from this count.' },
  waiting: { short: 'Reply sync pending', long: 'This mailbox has not finished a reply sync yet, so replies to it may be missing from this count.' },
  failing: { short: 'Reply sync failing', long: 'Reply sync is failing on this mailbox, so replies to it may be missing from this count.' },
};

/** An address as the Reply-To matching compares it. */
const sameAddressKey = (value: string | null | undefined) => value?.trim().toLowerCase() || '';

/**
 * The Accounts page's Replies figure for a mailbox. Its count is of the replies that
 * arrived in it, so it is no share of the leads it contacted, as a campaign's reply
 * rate is: it is given per 100 of the emails it sent, but only where that means
 * something. Otherwise the line under it says why there is no such figure:
 * - its Reply-To is another address, so replies to its emails land there, not here;
 * - its reply sync is not working (off, pending or failing), as the campaign page says;
 * - it is the Reply-To of other mailboxes among `mailboxes`, so its replies answer their emails too;
 * - it sent no campaign email, so there is nothing to give replies per.
 * The count is unknown while its reply sync is off and no reply was recorded (replyCountUnknown).
 */
export function mailboxRepliesFigure(mailbox: MailboxReplyFields, mailboxes: MailboxReplyFields[] = []): MailboxRepliesFigure {
  const own = sameAddressKey(mailbox.emailAddress);
  const sync = imapSyncState(mailbox);
  const count = replyCountUnknown(sync, mailbox.replies) ? null : mailbox.replies ?? 0;
  const replyTo = mailbox.replyTo?.trim();
  const repliesGoElsewhere = !!replyTo && sameAddressKey(replyTo) !== own;
  const answered = own
    ? mailboxes.filter((m) => sameAddressKey(m.replyTo) === own && sameAddressKey(m.emailAddress) !== own)
    : [];

  const caveat = [
    repliesGoElsewhere ? `Replies to this mailbox's emails go to its Reply-To address, ${replyTo}, so they are not counted here.` : null,
    sync !== 'ok' && count !== null ? MAILBOX_REPLY_SYNC_NOTES[sync].long : null,
    answered.length > 0
      ? `This mailbox is the Reply-To address of ${answered.map((m) => m.emailAddress).join(', ')}, so its count includes replies to their emails.`
      : null,
  ].filter(Boolean).join(' ') || null;

  let sub: string;
  if (repliesGoElsewhere) sub = `Replies go to ${replyTo}`;
  else if (sync !== 'ok') sub = MAILBOX_REPLY_SYNC_NOTES[sync].short;
  else if (answered.length > 0) sub = `Reply-To for ${answered.length} ${answered.length === 1 ? 'mailbox' : 'mailboxes'}`;
  else if (!mailbox.sentTotal) sub = 'No campaign emails sent from this mailbox';
  else {
    const per100 = mailbox.repliesPer100Sent ?? 0;
    sub = `${per100} ${per100 === 1 ? 'reply' : 'replies'} per 100 emails sent`;
  }
  return { count, sub, caveat };
}

/**
 * Why a campaign that pauses leads on reply would never pause anyone: no mailbox that
 * receives its replies has a working reply sync, so no reply is ever read. Replies go
 * to the sender pool's mailboxes, and for one with a Reply-To, to the mailbox (among
 * `mailboxes`) with that address. Null when one of them syncs, when the campaign
 * doesn't pause on reply, or when it has no sender yet.
 */
export function stopOnReplyWarning(stopOnReply: boolean, pool: ImapSyncFields[], mailboxes: ImapSyncFields[] = pool): string | null {
  if (!stopOnReply || pool.length === 0) return null;
  const states = replyReceiverStates(pool, mailboxes);
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
