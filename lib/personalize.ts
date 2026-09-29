/**
 * Mail-merge for campaign emails. The send engine and every editor preview use
 * personalizeEmail and renderEmailBody, so a preview shows what a lead will
 * receive. Pure string work so it runs in both the browser and Node.
 *
 * The order matters:
 * 1. {{...}} placeholders (and the legacy single-brace { $json.name } forms)
 *    are resolved on the template. Unknown ones, including {{unsubscribe_url}}
 *    which applyEmailTracking fills in, are kept exactly as written.
 * 2. Spintax runs on the template text only. A brace group is spintax only when
 *    it contains '|', and <style> and <script> blocks are never touched, so CSS
 *    rules and scripts survive.
 * 3. Lead values go in last, so a value is never read as spintax or as a
 *    $-replacement pattern. In an HTML body they are HTML-escaped, and
 *    URL-encoded inside href attributes; anywhere else they go in verbatim.
 */
import { applyEmailTracking, unsubscribeUrl } from './emailTracking';

/** The lead fields a template can use. */
export type PersonalizationLead = {
  name?: string | null;
  firstName?: string | null;
  company?: string | null;
  jobTitle?: string | null;
  email?: string | null;
};

/** Picks which of `count` spintax options to use, by index. */
export type PickOption = (count: number) => number;

const randomOption: PickOption = (count) => Math.floor(Math.random() * count);

// {{ anything }}, or the legacy single-brace { $json.name || 'fallback' } and
// { $json.company } forms. A slot character already in the template is taken
// too, so it is kept as written and never read as a slot.
const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}|\{\s*(\$json\.(?:name|company)\s*(?:\|\|\s*'[^']*')?)\s*\}|[\uE000\uE001]/g;
const JSON_FIELD = /^\$json\.(name|company)\s*(?:\|\|\s*'([^']*)')?$/;

// While spintax runs, each placeholder stands in the text as a numbered slot
// between private-use characters, which contain no braces or '|'.
const SLOT = /\uE000(\d+)\uE001/g;

// An innermost brace group with a '|' in it. Groups resolve innermost first,
// so {A|{B|C}} works; a group with no '|', such as a CSS rule, is left alone.
const SPINTAX = /\{([^{}]*\|[^{}]*)\}/g;
const RAW_TEXT_BLOCK = /<(style|script)\b[\s\S]*?(?:<\/\1\s*>|$)/gi;

// A doctype, a closing tag, or a <br>, <hr> or <img> tag. Bracketed text in a
// plain-text email, like 'Jane <jane@acme.com>' or '<Company Name>', is none of these.
const HTML_MARKUP = /<!doctype\s+html\b|<\/[a-z][a-z0-9]*\s*>|<(?:br|hr|img)(?=[\s/>])[^<>]*>/i;

// An href attribute's value, quoted or not.
const HREF_VALUE = /(\shref\s*=\s*)("[^"]*"|'[^']*'|[^\s"'<>`]+)/gi;

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

// Every reserved character is encoded, including the !'()* encodeURIComponent
// leaves, so a value can't end a quoted href or split a query. '@' is kept so
// mailto:{{email}} still reads as an address.
function encodeUrlValue(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%40/g, '@');
}

function firstWord(fullName: string | null | undefined): string {
  return fullName ? fullName.trim().split(/\s+/)[0] : '';
}

/** The value for a placeholder expression, or null when it is not one we fill. */
function placeholderValue(expr: string, lead: PersonalizationLead): string | null {
  const firstName = (fallback: string) => firstWord(lead.name || lead.firstName) || fallback;
  switch (expr) {
    case 'firstName': return firstName('there');
    case 'company': return lead.company || 'your company';
    case 'name': return lead.name || 'there';
    case 'jobTitle': return lead.jobTitle || 'professional';
    case 'email': return lead.email || '';
  }
  // n8n style: $json.name, $json.company, optionally with || 'fallback'
  const json = JSON_FIELD.exec(expr);
  if (json) {
    const fallback = json[2];
    return json[1] === 'name' ? firstName(fallback || 'there') : lead.company || fallback || 'your company';
  }
  return null;
}

function spin(text: string, pickOption: PickOption): string {
  let result = text;
  let previous: string;
  do {
    previous = result;
    result = result.replace(SPINTAX, (_match, options: string) => {
      const choices = options.split('|');
      return choices[pickOption(choices.length)] ?? '';
    });
  } while (result !== previous);
  return result;
}

