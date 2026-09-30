import { describe, it, expect } from 'vitest';
import {
  clampPage,
  leadListParams,
  parseLeadListQuery,
  LEAD_PAGE_MAX,
  LEAD_PAGE_SIZE,
  type LeadListQuery,
} from '../../lib/leadView';

describe('clampPage (L33)', () => {
  it('moves back to the new last page when the last one empties', () => {
    // 41 leads over 5 pages; deleting the one on page 5 leaves 4 pages
    expect(clampPage(5, Math.ceil(40 / 10))).toBe(4);
  });

  it('keeps a page that still exists', () => {
    expect(clampPage(3, 4)).toBe(3);
    expect(clampPage(1, 1)).toBe(1);
  });

  it('stays on page 1 when the list is empty', () => {
    expect(clampPage(3, 0)).toBe(1);
    expect(clampPage(0, 0)).toBe(1);
  });
});

/** The list page a GET /api/leads query string names, as the route reads it. */
const parse = (search: string) => parseLeadListQuery(new URLSearchParams(search));

describe('the leads list query (M42)', () => {
  const query = (fields: Partial<LeadListQuery> = {}): LeadListQuery => ({
    view: 'leads', search: '', status: 'All', groupIds: [], page: 1, pageSize: LEAD_PAGE_SIZE, ...fields,
  });

  it.each([
    ['the Leads tab', query()],
    ['a searched and filtered page of the Suppressed tab', query({ view: 'suppressed', search: 'acme & co_50%', status: 'Bounced', page: 3 })],
    ['a group', query({ view: 'group', groupIds: ['g-1'], page: 2 })],
    ['overlaps between two groups', query({ view: 'overlaps', groupIds: ['g-1', 'g-2'] })],
    ['an export page', query({ view: 'archived', status: 'Unverified', pageSize: LEAD_PAGE_MAX })],
  ])('reads back what the page asks for: %s', (_label, asked) => {
    expect(parse(leadListParams(asked).toString())).toEqual({ ok: true, query: asked });
  });

  it('asks for the first page of the Leads tab when nothing is named', () => {
    expect(parse('')).toEqual({ ok: true, query: query() });
  });

  it('never serves more than LEAD_PAGE_MAX rows a page, and falls back to page 1 for a malformed page', () => {
    expect(parse('pageSize=100000')).toMatchObject({ ok: true, query: { pageSize: LEAD_PAGE_MAX } });
    expect(parse('page=0&pageSize=-5')).toMatchObject({ ok: true, query: { page: 1, pageSize: LEAD_PAGE_SIZE } });
    expect(parse('page=two')).toMatchObject({ ok: true, query: { page: 1 } });
  });

  it('trims the search and drops repeated or blank group ids', () => {
    expect(parse('q=%20%20jane%20&view=overlaps&groupId=g-1&groupId=&groupId=g-1&groupId=g-2')).toMatchObject({
      ok: true, query: { search: 'jane', groupIds: ['g-1', 'g-2'] },
    });
  });

  it.each([
    ['an unknown view', 'view=everything', 'view must be one of leads, archived, suppressed, group, overlaps.'],
    ['an unknown status', 'status=Deleted', 'status must be one of All, Valid, Risky, Invalid, Unverified, Bounced, Unsubscribed.'],
    ['a group view without a group', 'view=group', 'The group view needs one groupId.'],
    ['a group view with two groups', 'view=group&groupId=g-1&groupId=g-2', 'The group view needs one groupId.'],
  ])('refuses %s', (_label, search, error) => {
    expect(parse(search)).toEqual({ ok: false, error });
  });
});
