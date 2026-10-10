import { describe, expect, it } from 'vitest';

import {
  FirmwareRefusal,
  STATE_WORD,
  allDevices,
  cleanSha256,
  clearTarget,
  deviceFirmware,
  listTargets,
  modelRows,
  setFirmwareHold,
  setTarget,
  stateOf,
  targetFor,
} from './firmware';
import { NOW, estate } from './firmwareFixture';
import { emptyDocument, parseNodeId, type Document } from './model';
import { undo } from './undo';

describe('stateOf', () => {
  const dev = (osVersion: string, hold: string | null = null) => ({ platform: 'junos-ex', osVersion, hold });
  const target = { version: '21.4R3-S6', platform: '' };

  it('says each state in words', () => {
    expect(stateOf(dev('21.4R3-S5'), target)).toBe('behind');
    expect(stateOf(dev('21.4R3-S6'), target)).toBe('current');
    expect(stateOf(dev('22.1R1'), target)).toBe('current');
    expect(stateOf(dev(''), target)).toBe('not-recorded');
    expect(stateOf(dev('20.4X53-D10'), target)).toBe('unclear');
    expect(stateOf(dev('21.4R3-S5'), null)).toBe('no-target');
    expect(Object.keys(STATE_WORD).sort()).toEqual(['behind', 'current', 'held', 'no-target', 'not-recorded', 'unclear']);
  });

  it('a hold wins over behind, as the check does, but not over no chosen version', () => {
    expect(stateOf(dev('21.4R3-S5', 'ordered 2024 for the lab'), target)).toBe('held');
    expect(stateOf(dev('21.4R3-S5', 'x'), null)).toBe('no-target');
  });

  it('falls back to the target platform when the device has none', () => {
    expect(stateOf({ platform: '', osVersion: '4.30.2F', hold: null }, { version: '4.31.1.1M', platform: 'eos' })).toBe('behind');
    expect(stateOf({ platform: '', osVersion: '4.30.2F', hold: null }, { version: '4.31.1.1M', platform: '' })).toBe('unclear');
  });
});

describe('targets', () => {
  it('chooses a version for a model, then changes it, as one undo step each', () => {
    const { doc } = estate();
    const by = { actor: '01ARZ3NDEKTSV4RRFFQ69G5FAV' };
    const a = setTarget(doc, 'ex4300-48t', { version: '21.4R3-S6', platform: 'junos-ex' }, { ...by, now: NOW + 9 });
    expect(targetFor(a, 'ex4300-48t')).toMatchObject({ version: '21.4R3-S6', platform: 'junos-ex', image: '', note: '' });
    const b = setTarget(a, 'ex4300-48t', { version: '22.1R1', note: 'after the freeze' }, { ...by, now: NOW + 10 });
    expect(listTargets(b)).toHaveLength(1);
    expect(targetFor(b, 'ex4300-48t')).toMatchObject({ version: '22.1R1', platform: 'junos-ex', note: 'after the freeze' });
    expect(b.batches.length).toBe(a.batches.length + 1);
    const back = undo(b, b.batches[b.batches.length - 1]!.id, { ...by, now: NOW + 11 });
    expect(targetFor(back, 'ex4300-48t')).toMatchObject({ version: '21.4R3-S6', note: '' });
  });

  it('names an image, then lets go of it with null', () => {
    const { doc } = estate();
    const sha = 'a'.repeat(64);
    const a = setTarget(doc, 'ex4300-48t', { version: '21.4R3-S6', image: '01ARZ3NDEKTSV4RRFFQ69G5FAV', imageSha256: sha }, { now: NOW + 9 });
    expect(targetFor(a, 'ex4300-48t')).toMatchObject({ image: '01ARZ3NDEKTSV4RRFFQ69G5FAV', imageSha256: sha });
    const b = setTarget(a, 'ex4300-48t', { version: '21.4R3-S6', image: null, imageSha256: null }, { now: NOW + 10 });
    expect(targetFor(b, 'ex4300-48t')).toMatchObject({ image: '', imageSha256: '' });
  });

  it('writes nothing when nothing changed', () => {
    const { doc } = estate();
    const a = setTarget(doc, 'ex4300-48t', { version: '21.4R3-S6' }, { now: NOW + 9 });
    expect(setTarget(a, 'ex4300-48t', { version: '21.4R3-S6' }, { now: NOW + 10 })).toBe(a);
  });

  it('refuses what the schema would not hold, in words', () => {
    const { doc } = estate();
    expect(() => setTarget(doc, 'ex 4300', { version: '1' })).toThrow(FirmwareRefusal);
    expect(() => setTarget(doc, 'ex4300', { version: '' })).toThrow('Give a version.');
    expect(() => setTarget(doc, 'ex4300', { version: '21.4 R3' })).toThrow('no spaces');
    expect(() => setTarget(doc, 'ex4300', { version: '1', platform: 'panos2' })).toThrow('platform');
    expect(() => setTarget(doc, 'ex4300', { version: '1', image: 'nope' })).toThrow('image');
    expect(() => setTarget(doc, 'ex4300', { version: '1', imageSha256: 'abc' })).toThrow('64');
  });

  it('clears a target', () => {
    const { doc } = estate();
    const a = setTarget(doc, 'ex4300-48t', { version: '21.4R3-S6' });
    const b = clearTarget(a, 'ex4300-48t');
    expect(listTargets(b)).toHaveLength(0);
    expect(clearTarget(b, 'ex4300-48t')).toBe(b);
  });

  it('shows one target per model when a payload holds two', () => {
    const { doc } = estate();
    const a = setTarget(doc, 'srx300', { version: '21.4R3' }, { now: NOW + 1 });
    const dupe = setTarget(a, 'srx300', { version: '21.4R4' }, { now: NOW + 2 });
    // Make a second node by hand the way a merge could.
    const first = a.nodes.find((n) => parseNodeId(n.id).kind === 'FirmwareTarget')!;
    const merged: Document = { ...dupe, nodes: [...dupe.nodes, { ...first, id: first.id.replace(/.$/, first.id.endsWith('Z') ? 'Y' : 'Z') }] };
    expect(listTargets(merged)).toHaveLength(1);
  });
});

