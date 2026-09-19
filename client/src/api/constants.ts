// The five headers a signed request carries, named once here rather than
// inline so this file and `crates/fathom-server/src/api.rs`'s own
// `HEADER_*` block have exactly one list each to agree on.
export const HEADER_SESSION = 'fathom-session';
export const HEADER_TOKEN = 'fathom-session-token';
export const HEADER_NONCE = 'fathom-nonce';
export const HEADER_TIMESTAMP = 'fathom-timestamp';
export const HEADER_COUNTER = 'fathom-counter';
export const HEADER_SIGNATURE = 'fathom-signature';

/** `sessions::PrincipalKind::Steward`. The only plane this client signs into
 * -- `sessions.rs` refuses every operator attempt for want of an
 * authenticator (`SessionError::OperatorHasNoAuthenticator`), so there is no
 * second value this screen could offer that would ever succeed. */
export const PRINCIPAL_KIND_STEWARD = 'steward';
