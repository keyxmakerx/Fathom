//! Firmware staging: Fathom accepts an image, proves it is whole, and serves it
//! **once** to a network device that comes and fetches it.
//!
//! Brief: `docs/decisions/adr-0045-firmware-moves-by-the-device-pulling-not-fathom-pushing.md`
//! (§4 decision, §6 traps, §8 consequences). `docs/UPGRADING-A-JUNIPER.md` is the
//! operator procedure this module renders with the real hash substituted.
//! `migrations/0017_firmware_staging.sql` holds the tables. Shape as
//! `src/design_api.rs`: own state, `Signed` and router; `api::router` untouched.
//!
//! # The line this module does not cross
//!
//! **Fathom never connects to a device, holds a device credential, runs an upgrade
//! or modifies a device's configuration.** There is no outbound socket, no column
//! in `0017` a credential could arrive in, and no code path naming a device. The
//! device makes one inbound `GET` for a public vendor artefact (CLAUDE.md rule 4).
//!
//! # Why four routes and not one upload
//!
//! A signature covers a digest of the body, so a signed upload of a one-to-two
//! gigabyte Junos image would buffer it whole before the signature could refuse it.
//!
//! 1. **Declare** (signed, `steward`): filename, byte length and the claimed
//!    SHA-256. Mints a single-use upload token.
//! 2. **Send the bytes** (upload token, no signature): streamed to disk, hashed as
//!    written. The computed hash and length are compared with the declaration;
//!    **on any mismatch the partial file is deleted and the upload refused** (trap
//!    2 of `docs/UPGRADING-A-JUNIPER.md`, the reason this feature exists).
//! 3. **Issue a fetch URL** (signed, `steward`): 256-bit, single-use, short-lived,
//!    bound to one image, sealed on issue and on redemption.
//! 4. **Read back** (signed, `read`): what is staged, the hash Fathom computed, and
//!    the operator commands with it.
//!
//! # The hash reported is never the one it was told
//!
//! `firmware_images.declared_sha256` is a claim and is never rendered.
//! `computed_sha256` is written by one statement, in [`finish_upload`], from a
//! `Sha256` fed the bytes as they went to disk. A lying declaration cannot produce
//! a staged image (`tests/firmware.rs`).
//!
//! # The fetch URL is a credential
//!
//! A switch cannot sign a request, so the URL is the authorisation (ADR-0045
//! §4.2): 256 bits from the kernel CSPRNG, single-use, short-lived, bound to one
//! image, stored only as `H(LP(tag) ‖ LP(token))`, and **never written to a log
//! line**. Nothing here passes the token, or a path containing it, to `tracing`;
//! redemption is logged by image id and byte count.
//!
//! # No range requests, deliberately
//!
//! The whole file or nothing: no `Accept-Ranges`, and `Range` is ignored (RFC 9110
//! §14.2 permits it). ADR-0045 does not say whether a partial read spends a
//! single-use token, and half-answering would make it single-use except when not.
//!
//! # No `HEAD`, deliberately
//!
//! axum answers `HEAD` with the `GET` handler, which would spend the token on a
//! request that carries no bytes and leave the device's real `GET` refused. So
//! `HEAD` is its own route and answers `405` without touching the token.
//!
//! # Nothing holds an image in memory
//!
//! Upload writes to disk as bytes arrive ([`stream_to_disk`]); download streams
//! from disk ([`fetch_handler`], `ReaderStream` over a [`tokio::fs::File`]). A fetch
//! holds [`FETCH_CHUNK`] bytes, not `max_image_bytes` (hence `tokio-util` as a
//! direct dependency, `deps/decisions/tokio-util.md`). This matters because the
//! fetch is the one route an unauthenticated caller reaches: a per-caller
//! gibibyte would be a denial-of-service surface for anyone holding one URL.
//!
//! Two properties are load-bearing (restated at [`fetch_handler`]): redemption is
//! **sealed and committed before the first byte reaches the socket**, and the token
//! is spent **exactly once** whether or not the transfer completes.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;

use axum::body::{Body, Bytes, HttpBody};
use axum::extract::{FromRequest, Path as PathExtractor, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::Router;
use deadpool_postgres::Transaction;
use sha2::{Digest, Sha256, Sha512};

use fathom_canon::Json;

use crate::api;
use crate::authority::Capability;
use crate::chain::EntryType;
use crate::chains::{self, ChainStoreError};
use crate::crypto::hex;
use crate::crypto::{self, CryptoError};
use crate::crypto::{now_unix, unhex};
use crate::firmware_commands::commands_with;
use crate::grants::{self, Authority, EpochWatch};
use crate::keys::{self, KeyRing, KeyStoreError};
use crate::repo::{self, FirmwareImageId, OrganisationId, RepoError, ScopeId};
use crate::sessions::{
    self, PendingRequest, SessionError, SessionStore, SignedRequest, VerifiedSession,
};

// ---- Constants that are this module's own ----

/// How long a declaration's upload token is good for. An hour, because a
/// one-to-two-gigabyte transfer over the operator's link can be slow and a token
/// expiring mid-upload costs the whole transfer. It is spent at the START of the
/// upload, so the window bounds when the transfer may BEGIN.
pub const UPLOAD_TOKEN_LIFETIME_SECONDS: i64 = 60 * 60;

/// How long a fetch URL is good for. Fifteen minutes: the operator issues it,
/// pastes one `file copy` command and watches it run. ADR-0045 §4.2 asks for
/// short-lived without a number; promote this to configuration if a real
/// maintenance window disagrees.
pub const FETCH_TOKEN_LIFETIME_SECONDS: i64 = 15 * 60;

/// Uploads in flight at once for one organisation, and for the whole server
/// (sign-off r62). An upload past either is refused with `429` and its token kept,
/// so the same token can try again a minute later. Downloads by devices are not
/// limited: upgrading a dozen switches at once is a normal night.
pub const UPLOADS_AT_ONCE_PER_ORGANISATION: usize = 1;
pub const UPLOADS_AT_ONCE_PER_SERVER: usize = 3;

/// An upload that sends nothing for this long is dropped and its file deleted, so a
/// stalled or deliberately slow sender cannot hold a slot. A slow upload that keeps
/// moving is never cut off.
pub const UPLOAD_IDLE_SECONDS: u64 = 120;

/// Default for `FATHOM_FIRMWARE_ORGANISATION_MAX_BYTES`: what one organisation's
/// images may add up to (sign-off r62). Twenty gibibytes.
pub const DEFAULT_ORGANISATION_MAX_BYTES: u64 = 20 * 1024 * 1024 * 1024;

/// Default for `FATHOM_FIRMWARE_TOTAL_MAX_BYTES`: what every image file in the
/// staging directory may add up to. Fifty gibibytes. **This stands in for a
/// free-space check**: std has no portable free-space call and reading one needs a
/// new dependency, so the operator sets this below what the volume can hold
/// (`docs/OPERATING.md`). It is what keeps firmware from filling a disk the
/// database shares.
pub const DEFAULT_TOTAL_MAX_BYTES: u64 = 50 * 1024 * 1024 * 1024;

/// The header the upload's bytes carry their token in. A header, not a query
/// parameter: a token in a URL reaches proxy logs, browser history and
/// `Referer`. The fetch URL has no choice (a switch can only be given a URL),
/// which is why it is single-use and expires in minutes.
pub const HEADER_UPLOAD_TOKEN: &str = "fathom-firmware-upload-token";

/// How much of a signed body this module's routes accept. They carry a filename
/// and forty bytes; the image never travels on a signed route, so this is
/// smaller than `api::MAX_SIGNED_BODY`.
pub const MAX_SIGNED_BODY: usize = 64 * 1024;

/// Memory held between socket and disk on upload: four mebibytes, flushed
/// through `spawn_blocking` ([`stream_to_disk`]).
const UPLOAD_CHUNK: usize = 4 * 1024 * 1024;

/// Memory held between disk and socket on fetch: **this, not the image size.**
///
/// 256 KiB. `ReaderStream`'s 4 KiB default means over five hundred thousand
/// `spawn_blocking` round trips for two gibibytes. What matters is that it is a
/// constant, so a hundred concurrent fetches cost a hundred of these rather than
/// a hundred images.
const FETCH_CHUNK: usize = 256 * 1024;

/// The domain separator for a firmware token's stored hash; a new use of a hash
/// gets its own label, as `sessions::token_hash`'s does.
const TAG_FIRMWARE_TOKEN: &[u8] = b"fathom/firmware/token/v1";

// ---- State ----

/// Everything this module's routes need. Deliberately not [`api::ApiState`] or
/// `design_api::DesignApiState`: a shared state type is how parallel builders
/// collide.
#[derive(Clone)]
pub struct FirmwareState {
    pub sessions: Arc<SessionStore>,
    pub watch: Arc<EpochWatch>,
    pub ring: Arc<KeyRing>,
    pub store: Arc<FirmwareStore>,
}

/// The directory images live in, and a few numbers around it.
///
/// **Checked at startup, not at first upload.** [`FirmwareStore::open`] writes
/// and removes a probe file, so a read-only or missing volume fails at start with
/// the path named, not in the middle of the first two-gigabyte transfer.
pub struct FirmwareStore {
    directory: PathBuf,
    max_image_bytes: u64,
    organisation_max_bytes: u64,
    total_max_bytes: u64,
    upload_idle: std::time::Duration,
    fetch_base_url: String,
    client_address: crate::client_address::ClientAddress,
    /// Uploads in flight, counted in this process. Several servers behind one
    /// load balancer each keep their own count, so the server-wide limit is per
    /// process; the per-organisation total is read from the database and holds
    /// across all of them.
    slots: std::sync::Mutex<Slots>,
}

#[derive(Default)]
struct Slots {
    total: usize,
    by_organisation: std::collections::HashMap<String, usize>,
}

/// One upload's place in [`Slots`], given back when it is dropped: on success, on
/// refusal and on a panic alike.
pub struct UploadSlot {
    store: Arc<FirmwareStore>,
    organisation: String,
}

impl Drop for UploadSlot {
    fn drop(&mut self) {
        let mut slots = self.store.slots.lock().unwrap_or_else(|e| e.into_inner());
        slots.total = slots.total.saturating_sub(1);
        if let Some(n) = slots.by_organisation.get_mut(&self.organisation) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                slots.by_organisation.remove(&self.organisation);
            }
        }
    }
}

