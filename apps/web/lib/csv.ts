/**
 * Small CSV reader/writer for the Contacts import and export flows. Handles
 * what real CRM exports throw at us — quoted fields with "" escapes and
 * embedded newlines, CRLF or bare LF, a UTF-8 BOM, ragged rows — without a
 * dependency: the files reps upload are lists, not warehouses.
 */

export interface ParsedCsv {
  headers: string[];
  /** One object per data row, keyed by header. Blank rows are dropped. */
  rows: Record<string, string>[];
}

/** RFC 4180 with the usual tolerances. */
export function parseCsv(text: string): ParsedCsv {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;

  while (i < src.length) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          quoted = false;
          i += 1;
        }
      } else {
        field += ch;
        i += 1;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i += 1;
    } else if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
    } else if (ch === '\r' || ch === '\n') {
      row.push(field);
      records.push(row);
      row = [];
      field = '';
      i += ch === '\r' && src[i + 1] === '\n' ? 2 : 1;
    } else {
      field += ch;
      i += 1;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    records.push(row);
  }

  const rawHeaders = records.shift() ?? [];
  const headers: string[] = [];
  const seen = new Map<string, number>();
  rawHeaders.forEach((h, idx) => {
    let name = h.trim() || `column_${idx + 1}`;
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    if (count > 0) name = `${name} (${count + 1})`;
    headers.push(name);
  });

  const rows: Record<string, string>[] = [];
  for (const rec of records) {
    if (rec.every((cell) => cell.trim() === '')) continue;
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => {
      obj[h] = (rec[idx] ?? '').trim();
    });
    rows.push(obj);
  }
  return { headers, rows };
}

function csvCell(value: string | number | null | undefined): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CRLF-terminated, quoted where needed — what Excel and Sheets both open cleanly. */
export function toCsv(headers: string[], rows: Array<Array<string | number | null | undefined>>): string {
  return [headers, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** Hand the browser a file to save. */
export function downloadFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('could not read file'));
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.readAsText(file);
  });
}
