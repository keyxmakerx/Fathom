import { describe, expect, it } from 'vitest';

import type { FirmwareImage } from '../../api/firmware';
import type { FwDevice, FwTarget } from '../../document/firmware';
import type { Plan, PlanStep } from '../../document/plans';
import { KIT_CHOICES } from './kits';
import { FETCH_STEP_TITLE, LINK_PLACEHOLDER, buildUpgradePlan, commandWithLink, commandsFit, labelled, maskedLink, parseUpgradeTitle, stepTitle, upgradeGroups, upgradeTitle } from './upgradePlan';

const HASH = '9f2c' + 'cd'.repeat(28) + 'a41e';

const dev = (id: string, name: string, osVersion = '21.4R3-S5'): FwDevice => ({ deviceId: id, chassisIds: [], hostname: name, models: ['EX2300-24P'], platform: 'junos-ex', osVersion, hold: null, ownTarget: '' });
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
  sha512: null,
  lastCheckedAtUnix: null,
  changedAtUnix: null,
  platform: null,
  version: '23.4R2',
  models: ['EX2300-24P'],
  commands: {
    expectedSha256: HASH,
    devicePath: '/var/tmp/x.tgz',
    sourcedNote: '',
    sourced: 'summary',
    platform: null,
    family: 'junos',
    couldNotEstablish: [],
    deviceHash: { algorithm: 'sha256', comparesWith: 'expected_sha256' },
    byHand: null,
    steps: [
      { order: 1, step: 'check space first', command: 'show system storage', note: '' },
      { order: 2, step: 'make room BEFORE the copy', command: 'request system storage cleanup', note: '' },
      { order: 3, step: 'take the first snapshot', command: 'request system snapshot', note: '' },
      { order: 4, step: 'have the device pull the image', command: 'file copy <the fetch URL, from POST .../fetch-urls — Fathom keeps only its hash> /var/tmp/x.tgz', note: '' },
      { order: 5, step: 'prove the whole file arrived', command: 'file checksum sha-256 /var/tmp/x.tgz', note: '' },
      { order: 6, step: 'prove Juniper made it', command: 'request system software validate /var/tmp/x.tgz', note: '' },
      { order: 7, step: 'install -- yours to run, not Fathom\'s', command: 'request system software add /var/tmp/x.tgz', note: '' },
      { order: 8, step: 'and the second snapshot, after it comes back', command: 'request system snapshot', note: '' },
    ],
  },
  ...over,
});

describe('buildUpgradePlan', () => {
  const t = buildUpgradePlan({ devices: [dev('d1', 'switch-1'), dev('d3', 'switch-3')], label: 'EX2300-24P', version: target.version, target, image: image() });

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
      'Record 23.4R2 as running',
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
    expect(t.steps[2]!.after).toBe(`file copy ${LINK_PLACEHOLDER} /var/tmp/x.tgz`);
    expect(JSON.stringify(t)).not.toContain('http');
    expect(JSON.stringify(t)).not.toContain('POST');
    expect(commandWithLink(t.steps[2]!.after!, 'https://f.example/fw/fetch/abc')).toBe('file copy https://f.example/fw/fetch/abc /var/tmp/x.tgz');
  });

  it('says so when the image is not staged, and gives no commands it does not have', () => {
    const u = buildUpgradePlan({ devices: [dev('d1', 'switch-1')], label: 'EX2300-24P', version: target.version, target, image: image({ state: 'failed', sha256: null, commands: null }) });
    expect(u.steps[2]!.change).toContain('Stage the image in Fathom first');
    expect(u.steps.every((s) => s.after === undefined)).toBe(true);
  });

  it('has no command the server did not write: a staged image without steps gets none, and says so', () => {
    const none = image({ platform: 'frr', commands: { ...image().commands!, platform: 'frr', family: 'unknown', sourced: 'none', steps: [] } });
    const u = buildUpgradePlan({ devices: [{ ...dev('d1', 'a'), platform: 'frr' }], label: 'X', version: target.version, target: { ...target, platform: 'frr' }, image: none });
    expect(u.steps.every((s) => s.after === undefined)).toBe(true);
    expect(u.steps[2]!.change).toBe(`${FETCH_STEP_TITLE}\nNo steps are written for this platform yet.`);
    expect(JSON.stringify(u)).not.toContain('copy the image from');
  });

  it("does not hand a Juniper command list to another vendor's switch", () => {
    const u = buildUpgradePlan({ devices: [{ ...dev('d1', 'a'), platform: 'eos' }], label: 'DCS-7050', version: '4.31.1.1M', target: { ...target, platform: 'eos', version: '4.31.1.1M' }, image: image() });
    expect(u.steps.some((s) => (s.after ?? '').includes('request system'))).toBe(false);
  });
});

