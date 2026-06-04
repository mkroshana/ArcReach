import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession, setSession } from '@/lib/session';

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
        role: true,
        createdAt: true
      }
    });

    // 2. Fetch or initialize Global Settings
    let settings = await prisma.globalSettings.findFirst();
    if (!settings) {
      settings = await prisma.globalSettings.create({
        data: {
          smtpHost: 'smtp.mailgun.org',
          smtpPort: 587,
          smtpUser: 'postmaster@sandbox.arcreach.com',
          smtpPass: '•••••••••••••••••••••••••••••'
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
    const { name, smtpHost, smtpPort, smtpUser, smtpPass } = body;

    // 1. Update user profile name in the DB
    if (name !== undefined) {
      const updatedUser = await prisma.user.update({
        where: { id: session.id },
        data: { name }
      });
      // Sync active cookies session as well
      await setSession({
        id: session.id,
        email: session.email,
        role: session.role,
        name: updatedUser.name || session.name
      });
    }

    // 2. Update Global Settings
    const settings = await prisma.globalSettings.findFirst();
    
    const settingsData: any = {};
    if (smtpHost !== undefined) settingsData.smtpHost = smtpHost;
    if (smtpPort !== undefined) settingsData.smtpPort = Number(smtpPort) || null;
    if (smtpUser !== undefined) settingsData.smtpUser = smtpUser;
    if (smtpPass !== undefined) settingsData.smtpPass = smtpPass;

    let updatedSettings;
    if (settings) {
      updatedSettings = await prisma.globalSettings.update({
        where: { id: settings.id },
        data: settingsData
      });
    } else {
      updatedSettings = await prisma.globalSettings.create({
        data: {
          smtpHost: smtpHost || null,
          smtpPort: Number(smtpPort) || null,
          smtpUser: smtpUser || null,
          smtpPass: smtpPass || null
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
