import { describe, expect, it } from 'vitest';

import { buildCsv, guardCsvCell } from './csv';

describe('guardCsvCell', () => {
  it('prefixes a cell opening with =, +, -, @, tab or CR', () => {
    expect(guardCsvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(guardCsvCell('+1')).toBe("'+1");
    expect(guardCsvCell('-1')).toBe("'-1");
    expect(guardCsvCell('@cmd')).toBe("'@cmd");
    expect(guardCsvCell('\tcmd')).toBe("'\tcmd");
    expect(guardCsvCell('\rcmd')).toBe("'\rcmd");
  });

  it('checks after leading whitespace (space, NBSP, vertical tab)', () => {
    expect(guardCsvCell('  =1+1')).toBe("'  =1+1");
    expect(guardCsvCell(' =1+1')).toBe("' =1+1");
    expect(guardCsvCell('\u000B=1+1')).toBe("'\u000B=1+1");
  });

  it('checks the full-width forms of the same five signs', () => {
    expect(guardCsvCell('＝1')).toBe("'＝1"); // full-width =
    expect(guardCsvCell('＋1')).toBe("'＋1"); // full-width +
    expect(guardCsvCell('－1')).toBe("'－1"); // full-width -
    expect(guardCsvCell('＠1')).toBe("'＠1"); // full-width @
  });

  it('leaves an ordinary cell alone', () => {
    expect(guardCsvCell('sw-core')).toBe('sw-core');
    expect(guardCsvCell('')).toBe('');
  });
});

describe('buildCsv', () => {
  it('opens with a UTF-8 BOM', () => {
    const bytes = buildCsv([['a', 'b']]);
    expect(bytes[0]).toBe(0xef);
    expect(bytes[1]).toBe(0xbb);
    expect(bytes[2]).toBe(0xbf);
  });

  it('quotes a field carrying a comma, quote or newline', () => {
    const bytes = buildCsv([['a,b', 'say "hi"', 'x\ny']]);
    const text = new TextDecoder().decode(bytes.slice(3));
    expect(text).toBe('"a,b","say ""hi""","x\ny"\r\n');
  });

  it('joins rows with CRLF and guards a dangerous cell inline', () => {
    const bytes = buildCsv([
      ['name', 'note'],
      ['sw-core', '=1+1'],
    ]);
    const text = new TextDecoder().decode(bytes.slice(3));
    expect(text).toBe('name,note\r\nsw-core,\'=1+1\r\n');
  });

  it('cleans forbidden characters before quoting', () => {
    const bytes = buildCsv([['a\u0000b']]);
    const text = new TextDecoder().decode(bytes.slice(3));
    expect(text).toBe('ab\r\n');
  });
});
