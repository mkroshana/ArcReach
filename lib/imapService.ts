import tls from 'tls';
import { prisma } from './db';

interface ImapMessage {
  from: string;
  subject: string;
  date: Date;
  messageId: string;
  inReplyTo?: string;
  references?: string;
  body: string;
}

export async function syncMailboxReplies(mailboxId: string) {
  const mailbox = await prisma.senderAccount.findUnique({
    where: { id: mailboxId }
  });
  
  if (!mailbox || !mailbox.imapHost || !mailbox.imapPort || !mailbox.imapUser || !mailbox.imapPass) {
    console.log(`[IMAP Sync] Mailbox ${mailboxId} is not configured with IMAP credentials.`);
    return { success: false, reason: 'Not configured' };
  }
  
  console.log(`[IMAP Sync] Syncing replies for ${mailbox.emailAddress} using ${mailbox.imapHost}:${mailbox.imapPort}`);
  
  let socket: tls.TLSSocket | null = null;
  try {
    const messages = await new Promise<ImapMessage[]>((resolve, reject) => {
      socket = tls.connect(
        mailbox.imapPort!,
        mailbox.imapHost!,
        { rejectUnauthorized: false },
        () => {
          console.log('[IMAP Sync] Connected via TLS.');
        }
      );
      
      socket!.setTimeout(10000); // 10s timeout
      
      let initialResponseReceived = false;
      let buffer = '';
      
      const commandsQueue: { tag: string; cmd: string; handler: (resp: string) => void }[] = [];
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
          console.log(`[IMAP Sync] Sending: ${item.tag} ${item.cmd}`);
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
          // Check if we got the server greeting (* OK)
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
            // Find the end of this line (which is \n)
            const lineEndIdx = buffer.indexOf('\n', tagIdx + tagPattern.length);
            if (lineEndIdx !== -1) {
              const completionLineEnd = lineEndIdx + 1; // Include the \n
              const responseStr = buffer.substring(0, completionLineEnd);
              buffer = buffer.substring(completionLineEnd); // Retain subsequent data in buffer
              
              try {
                item.handler(responseStr);
                executeNext();
              } catch (err) {
                console.error(`[IMAP Sync] Error in command ${item.tag} handler:`, err);
                socket!.destroy();
                reject(err);
              }
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
      // 1. LOGIN
      commandsQueue.push({
        tag: tagLogin,
        cmd: `LOGIN "${mailbox.imapUser!.replace(/"/g, '\\"')}" "${mailbox.imapPass!.replace(/"/g, '\\"')}"`,
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
              // Take the last 20 messages to prevent fetching too many
              const last20 = numbers.slice(-20);
              const range = last20.join(',');
              const tagFetch = makeTag('A4_FETCH');
              
              // Add FETCH command dynamically into the queue
              commandsQueue.splice(currentCommandIdx + 1, 0, {
                tag: tagFetch,
                cmd: `FETCH ${range} (BODY[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES)] BODY[TEXT])`,
                handler: (fetchResp) => {
                  if (!fetchResp.includes(`${tagFetch} OK`)) {
                    throw new Error('IMAP FETCH failed: ' + fetchResp);
                  }
                  const parsed = parseFetchResponse(fetchResp);
                  fetchedMessages.push(...parsed);
                }
              });
            }
          }
        }
      });
    });
    
    console.log(`[IMAP Sync] Fetched ${messages.length} messages from mail server.`);
    
    // Now, process messages and match with database Leads
    let newRepliesCount = 0;
    for (const msg of messages) {
      if (!msg.from) continue;
      
      // 1. Look up lead by email
      const lead = await prisma.lead.findUnique({
        where: { email: msg.from }
      });
      
      if (!lead) {
        // Not a lead in our CRM, skip
        continue;
      }
      
      // 2. Check if this response already exists in db
      const timeWindowStart = new Date(msg.date.getTime() - 10000); // -10s
      const timeWindowEnd = new Date(msg.date.getTime() + 10000);   // +10s
      
      const existing = await prisma.inboundResponse.findFirst({
        where: {
          leadId: lead.id,
          receivedAt: {
            gte: timeWindowStart,
            lte: timeWindowEnd
          }
        }
      });
      
      if (existing) {
        // Already logged this reply, skip
        continue;
      }
      
      // 3. Create InboundResponse record
      await prisma.inboundResponse.create({
        data: {
          leadId: lead.id,
          senderAccountId: mailbox.id,
          subject: msg.subject || 'No Subject',
          body: msg.body || '',
          receivedAt: msg.date,
          unread: true
        }
      });
      newRepliesCount++;
      
      // 4. Stop sequence on reply (if enabled in campaign)
      const activeEnrollments = await prisma.campaignEnrollment.findMany({
        where: {
          leadId: lead.id,
          status: 'Active'
        },
        include: {
          campaign: true
        }
      });
      
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
    
    const subject = subjectMatch ? subjectMatch[1].trim() : '';
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
    if (/^From:\s+/i.test(trimmed) && cleanLines.length > 0) {
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
  
  // Detect if body is multipart by searching for a line starting with "--"
  const lines = body.split(/\r?\n/);
  const boundaryLine = lines.find(line => line.trim().startsWith('--') && line.trim().length > 5);
  
  if (boundaryLine) {
    const boundary = boundaryLine.trim().slice(2).replace(/--$/, '');
    
    // Split body by the boundary
    const parts = body.split('--' + boundary);
    
    let textPart = '';
    for (const part of parts) {
      const trimmedPart = part.trim();
      if (!trimmedPart || trimmedPart === '--') continue;
      
      const match = trimmedPart.match(/\r?\n\r?\n/);
      if (match && match.index !== undefined) {
        const headers = trimmedPart.substring(0, match.index);
        const partBody = trimmedPart.substring(match.index + match[0].length);
        
        const isPlain = /Content-Type:\s*text\/plain/i.test(headers) || !headers.includes('Content-Type');
        
        if (isPlain) {
          const isQuotedPrintable = /Content-Transfer-Encoding:\s*quoted-printable/i.test(headers);
          const isBase64 = /Content-Transfer-Encoding:\s*base64/i.test(headers);
          
          let decoded = partBody;
          if (isQuotedPrintable) {
            decoded = decodeQuotedPrintable(partBody);
          } else if (isBase64) {
            try {
              decoded = Buffer.from(partBody.replace(/\s+/g, ''), 'base64').toString('utf8');
            } catch {}
          }
          textPart = decoded;
          break;
        }
      } else {
        textPart = trimmedPart;
      }
    }
    
    if (textPart) {
      return cleanReplyHistory(textPart);
    }
  }
  
  return cleanReplyHistory(decodeQuotedPrintable(body));
}
