// A dropped folder of configs against the REAL module (`bash scripts/build-wasm.sh` first), with secrets as long as a
// device will take (CLAUDE.md rule 2).
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { createSketchDevice } from '../../document/commands';
import { captureOf } from '../../document/capture';
import { asString, emptyDocument, fieldValue, parseNodeId, type Document } from '../../document/model';
import { writePlain } from '../../document/plain';
import { Engine } from '../../engine/engine';
import { Mirror } from '../../engine/mirror';
import { fileLoader } from '../../engine/wasm';
import { applyFolder, changed, planFolder } from './configFolder';

const WASM_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../public/engine/fathom_wasm.wasm');
if (!existsSync(WASM_PATH)) throw new Error(`${WASM_PATH} missing: run \`bash scripts/build-wasm.sh\` first.`);

const OPTS = { now: 1_700_000_000_000 };
const IKE = 'FATHOMFOLDERike' + 'k7Qz'.repeat(30);
const SHORT = 'hunter22';

const SRX = (host: string, extra = '') => `set system host-name ${host}
set interfaces ge-0/0/0 unit 0 family inet address 203.0.113.2/30
set interfaces ge-0/0/1 unit 0 family inet address 10.0.0.1/24
set security ike policy ike-pol pre-shared-key ascii-text ${IKE}
set security ike policy ike-two pre-shared-key ascii-text ${SHORT}
set security zones security-zone trust interfaces ge-0/0/1.0
${extra}`;

const LLDP = `Local Interface    Parent Interface    Chassis Id          Port info          System Name
ge-0/0/0           -                   00:1b:21:3a:4f:10   eth0               nas
`;

function bytesInclude(hay: Uint8Array, needle: string): boolean {
  const n = new TextEncoder().encode(needle);
  outer: for (let i = 0; i + n.length <= hay.length; i++) {
    for (let j = 0; j < n.length; j++) if (hay[i + j] !== n[j]) continue outer;
    return true;
  }
  return false;
}

const deviceNamed = (doc: Document, name: string) =>
  doc.nodes.filter((n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'Device' && asString(fieldValue(n.fields, 'Device.hostname')) === name);

const spots = (n: number) => Array.from({ length: n }, (_, i) => ({ x: 400 + i * 200, y: 0 }));

let mirror: Mirror;
beforeAll(async () => {
  mirror = new Mirror(await Engine.init(fileLoader(WASM_PATH)));
});

describe('a dropped folder of configs', () => {
  it('attaches to the drawn device, adds the rest, and skips what is not a config', () => {
    const doc = createSketchDevice(emptyDocument(), { ...OPTS, hostname: 'srx-edge' });
    const files = [
      { name: 'backups/srx-edge.conf', text: SRX('srx-edge') },
      { name: 'backups/srx-branch.conf', text: SRX('srx-branch') },
      { name: 'backups/lldp.txt', text: LLDP },
      { name: 'backups/photo.jpg', text: 'JFIF\u0000\u0000binary\nmore' },
    ];
    const rows = planFolder(mirror, doc, files);
    expect(rows.map((r) => `${r.file}:${r.outcome}`)).toEqual([
      'backups/lldp.txt:skip',
      'backups/photo.jpg:skip',
      'backups/srx-branch.conf:add',
      'backups/srx-edge.conf:attach',
    ]);
    expect(rows[0]!.why).toContain('paste it on its own');
    expect(rows.find((r) => r.outcome === 'attach')!.destroyed).toBeGreaterThanOrEqual(2);

    const next = applyFolder(mirror, doc, files, rows, spots, OPTS);
    expect(next.batches.length).toBe(doc.batches.length + 1);
    expect(next.batches.at(-1)!.label).toBe('configs from a folder');
    expect(deviceNamed(next, 'srx-edge')).toHaveLength(1);
    expect(captureOf(next, deviceNamed(next, 'srx-edge')[0]!.id)).not.toBeNull();
    expect(deviceNamed(next, 'srx-branch')).toHaveLength(1);

    const bytes = writePlain(next);
    expect(bytesInclude(bytes, IKE)).toBe(false);
    expect(bytesInclude(bytes, SHORT)).toBe(false);
  });

  it('compares a device that already carries a config, and writes nothing for it', () => {
    const base = createSketchDevice(emptyDocument(), { ...OPTS, hostname: 'srx-edge' });
    const once = applyFolder(mirror, base, [{ name: 'a.conf', text: SRX('srx-edge') }], planFolder(mirror, base, [{ name: 'a.conf', text: SRX('srx-edge') }]), spots, OPTS);
    const again = [{ name: 'b.conf', text: SRX('srx-edge', 'set interfaces ge-0/0/2 unit 0 family inet address 192.0.2.1/24\n').replace('10.0.0.1/24', '10.0.0.9/24') }];
    const rows = planFolder(mirror, once, again);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe('compare');
    expect(rows[0]!.changes).toMatchObject({ added: ['ge-0/0/2'], gone: [], readdressed: ['ge-0/0/1'] });
    expect(changed(rows[0]!.changes!)).toBe(true);
    expect(applyFolder(mirror, once, again, rows, spots, OPTS)).toBe(once);

    const same = planFolder(mirror, once, [{ name: 'c.conf', text: SRX('srx-edge') }]);
    expect(changed(same[0]!.changes!)).toBe(false);
  });

  it('reads only the first of two files that name the same device', () => {
    const files = [
      { name: '1.conf', text: SRX('srx-a') },
      { name: '2.conf', text: SRX('SRX-A') },
    ];
    const rows = planFolder(mirror, emptyDocument(), files);
    expect(rows.map((r) => r.outcome)).toEqual(['add', 'skip']);
    expect(rows[1]!.why).toContain('1.conf already names');
  });

  it('writes nothing when nothing is chosen', () => {
    const doc = emptyDocument();
    expect(applyFolder(mirror, doc, [{ name: 'a.conf', text: SRX('x') }], [], spots, OPTS)).toBe(doc);
  });
});

describe('what changed, in words', () => {
  it('names the interfaces and the version', async () => {
    const { changeWords } = await import('./FolderCard');
    expect(changeWords({ added: ['ge-0/0/2'], gone: [], readdressed: ['ge-0/0/1'], version: { was: '21.4R3', now: '22.2R1' } })).toBe(
      'Changed since the copy in the drawing: 1 new interface (ge-0/0/2); new addresses on ge-0/0/1; version 21.4R3 to 22.2R1. It already carries a config, so this one is not added yet.',
    );
    expect(changeWords({ added: [], gone: [], readdressed: [], version: null })).toBe('Nothing changed since the copy in the drawing.');
  });
});
