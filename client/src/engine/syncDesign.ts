// A realistic design and a run of ordinary edits, for the sync oracle test and the benchmark
// (`scripts/bench-checks-sync.mjs`). Every write goes through the same commands the app uses, so
// the batches, ops and history are the ones a real session produces. Not imported by the app.

import { addSketchPortRange } from '../document/commands';
import { connectPorts, disconnect, setCableField } from '../document/cables';
import { setDeviceField } from '../document/edit';
import { createFreeBox, moveFree } from '../document/freeform';
import { edgesOut, emptyDocument, findNode, type Document } from '../document/model';
import { addSubnet, addVlan } from '../document/networks';
import { tagObject } from '../document/tags';
import { redo, undo } from '../document/undo';

/** A valid ULID standing in for the signed-in account. */
export const ACTOR = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const T0 = 1_790_000_000_000;

export interface Box {
  deviceId: string;
  chassisId: string;
  ports: string[];
}

export interface Design {
  doc: Document;
  boxes: Box[];
  cables: string[];
  clock: number;
  /** Next unused pair of spare ports for "add a cable". */
  spare: number;
}

function opts(d: { clock: number }): { actor: string; now: number } {
  d.clock += 1;
  return { actor: ACTOR, now: d.clock };
}

/** `n` boxes with six ports each, a cable between neighbours, a VLAN and an address on some. */
export function buildDesign(n: number): Design {
  const d: Design = { doc: emptyDocument(), boxes: [], cables: [], clock: T0, spare: 0 };
  for (let i = 0; i < n; i += 1) {
    const made = createFreeBox(d.doc, { ...opts(d), x: (i % 40) * 260, y: Math.floor(i / 40) * 200, hostname: `sw-${i}`, role: 'switch' });
    const doc = addSketchPortRange(
      made.doc,
      made.chassisId,
      { labelPrefix: 'ge-0/0/', first: 0, last: 5, connector: 'rj45', service: 'ethernet', face: 'front' },
      opts(d),
    );
    d.doc = doc;
    d.boxes.push({
      deviceId: made.deviceId,
      chassisId: made.chassisId,
      ports: edgesOut(doc, made.chassisId, 'HasPort').map((e) => e.to),
    });
  }
  for (let i = 0; i < n; i += 1) {
    const a = d.boxes[i].ports[0];
    const b = d.boxes[(i + 1) % n].ports[1];
    if (a === b || n < 2) continue;
    d.doc = connectPorts(d.doc, a, b, { media: 'cat6' }, opts(d));
    d.cables.push(cableOf(d.doc, a));
  }
  for (let i = 0; i < n; i += 4) {
    const box = d.boxes[i];
    d.doc = addVlan(
      d.doc,
      { vlanId: 10 + (i % 4), name: `v${i % 4}`, attach: [{ target: { kind: 'port', portId: box.ports[2], interfaceName: 'ge-0/0/2' } }] },
      opts(d),
    );
  }
  for (let i = 1; i < n; i += 4) {
    const box = d.boxes[i];
    d.doc = addSubnet(
      d.doc,
      {
        prefix: `10.${i >> 8}.${i & 255}.0/24`,
        attach: [{ target: { kind: 'port', portId: box.ports[3], interfaceName: 'ge-0/0/3' }, address: `10.${i >> 8}.${i & 255}.1/24` }],
      },
      opts(d),
    );
  }
  return d;
}

function cableOf(doc: Document, portId: string): string {
  const e = doc.edges.find((x) => x.to === portId && x.absentSince === undefined && x.id.startsWith('terminates:'));
  if (!e) throw new Error(`no cable on ${portId}`);
  return e.from;
}

/** A cable of `d` that is still live, by rotation from `i`. */
function liveCable(d: Design, i: number): string {
  for (let k = 0; k < d.cables.length; k += 1) {
    const id = d.cables[(i + k) % d.cables.length];
    if (findNode(d.doc, id)?.absentSince === undefined) return id;
  }
  throw new Error('no live cable');
}

const byName = (name: string) => EDITS.find((e) => e.name === name)!;

/** One named kind of ordinary edit, applied to `d` (which is updated in place). */
export const EDITS: readonly { name: string; apply: (d: Design, i: number) => void }[] = [
  {
    name: 'move a box',
    apply: (d, i) => {
      d.doc = moveFree(d.doc, [{ id: d.boxes[i % d.boxes.length].chassisId, x: 40 + i * 7, y: 60 + i * 3 }], opts(d));
    },
  },
  {
    name: 'add a cable',
    apply: (d) => {
      const k = d.spare;
      d.spare += 1;
      const a = d.boxes[k % d.boxes.length].ports[4];
      const b = d.boxes[(k + 3) % d.boxes.length].ports[5];
      d.doc = connectPorts(d.doc, a, b, { media: 'cat6' }, opts(d));
      d.cables.push(cableOf(d.doc, a));
    },
  },
  {
    name: 'set a field',
    apply: (d, i) => {
      d.doc = setDeviceField(d.doc, d.boxes[(i * 11) % d.boxes.length].deviceId, 'hostname', `renamed-${i}`, opts(d));
    },
  },
  {
    name: 'tag a box',
    apply: (d, i) => {
      d.doc = tagObject(d.doc, d.boxes[(i * 13) % d.boxes.length].deviceId, `site-${i % 3}`, opts(d));
    },
  },
  {
    name: 'set a cable field',
    apply: (d, i) => {
      d.doc = setCableField(d.doc, liveCable(d, i), 'media', i % 2 === 0 ? 'cat5e' : 'cat6a', opts(d));
    },
  },
  {
    name: 'remove a cable',
    apply: (d, i) => {
      d.doc = disconnect(d.doc, liveCable(d, i), opts(d));
    },
  },
  {
    name: 'undo',
    apply: (d) => {
      const last = [...d.doc.batches].reverse().find((b) => b.reverses === undefined);
      if (last) d.doc = undo(d.doc, last.id, opts(d));
    },
  },
  {
    name: 'redo',
    apply: (d) => {
      const last = d.doc.batches[d.doc.batches.length - 1];
      if (last?.reverses !== undefined) d.doc = redo(d.doc, last.id, opts(d));
    },
  },
  {
    name: 'add a cable then undo',
    apply: (d, i) => {
      byName('add a cable').apply(d, i);
      d.doc = undo(d.doc, d.doc.batches[d.doc.batches.length - 1].id, opts(d));
    },
  },
  {
    name: 'tag a box then undo',
    apply: (d, i) => {
      byName('tag a box').apply(d, i);
      d.doc = undo(d.doc, d.doc.batches[d.doc.batches.length - 1].id, opts(d));
    },
  },
];
