// The five headers a signed request carries, named once here rather than
// inline so this file and `crates/fathom-server/src/api.rs`'s own
// `HEADER_*` block have exactly one list each to agree on.
export const HEADER_SESSION = 'fathom-session';
export const HEADER_TOKEN = 'fathom-session-token';
export const HEADER_NONCE = 'fathom-nonce';
export const HEADER_TIMESTAMP = 'fathom-timestamp';
export const HEADER_COUNTER = 'fathom-counter';
export const HEADER_SIGNATURE = 'fathom-signature';

/** `sessions::PrincipalKind`, as `POST /session/challenge` and
 * `POST /session` spell it in their first field. Two planes, two doors:
 * an account signs in as a steward at its address; an operator signs in
 * with the operator id `POST /enrolment/operator` handed back when their
 * key was enrolled (`sessions::operator_by_id` -- *"handed to them once at
 * enrolment"*). Until 2026-09-21 this client offered the steward plane
 * only, on the strength of a comment saying the server refused every
 * operator attempt -- true before migration `0015`, and not since. */
export type PrincipalKind = 'steward' | 'operator';
export const PRINCIPAL_KIND_STEWARD: PrincipalKind = 'steward';
export const PRINCIPAL_KIND_OPERATOR: PrincipalKind = 'operator';

/**
 * Where `../crypto/keys.ts` keeps a principal's key: an account's under its
 * address, exactly as before; an operator's under `operator:` and the
 * operator id. The two planes never share a slot because an operator id is
 * a ULID (`looksLikeOperatorId`) and `identityOfSlot` reads a slot as an
 * operator's only when what follows the prefix is one -- an address that
 * happens to be spelled `operator:…` stays an address. The prefix, not a
 * separate store, because the two-store pending/enrolled promotion in
 * `keys.ts` is what makes an enrolment safe and it is keyed by this one
 * string.
 */
export function keySlot(kind: PrincipalKind, id: string): string {
  return kind === PRINCIPAL_KIND_OPERATOR ? `operator:${id}` : id;
}

/**
 * The pending slot an operator's key waits in *before* the server has said
 * which operator it enrolled: `POST /enrolment/operator` takes no operator
 * id (the token names the operator) and answers with it, so unlike an
 * account's key there is no id to file the pending key under until the
 * answer is read. One sentinel slot, promoted to `keySlot('operator', id)`
 * on a confirmed answer; `signIn` falls back to it for an operator whose
 * enrolment outcome could not be confirmed (`../api/enrolment.ts`).
 */
export const OPERATOR_PENDING_SLOT = 'operator:?';

/** The two halves of a key slot, read back: which plane, and the address
 * or operator id. The inverse of [`keySlot`]. */
export interface SlotIdentity {
  kind: PrincipalKind;
  id: string;
}

export function identityOfSlot(slot: string): SlotIdentity {
  if (slot === OPERATOR_PENDING_SLOT) {
    return { kind: PRINCIPAL_KIND_OPERATOR, id: '?' };
  }
  const rest = slot.startsWith('operator:') ? slot.slice('operator:'.length) : null;
  return rest !== null && looksLikeOperatorId(rest)
    ? { kind: PRINCIPAL_KIND_OPERATOR, id: rest }
    : { kind: PRINCIPAL_KIND_STEWARD, id: slot };
}

/** An operator id is a ULID: 26 characters of Crockford base32
 * (`crates/fathom-server/src/ids.rs`). The one shape an address can never
 * take, which is what lets sign-in try the operator plane for it without
 * being told to. */
export function looksLikeOperatorId(text: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(text);
}
