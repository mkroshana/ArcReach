import { describe, it, expect } from 'vitest';
import { toCsv } from '../../lib/csv';

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