const step = (n: number, title: string, command: string) => ({ order: n, step: title, command, note: '' });

describe('the plan for other vendors, from the server steps', () => {
  const ios = image({
    platform: 'ios-xe',
    commands: {
      expectedSha256: HASH,
      devicePath: 'bootflash:x.bin',
      sourcedNote: '',
      sourced: 'vendor_docs',
      platform: 'ios-xe',
      family: 'ios-xe',
      couldNotEstablish: ['an on-device SHA-256 command on IOS XE'],
      deviceHash: { algorithm: 'sha512', comparesWith: 'vendor_published_sha512' },
      byHand: null,
      steps: [
        step(1, 'check space first', 'dir bootflash:'),
        step(2, 'make room BEFORE the copy', 'install remove inactive'),
        step(3, 'have the device pull the image', 'copy <the fetch URL, from POST .../fetch-urls> bootflash:x.bin'),
        step(4, 'prove the whole file arrived', 'verify /sha512 bootflash:x.bin'),
        step(5, 'check Cisco signed it', 'show software authenticity file bootflash:x.bin'),
        step(6, "install -- yours to run, not Fathom's", 'install add file bootflash:x.bin activate commit'),
        step(7, 'check after it comes back', 'show version'),
      ],
    },
  });
  const plan = buildUpgradePlan({ devices: [{ ...dev('d1', 'a'), platform: 'ios-xe' }], label: 'C9300', version: target.version, target: { ...target, platform: 'ios-xe' }, image: ios });

  it('puts IOS XE steps under the six plain ones, "install remove inactive" in the room step', () => {
    expect(plan.steps).toHaveLength(6);
    expect(plan.steps[1]!.after).toBe('dir bootflash:\ninstall remove inactive');
    expect(plan.steps[2]!.after).toBe(`copy ${LINK_PLACEHOLDER} bootflash:x.bin`);
    expect(plan.steps[3]!.after).toBe('verify /sha512 bootflash:x.bin\nshow software authenticity file bootflash:x.bin');
    expect(plan.steps[4]!.after).toBe('install add file bootflash:x.bin activate commit');
    expect(plan.steps[5]!.after).toBe('show version');
  });

  it("words step 4 from the device hash: IOS XE compares a SHA-512 with Cisco's, not Fathom's SHA-256", () => {
    expect(plan.steps[3]!.change).toBe("Check the SHA-512 on the device\nCompare with the SHA-512 on Cisco's download page.");
    expect(plan.steps[3]!.change).not.toContain('SHA-256');
    expect(plan.steps[3]!.change).not.toContain('9f2c');
  });

  it('keeps the SHA-256 wording where the device offers a SHA-256', () => {
    const eos = image({ platform: 'eos', commands: { ...ios.commands!, platform: 'eos', family: 'eos', deviceHash: { algorithm: 'sha256', comparesWith: 'expected_sha256' }, steps: [step(1, 'save the configuration', 'copy running-config flash:/b'), step(2, 'reload -- yours to run, not Fathom\'s', 'reload'), step(3, 'compare with the hash Arista publishes', 'verify /sha512 flash:/x.swi')] } });
    const p = buildUpgradePlan({ devices: [{ ...dev('d1', 'a'), platform: 'eos' }], label: 'DCS', version: target.version, target: { ...target, platform: 'eos' }, image: eos });
    expect(p.steps[3]!.change).toContain('Check the SHA-256 on the device');
    expect(p.steps[0]!.after).toBe('copy running-config flash:/b');
    expect(p.steps[3]!.after).toBe('verify /sha512 flash:/x.swi');
    expect(p.steps[4]!.after).toBe('reload');
  });
});

describe('helpers', () => {
  it('commandsFit trusts the image platform when it has one, else a Junos device', () => {
    expect(commandsFit(image({ platform: 'junos-srx' }), 'junos-srx')).toBe(true);
    expect(commandsFit(image({ platform: 'junos-srx' }), 'junos-ex')).toBe(false);
    expect(commandsFit(image(), 'junos-mx')).toBe(true);
    expect(commandsFit(image(), 'ios-xe')).toBe(false);
    expect(commandsFit(image({ platform: 'ios-xe' }), 'ios-xe')).toBe(true);
    expect(commandsFit(null, 'junos-ex')).toBe(false);
  });
  it('masks a link after its path', () => {
    expect(maskedLink('https://fathom.example/firmware/fetch/abcdef0123')).toBe('https://fathom.example/firmware/fetch/••••••••••••');
    expect(maskedLink('abc')).toBe('••••••••');
  });
});

