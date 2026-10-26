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

/** Fathom's own copy of a login (Mode B, ADR-0071 part two), when it has ever had one. */
export interface FathomCopy {
  /** `waiting`: the owner said yes, another admin has still to. `off`: the copy is gone. */
  state: 'waiting' | 'on' | 'off';
  consentedBy: string;
  consentedByName: string;
  consentAt: number;
  countersignNeeded: boolean;
  countersignedBy: string | null;
  countersignedByName: string | null;
  /** The epoch the copy was made at. Behind the login's epoch means it is out of date. */
  copyEpoch: number;
  serverKeyId: string;
  /** The statement the owner signed, which a countersigning admin signs as it is. */
  consentBytes: Uint8Array;
  reads: number;
  lastRead: number | null;
  lastPurpose: string | null;
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
  /** The organisation-history entry of this epoch's share, which a consent names. */
  shareSeq: number;
  fathom: FathomCopy | null;
  /** Marked critical: checked weekly, a breached password refused. */
  critical: boolean;
  /** What a holder's browser last found at this epoch; null when not checked since it changed. */
  breach: { found: boolean; checkedAt: number } | null;
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
  /** Which `vault.key` this server seals Fathom's copies under; a consent names it. Null on an
   * install whose keys volume predates it: letting Fathom use a login is off there. */
  fathomKeyId: string | null;
  breachPolicy: BreachPolicy;
  /** Outside vaults (part four): the caller's own connections, and every one for an admin. */
  outside: OutsideConnection[];
  /** Whether this server's Passbolt helper answers; Passbolt is offered only then. */
  passboltAvailable: boolean;
}

export interface BreachLevel {
  enabled: boolean;
  intervalDays: number;
  action: 'warn' | 'refuse';
}

