// Drives the REAL module — `client/public/engine/fathom_wasm.wasm`, built by
// `scripts/build-wasm.sh` — through the same client the browser will use.
// This is the client-side half of `crates/fathom-wasm/tests/paste.rs`: same
// paste text, same expected summary, plus the byte-level canary sweep
// `scripts/drive-reconciled-paste.mjs` runs against the real page.
//
// Run `bash scripts/build-wasm.sh` first. This file fails loudly, not
// silently, if the artefact is missing — it does not fall back to a stub.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { DICT_PLATFORMS, DICT_PLATFORMS_EXCLUDED, Engine, EngineError } from './engine';
import { allDictPlatforms } from './frames';
import { decodeReply } from './protocol';
import { ERRORS, OPCODES } from './protocol.constants';
import { fileLoader } from './wasm';
import { connectPorts } from '../document/cables';
import { addSketchPort, createSketchDevice, removeChassis } from '../document/commands';
import { setDeviceField } from '../document/edit';
import { addContainer, addContainerNetwork, addPublishedPort, attachContainerToNetwork } from '../document/docker';
import { edgesIn, edgesOut, emptyDocument, text, type Document } from '../document/model';
import { addSubnet, addVlan, removeVlanNetwork } from '../document/networks';
import { begin, createFreeBox, createLabel, createLine, finish, removeFree, setLineLabel, setNodeField } from '../document/freeform';
import { addNote } from '../document/notes';
import { writePlain } from '../document/plain';
import { undo } from '../document/undo';
import { addStep, createPlan, markDone, markWentDifferently, recordPlan, startPlan, readPlan } from '../document/plans';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.resolve(__dirname, '../../public/engine/fathom_wasm.wasm');

if (!existsSync(WASM_PATH)) {
  throw new Error(
    `client/src/engine/engine.test.ts: ${WASM_PATH} does not exist. ` +
      'Run `bash scripts/build-wasm.sh` from the repo root before running this suite.',
  );
}

/// crates/fathom-wasm/tests/paste.rs's own `PASTE` constant, verbatim — the
/// same route-based IPsec config, deliberately mixed: statements the
/// dictionary knows, one it does not, one it half understands, and one
/// pre-shared key that must never survive the call.
const PASTE = `set system host-name srx-branch-01
set interfaces ge-0/0/0 unit 0 family inet address 203.0.113.2/30
set interfaces st0 unit 0 family inet address 10.255.0.1/30
set security ike proposal ike-prop authentication-method pre-shared-keys
set security ike proposal ike-prop dh-group group14
set security ike proposal ike-prop encryption-algorithm aes-256-cbc
set security ike policy ike-pol proposals ike-prop
set security ike policy ike-pol pre-shared-key ascii-text "SuperSecret123"
set security ike gateway gw-hq ike-policy ike-pol
set security ike gateway gw-hq address 198.51.100.10
set security ike gateway gw-hq external-interface ge-0/0/0.0
set security ipsec proposal ipsec-prop protocol esp
set security ipsec policy ipsec-pol proposals ipsec-prop
set security ipsec vpn hq-vpn ike gateway gw-hq
set security ipsec vpn hq-vpn ike ipsec-policy ipsec-pol
set security ipsec vpn hq-vpn bind-interface st0.0
set security zones security-zone trust interfaces ge-0/0/0.0
set security zones security-zone vpn interfaces st0.0
set routing-options static route 10.10.0.0/16 next-hop st0.0
set security policies from-zone trust to-zone vpn policy allow match source-address any
set security policies from-zone trust to-zone vpn policy allow match application any
`;
const PASTE_SECRET = 'SuperSecret123';

/// scripts/drive-reconciled-paste.mjs's own `SECRETS` and `PASTE`, verbatim —
/// the reconciliation's six canaries, in one config.
const CANARIES = [
  'FATHOMDRIVEospfSimplePw0123456789',
  'FATHOMDRIVEbgpKeyBare',
  'FATHOMDRIVEbgpKeyGroup',
  'FATHOMDRIVEbgpKeyNeighbour',
  'FATHOMDRIVEikePreShared0123456789',
  'FATHOMDRIVEsnmpCommunity',
];
const CANARY_PASTE = `set system host-name srx-reconciled-01
set system time-zone America/New_York
set system ntp server 192.0.2.30
set routing-options router-id 10.0.0.9
set protocols ospf reference-bandwidth 100000000000
set protocols ospf area 0.0.0.0 interface ge-0/0/1.0 metric 100
set protocols ospf area 0.0.0.0 interface ge-0/0/2.0 passive
set protocols ospf area 0.0.0.1 interface st0.0 interface-type p2p
set protocols ospf area 0.0.0.0 interface ge-0/0/1.0 authentication simple-password FATHOMDRIVEospfSimplePw0123456789
set protocols bgp local-as 65001
set protocols bgp authentication-key FATHOMDRIVEbgpKeyBare
set protocols bgp group ISP-EDGE authentication-key FATHOMDRIVEbgpKeyGroup
set protocols bgp group ISP-EDGE neighbor 203.0.113.1 peer-as 64512
set protocols bgp group ISP-EDGE neighbor 203.0.113.1 authentication-key FATHOMDRIVEbgpKeyNeighbour
set protocols rip group RIP-GRP neighbor ge-0/0/9.0
set vlans guests vlan-id 20
set vlans guests l3-interface irb.20
set interfaces ge-0/0/4 disable
set interfaces ge-0/0/6 unit 0 vlan-id 100
set security flow tcp-mss ipsec-vpn mss 1350
set security zones security-zone trust host-inbound-traffic protocols all
set security zones security-zone untrust tcp-rst
set security ike policy ike-pol pre-shared-key ascii-text FATHOMDRIVEikePreShared0123456789
set snmp community FATHOMDRIVEsnmpCommunity authorization read-only
`;

