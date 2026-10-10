import { describe, expect, it } from 'vitest';

import type { FirmwareImage } from '../../api/firmware';
import type { FwDevice, FwTarget } from '../../document/firmware';
import { FETCH_STEP_TITLE, LINK_PLACEHOLDER, buildUpgradePlan, commandWithLink, commandsFit, maskedLink, parseUpgradeTitle, upgradeTitle } from './upgradePlan';

const HASH = '9f2c' + 'cd'.repeat(28) + 'a41e';

const dev = (id: string, name: string, osVersion = '21.4R3-S5'): FwDevice => ({ deviceId: id, chassisIds: [], hostname: name, models: ['EX2300-24P'], platform: 'junos-ex', osVersion, hold: null });
const target: FwTarget = { id: 't', model: 'EX2300-24P', version: '23.4R2', platform: 'junos-ex', image: 'I1', imageSha256: HASH, note: '' };

const image = (over: Partial<FirmwareImage> = {}): FirmwareImage => ({
  imageId: 'I1',
  filename: 'junos-install-ex.tgz',
  byteLength: 1_400_000_000,
  state: 'staged',
  failedReason: null,
  createdAtUnix: 1,
  stagedAtUnix: 2,
  sha256: HASH,
  platform: null,
  version: '23.4R2',
  models: ['EX2300-24P'],
  commands: {
    expectedSha256: HASH,
    devicePath: '/var/tmp/x.tgz',
    sourcedNote: '',
    steps: [
      { order: 1, step: 'check space first', command: 'show system storage', note: '' },
      { order: 2, step: 'make room BEFORE the copy', command: 'request system storage cleanup', note: '' },
      { order: 3, step: 'take the first snapshot', command: 'request system snapshot', note: '' },
      { order: 4, step: 'have the device pull the image', command: 'file copy <the fetch URL, from POST .../fetch-urls — Fathom keeps only its hash> /var/tmp/', note: '' },
      { order: 5, step: 'prove the whole file arrived', command: 'file checksum sha-256 /var/tmp/x.tgz', note: '' },
      { order: 6, step: 'prove Juniper made it', command: 'request system software validate /var/tmp/x.tgz', note: '' },
      { order: 7, step: 'install -- yours to run, not Fathom\'s', command: 'request system software add /var/tmp/x.tgz', note: '' },
      { order: 8, step: 'and the second snapshot, after it comes back', command: 'request system snapshot', note: '' },
    ],
  },
  ...over,
});

describe('buildUpgradePlan', () => {
  const t = buildUpgradePlan({ devices: [dev('d1', 'switch-1'), dev('d3', 'switch-3')], model: 'EX2300-24P', target, image: image() });

  it('is one plan for the devices, named for the model and the version', () => {
    expect(t.title).toBe('Upgrade EX2300-24P to 23.4R2');
    expect(t.deviceIds).toEqual(['d1', 'd3']);
    expect(parseUpgradeTitle(t.title)).toEqual({ model: 'EX2300-24P', version: '23.4R2' });
    expect(upgradeTitle('X', '1')).toBe('Upgrade X to 1');
    expect(parseUpgradeTitle('Change to switch-1')).toBeNull();
  });

  it('has six steps in plain words, each with a muted second line', () => {
    expect(t.steps.map((s) => s.change.split('\n')[0])).toEqual([
      'Back up the running config',
      'Check free space on the device',
      FETCH_STEP_TITLE,
      'Check the SHA-256 on the device',
      'Install and reboot',
      'Paste the new version back',
    ]);
    expect(t.steps.every((s) => s.kind === 'other' && s.change.split('\n').length === 2)).toBe(true);
    expect(t.steps[3]!.change).toContain('Compare with 9f2c…a41e.');
  });

  it("keeps the vendor's commands in the step they belong to, not as extra steps", () => {
    expect(t.steps[0]!.after).toBe('request system snapshot');
    expect(t.steps[1]!.after).toBe('show system storage\nrequest system storage cleanup');
    expect(t.steps[3]!.after).toBe('file checksum sha-256 /var/tmp/x.tgz\nrequest system software validate /var/tmp/x.tgz');
    expect(t.steps[4]!.after).toBe('request system software add /var/tmp/x.tgz\nrequest system snapshot');
    expect(t.steps[5]!.after).toBeUndefined();
  });

  it('never carries a link: the fetch step shows a placeholder', () => {
    expect(t.steps[2]!.after).toBe(`file copy ${LINK_PLACEHOLDER} /var/tmp/`);
    expect(JSON.stringify(t)).not.toContain('http');
    expect(JSON.stringify(t)).not.toContain('POST');
    expect(commandWithLink(t.steps[2]!.after!, 'https://f.example/fw/fetch/abc')).toBe('file copy https://f.example/fw/fetch/abc /var/tmp/');
  });

  it('says so when the image is not staged, and gives no commands it does not have', () => {
    const u = buildUpgradePlan({ devices: [dev('d1', 'switch-1')], model: 'EX2300-24P', target, image: image({ state: 'failed', sha256: null, commands: null }) });
    expect(u.steps[2]!.change).toContain('Stage the image in Fathom first');
    expect(u.steps.every((s) => s.after === undefined)).toBe(true);
  });

  it("does not hand a Juniper command list to another vendor's switch", () => {
    const u = buildUpgradePlan({ devices: [{ ...dev('d1', 'a'), platform: 'eos' }], model: 'DCS-7050', target: { ...target, platform: 'eos', version: '4.31.1.1M' }, image: image() });
    expect(u.steps.some((s) => (s.after ?? '').includes('request system'))).toBe(false);
  });
});

describe('helpers', () => {
  it('commandsFit trusts the image platform when it has one, else a Junos device', () => {
    expect(commandsFit(image({ platform: 'junos-srx' }), 'junos-srx')).toBe(true);
    expect(commandsFit(image({ platform: 'junos-srx' }), 'junos-ex')).toBe(false);
    expect(commandsFit(image(), 'junos-mx')).toBe(true);
    expect(commandsFit(image(), 'ios-xe')).toBe(false);
    expect(commandsFit(null, 'junos-ex')).toBe(false);
  });
  it('masks a link after its path', () => {
    expect(maskedLink('https://fathom.example/firmware/fetch/abcdef0123')).toBe('https://fathom.example/firmware/fetch/••••••••••••');
    expect(maskedLink('abc')).toBe('••••••••');
  });
});
