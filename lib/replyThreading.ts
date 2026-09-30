import { decodeMimeHeader } from './mime';

/**
 * Threading of Unibox replies (RFC 5322 section 3.6.4). IMAP sync stores the
 * message ids a lead's reply refers to on InboundResponse.references, beside its
 * Message-ID, and a Unibox reply to it names them in In-Reply-To and References,
 * under its subject with "Re: ", so the lead's mail client shows it in the same
 * conversation instead of as a new email.
 */

/** Most message ids a stored chain or a References header keeps: the thread's first and its latest. */
export const REFERENCES_MAX_IDS = 20;

/** Longest message id put in a header, as IMAP sync stores Message-IDs as they are up to this length. */
const MESSAGE_ID_MAX_CHARS = 255;

/** Whether `value` is one <...> message id a header can carry as it is: printable ASCII without spaces, at most 255 characters. */
export function isHeaderMessageId(value: string | null | undefined): value is string {
  return !!value && value.length <= MESSAGE_ID_MAX_CHARS && /^<[!-;=?-~]+>$/.test(value);
}

/** `ids` cut to the first and the latest REFERENCES_MAX_IDS - 1 when longer. */
function capReferences(ids: string[]): string[] {
  return ids.length <= REFERENCES_MAX_IDS ? ids : [ids[0], ...ids.slice(1 - REFERENCES_MAX_IDS)];
}

/**
 * The message ids a received message's thread refers to, space-separated as
 * InboundResponse.references stores them: its References, else the single id
 * of its In-Reply-To, as a reply to it builds its References. Null when it
 * names none a header can carry.
 */
export function threadReferences(inReplyTo = '', references = ''): string | null {
  let ids = (references.match(/<[^<>\s]+>/g) ?? []).filter(isHeaderMessageId);
  if (ids.length === 0) {
    const parents = inReplyTo.match(/<[^<>\s]+>/g) ?? [];
    if (parents.length === 1 && isHeaderMessageId(parents[0])) ids = parents;
  }
  return ids.length > 0 ? capReferences(ids).join(' ') : null;
}

/**
 * The In-Reply-To and References headers of a reply to a stored message:
 * In-Reply-To its Message-ID, References its stored chain followed by that
 * Message-ID. A message stored without a Message-ID a header can carry (none,
 * a hashed one or a UID stand-in) is named by References alone, and one with
 * neither gets no headers.
 */
export function replyThreadingHeaders(parent: { messageId: string | null; references: string | null }): Record<string, string> {
  const headers: Record<string, string> = {};
  const chain = (parent.references ?? '').split(' ').filter(isHeaderMessageId);
  if (isHeaderMessageId(parent.messageId)) {
    headers['In-Reply-To'] = parent.messageId;
    chain.push(parent.messageId);
  }
  if (chain.length > 0) headers['References'] = capReferences(chain).join(' ');
  return headers;
}

/** The subject of a reply to a message titled `subject`: "Re: " before it, unless it already starts with Re:. */
export function replySubject(subject: string): string {
  const title = decodeMimeHeader(subject).trim();
  return /^re:/i.test(title) ? title : `Re: ${title}`;
}
