import { describe, it, expect } from 'vitest';
import {
  toCsv,
  parseCsv,
  readCsvTable,
  decodeCsvBytes,
  csvColumnLabels,
  matchCsvColumns,
  CsvParseError
} from '../../lib/csv';

describe('toCsv utility', () => {
  it('should serialize basic columns in the specified order', () => {
    const columns = [
      { key: 'name', label: 'Name' },
      { key: 'email', label: 'Email' }
    ];
    const rows = [
      { name: 'John Doe', email: 'john@example.com' },
      { name: 'Jane Smith', email: 'jane@example.com' }
    ];

    const result = toCsv(rows, columns);
    const expected = 'Name,Email\nJohn Doe,john@example.com\nJane Smith,jane@example.com';
    expect(result).toBe(expected);
  });

  it('should escape cells containing commas by wrapping them in double quotes', () => {
    const columns = [
      { key: 'company', label: 'Company' }
    ];
    const rows = [
      { company: 'Acme, Inc.' },
      { company: 'Normal Corp' }
    ];

    const result = toCsv(rows, columns);
    const expected = 'Company\n"Acme, Inc."\nNormal Corp';
    expect(result).toBe(expected);
  });

  it('should escape cells containing double-quotes by doubling them and wrapping in quotes', () => {
    const columns = [
      { key: 'quote', label: 'Quote' }
    ];
    const rows = [
      { quote: 'He said "Hello"' }
    ];

    const result = toCsv(rows, columns);
    const expected = 'Quote\n"He said ""Hello"""';
    expect(result).toBe(expected);
  });

  it('should escape cells containing newlines and carriage returns', () => {
    const columns = [
      { key: 'notes', label: 'Notes' }
    ];
    const rows = [
      { notes: 'Line 1\nLine 2\r\nLine 3' }
    ];

    const result = toCsv(rows, columns);
    const expected = 'Notes\n"Line 1\nLine 2\r\nLine 3"';
    expect(result).toBe(expected);
  });

  it('should coerce null and undefined to empty strings', () => {
    const columns = [
      { key: 'name', label: 'Name' },
      { key: 'title', label: 'Title' }
    ];
    const rows = [
      { name: 'John', title: null },
      { name: 'Jane', title: undefined }
    ];

    const result = toCsv(rows, columns);
    const expected = 'Name,Title\nJohn,\nJane,';
    expect(result).toBe(expected);
  });

  it('should convert Date objects to ISO strings', () => {
    const columns = [
      { key: 'created', label: 'Created At' }
    ];
    const date = new Date('2026-06-19T10:00:00.000Z');
    const rows = [
      { created: date }
    ];

    const result = toCsv(rows, columns);
    const expected = `Created At\n${date.toISOString()}`;
    expect(result).toBe(expected);
  });

  it('should join arrays with semicolons', () => {
    const columns = [
      { key: 'tags', label: 'Tags' }
    ];
    const rows = [
      { tags: ['lead', 'saas', 'interested'] }
    ];

    const result = toCsv(rows, columns);
    const expected = 'Tags\nlead; saas; interested';
    expect(result).toBe(expected);
  });

  it('should handle nested path access', () => {
    const columns = [
      { key: 'lead.email', label: 'Lead Email' },
      { key: 'lead.details.age', label: 'Age' }
    ];
    const rows = [
      {
        lead: {
          email: 'john@example.com',
          details: { age: 30 }
        }
      }
    ];

    const result = toCsv(rows, columns);
    const expected = 'Lead Email,Age\njohn@example.com,30';
    expect(result).toBe(expected);
  });
});

const BOM = String.fromCharCode(0xfeff);
const REPLACEMENT = String.fromCharCode(0xfffd);
const RIGHT_QUOTE = String.fromCharCode(0x2019);

