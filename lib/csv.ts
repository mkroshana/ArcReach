import { parseLeadEmail } from './leadEmail';

/**
 * Escapes a cell value according to RFC-4180 CSV specifications.
 * If the value contains double-quotes, commas, newlines (\n), or carriage returns (\r),
 * it will be wrapped in double quotes and any internal double quotes will be doubled.
 */
function escapeCell(val: any): string {
  if (val === null || val === undefined) {
    return '';
  }

  let str = '';
  if (val instanceof Date) {
    str = val.toISOString();
  } else if (Array.isArray(val)) {
    str = val.map(v => (typeof v === 'object' ? JSON.stringify(v) : String(v))).join('; ');
  } else if (typeof val === 'object') {
    str = JSON.stringify(val);
  } else {
    str = String(val);
  }

  const needsQuotes = /["\n\r,]/.test(str);
  const escaped = str.replace(/"/g, '""');

  if (needsQuotes) {
    return `"${escaped}"`;
  }
  return escaped;
}

/**
 * Traverses a nested object by path (e.g. "lead.email") to get the value.
 */
function getValueByPath(obj: any, path: string): any {
  if (!obj) return undefined;
  return path.split('.').reduce((acc, part) => acc && acc[part], obj);
}

/**
 * Converts an array of row objects into a CSV string using specified columns.
 */
export function toCsv(
  rows: Record<string, any>[],
  columns: { key: string; label: string }[]
): string {
  const headerRow = columns.map(col => escapeCell(col.label)).join(',');
  const dataRows = rows.map(row => {
    return columns.map(col => {
      // Allow key to be a nested path (e.g. "lead.email") or a direct property
      const val = col.key.includes('.') ? getValueByPath(row, col.key) : row[col.key];
      return escapeCell(val);
    }).join(',');
  });
  return [headerRow, ...dataRows].join('\n');
}

/**
 * Triggers a client-side browser download for a CSV string.
 * Prepends the UTF-8 Byte Order Mark (BOM) so Excel reads international characters correctly.
 */
export function downloadCsv(filename: string, csvContent: string): void {
  if (typeof window === 'undefined') return;

  const bom = '\uFEFF';
  const blob = new Blob([bom + csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/** Thrown by parseCsv when a quoted field is still open at the end of the text. */
export class CsvParseError extends Error {
  constructor(message: string, readonly line: number) {
    super(message);
    this.name = 'CsvParseError';
  }
}

/**
 * Parses CSV text into records per RFC 4180. Fields are separated by commas and records
 * by CRLF, LF or CR. Only a double quote at the start of a field quotes it (an apostrophe
 * is ordinary text); a quoted field may hold commas and line breaks, and "" inside it is
 * one literal quote. A quote anywhere else, and text between a closing quote and the next
 * comma, is kept as text. A leading byte order mark is dropped, and a final line break
 * does not start another record.
 */
export function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let atFieldStart = true;
  let inQuotes = false;
  let line = 1;
  let quoteLine = 1;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
        continue;
      }
      if (ch === '\n' || (ch === '\r' && text[i + 1] !== '\n')) line++;
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && atFieldStart) {
      inQuotes = true;
      quoteLine = line;
      atFieldStart = false;
      i++;
    } else if (ch === ',') {
      record.push(field);
      field = '';
      atFieldStart = true;
      i++;
    } else if (ch === '\r' || ch === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      atFieldStart = true;
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      line++;
    } else {
      field += ch;
      atFieldStart = false;
      i++;
    }
  }

  if (inQuotes) {
    throw new CsvParseError(`the quoted field that starts on line ${quoteLine} is never closed`, quoteLine);
  }
  if (!atFieldStart || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

export interface CsvTable {
  headers: string[];
  rows: string[][];
}

/**
 * The header row and data rows of CSV text, every cell trimmed. Rows whose cells are all
 * blank (blank lines, Excel's trailing ",,,") are dropped, and the headers are padded
 * with blanks to the widest row so every column can be picked.
 */
export function readCsvTable(text: string): CsvTable {
  const records = parseCsv(text)
    .map(record => record.map(cell => cell.trim()))
    .filter(record => record.some(cell => cell !== ''));
  const [headers = [], ...rows] = records;
  let width = headers.length;
  for (const row of rows) {
    if (row.length > width) width = row.length;
  }
  while (headers.length < width) headers.push('');
  return { headers, rows };
}

export type CsvEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';

/**
 * Text of an uploaded CSV file. A UTF-16 or UTF-8 byte order mark picks that encoding
 * (bytes it can't read become U+FFFD); without one the bytes are read as UTF-8 when they
 * are valid UTF-8 and as windows-1252 otherwise, the encoding Excel's "CSV (Comma
 * delimited)" writes on Western-language Windows. The byte order mark is dropped.
 */
export function decodeCsvBytes(bytes: Uint8Array): { text: string; encoding: CsvEncoding } {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(bytes), encoding: 'utf-16le' };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(bytes), encoding: 'utf-16be' };
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8' };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252' };
  }
}

/**
 * A distinct label for each CSV column: its header, with its column number added when
 * another column has the same header, or "Column N (No Header)" when it is blank.
 */
