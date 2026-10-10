// "Not here? Describe it" (sign-off r15-catalogue, mockup r15-f1): a device the catalogue does not
// carry, described as a few rows of ports (what, how many, which face) and turned into hand-typed
// ports. Faces are any of the five the schema has (0.21): front, rear, left, right, top, so a mini
// PC with ports on its sides and top can be drawn (the owner's NUC). Pure, so a vitest drives it.

import { PORT_FACE_VALUES, type PortFace } from '../../document/compat';
import type { TemplatePort } from '../../document/plate';

/** What a row of ports is, in the words the builder shows. */
export const DESCRIBE_KINDS = [
  { kind: 'copper', label: 'Copper', connector: 'rj45' },
  { kind: 'sfp', label: 'SFP', connector: 'sfp' },
  { kind: 'sfp_plus', label: 'SFP+', connector: 'sfp_plus' },
  { kind: 'sfp28', label: 'SFP28', connector: 'sfp28' },
  { kind: 'qsfp28', label: 'QSFP28', connector: 'qsfp28' },
  { kind: 'console', label: 'Console', connector: 'rj45', service: 'console' },
  { kind: 'power', label: 'Power', connector: 'c14', service: 'power' },
] as const;

export type DescribeKind = (typeof DESCRIBE_KINDS)[number]['kind'];

export interface DescribeRow {
  kind: DescribeKind;
  count: number;
  face: PortFace;
}

/** The most ports one description adds, the same cap `addTemplatePorts` keeps. */
export const MAX_DESCRIBED_PORTS = 256;
/** The most one row offers in its count list. */
export const MAX_ROW_COUNT = 64;

/** Where the builder starts: eight copper ports on the front, as in the mockup. */
export const STARTING_ROWS: readonly DescribeRow[] = [
  { kind: 'copper', count: 8, face: 'front' },
  { kind: 'sfp', count: 0, face: 'front' },
];

function kindOf(kind: DescribeKind) {
  return DESCRIBE_KINDS.find((k) => k.kind === kind)!;
}

function wholeCount(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(MAX_ROW_COUNT, Math.floor(n))) : 0;
}

/** Every port the rows describe, as template ports. Data ports (copper and cages) are numbered
 * 1, 2, 3... in row order, the way a switch's silkscreen runs on into its SFP cages. A console
 * port is "console" and a power inlet "PSU", numbered only when there is more than one. */
export function describedPorts(rows: readonly DescribeRow[]): TemplatePort[] {
  const out: TemplatePort[] = [];
  const named = new Map<string, number>();
  for (const r of rows) {
    if (r.kind === 'console' || r.kind === 'power') named.set(r.kind, (named.get(r.kind) ?? 0) + wholeCount(r.count));
  }
  const seen = new Map<string, number>();
  let n = 0;
  for (const r of rows) {
    const k = kindOf(r.kind);
    for (let i = 0; i < wholeCount(r.count); i += 1) {
      let label: string;
      if (r.kind === 'console' || r.kind === 'power') {
        const base = r.kind === 'console' ? 'console' : 'PSU';
        const at = (seen.get(r.kind) ?? 0) + 1;
        seen.set(r.kind, at);
        label = (named.get(r.kind) ?? 0) > 1 ? `${base} ${at}` : base;
      } else {
        n += 1;
        label = String(n);
      }
      const port: TemplatePort = { label, connector: k.connector, face: r.face };
      if ('service' in k) port.service = k.service;
      out.push(port);
    }
  }
  return out;
}

export function describedCount(rows: readonly DescribeRow[]): number {
  return rows.reduce((n, r) => n + wholeCount(r.count), 0);
}

/** The faces that carry a port, in the order the preview unfolds them, each with its ports. */
export function portsByFace(ports: readonly TemplatePort[]): { face: PortFace; ports: TemplatePort[] }[] {
  return PORT_FACE_VALUES.map((face) => ({ face, ports: ports.filter((p) => p.face === face) })).filter((f) => f.ports.length > 0);
}

/** One line in words: "8 copper, 2 SFP on the right side". */
export function describedSummary(rows: readonly DescribeRow[]): string {
  const parts: string[] = [];
  for (const r of rows) {
    const c = wholeCount(r.count);
    if (c === 0) continue;
    const where = r.face === 'front' ? '' : r.face === 'top' ? ' on top' : r.face === 'rear' ? ' on the rear' : ` on the ${r.face} side`;
    parts.push(`${c} ${kindOf(r.kind).label}${where}`);
  }
  return parts.length === 0 ? 'No ports yet' : parts.join(', ');
}

/** Why the description cannot be used yet, or null when it can. */
export function describeProblem(name: string, rows: readonly DescribeRow[]): string | null {
  if (name.trim() === '') return 'Give it a name.';
  const count = describedCount(rows);
  if (count === 0) return 'Add at least one port.';
  if (count > MAX_DESCRIBED_PORTS) return `That is ${count} ports; one device takes up to ${MAX_DESCRIBED_PORTS}.`;
  return null;
}

/** A kept model's line in the equipment list: "10 ports · front, right side". */
export function portsSummary(ports: readonly TemplatePort[]): string {
  if (ports.length === 0) return 'No ports';
  const faces = portsByFace(ports).map((f) => (f.face === 'left' || f.face === 'right' ? `${f.face} side` : f.face));
  return `${ports.length === 1 ? '1 port' : `${ports.length} ports`} · ${faces.join(', ')}`;
}

/** The stem a described device is named from: "NUC 13 Pro" gives "nuc-13-pro", so the first one
 * is nuc-13-pro-1 and the next nuc-13-pro-2 (`racks/pick.ts`'s `nextHostname`). */
export function nameStem(name: string): string {
  const stem = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return stem === '' ? 'device' : stem;
}
