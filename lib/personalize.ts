/**
 * Mail-merge for campaign emails. The send engine and every editor preview use
 * personalizeEmail, so a preview shows what a lead will receive. Pure string
 * work so it runs in both the browser and Node.
 *
 * The order matters:
 * 1. {{...}} placeholders (and the legacy single-brace { $json.name } forms)
 *    are resolved on the template. Unknown ones, including {{unsubscribe_url}}
 *    which applyEmailTracking fills in, are kept exactly as written.
 * 2. Spintax runs on the template text only. A brace group is spintax only when
 *    it contains '|', and <style> and <script> blocks are never touched, so CSS
 *    rules and scripts survive.
 * 3. Lead values go in last, verbatim, so a value is never read as spintax or
 *    as a $-replacement pattern.
 */

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

/**
 * Fills a subject or body template for one lead: {{firstName}}, {{name}},
 * {{company}}, {{jobTitle}}, {{email}} and the n8n {{ $json.name }} forms, then
 * resolves {A|B} spintax with `pickOption` (a random option by default).
 */
export function personalizeEmail(template: string, lead: PersonalizationLead, pickOption: PickOption = randomOption): string {
  if (!template) return '';

  const values: string[] = [];
  const slotted = template.replace(PLACEHOLDER, (match, expr: string | undefined, legacyExpr: string | undefined) => {
    values.push(placeholderValue(expr ?? legacyExpr ?? '', lead) ?? match);
    return `\uE000${values.length - 1}\uE001`;
  });

  return spinOutsideRawText(slotted, pickOption).replace(SLOT, (_match, index: string) => values[Number(index)]);
}

/** The sample contact the template and campaign editors preview with. */
export const PREVIEW_LEAD: PersonalizationLead = {
  name: 'Emily Carter',
  company: 'Stark Industries',
  jobTitle: 'VP of Marketing',
  email: 'emily@starkindustries.com',
};

/**
 * An editor preview of a template: personalised for PREVIEW_LEAD with the first
 * spintax option, and unsubscribe links pointed at '#unsubscribe'.
 */
export function personalizePreview(template: string): string {
  return personalizeEmail(template, PREVIEW_LEAD, () => 0)
    .replace(/\[\[\s*unsubscribe_url\s*\]\]/gi, '#unsubscribe')
    .replace(/\{\{\s*unsubscribe_url\s*\}\}/gi, '#unsubscribe');
}
