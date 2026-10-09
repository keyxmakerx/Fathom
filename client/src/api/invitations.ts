// Steward invitations, the Waiting list, and the one-signature batch confirm.
// Wire shapes are `design_api.rs`'s "Invitations, Waiting for you, People and
// seconding" routes; `invitations.rs` has what each check is.
//
// What the browser signs is rebuilt here from what the steward saw. A proposal
// is refused, and nothing is signed, unless its items are exactly the rows on
// screen, name the same keys, and carry consecutive epochs.

import { concatBytes, fromHex, lp, toHex, utf8 } from '../crypto/bytes';
import { getSession } from '../state/sessionState';
import { ApiRefusal } from './errors';
import { grantBytes, keyCode, type GrantCapability } from './grantBytes';
import { arrayOf, asRec, bool, int, jsonObject, oneOf, optInt, optStr, sameBytes, str, type Rec } from './json';
import { NoSigningKeyHere, ownKeyFingerprint, signingKey } from './share';
import { signedFetch } from './signedFetch';
import { signMessage } from '../crypto/keys';

/** The most people one confirm signs, and so the most rows one batch holds. */
export const BATCH_CAP = 500;
/** A steward appointment's default lifetime and its bounds (`STEWARD_GRANT_LIFETIME_SECONDS`). */
export const STEWARD_DEFAULT_DAYS = 365;
export const DAY_SECONDS = 24 * 60 * 60;

export type Asked = GrantCapability;
const CAPABILITIES: readonly Asked[] = ['read', 'draw', 'steward'];

const base = (organisation: string) => `/organisations/${encodeURIComponent(organisation)}/invitations`;

// ---- Issue ------------------------------------------------------------

export interface IssueRequest {
  name: string;
  /** A contact note only. It is never a sign-in name. */
  email: string;
  capability: Asked;
  /** `null` is the whole organisation. */
  scopeId: string | null;
}

/** Body: `LP(name) LP(email or "") LP(capability) LP(scope or "")`. */
export function buildIssueBody(r: IssueRequest): Uint8Array {
  return concatBytes(lp(utf8(r.name)), lp(utf8(r.email)), lp(utf8(r.capability)), lp(utf8(r.scopeId ?? '')));
}

/** What an issue answers, once: the link and token are not kept by the server. */
export interface IssuedInvitation {
  invitation: string;
  account: string;
  signInName: string;
  token: string;
  linkPath: string;
  expiresAtUnix: number;
}

export function parseIssued(bytes: Uint8Array): IssuedInvitation {
  const r = jsonObject(bytes, 'invitation');
  const token = str(r, 'token', 'invitation');
  if (!/^inv_[0-9a-f]{64}$/.test(token)) throw new Error('malformed invitation response: bad token');
  return {
    invitation: str(r, 'invitation', 'invitation'),
    account: str(r, 'account', 'invitation'),
    signInName: str(r, 'sign_in_name', 'invitation'),
    token,
    linkPath: str(r, 'link_path', 'invitation'),
    expiresAtUnix: int(r, 'expires_at_unix', 'invitation'),
  };
}

export async function issueInvitation(organisation: string, request: IssueRequest): Promise<IssuedInvitation> {
  return parseIssued(await signedFetch('POST', base(organisation), buildIssueBody(request)));
}

// ---- Waiting for you --------------------------------------------------

export interface Invitation {
  id: string;
  account: string;
  state: 'asked' | 'joined';
  /** What the steward typed. Not attested by the person. */
  displayName: string;
  /** What the steward typed. Not attested by the person. */
  contactEmail: string | null;
  signInName: string;
  capabilityAsked: Asked;
  scopeId: string | null;
  scopeLabel: string;
  /** Ten characters of the joiner's key fingerprint; null until they join. */
  keyCode: string | null;
  issuedBy: string;
  issuedByName: string;
  issuedAtUnix: number;
  joinedAtUnix: number | null;
  windowEndsAtUnix: number;
  expired: boolean;
  unverifiable: boolean;
  canConfirm: boolean;
}

