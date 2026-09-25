// The operator console's calls: `crates/fathom-server/src/admin.rs`'s
// router, one function per verb this board offers, each assembling and
// reading exactly the bytes that file's doc comments give and nothing
// else. Every call goes through `signedFetch`, so an operator session
// (`../state/sessionState.ts`, `kind: 'operator'`) is what makes any of
// them possible; the server refuses a steward session on all of them
// (`operators.rs`'s `acting_operator`).
//
// Since ADR-0055 the assertion-carrying verbs are here too: a colleague
// (`POST /admin/operators`) and a settings change (`POST /admin/settings`)
// are each signed by the operator's ENROLLED key over bytes `operators.rs`
// defines, and `api/placement.ts` holds the two things that needs -- the
// deployment id and the key itself. What is still NOT here: the seconding
// half of either verb (a sole operator's request applies on the delay alone,
// `min(2, live)`), and any route that lists accounts, so this board still
// shows only the accounts it created itself in this session.

import { concatBytes, lp, readLp, readU64LE, utf8 } from '../crypto/bytes';
import { ApiRefusal } from './errors';
import { deploymentId, signOperatorAssertion } from './placement';
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

/**
 * `POST /admin/organisations`'s answer: an invitation plus the deployment's
 * notice address the claim is pinned to.
 */
export interface OrganisationClaim extends Invitation {
  noticeAddress: string;
}

/** `LP(shell) ‖ LP(token) ‖ LP(token_id) ‖ u64(expires_at) ‖ LP(notice_address)`, as `admin.rs`'s `create_organisation_shell` builds it. */
export function parseOrganisationClaimAnswer(bytes: Uint8Array): OrganisationClaim {
  const { value: subjectBytes, rest: afterSubject } = readLp(bytes);
  const { value: token, rest: afterToken } = readLp(afterSubject);
  const { value: tokenIdBytes, rest: afterTokenId } = readLp(afterToken);
  if (afterTokenId.length < 8) {
    throw new Error('malformed organisation claim answer: no expiry');
  }
  const expiresAtUnix = Number(readU64LE(afterTokenId));
  const { value: noticeAddressBytes, rest } = readLp(afterTokenId.slice(8));
  if (rest.length !== 0) {
    throw new Error(`malformed organisation claim answer: ${rest.length} trailing byte(s)`);
  }
  if (token.length !== 32) {
    throw new Error(`malformed organisation claim answer: a ${token.length}-byte token`);
  }
  return {
    subject: new TextDecoder().decode(subjectBytes),
    token,
    tokenId: new TextDecoder().decode(tokenIdBytes),
    expiresAtUnix,
    noticeAddress: new TextDecoder().decode(noticeAddressBytes),
  };
}

/** `POST /admin/organisations`: `LP(display_name)`; answers the shell id, claim
 * token, and notice address. `redeemOrganisationClaim` turns the claim into an organisation. */
export async function createOrganisationShell(displayName: string): Promise<OrganisationClaim> {
  const bytes = await signedFetch('POST', '/admin/organisations', lp(utf8(displayName)));
  return parseOrganisationClaimAnswer(bytes);
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
  /** ADR-0055 decision 5: an operator has an address of record now -- where
   * their notices go and the name they sign in to their ACCOUNT with. `null`
   * for a row written before the binding existed (`-` on the wire). */
  address: string | null;
}

/**
 * `list_operators`'s answer: one line per operator,
 * `id display_name created_by never_independently_signed_in disabled address`,
 * space-separated and unquoted -- so a display name with spaces in it is
 * read from both ends: the id is the first word, the last four words are the
 * address, the two flags and `created_by`, and everything between is the
 * name.
 *
 * **Six fields, not five, since ADR-0055 stream (b)** appended the address
 * (`admin.rs`'s `list_operators`). A five-field line is refused rather than
 * read as a six-field one with a missing address: the flags are positional,
 * and a parser that shrugged at a short line would report `disabled` off
 * `never_signed_in`.
 */
