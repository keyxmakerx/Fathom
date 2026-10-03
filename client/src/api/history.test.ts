import { describe, expect, it } from 'vitest';

import { parseHistory, parseVerify, verifyWords } from './history';

const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

describe('verify wording', () => {
  it('says each outcome in words', () => {
    expect(verifyWords(parseVerify(bytes({ outcome: 'verified', entries: 4 })))).toBe('Checked: every save is intact');
    expect(verifyWords(parseVerify(bytes({ outcome: 'broken_at', seq: 3, design_version: 5 })))).toBe('Broken at save 5');
    expect(verifyWords(parseVerify(bytes({ outcome: 'broken_at', seq: 3, design_version: null })))).toBe('Broken at save 3');
    expect(verifyWords(parseVerify(bytes({ outcome: 'cannot_verify_under_key_epoch', epochs: [1], ranges: [] })))).toBe(
      "Can't be checked under an old key",
    );
  });

  it('refuses an outcome it does not know', () => {
    expect(() => parseVerify(bytes({ outcome: 'fine' }))).toThrow();
  });
});

describe('parseHistory', () => {
  it('reads when and who', () => {
    const [e] = parseHistory(bytes([{ seq: 1, entry_type: 'create', chain_key_epoch: 1, design_version: 1, at_unix: 1_700_000_000, actor: 'ACC' }]));
    expect(e).toMatchObject({ seq: 1, designVersion: 1, atUnix: 1_700_000_000, actor: 'ACC' });
  });

  it('reads an unknown actor as null and refuses a row with no time', () => {
    const [e] = parseHistory(bytes([{ seq: 1, design_version: 1, at_unix: 5, actor: null }]));
    expect(e!.actor).toBeNull();
    expect(() => parseHistory(bytes([{ seq: 1, design_version: 1 }]))).toThrow();
  });
});