/** A steward grant waiting for the caller's second signature. */
export interface SecondingItem {
  grant: string;
  scopeId: string | null;
  scopeLabel: string;
  subject: string;
  subjectName: string;
  keyCode: string;
  granter: string | null;
  granterName: string | null;
  effectiveFromUnix: number;
  expiresAtUnix: number;
}

export interface Waiting {
  waitingCount: number;
  invitations: Invitation[];
  seconding: SecondingItem[];
}

export function parseInvitation(entry: unknown, i: number): Invitation {
  const what = `invitation ${i}`;
  const r = asRec(entry, what);
  return {
    id: str(r, 'id', what),
    account: str(r, 'account', what),
    state: oneOf(r, 'state', ['asked', 'joined'] as const, what),
    displayName: str(r, 'display_name', what),
    contactEmail: optStr(r, 'contact_email', what),
    signInName: str(r, 'sign_in_name', what),
    capabilityAsked: oneOf(r, 'capability_asked', CAPABILITIES, what),
    scopeId: optStr(r, 'scope_id', what),
    scopeLabel: str(r, 'scope_label', what),
    keyCode: optStr(r, 'key_code', what),
    issuedBy: str(r, 'issued_by', what),
    issuedByName: str(r, 'issued_by_name', what),
    issuedAtUnix: int(r, 'issued_at_unix', what),
    joinedAtUnix: optInt(r, 'joined_at_unix', what),
    windowEndsAtUnix: int(r, 'window_ends_at_unix', what),
    expired: bool(r, 'expired', what),
    unverifiable: bool(r, 'unverifiable', what),
    canConfirm: bool(r, 'can_confirm', what),
  };
}

function parseSeconding(entry: unknown, i: number): SecondingItem {
  const what = `seconding ${i}`;
  const r = asRec(entry, what);
  return {
    grant: str(r, 'grant', what),
    scopeId: optStr(r, 'scope_id', what),
    scopeLabel: str(r, 'scope_label', what),
    subject: str(r, 'subject', what),
    subjectName: str(r, 'subject_name', what),
    keyCode: str(r, 'key_code', what),
    granter: optStr(r, 'granter', what),
    granterName: optStr(r, 'granter_name', what),
    effectiveFromUnix: int(r, 'effective_from_unix', what),
    expiresAtUnix: int(r, 'expires_at_unix', what),
  };
}

export function parseWaiting(bytes: Uint8Array): Waiting {
  const r = jsonObject(bytes, 'waiting');
  return {
    waitingCount: int(r, 'waiting_count', 'waiting'),
    invitations: arrayOf(r, 'invitations', 'waiting').map(parseInvitation),
    seconding: arrayOf(r, 'seconding', 'waiting').map(parseSeconding),
  };
}

export async function fetchWaiting(organisation: string): Promise<Waiting> {
  return parseWaiting(await signedFetch('GET', base(organisation)));
}

async function close(organisation: string, invitation: string, how: 'cancel' | 'refuse'): Promise<void> {
  await signedFetch('POST', `${base(organisation)}/${encodeURIComponent(invitation)}/${how}`);
}

/** Withdraw an invitation, joined or not. Nothing is granted either way. */
export const cancelInvitation = (organisation: string, invitation: string) => close(organisation, invitation, 'cancel');
/** Turn away a person who has joined. */
export const refuseInvitation = (organisation: string, invitation: string) => close(organisation, invitation, 'refuse');

// ---- Confirm ----------------------------------------------------------

/** One row as it is on screen at the moment of confirming, after any Change. */
export interface ConfirmRow {
  invitation: string;
  account: string;
  capability: Asked;
  scopeId: string | null;
  /** The code shown on the row, from the joiner's key. */
  keyCode: string;
}

export interface ProposedItem {
  invitation: string;
  subject: string;
  subjectKeyFpr: string;
  keyCode: string;
  capability: Asked;
  scopeId: string | null;
  effectiveFromUnix: number;
  expiresAtUnix: number;
  authEpoch: number;
  soleSteward: boolean;
  granterKeyFpr: string;
  rootPubkeyFpr: string;
  bytes: string;
}

