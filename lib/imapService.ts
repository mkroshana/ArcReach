import net from 'net';
import tls from 'tls';
import { prisma } from './db';
import { decodeMimeHeader } from './mime';
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

const activeSyncs = new Set<string>();

/**
 * Log-safe form of an outgoing IMAP command: tag and verb only. Arguments are
 * never logged because LOGIN carries the decrypted mailbox password.
 */
export function describeImapCommand(tag: string, cmd: string): string {
  const verb = cmd.trim().split(/\s+/)[0] || '';
  return `${tag} ${verb}`;
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
    
    let socket: tls.TLSSocket | null = null;
    try {
      const messages = await new Promise<ImapMessage[]>((resolve, reject) => {
        socket = tls.connect(imapTlsOptions(mailbox.imapHost!, mailbox.imapPort!, mailbox.imapAllowSelfSigned), () => {
          console.log('[IMAP Sync] Connected via TLS.');
        });
        
        socket!.setTimeout(15000); // 15s timeout
        
        let initialResponseReceived = false;
        let buffer = '';
        
        const commandsQueue: { tag: string; cmd: string; handler: (resp: string) => void | Promise<void> }[] = [];
        let currentCommandIdx = -1;
        const fetchedMessages: ImapMessage[] = [];
        
        const makeTag = (prefix: string) => `${prefix}_${Math.random().toString(36).substring(2, 8)}`;
        
        const tagLogin = makeTag('A1_LOGIN');
        const tagSelect = makeTag('A2_SELECT');
        const tagSearch = makeTag('A3_SEARCH');
        
        const executeNext = () => {
          currentCommandIdx++;
          if (currentCommandIdx < commandsQueue.length) {
            const item = commandsQueue[currentCommandIdx];
            console.log(`[IMAP Sync] Sending: ${describeImapCommand(item.tag, item.cmd)}`);
            socket!.write(`${item.tag} ${item.cmd}\r\n`);
          } else {
            // Finished all commands, close connection
            const tagLogout = makeTag('A_LOGOUT');
            socket!.write(`${tagLogout} LOGOUT\r\n`);
            socket!.end();
            resolve(fetchedMessages);
          }
        };
        
        socket!.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          
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
        commandsQueue.push({
          tag: tagLogin,
          cmd: `LOGIN "${mailbox.imapUser!.replace(/"/g, '\\"')}" "${imapPassPlain.replace(/"/g, '\\"')}"`,
          handler: (resp) => {
            if (!resp.includes(`${tagLogin} OK`)) {
              throw new Error('IMAP Login failed: ' + resp);
            }
          }
        });
        
        // 2. SELECT INBOX
        commandsQueue.push({
          tag: tagSelect,
          cmd: 'SELECT INBOX',
          handler: (resp) => {
            if (!resp.includes(`${tagSelect} OK`)) {
              throw new Error('IMAP SELECT failed: ' + resp);
            }
          }
        });
        
        // 3. SEARCH ALL
        commandsQueue.push({
          tag: tagSearch,
          cmd: 'SEARCH ALL',
          handler: (resp) => {
            if (!resp.includes(`${tagSearch} OK`)) {
              throw new Error('IMAP SEARCH failed: ' + resp);
            }
            
            const match = resp.match(/\* SEARCH\s+([0-9\s]+)/i);
            if (match && match[1].trim()) {
              const numbers = match[1].trim().split(/\s+/).filter(Boolean);
              if (numbers.length > 0) {
                const last20 = numbers.slice(-20);
                const range = last20.join(',');
                const tagFetchHeaders = makeTag('A4_FETCH_HEADERS');
                
                // Add header FETCH command dynamically
                commandsQueue.splice(currentCommandIdx + 1, 0, {
                  tag: tagFetchHeaders,
                  cmd: `FETCH ${range} (BODY[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES)])`,
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
                    
                    // For each matching message, dynamically queue a command to fetch its body
                    for (const msg of headerParsed) {
                      if (matchedLeadEmails.has(normalizeEmail(msg.from))) {
                        const tagFetchBody = makeTag('A5_FETCH_BODY');
                        commandsQueue.splice(currentCommandIdx + 1, 0, {
                          tag: tagFetchBody,
                          cmd: `FETCH ${msg.seq} (BODY[TEXT])`,
                          handler: (bodyResp) => {
                            if (!bodyResp.includes(`${tagFetchBody} OK`)) {
                              throw new Error('IMAP Fetch body failed: ' + bodyResp);
                            }
                            const bodyParsedText = parseBodyResponse(bodyResp);
                            fetchedMessages.push({
                              from: msg.from,
                              subject: msg.subject,
                              date: msg.date,
                              messageId: msg.messageId,
                              inReplyTo: msg.inReplyTo,
                              references: msg.references,
                              body: cleanMimeBody(bodyParsedText)
                            });
                          }
                        });
                      }
                    }
                  }
                });
              }
            }
          }
        });
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
        
        const timeWindowStart = new Date(msg.date.getTime() - 10000);
        const timeWindowEnd = new Date(msg.date.getTime() + 10000);
        
        const existing = await prisma.inboundResponse.findFirst({
          where: {
            leadId: lead.id,
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
        
        await prisma.inboundResponse.create({
          data: {
            leadId: lead.id,
            campaignId,
            senderAccountId: mailbox.id,
            subject: msg.subject || 'No Subject',
            body: msg.body || '',
            receivedAt: msg.date,
            unread: true
          }
        });
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
  seq: string;
  from: string;
  subject: string;
  date: Date;
  messageId: string;
  inReplyTo: string;
  references: string;
}

export function parseHeaderResponse(fetchResp: string): HeaderInfo[] {
  const result: HeaderInfo[] = [];
  const msgBlocks = fetchResp.split(/\r\n\* /i);
  
  for (const block of msgBlocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    
    const match = trimmed.match(/^(\d+)\s+FETCH\s+\(/i);
    if (!match) continue;
    
    const seq = match[1];
    
    const fromMatch = trimmed.match(/From:\s*([^\r\n]+)/i);
    const subjectMatch = trimmed.match(/Subject:\s*([^\r\n]+)/i);
    const dateMatch = trimmed.match(/Date:\s*([^\r\n]+)/i);
    const msgIdMatch = trimmed.match(/Message-ID:\s*([^\r\n]+)/i);
    const inReplyToMatch = trimmed.match(/In-Reply-To:\s*([^\r\n]+)/i);
    const refsMatch = trimmed.match(/References:\s*([^\r\n]+)/i);
    
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
    
    result.push({
      seq,
      from: fromEmail.toLowerCase(),
      subject,
      date,
      messageId,
      inReplyTo,
      references
    });
  }
  
  return result;
}

export function parseBodyResponse(fetchResp: string): string {
  const bodyHeaderMatch = fetchResp.match(/BODY\[(?:TEXT)?\]\s*\{\d+\}\r\n/i);
  let body = '';
  
  if (bodyHeaderMatch && bodyHeaderMatch.index !== undefined) {
    const startIdx = bodyHeaderMatch.index + bodyHeaderMatch[0].length;
    let rawBody = fetchResp.substring(startIdx).trim();
    if (rawBody.endsWith(')')) {
      rawBody = rawBody.slice(0, -1).trim();
    }
    body = rawBody;
  } else {
    const headerEndIdx = fetchResp.search(/\r\n\r\n/);
    if (headerEndIdx !== -1) {
      let rawBody = fetchResp.substring(headerEndIdx + 4).trim();
      if (rawBody.endsWith(')')) {
        rawBody = rawBody.slice(0, -1).trim();
      }
      body = rawBody;
    } else {
      body = fetchResp;
    }
  }
  
  return body;
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

export function decodeQuotedPrintable(str: string): string {
  // Only decode if we detect quoted-printable signatures:
  // e.g. "=3D" or soft line breaks "=\r\n" or "=\n"
  if (!/=3D/i.test(str) && !/=\r?\n/.test(str)) {
    return str;
  }
  
  // 1. Remove soft line breaks (an equals sign at the end of a line)
  let result = str.replace(/=+(?:\r?\n|$)/g, '');
  
  // 2. Decode hex escapes: =XX
  result = result.replace(/=([0-9A-F]{2})/gi, (match, hex) => {
    try {
      return String.fromCharCode(parseInt(hex, 16));
    } catch {
      return match;
    }
  });
  
  return result;
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

export function cleanMimeBody(body: string): string {
  if (!body) return '';
  
  // 1. Try to extract boundary from a Content-Type header within the body itself
  //    (this handles cases where BODY[TEXT] includes the MIME structure)
  let boundary = '';
  
  const ctBoundaryMatch = body.match(/Content-Type:\s*multipart\/\w+;\s*boundary=["']?([^\s"';\r\n]+)["']?/i);
  if (ctBoundaryMatch) {
    boundary = ctBoundaryMatch[1];
  }
  
  // 2. Fallback: detect boundary from a line starting with "--" that looks like a MIME boundary
  if (!boundary) {
    const lines = body.split(/\r?\n/);
    const boundaryLine = lines.find(line => {
      const t = line.trim();
      // Must start with --, be longer than just --, and not be a text separator like "---"
      return t.startsWith('--') && t.length > 10 && /^--[a-zA-Z0-9_=.+/-]+--?$/.test(t);
    });
    if (boundaryLine) {
      boundary = boundaryLine.trim().slice(2).replace(/--$/, '');
    }
  }
  
  if (boundary) {
    return extractFromMultipart(body, boundary);
  }
  
  // 3. Not multipart — check for single-part with Content-Type headers embedded
  //    (e.g. BODY[TEXT] that starts with Content-Type: text/plain)
  const singlePartMatch = body.match(/Content-Type:\s*text\/plain[^\r\n]*\r?\n(?:Content-Transfer-Encoding:\s*(\S+)\r?\n)?(?:[^\r\n]+\r?\n)*?\r?\n/i);
  if (singlePartMatch && singlePartMatch.index !== undefined) {
    const encoding = singlePartMatch[1] || '';
    const contentStart = singlePartMatch.index + singlePartMatch[0].length;
    let rawContent = body.substring(contentStart);
    
    // Trim trailing boundary or MIME artifacts
    const trailingBoundary = rawContent.search(/\r?\n--[a-zA-Z0-9_=.+/-]+/);
    if (trailingBoundary !== -1) {
      rawContent = rawContent.substring(0, trailingBoundary);
    }
    
    rawContent = decodeTransferEncoding(rawContent, encoding);
    return cleanReplyHistory(rawContent);
  }
  
  // 4. Check if entire body looks like raw MIME headers + content dump
  //    (contains things like "Content-Type:", "From:", "Message-ID:" near the start)
  const hasMimeHeaders = /^(Content-Type:|MIME-Version:|Content-Transfer-Encoding:|From:|Date:|Message-ID:|Subject:)/mi.test(body.substring(0, 500));
  if (hasMimeHeaders) {
    // Try to extract just the readable text by finding the first blank line separator
    const headerEndIdx = body.search(/\r?\n\r?\n/);
    if (headerEndIdx !== -1) {
      let rawBody = body.substring(headerEndIdx + (body[headerEndIdx] === '\r' ? 4 : 2)).trim();
      
      // Check if after the blank line we hit another MIME part
      const innerBoundaryMatch = rawBody.match(/Content-Type:\s*multipart\/\w+;\s*boundary=["']?([^\s"';\r\n]+)["']?/i);
      if (innerBoundaryMatch) {
        return extractFromMultipart(rawBody, innerBoundaryMatch[1]);
      }
      
      // Check if it starts with another Content-Type
      const innerCtMatch = rawBody.match(/^Content-Type:\s*text\/plain[^\r\n]*\r?\n(?:Content-Transfer-Encoding:\s*(\S+)\r?\n)?(?:[^\r\n]+\r?\n)*?\r?\n/i);
      if (innerCtMatch) {
        const encoding = innerCtMatch[1] || '';
        rawBody = rawBody.substring(innerCtMatch[0].length);
        rawBody = decodeTransferEncoding(rawBody, encoding);
      }
      
      // Strip any remaining Content-Type / MIME lines that leaked through
      rawBody = stripLeakedMimeHeaders(rawBody);
      
      if (rawBody.endsWith(')')) {
        rawBody = rawBody.slice(0, -1).trim();
      }
      return cleanReplyHistory(rawBody);
    }
  }
  
  // 5. Final fallback: decode QP and clean reply chain
  let result = decodeQuotedPrintable(body);
  result = stripLeakedMimeHeaders(result);
  return cleanReplyHistory(result);
}

function decodeTransferEncoding(content: string, encoding: string): string {
  const enc = encoding.toLowerCase().trim();
  if (enc === 'quoted-printable') {
    return decodeQuotedPrintable(content);
  }
  if (enc === 'base64') {
    try {
      return Buffer.from(content.replace(/\s+/g, ''), 'base64').toString('utf8');
    } catch {
      return content;
    }
  }
  return content;
}

function extractFromMultipart(body: string, boundary: string): string {
  const parts = body.split('--' + boundary);
  
  let textPart = '';
  let htmlPart = '';
  
  for (const part of parts) {
    const trimmedPart = part.trim();
    if (!trimmedPart || trimmedPart === '--') continue;
    
    // Find the blank line separator between headers and body
    const blankLineMatch = trimmedPart.match(/\r?\n\r?\n/);
    if (blankLineMatch && blankLineMatch.index !== undefined) {
      const headers = trimmedPart.substring(0, blankLineMatch.index);
      let partBody = trimmedPart.substring(blankLineMatch.index + blankLineMatch[0].length);
      
      // Clean trailing boundary/closing paren artifacts
      if (partBody.endsWith(')')) {
        partBody = partBody.slice(0, -1).trim();
      }
      
      const isPlain = /Content-Type:\s*text\/plain/i.test(headers);
      const isHtml = /Content-Type:\s*text\/html/i.test(headers);
      
      // Detect encoding
      const encodingMatch = headers.match(/Content-Transfer-Encoding:\s*(\S+)/i);
      const encoding = encodingMatch ? encodingMatch[1] : '';
      
      const decoded = decodeTransferEncoding(partBody, encoding);
      
      if (isPlain) {
        textPart = decoded;
        break; // Prefer text/plain, take first one
      } else if (isHtml && !htmlPart) {
        htmlPart = decoded;
      } else if (!headers.includes('Content-Type') && !textPart) {
        // No Content-Type header — treat as plain text
        textPart = decoded;
      }
    }
  }
  
  if (textPart) {
    return cleanReplyHistory(textPart);
  }
  
  // Fallback to HTML part, strip tags
  if (htmlPart) {
    return cleanReplyHistory(stripHtmlTags(htmlPart));
  }
  
  // Nothing worked — try decoding raw body
  return cleanReplyHistory(decodeQuotedPrintable(body));
}

function stripHtmlTags(html: string): string {
  let text = html;
  // Convert common block elements to newlines
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/?(p|div|tr|li|h[1-6])[^>]*>/gi, '\n');
  text = text.replace(/<\/?(td|th)[^>]*>/gi, ' ');
  // Remove blockquote content (reply chains in HTML)
  text = text.replace(/<blockquote[^>]*>[\s\S]*?<\/blockquote>/gi, '');
  // Remove all remaining tags
  text = text.replace(/<[^>]+>/g, '');
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

function stripLeakedMimeHeaders(text: string): string {
  // Remove lines that look like leaked MIME headers
  const lines = text.split(/\r?\n/);
  const cleaned: string[] = [];
  
  for (const line of lines) {
    const t = line.trim();
    // Skip lines that are clearly MIME headers
    if (/^Content-Type:\s/i.test(t)) continue;
    if (/^Content-Transfer-Encoding:\s/i.test(t)) continue;
    if (/^MIME-Version:\s/i.test(t)) continue;
    if (/^Content-Disposition:\s/i.test(t)) continue;
    if (/^Message-ID:\s/i.test(t)) continue;
    if (/^In-Reply-To:\s/i.test(t)) continue;
    if (/^References:\s/i.test(t)) continue;
    // Skip boundary markers
    if (/^--[a-zA-Z0-9_=.+/-]{10,}--?$/.test(t)) continue;
    // Skip IMAP fetch artifacts like "{530}" octet counts
    if (/^\{\d+\}$/.test(t)) continue;
    
    cleaned.push(line);
  }
  
  return cleaned.join('\n').replace(/\n{3,}/g, '\n\n').trim();
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
