import net from 'net';
import tls from 'tls';
import { createHash } from 'crypto';
import { prisma } from './db';
import { decodeCharset, decodeMimeHeader } from './mime';
import { decryptSecret } from './secrets';
import { leadEmailIn, normalizeEmail } from './leadEmail';

interface ImapMessage {
  from: string;
  subject: string;
  date: Date;
  messageId: string;
  inReplyTo?: string;
  references?: string;
  body: string;
}

// Mailboxes syncing in this process. Kept on globalThis because the worker
// (instrumentation) and the Unibox route are separate bundles, each with its own
// copy of this module, and both sync the same mailboxes.
const globalForImap = globalThis as unknown as { imapActiveSyncs: Set<string> | undefined };
const activeSyncs = (globalForImap.imapActiveSyncs ??= new Set<string>());

/** Most new INBOX messages one sync reads, oldest first; the rest wait for the next sync. */
export const IMAP_SYNC_BATCH_SIZE = 200;

/** A mailbox without a checkpoint (first sync, or the server reset UIDVALIDITY) starts with mail received in this many days. */
export const IMAP_FIRST_SYNC_LOOKBACK_DAYS = 7;

const IMAP_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** RFC 3501 SEARCH date (d-Mon-yyyy) of the UTC day of `d`. */
export function imapSearchDate(d: Date): string {
  return `${d.getUTCDate()}-${IMAP_MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

/**
 * The UID SEARCH listing INBOX messages the sync has not read. The saved UID is
 * only meaningful while the INBOX keeps the UIDVALIDITY it was saved under, so a
 * missing or stale checkpoint falls back to mail from the lookback window.
 */
export function replySearchPlan(
  checkpoint: { imapUidValidity: number | null; imapLastUid: number | null },
  uidValidity: number,
  now: Date
): { cmd: string; afterUid: number; resumed: boolean } {
  if (checkpoint.imapUidValidity === uidValidity && checkpoint.imapLastUid !== null) {
    const afterUid = checkpoint.imapLastUid;
    return { cmd: `UID SEARCH UID ${afterUid + 1}:*`, afterUid, resumed: true };
  }
  const since = new Date(now.getTime() - IMAP_FIRST_SYNC_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  return { cmd: `UID SEARCH SINCE ${imapSearchDate(since)}`, afterUid: 0, resumed: false };
}

/** UIDs listed by the untagged SEARCH responses in `resp`. */
export function parseSearchUids(resp: string): number[] {
  const uids: number[] = [];
  for (const match of resp.matchAll(/^\* SEARCH([ \d]*)/gim)) {
    for (const n of match[1].trim().split(/\s+/)) {
      if (n) uids.push(Number(n));
    }
  }
  return uids;
}

/** `d` when Postgres can store it as a reply's receivedAt (years 1970-9999), else null; an Invalid Date is null. */
function storableDate(d: Date): Date | null {
  const t = d.getTime();
  return t >= 0 && t < Date.UTC(10000, 0, 1) ? d : null;
}

/** An RFC 3501 INTERNALDATE such as "17-Jul-1996 02:44:25 -0700" (the day may be space-padded), or null. */
export function parseInternalDate(value: string | null | undefined): Date | null {
  const m = value?.match(/^\s*(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})\s*$/);
  if (!m) return null;
  const month = IMAP_MONTHS.findIndex(name => name.toLowerCase() === m[2].toLowerCase());
  if (month === -1) return null;
  const offsetMinutes = (m[7] === '-' ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9]));
  const utc = Date.UTC(Number(m[3]), month, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6]));
  return storableDate(new Date(utc - offsetMinutes * 60_000));
}

/**
 * When a reply was received: its Date header, else the server's INTERNALDATE, else
 * `now`. A missing, unparseable or out-of-range Date never reaches the database,
 * where it would fail the write and stop the mailbox's sync at that message.
 */
export function replyReceivedAt(dateHeader: string, internalDate: string | null | undefined, now: Date = new Date()): Date {
  return (dateHeader ? storableDate(new Date(dateHeader)) : null) ?? parseInternalDate(internalDate) ?? now;
}

/** Longest Message-ID stored as it is; a longer one is stored hashed so it fits the unique index. */
const MESSAGE_ID_MAX_CHARS = 255;

/**
 * The key a reply is recorded under, unique per mailbox: its Message-ID (the <...>
 * token when there is one), hashed when long or not printable ASCII, or for a
 * message without one a stand-in from the INBOX UIDVALIDITY and UID. Stand-ins
 * hold a space, which a Message-ID stored as it is never does, so they can't collide.
 */
export function replyDedupeKey(messageIdHeader: string, uidValidity: number, uid: number): string {
  const id = messageIdHeader.match(/<[^<>\s]+>/)?.[0] ?? messageIdHeader.trim();
  if (!id) return `uid ${uidValidity} ${uid}`;
  if (id.length <= MESSAGE_ID_MAX_CHARS && /^[!-~]+$/.test(id)) return id;
  return `sha256 ${createHash('sha256').update(octets(id)).digest('hex')}`;
}

/**
 * Log-safe form of an outgoing IMAP command: tag and verb only. Arguments are
 * never logged because LOGIN carries the decrypted mailbox password.
 */
export function describeImapCommand(tag: string, cmd: string): string {
  const verb = cmd.trim().split(/\s+/)[0] || '';
  return `${tag} ${verb}`;
}

/**
 * IMAP LOGIN as the lines the client sends: the first after the tag, each later one
 * once the server answers the literal announced at the end of the previous line with
 * a "+" continuation request. User and password go as quoted strings with backslash
 * and double quote escaped, or as literals when they hold characters a quoted string
 * can't carry (non-ASCII, CR or LF).
 */
export function imapLoginLines(user: string, pass: string): string[] {
  const lines = ['LOGIN'];
  for (const value of [user, pass]) {
    if (/^[\x01-\x09\x0b\x0c\x0e-\x7f]*$/.test(value)) {
      lines[lines.length - 1] += ` "${value.replace(/[\\"]/g, '\\$&')}"`;
    } else {
      lines[lines.length - 1] += ` {${Buffer.byteLength(value, 'utf8')}}`;
      lines.push(value);
    }
  }
  return lines;
}

