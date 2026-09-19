// ADR-0052 §1's browser engine client: boot the module, hand it both
// dictionaries, paste, and read the typed reply back. The redaction gate
// itself never runs here — it runs inside `fathom-wasm` (CLAUDE.md rule 4)
// — this file only speaks the wire protocol to it.
import { packDict, pasteFrame } from './frames';
import { decodeReply, type FaceRow } from './protocol';
import { ERRORS, FACES, OPCODES, errorName } from './protocol.constants';
import { type ByteLoader, type EngineWasm, fetchLoader, loadWasm } from './wasm';

/** The two dictionaries the drawer boots with (ADR-0052 §5's scope: "the
 * inside stop for a Junos SRX", plus the OPNsense rules table already on the
 * retired page). Booting both, always, mirrors `tests/common/mod.rs`'s
 * `booted_shell` — a helper that booted less than the real boot does would
 * let a slot-routing defect through untested. */
const DICT_PLATFORMS = ['junos-srx', 'opnsense'] as const;

const DEFAULT_MODULE_URL = '/engine/fathom_wasm.wasm';

/** One of `protocol.rs`'s `ERR_*` codes, surfaced as a typed exception rather
 * than a bare string — a caller that wants the code (to offer `ERR_LINK_CHOICE`
 * as buttons, say) does not have to parse it back out of a message. */
export class EngineError extends Error {
  readonly code: number;
  readonly detail: string;

  constructor(code: number, detail: string) {
    super(`fathom-wasm: ${errorName(code) ?? `error ${code}`}: ${detail}`);
    this.name = 'EngineError';
    this.code = code;
    this.detail = detail;
  }
}

export interface PasteSummary {
  nodes: number;
  edges: number;
  residueLines: number;
  secretsRedacted: number;
  unresolvedCount: number;
  deviceId: string;
  hostname: string;
  platform: string;
}

/** `FACE_RESIDUE`: one line the parser did not bind. */
export interface ResidueRow {
  line: number;
  text: string;
  reason: string;
}

/** `FACE_UNRESOLVED`: one reference the capture named and did not contain. */
export interface UnresolvedRow {
  name: string;
  edgeKind: string;
  line: number;
}

/** `FACE_PASTE_LINE` (ADR-0052 §2): one ledger line's fate — the drawer's
 * gutter mark. `outcome` is one of the four wire words `built`/`kept`/`noise`/
 * `quarantined`, never a Rust variant name (`protocol.rs`'s own discipline). */
export interface PasteLineRow {
  ordinal: number;
  outcome: string;
  byteStart: number;
  byteEnd: number;
  nodeId: string;
  fields: string;
  reason: string;
}

/** `FACE_DROP` (ADR-0052 §2): one value the gate destroyed. No original
 * length travels — the span is the fixed-width marker's, not the secret's
 * (`protocol.rs`'s own note on `FACE_DROP`). */
export interface DropRow {
  ordinal: number;
  markerStart: number;
  markerEnd: number;
  label: string;
  detectors: string;
}

export interface PasteResult {
  summary: PasteSummary;
  residue: ResidueRow[];
  unresolved: UnresolvedRow[];
  /** `FACE_CAPTURE`: the paste as the redaction gate left it. Empty when the
   * reply carried none (`encode_paste_reply` omits the row when the field is
   * empty). */
  capture: string;
  /** `FACE_SHAPE`: the estate's drift-detection digest, opaque to this
   * client — never parsed, truncated or displayed as a seal
   * (`protocol.rs`'s own warning on `FACE_SHAPE`). */
  shape: string;
  /** `FACE_PASTE_LINE` rows, one per ledger line, in ledger order. */
  lines: PasteLineRow[];
  /** `FACE_DROP` rows, one per destroyed value. */
  drops: DropRow[];
}

// --- OP_INSIDE (opcode 26), UI-SPEC "Inside a box" -------------------------
//
// `crates/fathom-wasm/src/protocol.rs`'s `encode_inside_reply`: one
// `FACE_INSIDE` head record, then `FACE_IN_IFACE` records each immediately
// followed by that interface's own `FACE_IN_UNIT` children, then every
// `FACE_IN_ZONE`, then `FACE_IN_SET` records each immediately followed by
// that set's own `FACE_IN_POLICY` children (already in the ordinal order the
// device reads them — `tests/inside.rs`'s own property 1, never re-sorted
// here), then `FACE_IN_ROUTE` records each immediately followed by that
// route's own `FACE_IN_PROTO` children, then every `FACE_IN_TUNNEL`. A
// live element that is not a `Device` (or one with nothing recorded yet)
// comes back as zero rows — `tests/inside.rs`'s
// `a_live_non_device_comes_back_empty` — decoded below to every field
// empty, not thrown as an error: UI-SPEC "Absent is drawn as absent."

