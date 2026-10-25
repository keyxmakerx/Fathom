import { describe, expect, it } from 'vitest';

import { parseExplainers } from './learn';

const bytesOf = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

const wire = {
  id: 'explain:concept:arista.eos-basics',
  class: 'concept',
  title: 'EOS',
  subject: 'arista.eos-basics',
  platforms: ['eos'],
  tab: 'read this first',
  terse: 'Short.',
  explained: 'Longer.',
  teaching: null,
  breaks_if_wrong: null,
  reviewed_on: '2026-09-19',
  reviewed: false,
  sources: [{ publisher: 'Arista', doc: 'EOS manual', url: 'https://www.arista.com/', read_on: '2026-09-19', note: null }],
};

describe('parseExplainers', () => {
  it('reads every field', () => {
    const [e] = parseExplainers(bytesOf([wire]));
    expect(e).toMatchObject({ id: wire.id, kind: 'concept', platforms: ['eos'], reviewed: false, reviewedOn: '2026-09-19' });
    expect(e!.sources[0]).toEqual({ publisher: 'Arista', doc: 'EOS manual', url: 'https://www.arista.com/', readOn: '2026-09-19', note: null });
  });

  it('refuses a body that is not a list', () => {
    expect(() => parseExplainers(bytesOf({}))).toThrow(/malformed explainers/);
  });

  it('refuses an entry without the reviewed flag', () => {
    const { reviewed: _, ...rest } = wire;
    expect(() => parseExplainers(bytesOf([rest]))).toThrow(/reviewed/);
  });
});
