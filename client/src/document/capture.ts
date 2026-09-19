// The config drawer's own read model (ADR-0052 §3, §4). A `Capture` is a
// node the weld wrote on the `Device` it pasted under — the redacted text,
// its platform and a line count — and every field a paste bound anywhere in
// the document carries an `Origin::Parsed { capture, span }` naming this
// same node and a byte range inside its `text`. That is "no join" (ADR-0052
// §3's own words): this module never stores a second copy of which line
// built what: it walks the document's own provenance once and reads the
// gutter mark straight back off it, whether that document was just handed
// back by `mirror.ts`'s `pasteInto` or loaded from a save made months ago.
//
// `<REDACTED:label>` markers are read the same way — straight out of
// `Capture.text` — never a second stored ledger of what the gate destroyed
// (`crates/fathom-ingest/src/redact.rs`'s `marker`, mirrored here only as
// the fixed string shape, never reimplemented as a redactor: CLAUDE.md rule
// 4 is about the gate that DECIDES what to destroy, which never runs here;
// reading the marker it already left behind is not that gate).

import {
  edgesOut,
  findNode,
  parseNodeId,
  type Document,
  type FieldEntry,
  type GraphNode,
} from './model';
import { KIND_FIELDS, type NodeKind } from '../../../schema/generated/ir_types';

/** One value the gate destroyed, found on reopen by the marker it left in
 * `Capture.text` rather than by a stored `FACE_DROP` row (there is none to
 * store — ADR-0052 §3). `start`/`end` are JS string offsets into this
 * line's own `text`, ready for a caller to slice and overlay the block; see
 * this file's own note on why that is a different offset space from the
 * `Origin.span` byte range used to find the line in the first place. */
export interface CaptureDrop {
  start: number;
  end: number;
  label: string;
}

/** ADR-0052 §2's four wire outcomes collapse to three gutter marks here —
 * `quarantined` and `noise`/`kept` are all "not built" from the drawer's
 * own point of view (UI-SPEC "Config": "kept as text" is the one word for
 * everything the gate did not destroy and nothing bound). A line that both
 * built a field AND carries a destroyed value (the PSK line, which still
 * binds: `protocol.rs`'s own note on `FACE_PASTE_LINE`) is `'built'` here,
 * with `drops` non-empty — the drawer draws both the dot and the block on
 * the one row, never a fourth mark. */
export type CaptureMark = 'built' | 'kept' | 'destroyed';

export interface CaptureLine {
  /** 1-based — the line's own position in `Capture.text`, `split('\n')`
   * order. Not `FACE_PASTE_LINE`'s wire `ordinal` (that one is 0-based,
   * `shell.rs::line_rows`'s own doc); this is a display number, derived
   * fresh from the text every time, and the two never need to agree. */
  ordinal: number;
  text: string;
  mark: CaptureMark;
  /** The name of whatever this line built, when it built something with a
   * name at all (`ConfigDrawer.tsx` decides from this whether it names a
   * port on the faceplate — that check needs the chassis's own ports, which
   * this module does not have). `null` for a line that built nothing named
   * — a policy match clause, an address, anything with no `name` field on
   * the schema's own registry — or nothing at all. */
  builtLabel: string | null;
  drops: CaptureDrop[];
}

export interface CaptureView {
  id: string;
  platform: string;
  lineCount: number;
  lines: CaptureLine[];
}

// ---------------------------------------------------------------------------
// Field reads. `document/model.ts`'s own typed readers stop at the five
// kinds its session drew (its file header, verbatim); `Capture`'s three
// fields are schema 0.9's own addition and are not among them, so this
// module reads its own node's fields directly, the same way `model.ts`'s
// header says every OTHER kind's fields are meant to be read — straight off
// the registry, never invented (CLAUDE.md rule 3): `Capture.text`,
// `Capture.platform` are field-keys.yaml 326/327.

function fieldValue(node: GraphNode, name: string): FieldEntry['value'] {
  const entry = node.fields[name];
  return entry && entry.presence === 'set' ? entry.value : undefined;
}

function asString(v: FieldEntry['value']): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** The four interface kinds — `schema/schema.json`'s generated
 * `InterfaceLike` class, named again here rather than imported because
 * `ir_types.ts` does not export class membership, only per-kind field
 * lists. The only kinds `ConfigDrawer.tsx` ever tries to light a port for;
 * every other named kind still gets its `builtLabel`, just never a port. */
const INTERFACE_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'Interface',
  'AggregateInterface',
  'RethInterface',
  'TunnelInterface',
]);

function nameOf(node: GraphNode): string | undefined {
  const kind = parseNodeId(node.id).kind;
  if (!KIND_FIELDS[kind]?.includes('name')) return undefined;
  return asString(fieldValue(node, `${kind}.name`));
}

/** ADR-0052 §3's own doc on `Capture`'s L0 tuple: a `Capture` is not
 * singular under its `Device` the way a `LayoutPin` is under its element
 * (`HasCapture`'s `out: "0..n"`). In practice a device carries at most one
 * LIVE capture today — the door refuses a second paste onto a device that
 * already has one, until "replace a capture" exists (the ADR's own
 * amendment) — so the first live `HasCapture` target is the whole answer;
 * anything else found is a tombstoned capture from before that refusal
 * existed, not this one. */
