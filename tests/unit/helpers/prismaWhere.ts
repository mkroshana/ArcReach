/**
 * Evaluates the Prisma filters the metrics queries build against in-memory
 * rows, as Postgres would (a comparison with NULL never matches), so route
 * tests count real rows with the routes' real where clauses. Relation filters
 * resolve through `relations`: a to-many relation returns an array and takes
 * `some` or `none`, a to-one returns the row or null. Throws on a filter shape
 * it does not model, so a changed query cannot silently match.
 */
export type Relations = Record<string, (row: any) => any>;

function compare(value: any, op: string, operand: any): boolean {
  if (value === null || value === undefined) return false;
  switch (op) {
    case 'equals': return value === operand;
    case 'in': return operand.includes(value);
    case 'notIn': return !operand.includes(value);
    case 'gt': return value > operand;
    case 'gte': return value >= operand;
    case 'lt': return value < operand;
    case 'lte': return value <= operand;
    default: throw new Error(`Unmodelled operator: ${op}`);
  }
}

function matchesValue(value: any, cond: any): boolean {
  if (cond === null || typeof cond !== 'object' || cond instanceof Date) {
    if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
    return (value ?? null) === cond;
  }
  // mode: 'insensitive' compares strings lower-cased on both sides, as Postgres does
  const fold = (v: any): any =>
    cond.mode !== 'insensitive' ? v : typeof v === 'string' ? v.toLowerCase() : Array.isArray(v) ? v.map(fold) : v;
  return Object.entries(cond).every(([op, operand]) => {
    if (op === 'mode') return true;
    if (op === 'not') return operand === null ? value != null : value != null && fold(value) !== fold(operand);
    return compare(fold(value), op, fold(operand));
  });
}

export function matchesWhere(row: any, where: any, relations: Relations = {}): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]: [string, any]) => {
    if (cond === undefined) return true;
    if (key === 'AND') return ([] as any[]).concat(cond).every((w) => matchesWhere(row, w, relations));
    if (key === 'OR') return cond.some((w: any) => matchesWhere(row, w, relations));
    if (key === 'NOT') return !([] as any[]).concat(cond).every((w) => matchesWhere(row, w, relations));
    if (key in relations) {
      const related = relations[key](row);
      if (Array.isArray(related)) {
        if ('some' in cond) return related.some((r) => matchesWhere(r, cond.some, relations));
        if ('none' in cond) return !related.some((r) => matchesWhere(r, cond.none, relations));
        throw new Error(`Unmodelled to-many filter: ${key} ${JSON.stringify(cond)}`);
      }
      return related != null && matchesWhere(related, cond, relations);
    }
    return matchesValue(row[key], cond);
  });
}

/** Counts the rows matching `where`. */
export function countRows(rows: any[], where: any, relations: Relations = {}): number {
  return rows.filter((row) => matchesWhere(row, where, relations)).length;
}

/** A groupBy with `_count: { id: true }` over the rows matching `where`. */
export function groupRows(rows: any[], args: { by: string[]; where?: any }, relations: Relations = {}) {
  const groups = new Map<string, any>();
  for (const row of rows.filter((r) => matchesWhere(r, args.where, relations))) {
    const keys = Object.fromEntries(args.by.map((field) => [field, row[field] ?? null]));
    const id = JSON.stringify(keys);
    const group = groups.get(id) ?? { ...keys, _count: { id: 0 } };
    group._count.id++;
    groups.set(id, group);
  }
  return [...groups.values()];
}
