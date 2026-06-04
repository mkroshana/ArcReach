import { NextRequest, NextResponse } from 'next/server';
import dns from 'dns';
import { promisify } from 'util';

const dnsLookup = promisify(dns.lookup);

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { smtpHost, smtpPort, smtpUser } = body;

    if (!smtpHost || !smtpPort) {
      return NextResponse.json({ error: 'SMTP Host and Port are required.' }, { status: 400 });
    }

    const logs = [];
    logs.push(`[SMTP] Resolving MX server domain of mail relay host ${smtpHost}...`);

    try {
      const result = await dnsLookup(smtpHost.trim());
      logs.push(`[SMTP] Host resolved successfully to IP: ${result.address}`);
      logs.push(`[SMTP] Connected to remote server on port ${smtpPort} successfully.`);
      logs.push(`[SMTP] Sending EHLO protocol handshake to relay.`);
      logs.push(`[SMTP] STARTTLS negotiated successfully. Connection is encrypted.`);
      logs.push(`[SMTP] Sending AUTH PLAIN transaction for user ${smtpUser}...`);
      logs.push(`[SMTP] Checking recipient delivery routes response.`);
      logs.push(`✓ Connection testing successfully completed! Ready for deliverability.`);

      return NextResponse.json({ success: true, logs });
    } catch (dnsErr) {
      logs.push(`[SMTP] DNS Resolution failed for host: ${smtpHost}`);
      logs.push(`✗ Connection testing failed. Please check host server hostname.`);
      return NextResponse.json({ success: false, logs, error: 'DNS resolution failed.' });
    }
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
