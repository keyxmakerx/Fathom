// `Mirror.sync`: the first call loads the whole design, later calls send only the batches the module has
// not seen, and anything in doubt falls back to the full load. Part one drives it with a recording engine
// (sequencing); part two drives the REAL module (`bash scripts/build-wasm.sh` first) against a full load of
// the same document, which is the oracle.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { Engine } from './engine';
import { Mirror } from './mirror';
import { ACTOR, EDITS, buildDesign } from './syncDesign';
import { fileLoader } from './wasm';
import { parseCanonical } from '../document/canon';
import { setDeviceField } from '../document/edit';
import { emptyDocument, type Document } from '../document/model';
import { readPlain, writePlain } from '../document/plain';
import { undo } from '../document/undo';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.resolve(__dirname, '../../public/engine/fathom_wasm.wasm');

if (!existsSync(WASM_PATH)) {
  throw new Error(`client/src/engine/mirror.sync.test.ts: ${WASM_PATH} does not exist. Run \`bash scripts/build-wasm.sh\` first.`);
}

// --- a recording engine ------------------------------------------------------------------------

class FakeEngine {
  calls: ('load' | 'delta')[] = [];
  loads: Uint8Array[] = [];
  deltas: Uint8Array[] = [];
  /** What `syncDelta` answers: counts of this document, or `null` ("resync needed"). */
  answer: 'resync' | 'throw' | Document = 'resync';
  pasted: Document | null = null;

  loadPlain(bytes: Uint8Array): void {
    this.calls.push('load');
    this.loads.push(bytes);
  }

  syncDelta(bytes: Uint8Array): { nodes: number; edges: number } | null {
    this.calls.push('delta');
    this.deltas.push(bytes);
    if (this.answer === 'throw') throw new Error('boom');
    if (this.answer === 'resync') return null;
    return { nodes: this.answer.nodes.length, edges: this.answer.edges.length };
  }

  pasteInto(): unknown {
    return {};
  }

  exportPlain(): Uint8Array {
    return writePlain(this.pasted!);
  }
}

function rig(): { engine: FakeEngine; mirror: Mirror } {
  const engine = new FakeEngine();
  return { engine, mirror: new Mirror(engine as unknown as Engine) };
}

/** The delta's header lines and fragment. */
function readDelta(bytes: Uint8Array): { header: string[]; batches: { id: string }[] } {
  let at = 0;
  const header: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    const nl = bytes.indexOf(0x0a, at);
    header.push(new TextDecoder().decode(bytes.subarray(at, nl)));
    at = nl + 1;
  }
  const body = parseCanonical(bytes.subarray(at)) as { batches: { id: string }[] };
  return { header, batches: body.batches };
}

const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

const edit = (name: string, d: ReturnType<typeof buildDesign>, i = 0): Document => {
  EDITS.find((e) => e.name === name)!.apply(d, i);
  return d.doc;
};

