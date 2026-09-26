import { describe, expect, it } from 'vitest';

import { readStoredZip } from './zip';
import { buildXlsx } from './xlsx';

function partText(zipBytes: Uint8Array, name: string): string {
  const entries = readStoredZip(zipBytes);
  const entry = entries.find((e) => e.name === name);
  if (!entry) throw new Error(`no part named ${name}`);
  return new TextDecoder().decode(entry.data);
}

describe('buildXlsx', () => {
  it('is a stored zip carrying the required OOXML parts', () => {
    const bytes = buildXlsx('Cut sheet', [[{ text: 'Port' }, { text: 'Far end' }]]);
    const names = readStoredZip(bytes).map((e) => e.name);
    expect(names).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
    ]);
  });

  it('writes every row and cell as an inline string, never a formula', () => {
    const bytes = buildXlsx('Cut sheet', [
      [{ text: 'Port', bold: true }, { text: 'Far end', bold: true }],
      [{ text: 'Et1' }, { text: 'sw-core Et2' }],
    ]);
    const sheet = partText(bytes, 'xl/worksheets/sheet1.xml');
    expect(sheet).toContain('<row r="1">');
    expect(sheet).toContain('<c r="A1" t="inlineStr" s="1"><is><t xml:space="preserve">Port</t></is></c>');
    expect(sheet).toContain('<c r="B1" t="inlineStr" s="1"><is><t xml:space="preserve">Far end</t></is></c>');
    expect(sheet).toContain('<row r="2">');
    expect(sheet).toContain('<c r="A2" t="inlineStr"><is><t xml:space="preserve">Et1</t></is></c>');
    expect(sheet).not.toContain('<f>');
  });

  it('cleans forbidden characters and never leaves an unescaped ampersand', () => {
    const bytes = buildXlsx('Cut sheet', [[{ text: 'a\u0000b & c' }]]);
    const sheet = partText(bytes, 'xl/worksheets/sheet1.xml');
    expect(sheet).toContain('ab &amp; c');
    expect(sheet).not.toContain('\u0000');
  });

  it('does NOT csv-guard a leading "=" — an inline string is never a formula', () => {
    const bytes = buildXlsx('Cut sheet', [[{ text: '=1+1' }]]);
    const sheet = partText(bytes, 'xl/worksheets/sheet1.xml');
    expect(sheet).toContain('<t xml:space="preserve">=1+1</t>');
  });

  it('names the one worksheet in the workbook part', () => {
    const bytes = buildXlsx('Cut sheet', []);
    const workbook = partText(bytes, 'xl/workbook.xml');
    expect(workbook).toContain('<sheet name="Cut sheet" sheetId="1" r:id="rId1"/>');
  });

  it('gives a device header row (bold=true) style index 1, an ordinary row style index 0 or none', () => {
    const bytes = buildXlsx('Cut sheet', [[{ text: 'fw-01', bold: true }], [{ text: 'igc0' }]]);
    const sheet = partText(bytes, 'xl/worksheets/sheet1.xml');
    expect(sheet).toContain('<c r="A1" t="inlineStr" s="1">');
    expect(sheet).toContain('<c r="A2" t="inlineStr">');
    expect(sheet).not.toContain('<c r="A2" t="inlineStr" s="1">');
  });

  it('round-trips through readStoredZip with valid CRC-32 on every part', () => {
    const bytes = buildXlsx('Cut sheet', [[{ text: 'x' }]]);
    // readStoredZip itself throws on a CRC mismatch — reaching a result at
    // all is the proof.
    expect(readStoredZip(bytes)).toHaveLength(6);
  });
});