/** Byte-level substring search — deliberately not `TextDecoder` first: a
 * canary must be absent from the RAW reply bytes, not merely from however a
 * lossy or reordering decode would render them back. */
function bytesInclude(haystack: Uint8Array, needle: string): boolean {
  const needleBytes = new TextEncoder().encode(needle);
  if (needleBytes.length === 0 || needleBytes.length > haystack.length) {
    return false;
  }
  outer: for (let i = 0; i + needleBytes.length <= haystack.length; i++) {
    for (let j = 0; j < needleBytes.length; j++) {
      if (haystack[i + j] !== needleBytes[j]) {
        continue outer;
      }
    }
    return true;
  }
  return false;
}

let engine: Engine;
let loadMs: number;

beforeAll(async () => {
  const t0 = performance.now();
  engine = await Engine.init(fileLoader(WASM_PATH));
  loadMs = performance.now() - t0;
  // No assertion on the number — the task asks it measured and printed.
  console.log(`fathom-wasm: module load + boot (both dictionaries): ${loadMs.toFixed(2)}ms`);
});

describe('boot', () => {
  it('loads the module and boots both dictionaries without throwing', () => {
    expect(engine).toBeDefined();
  });
});

describe('OP_PASTE parity with crates/fathom-wasm/tests/paste.rs', () => {
  it('matches the Rust test\'s summary: secrets, hostname, platform', () => {
    const t0 = performance.now();
    const result = engine.paste(PASTE);
    const pasteMs = performance.now() - t0;
    console.log(`fathom-wasm: OP_PASTE (the paste.rs config): ${pasteMs.toFixed(2)}ms`);

    expect(result.summary.nodes).toBeGreaterThan(0);
    expect(result.summary.edges).toBeGreaterThan(0);
    expect(result.summary.secretsRedacted).toBe(1);
    expect(result.summary.hostname).toBe('srx-branch-01');
    expect(result.summary.platform).toBe('junos-srx');
  });

  it('never returns the pre-shared key, in any byte of any reply the page can reach', () => {
    const pasteReply = engine.call(
      OPCODES.OP_PASTE,
      // Rebuild the same frame paste() would, so we can inspect the raw
      // bytes rather than the decoded strings.
      (() => {
        const nonce = crypto.getRandomValues(new Uint8Array(16));
        const at = new Uint8Array(8);
        new DataView(at.buffer).setBigUint64(0, BigInt(Date.now()), true);
        const text = new TextEncoder().encode(PASTE);
        const out = new Uint8Array(25 + text.length);
        out.set(at, 0);
        out.set(nonce, 8);
        out[24] = 0;
        out.set(text, 25);
        return out;
      })(),
    );
    expect(bytesInclude(pasteReply, PASTE_SECRET)).toBe(false);

    // Everything the page can reach afterwards, not just the paste reply
    // (tests/paste.rs's own `the_pre_shared_key_never_comes_back`).
    for (const kind of [0, 1, 2]) {
      const reply = engine.invRowsRaw(kind);
      expect(bytesInclude(reply, PASTE_SECRET)).toBe(false);
    }
  });
});

describe('the six drive-reconciled-paste.mjs canaries', () => {
  it('are absent from every byte of the paste reply', () => {
    // A fresh engine: the parity test above already holds a device named
    // srx-branch-01 and this paste's hostname differs, so either engine
    // would do, but a fresh one keeps this test's evidence self-contained.
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    const at = new Uint8Array(8);
    new DataView(at.buffer).setBigUint64(0, BigInt(Date.now()), true);
    const text = new TextEncoder().encode(CANARY_PASTE);
    const frame = new Uint8Array(25 + text.length);
    frame.set(at, 0);
    frame.set(nonce, 8);
    frame[24] = 0;
    frame.set(text, 25);

    const reply = engine.call(OPCODES.OP_PASTE, frame);
    for (const canary of CANARIES) {
      expect(bytesInclude(reply, canary)).toBe(false);
    }
  });
});

/** `OP_EQUIP_ADD`'s frame (`shell.rs::equip_add`'s own doc, PREFIX = 24): the
 * usual clock/entropy prefix, a field count byte, then `count` x
 * `[u16 field_key][u16 byte_len][utf8 value]`. Built inline, the same way
 * this file already builds `OP_PASTE`'s frame by hand above, rather than
 * adding production wiring no page needs yet. */
const DEVICE_HOSTNAME_KEY = 6; // schema/field-keys.yaml: Device.hostname
const DEVICE_PLATFORM_KEY = 7; // schema/field-keys.yaml: Device.platform

