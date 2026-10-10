import { describe, expect, it } from 'vitest';
import { expandPortPattern, previewLabels } from './portPattern';

const labels = (p: string) => {
  const r = expandPortPattern(p);
  if (!r.ok) throw new Error(r.reason);
  return r.labels;
};
const reason = (p: string) => {
  const r = expandPortPattern(p);
  if (r.ok) throw new Error(`expected a refusal for ${p}`);
  return r.reason;
};

describe('expandPortPattern', () => {
  it('reads the mockup pattern as 24 ports', () => {
    const l = labels('ge-0/0/{0-23}');
    expect(l).toHaveLength(24);
    expect(l[0]).toBe('ge-0/0/0');
    expect(l[23]).toBe('ge-0/0/23');
    expect(previewLabels(l)).toBe('ge-0/0/0 · ge-0/0/1 · ge-0/0/2 · … · ge-0/0/23');
  });

  it('takes plain text as one port', () => {
    expect(labels(' eth0 ')).toEqual(['eth0']);
  });

  it('keeps zero padding and lists words', () => {
    expect(labels('port{08-10}')).toEqual(['port08', 'port09', 'port10']);
    expect(labels('{wan,lan, dmz}')).toEqual(['wan', 'lan', 'dmz']);
  });

  it('multiplies several braces in order', () => {
    expect(labels('ge-{0-1}/0/{0-1}')).toEqual(['ge-0/0/0', 'ge-0/0/1', 'ge-1/0/0', 'ge-1/0/1']);
  });

  it('refuses what it cannot read, saying why', () => {
    expect(reason('')).toMatch(/Type/);
    expect(reason('ge-0/0/{23-0}')).toMatch(/smaller number first/);
    expect(reason('ge-0/0/{0-23')).toMatch(/not closed/);
    expect(reason('ge}')).toMatch(/no \{/);
    expect(reason('x{abc}')).toMatch(/not a range/);
    expect(reason('{0-99}/{0-9}')).toMatch(/1000 ports/);
    expect(reason('{a,a}')).toMatch(/twice/);
  });
});
