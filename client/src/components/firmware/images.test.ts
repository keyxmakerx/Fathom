import { describe, expect, it } from 'vitest';

import type { FirmwareImage } from '../../api/firmware';
import { setFirmwareHold, setTarget } from '../../document/firmware';
import { NOW, addDevice } from '../../document/firmwareFixture';
import { emptyDocument, type Document } from '../../document/model';
import { addStep, createPlan, TYPED_AS_WRITTEN } from '../../document/plans';
import { BADGE_WORD, behindByModel, filterImageRows, imageRows, modelsOfImage, vendorOf } from './images';

const HASH = (c: string) => c.repeat(64);

const image = (id: string, version: string, models: string[], over: Partial<FirmwareImage> = {}): FirmwareImage => ({
  imageId: id,
  filename: `junos-${version}.tgz`,
  byteLength: 1_000_000_000,
  state: 'staged',
  failedReason: null,
  createdAtUnix: 1,
  stagedAtUnix: 2,
  sha256: HASH(id.slice(-1).toLowerCase() === 'a' ? 'a' : 'b'),
  platform: 'junos-ex',
  version,
  models,
  commands: null,
  ...over,
});

/** Four EX2300-24P switches (three on 21.4R3-S5, one on 23.4R2), one SRX300 on 22.4R3. */
function estate(): { doc: Document; ids: string[] } {
  let doc = emptyDocument();
  const ids: string[] = [];
  let t = NOW;
  for (const [name, model, version] of [
    ['switch-1', 'EX2300-24P', '21.4R3-S5'],
    ['switch-2', 'EX2300-24P', '23.4R2'],
    ['switch-3', 'EX2300-24P', '21.4R3-S5'],
    ['switch-4', 'EX2300-24P', '21.4R3-S5'],
    ['fw-1', 'SRX300', '22.4R3'],
  ] as const) {
    t += 1000;
    const made = addDevice(doc, name, model, name.startsWith('fw') ? 'junos-srx' : 'junos-ex', version, t);
    doc = made.doc;
    ids.push(made.deviceId);
  }
  return { doc, ids };
}

const I_NEW = image('01JQZ00000000000000000000A', '23.4R2', ['EX2300-24P', 'EX2300-48P']);
const I_OLD = image('01JQZ00000000000000000000B', '21.4R3-S5', ['EX2300-24P']);
const I_NONE = image('01JQZ00000000000000000000C', '10.4.3', [], { platform: 'nx-os' });

