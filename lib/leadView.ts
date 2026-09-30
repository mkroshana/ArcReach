/**
 * What the leads page's tables show and act on: the selected leads a bulk
 * action reaches, the page a shortened list lands on, and a group's member
 * list. Kept apart from the page so they can be tested.
 */

/**
 * The selected leads a bulk action acts on: those `view` holds (the rows the
 * current tab, search and status filter show, on any of its pages), in its
 * order. A selected lead the view hides, by a search or filter or because it
 * moved to another tab since, is left out, so an action never reaches a lead
 * the user cannot see is selected.
 */
export function selectedInView<T extends { id: string }>(view: readonly T[], selectedIds: readonly string[]): T[] {
  if (selectedIds.length === 0) return [];
  const selected = new Set(selectedIds);
  return view.filter((lead) => selected.has(lead.id));
}

/** `page` kept between 1 and `pageCount`, so a list that got shorter shows its new last page instead of an empty one. */
export function clampPage(page: number, pageCount: number): number {
  return Math.min(Math.max(page, 1), Math.max(pageCount, 1));
}

/** A group's unarchived members, by membership alone: the Leads tab's search and status filter do not apply. */
export function groupMembers<T extends { isArchived?: boolean | null; groups?: readonly { groupId: string }[] | null }>(
  leads: readonly T[],
  groupId: string,
): T[] {
  return leads.filter((lead) => !lead.isArchived && (lead.groups || []).some((g) => g.groupId === groupId));
}