export function parseOperatorList(text: string): OperatorRow[] {
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      const words = line.trim().split(' ');
      if (words.length < 6) {
        throw new Error(`malformed /admin/operators line ${index + 1}: fewer than six fields`);
      }
      const [id, ...rest] = words;
      const address = rest.pop()!;
      const disabled = parseFlag(rest.pop()!, 'disabled', index);
      const never = parseFlag(rest.pop()!, 'never_independently_signed_in', index);
      const createdBy = rest.pop()!;
      return {
        id,
        displayName: rest.join(' '),
        createdBy: createdBy === '-' ? null : createdBy,
        neverIndependentlySignedIn: never,
        disabled,
        address: address === '-' ? null : address,
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

// ---------------------------------------------------------------------------
// ADR-0055 decisions 4 and 8 -- the standing notices
// ---------------------------------------------------------------------------

/**
 * One line of `GET /admin/notices`, LP-framed, derived by the server from
 * the chain and the register and stored nowhere (`operators::notices`):
 *
 * - `one_operator <live_independent> <weeks_since_install>` -- decision 4's
 *   standing banner, which escalates weekly and never blocks work.
 * - `recovered_from_host <at_unix> <until_unix>` -- decision 8's seven-day
 *   banner after `fathom-server recover-operator`.
 *
 * A line this client does not know is carried through as `unknown` with its
 * text intact rather than dropped: a notice nobody shows is a notice nobody
 * gets, and a client that silently swallowed one the server thought was
 * important would be the worst of the two failures.
 */
export type Notice =
  | { kind: 'one_operator'; live: number; weeks: number; line: string }
  | { kind: 'recovered_from_host'; atUnix: number; untilUnix: number; line: string }
  | { kind: 'unknown'; line: string };

export function parseNotices(bytes: Uint8Array): Notice[] {
  const decoder = new TextDecoder();
  const out: Notice[] = [];
  let rest = bytes;
  while (rest.length > 0) {
    const read = readLp(rest);
    rest = read.rest;
    const line = decoder.decode(read.value);
    const words = line.trim().split(/\s+/);
    if (words[0] === 'one_operator' && words.length >= 3) {
      out.push({ kind: 'one_operator', live: Number(words[1]), weeks: Number(words[2]), line });
    } else if (words[0] === 'recovered_from_host' && words.length >= 3) {
      out.push({
        kind: 'recovered_from_host',
        atUnix: Number(words[1]),
        untilUnix: Number(words[2]),
        line,
      });
    } else {
      out.push({ kind: 'unknown', line });
    }
  }
  return out;
}

export async function fetchNotices(): Promise<Notice[]> {
  return parseNotices(await signedFetch('GET', '/admin/notices'));
}

// ---------------------------------------------------------------------------
// The two-assertion verbs: a colleague, and a setting
// ---------------------------------------------------------------------------

/** Both assertion-carrying verbs answer `LP(id) ‖ u64(effective_at)`
 * (`admin.rs`'s `pending_response`): the row, and when it takes effect. */
export interface PendingChange {
  id: string;
  effectiveAtUnix: number;
}

export function parsePendingAnswer(bytes: Uint8Array): PendingChange {
  const { value: idBytes, rest } = readLp(bytes);
  if (rest.length !== 8) {
    throw new Error(`malformed pending answer: ${rest.length} byte(s) where u64(effective_at) belongs`);
  }
  return { id: new TextDecoder().decode(idBytes), effectiveAtUnix: Number(readU64LE(rest)) };
}

/**
 * `operators::operator_request_bytes`:
 * `LP("fathom/site/operator/request/v1") ‖ LP(deployment) ‖ LP(operator)
 *  ‖ LP(display_name) ‖ LP(address)`.
 *
 * The address is inside the assertion as well as in the body (ADR-0055
 * decision 5): the operator signs **where the invitation goes**.
 */
export function operatorRequestBytes(
  deployment: string,
  operator: string,
  displayName: string,
  address: string,
): Uint8Array {
  return concatBytes(
    lp(utf8('fathom/site/operator/request/v1')),
    lp(utf8(deployment)),
    lp(utf8(operator)),
    lp(utf8(displayName)),
    lp(utf8(address)),
  );
}

/** `POST /admin/operators`: `LP(display_name) ‖ LP(address) ‖ LP(assertion)`. */
export function buildOperatorRequestBody(
  displayName: string,
  address: string,
  assertion: Uint8Array,
): Uint8Array {
  return concatBytes(lp(utf8(displayName)), lp(utf8(address)), lp(assertion));
}

/**
 * Ask for a colleague. With one live operator the quorum is `min(2, live)`
 * = 1 (decision 3), so this request stands alone -- and still waits out the
 * 24-hour delay, which is what `effectiveAtUnix` says.
 */
export async function requestOperator(
  actingOperatorId: string,
  displayName: string,
  address: string,
): Promise<PendingChange> {
  const deployment = await deploymentId(actingOperatorId);
  const assertion = await signOperatorAssertion(
    actingOperatorId,
    operatorRequestBytes(deployment, actingOperatorId, displayName, address),
  );
  return parsePendingAnswer(
    await signedFetch('POST', '/admin/operators', buildOperatorRequestBody(displayName, address, assertion)),
  );
}

/** `POST /admin/operators/{operator}/disabled`, empty body. There is no
 * re-enable route: §4.5 re-enrols an operator through §5.4's machinery. */
export async function disableOperator(operatorId: string): Promise<void> {
  await signedFetch('POST', `/admin/operators/${encodeURIComponent(operatorId)}/disabled`);
}

/**
 * `operators::setting_request_bytes`:
 * `LP("fathom/site/setting/request/v1") ‖ LP(deployment) ‖ LP(operator)
 *  ‖ LP(key) ‖ LP(SHA-256(value))`.
 *
 * The **digest** of the value, not the value: an SMTP password does not go
 * through a signature input any more than it goes through a log.
 */
export async function settingRequestBytes(
  deployment: string,
  operator: string,
  key: string,
  value: Uint8Array,
): Promise<Uint8Array> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', value as BufferSource));
  return concatBytes(
    lp(utf8('fathom/site/setting/request/v1')),
    lp(utf8(deployment)),
    lp(utf8(operator)),
    lp(utf8(key)),
    lp(digest),
  );
}

/** `POST /admin/settings`: `LP(key) ‖ LP(value) ‖ LP(assertion)`. */
export function buildSettingBody(key: string, value: Uint8Array, assertion: Uint8Array): Uint8Array {
  return concatBytes(lp(utf8(key)), lp(value), lp(assertion));
}

/** The `smtp` value envelope, sealed under the site settings key before it
 * is stored: `LP(host) ‖ LP(port as text) ‖ LP(tls_mode) ‖ LP(user) ‖
 * LP(password) ‖ LP(from_address)` (`placement::smtp_value_bytes`). */
export type SmtpTlsMode = 'starttls' | 'implicit' | 'none';

export interface SmtpSettings {
  host: string;
  port: number;
  tlsMode: SmtpTlsMode;
  user: string;
  password: string;
  fromAddress: string;
}

export function smtpValueBytes(settings: SmtpSettings): Uint8Array {
  return concatBytes(
    lp(utf8(settings.host)),
    lp(utf8(String(settings.port))),
    lp(utf8(settings.tlsMode)),
    lp(utf8(settings.user)),
    lp(utf8(settings.password)),
    lp(utf8(settings.fromAddress)),
  );
}

/** Request a settings change. The first `smtp` version applies at once and
 * every later one takes the delay (decision 11); either way the answer says
 * when, and the board shows that rather than guessing. */
export async function requestSetting(
  actingOperatorId: string,
  key: string,
  value: Uint8Array,
): Promise<PendingChange> {
  const deployment = await deploymentId(actingOperatorId);
  const assertion = await signOperatorAssertion(
    actingOperatorId,
    await settingRequestBytes(deployment, actingOperatorId, key, value),
  );
  return parsePendingAnswer(
    await signedFetch('POST', '/admin/settings', buildSettingBody(key, value, assertion)),
  );
}

export async function requestSmtpSetting(
  actingOperatorId: string,
  settings: SmtpSettings,
): Promise<PendingChange> {
  return requestSetting(actingOperatorId, 'smtp', smtpValueBytes(settings));
}

/**
 * `POST /admin/settings/{change}/test-send`, empty body.
 *
 * **There is no mail client in this build**, so the honest answer is the
 * server's own: a 503 and one sentence. It is returned rather than thrown,
 * because it is not a failure of the form -- it is what the product does
 * today, and the board says so in the server's words rather than in a
 * cheerful one of its own.
 */
export async function sendTestMessage(changeId: string): Promise<string> {
  try {
    await signedFetch('POST', `/admin/settings/${encodeURIComponent(changeId)}/test-send`);
    return 'The server accepted the test send.';
  } catch (error) {
    if (error instanceof ApiRefusal && error.status === 503) {
      return error.message;
    }
    throw error;
  }
}