describe('parseCsv', () => {
  it('treats apostrophes as text, keeping every column of O\'Brien and Macy\'s rows', () => {
    expect(parseCsv("Sean,O'Brien,sean@x.com,Acme")).toEqual([['Sean', "O'Brien", 'sean@x.com', 'Acme']]);
    expect(parseCsv("sean@x.com,Sean O'Brien,Macy's,CEO")).toEqual([['sean@x.com', "Sean O'Brien", "Macy's", 'CEO']]);
  });

  it('keeps commas inside double-quoted fields and reads "" as one literal quote', () => {
    expect(parseCsv('"Acme, Inc.",x')).toEqual([['Acme, Inc.', 'x']]);
    expect(parseCsv('"He said ""Hi""",b')).toEqual([['He said "Hi"', 'b']]);
    expect(parseCsv('"",b')).toEqual([['', 'b']]);
  });

  it('keeps line breaks inside quoted fields as part of one record', () => {
    const text = 'email,notes\r\na@x.com,"line 1\r\nline 2"\r\nb@x.com,ok\r\n';
    expect(parseCsv(text)).toEqual([
      ['email', 'notes'],
      ['a@x.com', 'line 1\r\nline 2'],
      ['b@x.com', 'ok']
    ]);
  });

  it('splits records on CRLF, LF and CR without adding a record for the final line break', () => {
    expect(parseCsv('a,b\r\nc,d\ne,f\rg,h\n')).toEqual([['a', 'b'], ['c', 'd'], ['e', 'f'], ['g', 'h']]);
    expect(parseCsv('a,b')).toEqual([['a', 'b']]);
    expect(parseCsv('')).toEqual([]);
  });

  it('keeps empty fields, including a trailing one', () => {
    expect(parseCsv('a,,c\nd,')).toEqual([['a', '', 'c'], ['d', '']]);
  });

  it('drops a leading byte order mark', () => {
    expect(parseCsv(`${BOM}Email,Name\nx@y.com,X`)).toEqual([['Email', 'Name'], ['x@y.com', 'X']]);
  });

  it('keeps a quote that does not open a field as text', () => {
    expect(parseCsv('5" screen,x')).toEqual([['5" screen', 'x']]);
    expect(parseCsv('"a"b,c')).toEqual([['ab', 'c']]);
  });

  it('throws a CsvParseError naming the line where an unclosed quote starts', () => {
    const text = 'email,name\na@x.com,ok\nb@x.com,"Sean\nc@x.com,Pat';
    expect(() => parseCsv(text)).toThrow(CsvParseError);
    try {
      parseCsv(text);
    } catch (err) {
      expect((err as CsvParseError).line).toBe(3);
      expect((err as CsvParseError).message).toContain('line 3');
    }
  });

  it('reads back what toCsv writes', () => {
    const rows = [
      { name: "Sean O'Brien", company: 'Acme, "Inc."', notes: 'Line 1\r\nLine 2' },
      { name: 'José', company: '', notes: 'plain' }
    ];
    const columns = [
      { key: 'name', label: 'Name' },
      { key: 'company', label: 'Company' },
      { key: 'notes', label: 'Notes' }
    ];
    expect(parseCsv(toCsv(rows, columns))).toEqual([
      ['Name', 'Company', 'Notes'],
      ["Sean O'Brien", 'Acme, "Inc."', 'Line 1\r\nLine 2'],
      ['José', '', 'plain']
    ]);
  });
});

describe('readCsvTable', () => {
  it('trims cells and drops blank lines and all-blank rows, including trailing ones', () => {
    const text = '\n Email , Name \r\n a@x.com , Ann \r\n\r\n,,\r\nb@x.com,"Bob "\r\n\r\n\r\n';
    expect(readCsvTable(text)).toEqual({
      headers: ['Email', 'Name'],
      rows: [['a@x.com', 'Ann'], ['b@x.com', 'Bob']]
    });
  });

  it('pads the headers to the widest row so extra columns can be picked', () => {
    expect(readCsvTable('Email\na@x.com,Acme')).toEqual({ headers: ['Email', ''], rows: [['a@x.com', 'Acme']] });
  });

  it('returns no rows for a header-only or empty file', () => {
    expect(readCsvTable('Email,Name\n')).toEqual({ headers: ['Email', 'Name'], rows: [] });
    expect(readCsvTable('')).toEqual({ headers: [], rows: [] });
  });
});

