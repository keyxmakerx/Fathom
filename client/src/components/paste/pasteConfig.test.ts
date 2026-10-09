// The paste path against the REAL module (`bash scripts/build-wasm.sh` first),
// with secrets as long as a device will take (CLAUDE.md rule 2).
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { captureOf } from '../../document/capture';
import { createFreeBox } from '../../document/freeform';
import { edgesIn, emptyDocument, findNode, parseNodeId } from '../../document/model';
import { tiePlan } from '../../document/portTies';
import { writePlain } from '../../document/plain';
import { Engine } from '../../engine/engine';
import { Mirror } from '../../engine/mirror';
import { fileLoader } from '../../engine/wasm';
import { devicePlatform, interfacesOf, platformChoices, previewPaste, sameNamed, worthReading } from './pasteConfig';

const WASM_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../public/engine/fathom_wasm.wasm');
if (!existsSync(WASM_PATH)) throw new Error(`${WASM_PATH} missing: run \`bash scripts/build-wasm.sh\` first.`);

// Real devices take long secrets: an IKE key to 128 chars, an SNMP community, an OSPF/BGP key.
const IKE = 'FATHOMPASTEike' + 'k7Qz'.repeat(30);
const SNMP = 'FATHOMPASTEsnmp' + 'Rw9x'.repeat(16);
const BGP = 'FATHOMPASTEbgp' + 'Hn3m'.repeat(12);
// Short ones too: the value-shape detector alone must not be what the test leans on.
const SHORT = ['hunter22', 'n0cR3ad', 'bgpK3y1', 'Rt8pass'];
const SECRETS = [IKE, SNMP, BGP, ...SHORT];

const CONFIG = (host: string) => `set system host-name ${host}
set interfaces ge-0/0/0 unit 0 family inet address 203.0.113.2/30
set interfaces xe-0/0/1 unit 0 family inet address 10.0.0.1/24
set interfaces st0 unit 0 family inet address 10.255.0.1/30
set security ike policy ike-pol pre-shared-key ascii-text ${IKE}
set snmp community ${SNMP} authorization read-only
set protocols bgp group ISP neighbor 203.0.113.1 authentication-key ${BGP}
set protocols bgp group ISP neighbor 203.0.113.9 authentication-key bgpK3y1
set protocols ospf area 0.0.0.0 interface ge-0/0/0.0 authentication simple-password n0cR3ad
set system root-authentication plain-text-password-value Rt8pass
set security ike policy ike-two pre-shared-key ascii-text hunter22
`;

function bytesInclude(hay: Uint8Array, needle: string): boolean {
  const n = new TextEncoder().encode(needle);
  outer: for (let i = 0; i + n.length <= hay.length; i++) {
    for (let j = 0; j < n.length; j++) if (hay[i + j] !== n[j]) continue outer;
    return true;
  }
  return false;
}

let mirror: Mirror;
beforeAll(async () => {
  mirror = new Mirror(await Engine.init(fileLoader(WASM_PATH)));
});

