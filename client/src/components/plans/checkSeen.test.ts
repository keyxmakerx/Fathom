import { describe, expect, it } from 'vitest';

import type { Plan, PlanStep } from '../../document/plans';
import { FETCH_STEP_TITLE, recordStepTitle } from '../firmware/upgradePlan';
import { compareSeen, expectationOf, hexValues, isCheckStep } from './checkSeen';

const step = (ordinal: number, change: string): PlanStep => ({
  id: `PlanStep:${ordinal}`, ordinal, kind: 'other', change, before: '', after: '', targets: ['Device:a'], edit: null, state: 'planned', note: '', doneAt: '', seen: '', compared: null, label: String(ordinal + 1), ifWhen: '', branchOf: '', ifTaken: false, issue: '',
});
const plan = (steps: PlanStep[]): Plan => ({
  id: 'MaintenancePlan:1', title: 'Upgrade EX2300 to 23.4R2', windowStart: '', windowEnd: '', author: '', stage: 'doing', outcome: null, record: '', steps, ifPaths: {}, checks: [], releaseNotes: '',
});

const SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const SHA512 = 'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e';

const hashStep = step(3, `Check the SHA-256 on the device\nCompare with ${SHA256.slice(0, 4)}…${SHA256.slice(-4)}.`);
const sha512Step = step(3, `Check the SHA-512 on the device\nCompare with ${SHA512.slice(0, 4)}…${SHA512.slice(-4)}, which Fathom worked out.`);
const recordStep = step(5, `${recordStepTitle('23.4R2-S3.9')}\nPaste the config back.`);
const firmware = plan([step(0, 'Back up the running config'), step(1, 'Check free space on the device'), step(2, FETCH_STEP_TITLE), hashStep, step(4, 'Install and reboot'), recordStep]);

describe('which steps get the paste box', () => {
  it('in a firmware plan: the device checks and the record step, not the others', () => {
    expect(firmware.steps.filter((s) => isCheckStep(firmware, s)).map((s) => s.ordinal)).toEqual([1, 3, 5]);
  });

  it('a kit step that checks the steps against the vendor is not a device check', () => {
    const kit = plan([step(0, "Check these steps against Synology's own help first"), recordStep]);
    expect(isCheckStep(kit, kit.steps[0]!)).toBe(false);
  });

  it('in any other plan: a step a person wrote starting Check, Verify or Confirm', () => {
    const p = { ...plan([step(0, 'Move the uplink'), step(1, 'Verify BGP is up'), step(2, 'check the LLDP neighbour')]), title: 'Move uplink' };
    expect(p.steps.filter((s) => isCheckStep(p, s)).map((s) => s.ordinal)).toEqual([1, 2]);
  });
});

describe('a hash check', () => {
  // Shapes as each platform prints a file hash: Junos `file checksum sha-256`, IOS XE and EOS `verify /sha512`.
  const junos = `root@ex2300> file checksum sha-256 /var/tmp/junos.tgz\nSHA256 (/var/tmp/junos.tgz) = ${SHA256}\n`;
  const iosxe = `Switch#verify /sha512 bootflash:cat9k.bin\n.........................Done!\nverify /sha512 (bootflash:cat9k.bin) = ${SHA512.toUpperCase()}\n`;

  it('Matches when the image’s own value is in the paste, whatever its case', () => {
    expect(compareSeen(expectationOf(hashStep, SHA256), junos).verdict).toBe('matches');
    expect(compareSeen(expectationOf(sha512Step, SHA512), iosxe).verdict).toBe('matches');
  });

  it('Differs when the paste holds another value of that length', () => {
    const other = junos.replace(SHA256, 'a'.repeat(64));
    const c = compareSeen(expectationOf(hashStep, SHA256), other);
    expect(c.verdict).toBe('differs');
    expect(c.why).toContain('aaaaaaaa…aaaaaaaa');
  });

  it('only the plan’s four and four can never say Matches, only Differs or Can’t tell', () => {
    expect(compareSeen(expectationOf(hashStep), junos).verdict).toBe('cant_tell');
    const near = SHA256.slice(0, 4) + 'f'.repeat(56) + SHA256.slice(-4);
    expect(compareSeen(expectationOf(hashStep), `SHA256 (x) = ${near}`).verdict).toBe('cant_tell');
    expect(compareSeen(expectationOf(hashStep), `SHA256 (x) = ${'b'.repeat(64)}`).verdict).toBe('differs');
  });

  it('a value one character longer or shorter is not that hash', () => {
    expect(hexValues(`${SHA256}0`, 64)).toEqual([]);
    expect(compareSeen(expectationOf(hashStep, SHA256), SHA256.slice(1)).verdict).toBe('cant_tell');
  });

  it('a SHA-256 in a SHA-512 step is not compared', () => {
    expect(compareSeen(expectationOf(sha512Step, SHA512), junos).verdict).toBe('cant_tell');
  });

  it('a full value of the wrong length is ignored, and the plan’s short form is used', () => {
    expect(expectationOf(hashStep, SHA512)).toMatchObject({ full: null, head: SHA256.slice(0, 4) });
  });
});

describe('the record step: the version', () => {
  const e = expectationOf(recordStep);

  it('Matches when the version is a whole word in the paste', () => {
    expect(compareSeen(e, 'Hostname: ex2300\nModel: ex2300-24t\nJunos: 23.4R2-S3.9\n').verdict).toBe('matches');
  });

  it('a longer version is not the same version', () => {
    const short = expectationOf(step(5, recordStepTitle('23.4R2')));
    const c = compareSeen(short, 'Junos: 23.4R2-S3.9\n');
    expect(c.verdict).toBe('differs');
    expect(c.why).toContain('23.4R2-S3.9');
  });

  it('Differs, naming what the device said, on each platform’s version line', () => {
    const want = (v: string) => expectationOf(step(5, recordStepTitle(v)));
    expect(compareSeen(want('17.12.04'), 'Cisco IOS XE Software, Version 17.09.04a\n').why).toContain('17.09.04a');
    expect(compareSeen(want('10.4(3)'), 'NXOS: version 10.3(4a)\n').why).toContain('10.3(4a)');
    expect(compareSeen(want('4.32.1F'), 'Software image version: 4.31.2F\n').why).toContain('4.31.2F');
    expect(compareSeen(want('17.12.04'), 'Cisco IOS XE Software, Version 17.12.04\n').verdict).toBe('matches');
    expect(compareSeen(want('10.3(4a)'), 'NXOS: version 10.3(4a)\n').verdict).toBe('matches');
  });

  it('Can’t tell when no line names a version', () => {
    expect(compareSeen(e, 'ex2300 uptime 3 days').verdict).toBe('cant_tell');
    expect(compareSeen(e, '').verdict).toBe('cant_tell');
  });
});

it('a step with nothing to compare says so', () => {
  const c = compareSeen(expectationOf(step(1, 'Check free space on the device')), 'Filesystem Size Used Avail\n/dev/gpt/var 1.3G 300M 900M');
  expect(c).toEqual({ verdict: 'cant_tell', why: 'Fathom has nothing to compare this step with. Read it yourself.' });
});
