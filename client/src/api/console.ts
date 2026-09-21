// The operator console's calls: `crates/fathom-server/src/admin.rs`'s
// router, one function per verb this board offers, each assembling and
// reading exactly the bytes that file's doc comments give and nothing
// else. Every call goes through `signedFetch`, so an operator session
// (`../state/sessionState.ts`, `kind: 'operator'`) is what makes any of
// them possible; the server refuses a steward session on all of them
// (`operators.rs`'s `acting_operator`).
//
// What is NOT here, and why: the two-person verbs (`POST /admin/operators`,
// `POST /admin/settings` and their seconds) each carry an assertion signed
// by the operator's ENROLLED key over bytes `operators.rs` defines
// (`operator_request_bytes`, `setting_request_bytes`), which this client
// does not build yet; and there is no route that lists accounts, so this
// board can show only the accounts it created itself in this session.

import { concatBytes, lp, readLp, readU64LE, utf8 } from '../crypto/bytes';
import { signedFetch } from './signedFetch';

/**
 * What every invitation-minting verb answers
 * (`admin.rs`'s `invitation_response`): `LP(subject) ‖ LP(token) ‖
 * LP(token_id) ‖ u64(expires_at)`. `subject` is the account for an
 * account invitation and the shell id for an organisation claim.
 *
 * **The token is answered once and never again** -- the server stores its
 * hash. It is shown on the board once, to be handed over out of band
 * (nothing is emailed: `docs/RUNNING-IT.md`), and is held in component
 * state only.
 */
export interface Invitation {
  subject: string;
  token: Uint8Array;
  tokenId: string;
  expiresAtUnix: number;
}

export function parseInvitationAnswer(bytes: Uint8Array): Invitation {
  const { value: subjectBytes, rest: afterSubject } = readLp(bytes);
  const { value: token, rest: afterToken } = readLp(afterSubject);
  const { value: tokenIdBytes, rest: afterTokenId } = readLp(afterToken);
  if (afterTokenId.length < 8) {
    throw new Error('malformed invitation answer: no expiry');
  }
  const expiresAtUnix = Number(readU64LE(afterTokenId));
  if (afterTokenId.length !== 8) {
    throw new Error(`malformed invitation answer: ${afterTokenId.length - 8} trailing byte(s)`);
  }
  if (token.length !== 32) {
    throw new Error(`malformed invitation answer: a ${token.length}-byte token`);
  }
  return {
    subject: new TextDecoder().decode(subjectBytes),
    token,
    tokenId: new TextDecoder().decode(tokenIdBytes),
    expiresAtUnix,
  };
}

/** `POST /admin/accounts`: `LP(address) ‖ LP(display_name)`. */
export function buildAccountShellBody(address: string, displayName: string): Uint8Array {
  return concatBytes(lp(utf8(address)), lp(utf8(displayName)));
}

/** §1.1's *"create an account shell (email, display name)"*, which also
 * mints that account's first invitation. */
export async function createAccountShell(address: string, displayName: string): Promise<Invitation> {
  const bytes = await signedFetch('POST', '/admin/accounts', buildAccountShellBody(address, displayName));
  return parseInvitationAnswer(bytes);
}

/** `POST /admin/accounts/{account}/enrolment`, empty body: a fresh
 * invitation for an existing account, which is also §5.1's reset. The
 * account is named in the path only -- there is deliberately no
 * destination field (`admin.rs`). */
export async function issueAccountEnrolment(accountId: string): Promise<Invitation> {
  const bytes = await signedFetch('POST', `/admin/accounts/${encodeURIComponent(accountId)}/enrolment`);
  return parseInvitationAnswer(bytes);
}

/** `POST /admin/accounts/{account}/disabled`: `LP("yes" | "no")`. */
export async function setAccountDisabled(accountId: string, disabled: boolean): Promise<void> {
  await signedFetch(
    'POST',
    `/admin/accounts/${encodeURIComponent(accountId)}/disabled`,
    lp(utf8(disabled ? 'yes' : 'no')),
  );
}

/** `POST /admin/organisations`: `LP(display_name)`; answers the shell id,
 * then the claim token exactly as an invitation. `redeem_organisation_claim`
 * (`operators.rs`) is the act that would turn the claim into an
 * organisation, and **no route reaches it in this build** -- `admin.rs`
 * says so, and so does the board. */
export async function createOrganisationShell(displayName: string): Promise<Invitation> {
  const bytes = await signedFetch('POST', '/admin/organisations', lp(utf8(displayName)));
  return parseInvitationAnswer(bytes);
}

/** One row of `GET /admin/operators`, with §5.5's sentence beside it. */
export interface OperatorRow {
  id: string;
  displayName: string;
  /** The operator who requested this one, or `null` for the first
   * operator, whom nobody created (`-` on the wire). */
  createdBy: string | null;
  neverIndependentlySignedIn: boolean;
  disabled: boolean;
}

/**
 * `list_operators`'s answer: one line per operator,
 * `id display_name created_by never_independently_signed_in disabled`,
 * space-separated and unquoted -- so a display name with spaces in it is
 * read from both ends: the id is the first word, the last three words are
 * the two flags and `created_by`, and everything between is the name.
 */
export function parseOperatorList(text: string): OperatorRow[] {
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      const words = line.trim().split(' ');
      if (words.length < 5) {
        throw new Error(`malformed /admin/operators line ${index + 1}: fewer than five fields`);
      }
      const [id, ...rest] = words;
      const disabled = parseFlag(rest.pop()!, 'disabled', index);
      const never = parseFlag(rest.pop()!, 'never_independently_signed_in', index);
      const createdBy = rest.pop()!;
      return {
        id,
        displayName: rest.join(' '),
        createdBy: createdBy === '-' ? null : createdBy,
        neverIndependentlySignedIn: never,
        disabled,
      };
    });
}

function parseFlag(word: string, what: string, index: number): boolean {
  if (word === 'true') return true;
  if (word === 'false') return false;
  throw new Error(`malformed /admin/operators line ${index + 1}: ${what} is ${JSON.stringify(word)}`);
}

export async function listOperators(): Promise<OperatorRow[]> {
  const bytes = await signedFetch('GET', '/admin/operators');
  return parseOperatorList(new TextDecoder().decode(bytes));
}

export interface OrganisationRow {
  id: string;
  displayName: string;
}

/** `list_organisations`'s answer: `id name` per line; the name is
 * everything after the first space. */
export function parseOrganisationList(text: string): OrganisationRow[] {
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const trimmed = line.trim();
      const space = trimmed.indexOf(' ');
      return space === -1
        ? { id: trimmed, displayName: '' }
        : { id: trimmed.slice(0, space), displayName: trimmed.slice(space + 1) };
    });
}

export async function listOrganisations(): Promise<OrganisationRow[]> {
  const bytes = await signedFetch('GET', '/admin/organisations/list');
  return parseOrganisationList(new TextDecoder().decode(bytes));
}
