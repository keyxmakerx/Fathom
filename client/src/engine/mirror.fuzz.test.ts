// `Mirror.sync` against a full load over random command sequences (`bash scripts/build-wasm.sh` first).
// `mirror.sync.test.ts` covers the ordinary edits; this one throws every document command at it, undo and
// redo included. After each step a module kept in step by deltas must answer and export exactly as a fresh
// one loaded whole, and must never hold a design the full load refuses.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { Engine } from './engine';
import { Mirror } from './mirror';
import { ACTOR, EDITS, buildDesign, type Design } from './syncDesign';
import { fileLoader } from './wasm';
import { addSketchPort, duplicateDevice, removeChassis, removeSketchPort } from '../document/commands';
import { disconnect } from '../document/cables';
import { createFreeBox, createLabel, createLine, removeFree } from '../document/freeform';
import { detachAddress, detachVlanMember } from '../document/networks';
import { addNote, removeNote } from '../document/notes';
import { edgesOut, findNode, type Document } from '../document/model';
import { fitSupply, removeSupply } from '../document/supplies';
import { listTags, removeTag, renameTag, tagObject, untagObject } from '../document/tags';
import { redo, undo, undoable } from '../document/undo';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.resolve(__dirname, '../../public/engine/fathom_wasm.wasm');

if (!existsSync(WASM_PATH)) {
  throw new Error(`client/src/engine/mirror.fuzz.test.ts: ${WASM_PATH} does not exist. Run \`bash scripts/build-wasm.sh\` first.`);
}

let incremental: Engine;
let oracle: Engine;
beforeAll(async () => {
  incremental = await Engine.init(fileLoader(WASM_PATH));
  oracle = await Engine.init(fileLoader(WASM_PATH));
});

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const live = (doc: Document, prefix: string): string[] =>
  doc.nodes.filter((n) => n.absentSince === undefined && n.id.startsWith(prefix)).map((n) => n.id);

const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