/** The organisation's level (null: never set, so off) and the kinds it overrides. */
export interface BreachPolicy {
  organisation: BreachLevel | null;
  kinds: Partial<Record<LoginKind, BreachLevel>>;
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

function breachLevel(raw: unknown): BreachLevel {
  const r = asRec(raw, W);
  const action = str(r, 'action', W);
  if (action !== 'warn' && action !== 'refuse') throw new Error('malformed vault response: breach action');
  return { enabled: bool(r, 'enabled', W), intervalDays: int(r, 'intervalDays', W), action };
}

function breachPolicy(raw: unknown): BreachPolicy {
  const r = asRec(raw, W);
  const kinds: BreachPolicy['kinds'] = {};
  const k = r.kinds == null ? {} : asRec(r.kinds, W);
  for (const kind of LOGIN_KINDS) if (k[kind] != null) kinds[kind] = breachLevel(k[kind]);
  return { organisation: r.organisation == null ? null : breachLevel(r.organisation), kinds };
}

function fathomView(raw: unknown): FathomCopy {
  const r = asRec(raw, W);
  const state = str(r, 'state', W);
  if (state !== 'waiting' && state !== 'on' && state !== 'off') throw new Error('malformed vault response: Fathom copy state');
  return {
    state,
    consentedBy: str(r, 'consentedBy', W),
    consentedByName: str(r, 'consentedByName', W),
    consentAt: int(r, 'consentAt', W),
    countersignNeeded: bool(r, 'countersignNeeded', W),
    countersignedBy: optStr(r, 'countersignedBy', W),
    countersignedByName: optStr(r, 'countersignedByName', W),
    copyEpoch: int(r, 'copyEpoch', W),
    serverKeyId: str(r, 'serverKeyId', W),
    consentBytes: hex(r, 'consentBytes'),
    reads: int(r, 'reads', W),
    lastRead: optNum(r, 'lastRead'),
    lastPurpose: optStr(r, 'lastPurpose', W),
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
    shareSeq: int(r, 'shareSeq', W),
    fathom: r.fathom == null ? null : fathomView(r.fathom),
    critical: bool(r, 'critical', W),
    breach: r.breach == null ? null : (() => {
      const b = asRec(r.breach, W);
      return { found: bool(b, 'found', W), checkedAt: int(b, 'checkedAt', W) };
    })(),
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
    fathomKeyId: optStr(r, 'fathomKeyId', W),
    breachPolicy: breachPolicy(r.breachPolicy),
    outside: arrayOf(r, 'outside', W).map(outsideConnection),
    passboltAvailable: r.passboltAvailable === true,
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

// ---------------------------------------------------------------------------
// Fathom's copy (Mode B). These four routes are the only ones that carry a login in the clear,
// because handing Fathom the login is what the person chose. The server seals it at once.
// ---------------------------------------------------------------------------

/** The plain login, as the server keeps it: `{u, p, n}`. */
export interface LoginCopy {
  u: string;
  p: string;
  n: string;
}

export async function fathomOn(
  organisation: string,
  credential: string,
  e: { ifVersion: number; epochBefore: number; at: number; keyFpr: Uint8Array; signature: Uint8Array; copy: LoginCopy },
): Promise<FathomCopy> {
  const answer = await signedFetch(
    'POST',
    entryPath(organisation, credential, 'fathom/on'),
    body({ ifVersion: e.ifVersion, epochBefore: e.epochBefore, at: e.at, keyFpr: toHex(e.keyFpr), signature: toHex(e.signature), copy: e.copy }),
  );
  return fathomView(jsonObject(answer, W));
}

export async function fathomCountersign(
  organisation: string,
  credential: string,
  e: { at: number; keyFpr: Uint8Array; signature: Uint8Array },
): Promise<FathomCopy> {
  const answer = await signedFetch(
    'POST',
    entryPath(organisation, credential, 'fathom/countersign'),
    body({ at: e.at, keyFpr: toHex(e.keyFpr), signature: toHex(e.signature) }),
  );
  return fathomView(jsonObject(answer, W));
}

export async function fathomRefresh(organisation: string, credential: string, copy: LoginCopy): Promise<FathomCopy> {
  return fathomView(jsonObject(await signedFetch('POST', entryPath(organisation, credential, 'fathom/refresh'), body({ copy })), W));
}

export async function fathomOff(organisation: string, credential: string): Promise<FathomCopy> {
  return fathomView(jsonObject(await signedFetch('POST', entryPath(organisation, credential, 'fathom/off'), body({})), W));
}

// ---------------------------------------------------------------------------
// Breach checks (part three)
// ---------------------------------------------------------------------------

/** An admin sets the whole policy; a kind left out is the same as the organisation. */
export async function setBreachPolicy(organisation: string, policy: BreachPolicy): Promise<BreachPolicy> {
  return breachPolicy(jsonObject(await signedFetch('POST', `${base(organisation)}/breach-policy`, body(policy)), W));
}

export async function setCritical(organisation: string, credential: string, critical: boolean): Promise<boolean> {
  return bool(jsonObject(await signedFetch('POST', entryPath(organisation, credential, 'critical'), body({ critical })), W), 'critical', W);
}

/** What this browser found for the login at `epoch`. Only a holder may say. */
export async function recordBreach(organisation: string, credential: string, epoch: number, found: boolean): Promise<{ found: boolean; checkedAt: number }> {
  const r = jsonObject(await signedFetch('POST', entryPath(organisation, credential, 'breach'), body({ epoch, found })), W);
  return { found: bool(r, 'found', W), checkedAt: int(r, 'checkedAt', W) };
}

// ---------------------------------------------------------------------------
// Outside vaults (part four). The master password never appears here: the browser opens the
// account's keys with it (`../vault/outside.ts`) and sends only the organisation key.
// ---------------------------------------------------------------------------

export interface OutsideItem {
  id: string;
  cipherId: string;
  name: string;
  kind: LoginKind;
  usedOn: UsedOn[];
  state: 'on' | 'removed';
  removedBy: string | null;
  removedByName: string | null;
  reads: number;
  lastRead: number | null;
}

export interface OutsideConnection {
  id: string;
  owner: string;
  ownerName: string;
  provider: OutsideProvider;
  url: string;
  /** Vaultwarden's collection, or Secret Server's or Passbolt's folder. */
  collectionName: string;
  /** `stopped`: a check failed on a read, and `stoppedReason` says which. `waiting`: Passbolt's
   * account is set up and waits for its folder to be shared; the first passing check binds it. */
  state: 'waiting' | 'on' | 'stopped' | 'disconnected';
  stoppedReason: string | null;
  checkedAt: number | null;
  createdAt: number;
  items: OutsideItem[];
}

export type OutsideProvider = 'vaultwarden' | 'delinea' | 'passbolt';

export const PROVIDER_LABELS: Record<OutsideProvider, string> = {
  vaultwarden: 'Vaultwarden',
  delinea: 'Secret Server',
  passbolt: 'Passbolt',
};

export interface CheckLine {
  id: string;
  passed: boolean;
  text: string;
}

export interface OutsideLogin {
  cipherId: string;
  name: string;
  hasPassword: boolean;
}

/** What the server read from the vault with the API key, for the browser to open. */
export interface OutsidePrepared {
  url: string;
  deviceId: string;
  protectedUserKey: string;
  protectedPrivateKey: string;
  kdf: { type: number; iterations: number; memory: number | null; parallelism: number | null };
  /** The account's e-mail, which Bitwarden salts the master key with; null if the vault did not say. */
  salt: string | null;
  organisations: { id: string; name: string; role: number; status: number; protectedKey: string | null }[];
  collections: { id: string; organisationId: string; protectedName: string }[];
  checks: CheckLine[];
}

function outsideItem(raw: unknown): OutsideItem {
  const r = asRec(raw, W);
  const state = str(r, 'state', W);
  if (state !== 'on' && state !== 'removed') throw new Error('malformed vault response: outside item state');
  const kind = str(r, 'kind', W) as LoginKind;
  return {
    id: str(r, 'id', W),
    cipherId: str(r, 'cipherId', W),
    name: str(r, 'name', W),
    kind: LOGIN_KINDS.includes(kind) ? kind : 'other',
    usedOn: arrayOf(r, 'usedOn', W).map((u) => {
      const x = asRec(u, W);
      return { design: str(x, 'design', W), element: str(x, 'element', W) };
    }),
    state,
    removedBy: optStr(r, 'removedBy', W),
    removedByName: optStr(r, 'removedByName', W),
    reads: int(r, 'reads', W),
    lastRead: optNum(r, 'lastRead'),
  };
}

function outsideProvider(p: string): OutsideProvider {
  if (p !== 'vaultwarden' && p !== 'delinea' && p !== 'passbolt') throw new Error('malformed vault response: outside provider');
  return p;
}

function outsideConnection(raw: unknown): OutsideConnection {
  const r = asRec(raw, W);
  const state = str(r, 'state', W);
  if (state !== 'waiting' && state !== 'on' && state !== 'stopped' && state !== 'disconnected') throw new Error('malformed vault response: outside state');
  return {
    id: str(r, 'id', W),
    owner: str(r, 'owner', W),
    ownerName: str(r, 'ownerName', W),
    provider: outsideProvider(str(r, 'provider', W)),
    url: str(r, 'url', W),
    collectionName: str(r, 'collectionName', W),
    state,
    stoppedReason: optStr(r, 'stoppedReason', W),
    checkedAt: optNum(r, 'checkedAt'),
    createdAt: int(r, 'createdAt', W),
    items: arrayOf(r, 'items', W).map(outsideItem),
  };
}

function checkLines(r: Rec): CheckLine[] {
  return arrayOf(r, 'checks', W).map((c) => {
    const x = asRec(c, W);
    return { id: str(x, 'id', W), passed: bool(x, 'passed', W), text: str(x, 'text', W) };
  });
}

export async function outsidePrepare(
  organisation: string,
  e: { url: string; clientId: string; clientSecret: string },
): Promise<OutsidePrepared> {
  const r = jsonObject(await signedFetch('POST', `${base(organisation)}/outside/prepare`, body(e)), W);
  const k = asRec(r.kdf, W);
  return {
    url: str(r, 'url', W),
    deviceId: str(r, 'deviceId', W),
    protectedUserKey: str(r, 'protectedUserKey', W),
    protectedPrivateKey: str(r, 'protectedPrivateKey', W),
    kdf: { type: int(k, 'type', W), iterations: int(k, 'iterations', W), memory: optNum(k, 'memory'), parallelism: optNum(k, 'parallelism') },
    salt: optStr(r, 'salt', W),
    organisations: arrayOf(r, 'organisations', W).map((o) => {
      const x = asRec(o, W);
      return { id: str(x, 'id', W), name: str(x, 'name', W), role: int(x, 'role', W), status: int(x, 'status', W), protectedKey: optStr(x, 'protectedKey', W) };
    }),
    collections: arrayOf(r, 'collections', W).map((c) => {
      const x = asRec(c, W);
      return { id: str(x, 'id', W), organisationId: str(x, 'organisationId', W), protectedName: str(x, 'protectedName', W) };
    }),
    checks: checkLines(r),
  };
}

export async function outsideConnect(
  organisation: string,
  e: { url: string; clientId: string; clientSecret: string; deviceId: string; collectionId: string; collectionName: string; orgKey: Uint8Array },
): Promise<OutsideConnection> {
  const answer = await signedFetch('POST', `${base(organisation)}/outside/connect`, body({ ...e, orgKey: toHex(e.orgKey) }));
  return outsideConnection(jsonObject(answer, W));
}

/** Delinea Secret Server: the server signs in with the account and reads what it sees. */
export async function outsideDelineaPrepare(
  organisation: string,
  e: { url: string; username: string; password: string },
): Promise<{ url: string; folders: { id: string; name: string }[]; checks: CheckLine[] }> {
  const r = jsonObject(await signedFetch('POST', `${base(organisation)}/outside/prepare`, body({ provider: 'delinea', ...e })), W);
  return {
    url: str(r, 'url', W),
    folders: arrayOf(r, 'folders', W).map((f) => {
      const x = asRec(f, W);
      return { id: str(x, 'id', W), name: str(x, 'name', W) };
    }),
    checks: checkLines(r),
  };
}

export async function outsideDelineaConnect(
  organisation: string,
  e: { url: string; username: string; password: string; folderName: string },
): Promise<OutsideConnection> {
  const answer = await signedFetch('POST', `${base(organisation)}/outside/connect`, body({ provider: 'delinea', ...e }));
  return outsideConnection(jsonObject(answer, W));
}

/** Passbolt: the address its invitation names and its server key's fingerprint, for the person to
 * compare with what Passbolt's administrator gives them. The invitation is not used. */
export async function outsidePassboltPrepare(organisation: string, e: { invite: string }): Promise<{ url: string; serverFingerprint: string }> {
  const r = jsonObject(await signedFetch('POST', `${base(organisation)}/outside/prepare`, body({ provider: 'passbolt', ...e })), W);
  return { url: str(r, 'url', W), serverFingerprint: str(r, 'serverFingerprint', W) };
}

/** Passbolt: Fathom makes its own key and finishes the invited account's setup with it; the
 * connection then waits for one folder to be shared with that account. Uses the invitation. */
export async function outsidePassboltConnect(
  organisation: string,
  e: { invite: string; folderName: string; serverFingerprint: string },
): Promise<OutsideConnection> {
  const answer = await signedFetch('POST', `${base(organisation)}/outside/connect`, body({ provider: 'passbolt', ...e }));
  return outsideConnection(jsonObject(answer, W));
}

export async function outsideCheck(
  organisation: string,
  connection: string,
): Promise<{ connection: OutsideConnection; checks: CheckLine[]; logins: OutsideLogin[] }> {
  const r = jsonObject(await signedFetch('POST', `${base(organisation)}/outside/${encodeURIComponent(connection)}/check`, body({})), W);
  return {
    connection: outsideConnection(r.connection),
    checks: checkLines(r),
    logins: arrayOf(r, 'logins', W).map((l) => {
      const x = asRec(l, W);
      return { cipherId: str(x, 'cipherId', W), name: str(x, 'name', W), hasPassword: bool(x, 'hasPassword', W) };
    }),
  };
}

export async function outsidePull(
  organisation: string,
  connection: string,
  e: { cipherId: string; kind: LoginKind; usedOn: UsedOn[] },
): Promise<OutsideConnection> {
  const answer = await signedFetch('POST', `${base(organisation)}/outside/${encodeURIComponent(connection)}/pull`, body(e));
  return outsideConnection(jsonObject(answer, W));
}

export async function outsideDisconnect(organisation: string, connection: string): Promise<OutsideConnection> {
  return outsideConnection(jsonObject(await signedFetch('POST', `${base(organisation)}/outside/${encodeURIComponent(connection)}/disconnect`, body({})), W));
}

export async function outsideRemove(organisation: string, item: string): Promise<OutsideConnection> {
  return outsideConnection(jsonObject(await signedFetch('POST', `${base(organisation)}/outside/items/${encodeURIComponent(item)}/remove`, body({})), W));
}

export async function outsideRestore(organisation: string, item: string): Promise<OutsideConnection> {
  return outsideConnection(jsonObject(await signedFetch('POST', `${base(organisation)}/outside/items/${encodeURIComponent(item)}/restore`, body({})), W));
}
