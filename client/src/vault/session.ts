// The vault as this browser uses it: whether it is unlocked, what this browser remembers, and
// every act that seals, signs and sends. Screens call these and render the result; none of them
// touches a key.
//
// **Unlocked means one opened vault key in this tab's memory**, for 15 minutes from the last time
// it was used, then dropped. Nothing opened is written anywhere. Lock drops it at once.
//
// **What this browser remembers**, in local storage, and why each is safe to:
// - The 128-bit vault key from the Emergency Kit, so a person types only their passphrase here.
//   It opens nothing alone: the sealed key also needs the passphrase (ADR-0043 §6), and the
//   sealed key lives on the server, not here.
// - Pins (storage design §13.2, tier B): the vault key fingerprint first seen for each person,
//   so a key that changes without a signed succession is caught, and its holder is not given a
//   new password.

import { signMessage } from '../crypto/keys';
import { sameBytes } from '../api/json';
import { keyFingerprint } from '../api/grantBytes';
import { ownKeyFingerprint, signingKey } from '../api/share';
import {
  createLogin,
  deleteLogin,
  enrolVaultKey,
  fetchVault,
  newEpoch,
  openWithRecoverySheet,
  revokeHolder,
  setLoginDetails,
  type EpochReason,
  type LoginKind,
  type ShareBody,
  type UsedOn,
  type VaultEntry,
  type VaultKeyView,
  type VaultOverview,
} from '../api/vault';
import { toHex } from '../crypto/bytes';
import type { Engine } from '../engine/engine';
import { newUlid } from '../document/ulid';
import { RECOVERY_RECIPIENT, keyFpr, personKeyBytes, recoveryKeyBytes, shareBytes, supersedeBytes, wrapDigest, type Recipient } from './bytes';
import {
  KDF,
  fromBase32,
  makePersonKey,
  makeRecoveryKey,
  newContentKey,
  openPersonKey,
  openRecoveryKey,
  openSecret,
  recoveryText,
  sealSecret,
  unwrap,
  vaultKeyText,
  verifyAccountSignature,
  wrapTo,
  type OpenVaultKey,
  type Secret,
} from './crypto';

export const UNLOCK_MINUTES = 15;

// ---------------------------------------------------------------------------
// Unlocked state
// ---------------------------------------------------------------------------

interface Unlocked {
  organisation: string;
  account: string;
  key: OpenVaultKey;
  fpr: Uint8Array;
  until: number;
}

let unlocked: Unlocked | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

/** Subscribe to lock and unlock. Returns the unsubscribe. */
export function onVaultChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function lockVault(): void {
  unlocked = null;
  if (timer) clearTimeout(timer);
  timer = null;
  notify();
}

function arm(): void {
  if (!unlocked) return;
  unlocked.until = Date.now() + UNLOCK_MINUTES * 60_000;
  if (timer) clearTimeout(timer);
  timer = setTimeout(lockVault, UNLOCK_MINUTES * 60_000);
}

/** Whether `organisation`'s vault is open in this tab, and until when. */
export function vaultUnlocked(organisation?: string): { until: number } | null {
  if (!unlocked || (organisation && unlocked.organisation !== organisation)) return null;
  return { until: unlocked.until };
}

function need(organisation: string): Unlocked {
  if (!unlocked || unlocked.organisation !== organisation) throw new Error('Unlock your passwords first.');
  arm();
  return unlocked;
}

// ---------------------------------------------------------------------------
// What this browser remembers
// ---------------------------------------------------------------------------

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // A browser that will not store it asks for the kit at each unlock; nothing breaks.
  }
}

const kitSlot = (organisation: string, account: string) => `fathom.vault.kit.${organisation}.${account}`;
const pinSlot = (organisation: string) => `fathom.vault.pins.${organisation}`;

/** The vault key this browser remembers for this person, if any. */
export function rememberedKit(organisation: string, account: string): Uint8Array | null {
  const t = read(kitSlot(organisation, account));
  return t ? fromBase32(t, 16) : null;
}

export type PinState = 'unpinned' | 'pinned' | 'rotated' | 'unexplained';

