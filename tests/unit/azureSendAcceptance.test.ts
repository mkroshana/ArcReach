import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

/**
 * Drives the real ACS SDK against a local stub of the Email REST API, so the
 * tests see what really goes over the wire: how many times the send is POSTed,
 * its Operation-Id header, and the status polls that follow. The only change
 * to the SDK is allowing plain HTTP to reach the stub.
 */
const sdk = vi.hoisted(() => ({ clientOptions: [] as unknown[] }));

vi.mock('@azure/communication-email', async (importOriginal) => {
  const real = await importOriginal<typeof import('@azure/communication-email')>();
  class EmailClient extends real.EmailClient {
    constructor(connectionString: string, options: Record<string, unknown> = {}) {
      sdk.clientOptions.push(options);
      super(connectionString, { ...options, allowInsecureConnection: true });
    }
  }
  return { ...real, EmailClient };
});

import { sendMessage, getAzureSendStatus, EmailSendError } from '../../lib/emailProvider';
import { encryptSecret } from '../../lib/secrets';
import { replyThreadingHeaders } from '../../lib/replyThreading';

const OPERATION_ID = '5b0e7a52-3c1d-4d8e-9f10-2a3b4c5d6e7f';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACCESS_KEY = Buffer.from('k'.repeat(32)).toString('base64');

type Reply = { status: number; body: unknown } | 'drop' | 'hang';
type Hit = { method: string; path: string; operationId: string | undefined };

let server: http.Server;
let baseUrl: string;
let hits: Hit[];
/** Full URL and Authorization header of each request, in the order received. */
let signed: Array<{ url: string; authorization: string | undefined }>;
/** Raw body of each request, in the order received. */
let bodies: string[];
/** Answers the Nth request (1-based) the stub receives. */
let reply: (method: string, n: number) => Reply;

beforeEach(async () => {
  sdk.clientOptions.length = 0;
  hits = [];
  signed = [];
  bodies = [];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString('utf8'));
      hits.push({
        method: req.method!,
        path: req.url!.split('?')[0],
        operationId: req.headers['operation-id'] as string | undefined,
      });
      signed.push({ url: req.url!, authorization: req.headers.authorization });
      const answer = reply(req.method!, hits.length);
      if (answer === 'drop') {
        req.socket.destroy();
        return;
      }
      if (answer === 'hang') return;
      const operationLocation = `${baseUrl}/emails/operations/${OPERATION_ID}?api-version=2025-09-01`;
      res.writeHead(answer.status, { 'content-type': 'application/json', 'operation-location': operationLocation });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  vi.restoreAllMocks();
});

const send = (operationId: string | undefined = OPERATION_ID) =>
  sendMessage(
    {
      to: 'lead@prospect.test', subject: 'Hello', body: 'Hi there', isHtml: false,
      sender: { emailAddress: 'one@acme.test' }, operationId,
    },
    {
      activeProvider: 'AZURE',
      azureConnString: encryptSecret(`endpoint=${baseUrl}/;accesskey=${ACCESS_KEY}`),
      azureSenderDomains: ['acme.test'],
    },
  );

const accepted: Reply = { status: 202, body: { id: OPERATION_ID, status: 'Running' } };
const status = (value: string, extra: Record<string, unknown> = {}): Reply => ({ status: 200, body: { id: OPERATION_ID, status: value, ...extra } });
const error = (code: number, errorCode: string, message: string): Reply => ({ status: code, body: { error: { code: errorCode, message } } });

