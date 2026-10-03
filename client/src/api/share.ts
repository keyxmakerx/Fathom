// Sharing a scope with people already in the organisation (round 9 bundle 2).
// Wire shapes are `design_api.rs`'s "Sharing a scope" routes. The grant is signed
// here, with this browser's enrolled key: the server fixes the bytes first and
// re-derives every field of them when the signature comes back.

import { concatBytes, fromHex, lp, toHex, u32LE, u64LE, utf8 } from '../crypto/bytes';
import { getEnrolledKeyPair, signMessage } from '../crypto/keys';
import { getSession } from '../state/sessionState';
import { keySlot } from './constants';
import { signedFetch } from './signedFetch';

/** What a person can do at a scope. `steward` is shown, never handed out. */
export type Standing = 'steward' | 'draw' | 'read' | null;
/** What the Share panel can set: View, Draw, or nothing of its own. */
export type ShareChoice = 'read' | 'draw' | 'none';

export interface AccessPerson {
  account: string;
  email: string;
  name: string;
  you: boolean;
  standing: Standing;
  /** The standing comes from a grant above this scope; changing it here would not change it. */
  inherited: boolean;
  /** Live View/Draw grants made exactly here. */
  direct: { grant: string; capability: 'read' | 'draw' }[];
}

/** This browser does not hold the signing key the grant needs. */
export class NoSigningKeyHere extends Error {
  constructor() {
    super('Sharing needs the browser you set up your signing key in.');
    this.name = 'NoSigningKeyHere';
  }
}

const base = (organisation: string, scope: string) =>
  `/organisations/${encodeURIComponent(organisation)}/scopes/${encodeURIComponent(scope)}`;

function parseJson(bytes: Uint8Array, what: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>;
  } catch {
    // falls through to the one error below
  }
  throw new Error(`malformed ${what} response`);
}

const standingOf = (value: unknown): Standing =>
  value === 'steward' || value === 'draw' || value === 'read' ? value : null;

export function parseAccess(bytes: Uint8Array): AccessPerson[] {
  const people = parseJson(bytes, 'access').people;
  if (!Array.isArray(people)) throw new Error('malformed access response');
  return people.map((entry: unknown, i): AccessPerson => {
    const p = (entry ?? {}) as Record<string, unknown>;
    if (typeof p.account !== 'string' || typeof p.email !== 'string' || typeof p.name !== 'string') {
      throw new Error(`malformed access response: person ${i}`);
    }
    const direct = Array.isArray(p.direct) ? p.direct : [];
    return {
      account: p.account,
      email: p.email,
      name: p.name,
      you: p.you === true,
      standing: standingOf(p.capability),
      inherited: p.inherited === true,
      direct: direct.flatMap((g: unknown) => {
        const row = (g ?? {}) as Record<string, unknown>;
        return typeof row.grant === 'string' && (row.capability === 'read' || row.capability === 'draw')
          ? [{ grant: row.grant, capability: row.capability }]
          : [];
      }),
    };
  });
}

export async function fetchAccess(organisation: string, scope: string): Promise<AccessPerson[]> {
  return parseAccess(await signedFetch('GET', `${base(organisation, scope)}/access`));
}

async function signingKey(): Promise<CryptoKey> {
  const session = getSession();
  const pair = session ? await getEnrolledKeyPair(keySlot(session.kind, session.address)) : null;
  if (!pair) throw new NoSigningKeyHere();
  return pair.privateKey;
}

