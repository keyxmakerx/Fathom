// ADR-0057 decision 8: repeats `u32le`/`lpField`/`lpBytes` rather than
// importing `../crypto/bytes`, so this can't pass by construction. The
// layout is written out by hand from `crates/fathom-server/src/api.rs`.
import { describe, expect, it } from 'vitest';

import { buildCodeBody, buildEndSessionBody, parseSessionSummaries } from './sessions';

function u32le(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

function u64le(n: number): number[] {
  const out: number[] = [];
  let value = BigInt(n);
  for (let i = 0; i < 8; i += 1) {
    out.push(Number(value & 0xffn));
    value >>= 8n;
  }
  return out;
}

function lpField(text: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(text));
  return [...u32le(bytes.length), ...bytes];
}

function record(
  sessionId: string,
  browserLabel: string,
  addressClass: string,
  addressChanged: boolean,
  lastActiveUnix: number,
  issuedAtUnix: number,
  isCurrent: boolean,
): number[] {
  return [
    ...lpField(sessionId),
    ...lpField(browserLabel),
    ...lpField(addressClass),
    addressChanged ? 1 : 0,
    ...u64le(lastActiveUnix),
    ...u64le(issuedAtUnix),
    isCurrent ? 1 : 0,
  ];
}

describe('the session request bodies (api.rs, ADR-0057 decision 8)', () => {
  it('frames LP(session_id) || LP(code) for POST /sessions/end', () => {
    expect(Array.from(buildEndSessionBody('01JQZSESSION', '123456'))).toEqual([
      ...lpField('01JQZSESSION'),
      ...lpField('123456'),
    ]);
  });

  it('trims the code, exactly as the credential routes do', () => {
    expect(Array.from(buildEndSessionBody('01JQZSESSION', '  123456 '))).toEqual([
      ...lpField('01JQZSESSION'),
      ...lpField('123456'),
    ]);
  });

  it('frames LP(code) alone for POST /sessions/end-others', () => {
    expect(Array.from(buildCodeBody(' 654321 '))).toEqual([...lpField('654321')]);
  });
});

describe('parseSessionSummaries (GET /sessions)', () => {
  it('reads an empty list', () => {
    expect(parseSessionSummaries(Uint8Array.from(u32le(0)))).toEqual([]);
  });

  it('reads two records, one of them the current session', () => {
    const bytes = Uint8Array.from([
      ...u32le(2),
      ...record('01JQZAAA', 'Firefox on Linux', '203.0.113.9', false, 1_760_000_100, 1_760_000_000, true),
      ...record('01JQZBBB', 'Chrome on Windows', '198.51.100.4', true, 1_760_000_200, 1_760_000_050, false),
    ]);
    expect(parseSessionSummaries(bytes)).toEqual([
      {
        sessionId: '01JQZAAA',
        browserLabel: 'Firefox on Linux',
        addressClass: '203.0.113.9',
        addressChanged: false,
        lastActiveUnix: 1_760_000_100,
        issuedAtUnix: 1_760_000_000,
        isCurrent: true,
      },
      {
        sessionId: '01JQZBBB',
        browserLabel: 'Chrome on Windows',
        addressClass: '198.51.100.4',
        addressChanged: true,
        lastActiveUnix: 1_760_000_200,
        issuedAtUnix: 1_760_000_050,
        isCurrent: false,
      },
    ]);
  });

  it('reads an empty LP as null, for a session that predates the browser label or the address class', () => {
    const bytes = Uint8Array.from([
      ...u32le(1),
      ...record('01JQZOLD', '', '', false, 1_760_000_000, 1_760_000_000, false),
    ]);
    expect(parseSessionSummaries(bytes)).toEqual([
      {
        sessionId: '01JQZOLD',
        browserLabel: null,
        addressClass: null,
        addressChanged: false,
        lastActiveUnix: 1_760_000_000,
        issuedAtUnix: 1_760_000_000,
        isCurrent: false,
      },
    ]);
  });

  it('refuses trailing bytes after the declared count', () => {
    const bytes = Uint8Array.from([...u32le(0), 1, 2, 3]);
    expect(() => parseSessionSummaries(bytes)).toThrow(/trailing bytes/);
  });
});
