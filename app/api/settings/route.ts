import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession, setSession } from '@/lib/session';
import { UnauthorizedError, unauthorizedResponse } from '@/lib/sessionError';
import { verifyPassword, hashPassword } from '@/lib/auth';
import { MASKED_SECRET, encryptSecret } from '@/lib/secrets';
import { passwordPolicyError } from '@/lib/passwordPolicy';
import { ensureGlobalSettings, saveGlobalSettings } from '@/lib/settings';
import { globalRateLimitError } from '@/lib/rateLimitPolicy';

/** Fields that are never returned in plaintext and must be skipped on PUT when
 * the client echoes back the mask. */
const SECRET_FIELDS = ['azureConnString', 'smtpPass', 'imapPass'] as const;

/** Settings fields that require ADMIN to read or write. Profile/password live
 * outside this set and remain accessible to the owning user. */
const ADMIN_ONLY_SETTINGS_FIELDS = [
  'activeProvider',
  'azureConnString',
  'azureSenderDomain',
  'azureSenderDomains',
  'smtpHost', 'smtpPort', 'smtpUser', 'smtpPass',
  'imapHost', 'imapPort', 'imapUser', 'imapPass',
  'rateLimitMinute', 'rateLimitHour',
] as const;

/** Normalize a verified-domains payload into a trimmed, lowercased, de-duped string[]. */
function normalizeDomains(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const cleaned = input.map((d) => String(d).trim().toLowerCase()).filter(Boolean);
  return [...new Set(cleaned)];
}

function redactSettings<T extends Record<string, any>>(settings: T): T {
  const out: Record<string, any> = { ...settings };
  for (const f of SECRET_FIELDS) {
    if (out[f]) out[f] = MASKED_SECRET;
  }
  return out as T;
}

