// CLAUDE.md rule 4: nothing imported is kept until it has passed the redaction gate. Every
// non-empty header and cell goes through `redact` (the wasm engine in the app), none skipped for
// looking harmless. The gate is not reimplemented here. After it come the safety steps: control and
// bidi characters out, and a cell that a spreadsheet would run as a formula kept as text.

import { LIMITS } from './limits';
import type { GatedTable, RawTable } from './table';
import { clip, neutraliseFormula, stripUnsafe } from './text';

export type Redact = (text: string) => Promise<string>;

const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A refused or failed gate throws and nothing is returned, so nothing can be stored unredacted. */
export async function gateTable(
  raw: RawTable,
  redact: Redact,
  opts: { onProgress?: (done: number, total: number) => void } = {},
): Promise<GatedTable> {
  // Identical cells are gated once; the gate looks at one cell at a time, so the answer is the same.
  const cache = new Map<string, string>();
  let neutralised = 0;
  let truncated = 0;
  let calls = 0;
  const total = raw.rows.reduce((n, r) => n + r.length, raw.headers.length);
  let done = 0;

  const one = async (cell: string): Promise<string> => {
    done += 1;
    if (done % 500 === 0) opts.onProgress?.(done, total);
    if (cell.trim() === '') return '';
    let text = stripUnsafe(cell);
    if (text.length > LIMITS.cellChars) {
      text = clip(text, LIMITS.cellChars);
      truncated += 1;
    }
    let gated = cache.get(text);
    if (gated === undefined) {
      gated = await redact(text);
      cache.set(text, gated);
      calls += 1;
      if (calls % 50 === 0) await yieldToUi();
    }
    const clean = stripUnsafe(gated).trim();
    const safe = neutraliseFormula(cell, clean);
    if (safe.changed) neutralised += 1;
    return safe.text;
  };

  const headers: string[] = [];
  for (const h of raw.headers) headers.push((await one(h)).replace(/\s+/g, ' ') || 'column');
  const rows: string[][] = [];
  for (const r of raw.rows) {
    const out: string[] = [];
    for (const c of r) out.push(await one(c));
    rows.push(out);
  }
  opts.onProgress?.(total, total);
  return { kind: raw.kind, label: raw.label, headers, rows, notes: raw.notes, neutralised, truncated } as GatedTable;
}
