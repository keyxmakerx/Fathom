// People: `GET /organisations/{org}/people`, removing access, and seconding a
// steward grant. Stewards only: the server refuses anyone else before it reads
// a row, and names and emails are in the answer for no one else.

import { concatBytes, fromHex, lp, toHex, utf8 } from '../crypto/bytes';
import { signMessage } from '../crypto/keys';
import { getSession } from '../state/sessionState';
import { grantBytes, keyCode, secondBytes } from './grantBytes';
import { arrayOf, asRec, bool, int, jsonObject, oneOf, optInt, optStr, sameBytes, str } from './json';
import type { Asked, SecondingItem } from './invitations';
import { NoSigningKeyHere, signingKey, stopSharing } from './share';
import { signedFetch } from './signedFetch';

export type PersonState = 'active' | 'invited' | 'waiting';

export interface AccessRow {
  /** `null` is the whole organisation. */
  scopeId: string | null;
  label: string;
  capability: Asked;
  grant: string;
  /** Held through a folder above this one. */
  inherited: boolean;
  genesis: boolean;
  /** Only a grant made exactly here, not an inherited or founding one, can be removed. */
  revocable: boolean;
  effectiveFromUnix: number;
  expiresAtUnix: number | null;
  /** 86400 for a steward someone else removes; 0 for anything else. */
  revokeTakesEffectInSeconds: number;
  revokingAtUnix: number | null;
  awaitingSecond: boolean;
  suspended: boolean;
}

export interface Person {
  account: string;
  name: string;
  email: string | null;
  you: boolean;
  state: PersonState;
  invitation: string | null;
  asked: { capability: Asked; scopeId: string | null; scopeLabel: string } | null;
  expired: boolean;
  access: AccessRow[];
}

export interface People {
  waitingCount: number;
  people: Person[];
}

const CAPS = ['read', 'draw', 'steward'] as const;

export function parsePeople(bytes: Uint8Array): People {
  const r = jsonObject(bytes, 'people');
  return {
    waitingCount: int(r, 'waiting_count', 'people'),
    people: arrayOf(r, 'people', 'people').map((entry, i): Person => {
      const what = `person ${i}`;
      const p = asRec(entry, what);
      const asked = p.asked === null || p.asked === undefined ? null : asRec(p.asked, what);
      return {
        account: str(p, 'account', what),
        name: str(p, 'name', what),
        email: optStr(p, 'email', what),
        you: bool(p, 'you', what),
        state: oneOf(p, 'state', ['active', 'invited', 'waiting'] as const, what),
        invitation: optStr(p, 'invitation', what),
        asked: asked && {
          capability: oneOf(asked, 'capability', CAPS, what),
          scopeId: optStr(asked, 'scope_id', what),
          scopeLabel: str(asked, 'scope_label', what),
        },
        expired: bool(p, 'expired', what),
        access: arrayOf(p, 'access', what).map((row, j): AccessRow => {
          const w = `${what} access ${j}`;
          const a = asRec(row, w);
          return {
            scopeId: optStr(a, 'scope_id', w),
            label: str(a, 'label', w),
            capability: oneOf(a, 'capability', CAPS, w),
            grant: str(a, 'grant', w),
            inherited: bool(a, 'inherited', w),
            genesis: bool(a, 'genesis', w),
            revocable: bool(a, 'revocable', w),
            effectiveFromUnix: int(a, 'effective_from_unix', w),
            expiresAtUnix: optInt(a, 'expires_at_unix', w),
            revokeTakesEffectInSeconds: int(a, 'revoke_takes_effect_in_seconds', w),
            revokingAtUnix: optInt(a, 'revoking_at_unix', w),
            // Not in the first contract: absent reads as no.
            awaitingSecond: a.awaiting_second === true,
            suspended: a.suspended === true,
          };
        }),
      };
    }),
  };
}

