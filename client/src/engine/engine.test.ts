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

import { Engine } from './engine';
import { decodeReply } from './protocol';
import { OPCODES } from './protocol.constants';
import { fileLoader } from './wasm';

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
