import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { db, prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { MASKED_SECRET, encryptSecret } from '@/lib/secrets';
import { type FieldRule, fieldRules, isPlainObject, pickUpdateFields } from '@/lib/updateAllowList';

/** Scalar columns the mailbox PUT may write: the throttle, warmup and credential
 *  controls on the Accounts page plus the display name. Counters, reputation and
 *  warmupStartedAt are server-managed. */
const ACCOUNT_UPDATE_FIELDS: Record<string, FieldRule> = {
  name: fieldRules.nullableString,
  replyTo: fieldRules.nullableString,
  minuteLimit: fieldRules.nonNegativeInt,
  hourlyLimit: fieldRules.nonNegativeInt,
  dailyLimit: fieldRules.nonNegativeInt,
  warmupEnabled: fieldRules.boolean,
  warmupLimit: fieldRules.nonNegativeInt,
  warmupRamp: fieldRules.nonNegativeInt,
  smtpHost: fieldRules.nullableString,
  smtpPort: fieldRules.port,
  smtpUser: fieldRules.nullableString,
  smtpPass: fieldRules.nullableString,
  imapHost: fieldRules.nullableString,
  imapPort: fieldRules.port,
  imapUser: fieldRules.nullableString,
  imapPass: fieldRules.nullableString,
  userId: fieldRules.nonEmptyString,
};

/** Redact stored secrets in API responses; UI sends the mask back unchanged
 *  for unedited fields, and PUT skips them so the real secret stays intact. */
function redactAccount<T extends Record<string, any>>(acc: T): T {
  return { ...acc, smtpPass: acc.smtpPass ? MASKED_SECRET : null, imapPass: acc.imapPass ? MASKED_SECRET : null };
}

/** Encrypt a plaintext secret, or pass null/empty through. */
function encryptedOrNull(v: string | null | undefined): string | null {
  return v ? encryptSecret(v) : null;
}

/** Campaign names the in-use 409 spells out; any beyond this are only counted, so the toast stays readable. */
const MAX_LISTED_CAMPAIGNS = 5;

/** 409 text for a mailbox that `total` campaigns still send from, naming the ones in `visibleNames`. */
function mailboxInUseMessage(total: number, visibleNames: string[]): string {
  const listed = visibleNames.slice(0, MAX_LISTED_CAMPAIGNS).map((n) => `"${n}"`);
  const unlisted = total - listed.length;
  const detail = listed.length === 0 ? '' : `: ${listed.join(', ')}${unlisted > 0 ? ` and ${unlisted} more` : ''}`;
  const one = total === 1;
  return `Cannot delete this mailbox while ${one ? 'a campaign uses' : `${total} campaigns use`} it as a sender${detail}. ` +
    `Switch ${one ? 'that campaign' : 'those campaigns'} to another mailbox or delete ${one ? 'it' : 'them'} first.`;
}

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
        // A 'Sending' row has not been accepted by the provider yet, and an
        // 'Unknown' one was never confirmed sent.
        status: { notIn: ['Sending', 'Unknown'] },
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
        ...redactAccount(account),
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
      smtpPass: encryptedOrNull(smtpPass),
      imapHost: imapHost || null,
      imapPort: imapPort ? Number(imapPort) : null,
      imapUser: imapUser || null,
      imapPass: encryptedOrNull(imapPass),
    });

    return NextResponse.json(redactAccount(newAccount));
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const session = await getSession();
    const data = await req.json();
    if (!isPlainObject(data)) {
      return NextResponse.json({ error: 'Request body must be a JSON object.' }, { status: 400 });
    }
    const { id, ...fields } = data;

    if (!id || typeof id !== 'string') {
      return NextResponse.json({ error: 'Account ID is required for editing.' }, { status: 400 });
    }

    // Only listed scalar columns reach Prisma; object values would be nested writes.
    const picked = pickUpdateFields(fields, ACCOUNT_UPDATE_FIELDS);
    if (!picked.ok) {
      return NextResponse.json({ error: picked.error }, { status: 400 });
    }
    const updates = picked.data;

    // Check permissions - if user, verify they own the mailbox
    const accountsList = await db.getAccounts(session.id, session.role);
    const hasAccess = accountsList.some(acc => acc.id === id);

    if (!hasAccess) {
      return NextResponse.json({ error: 'Unauthorized profile update.' }, { status: 403 });
    }

    // If standard user, prevent them from reassigning the account to someone else
    if (updates.userId !== undefined) {
      if (session.role !== 'ADMIN') {
        delete updates.userId;
      } else {
        const owner = await prisma.user.findUnique({ where: { id: updates.userId as string }, select: { id: true } });
        if (!owner) {
          return NextResponse.json({ error: 'Assigned user does not exist.' }, { status: 400 });
        }
      }
    }

    // Secrets: drop if echoed mask (don't overwrite real value); else encrypt.
    for (const f of ['smtpPass', 'imapPass'] as const) {
      if (updates[f] === MASKED_SECRET) {
        delete updates[f];
      } else if (updates[f] !== undefined) {
        updates[f] = encryptedOrNull(updates[f] as string | null);
      }
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
    return NextResponse.json(redactAccount(updated));
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

    // Refuse, deleting nothing, while any campaign sends from this mailbox as its primary sender
    // or from its sender pool. Non-admins only get the names of their own campaigns.
    const dependents = await prisma.campaign.findMany({
      where: { OR: [{ senderAccountId: id }, { senders: { some: { senderAccountId: id } } }] },
      select: { name: true, userId: true },
      orderBy: { name: 'asc' },
    });
    if (dependents.length > 0) {
      const visibleNames = dependents
        .filter((c) => session.role === 'ADMIN' || c.userId === session.id)
        .map((c) => c.name);
      return NextResponse.json({ error: mailboxInUseMessage(dependents.length, visibleNames) }, { status: 409 });
    }

    await db.deleteAccount(id);
    return NextResponse.json({ success: true });
  } catch (error: any) {
    // P2003: a campaign picked this mailbox as primary sender after the check above, and the
    // Restrict foreign key refused the delete.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
      return NextResponse.json({ error: mailboxInUseMessage(1, []) }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
