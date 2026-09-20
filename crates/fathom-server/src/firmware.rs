//! Firmware staging: Fathom accepts an image, proves it is whole, and serves
//! it **once** to a network device that comes and fetches it.
//!
//! `docs/decisions/adr-0045-firmware-moves-by-the-device-pulling-not-fathom-pushing.md`
//! is the brief — §4 the decision, §6 the traps, §8 the consequences.
//! `docs/UPGRADING-A-JUNIPER.md` is the operator-facing procedure whose steps
//! this module renders back with the real hash substituted in.
//! `migrations/0017_firmware_staging.sql` holds the tables and the reasoning
//! about them. `src/design_api.rs` is the module shape this follows: its own
//! state, its own `Signed`, its own router, and `api::router` untouched.
//!
//! # The line this module does not cross
//!
//! **Fathom never connects to a device, never holds a device credential, never
//! runs an upgrade and never modifies a device's configuration.** There is no
//! outbound socket in this file, no column in `0017` a credential could arrive
//! in, and no code path that names a device at all. The device is on the other
//! end of one inbound `GET`, and what it collects is a public vendor artefact.
//! CLAUDE.md rule 4 is untouched: no credential arrives, so none is stored.
//!
//! # Why this is four routes and not one upload
//!
//! A Junos image is one to two gigabytes, and a per-request signature covers a
//! digest of the body — so a signed upload would have to buffer the whole
//! image in memory before the signature that might refuse it had been checked.
//! That is not acceptable, so the act is split:
//!
//! 1. **Declare** (signed, `steward`): the filename, the byte length and the
//!    SHA-256 the caller says the image has. Small, signed, and it mints a
//!    single-use upload token.
//! 2. **Send the bytes** (the upload token, no signature): streamed straight to
//!    disk, hashed as it is written, never held whole in memory. At the end the
//!    computed hash and the byte count are compared against the declaration,
//!    and **on any mismatch the partial file is deleted and the upload is
//!    refused** — trap 2 of `docs/UPGRADING-A-JUNIPER.md`, and the whole reason
//!    this feature exists.
//! 3. **Issue a fetch URL** (signed, `steward`): a 256-bit, single-use,
//!    short-lived URL bound to one image, with a sealed entry when it is issued
//!    and another when it is redeemed.
//! 4. **Read back** (signed, `read`): what is staged, with the hash Fathom
//!    computed, and the operator commands with that hash already in them.
//!
//! # The hash this server reports is never the one it was told
//!
//! `firmware_images.declared_sha256` is the claim and is never rendered to
//! anybody. `computed_sha256` is written by exactly one statement, in
//! [`finish_upload`], from a `Sha256` that was fed the bytes as they went to
//! disk. A declaration that lies therefore cannot produce a staged image at
//! all: the comparison fails, the file is deleted and the row goes to `failed`.
//! `tests/firmware.rs` proves it with a declaration that lies.
//!
//! # The fetch URL is a credential, and is treated as one
//!
//! A switch cannot sign a request. ADR-0045 §4.2 therefore makes the URL the
//! authorisation, so it is 256 bits from the kernel CSPRNG, single-use,
//! short-lived, bound to one image, stored only as `H(LP(tag) ‖ LP(token))`,
//! and **never written to a log line** — the rule the bootstrap token already
//! has. Nothing in this file passes the token, or a path containing it, to
//! `tracing`; the redemption is logged by image id and byte count.
//!
//! # No range requests, deliberately
//!
//! This version serves the whole file or nothing. It sends no `Accept-Ranges`
//! header and it ignores `Range`, which under RFC 9110 §14.2 a server is
//! permitted to do — a range request on a single-use token raises questions
//! (does a partial read spend it? may a resumed transfer re-present it?) that
//! ADR-0045 does not answer, and half-answering them here would produce a
//! token that is single-use except when it is not. Junos's `file copy` fetches
//! whole files. If resumption is wanted later it is a decision, not a patch.
//!
//! # Nothing here holds an image in memory — NOT ON EITHER PATH
//!
//! Both directions stream. The upload writes to disk as the bytes arrive
//! ([`stream_to_disk`]); the download reads from disk as the socket drains
//! ([`fetch_handler`], `tokio_util::io::ReaderStream` over a
//! [`tokio::fs::File`], served as `axum::body::Body::from_stream`). What a
//! fetch holds at once is [`FETCH_CHUNK`] bytes, not `max_image_bytes`, and
//! that is the whole reason `tokio-util` is a direct dependency —
//! `deps/decisions/tokio-util.md`, owner-approved 2026-09-14 for exactly one
//! item.
//!
//! **Why that matters more here than anywhere else in the server:** this is the
//! one route an unauthenticated caller can reach, because a switch cannot sign
//! a request and the URL is therefore the credential (ADR-0045 §4.2). A route
//! with no session behind it that allocated a gibibyte per caller would be a
//! denial-of-service surface reachable by anybody holding one handed-out URL.
//! It no longer allocates one, so the process-wide `FetchBudget` that used to
//! admit one fetch at a time — and refuse the second with `503` — is gone with
//! the allocation it existed to bound. Concurrency here is now bounded by the
//! same thing that bounds every other route: connections and file handles.
//!
//! Two properties survive that change and are load-bearing, both restated at
//! [`fetch_handler`] where the code makes them: the redemption is **sealed and
//! committed before the first byte is written to the socket**, and the token is
//! spent **exactly once** whether or not the transfer completes.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;

use axum::body::{Body, Bytes, HttpBody};
use axum::extract::{FromRequest, Path as PathExtractor, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use deadpool_postgres::Transaction;
use sha2::{Digest, Sha256};

use fathom_canon::Json;

use crate::api;
use crate::authority::Capability;
use crate::chain::EntryType;
use crate::chains::{self, ChainStoreError};
use crate::crypto::{self, CryptoError};
use crate::grants::{self, Authority, EpochWatch};
use crate::keys::{self, KeyRing, KeyStoreError};
use crate::repo::{self, FirmwareImageId, OrganisationId, RepoError, ScopeId};
use crate::sessions::{
    self, PendingRequest, SessionError, SessionStore, SignedRequest, VerifiedSession,
};

// ---------------------------------------------------------------------------
// Constants that are this module's own
// ---------------------------------------------------------------------------

/// How long a declaration's upload token is good for.
///
/// An hour, because the thing it authorises is a one-to-two-gigabyte transfer
/// over whatever link the operator has, and a token that expires mid-upload
/// costs the whole transfer. It is spent at the START of the upload, so the
/// window bounds when the transfer may BEGIN, not how long it may take.
pub const UPLOAD_TOKEN_LIFETIME_SECONDS: i64 = 60 * 60;

/// How long a fetch URL is good for.
///
/// Fifteen minutes: the operator issues it, pastes one `file copy` command and
/// watches it run. ADR-0045 §4.2 asks for short-lived and does not put a number
/// on it; this is the number, stated here rather than left implicit, and it is
/// the obvious thing to promote to configuration if a real maintenance window
/// disagrees with it.
pub const FETCH_TOKEN_LIFETIME_SECONDS: i64 = 15 * 60;

/// The header the upload's bytes carry their token in.
///
/// A header and not a query parameter: a token in a URL is in the proxy log,
/// the browser history and the `Referer`. The fetch URL has no choice about
/// this — a switch can only be given a URL — which is exactly why it is
/// single-use and expires in minutes.
pub const HEADER_UPLOAD_TOKEN: &str = "fathom-firmware-upload-token";

/// How much of a signed body this module's routes accept.
///
/// The routes that take a signature here carry a declaration, which is a
/// filename and forty bytes. `api::MAX_SIGNED_BODY`'s mebibyte is already
/// generous; this is smaller still, because nothing here has any reason to be
/// large and the image does not travel on a signed route at all.
pub const MAX_SIGNED_BODY: usize = 64 * 1024;

/// How much is held in memory between the socket and the disk on the upload
/// path. Four mebibytes, flushed through `spawn_blocking` — see
/// [`stream_to_disk`].
const UPLOAD_CHUNK: usize = 4 * 1024 * 1024;

/// How much is held in memory between the disk and the socket on the fetch
/// path: **this, and not the size of the image.**
///
/// 256 KiB. `ReaderStream`'s own default is 4 KiB, which for a two-gibibyte
/// image is over five hundred thousand round trips through `spawn_blocking`;
/// this is the same order as the upload's chunk without matching it, because
/// the two are bounded by different things — the upload accumulates before one
/// blocking write, the download allocates one of these per chunk in flight.
/// The number that matters is that it is a constant, so a fetch's memory does
/// not depend on `max_image_bytes` and a hundred concurrent fetches cost a
/// hundred of these rather than a hundred images.
const FETCH_CHUNK: usize = 256 * 1024;

/// The domain separator for a firmware token's stored hash. A new use of a
/// hash gets a label of its own, as `sessions::token_hash`'s does.
const TAG_FIRMWARE_TOKEN: &[u8] = b"fathom/firmware/token/v1";

/// Where an image lands on a Junos device. `docs/UPGRADING-A-JUNIPER.md` step 3
/// uses `/var/tmp/`, and §6's trap 4 is that `/var` is what fills.
const DEVICE_STAGING_DIRECTORY: &str = "/var/tmp/";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/// Everything this module's routes need. Deliberately not [`api::ApiState`]
/// and not `design_api::DesignApiState`: three builders have added routes to
/// this server, and a shared state type is how two of them collide.
#[derive(Clone)]
pub struct FirmwareState {
    pub sessions: Arc<SessionStore>,
    pub watch: Arc<EpochWatch>,
    pub ring: Arc<KeyRing>,
    pub store: Arc<FirmwareStore>,
}

/// The directory images live in, and the few numbers around it.
///
/// **Checked at startup, not at first upload.** [`FirmwareStore::open`] proves
/// the directory exists and can be written to by writing a probe file and
/// removing it. A deployment that mounted the volume read-only, or did not
/// mount it at all, therefore fails at start with a message naming the path —
/// rather than three weeks later, in the middle of the first two-gigabyte
/// transfer anybody tried.
pub struct FirmwareStore {
    directory: PathBuf,
    max_image_bytes: u64,
    fetch_base_url: String,
    client_address: crate::client_address::ClientAddress,
}

impl FirmwareStore {
    /// Open the staging directory, or refuse with a message that says what to
    /// fix.
    ///
    /// `fetch_base_url` is the origin a NETWORK DEVICE can reach this server
    /// at — not what the browser used, which may be an internal name or a
    /// tunnel. It is rendered into the `file copy` command, so getting it
    /// wrong produces a command that does not work rather than a security
    /// problem, and there is no way for this server to discover it.
    pub fn open(
        directory: PathBuf,
        max_image_bytes: u64,
        fetch_base_url: String,
        client_address: crate::client_address::ClientAddress,
    ) -> Result<Self, StoreUnusable> {
        let meta = std::fs::metadata(&directory).map_err(|e| StoreUnusable {
            directory: directory.clone(),
            why: format!("it could not be read: {e}"),
        })?;
        if !meta.is_dir() {
            return Err(StoreUnusable {
                directory,
                why: "it is not a directory".to_string(),
            });
        }
        let probe = directory.join(".fathom-firmware-write-probe");
        std::fs::write(&probe, b"fathom").map_err(|e| StoreUnusable {
            directory: directory.clone(),
            why: format!("it is not writable by this process: {e}"),
        })?;
        let _ = std::fs::remove_file(&probe);

        if max_image_bytes == 0 {
            return Err(StoreUnusable {
                directory,
                why: "the maximum image size is zero, so nothing could ever be staged".to_string(),
            });
        }

        Ok(Self {
            directory,
            max_image_bytes,
            fetch_base_url: fetch_base_url.trim_end_matches('/').to_string(),
            client_address,
        })
    }

    pub fn max_image_bytes(&self) -> u64 {
        self.max_image_bytes
    }

    /// Where the bytes of one image live. **The only place in this server that
    /// builds a path out of anything**, and it builds it out of an id this
    /// server minted, never out of a name a caller sent.
    fn image_path(&self, image: FirmwareImageId) -> PathBuf {
        self.directory.join(storage_name(image))
    }

    /// Where the bytes go while they are arriving. A `.part` file is never
    /// served, so a `.img` file only ever exists complete.
    fn partial_path(&self, image: FirmwareImageId) -> PathBuf {
        self.directory.join(format!("{}.part", ulid_text(image)))
    }
}

/// What a staged image is called on disk.
///
/// The id and nothing else. A ULID encodes to twenty-six characters of
/// Crockford base32 — the digits and the capitals minus `I`, `L`, `O` and `U` —
/// so it can contain no separator, no `.` and no `..`. This function re-checks
/// that alphabet and panics on anything else, because the only way to reach it
/// with a bad value is for [`repo::FirmwareImageId`] or `0017`'s `CHECK` to
/// have stopped meaning what they say, and continuing from there would mean
/// joining an unknown string to a directory.
fn storage_name(image: FirmwareImageId) -> String {
    format!("{}.img", ulid_text(image))
}

fn ulid_text(image: FirmwareImageId) -> String {
    let text = image.to_string();
    assert!(
        text.len() == 26
            && text
                .bytes()
                .all(|b| b.is_ascii_digit() || (b.is_ascii_uppercase() && !b"ILOU".contains(&b))),
        "a firmware image id is a ULID and becomes a filename; this one is not"
    );
    text
}

/// The staging directory cannot be used, said at startup rather than at the
/// first upload.
#[derive(Debug)]
pub struct StoreUnusable {
    pub directory: PathBuf,
    pub why: String,
}

impl core::fmt::Display for StoreUnusable {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(
            f,
            "the firmware staging directory {} cannot be used: {}. Create it, mount it writable, \
             or point this deployment at another one",
            self.directory.display(),
            self.why
        )
    }
}

