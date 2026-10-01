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

/** An address as the Reply-To matching compares it. */
const sameAddressKey = (value: string | null | undefined) => value?.trim().toLowerCase() || '';

/** A mailbox's Reply-To when it is an address other than its own, so replies to its emails land there; null otherwise. */
export function otherReplyTo(mailbox: ImapSyncFields): string | null {
  const replyTo = mailbox.replyTo?.trim();
  return replyTo && sameAddressKey(replyTo) !== sameAddressKey(mailbox.emailAddress) ? replyTo : null;
}

/** Where the replies to a pool mailbox's emails land, and the reply-sync state they are read with. */
type ReplyReceiver = { sender: ImapSyncFields; replyTo: string | null; state: ImapSyncState };

/**
 * Where the replies to each of a campaign's pool mailboxes land: the mailbox itself, or
 * for one whose Reply-To is another address, that address alone, since replies go to
 * the Reply-To and the sender's own reply sync never sees them. A Reply-To is read with
 * the reply sync of the mailbox (among `mailboxes`) with that address, and is 'off' when
 * no mailbox has it.
 */
function replyReceivers(pool: ImapSyncFields[], mailboxes: ImapSyncFields[]): ReplyReceiver[] {
  return pool.map((sender) => {
    const replyTo = otherReplyTo(sender);
    if (!replyTo) return { sender, replyTo: null, state: imapSyncState(sender) };
    const target = mailboxes.find((m) => sameAddressKey(m.emailAddress) === sameAddressKey(replyTo));
    return { sender, replyTo, state: target ? imapSyncState(target) : 'off' };
  });
}

/**
 * Whether a campaign's replies are read: 'ok' when a mailbox that receives them has a
 * working reply sync, else the best of the others ('waiting', then 'failing'), or 'off'
 * when none has IMAP set up or the campaign has no sender. A Reply-To address that is
 * not a mailbox with reply sync on counts as 'off', whatever the sender's own sync.
 */
export function replySyncState(pool: ImapSyncFields[], mailboxes: ImapSyncFields[] = pool): ImapSyncState {
  const states = replyReceivers(pool, mailboxes).map((receiver) => receiver.state);
  return (['ok', 'waiting', 'failing'] as const).find((state) => states.includes(state)) ?? 'off';
}

/** A Reply-To address a campaign's replies go to that ArcReach does not read, and the pool mailboxes that set it. */
export interface UnreadReplyTo { address: string; senders: string[] }

/**
 * The Reply-To addresses of a campaign's pool mailboxes that are not a mailbox (among
 * `mailboxes`) with reply sync on, so the replies to their emails are never read.
 * Addresses compare trimmed and case-insensitively.
 */
export function unreadReplyTos(pool: ImapSyncFields[], mailboxes: ImapSyncFields[] = pool): UnreadReplyTo[] {
  const unread = new Map<string, UnreadReplyTo>();
  for (const { sender, replyTo, state } of replyReceivers(pool, mailboxes)) {
    if (!replyTo || state !== 'off') continue;
    const entry = unread.get(sameAddressKey(replyTo)) ?? { address: replyTo, senders: [] };
    const from = sender.emailAddress?.trim();
    if (from && !entry.senders.some((s) => sameAddressKey(s) === sameAddressKey(from))) entry.senders.push(from);
    unread.set(sameAddressKey(replyTo), entry);
  }
  return [...unread.values()];
}

/** The note naming the Reply-To addresses that are not read (unreadReplyTos), and whose replies go there; null when none. */
export function unreadReplyToNote(unread: UnreadReplyTo[]): string | null {
  if (unread.length === 0) return null;
  return unread
    .map(({ address, senders }) => {
      const from = senders.length > 0 ? ` from ${senders.join(', ')}` : '';
      return `Replies to emails${from} go to the Reply-To address ${address}, which is not a mailbox in ArcReach with reply sync on.`;
    })
    .join(' ');
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
 * to the sender pool's mailboxes, and for one with a Reply-To, to that address instead
 * (replyReceivers), which it names when it is not a mailbox with reply sync on. Null
 * when one of them syncs, when the campaign doesn't pause on reply, or when it has no
 * sender yet.
 */
export function stopOnReplyWarning(stopOnReply: boolean, pool: ImapSyncFields[], mailboxes: ImapSyncFields[] = pool): string | null {
  if (!stopOnReply || pool.length === 0) return null;
  const receivers = replyReceivers(pool, mailboxes);
  const states = receivers.map((receiver) => receiver.state);
  if (states.includes('ok')) return null;
  const effect = 'so replies are not read and Pause Sequence on Reply cannot pause anyone';
  const unread = unreadReplyTos(pool, mailboxes);
  const unreadNote = unreadReplyToNote(unread);
  const withUnread = (warning: string) => (unreadNote ? `${warning} ${unreadNote}` : warning);
  if (states.includes('failing')) {
    return withUnread(`Reply sync is failing on every mailbox that receives this campaign's replies and has IMAP set up, ${effect}. See the error on the Accounts page.`);
  }
  if (states.includes('waiting')) {
    return withUnread(`No mailbox that receives this campaign's replies has finished a reply sync yet, ${effect} until one does.`);
  }
  // Every receiver is off here: a Reply-To that is not read, or a sender with no other Reply-To and no IMAP,
  // which adding IMAP details to would also fix.
  const setUpReplyTo = `Set up reply sync for ${unread.length === 1 ? 'that address' : 'those addresses'}`;
  let fix = 'Add IMAP details to a sender mailbox on the Accounts page.';
  if (unread.length > 0) {
    fix = receivers.some((receiver) => !receiver.replyTo)
      ? `${setUpReplyTo}, change the Reply-To, or add IMAP details to a sender mailbox that has no other Reply-To, on the Accounts page.`
      : `${setUpReplyTo}, or change the Reply-To, on the Accounts page.`;
  }
  return `${withUnread(`No mailbox that receives this campaign's replies has reply sync on, ${effect}.`)} ${fix}`;
}
