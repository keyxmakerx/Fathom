import { describe, expect, it } from 'vitest';

import { inPortOrder } from './portOrder';

const p = (label: string, face = 'front') => ({ label, face });

describe('ports in reading order', () => {
  it('is natural, so 2 comes before 10', () => {
    expect(inPortOrder([p('ge-0/0/10'), p('ge-0/0/2'), p('ge-0/0/1')]).map((x) => x.label)).toEqual(['ge-0/0/1', 'ge-0/0/2', 'ge-0/0/10']);
  });
  it('keeps a patch panel hole\'s front and rear together, front first', () => {
    const out = inPortOrder([p('2', 'rear'), p('1', 'rear'), p('2', 'front'), p('1', 'front'), p('10', 'front')]);
    expect(out.map((x) => `${x.label}${x.face[0]}`)).toEqual(['1f', '1r', '2f', '2r', '10f']);
  });
});
