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

  it('checks after any leading Unicode whitespace', () => {
    expect(guardCsvCell('  =1+1')).toBe("'  =1+1");
    expect(guardCsvCell('\u00A0=1+1')).toBe("'\u00A0=1+1"); // no-break space
    expect(guardCsvCell('\u000B=1+1')).toBe("'\u000B=1+1"); // vertical tab
    expect(guardCsvCell('\u2003=1+1')).toBe("'\u2003=1+1"); // em space
    expect(guardCsvCell('\u3000=1+1')).toBe("'\u3000=1+1"); // ideographic space
    expect(guardCsvCell('\uFEFF=1+1')).toBe("'\uFEFF=1+1"); // BOM / zero-width no-break space
    expect(guardCsvCell('\n=1+1')).toBe("'\n=1+1"); // a leading newline
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

  it('cuts to 32,767 characters AFTER the guard quote, never 32,768', () => {
    const raw = '=' + 'a'.repeat(32_766); // 32,767 chars, all dangerous-leading
    const bytes = buildCsv([[raw]]);
    const text = new TextDecoder().decode(bytes.slice(3));
    const cell = text.slice(0, text.length - 2); // drop the trailing CRLF
    expect(cell.length).toBe(32_767);
    expect(cell[0]).toBe("'");
  });
});
