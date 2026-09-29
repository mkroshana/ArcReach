import { describe, it, expect } from 'vitest';
import { personalizeEmail, personalizePreview, isHtmlTemplate, renderEmailBody, previewEmailBody, PREVIEW_LEAD } from '../../lib/personalize';
import { applyEmailTracking } from '../../lib/emailTracking';

const lead = { id: 'lead-1', name: 'John Doe', company: 'Acme Corp', jobTitle: 'CTO', email: 'john@acme.com' };
const firstOption = () => 0;
const lastOption = (count: number) => count - 1;

describe('personalizeEmail (H22, L11)', () => {
  it('leaves CSS rules and brace groups without a pipe exactly as written', () => {
    const template = '<style>.btn{color:#fff} @media (max-width:600px){.btn{width:100%}}</style><p>{not spintax}</p>';
    expect(personalizeEmail(template, lead, firstOption)).toBe(template);
  });

  it('never resolves spintax inside <style> or <script>, even with a pipe', () => {
    const style = '<STYLE>.a{b|c}</STYLE>';
    const script = '<script>if (a || b) { f(a|b) }</script>';
    expect(personalizeEmail(`${style}${script}<p>{Hi|Hello}</p>`, lead, lastOption)).toBe(`${style}${script}<p>Hello</p>`);
  });

  it('keeps an unclosed <style> block untouched to the end of the text', () => {
    const template = '<p>{Hi|Hello}</p><style>.a{b|c}';
    expect(personalizeEmail(template, lead, firstOption)).toBe('<p>Hi</p><style>.a{b|c}');
  });

  it('resolves brace groups with a pipe, innermost first', () => {
    expect(personalizeEmail('{Hi|Hello} there, {see|{check|look at}} this', lead, lastOption)).toBe('Hello there, look at this');
    expect(personalizeEmail('{Hi|Hello} there, {see|{check|look at}} this', lead, firstOption)).toBe('Hi there, see this');
  });

  it('picks a random option by default', () => {
    const seen = new Set(Array.from({ length: 200 }, () => personalizeEmail('{A|B}', lead)));
    expect(seen).toEqual(new Set(['A', 'B']));
  });

  it('fills the known placeholders, with or without spaces inside the braces', () => {
    const template = '{{firstName}} / {{ name }} / {{company}} / {{jobTitle}} / {{email}}';
    expect(personalizeEmail(template, lead)).toBe('John / John Doe / Acme Corp / CTO / john@acme.com');
    expect(personalizeEmail(template, {})).toBe('there / there / your company / professional / ');
  });

  it('fills the n8n $json forms in double and single braces, with and without fallbacks', () => {
    const template = "{{ $json.name || 'friend' }} / { $json.name } / {{ $json.company || 'your team' }} / { $json.company || 'Co' }";
    expect(personalizeEmail(template, lead, firstOption)).toBe('John / John / Acme Corp / Acme Corp');
    expect(personalizeEmail(template, { name: '', company: '' }, firstOption)).toBe('friend / there / your team / Co');
  });

  it('leaves unknown placeholders and {{unsubscribe_url}} exactly as written, even with a pipe inside', () => {
    const template = 'Hi {{firstName}} from {{city}} {{ unsubscribe_url }} {{a|b}} [[unsubscribe_url]]';
    expect(personalizeEmail(template, lead, firstOption)).toBe('Hi John from {{city}} {{ unsubscribe_url }} {{a|b}} [[unsubscribe_url]]');
  });

  it('fills placeholders inside spintax options', () => {
    expect(personalizeEmail('{Hi {{firstName}}|Hello {{ company }}}!', lead, firstOption)).toBe('Hi John!');
    expect(personalizeEmail('{Hi {{firstName}}|Hello {{ company }}}!', lead, lastOption)).toBe('Hello Acme Corp!');
  });

  it('inserts lead values verbatim, never as $-replacement patterns or spintax', () => {
    const tricky = { name: 'Bruce $& Wayne', company: "{Wayne|Stark} Cash$'n'Carry $$ $1 $<x>", jobTitle: '{{email}}' };
    const template = 'Dear {{name}} at {{company}} ({{jobTitle}}), {Hi|Hello}. Bye.';
    expect(personalizeEmail(template, tricky, firstOption))
      .toBe("Dear Bruce $& Wayne at {Wayne|Stark} Cash$'n'Carry $$ $1 $<x> ({{email}}), Hi. Bye.");
  });

  it('keeps private-use characters already in the template', () => {
    const open = String.fromCharCode(0xe000);
    const close = String.fromCharCode(0xe001);
    const template = `${open}0${close} ${open}1${close} {{firstName}} {A|B}`;
    expect(personalizeEmail(template, lead, firstOption)).toBe(`${open}0${close} ${open}1${close} John A`);
  });

  it('returns an empty string for an empty template', () => {
    expect(personalizeEmail('', lead)).toBe('');
  });
});