impl FirmwareStore {
    /// Open the staging directory, or refuse with a message saying what to fix.
    ///
    /// `fetch_base_url` is the origin a NETWORK DEVICE can reach this server at, not
    /// what the browser used. It is rendered into the `file copy` command, so a wrong
    /// value gives a command that does not work, not a security problem. The server
    /// cannot discover it.
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
            organisation_max_bytes: DEFAULT_ORGANISATION_MAX_BYTES,
            total_max_bytes: DEFAULT_TOTAL_MAX_BYTES,
            upload_idle: std::time::Duration::from_secs(UPLOAD_IDLE_SECONDS),
            fetch_base_url: fetch_base_url.trim_end_matches('/').to_string(),
            client_address,
            slots: std::sync::Mutex::new(Slots::default()),
        })
    }

    /// What one organisation's images, and every image on this server, may add up
    /// to. Both default to [`DEFAULT_ORGANISATION_MAX_BYTES`] and
    /// [`DEFAULT_TOTAL_MAX_BYTES`].
    pub fn with_space_limits(mut self, organisation_max_bytes: u64, total_max_bytes: u64) -> Self {
        self.organisation_max_bytes = organisation_max_bytes;
        self.total_max_bytes = total_max_bytes;
        self
    }

    /// How long an upload may send nothing before it is dropped. [`UPLOAD_IDLE_SECONDS`]
    /// unless a test shortens it.
    pub fn with_upload_idle(mut self, idle: std::time::Duration) -> Self {
        self.upload_idle = idle;
        self
    }

    pub fn max_image_bytes(&self) -> u64 {
        self.max_image_bytes
    }

    /// A place for one upload, or `None` when this organisation or this server
    /// already has as many in flight as it may.
    fn take_slot(self: &Arc<Self>, organisation: &str) -> Option<UploadSlot> {
        let mut slots = self.slots.lock().unwrap_or_else(|e| e.into_inner());
        let mine = slots
            .by_organisation
            .get(organisation)
            .copied()
            .unwrap_or(0);
        if slots.total >= UPLOADS_AT_ONCE_PER_SERVER || mine >= UPLOADS_AT_ONCE_PER_ORGANISATION {
            return None;
        }
        slots.total += 1;
        *slots
            .by_organisation
            .entry(organisation.to_string())
            .or_insert(0) += 1;
        Some(UploadSlot {
            store: Arc::clone(self),
            organisation: organisation.to_string(),
        })
    }

    /// The bytes every image and partial upload in the staging directory holds now.
    async fn bytes_on_disk(&self) -> Result<u64, FirmwareError> {
        let directory = self.directory.clone();
        tokio::task::spawn_blocking(move || {
            let mut total = 0u64;
            for entry in std::fs::read_dir(&directory)? {
                let entry = entry?;
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.ends_with(".img") || name.ends_with(".part") {
                    total = total.saturating_add(entry.metadata()?.len());
                }
            }
            Ok::<u64, std::io::Error>(total)
        })
        .await
        .map_err(joined)?
        .map_err(FirmwareError::Storage)
    }

    /// Where one image's bytes live. **The only place in this server that builds a
    /// path**, and from an id this server minted, never a caller's name.
    fn image_path(&self, image: FirmwareImageId) -> PathBuf {
        self.directory.join(storage_name(image))
    }

    /// Where the bytes go while arriving. A `.part` file is never served, so a `.img`
    /// file only exists complete.
    fn partial_path(&self, image: FirmwareImageId) -> PathBuf {
        self.directory.join(format!("{}.part", ulid_text(image)))
    }
}

/// What a staged image is called on disk: the id and nothing else. A ULID is 26
/// characters of Crockford base32 (digits and capitals minus `I`, `L`, `O`, `U`),
/// so it holds no separator, `.` or `..`. This re-checks the alphabet and panics
/// otherwise: the only way to get a bad value here is for
/// [`repo::FirmwareImageId`] or `0017`'s `CHECK` to have stopped meaning what they
/// say, and continuing would join an unknown string to a directory.
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

/// The staging directory cannot be used; said at startup, not at first upload.
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

// ---- The router ----

/// This module's routes, to `merge` into the main router. Nothing is added to
/// `api::router` or `design_api::router`.
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
        .route(
            "/organisations/{organisation}/firmware/{image}/models",
            put(models_handler),
        )
        .route(
            "/organisations/{organisation}/firmware/{image}/retire",
            post(retire_handler),
        )
        .route(
            "/firmware/fetch/{token}",
            get(fetch_handler).head(head_refused),
        )
        .with_state(state)
}

// ---- Errors ----

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
    /// The image exists but is not staged, so there is nothing whole to serve or
    /// issue a URL for.
    NotStaged,
    /// A declaration was already made and its bytes have arrived or are arriving.
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

    /// The token was never issued, already spent, or expired. **One variant for all
    /// three**, as `SessionError::NonceNotFresh` does: telling them apart tells a
    /// caller which guess was closer.
    TokenNotFresh,

    /// Something about the filesystem. Never rendered to the caller in detail.
    Storage(std::io::Error),

    /// This organisation, or this server, already has as many uploads in flight as
    /// it may. The token is not spent.
    Busy,
    /// Staging this image would take the organisation's images, or every image on
    /// this server, past what they may add up to.
    OverSpace {
        used: u64,
        requested: u64,
        max: u64,
        whole_server: bool,
    },
    /// The upload sent nothing for [`UPLOAD_IDLE_SECONDS`]; the partial file was
    /// deleted.
    Stalled,
    /// **The file on disk is not the file that was staged.** Its SHA-256, read again
    /// just before sending, differs from the one computed at upload. Nothing is sent.
    ImageChanged,
}

/// For an operator reading a log line, never the network; [`IntoResponse`] below
/// holds the network's fixed sentence per status.
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
            Self::Busy => f.write_str("another firmware upload is already running"),
            Self::OverSpace {
                used,
                requested,
                max,
                whole_server,
            } => write!(
                f,
                "staging {requested} more bytes would take {} past {max} (it holds {used})",
                if *whole_server {
                    "this server's firmware"
                } else {
                    "this organisation's firmware"
                }
            ),
            Self::Stalled => write!(
                f,
                "the upload sent nothing for {UPLOAD_IDLE_SECONDS} seconds and was dropped"
            ),
            Self::ImageChanged => f.write_str(
                "a staged image's bytes no longer have the SHA-256 computed when it was uploaded",
            ),
        }
    }
}

impl core::fmt::Debug for FirmwareError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        // The same sentence; a `Debug` derive would add only noise.
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
            // Reuses `api::Refusal`'s tested mapping: every authorisation refusal becomes
            // the identical `403 not authorised` body, so a `draw` caller cannot tell a real
            // organisation from one that does not exist.
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

            // The one refusal that explains itself, deliberately: the caller is the operator
            // who declared the image, the fact concerns their own bytes, and trap 2 exists
            // because this failure is normally SILENT.
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
                // No detail, no token in the log, one message for all three causes.
                tracing::info!(
                    "a firmware token was refused: not issued, already spent, or expired"
                );
                (StatusCode::UNAUTHORIZED, "not authenticated\n").into_response()
            }

            Self::Storage(e) => {
                tracing::error!(reason = %e, "firmware storage failed");
                (StatusCode::INTERNAL_SERVER_ERROR, "refused\n").into_response()
            }

            Self::Busy => (
                StatusCode::TOO_MANY_REQUESTS,
                [(axum::http::header::RETRY_AFTER, "30")],
                "another firmware upload is running for this organisation or on this server. \
                 Your upload token is still good: try again in a minute\n",
            )
                .into_response(),
            Self::OverSpace {
                used,
                requested,
                max,
                whole_server,
            } => (
                StatusCode::INSUFFICIENT_STORAGE,
                format!(
                    "there is no room for this image. {} firmware holds {used} bytes of the \
                     {max} it may, and this image is {requested}. {}\n",
                    if whole_server {
                        "This server's"
                    } else {
                        "This organisation's"
                    },
                    if whole_server {
                        "Ask the server's operator to raise FATHOM_FIRMWARE_TOTAL_MAX_BYTES or \
                         free space"
                    } else {
                        "Retire an image you no longer need, or ask the server's operator to \
                         raise FATHOM_FIRMWARE_ORGANISATION_MAX_BYTES"
                    }
                ),
            )
                .into_response(),
            Self::Stalled => (
                StatusCode::REQUEST_TIMEOUT,
                format!(
                    "the upload sent nothing for {UPLOAD_IDLE_SECONDS} seconds, so it was dropped \
                     and nothing was staged. Declare the image again to retry\n"
                ),
            )
                .into_response(),
            Self::ImageChanged => {
                tracing::error!(
                    "a staged firmware image changed on disk after it was uploaded; refusing to \
                     send it"
                );
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "this image has changed on the server since it was uploaded, so it was not \
                     sent. Tell the server's operator, and upload it again from the vendor\n",
                )
                    .into_response()
            }
        }
    }
}

// ---- The signed extractor: `api::Signed`'s shape for this state ----

/// A request whose single-use nonce has been spent and which awaits verification
/// inside the handler's own transaction.
///
/// Verification and the authorisation after it share one database snapshot (see
/// `api::Signed`, `design_api::Signed`), so this is deliberately a third
/// implementation, not a shortcut to a shared one.
pub struct Signed {
    pending: PendingRequest,
    body: Bytes,
    /// ADR-0057 decision 7, captured at extraction like `api::Signed`'s.
    address: String,
}

impl Signed {
    async fn verify(
        &self,
        state: &FirmwareState,
        tx: &Transaction<'_>,
    ) -> Result<VerifiedSession, SessionError> {
        let session = state.sessions.verify_pending(tx, &self.pending).await?;
        state
            .sessions
            .check_session_address(tx, session.id(), &self.address)
            .await?;
        Ok(session)
    }