/**
 * TLS options for the IMAP connection. LOGIN sends the mailbox password, so the
 * server certificate is verified for the host (also sent as SNI unless it is an
 * IP address) unless the mailbox opted in to a self-signed certificate.
 */
export function imapTlsOptions(host: string, port: number, allowSelfSigned: boolean): tls.ConnectionOptions {
  return {
    host,
    port,
    servername: net.isIP(host) ? undefined : host,
    rejectUnauthorized: !allowSelfSigned,
  };
}

/**
 * Save the reply-sync checkpoint. The worker and a Unibox load can sync the same
 * mailbox at once, so a save never moves the UID back under the same UIDVALIDITY.
 */
async function saveImapCheckpoint(mailboxId: string, uidValidity: number, lastUid: number) {
  await prisma.senderAccount.updateMany({
    where: {
      id: mailboxId,
      OR: [
        { imapUidValidity: null },
        { imapUidValidity: { not: uidValidity } },
        { imapLastUid: null },
        { imapLastUid: { lt: lastUid } },
      ],
    },
    data: { imapUidValidity: uidValidity, imapLastUid: lastUid },
  });
}

export async function syncMailboxReplies(mailboxId: string) {
  if (activeSyncs.has(mailboxId)) {
    console.log(`[IMAP Sync] Sync for mailbox ${mailboxId} is already in progress. Skipping.`);
    return { success: false, reason: 'Already syncing' };
  }
  
  activeSyncs.add(mailboxId);
  
  try {
    const mailbox = await prisma.senderAccount.findUnique({
      where: { id: mailboxId }
    });
    
    if (!mailbox || !mailbox.imapHost || !mailbox.imapPort || !mailbox.imapUser || !mailbox.imapPass) {
      console.log(`[IMAP Sync] Mailbox ${mailboxId} is not configured with IMAP credentials.`);
      return { success: false, reason: 'Not configured' };
    }
    
    console.log(`[IMAP Sync] Syncing replies for ${mailbox.emailAddress} using ${mailbox.imapHost}:${mailbox.imapPort}`);
    if (mailbox.imapAllowSelfSigned) {
      console.warn(`[IMAP Sync] Certificate verification is off for ${mailbox.emailAddress} (Allow Self-Signed Certificate).`);
    }
    
    // Where this sync leaves the checkpoint, known once the IMAP exchange has run.
    const batch: { uidValidity: number | null; lastUid: number | null; complete: boolean } = {
      uidValidity: null,
      lastUid: null,
      complete: false,
    };
    
    let socket: tls.TLSSocket | null = null;
    try {
      const messages = await new Promise<ImapMessage[]>((resolve, reject) => {
        socket = tls.connect(imapTlsOptions(mailbox.imapHost!, mailbox.imapPort!, mailbox.imapAllowSelfSigned), () => {
          console.log('[IMAP Sync] Connected via TLS.');
        });
        
        socket!.setTimeout(15000); // 15s timeout
        
        let initialResponseReceived = false;
        let buffer = '';
        
        // `continuation`: lines sent after each "+" continuation request, carrying literals
        const commandsQueue: { tag: string; cmd: string; continuation?: string[]; handler: (resp: string) => void | Promise<void> }[] = [];
        let currentCommandIdx = -1;
        let continuationsSent = 0;
        const fetchedMessages: ImapMessage[] = [];
        
        const makeTag = (prefix: string) => `${prefix}_${Math.random().toString(36).substring(2, 8)}`;
        
        const tagLogin = makeTag('A1_LOGIN');
        const tagExamine = makeTag('A2_EXAMINE');
        const tagSearch = makeTag('A3_SEARCH');
        
        const executeNext = () => {
          currentCommandIdx++;
          continuationsSent = 0;
          if (currentCommandIdx < commandsQueue.length) {
            const item = commandsQueue[currentCommandIdx];
            console.log(`[IMAP Sync] Sending: ${describeImapCommand(item.tag, item.cmd)}`);
            socket!.write(`${item.tag} ${item.cmd}\r\n`);
          } else {
            // Finished all commands, close connection
            batch.complete = true;
            const tagLogout = makeTag('A_LOGOUT');
            socket!.write(`${tagLogout} LOGOUT\r\n`);
            socket!.end();
            resolve(fetchedMessages);
          }
        };
        
        socket!.on('data', (chunk) => {
          // One char per octet: FETCH literal lengths count octets, and a UTF-8 character
          // split across chunks survives until the text is decoded with its charset
          buffer += chunk.toString('latin1');
          
          if (!initialResponseReceived) {
            if (buffer.includes('\r\n')) {
              initialResponseReceived = true;
              buffer = '';
              executeNext();
            }
            return;
          }
          
          if (currentCommandIdx >= 0 && currentCommandIdx < commandsQueue.length) {
            const item = commandsQueue[currentCommandIdx];
            
            // "+" asks for the literal announced at the end of the last line sent
            const pendingLines = item.continuation ?? [];
            const continuationRequest = continuationsSent < pendingLines.length ? /(?:^|\n)(\+[^\n]*\n)/.exec(buffer) : null;
            if (continuationRequest) {
              const start = continuationRequest.index + continuationRequest[0].length - continuationRequest[1].length;
              buffer = buffer.substring(0, start) + buffer.substring(start + continuationRequest[1].length);
              socket!.write(`${pendingLines[continuationsSent++]}\r\n`);
            }
            
            const tagPattern = `${item.tag} `;
            const tagIdx = buffer.indexOf(tagPattern);
            
            if (tagIdx !== -1) {
              const lineEndIdx = buffer.indexOf('\n', tagIdx + tagPattern.length);
              if (lineEndIdx !== -1) {
                const completionLineEnd = lineEndIdx + 1;
                const responseStr = buffer.substring(0, completionLineEnd);
                buffer = buffer.substring(completionLineEnd);
                
                Promise.resolve(item.handler(responseStr))
                  .then(() => {
                    executeNext();
                  })
                  .catch((err) => {
                    console.error(`[IMAP Sync] Error in command ${item.tag} handler:`, err);
                    socket!.destroy();
                    reject(err);
                  });
              }
            }
          }
        });
        
        socket!.on('timeout', () => {
          console.log('[IMAP Sync] Timeout reached.');
          socket!.destroy();
          reject(new Error('IMAP connection timed out'));
        });
        
        socket!.on('error', (err) => {
          console.error('[IMAP Sync] Socket error:', err);
          reject(err);
        });
        
        socket!.on('close', () => {
          console.log('[IMAP Sync] Connection closed.');
          resolve(fetchedMessages);
        });
        
        // Build commands queue
        // 1. LOGIN — decrypt stored password just-in-time for the protocol command.
        const imapPassPlain = decryptSecret(mailbox.imapPass) || '';
        const [loginCmd, ...loginContinuation] = imapLoginLines(mailbox.imapUser!, imapPassPlain);
        commandsQueue.push({
          tag: tagLogin,
          cmd: loginCmd,
          continuation: loginContinuation,
          handler: (resp) => {
            if (!resp.includes(`${tagLogin} OK`)) {
              throw new Error('IMAP Login failed: ' + resp);
            }
          }
        });
        
        // Reply-sync checkpoint state, set once EXAMINE reports the INBOX's UIDVALIDITY
        let afterUid = 0;
        let resumed = false;
        let uidNext: number | null = null;
        // Nothing to read without a checkpoint: start one at the newest message.
        const checkpointAtNewest = () => {
          if (!resumed && uidNext !== null) batch.lastUid = uidNext - 1;
        };
        
        // 2. EXAMINE INBOX: read-only, so the sync never changes flags on the user's mail
        commandsQueue.push({
          tag: tagExamine,
          cmd: 'EXAMINE INBOX',
          handler: (resp) => {
            if (!resp.includes(`${tagExamine} OK`)) {
              throw new Error('IMAP EXAMINE failed: ' + resp);
            }
            const validityMatch = resp.match(/\[UIDVALIDITY (\d+)\]/i);
            if (!validityMatch) {
              throw new Error('IMAP EXAMINE returned no UIDVALIDITY: ' + resp);
            }
            batch.uidValidity = Number(validityMatch[1]);
            const uidNextMatch = resp.match(/\[UIDNEXT (\d+)\]/i);
            uidNext = uidNextMatch ? Number(uidNextMatch[1]) : null;
            
            const plan = replySearchPlan(mailbox, batch.uidValidity, new Date());
            afterUid = plan.afterUid;
            resumed = plan.resumed;
            
            // An empty INBOX has nothing to search, and some servers refuse "UID n:*" there
            const existsMatch = resp.match(/^\* (\d+) EXISTS/im);
            if (existsMatch && Number(existsMatch[1]) === 0) {
              checkpointAtNewest();
              return;
            }
            searchCommand.cmd = plan.cmd;
            commandsQueue.splice(currentCommandIdx + 1, 0, searchCommand);
          }
        });
        
        // 3. UID SEARCH for the messages after the checkpoint, queued by EXAMINE
        const searchCommand = {
          tag: tagSearch,
          cmd: '',
          handler: (resp: string) => {
            if (!resp.includes(`${tagSearch} OK`)) {
              throw new Error('IMAP SEARCH failed: ' + resp);
            }
            
            // "UID n:*" always lists the newest message, even when its UID is below n
            const uids = Array.from(new Set(parseSearchUids(resp)))
              .filter(uid => uid > afterUid)
              .sort((a, b) => a - b)
              .slice(0, IMAP_SYNC_BATCH_SIZE);
            if (uids.length === 0) {
              checkpointAtNewest();
              return;
            }
            batch.lastUid = uids[uids.length - 1];
            const tagFetchHeaders = makeTag('A4_FETCH_HEADERS');
            
            // Add header FETCH command dynamically. BODY.PEEK leaves the \Seen flag alone.
            // The content headers say how to decode the body fetched below, and
            // INTERNALDATE dates a reply whose Date header is missing or unreadable.
            commandsQueue.splice(currentCommandIdx + 1, 0, {
              tag: tagFetchHeaders,
              cmd: `UID FETCH ${uids.join(',')} (UID INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES CONTENT-TYPE CONTENT-TRANSFER-ENCODING)])`,
              handler: async (headerResp) => {
                if (!headerResp.includes(`${tagFetchHeaders} OK`)) {
                  throw new Error('IMAP Fetch headers failed: ' + headerResp);
                }
                const headerParsed = parseHeaderResponse(headerResp);
                if (headerParsed.length === 0) return;
                
                // Filter headers where the sender email matches an active Lead in our database, ignoring case
                const senderEmails = headerParsed.map(h => normalizeEmail(h.from));
                const matchedLeads = await prisma.lead.findMany({
                  where: leadEmailIn(senderEmails)
                });
                const matchedLeadEmails = new Set(matchedLeads.map(l => normalizeEmail(l.email)));
                
                // For each matching message, oldest first, queue a command to fetch its body
                const bodyCommands = headerParsed
                  .filter(msg => matchedLeadEmails.has(normalizeEmail(msg.from)))
                  .map(msg => {
                    const tagFetchBody = makeTag('A5_FETCH_BODY');
                    return {
                      tag: tagFetchBody,
                      cmd: `UID FETCH ${msg.uid} (BODY.PEEK[TEXT])`,
                      handler: (bodyResp: string) => {
                        if (!bodyResp.includes(`${tagFetchBody} OK`)) {
                          throw new Error('IMAP Fetch body failed: ' + bodyResp);
                        }
                        const bodyParsedText = parseBodyResponse(bodyResp);
                        fetchedMessages.push({
                          from: msg.from,
                          subject: msg.subject,
                          date: msg.date,
                          messageId: replyDedupeKey(msg.messageId, batch.uidValidity!, msg.uid),
                          inReplyTo: msg.inReplyTo,
                          references: msg.references,
                          // A message without Content-Type is text/plain (RFC 2045)
                          body: cleanMimeBody(bodyParsedText, msg.contentType || 'text/plain', msg.transferEncoding)
                        });
                      }
                    };
                  });
                commandsQueue.splice(currentCommandIdx + 1, 0, ...bodyCommands);
              }
            });
          }
        };
      });
      
      console.log(`[IMAP Sync] Fetched ${messages.length} messages from mail server.`);
      
      // Process messages and match with database Leads
      let newRepliesCount = 0;
      for (const msg of messages) {
        if (!msg.from) continue;
        
        const lead = await prisma.lead.findFirst({
          where: leadEmailIn([msg.from])
        });
        
        if (!lead) continue;
        
        // Replies recorded before Message-IDs were stored have none, so a message read
        // again (a mailbox's first sync reads the last 7 days) is matched to them as
        // before, by lead and a Date within 10 seconds.
        const timeWindowStart = new Date(msg.date.getTime() - 10000);
        const timeWindowEnd = new Date(msg.date.getTime() + 10000);
        
        const existing = await prisma.inboundResponse.findFirst({
          where: {
            leadId: lead.id,
            messageId: null,
            receivedAt: {
              gte: timeWindowStart,
              lte: timeWindowEnd
            }
          }
        });
        
        if (existing) continue;

        const activeEnrollments = await prisma.campaignEnrollment.findMany({
          where: {
            leadId: lead.id,
            status: 'Active'
          },
          include: {
            campaign: true
          }
        });

        // Resolve campaignId based on last sent campaign email or active enrollment
        const lastDispatch = await prisma.emailDispatch.findFirst({
          where: { leadId: lead.id, campaignId: { not: null } },
          orderBy: { sentAt: 'desc' }
        });
        const campaignId = lastDispatch?.campaignId || activeEnrollments[0]?.campaignId || null;
        
        // The Message-ID is unique per mailbox, so a message another sync already
        // recorded (one in another process, or an earlier read of this batch) is skipped.
        const { count } = await prisma.inboundResponse.createMany({
          data: {
            leadId: lead.id,
            campaignId,
            senderAccountId: mailbox.id,
            messageId: msg.messageId,
            subject: msg.subject || 'No Subject',
            body: msg.body || '',
            receivedAt: msg.date,
            unread: true
          },
          skipDuplicates: true
        });
        if (count === 0) continue;
        newRepliesCount++;
        
        for (const enrollment of activeEnrollments) {
          if (enrollment.campaign.stopOnReply) {
            await prisma.campaignEnrollment.update({
              where: { id: enrollment.id },
              data: { status: 'Paused' }
            });
            console.log(`[IMAP Sync] Paused enrollment for lead ${lead.email} in campaign ${enrollment.campaign.name} due to stopOnReply.`);
          }
        }
      }
      
      // Move the checkpoint only after every message of the batch was fetched and
      // recorded, so a dropped connection or a failed write reads the batch again.
      if (batch.complete && batch.uidValidity !== null && batch.lastUid !== null) {
        await saveImapCheckpoint(mailbox.id, batch.uidValidity, batch.lastUid);
      }
      
      console.log(`[IMAP Sync] Finished. Synced ${newRepliesCount} new replies.`);
      return { success: true, syncedCount: newRepliesCount };
    } catch (err: any) {
      console.error(`[IMAP Sync] Sync error for mailbox ${mailboxId}:`, err);
      if (socket) {
        try {
          (socket as any).destroy();
        } catch {}
      }
      return { success: false, error: err.message };
    }
  } finally {
    activeSyncs.delete(mailboxId);
  }
}

