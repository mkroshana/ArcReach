import { NextRequest, NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getSession, type UserSession } from '@/lib/session';
import { UnauthorizedError, unauthorizedResponse } from '@/lib/sessionError';
import { syncMailboxReplies, getActiveImapAccounts } from '@/lib/imapService';
import { leaseHeldElsewhere } from '@/lib/workerLease';
import { MAILBOX_SECRET_OMIT } from '@/lib/mailboxSecrets';
import { CAMPAIGN_LABEL_SELECT, dispatchScope, enrollmentScope, replyScope } from '@/lib/leadHistoryScope';
import { normalizeEmail } from '@/lib/leadEmail';
import { CRM_STATUSES, suppressionEntries } from '@/lib/suppression';

/** Threads in one page of the list, unless the request asks for another number up to THREAD_PAGE_MAX. */
const THREAD_PAGE_SIZE = 50;
const THREAD_PAGE_MAX = 200;
/** Replies in one page of the CSV export. */
const EXPORT_PAGE_SIZE = 500;
/** Characters of a thread's latest reply the list sends for its preview line. */
const PREVIEW_MAX_CHARS = 2000;

/** The mailbox columns Unibox shows next to a reply. */
const MAILBOX_LABEL_SELECT = {
  id: true,
  emailAddress: true,
} as const satisfies Prisma.SenderAccountSelect;

type Caller = Pick<UserSession, 'id' | 'role'>;

function normalizeSubject(subject: string): string {
  if (!subject) return '';
  let cleaned = subject.trim().toLowerCase();

  // Strip common prefixes like Re:, Fwd:, Fw:, etc.
  const rePattern = /^(re|fwd|fw)\s*:\s*/;
  while (rePattern.test(cleaned)) {
    cleaned = cleaned.replace(rePattern, '');
  }
  return cleaned.trim();
}

/** A thread's id: the lead and the normalized subject (leadId-normalizedSubject), as PUT reads it back. */
function threadKey(leadId: string, subject: string): string {
  return `${leadId}-${normalizeSubject(subject)}`;
}