describe('previewPaste', () => {
  it('reads hostname, interfaces and addresses; reports destroyed values by kind, never the values', () => {
    const p = previewPaste(mirror, emptyDocument(), CONFIG('srx-new'), { x: 0, y: 0 });
    expect(p.hostname).toBe('srx-new');
    expect(p.platform).toBe('junos-srx');
    const ge = p.interfaces.find((i) => i.name === 'ge-0/0/0');
    expect(ge?.addresses).toEqual(['203.0.113.2/30']);
    expect(p.destroyed.length).toBeGreaterThan(0);
    expect(p.destroyed.reduce((n, d) => n + d.count, 0)).toBeGreaterThanOrEqual(3);
    expect(p.match).toBeNull();
    expect(p.attachDoc).toBeNull();
    for (const s of SECRETS) {
      expect(JSON.stringify(p)).not.toContain(s);
      expect(bytesInclude(writePlain(p.addDoc), s)).toBe(false);
    }
  });

  it('adds a box with the hostname, a port per physical interface and the capture attached', () => {
    const p = previewPaste(mirror, emptyDocument(), CONFIG('srx-new'), { x: 40, y: 80 });
    const device = p.addDoc.nodes.find((n) => parseNodeId(n.id).kind === 'Device')!;
    expect(device.fields['Device.hostname']?.value).toBe('srx-new');
    const labels = p.addDoc.nodes
      .filter((n) => parseNodeId(n.id).kind === 'PhysicalPort')
      .map((n) => n.fields['PhysicalPort.label']?.value)
      .sort();
    expect(labels).toEqual(['ge-0/0/0', 'xe-0/0/1']);
    const cap = captureOf(p.addDoc, device.id);
    expect(cap).not.toBeNull();
    for (const s of SECRETS) expect(cap!.lines.map((l) => l.text).join('\n')).not.toContain(s);
    expect(interfacesOf(p.addDoc, device.id).map((i) => i.name)).toEqual(expect.arrayContaining(['ge-0/0/0', 'xe-0/0/1']));
    // Each port made from the config is tied to the interface it was made for, in the same undo step.
    for (const port of p.addDoc.nodes.filter((n) => parseNodeId(n.id).kind === 'PhysicalPort')) {
      const tie = edgesIn(p.addDoc, port.id, 'Occupies');
      expect(tie.length).toBe(1);
      expect(findNode(p.addDoc, tie[0].from)!.fields['Interface.name']?.value).toBe(port.fields['PhysicalPort.label']?.value);
    }
    expect(tiePlan(p.addDoc, device.id, [])!.rows.map((r) => r.name)).not.toEqual(expect.arrayContaining(['ge-0/0/0', 'xe-0/0/1']));
  });

  it('offers to attach to the same-named device, in either letter case, without touching the original', () => {
    const base = createFreeBox(emptyDocument(), { x: 0, y: 0, hostname: 'srx-old' }).doc;
    const p = previewPaste(mirror, base, CONFIG('SRX-OLD'), { x: 200, y: 0 });
    expect(p.match?.hostname).toBe('srx-old');
    expect(p.match?.hasCapture).toBe(false);
    expect(p.attachDoc).not.toBeNull();
    expect(captureOf(p.attachDoc!, p.match!.deviceId)).not.toBeNull();
    expect(captureOf(base, p.match!.deviceId)).toBeNull();
    for (const s of SECRETS) expect(bytesInclude(writePlain(p.attachDoc!), s)).toBe(false);
  });

  it('cannot attach to a device that already carries a capture', () => {
    const first = previewPaste(mirror, emptyDocument(), CONFIG('srx-old'), { x: 0, y: 0 });
    const p = previewPaste(mirror, first.addDoc, CONFIG('srx-old'), { x: 200, y: 0 });
    expect(p.match?.hasCapture).toBe(true);
    expect(p.attachDoc).toBeNull();
    expect(sameNamed(first.addDoc, 'srx-old')?.hasCapture).toBe(true);
  });

  it('a refusal quotes no secret from the first line', () => {
    let message = '';
    try {
      previewPaste(mirror, emptyDocument(), 'enable secret 0 hunter22\nsnmp-server community n0cR3ad RO\n', { x: 0, y: 0 });
    } catch (e) {
      message = e instanceof Error ? e.message + (e as { detail?: string }).detail : String(e);
    }
    expect(message).not.toBe('');
    for (const s of SHORT) expect(message).not.toContain(s);
  });

  it('does not offer Attach when two devices share the name', () => {
    const one = createFreeBox(emptyDocument(), { x: 0, y: 0, hostname: 'dup' }).doc;
    const two = createFreeBox(one, { x: 200, y: 0, hostname: 'dup' }).doc;
    const p = previewPaste(mirror, two, CONFIG('dup'), { x: 400, y: 0 });
    expect(p.match?.ambiguous).toBe(true);
    expect(p.attachDoc).toBeNull();
  });

  it('refuses text the dictionary reads nothing from', () => {
    expect(() => previewPaste(mirror, emptyDocument(), 'hello\nworld\nthis is not a config\n', { x: 0, y: 0 })).toThrow();
  });
});

describe('which device is this from', () => {
  const VAGUE = 'set system host-name sw-vague\nset interfaces ge-0/0/1 description uplink\n';

  it('surfaces the candidates when the engine cannot tell, and obeys the answer', () => {
    let choices: ReturnType<typeof platformChoices> = null;
    try {
      previewPaste(mirror, emptyDocument(), VAGUE, { x: 0, y: 0 });
    } catch (e) {
      choices = platformChoices(e);
    }
    expect(choices).not.toBeNull();
    expect(choices).toContain('junos-ex');
    const p = previewPaste(mirror, emptyDocument(), VAGUE, { x: 0, y: 0 }, undefined, 'junos-ex');
    expect(p.platform).toBe('junos-ex');
    expect(p.hostname).toBe('sw-vague');
  });

  it('is not a choice for any other error', () => {
    expect(platformChoices(new Error('no'))).toBeNull();
  });

  it('reads a placed device\'s own platform for the attach path', () => {
    const doc = emptyDocument();
    expect(devicePlatform(doc, 'device:missing')).toBeNull();
  });
});

describe('worthReading', () => {
  it('leaves a single line alone', () => {
    expect(worthReading('hello')).toBe(false);
    expect(worthReading('a\nb')).toBe(true);
  });
});