impl std::error::Error for StoreUnusable {}

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

/// This module's routes, ready to `merge` into the main router.
///
/// Nothing here is added to `api::router` or to `design_api::router`; see the
/// module doc.
pub fn router(state: FirmwareState) -> Router {
    Router::new()
        .route(
            "/organisations/{organisation}/scopes/{scope}/firmware",
            post(declare_handler).get(list_handler),
        )
        .route("/firmware/uploads/{image}", post(upload_handler))
        .route(
            "/organisations/{organisation}/firmware/{image}/fetch-urls",
            post(issue_fetch_url_handler),
        )
        .route("/firmware/fetch/{token}", get(fetch_handler))
        .with_state(state)
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Everything a route here can refuse with.
pub enum FirmwareError {
    Session(SessionError),
    Keys(KeyStoreError),
    Chain(ChainStoreError),
    Crypto(CryptoError),
    Repo(RepoError),
    Db(tokio_postgres::Error),
    Pool(deadpool_postgres::PoolError),

    /// No scope with that id in this organisation.
    NoSuchScope,
    /// No image with that id in this organisation.
    NoSuchImage,
    /// The image exists but has not been staged, so there is nothing whole to
    /// serve or to issue a URL for.
    NotStaged,
    /// A declaration was made for this image already, and its bytes have
    /// arrived or are arriving.
    AlreadyUploaded,

    /// The declared length is beyond this deployment's configured maximum.
    TooLarge {
        bytes: u64,
        max: u64,
    },
    /// A field of a message was not the shape it must be.
    Malformed(&'static str),
    /// The filename is not one this server will carry. See [`safe_filename`].
    UnsafeFilename,

    /// **The bytes were not the bytes that were declared.** The partial file
    /// has been deleted by the time this is returned.
    DeclarationNotMet {
        declared_bytes: u64,
        received_bytes: u64,
        hash_matched: bool,
    },

    /// The token was never issued, has already been spent, or has expired.
    /// **All three are one variant**, for the same reason
    /// `SessionError::NonceNotFresh` covers four: they are the same fact from
    /// this side — the caller holds no fresh single-use authorisation — and
    /// telling them apart tells a caller which guess was closer.
    TokenNotFresh,

    /// Something about the filesystem. Never rendered to the caller in detail.
    Storage(std::io::Error),
}

/// Written for an operator reading a log line, never for the network — the
/// same split `SessionError` makes, and [`IntoResponse`] below is where the
/// network's fixed sentence per status lives.
impl core::fmt::Display for FirmwareError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Session(e) => write!(f, "{e}"),
            Self::Keys(e) => write!(f, "{e}"),
            Self::Chain(e) => write!(f, "{e}"),
            Self::Crypto(e) => write!(f, "{e}"),
            Self::Repo(e) => write!(f, "{e}"),
            Self::Db(e) => write!(f, "database error: {e}"),
            Self::Pool(_) => f.write_str("no database connection was available"),
            Self::NoSuchScope => f.write_str("no scope with that id in this organisation"),
            Self::NoSuchImage => f.write_str("no firmware image with that id in this organisation"),
            Self::NotStaged => f.write_str(
                "that image has no complete, hash-checked copy held by this server, so there is \
                 nothing to serve",
            ),
            Self::AlreadyUploaded => {
                f.write_str("that image's bytes have already arrived or are arriving")
            }
            Self::TooLarge { bytes, max } => write!(
                f,
                "an image of {bytes} bytes was declared and this deployment stages at most {max}"
            ),
            Self::Malformed(what) => write!(f, "the {what} is not the shape it must be"),
            Self::UnsafeFilename => f.write_str(
                "that filename is not one this server will carry into a command an operator \
                 pastes into a switch",
            ),
            Self::DeclarationNotMet {
                declared_bytes,
                received_bytes,
                hash_matched,
            } => write!(
                f,
                "the bytes did not match the declaration: {received_bytes} arrived against a \
                 declared {declared_bytes}, and the hash {}. Nothing was staged and the partial \
                 file was deleted",
                if *hash_matched {
                    "matched"
                } else {
                    "did not match"
                }
            ),
            Self::TokenNotFresh => f.write_str(
                "this request carries no fresh single-use firmware token: it was never issued, \
                 has already been spent, or has expired",
            ),
            Self::Storage(e) => write!(f, "the firmware staging directory refused something: {e}"),
        }
    }
}

impl core::fmt::Debug for FirmwareError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        // The same sentence. There is nothing in this type a `Debug` derive
        // would add except the inner types' own noise, and a test failure
        // reads better with the operator's sentence.
        write!(f, "{self}")
    }
}

impl std::error::Error for FirmwareError {}

impl From<SessionError> for FirmwareError {
    fn from(e: SessionError) -> Self {
        Self::Session(e)
    }
}
impl From<KeyStoreError> for FirmwareError {
    fn from(e: KeyStoreError) -> Self {
        Self::Keys(e)
    }
}
impl From<ChainStoreError> for FirmwareError {
    fn from(e: ChainStoreError) -> Self {
        Self::Chain(e)
    }
}
impl From<CryptoError> for FirmwareError {
    fn from(e: CryptoError) -> Self {
        Self::Crypto(e)
    }
}
impl From<RepoError> for FirmwareError {
    fn from(e: RepoError) -> Self {
        Self::Repo(e)
    }
}
impl From<tokio_postgres::Error> for FirmwareError {
    fn from(e: tokio_postgres::Error) -> Self {
        Self::Db(e)
    }
}
impl From<deadpool_postgres::PoolError> for FirmwareError {
    fn from(e: deadpool_postgres::PoolError) -> Self {
        Self::Pool(e)
    }
}
impl From<grants::AuthorityError> for FirmwareError {
    fn from(e: grants::AuthorityError) -> Self {
        Self::Session(SessionError::Authority(e))
    }
}

