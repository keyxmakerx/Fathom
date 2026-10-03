// Pasted text is gated by the REAL wasm engine (no stand-in): a box, a spreadsheet row, and the
// header-less row whose keyword and secret sit in different cells.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { Engine } from '../../engine/engine';
import { fileLoader } from '../../engine/wasm';
import { gatedInsert, oneLine, spliceAt, type Redact } from '../paste/gatedPaste';
import { gatePastedTable, parseTable, planPaste, splitRowNote, withoutUntickedSplitRows } from './paste';
import type { Column } from './kinds';

const WASM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../public/engine/fathom_wasm.wasm');
const SECRET = 'Sup3rS3cret!';
const col = (key: string, label: string): Column => ({ key, label, width: 100, editable: true, type: 'text' });

describe('pasted text passes the real gate', () => {
  let real: Redact;
  beforeAll(async () => {
    if (!existsSync(WASM)) throw new Error(`${WASM} is missing; run bash scripts/build-wasm.sh first. This suite does not fall back to a stub.`);
    const engine = await Engine.init(fileLoader(WASM));
    real = async (t) => engine.redactText(t).text;
  });

  it('a pasted `enable secret` line never reaches a text box with its secret', async () => {
    const next = await gatedInsert(real, { value: 'ab', selectionStart: 1, selectionEnd: 1 }, `enable secret ${SECRET}`);
    expect(next.value).not.toContain(SECRET);
    expect(next.value.startsWith('a')).toBe(true);
    expect(next.value.endsWith('b')).toBe(true);
  });

  it('line breaks in a paste into a one-line box are read as one statement', async () => {
    const next = await gatedInsert(real, { value: '', selectionStart: 0, selectionEnd: 0 }, `enable secret\n${SECRET}`);
    expect(next.value).not.toContain(SECRET);
  });

  it('an ordinary paste arrives as pasted, over the selection', async () => {
    const next = await gatedInsert(real, { value: 'abXYcd', selectionStart: 2, selectionEnd: 4 }, 'EX4300-48P');
    expect(next).toEqual({ value: 'abEX4300-48Pcd', caret: 12 });
  });

  it('a gate that fails inserts nothing', async () => {
    const boom: Redact = async () => {
      throw new Error('down');
    };
    await expect(gatedInsert(boom, { value: '', selectionStart: 0, selectionEnd: 0 }, 'x')).rejects.toThrow('down');
  });

  it('a header-less row with the keyword in one cell and the secret in the next is gated as a statement', async () => {
    const table = parseTable(`lon1-fw1\tserver\tenable secret\t${SECRET}`);
    // Each cell alone looks harmless: that is the bug this guards.
    for (const c of table[0]!) expect(await real(c)).toBe(c);
    const { clean, redactedRows } = await gatePastedTable(table, real);
    expect(JSON.stringify(clean)).not.toContain(SECRET);
    expect(redactedRows).toBe(1);
    const columns = [col('name', 'Name'), col('role', 'Role'), col('note', 'Note'), col('serial', 'Serial')];
    const plan = planPaste(clean, columns, [], { canAdd: true });
    expect(JSON.stringify(plan)).not.toContain(SECRET);
  });

  it('a secret split across cells is flagged for the dialog, and unticked rows are not brought in', async () => {
    const table = parseTable(`name\trole\tnote\tserial\nlon1-sw1\tswitch\tEX4300\tJN1\nlon1-fw1\tserver\tenable secret\t${SECRET}\nlon1-sw2\tswitch\tEX4300\tJN2`);
    const gated = await gatePastedTable(table, real);
    expect(gated.splitRows).toEqual([2]);
    expect(JSON.stringify(gated.clean)).not.toContain(SECRET);
    expect(splitRowNote(3)).toBe('Row 3: something that may be a password is split across cells, so every word in this row was hidden. Fix it in your file, or bring it in hidden.');
    // Unticked (the default): the row is dropped, the others stay.
    const left = withoutUntickedSplitRows(gated.clean, gated.splitRows, new Set());
    expect(left.map((r) => r[0])).toEqual(['name', 'lon1-sw1', 'lon1-sw2']);
    // Ticked: it comes in, hidden.
    const kept = withoutUntickedSplitRows(gated.clean, gated.splitRows, new Set([2]));
    expect(kept).toHaveLength(4);
    expect(JSON.stringify(kept)).not.toContain(SECRET);
  });

  it('a secret wholly inside one cell is hidden by the cell pass, so the row is not a split row', async () => {
    const table = parseTable(`enable secret ${SECRET}`);
    const { splitRows, redactedRows } = await gatePastedTable(table, real);
    expect(redactedRows).toBe(1);
    expect(splitRows).toEqual([]);
  });

  it('an ordinary row is left exactly as pasted', async () => {
    const table = parseTable('lon1-sw1\tswitch\tEX4300-48P\tJN1234567890\nlon1-sw2\tswitch\t\tJN1234567891');
    const { clean, redactedRows } = await gatePastedTable(table, real);
    expect(clean).toEqual(table);
    expect(redactedRows).toBe(0);
    expect((await gatePastedTable(table, real)).splitRows).toEqual([]);
  });

  it('a gate that fails stops the whole paste', async () => {
    const boom: Redact = async () => {
      throw new Error('gate down');
    };
    await expect(gatePastedTable([['a', 'b']], boom)).rejects.toThrow('gate down');
  });
});

describe('the splice', () => {
  it('replaces the selection and puts the caret after the paste', () => {
    expect(spliceAt('hello', 1, 3, 'EY')).toEqual({ value: 'hEYlo', caret: 3 });
    expect(spliceAt('hi', 9, 9, '!')).toEqual({ value: 'hi!', caret: 3 });
  });
  it('turns tabs and line breaks into single spaces', () => {
    expect(oneLine('a\tb\r\nc')).toBe('a b c');
  });
});