function pins(organisation: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(read(pinSlot(organisation)) ?? '{}');
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** §13.2's four states for one person's current vault key, against this browser's pin. */
export function pinState(organisation: string, key: VaultKeyView): PinState {
  const pinned = pins(organisation)[key.account ?? RECOVERY_RECIPIENT];
  if (!pinned) return 'unpinned';
  if (pinned === toHex(key.fpr)) return 'pinned';
  if (key.supersedes && toHex(key.supersedes.oldFpr) === pinned) return 'rotated';
  return 'unexplained';
}

/** Remember these keys as the ones seen. Never called for an unexplained key. */
export function pinKeys(organisation: string, keys: readonly VaultKeyView[]): void {
  const p = pins(organisation);
  for (const k of keys) {
    if (pinState(organisation, k) !== 'unexplained') p[k.account ?? RECOVERY_RECIPIENT] = toHex(k.fpr);
  }
  write(pinSlot(organisation), JSON.stringify(p));
}

// ---------------------------------------------------------------------------
// Checking what the server sends
// ---------------------------------------------------------------------------

/** A key the server lists is used only if its enrolment signature verifies against the account
 * key the server names, and that key's fingerprint is the one signed. */
export async function keyVouchedFor(organisation: string, k: VaultKeyView): Promise<boolean> {
  if (!sameBytes(await keyFingerprint(k.signerPublicKey), k.signerKeyFpr)) return false;
  if (!sameBytes(await keyFpr(k.publicKey), k.fpr)) return false;
  const bytes =
    k.kind === 'person'
      ? personKeyBytes(organisation, k.account ?? '', k.publicKey, k.signerKeyFpr, k.enrolledAt)
      : recoveryKeyBytes(organisation, k.publicKey, k.createdBy, k.signerKeyFpr, k.enrolledAt);
  return verifyAccountSignature(k.signerPublicKey, bytes, k.signature);
}

/** Rebuild the signed recipient set from what is listed and check the sharer's signature. A wrap
 * no verified share covers is not opened (§13.7 rule 2). */
async function shareVerifies(organisation: string, entry: VaultEntry): Promise<boolean> {
  const o = entry.opening;
  if (!o) return false;
  if (!sameBytes(await keyFingerprint(o.sharerPublicKey), o.sharerKeyFpr)) return false;
  const recipients: Recipient[] = entry.holders.map((h) => ({
    who: h.kind === 'recovery' ? RECOVERY_RECIPIENT : (h.account ?? ''),
    keyFpr: h.fpr,
    digest: h.digest,
  }));
  const bytes = shareBytes(organisation, entry.id, entry.epoch, recipients, o.sharer, o.sharerKeyFpr, o.shareAt);
  return verifyAccountSignature(o.sharerPublicKey, bytes, o.signature);
}

// ---------------------------------------------------------------------------
// Setting up and unlocking
// ---------------------------------------------------------------------------

const nowUnix = () => Math.floor(Date.now() / 1000);

let enginePromise: Promise<Engine> | null = null;
/** One engine for the vault in this tab, booted the first time a passphrase is typed. */
export function vaultEngine(): Promise<Engine> {
  enginePromise ??= import('../engine/engine').then((m) => m.Engine.init());
  enginePromise.catch(() => {
    enginePromise = null;
  });
  return enginePromise;
}

async function accountKeyFacts(): Promise<{ key: CryptoKey; fpr: Uint8Array }> {
  return { key: await signingKey(), fpr: await ownKeyFingerprint() };
}

/**
 * Make this person's vault key and send it, sealed, under `passphrase` and the vault key `secret`
 * already saved on their Emergency Kit. Answers the kit's text. If they already had one (a forgotten passphrase), this replaces it with a succession the
 * account key signs, and logins shared to the old key need sharing again.
 */
export async function setUpVault(engine: Engine, overview: VaultOverview, organisation: string, passphrase: string, secret: Uint8Array): Promise<string> {
  const account = overview.me;
  const made = await makePersonKey(engine, organisation, account, passphrase, secret);
  const signer = await accountKeyFacts();
  const at = nowUnix();
  const newFpr = await keyFpr(made.publicKey);
  const old = overview.myKey;
  const successionSig = old
    ? await signMessage(signer.key, supersedeBytes(organisation, 'person', account, old.fpr, newFpr, at))
    : null;
  const enrolled = await enrolVaultKey(organisation, {
    kind: 'person',
    publicKey: made.publicKey,
    sealedPrivate: made.sealedPrivate,
    sealedNonce: made.sealedNonce,
    kdf: { salt: made.kdfSalt, ...KDF },
    signerKeyFpr: signer.fpr,
    enrolledAt: at,
    signature: await signMessage(signer.key, personKeyBytes(organisation, account, made.publicKey, signer.fpr, at)),
    successionSig,
  });
  const kit = vaultKeyText(made.secret);
  write(kitSlot(organisation, account), kit.replace(/-/g, ''));
  pinKeys(organisation, [enrolled]);
  unlocked = { organisation, account, key: made.opened, fpr: newFpr, until: 0 };
  arm();
  notify();
  return kit;
}

/** Unlock with the passphrase, and the Emergency Kit's vault key when this browser has none. */
export async function unlockVault(engine: Engine, overview: VaultOverview, organisation: string, passphrase: string, kitText?: string): Promise<void> {
  const k = overview.myKey;
  if (!k?.own || !k.own.kdfSalt || k.own.kdfM == null || k.own.kdfT == null || k.own.kdfP == null) {
    throw new Error('Set up your passwords first.');
  }
  const secret = kitText ? fromBase32(kitText, 16) : rememberedKit(organisation, overview.me);
  if (!secret) throw new Error(kitText ? 'That vault key is mistyped: it is 26 letters and digits.' : 'Type the vault key from your Emergency Kit.');
  const key = await openPersonKey(
    engine,
    organisation,
    overview.me,
    { publicKey: k.publicKey, sealedPrivate: k.own.sealedPrivate, sealedNonce: k.own.sealedNonce, kdfSalt: k.own.kdfSalt, m: k.own.kdfM, t: k.own.kdfT, p: k.own.kdfP },
    passphrase,
    secret,
  );
  if (kitText) write(kitSlot(organisation, overview.me), vaultKeyText(secret).replace(/-/g, ''));
  unlocked = { organisation, account: overview.me, key, fpr: k.fpr, until: 0 };
  arm();
  notify();
}

/** An admin makes the organisation's recovery sheet. Answers its secret, to print. */
export async function makeRecoverySheet(overview: VaultOverview, organisation: string): Promise<string> {
  if (!overview.steward) throw new Error('Only an admin makes the recovery sheet.');
  const made = await makeRecoveryKey(organisation, overview.me);
  const signer = await accountKeyFacts();
  const at = nowUnix();
  const old = overview.recovery;
  const enrolled = await enrolVaultKey(organisation, {
    kind: 'recovery',
    publicKey: made.publicKey,
    sealedPrivate: made.sealedPrivate,
    sealedNonce: made.sealedNonce,
    kdf: null,
    signerKeyFpr: signer.fpr,
    enrolledAt: at,
    signature: await signMessage(signer.key, recoveryKeyBytes(organisation, made.publicKey, overview.me, signer.fpr, at)),
    successionSig: old
      ? await signMessage(signer.key, supersedeBytes(organisation, 'recovery', organisation, old.fpr, await keyFpr(made.publicKey), at))
      : null,
  });
  pinKeys(organisation, [enrolled]);
  return recoveryText(made.sheetSecret);
}

// ---------------------------------------------------------------------------
// Logins
// ---------------------------------------------------------------------------

export interface Recipients {
  /** Keys that will be given this login. */
  keys: VaultKeyView[];
  /** People left out, and why, in words for the share dialog. */
  dropped: { name: string; why: string }[];
}

/**
 * Who a login goes to: me, the recovery sheet when there is one, and whoever else was chosen.
 * A key that does not verify, or changed with no signed succession, is dropped: §13.2, "the
 * recipient is dropped and the wrap is not produced", with no way to proceed anyway.
 */
export async function chooseRecipients(organisation: string, overview: VaultOverview, others: readonly string[]): Promise<Recipients> {
  const keys: VaultKeyView[] = [];
  const dropped: Recipients['dropped'] = [];
  const consider = async (k: VaultKeyView | null, name: string) => {
    if (!k) {
      dropped.push({ name, why: 'has not set up their passwords yet' });
    } else if (!(await keyVouchedFor(organisation, k))) {
      dropped.push({ name, why: 'has a key whose signature does not check out' });
    } else if (pinState(organisation, k) === 'unexplained') {
      dropped.push({ name, why: 'has a key that changed without a signed replacement. Ask them to check it with you' });
    } else {
      keys.push(k);
    }
  };
  await consider(overview.myKey, 'You');
  if (overview.recovery) await consider(overview.recovery, 'The recovery sheet');
  for (const account of others) {
    if (account === overview.me) continue;
    const person = overview.people.find((p) => p.account === account);
    await consider(person?.key ?? null, person?.name ?? 'Someone');
  }
  return { keys, dropped };
}

async function buildShare(
  organisation: string,
  sharer: string,
  credential: string,
  epoch: number,
  contentKey: Uint8Array,
  keys: readonly VaultKeyView[],
  viaRecovery = false,
): Promise<ShareBody> {
  const signer = await accountKeyFacts();
  const ctx = { organisation, credential, epoch, sharerKeyFpr: signer.fpr };
  const wraps: ShareBody['wraps'] = [];
  const recipients: Recipient[] = [];
  for (const k of keys) {
    const wrap = await wrapTo(ctx, k.publicKey, k.fpr, contentKey);
    wraps.push({ keyId: k.id, wrap });
    recipients.push({ who: k.kind === 'recovery' ? RECOVERY_RECIPIENT : (k.account ?? ''), keyFpr: k.fpr, digest: await wrapDigest(wrap) });
  }
  const at = nowUnix();
  const signature = await signMessage(signer.key, shareBytes(organisation, credential, epoch, recipients, sharer, signer.fpr, at));
  pinKeys(organisation, keys);
  return { at, sharerKeyFpr: signer.fpr, signature, viaRecovery, wraps };
}

export interface NewLogin {
  name: string;
  kind: LoginKind;
  usedOn: UsedOn[];
  secret: Secret;
}

export async function storeLogin(organisation: string, recipients: Recipients, login: NewLogin): Promise<VaultEntry> {
  const u = need(organisation);
  const id = `cred_${newUlid()}`;
  const contentKey = newContentKey();
  const sealed = await sealSecret(organisation, id, 1, contentKey, login.secret);
  const share = await buildShare(organisation, u.account, id, 1, contentKey, recipients.keys);
  return createLogin(organisation, { id, name: login.name, kind: login.kind, usedOn: login.usedOn, secretCt: sealed.ct, secretNonce: sealed.nonce, share });
}

/** Open my copy of a login. Refuses a copy no verified share covers, or whose digest is not the
 * one signed. */
export async function revealLogin(organisation: string, entry: VaultEntry): Promise<Secret> {
  const u = need(organisation);
  const o = entry.opening;
  if (!o) throw new Error('This login has not been shared with you.');
  const mine = entry.holders.find((h) => h.keyId === o.keyId);
  if (!mine || !sameBytes(mine.fpr, u.fpr) || !sameBytes(mine.digest, await wrapDigest(o.wrap))) {
    throw new Error('Your copy of this login does not match what was signed, so it was not opened.');
  }
  if (!(await shareVerifies(organisation, entry))) {
    throw new Error('The signature on who holds this login does not check out, so it was not opened.');
  }
  const contentKey = await unwrap({ organisation, credential: entry.id, epoch: entry.epoch, sharerKeyFpr: o.sharerKeyFpr }, u.key, u.fpr, o.wrap);
  return openSecret(organisation, entry.id, entry.epoch, contentKey, o.secretCt, o.secretNonce);
}

/** A new epoch: a changed password, a changed set of holders, or a rotation after someone was
 * taken off. Always a fresh content key, so a removed holder's copy opens nothing new. */
export async function reshareLogin(
  organisation: string,
  entry: VaultEntry,
  recipients: Recipients,
  reason: EpochReason,
  newSecret?: Secret,
): Promise<VaultEntry> {
  const secret = newSecret ?? (await revealLogin(organisation, entry));
  const next = entry.epoch + 1;
  const contentKey = newContentKey();
  const sealed = await sealSecret(organisation, entry.id, next, contentKey, secret);
  const share = await buildShare(organisation, need(organisation).account, entry.id, next, contentKey, recipients.keys);
  return newEpoch(organisation, entry.id, { ifVersion: entry.version, reason, secretCt: sealed.ct, secretNonce: sealed.nonce, share });
}

/** The accounts that currently hold `entry`, live and not revoked, other than the recovery sheet. */
export function holderAccounts(entry: VaultEntry): string[] {
  return entry.holders.filter((h) => h.kind === 'person' && !h.revoked && h.account).map((h) => h.account as string);
}

/**
 * After an unlock: logins I hold that the current recovery sheet does not, or that are held by a
 * key since replaced, are re-shared so the sheet and the new keys cover them. This is what keeps
 * a person who forgets their passphrase from locking the organisation out of a login.
 */
export async function coverWithCurrentKeys(organisation: string, overview: VaultOverview): Promise<number> {
  need(organisation);
  let done = 0;
  for (const entry of overview.entries) {
    if (!entry.opening) continue;
    const live = entry.holders.filter((h) => !h.revoked);
    const sheetMissing = overview.recovery != null && !live.some((h) => sameBytes(h.fpr, overview.recovery!.fpr));
    const stale = live.some((h) => h.stale);
    if (!sheetMissing && !stale) continue;
    const recipients = await chooseRecipients(organisation, overview, holderAccounts(entry));
    await reshareLogin(organisation, entry, recipients, 'shared');
    done += 1;
  }
  return done;
}

export const renameLogin = setLoginDetails;
export const takeAwayCopy = revokeHolder;
export const removeLogin = deleteLogin;

/**
 * An admin, with the printed sheet, opens a login the sheet holds and gives it to `toAccounts`
 * (usually themselves, or the person who lost their passphrase). Recorded on the organisation's
 * history before anything is served, and listed on the admin page for everyone.
 */
export async function recoverLogins(organisation: string, overview: VaultOverview, sheetText: string, credentialIds: readonly string[], toAccounts: readonly string[]): Promise<number> {
  const sheet = fromBase32(sheetText, 32);
  if (!sheet) throw new Error('That recovery code is mistyped: it is 52 letters and digits.');
  const opened = await openWithRecoverySheet(organisation);
  const recoveryKey = await openRecoveryKey(organisation, opened.key.createdBy, { publicKey: opened.key.publicKey, sealedPrivate: opened.sealedPrivate, sealedNonce: opened.sealedNonce }, sheet);
  let done = 0;
  for (const entry of opened.entries) {
    if (!credentialIds.includes(entry.id) || !entry.opening) continue;
    if (!(await shareVerifies(organisation, entry))) continue;
    const o = entry.opening;
    const contentKey = await unwrap({ organisation, credential: entry.id, epoch: entry.epoch, sharerKeyFpr: o.sharerKeyFpr }, recoveryKey, opened.key.fpr, o.wrap);
    const secret = await openSecret(organisation, entry.id, entry.epoch, contentKey, o.secretCt, o.secretNonce);
    const recipients = await chooseRecipients(organisation, overview, [...new Set([...holderAccounts(entry), ...toAccounts])]);
    const next = entry.epoch + 1;
    const fresh = newContentKey();
    const sealed = await sealSecret(organisation, entry.id, next, fresh, secret);
    const share = await buildShare(organisation, overview.me, entry.id, next, fresh, recipients.keys, true);
    await newEpoch(organisation, entry.id, { ifVersion: entry.version, reason: 'shared', secretCt: sealed.ct, secretNonce: sealed.nonce, share });
    done += 1;
  }
  return done;
}

export { fetchVault };