interface HeaderInfo {
  uid: number;
  from: string;
  subject: string;
  date: Date;
  messageId: string;
  inReplyTo: string;
  references: string;
  contentType: string;
  transferEncoding: string;
}

/** One untagged FETCH response: its UID and its data items by upper-case name. */
interface FetchData {
  uid: number | null;
  /** Section data such as BODY[TEXT] exactly as sent, one char per octet; null for NIL. */
  items: Map<string, string | null>;
}

/**
 * Bytes of a string read from the IMAP connection (one char per octet). Text that
 * was already decoded, so holds characters past U+00FF, is taken as UTF-8.
 */
function octets(str: string): Buffer {
  return Buffer.from(str, /[^\x00-\xff]/.test(str) ? 'utf8' : 'latin1');
}

/**
 * The untagged FETCH responses of a command response. A {N} literal is read as
 * exactly N octets, so header and body data never run into the rest of the
 * response (a later UID or FLAGS item, the closing parenthesis, the tagged OK).
 */
function readFetchResponses(resp: string): FetchData[] {
  const out: FetchData[] = [];
  let pos = 0;
  while (pos < resp.length) {
    // One response line, continued after each literal it announces. Literals are
    // replaced by NUL, which IMAP never sends outside a literal.
    let line = '';
    const literals: string[] = [];
    for (;;) {
      const eol = resp.indexOf('\r\n', pos);
      const segment = resp.substring(pos, eol === -1 ? resp.length : eol);
      pos = eol === -1 ? resp.length : eol + 2;
      const literal = eol === -1 ? null : segment.match(/\{(\d+)\+?\}$/);
      if (!literal || literal.index === undefined) {
        line += segment;
        break;
      }
      line += segment.substring(0, literal.index) + '\0';
      literals.push(resp.substring(pos, pos + Number(literal[1])));
      pos += Number(literal[1]);
    }

    const head = line.match(/^\* \d+ FETCH \(/i);
    if (!head) continue;
    const s = line.substring(head[0].length);
    let i = 0;
    let nextLiteral = 0;
    const skipSpaces = () => {
      while (s[i] === ' ') i++;
    };
    // An atom; a section such as BODY[HEADER.FIELDS (FROM DATE)] is one atom
    const readAtom = () => {
      const start = i;
      while (i < s.length && !' ()"\0'.includes(s[i])) {
        if (s[i] === '[') {
          const close = s.indexOf(']', i);
          i = close === -1 ? s.length : close + 1;
        } else {
          i++;
        }
      }
      return s.substring(start, i);
    };
    // A literal, quoted string, NIL, atom, or parenthesised list (read past, returned raw)
    const readValue = (): string | null => {
      skipSpaces();
      if (s[i] === '\0') {
        i++;
        return literals[nextLiteral++] ?? '';
      }
      if (s[i] === '"') {
        let value = '';
        for (i++; i < s.length && s[i] !== '"'; i++) {
          if (s[i] === '\\') i++;
          value += s[i] ?? '';
        }
        i++;
        return value;
      }
      if (s[i] === '(') {
        const start = i++;
        for (skipSpaces(); i < s.length && s[i] !== ')'; skipSpaces()) readValue();
        i++;
        return s.substring(start, i);
      }
      const atom = readAtom();
      return atom.toUpperCase() === 'NIL' ? null : atom;
    };

    const items = new Map<string, string | null>();
    for (skipSpaces(); i < s.length && s[i] !== ')'; skipSpaces()) {
      const name = readAtom().toUpperCase();
      if (!name) break;
      // BODY[TEXT]<0> is the partial form of BODY[TEXT]
      items.set(name.replace(/<\d+>$/, ''), readValue());
    }
    const uid = items.get('UID');
    out.push({ uid: uid && /^\d+$/.test(uid) ? Number(uid) : null, items });
  }
  return out;
}

/**
 * Header fields of a header block by lower-case name, first occurrence kept.
 * Folded lines are unfolded first, and a field name only matches at a line start.
 */
export function parseHeaderFields(block: string): Map<string, string> {
  const fields = new Map<string, string>();
  const unfolded = block.replace(/\r?\n(?=[ \t])/g, '');
  for (const line of unfolded.split(/\r?\n/)) {
    const field = line.match(/^([!-9;-~]+)[ \t]*:(.*)$/);
    if (!field) continue;
    const name = field[1].toLowerCase();
    if (!fields.has(name)) fields.set(name, field[2].trim());
  }
  return fields;
}

/**
 * The address of the first mailbox in an address header value, such as
 * `"Doe, Jane" <jane@acme.test>`, `=?UTF-8?B?...?= <jane@acme.test>` or
 * `jane@acme.test (Jane Doe)`. Quoted display names and comments may hold
 * '<', ',' or '@' and are never read as the address.
 */
export function parseMailboxAddress(value: string): string {
  let bare = '';
  let quoted = false;
  let commentDepth = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '\\' && (quoted || commentDepth > 0)) {
      if (quoted) bare += c + (value[i + 1] ?? '');
      i++;
    } else if (quoted) {
      bare += c;
      if (c === '"') quoted = false;
    } else if (commentDepth > 0) {
      if (c === '(') commentDepth++;
      else if (c === ')') commentDepth--;
    } else if (c === '(') {
      commentDepth = 1;
    } else if (c === '"') {
      quoted = true;
      bare += c;
    } else if (c === '<') {
      const end = value.indexOf('>', i);
      return value.substring(i + 1, end === -1 ? value.length : end).trim();
    } else if (c === ',') {
      break;
    } else {
      bare += c;
    }
  }
  // No angle brackets: the value is a bare address (a quoted local part stays)
  return bare.trim();
}