export async function GET() {
  try {
    const session = await getSession();

    const user = await prisma.user.findUnique({
      where: { id: session.id },
      select: {
        id: true, email: true, name: true, organization: true,
        role: true, createdAt: true,
      }
    });

    // Settings are admin-only. Non-admins get their profile but no settings block.
    let settingsPayload: any = null;
    if (session.role === 'ADMIN') {
      // Nothing is configured on first load: SMTP and IMAP stay null.
      const settings = await ensureGlobalSettings({
        activeProvider: 'DISABLED',
        rateLimitMinute: 60,
        rateLimitHour: 1000
      });
      settingsPayload = redactSettings(settings);
    }

    return NextResponse.json({
      user: user || {
        id: session.id,
        name: session.name,
        email: session.email,
        role: session.role
      },
      settings: settingsPayload
    });
  } catch (error: any) {
    if (error instanceof UnauthorizedError) return unauthorizedResponse();
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const session = await getSession();
    const body = await req.json();
    const { name, organization, activeProvider, azureConnString, azureSenderDomain, azureSenderDomains, smtpHost, smtpPort, smtpUser, smtpPass, imapHost, imapPort, imapUser, imapPass, rateLimitMinute, rateLimitHour, currentPassword, newPassword } = body;

    // Block non-admins from touching any admin-only settings field.
    const touchesAdminField = ADMIN_ONLY_SETTINGS_FIELDS.some((f) => body[f] !== undefined);
    if (touchesAdminField && session.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Admin role required to modify delivery settings.' }, { status: 403 });
    }

    // 1. Update user profile details in the DB
    // User.timezone is not written: nothing reads it, so the profile no longer offers it.
    if (name !== undefined || organization !== undefined) {
      const dataToUpdate: any = {};
      if (name !== undefined) dataToUpdate.name = name;
      if (organization !== undefined) dataToUpdate.organization = organization;

      // getSession reads the name from the database, so the session cookie needs no update.
      await prisma.user.update({
        where: { id: session.id },
        data: dataToUpdate
      });
    }

    // Update password in the DB
    if (newPassword !== undefined) {
      if (!currentPassword) {
        return NextResponse.json({ error: 'Current password is required.' }, { status: 400 });
      }
      const passwordError = passwordPolicyError(newPassword);
      if (passwordError) {
        return NextResponse.json({ error: passwordError }, { status: 400 });
      }

      const userObj = await prisma.user.findUnique({
        where: { id: session.id }
      });

      if (!userObj) {
        return NextResponse.json({ error: 'User not found.' }, { status: 404 });
      }

      if (!(await verifyPassword(currentPassword, userObj.passwordHash))) {
        return NextResponse.json({ error: 'Current password does not match.' }, { status: 400 });
      }

      // Bumping tokenVersion ends every other session; this one is re-issued so the user stays signed in here.
      const { tokenVersion } = await prisma.user.update({
        where: { id: session.id },
        data: { passwordHash: await hashPassword(newPassword), tokenVersion: { increment: 1 } },
        select: { tokenVersion: true }
      });
      await setSession({ ...session, tokenVersion });
    }

    // From here on, only admins can reach the settings-write paths. If nothing
    // settings-related was supplied, short-circuit and return the user's view.
    if (!touchesAdminField) {
      return NextResponse.json({ success: true, settings: null });
    }

    // 2. Update Global Settings
    /** Echo guard: if the client sent back the mask sentinel, drop the field. */
    const liveSecret = (v: unknown): string | null | undefined => {
      if (v === undefined || v === MASKED_SECRET) return undefined;
      if (v === null) return null;
      return String(v);
    };

    const settingsData: any = {};
    if (activeProvider !== undefined) {
      // Azure Communication Services is the only provider; DISABLED sends nothing.
      if (activeProvider !== 'AZURE' && activeProvider !== 'DISABLED') {
        return NextResponse.json({ error: 'Delivery provider must be AZURE or DISABLED.' }, { status: 400 });
      }
      settingsData.activeProvider = activeProvider;
    }
    // null is an explicit No Limit; an empty, zero or fractional limit would silently turn limiting off.
    const rateLimitProblem = (rateLimitMinute !== undefined && globalRateLimitError(rateLimitMinute, 'minute'))
      || (rateLimitHour !== undefined && globalRateLimitError(rateLimitHour, 'hour'));
    if (rateLimitProblem) {
      return NextResponse.json({ error: rateLimitProblem }, { status: 400 });
    }
    /** Encrypt unless the value is null/empty (which clears the field). */
    const encrypted = (v: string | null | undefined) => (v ? encryptSecret(v) : v ?? null);

    const liveAzureConn = liveSecret(azureConnString);
    const liveSmtpPass = liveSecret(smtpPass);
    const liveImapPass = liveSecret(imapPass);
    if (liveAzureConn !== undefined) settingsData.azureConnString = encrypted(liveAzureConn);
    if (azureSenderDomain !== undefined) settingsData.azureSenderDomain = azureSenderDomain;
    if (azureSenderDomains !== undefined) settingsData.azureSenderDomains = normalizeDomains(azureSenderDomains);
    if (smtpHost !== undefined) settingsData.smtpHost = smtpHost;
    if (smtpPort !== undefined) settingsData.smtpPort = Number(smtpPort) || null;
    if (smtpUser !== undefined) settingsData.smtpUser = smtpUser;
    if (liveSmtpPass !== undefined) settingsData.smtpPass = encrypted(liveSmtpPass);
    if (imapHost !== undefined) settingsData.imapHost = imapHost;
    if (imapPort !== undefined) settingsData.imapPort = Number(imapPort) || null;
    if (imapUser !== undefined) settingsData.imapUser = imapUser;
    if (liveImapPass !== undefined) settingsData.imapPass = encrypted(liveImapPass);
    if (rateLimitMinute !== undefined) settingsData.rateLimitMinute = rateLimitMinute;
    if (rateLimitHour !== undefined) settingsData.rateLimitHour = rateLimitHour;

    const updatedSettings = await saveGlobalSettings(settingsData, {
      activeProvider: activeProvider || 'DISABLED',
      azureConnString: encrypted(liveAzureConn),
      azureSenderDomain: azureSenderDomain || null,
      azureSenderDomains: azureSenderDomains !== undefined ? normalizeDomains(azureSenderDomains) : undefined,
      smtpHost: smtpHost || null,
      smtpPort: Number(smtpPort) || null,
      smtpUser: smtpUser || null,
      smtpPass: encrypted(liveSmtpPass),
      imapHost: imapHost || null,
      imapPort: Number(imapPort) || null,
      imapUser: imapUser || null,
      imapPass: encrypted(liveImapPass),
      rateLimitMinute: rateLimitMinute === undefined ? 60 : rateLimitMinute,
      rateLimitHour: rateLimitHour === undefined ? 1000 : rateLimitHour
    });

    return NextResponse.json({
      success: true,
      settings: redactSettings(updatedSettings)
    });
  } catch (error: any) {
    if (error instanceof UnauthorizedError) return unauthorizedResponse();
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
