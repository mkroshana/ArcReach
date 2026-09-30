import { describe, it, expect } from 'vitest';
import { emailBodyToText } from '@/lib/emailText';

describe('emailBodyToText', () => {
  it('returns empty string for missing bodies', () => {
    expect(emailBodyToText('')).toBe('');
    expect(emailBodyToText(null)).toBe('');
    expect(emailBodyToText(undefined)).toBe('');
  });

  it('leaves plain text untouched, including angle-bracketed addresses', () => {
    const body = 'Hi there,\n\nThanks for reaching out.\nJane <jane@example.com>';
    expect(emailBodyToText(body)).toBe(body);
  });

  it('removes markup that would execute or load when rendered as HTML', () => {
    const body = '<p>Hello</p><img src=x onerror="alert(1)"><script>alert(2)</script><svg onload="alert(3)"></svg>';
    const text = emailBodyToText(body);
    expect(text).toBe('Hello');
    expect(text).not.toMatch(/<|onerror|onload|alert/);
  });

  it('drops the tracking pixel and keeps link text without tracked URLs (M37)', () => {
    const body =
      '<html><head><meta charset="utf-8"><title>t</title><style>p{color:red}</style></head><body>' +
      '<p>Hi Emily,</p><p>See <a href="https://app.example.com/api/track/click/d1?url=https%3A%2F%2Fx.com">our site</a>.</p>' +
      '<img src="https://app.example.com/api/track/open/d1" width="1" height="1" style="display:none;" alt="" />' +
      '</body></html>';
    const text = emailBodyToText(body);
    expect(text).toBe('Hi Emily,\n\nSee our site.');
    expect(text).not.toContain('track');
  });

  it('turns <br> and block tags into line breaks and collapses indentation', () => {
    const body = '<div>\n    Line one<br>Line two<br />\n    <ul><li>A</li><li>B</li></ul>\n</div>';
    expect(emailBodyToText(body)).toBe('Line one\nLine two\n\nA\n\nB');
  });

  it('decodes entities to text without re-creating markup from double-encoded input', () => {
    expect(emailBodyToText('Tom &amp; Jerry&nbsp;&#8217;s &quot;show&quot; &#x2014; &lt;b&gt;')).toBe(
      'Tom & Jerry ’s "show" — <b>'
    );
    expect(emailBodyToText('&amp;lt;script&amp;gt;')).toBe('&lt;script&gt;');
  });

  it('leaves unknown or invalid entities as written', () => {
    expect(emailBodyToText('&bogus; &#0; &#xD800;')).toBe('&bogus; &#0; &#xD800;');
  });

  it('ignores ">" inside quoted attribute values when stripping tags', () => {
    expect(emailBodyToText('<a title="a>b" href="https://x.com">link</a>')).toBe('link');
  });

  it('removes HTML comments and doctype', () => {
    expect(emailBodyToText('<!DOCTYPE html><!-- hidden <b>x</b> -->Visible')).toBe('Visible');
  });
});
