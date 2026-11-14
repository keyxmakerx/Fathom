// Throwaway: copied into client/src by scripts/drive-orders.mjs, run once with vitest, then removed. It builds the
// design the orders drive needs for ADR-0084 decision 18 (two switches and a plan on core-sw1's Gi1/0/48) with the
// client's own document commands, and writes it as the plain bytes a save sends, so the seed can store it.
import { writeFileSync } from 'node:fs';

import { it } from 'vitest';

import { addSketchPort, createSketchDevice } from './document/commands';
import { edgesOut, emptyDocument, type Document } from './document/model';
import { SCHEMA_VERSION, writePlain } from './document/plain';
import { addStep, createPlan, TYPED_AS_WRITTEN } from './document/plans';

const tick = (() => {
  let now = 1_790_900_000_000;
  return () => ({ actor: '01ARZ3NDEKTSV4RRFFQ69G5FAV', now: (now += 1000) });
})();

it('writes the clash design', () => {
  const out = process.env.CLASH_OUT;
  if (!out) throw new Error('CLASH_OUT must name the file to write');
  const sw = (doc: Document, hostname: string, labels: string[]) => {
    const before = new Set(doc.nodes.map((n) => n.id));
    let d = createSketchDevice(doc, { hostname, ...tick() });
    const fresh = d.nodes.filter((n) => !before.has(n.id));
    const chassis = fresh.find((n) => n.id.startsWith('chassis:'))!.id;
    for (const label of labels) d = addSketchPort(d, chassis, { label, connector: 'rj45', face: 'front' }, tick());
    return { doc: d, device: fresh.find((n) => n.id.startsWith('device:'))!.id, ports: edgesOut(d, chassis, 'HasPort').map((e) => e.to) };
  };
  const a = sw(emptyDocument(), 'edge-rt1', ['Et47', 'Et48', 'Et49']);
  const b = sw(a.doc, 'core-sw1', ['Gi1/0/1']);
  const plan = createPlan(b.doc, { title: 'Move the uplinks on edge-rt1', windowStart: '2026-11-20T22:00', windowEnd: '2026-11-21T01:00', gate: TYPED_AS_WRITTEN, ...tick() });
  const step = addStep(plan.doc, plan.id, { kind: 'other', targets: [a.ports[2]], change: 'Move the uplink off Et49', gate: TYPED_AS_WRITTEN, ...tick() });
  const minor = Number(SCHEMA_VERSION.split('.')[1]);
  // One line, tab-separated, so the seed needs no JSON reader: minor, payload as hex, device, port, plan.
  writeFileSync(out, [minor, Buffer.from(writePlain(step.doc)).toString('hex'), a.device, a.ports[2], plan.id].join('\t'));
});
