/**
 * Single entry point for outbound email delivery. Owns the AZURE / SMTP
 * branching that was previously duplicated across the send engine, campaign
 * run route, manual send, send-test, and unibox-reply routes.
 *
 * Throws:
 *   EmailConfigError — missing/invalid configuration, including an Azure
 *                      connection string that cannot be decrypted or parsed
 *                      (callers map to 4xx).
 *   EmailSendError   — the provider refused the message, never answered the
 *                      send, or reported it Failed (Azure status "Failed",
 *                      SMTP transport error, etc.). An Azure send ACS accepted
 *                      is never reported as an EmailSendError just because its
 *                      status could not be read afterwards.
 */
import { randomUUID } from 'crypto';
import nodemailer from 'nodemailer';
import { EmailClient, type EmailMessage, type EmailSendOptionalParams } from '@azure/communication-email';
import { getVerifiedDomains, resolveAzureFromAddress } from './azureDomains';
import { decryptSecret } from './secrets';

export class EmailConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailConfigError';
  }
}

export class EmailSendError extends Error {
  /** HTTP status the provider answered with, when it answered at all. */
  statusCode?: number;
  /** Provider error code (e.g. "TooManyRequests") or network code (e.g. "ECONNRESET"). */
  code?: string;
  constructor(message: string, details: { statusCode?: number; code?: string } = {}) {
    super(message);
    this.name = 'EmailSendError';
    this.statusCode = details.statusCode;
    this.code = details.code;
  }
}

// Reuse one EmailClient per connection string. Azure SDK clients hold HTTP
// pipelines/keep-alive sockets and are designed to be long-lived; constructing
// one per message churned memory in the always-on worker process.
const azureClientCache = new Map<string, EmailClient>();
function getAzureClient(connString: string): EmailClient {
  let client = azureClientCache.get(connString);
  if (!client) {
    // No SDK retries. The pipeline would re-POST the send after a 5xx, 429 or
    // dropped connection, and a POST whose response was lost may already have
    // queued the email, so a retry can send it twice. A failed send is retried
    // by the send engine instead, as a new dispatch.
    client = new EmailClient(connString, { retryOptions: { maxRetries: 0 } });
    azureClientCache.clear(); // at most one active config; drop stale entries
    azureClientCache.set(connString, client);
  }
  return client;
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
  /** Internal label. Only the SMTP path uses it as the From name; ACS takes the
   *  From name from the sender username configured in Azure. */
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
  /**
   * ACS Operation-Id (a UUID) to send under. Callers that record a dispatch
   * store it there before sending; one is generated when omitted.
   */
  operationId?: string;
  /** Extra message headers, e.g. List-Unsubscribe on campaign sends. */
  headers?: Record<string, string>;
}

export interface SendResult {
  /** Provider-supplied message ID. Null for the rare provider that
   *  acknowledges without returning an ID. */
  providerMessageId: string | null;
}

const SENDING_DISABLED_MESSAGE =
  'Sending is disabled. An admin must select Azure Communication Services as the delivery provider in Settings.';

/**
 * Azure Communication Services is the only sanctioned provider. Returns why
 * sending is refused (no settings row, any other provider, or ACS missing its
 * connection string or verified domains), or null when ACS can send. Callers
 * check this before recording dispatches or moving enrollments, so nothing is
 * marked sent while sending is disabled.
 */
export function sendingDisabledReason(settings: ProviderSettings | null | undefined): string | null {
  if (settings?.activeProvider !== 'AZURE') return SENDING_DISABLED_MESSAGE;
  if (!settings.azureConnString || getVerifiedDomains(settings).length === 0) {
    return 'Sending is disabled. An admin must save the Azure Communication Services connection string and at least one verified sender domain in Settings.';
  }
  return null;
}

/**
 * Why the saved settings cannot send through ACS, checked without calling
 * Azure: sendingDisabledReason, then whether the connection string decrypts
 * and the SDK accepts its format. Null means the settings are complete, not
 * that Azure accepts the access key; only a send shows that.
 */
