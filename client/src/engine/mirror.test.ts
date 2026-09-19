// Drives the REAL module — `client/public/engine/fathom_wasm.wasm`, built by
// `scripts/build-wasm.sh` — through `Mirror`, proving ADR-0052 §4's own
// claim end to end: a document goes in through door one, a paste from
// `crates/fathom-wasm/tests/paste.rs` lands on the device it was placed
// under through door three, and the document that comes back out through
// door two carries the `Capture` node and none of the secret the gate
// destroyed — not in the exported plain bytes, and not in the capture's own
// `text` field, which is the same "post-gate" text the wire's `FACE_DROP`
// spans are measured against (`protocol.rs`'s own doc).
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { Engine } from './engine';
import { Mirror, refusalSentence } from './mirror';
import { fileLoader } from './wasm';
import { captureOf } from '../document/capture';
import { createSketchDevice } from '../document/commands';
import { edgesOut, emptyDocument, findNode, parseNodeId } from '../document/model';
import { writePlain } from '../document/plain';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.resolve(__dirname, '../../public/engine/fathom_wasm.wasm');

if (!existsSync(WASM_PATH)) {
  throw new Error(
    `client/src/engine/mirror.test.ts: ${WASM_PATH} does not exist. ` +
      'Run `bash scripts/build-wasm.sh` from the repo root before running this suite.',
  );
}

// `crates/fathom-wasm/tests/paste.rs`'s own `PASTE`, verbatim — the same
// config `engine.test.ts` already drives through `OP_PASTE`, driven here
// through `OP_PASTE_INTO` instead.
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

/** Byte-level substring search — the same discipline `engine.test.ts` uses
 * and for the same reason: a canary must be absent from the raw bytes, not
 * merely from however a lossy decode would render them back. */
function bytesInclude(haystack: Uint8Array, needle: string): boolean {
  const needleBytes = new TextEncoder().encode(needle);
  if (needleBytes.length === 0 || needleBytes.length > haystack.length) return false;
  outer: for (let i = 0; i + needleBytes.length <= haystack.length; i++) {
    for (let j = 0; j < needleBytes.length; j++) {
      if (haystack[i + j] !== needleBytes[j]) continue outer;
    }
    return true;
  }
  return false;
}

let engine: Engine;

beforeAll(async () => {
  engine = await Engine.init(fileLoader(WASM_PATH));
});

describe('Mirror', () => {
  it('pastes into a placed device: no canary anywhere in the round-tripped document, and a Capture node with text and a line count', () => {
    const mirror = new Mirror(engine);

    // A device, entirely client-side (`document/commands.ts`), with no
    // paste involved yet — this is what "already placed" means: a real
    // Device node the operator put on a faceplate before pasting under it.
    const seeded = createSketchDevice(emptyDocument());
    const deviceId = seeded.nodes.find((n) => parseNodeId(n.id).kind === 'Device')!.id;

    mirror.load(seeded);
    const { doc, result } = mirror.pasteInto(deviceId, PASTE);

    expect(result.summary.secretsRedacted).toBe(1);
    expect(result.summary.hostname).toBe('srx-branch-01');

    // The canary is absent from the plain bytes a save would actually send.
    const bytes = writePlain(doc);
    expect(bytesInclude(bytes, PASTE_SECRET)).toBe(false);

    // The Capture node exists, owned by the device, with text and a line
    // count — and the secret is absent from that text too, not merely from
    // the bytes around it.
    const captureEdge = edgesOut(doc, deviceId, 'HasCapture')[0];
    expect(captureEdge).toBeDefined();
    const captureNode = findNode(doc, captureEdge.to);
    expect(captureNode).toBeDefined();
    expect(captureNode!.absentSince).toBeUndefined();

    const textEntry = captureNode!.fields['Capture.text'];
    expect(textEntry?.presence).toBe('set');
    expect(typeof textEntry?.value).toBe('string');
    const captureText = textEntry!.value as string;
    expect(captureText.includes(PASTE_SECRET)).toBe(false);
    expect(captureText).toContain('<REDACTED:');

    const lineCountEntry = captureNode!.fields['Capture.line_count'];
    expect(lineCountEntry?.presence).toBe('set');
    expect(typeof lineCountEntry?.value).toBe('number');
    expect(lineCountEntry!.value as number).toBeGreaterThan(0);

    const platformEntry = captureNode!.fields['Capture.platform'];
    expect(platformEntry?.value).toBe('junos-srx');

    // `document/capture.ts`'s own `captureOf` — the drawer's actual read
    // model — must find at least one line the paste really built (the
    // hostname, the interfaces, the zones above all bind something), driven
    // against the real engine's own id shapes rather than a fixture that
    // could drift from them (`capture.test.ts`'s own fixtures are hand-built
    // and cannot catch a mismatch between the wire's bare-ULID
    // `Origin.capture` and this document's formatted node ids).
    const view = captureOf(doc, deviceId);
    expect(view).not.toBeNull();
    expect(view!.lines.some((l) => l.mark === 'built')).toBe(true);
  });

  it('refuses a second paste onto a device that already carries a live capture, with a sentence naming why (ADR-0052 §5\'s amendment)', () => {
    const mirror = new Mirror(engine);
    const seeded = createSketchDevice(emptyDocument());
    const deviceId = seeded.nodes.find((n) => parseNodeId(n.id).kind === 'Device')!.id;

    mirror.load(seeded);
    const first = mirror.pasteInto(deviceId, PASTE);
    mirror.load(first.doc);

    let thrown: unknown;
    try {
      mirror.pasteInto(deviceId, PASTE);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect(refusalSentence(thrown)).toContain('already carries a live capture');
  });
});