describe('imageRows', () => {
  it('groups the rows Juniper, then Cisco, then Arista, the chosen version first within a model', () => {
    const { doc } = estate();
    const eos = image('01JQZ00000000000000000000D', '4.30.2F', ['DCS-7050SX3-48YC8'], { platform: 'eos' });
    const d = setTarget(doc, 'EX2300-24P', { version: '23.4R2', platform: 'junos-ex', image: I_NEW.imageId }, { now: NOW + 1 });
    const rows = imageRows({ doc: d, images: [eos, I_NONE, I_OLD, I_NEW] });
    expect(rows.map((r) => r.version)).toEqual(['23.4R2', '21.4R3-S5', '10.4.3', '4.30.2F']);
  });

  it('one row per image: running, behind, plans and a badge', () => {
    const { doc, ids } = estate();
    let d = setTarget(doc, 'EX2300-24P', { version: '23.4R2', platform: 'junos-ex', image: I_NEW.imageId, imageSha256: I_NEW.sha256 }, { now: NOW + 1 });
    d = setTarget(d, 'SRX300', { version: '22.4R3', platform: 'junos-srx' }, { now: NOW + 2 });
    const made = createPlan(d, { title: 'Upgrade EX2300-24P to 23.4R2', gate: TYPED_AS_WRITTEN, now: NOW + 3 });
    d = addStep(made.doc, made.id, { kind: 'other', change: 'step', targets: [ids[0]!], gate: TYPED_AS_WRITTEN, now: NOW + 4 }).doc;

    const rows = imageRows({ doc: d, images: [I_OLD, I_NEW, I_NONE] });
    const by = (v: string) => rows.find((r) => r.version === v)!;

    const chosen = by('23.4R2');
    expect(chosen).toMatchObject({ badge: 'chosen', models: ['EX2300-24P', 'EX2300-48P'], running: 1, behind: 3, plans: 1, vendor: 'juniper' });
    expect(chosen.behindDevices).toEqual([ids[0], ids[2], ids[3]]);

    expect(by('21.4R3-S5')).toMatchObject({ badge: 'older', running: 3, behind: null, plans: 0 });
    expect(by('10.4.3')).toMatchObject({ badge: 'staged', running: 0, behind: null, models: [], vendor: 'cisco' });
    // The SRX version was typed with no image: still a row, and still chosen.
    expect(by('22.4R3')).toMatchObject({ badge: 'chosen', image: null, running: 1, behind: 0, models: ['SRX300'] });
    expect(rows).toHaveLength(4);
  });

  it('leaves out an image that is not staged', () => {
    const { doc } = estate();
    const rows = imageRows({ doc, images: [image('01JQZ00000000000000000000D', '1.0', [], { state: 'failed', sha256: null })] });
    expect(rows).toEqual([]);
  });

  it('ignores the chosen-version fallback once the server names models', () => {
    const named = image('I9', '23.4R2', ['EX2300-48P']);
    expect(modelsOfImage(named, [{ id: 't', model: 'EX2300-24P', version: '23.4R2', platform: '', image: 'I9', imageSha256: '', note: '' }])).toEqual(['EX2300-48P']);
  });

  it('falls back to the models whose chosen version names the image', () => {
    const { doc } = estate();
    const bare = image('01JQZ00000000000000000000E', '23.4R2', []);
    const d = setTarget(doc, 'EX2300-24P', { version: '23.4R2', image: bare.imageId });
    expect(modelsOfImage(bare, [{ id: 't', model: 'EX2300-24P', version: '23.4R2', platform: '', image: bare.imageId, imageSha256: '', note: '' }])).toEqual(['EX2300-24P']);
    expect(imageRows({ doc: d, images: [bare] })[0]).toMatchObject({ models: ['EX2300-24P'], badge: 'chosen', behind: 3 });
  });

  it('a held device is not counted behind', () => {
    const { doc, ids } = estate();
    let d = setTarget(doc, 'EX2300-24P', { version: '23.4R2', image: I_NEW.imageId });
    d = setFirmwareHold(d, ids[0]!, 'lab rig', { now: NOW + 9 });
    const row = imageRows({ doc: d, images: [I_NEW] })[0]!;
    expect(row.behind).toBe(2);
    expect(behindByModel(d)).toEqual([{ model: 'EX2300-24P', deviceIds: [ids[2], ids[3]] }]);
  });

  it('with no server, a typed version is still listed', () => {
    const { doc } = estate();
    const rows = imageRows({ doc: setTarget(doc, 'EX2300-24P', { version: '23.4R2' }), images: [] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ image: null, version: '23.4R2', sha256: '', badge: 'chosen', behind: 3 });
  });
});

describe('filter', () => {
  const { doc } = estate();
  const rows = imageRows({ doc, images: [I_OLD, I_NEW, I_NONE] });
  it('vendor tabs and the filter box', () => {
    expect(filterImageRows(rows, '', 'all')).toHaveLength(3);
    expect(filterImageRows(rows, '', 'juniper')).toHaveLength(2);
    expect(filterImageRows(rows, '', 'cisco').map((r) => r.version)).toEqual(['10.4.3']);
    expect(filterImageRows(rows, '', 'arista')).toEqual([]);
    expect(filterImageRows(rows, 'ex2300-48p', 'all').map((r) => r.version)).toEqual(['23.4R2']);
    expect(filterImageRows(rows, '23.4 chosen', 'all')).toEqual([]);
  });
  it('words', () => {
    expect(vendorOf('junos-mx')).toBe('juniper');
    expect(vendorOf('eos')).toBe('arista');
    expect(vendorOf('panos')).toBeNull();
    expect(Object.values(BADGE_WORD)).toEqual(['Chosen', 'Older', 'Staged']);
  });
});
