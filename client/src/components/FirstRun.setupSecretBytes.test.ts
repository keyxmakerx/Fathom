// What `setupSecretBytes` sends for what a person typed into step 1's field:
// its UTF-8 bytes, unmodified, every time, `op_` codes included. The client
// decides nothing about the shape; `credentials::parse_recovery_code` on the
// server is the one place that decides whether it is a recovery code.

import { describe, expect, it } from 'vitest';

import { formatToken } from '../api/enrolment';
import { utf8 } from '../crypto/bytes';
import { setupSecretBytes } from './FirstRun';

const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

describe('setupSecretBytes: exactly what was typed, as UTF-8, every time', () => {
  it.each([
    ['a plain passphrase', 'meadow-compass-ferry-eleven'],
    // `openssl rand -hex 32` -- the shape a network engineer reaches for.
    ['64 hex with no prefix', '3f9c2a7b1e4d8f60a5b3c9d2e1f7a8b4c6d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6'],
    // The same, with a hyphen in it (two UUIDs joined is the same shape).
    [
      'hyphenated hex',
      '3f9c2a7b-1e4d-8f60-a5b3-c9d2e1f7a8b4-c6d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6',
    ],
    // A `sha256sum` digest, upper case, with the spaces its own output has.
    [
      'upper-case hex with spaces',
      '3F9C2A7B 1E4D8F60 A5B3C9D2 E1F7A8B4 C6D0E9F8 A7B6C5D4 E3F2A1B0 C9D8E7F6',
    ],
    // `openssl rand -base64 24` -- docs/RUNNING-IT.md and .env.example's own
    // suggestion -- exactly 32 characters, not hex.
    ['base64, 32 characters', 'K9mQ2xVzL7pR4wN8jT6yB3hC1dF5sG0k'],
  ])('%s goes as typed, unmodified (%s)', (_label, typed) => {
    expect(same(setupSecretBytes(typed), utf8(typed))).toBe(true);
  });

  it('an op_ recovery code goes as typed too, not decoded -- round 2, item 5', () => {
    const raw = new Uint8Array(32);
    for (let i = 0; i < 32; i += 1) raw[i] = i;
    const typed = formatToken(raw, 'operator');
    expect(typed.startsWith('op_')).toBe(true);
    const sent = setupSecretBytes(typed);
    // The client decides nothing now: the bytes on the wire are the typed
    // string's own UTF-8 bytes, `op_` prefix and all -- never the 32 raw
    // bytes a client-side decode would have produced.
    expect(same(sent, utf8(typed))).toBe(true);
    expect(sent.length).toBe(typed.length);
  });

  it('the op3f9c… and OP-3f9c9… shapes the round-2 probes found also go as typed', () => {
    // No underscore -- `parseToken`'s own prefix is `(op|inv|org)_?`, the
    // underscore optional, so a client-side decode would have accepted this
    // as a token even though it is exactly the shape an installer's real
    // password could take.
    const noUnderscore = 'op3f9c2a7b1e4d8f60a5b3c9d2e1f7a8b4c6d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6';
    expect(same(setupSecretBytes(noUnderscore), utf8(noUnderscore))).toBe(true);

    // Upper case with a hyphen after `OP` -- `parseToken`'s noise filter
    // discards hyphens before the prefix is even read.
    const hyphenated = 'OP-3f9c2a7b1e4d8f60a5b3c9d2e1f7a8b4c6d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6';
    expect(same(setupSecretBytes(hyphenated), utf8(hyphenated))).toBe(true);
  });
});
