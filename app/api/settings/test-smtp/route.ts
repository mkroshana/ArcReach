import { NextRequest, NextResponse } from 'next/server';
import nodemailer from 'nodemailer';
import { getSession } from '@/lib/session';
import { getGlobalSettings } from '@/lib/settings';
import { MASKED_SECRET, decryptSecret } from '@/lib/secrets';

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (session.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Admin role required.' }, { status: 403 });
    }

    const body = await req.json();
    let { smtpHost, smtpPort, smtpUser, smtpPass } = body;

    // If the form sent the redacted sentinel (password not edited), fall back to
    // the stored encrypted value so the test can actually authenticate.
    if (smtpPass === MASKED_SECRET) {
      const stored = await getGlobalSettings();
      smtpPass = decryptSecret(stored?.smtpPass) || '';
    }

    if (!smtpHost || !smtpPort) {
      return NextResponse.json({ error: 'SMTP Host and Port are required.' }, { status: 400 });
    }

    const logs: string[] = [];
    logs.push(`[SMTP] Resolving MX server domain of mail relay host ${smtpHost}...`);
    logs.push(`[SMTP] Establishing connection to ${smtpHost} on port ${smtpPort}...`);

    // Define custom logger to capture internal transaction steps
    const customLogger = {
      info: (msg: any) => logs.push(`[SMTP INFO] ${msg}`),
      warn: (msg: any) => logs.push(`[SMTP WARN] ${msg}`),
      error: (msg: any) => logs.push(`[SMTP ERROR] ${msg}`),
    };

    const portNum = Number(smtpPort);
    const transport = nodemailer.createTransport({
      host: smtpHost.trim(),
      port: portNum,
      secure: portNum === 465, // true for 465, false for other ports
      auth: {
        user: smtpUser || '',
        pass: smtpPass || '',
      },
      debug: true,
      logger: customLogger as any,
    });

    try {
      await transport.verify();
      logs.push(`[SMTP OK] Connection testing successfully completed! Ready for deliverability.`);
      return NextResponse.json({ success: true, logs });
    } catch (err: any) {
      logs.push(`[SMTP ERROR] Authentication or connection handshake failed: ${err.message}`);
      logs.push(`[SMTP FAILED] Connection testing failed. Please check host server hostname.`);
      return NextResponse.json({ success: false, logs, error: err.message });
    }
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
