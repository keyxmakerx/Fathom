// ADR-0057 decision 8: "Signed-in browsers" (OWASP ASVS 5.0.0 7.5.2). Lists
// and ends this account's sessions; the admin surface (7.4.5) is not yet
// built in this client, so only these self-service routes are bound here.

import { concatBytes, lp, readLp, readU32LE, readU64LE, utf8 } from '../crypto/bytes';
import { signedFetch } from './signedFetch';

const decoder = new TextDecoder();

export interface SessionSummary {
  sessionId: string;
  /** "Firefox on Linux", or `null` for a session old enough to predate the
   * column (`browser_label::label` never answers an empty string). */
  browserLabel: string | null;
  /** The address class this session is bound to (ADR-0057 decision 7), or
   * `null` when sign-in could not class it. Never the raw address. */
  addressClass: string | null;
  /** Whether a later request's address stopped matching `addressClass`. */
  addressChanged: boolean;
  lastActiveUnix: number;
  issuedAtUnix: number;
  /** This is the session the request answering the list was itself signed
   * with. */
  isCurrent: boolean;
}

function readU8(bytes: Uint8Array): { value: number; rest: Uint8Array } {
  if (bytes.length < 1) {
    throw new Error('malformed response: truncated byte');
  }
  return { value: bytes[0], rest: bytes.slice(1) };
}

function textOrNull(bytes: Uint8Array): string | null {
  return bytes.length === 0 ? null : decoder.decode(bytes);
}

/** One [`SessionSummary`] record, and the rest of the message after it. */
function parseOne(bytes: Uint8Array): { value: SessionSummary; rest: Uint8Array } {
  const { value: sessionIdBytes, rest: r1 } = readLp(bytes);
  const { value: browserLabelBytes, rest: r2 } = readLp(r1);
  const { value: addressClassBytes, rest: r3 } = readLp(r2);
  const { value: addressChanged, rest: r4 } = readU8(r3);
  const lastActiveUnix = Number(readU64LE(r4));
  const r5 = r4.slice(8);
  const issuedAtUnix = Number(readU64LE(r5));
  const r6 = r5.slice(8);
  const { value: isCurrent, rest: r7 } = readU8(r6);
  return {
    value: {
      sessionId: decoder.decode(sessionIdBytes),
      browserLabel: textOrNull(browserLabelBytes),
      addressClass: textOrNull(addressClassBytes),
      addressChanged: addressChanged !== 0,
      lastActiveUnix,
      issuedAtUnix,
      isCurrent: isCurrent !== 0,
    },
    rest: r7,
  };
}

/** `u32(count)` then that many [`parseOne`] records, and nothing after. */
export function parseSessionSummaries(bytes: Uint8Array): SessionSummary[] {
  const count = readU32LE(bytes);
  let rest: Uint8Array = bytes.slice(4);
  const out: SessionSummary[] = [];
  for (let i = 0; i < count; i += 1) {
    const read = parseOne(rest);
    out.push(read.value);
    rest = read.rest;
  }
  if (rest.length !== 0) {
    throw new Error('malformed response: trailing bytes after the session list');
  }
  return out;
}

/** `GET /sessions` — this account's signed-in browsers, most recently
 * active first. */
export async function listSessions(): Promise<SessionSummary[]> {
  return parseSessionSummaries(await signedFetch('GET', '/sessions'));
}

/** `LP(session_id) ‖ LP(code)` — `POST /sessions/end`. */
export function buildEndSessionBody(sessionId: string, code: string): Uint8Array {
  return concatBytes(lp(utf8(sessionId)), lp(utf8(code.trim())));
}

/** `LP(code)` — `POST /sessions/end-others`. */
export function buildCodeBody(code: string): Uint8Array {
  return concatBytes(lp(utf8(code.trim())));
}

/** `POST /sessions/end` — end one of this account's OTHER sessions (ASVS
 * 5.0.0 7.5.2). Needs a current authenticator code; the current session
 * itself is refused here with no code checked, on purpose — sign out this
 * browser with `signOut` (`./auth.ts`) instead. */
export async function endSession(sessionId: string, code: string): Promise<void> {
  await signedFetch('POST', '/sessions/end', buildEndSessionBody(sessionId, code));
}

/** `POST /sessions/end-others` — "sign out all other browsers" (ASVS 5.0.0
 * 7.5.2). Needs a current authenticator code; this session is left alone. */
export async function endOtherSessions(code: string): Promise<void> {
  await signedFetch('POST', '/sessions/end-others', buildCodeBody(code));
}