/** One `FACE_IN_UNIT` row — a logical unit under an interface. `zoneId`/
 * `zoneName` are empty when the config names no zone for it (read off a
 * live `ZoneMember` edge, never inferred — `tests/inside.rs`'s
 * `a_units_zone_is_read_not_inferred`); `tunnel` is empty unless a live
 * `Tunnel.bind_interface` names this unit. */
export interface InsideUnit {
  id: string;
  interfaceId: string;
  label: string;
  /** Already comma-joined by the module (`protocol.rs`'s own note: "a
   * string a reader is shown is a string this side composed"). */
  addresses: string;
  zoneId: string;
  zoneName: string;
  tunnel: string;
}

/** One `FACE_IN_IFACE` row, with its `FACE_IN_UNIT` children gathered under
 * it. An interface with no unit at all is still a row — `unitCount` is `0`
 * and `units` is empty (`tests/inside.rs`'s `ge-0/0/2`, "description-only",
 * still a row). */
export interface InsideInterface {
  id: string;
  name: string;
  kindWord: string;
  unitCount: number;
  units: InsideUnit[];
}

/** One `FACE_IN_ZONE` row — "zones are regions inside the box" (UI-SPEC
 * "Inside a box"). `members` is the count the module walked; the regions
 * page draws are the units above whose `zoneId` names this zone's `id`. */
export interface InsideZone {
  id: string;
  name: string;
  members: number;
}

/** One `FACE_IN_POLICY` row — a rung on the ordinal rail. `action` is the
 * stored token verbatim (`permit`/`deny`/`reject`, `schema/enums/policy_action.yaml`),
 * never a verdict: "Fathom never says permitted or denied" (UI-SPEC "Inside
 * a box"). `enabled` is the wire's own three-state-safe string (`"1"`/`"0"`),
 * carried through rather than collapsed to a boolean the caller cannot tell
 * "off" apart from "the field forgot to say." */
export interface InsidePolicy {
  id: string;
  setId: string;
  ordinal: string;
  name: string;
  action: string;
  enabled: string;
  description: string;
}

/** One `FACE_IN_SET` row, with its `FACE_IN_POLICY` children already in
 * device order — "a policy set is a stack with an ordinal rail — a rack of
 * rules" (UI-SPEC "Inside a box"). `scope` is empty in this build:
 * `tests/inside.rs`'s `a_policy_set_cannot_name_the_zone_pair_it_governs`,
 * `PolicyScope` has no shape yet, so this client draws nothing rather than
 * inventing one. */
export interface InsidePolicySet {
  id: string;
  scope: string;
  policyCount: number;
  policies: InsidePolicy[];
}

/** One `FACE_IN_PROTO` row — a routing protocol instance's adjacency count,
 * never a listing of the adjacencies themselves (`tests/inside.rs`'s
 * `a_routing_protocol_counts_its_adjacencies`: "counted, not listed"). */
export interface InsideProtocol {
  id: string;
  instanceId: string;
  protocol: string;
  adjacencies: number;
}

/** One `FACE_IN_ROUTE` row, with its `FACE_IN_PROTO` children. */
export interface InsideRoute {
  id: string;
  name: string;
  protocols: InsideProtocol[];
}

/** One `FACE_IN_TUNNEL` row — `unit` names the interface unit it binds
 * (`tests/inside.rs`'s `the_tunnel_names_the_unit_it_binds`), so a caller
 * never has to cross the picture to draw the line back. */
export interface InsideTunnel {
  id: string;
  name: string;
  unit: string;
}

/** `OP_INSIDE` decoded. Everything empty (`deviceId`/`hostname` `''`, every
 * band an empty array, `unzoned` `0`) is the reply's own empty state — a
 * live element that named nothing this stop can draw, not an error and not
 * a field this client invents text for. */
export interface InsideFaces {
  deviceId: string;
  hostname: string;
  interfaces: InsideInterface[];
  zones: InsideZone[];
  policySets: InsidePolicySet[];
  routes: InsideRoute[];
  tunnels: InsideTunnel[];
  /** Slot 7's third decimal — units that name no zone at all
   * (`tests/inside.rs`: "ge-0/0/1.10 is in no zone, and that is reported
   * rather than blank"). The units themselves are still findable in
   * `interfaces[].units` by an empty `zoneId`; this is the count the head
   * itself already carries, read once rather than recomputed. */
  unzoned: number;
}

