import { describe, it, expect } from 'vitest';
import { selectedInView, clampPage, groupMembers } from '../../lib/leadView';

type Lead = { id: string; isArchived?: boolean; groups?: { groupId: string }[]; status?: string };

const lead = (id: string, extra: Partial<Lead> = {}): Lead => ({ id, isArchived: false, groups: [], ...extra });

describe('selectedInView (M64)', () => {
  const view = [lead('a'), lead('b'), lead('c')];

  it('acts only on the selected leads the current view shows, in view order', () => {
    // 'x' was selected on another tab, or before a search hid it
    expect(selectedInView(view, ['c', 'x', 'a']).map((l) => l.id)).toEqual(['a', 'c']);
  });

  it('acts on nothing when every selected lead is hidden', () => {
    // Twenty leads selected in Archived, then Delete on the Leads tab
    expect(selectedInView(view, ['archived-1', 'archived-2'])).toEqual([]);
    expect(selectedInView(view, [])).toEqual([]);
  });

  it('keeps a selected lead on another page of the same view', () => {
    const many = Array.from({ length: 25 }, (_, i) => lead(`l${i}`));
    expect(selectedInView(many, ['l2', 'l24']).map((l) => l.id)).toEqual(['l2', 'l24']);
  });
});

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

describe('groupMembers (L36)', () => {
  const leads = [
    lead('bounced', { groups: [{ groupId: 'g-1' }], status: 'Bounced' }),
    lead('neutral', { groups: [{ groupId: 'g-1' }, { groupId: 'g-2' }], status: 'Neutral' }),
    lead('archived', { groups: [{ groupId: 'g-1' }], isArchived: true }),
    lead('other', { groups: [{ groupId: 'g-2' }] }),
    { id: 'no-groups', isArchived: false },
  ];

  it('lists every unarchived member whatever its status', () => {
    expect(groupMembers(leads, 'g-1').map((l) => l.id)).toEqual(['bounced', 'neutral']);
    expect(groupMembers(leads, 'g-2').map((l) => l.id)).toEqual(['neutral', 'other']);
  });

  it('lists nobody for a group with no members', () => {
    expect(groupMembers(leads, 'g-3')).toEqual([]);
  });
});
