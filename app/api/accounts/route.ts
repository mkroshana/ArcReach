import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { db, prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { UnauthorizedError, unauthorizedResponse } from '@/lib/sessionError';
import { MASKED_SECRET, encryptSecret } from '@/lib/secrets';
import { getGlobalSettings } from '@/lib/settings';
import { getVerifiedDomains, unverifiedSenderMessage } from '@/lib/azureDomains';
import { getMailboxCap, senderCapDispatchWhere } from '@/lib/sendEngine';
import { mailboxDailyLimitsOff } from '@/lib/mailboxCapacity';
import { type MetricsScope, countHardBounces, countReplies, percent, sendSummary } from '@/lib/engagementMetrics';
import { type FieldRule, fieldRules, isPlainObject, pickUpdateFields } from '@/lib/updateAllowList';
import { parseRecipientDomains } from '@/lib/senderRouting';
import { campaignsLeftUnrouted } from '@/lib/campaignRouting';

/** Scalar columns the mailbox PUT may write: the daily limit, warmup and IMAP credential
 *  controls on the Accounts page plus the internal label. Counters, reputation and
 *  warmupStartedAt are server-managed. Per-minute and per-hour limits are global
 *  (Settings), so a minuteLimit or hourlyLimit is refused, and Azure sends every
 *  email, so SMTP details are too. The PUT also takes recipientDomains, a list. */
const ACCOUNT_UPDATE_FIELDS: Record<string, FieldRule> = {
  name: fieldRules.nullableString,
  replyTo: fieldRules.nullableString,
  replyToName: fieldRules.nullableString,
  dailyLimit: fieldRules.nonNegativeInt,
  warmupEnabled: fieldRules.boolean,
  warmupLimit: fieldRules.nonNegativeInt,
  warmupRamp: fieldRules.nonNegativeInt,
  imapHost: fieldRules.nullableString,
  imapPort: fieldRules.port,
  imapUser: fieldRules.nullableString,
  imapPass: fieldRules.nullableString,
  imapAllowSelfSigned: fieldRules.boolean,
  userId: fieldRules.nonEmptyString,
};

/** Redact stored secrets in API responses; UI sends the mask back unchanged
 *  for unedited fields, and PUT skips them so the real secret stays intact. */
function redactAccount<T extends Record<string, any>>(acc: T): T {
  return { ...acc, imapPass: acc.imapPass ? MASKED_SECRET : null };
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

/** 409 text for Recipient Domains that would leave `total` campaigns with no mailbox for leads at other domains, naming the ones in `visibleNames`. */
function leavesCampaignsUnroutedMessage(total: number, visibleNames: string[]): string {
  const listed = visibleNames.slice(0, MAX_LISTED_CAMPAIGNS).map((n) => `"${n}"`);
  const unlisted = total - listed.length;
  const detail = listed.length === 0 ? '' : `: ${listed.join(', ')}${unlisted > 0 ? ` and ${unlisted} more` : ''}`;
  const one = total === 1;
  return `Cannot limit this mailbox to Recipient Domains: ${one ? 'a campaign' : `${total} campaigns`} would be left with no mailbox for leads at other domains${detail}. ` +
    `Add a mailbox with no Recipient Domains to ${one ? 'that campaign' : 'those campaigns'} first.`;
}

/** Whether the global rate limits in Settings have the mailboxes' own daily limits off. */
async function mailboxDailyLimitsAreOff(): Promise<boolean> {
  const settings = await getGlobalSettings();
  return mailboxDailyLimitsOff({ minute: settings?.rateLimitMinute, hour: settings?.rateLimitHour });
}

export async function GET() {
  try {
    const session = await getSession();
    
    // Fetch accounts with constraints. Admins see all, users only see theirs.
    const accounts = await db.getAccounts(session.id, session.role);
    
    const now = new Date();
    // With a global rate limit set the mailboxes share its daily allowance (GET
    // /api/accounts/capacity) and have no daily limits of their own.
    const dailyLimitsOff = await mailboxDailyLimitsAreOff();

    const accountsWithStats = await Promise.all(accounts.map(async (account) => {
      // Counted as the send engine counts the mailbox's daily and warmup cap:
      // sends in the last 24 hours, not since midnight, and never Failed ones.
      const sentLast24Hours = await prisma.emailDispatch.count({
        where: senderCapDispatchWhere(account.id, now)
      });

      // The mailbox's campaign sends that ACS accepted, their opens, clicks and
      // hard bounces (at send time or reported), defined in lib/engagementMetrics
      // as on the campaign pages and the dashboard. `reported`: how many a
      // delivery report arrived for, the delivery rate's base; with none, the
      // page shows Delivered as unknown.
      // Replies: the human replies that arrived in this mailbox, which may answer
      // another mailbox's emails (its Reply-To), so they are no share of the leads
      // this mailbox contacted, as a campaign's reply rate is. They are given per
      // 100 emails this mailbox sent instead (repliesPer100Sent), null when it sent
      // none, and the page says when even that means little (mailboxRepliesFigure).
      const scope: MetricsScope = { kind: 'mailbox', senderAccountId: account.id };
      const [sends, bounced, replies] = await Promise.all([
        sendSummary(prisma, scope),
        countHardBounces(prisma, scope),
        countReplies(prisma, scope),
      ]);

      // The cap the send engine enforces on the mailbox's own sends: the warmup ramp while it
      // holds the mailbox below its daily limit, and null when it has none (its daily limit is
      // off and it is not warming up).
      const effectiveDailyCap = getMailboxCap(account, now, dailyLimitsOff);

      return {
        ...redactAccount(account),
        sentLast24Hours,
        sentTotal: sends.sent,
        delivered: sends.delivered,
        reported: sends.reported,
        opens: sends.opened,
        clicks: sends.clicked,
        replies,
        bounced,
        deliveryRate: sends.deliveryRate,
        openRate: sends.openRate,
        clickRate: sends.clickRate,
        repliesPer100Sent: sends.sent > 0 ? percent(replies, sends.sent) : null,
        effectiveDailyCap
      };
    }));

    return NextResponse.json(accountsWithStats);
  } catch (error: any) {
    if (error instanceof UnauthorizedError) return unauthorizedResponse();
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
      replyToName,
      provider,
      status,
      dailyLimit,
      userId,
      warmupEnabled,
      warmupLimit,
      warmupRamp,
      imapHost,
      imapPort,
      imapUser,
      imapPass,
      imapAllowSelfSigned
    } = data;

    if (!emailAddress || !provider) {
      return NextResponse.json({ error: 'Email address and Provider are required.' }, { status: 400 });
    }

    // Azure sends only from a verified domain, so refuse a mailbox it could
    // never send from instead of failing every send later. PUT cannot change
    // the address, so this is the only place it is set.
    const settings = await getGlobalSettings();
    const unverified = unverifiedSenderMessage(emailAddress, settings);
    if (unverified) {
      return NextResponse.json({ error: unverified, verifiedDomains: getVerifiedDomains(settings) }, { status: 400 });
    }

    // Role boundary checks: standard users can ONLY create accounts assigned to themselves
    const targetUserId = session.role === 'ADMIN' ? (userId || session.id) : session.id;

    const newAccount = await db.createAccount({
      emailAddress,
      name: name || '',
      replyTo: replyTo || null,
      replyToName: replyToName || null,
      provider,
      status: status || 'Active',
      dailyLimit: Number(dailyLimit) || 500,
      userId: targetUserId,
      warmupEnabled: !!warmupEnabled,
      warmupStartedAt: warmupEnabled ? new Date() : null,
      warmupLimit: Number(warmupLimit) || 50,
      warmupRamp: Number(warmupRamp) || 2,
      imapHost: imapHost || null,
      imapPort: imapPort ? Number(imapPort) : null,
      imapUser: imapUser || null,
      imapPass: encryptedOrNull(imapPass),
      // Certificate verification stays on unless explicitly turned off.
      imapAllowSelfSigned: imapAllowSelfSigned === true,
    });

    return NextResponse.json(redactAccount(newAccount));
  } catch (error: any) {
    if (error instanceof UnauthorizedError) return unauthorizedResponse();
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
    // recipientDomains is the one list among the mailbox's columns, so it is read apart from the scalar ones below.
    const { id, recipientDomains, ...fields } = data;

    if (!id || typeof id !== 'string') {
      return NextResponse.json({ error: 'Account ID is required for editing.' }, { status: 400 });
    }

    const domains = recipientDomains === undefined ? null : parseRecipientDomains(recipientDomains);
    if (domains && domains.error !== null) {
      return NextResponse.json({ error: domains.error }, { status: 400 });
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

    // The mailbox's own Recipient Domains hold in every campaign (lib/senderRouting),
    // so they may not leave a campaign that sends from it with no mailbox for
    // leads at other domains. Non-admins only get the names of their own campaigns.
    if (domains?.domains) {
      const unrouted = await campaignsLeftUnrouted(id, domains.domains);
      if (unrouted.length > 0) {
        const visibleNames = unrouted
          .filter((c) => session.role === 'ADMIN' || c.userId === session.id)
          .map((c) => c.name);
        return NextResponse.json({ error: leavesCampaignsUnroutedMessage(unrouted.length, visibleNames) }, { status: 409 });
      }
      updates.recipientDomains = domains.domains;
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

    // Secret: drop if echoed mask (don't overwrite real value); else encrypt.
    if (updates.imapPass === MASKED_SECRET) {
      delete updates.imapPass;
    } else if (updates.imapPass !== undefined) {
      updates.imapPass = encryptedOrNull(updates.imapPass as string | null);
    }

    // Turning warmup on, first time or again, starts the ramp over at Day 1: days
    // with warmup off must not count as ramp days, and warmupSent counts this ramp only.
    const existingAccount = await prisma.senderAccount.findUnique({ where: { id } });
    if (existingAccount) {
      if (updates.warmupEnabled === true && !existingAccount.warmupEnabled) {
        updates.warmupStartedAt = new Date();
        updates.warmupSent = 0;
      }
      // Another IMAP host or login is another mailbox, whose UIDs the reply-sync
      // checkpoint says nothing about, so the next sync starts over.
      const imapMoved = (['imapHost', 'imapUser'] as const).some(
        (f) => updates[f] !== undefined && (updates[f] ?? null) !== (existingAccount[f] ?? null)
      );
      if (imapMoved) {
        updates.imapUidValidity = null;
        updates.imapLastUid = null;
        updates.imapFailedUid = null;
        updates.imapFailedUidAttempts = 0;
      }
      // The reply-sync status describes the connection details it was read with, so
      // any change to them shows the mailbox as pending until the next sync. A new
      // password always counts: the stored one is encrypted and can't be compared.
      const imapConnectionChanged = (['imapHost', 'imapPort', 'imapUser', 'imapPass', 'imapAllowSelfSigned'] as const).some(
        (f) => updates[f] !== undefined && (updates[f] ?? null) !== (existingAccount[f] ?? null)
      );
      if (imapConnectionChanged) {
        updates.imapLastSyncAt = null;
        updates.imapLastSyncError = null;
      }
    }

    const updated = await db.updateAccount(id, updates);
    // The Accounts page merges this into the mailbox it shows, keeping the stats GET counted;
    // the effective cap is the one figure a limit or warmup change moves, so it is sent too.
    return NextResponse.json({ ...redactAccount(updated), effectiveDailyCap: getMailboxCap(updated, new Date(), await mailboxDailyLimitsAreOff()) });
  } catch (error: any) {
    if (error instanceof UnauthorizedError) return unauthorizedResponse();
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
    if (error instanceof UnauthorizedError) return unauthorizedResponse();
    // P2003: a campaign picked this mailbox as primary sender after the check above, and the
    // Restrict foreign key refused the delete.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
      return NextResponse.json({ error: mailboxInUseMessage(1, []) }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