impl IntoResponse for FirmwareError {
    fn into_response(self) -> Response {
        match self {
            // Reuses `api::Refusal`'s tested mapping rather than a second copy
            // of the same match — in particular, every authorisation refusal
            // becomes the identical `403 not authorised` body, which is what
            // makes "a `draw` caller cannot tell a real organisation from one
            // that does not exist" true rather than hoped for.
            Self::Session(e) => api::Refusal::from(e).into_response(),
            Self::Repo(e) => api::Refusal::from(SessionError::Repo(e)).into_response(),
            Self::Keys(e) => api::Refusal::from(SessionError::Keys(e)).into_response(),
            Self::Chain(e) => api::Refusal::from(SessionError::Chain(e)).into_response(),
            Self::Db(e) => api::Refusal::from(SessionError::Db(e)).into_response(),
            Self::Pool(e) => api::Refusal::from(SessionError::Pool(e)).into_response(),
            Self::Crypto(e) => {
                tracing::error!(reason = %e, "firmware request failed");
                (StatusCode::INTERNAL_SERVER_ERROR, "refused\n").into_response()
            }

            Self::NoSuchScope => (StatusCode::NOT_FOUND, "no such scope\n").into_response(),
            Self::NoSuchImage => (StatusCode::NOT_FOUND, "no such image\n").into_response(),
            Self::NotStaged => (
                StatusCode::CONFLICT,
                "that image has not been staged: no complete, hash-checked copy of it is held\n",
            )
                .into_response(),
            Self::AlreadyUploaded => (
                StatusCode::CONFLICT,
                "that image already has its bytes; declare another to replace it\n",
            )
                .into_response(),
            Self::TooLarge { bytes, max } => (
                StatusCode::PAYLOAD_TOO_LARGE,
                format!(
                    "that image is declared as {bytes} bytes; this deployment stages at most \
                     {max}\n"
                ),
            )
                .into_response(),
            Self::Malformed(what) => (
                StatusCode::BAD_REQUEST,
                format!("the {what} is not the shape it must be\n"),
            )
                .into_response(),
            Self::UnsafeFilename => (
                StatusCode::BAD_REQUEST,
                "a firmware filename may hold letters, digits, dot, dash and underscore, must \
                 not begin with a dot, and may not be longer than 255 characters. It is shown \
                 back to an operator inside a command they paste into a switch, so it is kept \
                 to what a filename can be\n",
            )
                .into_response(),

            // The one refusal that explains itself in full, and deliberately:
            // the caller is the operator who declared this image, the fact is
            // about their own bytes, and trap 2 exists because this failure is
            // normally SILENT.
            Self::DeclarationNotMet {
                declared_bytes,
                received_bytes,
                hash_matched,
            } => {
                tracing::warn!(
                    declared_bytes,
                    received_bytes,
                    hash_matched,
                    "firmware upload refused: the bytes did not match the declaration"
                );
                (
                    StatusCode::CONFLICT,
                    format!(
                        "NOTHING WAS STAGED. {received_bytes} bytes arrived against a declared \
                         {declared_bytes}, and the SHA-256 of what arrived {} what was declared. \
                         The partial file has been deleted. A partial image accepted as a whole \
                         one is how an upgrade fails at install with `truncated or corrupted \
                         package`, so this is refused rather than repaired\n",
                        if hash_matched {
                            "matched"
                        } else {
                            "did not match"
                        }
                    ),
                )
                    .into_response()
            }

            Self::TokenNotFresh => {
                // No detail, no log of the token, and one message for all
                // three causes.
                tracing::info!(
                    "a firmware token was refused: not issued, already spent, or expired"
                );
                (StatusCode::UNAUTHORIZED, "not authenticated\n").into_response()
            }

            Self::Storage(e) => {
                tracing::error!(reason = %e, "firmware storage failed");
                (StatusCode::INTERNAL_SERVER_ERROR, "refused\n").into_response()
            }
        }
    }
}

// ---------------------------------------------------------------------------
// The signed extractor — `api::Signed`'s shape, once more, for this state
// ---------------------------------------------------------------------------

/// A request whose single-use nonce has been spent and which is waiting to be
/// verified inside the handler's own transaction.
///
/// See `api::Signed` and `design_api::Signed`: verification and the
/// authorisation that follows it share one database snapshot, so this is
/// deliberately a third implementation of that shape rather than a shortcut
/// back to a shared one.
pub struct Signed {
    pending: PendingRequest,
    body: Bytes,
}

impl Signed {
    async fn verify(
        &self,
        state: &FirmwareState,
        tx: &Transaction<'_>,
    ) -> Result<VerifiedSession, SessionError> {
        state.sessions.verify_pending(tx, &self.pending).await
    }
}

impl FromRequest<FirmwareState> for Signed {
    type Rejection = FirmwareError;

    async fn from_request(
        request: Request,
        state: &FirmwareState,
    ) -> Result<Self, Self::Rejection> {
        let (parts, body) = request.into_parts();
        let method = parts.method.as_str().to_string();
        let path = parts
            .uri
            .path_and_query()
            .map(|p| p.as_str().to_string())
            .unwrap_or_else(|| parts.uri.path().to_string());
        let headers = parts.headers;

        let unsigned = || SessionError::NotSigned;
        let session_id = header_text(&headers, api::HEADER_SESSION).ok_or_else(unsigned)?;
        let nonce: [u8; 32] = header_hex(&headers, api::HEADER_NONCE)
            .ok_or_else(unsigned)?
            .as_slice()
            .try_into()
            .map_err(|_| unsigned())?;
        let unix_ms = header_number(&headers, api::HEADER_TIMESTAMP).ok_or_else(unsigned)?;
        let counter = header_number(&headers, api::HEADER_COUNTER).ok_or_else(unsigned)?;
        let signature: [u8; 64] = header_hex(&headers, api::HEADER_SIGNATURE)
            .ok_or_else(unsigned)?
            .as_slice()
            .try_into()
            .map_err(|_| unsigned())?;

        let body = axum::body::to_bytes(body, MAX_SIGNED_BODY)
            .await
            .map_err(|_| SessionError::Malformed("request body"))?;

        let pending = state
            .sessions
            .begin_request(&SignedRequest {
                session_id: &session_id,
                method: &method,
                path: &path,
                body: &body,
                nonce,
                unix_ms,
                counter,
                signature,
            })
            .await?;

        Ok(Self { pending, body })
    }
}

fn header_text(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
}

fn header_hex(headers: &HeaderMap, name: &str) -> Option<Vec<u8>> {
    unhex(&header_text(headers, name)?)
}

