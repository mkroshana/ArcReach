import { describe, it, expect } from 'vitest';
import { decodeMimeHeader } from '@/lib/mime';

describe('decodeMimeHeader', () => {
  it('returns plain strings unchanged', () => {
    expect(decodeMimeHeader('Re: Hello there')).toBe('Re: Hello there');
    expect(decodeMimeHeader('')).toBe('');
    expect(decodeMimeHeader(null)).toBe('');
    expect(decodeMimeHeader(undefined)).toBe('');
  });

  it('decodes Q-encoded words (underscore=space, =XX hex)', () => {
    expect(decodeMimeHeader('=?UTF-8?Q?Re=3A_Hello?=')).toBe('Re: Hello');
  });

  it('decodes B-encoded (base64) words', () => {
    expect(decodeMimeHeader('=?UTF-8?B?SGVsbG8gd29ybGQ=?=')).toBe('Hello world');
  });

  it('decodes UTF-8 multibyte sequences', () => {
    // "Let's" with a curly apostrophe (’ = E2 80 99) in Q-encoding
    expect(decodeMimeHeader('=?UTF-8?Q?Let=E2=80=99s_fix_it?=')).toBe('Let’s fix it');
  });

  it('joins adjacent encoded-words and preserves surrounding text', () => {
    expect(decodeMimeHeader('=?UTF-8?Q?Hello?= =?UTF-8?Q?_World?=')).toBe('Hello World');
  });
});