export async function fetchPeople(organisation: string): Promise<People> {
  return parsePeople(await signedFetch('GET', `/organisations/${encodeURIComponent(organisation)}/people`));
}

/** Take away one access row. Only a grant made at a folder can be removed here;
 * the server refuses the rest, and `revocable` already says so. */
export async function removeAccess(organisation: string, row: AccessRow): Promise<{ takesEffectAtUnix: number | null; delayed: boolean }> {
  if (row.scopeId === null) {
    throw new Error('Access given to the whole organisation cannot be removed from this screen yet.');
  }
  return stopSharing(organisation, row.scopeId, row.grant);
}

// ---- Seconding --------------------------------------------------------

const secondPath = (organisation: string, scope: string | null, grant: string) =>
  `/organisations/${encodeURIComponent(organisation)}${scope === null ? '' : `/scopes/${encodeURIComponent(scope)}`}` +
  `/grants/${encodeURIComponent(grant)}/second`;

/**
 * Second a steward grant, as the server described it in the Waiting list. The
 * grant bytes and the seconding bytes are rebuilt here; nothing is signed unless
 * both match the server's and the grant is the one on screen: same person, same
 * key code, same folder, same expiry, and a steward grant.
 */
export async function secondSteward(organisation: string, item: SecondingItem): Promise<void> {
  const refuse = (why: string): never => {
    throw new Error(`The server described a different grant from the one you were shown (${why}), so nothing was signed.`);
  };
  const key = await signingKey();
  const me = getSession()?.accountId;
  if (!me) throw new NoSigningKeyHere();
  const path = secondPath(organisation, item.scopeId, item.grant);
  const v = jsonObject(await signedFetch('GET', path), 'seconding');
  const subjectKeyFpr = fromHex(str(v, 'subject_key_fpr', 'seconding'));
  const granterKeyFpr = fromHex(str(v, 'granter_key_fpr', 'seconding'));
  const granter = str(v, 'granter', 'seconding');
  if (str(v, 'grant', 'seconding') !== item.grant) refuse('another grant');
  if (str(v, 'organisation', 'seconding') !== organisation) refuse('another organisation');
  if (optStr(v, 'scope_id', 'seconding') !== item.scopeId) refuse('another folder');
  if (str(v, 'subject', 'seconding') !== item.subject) refuse('another person');
  if (str(v, 'capability', 'seconding') !== 'steward') refuse('not a steward grant');
  if (keyCode(subjectKeyFpr) !== item.keyCode || str(v, 'key_code', 'seconding') !== item.keyCode) refuse('another key');
  if (int(v, 'expires_at_unix', 'seconding') !== item.expiresAtUnix) refuse('another expiry');
  if (int(v, 'effective_from_unix', 'seconding') !== item.effectiveFromUnix) refuse('another start time');
  if (granter === me) refuse('you made this grant yourself');
  if (item.granter !== null && granter !== item.granter) refuse('another granter');
  const local = grantBytes({
    organisation,
    rootPubkeyFpr: fromHex(str(v, 'root_pubkey_fpr', 'seconding')),
    scope: item.scopeId ?? '',
    subject: item.subject,
    subjectKeyFpr,
    capability: 'steward',
    granter,
    granterKeyFpr,
    effectiveFromUnix: item.effectiveFromUnix,
    expiresAtUnix: item.expiresAtUnix,
    soleSteward: bool(v, 'sole_steward_appointment', 'seconding'),
    authEpoch: int(v, 'auth_epoch', 'seconding'),
  });
  if (!sameBytes(local, fromHex(str(v, 'grant_bytes', 'seconding')))) refuse('grant bytes that differ');
  const second = await secondBytes(local, granterKeyFpr);
  if (!sameBytes(second, fromHex(str(v, 'second_bytes', 'seconding')))) refuse('different bytes to sign');
  const signature = await signMessage(key, second);
  await signedFetch('POST', path, concatBytes(lp(utf8(toHex(signature)))));
}