describe('Azure send: one POST under the Operation-Id, and acceptance is final (H5)', () => {
  it('sends under the caller\'s operation id and returns the ACS id once the send succeeds', async () => {
    reply = (method) => (method === 'POST' ? accepted : status('Succeeded'));

    await expect(send()).resolves.toEqual({ providerMessageId: OPERATION_ID });
    expect(hits).toEqual([
      { method: 'POST', path: '/emails:send', operationId: OPERATION_ID },
      { method: 'GET', path: `/emails/operations/${OPERATION_ID}`, operationId: OPERATION_ID },
    ]);
  });

  it('generates an operation id when the caller has none', async () => {
    reply = (method) => (method === 'POST' ? accepted : status('Succeeded'));

    await send(undefined);

    expect(hits[0].operationId).toMatch(UUID);
  });

  it.each<[string, Reply, { statusCode?: number; code: string }]>([
    ['a 503', error(503, 'ServiceUnavailable', 'Service is down.'), { statusCode: 503, code: 'ServiceUnavailable' }],
    ['a 429', error(429, 'TooManyRequests', 'Slow down.'), { statusCode: 429, code: 'TooManyRequests' }],
    ['a dropped connection', 'drop', { code: 'ECONNRESET' }],
  ])('POSTs the send once, without SDK retries, when ACS answers with %s', async (_label, answer, details) => {
    reply = () => answer;

    const err = await send().catch((e) => e);

    expect(err).toBeInstanceOf(EmailSendError);
    expect(err).toMatchObject(details);
    expect(hits).toEqual([{ method: 'POST', path: '/emails:send', operationId: OPERATION_ID }]);
    expect(sdk.clientOptions).toEqual([{ retryOptions: { maxRetries: 0 } }]);
  });

  it('keeps the status code and error code of a refused POST', async () => {
    reply = () => error(401, 'Denied', 'Denied by the resource provider.');

    await expect(send()).rejects.toMatchObject({
      name: 'EmailSendError', message: 'Denied by the resource provider.', statusCode: 401, code: 'Denied',
    });
  });

  it('reports a send as sent when ACS accepted it but the status poll inside beginSend fails', async () => {
    reply = (method) => (method === 'POST' ? accepted : error(500, 'InternalError', 'Status lookup failed.'));

    await expect(send()).resolves.toEqual({ providerMessageId: OPERATION_ID });
    expect(hits.map((h) => h.method)).toEqual(['POST', 'GET']);
  });

  it('reports a send as sent when ACS accepted it but a later status poll is throttled', async () => {
    reply = (method, n) => (method === 'POST' ? accepted : n === 2 ? status('Running') : error(429, 'TooManyRequests', 'Slow down.'));

    await expect(send()).resolves.toEqual({ providerMessageId: OPERATION_ID });
    expect(hits.map((h) => h.method)).toEqual(['POST', 'GET', 'GET']);
  });

  it.each(['Failed', 'Canceled'])('reports a %s status as a provider rejection with its error code', async (value) => {
    reply = (method) =>
      method === 'POST' ? accepted : status(value, { error: { code: 'InvalidRecipient', message: 'Recipient address rejected.' } });

    await expect(send()).rejects.toMatchObject({
      name: 'EmailSendError', message: 'Recipient address rejected.', code: 'InvalidRecipient',
    });
    expect(hits.map((h) => h.method)).toEqual(['POST', 'GET']);
  });
});

describe('Azure send: ACS engagement tracking is always off (L5)', () => {
  it('asks ACS on the wire to skip its own pixel and link rewriting, since our own tracking is the only one', async () => {
    reply = (method) => (method === 'POST' ? accepted : status('Succeeded'));

    await send();

    const posted = JSON.parse(bodies[0]);
    expect(posted.userEngagementTrackingDisabled).toBe(true);
    expect(posted).not.toHaveProperty('disableUserEngagementTracking');
  });
});

