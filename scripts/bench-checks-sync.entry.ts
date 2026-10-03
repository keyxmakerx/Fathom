// Bundled and run by scripts/bench-checks-sync.mjs. A design of N boxes, one full load, then ordinary edits
// through Mirror.sync + checks, timed in this process against the built module (no throttle).
import { performance } from 'node:perf_hooks';

import { Engine } from '../client/src/engine/engine';
import { Mirror } from '../client/src/engine/mirror';
import { EDITS, buildDesign } from '../client/src/engine/syncDesign';
import { fileLoader } from '../client/src/engine/wasm';
import { writePlain } from '../client/src/document/plain';

export interface Options {
  wasmPath: string;
  devices: number;
  edits: number;
  /** Also time the old path (full load + checks) for this many of the edits. */
  oldPath: number;
  log: (line: string) => void;
}

const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const f = (ms: number): string => `${ms.toFixed(1)} ms`;

export async function run(o: Options): Promise<void> {
  const { log } = o;
  let t = performance.now();
  const d = buildDesign(o.devices);
  log(`built ${o.devices} devices: ${d.doc.nodes.length} nodes, ${d.doc.edges.length} edges, ${d.doc.batches.length} batches (${f(performance.now() - t)}, not part of the measure)`);

  const engine = await Engine.init(fileLoader(o.wasmPath));
  const mirror = new Mirror(engine);

  t = performance.now();
  const plainBytes = writePlain(d.doc).length;
  const writeMs = performance.now() - t;
  t = performance.now();
  const kind = mirror.sync(d.doc);
  const firstSync = performance.now() - t;
  t = performance.now();
  const first = mirror.checks();
  const firstChecks = performance.now() - t;
  log(`first load (${kind}): sync ${f(firstSync)} (writePlain alone ${f(writeMs)}, ${plainBytes} bytes), first checks ${f(firstChecks)}, ${first.findings.length} findings`);

  const rows: { name: string; kind: string; sync: number; checks: number }[] = [];
  for (let i = 0; i < o.edits; i += 1) {
    const e = EDITS[i % EDITS.length];
    e.apply(d, i + 1);
    t = performance.now();
    const k = mirror.sync(d.doc);
    const sync = performance.now() - t;
    t = performance.now();
    mirror.checks();
    rows.push({ name: e.name, kind: k, sync, checks: performance.now() - t });
  }
  for (const r of rows) log(`  ${r.name.padEnd(24)} ${r.kind.padEnd(6)} sync ${f(r.sync).padStart(10)}  checks ${f(r.checks).padStart(10)}  total ${f(r.sync + r.checks).padStart(10)}`);
  const total = rows.map((r) => r.sync + r.checks);
  const sync = rows.map((r) => r.sync);
  const checks = rows.map((r) => r.checks);
  log(`${o.edits} edits, ${rows.filter((r) => r.kind === 'delta').length} synced as deltas:`);
  log(`  sync   p50 ${f(pct(sync, 50))}  p95 ${f(pct(sync, 95))}`);
  log(`  checks p50 ${f(pct(checks, 50))}  p95 ${f(pct(checks, 95))}`);
  log(`  total  p50 ${f(pct(total, 50))}  p95 ${f(pct(total, 95))}  max ${f(Math.max(...total))}`);

  // The path this replaces, for the same design: write the whole plain face, replace the estate, check from cold.
  const old: number[] = [];
  for (let i = 0; i < o.oldPath; i += 1) {
    EDITS[i % EDITS.length].apply(d, o.edits + i + 1);
    t = performance.now();
    mirror.load(d.doc);
    mirror.checks();
    old.push(performance.now() - t);
  }
  if (old.length > 0) log(`old path (full load + cold checks), ${old.length} edits: p50 ${f(pct(old, 50))}  p95 ${f(pct(old, 95))}`);
}
