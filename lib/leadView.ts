/**
 * What the leads page's tables show: the lists GET /api/leads pages through,
 * the query that names one page of them, and the page a shortened list lands
 * on. Kept apart from the page and the route so both read one definition and
 * it can be tested; the route filters in the database (lib/leadList.ts).
 */

/** Rows in one page of a leads table. */
export const LEAD_PAGE_SIZE = 10;
/** Most rows one GET /api/leads page carries: the page size of the CSV export. */
export const LEAD_PAGE_MAX = 500;

/**
 * The lists GET /api/leads pages through: the Leads Directory (unarchived),
 * Archived Leads and Suppressed Leads tabs, a group's members, and the
 * Cross-Check tab's leads in more than one group.
 */
export const LEAD_LIST_VIEWS = ['leads', 'archived', 'suppressed', 'group', 'overlaps'] as const;
export type LeadListView = (typeof LEAD_LIST_VIEWS)[number];

/** The status filter of the Leads, Archived and Suppressed tabs: a validation status, or the Bounced or Unsubscribed chip. */
export const LEAD_STATUS_FILTERS = ['All', 'Valid', 'Risky', 'Invalid', 'Unverified', 'Bounced', 'Unsubscribed'] as const;
export type LeadStatusFilter = (typeof LEAD_STATUS_FILTERS)[number];

/** One page of one list, as the leads page asks for it and the route reads it. */
export type LeadListQuery = {
  view: LeadListView;
  /** Kept when the name, email or company contains it, ignoring case. Leads, Archived and Suppressed only. */
  search: string;
  /** Leads, Archived and Suppressed only. */
  status: LeadStatusFilter;
  /** group: the one group whose members are listed; overlaps: the groups to cross-check, none for every group. */
  groupIds: string[];
  /** From 1. */
  page: number;
  pageSize: number;
};

/** `page` kept between 1 and `pageCount`, so a list that got shorter shows its new last page instead of an empty one. */
export function clampPage(page: number, pageCount: number): number {
  return Math.min(Math.max(page, 1), Math.max(pageCount, 1));
}

/** The GET /api/leads query string of `query`, which parseLeadListQuery reads back. */
export function leadListParams(query: LeadListQuery): URLSearchParams {
  const params = new URLSearchParams({ view: query.view, page: String(query.page) });
  if (query.pageSize !== LEAD_PAGE_SIZE) params.set('pageSize', String(query.pageSize));
  if (query.search) params.set('q', query.search);
  if (query.status !== 'All') params.set('status', query.status);
  for (const groupId of query.groupIds) params.append('groupId', groupId);
  return params;
}

/** A positive integer query parameter, or `fallback` when missing or malformed. */
function positiveInt(params: URLSearchParams, name: string, fallback: number): number {
  const value = Number.parseInt(params.get(name) ?? '', 10);
  return Number.isFinite(value) && value >= 1 ? value : fallback;
}

/**
 * The page of a list GET /api/leads names: `view` (default leads), `q`,
 * `status` (default All), `groupId` (once for a group, any number of times for
 * overlaps), `page` (from 1) and `pageSize` (at most LEAD_PAGE_MAX). An
 * unknown view or status, or a group view without exactly one group, is an
 * error; a malformed page or page size falls back to the first page of
 * LEAD_PAGE_SIZE rows.
 */
export function parseLeadListQuery(params: URLSearchParams): { ok: true; query: LeadListQuery } | { ok: false; error: string } {
  const view = params.get('view') ?? 'leads';
  if (!(LEAD_LIST_VIEWS as readonly string[]).includes(view)) {
    return { ok: false, error: `view must be one of ${LEAD_LIST_VIEWS.join(', ')}.` };
  }
  const status = params.get('status') ?? 'All';
  if (!(LEAD_STATUS_FILTERS as readonly string[]).includes(status)) {
    return { ok: false, error: `status must be one of ${LEAD_STATUS_FILTERS.join(', ')}.` };
  }
  const groupIds = Array.from(new Set(params.getAll('groupId').filter((id) => id !== '')));
  if (view === 'group' && groupIds.length !== 1) {
    return { ok: false, error: 'The group view needs one groupId.' };
  }
  return {
    ok: true,
    query: {
      view: view as LeadListView,
      search: (params.get('q') ?? '').trim(),
      status: status as LeadStatusFilter,
      groupIds,
      page: positiveInt(params, 'page', 1),
      pageSize: Math.min(positiveInt(params, 'pageSize', LEAD_PAGE_SIZE), LEAD_PAGE_MAX),
    },
  };
}
