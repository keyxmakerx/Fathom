// The page and the check must say "behind" about the same devices (`bash scripts/build-wasm.sh` first).
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { Engine } from '../../engine/engine';
import { Mirror } from '../../engine/mirror';
import { fileLoader } from '../../engine/wasm';
import { modelRows, ownTargetLines, setDeviceTarget, setFirmwareHold, setRunningVersion, setTarget, setVersionPlatform } from '../../document/firmware';
import { NOW, addBareDevice, estate } from '../../document/firmwareFixture';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.resolve(__dirname, '../../../public/engine/fathom_wasm.wasm');
if (!existsSync(WASM_PATH)) throw new Error(`${WASM_PATH} does not exist. Run \`bash scripts/build-wasm.sh\` first.`);

let engine: Engine;
beforeAll(async () => {
  engine = await Engine.init(fileLoader(WASM_PATH));
});

describe('the Firmware page and the check agree', () => {
  it('flags the devices the page counts behind, and not the held one', () => {
    const { doc, ids } = estate();
    let d = setTarget(doc, 'ex4300-48t', { version: '22.1R1', platform: 'junos-ex' }, { now: NOW + 1 });
    d = setFirmwareHold(d, ids.sw1!, 'lab rig', { now: NOW + 2 });
    const mirror = new Mirror(engine);
    mirror.load(d);
    const found = mirror.checks().findings.filter((f) => f.rule === 'fw.device.behind-chosen-version');
    const flagged = new Set(found.flatMap((f) => f.elements.map((e) => e.id)));
    const behind = modelRows(d).flatMap((r) => r.devices.filter((l) => l.state === 'behind').map((l) => l.device.deviceId));
    expect(behind.length).toBe(1); // sw1 is held, sw3 is on the chosen version, sw4 has none recorded: only sw2 is behind
    expect(found.length).toBe(behind.length);
    for (const id of behind) expect([...flagged].some((f) => f.includes(id) || id.includes(f))).toBe(true);
  });

  it("flags a device behind its own chosen version, as the page does (schema 0.31)", () => {
    const { doc } = estate();
    let d = doc;
    const ids: string[] = [];
    for (const [name, platform, running, chosen] of [
      ['fw-home', 'opnsense', '25.7.11_2', '26.1'],
      ['nas', 'linux-host', '24.04.1', '24.04'],
      ['rtr', 'routeros', '7.16', '7.16.2'],
      ['pf', 'pfsense', '2.8.0', '26.03'],
    ] as const) {
      const made = addBareDevice(d, name, NOW + ids.length * 10 + 1);
      d = setVersionPlatform(made.doc, made.deviceId, platform, { now: NOW + ids.length * 10 + 2 });
      d = setRunningVersion(d, made.deviceId, running, { now: NOW + ids.length * 10 + 3 });
      d = setDeviceTarget(d, made.deviceId, chosen, { now: NOW + ids.length * 10 + 4 });
      ids.push(made.deviceId);
    }
    const mirror = new Mirror(engine);
    mirror.load(d);
    const flagged = mirror.checks().findings.filter((f) => f.rule === 'fw.device.behind-chosen-version').flatMap((f) => f.elements.map((e) => e.id));
    const behind = ownTargetLines(d).filter((l) => l.state === 'behind').map((l) => l.device.deviceId);
    // fw-home and rtr are behind; nas is ahead; pf is CE against Plus, which no one can order.
    expect(behind.sort()).toEqual([ids[0]!, ids[2]!].sort());
    expect(flagged.length).toBe(behind.length);
    for (const id of behind) expect(flagged.some((f) => f.includes(id) || id.includes(f))).toBe(true);
  });
});