/** A header value as text, raw 8-bit bytes read as UTF-8 (else windows-1252). RFC 2047 words stay encoded. */
function headerText(value: string | undefined): string {
  return decodeCharset(octets(value ?? ''));
}

export function parseHeaderResponse(fetchResp: string): HeaderInfo[] {
  const result: HeaderInfo[] = [];

  for (const fetched of readFetchResponses(fetchResp)) {
    // Without a UID the body can't be fetched (an unsolicited flag update, say)
    if (fetched.uid === null) continue;
    const block = [...fetched.items].find(([name]) => name.startsWith('BODY[HEADER'))?.[1];
    if (!block) continue;

    const fields = parseHeaderFields(block);
    // The address is read before any RFC 2047 decoding, which could put '<' or ',' in the display name
    const fromEmail = parseMailboxAddress(headerText(fields.get('from')));
    if (!fromEmail.includes('@')) continue;

    result.push({
      uid: fetched.uid,
      from: fromEmail.toLowerCase(),
      subject: decodeMimeHeader(headerText(fields.get('subject'))),
      date: replyReceivedAt(fields.get('date') ?? '', fetched.items.get('INTERNALDATE')),
      messageId: fields.get('message-id') ?? '',
      inReplyTo: fields.get('in-reply-to') ?? '',
      references: (fields.get('references') ?? '').replace(/\s+/g, ' '),
      contentType: fields.get('content-type') ?? '',
      transferEncoding: fields.get('content-transfer-encoding') ?? ''
    });
  }

  return result;
}