function text(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  throw new Error(`malformed proposal: no ${key}`);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** `authority::grant_bytes` for a View/Draw grant, built here from what the
 * steward chose, so the key never signs bytes the server merely asserts. */
export function shareGrantBytes(f: {
  organisation: string;
  rootPubkeyFpr: Uint8Array;
  scope: string;
  subject: string;
  subjectKeyFpr: Uint8Array;
  capability: 'read' | 'draw';
  granter: string;
  granterKeyFpr: Uint8Array;
  effectiveFromUnix: number;
  authEpoch: number;
}): Uint8Array {
  return concatBytes(
    lp(utf8('fathom/grant/v2')),
    lp(utf8(f.organisation)),
    lp(f.rootPubkeyFpr),
    lp(utf8(f.scope)),
    lp(utf8(f.subject)),
    lp(f.subjectKeyFpr),
    lp(utf8(f.capability)),
    lp(utf8(f.granter)),
    lp(f.granterKeyFpr),
    u64LE(f.effectiveFromUnix),
    u64LE(0), // expires: never
    u32LE(0), // sole-steward appointment: no
    u32LE(f.authEpoch),
  );
}

/** Give `person` View (`read`) or Draw at the scope: propose, sign, send. The
 * bytes signed are rebuilt here from the steward's own choice; a proposal whose
 * bytes differ is refused. */
export async function shareWith(
  organisation: string,
  scope: string,
  person: string,
  capability: 'read' | 'draw',
): Promise<void> {
  const key = await signingKey();
  const granter = getSession()?.accountId;
  if (!granter) throw new NoSigningKeyHere();
  const proposal = parseJson(
    await signedFetch('POST', `${base(organisation, scope)}/grants/propose`, concatBytes(lp(utf8(person)), lp(utf8(capability)))),
    'proposal',
  );
  const effectiveFromUnix = Number(text(proposal, 'effective_from_unix'));
  const authEpoch = Number(text(proposal, 'auth_epoch'));
  const local = shareGrantBytes({
    organisation,
    rootPubkeyFpr: fromHex(text(proposal, 'root_pubkey_fpr')),
    scope,
    subject: person,
    subjectKeyFpr: fromHex(text(proposal, 'subject_key_fpr')),
    capability,
    granter,
    granterKeyFpr: fromHex(text(proposal, 'granter_key_fpr')),
    effectiveFromUnix,
    authEpoch,
  });
  if (!Number.isSafeInteger(effectiveFromUnix) || !Number.isSafeInteger(authEpoch) || !sameBytes(local, fromHex(text(proposal, 'bytes')))) {
    throw new Error('The server proposed a grant that is not the one you chose, so it was not signed.');
  }
  const signature = await signMessage(key, local);
  await signedFetch(
    'POST',
    `${base(organisation, scope)}/grants/sign`,
    concatBytes(
      lp(utf8(person)),
      lp(utf8(capability)),
      lp(utf8(String(effectiveFromUnix))),
      lp(utf8(String(authEpoch))),
      ...['granter_key_fpr', 'subject_key_fpr', 'root_pubkey_fpr'].map((f) => lp(utf8(text(proposal, f)))),
      lp(utf8(toHex(signature))),
    ),
  );
}

/** Take back one View/Draw grant made at this scope. The bytes to sign must be a
 * revocation of this grant, in this organisation, at the time being sent. */
export async function stopSharing(organisation: string, scope: string, grant: string): Promise<void> {
  const key = await signingKey();
  const path = `${base(organisation, scope)}/grants/${encodeURIComponent(grant)}/revoke`;
  const prepared = parseJson(await signedFetch('GET', path), 'revoke');
  const at = Number(text(prepared, 'at'));
  const bytes = fromHex(text(prepared, 'bytes'));
  const head = concatBytes(lp(utf8('fathom/grant/revoke/v1')), lp(utf8(organisation)), lp(utf8(grant)));
  const tail = u64LE(at);
  if (
    !Number.isSafeInteger(at) ||
    bytes.length < head.length + tail.length ||
    !sameBytes(bytes.subarray(0, head.length), head) ||
    !sameBytes(bytes.subarray(bytes.length - tail.length), tail)
  ) {
    throw new Error('The server asked for a signature on something other than this revocation, so it was not signed.');
  }
  const signature = await signMessage(key, bytes);
  await signedFetch('POST', path, concatBytes(lp(utf8(String(at))), lp(utf8(toHex(signature)))));
}

/** Make `person`'s own grants here exactly `choice`: drop the ones that differ, add the missing one. */
export async function setShare(organisation: string, scope: string, person: AccessPerson, choice: ShareChoice): Promise<void> {
  for (const g of person.direct) {
    if (g.capability !== choice) await stopSharing(organisation, scope, g.grant);
  }
  if (choice !== 'none' && !person.direct.some((g) => g.capability === choice)) {
    await shareWith(organisation, scope, person.account, choice);
  }
}
