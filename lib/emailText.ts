/**
 * Converts a stored email body (HTML or plain text) into readable plain text
 * for display in the app. Render the result as a React text child, never as
 * HTML: that is what keeps markup from inbound replies inert, and it means the
 * tracking pixel and tracked links in a sent copy are never loaded or clicked.
 *
 * Pure string work so it runs in both the browser and Node.
 */

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  ndash: '–',
  mdash: '—',
  hellip: '…',
};

function decodeEntities(text: string): string {
  // Single pass, so "&amp;lt;" becomes the literal text "&lt;" rather than "<".
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X'
        ? parseInt(entity.slice(2), 16)
        : parseInt(entity.slice(1), 10);
      const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
      return valid ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

export function emailBodyToText(body?: string | null): string {
  if (!body) return '';
  let text = body;

  // Drop markup whose content is never visible.
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<(head|style|script|title|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');

  // Line breaks and block boundaries become newlines, table cells a space.
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/?(p|div|tr|li|ul|ol|table|blockquote|h[1-6]|hr)\b[^>]*>/gi, '\n');
  text = text.replace(/<\/?(td|th)\b[^>]*>/gi, ' ');

  // Remove every remaining tag (the <img> pixel, <a> wrappers keeping their text).
  // Only strip tag-shaped text so a plain-text "<name@example.com>" survives.
  text = text.replace(/<\/?[a-z][a-z0-9-]*(?:\s(?:[^>"']|"[^"]*"|'[^']*')*)?\/?>/gi, '');
  text = text.replace(/<![^>]*>/g, '');

  text = decodeEntities(text);

  // Tidy the whitespace the markup leaves behind.
  text = text.replace(/[ \t]+/g, ' ');
  text = text.split(/\r?\n/).map(line => line.trim()).join('\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}