/** The BODY[TEXT] data of a body FETCH response, exactly as sent (one char per octet), without the rest of the response. */
export function parseBodyResponse(fetchResp: string): string {
  for (const fetched of readFetchResponses(fetchResp)) {
    if (fetched.items.has('BODY[TEXT]')) return fetched.items.get('BODY[TEXT]') ?? '';
  }
  return '';
}

function parseFetchResponse(fetchResp: string): ImapMessage[] {
  const emails: ImapMessage[] = [];
  
  // Split by the fetch item pattern: * <num> FETCH (
  const msgBlocks = fetchResp.split(/\r\n\* \d+ FETCH \(/i);
  
  for (const block of msgBlocks) {
    if (!block.trim()) continue;
    
    const fromMatch = block.match(/From:\s*([^\r\n]+)/i);
    const subjectMatch = block.match(/Subject:\s*([^\r\n]+)/i);
    const dateMatch = block.match(/Date:\s*([^\r\n]+)/i);
    const msgIdMatch = block.match(/Message-ID:\s*([^\r\n]+)/i);
    const inReplyToMatch = block.match(/In-Reply-To:\s*([^\r\n]+)/i);
    const refsMatch = block.match(/References:\s*([^\r\n]+)/i);
    
    if (!fromMatch) continue;
    
    const rawFrom = fromMatch[1].trim();
    const emailMatch = rawFrom.match(/<([^>]+)>/);
    const fromEmail = emailMatch ? emailMatch[1].trim() : rawFrom;
    
    const subject = subjectMatch ? decodeMimeHeader(subjectMatch[1].trim()) : '';
    const dateStr = dateMatch ? dateMatch[1].trim() : '';
    const date = dateStr ? new Date(dateStr) : new Date();
    const messageId = msgIdMatch ? msgIdMatch[1].trim() : '';
    const inReplyTo = inReplyToMatch ? inReplyToMatch[1].trim() : '';
    const references = refsMatch ? refsMatch[1].trim() : '';
    
    // Extract Body:
    const bodyHeaderMatch = block.match(/BODY\[(?:TEXT)?\]\s*\{\d+\}\r\n/i);
    let body = '';
    
    if (bodyHeaderMatch && bodyHeaderMatch.index !== undefined) {
      const startIdx = bodyHeaderMatch.index + bodyHeaderMatch[0].length;
      const rawBody = block.substring(startIdx);
      let cleanedBody = rawBody.trim();
      if (cleanedBody.endsWith(')')) {
        cleanedBody = cleanedBody.slice(0, -1).trim();
      }
      body = cleanedBody;
    } else {
      const headerEndIdx = block.search(/\r\n\r\n/);
      if (headerEndIdx !== -1) {
        let rawBody = block.substring(headerEndIdx + 4).trim();
        if (rawBody.endsWith(')')) {
          rawBody = rawBody.slice(0, -1).trim();
        }
        body = rawBody;
      }
    }
    
    emails.push({
      from: fromEmail.toLowerCase(),
      subject,
      date,
      messageId,
      inReplyTo,
      references,
      body: cleanMimeBody(body)
    });
  }
  
  return emails;
}

/** Octets of quoted-printable text: soft line breaks removed and =XX escapes decoded. */
function quotedPrintableBytes(str: string): Buffer {
  const src = octets(str.replace(/=[ \t]*(?:\r?\n|$)/g, ''));
  const out = Buffer.alloc(src.length);
  let n = 0;
  for (let i = 0; i < src.length; i++) {
    const hex = src[i] === 0x3d ? src.toString('latin1', i + 1, i + 3) : '';
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      out[n++] = parseInt(hex, 16);
      i += 2;
    } else {
      // A '=' not followed by two hex digits is kept as it is
      out[n++] = src[i];
    }
  }
  return out.subarray(0, n);
}