    /// As [`Signed::verify`], but commits `tx` whatever the outcome and hands it back
    /// on success. `verify` only borrows `tx`, so an ending it makes there would be
    /// undone when the route refuses the request that found it.
    async fn verify_and_commit<'a>(
        &self,
        state: &FirmwareState,
        tx: Transaction<'a>,
    ) -> Result<(VerifiedSession, Transaction<'a>), SessionError> {
        match self.verify(state, &tx).await {
            Ok(session) => Ok((session, tx)),
            Err(e) => {
                let _ = tx.commit().await;
                Err(e)
            }
        }
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
        let address = state.store.client_address.of(&headers, &parts.extensions);

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

        Ok(Self {
            pending,
            body,
            address,
        })
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

/// The stored form of a firmware token: `H(LP(tag) ‖ LP(token))`, as
/// `sessions::token_hash` does under its own label, so one surface's token cannot
/// be presented at the other.
pub fn token_hash(token: &[u8]) -> [u8; 32] {
    let mut msg = Vec::with_capacity(96);
    crypto::lp(&mut msg, TAG_FIRMWARE_TOKEN);
    crypto::lp(&mut msg, token);
    Sha256::digest(&msg).into()
}

/// 256 bits from the kernel CSPRNG, for a token that is the whole authorisation.
fn fresh_token() -> Result<[u8; 32], CryptoError> {
    Ok(*crypto::Key32::random()?.expose())
}

// ---- Filenames, which never become paths ----

/// Whether this is a filename this server will carry.
///
/// **Two reasons, neither "to build a path from it"** ([`FirmwareStore::image_path`]
/// uses the id):
///
/// 1. It is rendered inside a command an operator pastes into a switch
///    (`file checksum sha-256 /var/tmp/<filename>`); a space, quote, newline or
///    `;` turns one command into two.
/// 2. A name with `/` or `..` is a caller trying something; storing it makes such
///    values look normal.
///
/// Letters, digits, `.`, `-`, `_`; not starting with `.`; 1 to 255 bytes. Real names
/// such as `junos-install-ex-x86-64-21.4R3-S5.5.tgz` fit (CLAUDE.md rule 2).
pub fn safe_filename(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 255
        && !name.starts_with('.')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b'_')
}

// ---- Authorisation, shared by the routes that take a session ----

/// Open the tenant context and authorise `needed` on `scope`, in `tx`.
///
/// A non-member and a caller naming a nonexistent organisation both come out of
/// `repo::open_tenant_context` as `RepoError::NotAMember` and render as the same
/// `403 not authorised`, which the refusal tests assert byte for byte.
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

// ---- 1. Declare ----

