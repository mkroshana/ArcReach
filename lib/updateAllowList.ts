/**
 * Allow-list validation for PUT bodies that feed a Prisma update.
 *
 * Prisma reads object values as nested writes, so a body passed straight
 * through lets a caller send `user: { update: { role: 'ADMIN' } }` or
 * `senderAccount: { connect: { id } }`. Routes list the scalar columns they
 * accept; unknown keys, object/array values and wrong types are rejected.
 */

/** Largest value a Postgres `integer` column holds. */
const MAX_INT4 = 2_147_483_647;

export interface FieldRule {
  /** Phrase used in the 400 message, e.g. "a boolean". */
  expected: string;
  valid: (value: unknown) => boolean;
}

function rule(expected: string, valid: (value: unknown) => boolean): FieldRule {
  return { expected, valid };
}

function isIntInRange(v: unknown, min: number, max: number): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

export const fieldRules = {
  boolean: rule('a boolean', (v) => typeof v === 'boolean'),
  nonEmptyString: rule('a non-empty string', (v) => typeof v === 'string' && v.trim() !== ''),
  nullableString: rule('a string or null', (v) => v === null || typeof v === 'string'),
  nonNegativeInt: rule('a non-negative integer', (v) => isIntInRange(v, 0, MAX_INT4)),
  port: rule('null or a port number (1-65535)', (v) => v === null || isIntInRange(v, 1, 65535)),
  oneOf: (values: readonly string[]) =>
    rule(`one of ${values.join(', ')}`, (v) => typeof v === 'string' && values.includes(v)),
};

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type PickResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string };

/** Build Prisma `data` from `fields`, accepting only keys in `allowed` whose values pass their rule. */
export function pickUpdateFields(fields: Record<string, unknown>, allowed: Record<string, FieldRule>): PickResult {
  const unknownKeys = Object.keys(fields).filter((k) => !Object.prototype.hasOwnProperty.call(allowed, k));
  if (unknownKeys.length > 0) {
    return { ok: false, error: `Unknown field(s): ${unknownKeys.join(', ')}.` };
  }

  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'object' && value !== null) {
      return { ok: false, error: `Field "${key}" must be a plain value, not an object or array.` };
    }
    if (!allowed[key].valid(value)) {
      return { ok: false, error: `Field "${key}" must be ${allowed[key].expected}.` };
    }
    data[key] = value;
  }
  return { ok: true, data };
}
