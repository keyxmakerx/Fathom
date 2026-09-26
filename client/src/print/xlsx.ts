// The cut sheet's .xlsx download — a minimal OOXML spreadsheet, one
// worksheet, inline strings only (never a formula, never a shared-string
// table). Built with `zip.ts`'s own stored writer; no new dependency.
import { cleanExportText } from './textClean';
import { writeStoredZip, type ZipEntry } from './zip';

export interface XlsxCell {
  text: string;
  bold?: boolean;
}

export type XlsxRow = readonly XlsxCell[];

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** `A`, `B`, ..., `Z`, `AA`, `AB`, ... — a 1-based spreadsheet column index
 * to its letters. */
function columnLetters(indexFromZero: number): string {
  let n = indexFromZero + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function sanitiseSheetName(name: string): string {
  // Excel's own rules: no : \ / ? * [ ], 31 characters at most.
  const stripped = name.replace(/[:\\/?*[\]]/g, ' ').trim();
  const named = stripped.length > 0 ? stripped : 'Sheet1';
  return named.slice(0, 31);
}

function worksheetXml(rows: readonly XlsxRow[]): string {
  const rowsXml = rows
    .map((row, rowIndex) => {
      const r = rowIndex + 1;
      const cellsXml = row
        .map((cell, colIndex) => {
          const ref = `${columnLetters(colIndex)}${r}`;
          const text = xmlEscape(cleanExportText(cell.text));
          const style = cell.bold ? ' s="1"' : '';
          return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${text}</t></is></c>`;
        })
        .join('');
      return `<row r="${r}">${cellsXml}</row>`;
    })
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetData>${rowsXml}</sheetData>` +
    '</worksheet>'
  );
}

const CONTENT_TYPES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
  '</Types>';

const ROOT_RELS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  '</Relationships>';

const WORKBOOK_RELS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  '</Relationships>';

const STYLES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border/></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="2">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '</cellXfs>' +
  '</styleSheet>';

function workbookXml(sheetName: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets><sheet name="${xmlEscape(sanitiseSheetName(sheetName))}" sheetId="1" r:id="rId1"/></sheets>` +
    '</workbook>'
  );
}

/** One worksheet, a header row, bold device header rows — brief item 5. */
export function buildXlsx(sheetName: string, rows: readonly XlsxRow[]): Uint8Array {
  const enc = (s: string) => new TextEncoder().encode(s);
  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: enc(CONTENT_TYPES_XML) },
    { name: '_rels/.rels', data: enc(ROOT_RELS_XML) },
    { name: 'xl/workbook.xml', data: enc(workbookXml(sheetName)) },
    { name: 'xl/_rels/workbook.xml.rels', data: enc(WORKBOOK_RELS_XML) },
    { name: 'xl/styles.xml', data: enc(STYLES_XML) },
    { name: 'xl/worksheets/sheet1.xml', data: enc(worksheetXml(rows)) },
  ];
  return writeStoredZip(entries);
}