const EMPTY_INSIDE: InsideFaces = {
  deviceId: '',
  hostname: '',
  interfaces: [],
  zones: [],
  policySets: [],
  routes: [],
  tunnels: [],
  unzoned: 0,
};

function readInsideReply(rows: FaceRow[]): InsideFaces {
  if (rows.length === 0) {
    return EMPTY_INSIDE;
  }
  const head = rows[0];
  if (!head || head.role !== FACES.FACE_INSIDE) {
    throw new Error(`OP_INSIDE reply: record 0 is not the FACE_INSIDE head (got role ${head?.role})`);
  }
  const deviceId = head.strings[0];
  const hostname = head.strings[1];
  const tailParts = head.strings[7].split(' ');
  if (tailParts.length !== 3) {
    throw new Error(`OP_INSIDE reply: head slot 7 is "${head.strings[7]}", not three space-separated counts`);
  }
  const unzoned = parseCount(tailParts[2], 'inside head tail slot 2 (unzoned)');

  const interfaces: InsideInterface[] = [];
  const zones: InsideZone[] = [];
  const policySets: InsidePolicySet[] = [];
  const routes: InsideRoute[] = [];
  const tunnels: InsideTunnel[] = [];

  let currentIface: InsideInterface | null = null;
  let currentSet: InsidePolicySet | null = null;
  let currentRoute: InsideRoute | null = null;

  for (const row of rows.slice(1)) {
    switch (row.role) {
      case FACES.FACE_IN_IFACE:
        currentIface = {
          id: row.strings[0],
          name: row.strings[1],
          kindWord: row.strings[2],
          unitCount: parseCount(row.strings[3], 'interface unit count'),
          units: [],
        };
        interfaces.push(currentIface);
        break;
      case FACES.FACE_IN_UNIT:
        if (!currentIface) {
          throw new Error('OP_INSIDE reply: FACE_IN_UNIT arrived before any FACE_IN_IFACE');
        }
        currentIface.units.push({
          id: row.strings[0],
          interfaceId: row.strings[1],
          label: row.strings[2],
          addresses: row.strings[3],
          zoneId: row.strings[4],
          zoneName: row.strings[5],
          tunnel: row.strings[6],
        });
        break;
      case FACES.FACE_IN_ZONE:
        zones.push({
          id: row.strings[0],
          name: row.strings[1],
          members: parseCount(row.strings[2], 'zone member count'),
        });
        break;
      case FACES.FACE_IN_SET:
        currentSet = {
          id: row.strings[0],
          scope: row.strings[1],
          policyCount: parseCount(row.strings[2], 'policy set count'),
          policies: [],
        };
        policySets.push(currentSet);
        break;
      case FACES.FACE_IN_POLICY:
        if (!currentSet) {
          throw new Error('OP_INSIDE reply: FACE_IN_POLICY arrived before any FACE_IN_SET');
        }
        currentSet.policies.push({
          id: row.strings[0],
          setId: row.strings[1],
          ordinal: row.strings[2],
          name: row.strings[3],
          action: row.strings[4],
          enabled: row.strings[5],
          description: row.strings[6],
        });
        break;
      case FACES.FACE_IN_ROUTE:
        currentRoute = { id: row.strings[0], name: row.strings[1], protocols: [] };
        routes.push(currentRoute);
        break;
      case FACES.FACE_IN_PROTO:
        if (!currentRoute) {
          throw new Error('OP_INSIDE reply: FACE_IN_PROTO arrived before any FACE_IN_ROUTE');
        }
        currentRoute.protocols.push({
          id: row.strings[0],
          instanceId: row.strings[1],
          protocol: row.strings[2],
          adjacencies: parseCount(row.strings[3], 'protocol adjacency count'),
        });
        break;
      case FACES.FACE_IN_TUNNEL:
        tunnels.push({ id: row.strings[0], name: row.strings[1], unit: row.strings[2] });
        break;
      default:
        throw new Error(`OP_INSIDE reply: unexpected role ${row.role} (${row.roleName ?? 'unknown'})`);
    }
  }

  return { deviceId, hostname, interfaces, zones, policySets, routes, tunnels, unzoned };
}

function parseCount(value: string, what: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) {
    throw new Error(`${what} is not a decimal count: "${value}"`);
  }
  return n;
}