fn header_number(headers: &HeaderMap, name: &str) -> Option<i64> {
    header_text(headers, name)?.parse::<i64>().ok()
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(text.len() / 2);
    for pair in bytes.chunks(2) {
        let hi = (pair[0] as char).to_digit(16)?;
        let lo = (pair[1] as char).to_digit(16)?;
        out.push((hi * 16 + lo) as u8);
    }
    Some(out)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The stored form of a firmware token: `H(LP(tag) ‖ LP(token))`.
///
/// The same construction `sessions::token_hash` uses, under a label of its
/// own, so that a token from one surface cannot be presented at the other even
/// if both hashes were somehow compared.
pub fn token_hash(token: &[u8]) -> [u8; 32] {
    let mut msg = Vec::with_capacity(96);
    crypto::lp(&mut msg, TAG_FIRMWARE_TOKEN);
    crypto::lp(&mut msg, token);
    Sha256::digest(&msg).into()
}

/// 256 bits from the kernel CSPRNG, for a token that is the whole
/// authorisation.
fn fresh_token() -> Result<[u8; 32], CryptoError> {
    Ok(*crypto::Key32::random()?.expose())
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Filenames, which never become paths
// ---------------------------------------------------------------------------

/// Whether this is a filename this server will carry.
///
/// **Two separate reasons, and neither is "to build a path from it".** No path
/// is ever built from this value — [`FirmwareStore::image_path`] uses the id.
///
/// 1. It is rendered back to an operator INSIDE a command they paste into a
///    switch (`file checksum sha-256 /var/tmp/<filename>`). A name containing
///    a space, a quote, a newline or a `;` turns one command into two.
/// 2. A name containing `/` or `..` is a caller trying something, and storing
///    it teaches the next reader of the table that such values are normal.
///
/// Letters, digits, `.`, `-` and `_`; not starting with `.`; 1 to 255 bytes.
/// Real Junos image names — `junos-install-ex-x86-64-21.4R3-S5.5.tgz` — are
/// inside it with room to spare, which is CLAUDE.md rule 2's test: the gate is
/// measured against what a real device accepts, not against what is easy to
/// check.
pub fn safe_filename(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 255
        && !name.starts_with('.')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b'_')
}

// ---------------------------------------------------------------------------
// Authorisation, shared by the routes that take a session
// ---------------------------------------------------------------------------

/// Open the tenant context and authorise `needed` on `scope`, in `tx`.
///
/// A caller who is not a member of the organisation, and a caller who names an
/// organisation that does not exist, both come out of `repo::open_tenant_context`
/// as `RepoError::NotAMember` and both render as the same `403 not authorised`.
/// That is the property the refusal tests assert byte for byte.
async fn authorise_in(
    tx: &Transaction<'_>,
    state: &FirmwareState,
    session: &VerifiedSession,
    tenant: OrganisationId,
    scope: Option<ScopeId>,
    needed: Capability,
) -> Result<repo::TenantContext, FirmwareError> {
    let ctx = sessions::open_tenant_context(tx, tenant, session).await?;
    let tenant_key = keys::tenant_key(tx, &state.ring, &ctx).await?;
    let auth = Authority {
        ring: &state.ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &state.watch,
    };
    grants::authorise_account(tx, &auth, scope, needed).await?;
    Ok(ctx)
}

fn parse_organisation(text: &str) -> Result<OrganisationId, FirmwareError> {
    text.parse()
        .map_err(|_| FirmwareError::Malformed("organisation id"))
}

fn parse_scope(text: &str) -> Result<ScopeId, FirmwareError> {
    text.parse()
        .map_err(|_| FirmwareError::Malformed("scope id"))
}

fn parse_image(text: &str) -> Result<FirmwareImageId, FirmwareError> {
    text.parse()
        .map_err(|_| FirmwareError::Malformed("image id"))
}

// ---------------------------------------------------------------------------
// 1. Declare
// ---------------------------------------------------------------------------

/// `POST /organisations/{organisation}/scopes/{scope}/firmware` — declare an
/// image and take a one-time upload token for it. **Requires `steward`.**
///
/// Body, length-prefixed as everything on `api.rs`'s surface is:
///
/// ```text
/// LP(filename) ‖ LP(byte_length as 8 bytes little-endian) ‖ LP(sha256)
/// ```
///
/// Answers canonical JSON: the image id, where to send the bytes, the token,
/// and when the token stops working. **The declared hash is not echoed** — it
/// is a claim, and this server has nothing to say about it until it has
/// computed its own.
async fn declare_handler(
    State(state): State<FirmwareState>,
    PathExtractor((organisation, scope)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, FirmwareError> {
    let tenant = parse_organisation(&organisation)?;
    let scope_id = parse_scope(&scope)?;

    let (filename, byte_length, declared) = parse_declaration(&signed.body)?;
    if !safe_filename(&filename) {
        return Err(FirmwareError::UnsafeFilename);
    }
    if byte_length == 0 || byte_length > state.store.max_image_bytes {
        return Err(FirmwareError::TooLarge {
            bytes: byte_length,
            max: state.store.max_image_bytes,
        });
    }

    let mut client = state.sessions.pool().get().await?;
    let tx = client.transaction().await?;
    let session = signed.verify(&state, &tx).await?;
    let ctx = authorise_in(
        &tx,
        &state,
        &session,
        tenant,
        Some(scope_id),
        Capability::Steward,
    )
    .await?;

    let image = FirmwareImageId::new();
    // `WHERE EXISTS` against `scopes`, exactly as `designs::create_design`
    // does: a scope id from another organisation inserts nothing, and the row
    // count is checked, because an insert that quietly matched nothing and
    // still returned an id would hand a caller an image that does not exist.
    let inserted = tx
        .execute(
            "INSERT INTO firmware_images \
                 (id, organisation_id, scope_id, filename, byte_length, declared_sha256, \
                  state, created_by) \
             SELECT $1, $2, $3, $4, $5, $6, 'declared', $7 WHERE EXISTS \
                 (SELECT 1 FROM scopes WHERE id = $3 AND organisation_id = $2)",
            &[
                &image.to_string(),
                &ctx.tenant().to_string(),
                &scope_id.to_string(),
                &filename,
                &(byte_length as i64),
                &declared.to_vec(),
                &ctx.actor().to_string(),
            ],
        )
        .await?;
    if inserted != 1 {
        return Err(FirmwareError::NoSuchScope);
    }

    let token = fresh_token()?;
    let expires = now_unix() + UPLOAD_TOKEN_LIFETIME_SECONDS;
    tx.execute(
        "INSERT INTO firmware_upload_tokens \
             (image_id, organisation_id, token_hash, expires_at) \
         VALUES ($1, $2, $3, to_timestamp($4::bigint))",
        &[
            &image.to_string(),
            &ctx.tenant().to_string(),
            &token_hash(&token).to_vec(),
            &expires,
        ],
    )
    .await?;

    tx.commit().await?;

    // **No chain entry here.** A declaration stages nothing: there is a row
    // and no bytes, and an entry per declaration would let a steward grow the
    // sealed audit at will with acts that did not happen. The sealed record
    // starts when an image is actually staged.
    let mut map = BTreeMap::new();
    map.insert("image_id".to_string(), Json::Str(image.to_string()));
    map.insert("filename".to_string(), Json::Str(filename));
    map.insert("byte_length".to_string(), Json::Int(byte_length as i64));
    map.insert(
        "upload_path".to_string(),
        Json::Str(format!("/firmware/uploads/{image}")),
    );
    map.insert("upload_token".to_string(), Json::Str(hex(&token)));
    map.insert(
        "upload_token_header".to_string(),
        Json::Str(HEADER_UPLOAD_TOKEN.to_string()),
    );
    map.insert(
        "upload_token_expires_at_unix".to_string(),
        Json::Int(expires),
    );
    Ok(json_response(Json::Obj(map)))
}

fn parse_declaration(body: &[u8]) -> Result<(String, u64, [u8; 32]), FirmwareError> {
    let (filename, rest) =
        crypto::read_lp(body).ok_or(FirmwareError::Malformed("declaration body"))?;
    let (length, rest) =
        crypto::read_lp(rest).ok_or(FirmwareError::Malformed("declaration body"))?;
    let (digest, rest) =
        crypto::read_lp(rest).ok_or(FirmwareError::Malformed("declaration body"))?;
    if !rest.is_empty() {
        return Err(FirmwareError::Malformed("declaration body"));
    }
    let filename =
        String::from_utf8(filename.to_vec()).map_err(|_| FirmwareError::UnsafeFilename)?;
    let length: [u8; 8] = length
        .try_into()
        .map_err(|_| FirmwareError::Malformed("declared byte length"))?;
    let digest: [u8; 32] = digest
        .try_into()
        .map_err(|_| FirmwareError::Malformed("declared sha256"))?;
    Ok((filename, u64::from_le_bytes(length), digest))
}

// ---------------------------------------------------------------------------
// 2. The bytes
// ---------------------------------------------------------------------------

/// `POST /firmware/uploads/{image}` — the image itself, streamed to disk.
///
/// **Not signed, and the module doc says why**: a signature covers a digest of
/// the body, and computing that over two gigabytes means holding two gigabytes.
/// The authorisation is the single-use token from the declaration, presented in
/// [`HEADER_UPLOAD_TOKEN`], and what it can do is exactly one thing: fill in
/// the image its own declaration named, at the length and hash that declaration
/// named.
///
/// The body is never held whole: it is read frame by frame, written through a
/// four-mebibyte buffer, and hashed as it is written.
async fn upload_handler(
    State(state): State<FirmwareState>,
    PathExtractor(image): PathExtractor<String>,
    request: Request,
) -> Result<Response, FirmwareError> {
    let image = parse_image(&image)?;
    let (parts, body) = request.into_parts();
    let token = header_hex(&parts.headers, HEADER_UPLOAD_TOKEN)
        .filter(|t| t.len() == 32)
        .ok_or(FirmwareError::TokenNotFresh)?;

    // --- spend the token, and read the declaration it belongs to -----------
    let mut client = state.sessions.pool().get().await?;
    let tx = client.transaction().await?;
    enter_upload_custody(&tx).await?;

    let spent = tx
        .query_opt(
            "UPDATE firmware_upload_tokens SET redeemed_at = now() \
             WHERE token_hash = $1 AND image_id = $2 AND redeemed_at IS NULL \
               AND expires_at > now() \
             RETURNING organisation_id",
            &[&token_hash(&token).to_vec(), &image.to_string()],
        )
        .await?
        .ok_or(FirmwareError::TokenNotFresh)?;
    let organisation: String = spent.get(0);

    // The tenant comes OFF THE ROW this server just read, never off the
    // request — `repo::set_custody_tenant`'s whole purpose, and the same shape
    // `grants::suspend_grant_by_operator` uses for the other act that has no
    // membership to pin from.
    repo::set_custody_tenant(&tx, &organisation).await?;

    let row = tx
        .query_opt(
            "SELECT byte_length, declared_sha256, state, created_by, scope_id, filename \
             FROM firmware_images WHERE id = $1 AND organisation_id = $2",
            &[&image.to_string(), &organisation],
        )
        .await?
        .ok_or(FirmwareError::NoSuchImage)?;
    let declared_length: i64 = row.get(0);
    let declared_digest: Vec<u8> = row.get(1);
    let state_text: String = row.get(2);
    let created_by: String = row.get(3);
    let scope_id: String = row.get(4);
    let filename: String = row.get(5);
    if state_text != "declared" {
        return Err(FirmwareError::AlreadyUploaded);
    }
    tx.commit().await?;

    let declared_length = declared_length as u64;

    // --- the bytes ---------------------------------------------------------
    let partial = state.store.partial_path(image);
    let outcome = stream_to_disk(&partial, body, declared_length).await;

    let (received, computed) = match outcome {
        Ok(pair) => pair,
        Err(e) => {
            remove_quietly(&partial).await;
            mark_failed(&state, &organisation, image, "write_failed").await?;
            return Err(e);
        }
    };

    let hash_matched = computed.as_slice() == declared_digest.as_slice();
    if received != declared_length || !hash_matched {
        // **Delete first, then record.** A partial file that outlived its
        // refusal is the thing trap 2 is about.
        remove_quietly(&partial).await;
        mark_failed(
            &state,
            &organisation,
            image,
            if received != declared_length {
                "length_mismatch"
            } else {
                "hash_mismatch"
            },
        )
        .await?;
        return Err(FirmwareError::DeclarationNotMet {
            declared_bytes: declared_length,
            received_bytes: received,
            hash_matched,
        });
    }

    finish_upload(
        &state,
        &organisation,
        image,
        &scope_id,
        &filename,
        &created_by,
        received,
        computed,
        &partial,
    )
    .await
}

/// Read the body frame by frame, write it through a bounded buffer, and hash
/// it on the way past.
///
/// **`std::fs` inside `spawn_blocking`, not `tokio::fs`**: this crate's tokio
/// carries `rt-multi-thread`, `net`, `macros`, `signal` and `time` and not
/// `fs`, and turning a feature on is a dependency decision. A blocking write
/// on a blocking pool is what `tokio::fs` does internally anyway; what this
/// gives up is per-call efficiency, which is why the buffer is four mebibytes
/// and not four kilobytes.
///
/// Refuses as soon as the body runs past the declared length rather than at
/// the end, so a caller cannot make this server write an unbounded file by
/// declaring a small one.
async fn stream_to_disk(
    partial: &Path,
    mut body: Body,
    declared_length: u64,
) -> Result<(u64, [u8; 32]), FirmwareError> {
    let path = partial.to_path_buf();
    let mut sink = tokio::task::spawn_blocking(move || {
        std::fs::File::create(&path).map(|file| Sink {
            file,
            hasher: Sha256::new(),
            written: 0,
        })
    })
    .await
    .map_err(joined)?
    .map_err(FirmwareError::Storage)?;

    let mut buffer: Vec<u8> = Vec::with_capacity(UPLOAD_CHUNK);
    loop {
        let frame = std::future::poll_fn(|cx| Pin::new(&mut body).poll_frame(cx)).await;
        let Some(frame) = frame else { break };
        let frame = frame.map_err(|_| FirmwareError::Malformed("request body"))?;
        let Ok(data) = frame.into_data() else {
            // A trailer, which this route has no use for.
            continue;
        };

        if sink.written + buffer.len() as u64 + data.len() as u64 > declared_length {
            return Err(FirmwareError::DeclarationNotMet {
                declared_bytes: declared_length,
                received_bytes: sink.written + buffer.len() as u64 + data.len() as u64,
                hash_matched: false,
            });
        }
        buffer.extend_from_slice(&data);
        if buffer.len() >= UPLOAD_CHUNK {
            (sink, buffer) = flush(sink, buffer).await?;
        }
    }
    if !buffer.is_empty() {
        (sink, _) = flush(sink, buffer).await?;
    }

    let written = sink.written;
    let digest = tokio::task::spawn_blocking(move || {
        use std::io::Write;
        sink.file.flush()?;
        sink.file.sync_all()?;
        Ok::<[u8; 32], std::io::Error>(sink.hasher.finalize().into())
    })
    .await
    .map_err(joined)?
    .map_err(FirmwareError::Storage)?;

    Ok((written, digest))
}

struct Sink {
    file: std::fs::File,
    hasher: Sha256,
    written: u64,
}

/// One buffer, written and hashed on the blocking pool, with both halves moved
/// back so the allocation is reused for the next four mebibytes.
async fn flush(mut sink: Sink, mut buffer: Vec<u8>) -> Result<(Sink, Vec<u8>), FirmwareError> {
    let (sink, buffer) = tokio::task::spawn_blocking(move || {
        use std::io::Write;
        sink.file.write_all(&buffer)?;
        sink.hasher.update(&buffer);
        sink.written += buffer.len() as u64;
        buffer.clear();
        Ok::<(Sink, Vec<u8>), std::io::Error>((sink, buffer))
    })
    .await
    .map_err(joined)?
    .map_err(FirmwareError::Storage)?;
    Ok((sink, buffer))
}

fn joined(e: tokio::task::JoinError) -> FirmwareError {
    FirmwareError::Storage(std::io::Error::other(e))
}

async fn remove_quietly(path: &Path) {
    let path = path.to_path_buf();
    let _ = tokio::task::spawn_blocking(move || std::fs::remove_file(path)).await;
}

/// Record that an upload did not produce what was declared.
///
/// No chain entry: nothing was staged. The row is the record, and it is the
/// reason the image id cannot be reused for a second attempt — a retry is a
/// new declaration, so a caller cannot try repeatedly against one hash.
async fn mark_failed(
    state: &FirmwareState,
    organisation: &str,
    image: FirmwareImageId,
    reason: &str,
) -> Result<(), FirmwareError> {
    let mut client = state.sessions.pool().get().await?;
    let tx = client.transaction().await?;
    repo::set_custody_tenant(&tx, organisation).await?;
    tx.execute(
        "UPDATE firmware_images SET state = 'failed', failed_reason = $3 \
         WHERE id = $1 AND organisation_id = $2 AND state = 'declared'",
        &[&image.to_string(), &organisation, &reason],
    )
    .await?;
    tx.commit().await?;
    Ok(())
}

/// The bytes matched: move the file into place, seal the fact, and mark the
/// row staged.
///
/// **The rename happens before the database write.** A `.img` file with a
/// `declared` row serves nothing and is the safe disagreement (`0017` §A); a
/// `staged` row with no file would be the dangerous one, and this order cannot
/// produce it.
#[allow(clippy::too_many_arguments)]
async fn finish_upload(
    state: &FirmwareState,
    organisation: &str,
    image: FirmwareImageId,
    scope_id: &str,
    filename: &str,
    created_by: &str,
    received: u64,
    computed: [u8; 32],
    partial: &Path,
) -> Result<Response, FirmwareError> {
    let from = partial.to_path_buf();
    let to = state.store.image_path(image);
    tokio::task::spawn_blocking(move || std::fs::rename(&from, &to))
        .await
        .map_err(joined)?
        .map_err(FirmwareError::Storage)?;

    let mut client = state.sessions.pool().get().await?;
    let tx = client.transaction().await?;
    repo::set_custody_tenant(&tx, organisation).await?;
    let tenant_key = keys::tenant_key_for(&tx, &state.ring, organisation).await?;

    let metadata = staged_metadata(
        organisation,
        created_by,
        image,
        scope_id,
        filename,
        received,
        &computed,
    );
    let appended = chains::append_org_as(
        &tx,
        &state.ring,
        organisation,
        created_by,
        &tenant_key,
        EntryType::FirmwareStaged,
        &metadata,
    )
    .await?;

    // `computed_sha256` is written HERE and from this variable. Nothing in
    // this module reads `declared_sha256` into it.
    let updated = tx
        .execute(
            "UPDATE firmware_images \
                SET state = 'staged', computed_sha256 = $3, staged_at = now(), staged_seq = $4 \
             WHERE id = $1 AND organisation_id = $2 AND state = 'declared'",
            &[
                &image.to_string(),
                &organisation,
                &computed.to_vec(),
                &appended.seq,
            ],
        )
        .await?;
    if updated != 1 {
        return Err(FirmwareError::AlreadyUploaded);
    }
    tx.commit().await?;

    tracing::info!(
        image = %image,
        bytes = received,
        "firmware image staged"
    );

    let mut map = BTreeMap::new();
    map.insert("image_id".to_string(), Json::Str(image.to_string()));
    map.insert("state".to_string(), Json::Str("staged".to_string()));
    map.insert("byte_length".to_string(), Json::Int(received as i64));
    map.insert("sha256".to_string(), Json::Str(hex(&computed)));
    map.insert("staged_seq".to_string(), Json::Int(appended.seq));
    Ok(json_response(Json::Obj(map)))
}

// ---------------------------------------------------------------------------
// 3. A fetch URL
// ---------------------------------------------------------------------------

/// `POST /organisations/{organisation}/firmware/{image}/fetch-urls` — mint a
/// single-use URL a device can collect this image from. **Requires `steward`.**
///
/// ADR-0045 §8: this is the act that publishes bytes to anything that can reach
/// this server holding the token, so it is `steward`, it is sealed, and the
/// answer is the only time the URL exists anywhere outside the caller's screen.
async fn issue_fetch_url_handler(
    State(state): State<FirmwareState>,
    PathExtractor((organisation, image)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, FirmwareError> {
    let tenant = parse_organisation(&organisation)?;
    let image = parse_image(&image)?;

    let mut client = state.sessions.pool().get().await?;
    let tx = client.transaction().await?;
    let session = signed.verify(&state, &tx).await?;

    // Authorised against the image's own scope when the image exists, and
    // against the ORGANISATION's scope when it does not — `design_api`'s
    // "absent, not forbidden" rule, so a caller who lacks `steward` cannot use
    // this route to find out which image ids are real.
    let scope = image_scope(&tx, tenant, image).await?;
    let ctx = authorise_in(&tx, &state, &session, tenant, scope, Capability::Steward).await?;

    let row = tx
        .query_opt(
            "SELECT filename, byte_length, computed_sha256, state \
             FROM firmware_images WHERE id = $1 AND organisation_id = $2",
            &[&image.to_string(), &ctx.tenant().to_string()],
        )
        .await?
        .ok_or(FirmwareError::NoSuchImage)?;
    let filename: String = row.get(0);
    let byte_length: i64 = row.get(1);
    let computed: Option<Vec<u8>> = row.get(2);
    let state_text: String = row.get(3);
    if state_text != "staged" {
        return Err(FirmwareError::NotStaged);
    }
    let computed = computed.ok_or(FirmwareError::NotStaged)?;

    let token = fresh_token()?;
    let token_id = FirmwareImageId::new();
    let expires = now_unix() + FETCH_TOKEN_LIFETIME_SECONDS;

    let tenant_key = keys::tenant_key(&tx, &state.ring, &ctx).await?;
    let metadata = fetch_issued_metadata(
        &ctx.tenant().to_string(),
        &ctx.actor().to_string(),
        image,
        token_id,
        expires,
    );
    let appended = chains::append_org(
        &tx,
        &state.ring,
        &ctx,
        &tenant_key,
        EntryType::FirmwareFetchIssued,
        &metadata,
    )
    .await?;

    tx.execute(
        "INSERT INTO firmware_fetch_tokens \
             (id, image_id, organisation_id, token_hash, issued_by, issued_seq, expires_at) \
         VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7::bigint))",
        &[
            &token_id.to_string(),
            &image.to_string(),
            &ctx.tenant().to_string(),
            &token_hash(&token).to_vec(),
            &ctx.actor().to_string(),
            &appended.seq,
            &expires,
        ],
    )
    .await?;
    tx.commit().await?;

    // Logged by token ID, never by token. The id is in the sealed entry too,
    // so an operator can tie a log line to a chain entry without either
    // carrying the credential.
    tracing::info!(
        image = %image,
        fetch_token_id = %token_id,
        "firmware fetch url issued"
    );

    let url = format!(
        "{}/firmware/fetch/{}",
        state.store.fetch_base_url,
        hex(&token)
    );
    let sha256 = hex(&computed);

    let mut map = BTreeMap::new();
    map.insert("image_id".to_string(), Json::Str(image.to_string()));
    map.insert("filename".to_string(), Json::Str(filename.clone()));
    map.insert("byte_length".to_string(), Json::Int(byte_length));
    map.insert("sha256".to_string(), Json::Str(sha256.clone()));
    map.insert("fetch_url".to_string(), Json::Str(url.clone()));
    map.insert(
        "fetch_token_id".to_string(),
        Json::Str(token_id.to_string()),
    );
    map.insert("fetch_url_expires_at_unix".to_string(), Json::Int(expires));
    map.insert("issued_seq".to_string(), Json::Int(appended.seq));
    map.insert(
        "commands".to_string(),
        commands(&filename, &sha256, Some(&url)),
    );
    Ok(json_response(Json::Obj(map)))
}

/// The image's own scope, or `None` if no image with this id exists in this
/// tenant. See [`issue_fetch_url_handler`] on why `None` rather than a refusal.
async fn image_scope(
    tx: &Transaction<'_>,
    tenant: OrganisationId,
    image: FirmwareImageId,
) -> Result<Option<ScopeId>, FirmwareError> {
    // Read through the tenant's own policy needs a tenant context, which is
    // not open yet — so this is deliberately a read that returns nothing until
    // `authorise_in` has run. It is called before the context exists and
    // therefore always sees zero rows under `FORCE ROW LEVEL SECURITY`, which
    // is the safe direction: `None` means "authorise against the organisation",
    // which is the stricter of the two.
    let row = tx
        .query_opt(
            "SELECT scope_id FROM firmware_images WHERE id = $1 AND organisation_id = $2",
            &[&image.to_string(), &tenant.to_string()],
        )
        .await?;
    match row {
        None => Ok(None),
        Some(row) => {
            let text: String = row.get(0);
            Ok(Some(text.parse().map_err(|_| {
                FirmwareError::Session(SessionError::Corrupt("image scope id"))
            })?))
        }
    }
}

// ---------------------------------------------------------------------------
// 4. The device's fetch
// ---------------------------------------------------------------------------

/// `GET /firmware/fetch/{token}` — the one route in this server a network
/// device talks to, and the one route whose URL is itself the authorisation.
///
/// What happens, in order, and the order is the design:
///
/// 1. **Spend the token** with one guarded `UPDATE ... RETURNING`, atomic
///    against a second caller presenting the same URL.
/// 2. **Take the tenant off the row that was just read**, never off the
///    request.
/// 3. **Seal `firmware_fetch_redeemed` and commit** — before a single byte is
///    written to the socket, so a transfer that dies half way still leaves the
///    record that the bytes left.
/// 4. Serve exactly the staged bytes, **streamed**, a [`FETCH_CHUNK`] at a
///    time.
///
/// # Streaming does not weaken step 3, and the code says so twice
///
/// With a buffered body the ordering was obvious because the bytes did not
/// exist until after `tx.commit()`. Streaming makes it less obvious — the body
/// is a lazily-polled object — so it is stated here and again at the line that
/// builds it: `tx.commit().await?` **returns before `File::open` is called**,
/// and hyper cannot poll the body before this function has returned the
/// response that holds it. There is no path on which a byte reaches the socket
/// with the redemption uncommitted. `tests/firmware.rs` holds the test for it.
///
/// # The token is spent exactly once, including when the transfer dies
///
/// Spending is the `UPDATE ... WHERE redeemed_at IS NULL` in step 1, and it is
/// committed in step 3. Nothing after that point can give it back: an error
/// opening the file, a length that disagrees with the row, a read error mid
/// stream and a device that hangs up at forty per cent all leave the row
/// redeemed. That is ADR-0045 §4.2's single use taken literally — a URL that
/// published bytes is spent whether or not the bytes all arrived — and it is
/// the same behaviour the buffered version had.
///
/// The old code reserved a process-wide buffer budget *before* spending the
/// token, so that a refusal under load cost a retry rather than the URL. That
/// concern was specific to the allocation: the refusal it protected against
/// was transient and retrying would have worked. With the allocation gone
/// there is no transient refusal left on this route — every remaining failure
/// after the commit is an integrity fault (the staged file is missing, or is
/// not the length its row records) that a retry would hit again — so there is
/// nothing left to reserve ahead of the spend.
///
/// No range support: see the module doc.
async fn fetch_handler(
    State(state): State<FirmwareState>,
    PathExtractor(token): PathExtractor<String>,
    request: Request,
) -> Result<Response, FirmwareError> {
    let token = unhex(&token)
        .filter(|t| t.len() == 32)
        .ok_or(FirmwareError::TokenNotFresh)?;

    let source = source_of(&state, request.headers(), request.extensions());

    let mut client = state.sessions.pool().get().await?;
    let tx = client.transaction().await?;
    enter_fetch_custody(&tx).await?;

    let spent = tx
        .query_opt(
            "UPDATE firmware_fetch_tokens SET redeemed_at = now(), redeemed_from = $2 \
             WHERE token_hash = $1 AND redeemed_at IS NULL AND expires_at > now() \
             RETURNING id, image_id, organisation_id, issued_by",
            &[&token_hash(&token).to_vec(), &source],
        )
        .await?
        .ok_or(FirmwareError::TokenNotFresh)?;
    let token_id: String = spent.get(0);
    let image_text: String = spent.get(1);
    let organisation: String = spent.get(2);
    let issued_by: String = spent.get(3);
    let image = parse_image(&image_text)?;

    repo::set_custody_tenant(&tx, &organisation).await?;

    let row = tx
        .query_opt(
            "SELECT filename, byte_length, computed_sha256, state \
             FROM firmware_images WHERE id = $1 AND organisation_id = $2",
            &[&image_text, &organisation],
        )
        .await?
        .ok_or(FirmwareError::NoSuchImage)?;
    let filename: String = row.get(0);
    let byte_length: i64 = row.get(1);
    let computed: Option<Vec<u8>> = row.get(2);
    let state_text: String = row.get(3);
    if state_text != "staged" {
        return Err(FirmwareError::NotStaged);
    }
    let computed = computed.ok_or(FirmwareError::NotStaged)?;

    let tenant_key = keys::tenant_key_for(&tx, &state.ring, &organisation).await?;
    let metadata = fetch_redeemed_metadata(
        &organisation,
        &issued_by,
        image,
        &token_id,
        byte_length as u64,
        &computed,
        &source,
    );
    let appended = chains::append_org_as(
        &tx,
        &state.ring,
        &organisation,
        &issued_by,
        &tenant_key,
        EntryType::FirmwareFetchRedeemed,
        &metadata,
    )
    .await?;
    tx.execute(
        "UPDATE firmware_fetch_tokens SET redeemed_seq = $2 WHERE id = $1",
        &[&token_id, &appended.seq],
    )
    .await?;
    tx.commit().await?;

    // **The token is not in this line and must never be.** The token id is,
    // which names the sealed entry without being redeemable.
    tracing::info!(
        image = %image,
        fetch_token_id = %token_id,
        bytes = byte_length,
        source = %source,
        "firmware image served"
    );

    // **Everything above this line is committed.** `tx.commit()` has already
    // returned, so the redemption is durable before the file is so much as
    // opened, let alone read — step 3 of the order above, restated at the line
    // that would otherwise make it hard to see.
    let path = state.store.image_path(image);
    let file = tokio::fs::File::open(&path)
        .await
        .map_err(FirmwareError::Storage)?;

    // The row said how long it is; disagreeing with the disk means the file
    // was changed underneath this server, which is an integrity alarm and not
    // a transfer to complete. Checked from the metadata of the OPEN handle, so
    // it is the length of the file this response will actually read from and
    // not of whatever is at that path a moment later.
    let on_disk = file.metadata().await.map_err(FirmwareError::Storage)?.len();
    if on_disk as i64 != byte_length {
        tracing::error!(
            image = %image,
            expected = byte_length,
            found = on_disk,
            "a staged firmware image is not the length its row records"
        );
        return Err(FirmwareError::NotStaged);
    }

    // One `FETCH_CHUNK` in flight, never the image. The handle lives as long
    // as the response body does: when the device hangs up, hyper drops the
    // body, which drops the `ReaderStream`, which drops the `File` and closes
    // the descriptor. Nothing here has to notice the disconnect.
    let body = Body::from_stream(tokio_util::io::ReaderStream::with_capacity(
        file,
        FETCH_CHUNK,
    ));

    let mut headers = HeaderMap::new();
    headers.insert(
        axum::http::header::CONTENT_TYPE,
        "application/octet-stream"
            .parse()
            .expect("a static content type is a valid header value"),
    );
    headers.insert(
        axum::http::header::CONTENT_DISPOSITION,
        format!("attachment; filename=\"{filename}\"")
            .parse()
            .expect("a checked filename is a valid header value"),
    );
    // A streamed body has no length of its own, so hyper would frame this
    // response with `Transfer-Encoding: chunked`. It is stated instead, from
    // the length that was just checked against the open handle, because a
    // device copying a two-gigabyte image should be able to see how far it has
    // got and to know a truncated transfer was truncated. `Content-Length` and
    // the body length cannot disagree: both come from `on_disk`.
    headers.insert(
        axum::http::header::CONTENT_LENGTH,
        on_disk
            .to_string()
            .parse()
            .expect("a decimal integer is a valid header value"),
    );
    // What a device should compare against, in the response itself, so a
    // transfer's own record carries the hash Fathom holds.
    headers.insert(
        "fathom-firmware-sha256",
        hex(&computed).parse().expect("hex is a valid header value"),
    );
    Ok((StatusCode::OK, headers, body).into_response())
}

/// The request's address as the store's policy decides it, the one rule
/// every route shares (`crate::client_address`), which also caps the string
/// at 255 characters because it is stored. Until 2026-09-20 this was a copy
/// that read the header's FIRST entry, the one a client can write.
fn source_of(
    state: &FirmwareState,
    headers: &HeaderMap,
    extensions: &axum::http::Extensions,
) -> String {
    state.store.client_address.of(headers, extensions)
}

// ---------------------------------------------------------------------------
// 5. Read back
// ---------------------------------------------------------------------------

/// `GET /organisations/{organisation}/scopes/{scope}/firmware` — what is staged
/// for this scope, with the hash Fathom computed and the commands to use it.
/// **Requires `read`.**
///
/// # Why the commands here have a placeholder where the URL goes
///
/// Every command is rendered with the real filename and the real hash. The
/// `file copy` line is not, and cannot be: this server keeps only
/// `H(LP(tag) ‖ LP(token))` of a fetch URL, so it *cannot* reproduce one it
/// issued — which is the property that makes the token safe at rest. A route
/// that could show you the URL again would be a route that stored it.
///
/// The URL arrives, once, in the answer to `POST .../fetch-urls`, which is a
/// `steward` act with a sealed entry. That is deliberate: issuing is what
/// publishes the bytes, and a `GET` that minted a credential would make reading
/// a list into an act of publication.
async fn list_handler(
    State(state): State<FirmwareState>,
    PathExtractor((organisation, scope)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, FirmwareError> {
    let tenant = parse_organisation(&organisation)?;
    let scope_id = parse_scope(&scope)?;

    let mut client = state.sessions.pool().get().await?;
    let tx = client.transaction().await?;
    let session = signed.verify(&state, &tx).await?;
    let ctx = authorise_in(
        &tx,
        &state,
        &session,
        tenant,
        Some(scope_id),
        Capability::Read,
    )
    .await?;

    let rows = tx
        .query(
            "SELECT id, filename, byte_length, computed_sha256, state, failed_reason, \
                    extract(epoch FROM created_at)::bigint, \
                    extract(epoch FROM staged_at)::bigint, staged_seq \
             FROM firmware_images \
             WHERE organisation_id = $1 AND scope_id = $2 \
             ORDER BY created_at",
            &[&ctx.tenant().to_string(), &scope_id.to_string()],
        )
        .await?;
    tx.commit().await?;

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let id: String = row.get(0);
        let filename: String = row.get(1);
        let byte_length: i64 = row.get(2);
        let computed: Option<Vec<u8>> = row.get(3);
        let state_text: String = row.get(4);
        let failed_reason: Option<String> = row.get(5);
        let created_at: i64 = row.get(6);
        let staged_at: Option<i64> = row.get(7);
        let staged_seq: Option<i64> = row.get(8);

        let mut map = BTreeMap::new();
        map.insert("image_id".to_string(), Json::Str(id));
        map.insert("scope_id".to_string(), Json::Str(scope_id.to_string()));
        map.insert("filename".to_string(), Json::Str(filename.clone()));
        map.insert("byte_length".to_string(), Json::Int(byte_length));
        map.insert("state".to_string(), Json::Str(state_text));
        map.insert(
            "failed_reason".to_string(),
            match failed_reason {
                Some(r) => Json::Str(r),
                None => Json::Null,
            },
        );
        map.insert("created_at_unix".to_string(), Json::Int(created_at));
        map.insert(
            "staged_at_unix".to_string(),
            match staged_at {
                Some(t) => Json::Int(t),
                None => Json::Null,
            },
        );
        map.insert(
            "staged_seq".to_string(),
            match staged_seq {
                Some(s) => Json::Int(s),
                None => Json::Null,
            },
        );
        // **The hash Fathom computed, or nothing at all.** `declared_sha256`
        // is never rendered anywhere: a hash this server was told is not a
        // hash this server can stand behind.
        match &computed {
            Some(digest) => {
                let sha256 = hex(digest);
                map.insert("sha256".to_string(), Json::Str(sha256.clone()));
                map.insert("commands".to_string(), commands(&filename, &sha256, None));
            }
            None => {
                map.insert("sha256".to_string(), Json::Null);
                map.insert("commands".to_string(), Json::Null);
            }
        }
        out.push(Json::Obj(map));
    }

    Ok(json_response(Json::Arr(out)))
}

// ---------------------------------------------------------------------------
// The commands an operator actually runs
// ---------------------------------------------------------------------------

/// `docs/UPGRADING-A-JUNIPER.md` steps 2 to 7 and ADR-0045 §6's traps, with
/// this image's own filename, hash and — when there is one — fetch URL
/// substituted in.
///
/// **The order is a control, not a listing.** Trap 1 is that `request system
/// storage cleanup` deletes the image you just copied, so cleanup is before the
/// copy here and a reader who works down the list cannot hit it. Trap 5 is the
/// second snapshot, so there are two.
///
/// **Fathom runs none of these** (ADR-0045 §4.4). `note` says so where it
/// matters, because a list of commands with no warning on the install step is
/// how a list of commands becomes a tool that installs.
///
/// Every one of these is a *summary* of Juniper's documentation rather than a
/// verbatim read — `juniper.net` was unreachable on 2026-09-14, which
/// `docs/UPGRADING-A-JUNIPER.md`'s own header states — so the answer carries
/// `"sourced": "summary"` and says where to check it. ADR-0034 is the rule
/// that requires the marking to survive into the API and not only the prose.
fn commands(filename: &str, sha256: &str, url: Option<&str>) -> Json {
    let device_path = format!("{DEVICE_STAGING_DIRECTORY}{filename}");
    let copy_source = match url {
        Some(url) => url.to_string(),
        None => "<the fetch URL, from POST .../fetch-urls — Fathom keeps only its hash and \
                 cannot show you one it already issued>"
            .to_string(),
    };

    let steps: Vec<(&str, String, &str)> = vec![
        (
            "check space first",
            "show system storage".to_string(),
            "/var is the partition that fills. On Junos OS Evolved, 90% or more on /soft, /var \
             or /data means there is not enough room to install.",
        ),
        (
            "make room BEFORE the copy",
            "request system storage cleanup".to_string(),
            "TRAP 1: cleanup can delete the image you just copied. Run it before the copy, \
             never after. `request system storage cleanup dry-run` shows what it would remove.",
        ),
        (
            "take the first snapshot",
            "request system snapshot".to_string(),
            "Copies the running system to alternate media. `request system configuration rescue \
             save` gives `rollback rescue` a known-good configuration to return to.",
        ),
        (
            "have the device pull the image",
            format!("file copy {copy_source} {DEVICE_STAGING_DIRECTORY}"),
            "The device uses its own transfer stack, so the SCP-versus-SFTP question does not \
             arise. Whether Junos verifies TLS certificates on an https:// source could not be \
             established, so nothing here leans on the transport: the next two steps are what \
             establish that the right bytes arrived.",
        ),
        (
            "prove the whole file arrived",
            format!("file checksum sha-256 {device_path}"),
            "TRAP 2, and the reason this feature exists. The answer must equal the `expected_sha256` \
             in this response, which Fathom computed over the bytes it holds. If they differ, \
             delete the file and copy it again.",
        ),
        (
            "prove Juniper made it",
            format!("request system software validate {device_path}"),
            "Checks the vendor signature against a Juniper root certificate. THIS is the \
             authenticity control -- not the published MD5 or SHA-1, which catch a truncated \
             download and not a substituted image. It does not answer 'is this the release I \
             meant', which is yours to check.",
        ),
        (
            "install -- yours to run, not Fathom's",
            format!("request system software add {device_path}"),
            "ADR-0045 §4.4: Fathom stages and verifies and never installs. This line is here so \
             you can copy it, not so that anything runs it.",
        ),
        (
            "and the second snapshot, after it comes back",
            "request system snapshot".to_string(),
            "TRAP 5: skip this and the alternate boot media stays out of step with the primary. \
             `request system software rollback` reverts the last install if the upgrade went \
             wrong.",
        ),
    ];

    let mut out = Vec::with_capacity(steps.len() + 1);
    for (order, (step, command, note)) in steps.into_iter().enumerate() {
        let mut map = BTreeMap::new();
        map.insert("order".to_string(), Json::Int(order as i64 + 1));
        map.insert("step".to_string(), Json::Str(step.to_string()));
        map.insert("command".to_string(), Json::Str(command));
        map.insert("note".to_string(), Json::Str(note.to_string()));
        map.insert("run_by".to_string(), Json::Str("operator".to_string()));
        out.push(Json::Obj(map));
    }

    let mut envelope = BTreeMap::new();
    envelope.insert("expected_sha256".to_string(), Json::Str(sha256.to_string()));
    envelope.insert("device_path".to_string(), Json::Str(device_path));
    envelope.insert("steps".to_string(), Json::Arr(out));
    envelope.insert("sourced".to_string(), Json::Str("summary".to_string()));
    envelope.insert(
        "sourced_note".to_string(),
        Json::Str(
            "juniper.net was unreachable when these were researched (2026-09-14), so these are \
             search summaries describing Juniper's documentation rather than verbatim reads of \
             it. Check them against the hardware guide for your platform and release before a \
             maintenance window you care about. docs/UPGRADING-A-JUNIPER.md carries the same \
             warning and the per-step marking."
                .to_string(),
        ),
    );
    envelope.insert("fathom_runs_none_of_these".to_string(), Json::Bool(true));
    Json::Obj(envelope)
}

// ---------------------------------------------------------------------------
// Sealed metadata
// ---------------------------------------------------------------------------

fn staged_metadata(
    organisation: &str,
    actor: &str,
    image: FirmwareImageId,
    scope: &str,
    filename: &str,
    byte_length: u64,
    sha256: &[u8; 32],
) -> Vec<u8> {
    let mut map = BTreeMap::new();
    map.insert("actor".to_string(), Json::Str(actor.to_string()));
    map.insert("byte_length".to_string(), Json::Int(byte_length as i64));
    map.insert(
        "entry_type".to_string(),
        Json::Str(EntryType::FirmwareStaged.as_str().to_string()),
    );
    map.insert("filename".to_string(), Json::Str(filename.to_string()));
    map.insert("image".to_string(), Json::Str(image.to_string()));
    map.insert(
        "organisation".to_string(),
        Json::Str(organisation.to_string()),
    );
    map.insert("scope".to_string(), Json::Str(scope.to_string()));
    map.insert("sha256".to_string(), Json::Str(hex(sha256)));
    Json::Obj(map).to_canonical_bytes()
}

fn fetch_issued_metadata(
    organisation: &str,
    actor: &str,
    image: FirmwareImageId,
    token_id: FirmwareImageId,
    expires_at_unix: i64,
) -> Vec<u8> {
    let mut map = BTreeMap::new();
    map.insert("actor".to_string(), Json::Str(actor.to_string()));
    map.insert(
        "entry_type".to_string(),
        Json::Str(EntryType::FirmwareFetchIssued.as_str().to_string()),
    );
    map.insert("expires_at_unix".to_string(), Json::Int(expires_at_unix));
    map.insert("image".to_string(), Json::Str(image.to_string()));
    map.insert(
        "organisation".to_string(),
        Json::Str(organisation.to_string()),
    );
    // The token's ID. **Never the token**: this metadata is decryptable by
    // anyone holding the chain key, and a credential in an audit trail is a
    // credential with a second home.
    map.insert("token_id".to_string(), Json::Str(token_id.to_string()));
    Json::Obj(map).to_canonical_bytes()
}

#[allow(clippy::too_many_arguments)]
fn fetch_redeemed_metadata(
    organisation: &str,
    issued_by: &str,
    image: FirmwareImageId,
    token_id: &str,
    byte_length: u64,
    sha256: &[u8],
    source: &str,
) -> Vec<u8> {
    let mut map = BTreeMap::new();
    map.insert("byte_length".to_string(), Json::Int(byte_length as i64));
    map.insert(
        "entry_type".to_string(),
        Json::Str(EntryType::FirmwareFetchRedeemed.as_str().to_string()),
    );
    map.insert("image".to_string(), Json::Str(image.to_string()));
    map.insert("issued_by".to_string(), Json::Str(issued_by.to_string()));
    map.insert(
        "organisation".to_string(),
        Json::Str(organisation.to_string()),
    );
    map.insert("sha256".to_string(), Json::Str(hex(sha256)));
    map.insert("source".to_string(), Json::Str(source.to_string()));
    map.insert("token_id".to_string(), Json::Str(token_id.to_string()));
    Json::Obj(map).to_canonical_bytes()
}

// ---------------------------------------------------------------------------
// The two transaction-local capabilities
// ---------------------------------------------------------------------------

/// Turn on `app.firmware_upload_custody` (`0017` §D).
///
/// The upload path has a token and no session, exactly as `0015`'s enrolment
/// redemption does, and gets its own capability for the same reason: an
/// unauthenticated caller must reach one table and no more. `app.design_capability`
/// is set to its refusal first, so this transaction cannot read a design
/// payload whatever else it does.
async fn enter_upload_custody(tx: &Transaction<'_>) -> Result<(), FirmwareError> {
    tx.execute(
        "SELECT set_config('app.design_capability', 'no', true)",
        &[],
    )
    .await?;
    tx.execute(
        "SELECT set_config('app.firmware_upload_custody', 'yes', true)",
        &[],
    )
    .await?;
    Ok(())
}

/// Turn on `app.firmware_fetch_custody` (`0017` §D). The device's door, and the
/// narrowest capability in this schema: exactly one table names it.
async fn enter_fetch_custody(tx: &Transaction<'_>) -> Result<(), FirmwareError> {
    tx.execute(
        "SELECT set_config('app.design_capability', 'no', true)",
        &[],
    )
    .await?;
    tx.execute(
        "SELECT set_config('app.firmware_fetch_custody', 'yes', true)",
        &[],
    )
    .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Response framing
// ---------------------------------------------------------------------------

fn json_response(j: Json) -> Response {
    (
        StatusCode::OK,
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        j.to_canonical_bytes(),
    )
        .into_response()
}

// ---------------------------------------------------------------------------
// Tests that need no database: the rules that are pure functions
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn json_text(j: &Json) -> String {
        String::from_utf8(j.to_canonical_bytes()).expect("canonical JSON is UTF-8")
    }

    /// CLAUDE.md rule 2: the gate is measured against what a real device
    /// accepts. These are the shapes Juniper actually ships.
    #[test]
    fn a_real_junos_image_name_is_accepted() {
        for name in [
            "junos-install-ex-x86-64-21.4R3-S5.5.tgz",
            "junos-srxsme-15.1X49-D200.3-domestic.tgz",
            "jinstall-host-qfx-5e-x86-64-21.2R3-S4.9-secure-signed.tgz",
            "junos-vmhost-install-mx-x86-64-22.4R2-S2.6.tgz",
        ] {
            assert!(safe_filename(name), "{name} is a real image name");
        }
    }

    /// A filename never becomes a path, and it never becomes a second command
    /// either — it is rendered inside a line an operator pastes into a switch.
    #[test]
    fn a_filename_that_could_escape_a_directory_or_a_command_is_refused() {
        for name in [
            "../../../etc/passwd",
            "..",
            ".",
            "a/b",
            "a\\b",
            ".hidden",
            "junos; request system reboot",
            "junos\nrequest system reboot",
            "junos image.tgz",
            "junos`whoami`.tgz",
            "junos$(id).tgz",
            "junos\"quote.tgz",
            "junos'quote.tgz",
            "",
        ] {
            assert!(!safe_filename(name), "{name:?} must be refused");
        }
        assert!(
            !safe_filename(&"a".repeat(256)),
            "a 256-character name must be refused"
        );
    }

    /// The on-disk name is the id and nothing else, so there is no input to it
    /// that could contain a separator.
    #[test]
    fn the_on_disk_name_is_the_id_and_carries_no_separator() {
        let id = FirmwareImageId::new();
        let name = storage_name(id);
        assert_eq!(name, format!("{id}.img"));
        assert!(!name.contains('/'), "{name}");
        assert!(!name.contains('\\'), "{name}");
        assert!(!name.contains(".."), "{name}");
        assert_eq!(Path::new(&name).components().count(), 1, "{name}");
    }

    /// A directory join can only ever produce a child of the directory.
    #[test]
    fn a_staged_image_path_is_always_inside_the_directory() {
        let store = FirmwareStore {
            directory: PathBuf::from("/srv/fathom/firmware"),
            max_image_bytes: 1,
            fetch_base_url: "https://example.invalid".to_string(),
            client_address: crate::client_address::ClientAddress::peer(),
        };
        let path = store.image_path(FirmwareImageId::new());
        assert!(
            path.starts_with("/srv/fathom/firmware"),
            "{}",
            path.display()
        );
        assert_eq!(path.components().count(), 5, "{}", path.display());
    }

    /// The declaration parser accepts exactly its own framing and nothing
    /// adjacent to it.
    #[test]
    fn the_declaration_framing_round_trips_and_rejects_anything_else() {
        let mut body = Vec::new();
        crypto::lp(&mut body, b"junos-install-21.4R3.tgz");
        crypto::lp(&mut body, &1_234_567_890u64.to_le_bytes());
        crypto::lp(&mut body, &[7u8; 32]);
        let (name, length, digest) = parse_declaration(&body).expect("a well-formed declaration");
        assert_eq!(name, "junos-install-21.4R3.tgz");
        assert_eq!(length, 1_234_567_890);
        assert_eq!(digest, [7u8; 32]);

        assert!(parse_declaration(b"").is_err());
        assert!(parse_declaration(&body[..body.len() - 1]).is_err());
        let mut trailing = body.clone();
        trailing.push(0);
        assert!(
            parse_declaration(&trailing).is_err(),
            "a trailing byte is a different message"
        );
    }

    /// The one-hash rule, as a property of the rendering: what a caller reads
    /// back is the computed hash under the name `sha256`, and the declaration
    /// has no name at all in any answer this module produces.
    #[test]
    fn the_commands_carry_the_hash_they_were_given_and_the_traps_are_in_order() {
        let sha = "a".repeat(64);
        let text = json_text(&commands("junos-install-21.4R3.tgz", &sha, None));
        assert!(text.contains(&sha), "{text}");
        assert!(
            text.contains("file checksum sha-256 /var/tmp/junos-install-21.4R3.tgz"),
            "{text}"
        );
        assert!(
            text.contains("request system software validate /var/tmp/junos-install-21.4R3.tgz"),
            "{text}"
        );
        assert!(text.contains("summary"), "{text}");

        let cleanup = text.find("storage cleanup").expect("cleanup is listed");
        let copy = text.find("file copy").expect("the copy is listed");
        assert!(
            cleanup < copy,
            "trap 1: cleanup must come before the copy, or the list teaches the failure it \
             warns about\n{text}"
        );
    }

    /// With a URL, the copy line is the real one; without, it says why it
    /// cannot be and does not invent one.
    #[test]
    fn the_copy_line_holds_the_real_url_when_there_is_one_and_never_a_fake_one() {
        let sha = "b".repeat(64);
        let with = json_text(&commands(
            "junos.tgz",
            &sha,
            Some("https://fathom.example.net/firmware/fetch/deadbeef"),
        ));
        assert!(
            with.contains("file copy https://fathom.example.net/firmware/fetch/deadbeef /var/tmp/"),
            "{with}"
        );

        let without = json_text(&commands("junos.tgz", &sha, None));
        assert!(!without.contains("/firmware/fetch/"), "{without}");
        assert!(without.contains("cannot show you one"), "{without}");
    }

    /// The token hash is domain-separated from every other token hash in this
    /// server, so one surface's token is not the other's.
    #[test]
    fn a_firmware_token_hashes_differently_from_a_session_token() {
        let token = [9u8; 32];
        assert_ne!(token_hash(&token), sessions::token_hash(&token));
    }
}