describe('Mirror.sync over random command sequences', () => {
  it('answers as a full load does, and never holds a design the full load refuses', () => {
    const stats: Record<string, number> = {};
    const bump = (k: string) => (stats[k] = (stats[k] ?? 0) + 1);
    for (let seed = 1; seed <= 4; seed += 1) {
      const R = rng(seed);
      const pick = <T>(v: readonly T[]): T | undefined => (v.length ? v[Math.floor(R() * v.length)] : undefined);
      const d: Design = buildDesign(6);
      const mirror = new Mirror(incremental);
      const full = new Mirror(oracle);
      mirror.sync(d.doc);
      let clock = d.clock + 1000;
      const o = () => ({ actor: ACTOR, now: (clock += 1) });
      const commands: [string, () => void][] = [
        ['edit', () => pick(EDITS)!.apply(d, Math.floor(R() * 50))],
        ['removeChassis', () => { const c = pick(live(d.doc, 'chassis:')); if (c) d.doc = removeChassis(d.doc, c, o()); }],
        ['duplicateDevice', () => { const c = pick(live(d.doc, 'chassis:')); if (c) d.doc = duplicateDevice(d.doc, c, o()).doc; }],
        [
          'removeSketchPort',
          () => {
            const c = pick(live(d.doc, 'chassis:'));
            if (!c) return;
            const p = pick(edgesOut(d.doc, c, 'HasPort').map((e) => e.to).filter((x) => findNode(d.doc, x)?.absentSince === undefined));
            if (p) d.doc = removeSketchPort(d.doc, c, p, o());
          },
        ],
        ['addSketchPort', () => { const c = pick(live(d.doc, 'chassis:')); if (c) d.doc = addSketchPort(d.doc, c, { label: `x${clock}`, connector: 'sfp_plus', face: 'front' } as never, o()); }],
        ['fitSupply', () => { const c = pick(live(d.doc, 'chassis:')); if (c) d.doc = fitSupply(d.doc, c, `PSU${Math.floor(R() * 3)}`, {}, o()); }],
        ['removeSupply', () => { const s = pick(live(d.doc, 'power-supply:')); if (s) d.doc = removeSupply(d.doc, s, o()); }],
        ['addNote', () => { const c = pick(live(d.doc, 'device:')); if (c) d.doc = addNote(d.doc, c, { text: 'n', how: 'typed', ...o() } as never); }],
        ['removeNote', () => { const n = pick(live(d.doc, 'note:')); if (n) d.doc = removeNote(d.doc, n, o()); }],
        ['tag', () => { const c = pick(live(d.doc, 'device:')); if (c) d.doc = tagObject(d.doc, c, `t${Math.floor(R() * 4)}`, o()); }],
        [
          'untag, removeTag, renameTag',
          () => {
            const t = pick(listTags(d.doc)) as { id?: string; tagId?: string } | undefined;
            const id = t && (t.id ?? t.tagId);
            if (!id) return;
            const r = R();
            if (r < 0.4) d.doc = removeTag(d.doc, id, o());
            else if (r < 0.7) d.doc = renameTag(d.doc, id, `r${clock}`, o());
            else {
              const c = pick(live(d.doc, 'device:'));
              if (c) d.doc = untagObject(d.doc, c, id, o());
            }
          },
        ],
        [
          'detach',
          () => {
            const vm = pick(d.doc.edges.filter((e) => e.absentSince === undefined && e.id.startsWith('vlan-member:')).map((e) => e.id));
            if (vm && R() < 0.5) d.doc = detachVlanMember(d.doc, vm, o());
            else {
              const a = pick(live(d.doc, 'address:'));
              if (a) d.doc = detachAddress(d.doc, a, o());
            }
          },
        ],
        [
          'labels and lines',
          () => {
            const r = R();
            if (r < 0.3) d.doc = createLabel(d.doc, { text: 'L', form: 'text', x: 10, y: 10, ...o() }).doc;
            else if (r < 0.6) {
              const a = pick(live(d.doc, 'chassis:'));
              const b = pick(live(d.doc, 'chassis:'));
              if (a && b && a !== b) d.doc = createLine(d.doc, a, b, o()).doc;
            } else {
              const x = pick([...live(d.doc, 'label:'), ...live(d.doc, 'line:')]);
              if (x) d.doc = removeFree(d.doc, [x], o());
            }
          },
        ],
        ['free box', () => { d.doc = createFreeBox(d.doc, { x: 5, y: 5, hostname: `fb${clock}`, ...o() }).doc; }],
        ['disconnect', () => { const c = pick(live(d.doc, 'cable:')); if (c) d.doc = disconnect(d.doc, c, o()); }],
        ['undo or redo', () => { const b = pick(undoable(d.doc, ACTOR)); if (b) d.doc = (b.reverses !== undefined && R() < 0.5 ? redo : undo)(d.doc, b.id, o()); }],
        ['comment on an old batch', () => { const i = Math.floor(R() * d.doc.batches.length); d.doc = { ...d.doc, batches: d.doc.batches.map((b, j) => (j === i ? { ...b, comment: `c${clock}` } : b)) }; }],
      ];
      for (let step = 0; step < 40; step += 1) {
        const [name, run] = pick(commands)!;
        try {
          run();
        } catch {
          continue; // the command refused: nothing changed
        }
        if (R() < 0.3) continue; // let a few pile up, as a debounce does
        let fullAccepts = true;
        try {
          full.load(d.doc);
        } catch {
          fullAccepts = false;
        }
        let kind: string;
        try {
          kind = mirror.sync(d.doc);
        } catch {
          // The design is one the module will not load: the full load must say the same.
          expect(fullAccepts, `seed ${seed} step ${step} after ${name}: sync refused, a full load did not`).toBe(false);
          bump('unloadable');
          d.doc = buildDesign(4).doc;
          mirror.sync(d.doc);
          continue;
        }
        expect(fullAccepts, `seed ${seed} step ${step} after ${name}: the module holds a design a full load refuses`).toBe(true);
        bump(`sync ${kind}`);
        expect(mirror.checks(), `seed ${seed} step ${step} after ${name} (${kind})`).toEqual(full.checks());
        expect(same(incremental.exportPlain(), oracle.exportPlain()), `seed ${seed} step ${step} after ${name} (${kind}): the held design`).toBe(true);
      }
    }
    expect(stats['sync delta'], JSON.stringify(stats)).toBeGreaterThan(20);
  }, 120_000);
});