describe('decodeCsvBytes', () => {
  it('reads valid UTF-8 as UTF-8', () => {
    const bytes = new TextEncoder().encode('José Müller,a@x.com');
    expect(decodeCsvBytes(bytes)).toEqual({ text: 'José Müller,a@x.com', encoding: 'utf-8' });
  });

  it('falls back to windows-1252 when the bytes are not valid UTF-8, as Excel writes them', () => {
    // "José Müller,O’Brien" in windows-1252: é = E9, ü = FC, ’ = 92
    const bytes = new Uint8Array([
      0x4a, 0x6f, 0x73, 0xe9, 0x20, 0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72, 0x2c,
      0x4f, 0x92, 0x42, 0x72, 0x69, 0x65, 0x6e
    ]);
    const { text, encoding } = decodeCsvBytes(bytes);
    expect(encoding).toBe('windows-1252');
    expect(text).toBe(`José Müller,O${RIGHT_QUOTE}Brien`);
    expect(text).not.toContain(REPLACEMENT);
  });

  it('drops a UTF-8 byte order mark', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('Email\na@x.com')]);
    expect(decodeCsvBytes(bytes)).toEqual({ text: 'Email\na@x.com', encoding: 'utf-8' });
  });

  it('keeps a file with a UTF-8 byte order mark as UTF-8, marking unreadable bytes', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x4a, 0x6f, 0x73, 0xe9]);
    expect(decodeCsvBytes(bytes)).toEqual({ text: `Jos${REPLACEMENT}`, encoding: 'utf-8' });
  });

  it('reads UTF-16 files by their byte order mark', () => {
    expect(decodeCsvBytes(new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0xe9, 0x00]))).toEqual({ text: 'Aé', encoding: 'utf-16le' });
    expect(decodeCsvBytes(new Uint8Array([0xfe, 0xff, 0x00, 0x41, 0x00, 0xe9]))).toEqual({ text: 'Aé', encoding: 'utf-16be' });
  });

  it('decodes and parses an Excel windows-1252 export end to end', () => {
    // Email,Name,Company / a@x.com,"Müller, José",Macy's
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('Email,Name,Company\r\na@x.com,"M'),
      0xfc,
      ...new TextEncoder().encode('ller, Jos'),
      0xe9,
      ...new TextEncoder().encode('",Macy\'s\r\n')
    ]);
    expect(readCsvTable(decodeCsvBytes(bytes).text)).toEqual({
      headers: ['Email', 'Name', 'Company'],
      rows: [['a@x.com', 'Müller, José', "Macy's"]]
    });
  });
});

describe('csvColumnLabels', () => {
  it('numbers duplicate headers and labels blank ones by column', () => {
    expect(csvColumnLabels(['Email', 'Name', 'email', '', 'Company'])).toEqual([
      'Email (Column 1)',
      'Name',
      'email (Column 3)',
      'Column 4 (No Header)',
      'Company'
    ]);
  });
});

describe('matchCsvColumns', () => {
  it('maps Company Name to Company and Contact Name to Full Name', () => {
    expect(matchCsvColumns(['Email', 'Company Name', 'Contact Name'])).toEqual({
      email: 0,
      company: 1,
      name: 2,
      jobTitle: -1
    });
  });

  it('prefers an exact header name over one that only contains the keyword', () => {
    expect(matchCsvColumns(['Email Opt Out', 'Email', 'Title', 'Job Title']).email).toBe(1);
    expect(matchCsvColumns(['Company Size', 'Company', 'Name']).company).toBe(1);
  });

  it('gives each column to one field only', () => {
    expect(matchCsvColumns(['Business Name', 'First Name', 'Email'])).toEqual({
      email: 2,
      company: 0,
      name: 1,
      jobTitle: -1
    });
    expect(matchCsvColumns(['Contact Email', 'Company']).name).toBe(-1);
    expect(matchCsvColumns(['Contact Email', 'Company']).email).toBe(0);
  });

  it('reads camelCase, snake_case and joined headers', () => {
    expect(matchCsvColumns(['emailAddress', 'job_title', 'companyname', 'FullName'])).toEqual({
      email: 0,
      jobTitle: 1,
      company: 2,
      name: 3
    });
  });

  it('picks the leftmost of duplicate headers and never a blank one', () => {
    expect(matchCsvColumns(['', 'Email', 'Email']).email).toBe(1);
    expect(matchCsvColumns(['', ''])).toEqual({ email: -1, name: -1, company: -1, jobTitle: -1 });
  });

  it('does not take a street Address column for Email', () => {
    expect(matchCsvColumns(['Address', 'Name']).email).toBe(-1);
  });
});
