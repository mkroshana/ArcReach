/**
 * Decodes RFC 2047 "encoded-word" email header values, e.g.
 *   =?UTF-8?Q?Re=3A_Hello?=  ->  "Re: Hello"
 *   =?UTF-8?B?SGVsbG8=?=     ->  "Hello"
 * Plain (unencoded) strings are returned untouched.
 *
 * Uses only TextDecoder/atob so it runs in both the browser and Node.
 */
function decodeBytes(bytes: number[], charset: string): string {
  try {
    return new TextDecoder(charset || 'utf-8').decode(new Uint8Array(bytes));
  } catch {
    return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
  }
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
