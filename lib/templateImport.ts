/**
 * Turns uploaded HTML email files into Copy Library templates. Pure string
 * work so it runs in both the browser and Node.
 *
 * A file is imported whole as a step's body: renderEmailBody sends a document
 * that has its own <html> as it is. The step's subject is the text of the
 * file's <title>, and a template made from one file takes the file's name.
 */
import { decodeCsvBytes } from './csv';
import { decodeEntities } from './emailText';

/** An email's HTML is tens of kilobytes; this only stops a wrong file from being read into the page. */
export const MAX_IMPORT_FILE_BYTES = 1024 * 1024;

/** The wait a follow-up step gets unless the import says otherwise, as Add Step gives it. */
export const DEFAULT_IMPORT_WAIT_DAYS = 3;

const HTML_FILE_NAME = /\.html?$/i;
const REPLACEMENT_CHARACTER = '\uFFFD';

/** One uploaded file, read. */
export interface ImportedEmail {
  fileName: string;
  /** The file name without its extension. */
  name: string;
  /** The file's <title> text, or `name` when it has none. */
  subject: string;
  /** False when the file has no <title> text, so the subject is the file's name. */
  subjectFromTitle: boolean;
  /** The whole file as text. */
  body: string;
  /** True when some bytes could not be read and are in the text as U+FFFD. */
  hasUnreadableText: boolean;
}

export type ImportedFile =
  | { ok: true; email: ImportedEmail }
  | { ok: false; fileName: string; reason: string };

/** A sequence step as the Copy Library stores it in Template.steps. */
export interface ImportedStep {
  id: string;
  waitDays: number;
  subject: string;
  body: string;
}

/** The body POST /api/templates takes. */
export interface ImportedTemplate {
  name: string;
  subject: string;
  body: string;
  category: string;
  steps: ImportedStep[];
}

/**
 * The text of the document's <title>, with character references decoded and
 * runs of whitespace as one space. Only the part before <body> is read, with
 * comments removed, so the <title> of an inline SVG or a commented-out one is
 * never taken for the subject.
 */
function titleText(html: string): string {
  const bodyStart = html.search(/<body\b/i);
  const head = (bodyStart === -1 ? html : html.slice(0, bodyStart)).replace(/<!--[\s\S]*?-->/g, '');
  const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(head);
  return match ? decodeEntities(match[1]).replace(/\s+/g, ' ').trim() : '';
}

/**
 * Why a file is refused from its name and size alone, or null when it can be
 * read. The page asks this before it loads a file's bytes.
 */
export function importRefusal(fileName: string, size: number): string | null {
  if (!HTML_FILE_NAME.test(fileName)) return 'Not an .html or .htm file.';
  if (size > MAX_IMPORT_FILE_BYTES) return 'Larger than 1 MB.';
  return null;
}

/**
 * Reads one uploaded file. The bytes are decoded as decodeCsvBytes decodes a
 * CSV: by their byte order mark, else as UTF-8 when valid and windows-1252
 * otherwise. A file that is not .html or .htm, is over MAX_IMPORT_FILE_BYTES
 * or holds no text is refused with the reason.
 */
export function readEmailFile(fileName: string, bytes: Uint8Array): ImportedFile {
  const refusal = importRefusal(fileName, bytes.length);
  if (refusal) {
    return { ok: false, fileName, reason: refusal };
  }
  const { text } = decodeCsvBytes(bytes);
  if (text.trim() === '') {
    return { ok: false, fileName, reason: 'The file is empty.' };
  }
  const name = fileName.replace(HTML_FILE_NAME, '').trim() || fileName;
  const title = titleText(text);
  return {
    ok: true,
    email: {
      fileName,
      name,
      subject: title || name,
      subjectFromTitle: title !== '',
      body: text,
      hasUnreadableText: text.includes(REPLACEMENT_CHARACTER),
    },
  };
}

/** The emails in file-name order, numbers compared as numbers, so "Email 2" comes before "Email 10". */
export function sortImportedEmails(emails: ImportedEmail[]): ImportedEmail[] {
  return [...emails].sort((a, b) => a.fileName.localeCompare(b.fileName, undefined, { numeric: true, sensitivity: 'base' }));
}

/** A whole number of days, 1 at least; a blank or anything that is not a number is the default. */
export function importWaitDays(value: unknown): number {
  const days = typeof value === 'string' && value.trim() === '' ? NaN : Math.floor(Number(value));
  return Number.isFinite(days) ? Math.max(1, days) : DEFAULT_IMPORT_WAIT_DAYS;
}

/**
 * One template whose steps are `emails` in the order given. Step 1 is sent on
 * enrollment, so it has no wait; each later step waits `waitDays` days after
 * the step before it. Null when there are no emails.
 */
export function sequenceTemplate(emails: ImportedEmail[], name: string, category: string, waitDays: unknown): ImportedTemplate | null {
  if (emails.length === 0) return null;
  const wait = importWaitDays(waitDays);
  const steps = emails.map((email, index) => ({
    id: `step-${index + 1}`,
    waitDays: index === 0 ? 0 : wait,
    subject: email.subject,
    body: email.body,
  }));
  return { name: name.trim(), subject: steps[0].subject, body: steps[0].body, category: category.trim(), steps };
}

/** One single-step template per email, named after its file. */
export function separateTemplates(emails: ImportedEmail[], category: string): ImportedTemplate[] {
  return emails.map((email) => ({
    name: email.name,
    subject: email.subject,
    body: email.body,
    category: category.trim(),
    steps: [{ id: 'step-1', waitDays: 0, subject: email.subject, body: email.body }],
  }));
}
