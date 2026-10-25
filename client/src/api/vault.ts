// The password vault's routes (`crates/fathom-server/src/design_api/vault_routes.rs`, ADR-0071).
// Every body is canonical JSON with bytes as lower-case hex. Nothing here seals or opens
// anything: `../vault/crypto.ts` does that, and only its output is ever sent.

import { fromHex, toHex } from '../crypto/bytes';
import { body } from './fieldDefinitions';
import { arrayOf, asRec, bool, int, jsonObject, optStr, str, type Rec } from './json';
import { signedFetch } from './signedFetch';

export const LOGIN_KINDS = ['login', 'snmp', 'wifi', 'api', 'other'] as const;
export type LoginKind = (typeof LOGIN_KINDS)[number];

export const KIND_LABELS: Record<LoginKind, string> = {
  login: 'Device login',
  snmp: 'SNMP',
  wifi: 'Wi-Fi',
  api: 'API key',
  other: 'Other',
};

export interface UsedOn {
  design: string;
  element: string;
}

export interface VaultKeyView {
  id: string;
  kind: 'person' | 'recovery';
  account: string | null;
  createdBy: string;
  publicKey: Uint8Array;
  fpr: Uint8Array;
  signerKeyFpr: Uint8Array;
  signerPublicKey: Uint8Array;
  enrolledAt: number;
  signature: Uint8Array;
  supersedes: { oldFpr: Uint8Array; at: number; signature: Uint8Array } | null;
  /** Present only on the caller's own key (and the recovery key, to an admin opening it). */
  own: {
    sealedPrivate: Uint8Array;
    sealedNonce: Uint8Array;
    kdfSalt: Uint8Array | null;
    kdfM: number | null;
    kdfT: number | null;
    kdfP: number | null;
  } | null;
}

export interface Holder {
  keyId: string;
  kind: 'person' | 'recovery';
  account: string | null;
  name: string;
  fpr: Uint8Array;
  digest: Uint8Array;
  revoked: boolean;
  /** The key was replaced since this copy was made: it needs re-sharing to the new one. */
  stale: boolean;
}

export interface Opening {
  keyId: string;
  wrap: Uint8Array;
  secretCt: Uint8Array;
  secretNonce: Uint8Array;
  sharer: string;
  sharerKeyFpr: Uint8Array;
  sharerPublicKey: Uint8Array;
  shareAt: number;
  signature: Uint8Array;
  viaRecovery: boolean;
}

export interface VaultEntry {
  id: string;
  name: string;
  kind: LoginKind;
  usedOn: UsedOn[];
  owner: string;
  ownerName: string;
  createdAt: number;
  updatedAt: number;
  updatedBy: string;
  version: number;
  epoch: number;
  needsRotation: boolean;
  holders: Holder[];
  /** The caller's own copy, when they hold one. */
  opening: Opening | null;
}

export interface VaultOverview {
  me: string;
  steward: boolean;
  myKey: VaultKeyView | null;
  recovery: VaultKeyView | null;
  /** Every time an admin opened the vault with the recovery sheet. Shown on the admin page. */
  recoveryUses: { by: string; byName: string; at: number }[];
  people: { account: string; name: string; key: VaultKeyView | null }[];
  entries: VaultEntry[];
}

const W = 'vault';
const hex = (r: Rec, k: string): Uint8Array => fromHex(str(r, k, W));
const optHex = (r: Rec, k: string): Uint8Array | null => {
  const v = optStr(r, k, W);
  return v === null ? null : fromHex(v);
};
const optNum = (r: Rec, k: string): number | null => (typeof r[k] === 'number' ? (r[k] as number) : null);

function keyView(raw: unknown): VaultKeyView {
  const r = asRec(raw, W);
  const kind = str(r, 'kind', W);
  if (kind !== 'person' && kind !== 'recovery') throw new Error('malformed vault response: key kind');
  const sup = r.supersedes == null ? null : asRec(r.supersedes, W);
  const own = r.own == null ? null : asRec(r.own, W);
  return {
    id: str(r, 'id', W),
    kind,
    account: optStr(r, 'account', W),
    createdBy: str(r, 'createdBy', W),
    publicKey: hex(r, 'publicKey'),
    fpr: hex(r, 'fpr'),
    signerKeyFpr: hex(r, 'signerKeyFpr'),
    signerPublicKey: hex(r, 'signerPublicKey'),
    enrolledAt: int(r, 'enrolledAt', W),
    signature: hex(r, 'signature'),
    supersedes: sup && { oldFpr: hex(sup, 'oldFpr'), at: int(sup, 'at', W), signature: hex(sup, 'signature') },
    own: own && {
      sealedPrivate: hex(own, 'sealedPrivate'),
      sealedNonce: hex(own, 'sealedNonce'),
      kdfSalt: optHex(own, 'kdfSalt'),
      kdfM: optNum(own, 'kdfM'),
      kdfT: optNum(own, 'kdfT'),
      kdfP: optNum(own, 'kdfP'),
    },
  };
}

