import { describe, expect, it } from 'vitest';

import type { FirmwareImage } from '../../api/firmware';
import { deviceFirmware, setTarget } from '../../document/firmware';
import { NOW, estate } from '../../document/firmwareFixture';
import { linkWarnings, warningCodes } from './linkWarnings';

const image = (over: Partial<FirmwareImage> = {}): FirmwareImage => ({
  imageId: '01JQZ00000000000000000000A',
  filename: 'junos-install-ex.tgz',
  byteLength: 1000,
  state: 'staged',
  failedReason: null,
  createdAtUnix: 1,
  stagedAtUnix: 2,
  sha256: 'a'.repeat(64),
  sha512: null,
  md5: null,
  lastCheckedAtUnix: null,
  changedAtUnix: null,
  retiredAtUnix: null,
  platform: 'junos-ex',
  version: '23.4R2',
  models: ['ex4300-48t'],
  commands: null,
  ...over,
});

describe('warnings before a one-time link (r62)', () => {
  const { doc, ids } = estate();
  const dev = (name: string) => deviceFirmware(doc, ids[name]!)!;

  it('says nothing for the right model going up to its chosen version', () => {
    const d = setTarget(doc, 'ex4300-48t', { version: '23.4R2', platform: 'junos-ex' }, { now: NOW + 1 });
    expect(linkWarnings(d, image(), [deviceFirmware(d, ids.sw1!)!])).toEqual([]);
  });

  it('names the wrong model, with what the image is for and what the device is', () => {
    const w = linkWarnings(doc, image(), [dev('fw1')]);
    expect(w.map((x) => x.code)).toContain('wrong_model');
    expect(w.find((x) => x.code === 'wrong_model')!.words).toBe('This image is for ex4300-48t. fw1 is srx300.');
  });

  it('says nothing about models when the image lists none', () => {
    expect(linkWarnings(doc, image({ models: [] }), [dev('fw1')]).map((x) => x.code)).not.toContain('wrong_model');
  });

  it('warns of a downgrade, and says nothing when the device has no version recorded', () => {
    const w = linkWarnings(doc, image({ version: '21.4R3-S5' }), [dev('sw3'), dev('sw4')]);
    expect(w.filter((x) => x.code === 'downgrade').map((x) => x.deviceId)).toEqual([ids.sw3]);
  });

  it('warns when the image is not the version chosen for the device', () => {
    const d = setTarget(doc, 'ex4300-48t', { version: '23.4R2', platform: 'junos-ex' }, { now: NOW + 1 });
    const w = linkWarnings(d, image({ version: '22.4R3' }), [deviceFirmware(d, ids.sw1!)!]);
    expect(w.map((x) => x.code)).toEqual(['not_chosen']);
    expect(w[0]!.words).toBe('sw1 has 23.4R2 chosen, not 22.4R3.');
  });

  it('gives the server each code once, sorted', () => {
    const w = linkWarnings(doc, image({ version: '21.4R3-S5' }), [dev('sw3'), dev('fw1')]);
    expect(warningCodes(w)).toEqual(['downgrade', 'wrong_model']);
  });
});
