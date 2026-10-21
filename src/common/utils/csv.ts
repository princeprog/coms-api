export const CSV_ROW_LIMIT = 50_000;

export type CsvColumn<T> = { header: string; value: (row: T) => unknown };

const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const plainNumber = /^-?\d+(?:\.\d+)?$/;
// Spreadsheet apps run cells starting with these characters as formulas.
const formulaStart = /^[=+\-@\t\r]/;

/** Formats an instant as Manila local time: YYYY-MM-DD HH:mm. */
export function csvDateTime(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  return new Date(date.getTime() + MANILA_OFFSET_MS)
    .toISOString()
    .slice(0, 16)
    .replace('T', ' ');
}

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text: string;
  if (value instanceof Date) text = csvDateTime(value);
  else if (typeof value === 'boolean') text = value ? 'Yes' : 'No';
  else if (Array.isArray(value)) text = value.map(String).join('; ');
  else if (typeof value === 'object') text = JSON.stringify(value);
  else text = String(value as string | number | bigint);
  if (!plainNumber.test(text) && formulaStart.test(text)) text = `'${text}`;
  return /[",\r\n]|^\s|\s$/.test(text)
    ? `"${text.replaceAll('"', '""')}"`
    : text;
}

/** UTF-8 with BOM and CRLF line endings, which Excel opens correctly. */
export function toCsv<T>(columns: CsvColumn<T>[], rows: T[]) {
  const lines = [columns.map((column) => csvCell(column.header)).join(',')];
  for (const row of rows)
    lines.push(columns.map((column) => csvCell(column.value(row))).join(','));
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

/** Turns an enum value such as DINE_IN into "Dine in". */
export function csvLabel(value: string | null | undefined) {
  if (!value) return '';
  const words = value.replaceAll('_', ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