export function csvColumnLabels(headers: string[]): string[] {
  const counts = new Map<string, number>();
  for (const header of headers) {
    const key = header.toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return headers.map((header, i) => {
    if (!header) return `Column ${i + 1} (No Header)`;
    return (counts.get(header.toLowerCase()) || 0) > 1 ? `${header} (Column ${i + 1})` : header;
  });
}

export type CsvLeadField = 'email' | 'name' | 'company' | 'jobTitle';

/** The CSV column index picked for each lead field, -1 when none is. */
export type CsvColumnMapping = Record<CsvLeadField, number>;

// Header names that mean a field outright, and words that suggest it, as csvHeaderWords writes them
const CSV_FIELD_NAMES: Record<CsvLeadField, { exact: string[]; words: string[] }> = {
  email: {
    exact: ['email', 'e mail', 'mail', 'email address', 'e mail address', 'emailaddress'],
    words: ['email', 'e mail', 'mail'],
  },
  company: {
    exact: ['company', 'company name', 'companyname', 'organization', 'organisation', 'organization name', 'organisation name', 'org', 'business', 'business name', 'brand'],
    words: ['company', 'organization', 'organisation', 'org', 'business', 'brand'],
  },
  jobTitle: {
    exact: ['title', 'job title', 'jobtitle', 'job', 'role', 'position'],
    words: ['title', 'job', 'role', 'position'],
  },
  name: {
    exact: ['name', 'full name', 'fullname', 'contact name', 'contact', 'person', 'contact person'],
    words: ['name', 'contact', 'person'],
  },
};

// On equal matches the field listed first wins, so "Company Name" is Company rather than Full Name
const CSV_FIELD_ORDER: CsvLeadField[] = ['email', 'company', 'jobTitle', 'name'];

/** A header as lowercase words: "JobTitle", "job_title" and "Job Title" all become "job title". */
function csvHeaderWords(header: string): string {
  return header
    .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** 3 for an exact header name, 2 for a whole-word match, 1 for a keyword inside a word, else 0. */
function csvHeaderScore(words: string, names: { exact: string[]; words: string[] }): number {
  if (!words) return 0;
  if (names.exact.includes(words)) return 3;
  const padded = ` ${words} `;
  if (names.words.some(word => padded.includes(` ${word} `))) return 2;
  const joined = words.replace(/ /g, '');
  if (names.words.some(word => joined.includes(word.replace(/ /g, '')))) return 1;
  return 0;
}

/**
 * Picks a column for each lead field from the CSV headers, best match first: exact header
 * names, then whole words, then keywords inside a word. Each column goes to one field at
 * most, and on equal matches the leftmost column wins.
 */
export function matchCsvColumns(headers: string[]): CsvColumnMapping {
  const candidates: { field: CsvLeadField; column: number; score: number; rank: number }[] = [];
  headers.forEach((header, column) => {
    const words = csvHeaderWords(header);
    CSV_FIELD_ORDER.forEach((field, rank) => {
      const score = csvHeaderScore(words, CSV_FIELD_NAMES[field]);
      if (score > 0) candidates.push({ field, column, score, rank });
    });
  });
  candidates.sort((a, b) => b.score - a.score || a.rank - b.rank || a.column - b.column);

  const mapping: CsvColumnMapping = { email: -1, name: -1, company: -1, jobTitle: -1 };
  const used = new Set<number>();
  for (const { field, column } of candidates) {
    if (mapping[field] !== -1 || used.has(column)) continue;
    mapping[field] = column;
    used.add(column);
  }
  return mapping;
}

/** The lead fields one CSV data row imports. */
export interface CsvRowLead {
  email: string;
  name: string | null;
  company: string | null;
  jobTitle: string | null;
}

/**
 * The lead in a CSV data row, or null when its Email cell is not one valid address
 * (see parseLeadEmail). The email is stored trimmed and lowercased. A Name, Company or
 * Job Title that is unmapped or blank is null, never a stand-in value, so templates
 * use their own fallback for it.
 */
export function csvRowLead(row: string[], mapping: CsvColumnMapping): CsvRowLead | null {
  const email = parseLeadEmail(mapping.email === -1 ? '' : row[mapping.email]);
  if (!email) return null;
  const cell = (column: number) => (column === -1 ? '' : (row[column] ?? '').trim()) || null;
  return { email, name: cell(mapping.name), company: cell(mapping.company), jobTitle: cell(mapping.jobTitle) };
}

/** The data rows of a CSV import, sorted into the leads to send and the rows skipped. */
export interface CsvImportPlan {
  /** One lead per address, in file order: the first row with an address wins. */
  leads: CsvRowLead[];
  /** Rows whose Email cell is blank or unmapped. */
  blank: number;
  /** Email cells that are not one valid address, trimmed, as the file has them. */
  invalid: string[];
  /** Rows repeating the address of an earlier row, under any capitalisation. */
  duplicate: number;
}

/**
 * Sorts `rows` into the leads the import sends and the rows it skips, so the
 * page can say before the import which rows will not be imported, and count
 * them in its result. Repeats are dropped across the whole file here, since a
 * repeat in a later batch would otherwise come back as already in the CRM.
 */
export function planCsvImport(rows: string[][], mapping: CsvColumnMapping): CsvImportPlan {
  const plan: CsvImportPlan = { leads: [], blank: 0, invalid: [], duplicate: 0 };
  const seen = new Set<string>();
  for (const row of rows) {
    const lead = csvRowLead(row, mapping);
    if (!lead) {
      const value = mapping.email === -1 ? '' : (row[mapping.email] ?? '').trim();
      if (value === '') plan.blank++;
      else plan.invalid.push(value);
    } else if (seen.has(lead.email)) {
      plan.duplicate++;
    } else {
      seen.add(lead.email);
      plan.leads.push(lead);
    }
  }
  return plan;
}