export function azureSettingsProblem(settings: ProviderSettings | null | undefined): string | null {
  const disabled = sendingDisabledReason(settings);
  if (disabled) return disabled;

  let connString: string | null | undefined;
  try {
    connString = decryptSecret(settings!.azureConnString);
  } catch {
    return 'The saved Azure Communication Services connection string could not be decrypted. SECRETS_KEY may have changed since it was saved; an admin must save it again in Settings.';
  }
  const invalid = 'The saved Azure Communication Services connection string is not valid; an admin must save it again in Settings.';
  if (!connString) return invalid;
  try {
    getAzureClient(connString);
  } catch {
    // The SDK's error echoes the string, access key included, so it is not kept.
    return invalid;
  }
  return null;
}

export async function sendMessage(
  input: MessageInput,
  settings: ProviderSettings | null | undefined
): Promise<SendResult> {
  const provider = settings?.activeProvider;
  const { to, subject, body, isHtml, sender, headers } = input;

  if (provider === 'AZURE') {
    return sendViaAzure({ to, subject, body, isHtml, sender, headers, operationId: input.operationId }, settings!);
  }

  // SMTP / GOOGLE / MICROSOFT all use nodemailer with the same shape.
  if (provider === 'SMTP' || provider === 'GOOGLE' || provider === 'MICROSOFT') {
    return sendViaSmtp({ to, subject, body, isHtml, sender, headers, fromName: input.fromName }, settings!);
  }

  // No settings row, DISABLED, or the retired MOCK value: nothing is sent, so
  // never report success.
  throw new EmailConfigError(SENDING_DISABLED_MESSAGE);
}

async function sendViaAzure(
  input: {
    to: string; subject: string; body: string; isHtml: boolean; sender: SenderInput; headers?: Record<string, string>; operationId?: string;
  },
  settings: ProviderSettings
): Promise<SendResult> {
  let connString: string | null | undefined;
  try {
    connString = decryptSecret(settings.azureConnString);
  } catch (err: any) {
    // A connection string that cannot be decrypted fails every send the same
    // way until it is saved again, so it is a config issue.
    throw new EmailConfigError(
      `The saved Azure Communication Services connection string could not be decrypted (${err?.message || err}). ` +
        'SECRETS_KEY may have changed since it was saved; an admin must save it again in Settings.'
    );
  }
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

  let emailClient: EmailClient;
  try {
    emailClient = getAzureClient(connString);
  } catch {
    // The SDK refuses a connection string it cannot parse (only the key, an
    // endpoint with a path, ...), so every send fails until it is saved again.
    // Its error echoes the string, access key included, so it is not kept.
    throw new EmailConfigError(
      'The saved Azure Communication Services connection string is not valid; an admin must save it again in Settings.'
    );
  }

  const message: EmailMessage = {
    senderAddress: fromAddress,
    content: input.isHtml
      ? { subject: input.subject, html: input.body }
      : { subject: input.subject, plainText: input.body },
    recipients: { to: [{ address: input.to }] },
    // Opens and clicks are tracked only by our own pixel and link rewriting,
    // so ACS must never add its pixel or rewrite links, whatever the resource
    // setting or the campaign's Track Opens.
    disableUserEngagementTracking: true,
  };
  if (input.headers && Object.keys(input.headers).length > 0) {
    message.headers = input.headers;
  }

  // Only set Reply-To when one is explicitly configured; otherwise omit the
  // header so replies go to the From address by default.
  const replyTo = input.sender.replyTo?.trim();
  if (replyTo) {
    message.replyTo = [{ address: replyTo }];
  }

  const operationId = input.operationId ?? randomUUID();

  // beginSend POSTs the send and then polls its status once, so its rejecting
  // doesn't mean the email wasn't queued. The raw responses say what ACS did:
  // whether it accepted the POST, and whether it reported the send Failed or
  // Canceled.
  let accepted = false;
  let refusal = null as { code?: string; message: string } | null;
  const onResponse: NonNullable<EmailSendOptionalParams['onResponse']> = (raw) => {
    if (raw.request.method === 'POST' && raw.status >= 200 && raw.status < 300) accepted = true;
    const body = raw.parsedBody;
    const status = typeof body?.status === 'string' ? body.status.toLowerCase() : '';
    if (status === 'failed' || status === 'canceled') {
      refusal = {
        code: body.error?.code,
        message: body.error?.message || `Azure Communication Services reported send status: ${body.status}.`,
      };
    }
  };

  let result: any;
  try {
    const poller = await emailClient.beginSend(message, { operationId, onResponse });
    accepted = true; // beginSend resolves only once the POST was accepted
    result = await poller.pollUntilDone();
  } catch (err: any) {
    if (!accepted) {
      // ACS refused the POST, or no answer to it arrived: report it not sent.
      throw new EmailSendError(err?.message || 'Azure Communication Services failed to send email.', {
        statusCode: err?.statusCode,
        code: err?.code,
      });
    }
    if (refusal) {
      throw new EmailSendError(refusal.message, { code: refusal.code });
    }
    // Accepted, but a status poll failed (throttled, reset, timed out). The
    // email is queued, so it counts as sent; the delivery webhook reports how
    // it ends under the operation id, which ACS also uses as the message id.
    console.warn(
      `[EmailProvider/Azure] Accepted as operation ${operationId}, final status unknown: ${err?.message || err} | To: ${input.to}`
    );
    return { providerMessageId: operationId };
  }

  if (result && result.status === 'Failed') {
    throw new EmailSendError(result.error?.message || 'Azure Communication Services reported send status: Failed.', {
      code: result.error?.code,
    });
  }

  const providerMessageId: string | null = result?.id || null;
  console.log(`[EmailProvider/Azure Success] Message ID: ${providerMessageId} | From: ${fromAddress} → To: ${input.to}`);
  return { providerMessageId };
}

