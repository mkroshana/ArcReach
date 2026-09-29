import type { Prisma } from '@prisma/client';

/**
 * Prisma `omit` for the SenderAccount credential columns. Every API response
 * that embeds sender mailboxes (campaigns, Unibox) loads them with this so the
 * passwords never reach the browser; /api/accounts shows a mask instead. The
 * send engine and IMAP sync read full rows and need these columns.
 */
export const MAILBOX_SECRET_OMIT = {
  smtpPass: true,
  imapPass: true,
} as const satisfies Prisma.SenderAccountOmit;
