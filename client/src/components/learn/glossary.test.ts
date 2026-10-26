import { describe, expect, it } from 'vitest';

import { GLOSSARY, glossPieces } from './glossary';

const words = (text: string): string[] => glossPieces(text).flatMap((p) => (typeof p === 'string' ? [] : [`${p.text}=${p.entry.term}`]));

describe('glossPieces', () => {
  it("marks the words the diary's trace cards used", () => {
    expect(words('The longest matching prefix wins; a tie goes to the lower preference.')).toEqual(['prefix=prefix', 'preference=preference']);
    expect(words('A switch carries a frame to the other ports in its VLAN.')).toEqual(['frame=frame', 'VLAN=vlan']);
    expect(words('out on port2.0')).toEqual(['port2.0=unit']);
    expect(words('out on ge-0/0/1.0')).toEqual(['ge-0/0/1.0=unit']);
    expect(words('learned routes are not in the design')).toEqual(['learned routes=learned routes']);
  });

  it('takes plurals and the longest term, once each', () => {
    expect(words('Two VLANs, one trunk carrying both VLANs, and an access port.')).toEqual(['VLANs=vlan', 'trunk=trunk', 'access port=access port']);
    expect(words('A cable joins them into one broadcast domain.')).toEqual(['broadcast domain=broadcast domain']);
  });

  it('leaves addresses and words inside other words alone', () => {
    expect(words('192.168.10.10 holds a prefixed name and a subnetwork')).toEqual([]);
  });

  it('gives back the text unchanged around the marks', () => {
    const text = 'The longest matching prefix wins; out on port2.0.';
    expect(glossPieces(text).map((p) => (typeof p === 'string' ? p : p.text)).join('')).toBe(text);
  });

  it('defines every word in one plain line or two', () => {
    for (const e of GLOSSARY) expect(e.definition.length).toBeLessThan(320);
  });
});

const explainerFiles = import.meta.glob('../../../../corpus/explainers/*.yaml', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;
const explainerIds = new Set(Object.values(explainerFiles).flatMap((text) => [...text.matchAll(/^- id: (\S+)$/gm)].map((m) => m[1])));

describe('Learn more from the glossary', () => {
  it('names only explainers that exist, and the basics words have one', () => {
    for (const e of GLOSSARY) if (e.explainer !== undefined) expect(explainerIds, e.term).toContain(e.explainer);
    for (const term of ['vlan', 'trunk', 'access port', 'zone']) expect(GLOSSARY.find((e) => e.term === term)?.explainer, term).toBeDefined();
  });
});