/** Quoted-printable text decoded to bytes and read in `charset` (UTF-8, else windows-1252, when not given). */
export function decodeQuotedPrintable(str: string, charset?: string): string {
  return decodeCharset(quotedPrintableBytes(str), charset);
}

export function cleanReplyHistory(text: string): string {
  const lines = text.split(/\r?\n/);
  const cleanLines: string[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    
    // Stop at common reply headers:
    // "On ... wrote:" can span multiple lines. We check if this line starts with "On "
    // and ends with "wrote:" or if any of the next 2 lines ends with "wrote:".
    if (/^On\s+/i.test(trimmed)) {
      let foundWrote = false;
      for (let j = 0; j < 3 && (i + j) < lines.length; j++) {
        if (/wrote:?\s*$/i.test(lines[i + j].trim())) {
          foundWrote = true;
          break;
        }
      }
      if (foundWrote) {
        break;
      }
    }
    
    if (/^-----Original Message-----/i.test(trimmed)) {
      break;
    }
    if (/^---+\s*Original Message\s*---+/i.test(trimmed)) {
      break;
    }
    if (/^_{3,}\s*$/.test(trimmed) && cleanLines.length > 0) {
      break;
    }
    if (/^From:\s+/i.test(trimmed) && cleanLines.length > 0) {
      break;
    }
    if (/^Sent:\s+/i.test(trimmed) && cleanLines.length > 0) {
      break;
    }
    if (/^Date:\s+/i.test(trimmed) && cleanLines.length > 0) {
      break;
    }
    if (/^Subject:\s+/i.test(trimmed) && cleanLines.length > 0) {
      break;
    }
    if (/^To:\s+\S+@/i.test(trimmed) && cleanLines.length > 0) {
      break;
    }
    if (trimmed.startsWith('>')) {
      continue;
    }
    
    cleanLines.push(line);
  }
  
  return cleanLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Readable reply text of a message body, without the quoted reply history. `body`
 * is BODY[TEXT] as read from the IMAP connection (one char per octet), and
 * `contentType` and `transferEncoding` are the message's Content-Type and
 * Content-Transfer-Encoding: the first text/plain part is used, else the first
 * text/html part with its tags stripped, decoded with its declared charset. A body
 * given without its Content-Type is read by its own MIME headers or boundary lines.
 */
export function cleanMimeBody(body: string, contentType = '', transferEncoding = ''): string {
  if (!body) return '';
  const entity = contentType ? { body, contentType, transferEncoding } : sniffBodyHeaders(body);
  const found = mimeEntityText(entity.body, entity.contentType, entity.transferEncoding);
  if (!found) return '';
  return cleanReplyHistory(found.html ? stripHtmlTags(found.text) : found.text);
}

/** A Content-Type value's media type (text/plain when missing or malformed, RFC 2045) and lower-case parameters. */
function parseContentType(value: string): { type: string; params: Record<string, string> } {
  const type = value.match(/^\s*([^\s/;]+\/[^\s;]+)/)?.[1].toLowerCase() ?? 'text/plain';
  const params: Record<string, string> = {};
  for (const param of value.matchAll(/;\s*([^\s=;]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s;]+))/g)) {
    params[param[1].toLowerCase()] = param[2] !== undefined ? param[2].replace(/\\(.)/g, '$1') : param[3];
  }
  return { type, params };
}

