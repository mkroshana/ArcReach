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

      const sentToday = await prisma.emailDispatch.count({
        where: {
          campaignId: { in: campaignIds },
          sentAt: { gte: startOfToday }
        }
      });

      const sentTotal = await prisma.emailDispatch.count({
        where: { campaignId: { in: campaignIds } }
      });

      const opens = await prisma.emailDispatch.count({
        where: {
          campaignId: { in: campaignIds },
          events: {
            some: { eventType: 'open' }
          }
        }
      });

      const clicks = await prisma.emailDispatch.count({
        where: {
          campaignId: { in: campaignIds },
          events: {
            some: { eventType: 'click' }
          }
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

      return {
        ...account,
        sentToday,
        sentTotal,
        opens,
        clicks,
        replies,
        bounced
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