/** A non-negative integer query parameter, or `fallback` when missing or malformed. */
function intParam(searchParams: URLSearchParams, name: string, fallback: number): number {
  const value = Number.parseInt(searchParams.get(name) ?? '', 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

interface ThreadIndexEntry {
  id: string;
  leadId: string;
  /** The thread's replies, newest first. */
  replyIds: string[];
  /** When the thread's newest reply or dispatch arrived or went out, and that message's subject. */
  lastActivityAt: Date;
  subject: string;
  unread: boolean;
}

/**
 * Every thread the caller can see, newest activity first. It is built from a
 * few columns of each reply and of each dispatch to a lead that replied, never
 * a body, so the list can be paged and searched without loading messages.
 * Dispatches only date and title the threads their replies started.
 */
async function loadThreadIndex(session: Caller): Promise<ThreadIndexEntry[]> {
  const replies = await prisma.inboundResponse.findMany({
    where: replyScope(session),
    select: { id: true, leadId: true, subject: true, receivedAt: true, unread: true },
    orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }]
  });
  if (replies.length === 0) return [];

  const threads = new Map<string, ThreadIndexEntry>();
  for (const reply of replies) {
    const key = threadKey(reply.leadId, reply.subject);
    let thread = threads.get(key);
    if (!thread) {
      thread = { id: key, leadId: reply.leadId, replyIds: [], lastActivityAt: reply.receivedAt, subject: reply.subject, unread: false };
      threads.set(key, thread);
    }
    thread.replyIds.push(reply.id);
    if (reply.unread) thread.unread = true;
  }

  // The caller's dispatches to leads with a reply the caller can see
  const dispatches = await prisma.emailDispatch.findMany({
    where: {
      lead: { replies: { some: replyScope(session) ?? {} } },
      ...dispatchScope(session)
    },
    select: { leadId: true, subject: true, sentAt: true }
  });
  for (const dispatch of dispatches) {
    if (!dispatch.leadId) continue;
    const thread = threads.get(threadKey(dispatch.leadId, dispatch.subject || ''));
    if (thread && dispatch.sentAt.getTime() > thread.lastActivityAt.getTime()) {
      thread.lastActivityAt = dispatch.sentAt;
      thread.subject = dispatch.subject || 'Campaign Outreach';
    }
  }

  return Array.from(threads.values()).sort((a, b) =>
    b.lastActivityAt.getTime() - a.lastActivityAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** Ids of the threads with a reply whose subject, body, or lead name or email contains `q`, ignoring case. */
async function searchThreadIds(session: Caller, q: string): Promise<Set<string>> {
  const contains = { contains: q, mode: 'insensitive' as const };
  const matches = await prisma.inboundResponse.findMany({
    where: {
      AND: [
        replyScope(session) ?? {},
        { OR: [{ subject: contains }, { body: contains }, { lead: { name: contains } }, { lead: { email: contains } }] }
      ]
    },
    select: { leadId: true, subject: true }
  });
  return new Set(matches.map(r => threadKey(r.leadId, r.subject)));
}

/**
 * One thread's messages, oldest first: its replies and the caller's dispatches
 * to the lead under the same subject, with their bodies. Null when the caller
 * can see no reply in it.
 */
async function loadThreadMessages(session: Caller, threadId: string) {
  const parts = threadId.split('-');
  const leadId = parts.slice(0, 5).join('-');
  const normalizedSub = parts.slice(5).join('-');

  const replies = (await prisma.inboundResponse.findMany({
    where: { leadId, ...replyScope(session) },
    select: {
      id: true, subject: true, body: true, receivedAt: true, unread: true, autoReply: true, senderAccountId: true,
      senderAccount: { select: MAILBOX_LABEL_SELECT },
      campaign: { select: CAMPAIGN_LABEL_SELECT }
    },
    orderBy: { receivedAt: 'asc' }
  })).filter(r => normalizeSubject(r.subject) === normalizedSub);
  if (replies.length === 0) return null;

  const dispatches = (await prisma.emailDispatch.findMany({
    where: { leadId, ...dispatchScope(session) },
    select: { id: true, subject: true, body: true, sentAt: true },
    orderBy: { sentAt: 'asc' }
  })).filter(d => normalizeSubject(d.subject || '') === normalizedSub);

  // Map replies to standard message format
  const inboundMsgs = replies.map(r => ({
    id: r.id,
    type: 'inbound' as const,
    subject: r.subject,
    body: r.body,
    timestamp: r.receivedAt,
    senderAccountId: r.senderAccountId,
    senderAccount: r.senderAccount,
    campaign: r.campaign,
    unread: r.unread,
    // Set on a bounce, out-of-office notice or other auto-reply, which stopped no sequence
    autoReply: r.autoReply
  }));

  // Map dispatches to standard message format
  const outboundMsgs = dispatches.map(d => ({
    id: d.id,
    type: 'outbound' as const,
    subject: d.subject || 'Campaign Outreach',
    body: d.body || '',
    timestamp: d.sentAt,
    senderAccountId: null,
    senderAccount: null
  }));

  // Combine and sort messages chronologically (oldest first)
  return [...inboundMsgs, ...outboundMsgs].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
}

/**
 * GET /api/unibox lists the caller's reply threads a page at a time, newest
 * activity first: `offset` and `limit` page it, `q` keeps the threads with a
 * reply whose subject, body, or lead name or email contains it. A list entry
 * carries only what the list shows, with the start of its latest reply as the
 * preview. `?thread=<id>` returns one thread's messages with their bodies, and
 * `?export=replies` pages the list's replies for the CSV export.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    const { searchParams } = new URL(req.url);

    // An opened thread: its messages, bodies included
    const threadId = searchParams.get('thread');
    if (threadId !== null) {
      const messages = await loadThreadMessages(session, threadId);
      if (!messages) return NextResponse.json({ error: 'Conversation not found.' }, { status: 404 });
      return NextResponse.json({ id: threadId, messages });
    }

    const exporting = searchParams.get('export') === 'replies';
    const q = (searchParams.get('q') || '').trim();
    const offset = intParam(searchParams, 'offset', 0);
    const shouldSync = searchParams.get('sync') === 'true';

    // Find all active sender accounts with IMAP configured for this user/admin using shared helper.
    // Only a list load syncs: when asked (Refresh), else in the background for the list's first unsearched page.
    const syncs = !exporting && (shouldSync || (offset === 0 && !q));
    const activeImapAccounts = syncs ? await getActiveImapAccounts(session.id, session.role) : [];

    // Concurrently trigger IMAP sync for all eligible accounts. The worker holding the
    // lease syncs every mailbox every 3 minutes; while another process holds it, a
    // sync from here would read the same mail at the same time, so it is left to that worker.
    if (activeImapAccounts.length > 0 && !(await leaseHeldElsewhere())) {
      if (shouldSync) {
        await Promise.allSettled(
          activeImapAccounts.map(acc => syncMailboxReplies(acc.id))
        );
      } else {
        // Fire-and-forget background sync to keep initial page loads instant
        Promise.allSettled(
          activeImapAccounts.map(acc => syncMailboxReplies(acc.id))
        ).catch(err => {
          console.error('[IMAP Background Sync Error]', err);
        });
      }
    }

    // Non-admins see replies received on their own mailboxes, and only their own
    // enrollments and dispatches for those leads.
    let threads = await loadThreadIndex(session);
    const unreadCount = threads.filter(t => t.unread).length;
    if (q) {
      const matching = await searchThreadIds(session, q);
      threads = threads.filter(t => matching.has(t.id));
    }

    if (exporting) {
      // Each thread's replies oldest first, threads newest activity first
      const replyIds = threads.flatMap(t => [...t.replyIds].reverse());
      const pageIds = replyIds.slice(offset, offset + EXPORT_PAGE_SIZE);
      const rows = pageIds.length === 0 ? [] : await prisma.inboundResponse.findMany({
        where: { id: { in: pageIds }, ...replyScope(session) },
        select: {
          id: true, subject: true, body: true, receivedAt: true, unread: true,
          campaign: { select: CAMPAIGN_LABEL_SELECT },
          senderAccount: { select: MAILBOX_LABEL_SELECT },
          lead: {
            select: {
              email: true, name: true, company: true, status: true,
              // Names the campaign of a reply recorded without one
              enrollments: { where: enrollmentScope(session), select: { campaign: { select: CAMPAIGN_LABEL_SELECT } }, take: 1 }
            }
          }
        }
      });
      const byId = new Map(rows.map(r => [r.id, r]));
      return NextResponse.json({
        replies: pageIds.flatMap(id => byId.get(id) ?? []),
        nextOffset: offset + EXPORT_PAGE_SIZE < replyIds.length ? offset + EXPORT_PAGE_SIZE : null
      });
    }

    const limit = Math.min(Math.max(intParam(searchParams, 'limit', THREAD_PAGE_SIZE), 1), THREAD_PAGE_MAX);
    const page = threads.slice(offset, offset + limit);

    // Each listed thread's latest reply, with its lead, the caller's enrollments and the receiving mailbox
    const latestReplies = page.length === 0 ? [] : await prisma.inboundResponse.findMany({
      where: { id: { in: page.map(t => t.replyIds[0]) }, ...replyScope(session) },
      select: {
        id: true, body: true, senderAccountId: true,
        senderAccount: { select: MAILBOX_LABEL_SELECT },
        lead: {
          select: {
            id: true, email: true, name: true, status: true,
            enrollments: { where: enrollmentScope(session), select: { id: true, status: true } }
          }
        }
      }
    });
    const latestById = new Map(latestReplies.map(r => [r.id, r]));

    // Each lead's suppression-list entry, shown on the thread whatever its CRM status says
    const suppression = await suppressionEntries(prisma, latestReplies.map(r => r.lead.email));

    const listed = page.map(thread => {
      const latestInbound = latestById.get(thread.replyIds[0]);
      const replyLead = latestInbound?.lead;
      const lead = replyLead ? { ...replyLead, suppression: suppression.get(normalizeEmail(replyLead.email)) ?? null } : null;
      return {
        id: thread.id, // Thread ID is the threadKey (leadId-normalizedSubject)
        subject: thread.subject || 'No Subject',
        preview: (latestInbound?.body || '').substring(0, PREVIEW_MAX_CHARS),
        receivedAt: thread.lastActivityAt,
        // Unread when any inbound reply is unread
        unread: thread.unread,
        leadId: thread.leadId,
        lead,
        senderAccountId: latestInbound?.senderAccountId || null,
        senderAccount: latestInbound?.senderAccount || null
      };
    });

    return NextResponse.json({
      threads: listed,
      total: threads.length,
      unreadCount,
      nextOffset: offset + limit < threads.length ? offset + limit : null
    });
  } catch (error: any) {
    if (error instanceof UnauthorizedError) return unauthorizedResponse();
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const session = await getSession();
    const data = await req.json();
    const { responseId, leadId, unread, leadStatus, enrollmentStatus } = data;

    if (!responseId && !leadId) {
      return NextResponse.json({ error: 'Either responseId or leadId is required.' }, { status: 400 });
    }

    // The status is CRM sentiment only: Bounced and Unsubscribed come with a suppression, never from an edit
    if (leadStatus !== undefined && !CRM_STATUSES.includes(leadStatus)) {
      return NextResponse.json({ error: `leadStatus must be one of ${CRM_STATUSES.join(', ')}.` }, { status: 400 });
    }

    // 1. Update unread status on InboundResponse (could be lead level, threadKey level, or specific response level)
    if (responseId && unread !== undefined) {
      const parts = responseId.split('-');
      const lId = parts.slice(0, 5).join('-');
      const normalizedSub = parts.slice(5).join('-');
      
      const isLead = await prisma.lead.count({ where: { id: lId } });
      if (isLead > 0 && normalizedSub) {
        // Fetch all inbound responses for this lead
        const leadReplies = await prisma.inboundResponse.findMany({
          where: { leadId: lId }
        });
        const matchingReplyIds = leadReplies
          .filter(r => normalizeSubject(r.subject) === normalizedSub)
          .map(r => r.id);
          
        if (matchingReplyIds.length > 0) {
          await prisma.inboundResponse.updateMany({
            where: { id: { in: matchingReplyIds } },
            data: { unread: !!unread }
          });
        }
      } else {
        const isResponse = await prisma.inboundResponse.count({ where: { id: responseId } });
        if (isResponse > 0) {
          await prisma.inboundResponse.update({
            where: { id: responseId },
            data: { unread: !!unread }
          });
        } else if (isLead > 0) {
          await prisma.inboundResponse.updateMany({
            where: { leadId: responseId, unread: true },
            data: { unread: !!unread }
          });
        }
      }
    }

    // 2. Update Lead CRM status. A suppressed address stays on the suppression list whatever it is set to.
    if (leadId && leadStatus !== undefined) {
      await prisma.lead.update({
        where: { id: leadId },
        data: { status: leadStatus }
      });
    }

    // 3. Update CampaignEnrollment status (e.g. pause/resume all enrollments for this lead)
    if (leadId && enrollmentStatus !== undefined) {
      await prisma.campaignEnrollment.updateMany({
        where: { leadId },
        data: { status: enrollmentStatus } // 'Active' or 'Paused'
      });
    }

    // Return the updated reply details if responseId is provided
    if (responseId) {
      const parts = responseId.split('-');
      const lId = parts[0];
      const isLead = await prisma.lead.count({ where: { id: lId } });
      if (isLead > 0) {
        return NextResponse.json({ success: true });
      }
      
      const updatedReply = await prisma.inboundResponse.findUnique({
        where: { id: responseId },
        include: {
          lead: {
            include: {
              enrollments: true
            }
          },
          senderAccount: { omit: MAILBOX_SECRET_OMIT }
        }
      });
      return NextResponse.json(updatedReply);
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    if (error instanceof UnauthorizedError) return unauthorizedResponse();
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
