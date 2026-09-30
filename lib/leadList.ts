import { Prisma, type PrismaClient, type SuppressionReason } from '@prisma/client';
import { SUPPRESSION_LABELS, withSuppression } from './suppression';
import { clampPage, type LeadListQuery } from './leadView';

/**
 * The leads page's tables, a page at a time (GET /api/leads). The list is
 * filtered, searched, counted and paged in the database, and a page carries
 * only what the tables and the CSV export show. The Suppressed tab and the
 * Bounced and Unsubscribed filters read the suppression list, which has no
 * relation to Lead that a Prisma filter could follow, so the filter is SQL
 * over the leads joined to their suppression-list entries.
 */

type LeadListClient = Pick<PrismaClient, 'lead' | 'suppressedEmail' | '$queryRaw'>;

/** The lead columns the tables and the CSV export show, and each group's id and name for its chips. */
export const LEAD_ROW_SELECT = {
  id: true,
  email: true,
  name: true,
  company: true,
  jobTitle: true,
  status: true,
  validationStatus: true,
  isArchived: true,
  createdAt: true,
  groups: { select: { groupId: true, group: { select: { id: true, name: true } } } },
} as const satisfies Prisma.LeadSelect;

/** Each lead `l` with its suppression-list entry `s`, or nulls. Addresses are stored lowercased (lib/leadEmail). */
const LEAD_LIST_FROM = Prisma.sql`"Lead" l LEFT JOIN "SuppressedEmail" s ON s."email" = lower(l."email")`;

/** An ILIKE pattern matching `text` anywhere, its %, _ and \ standing for themselves. */
function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, '\\$&')}%`;
}

/** The suppression reasons the leads page shows with `chip` (SUPPRESSION_LABELS). */
function reasonsWithChip(chip: string): SuppressionReason[] {
  return (Object.keys(SUPPRESSION_LABELS) as SuppressionReason[]).filter((reason) => SUPPRESSION_LABELS[reason].chip === chip);
}

/**
 * The SQL condition on `l` and `s` (LEAD_LIST_FROM) for the leads `query`'s
 * view shows, on any of its pages:
 * - leads, archived: unarchived or archived leads;
 * - suppressed: unarchived leads on the suppression list, Bounced or
 *   Unsubscribed, or Invalid;
 * - group: a group's unarchived members, by membership alone (L36);
 * - overlaps: unarchived leads in more than one of `groupIds`, or of every
 *   group when none is named.
 * On the first three the name, email or company must contain the search,
 * ignoring case, and the status filter keeps one validation status, or the
 * leads whose chip reads Bounced or Unsubscribed: from their suppression-list
 * entry when they have one, else from their status.
 */
export function leadListWhere(query: LeadListQuery): Prisma.Sql {
  const conditions = [Prisma.sql`l."isArchived" = ${query.view === 'archived'}`];

  if (query.view === 'group') {
    conditions.push(Prisma.sql`EXISTS (SELECT 1 FROM "LeadGroupMembership" m WHERE m."leadId" = l."id" AND m."groupId" = ${query.groupIds[0]})`);
    return Prisma.join(conditions, ' AND ');
  }
  if (query.view === 'overlaps') {
    const inGroups = query.groupIds.length > 0 ? Prisma.sql` AND m."groupId" IN (${Prisma.join(query.groupIds)})` : Prisma.empty;
    conditions.push(Prisma.sql`(SELECT COUNT(*) FROM "LeadGroupMembership" m WHERE m."leadId" = l."id"${inGroups}) > 1`);
    return Prisma.join(conditions, ' AND ');
  }

  if (query.view === 'suppressed') {
    conditions.push(Prisma.sql`(s."email" IS NOT NULL OR l."status" IN ('Bounced', 'Unsubscribed') OR l."validationStatus" = 'Invalid')`);
  }
  if (query.search) {
    const pattern = containsPattern(query.search);
    conditions.push(Prisma.sql`(l."name" ILIKE ${pattern} OR l."email" ILIKE ${pattern} OR l."company" ILIKE ${pattern})`);
  }
  if (query.status === 'Bounced' || query.status === 'Unsubscribed') {
    conditions.push(Prisma.sql`(s."reason"::text IN (${Prisma.join(reasonsWithChip(query.status))}) OR (s."email" IS NULL AND l."status"::text = ${query.status}))`);
  } else if (query.status !== 'All') {
    conditions.push(Prisma.sql`l."validationStatus"::text = ${query.status}`);
  }
  return Prisma.join(conditions, ' AND ');
}

/**
 * One page of `query`'s list in address order, each lead with its
 * suppression-list entry (`suppression`), with how many leads the list holds
 * (`total`) and the CRM holds (`leadCount`). A page past the end answers the
 * list's last page, and `page` says which page was served.
 */
export async function loadLeadPage(client: LeadListClient, query: LeadListQuery) {
  const where = leadListWhere(query);
  const [counts] = await client.$queryRaw<{ total: number; leadCount: number }[]>(Prisma.sql`
    SELECT (SELECT COUNT(*)::int FROM ${LEAD_LIST_FROM} WHERE ${where}) AS "total",
           (SELECT COUNT(*)::int FROM "Lead") AS "leadCount"
  `);
  const total = Number(counts?.total ?? 0);
  const page = clampPage(query.page, Math.ceil(total / query.pageSize));

  const pageIds = total === 0 ? [] : (await client.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT l."id" FROM ${LEAD_LIST_FROM}
    WHERE ${where}
    ORDER BY l."email" ASC
    LIMIT ${query.pageSize} OFFSET ${(page - 1) * query.pageSize}
  `)).map((row) => row.id);

  const rows = pageIds.length === 0 ? [] : await client.lead.findMany({
    where: { id: { in: pageIds } },
    select: LEAD_ROW_SELECT,
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const leads = await withSuppression(client, pageIds.flatMap((id) => byId.get(id) ?? []));

  return { leads, total, page, pageSize: query.pageSize, leadCount: Number(counts?.leadCount ?? 0) };
}
