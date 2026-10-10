// The vectors are the ones in crates/fathom-rules/src/version.rs's tests: the page and the check
// must agree on which device is behind.
import { describe, expect, it } from 'vitest';

import { versionOlder } from './firmwareVersion';

const older = (platform: string) => (a: string, b: string) => versionOlder(platform, a, b);

describe('versionOlder matches the check', () => {
  it('junos orders releases, services and spins', () => {
    const o = older('junos-srx');
    expect(o('21.4R3-S5', '21.4R3-S6')).toBe(true);
    expect(o('21.4R3-S5', '21.4R3-S5')).toBe(false);
    expect(o('21.4R3', '21.4R3-S1')).toBe(true);
    expect(o('21.4R3-S1', '21.4R4')).toBe(true);
    expect(o('23.4R2-S3.9', '23.4R2-S3.10')).toBe(true);
    expect(o('23.4R2-S3.9', '23.4R2-S4')).toBe(true);
    expect(o('22.2R1', '21.4R9-S9')).toBe(false);
    expect(o('9.4R1', '10.0R1')).toBe(true);
    expect(o('24.2R1.13', '24.2R1.14')).toBe(true);
    expect(o('21.1R3-EVO', '21.1R4-EVO')).toBe(true);
    expect(o('21.1R3-EVO', '21.1R4')).toBeNull();
  });

  it('junos forms nobody could source are null', () => {
    const o = older('junos-ex');
    expect(o('20.4X53-D10', '20.4X53-D20')).toBeNull();
    expect(o('15.1F6-S10', '15.1F6-S11')).toBeNull();
    expect(o('21.4R3-S5.1.2', '21.4R4')).toBeNull();
    expect(o('21.4R3.1-S5', '21.4R4')).toBeNull();
    expect(o('', '21.4R4')).toBeNull();
    expect(o('junos', '21.4R4')).toBeNull();
    expect(o('21.4R-S5', '21.4R4')).toBeNull();
  });

  it('ios-xe orders numbers and leaves letters alone', () => {
    const o = older('ios-xe');
    expect(o('16.12.10', '17.9.4a')).toBe(true);
    expect(o('17.9.4a', '17.9.5')).toBe(true);
    expect(o('17.9.10', '17.9.9')).toBe(false);
    expect(o('17.9.4a', '17.9.4a')).toBe(false);
    expect(o('17.9.4', '17.9.4a')).toBeNull();
    expect(o('3.16.2S', '17.9.4')).toBeNull();
    expect(o('17.9', '17.9.4')).toBeNull();
  });

  it('nx-os orders train and sequence', () => {
    const o = older('nx-os');
    expect(o('9.3(10)', '10.3(4a)')).toBe(true);
    expect(o('10.3(4a)', '10.4(1)F')).toBe(true);
    expect(o('10.3(4a)M', '10.3(5)M')).toBe(true);
    expect(o('9.3(9)', '9.3(10)')).toBe(true);
    expect(o('10.4(1)F', '10.3(4a)')).toBe(false);
    expect(o('10.3(4a)', '10.3(4a)')).toBe(false);
    expect(o('10.3(4)', '10.3(4a)')).toBeNull();
    expect(o('10.3(4a)M', '10.3(4a)')).toBeNull();
    expect(o('7.0(3)I7(4)', '10.3(4a)')).toBeNull();
    expect(o('10.3', '10.4(1)F')).toBeNull();
  });

  it('eos reads up to four numbers', () => {
    const o = older('eos');
    expect(o('4.30.2F', '4.31.1.1M')).toBe(true);
    expect(o('4.31.1.1M', '4.31.1.2M')).toBe(true);
    expect(o('4.30.2F', '4.30.2.1F')).toBe(true);
    expect(o('4.31.1.1M', '4.30.9F')).toBe(false);
    expect(o('4.30.2F', '4.30.2F')).toBe(false);
    expect(o('4.30.2F', '4.30.2M')).toBeNull();
    expect(o('4.17.1.1FX-MDP', '4.30.2F')).toBeNull();
    expect(o('4.30F', '4.30.2F')).toBeNull();
  });

  it('an unknown platform or an empty version is null', () => {
    expect(versionOlder('panos', '10.1.1', '10.2.0')).toBeNull();
    expect(versionOlder('', '1.0.0', '2.0.0')).toBeNull();
    expect(versionOlder('eos', '4.30.2F', '')).toBeNull();
  });
});
