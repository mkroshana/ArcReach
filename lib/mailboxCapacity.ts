/**
 * The combined sending capacity of the mailboxes GET /api/accounts returns, as the send engine
 * enforces it. Kept free of server imports so the Accounts page can use it.
 */

/** The mailbox fields capacity is read from: effectiveDailyCap is getEffectiveDailyCap's cap. */
export interface MailboxCapacityFields {
  dailyLimit?: number | null;
  effectiveDailyCap?: number | null;
  sentLast24Hours?: number | null;
}

/**
 * Each mailbox may send up to its effective cap (the warmup ramp while it is below the daily
 * limit) in any rolling 24 hours, and its sends in the last 24 hours count toward it. `remaining`
 * adds up what each mailbox has left, so one over its cap (after a lowered limit or a restarted
 * ramp) takes nothing from the others.
 */
export function combinedDailyCapacity(mailboxes: MailboxCapacityFields[]): { sent: number; cap: number; remaining: number } {
  let sent = 0;
  let cap = 0;
  let remaining = 0;
  for (const mailbox of mailboxes) {
    const mailboxCap = mailbox.effectiveDailyCap ?? mailbox.dailyLimit ?? 0;
    const mailboxSent = mailbox.sentLast24Hours ?? 0;
    sent += mailboxSent;
    cap += mailboxCap;
    remaining += Math.max(0, mailboxCap - mailboxSent);
  }
  return { sent, cap, remaining };
}