export interface Proposal {
  headEpoch: number;
  items: ProposedItem[];
}

export function parseProposal(bytes: Uint8Array): Proposal {
  const r = jsonObject(bytes, 'proposal');
  return {
    headEpoch: int(r, 'head_epoch', 'proposal'),
    items: arrayOf(r, 'items', 'proposal').map((entry, i): ProposedItem => {
      const what = `proposal item ${i}`;
      const p: Rec = asRec(entry, what);
      return {
        invitation: str(p, 'invitation', what),
        subject: str(p, 'subject', what),
        subjectKeyFpr: str(p, 'subject_key_fpr', what),
        keyCode: str(p, 'key_code', what),
        capability: oneOf(p, 'capability', CAPABILITIES, what),
        scopeId: optStr(p, 'scope_id', what),
        effectiveFromUnix: int(p, 'effective_from_unix', what),
        expiresAtUnix: int(p, 'expires_at_unix', what),
        authEpoch: int(p, 'auth_epoch', what),
        soleSteward: bool(p, 'sole_steward_appointment', what),
        granterKeyFpr: str(p, 'granter_key_fpr', what),
        rootPubkeyFpr: str(p, 'root_pubkey_fpr', what),
        bytes: str(p, 'bytes', what),
      };
    }),
  };
}

const byId = (a: ConfirmRow, b: ConfirmRow) => (a.invitation < b.invitation ? -1 : a.invitation > b.invitation ? 1 : 0);

/** Rows in the order the server demands: ascending by id. Refuses a shape the
 * server would refuse, before anything is sent. */
export function orderedRows(rows: readonly ConfirmRow[]): ConfirmRow[] {
  if (rows.length < 1) throw new Error('Tick at least one person to confirm.');
  if (rows.length > BATCH_CAP) throw new Error(`One confirm signs at most ${BATCH_CAP} people. Untick some and confirm again.`);
  const sorted = [...rows].sort(byId);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].invitation === sorted[i - 1].invitation) throw new Error('The same invitation is in the list twice.');
  }
  if (sorted.length > 1 && sorted.some((r) => r.capability === 'steward')) {
    throw new Error('A steward request is confirmed on its own, not with others.');
  }
  return sorted;
}

/** Body: `LP(n) n x [LP(invitation) LP(capability) LP(scope or "")]`, and for one
 * steward request `LP(expires_at or "")` once at the end. */
export function buildProposeBody(rows: readonly ConfirmRow[], expiresAtUnix: number | null): Uint8Array {
  const parts: Uint8Array[] = [lp(utf8(String(rows.length)))];
  for (const r of rows) parts.push(lp(utf8(r.invitation)), lp(utf8(r.capability)), lp(utf8(r.scopeId ?? '')));
  if (rows.length === 1 && rows[0].capability === 'steward') {
    parts.push(lp(utf8(expiresAtUnix === null ? '' : String(expiresAtUnix))));
  }
  return concatBytes(...parts);
}

/** A proposal that passed every check, with the bytes this browser built. */
export interface CheckedItem {
  row: ConfirmRow;
  item: ProposedItem;
  bytes: Uint8Array;
}

export interface CheckedProposal {
  organisation: string;
  granter: string;
  items: CheckedItem[];
}

/**
 * Refuse the whole proposal unless it is exactly the rows shown: one item per
 * row in order, the same invitation, person, capability and folder, the subject
 * key behind the code on the row, epochs consecutive from the head, one granter
 * key (this browser's own) and one organisation root across all items, and the
 * grant bytes the same as those built here. Steward items must carry an expiry
 * that is more than a day and at most a year ahead, and nothing else may.
 */
