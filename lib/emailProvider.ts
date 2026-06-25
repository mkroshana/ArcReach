/**
 * Single entry point for outbound email delivery. Owns the MOCK / AZURE / SMTP
 * branching that was previously duplicated across the send engine, campaign
 * run route, manual send, send-test, and unibox-reply routes.
 *
 * Throws:
 *   EmailConfigError — missing/invalid configuration (callers map to 4xx).
 *   EmailSendError   — provider accepted the request but the send failed
 *                      (Azure status === "Failed", SMTP transport error, etc.).
 */
import nodemailer from 'nodemailer';
import { EmailClient } from '@azure/communication-email';
import { getVerifiedDomains, resolveAzureFromAddress } from './azureDomains';
import { decryptSecret } from './secrets';

export class EmailConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailConfigError';
  }
}

export class EmailSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailSendError';
  }
}

/** Subset of GlobalSettings we actually need to send a message. */
export interface ProviderSettings {
  activeProvider?: string | null;
  azureConnString?: string | null;
  azureSenderDomain?: string | null;
  azureSenderDomains?: unknown;
  smtpHost?: string | null;
  smtpPort?: number | null;
  smtpUser?: string | null;
  smtpPass?: string | null;
}

/** Subset of SenderAccount we actually need; works with both Prisma rows and ad-hoc objects. */
export interface SenderInput {
  emailAddress: string;
  replyTo?: string | null;
  name?: string | null;
  smtpHost?: string | null;
  smtpPort?: number | null;
  smtpUser?: string | null;
  smtpPass?: string | null;
}

export interface MessageInput {
  to: string;
  subject: string;
  /** Raw body. Tracking pixel / link rewriting is applied by the caller. */
  body: string;
  isHtml: boolean;
  sender: SenderInput;
  /** Overrides the SMTP "From" display name (Azure ignores this field). */
  fromName?: string;
  /** When false, disables Azure user-engagement tracking. Defaults to true. */
  trackOpens?: boolean;
}

export interface SendResult {
  /** Provider-supplied message ID. Null for MOCK and the rare provider that
   *  acknowledges without returning an ID. */
  providerMessageId: string | null;
}

export async function sendMessage(
  input: MessageInput,
  settings: ProviderSettings | null | undefined
): Promise<SendResult> {
  const provider = settings?.activeProvider || 'MOCK';
  const { to, subject, body, isHtml, sender, trackOpens = true } = input;

  if (provider === 'MOCK') {
    console.log(`[EmailProvider/Mock] From: ${sender.emailAddress} → To: ${to} | Subject: ${subject}`);
    return { providerMessageId: null };
  }

  if (provider === 'AZURE') {
    return sendViaAzure({ to, subject, body, isHtml, sender, trackOpens }, settings!);
  }

  // SMTP / GOOGLE / MICROSOFT all use nodemailer with the same shape.
  return sendViaSmtp({ to, subject, body, isHtml, sender, fromName: input.fromName }, settings!);
}

async function sendViaAzure(
  input: { to: string; subject: string; body: string; isHtml: boolean; sender: SenderInput; trackOpens: boolean },
  settings: ProviderSettings
): Promise<SendResult> {
  const connString = decryptSecret(settings.azureConnString);
  if (!connString || getVerifiedDomains(settings).length === 0) {
    throw new EmailConfigError(
      'Azure Communication Services connection string or verified sender domains are not configured.'
    );
  }

  let fromAddress: string;
  try {
    fromAddress = resolveAzureFromAddress(input.sender.emailAddress, settings);
  } catch (err: any) {
    // Unverified-domain errors are config issues, not send-time failures.
    throw new EmailConfigError(err.message || 'Invalid Azure sender address.');
  }

  const emailClient = new EmailClient(connString);

  const message = {
    senderAddress: fromAddress,
    content: input.isHtml
      ? { subject: input.subject, html: input.body }
      : { subject: input.subject, plainText: input.body },
    recipients: { to: [{ address: input.to }] },
    replyTo: [{ address: input.sender.replyTo || input.sender.emailAddress }],
    userEngagementTrackingDisabled: !input.trackOpens,
  };

  let result: any;
  try {
    const poller = await emailClient.beginSend(message);
    result = await poller.pollUntilDone();
  } catch (err: any) {
    throw new EmailSendError(err?.message || 'Azure Communication Services failed to send email.');
  }

  if (result && result.status === 'Failed') {
    throw new EmailSendError(result.error?.message || 'Azure Communication Services reported send status: Failed.');
  }

  const providerMessageId: string | null = result?.id || null;
  console.log(`[EmailProvider/Azure Success] Message ID: ${providerMessageId} | From: ${fromAddress} → To: ${input.to}`);
  return { providerMessageId };
}

async function sendViaSmtp(
  input: { to: string; subject: string; body: string; isHtml: boolean; sender: SenderInput; fromName?: string },
  settings: ProviderSettings
): Promise<SendResult> {
  // Prefer per-sender SMTP credentials; fall back to global.
  let smtpHost = settings.smtpHost;
  let smtpPort = settings.smtpPort || 587;
  let smtpUser = settings.smtpUser;
  let smtpPass = decryptSecret(settings.smtpPass);

  const s = input.sender;
  if (s.smtpHost && s.smtpUser && s.smtpPass) {
    smtpHost = s.smtpHost;
    smtpPort = s.smtpPort || 587;
    smtpUser = s.smtpUser;
    smtpPass = decryptSecret(s.smtpPass);
  }

  if (!smtpHost || !smtpUser || !smtpPass) {
    throw new EmailConfigError('SMTP credentials are missing.');
  }

  const portNum = Number(smtpPort) || 587;
  const transport = nodemailer.createTransport({
    host: smtpHost,
    port: portNum,
    secure: portNum === 465,
    auth: { user: smtpUser, pass: smtpPass },
  });

  const fromName = input.fromName || s.name || 'ArcReach Sender';
  const mailOptions: any = {
    from: `"${fromName}" <${smtpUser}>`,
    to: input.to,
    replyTo: s.replyTo || s.emailAddress,
    subject: input.subject,
  };
  if (input.isHtml) mailOptions.html = input.body;
  else mailOptions.text = input.body;

  let info: any;
  try {
    info = await transport.sendMail(mailOptions);
  } catch (err: any) {
    throw new EmailSendError(err?.message || 'SMTP transport failed to send email.');
  }

  const providerMessageId: string | null = info?.messageId || null;
  console.log(`[EmailProvider/SMTP Success] Message ID: ${providerMessageId} | From: ${smtpUser} → To: ${input.to}`);
  return { providerMessageId };
}
