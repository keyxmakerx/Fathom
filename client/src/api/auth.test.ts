// `parseSignInAnswer`'s bytes below are built by hand, not with `lp`/`u64LE`
// from `../crypto/bytes` -- `enrolment.test.ts`'s own header names the
// reason this repeats: a test assembled from a module's own encoder and then
// checked against that same encoder's decoder would pass for any
// construction whatsoever, including a wrong one.
import { describe, expect, it } from 'vitest';

import { parseSignInAnswer } from './auth';

function u32le(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

function lpField(text: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(text));
  return [...u32le(bytes.length), ...bytes];
}

function u64le(n: number): number[] {
  const out = new Array(8).fill(0);
  let value = BigInt(n);
  for (let i = 0; i < 8; i += 1) {
    out[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return out;
}

describe('parseSignInAnswer (crates/fathom-server/src/api.rs sign_in_handler)', () => {
  it('reads LP(session_id) || LP(token) || u64(expires_at_unix) || LP(account_id), in that order', () => {
    const sessionId = '01JXSESSIONIDEXAMPLE00000A';
    const token = Array.from({ length: 32 }, (_, i) => i);
    const expiresAtUnix = 1_790_000_000;
    const accountId = '01JXACCOUNTIDEXAMPLE000001';

    const bytes = new Uint8Array([
      ...lpField(sessionId),
      ...u32le(token.length),
      ...token,
      ...u64le(expiresAtUnix),
      ...lpField(accountId),
    ]);

    const answer = parseSignInAnswer(bytes);
    expect(answer.sessionId).toBe(sessionId);
    expect(Array.from(answer.token)).toEqual(token);
    expect(answer.expiresAtUnix).toBe(expiresAtUnix);
    expect(answer.accountId).toBe(accountId);
  });

  it('ignores bytes after the fourth field -- additive per ADR-0053 §3, never refused as trailing', () => {
    const sessionId = 's';
    const token = new Array(32).fill(7);
    const accountId = '01JXACCOUNTIDEXAMPLE000002';

    const bytes = new Uint8Array([
      ...lpField(sessionId),
      ...u32le(token.length),
      ...token,
      ...u64le(1),
      ...lpField(accountId),
      0xde,
      0xad,
      0xbe,
      0xef,
    ]);

    expect(parseSignInAnswer(bytes).accountId).toBe(accountId);
  });

  it('throws on a truncated account id field rather than returning a partial answer', () => {
    const sessionId = 's';
    const token = new Array(32).fill(0);
    const bytes = new Uint8Array([
      ...lpField(sessionId),
      ...u32le(token.length),
      ...token,
      ...u64le(0),
      // A length prefix claiming 26 bytes with none following.
      ...u32le(26),
    ]);

    expect(() => parseSignInAnswer(bytes)).toThrow();
  });
});