export function checkProposal(
  organisation: string,
  granter: string,
  granterKeyFpr: Uint8Array,
  rows: readonly ConfirmRow[],
  proposal: Proposal,
  nowUnix: number,
  wantedExpiryUnix: number | null,
): CheckedProposal {
  const refuse = (why: string): never => {
    throw new Error(`The server proposed something other than what you ticked (${why}), so nothing was signed.`);
  };
  if (proposal.items.length !== rows.length) refuse('a different number of people');
  if (!Number.isSafeInteger(proposal.headEpoch) || proposal.headEpoch < 0) refuse('no starting epoch');
  const items: CheckedItem[] = [];
  const granterHex = toHex(granterKeyFpr);
  const root = proposal.items[0]?.rootPubkeyFpr;
  rows.forEach((row, i) => {
    const item = proposal.items[i];
    if (item.invitation !== row.invitation) refuse('a different person or order');
    if (item.subject !== row.account) refuse('a different account');
    if (item.capability !== row.capability) refuse('different access');
    if (item.scopeId !== row.scopeId) refuse('a different folder');
    const subjectFpr = fromHexStrict(item.subjectKeyFpr, 'a key fingerprint');
    if (keyCode(subjectFpr) !== row.keyCode || item.keyCode !== row.keyCode) refuse('a different key from the code you were shown');
    if (item.authEpoch !== proposal.headEpoch + 1 + i) refuse('epochs that are not consecutive');
    if (item.granterKeyFpr !== granterHex) refuse('a signing key that is not this browser’s');
    if (item.rootPubkeyFpr !== root) refuse('more than one organisation root');
    if (item.capability === 'steward') {
      if (rows.length !== 1) refuse('a steward request in a batch');
      if (item.expiresAtUnix < nowUnix + DAY_SECONDS || item.expiresAtUnix > nowUnix + STEWARD_DEFAULT_DAYS * DAY_SECONDS + 300) {
        refuse('an expiry outside one day to one year');
      }
      if (wantedExpiryUnix !== null && item.expiresAtUnix !== wantedExpiryUnix) refuse('a different expiry');
    } else if (item.expiresAtUnix !== 0 || item.soleSteward) {
      refuse('an expiry on a read or draw grant');
    }
    const bytes = grantBytes({
      organisation,
      rootPubkeyFpr: fromHexStrict(item.rootPubkeyFpr, 'a root fingerprint'),
      scope: item.scopeId ?? '',
      subject: item.subject,
      subjectKeyFpr: subjectFpr,
      capability: item.capability,
      granter,
      granterKeyFpr,
      effectiveFromUnix: item.effectiveFromUnix,
      expiresAtUnix: item.expiresAtUnix,
      soleSteward: item.soleSteward,
      authEpoch: item.authEpoch,
    });
    if (!sameBytes(bytes, fromHexStrict(item.bytes, 'grant bytes'))) refuse('grant bytes that are not the ones you chose');
    items.push({ row, item, bytes });
  });
  return { organisation, granter, items };
}

function fromHexStrict(hex: string, what: string): Uint8Array {
  if (!/^([0-9a-f]{2})+$/.test(hex)) throw new Error(`The server sent ${what} that is not hex, so nothing was signed.`);
  return fromHex(hex);
}

/** Ask the server what the confirm would sign, check it against the rows, and
 * hand back what is about to be signed. Writes nothing on the server. */
export async function proposeConfirm(
  organisation: string,
  rows: readonly ConfirmRow[],
  expiresAtUnix: number | null = null,
): Promise<CheckedProposal> {
  const ordered = orderedRows(rows);
  const granter = getSession()?.accountId;
  if (!granter) throw new NoSigningKeyHere();
  const granterKeyFpr = await ownKeyFingerprint();
  const proposal = parseProposal(
    await signedFetch('POST', `${base(organisation)}/confirm/propose`, buildProposeBody(ordered, expiresAtUnix)),
  );
  return checkProposal(organisation, granter, granterKeyFpr, ordered, proposal, Math.floor(Date.now() / 1000), expiresAtUnix);
}

export interface ConfirmedItem {
  invitation: string;
  account: string;
  grant: string;
  capability: Asked;
  scopeId: string | null;
  effectiveFromUnix: number;
  needsSecond: boolean;
}

export interface ConfirmResult {
  batchId: string;
  confirmed: ConfirmedItem[];
}