function readPasteReply(rows: FaceRow[]): PasteResult {
  const head = rows[0];
  if (!head || head.role !== FACES.FACE_PASTE) {
    throw new Error(`OP_PASTE reply: record 0 is not the FACE_PASTE summary (got role ${head?.role})`);
  }
  const summary: PasteSummary = {
    nodes: parseCount(head.strings[0], 'summary slot 0 (nodes)'),
    edges: parseCount(head.strings[1], 'summary slot 1 (edges)'),
    residueLines: parseCount(head.strings[2], 'summary slot 2 (residue lines)'),
    secretsRedacted: parseCount(head.strings[3], 'summary slot 3 (secrets redacted)'),
    unresolvedCount: parseCount(head.strings[4], 'summary slot 4 (unresolved)'),
    deviceId: head.strings[5],
    hostname: head.strings[6],
    platform: head.strings[7],
  };

  const residue: ResidueRow[] = [];
  const unresolved: UnresolvedRow[] = [];
  const lines: PasteLineRow[] = [];
  const drops: DropRow[] = [];
  let capture = '';
  let shape = '';

  for (const row of rows.slice(1)) {
    switch (row.role) {
      case FACES.FACE_RESIDUE:
        residue.push({
          line: parseCount(row.strings[0], 'residue line'),
          text: row.strings[1],
          reason: row.strings[2],
        });
        break;
      case FACES.FACE_UNRESOLVED:
        unresolved.push({
          name: row.strings[0],
          edgeKind: row.strings[1],
          line: parseCount(row.strings[2], 'unresolved line'),
        });
        break;
      case FACES.FACE_CAPTURE:
        capture = row.strings[0];
        break;
      case FACES.FACE_SHAPE:
        shape = row.strings[0];
        break;
      case FACES.FACE_PASTE_LINE:
        lines.push({
          ordinal: parseCount(row.strings[0], 'paste line ordinal'),
          outcome: row.strings[1],
          byteStart: parseCount(row.strings[2], 'paste line byte start'),
          byteEnd: parseCount(row.strings[3], 'paste line byte end'),
          nodeId: row.strings[4],
          fields: row.strings[5],
          reason: row.strings[6],
        });
        break;
      case FACES.FACE_DROP:
        drops.push({
          ordinal: parseCount(row.strings[0], 'drop ordinal'),
          markerStart: parseCount(row.strings[1], 'drop marker start'),
          markerEnd: parseCount(row.strings[2], 'drop marker end'),
          label: row.strings[3],
          detectors: row.strings[4],
        });
        break;
      default:
        throw new Error(`OP_PASTE reply: unexpected role ${row.role} (${row.roleName ?? 'unknown'})`);
    }
  }

  return { summary, residue, unresolved, capture, shape, lines, drops };
}

export class Engine {
  private readonly wasm: EngineWasm;

  private constructor(wasm: EngineWasm) {
    this.wasm = wasm;
  }

  /** Load the module and hand it both dictionaries (ADR-0052 §1). Defaults
   * to fetching the artefact `scripts/build-wasm.sh` stages; tests inject a
   * `fileLoader` instead — one code path (`wasm.ts`'s `loadWasm`), two
   * loaders. */
  static async init(loadBytes: ByteLoader = fetchLoader(DEFAULT_MODULE_URL)): Promise<Engine> {
    const wasm = await loadWasm(loadBytes);
    const engine = new Engine(wasm);
    for (const platform of DICT_PLATFORMS) {
      const reply = wasm.call(OPCODES.OP_DICT, packDict(platform));
      if (reply.length !== 0) {
        const view = decodeReply(reply);
        if (view.kind === 'error') {
          throw new EngineError(view.error.code, `booting the ${platform} dictionary: ${view.error.detail}`);
        }
        throw new Error(`OP_DICT for ${platform} returned an unexpected non-empty, non-error reply`);
      }
    }
    return engine;
  }

  /** The raw call, exposed for opcodes this slice does not otherwise wrap
   * (`OP_INV_ROWS`, used by the parity tests to check a paste's secret is
   * absent from everywhere the page can reach afterwards, not only the paste
   * reply — `tests/paste.rs`'s own check). */
  call(op: number, req: Uint8Array): Uint8Array {
    return this.wasm.call(op, req);
  }

  private callFaces(op: number, req: Uint8Array): FaceRow[] {
    const reply = this.wasm.call(op, req);
    const view = decodeReply(reply);
    if (view.kind === 'error') {
      throw new EngineError(view.error.code, view.error.detail);
    }
    if (view.kind === 'empty') {
      return [];
    }
    return view.rows;
  }

