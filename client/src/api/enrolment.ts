// The enrolment flow: `POST /enrolment/account`. `crates/fathom-server/src/
// admin.rs`'s `redeem_account` doc comment gives the exact body and answer
// shapes; `crates/fathom-server/src/operators.rs`'s
// `redeem_account_enrolment` gives what is checked and the one refusal every
// cause produces. This module assembles and reads exactly those bytes and
// nothing else.

import { concatBytes, fromHex, lp, readLp, utf8 } from '../crypto/bytes';
import { exportPublicKeyRaw, generateSessionKeyPair, putEnrolledKeyPair } from '../crypto/keys';
import { refusalFrom } from './errors';

/**
 * Thrown when the pasted token is not 32 bytes of hex.
 *
 * **Not a server refusal.** The server never sees a token that fails this
 * check -- it is this screen's own format check on what was typed, the same
 * shape `crates/fathom-server/src/main.rs`'s `write_bootstrap_token` writes
 * an enrolment token as (`format!("{byte:02x}")` for each of 32 bytes,
 * "so an operator can read it out of a terminal without a hex dump"). It is
 * kept distinct from [`../api/errors.ts`]'s `ApiRefusal` so this screen never
 * reports a local typo as if the server had refused something.
 */
export class MalformedTokenError extends Error {
  constructor() {
    super('That does not look like an invitation token: paste the 64-character code as given.');
    this.name = 'MalformedTokenError';
  }
}

const TOKEN_HEX_RE = /^[0-9a-f]{64}$/;

/** Parse a pasted token into the 32 raw bytes the wire body carries. Accepts
 * surrounding whitespace and either case, since a person copying a token out
 * of an email or a terminal may pick either up. */
export function parseToken(input: string): Uint8Array {
  const trimmed = input.trim().toLowerCase();
  if (!TOKEN_HEX_RE.test(trimmed)) {
    throw new MalformedTokenError();
  }
  return fromHex(trimmed);
}

/**
 * Frame the redemption request body, byte for byte what `admin.rs`'s
 * `redeem_account` reads with `read_fields(&body, 3)`: `LP(token) ‖
 * LP(address) ‖ LP(public_key)`, in that order, and nothing after the third
 * field -- a body carrying a fourth is refused (`admin.rs`'s `read_fields`
 * doc comment) rather than having it quietly ignored. Exported on its own so
 * a test can check this framing without a network call or an IndexedDB.
 */
export function buildRedeemAccountBody(token: Uint8Array, address: string, publicKey: Uint8Array): Uint8Array {
  return concatBytes(lp(token), lp(utf8(address)), lp(publicKey));
}

/**
 * Read the answer: `LP(key_id)`, and nothing else -- what `admin.rs`'s
 * `redeem_account` sends back (`crypto::lp(&mut out, key.as_bytes())` over
 * the `String` `operators.rs`'s `redeem_account_enrolment` returns).
 * Exported on its own for the same reason as `buildRedeemAccountBody`.
 */
export function parseRedeemAccountResponse(bytes: Uint8Array): string {
  const { value: keyIdBytes } = readLp(bytes);
  return new TextDecoder().decode(keyIdBytes);
}

/**
 * Redeem an account's invitation token: generate this browser's account
 * keypair -- non-extractable, generated here, its private half never
 * exported (`../crypto/keys.ts`) -- enrol its public half against the
 * account the token names, and store the keypair in this browser under
 * `address` so `signIn` (`./auth.ts`) can use it right away.
 *
 * Body: `LP(token) ‖ LP(address) ‖ LP(public_key)`, byte for byte what
 * `admin.rs`'s `redeem_account` reads with `read_fields(&body, 3)` and what
 * `operators.rs`'s `redeem_account_enrolment(token, address, public_key)`
 * takes in that order -- the token as the raw 32 bytes, the address as
 * UTF-8, the public key as the SEC1 uncompressed point `exportPublicKeyRaw`
 * already produces for a sign-in session key.
 *
 * Every refusal the server can give here is
 * [`OperatorError::EnrolmentRefused`] -- **one message for a token that was
 * never issued, one already redeemed, one past its expiry, and one
 * presented with the wrong address alike** (`operators.rs`'s doc comment on
 * `redeem_account_enrolment`, restated on the error variant itself) -- so
 * this function does not try to tell those apart. It throws the server's own
 * `ApiRefusal` (`./errors.ts`) unchanged, the same class `signIn` throws.
 *
 * Returns the enrolled key's id, `LP`-decoded from the answer and otherwise
 * unused by this client today.
 */
export async function redeemAccountEnrolment(token: Uint8Array, address: string): Promise<string> {
  const keyPair = await generateSessionKeyPair();
  const publicKey = await exportPublicKeyRaw(keyPair.publicKey);

  const body = buildRedeemAccountBody(token, address, publicKey);
  const response = await fetch('/enrolment/account', {
    method: 'POST',
    body: body as BodyInit,
  });
  if (!response.ok) {
    throw await refusalFrom(response);
  }

  const out = new Uint8Array(await response.arrayBuffer());
  const keyId = parseRedeemAccountResponse(out);

  // The token is spent server-side the instant this response is OK
  // (`operators.rs`: the guarded `UPDATE` and the key enrolment commit in
  // the same transaction). Storing the new key only after that response is
  // read means a caller of this function never has a locally-stored key
  // this browser cannot yet sign in with.
  await putEnrolledKeyPair(address, keyPair);

  return keyId;
}