describe('personalizePreview', () => {
  it('previews a subject as sent to the sample contact, with the first spintax option', () => {
    expect(personalizePreview('{A|B} {{firstName}} {{name}} {{city}} <{{company}}>')).toBe('A Emily Emily Carter {{city}} <Stark Industries>');
  });
});

describe('template -> renderEmailBody -> applyEmailTracking (H22)', () => {
  const template = [
    '<html><head><style>.btn{color:#fff;background:#0a66c2} p{margin:0}</style></head><body>',
    '<p>{Hi|Hello} {{firstName}}, how is {{city}}?</p>',
    '<a class="btn" href="https://example.com/demo">Book</a>',
    "<p><a href='{{unsubscribe_url}}'>Unsubscribe</a></p>",
    '</body></html>',
  ].join('');

  it('keeps the styling, the custom unsubscribe link and unknown fields through tracking', () => {
    const rendered = renderEmailBody(template, lead, firstOption);
    expect(rendered.isHtml).toBe(true);
    const sent = applyEmailTracking(rendered.body, 'dispatch-1', rendered.isHtml, true, true, lead.id);

    expect(sent).toContain('<style>.btn{color:#fff;background:#0a66c2} p{margin:0}</style>');
    expect(sent).toContain('<p>Hi John, how is {{city}}?</p>');
    // The custom link becomes this lead's unsubscribe link, not click-tracked...
    expect(sent).toMatch(/<a href='[^']*\/api\/unsubscribe\?token=lead-1'>Unsubscribe<\/a>/);
    expect(sent).not.toContain('unsubscribe_url');
    // ...so no second, default unsubscribe footer is added.
    expect(sent).not.toContain('If you no longer wish to receive these emails');
    expect(sent.match(/\/api\/unsubscribe/g)).toHaveLength(1);
    // Other links are still click-tracked, and the open pixel is added.
    expect(sent).toContain('/api/track/click/dispatch-1?url=https%3A%2F%2Fexample.com%2Fdemo');
    expect(sent).toContain('/api/track/open/dispatch-1');
  });

  it('sends lead values escaped, never as $-replacement patterns or spintax, through tracking', () => {
    const tricky = { id: 'lead-2', name: "Ann $' Lee", company: '{Wayne|Stark} Industries' };
    const rendered = renderEmailBody('<p>{{name}} at {{company}}</p>', tricky);
    const sent = applyEmailTracking(rendered.body, 'dispatch-2', rendered.isHtml, false, false, tricky.id);

    expect(sent).toContain('<p>Ann $&#39; Lee at {Wayne|Stark} Industries</p>');
    expect(sent).toContain('If you no longer wish to receive these emails');
  });
});

describe('isHtmlTemplate (M5)', () => {
  it.each([
    '<p>Hi {{firstName}}</p>',
    'We cut costs by <b>30%</b>.',
    'Line one<br>Line two',
    'Line one<BR />Line two',
    'Thanks<hr>',
    '<img src="https://acme.test/logo.png" alt="">',
    '<!DOCTYPE html><html><body>Hi</body></html>',
    '<TABLE><TR><TD>Hi</TD></TR></TABLE>',
  ])('treats %j as HTML', (template) => {
    expect(isHtmlTemplate(template)).toBe(true);
  });

  it.each([
    'Best,\nJane <jane@acme.com>',
    'Hi <First Name>, see <https://acme.test/demo>',
    'Contact <b.smith@acme.test> or <p.jones@acme.test>',
    'If a < b and c > d, {Hi|Hello} {{firstName}}',
    '',
  ])('treats %j as plain text', (template) => {
    expect(isHtmlTemplate(template)).toBe(false);
  });
});