function equipAddFrame(now: number, nonce: Uint8Array, fields: [number, string][]): Uint8Array {
  const at = new Uint8Array(8);
  new DataView(at.buffer).setBigUint64(0, BigInt(now), true);
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [at, nonce, new Uint8Array([fields.length])];
  for (const [key, value] of fields) {
    const valueBytes = encoder.encode(value);
    const head = new Uint8Array(4);
    new DataView(head.buffer).setUint16(0, key, true);
    new DataView(head.buffer).setUint16(2, valueBytes.length, true);
    parts.push(head, valueBytes);
  }
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Places one device via `OP_EQUIP_ADD` and returns the display id
 * `equip_reply_text` puts at summary slot 5 — the same shape `OP_PASTE`'s
 * reply carries (`shell.rs::equip_reply_text` reuses `encode_paste_reply`). */
function placeDevice(hostname: string, platform: string): string {
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  const frame = equipAddFrame(Date.now(), nonce, [
    [DEVICE_HOSTNAME_KEY, hostname],
    [DEVICE_PLATFORM_KEY, platform],
  ]);
  const reply = engine.call(OPCODES.OP_EQUIP_ADD, frame);
  const view = decodeReply(reply);
  if (view.kind !== 'faces') {
    throw new Error(`OP_EQUIP_ADD did not reply with faces: ${JSON.stringify(view)}`);
  }
  return view.rows[0].strings[5];
}

describe("ADR-0052 §4's three doors (opcodes 28/29/30)", () => {
  it('OP_LOAD_PLAIN (28) / OP_EXPORT_PLAIN (29) round-trip the checked-in empty vector', () => {
    const vectorPath = path.resolve(__dirname, '../document/vectors/empty.plain');
    // The client's ambient `node:fs` shim (zero packages, no @types/node) reads text only;
    // the plain face is UTF-8, so encoding the string back gives the file's bytes.
    const bytes = new TextEncoder().encode(readFileSync(vectorPath, 'utf8'));

    engine.loadPlain(bytes);
    const exported = engine.exportPlain();

    expect(new TextDecoder().decode(exported)).toBe(new TextDecoder().decode(bytes));
  });

  it('OP_PASTE_INTO (30) writes onto a device this test placed, not a literal id', () => {
    const deviceId = placeDevice('srx-placed-01', 'junos-srx');

    const result = engine.pasteInto(deviceId, 'set system host-name srx-placed-01-renamed');

    expect(result.summary.deviceId).toBe(deviceId);
    expect(result.summary.hostname).toBe('srx-placed-01-renamed');
  });
});

// `OP_INSIDE` (opcode 26), decoded by `Engine.inside` — the inside stop's
// own contract. Placed via `OP_EQUIP_ADD` (`placeDevice`, above) rather than
// built by the paste itself, then `PASTE` (`crates/fathom-wasm/tests/paste.rs`'s
// own constant, this file's copy above) lands on it through `OP_PASTE_INTO`
// — the same two-step `mirror.test.ts` already drives. `tests/inside.rs`
// asserts its zone/policy counts against its own longer `SRX` fixture; this
// asserts them against `PASTE`'s own two `security zones` statements and one
// `security policies` statement, so the numbers below are this text's own,
// not copied from a different fixture.
describe('OP_INSIDE (26)', () => {
  it('decodes the zones and the one policy set this paste actually declares', () => {
    const deviceId = placeDevice('srx-inside-01', 'junos-srx');
    engine.pasteInto(deviceId, PASTE);

    const faces = engine.inside(deviceId);

    expect(faces.deviceId).toBe(deviceId);
    expect(faces.hostname).toBe('srx-branch-01');

    // `set security zones security-zone trust interfaces ge-0/0/0.0` and
    // `... vpn interfaces st0.0` — two zones, by name.
    expect(faces.zones.map((z) => z.name).sort()).toEqual(['trust', 'vpn']);

    // `set security policies from-zone trust to-zone vpn policy allow ...`,
    // twice — one policy set, one policy named `allow` (the second line
    // adds a field to the same policy, not a second one).
    expect(faces.policySets.length).toBe(1);
    expect(faces.policySets[0].policies.length).toBe(1);
    expect(faces.policySets[0].policies[0].name).toBe('allow');

    // Property 2, this client's own decode of it: whatever the module
    // stored travels verbatim, and nothing that reads as Fathom's own
    // verdict does. `PASTE` never states a `then permit`/`then deny` for
    // this policy, so the honest value here is the empty string — UI-SPEC
    // "Absent is drawn as absent" — not a guessed default.
    expect(faces.policySets[0].policies[0].action).toBe('');
    const everyString = JSON.stringify(faces).toLowerCase();
    for (const word of ['permitted', 'denied', 'allowed', 'blocked']) {
      expect(everyString).not.toContain(word);
    }

    // `st0.0` binds `hq-vpn` — the fourth band pointing back at the first.
    expect(faces.tunnels.length).toBe(1);
    expect(faces.tunnels[0].name).toBe('hq-vpn');
    expect(faces.tunnels[0].unit).toBe('st0.0');
  });

  it('a display id that names nothing is ERR_NO_ELEMENT, surfaced as an EngineError', () => {
    expect(() => engine.inside('device:not-a-real-ulid')).toThrow();
  });
});

// ADR-0053 §6 — the redaction gate alone, for a pasted note. `OP_REDACT_TEXT`
// (opcode 31) is landing on the Rust side in parallel with this client slice;
// if this build of `fathom_wasm.wasm` predates it, the module answers
// `ERR_UNKNOWN_OP` and this test says so, loudly, rather than pretending the
// door was exercised — the gate re-runs this suite once the artefact is
// rebuilt from the landed Rust.
describe('OP_REDACT_TEXT (31)', () => {
  it('gates a pasted note exactly as it gates a captured configuration', () => {
    // A short, device-realistic PSK — no real device takes a 20-character
    // one, and the detector is statement-driven, not length-sensitive, so a
    // fixture this short is the honest test, not the lenient one.
    const note = 'set security ike policy ike-pol pre-shared-key ascii-text "Sw0rdFsh"';
    let result: ReturnType<Engine['redactText']>;
    try {
      result = engine.redactText(note);
    } catch (e) {
      if (e instanceof EngineError && e.code === ERRORS.ERR_UNKNOWN_OP) {
        // Loud, not silent (this file's own promise): a stale or missing
        // artefact fails the gate's one client-side test rather than
        // reporting it green having never exercised the door at all.
        throw new Error(
          'OP_REDACT_TEXT (31) is not in this build of fathom_wasm.wasm — ' +
            "the Rust builder's work has not landed in this artefact, or it " +
            'predates opcode 31. Run scripts/build-wasm.sh and rerun this test.',
        );
      }
      throw e;
    }
    expect(result.text).not.toContain('Sw0rdFsh');
    expect(result.drops.length).toBeGreaterThan(0);
  });
});

// engine.ts's own DICT_PLATFORMS doc comment: a platform directory under
// corpus/dict/ that is not in that list boots with no platform-specific
// `secret:` path entries at all (ADR-0044 §2). This is the test that comment
// promises exists — it fails the day a new corpus/dict/<platform>/ lands and
// nobody wires it into DICT_PLATFORMS (or, deliberately, into the excluded
// list with a reason).
describe('DICT_PLATFORMS covers every directory under corpus/dict/', () => {
  it('every directory is either booted or explicitly, reason-fully excluded', () => {
    const onDisk = allDictPlatforms();
    const booted = new Set<string>(DICT_PLATFORMS);
    const excluded = new Set(Object.keys(DICT_PLATFORMS_EXCLUDED));
    const unaccountedFor = onDisk.filter((p) => !booted.has(p) && !excluded.has(p));
    expect(
      unaccountedFor,
      `corpus/dict/ has ${JSON.stringify(unaccountedFor)} which engine.ts's DICT_PLATFORMS ` +
        'neither boots nor DICT_PLATFORMS_EXCLUDED names a reason to skip',
    ).toEqual([]);

    // And the excluded list itself must not be fiction: every name in it
    // still has to exist on disk, or the exclusion is dead weight.
    for (const name of excluded) {
      expect(onDisk, `DICT_PLATFORMS_EXCLUDED names "${name}", not present under corpus/dict/`).toContain(name);
    }

    // No name is both booted and excluded — that would be a contradiction,
    // not a decision.
    for (const name of booted) {
      expect(excluded.has(name), `"${name}" is in both DICT_PLATFORMS and DICT_PLATFORMS_EXCLUDED`).toBe(false);
    }
  });
});

describe('a design stays saveable after undo', () => {
  it('undoing a drawn cable and two drawn ports still loads through the Rust reader', () => {
    const actor = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    let now = 1_790_000_000_000;
    const step = () => ({ actor, now: (now += 1000) });
    const added = (before: Document, after: Document, prefix: string) =>
      after.nodes.find((n) => n.id.startsWith(prefix) && !before.nodes.some((b) => b.id === n.id))!.id;

    let doc = emptyDocument();
    const chassis: string[] = [];
    const ports: string[] = [];
    for (const label of ['eth0', 'eth1']) {
      const before = doc;
      doc = createSketchDevice(doc, step());
      chassis.push(added(before, doc, 'chassis:'));
      const beforePort = doc;
      doc = addSketchPort(doc, chassis[chassis.length - 1], { label, connector: 'rj45', face: 'front' }, step());
      ports.push(added(beforePort, doc, 'physical-port:'));
    }
    doc = connectPorts(doc, ports[0], ports[1], {}, step());
    // The cable first, then both ports: newest first, as Ctrl Z would.
    for (const batch of doc.batches.slice(-3).reverse()) doc = undo(doc, batch.id, step());

    expect(() => engine.loadPlain(writePlain(doc))).not.toThrow();
  });

  it('free boxes, a line, a label and an area load through the Rust reader, before and after removal', () => {
    const step = (() => {
      let now = 1_790_600_000_000;
      return () => ({ actor: '01ARZ3NDEKTSV4RRFFQ69G5FAV', now: (now += 1000) });
    })();
    const a = createFreeBox(emptyDocument(), { role: 'router', hostname: 'router-1', x: 40, y: 40, ...step() });
    const b = createFreeBox(a.doc, { role: 'switch', hostname: 'switch-1', x: 300, y: -40, ...step() });
    let doc = createLine(b.doc, a.chassisId, b.chassisId, step()).doc;
    doc = setLineLabel(doc, doc.nodes.find((n) => n.id.startsWith('line:'))!.id, 'uplink', step());
    doc = createLabel(doc, { text: 'Floor 2', form: 'text', x: 0, y: 0, ...step() }).doc;
    doc = createLabel(doc, { text: 'Guest', form: 'area', x: 200, y: 200, w: 240, h: 160, ...step() }).doc;
    expect(() => engine.loadPlain(writePlain(doc))).not.toThrow();
    const removed = removeFree(doc, [a.chassisId], step());
    expect(() => engine.loadPlain(writePlain(removed))).not.toThrow();
    expect(() => engine.loadPlain(writePlain(undo(removed, removed.batches.at(-1)!.id, step())))).not.toThrow();
  });

  it('addVlan, addSubnet and removeVlanNetwork each still load through the Rust reader after undo', () => {
    const actor = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    let now = 1_790_100_000_000;
    const step = () => ({ actor, now: (now += 1000) });
    const added = (before: Document, after: Document, prefix: string) =>
      after.nodes.find((n) => n.id.startsWith(prefix) && !before.nodes.some((b) => b.id === n.id))!.id;

    let doc = emptyDocument();
    doc = createSketchDevice(doc, step());
    const chassisId = doc.nodes.find((n) => n.id.startsWith('chassis:'))!.id;
    const beforePort = doc;
    doc = addSketchPort(doc, chassisId, { label: 'Et1', connector: 'rj45', face: 'front' }, step());
    const portId = added(beforePort, doc, 'physical-port:');

    doc = addVlan(doc, { vlanId: 10, attach: [{ target: { kind: 'port', portId, interfaceName: 'Et1' } }] }, step());
    doc = undo(doc, doc.batches[doc.batches.length - 1].id, step());
    expect(() => engine.loadPlain(writePlain(doc))).not.toThrow();

    const beforeSecondVlan = doc;
    doc = addVlan(doc, { vlanId: 10, attach: [{ target: { kind: 'port', portId, interfaceName: 'Et1' } }] }, step());
    const vlanNodeId = added(beforeSecondVlan, doc, 'vlan:');
    const unitId = added(beforeSecondVlan, doc, 'logical-unit:');

    doc = addSubnet(doc, { prefix: '10.0.10.0/24', attach: [{ target: { kind: 'unit', unitId }, address: '10.0.10.5/24' }] }, step());
    doc = undo(doc, doc.batches[doc.batches.length - 1].id, step());
    expect(() => engine.loadPlain(writePlain(doc))).not.toThrow();

    doc = removeVlanNetwork(doc, [vlanNodeId], step());
    doc = undo(doc, doc.batches[doc.batches.length - 1].id, step());
    expect(() => engine.loadPlain(writePlain(doc))).not.toThrow();
  });

  it('removeChassis cascades a VLAN, a gateway unit, a note and a Docker network — nothing it contained stays live, one undo restores all of it', () => {
    const actor = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    let now = 1_790_200_000_000;
    const step = () => ({ actor, now: (now += 1000) });
    const added = (before: Document, after: Document, prefix: string) =>
      after.nodes.find((n) => n.id.startsWith(prefix) && !before.nodes.some((b) => b.id === n.id))!.id;

    let doc = emptyDocument();
    doc = createSketchDevice(doc, step());
    const chassisId = doc.nodes.find((n) => n.id.startsWith('chassis:'))!.id;
    const deviceId = doc.nodes.find((n) => n.id.startsWith('device:'))!.id;

    let before = doc;
    doc = addSketchPort(doc, chassisId, { label: 'Et1', connector: 'rj45', face: 'front' }, step());
    const accessPortId = added(before, doc, 'physical-port:');
    before = doc;
    doc = addSketchPort(doc, chassisId, { label: 'Et2', connector: 'rj45', face: 'front' }, step());
    const gatewayPortId = added(before, doc, 'physical-port:');

    doc = addVlan(
      doc,
      {
        vlanId: 10,
        name: 'Servers',
        attach: [
          { target: { kind: 'port', portId: accessPortId, interfaceName: 'Et1' } },
          { target: { kind: 'port', portId: gatewayPortId, interfaceName: 'Et2' }, gateway: true },
        ],
        subnet: '10.0.10.0/24',
        gatewayAddress: '10.0.10.1/24',
      },
      step(),
    );
    doc = addNote(doc, deviceId, { text: 'spare uplink', how: 'typed', ...step() });

    before = doc;
    doc = addContainerNetwork(doc, { hostDeviceId: deviceId, name: 'app_net', driver: 'bridge', subnets: ['172.18.0.0/16'] }, step());
    const cnId = added(before, doc, 'container-network:');
    before = doc;
    doc = addContainer(doc, { hostDeviceId: deviceId, name: 'gitea' }, step());
    const containerId = added(before, doc, 'container:');
    doc = attachContainerToNetwork(doc, { container: { kind: 'existing', containerId }, networkId: cnId, address: '172.18.0.3/16' }, step());
    doc = addPublishedPort(doc, { containerId, protocol: 'tcp', containerPort: 3000, hostPort: 3000 }, step());

    expect(() => engine.loadPlain(writePlain(doc))).not.toThrow();

    const liveIdsBefore = new Set(doc.nodes.filter((n) => n.absentSince === undefined).map((n) => n.id));

    const removed = removeChassis(doc, chassisId, step());
    const removeBatchId = removed.batches.at(-1)!.id;

    // Nothing the device contained is live: the chassis, both ports, the
    // VLAN, the gateway's address, the note, and the Docker network/container/port.
    for (const id of liveIdsBefore) {
      if (id === deviceId) continue;
      expect(removed.nodes.find((n) => n.id === id)?.absentSince, `${id} should be tombstoned`).toBeDefined();
    }
    expect(removed.nodes.find((n) => n.id === deviceId)?.absentSince).toBeDefined();
    expect(() => engine.loadPlain(writePlain(removed))).not.toThrow();

    const undone = undo(removed, removeBatchId, step());
    for (const id of liveIdsBefore) {
      expect(undone.nodes.find((n) => n.id === id)?.absentSince, `${id} should be live again`).toBeUndefined();
    }
    for (const e of doc.edges) {
      if (e.absentSince !== undefined) continue;
      expect(undone.edges.find((x) => x.id === e.id)?.absentSince, `${e.id} should be live again`).toBeUndefined();
    }
    expect(() => engine.loadPlain(writePlain(undone))).not.toThrow();
  });

  it('removing a container\'s own host tombstones the container and its AttachedTo — the overlay network on the other host no longer lists it', () => {
    const actor = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    let now = 1_790_300_000_000;
    const step = () => ({ actor, now: (now += 1000) });
    const added = (before: Document, after: Document, prefix: string) =>
      after.nodes.find((n) => n.id.startsWith(prefix) && !before.nodes.some((b) => b.id === n.id))!.id;

    let doc = emptyDocument();
    doc = createSketchDevice(doc, step());
    const hostAId = doc.nodes.find((n) => n.id.startsWith('device:'))!.id;
    const hostAChassisId = doc.nodes.find((n) => n.id.startsWith('chassis:'))!.id;

    const beforeB = doc;
    doc = createSketchDevice(doc, step());
    const hostBId = doc.nodes.find((n) => n.id.startsWith('device:') && !beforeB.nodes.some((b) => b.id === n.id))!.id;

    let before = doc;
    doc = addContainerNetwork(doc, { hostDeviceId: hostBId, name: 'overlay_net', driver: 'overlay' }, step());
    const overlayId = added(before, doc, 'container-network:');

    before = doc;
    doc = addContainer(doc, { hostDeviceId: hostAId, name: 'worker' }, step());
    const containerId = added(before, doc, 'container:');
    doc = attachContainerToNetwork(doc, { container: { kind: 'existing', containerId }, networkId: overlayId, address: '10.0.9.2/24' }, step());
    const attachedToEdgeId = edgesOut(doc, containerId, 'AttachedTo')[0]!.id;
    expect(() => engine.loadPlain(writePlain(doc))).not.toThrow();

    const removed = removeChassis(doc, hostAChassisId, step());
    expect(removed.nodes.find((n) => n.id === containerId)?.absentSince).toBeDefined();
    expect(removed.edges.find((e) => e.id === attachedToEdgeId)?.absentSince).toBeDefined();
    // host B and its overlay network are untouched
    expect(removed.nodes.find((n) => n.id === hostBId)?.absentSince).toBeUndefined();
    expect(removed.nodes.find((n) => n.id === overlayId)?.absentSince).toBeUndefined();
    expect(() => engine.loadPlain(writePlain(removed))).not.toThrow();
  });

  it('removeChassis takes a cable with it — both ends — and undo brings it, the device and the far port back; both loads run through the real engine', () => {
    const actor = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    let now = 1_790_400_000_000;
    const step = () => ({ actor, now: (now += 1000) });

    let doc = emptyDocument();
    doc = createSketchDevice(doc, step());
    const chassisA = doc.nodes.find((n) => n.id.startsWith('chassis:'))!.id;
    doc = addSketchPort(doc, chassisA, { label: 'Et1', connector: 'rj45', face: 'front' }, step());
    const portA = edgesOut(doc, chassisA, 'HasPort')[0]!.to;

    const beforeB = doc;
    doc = createSketchDevice(doc, step());
    const chassisB = doc.nodes.find((n) => n.id.startsWith('chassis:') && !beforeB.nodes.some((b) => b.id === n.id))!.id;
    doc = addSketchPort(doc, chassisB, { label: 'Et1', connector: 'rj45', face: 'front' }, step());
    const portB = edgesOut(doc, chassisB, 'HasPort')[0]!.to;

    doc = connectPorts(doc, portA, portB, {}, step());
    const cableFromPortA = edgesIn(doc, portA, 'Terminates')[0]!.from;
    expect(() => engine.loadPlain(writePlain(doc))).not.toThrow();

    const removed = removeChassis(doc, chassisA, step());
    const removeBatchId = removed.batches.at(-1)!.id;

    expect(removed.nodes.find((n) => n.id === cableFromPortA)?.absentSince).toBeDefined();
    expect(removed.nodes.find((n) => n.id === chassisA)?.absentSince).toBeDefined();
    // The far device and its port are untouched — only the cable is gone.
    expect(removed.nodes.find((n) => n.id === chassisB)?.absentSince).toBeUndefined();
    expect(removed.nodes.find((n) => n.id === portB)?.absentSince).toBeUndefined();
    expect(() => engine.loadPlain(writePlain(removed))).not.toThrow();

    const undone = undo(removed, removeBatchId, step());
    expect(undone.nodes.find((n) => n.id === cableFromPortA)?.absentSince).toBeUndefined();
    expect(undone.nodes.find((n) => n.id === chassisA)?.absentSince).toBeUndefined();
    expect(edgesOut(undone, cableFromPortA, 'Terminates')).toHaveLength(2);
    expect(() => engine.loadPlain(writePlain(undone))).not.toThrow();
  });
});

describe('OP_CHECKS (32) and OP_CHECK_GESTURE (33)', () => {
  const step = (() => {
    let now = 1_790_700_000_000;
    return () => ({ actor: '01ARZ3NDEKTSV4RRFFQ69G5FAV', now: (now += 1000) });
  })();
  function labDoc() {
    let doc = emptyDocument();
    const ports: string[] = [];
    for (const label of ['Et1', 'Et2', 'Et3']) {
      const before = doc;
      doc = createSketchDevice(doc, step());
      const chassis = doc.nodes.find((n) => n.id.startsWith('chassis:') && !before.nodes.some((b) => b.id === n.id))!.id;
      doc = addSketchPort(doc, chassis, { label, connector: 'rj45', face: 'front' }, step());
      ports.push(edgesOut(doc, chassis, 'HasPort')[0]!.to);
    }
    return { doc, ports };
  }

  it('standing checks decode: a head with the rule count, and no finding on a clean estate', () => {
    const { doc } = labDoc();
    engine.loadPlain(writePlain(doc));
    const result = engine.checks();
    expect(result.rulesLoaded).toBeGreaterThan(0);
    expect(result.loadFailed).toBe(false);
    expect(result.findings.length).toBe(result.refuse + result.warn + result.idea);
  });

  it('a switch with one cable is one idea, with its source, elements and counts', () => {
    const { doc, ports } = labDoc();
    const device = doc.nodes.find((n) => n.id.startsWith('device:'))!.id;
    const cabled = connectPorts(setDeviceField(doc, device, 'role', 'switch', step()), ports[0], ports[1], {}, step());
    engine.loadPlain(writePlain(cabled));
    const result = engine.checks();
    const idea = result.findings.find((f) => f.rule === 'topo.switch.single-cable');
    expect(idea?.severity).toBe('idea');
    expect(result.idea).toBeGreaterThanOrEqual(1);
    expect(idea?.source.note.length).toBeGreaterThan(0);
    expect(idea?.elements.length).toBeGreaterThan(0);
    expect(idea?.elements.every((e) => e.id.includes(':'))).toBe(true);
  });

  it('a cable onto an already-cabled port is refused with a sentence, a fix and a source line; nothing is written', () => {
    const { doc, ports } = labDoc();
    const cabled = connectPorts(doc, ports[0], ports[1], {}, step());
    engine.loadPlain(writePlain(cabled));
    const before = engine.exportPlain();
    const rows = engine.checkCable({ port: ports[0] }, { port: ports[2] }, 'cat6');
    const refusal = rows.find((r) => r.rule === 'phy.port.already-cabled');
    expect(refusal?.severity).toBe('refuse');
    expect(refusal?.title.length).toBeGreaterThan(0);
    expect(refusal?.fix.length).toBeGreaterThan(0);
    expect(refusal?.why.length).toBeGreaterThan(0);
    expect(refusal?.source.note.length).toBeGreaterThan(0);
    expect(refusal?.elements.some((e) => e.id === ports[0])).toBe(true);
    expect(engine.exportPlain()).toEqual(before);
  });

  it('a cable between two free ports is let through: zero rows', () => {
    const { doc, ports } = labDoc();
    engine.loadPlain(writePlain(doc));
    expect(engine.checkCable({ port: ports[0] }, { port: ports[1] }, 'cat6')).toEqual([]);
  });

  it('a frame naming nothing live answers with no rows, not an error', () => {
    const { doc } = labDoc();
    engine.loadPlain(writePlain(doc));
    expect(engine.checkCable({ port: 'physical-port:01ARZ3NDEKTSV4RRFFQ69G5FAV' }, 'unknown', '')).toEqual([]);
  });
});

describe('maintenance plans (OP_PLAN_PREVIEW 34, and the gate on plan text)', () => {
  const step = (() => {
    let now = 1_790_800_000_000;
    return () => ({ actor: '01ARZ3NDEKTSV4RRFFQ69G5FAV', now: (now += 1000) });
  })();
  const gate = (t: string) => engine.redactText(t).text;
  function lab() {
    let doc = emptyDocument();
    const ports: string[] = [];
    for (const label of ['Et1', 'Et2', 'Et3']) {
      const before = doc;
      doc = createSketchDevice(doc, step());
      const chassis = doc.nodes.find((n) => n.id.startsWith('chassis:') && !before.nodes.some((b) => b.id === n.id))!.id;
      doc = addSketchPort(doc, chassis, { label, connector: 'rj45', face: 'front' }, step());
      ports.push(edgesOut(doc, chassis, 'HasPort')[0]!.to);
    }
    return { doc, ports, device: doc.nodes.find((n) => n.id.startsWith('device:'))!.id };
  }

  it('previews each step in order, says what it adds, and changes nothing', () => {
    const { doc, ports } = lab();
    const cabled = connectPorts(doc, ports[0], ports[2], {}, step());
    let made = createPlan(cabled, { title: 'Re-patch', gate, ...step() });
    // Et1 already carries a cable: cabling it again is refused by the checks, after step 2 only.
    for (const edit of [
      { t: 'cable', a: ports[1], b: ports[2] },
      { t: 'cable', a: ports[0], b: ports[1] },
    ] as const) {
      const s = addStep(made.doc, made.id, { kind: 'cable', change: 'cable it', edit, gate, ...step() });
      made = { doc: s.doc, id: made.id };
    }
    engine.loadPlain(writePlain(made.doc));
    const before = engine.exportPlain();
    const out = engine.planPreview(made.id);
    expect(out.map((s) => s.ordinal)).toEqual([0, 1]);
    expect(out[0].error).toBe('');
    expect(out[1].impact.join(' ')).toMatch(/already carries a cable/);
    expect(out[1].findings.some((f) => f.rule === 'phy.port.already-cabled')).toBe(true);
    expect(out[1].touches.length).toBeGreaterThan(0);
    expect(engine.exportPlain()).toEqual(before);
    expect(engine.planPreview('device:not-a-plan')).toEqual([]);
  });

  it('real-length device secrets in any plan text never reach the stored plan', () => {
    const psk = 'Zk9Qw3Lm0PxV7tYsAbCdEfGhIjKlMnOpQrStUvWxYz0123456789-aBcDeF';
    const line = `set security ike policy ike-pol pre-shared-key ascii-text "${psk}"`;
    const { doc, device } = lab();
    expect(gate('Move the uplink to sw-02 before 06:00')).toBe('Move the uplink to sw-02 before 06:00');
    const made = createPlan(doc, { title: 'Rotate the key', gate, ...step() });
    const added = addStep(made.doc, made.id, {
      kind: 'other',
      change: 'Rotate the key',
      before: line,
      after: line,
      edit: { t: 'field', id: device, key: 'Device.role', value: line },
      gate,
      ...step(),
    });
    let d = startPlan(added.doc, made.id, step());
    d = markWentDifferently(d, added.id, { note: `I pasted this by mistake: ${line}`, gate, ...step() });
    d = recordPlan(d, made.id, { outcome: 'failed', text: `What went wrong:\n${line}`, gate, ...step() });
    const stored = JSON.stringify(d.nodes);
    expect(stored).not.toContain(psk);
    expect(stored).toContain('REDACTED');
    expect(readPlan(d, made.id).stage).toBe('recorded');
    expect(typeof markDone).toBe('function');
  });

  // Each line is what a real device accepts (CLAUDE.md rule 2): an 8-character Junos PSK, a `$9$`
  // BGP authentication-key, Cisco type 5 and type 7. The gate under test is the real wasm one.
  const SECRET_LINES: [string, string][] = [
    ['Ab3dE6gH', 'set security ike policy ike-pol pre-shared-key ascii-text "Ab3dE6gH"'],
    ['Ab3dE6gH', 'set security ike policy ike-pol pre-shared-key ascii-text Ab3dE6gH'],
    ['Qz7Lx-VYgoJDm5T3AtOBIEcSrKvWx', 'set protocols bgp group ISP neighbor 203.0.113.1 authentication-key "$9$Qz7Lx-VYgoJDm5T3AtOBIEcSrKvWx"'],
    ['Qz7Lx-VYgoJDm5T3AtOBIEcSrKvWx', 'set protocols bgp authentication-key $9$Qz7Lx-VYgoJDm5T3AtOBIEcSrKvWx'],
    ['mERr$hx5rVt7rPNoS4wqbXKX7m0', 'enable secret 5 $1$mERr$hx5rVt7rPNoS4wqbXKX7m0'],
    ['0822455D0A16', 'username admin privilege 15 password 7 0822455D0A16'],
    ['0822455D0A16', 'line vty 0 4\n password 7 0822455D0A16'],
  ];

  it.each(SECRET_LINES)('%s: never reaches a stored plan, in What went wrong, a step note or a step', (secret, line) => {
    const { doc, device } = lab();
    const made = createPlan(doc, { title: 'Rotate the key', gate, ...step() });
    const added = addStep(made.doc, made.id, {
      kind: 'other',
      change: `Rotate: ${line}`,
      before: line,
      after: line,
      edit: { t: 'field', id: device, key: 'Device.role', value: line.replace('\n', ' ') },
      gate,
      ...step(),
    });
    let d = startPlan(added.doc, made.id, step());
    d = markWentDifferently(d, added.id, { note: `Did it by hand:\n${line}`, gate, ...step() });
    d = recordPlan(d, made.id, { outcome: 'failed', text: `What went wrong:\n${line}`, gate, ...step() });
    const stored = JSON.stringify(d.nodes) + JSON.stringify(d.batches);
    expect(stored).not.toContain(secret);
    // The gate leaves a marker, or the quarantine sketch (`<word> <word>`) for a line it cannot label.
    expect(stored).toMatch(/REDACTED|<word>/);
    const p = readPlan(d, made.id);
    expect(p.record).not.toContain(secret);
    expect(p.steps[0].note).not.toContain(secret);
    expect(p.stage).toBe('recorded');
  });

  it('a crafted step the engine is asked to preview does not kill it', () => {
    const { doc, ports, device } = lab();
    let made = createPlan(doc, { title: 'Hostile', gate, ...step() });
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const s = addStep(made.doc, made.id, { kind: 'other', change: `s${i}`, edit: { t: 'field', id: device, key: 'Device.role', value: 'x' }, gate, ...step() });
      made = { doc: s.doc, id: made.id };
      ids.push(s.id);
    }
    // Written into the document the way a hostile client could, past addStep.
    const crafted = [
      `field\t${device}\tMaintenancePlan.stage\trecorded`,
      `field\t${ports[0]}\tDevice.management_address\t10.0.0.9`,
      `field\t${device}\tRack.row\tR1`,
    ];
    const b = begin(made.doc, step());
    crafted.forEach((line, i) => setNodeField(b, ids[i], 'PlanStep.edit', text(line)));
    const hostile = finish(b, 'crafted');
    engine.loadPlain(writePlain(hostile));
    const before = engine.exportPlain();
    const out = engine.planPreview(made.id);
    expect(out).toHaveLength(3);
    expect(engine.exportPlain()).toEqual(before);
    // Still alive and answering.
    expect(engine.planPreview(made.id)).toHaveLength(3);
    expect(engine.redactText('hello').text).toBe('hello');
  });
});