describe('holds', () => {
  it('holds a device with a reason and lifts it', () => {
    const { doc, ids } = estate();
    const a = setFirmwareHold(doc, ids.sw1!, '  customer freeze until March ', { now: NOW + 5 });
    expect(deviceFirmware(a, ids.sw1!)?.hold).toBe('customer freeze until March');
    const b = setFirmwareHold(a, ids.sw1!, null, { now: NOW + 6 });
    expect(deviceFirmware(b, ids.sw1!)?.hold).toBeNull();
    expect(setFirmwareHold(b, ids.sw1!, null)).toBe(b);
  });

  it('refuses a hold with no reason', () => {
    const { doc, ids } = estate();
    expect(() => setFirmwareHold(doc, ids.sw1!, '   ')).toThrow('Say why');
    expect(() => setFirmwareHold(doc, 'device:nope', 'x')).toThrow(FirmwareRefusal);
  });
});

describe('the list', () => {
  it('has a row per model, with its devices and how many are behind and held', () => {
    const { doc, ids } = estate();
    let d = setTarget(doc, 'ex4300-48t', { version: '21.4R3-S6', platform: 'junos-ex' }, { now: NOW + 5 });
    d = setFirmwareHold(d, ids.sw1!, 'lab unit', { now: NOW + 6 });
    const rows = modelRows(d);
    expect(rows.map((r) => r.model)).toEqual(['ex4300-48t', 'srx300']);
    const ex = rows[0]!;
    expect(ex.devices).toHaveLength(4);
    expect(ex.behind).toBe(0);
    expect(ex.held).toBe(1);
    expect(ex.devices.map((l) => l.state)).toEqual(['held', 'current', 'current', 'not-recorded']);
    expect(rows[1]!.target).toBeNull();
    expect(rows[1]!.devices[0]!.state).toBe('no-target');
  });

  it('counts a device behind only when the numbers say so', () => {
    const { doc } = estate();
    const rows = modelRows(setTarget(doc, 'ex4300-48t', { version: '22.1R1', platform: 'junos-ex' }));
    expect(rows[0]!.behind).toBe(2);
  });

  it('lists a model that has a target and no devices', () => {
    const rows = modelRows(setTarget(emptyDocument(), 'qfx5120', { version: '23.4R2' }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.devices).toHaveLength(0);
  });

  it('reads every device once', () => {
    expect(allDevices(estate().doc)).toHaveLength(5);
  });
});

describe('cleanSha256', () => {
  it('takes a hash as a vendor page shows it', () => {
    const h = 'A1B2C3D4'.repeat(8);
    expect(cleanSha256(`  ${h}  `)).toBe(h.toLowerCase());
    expect(cleanSha256(`SHA256: ${h.slice(0, 32)} ${h.slice(32)}`)).toBe(h.toLowerCase());
    expect(cleanSha256('nope')).toBeNull();
    expect(cleanSha256(h.slice(2))).toBeNull();
  });
});