/// `POST /organisations/{organisation}/scopes/{scope}/firmware`: declare an image
/// and take a one-time upload token. **Requires `steward`.**
///
/// Body (length-prefixed): `LP(filename) ‖ LP(byte_length, 8 bytes LE) ‖ LP(sha256)
/// [‖ LP(platform) [‖ LP(version) [‖ LP(models)]]]`. The last three are optional and
/// an empty one means "not given"; `models` is catalogue model ids joined by commas.
/// A three-field body is exactly what it was before `0038`.
///
/// Answers canonical JSON: image id, platform, version and models (null, null, []
/// when not given), where to send the bytes, the token, and its expiry. **The
/// declared hash is not echoed**: it is a claim.
async fn declare_handler(
    State(state): State<FirmwareState>,
    PathExtractor((organisation, scope)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, FirmwareError> {
    let tenant = parse_organisation(&organisation)?;
    let scope_id = parse_scope(&scope)?;

    let Declaration {
        filename,
        byte_length,
        sha256: declared,
        platform,
        version,
        models,
    } = parse_declaration(&signed.body)?;
    if !safe_filename(&filename) {
        return Err(FirmwareError::UnsafeFilename);
    }
    if platform.as_deref().is_some_and(|p| !safe_platform(p)) {
        return Err(FirmwareError::Malformed(PLATFORM_SHAPE));
    }
    if version.as_deref().is_some_and(|v| !safe_version(v)) {
        return Err(FirmwareError::Malformed(VERSION_SHAPE));
    }
    if byte_length == 0 || byte_length > state.store.max_image_bytes {
        return Err(FirmwareError::TooLarge {
            bytes: byte_length,
            max: state.store.max_image_bytes,
        });
    }

    let mut client = state.sessions.pool().get().await?;
    let tx = client.transaction().await?;
    let (session, tx) = signed.verify_and_commit(&state, tx).await?;
    let ctx = authorise_in(
        &tx,
        &state,
        &session,
        tenant,
        Some(scope_id),
        Capability::Steward,
    )
    .await?;

    // -- room for it (sign-off r62) --
    // The organisation's images: staged ones, and declared ones whose upload can
    // still start or has started. A declaration whose token expired unused holds
    // nothing.
    let used: i64 = tx
        .query_one(
            "SELECT coalesce(sum(i.byte_length), 0)::bigint FROM firmware_images i \
             WHERE i.organisation_id = $1 AND (i.state = 'staged' OR (i.state = 'declared' \
               AND EXISTS (SELECT 1 FROM firmware_upload_tokens t WHERE t.image_id = i.id \
                 AND (t.redeemed_at IS NOT NULL OR t.expires_at > now()))))",
            &[&ctx.tenant().to_string()],
        )
        .await?
        .get(0);
    let used = used.max(0) as u64;
    if used.saturating_add(byte_length) > state.store.organisation_max_bytes {
        return Err(FirmwareError::OverSpace {
            used,
            requested: byte_length,
            max: state.store.organisation_max_bytes,
            whole_server: false,
        });
    }
    let on_disk = state.store.bytes_on_disk().await?;
    if on_disk.saturating_add(byte_length) > state.store.total_max_bytes {
        return Err(FirmwareError::OverSpace {
            used: on_disk,
            requested: byte_length,
            max: state.store.total_max_bytes,
            whole_server: true,
        });
    }

    let image = FirmwareImageId::new();
    // `WHERE EXISTS` against `scopes`, as `designs::create_design` does: a scope id
    // from another organisation inserts nothing, and the row count is checked so an
    // insert that matched nothing cannot hand back an id for a nonexistent image.
    let inserted = tx
        .execute(
            "INSERT INTO firmware_images \
                 (id, organisation_id, scope_id, filename, byte_length, declared_sha256, \
                  state, created_by, platform, version, models) \
             SELECT $1, $2, $3, $4, $5, $6, 'declared', $7, $8, $9, $10 WHERE EXISTS \
                 (SELECT 1 FROM scopes WHERE id = $3 AND organisation_id = $2)",
            &[
                &image.to_string(),
                &ctx.tenant().to_string(),
                &scope_id.to_string(),
                &filename,
                &(byte_length as i64),
                &declared.to_vec(),
                &ctx.actor().to_string(),
                &platform,
                &version,
                &models,
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

    // **No chain entry here.** A declaration stages nothing; an entry per
    // declaration would let a steward grow the sealed audit with acts that did not
    // happen. The sealed record starts when an image is staged.
    let mut map = BTreeMap::new();
    map.insert("image_id".to_string(), Json::Str(image.to_string()));
    map.insert("filename".to_string(), Json::Str(filename));
    map.insert("byte_length".to_string(), Json::Int(byte_length as i64));
    map.insert("platform".to_string(), opt_str(platform));
    map.insert("version".to_string(), opt_str(version));
    map.insert("models".to_string(), strings(&models));
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

/// What a declaration said. `platform` and `version` are `None` when absent or
/// sent empty; they are checked by [`safe_platform`] / [`safe_version`] by the caller.
struct Declaration {
    filename: String,
    byte_length: u64,
    sha256: [u8; 32],
    platform: Option<String>,
    version: Option<String>,
    models: Vec<String>,
}

/// Three fields as before, then optionally `LP(platform)`, `LP(version)` and
/// `LP(models)`. A three-field body (every client before 0038) parses exactly as it
/// did; an empty field means "not given", so a version can be sent without a platform.
fn parse_declaration(body: &[u8]) -> Result<Declaration, FirmwareError> {
    let bad = || FirmwareError::Malformed("declaration body");
    let (filename, rest) = crypto::read_lp(body).ok_or_else(bad)?;
    let (length, rest) = crypto::read_lp(rest).ok_or_else(bad)?;
    let (digest, mut rest) = crypto::read_lp(rest).ok_or_else(bad)?;
    let mut optional = [None, None, None];
    for slot in &mut optional {
        if rest.is_empty() {
            break;
        }
        let (field, tail) = crypto::read_lp(rest).ok_or_else(bad)?;
        rest = tail;
        if !field.is_empty() {
            *slot = Some(String::from_utf8(field.to_vec()).map_err(|_| bad())?);
        }
    }
    if !rest.is_empty() {
        return Err(bad());
    }
    let [platform, version, models] = optional;
    let models = match models {
        None => Vec::new(),
        Some(text) => split_models(&text).ok_or(FirmwareError::Malformed(MODELS_SHAPE))?,
    };
    let filename =
        String::from_utf8(filename.to_vec()).map_err(|_| FirmwareError::UnsafeFilename)?;
    let length: [u8; 8] = length
        .try_into()
        .map_err(|_| FirmwareError::Malformed("declared byte length"))?;
    let digest: [u8; 32] = digest
        .try_into()
        .map_err(|_| FirmwareError::Malformed("declared sha256"))?;
    Ok(Declaration {
        filename,
        byte_length: u64::from_le_bytes(length),
        sha256: digest,
        platform,
        version,
        models,
    })
}

const WARNINGS_SHAPE: &str = "warnings_passed (each of downgrade, not_chosen, wrong_model at \
                              most once, sorted), or no body";

const MODELS_SHAPE: &str = "models (at most 16 distinct catalogue model ids, each 1 to 64 \
                            characters of letters, digits and - _ . / +)";

/// Most model ids one image may name.
pub const MAX_MODELS: usize = 16;

/// A catalogue model id: 1 to 64 bytes of letters, digits and `- _ . / +`, the same
/// rule as `0038`'s `firmware_models_ok`.
pub fn safe_model(model: &str) -> bool {
    (1..=64).contains(&model.len())
        && model
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_./+".contains(&b))
}

/// A whole list: at most [`MAX_MODELS`], each [`safe_model`], no duplicates.
pub fn safe_models(models: &[String]) -> bool {
    models.len() <= MAX_MODELS
        && models.iter().all(|m| safe_model(m))
        && models
            .iter()
            .enumerate()
            .all(|(i, m)| !models[..i].contains(m))
}

/// The declare field's comma-joined list, checked. `None` if it is not a valid list
/// (a comma is not in a model id, so the split is unambiguous; `a,,b` is refused).
fn split_models(text: &str) -> Option<Vec<String>> {
    let models: Vec<String> = text.split(',').map(str::to_string).collect();
    safe_models(&models).then_some(models)
}

fn strings(items: &[String]) -> Json {
    Json::Arr(items.iter().cloned().map(Json::Str).collect())
}

const PLATFORM_SHAPE: &str =
    "platform (a short slug: lower-case letters, digits and dash, 1 to 32 characters)";
const VERSION_SHAPE: &str = "version (letters, digits and . ( ) - _ only, 1 to 64 characters)";

/// A platform slug such as `junos`, `ios-xe`, `nx-os`, `eos`: `^[a-z0-9-]{1,32}$`,
/// the same rule as `0038`'s `CHECK`. It selects which vendor's steps are rendered
/// and is echoed back, so it is kept to what cannot become part of a command.
pub fn safe_platform(platform: &str) -> bool {
    (1..=32).contains(&platform.len())
        && platform
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// A release string as vendors write it (`21.4R3-S5.5`, `17.09.04a`, `10.3(4a)`):
/// letters, digits and `. ( ) - _`, 1 to 64 bytes, the same rule as `0038`'s `CHECK`.
pub fn safe_version(version: &str) -> bool {
    (1..=64).contains(&version.len())
        && version
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".()-_".contains(&b))
}

fn opt_str(value: Option<String>) -> Json {
    match value {
        Some(text) => Json::Str(text),
        None => Json::Null,
    }
}

// ---- 2. The bytes ----

/// `POST /firmware/uploads/{image}`: the image itself, streamed to disk.
///
/// **Not signed**: a signature covers a digest of the body, which means holding two
/// gigabytes. The authorisation is the single-use token from the declaration, in
/// [`HEADER_UPLOAD_TOKEN`], good for one thing: filling in the image its
/// declaration named, at that length and hash. The body is never held whole.
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

    let mut client = state.sessions.pool().get().await?;

    // -- a place to upload into, taken BEFORE the token is spent --
    // So an upload refused for being one too many keeps its token and can try
    // again. The look-up spends nothing; the guarded UPDATE below is still what
    // makes the token single-use.
    let peek = client.transaction().await?;
    enter_upload_custody(&peek).await?;
    let owner: String = peek
        .query_opt(
            "SELECT organisation_id FROM firmware_upload_tokens \
             WHERE token_hash = $1 AND image_id = $2 AND redeemed_at IS NULL \
               AND expires_at > now()",
            &[&token_hash(&token).to_vec(), &image.to_string()],
        )
        .await?
        .ok_or(FirmwareError::TokenNotFresh)?
        .get(0);
    peek.commit().await?;
    let _slot = state.store.take_slot(&owner).ok_or(FirmwareError::Busy)?;

    // -- spend the token, and read the declaration it belongs to --
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

    // The tenant comes OFF THE ROW just read, never the request
    // (`repo::set_custody_tenant`; `grants::suspend_grant_by_operator` does the
    // same for the other act with no membership to pin from).
    repo::set_custody_tenant(&tx, &organisation).await?;

    let row = tx
        .query_opt(
            "SELECT byte_length, declared_sha256, state, created_by, scope_id, filename, \
                    platform, version, models \
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
    let platform: Option<String> = row.get(6);
    let version: Option<String> = row.get(7);
    let models: Vec<String> = row.get(8);
    if state_text != "declared" {
        return Err(FirmwareError::AlreadyUploaded);
    }
    tx.commit().await?;

    let declared_length = declared_length as u64;

    // -- the bytes --
    let partial = state.store.partial_path(image);
    let outcome = stream_to_disk(&partial, body, declared_length, state.store.upload_idle).await;

    let (received, computed, sha512) = match outcome {
        Ok(hashed) => hashed,
        Err(e) => {
            remove_quietly(&partial).await;
            mark_failed(&state, &organisation, image, "write_failed").await?;
            return Err(e);
        }
    };

    let hash_matched = computed.as_slice() == declared_digest.as_slice();
    if received != declared_length || !hash_matched {
        // **Delete first, then record.** A partial file outliving its refusal is what
        // trap 2 is about.
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
        Labels {
            filename: &filename,
            platform: platform.as_deref(),
            version: version.as_deref(),
            models: &models,
        },
        &created_by,
        received,
        Digests {
            sha256: computed,
            sha512,
        },
        &partial,
    )
    .await
}

/// The two hashes Fathom worked out from an upload's bytes.
struct Digests {
    sha256: [u8; 32],
    sha512: [u8; 64],
}

/// The operator's labels for an image, as sealed when it is staged.
struct Labels<'a> {
    filename: &'a str,
    platform: Option<&'a str>,
    version: Option<&'a str>,
    models: &'a [String],
}

/// Read the body frame by frame, write through a bounded buffer, hash on the way.
///
/// **`std::fs` inside `spawn_blocking`, not `tokio::fs`**: this crate's tokio has no
/// `fs` feature, and enabling one is a dependency decision. The cost is per-call
/// efficiency, hence a four-mebibyte buffer.
///
/// Refuses as soon as the body passes the declared length, so a small declaration
/// cannot make the server write an unbounded file.
async fn stream_to_disk(
    partial: &Path,
    mut body: Body,
    declared_length: u64,
    idle: std::time::Duration,
) -> Result<(u64, [u8; 32], [u8; 64]), FirmwareError> {
    let path = partial.to_path_buf();
    let mut sink = tokio::task::spawn_blocking(move || {
        std::fs::File::create(&path).map(|file| Sink {
            file,
            hasher: Sha256::new(),
            sha512: Sha512::new(),
            written: 0,
        })
    })
    .await
    .map_err(joined)?
    .map_err(FirmwareError::Storage)?;

    let mut buffer: Vec<u8> = Vec::with_capacity(UPLOAD_CHUNK);
    loop {
        // Each frame must arrive within `idle` of the last, or the upload is dropped.
        let frame = tokio::time::timeout(
            idle,
            std::future::poll_fn(|cx| Pin::new(&mut body).poll_frame(cx)),
        )
        .await
        .map_err(|_| FirmwareError::Stalled)?;
        let Some(frame) = frame else { break };
        let frame = frame.map_err(|_| FirmwareError::Malformed("request body"))?;
        let Ok(data) = frame.into_data() else {
            // A trailer, which this route does not use.
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
    let (digest, sha512) = tokio::task::spawn_blocking(move || {
        use std::io::Write;
        sink.file.flush()?;
        sink.file.sync_all()?;
        Ok::<([u8; 32], [u8; 64]), std::io::Error>((
            sink.hasher.finalize().into(),
            sink.sha512.finalize().into(),
        ))
    })
    .await
    .map_err(joined)?
    .map_err(FirmwareError::Storage)?;

    Ok((written, digest, sha512))
}

struct Sink {
    file: std::fs::File,
    hasher: Sha256,
    /// The SHA-512 from the same pass (`0059`), for vendors that publish one.
    sha512: Sha512,
    written: u64,
}

/// One buffer, written and hashed on the blocking pool, both halves moved back so
/// the allocation is reused.
async fn flush(mut sink: Sink, mut buffer: Vec<u8>) -> Result<(Sink, Vec<u8>), FirmwareError> {
    let (sink, buffer) = tokio::task::spawn_blocking(move || {
        use std::io::Write;
        sink.file.write_all(&buffer)?;
        sink.hasher.update(&buffer);
        sink.sha512.update(&buffer);
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
/// No chain entry: nothing was staged. The row is the record, and it stops the
/// image id being reused: a retry is a new declaration, so a caller cannot try
/// repeatedly against one hash.
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

/// The bytes matched: move the file into place, seal the fact, mark the row
/// staged.
///
/// **The rename comes before the database write.** A `.img` file with a
/// `declared` row serves nothing and is the safe disagreement (`0017` §A); a
/// `staged` row with no file would be the dangerous one, and this order cannot
/// produce it.
#[allow(clippy::too_many_arguments)]
async fn finish_upload(
    state: &FirmwareState,
    organisation: &str,
    image: FirmwareImageId,
    scope_id: &str,
    labels: Labels<'_>,
    created_by: &str,
    received: u64,
    digests: Digests,
    partial: &Path,
) -> Result<Response, FirmwareError> {
    let computed = digests.sha256;
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
        &labels,
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

    // `computed_sha256` is written HERE from this variable; nothing reads
    // `declared_sha256` into it.
    let updated = tx
        .execute(
            "UPDATE firmware_images \
                SET state = 'staged', computed_sha256 = $3, staged_at = now(), staged_seq = $4, \
                    computed_sha512 = $5, last_checked_at = now() \
             WHERE id = $1 AND organisation_id = $2 AND state = 'declared'",
            &[
                &image.to_string(),
                &organisation,
                &computed.to_vec(),
                &appended.seq,
                &digests.sha512.to_vec(),
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
    map.insert("sha512".to_string(), Json::Str(hex(&digests.sha512)));
    map.insert("staged_seq".to_string(), Json::Int(appended.seq));
    Ok(json_response(Json::Obj(map)))
}

// ---- 3. A fetch URL ----

/// `POST /organisations/{organisation}/firmware/{image}/fetch-urls`: mint a
/// single-use URL a device can collect this image from. **Requires `steward`.**
///
/// ADR-0045 §8: this publishes bytes to anything holding the token, so it is
/// `steward`, sealed, and the answer is the only time the URL exists outside the
/// caller's screen.
async fn issue_fetch_url_handler(
    State(state): State<FirmwareState>,
    PathExtractor((organisation, image)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, FirmwareError> {
    let tenant = parse_organisation(&organisation)?;
    let image = parse_image(&image)?;
    let warnings_passed = parse_warnings_body(&signed.body)?;

    let mut client = state.sessions.pool().get().await?;
    let tx = client.transaction().await?;
    let (session, tx) = signed.verify_and_commit(&state, tx).await?;

    // Authorised against the image's own scope when it exists, else the
    // ORGANISATION's (`design_api`'s "absent, not forbidden" rule), so a caller
    // without `steward` cannot learn which image ids are real.
    let scope = image_scope(&tx, tenant, image).await?;
    let ctx = authorise_in(&tx, &state, &session, tenant, scope, Capability::Steward).await?;

    let row = tx
        .query_opt(
            "SELECT filename, byte_length, computed_sha256, state, platform, version, models, \
                    computed_sha512 \
             FROM firmware_images WHERE id = $1 AND organisation_id = $2",
            &[&image.to_string(), &ctx.tenant().to_string()],
        )
        .await?
        .ok_or(FirmwareError::NoSuchImage)?;
    let filename: String = row.get(0);
    let byte_length: i64 = row.get(1);
    let computed: Option<Vec<u8>> = row.get(2);
    let state_text: String = row.get(3);
    let platform: Option<String> = row.get(4);
    let version: Option<String> = row.get(5);
    let models: Vec<String> = row.get(6);
    let sha512: Option<String> = row.get::<_, Option<Vec<u8>>>(7).map(|h| hex(&h));
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
        &warnings_passed,
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

    // Logged by token ID, never the token. The id is in the sealed entry too, tying
    // a log line to a chain entry without carrying the credential.
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
    map.insert("platform".to_string(), opt_str(platform.clone()));
    map.insert("version".to_string(), opt_str(version));
    map.insert("models".to_string(), strings(&models));
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
        commands_with(
            platform.as_deref(),
            &filename,
            &sha256,
            sha512.as_deref(),
            Some(&url),
        ),
    );
    Ok(json_response(Json::Obj(map)))
}

/// The image's own scope, or `None` if no such image exists in this tenant; see
/// [`issue_fetch_url_handler`].
async fn image_scope(
    tx: &Transaction<'_>,
    tenant: OrganisationId,
    image: FirmwareImageId,
) -> Result<Option<ScopeId>, FirmwareError> {
    // Runs before a tenant context is open, so under `FORCE ROW LEVEL SECURITY` it
    // always sees zero rows. That is the safe direction: `None` means "authorise
    // against the organisation", the stricter choice.
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

// ---- 4. The device's fetch ----

/// `GET /firmware/fetch/{token}`: the one route a network device talks to, and the
/// one whose URL is itself the authorisation.
///
/// In order (the order is the design):
///
/// 1. **Spend the token** with one guarded `UPDATE ... RETURNING`, atomic against a
///    second caller presenting the same URL.
/// 2. **Take the tenant off the row just read**, never off the request.
/// 3. **Seal `firmware_fetch_redeemed` and commit** before a single byte is written
///    to the socket, so a transfer that dies halfway still leaves the record.
/// 4. Serve exactly the staged bytes, **streamed**, a [`FETCH_CHUNK`] at a time.
///
/// **Streaming does not weaken step 3.** `tx.commit().await?` **returns before
/// `File::open` is called**, and hyper cannot poll the body before this function
/// returns the response holding it (`tests/firmware.rs`).
///
/// **The token is spent exactly once, including when the transfer dies.** After step
/// 3 a file error, length mismatch, mid-stream read error or a device hanging up at
/// forty per cent all leave the row redeemed (ADR-0045 §4.2: a URL that published
/// bytes is spent whether or not they all arrived). Every failure after the commit
/// is an integrity fault a retry would hit again, so nothing is reserved ahead of
/// the spend. No range support: see the module doc.
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

    // **The token is not in this line and must never be.** The token id is; it names
    // the sealed entry without being redeemable.
    tracing::info!(
        image = %image,
        fetch_token_id = %token_id,
        bytes = byte_length,
        source = %source,
        "firmware image served"
    );

    // **Everything above is committed.** `tx.commit()` returned, so the redemption
    // is durable before the file is opened (step 3 above).
    let path = state.store.image_path(image);
    let file = std::fs::File::open(&path).map_err(FirmwareError::Storage)?;

    // The row says how long the file is; a disagreement means it was changed under
    // this server, an integrity alarm rather than a transfer to complete. Checked on
    // the OPEN handle, so it is the length of the file this response will read.
    let on_disk = file.metadata().map_err(FirmwareError::Storage)?.len();
    if on_disk as i64 != byte_length {
        tracing::error!(
            image = %image,
            expected = byte_length,
            found = on_disk,
            "a staged firmware image is not the length its row records"
        );
        return Err(FirmwareError::NotStaged);
    }

    // **The bytes, read again before any is sent** (sign-off r62). Hashed through
    // the same open handle the body then streams from, rewound, so a file renamed
    // over this one after the check is not what goes out. A two-gigabyte image
    // costs a few seconds before the first byte; the token is already spent, so a
    // caller cannot make the server do this more than once per URL.
    let file = verified(file, &computed).await?;
    let file = tokio::fs::File::from_std(file);

    // One `FETCH_CHUNK` in flight, never the image. When the device hangs up, hyper
    // drops the body, which drops the `ReaderStream` and `File`, closing the
    // descriptor; nothing has to notice the disconnect.
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
    // A streamed body has no length, so hyper would use chunked framing. Stated
    // instead, from the length just checked against the open handle, so a device
    // copying two gigabytes can see progress and know a truncated transfer was
    // truncated. `Content-Length` and the body both come from `on_disk`.
    headers.insert(
        axum::http::header::CONTENT_LENGTH,
        on_disk
            .to_string()
            .parse()
            .expect("a decimal integer is a valid header value"),
    );
    // What a device should compare against, so a transfer's own record carries the
    // hash Fathom holds.
    headers.insert(
        "fathom-firmware-sha256",
        hex(&computed).parse().expect("hex is a valid header value"),
    );
    // `no-store`, as everywhere. The URL is the credential, so an image in a shared
    // cache is a copy of the route's one secret, and a restaged image must not be
    // answered from a proxy holding the old one.
    headers.insert(
        axum::http::header::CACHE_CONTROL,
        "no-store"
            .parse()
            .expect("a static cache-control is a valid header value"),
    );
    Ok((StatusCode::OK, headers, body).into_response())
}

/// Hash an open image from the start, compare with what was computed at upload, and
/// hand the handle back rewound. [`FirmwareError::ImageChanged`] when they differ.
async fn verified(file: std::fs::File, staged: &[u8]) -> Result<std::fs::File, FirmwareError> {
    let staged = staged.to_vec();
    tokio::task::spawn_blocking(move || {
        use std::io::{Read, Seek};
        let mut file = file;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0u8; UPLOAD_CHUNK];
        loop {
            let n = file.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            hasher.update(&buffer[..n]);
        }
        file.rewind()?;
        Ok::<_, std::io::Error>((file, hasher.finalize()))
    })
    .await
    .map_err(joined)?
    .map_err(FirmwareError::Storage)
    .and_then(|(file, digest)| {
        if digest.as_slice() == staged.as_slice() {
            Ok(file)
        } else {
            Err(FirmwareError::ImageChanged)
        }
    })
}

/// How often each stored image is hashed again (sign-off r62).
pub const RECHECK_EVERY_DAYS: i64 = 7;

/// How often the re-check looks for images that are due. Short beside a week, so
/// a server restarted often still re-checks on time; each pass hashes one image
/// at a time, so it never competes with uploads for more than one file's reads.
pub const RECHECK_LOOK_EVERY: std::time::Duration = std::time::Duration::from_secs(60 * 60);

/// What one pass of [`recheck_due`] found.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Rechecked {
    /// Images whose stored file still matches.
    pub matched: usize,
    /// Images whose file no longer matches, or is gone. Each is marked `changed_at`
    /// and logged; a download refuses them anyway (`verified`).
    pub changed: usize,
}

/// Hash every staged image that is due (`RECHECK_EVERY_DAYS`), one at a time, and
/// record the result under the image's own organisation.
///
/// Finding what is due crosses organisations, so it reads under
/// `app.firmware_recheck_custody` (`0059`), which can read and cannot write.
/// Each write is then made with the organisation as the tenant. An image staged
/// before `0059` gets its SHA-512 here, and only once its SHA-256 has matched, so
/// the SHA-512 is never of bytes nobody vouched for.
pub async fn recheck_due(
    pool: &deadpool_postgres::Pool,
    store: &FirmwareStore,
) -> Result<Rechecked, FirmwareError> {
    recheck_due_in(pool, store, None).await
}

/// [`recheck_due`], limited to one organisation when `only` names one. The server
/// always passes `None`; a test passes its own organisation so it does not
/// re-check images other tests staged in other directories.
pub async fn recheck_due_in(
    pool: &deadpool_postgres::Pool,
    store: &FirmwareStore,
    only: Option<&str>,
) -> Result<Rechecked, FirmwareError> {
    let mut found = Rechecked::default();
    loop {
        let mut client = pool.get().await?;
        let tx = client.transaction().await?;
        enter_recheck_custody(&tx).await?;
        let due = tx
            .query_opt(
                "SELECT id, organisation_id, computed_sha256, computed_sha512 \
                 FROM firmware_images \
                 WHERE state = 'staged' AND computed_sha256 IS NOT NULL \
                   AND (last_checked_at IS NULL \
                        OR last_checked_at < now() - make_interval(days => $1::int)) \
                   AND ($2::text IS NULL OR organisation_id = $2) \
                 ORDER BY last_checked_at NULLS FIRST, id \
                 LIMIT 1",
                &[&(RECHECK_EVERY_DAYS as i32), &only],
            )
            .await?;
        tx.commit().await?;
        let Some(due) = due else {
            return Ok(found);
        };
        let id: String = due.get(0);
        let organisation: String = due.get(1);
        let sha256: Vec<u8> = due.get(2);
        let sha512: Option<Vec<u8>> = due.get(3);
        let image = parse_image(&id)?;

        let hashed = hash_file(store.image_path(image)).await;
        let (matches, fill_sha512) = match &hashed {
            Ok((now256, now512)) => {
                let same = now256.as_slice() == sha256.as_slice()
                    && sha512.as_deref().is_none_or(|s| s == now512.as_slice());
                (same, (same && sha512.is_none()).then(|| now512.to_vec()))
            }
            Err(_) => (false, None),
        };

        let tx = client.transaction().await?;
        repo::set_custody_tenant(&tx, &organisation).await?;
        tx.execute(
            "UPDATE firmware_images \
                SET last_checked_at = now(), \
                    computed_sha512 = coalesce(computed_sha512, $3), \
                    changed_at = CASE WHEN $4 THEN changed_at ELSE coalesce(changed_at, now()) END \
             WHERE id = $1 AND organisation_id = $2 AND state = 'staged'",
            &[&id, &organisation, &fill_sha512, &matches],
        )
        .await?;
        tx.commit().await?;

        if matches {
            found.matched += 1;
        } else {
            found.changed += 1;
            tracing::warn!(
                image = %id,
                organisation = %organisation,
                missing = hashed.is_err(),
                "a stored firmware image no longer matches the hash worked out when it was \
                 uploaded, or its file is gone. Downloads of it are refused. Compare the \
                 firmware volume with a backup."
            );
        }
    }
}

/// Run [`recheck_due`] every `RECHECK_LOOK_EVERY`, for as long as the server runs.
/// A failed pass is logged and tried again next time; it never stops the server.
pub fn spawn_recheck(
    pool: deadpool_postgres::Pool,
    store: Arc<FirmwareStore>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            match recheck_due(&pool, &store).await {
                Ok(Rechecked {
                    matched: 0,
                    changed: 0,
                }) => {}
                Ok(done) => tracing::info!(
                    matched = done.matched,
                    changed = done.changed,
                    "firmware images re-checked"
                ),
                Err(e) => tracing::warn!(error = %e, "the firmware re-check could not run"),
            }
            tokio::time::sleep(RECHECK_LOOK_EVERY).await;
        }
    })
}

/// SHA-256 and SHA-512 of a whole file, on the blocking pool.
async fn hash_file(path: PathBuf) -> Result<([u8; 32], [u8; 64]), FirmwareError> {
    tokio::task::spawn_blocking(move || {
        use std::io::Read;
        let mut file = std::fs::File::open(&path)?;
        let mut sha256 = Sha256::new();
        let mut sha512 = Sha512::new();
        let mut buffer = vec![0u8; UPLOAD_CHUNK];
        loop {
            let n = file.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            sha256.update(&buffer[..n]);
            sha512.update(&buffer[..n]);
        }
        Ok::<_, std::io::Error>((sha256.finalize().into(), sha512.finalize().into()))
    })
    .await
    .map_err(joined)?
    .map_err(FirmwareError::Storage)
}

/// `HEAD /firmware/fetch/{token}`: refused without reading the token, so a client
/// or proxy that asks before it fetches does not spend the one `GET` (module doc).
async fn head_refused() -> Response {
    (
        StatusCode::METHOD_NOT_ALLOWED,
        [(axum::http::header::ALLOW, "GET")],
    )
        .into_response()
}

/// The request's address as the shared policy decides it
/// (`crate::client_address`), which also caps the string at 255 characters
/// because it is stored.
fn source_of(
    state: &FirmwareState,
    headers: &HeaderMap,
    extensions: &axum::http::Extensions,
) -> String {
    state.store.client_address.of(headers, extensions)
}

// ---- 5. Read back ----

/// `GET /organisations/{organisation}/scopes/{scope}/firmware`: what is staged for
/// this scope, with the computed hash and the commands to use it. **Requires
/// `read`.**
///
/// Commands carry the real filename and hash but a placeholder where the `file copy`
/// URL goes: the server keeps only `H(LP(tag) ‖ LP(token))`, so it *cannot*
/// reproduce an issued URL, which is what makes the token safe at rest. The URL
/// arrives once, in `POST .../fetch-urls`, a sealed `steward` act; a `GET` that
/// minted a credential would turn reading a list into publication.
async fn list_handler(
    State(state): State<FirmwareState>,
    PathExtractor((organisation, scope)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, FirmwareError> {
    let tenant = parse_organisation(&organisation)?;
    let scope_id = parse_scope(&scope)?;

    let mut client = state.sessions.pool().get().await?;
    let tx = client.transaction().await?;
    let (session, tx) = signed.verify_and_commit(&state, tx).await?;
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
                    extract(epoch FROM staged_at)::bigint, staged_seq, platform, version, models, \
                    computed_sha512, extract(epoch FROM last_checked_at)::bigint, \
                    extract(epoch FROM changed_at)::bigint, extract(epoch FROM retired_at)::bigint \
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
        let platform: Option<String> = row.get(9);
        let version: Option<String> = row.get(10);
        let models: Vec<String> = row.get(11);
        let sha512: Option<Vec<u8>> = row.get(12);
        let last_checked_at: Option<i64> = row.get(13);
        let changed_at: Option<i64> = row.get(14);
        let retired_at: Option<i64> = row.get(15);

        let mut map = BTreeMap::new();
        map.insert("image_id".to_string(), Json::Str(id));
        map.insert("scope_id".to_string(), Json::Str(scope_id.to_string()));
        map.insert("filename".to_string(), Json::Str(filename.clone()));
        map.insert("byte_length".to_string(), Json::Int(byte_length));
        map.insert("platform".to_string(), opt_str(platform.clone()));
        map.insert("version".to_string(), opt_str(version));
        map.insert("models".to_string(), strings(&models));
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
        // **The hash Fathom computed, or nothing.** `declared_sha256` is never rendered:
        // a hash this server was told is not one it can stand behind.
        match &computed {
            Some(digest) => {
                let sha256 = hex(digest);
                map.insert("sha256".to_string(), Json::Str(sha256.clone()));
                map.insert(
                    "commands".to_string(),
                    commands_with(
                        platform.as_deref(),
                        &filename,
                        &sha256,
                        sha512.as_deref().map(hex).as_deref(),
                        None,
                    ),
                );
            }
            None => {
                map.insert("sha256".to_string(), Json::Null);
                map.insert("commands".to_string(), Json::Null);
            }
        }
        // Also computed, never declared (`0059`). Absent for an image staged before
        // it until the first weekly re-check has confirmed the file.
        map.insert(
            "sha512".to_string(),
            match &sha512 {
                Some(digest) => Json::Str(hex(digest)),
                None => Json::Null,
            },
        );
        map.insert(
            "last_checked_at_unix".to_string(),
            last_checked_at.map_or(Json::Null, Json::Int),
        );
        map.insert(
            "changed_at_unix".to_string(),
            changed_at.map_or(Json::Null, Json::Int),
        );
        map.insert(
            "retired_at_unix".to_string(),
            retired_at.map_or(Json::Null, Json::Int),
        );
        out.push(Json::Obj(map));
    }

    Ok(json_response(Json::Arr(out)))
}

// ---- 6. Replace an image's models ----

/// `PUT /organisations/{organisation}/firmware/{image}/models`: replace the list of
/// catalogue models an image is for. **Requires `steward`**, and a change is sealed
/// as `firmware_models_changed` (the image, the old list and the new one).
///
/// Body (canonical JSON, as the other JSON routes take): `{"models":["EX2300-24P"]}`
/// plus a final newline. The list is the whole new list, not a delta; `[]` clears it.
/// Answers `{"image_id", "models", "changed", "changed_seq"}`; a list equal to the
/// current one changes nothing and seals nothing (`changed: false`, `changed_seq:
/// null`). The image may be in any state: models are a label, not the bytes.
async fn models_handler(
    State(state): State<FirmwareState>,
    PathExtractor((organisation, image)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, FirmwareError> {
    let tenant = parse_organisation(&organisation)?;
    let image = parse_image(&image)?;
    let models = parse_models_body(&signed.body)?;

    let mut client = state.sessions.pool().get().await?;
    let tx = client.transaction().await?;
    let (session, tx) = signed.verify_and_commit(&state, tx).await?;
    // Authorised against the image's own scope when it exists, else the
    // organisation's, as in `issue_fetch_url_handler`.
    let scope = image_scope(&tx, tenant, image).await?;
    let ctx = authorise_in(&tx, &state, &session, tenant, scope, Capability::Steward).await?;

    let current: Vec<String> = tx
        .query_opt(
            "SELECT models FROM firmware_images WHERE id = $1 AND organisation_id = $2 \
             FOR UPDATE",
            &[&image.to_string(), &ctx.tenant().to_string()],
        )
        .await?
        .ok_or(FirmwareError::NoSuchImage)?
        .get(0);

    let mut map = BTreeMap::new();
    map.insert("image_id".to_string(), Json::Str(image.to_string()));
    map.insert("models".to_string(), strings(&models));

    if current == models {
        tx.commit().await?;
        map.insert("changed".to_string(), Json::Bool(false));
        map.insert("changed_seq".to_string(), Json::Null);
        return Ok(json_response(Json::Obj(map)));
    }

    let tenant_key = keys::tenant_key(&tx, &state.ring, &ctx).await?;
    let metadata = models_changed_metadata(
        &ctx.tenant().to_string(),
        &ctx.actor().to_string(),
        image,
        &current,
        &models,
    );
    let appended = chains::append_org(
        &tx,
        &state.ring,
        &ctx,
        &tenant_key,
        EntryType::FirmwareModelsChanged,
        &metadata,
    )
    .await?;
    let updated = tx
        .execute(
            "UPDATE firmware_images SET models = $3 WHERE id = $1 AND organisation_id = $2",
            &[&image.to_string(), &ctx.tenant().to_string(), &models],
        )
        .await?;
    if updated != 1 {
        return Err(FirmwareError::NoSuchImage);
    }
    tx.commit().await?;

    tracing::info!(image = %image, models = models.len(), "firmware image models replaced");
    map.insert("changed".to_string(), Json::Bool(true));
    map.insert("changed_seq".to_string(), Json::Int(appended.seq));
    Ok(json_response(Json::Obj(map)))
}

// ---- 7. Retire ----

/// `POST /organisations/{organisation}/firmware/{image}/retire`: delete a staged
/// image's file and keep its record (`0060`). **Requires `steward`.**
///
/// The row moves to `retired` and the act is sealed before the file is touched,
/// so a crash between the two leaves a retired row with a file that serves
/// nothing, never a staged row with no file. A fetch URL already issued for it
/// is refused from then on, because the fetch route sends staged images only.
async fn retire_handler(
    State(state): State<FirmwareState>,
    PathExtractor((organisation, image)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, FirmwareError> {
    let tenant = parse_organisation(&organisation)?;
    let image = parse_image(&image)?;

    let mut client = state.sessions.pool().get().await?;
    let tx = client.transaction().await?;
    let (session, tx) = signed.verify_and_commit(&state, tx).await?;
    let scope = image_scope(&tx, tenant, image).await?;
    let ctx = authorise_in(&tx, &state, &session, tenant, scope, Capability::Steward).await?;

    let row = tx
        .query_opt(
            "SELECT filename, byte_length, computed_sha256, state FROM firmware_images \
             WHERE id = $1 AND organisation_id = $2 FOR UPDATE",
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

    let tenant_key = keys::tenant_key(&tx, &state.ring, &ctx).await?;
    let metadata = retired_metadata(
        &ctx.tenant().to_string(),
        &ctx.actor().to_string(),
        image,
        &filename,
        byte_length,
        &computed,
    );
    let appended = chains::append_org(
        &tx,
        &state.ring,
        &ctx,
        &tenant_key,
        EntryType::FirmwareRetired,
        &metadata,
    )
    .await?;
    let updated = tx
        .execute(
            "UPDATE firmware_images SET state = 'retired', retired_at = now(), retired_seq = $3 \
             WHERE id = $1 AND organisation_id = $2 AND state = 'staged'",
            &[&image.to_string(), &ctx.tenant().to_string(), &appended.seq],
        )
        .await?;
    if updated != 1 {
        return Err(FirmwareError::NotStaged);
    }
    tx.commit().await?;

    // After the commit, on purpose (above). A file that will not go is logged
    // and counted against the space totals until someone removes it.
    let path = state.store.image_path(image);
    let removed = tokio::task::spawn_blocking(move || std::fs::remove_file(&path))
        .await
        .map_err(joined)?;
    if let Err(e) = &removed {
        tracing::warn!(
            image = %image,
            error = %e,
            "a retired firmware image's file could not be deleted; it serves nothing, but it \
             still takes space until it is removed from the firmware volume"
        );
    }
    tracing::info!(image = %image, bytes = byte_length, "firmware image retired");

    let mut map = BTreeMap::new();
    map.insert("image_id".to_string(), Json::Str(image.to_string()));
    map.insert("state".to_string(), Json::Str("retired".to_string()));
    map.insert("retired_seq".to_string(), Json::Int(appended.seq));
    map.insert("file_deleted".to_string(), Json::Bool(removed.is_ok()));
    Ok(json_response(Json::Obj(map)))
}

/// The warnings a person was shown before asking for a link and went past
/// (sign-off r62). An empty body is none. Otherwise `{"warnings_passed":[...]}`
/// and nothing else: each a known code, at most once, sorted. The words are the
/// client's; only the codes are sealed, so nothing a person typed reaches the chain.
pub const LINK_WARNING_CODES: [&str; 3] = ["downgrade", "not_chosen", "wrong_model"];

fn parse_warnings_body(body: &[u8]) -> Result<Vec<String>, FirmwareError> {
    if body.is_empty() {
        return Ok(Vec::new());
    }
    let bad = || FirmwareError::Malformed(WARNINGS_SHAPE);
    let Ok(Json::Obj(mut object)) = Json::parse_canonical(body) else {
        return Err(bad());
    };
    let Some(Json::Arr(items)) = object.remove("warnings_passed") else {
        return Err(bad());
    };
    if !object.is_empty() {
        return Err(bad());
    }
    let codes = items
        .into_iter()
        .map(|item| match item {
            Json::Str(s) if LINK_WARNING_CODES.contains(&s.as_str()) => Ok(s),
            _ => Err(bad()),
        })
        .collect::<Result<Vec<String>, _>>()?;
    if codes.windows(2).any(|w| w[0] >= w[1]) {
        return Err(bad());
    }
    Ok(codes)
}

/// `{"models":[...]}` and nothing else: one key, an array of strings, each a
/// [`safe_model`], at most [`MAX_MODELS`], no duplicates.
fn parse_models_body(body: &[u8]) -> Result<Vec<String>, FirmwareError> {
    let bad = || FirmwareError::Malformed(MODELS_SHAPE);
    let Ok(Json::Obj(mut object)) = Json::parse_canonical(body) else {
        return Err(bad());
    };
    let Some(Json::Arr(items)) = object.remove("models") else {
        return Err(bad());
    };
    if !object.is_empty() {
        return Err(bad());
    }
    let models = items
        .into_iter()
        .map(|item| match item {
            Json::Str(s) => Ok(s),
            _ => Err(bad()),
        })
        .collect::<Result<Vec<String>, _>>()?;
    if !safe_models(&models) {
        return Err(bad());
    }
    Ok(models)
}

// ---- Sealed metadata ----

fn models_changed_metadata(
    organisation: &str,
    actor: &str,
    image: FirmwareImageId,
    before: &[String],
    after: &[String],
) -> Vec<u8> {
    let mut map = BTreeMap::new();
    map.insert("actor".to_string(), Json::Str(actor.to_string()));
    map.insert(
        "entry_type".to_string(),
        Json::Str(EntryType::FirmwareModelsChanged.as_str().to_string()),
    );
    map.insert("image".to_string(), Json::Str(image.to_string()));
    map.insert("models_after".to_string(), strings(after));
    map.insert("models_before".to_string(), strings(before));
    map.insert(
        "organisation".to_string(),
        Json::Str(organisation.to_string()),
    );
    Json::Obj(map).to_canonical_bytes()
}

fn retired_metadata(
    organisation: &str,
    actor: &str,
    image: FirmwareImageId,
    filename: &str,
    byte_length: i64,
    sha256: &[u8],
) -> Vec<u8> {
    let mut map = BTreeMap::new();
    map.insert("actor".to_string(), Json::Str(actor.to_string()));
    map.insert("byte_length".to_string(), Json::Int(byte_length));
    map.insert(
        "entry_type".to_string(),
        Json::Str(EntryType::FirmwareRetired.as_str().to_string()),
    );
    map.insert("filename".to_string(), Json::Str(filename.to_string()));
    map.insert("image".to_string(), Json::Str(image.to_string()));
    map.insert(
        "organisation".to_string(),
        Json::Str(organisation.to_string()),
    );
    map.insert("sha256".to_string(), Json::Str(hex(sha256)));
    Json::Obj(map).to_canonical_bytes()
}

fn staged_metadata(
    organisation: &str,
    actor: &str,
    image: FirmwareImageId,
    scope: &str,
    labels: &Labels<'_>,
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
    map.insert(
        "filename".to_string(),
        Json::Str(labels.filename.to_string()),
    );
    // Sealed only when given, so an image without them seals the bytes it always did
    // and every entry written before `0038` still verifies unchanged.
    if let Some(platform) = labels.platform {
        map.insert("platform".to_string(), Json::Str(platform.to_string()));
    }
    if let Some(version) = labels.version {
        map.insert("version".to_string(), Json::Str(version.to_string()));
    }
    if !labels.models.is_empty() {
        map.insert("models".to_string(), strings(labels.models));
    }
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
    warnings_passed: &[String],
) -> Vec<u8> {
    let mut map = BTreeMap::new();
    // Only when there were any, so an ordinary link's entry keeps its shape.
    if !warnings_passed.is_empty() {
        map.insert("warnings_passed".to_string(), strings(warnings_passed));
    }
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
    // The token's ID. **Never the token**: this metadata is decryptable by anyone
    // holding the chain key, and a credential in an audit trail has a second home.
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

// ---- The two transaction-local capabilities ----

/// Turn on `app.firmware_upload_custody` (`0017` §D).
///
/// The upload path has a token and no session, like `0015`'s enrolment
/// redemption, and gets its own capability so an unauthenticated caller reaches
/// one table and no more. `app.design_capability` is set to its refusal first, so
/// this transaction cannot read a design payload.
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

/// Turn on `app.firmware_recheck_custody` (`0059`): read which images are due
/// across organisations. No policy lets it write.
async fn enter_recheck_custody(tx: &Transaction<'_>) -> Result<(), FirmwareError> {
    tx.execute(
        "SELECT set_config('app.design_capability', 'no', true)",
        &[],
    )
    .await?;
    tx.execute(
        "SELECT set_config('app.firmware_recheck_custody', 'yes', true)",
        &[],
    )
    .await?;
    Ok(())
}

/// Turn on `app.firmware_fetch_custody` (`0017` §D). The device's door, and the
/// narrowest capability in this schema: one table names it.
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

// ---- Response framing ----

/// `Cache-Control: no-store` on all of them, per `api::bytes_response`. Nothing
/// here is a document: it is one caller's answer under one caller's authority,
/// and a shared cache would hold it stale or offer it to the next caller.
fn json_response(j: Json) -> Response {
    (
        StatusCode::OK,
        [
            (axum::http::header::CONTENT_TYPE, "application/json"),
            (axum::http::header::CACHE_CONTROL, "no-store"),
        ],
        j.to_canonical_bytes(),
    )
        .into_response()
}

// ---- Tests that need no database: the rules that are pure functions ----

#[cfg(test)]
mod tests {
    use super::*;
    use crate::firmware_commands::commands;

    fn json_text(j: &Json) -> String {
        String::from_utf8(j.to_canonical_bytes()).expect("canonical JSON is UTF-8")
    }

    /// CLAUDE.md rule 2: measured against what a real device accepts; these are the
    /// shapes Juniper ships.
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

    /// A filename never becomes a path or a second command (it is rendered inside a
    /// line pasted into a switch).
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

    /// The on-disk name is the id and nothing else, so no input can contain a
    /// separator.
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
            organisation_max_bytes: 1,
            total_max_bytes: 1,
            upload_idle: std::time::Duration::from_secs(1),
            fetch_base_url: "https://example.invalid".to_string(),
            client_address: crate::client_address::ClientAddress::peer(),
            slots: std::sync::Mutex::new(Slots::default()),
        };
        let path = store.image_path(FirmwareImageId::new());
        assert!(
            path.starts_with("/srv/fathom/firmware"),
            "{}",
            path.display()
        );
        assert_eq!(path.components().count(), 5, "{}", path.display());
    }

    /// One upload per organisation and three per server, each place given back
    /// when its slot is dropped.
    #[test]
    fn upload_places_are_counted_per_organisation_and_per_server_and_given_back() {
        let store = Arc::new(FirmwareStore {
            directory: PathBuf::from("/srv/fathom/firmware"),
            max_image_bytes: 1,
            organisation_max_bytes: 1,
            total_max_bytes: 1,
            upload_idle: std::time::Duration::from_secs(1),
            fetch_base_url: "https://example.invalid".to_string(),
            client_address: crate::client_address::ClientAddress::peer(),
            slots: std::sync::Mutex::new(Slots::default()),
        });
        let a = store
            .take_slot("org-a")
            .expect("the first upload has a place");
        assert!(
            store.take_slot("org-a").is_none(),
            "one at a time per organisation"
        );
        let b = store
            .take_slot("org-b")
            .expect("another organisation is not held up");
        let c = store.take_slot("org-c").expect("a third on the server");
        assert!(
            store.take_slot("org-d").is_none(),
            "three at a time per server"
        );
        drop(a);
        let a2 = store.take_slot("org-a").expect("given back when dropped");
        drop((a2, b, c));
        let slots = store.slots.lock().unwrap();
        assert_eq!(slots.total, 0);
        assert!(slots.by_organisation.is_empty());
    }

    /// The declaration parser accepts exactly its own framing.
    #[test]
    fn the_declaration_framing_round_trips_and_rejects_anything_else() {
        let mut body = Vec::new();
        crypto::lp(&mut body, b"junos-install-21.4R3.tgz");
        crypto::lp(&mut body, &1_234_567_890u64.to_le_bytes());
        crypto::lp(&mut body, &[7u8; 32]);
        let d = parse_declaration(&body).expect("a well-formed declaration");
        assert_eq!(d.filename, "junos-install-21.4R3.tgz");
        assert_eq!(d.byte_length, 1_234_567_890);
        assert_eq!(d.sha256, [7u8; 32]);
        assert_eq!((d.platform, d.version), (None, None));

        assert!(parse_declaration(b"").is_err());
        assert!(parse_declaration(&body[..body.len() - 1]).is_err());
        let mut trailing = body.clone();
        trailing.push(0);
        assert!(
            parse_declaration(&trailing).is_err(),
            "a trailing byte is a different message"
        );
    }

    /// `0038`: the platform and version ride as optional trailing fields, and an
    /// empty one means "not given".
    #[test]
    fn the_optional_platform_and_version_fields_parse_and_empty_means_absent() {
        let mut base = Vec::new();
        crypto::lp(&mut base, b"a.bin");
        crypto::lp(&mut base, &9u64.to_le_bytes());
        crypto::lp(&mut base, &[1u8; 32]);

        let mut both = base.clone();
        crypto::lp(&mut both, b"ios-xe");
        crypto::lp(&mut both, b"17.09.04a");
        let d = parse_declaration(&both).expect("both fields");
        assert_eq!(d.platform.as_deref(), Some("ios-xe"));
        assert_eq!(d.version.as_deref(), Some("17.09.04a"));

        let mut only_version = base.clone();
        crypto::lp(&mut only_version, b"");
        crypto::lp(&mut only_version, b"4.32.2F");
        let d = parse_declaration(&only_version).expect("version alone");
        assert_eq!(d.platform, None);
        assert_eq!(d.version.as_deref(), Some("4.32.2F"));

        let mut only_platform = base.clone();
        crypto::lp(&mut only_platform, b"eos");
        let d = parse_declaration(&only_platform).expect("platform alone");
        assert_eq!(d.platform.as_deref(), Some("eos"));
        assert_eq!(d.version, None);

        let mut extra = both.clone();
        crypto::lp(&mut extra, b"a sixth field");
        assert!(parse_declaration(&extra).is_err());
        let mut not_utf8 = base;
        crypto::lp(&mut not_utf8, &[0xff, 0xfe]);
        assert!(parse_declaration(&not_utf8).is_err());
    }

    /// Model ids: the declare field and the replace body share one rule.
    #[test]
    fn models_are_limited_in_count_shape_and_duplicates() {
        let mut prefix = Vec::new();
        crypto::lp(&mut prefix, b"a.bin");
        crypto::lp(&mut prefix, &9u64.to_le_bytes());
        crypto::lp(&mut prefix, &[1u8; 32]);
        crypto::lp(&mut prefix, b"junos");
        crypto::lp(&mut prefix, b"");
        let with = |models: &str| {
            let mut b = prefix.clone();
            crypto::lp(&mut b, models.as_bytes());
            parse_declaration(&b)
        };
        let d = with("EX2300-24P,EX2300-48P,C9300-24T/1+x_y.z").expect("three labels");
        assert_eq!(
            d.models,
            vec!["EX2300-24P", "EX2300-48P", "C9300-24T/1+x_y.z"]
        );
        assert!(with("A,B").is_ok());
        for bad in [
            "A,,B",
            "A,",
            ",A",
            "A,A",
            "A B",
            "A;B",
            "é",
            &"x".repeat(65),
        ] {
            assert!(with(bad).is_err(), "{bad:?}");
        }
        let sixteen: Vec<String> = (0..16).map(|i| format!("M{i}")).collect();
        assert!(with(&sixteen.join(",")).is_ok());
        let seventeen: Vec<String> = (0..17).map(|i| format!("M{i}")).collect();
        assert!(with(&seventeen.join(",")).is_err());

        let body = |json: &str| format!("{json}\n").into_bytes();
        assert_eq!(
            parse_models_body(&body(r#"{"models":[]}"#)).unwrap().len(),
            0
        );
        assert!(parse_models_body(&body(r#"{"models":["A","B"]}"#)).is_ok());
        for bad in [
            r#"{"models":["A","A"]}"#,
            r#"{"models":[1]}"#,
            r#"{"models":"A"}"#,
            r#"{"models":["A"],"x":1}"#,
            r#"{"other":[]}"#,
            r#"[]"#,
        ] {
            assert!(parse_models_body(&body(bad)).is_err(), "{bad}");
        }
        assert!(
            parse_models_body(br#"{"models":[]}"#).is_err(),
            "no final newline"
        );
    }

    /// Real platform slugs and release strings pass; anything that could become a
    /// second command, a path or a long string does not (CLAUDE.md rule 2).
    #[test]
    fn platform_and_version_accept_what_vendors_write_and_nothing_else() {
        for ok in [
            "junos",
            "junos-evo",
            "ios-xe",
            "nx-os",
            "eos",
            &"a".repeat(32),
        ] {
            assert!(safe_platform(ok), "{ok}");
        }
        for bad in [
            "",
            "Junos",
            "ios xe",
            "eos;reload",
            "a/b",
            "ios_xe",
            &"a".repeat(33),
        ] {
            assert!(!safe_platform(bad), "{bad:?}");
        }
        for ok in [
            "21.4R3-S5.5",
            "17.09.04a",
            "10.3(4a)",
            "4.32.2F",
            "9.3(10)",
            "22.4R2-S2.6_x",
            &"1".repeat(64),
        ] {
            assert!(safe_version(ok), "{ok}");
        }
        for bad in [
            "",
            "21.4 R3",
            "1;reload",
            "1\nreload",
            "$(id)",
            "a/b",
            "v1.0+x",
            &"1".repeat(65),
        ] {
            assert!(!safe_version(bad), "{bad:?}");
        }
    }

    /// The one-hash rule: a caller reads back the computed hash under the name
    /// `sha256`, and the declaration appears under no name in any answer.
    #[test]
    fn the_commands_carry_the_hash_they_were_given_and_the_traps_are_in_order() {
        let sha = "a".repeat(64);
        let text = json_text(&commands(None, "junos-install-21.4R3.tgz", &sha, None));
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

    /// With a URL the copy line is the real one; without, it says why and invents
    /// none.
    #[test]
    fn the_copy_line_holds_the_real_url_when_there_is_one_and_never_a_fake_one() {
        let sha = "b".repeat(64);
        let with = json_text(&commands(
            None,
            "junos.tgz",
            &sha,
            Some("https://fathom.example.net/firmware/fetch/deadbeef"),
        ));
        assert!(
            with.contains("file copy https://fathom.example.net/firmware/fetch/deadbeef /var/tmp/"),
            "{with}"
        );

        let without = json_text(&commands(None, "junos.tgz", &sha, None));
        assert!(!without.contains("/firmware/fetch/"), "{without}");
        assert!(without.contains("cannot show you one"), "{without}");
    }

    /// The token hash is domain-separated from every other in this server.
    #[test]
    fn a_firmware_token_hashes_differently_from_a_session_token() {
        let token = [9u8; 32];
        assert_ne!(token_hash(&token), sessions::token_hash(&token));
    }

    #[test]
    fn warnings_passed_are_known_codes_once_and_sorted_or_nothing() {
        assert_eq!(parse_warnings_body(b"").unwrap(), Vec::<String>::new());
        assert_eq!(
            parse_warnings_body(
                br#"{"warnings_passed":["downgrade","wrong_model"]}
"#
            )
            .unwrap(),
            vec!["downgrade".to_string(), "wrong_model".to_string()]
        );
        for refused in [
            &br#"{"warnings_passed":["wrong_model","downgrade"]}
"#[..],
            br#"{"warnings_passed":["downgrade","downgrade"]}
"#,
            br#"{"warnings_passed":["looks odd to me"]}
"#,
            br#"{"warnings_passed":[],"note":"x"}
"#,
            br#"{"warnings":["downgrade"]}
"#,
        ] {
            assert!(
                parse_warnings_body(refused).is_err(),
                "{}",
                String::from_utf8_lossy(refused)
            );
        }
    }

    #[test]
    fn a_link_past_warnings_seals_their_codes_and_an_ordinary_one_keeps_its_shape() {
        let image = FirmwareImageId::new();
        let token = FirmwareImageId::new();
        let plain = fetch_issued_metadata("org", "me", image, token, 5, &[]);
        assert!(!String::from_utf8_lossy(&plain).contains("warnings_passed"));
        let past =
            fetch_issued_metadata("org", "me", image, token, 5, &["wrong_model".to_string()]);
        assert!(String::from_utf8_lossy(&past).contains(r#""warnings_passed":["wrong_model"]"#));
    }
}