describe('an upgrade Fathom has no image for (schema 0.31)', () => {
  const fw: FwDevice = { deviceId: 'f1', chassisIds: [], hostname: 'fw-home', models: [], platform: 'opnsense', osVersion: '25.7.11_2', hold: null, ownTarget: '26.1' };

  it("uses the written steps for the device's platform, and ends on the record step", () => {
    const t = buildUpgradePlan({ devices: [fw], label: 'fw-home', version: '26.1', target: null, image: null });
    expect(t.title).toBe('Upgrade fw-home to 26.1');
    const titles = t.steps.map((s) => stepTitle(s.change));
    expect(titles[0]).toBe('Check these steps against OPNsense');
    expect(titles).toContain('Check for updates and install');
    expect(titles[titles.length - 1]).toBe('Record 26.1 as running');
    expect(t.steps.some((s) => s.change.includes(FETCH_STEP_TITLE))).toBe(false);
    expect(t.steps.every((s) => s.change.split('\n').length === 2)).toBe(true);
  });

  it('takes the steps the person picked, and Synology says it was not checked', () => {
    const nas = { ...fw, deviceId: 'n1', hostname: 'blackopal', platform: '', ownTarget: '7.2.2' };
    const t = buildUpgradePlan({ devices: [nas], label: 'blackopal', version: '7.2.2', target: null, image: null, kit: 'synology' });
    expect(t.steps[0]!.change).toContain("Check these steps against Synology's own help first");
    expect(t.steps[0]!.change).toContain('could not read');
    const deb = buildUpgradePlan({ devices: [nas], label: 'blackopal', version: '13', target: null, image: null, kit: 'debian' });
    expect(deb.steps.find((s) => (s.after ?? '').includes('apt full-upgrade'))).toBeDefined();
  });

  it('every kit names where it came from and has no link in it', () => {
    for (const k of KIT_CHOICES) {
      const t = buildUpgradePlan({ devices: [fw], label: 'x', version: '1', target: null, image: null, kit: k });
      expect(JSON.stringify(t)).not.toContain(LINK_PLACEHOLDER);
      if (k !== 'general') expect(t.steps[0]!.change).toMatch(/Check these steps against/);
    }
  });
});

describe('one plan holding several upgrades', () => {
  const step = (id: string, change: string, targets: string[]): PlanStep => ({ id, ordinal: 0, kind: 'other', change, before: '', after: '', targets, edit: null, state: 'planned', note: '', doneAt: '' });
  const plan = (title: string, steps: PlanStep[]): Plan => ({ id: 'p', title, windowStart: '', windowEnd: '', author: '', stage: 'planned', outcome: null, record: '', steps });

  it('is known by its record steps whatever it is called, and pairs each fetch with its devices', () => {
    const added = labelled(buildUpgradePlan({ devices: [dev('d9', 'core-1')], label: 'EX2300-24P', version: '23.4R2', target, image: image() }), 'EX2300-24P to 23.4R2');
    expect(stepTitle(added.steps[2]!.change)).toBe(FETCH_STEP_TITLE);
    const p = plan('Saturday window', [
      step('a', 'fw-home to 26.1 · Check for updates and install\nx', ['f1']),
      step('b', 'fw-home to 26.1 · Record 26.1 as running\nx', ['f1']),
      ...added.steps.map((s, i) => step(`s${i}`, s.change, ['d9'])),
    ]);
    const groups = upgradeGroups(p);
    expect(groups.map((g) => [g.version, g.deviceIds, g.fetchStep?.id ?? null])).toEqual([
      ['26.1', ['f1'], null],
      ['23.4R2', ['d9'], 's2'],
    ]);
  });

  it('still knows a plan made before the record step, by its title', () => {
    const p = plan('Upgrade EX2300-24P to 23.4R2', [step('f', `${FETCH_STEP_TITLE}\nx`, ['d1'])]);
    expect(upgradeGroups(p)).toEqual([{ version: '23.4R2', deviceIds: ['d1'], fetchStep: p.steps[0] }]);
    expect(upgradeGroups(plan('Move the rack', [step('x', 'Move it\ny', ['d1'])]))).toEqual([]);
  });
});
