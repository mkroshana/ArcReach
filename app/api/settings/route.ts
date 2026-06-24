import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession, setSession } from '@/lib/session';
import { verifyPassword, hashPassword } from '@/lib/auth';

/** Normalize a verified-domains payload into a trimmed, lowercased, de-duped string[]. */
function normalizeDomains(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const cleaned = input.map((d) => String(d).trim().toLowerCase()).filter(Boolean);
  return [...new Set(cleaned)];
}

export async function GET() {
  try {
    const session = await getSession();
    
    // 1. Fetch user profile from DB
    const user = await prisma.user.findUnique({
      where: { id: session.id },
      select: {
        id: true,
        email: true,
        name: true,
        organization: true,
        timezone: true,
        role: true,
        createdAt: true
      }
    });

    // 2. Fetch or initialize Global Settings
    let settings = await prisma.globalSettings.findFirst();
    if (!settings) {
      settings = await prisma.globalSettings.create({
        data: {
          activeProvider: 'MOCK',
          smtpHost: 'smtp.mailgun.org',
          smtpPort: 587,
          smtpUser: 'postmaster@sandbox.arcreach.com',
          smtpPass: '•••••••••••••••••••••••••••••',
          rateLimitMinute: 60,
          rateLimitHour: 1000
        }
      });
    }

    return NextResponse.json({
      user: user || {
        id: session.id,
        name: session.name,
        email: session.email,
        role: session.role
      },
      settings
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const session = await getSession();
    const body = await req.json();
    const { name, organization, timezone, activeProvider, azureConnString, azureSenderDomain, azureSenderDomains, smtpHost, smtpPort, smtpUser, smtpPass, imapHost, imapPort, imapUser, imapPass, rateLimitMinute, rateLimitHour, currentPassword, newPassword } = body;

    // 1. Update user profile details in the DB
    if (name !== undefined || organization !== undefined || timezone !== undefined) {
      const dataToUpdate: any = {};
      if (name !== undefined) dataToUpdate.name = name;
      if (organization !== undefined) dataToUpdate.organization = organization;
      if (timezone !== undefined) dataToUpdate.timezone = timezone;

      const updatedUser = await prisma.user.update({
        where: { id: session.id },
        data: dataToUpdate
      });
      // Sync active cookies session as well
      await setSession({
        id: session.id,
        email: session.email,
        role: session.role,
        name: updatedUser.name || session.name
      });
    }

    // Update password in the DB
    if (newPassword !== undefined) {
      if (!currentPassword) {
        return NextResponse.json({ error: 'Current password is required.' }, { status: 400 });
      }

      const userObj = await prisma.user.findUnique({
        where: { id: session.id }
      });

      if (!userObj) {
        return NextResponse.json({ error: 'User not found.' }, { status: 404 });
      }

      if (!verifyPassword(currentPassword, userObj.passwordHash)) {
        return NextResponse.json({ error: 'Current password does not match.' }, { status: 400 });
      }

      await prisma.user.update({
        where: { id: session.id },
        data: { passwordHash: hashPassword(newPassword) }
      });
    }

    // 2. Update Global Settings
    const settings = await prisma.globalSettings.findFirst();
    
    const settingsData: any = {};
    if (activeProvider !== undefined) {
      if (activeProvider !== 'AZURE' && activeProvider !== 'MOCK') {
        return NextResponse.json({ error: 'Only AZURE or MOCK delivery providers are supported.' }, { status: 400 });
      }
      settingsData.activeProvider = activeProvider;
    }
    if (azureConnString !== undefined) settingsData.azureConnString = azureConnString;
    if (azureSenderDomain !== undefined) settingsData.azureSenderDomain = azureSenderDomain;
    if (azureSenderDomains !== undefined) settingsData.azureSenderDomains = normalizeDomains(azureSenderDomains);
    if (smtpHost !== undefined) settingsData.smtpHost = smtpHost;
    if (smtpPort !== undefined) settingsData.smtpPort = Number(smtpPort) || null;
    if (smtpUser !== undefined) settingsData.smtpUser = smtpUser;
    if (smtpPass !== undefined) settingsData.smtpPass = smtpPass;
    if (imapHost !== undefined) settingsData.imapHost = imapHost;
    if (imapPort !== undefined) settingsData.imapPort = Number(imapPort) || null;
    if (imapUser !== undefined) settingsData.imapUser = imapUser;
    if (imapPass !== undefined) settingsData.imapPass = imapPass;
    if (rateLimitMinute !== undefined) {
      settingsData.rateLimitMinute = rateLimitMinute === null ? null : Number(rateLimitMinute);
    }
    if (rateLimitHour !== undefined) {
      settingsData.rateLimitHour = rateLimitHour === null ? null : Number(rateLimitHour);
    }

    let updatedSettings;
    if (settings) {
      updatedSettings = await prisma.globalSettings.update({
        where: { id: settings.id },
        data: settingsData
      });
    } else {
      updatedSettings = await prisma.globalSettings.create({
        data: {
          activeProvider: activeProvider || 'MOCK',
          azureConnString: azureConnString || null,
          azureSenderDomain: azureSenderDomain || null,
          azureSenderDomains: azureSenderDomains !== undefined ? normalizeDomains(azureSenderDomains) : undefined,
          smtpHost: smtpHost || null,
          smtpPort: Number(smtpPort) || null,
          smtpUser: smtpUser || null,
          smtpPass: smtpPass || null,
          imapHost: imapHost || null,
          imapPort: Number(imapPort) || null,
          imapUser: imapUser || null,
          imapPass: imapPass || null,
          rateLimitMinute: rateLimitMinute === undefined ? 60 : (rateLimitMinute === null ? null : Number(rateLimitMinute)),
          rateLimitHour: rateLimitHour === undefined ? 1000 : (rateLimitHour === null ? null : Number(rateLimitHour))
        }
      });
    }

    return NextResponse.json({
      success: true,
      settings: updatedSettings
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
