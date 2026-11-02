// The read-only list against real spellings (ADR-0080 decision 9). Each refusal here is a command
// that writes, sends, runs something else, or could be made to: the list must refuse every one.

import { describe, expect, it } from 'vitest';

import { familyOf, readOnlyVerdict } from './readOnly';

const ok = (platform: string, command: string) => readOnlyVerdict(platform, command).ok;

describe('allowed: the commands Fathom’s own steps use, and plain show', () => {
  it.each([
    ['junos-ex', 'show version'],
    ['junos-ex', 'show system storage'],
    ['junos-srx', 'file checksum sha-256 /var/tmp/junos-arm-32-23.4R2-S3.9.tgz'],
    ['junos-mx', 'show interfaces ge-0/0/1 terse | match up'],
    ['junos-ex', 'show configuration | display set | match ge-0/0/1'],
    ['ios-xe', 'show version'],
    ['ios-xe', 'show interfaces GigabitEthernet1/0/1 | include line protocol'],
    ['ios-xe', 'dir bootflash:'],
    ['ios-xe', 'verify /sha512 bootflash:cat9k_iosxe.17.12.04.SPA.bin'],
    ['nx-os', 'show file bootflash:nxos64-cs.10.4.3.F.bin sha256sum'],
    ['nx-os', 'show version | section Software'],
    ['eos', 'show version'],
    ['eos', 'verify /sha512 flash:/EOS-4.32.1F.swi'],
    ['eos', 'verify-swi EOS-4.32.1F.swi'],
  ])('%s: %s', (platform, command) => {
    expect(readOnlyVerdict(platform, command)).toEqual({ ok: true });
  });
});

describe('refused: anything that changes, writes, sends or chains', () => {
  it.each([
    ['ios-xe', 'reload'],
    ['ios-xe', 'copy running-config startup-config'],
    ['ios-xe', 'delete /force bootflash:old.bin'],
    ['ios-xe', 'show running-config | redirect bootflash:run.txt'],
    ['ios-xe', 'show running-config | tee bootflash:run.txt'],
    ['ios-xe', 'show running-config | append bootflash:run.txt'],
    ['ios-xe', 'sh run'],
    ['ios-xe', 'show version | inc Version'],
    ['ios-xe', 'show version | section Version'],
    ['ios-xe', 'show version ; reload'],
    ['ios-xe', 'show version\nreload'],
    ['ios-xe', 'show version\rreload'],
    ['ios-xe', 'verify bootflash:x.bin'],
    ['junos-ex', 'request system reboot'],
    ['junos-ex', 'request system software add /var/tmp/junos.tgz'],
    ['junos-ex', 'file delete /var/tmp/junos.tgz'],
    ['junos-ex', 'file copy /var/tmp/a /var/tmp/b'],
    ['junos-ex', 'file checksum md5 /var/tmp/a'],
    ['junos-ex', 'show configuration | save /var/tmp/config.txt'],
    ['junos-ex', 'show configuration | tee /var/tmp/config.txt'],
    ['junos-ex', 'show configuration | append /var/tmp/config.txt'],
    ['junos-ex', 'show log messages | request message all'],
    ['junos-ex', 'show version | match "a|b"'],
    ['junos-ex', 'start shell'],
    ['junos-ex', 'configure'],
    ['nx-os', 'show running-config > bootflash:run.txt'],
    ['nx-os', 'show running-config >> bootflash:run.txt'],
    ['nx-os', 'show running-config | vsh'],
    ['nx-os', 'show running-config | perl'],
    ['nx-os', 'show running-config | sed s/a/b/'],
    ['nx-os', 'run bash'],
    ['eos', 'show version | include Software'],
    ['eos', 'bash sudo reboot'],
    ['eos', 'show version | redirect flash:x'],
    ['eos', 'show $(reload)'],
    ['eos', 'show `reload`'],
    ['eos', 'show {{SECRET}}'],
    ['eos', 'show ${INPUT_1:x}'],
    ['eos', 'show version | '],
    ['ios-xe', ''],
    ['ios-xe', 'show ' + 'a'.repeat(200)],
    ['linux-host', 'show version'],
    ['', 'show version'],
  ])('%s: %j', (platform, command) => {
    expect(ok(platform, command)).toBe(false);
  });
});

it('says why, in words', () => {
  expect(readOnlyVerdict('ios-xe', 'show run | redirect flash:x')).toEqual({ ok: false, why: '“| redirect” is not a display filter Fathom sends (begin, exclude, include).' });
  expect(readOnlyVerdict('ios-xe', 'reload')).toMatchObject({ why: expect.stringContaining('“reload” is not on the read-only list') });
});

it('maps platforms to their CLI, and offers nothing for the rest', () => {
  expect(['junos-ex', 'junos-srx', 'junos-mx', 'ios-xe', 'nx-os', 'eos', 'opnsense', 'linux-host'].map(familyOf)).toEqual(['junos', 'junos', 'junos', 'ios-xe', 'nx-os', 'eos', null, null]);
});