  /** `OP_PASTE`: pasted text in, the redacted estate's summary out. */
  paste(text: string, confirm = false, now: number = Date.now()): PasteResult {
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    const frame = pasteFrame(text, confirm, now, nonce);
    const rows = this.callFaces(OPCODES.OP_PASTE, frame);
    return readPasteReply(rows);
  }

  /** `OP_INV_ROWS`: one inventory kind's rows, undecoded — callers that only
   * need to scan the raw bytes (the canary checks) do not pay for a face
   * decode they are going to throw away. */
  invRowsRaw(kind: number): Uint8Array {
    return this.wasm.call(OPCODES.OP_INV_ROWS, new Uint8Array([kind]));
  }

  // --- ADR-0052 §4's two doors and one gesture -----------------------------
  //
  // Opcodes 28/29/30 are implemented on the Rust side (`fathom-wasm`): two
  // doors load the plain face into the module and export it back, and a
  // third pastes under a placed device.

  /** Door one: load a document's plain-face bytes into the module, so the
   * weld it holds is never reimplemented in JavaScript (ADR-0052 §4). */
  loadPlain(bytes: Uint8Array): void {
    const reply = this.wasm.call(OPCODES.OP_LOAD_PLAIN, bytes);
    if (reply.length === 0) {
      return;
    }
    const view = decodeReply(reply);
    if (view.kind === 'error') {
      throw new EngineError(view.error.code, view.error.detail);
    }
  }

  /** Door two: export the module's held estate as plain-face bytes — the
   * mirror of `loadPlain`, so every save carries what the gate let through.
   * The reply is the plain-face bytes THEMSELVES on success, not an FDLT
   * record, so a refusal can only be told apart by attempting the FDLT
   * decode and treating anything that fails it as the plain payload rather
   * than a protocol fault. */
  exportPlain(): Uint8Array {
    const reply = this.wasm.call(OPCODES.OP_EXPORT_PLAIN, new Uint8Array(0));
    if (reply.length === 0) {
      return reply;
    }
    try {
      const view = decodeReply(reply);
      if (view.kind === 'error') {
        throw new EngineError(view.error.code, view.error.detail);
      }
    } catch (e) {
      if (e instanceof EngineError) {
        throw e;
      }
      // Did not decode as FDLT at all: this is the plain-face payload, not a
      // protocol fault, and falls through to be returned below.
    }
    return reply;
  }

  /** Door three: paste under a placed device — the human answer ADR-0010
   * asks for, since choosing the faceplate is choosing the device. Frame:
   * the same 25-byte clock/entropy/confirm prefix `pasteFrame` builds, then a
   * u16-length-prefixed device display id, then the pasted text
   * (`shell.rs::paste_into`'s `PREFIX = 27` reads the length as two bytes at
   * offset 25). */
  pasteInto(deviceId: string, text: string, confirm = false, now: number = Date.now()): PasteResult {
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    const prefix = pasteFrame('', confirm, now, nonce).slice(0, 25);
    const encoder = new TextEncoder();
    const idBytes = encoder.encode(deviceId);
    const idLen = new Uint8Array(2);
    new DataView(idLen.buffer).setUint16(0, idBytes.length, true);
    const textBytes = encoder.encode(text);
    const frame = new Uint8Array(prefix.length + idLen.length + idBytes.length + textBytes.length);
    frame.set(prefix, 0);
    frame.set(idLen, prefix.length);
    frame.set(idBytes, prefix.length + idLen.length);
    frame.set(textBytes, prefix.length + idLen.length + idBytes.length);
    const rows = this.callFaces(OPCODES.OP_PASTE_INTO, frame);
    return readPasteReply(rows);
  }

  /** `OP_INSIDE`: the zoom ladder's stop beyond the faceplate (UI-SPEC "Zoom
   * is one continuous camera"). Request is the raw UTF-8 display id, no
   * framing (`shell.rs::node_request` reads the whole request buffer as the
   * id string, the same convention `OP_ELEMENT`/`OP_EQUIPMENT` already use).
   * A display id that names nothing is `ERR_NO_ELEMENT`, surfaced as the
   * usual `EngineError` by `callFaces`; a live element that is not a
   * `Device` is the reply's own empty state, not an error
   * (`tests/inside.rs`'s `a_live_non_device_comes_back_empty`) and decoded
   * to `EMPTY_INSIDE` above rather than thrown. */
  inside(deviceId: string): InsideFaces {
    const req = new TextEncoder().encode(deviceId);
    const rows = this.callFaces(OPCODES.OP_INSIDE, req);
    return readInsideReply(rows);
  }
}

export { ERRORS };
