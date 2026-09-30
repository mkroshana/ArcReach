/**
 * Saving the per-mailbox limit and warmup settings on the Accounts page.
 *
 * Each setting is saved with its own PUT /api/accounts. The number inputs save when they lose
 * focus, never per keystroke, and only a whole number the field allows. Saves run one at a time
 * in the order they were made, so the server always ends on the value made last, and an answer
 * never puts back a value that a save still queued is about to change. PUT answers with the
 * stored columns and effectiveDailyCap, not the mailbox's stats, so the page merges each answer
 * into the mailbox it shows.
 *
 * Has no Node-only imports so the client page can use it.
 */

/** The mailbox number inputs, each a whole number of at least `min`. */
export const MAILBOX_LIMIT_FIELDS = {
  dailyLimit: { label: 'Per Day', min: 10 },
  warmupLimit: { label: 'Starting Volume (Day 1)', min: 1 },
  warmupRamp: { label: 'Daily Ramp Increment', min: 0 },
} as const;

export type MailboxLimitField = keyof typeof MAILBOX_LIMIT_FIELDS;

/** The largest value the SenderAccount limit columns (Postgres integer) hold. */
export const MAX_MAILBOX_LIMIT = 2_147_483_647;

/** Reads a typed limit into the value to save, or why it can not be saved. */
export function mailboxLimitInputValue(field: MailboxLimitField, text: string): { value: number | null; error: string | null } {
  const { label, min } = MAILBOX_LIMIT_FIELDS[field];
  const trimmed = text.trim();
  const value = Number(trimmed);
  if (!trimmed || !Number.isInteger(value) || value < min || value > MAX_MAILBOX_LIMIT) {
    return { value: null, error: `${label} must be a whole number from ${min} to ${MAX_MAILBOX_LIMIT.toLocaleString('en-US')}.` };
  }
  return { value, error: null };
}

type Fields = Record<string, unknown>;

/** Columns PUT /api/accounts may change along with a setting: turning warmup on restarts the ramp. */
const CHANGED_WITH: Record<string, string[]> = { warmupEnabled: ['warmupStartedAt', 'warmupSent'] };

function pick(from: Fields, columns: string[]): Fields {
  return Object.fromEntries(columns.map((c) => [c, from[c]]));
}

/** The newest save of one mailbox setting not yet answered, and the stored values to show again if it fails. */
type QueuedSave = { accountId: string; seq: number; stored: Fields };

export class MailboxSettingsSaves {
  private tail: Promise<void> = Promise.resolve();
  private count = 0;
  private queued = new Map<string, QueuedSave>();

  /**
   * Queues a save of `field` behind every save already queued. `shown` is the mailbox as displayed
   * before this change, and `send` makes the PUT, resolving with its answer or rejecting. When the
   * save is answered, `onSaved` gets the answer's fields that no save still queued will change.
   * When it fails, `onFailed` gets the stored values to show again, unless a later save of the
   * same setting is queued, which then decides what the setting shows.
   */
  enqueue(save: {
    accountId: string;
    field: string;
    shown: Fields;
    send: () => Promise<Fields>;
    onSaved: (fields: Fields) => void;
    onFailed: (restore: Fields, error: unknown) => void;
  }): Promise<void> {
    const key = JSON.stringify([save.accountId, save.field]);
    const columns = [save.field, ...(CHANGED_WITH[save.field] ?? [])];
    const seq = ++this.count;
    // The server holds the values from before the first of this setting's saves still queued.
    const stored = this.queued.get(key)?.stored ?? pick(save.shown, columns);
    this.queued.set(key, { accountId: save.accountId, seq, stored });

    const run = async () => {
      let answer: Fields;
      try {
        answer = await save.send();
      } catch (error) {
        const latest = this.queued.get(key)!;
        if (latest.seq !== seq) return;
        this.queued.delete(key);
        save.onFailed(latest.stored, error);
        return;
      }
      const latest = this.queued.get(key)!;
      if (latest.seq === seq) this.queued.delete(key);
      // Stored now, so it is what the later save of this setting restores if that one fails.
      else latest.stored = pick(answer, columns);
      save.onSaved(this.withoutQueuedFields(save.accountId, answer));
    };
    const done = this.tail.then(run);
    this.tail = done.catch(() => undefined);
    return done;
  }

  /** `answer` without the columns that a save still queued for the same mailbox will change. */
  withoutQueuedFields(accountId: string, answer: Fields): Fields {
    const fresh = { ...answer };
    for (const queued of this.queued.values()) {
      if (queued.accountId !== accountId) continue;
      for (const column of Object.keys(queued.stored)) delete fresh[column];
    }
    return fresh;
  }
}
