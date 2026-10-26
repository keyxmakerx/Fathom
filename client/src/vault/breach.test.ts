import { afterEach, describe, expect, it } from 'vitest';

import type { BreachPolicy, VaultEntry } from '../api/vault';
import { checkDue, countIn, effectivePolicy, setFetchRange, sha1Hex, timesBreached } from './breach';

const on = (days: number, action: 'warn' | 'refuse' = 'warn') => ({ enabled: true, intervalDays: days, action });

describe('the breach policy, most specific first (mirrors vault_breach::effective)', () => {
  const policy: BreachPolicy = { organisation: on(30), kinds: { snmp: { enabled: false, intervalDays: 30, action: 'warn' } } };
  it('critical beats everything', () => {
    expect(effectivePolicy(policy, 'snmp', true)).toEqual({ level: on(7, 'refuse'), from: 'critical' });
  });
  it('then the kind, then the organisation, then off', () => {
    expect(effectivePolicy(policy, 'snmp', false).from).toBe('kind');
    expect(effectivePolicy(policy, 'login', false)).toEqual({ level: on(30), from: 'organisation' });
    expect(effectivePolicy({ organisation: null, kinds: {} }, 'login', false).from).toBe('off');
  });
  it('a check is due when never made at this epoch, or older than the interval', () => {
    const entry = { kind: 'login', critical: false, breach: null } as unknown as VaultEntry;
    const now = Date.UTC(2026, 9, 25);
    expect(checkDue(entry, policy, now)).toBe(true);
    expect(checkDue({ ...entry, breach: { found: false, checkedAt: now - 29 * 86_400_000 } }, policy, now)).toBe(false);
    expect(checkDue({ ...entry, breach: { found: false, checkedAt: now - 30 * 86_400_000 } }, policy, now)).toBe(true);
    expect(checkDue({ ...entry, kind: 'snmp' }, policy, now)).toBe(false);
  });
});

describe('the range check', () => {
  afterEach(() => setFetchRange(() => Promise.reject(new Error('no network in tests'))));

  it('hashes with SHA-1, upper-case hex, as the range API lists it', async () => {
    expect(await sha1Hex('password')).toBe('5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8');
  });

  it('reads the count for the suffix and ignores padding', () => {
    const range = '1E4C9B93F3F0682250B6CF8331B7EE68FD8:9659365\r\n0018A45C4D1DEF81644B54AB7F969B88D65:0\r\n';
    expect(countIn(range, '1E4C9B93F3F0682250B6CF8331B7EE68FD8')).toBe(9659365);
    expect(countIn(range, '0018A45C4D1DEF81644B54AB7F969B88D65')).toBe(0);
    expect(countIn(range, 'FFFFF')).toBe(0);
  });

  it('sends only the five-character prefix, once per prefix, and never more than four at a time', async () => {
    const asked: string[] = [];
    let now = 0;
    let most = 0;
    setFetchRange(async (prefix) => {
      asked.push(prefix);
      now += 1;
      most = Math.max(most, now);
      await new Promise((r) => setTimeout(r, 5));
      now -= 1;
      return prefix === '5BAA6' ? '1E4C9B93F3F0682250B6CF8331B7EE68FD8:3\n' : '';
    });
    const words = ['password', 'password', ...Array.from({ length: 9 }, (_, i) => `x-${i}-unlikely`)];
    const counts = await Promise.all(words.map(timesBreached));
    expect(counts[0]).toBe(3);
    expect(counts[1]).toBe(3);
    expect(asked.every((p) => /^[0-9A-F]{5}$/.test(p))).toBe(true);
    expect(asked.filter((p) => p === '5BAA6')).toHaveLength(1);
    expect(most).toBeLessThanOrEqual(4);
  });
});
