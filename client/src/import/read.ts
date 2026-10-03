// Step 1: look at a file, say what it is, and read it into a table. Pure and offline.

import { LIMITS, ImportRefusal, formatBytes } from './limits';
import { delimitedTable, jsonTable, nmapTable } from './formats';
import { parseJson } from './json';
import type { RawTable } from './table';
import { parseXml, type XmlParser } from './xml';

/** Refuse a file by its size before reading it into memory. */
export function checkSize(bytes: number): void {
  if (bytes > LIMITS.bytes) {
    throw new ImportRefusal(`This file is ${formatBytes(bytes)}; the limit is ${formatBytes(LIMITS.bytes)}. Split it and import the parts.`);
  }
}

/** `text` is the whole file. `xml` is injectable for tests; the app uses the browser's DOMParser. */
export function readImport(text: string, opts: { xml?: XmlParser } = {}): RawTable {
  if (text.length > LIMITS.bytes) checkSize(text.length);
  const body = text.replace(/^\uFEFF/, '');
  const first = body.trimStart()[0];
  if (first === undefined) throw new ImportRefusal('This file is empty.');
  if (first === '<') return nmapTable(parseXml(body, opts.xml));
  if (first === '{' || first === '[') return jsonTable(parseJson(body));
  return delimitedTable(body);
}

export async function readFile(file: File, opts: { xml?: XmlParser } = {}): Promise<RawTable> {
  checkSize(file.size);
  return readImport(await file.text(), opts);
}
