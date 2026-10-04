// Shared by the importer's tests only: fixtures, a document with racks, a stand-in redactor, and a
// small XML reader (the tests run in Node, which has no DOMParser; the app uses the browser's).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CatalogueModel } from '../api/catalogue';
import { addRack } from '../components/racks/emptyDesign';
import { createSketchDevice } from '../document/commands';
import { setChassisField, setDeviceField } from '../document/edit';
import { setFieldValue, type FieldDefView } from '../document/fields';
import { emptyDocument, type Document } from '../document/model';
import { gateTable, type Redact } from './gate';
import { defaultMapping, looksLikeSecret, newFieldFor, type Mapping } from './mapping';
import { readImport } from './read';
import type { GatedTable, RawTable } from './table';
import type { XEl, XmlParser } from './xml';

export const ACTOR = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
export const NOW = 1_790_000_000_000;

export function fixture(name: string): string {
  return readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', name), 'utf8');
}

const model = (vendor: string, name: string, rackUnits: number): CatalogueModel => ({
  vendor,
  model: name,
  rackUnits,
  reviewedBy: 'reviewer',
  source: { cite: 'cite', readOn: '2026-09-14' },
  psuSlots: [],
  faceplates: [{ face: 'front', portCount: 1, ports: [{ kind: 'RJ45', number: 0, uplink: false, row: 'single', column: 0, groupGapBefore: false }] }],
});

export const CATALOGUE: CatalogueModel[] = [
  model('juniper', 'EX2300-48P', 1),
  model('juniper', 'EX4300-48P', 1),
  model('juniper', 'SRX300', 1),
  model('dell', 'R740xd', 2),
];

/** A design with a premises and one 42U rack called R1. */
export function docWithRack(): { doc: Document; rackId: string } {
  const made = addRack(emptyDocument(), null, { label: 'R1', heightU: 42, actor: ACTOR, now: NOW });
  return { doc: made.doc, rackId: made.rackId };
}

/**
 * Stands in for the wasm gate in tests that only need a gate to exist. It blanks the value after the
 * statement words the real gate's own tests use (community, pre-shared-key, authentication-key,
 * simple-password, password). It is NOT the gate; gate.test.ts also runs the real engine.
 */
export const stubRedact: Redact = async (text) =>
  text.replace(/\b(community|pre-shared-key(?: ascii-text)?|authentication-key|simple-password|password)\s+("[^"]*"|\S+)/gi, '$1 [REDACTED]');

// --- a small XML reader for well-formed fixtures: elements, attributes, text, CDATA, comments ---

const unescapeXml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export const miniXml: XmlParser = (xml) => {
  const token = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  const root: XEl = { tag: '#root', attrs: new Map(), children: [], text: '' };
  const stack: XEl[] = [root];
  for (const m of xml.matchAll(token)) {
    const top = stack[stack.length - 1]!;
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2] !== undefined) stack.pop();
    else if (m[3] !== undefined) {
      const attrs = new Map<string, string>();
      for (const a of (m[4] ?? '').matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs.set(a[1]!, unescapeXml(a[2] ?? a[3] ?? ''));
      const el: XEl = { tag: m[3], attrs, children: [], text: '' };
      top.children.push(el);
      if (m[5] !== '/') stack.push(el);
    } else if (m[6] !== undefined) top.text += unescapeXml(m[6]);
  }
  const first = root.children[0];
  if (!first || stack.length !== 1) throw new Error('not well-formed');
  return first;
};

// --- documents and definitions ---

export const COST_CENTRE: FieldDefView = { id: '01ARZ3NDEKTSV4RRFFQ69G5F01', appliesTo: 'device', name: 'Cost centre', type: 'text', choices: [], version: 1, createdBy: ACTOR, archived: false };

export function addDevice(doc: Document, name: string, v: { serial?: string; role?: string; mgmt?: string; cost?: string } = {}): Document {
  const before = new Set(doc.nodes.map((n) => n.id));
  let d = createSketchDevice(doc, { hostname: name, actor: ACTOR, now: NOW });
  const added = d.nodes.filter((n) => !before.has(n.id)).map((n) => n.id);
  const deviceId = added.find((id) => id.startsWith('device:'))!;
  const chassisId = added.find((id) => id.startsWith('chassis:'))!;
  if (v.serial) d = setChassisField(d, chassisId, 'serial', v.serial, { actor: ACTOR, now: NOW });
  if (v.role) d = setDeviceField(d, deviceId, 'role', v.role, { actor: ACTOR, now: NOW });
  if (v.mgmt) d = setDeviceField(d, deviceId, 'management_address', v.mgmt, { actor: ACTOR, now: NOW });
  if (v.cost) d = setFieldValue(d, deviceId, COST_CENTRE.id, v.cost, [COST_CENTRE], { actor: ACTOR, now: NOW });
  return d;
}

export const identity = async (t: string) => t;

export async function gated(raw: RawTable): Promise<GatedTable> {
  return gateTable(raw, stubRedact);
}

/** The same definitions `plan.newFields` asks for, as the server would answer. */
export function freshDefs(newFields: ReadonlyArray<{ name: string; type: FieldDefView['type'] }>): FieldDefView[] {
  return newFields.map((f, i) => ({ id: `01ARZ3NDEKTSV4RRFFQ69G5F${String(i + 10)}`, appliesTo: 'device', name: f.name, type: f.type, choices: [], version: 1, createdBy: ACTOR, archived: false }));
}

export { readImport };

/** The default mapping, then every unmapped column with values (not a secret-looking one) made a new field, as a person would. */
export function fullMapping(table: GatedTable, defs: readonly FieldDefView[] = []): Mapping {
  return defaultMapping(table, defs).map((t, i) => {
    const filled = table.rows.some((r) => (r[i] ?? '') !== '');
    return t.kind === 'ignore' && filled && !looksLikeSecret(table.headers[i] ?? '') ? newFieldFor(table, i) : t;
  });
}
