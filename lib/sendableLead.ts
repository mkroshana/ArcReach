import type { Prisma } from '@prisma/client';

/**
 * Lead filter for leads that may be emailed: not archived, unsubscribed, bounced or invalid.
 * In a module of its own, with no database client, so lib/db can count with it.
 */
export function sendableLeadWhere(): Prisma.LeadWhereInput {
  return {
    isArchived: false,
    status: { notIn: ['Bounced', 'Unsubscribed'] },
    validationStatus: { notIn: ['Invalid'] },
  };
}
