import { NextRequest, NextResponse } from 'next/server';
import { db, prisma } from '@/lib/db';
import { getSession } from '@/lib/session';

export async function GET() {
  try {
    const session = await getSession();
    
    // Fetch accounts with constraints. Admins see all, users only see theirs.
    const accounts = await db.getAccounts(session.id, session.role);
    
    // Calculate emails sent today (since midnight) for each account
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const accountsWithStats = await Promise.all(accounts.map(async (account) => {
      const campaigns = await prisma.campaign.findMany({
        where: { senderAccountId: account.id },
        select: { id: true }
      });
      const campaignIds = campaigns.map(c => c.id);

      const dispatchWhereClause = {
        OR: [
          { senderAccountId: account.id },
          {
            senderAccountId: null,
            campaign: {
              senderAccountId: account.id
            }
          }
        ]
      };

      const sentToday = await prisma.emailDispatch.count({
        where: {
          ...dispatchWhereClause,
          sentAt: { gte: startOfToday }
        }
      });

      const sentTotal = await prisma.emailDispatch.count({
        where: dispatchWhereClause
      });

      const opens = await prisma.emailDispatch.count({
        where: {
          ...dispatchWhereClause,
          events: {
            some: { eventType: 'open' }
          }
        }
      });

      const clicks = await prisma.emailDispatch.count({
        where: {
          ...dispatchWhereClause,
          events: {
            some: { eventType: 'click' }
          }
        }
      });

      const delivered = await prisma.emailDispatch.count({
        where: {
          ...dispatchWhereClause,
          status: 'Sent',
          deliveredAt: { not: null }
        }
      });

      const replies = await prisma.inboundResponse.count({
        where: { senderAccountId: account.id }
      });

      const bounced = await prisma.campaignEnrollment.count({
        where: {
          campaignId: { in: campaignIds },
          status: 'Bounced'
        }
      });

      // Engagement rates against delivered mail when available, else against total sends.
      const engagementBase = delivered > 0 ? delivered : sentTotal;
      const deliveryRate = sentTotal > 0 ? Number(((delivered / sentTotal) * 100).toFixed(1)) : 0;
      const openRate = engagementBase > 0 ? Number(((opens / engagementBase) * 100).toFixed(1)) : 0;
      const clickRate = engagementBase > 0 ? Number(((clicks / engagementBase) * 100).toFixed(1)) : 0;
      const replyRate = sentTotal > 0 ? Number(((replies / sentTotal) * 100).toFixed(1)) : 0;

      // Calculate effectiveDailyCap
      const now = new Date();
      let effectiveDailyCap = account.dailyLimit;
      if (account.warmupEnabled && account.warmupStartedAt) {
        const startedAt = new Date(account.warmupStartedAt);
        const elapsedMs = now.getTime() - startedAt.getTime();
        const daysActive = Math.max(0, Math.floor(elapsedMs / 86400000));
        effectiveDailyCap = Math.min(account.dailyLimit, account.warmupLimit + account.warmupRamp * daysActive);
      }

      return {
        ...account,
        sentToday,
        sentTotal,
        delivered,
        opens,
        clicks,
        replies,
        bounced,
        deliveryRate,
        openRate,
        clickRate,
        replyRate,
        effectiveDailyCap
      };
    }));

    return NextResponse.json(accountsWithStats);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    const data = await req.json();

    const { 
      emailAddress, 
      name, 
      replyTo,
      provider, 
      status, 
      minuteLimit, 
      hourlyLimit, 
      dailyLimit,
      userId,
      warmupEnabled,
      warmupLimit,
      warmupRamp,
      smtpHost,
      smtpPort,
      smtpUser,
      smtpPass,
      imapHost,
      imapPort,
      imapUser,
      imapPass
    } = data;

    if (!emailAddress || !provider) {
      return NextResponse.json({ error: 'Email address and Provider are required.' }, { status: 400 });
    }

    // Role boundary checks: standard users can ONLY create accounts assigned to themselves
    const targetUserId = session.role === 'ADMIN' ? (userId || session.id) : session.id;

    const newAccount = await db.createAccount({
      emailAddress,
      name: name || '',
      replyTo: replyTo || null,
      provider,
      status: status || 'Active',
      minuteLimit: Number(minuteLimit) || 1,
      hourlyLimit: Number(hourlyLimit) || 60,
      dailyLimit: Number(dailyLimit) || 500,
      dailyMax: Number(dailyLimit) || 500,
      userId: targetUserId,
      warmupEnabled: !!warmupEnabled,
      warmupStartedAt: warmupEnabled ? new Date() : null,
      warmupLimit: Number(warmupLimit) || 50,
      warmupRamp: Number(warmupRamp) || 2,
      smtpHost: smtpHost || null,
      smtpPort: smtpPort ? Number(smtpPort) : null,
      smtpUser: smtpUser || null,
      smtpPass: smtpPass || null,
      imapHost: imapHost || null,
      imapPort: imapPort ? Number(imapPort) : null,
      imapUser: imapUser || null,
      imapPass: imapPass || null,
    });

    return NextResponse.json(newAccount);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const session = await getSession();
    const data = await req.json();
    const { id, ...updates } = data;

    if (!id) {
      return NextResponse.json({ error: 'Account ID is required for editing.' }, { status: 400 });
    }

    // Check permissions - if user, verify they own the mailbox
    const accountsList = await db.getAccounts(session.id, session.role);
    const hasAccess = accountsList.some(acc => acc.id === id);

    if (!hasAccess) {
      return NextResponse.json({ error: 'Unauthorized profile update.' }, { status: 403 });
    }

    // If standard user, prevent them from reassigning the account to someone else
    if (session.role !== 'ADMIN') {
      delete updates.userId;
    }

    if (updates.smtpPort !== undefined) {
      updates.smtpPort = updates.smtpPort ? Number(updates.smtpPort) : null;
    }
    if (updates.imapPort !== undefined) {
      updates.imapPort = updates.imapPort ? Number(updates.imapPort) : null;
    }

    const existingAccount = await prisma.senderAccount.findUnique({ where: { id } });
    if (existingAccount) {
      if (updates.warmupEnabled === true && !existingAccount.warmupEnabled) {
        if (!existingAccount.warmupStartedAt) {
          updates.warmupStartedAt = new Date();
        }
      }
    }

    const updated = await db.updateAccount(id, updates);
    return NextResponse.json(updated);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const session = await getSession();
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json({ error: 'Account ID is required.' }, { status: 400 });
    }

    // Check ownership
    const accountsList = await db.getAccounts(session.id, session.role);
    const hasAccess = accountsList.some(acc => acc.id === id);

    if (!hasAccess) {
      return NextResponse.json({ error: 'Unauthorized to delete this mailbox.' }, { status: 403 });
    }

    await db.deleteAccount(id);
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
