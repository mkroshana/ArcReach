import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { syncMailboxReplies, getActiveImapAccounts } from '@/lib/imapService';
import { MAILBOX_SECRET_OMIT } from '@/lib/mailboxSecrets';

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

export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    const { searchParams } = new URL(req.url);
    const shouldSync = searchParams.get('sync') === 'true';
    
    // Find all active sender accounts with IMAP configured for this user/admin using shared helper
    const activeImapAccounts = await getActiveImapAccounts(session.id, session.role);
    
    // Concurrently trigger IMAP sync for all eligible accounts
    if (activeImapAccounts.length > 0) {
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
    
    let inboundWhere = {};
    if (session.role !== 'ADMIN') {
      inboundWhere = {
        senderAccount: {
          userId: session.id
        }
      };
    }

    const replies = await prisma.inboundResponse.findMany({
      where: inboundWhere,
      include: {
        lead: {
          include: {
            enrollments: {
              include: {
                campaign: true
              }
            }
          }
        },
        campaign: true,
        senderAccount: { omit: MAILBOX_SECRET_OMIT }
      },
      orderBy: { receivedAt: 'desc' }
    });

    const leadIds = Array.from(new Set(replies.map(r => r.leadId)));
    
    // Fetch all dispatches for these leads
    const dispatches = await prisma.emailDispatch.findMany({
      where: {
        leadId: { in: leadIds }
      },
      orderBy: { sentAt: 'asc' }
    });
    
    // Group replies and dispatches by threadKey (leadId-normalizedSubject) in memory
    const threadsMap: Record<string, {
      leadReplies: typeof replies;
      leadDispatches: typeof dispatches;
    }> = {};
    
    for (const reply of replies) {
      const normSub = normalizeSubject(reply.subject);
      const key = `${reply.leadId}-${normSub}`;
      if (!threadsMap[key]) {
        threadsMap[key] = { leadReplies: [], leadDispatches: [] };
      }
      threadsMap[key].leadReplies.push(reply);
    }
    
    for (const dispatch of dispatches) {
      const normSub = normalizeSubject(dispatch.subject || '');
      const key = `${dispatch.leadId}-${normSub}`;
      // Note: Only group dispatches into threads that have at least one reply (standard Inbox/Unibox view)
      if (threadsMap[key]) {
        threadsMap[key].leadDispatches.push(dispatch);
      }
    }
    
    const threads = Object.entries(threadsMap).map(([key, group]) => {
      const parts = key.split('-');
      const leadId = parts.slice(0, 5).join('-');
      
      const { leadReplies, leadDispatches } = group;
      
      // Get the lead details (from any reply)
      const lead = leadReplies[0]?.lead || null;
      
      // Map replies to standard message format
      const inboundMsgs = leadReplies.map(r => ({
        id: r.id,
        type: 'inbound' as const,
        subject: r.subject,
        body: r.body,
        timestamp: r.receivedAt,
        senderAccountId: r.senderAccountId,
        senderAccount: r.senderAccount,
        campaign: r.campaign,
        unread: r.unread
      }));
      
      // Map dispatches to standard message format
      const outboundMsgs = leadDispatches.map(d => ({
        id: d.id,
        type: 'outbound' as const,
        subject: d.subject || 'Campaign Outreach',
        body: d.body || '',
        timestamp: d.sentAt,
        senderAccountId: null,
        senderAccount: null
      }));
      
      // Combine and sort messages chronologically (oldest first)
      const messages = [...inboundMsgs, ...outboundMsgs].sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );
      
      // Determine the latest message for displaying thread preview
      const sortedDesc = [...messages].sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );
      const latestMsg = sortedDesc[0];
      
      // Determine unread status (if any inbound replies are unread)
      const unread = leadReplies.some(r => r.unread);
      
      // Get the latest inbound response to populate senderAccountId and senderAccount for compatibility
      const latestInbound = [...leadReplies].sort(
        (a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime()
      )[0];
      
      return {
        id: key, // Thread ID is the threadKey (leadId-normalizedSubject)
        subject: latestMsg?.subject || 'No Subject',
        body: latestMsg?.body || '',
        receivedAt: latestMsg?.timestamp || new Date(),
        unread,
        leadId,
        lead,
        senderAccountId: latestInbound?.senderAccountId || null,
        senderAccount: latestInbound?.senderAccount || null,
        messages
      };
    });
    
    // Sort threads by the latest activity timestamp descending (most recent first)
    threads.sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime());
    
    return NextResponse.json(threads);
  } catch (error: any) {
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

    // 2. Update Lead CRM status
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
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