/** Content decoded from its Content-Transfer-Encoding and read in its charset. */
function decodeBodyText(content: string, transferEncoding: string, charset?: string): string {
  const encoding = transferEncoding.trim().toLowerCase();
  const bytes = encoding === 'base64'
    ? Buffer.from(content.replace(/[^A-Za-z0-9+/]/g, ''), 'base64')
    : encoding === 'quoted-printable' ? quotedPrintableBytes(content) : octets(content);
  return decodeCharset(bytes, charset);
}

/** The body parts of a multipart body, without preamble, epilogue or delimiter lines. */
function splitMultipart(body: string, boundary: string): string[] {
  const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const delimiter = new RegExp(`(?:^|\\r?\\n)--${escaped}(--)?[ \\t]*(?=\\r?\\n|$)`, 'g');
  const parts: string[] = [];
  let start = -1;
  for (const match of body.matchAll(delimiter)) {
    if (start !== -1) parts.push(body.substring(start, match.index).replace(/^\r?\n/, ''));
    if (match[1]) return parts;
    start = match.index + match[0].length;
  }
  // A body cut short before its close delimiter keeps its last part
  if (start !== -1) parts.push(body.substring(start).replace(/^\r?\n/, ''));
  return parts;
}

/**
 * The readable text of a MIME entity: text/plain, else text/html (flagged, tags
 * still in), decoded from its transfer encoding and charset. In a multipart the
 * first text/plain part wins over the first text/html one; attachments are skipped.
 */
function mimeEntityText(body: string, contentType: string, transferEncoding: string, depth = 0): { text: string; html: boolean } | null {
  const { type, params } = parseContentType(contentType);
  if (type.startsWith('multipart/')) {
    if (!params.boundary || depth > 10) return null;
    let html: { text: string; html: boolean } | null = null;
    for (const part of splitMultipart(body, params.boundary)) {
      // A part without headers starts with the blank line
      const blank = part.match(/^\r?\n|\r?\n\r?\n/);
      const headerEnd = blank?.index ?? part.length;
      const fields = parseHeaderFields(part.substring(0, headerEnd));
      if (/^\s*attachment/i.test(fields.get('content-disposition') ?? '')) continue;
      const found = mimeEntityText(
        blank ? part.substring(headerEnd + blank[0].length) : '',
        fields.get('content-type') || 'text/plain',
        fields.get('content-transfer-encoding') ?? '',
        depth + 1
      );
      if (found && !found.html) return found;
      html ??= found;
    }
    return html;
  }
  if (type !== 'text/plain' && type !== 'text/html') return null;
  return { text: decodeBodyText(body, transferEncoding, params.charset), html: type === 'text/html' };
}