describe('Azure send: message headers (H15, H16)', () => {
  const settings = () => ({
    activeProvider: 'AZURE',
    azureConnString: encryptSecret(`endpoint=${baseUrl}/;accesskey=${ACCESS_KEY}`),
    azureSenderDomains: ['acme.test'],
  });
  const message = { to: 'lead@prospect.test', subject: 'Hello', body: 'Hi there', isHtml: false, sender: { emailAddress: 'one@acme.test' } };

  it('sends the List-Unsubscribe headers a campaign send gives it on the wire', async () => {
    reply = (method) => (method === 'POST' ? accepted : status('Succeeded'));
    const headers = {
      'List-Unsubscribe': '<https://reach.acme.test/api/unsubscribe?token=abc>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    };

    await sendMessage({ ...message, operationId: OPERATION_ID, headers }, settings());

    expect(JSON.parse(bodies[0]).headers).toEqual(headers);
  });

  it('sends no headers object when the caller gives none', async () => {
    reply = (method) => (method === 'POST' ? accepted : status('Succeeded'));

    await sendMessage({ ...message, operationId: OPERATION_ID }, settings());

    expect(JSON.parse(bodies[0])).not.toHaveProperty('headers');
  });

  it('sends the In-Reply-To and References a Unibox reply gives it, and none for an empty set (M58)', async () => {
    reply = (method) => (method === 'POST' ? accepted : status('Succeeded'));
    const headers = replyThreadingHeaders({ messageId: '<amy-2@acme.test>', references: '<acs-1@mail.test> <amy-1@acme.test>' });

    await sendMessage({ ...message, operationId: OPERATION_ID, headers }, settings());
    await sendMessage({ ...message, operationId: OPERATION_ID, headers: replyThreadingHeaders({ messageId: null, references: null }) }, settings());

    // The two POSTed messages; the status polls between them carry no body
    const posted = bodies.filter(Boolean).map((b) => JSON.parse(b));
    expect(posted).toHaveLength(2);
    expect(posted[0].headers).toEqual({
      'In-Reply-To': '<amy-2@acme.test>',
      References: '<acs-1@mail.test> <amy-1@acme.test> <amy-2@acme.test>',
    });
    expect(posted[1]).not.toHaveProperty('headers');
  });
});

describe('Azure send status lookup by operation id, for reconciling interrupted sends (H6)', () => {
  const statusOf = (timeoutMs?: number) =>
    getAzureSendStatus(
      OPERATION_ID,
      {
        activeProvider: 'AZURE',
        azureConnString: encryptSecret(`endpoint=${baseUrl}/;accesskey=${ACCESS_KEY}`),
        azureSenderDomains: ['acme.test'],
      },
      timeoutMs,
    );

  it.each(['NotStarted', 'Running', 'Succeeded'])('reads %s with one signed, versioned GET of the operation', async (value) => {
    reply = () => status(value);

    await expect(statusOf()).resolves.toEqual({ status: value });
    expect(hits.map((h) => [h.method, h.path])).toEqual([['GET', `/emails/operations/${OPERATION_ID}`]]);
    expect(signed[0].url).toMatch(/[?&]api-version=\d{4}-\d{2}-\d{2}/);
    expect(signed[0].authorization).toMatch(/^HMAC-SHA256 SignedHeaders=.+&Signature=.+/);
  });

  it.each(['Failed', 'Canceled'])('reads %s with the error ACS gives', async (value) => {
    reply = () => status(value, { error: { code: 'InvalidRecipient', message: 'Recipient address rejected.' } });

    await expect(statusOf()).resolves.toMatchObject({
      status: value, error: { code: 'InvalidRecipient', message: 'Recipient address rejected.' },
    });
  });

  it('reports NotFound when ACS has no operation under the id', async () => {
    reply = () => error(404, 'NotFound', 'Operation not found.');

    await expect(statusOf()).resolves.toEqual({ status: 'NotFound' });
  });

  it.each<[string, Reply]>([
    ['a 500', error(500, 'InternalError', 'Status lookup failed.')],
    ['a 429', error(429, 'TooManyRequests', 'Slow down.')],
    ['a 401', error(401, 'Denied', 'Denied by the resource provider.')],
    ['a dropped connection', 'drop'],
    ['an unrecognised status', status('Queued')],
  ])('throws on %s after one request, so the dispatch is left for the next pass', async (_label, answer) => {
    reply = () => answer;

    await expect(statusOf()).rejects.toThrow();
    expect(hits).toHaveLength(1);
  });

  it('gives up when ACS does not answer within the timeout', async () => {
    reply = () => 'hang';

    await expect(statusOf(100)).rejects.toThrow();
    expect(hits).toHaveLength(1);
  });
});