describe('Mirror.sync sequencing', () => {
  it('loads the whole design first, then sends only the batches the module has not seen', () => {
    const { engine, mirror } = rig();
    const d = buildDesign(3);
    expect(mirror.sync(d.doc)).toBe('full');
    expect(engine.calls).toEqual(['load']);
    expect(mirror.sync(d.doc)).toBe('none');
    expect(engine.calls).toEqual(['load']);

    const before = d.doc.batches.length;
    const last = d.doc.batches[before - 1].id;
    const next = edit('set a field', d);
    engine.answer = next;
    expect(mirror.sync(next)).toBe('delta');
    expect(engine.calls).toEqual(['load', 'delta']);

    const sent = readDelta(engine.deltas[0]);
    expect(sent.header).toEqual(['fathom-delta 1', expect.stringMatching(/^schema 0\./), `base ${last}`, '']);
    expect(sent.batches.map((b) => b.id)).toEqual(next.batches.slice(before).map((b) => b.id));
    expect(engine.deltas[0].length).toBeLessThan(engine.loads[0].length / 4);

    // Several edits between two syncs go in one delta.
    const a = edit('move a box', d);
    const b = edit('tag a box', d);
    engine.answer = b;
    expect(a).not.toBe(b);
    expect(mirror.sync(b)).toBe('delta');
    expect(readDelta(engine.deltas[1]).batches).toHaveLength(b.batches.length - next.batches.length);
  });

  it('an empty design is a base of none', () => {
    const { engine, mirror } = rig();
    expect(mirror.sync(emptyDocument())).toBe('full');
    const d = buildDesign(1);
    engine.answer = d.doc;
    expect(mirror.sync(d.doc)).toBe('delta');
    expect(readDelta(engine.deltas[0]).header[2]).toBe('base none');
  });

  it('falls back to the full load on "resync needed", and then goes back to deltas', () => {
    const { engine, mirror } = rig();
    const d = buildDesign(3);
    mirror.sync(d.doc);
    const next = edit('set a field', d);
    engine.answer = 'resync';
    expect(mirror.sync(next)).toBe('full');
    expect(engine.calls).toEqual(['load', 'delta', 'load']);
    expect(same(engine.loads[1], writePlain(next))).toBe(true);

    const after = edit('tag a box', d);
    engine.answer = after;
    expect(mirror.sync(after)).toBe('delta');
  });

  it('a module that cannot be sent to at all is loaded whole', () => {
    const { engine, mirror } = rig();
    const d = buildDesign(2);
    mirror.sync(d.doc);
    engine.answer = 'throw';
    expect(mirror.sync(edit('set a field', d))).toBe('full');
    expect(engine.calls).toEqual(['load', 'delta', 'load']);
  });

  it('a module whose counts disagree with the document is loaded whole', () => {
    const { engine, mirror } = rig();
    const d = buildDesign(2);
    mirror.sync(d.doc);
    const next = edit('set a field', d);
    engine.answer = { ...next, nodes: [...next.nodes, next.nodes[0]] };
    expect(mirror.sync(next)).toBe('full');
  });

  it('follows undo and redo, which are appended batches', () => {
    const { engine, mirror } = rig();
    const d = buildDesign(3);
    mirror.sync(d.doc);
    for (const name of ['set a field', 'undo', 'redo']) {
      const next = edit(name, d, 1);
      engine.answer = next;
      expect(mirror.sync(next), name).toBe('delta');
    }
    const sent = engine.deltas.map(readDelta);
    expect(sent.map((s) => s.batches.length)).toEqual([1, 1, 1]);
    // The undo's batch says what it reverses, in the canonical encoding the module reads.
    expect(new TextDecoder().decode(engine.deltas[1])).toContain('"reverses"');
  });

  it('loads whole when the document is a different design', () => {
    const { engine, mirror } = rig();
    mirror.sync(buildDesign(3).doc);
    expect(mirror.sync(buildDesign(3).doc)).toBe('full');
    expect(mirror.sync(emptyDocument())).toBe('full');
    expect(engine.calls).toEqual(['load', 'load', 'load']);
  });

  it('loads whole when the history it holds was rewritten (a comment on an old batch)', () => {
    const { engine, mirror } = rig();
    const d = buildDesign(3);
    mirror.sync(d.doc);
    const old = d.doc.batches[1];
    const commented: Document = {
      ...d.doc,
      batches: d.doc.batches.map((b) => (b === old ? { ...b, comment: 'why' } : b)),
    };
    expect(mirror.sync(commented)).toBe('full');
    // A copy with the same history is still a continuation.
    engine.answer = commented;
    expect(mirror.sync(readPlain(writePlain(commented)))).toBe('delta');
  });

  it('after a load of its own it continues from that document, and after a paste from what came back', () => {
    const { engine, mirror } = rig();
    const d = buildDesign(2);
    mirror.load(d.doc);
    expect(mirror.sync(d.doc)).toBe('none');

    // `pasteInto` hands back the module's own estate; later syncs continue from it.
    engine.pasted = d.doc;
    mirror.pasteInto(d.boxes[0].deviceId, 'set system host-name x');
    const next = setDeviceField(d.doc, d.boxes[0].deviceId, 'hostname', 'x', { actor: ACTOR, now: 1_790_000_999_000 });
    engine.answer = next;
    expect(mirror.sync(next)).toBe('delta');
  });

  it('two undos in a row after the module was loaded from the server copy still sync', () => {
    const { engine, mirror } = rig();
    const d = buildDesign(2);
    const copy = readPlain(writePlain(d.doc));
    mirror.sync(copy);
    d.doc = undo(d.doc, d.doc.batches[d.doc.batches.length - 1].id, { actor: ACTOR, now: 1_790_000_888_000 });
    engine.answer = d.doc;
    expect(mirror.sync(d.doc)).toBe('delta');
  });
});

// --- the real module, against a full load -----------------------------------------------------------

let incremental: Engine;
let oracle: Engine;

beforeAll(async () => {
  incremental = await Engine.init(fileLoader(WASM_PATH));
  oracle = await Engine.init(fileLoader(WASM_PATH));
});

describe('Mirror.sync against the real module', () => {
  it('takes every ordinary edit as a delta and answers exactly as a full load of the same document', () => {
    const mirror = new Mirror(incremental);
    const full = new Mirror(oracle);
    const d = buildDesign(14);
    expect(mirror.sync(d.doc)).toBe('full');

    let findings = 0;
    const kinds: string[] = [];
    // Two passes over every kind of edit; every third step lets two edits pile up before the sync.
    for (let i = 0; i < EDITS.length * 2 + 2; i += 1) {
      const e = EDITS[i % EDITS.length];
      e.apply(d, i + 1);
      if (i % 3 === 2) continue;
      const kind = mirror.sync(d.doc);
      kinds.push(`${e.name}:${kind}`);
      expect(kind, e.name).toBe('delta');

      full.load(d.doc);
      const got = mirror.checks();
      expect(got, e.name).toEqual(full.checks());
      expect(same(incremental.exportPlain(), oracle.exportPlain()), `${e.name}: the held design`).toBe(true);
      findings += got.findings.length;
    }
    expect(kinds.length).toBeGreaterThan(10);
    expect(findings, 'the design must stand some findings or this proves nothing').toBeGreaterThan(0);
  });

  it('a different design, then back to deltas', () => {
    const mirror = new Mirror(incremental);
    const full = new Mirror(oracle);
    const a = buildDesign(4);
    mirror.sync(a.doc);
    const b = buildDesign(5);
    expect(mirror.sync(b.doc)).toBe('full');
    EDITS[2].apply(b, 1);
    expect(mirror.sync(b.doc)).toBe('delta');
    full.load(b.doc);
    expect(mirror.checks()).toEqual(full.checks());
  });
});