/**
 * Content headers for a body given without its message header, read from the body
 * itself: a leading MIME header block, else a "--boundary" line, else plain text
 * (quoted-printable when it has =XX escapes or soft line breaks).
 */
function sniffBodyHeaders(body: string): { body: string; contentType: string; transferEncoding: string } {
  const blank = body.match(/\r?\n\r?\n/);
  if (blank && blank.index !== undefined && /^[!-9;-~]+[ \t]*:/.test(body)) {
    const fields = parseHeaderFields(body.substring(0, blank.index));
    const contentType = fields.get('content-type');
    if (contentType) {
      return {
        body: body.substring(blank.index + blank[0].length),
        contentType,
        transferEncoding: fields.get('content-transfer-encoding') ?? '',
      };
    }
  }
  const boundaryLine = body.match(/^--(?=[^\r\n]*[A-Za-z0-9])([A-Za-z0-9'()+_,./:=?-]{8,})[ \t]*\r?$/m);
  if (boundaryLine) {
    return { body, contentType: `multipart/mixed; boundary="${boundaryLine[1].replace(/--$/, '')}"`, transferEncoding: '' };
  }
  const quotedPrintable = /=(?:[0-9A-Fa-f]{2}|\r?\n)/.test(body);
  return { body, contentType: 'text/plain', transferEncoding: quotedPrintable ? 'quoted-printable' : '' };
}

/** Reply HTML is read up to this many characters; the rest (usually quoted history or an inline image) is dropped. */
export const REPLY_HTML_MAX_CHARS = 512 * 1024;

/**
 * Text of reply HTML, read in one forward scan so that hostile markup (thousands of
 * unclosed tags, say) takes linear time instead of stalling the event loop the send
 * engine shares. A tag runs from '<' to the next '>': br, p, div, tr, li and h1-h6
 * become newlines, td and th spaces, a <blockquote> is dropped up to the next
 * </blockquote> (reply chains in HTML) and every other tag is removed. A '<' with no
 * '>' after it, and a blockquote never closed, are kept as text unless the cap cut them.
 */
function stripHtmlTags(html: string): string {
  const cut = html.length > REPLY_HTML_MAX_CHARS;
  const src = cut ? html.substring(0, REPLY_HTML_MAX_CHARS) : html;
  const parts: string[] = [];
  const quoteClose = /<\/blockquote>/gi;
  // The next '>' and </blockquote> already found ahead of the scan, each searched for
  // again only once the scan passes it (-1: none left), which keeps the scan linear
  let tagEnd = 0;
  let quoteEnd = 0;
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) break;
    if (tagEnd !== -1 && tagEnd <= lt) tagEnd = src.indexOf('>', lt + 1);
    if (tagEnd === -1) {
      if (cut) {
        parts.push(src.substring(i, lt));
        i = src.length;
      }
      break;
    }
    if (tagEnd === lt + 1) {
      // "<>" is text
      parts.push(src.substring(i, tagEnd));
      i = tagEnd;
      continue;
    }
    parts.push(src.substring(i, lt));
    const tag = src.substring(lt + 1, tagEnd);
    i = tagEnd + 1;
    if (/^br\s*\/?$/i.test(tag) || /^\/?(?:p|div|tr|li|h[1-6])/i.test(tag)) {
      parts.push('\n');
    } else if (/^\/?(?:td|th)/i.test(tag)) {
      parts.push(' ');
    } else if (/^blockquote/i.test(tag)) {
      if (quoteEnd !== -1 && quoteEnd < i) {
        quoteClose.lastIndex = i;
        quoteEnd = quoteClose.exec(src)?.index ?? -1;
      }
      if (quoteEnd !== -1) i = quoteEnd + '</blockquote>'.length;
      else if (cut) i = src.length;
    }
  }
  parts.push(src.substring(i));
  let text = parts.join('');
  // Decode HTML entities
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, ' ');
  // Collapse whitespace
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

export async function getActiveImapAccounts(userId: string, role: string) {
  let accountsWhere: any = {
    status: 'Active',
    imapHost: { not: null },
    imapPass: { not: null },
    provider: { not: 'Azure Relay Node' }
  };
  
  if (role !== 'ADMIN') {
    accountsWhere.userId = userId;
  }
  
  return prisma.senderAccount.findMany({
    where: accountsWhere
  });
}

export async function syncAllActiveMailboxes() {
  console.log('[IMAP Sync Daemon] Starting global mailbox synchronization tick...');
  const activeImapAccounts = await getActiveImapAccounts('', 'ADMIN');
  if (activeImapAccounts.length > 0) {
    const results = await Promise.allSettled(
      activeImapAccounts.map(acc => syncMailboxReplies(acc.id))
    );
    console.log(`[IMAP Sync Daemon] Tick finished. Synced ${activeImapAccounts.length} mailboxes.`, results);
  } else {
    console.log('[IMAP Sync Daemon] No active IMAP mailboxes found to sync.');
  }
}
