import { describe, it, expect, vi } from 'vitest';

vi.mock('../../lib/db', () => ({ prisma: {} }));

import { cleanMimeBody, REPLY_HTML_MAX_CHARS } from '../../lib/imapService';

const htmlText = (html: string) => cleanMimeBody(html, 'text/html; charset=utf-8', '7bit');

describe('Reply HTML to text (H34)', () => {
  // Each took seconds to minutes with the old regexes, whose time grew with the square of the input
  it.each([
    ['unclosed <p tags', '<p', '<p'],
    ['bare < characters', '<', '<'],
    ['unclosed <br tags', '<br ', '<br '],
    ['unclosed <td tags', '<td', '<td'],
    ['blockquotes never closed', 'x<blockquote>', 'x'],
  ])('reads %s in linear time', (_name, unit, kept) => {
    // Under the cap, so the whole input is scanned
    const count = Math.floor((REPLY_HTML_MAX_CHARS - 1024) / unit.length);
    const html = unit.repeat(count);

    const started = performance.now();
    const text = htmlText(html);
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(1000);
    // A '<' with no '>' after it stays text, and a blockquote never closed keeps its text
    expect(text).toBe(kept.repeat(count).trim());
  });

  it('turns a Gmail reply into its text without the quoted history', () => {
    const html = [
      '<div dir="ltr">Yes, Thursday works &amp; 2pm is fine.<br>See you then.</div><br>',
      '<div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Mon, Sep 28, 2026 at 10:04 AM Sales &lt;sales@arcreach.test&gt; wrote:<br></div>',
      '<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex">Hi Amy,<br>Would you be open to a call?</blockquote></div>',
    ].join('');
    expect(htmlText(html)).toBe('Yes, Thursday works & 2pm is fine.\nSee you then.');
  });

  it('keeps line breaks, table cells and the text around dropped blockquotes', () => {
    const html = '<p>Times:</p><table><tr><td>Mon</td><td>9am</td></tr></table>'
      + '<BLOCKQUOTE type="cite">earlier</BLOCKQUOTE><h2>Thanks</h2><blockquote>older';
    expect(htmlText(html)).toBe('Times:\n\n Mon 9am \n\nThanks\nolder');
    expect(htmlText('Is 3 < 5? Yes')).toBe('Is 3 < 5? Yes');
  });

  it('reads only the first REPLY_HTML_MAX_CHARS characters, dropping a tag or blockquote the cap cuts', () => {
    const image = '<p>Thursday works.</p><img src="data:image/png;base64,' + 'A'.repeat(REPLY_HTML_MAX_CHARS) + '"><p>After the image</p>';
    expect(htmlText(image)).toBe('Thursday works.');

    const filler = 'Earlier message. ';
    const quote = '<p>See you then.</p><blockquote type="cite">' + filler.repeat(REPLY_HTML_MAX_CHARS / filler.length + 1) + '</blockquote><p>Tail</p>';
    expect(htmlText(quote)).toBe('See you then.');
  });
});
