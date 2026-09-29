import { describe, it, expect } from 'vitest';
import { personalizeEmail, personalizePreview } from '../../lib/personalize';
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
  it('previews for the sample contact with the first spintax option and a placeholder unsubscribe link', () => {
    const template = '<a href="{{unsubscribe_url}}">x</a> [[unsubscribe_url]] {A|B} {{firstName}} {{name}} {{city}} <style>.b{c:d}</style>';
    expect(personalizePreview(template))
      .toBe('<a href="#unsubscribe">x</a> #unsubscribe A Emily Emily Carter {{city}} <style>.b{c:d}</style>');
  });
});

describe('template -> personalizeEmail -> applyEmailTracking (H22)', () => {
  const template = [
    '<html><head><style>.btn{color:#fff;background:#0a66c2} p{margin:0}</style></head><body>',
    '<p>{Hi|Hello} {{firstName}}, how is {{city}}?</p>',
    '<a class="btn" href="https://example.com/demo">Book</a>',
    "<p><a href='{{unsubscribe_url}}'>Unsubscribe</a></p>",
    '</body></html>',
  ].join('');

  it('keeps the styling, the custom unsubscribe link and unknown fields through tracking', () => {
    const sent = applyEmailTracking(personalizeEmail(template, lead, firstOption), 'dispatch-1', true, true, true, lead.id);

    expect(sent).toContain('<style>.btn{color:#fff;background:#0a66c2} p{margin:0}</style>');
    expect(sent).toContain('<p>Hi John, how is {{city}}?</p>');
    // The custom link becomes this lead's unsubscribe link, not click-tracked...
    expect(sent).toMatch(/<a href='[^']*\/api\/unsubscribe\?id=lead-1'>Unsubscribe<\/a>/);
    expect(sent).not.toContain('unsubscribe_url');
    // ...so no second, default unsubscribe footer is added.
    expect(sent).not.toContain('If you no longer wish to receive these emails');
    expect(sent.match(/\/api\/unsubscribe/g)).toHaveLength(1);
    // Other links are still click-tracked, and the open pixel is added.
    expect(sent).toContain('/api/track/click/dispatch-1?url=https%3A%2F%2Fexample.com%2Fdemo');
    expect(sent).toContain('/api/track/open/dispatch-1');
  });

  it('sends lead values verbatim through tracking', () => {
    const tricky = { id: 'lead-2', name: "Ann $' Lee", company: '{Wayne|Stark} Industries' };
    const sent = applyEmailTracking(personalizeEmail('<p>{{name}} at {{company}}</p>', tricky), 'dispatch-2', true, false, false, tricky.id);

    expect(sent).toContain("<p>Ann $' Lee at {Wayne|Stark} Industries</p>");
    expect(sent).toContain('If you no longer wish to receive these emails');
  });
});
