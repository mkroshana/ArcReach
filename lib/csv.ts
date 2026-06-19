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