describe('renderEmailBody (M5)', () => {
  const wrap = (body: string) => `<html><head><meta charset="utf-8"></head><body>${body}</body></html>`;

  it('decides HTML from the template, so a plain-text step stays plain text whatever the lead values hold', () => {
    const template = 'Hi {{firstName}} at {{company}},\n\nThanks,\nJane <jane@acme.com>';
    const angled = { name: '<b>Bob</b> Stone', company: 'Smith <Holdings> & Co' };

    expect(renderEmailBody(template, angled)).toEqual({
      isHtml: false,
      body: 'Hi <b>Bob</b> at Smith <Holdings> & Co,\n\nThanks,\nJane <jane@acme.com>',
    });
  });

  it('HTML-escapes lead values in an HTML template and wraps a fragment in a document', () => {
    const template = '<p>Hi {{firstName}} at {{company}}</p><p title="{{name}}">{{jobTitle}}</p>';
    const angled = { name: 'Ann "Nan" O\'Brien', company: 'Smith <Holdings> & Co', jobTitle: '<script>alert(1)</script>' };

    expect(renderEmailBody(template, angled)).toEqual({
      isHtml: true,
      body: wrap('<p>Hi Ann at Smith &lt;Holdings&gt; &amp; Co</p><p title="Ann &quot;Nan&quot; O&#39;Brien">&lt;script&gt;alert(1)&lt;/script&gt;</p>'),
    });
  });

  it('URL-encodes lead values inside href attributes, quoted or not', () => {
    const template = [
      '<a href="https://acme.test/demo?who={{firstName}}&co={{company}}">Book</a>',
      "<a href='mailto:{{email}}'>{{email}}</a>",
      '<a class="x" href=https://acme.test/?c={{company}}>Site</a>',
    ].join('');
    const quoted = { name: "D'Arcy Stone", company: 'Smith & Sons "Ltd"', email: "d'arcy+x@acme.test" };

    expect(renderEmailBody(template, quoted).body).toBe(wrap([
      '<a href="https://acme.test/demo?who=D%27Arcy&co=Smith%20%26%20Sons%20%22Ltd%22">Book</a>',
      "<a href='mailto:d%27arcy%2Bx@acme.test'>d&#39;arcy+x@acme.test</a>",
      '<a class="x" href=https://acme.test/?c=Smith%20%26%20Sons%20%22Ltd%22>Site</a>',
    ].join('')));
  });

  it('keeps {{unsubscribe_url}} and unknown placeholders in hrefs exactly as written', () => {
    const template = '<a href="{{unsubscribe_url}}">Unsubscribe</a><a href="https://acme.test/{{city}}?n={{firstName}}">x</a>';
    expect(renderEmailBody(template, lead).body)
      .toBe(wrap('<a href="{{unsubscribe_url}}">Unsubscribe</a><a href="https://acme.test/{{city}}?n=John">x</a>'));
  });

  it('leaves a body with its own <html> or <body> unwrapped', () => {
    const template = '<!DOCTYPE html><html><body><p>{{company}}</p></body></html>';
    expect(renderEmailBody(template, { company: 'A&B' }).body).toBe('<!DOCTYPE html><html><body><p>A&amp;B</p></body></html>');
  });

  it('keeps a click-tracked link whole when a lead value has a quote or an ampersand', () => {
    const quoted = { id: 'lead-3', name: "D'Arcy Stone", company: 'Smith & Sons' };
    const rendered = renderEmailBody('<a href="https://acme.test/demo?who={{firstName}}&co={{company}}">Book</a>', quoted);
    const sent = applyEmailTracking(rendered.body, 'dispatch-3', rendered.isHtml, false, true, quoted.id);

    expect(sent).toContain(`/api/track/click/dispatch-3?url=${encodeURIComponent('https://acme.test/demo?who=D%27Arcy&co=Smith%20%26%20Sons')}"`);
  });
});

describe('previewEmailBody (M6)', () => {
  it('detects HTML and fills placeholders as a send does, and shows the unsubscribe footer without tracking', () => {
    const template = 'Hi { $json.name },\n\nWe cut costs by <b>30%</b> at {{company}}.';
    const preview = previewEmailBody(template);
    const sent = renderEmailBody(template, PREVIEW_LEAD, firstOption);

    expect(preview.isHtml).toBe(true);
    expect(preview.isHtml).toBe(sent.isHtml);
    expect(preview.body).toContain(sent.body.replace('</body></html>', ''));
    expect(preview.body).toContain('Hi Emily,\n\nWe cut costs by <b>30%</b> at Stark Industries.');
    expect(preview.body).toContain('If you no longer wish to receive these emails, <a href="#unsubscribe"');
    expect(preview.body).not.toContain('/api/track/');
    expect(preview.body).not.toContain('/api/unsubscribe');
  });

  it('points a custom unsubscribe link at #unsubscribe and adds no second footer', () => {
    const preview = previewEmailBody('<p>{Hi|Hello} {{firstName}}</p><a href="{{unsubscribe_url}}">Opt out</a> [[unsubscribe_url]]');

    expect(preview.body).toBe('<html><head><meta charset="utf-8"></head><body><p>Hi Emily</p><a href="#unsubscribe">Opt out</a> #unsubscribe</body></html>');
  });

  it('previews a plain-text step as the text a send gives it, unsubscribe line included (H15)', () => {
    const template = 'Hi {{firstName}},\n\nThanks,\nJane <jane@acme.com>\n';
    expect(previewEmailBody(template)).toEqual({
      isHtml: false,
      body: 'Hi Emily,\n\nThanks,\nJane <jane@acme.com>\n\nUnsubscribe: [unsubscribe link]',
    });
  });

  it('shows a plain-text unsubscribe placeholder as the link and adds no unsubscribe line (H15)', () => {
    expect(previewEmailBody('Hi {{firstName}}. Opt out: {{unsubscribe_url}}')).toEqual({
      isHtml: false,
      body: 'Hi Emily. Opt out: [unsubscribe link]',
    });
  });
});
