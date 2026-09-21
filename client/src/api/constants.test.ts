import { describe, expect, it } from 'vitest';

import { identityOfSlot, keySlot, looksLikeOperatorId, OPERATOR_PENDING_SLOT } from './constants';

describe('key slots (constants.ts)', () => {
  it('files an account under its address and an operator under operator:<id>, and reads both back', () => {
    expect(keySlot('steward', 'jo@example.com')).toBe('jo@example.com');
    expect(keySlot('operator', '01JXOPERATORIDEXAMPLE00001')).toBe('operator:01JXOPERATORIDEXAMPLE00001');
    expect(identityOfSlot('jo@example.com')).toEqual({ kind: 'steward', id: 'jo@example.com' });
    expect(identityOfSlot('operator:01JXOPERATORIDEXAMPLE00001')).toEqual({
      kind: 'operator',
      id: '01JXOPERATORIDEXAMPLE00001',
    });
    expect(identityOfSlot(OPERATOR_PENDING_SLOT)).toEqual({ kind: 'operator', id: '?' });
  });

  it('tells an operator id (a ULID) from anything an address can be', () => {
    // Real ids from a first start (Crockford base32: no I, L, O or U).
    expect(looksLikeOperatorId('01M30P8VGB33Q8ZMNAV9XS72S5')).toBe(true);
    expect(looksLikeOperatorId('01m30pkvzw94kaxss4nb7tg29k')).toBe(true);
    expect(looksLikeOperatorId('jo@example.com')).toBe(false);
    expect(looksLikeOperatorId('01M30P8VGB33Q8ZMNAV9XS72S')).toBe(false); // 25
    expect(looksLikeOperatorId('01M30P8VGB33Q8ZMNAV9XS72IL')).toBe(false); // I and L are not Crockford
  });
});
