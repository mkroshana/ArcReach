/**
 * Decodes RFC 2047 "encoded-word" email header values, e.g.
 *   =?UTF-8?Q?Re=3A_Hello?=  ->  "Re: Hello"
 *   =?UTF-8?B?SGVsbG8=?=     ->  "Hello"
 * Plain (unencoded) strings are returned untouched.
 *
 * Uses only TextDecoder/atob so it runs in both the browser and Node.
 */

/**
 * Text of `bytes` in the declared `charset` (an RFC 2231 language suffix such as
 * "utf-8*en" is ignored). A missing, unknown or us-ascii charset is read as UTF-8
 * when the bytes are valid UTF-8, since mail often leaves 8-bit text undeclared,
 * and as windows-1252 otherwise.
 */
export function decodeCharset(bytes: Uint8Array, charset?: string | null): string {
  const label = (charset || '').split('*')[0].trim().toLowerCase();
  if (label && label !== 'us-ascii' && label !== 'ascii') {
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      // Unknown label: read it like an undeclared charset
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

function decodeBytes(bytes: number[], charset: string): string {
  return decodeCharset(new Uint8Array(bytes), charset);
}

export function decodeMimeHeader(input?: string | null): string {
  if (!input) return '';
  if (!input.includes('=?')) return input;

  // Adjacent encoded-words separated by whitespace should be concatenated (RFC 2047).
  const joined = input.replace(/\?=\s+=\?/g, '?==?');

  return joined.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_match, charset: string, enc: string, text: string) => {
    try {
      if (enc.toUpperCase() === 'B') {
        const bin = atob(text);
        const bytes = Array.from(bin, (c) => c.charCodeAt(0));
        return decodeBytes(bytes, charset);
      }
      // Q-encoding: '_' is a space, =XX are hex bytes.
      const qp = text.replace(/_/g, ' ');
      const bytes: number[] = [];
      for (let i = 0; i < qp.length; i++) {
        if (qp[i] === '=' && i + 2 < qp.length) {
          bytes.push(parseInt(qp.substr(i + 1, 2), 16));
          i += 2;
        } else {
          bytes.push(qp.charCodeAt(i));
        }
      }
      return decodeBytes(bytes, charset);
    } catch {
      return text;
    }
  });
}