export function parseConfirmResult(bytes: Uint8Array): ConfirmResult {
  const r = jsonObject(bytes, 'confirm');
  return {
    batchId: str(r, 'batch_id', 'confirm'),
    confirmed: arrayOf(r, 'confirmed', 'confirm').map((entry, i): ConfirmedItem => {
      const what = `confirmed item ${i}`;
      const c = asRec(entry, what);
      return {
        invitation: str(c, 'invitation', what),
        account: str(c, 'account', what),
        grant: str(c, 'grant', what),
        capability: oneOf(c, 'capability', CAPABILITIES, what),
        scopeId: optStr(c, 'scope_id', what),
        effectiveFromUnix: int(c, 'effective_from_unix', what),
        needsSecond: bool(c, 'needs_second', what),
      };
    }),
  };
}

/** Body of the confirm: each item with its own signature. The subject is never in it. */
export function buildConfirmBody(items: readonly { item: ProposedItem; signature: Uint8Array }[]): Uint8Array {
  const parts: Uint8Array[] = [lp(utf8(String(items.length)))];
  for (const { item, signature } of items) {
    parts.push(
      lp(utf8(item.invitation)),
      lp(utf8(item.capability)),
      lp(utf8(item.scopeId ?? '')),
      lp(utf8(String(item.effectiveFromUnix))),
      lp(utf8(String(item.authEpoch))),
      lp(utf8(String(item.expiresAtUnix))),
      lp(utf8(item.granterKeyFpr)),
      lp(utf8(item.subjectKeyFpr)),
      lp(utf8(item.rootPubkeyFpr)),
      lp(utf8(toHex(signature))),
    );
  }
  return concatBytes(...parts);
}

/** Sign every grant of a checked proposal with this browser's key and send them
 * together. All of them are recorded or none are. */
export async function signAndConfirm(checked: CheckedProposal): Promise<ConfirmResult> {
  const key = await signingKey();
  const signed: { item: ProposedItem; signature: Uint8Array }[] = [];
  for (const c of checked.items) signed.push({ item: c.item, signature: await signMessage(key, c.bytes) });
  return parseConfirmResult(await signedFetch('POST', base(checked.organisation) + '/confirm', buildConfirmBody(signed)));
}

// ---- Words for what the server refused -------------------------------

const BATCH_REASON: Record<string, string> = {
  stale: 'Something changed while you were looking. Nothing was signed; review and confirm again.',
  not_waiting: 'One of these people is no longer waiting (confirmed, refused or withdrawn). Nothing was signed.',
  window_closed: 'One of these people joined more than 14 days ago, so they can no longer be confirmed. Nothing was signed.',
  key_changed: 'One of these people’s keys changed after they joined, so they were not confirmed. Nothing was signed.',
  membership_exists: 'One of these people is already in the organisation. Nothing was signed.',
  not_authorised: 'You are not a steward where one of these people was asked to join. Nothing was signed.',
  bad_signature: 'A signature did not check out. Nothing was signed.',
  unverifiable: 'One of these invitations could not be verified, so nothing was signed.',
};

/** Plain words for a failure on these screens. The server's own sentence where
 * it gave one; a batch refusal turned into what it means and what happened. */
export function describeError(error: unknown): string {
  if (error instanceof ApiRefusal) {
    if (error.message.startsWith('{')) {
      try {
        const body = JSON.parse(error.message) as Rec;
        if (body.error === 'batch_refused' && typeof body.reason === 'string') {
          return BATCH_REASON[body.reason] ?? 'The server refused the batch. Nothing was signed.';
        }
      } catch {
        // not JSON after all: the sentence below
      }
    }
    if (error.status === 403) return 'Only a steward can do that here. The server refused.';
    if (error.status === 429) {
      return error.retryAfterSeconds != null
        ? `Too many invitations just now. Try again in ${Math.ceil(error.retryAfterSeconds / 60)} minutes.`
        : 'There are too many open invitations. Cancel some, or wait for them to be confirmed.';
    }
    return error.retryAfterSeconds != null ? `${error.message} Try again in ${error.retryAfterSeconds}s.` : error.message;
  }
  if (error instanceof Error) return error.message;
  return 'That request did not complete.';
}
