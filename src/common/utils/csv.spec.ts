import { describe, expect, it } from 'vitest';
import { csvCell, csvDateTime, toCsv } from './csv';

describe('csv', () => {
  it('quotes separators, quotes and line breaks', () => {
    expect(csvCell('Rice, 25kg')).toBe('"Rice, 25kg"');
    expect(csvCell('5" pan')).toBe('"5"" pan"');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
  });

  it('neutralizes formula text but keeps negative numbers', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('-cmd')).toBe("'-cmd");
    expect(csvCell('-50.25')).toBe('-50.25');
    expect(csvCell(-3)).toBe('-3');
  });

  it('writes Manila times and a BOM with CRLF rows', () => {
    expect(csvDateTime(new Date('2026-10-21T16:05:00Z'))).toBe(
      '2026-10-22 00:05',
    );
    const csv = toCsv(
      [
        { header: 'Name', value: (row: { name: string }) => row.name },
        { header: 'Active', value: () => true },
      ],
      [{ name: 'Garlic' }],
    );
    expect(csv).toBe('\uFEFFName,Active\r\nGarlic,Yes\r\n');
  });
});
