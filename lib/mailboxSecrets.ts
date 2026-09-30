import type { Prisma } from '@prisma/client';

/**
 * Prisma `omit` for the SenderAccount credential column. Every API response
 * that embeds sender mailboxes (campaigns, Unibox) loads them with this so the
 * IMAP password never reaches the browser; /api/accounts shows a mask instead.
 * IMAP sync reads full rows and needs this column.
 */
export const MAILBOX_SECRET_OMIT = {
  imapPass: true,
} as const satisfies Prisma.SenderAccountOmit;