function liveCaptureNode(doc: Document, deviceId: string): GraphNode | undefined {
  for (const edge of edgesOut(doc, deviceId, 'HasCapture')) {
    const node = findNode(doc, edge.to);
    if (node && node.absentSince === undefined) return node;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Line splitting. `Origin.span` and (per `protocol.rs`'s own doc on
// `FACE_DROP`) the wire's marker spans are both byte offsets into the
// POST-GATE capture text — UTF-8 bytes, not UTF-16 code units. Splitting on
// the raw encoded bytes (rather than a JS `string.split('\n')`) is what
// keeps a line's [start, end) lined up with what a parsed provenance
// record's span actually means when the text carries anything outside
// ASCII; splitting on the byte 0x0A is always safe because UTF-8's
// continuation bytes are all >= 0x80 and 0x0A can therefore only ever be a
// real newline.
interface ByteLine {
  start: number;
  end: number;
  text: string;
}

function splitByteLines(text: string): ByteLine[] {
  const bytes = new TextEncoder().encode(text);
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const lines: ByteLine[] = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] === 0x0a) {
      lines.push({ start, end: i, text: decoder.decode(bytes.subarray(start, i)) });
      start = i + 1;
    }
  }
  if (start < bytes.length) {
    lines.push({ start, end: bytes.length, text: decoder.decode(bytes.subarray(start, bytes.length)) });
  }
  return lines;
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && aEnd > bStart;
}

const REDACTED_MARKER = /<REDACTED:([^>]+)>/g;

function dropsIn(lineText: string): CaptureDrop[] {
  const drops: CaptureDrop[] = [];
  REDACTED_MARKER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REDACTED_MARKER.exec(lineText)) !== null) {
    drops.push({ start: m.index, end: m.index + m[0].length, label: m[1] });
  }
  return drops;
}

// ---------------------------------------------------------------------------

interface BuiltSpan {
  start: number;
  end: number;
  owner: GraphNode | null;
}

/** Every field, on any live node or edge, whose own provenance is
 * `Origin::Parsed` against THIS capture — walked once for the whole
 * document rather than once per line. An edge's owner (for `builtLabel`
 * purposes) is its `to` node when one is live, since that is the thing the
 * statement is usually naming (a zone membership names the zone or the
 * interface it binds, never the edge itself, which has no name field to
 * read). */
function builtSpans(doc: Document, captureUlid: string): BuiltSpan[] {
  const provSpan = new Map<string, { start: number; end: number }>();
  for (const rec of doc.provenance) {
    // `rec.origin.capture` is the wire's bare ULID (`crates/fathom-workspace/src/lib.rs`'s
    // `provenance_to_json`: `ulid_json(capture.0)`), never the formatted
    // `<kebab-kind>:<ulid>` node id (`model.ts`'s own `formatNodeId`, used
    // for `n.id.to_string()` on the Rust side too) — compared here against
    // the capture node's own bare ULID, not its formatted id.
    if (rec.origin.kind === 'parsed' && rec.origin.capture === captureUlid) {
      provSpan.set(rec.id, rec.origin.span);
    }
  }
  if (provSpan.size === 0) return [];

  const spans: BuiltSpan[] = [];
  for (const n of doc.nodes) {
    if (n.absentSince !== undefined) continue;
    for (const entry of Object.values(n.fields)) {
      if (entry.presence !== 'set') continue;
      const span = provSpan.get(entry.prov);
      if (span) spans.push({ start: span.start, end: span.end, owner: n });
    }
  }
  for (const e of doc.edges) {
    if (e.absentSince !== undefined) continue;
    const owner = findNode(doc, e.to) ?? findNode(doc, e.from) ?? null;
    const existSpan = provSpan.get(e.prov);
    if (existSpan) spans.push({ start: existSpan.start, end: existSpan.end, owner });
    for (const entry of Object.values(e.fields)) {
      if (entry.presence !== 'set') continue;
      const span = provSpan.get(entry.prov);
      if (span) spans.push({ start: span.start, end: span.end, owner });
    }
  }
  return spans;
}

function builtLabelFor(spans: BuiltSpan[]): string | null {
  let fallback: string | null = null;
  for (const s of spans) {
    if (!s.owner) continue;
    const name = nameOf(s.owner);
    if (!name) continue;
    if (INTERFACE_KINDS.has(parseNodeId(s.owner.id).kind)) return name;
    if (fallback === null) fallback = name;
  }
  return fallback;
}

/** Derives the config drawer's `CaptureView` for one device's live capture,
 * straight off the document — the marks come from provenance spans and the
 * `<REDACTED:label>` markers `Capture.text` already carries, both true
 * whether the document just came back from a paste (`mirror.ts`'s
 * `pasteInto`, which round-trips it through the module) or was loaded from
 * a save made earlier. `null` when this device carries no live capture. */
export function captureOf(doc: Document, deviceId: string): CaptureView | null {
  const node = liveCaptureNode(doc, deviceId);
  if (!node) return null;

  const text = asString(fieldValue(node, 'Capture.text')) ?? '';
  const platform = asString(fieldValue(node, 'Capture.platform')) ?? '';
  const spans = builtSpans(doc, parseNodeId(node.id).ulid);

  const lines: CaptureLine[] = splitByteLines(text).map((line, i) => {
    const builtHere = spans.filter((s) => overlaps(s.start, s.end, line.start, line.end));
    const drops = dropsIn(line.text);
    const mark: CaptureMark = builtHere.length > 0 ? 'built' : drops.length > 0 ? 'destroyed' : 'kept';
    return {
      ordinal: i + 1,
      text: line.text,
      mark,
      builtLabel: builtHere.length > 0 ? builtLabelFor(builtHere) : null,
      drops,
    };
  });

  return { id: node.id, platform, lineCount: lines.length, lines };
}