function entryView(raw: unknown): VaultEntry {
  const r = asRec(raw, W);
  const kind = str(r, 'kind', W) as LoginKind;
  if (!LOGIN_KINDS.includes(kind)) throw new Error('malformed vault response: login kind');
  const o = r.opening == null ? null : asRec(r.opening, W);
  return {
    id: str(r, 'id', W),
    name: str(r, 'name', W),
    kind,
    usedOn: arrayOf(r, 'usedOn', W).map((u) => {
      const x = asRec(u, W);
      return { design: str(x, 'design', W), element: str(x, 'element', W) };
    }),
    owner: str(r, 'owner', W),
    ownerName: str(r, 'ownerName', W),
    createdAt: int(r, 'createdAt', W),
    updatedAt: int(r, 'updatedAt', W),
    updatedBy: str(r, 'updatedBy', W),
    version: int(r, 'version', W),
    epoch: int(r, 'epoch', W),
    needsRotation: bool(r, 'needsRotation', W),
    holders: arrayOf(r, 'holders', W).map((h) => {
      const x = asRec(h, W);
      const hk = str(x, 'kind', W);
      return {
        keyId: str(x, 'keyId', W),
        kind: hk === 'recovery' ? 'recovery' : 'person',
        account: optStr(x, 'account', W),
        name: str(x, 'name', W),
        fpr: hex(x, 'fpr'),
        digest: hex(x, 'digest'),
        revoked: bool(x, 'revoked', W),
        stale: bool(x, 'stale', W),
      };
    }),
    opening: o && {
      keyId: str(o, 'keyId', W),
      wrap: hex(o, 'wrap'),
      secretCt: hex(o, 'secretCt'),
      secretNonce: hex(o, 'secretNonce'),
      sharer: str(o, 'sharer', W),
      sharerKeyFpr: hex(o, 'sharerKeyFpr'),
      sharerPublicKey: hex(o, 'sharerPublicKey'),
      shareAt: int(o, 'shareAt', W),
      signature: hex(o, 'signature'),
      viaRecovery: bool(o, 'viaRecovery', W),
    },
  };
}

export function parseOverview(bytes: Uint8Array): VaultOverview {
  const r = jsonObject(bytes, W);
  return {
    me: str(r, 'me', W),
    steward: bool(r, 'steward', W),
    myKey: r.myKey == null ? null : keyView(r.myKey),
    recovery: r.recovery == null ? null : keyView(r.recovery),
    recoveryUses: arrayOf(r, 'recoveryUses', W).map((u) => {
      const x = asRec(u, W);
      return { by: str(x, 'by', W), byName: str(x, 'byName', W), at: int(x, 'at', W) };
    }),
    people: arrayOf(r, 'people', W).map((p) => {
      const x = asRec(p, W);
      return { account: str(x, 'account', W), name: str(x, 'name', W), key: x.key == null ? null : keyView(x.key) };
    }),
    entries: arrayOf(r, 'entries', W).map(entryView),
  };
}

const base = (organisation: string) => `/organisations/${encodeURIComponent(organisation)}/vault`;
const entryPath = (organisation: string, credential: string, act: string) =>
  `${base(organisation)}/entries/${encodeURIComponent(credential)}/${act}`;

export async function fetchVault(organisation: string): Promise<VaultOverview> {
  return parseOverview(await signedFetch('GET', base(organisation)));
}

export interface EnrolBody {
  kind: 'person' | 'recovery';
  publicKey: Uint8Array;
  sealedPrivate: Uint8Array;
  sealedNonce: Uint8Array;
  kdf: { salt: Uint8Array; m: number; t: number; p: number } | null;
  signerKeyFpr: Uint8Array;
  enrolledAt: number;
  signature: Uint8Array;
  successionSig: Uint8Array | null;
}

