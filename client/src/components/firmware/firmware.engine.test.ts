// The page and the check must say "behind" about the same devices (`bash scripts/build-wasm.sh` first).
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { Engine } from '../../engine/engine';
import { Mirror } from '../../engine/mirror';
import { fileLoader } from '../../engine/wasm';
import { modelRows, setFirmwareHold, setTarget } from '../../document/firmware';
import { NOW, estate } from '../../document/firmwareFixture';

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
});