/** Resolves spintax everywhere except inside <style> and <script> blocks. */
function spinOutsideRawText(text: string, pickOption: PickOption): string {
  let result = '';
  let last = 0;
  for (const block of text.matchAll(RAW_TEXT_BLOCK)) {
    result += spin(text.slice(last, block.index), pickOption) + block[0];
    last = block.index + block[0].length;
  }
  return result + spin(text.slice(last), pickOption);
}

/** Fills a template for one lead, escaping the values for HTML when `html` is set. */
function fill(template: string, lead: PersonalizationLead, pickOption: PickOption, html: boolean): string {
  if (!template) return '';

  // `kept` marks text kept exactly as written: unknown placeholders and slot characters.
  const slots: { text: string; kept: boolean }[] = [];
  const slotted = template.replace(PLACEHOLDER, (match, expr: string | undefined, legacyExpr: string | undefined) => {
    const value = placeholderValue(expr ?? legacyExpr ?? '', lead);
    slots.push(value === null ? { text: match, kept: true } : { text: value, kept: false });
    return `\uE000${slots.length - 1}\uE001`;
  });
  const spun = spinOutsideRawText(slotted, pickOption);

  const hrefs = html
    ? [...spun.matchAll(HREF_VALUE)].map((m) => [m.index + m[1].length, m.index + m[0].length])
    : [];
  return spun.replace(SLOT, (_match, index: string, offset: number) => {
    const slot = slots[Number(index)];
    if (!html || slot.kept) return slot.text;
    return hrefs.some(([start, end]) => offset >= start && offset < end) ? encodeUrlValue(slot.text) : escapeHtml(slot.text);
  });
}

/**
 * Fills a subject or plain-text body template for one lead: {{firstName}},
 * {{name}}, {{company}}, {{jobTitle}}, {{email}} and the n8n {{ $json.name }}
 * forms, then resolves {A|B} spintax with `pickOption` (a random option by
 * default). Values go in verbatim; use renderEmailBody for a step body.
 */
export function personalizeEmail(template: string, lead: PersonalizationLead, pickOption: PickOption = randomOption): string {
  return fill(template, lead, pickOption, false);
}

/**
 * Whether a body template is HTML. Decided from the template, never the
 * personalised text, so a lead's values can't change how their email is sent.
 */
export function isHtmlTemplate(template: string): boolean {
  return HTML_MARKUP.test(template);
}

/**
 * The body a step sends to one lead, before tracking. An HTML template has the
 * lead's values escaped and is wrapped in a document unless it has its own
 * <html> or <body>; a plain-text template is sent as text with values verbatim.
 */
export function renderEmailBody(
  template: string,
  lead: PersonalizationLead,
  pickOption: PickOption = randomOption
): { isHtml: boolean; body: string } {
  const isHtml = isHtmlTemplate(template);
  const body = fill(template, lead, pickOption, isHtml);
  if (!isHtml || body.toLowerCase().includes('<html') || body.toLowerCase().includes('<body')) {
    return { isHtml, body };
  }
  return { isHtml, body: `<html><head><meta charset="utf-8"></head><body>${body}</body></html>` };
}

/** The sample contact the template and campaign editors preview with. */
export const PREVIEW_LEAD: PersonalizationLead = {
  name: 'Emily Carter',
  company: 'Stark Industries',
  jobTitle: 'VP of Marketing',
  email: 'emily@starkindustries.com',
};

// The lead id previews render unsubscribe links for, before they become '#unsubscribe'.
const PREVIEW_LEAD_ID = 'preview';

/** An editor preview of a subject line: as sent to PREVIEW_LEAD, with the first spintax option. */
export function personalizePreview(template: string): string {
  return personalizeEmail(template, PREVIEW_LEAD, () => 0);
}

/**
 * An editor preview of a step body: rendered for PREVIEW_LEAD with the first
 * spintax option exactly as a send renders it, unsubscribe footer included, but
 * without the open pixel or click-tracking redirects, which only work for a
 * real dispatch. Unsubscribe links point at '#unsubscribe'. Show an HTML body
 * only in a sandboxed iframe without allow-scripts, and a plain-text one as text.
 */
export function previewEmailBody(template: string): { isHtml: boolean; body: string } {
  const { isHtml, body } = renderEmailBody(template, PREVIEW_LEAD, () => 0);
  const tracked = applyEmailTracking(body, PREVIEW_LEAD_ID, isHtml, false, false, PREVIEW_LEAD_ID);
  return { isHtml, body: tracked.split(unsubscribeUrl(PREVIEW_LEAD_ID)).join('#unsubscribe') };
}