export async function enrolVaultKey(organisation: string, e: EnrolBody): Promise<VaultKeyView> {
  const answer = await signedFetch(
    'POST',
    `${base(organisation)}/keys`,
    body({
      kind: e.kind,
      publicKey: toHex(e.publicKey),
      sealedPrivate: toHex(e.sealedPrivate),
      sealedNonce: toHex(e.sealedNonce),
      kdfSalt: e.kdf ? toHex(e.kdf.salt) : undefined,
      kdfM: e.kdf?.m,
      kdfT: e.kdf?.t,
      kdfP: e.kdf?.p,
      signerKeyFpr: toHex(e.signerKeyFpr),
      enrolledAt: e.enrolledAt,
      signature: toHex(e.signature),
      successionSig: e.successionSig ? toHex(e.successionSig) : undefined,
    }),
  );
  return keyView(jsonObject(answer, W));
}

export interface ShareBody {
  at: number;
  sharerKeyFpr: Uint8Array;
  signature: Uint8Array;
  viaRecovery: boolean;
  wraps: { keyId: string; wrap: Uint8Array }[];
}

const shareJson = (s: ShareBody) => ({
  at: s.at,
  sharerKeyFpr: toHex(s.sharerKeyFpr),
  signature: toHex(s.signature),
  viaRecovery: s.viaRecovery || undefined,
  wraps: s.wraps.map((w) => ({ keyId: w.keyId, wrap: toHex(w.wrap) })),
});

export async function createLogin(
  organisation: string,
  e: { id: string; name: string; kind: LoginKind; usedOn: UsedOn[]; secretCt: Uint8Array; secretNonce: Uint8Array; share: ShareBody },
): Promise<VaultEntry> {
  const answer = await signedFetch(
    'POST',
    `${base(organisation)}/entries`,
    body({
      id: e.id,
      name: e.name,
      kind: e.kind,
      usedOn: e.usedOn,
      secretCt: toHex(e.secretCt),
      secretNonce: toHex(e.secretNonce),
      share: shareJson(e.share),
    }),
  );
  return entryView(jsonObject(answer, W));
}

export type EpochReason = 'changed' | 'shared' | 'rotated';

export async function newEpoch(
  organisation: string,
  credential: string,
  e: { ifVersion: number; reason: EpochReason; secretCt: Uint8Array; secretNonce: Uint8Array; share: ShareBody },
): Promise<VaultEntry> {
  const answer = await signedFetch(
    'POST',
    entryPath(organisation, credential, 'epoch'),
    body({ ifVersion: e.ifVersion, reason: e.reason, secretCt: toHex(e.secretCt), secretNonce: toHex(e.secretNonce), share: shareJson(e.share) }),
  );
  return entryView(jsonObject(answer, W));
}

export async function setLoginDetails(
  organisation: string,
  credential: string,
  e: { ifVersion: number; name: string; kind: LoginKind; usedOn: UsedOn[] },
): Promise<VaultEntry> {
  return entryView(jsonObject(await signedFetch('POST', entryPath(organisation, credential, 'meta'), body(e)), W));
}

export async function revokeHolder(organisation: string, credential: string, ifVersion: number, keyId: string): Promise<VaultEntry> {
  return entryView(jsonObject(await signedFetch('POST', entryPath(organisation, credential, 'revoke'), body({ ifVersion, keyId })), W));
}

export async function deleteLogin(organisation: string, credential: string, ifVersion: number): Promise<void> {
  await signedFetch('POST', entryPath(organisation, credential, 'delete'), body({ ifVersion }));
}

export interface RecoveryOpened {
  key: VaultKeyView;
  sealedPrivate: Uint8Array;
  sealedNonce: Uint8Array;
  entries: VaultEntry[];
}

/** Recorded on the organisation's history before anything is served. */
export async function openWithRecoverySheet(organisation: string): Promise<RecoveryOpened> {
  const r = jsonObject(await signedFetch('POST', `${base(organisation)}/recovery/open`, body({})), W);
  return {
    key: keyView(r.key),
    sealedPrivate: hex(r, 'sealedPrivate'),
    sealedNonce: hex(r, 'sealedNonce'),
    entries: arrayOf(r, 'entries', W).map(entryView),
  };
}