const AZURE_SEND_STATUSES = ['NotStarted', 'Running', 'Succeeded', 'Failed', 'Canceled'] as const;

/** What ACS reports for a send operation, or NotFound when it has no operation under that id. */
export interface AzureSendStatus {
  status: (typeof AZURE_SEND_STATUSES)[number] | 'NotFound';
  error?: { code?: string; message?: string };
}

type GetSendResult = (
  operationId: string,
  options?: { abortSignal?: AbortSignal }
) => Promise<{ status?: string; error?: { code?: string; message?: string } }>;

/**
 * Asks ACS for the status of the send made under `operationId` (GET
 * /emails/operations/{operationId}). EmailClient only exposes beginSend, so
 * this calls the getSendResult of the SDK's own generated client, which signs
 * and versions the request exactly as the send was. Throws when ACS gives no
 * usable answer: no response, a timeout, or any status other than 200 or 404.
 */
export async function getAzureSendStatus(
  operationId: string,
  settings: ProviderSettings,
  timeoutMs = 10_000
): Promise<AzureSendStatus> {
  const connString = decryptSecret(settings.azureConnString);
  if (!connString) {
    throw new EmailConfigError('Azure Communication Services connection string is not configured.');
  }

  const email = (getAzureClient(connString) as unknown as { generatedClient?: { email?: { getSendResult?: GetSendResult } } })
    .generatedClient?.email;
  if (typeof email?.getSendResult !== 'function') {
    throw new Error('This version of @azure/communication-email has no getSendResult; send status cannot be read.');
  }

  let result: Awaited<ReturnType<GetSendResult>>;
  try {
    result = await email.getSendResult(operationId, { abortSignal: AbortSignal.timeout(timeoutMs) });
  } catch (err: any) {
    // ACS has no operation under this id: it never received the send.
    if (err?.statusCode === 404) return { status: 'NotFound' };
    throw err;
  }

  const status = AZURE_SEND_STATUSES.find((known) => known.toLowerCase() === String(result?.status).toLowerCase());
  if (!status) {
    throw new Error(`Azure Communication Services reported an unrecognised send status: ${result?.status}.`);
  }
  return { status, error: result.error };
}

async function sendViaSmtp(
  input: {
    to: string; subject: string; body: string; isHtml: boolean; sender: SenderInput; headers?: Record<string, string>; fromName?: string;
  },
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
    subject: input.subject,
  };
  // Only set Reply-To when one is explicitly configured; otherwise omit it so
  // replies go to the From address by default.
  const replyTo = s.replyTo?.trim();
  if (replyTo) mailOptions.replyTo = replyTo;
  if (input.headers) mailOptions.headers = input.headers;
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
