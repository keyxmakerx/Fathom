//! The tamper-evident history: the constructions from
//! `docs/PHASE-2-STORAGE-DESIGN.md` §11.2 and §12.2, and the verifier that
//! reports §11.2's three outcomes and its fourth sub-state.
//!
//! This module is pure and touches no database: `designs` and `chains` read the
//! rows and hand them here. So every construction can be tested without
//! PostgreSQL, and a chain can be exported and verified elsewhere.
//!
//! # Three levels, one mechanism
//!
//! `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §7.1 adds a **site** chain (per
//! deployment) and an **organisation** chain (per tenant) beside §11.2's
//! per-design one. The seal construction, length prefixing, `prev_seal`,
//! `chain_key_epoch`, retired chain keys and ordering rules are unchanged.
//! Per level: the chain key's derivation label ([`chain_key`]), so entries
//! cannot be spliced between levels. Per entry: whether it binds a payload
//! ([`absent_content_binding`]). There is one verifier, so the §12.6a ordering
//! rule has to be right only once.
//!
//! # Never conflate
//!
//! **"Content not checked" must never render the same as "content verified."**
//! Routine verification is links plus storage bindings, with no decryption.
//! Deep verification also decrypts and recomputes the plaintext binding. Both
//! name which they ran: see [`Report::summary`].
//!
//! # The order of the checks is itself a control (§12.6a)
//!
//! Everything verifiable is verified first. A coverage gap is an extra fact
//! reported alongside, never an early return. Otherwise one `UPDATE` of any
//! entry's `chain_key_epoch` would turn a detected forgery into "a coverage
//! gap, not a failure". Counts of what verified come from verification, never
//! from a position in a list. An epoch above what this deployment ever wrote is
//! an anomaly, not a gap: there is no retired key to find.
//!
//! # What the chain does not do
//!
//! Each seal binds backwards only. Deleting the last entries leaves the
//! survivors verifying, and restoring old tables yields a rollback the chain
//! endorses (§6's B4 fix). `seq` is in the MAC input but does **not** detect
//! tail truncation. Only an anchor outside the deployment does, and this order
//! does not build one.

use core::fmt;

use sha2::{Digest, Sha256};

use crate::crypto::{self, Key32, KeyId};

/// The per-design chain key's derivation label (§12.2).
///
/// Identity inputs are length-prefixed. Without that, tenant `ab` + design `c`
/// and tenant `a` + design `bc` would derive the same chain key.
const CHAIN_KEY_LABEL: &[u8] = b"fathom/chain/key/v1";

/// The **site** chain key's derivation label: one chain per deployment
/// (admin design §7.1, §12.2's table).
///
/// Domain-separated from the other two, so entries lifted from one level do
/// not verify at another.
const SITE_CHAIN_KEY_LABEL: &[u8] = b"fathom/chain/key/site/v1";

/// The **organisation** chain key's derivation label: one chain per tenant
/// (§7.1, §12.2's table).
///
/// This is §12.6's "tenant-level chain", where a `rewrap` entry is filed.
const ORG_CHAIN_KEY_LABEL: &[u8] = b"fathom/chain/key/org/v1";

/// The **site metadata** key's derivation label (§7.3, §12.2's table).
///
/// Site metadata is AEAD ciphertext, but no tenant key exists at the site
/// level, so the key is derived from `chain_master`.
///
/// **Per `chain_key_epoch`.** Entries are append-only and cannot be
/// re-encrypted, so the key that opens one must never stop existing: epochs are
/// kept forever.
///
/// **Cost:** a routine verifier holding `chain_master` can read site metadata.
/// That is acceptable because the site chain records deployment-level acts and
/// no tenant data. It is not true one level down: the organisation content key
/// is a wrapped DEK under the tenant key, which a verifier cannot derive.
const SITE_METADATA_KEY_LABEL: &[u8] = b"fathom/chain/key/site-metadata/v1";

/// HKDF `info` for the sealing subkey (§12.2).
///
/// Deliberately a different literal from the in-MAC domain tag below. Someone
/// tidying one would silently change the other and break every seal already
/// written.
const KDF_SEAL_LABEL: &[u8] = b"fathom/chain/kdf/seal/v1";

/// HKDF `info` for the content-binding subkey (§12.2).
const KDF_CONTENT_LABEL: &[u8] = b"fathom/chain/kdf/content/v1";

/// The in-MAC domain tags. §11.2's, unchanged.
const TAG_PLAINTEXT: &[u8] = b"fathom/chain/plaintext/v1";
const TAG_STORAGE: &[u8] = b"fathom/chain/storage/v1";
const TAG_CONTENT: &[u8] = b"fathom/chain/content/v1";
const TAG_SEAL: &[u8] = b"fathom/chain/seal/v1";
const TAG_GENESIS: &[u8] = b"fathom/chain/genesis/v1";

/// The in-MAC domain tag for *"this entry binds no payload"*.
///
/// Site and organisation entries record an act, not a version, yet carry both
/// content bindings and a `content_hash` from the same functions. So [`seal`]
/// is unchanged and [`verify`]'s `content_hash` check runs on every entry
/// without a branch: one seal input in this product.
const TAG_NO_CONTENT: &[u8] = b"fathom/chain/nocontent/v1";

/// The in-MAC domain tag for the **metadata binding**: the keyed value covering
/// what an entry's metadata *means*, not its stored bytes. See [`metadata_binding`].
const TAG_METADATA: &[u8] = b"fathom/chain/metadata/v1";

/// The AEAD associated-data tag for an encrypted metadata column.
const AAD_METADATA: &[u8] = b"fathom/chain/metadata/aead/v1";

/// Which of the three chains an entry belongs to (admin design §7.1).
///
/// **`read` is not here.** §7.2's per-design read chain has an open volume
/// question and §15.6 leaves it out of this stage. Its derivation label is
/// reserved in §12.2's table and nothing writes it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ChainKind {
    /// One per deployment. Everything organisation-independent.
    Site,
    /// One per tenant. §12.6's *"tenant-level chain"*.
    Org,
    /// One per design. §11.2's.
    Design,
}

impl ChainKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Site => "site",
            Self::Org => "org",
            Self::Design => "design",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "site" => Some(Self::Site),
            "org" => Some(Self::Org),
            "design" => Some(Self::Design),
            _ => None,
        }
    }
}

impl fmt::Display for ChainKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Which chain, named.
///
/// # The two identity slots
///
/// §11.2's seal covers `LP(tenant_id) ‖ LP(design_id)`, which is just the
/// chain's identity in two length-prefixed parts. All three levels fill the
/// same two slots:
///
/// | chain | first slot | second slot |
/// |---|---|---|
/// | site | `""` | deployment id |
/// | organisation | organisation id | `""` |
/// | design | organisation id | design id |
///
/// The design case is byte-for-byte unchanged, so earlier seals still verify.
/// Empty slots are unambiguous because `LP("")` is four zero bytes.
///
/// The slots are the second layer of separation. The first is the per-level
/// chain key label (§7.1): a moved entry is sealed under a key the destination
/// never derives.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ChainRef<'a> {
    Site {
        deployment: &'a str,
    },
    Org {
        organisation: &'a str,
    },
    Design {
        organisation: &'a str,
        design: &'a str,
    },
}

impl<'a> ChainRef<'a> {
    pub fn kind(self) -> ChainKind {
        match self {
            Self::Site { .. } => ChainKind::Site,
            Self::Org { .. } => ChainKind::Org,
            Self::Design { .. } => ChainKind::Design,
        }
    }

    /// The value the `chain_id` column carries: what names this chain within
    /// its kind.
    pub fn chain_id(self) -> &'a str {
        match self {
            Self::Site { deployment } => deployment,
            Self::Org { organisation } => organisation,
            Self::Design { design, .. } => design,
        }
    }

    /// The organisation this chain belongs to, when it belongs to one.
    pub fn organisation(self) -> Option<&'a str> {
        match self {
            Self::Site { .. } => None,
            Self::Org { organisation } | Self::Design { organisation, .. } => Some(organisation),
        }
    }

    /// The two length-prefixed identity slots — see the type's own doc.
    fn identity(self) -> (&'a str, &'a str) {
        match self {
            Self::Site { deployment } => ("", deployment),
            Self::Org { organisation } => (organisation, ""),
            Self::Design {
                organisation,
                design,
            } => (organisation, design),
        }
    }
}

/// What kind of event an entry records.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum EntryType {
    /// The first version of a design.
    Create,
    /// A new version, written by someone.
    Update,
    /// **The same content, different bytes**: a rotation re-encrypted this
    /// version under a new key (§11.2, §12.6). `plaintext_binding` carries
    /// across unchanged, proving the content did not change. Metadata records
    /// the epochs, wrap versions and storage bindings on both sides.
    ///
    /// This stops a routine rotation looking like an attack, so operators do
    /// not learn to dismiss the alarm.
    Reencrypt,
    /// A live change (ADR-0063): one batch applied to the design's head. It
    /// takes a version number and binds the sealed change body.
    Change,

    // ---- Site chain (§7.2) ------------------------------------------------
    /// This deployment started: the site chain's first entry, and one more on
    /// every later start.
    ///
    /// §7.2 lists thirty-odd site types. Only those with an emitter exist: an
    /// entry type nothing emits is a `CHECK` name pretending to be a control.
    DeploymentStarted,
    /// **The audit destination has not taken anything for a while**: §9's
    /// `shipper_gap`, written when the oldest unshipped spool entry passes an
    /// escalation point (1h, 6h, the age bound). See `audit::SpoolBounds`.
    ShipperGap,
    /// **The spool has passed a bound**: §9's `spool_pressure`. At the age or
    /// size bound, §9's degrade table stops design writes and keeps reads serving.
    SpoolPressure,

    // ---- Sessions (§4, migration 0013) -----------------------------------
    //
    // Written by `sessions.rs`. Two are not in §7.2's list: it gives an account
    // sign-in no type, though §4 makes that the main path.
    /// An account proved possession of an enrolled signing key over a server
    /// challenge that also bound the fresh session public key (§4.2). The
    /// session row is written in the same transaction.
    AccountSignin,
    /// A sign-in attempt was refused. Carries the reason, including a
    /// rate-limit refusal — §13 item 7's lockout has its sealed record here
    /// rather than in a type of its own.
    AccountSigninFailed,
    /// A session was signed out (migration `0014`). §7.2 names no type for it.
    /// The sealed entry is what the `session_revocations` row's MAC binds to, so
    /// stopping the log stops the act.
    AccountSignedOut,
    /// An attempt at the operator sign-in surface was refused and recorded
    /// (§4.5: an operator session is `A1` or does not exist; no password path).
    OperatorSigninFailed,
    /// An account was disabled: its live sessions stop at their next request.
    AccountDisabled,
    /// An account was re-enabled.
    AccountEnabled,

    // ---- The operator console (§1.1, §5, §6, migration 0015) -------------
    //
    // Written by `operators.rs`. `operator_signed_out` and `operator_read` are
    // not in §7.2's list (`0015` §J carries the report). Operator acts must be
    // legible as operator acts to a reader holding only the chain key.
    /// An operator proved possession of a key in `operator_keys` over a server
    /// challenge that also bound the fresh session public key (§4.2, §4.5).
    /// There is no password path on this surface and there must never be one.
    OperatorSignin,
    /// An operator session was signed out. Not §7.2's — see above.
    OperatorSignedOut,
    /// §1.1's first verb: an operator read some surface of the console.
    /// **Sampled**: one entry per session per surface (`0015` §F's latch),
    /// because an unsampled entry lets a caller choose how fast the sealed audit
    /// grows. Not in §7.2.
    OperatorRead,
    /// The first operator of a deployment redeemed the token written to the
    /// master-key volume (§6.3).
    OperatorBootstrapped,
    /// Two operators' assertions and the delay produced a new operator (§5.5).
    OperatorCreated,
    /// A second operator seconded a pending operator creation (§5.5).
    OperatorSeconded,
    /// An operator enrolled their first key, which is what their first sign-in
    /// must do (§5.5).
    OperatorEnrolled,
    /// An operator was disabled: their live sessions stop at their next
    /// request. §4.5 — re-enrolment is two operators' work, not a form.
    OperatorDisabled,
    /// An operator created an account shell for an address (§1.1, §6.2).
    AccountCreated,
    /// An enrolment token was issued: §1.1's authenticator-enrolment token and
    /// §5.1's reset, **which are the same act**.
    EnrolmentTokenIssued,
    /// A token was redeemed, once and only once.
    EnrolmentTokenRedeemed,
    /// A token was presented after its expiry and refused.
    EnrolmentTokenExpired,
    /// A key joined a keyring through the enrolment path (§7.2's
    /// `authenticator_registered`), for an account whose first key cannot be
    /// filed on an organisation chain because it has no organisation (§6.2, §6.4).
    AuthenticatorRegistered,
    /// An operator created an organisation shell and its enrolment claim (§6.2).
    /// The shell holds no data and permits nothing until the claim is redeemed.
    OrgShellCreated,
    /// A change to a site setting was requested by one operator (§5.3).
    SettingRequested,
    /// A second operator seconded it (§5.3, §5.5).
    SettingSeconded,
    /// The delay elapsed and the change was applied. **This entry is the
    /// interlock**: `site_settings_versions.sealed_seq` names it, and the
    /// resolver refuses any row whose entry does not verify (§5.4).
    SettingApplied,
    /// A pending change was cancelled during its delay.
    SettingCancelled,
    /// §5.4 step 5: a candidate row failed a check and was NOT silently skipped.
    /// An incident, and the deployment banners it.
    SettingUnresolvable,
    /// §5.3's declaration, written at every startup that runs without a second
    /// operator, so nobody can later claim two-person control was in force.
    SingleOperatorMode,

    // ---- ADR-0055 stream (a): the person's credential (migration 0018 §F) --
    //
    // Written by `credentials.rs` and `sessions.rs`'s widened sign-in.
    /// type; "first" is recoverable from whether a prior entry exists.
    PasswordSet,
    /// The app code was enrolled — confirmed by a real code — together with the
    /// ten backup codes in the same transaction.
    TotpEnrolled,
    /// A password-reset token was issued.
    ResetRequested,
    /// A reset token was redeemed and the password changed.
    ResetSpent,
    /// One backup code was spent, in place of the app code.
    BackupCodeUsed,

    // ---- Organisation chain (§7.2) ---------------------------------------
    /// The first entry on an organisation's chain.
    OrgGenesis,

    // ---- The authority layer's acts (§7.2, migration 0011) ---------------
    //
    // Written by `grants.rs`. §7.2's other authority types (`scope_moved`,
    // `devices_reparented`, `recovery_holders_set`, `break_glass_*`,
    // `member_added|removed`, `authority_rollback`) arrive with the surfaces
    // that cause them.
    /// A signing key joined an account's keyring (§3.2, §8.4).
    AccountKeyEnrolled,
    /// An old key signed its successor, and says so (§8.4).
    AccountKeySuperseded,
    /// A key was retired and signs nothing further.
    AccountKeyRetired,
    /// A steward — or the organisation root key, at genesis — signed a scope
    /// grant (§3.3).
    GrantSigned,
    /// A second steward countersigned it (§3.5's quorum).
    GrantSeconded,
    /// A grant was suspended: by a steward, or by an operator (the one
    /// authority-adjacent act §1.1 gives the operator plane).
    GrantSuspended,
    /// A steward lifted a suspension. An operator cannot: `0011`'s `CHECK`
    /// refuses `unsuspend` for an operator principal.
    GrantUnsuspended,
    /// A grant was revoked — the positive, append-only fact §3.2 requires in
    /// place of a nullable column whose absence means live.
    GrantRevoked,
    /// The organisation's authority head moved to a new epoch (§3.4). Every act
    /// above writes it in the same transaction, so the current state of the SET
    /// is authenticated, not just each row's author.
    AuthHeadAdvanced,
    // ---- Firmware staging (ADR-0045, migration 0017) ---------------------
    //
    // Written by `firmware.rs`. Not in §7.2's list (it predates ADR-0045);
    // `0017` §E carries the report.
    /// An image arrived whole: written to disk, with its SHA-256 computed as it
    /// was written and matching the declaration. A truncated or altered upload
    /// writes nothing: the partial file is deleted and the upload refused (trap
    /// 2 of `docs/UPGRADING-A-JUNIPER.md`).
    FirmwareStaged,
    /// A one-time fetch URL was minted for a device. ADR-0045 §8: this publishes
    /// bytes to anything holding the token, so it is a sealed act, not a read.
    /// **The entry names the token's id, never the token.**
    FirmwareFetchIssued,
    /// A fetch URL was spent: the bytes went somewhere. Committed BEFORE the body
    /// is served, so a transfer that dies half way still leaves the record.
    FirmwareFetchRedeemed,

    /// **A re-wrap happened** (§12.6): custody changed, exposure did not. The
    /// entry names the old and new master identity, which key rows moved, who
    /// ran it, and that no payload was re-encrypted. Rotation writes a
    /// `reencrypt` entry per version because it changes bytes; re-wrap changes
    /// none, so without this entry the operation that changes *who can decrypt
    /// everything* would have no audit trail.
    ///
    /// **Filed on two kinds.** A re-wrap is deployment-wide, so one summary entry
    /// goes on the site chain (both master identities, tenants moved) and one on
    /// each affected organisation's chain (that tenant's epochs).
    /// `keys::rewrap_master_key` writes all of them in one transaction or none
    /// (§7.2).
    Rewrap,

    // ---- ADR-0055 stream (b) ---------------------------------------------
    //
    // Both are SITE types, in the schema: `operator_recovered_from_host` in
    // `0019_operator_account_binding.sql` §D, `operator_key_enrolled` in
    // `0022_operator_quorum_and_the_operator_key.sql` §C.
    /// **Break-glass, and it is loud** (ADR-0055 decision 8). `fathom-server
    /// recover-operator <address>` ran where the key volume is mounted and
    /// printed a ten-minute setup code for an existing operator. It mints no
    /// operator. Every operator session banners it for seven days, derived from
    /// this entry rather than from a column someone could clear.
    OperatorRecoveredFromHost,
    /// An account holding the operator custody registered an operator key for
    /// its browser, with its password and app code behind it (ADR-0055 decision
    /// 1, `POST /admin/operators/self/key`).
    ///
    /// **Not `operator_enrolled`** (a redeemed one-shot invitation): an auditor
    /// must tell the two apart without the chain key. Metadata carries `via` for
    /// a reader who has it.
    OperatorKeyEnrolled,
    /// One operator confirmed another's recovery, clearing `0021`'s seat hold
    /// early (ADR-0055 decision 7). The hold is a column; lifting it early is an
    /// act, and acts on the operator plane are sealed entries.
    OperatorSeatHoldCleared,
    /// **An operator created before ADR-0055 was bound to the install address**,
    /// on the first start of a build with decision 1 (migration `0026`).
    ///
    /// Such an operator has no account or binding, so nobody can sign in as them
    /// and `recover-operator` cannot resolve them. The start creates the account
    /// at `site_install.notice_address` and the sealed binding, and dispossesses
    /// what the older flow left without a second factor. **Not
    /// `operator_bootstrapped`**: no operator is created, and an auditor must
    /// tell a first start from an upgrade.
    OperatorAdopted,
    // ADR-0055 stream (c) -- console placement (decision 11, migration
    // `0020_console_placement.sql` §C). Written by `placement.rs`. Not in
    // §7.2's list (`0020`'s header carries the report).
    /// An operator moved the console to a host and a set of sources. It applies
    /// AT ONCE (`0020`: `sealed_seq NOT NULL` from the `INSERT`), so this records
    /// a change already made. The window after it decides whether it STAYS.
    ConsolePlacementRequested,
    /// An operator reached the console on the new host inside the window: the
    /// first `/admin` request that verifies there, not a route.
    ConsolePlacementConfirmed,
    /// The window ran out unconfirmed, or `fathom-server console-placement
    /// --reset` cleared a placement from the host. The entry's `reason` says which.
    ConsolePlacementReverted,
}

impl EntryType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::Update => "update",
            Self::Reencrypt => "reencrypt",
            Self::Change => "change",
            Self::DeploymentStarted => "deployment_started",
            Self::ShipperGap => "shipper_gap",
            Self::SpoolPressure => "spool_pressure",
            Self::AccountSignin => "account_signin",
            Self::AccountSigninFailed => "account_signin_failed",
            Self::AccountSignedOut => "account_signed_out",
            Self::OperatorSigninFailed => "operator_signin_failed",
            Self::AccountDisabled => "account_disabled",
            Self::AccountEnabled => "account_enabled",
            Self::OperatorSignin => "operator_signin",
            Self::OperatorSignedOut => "operator_signed_out",
            Self::OperatorRead => "operator_read",
            Self::OperatorBootstrapped => "operator_bootstrapped",
            Self::OperatorCreated => "operator_created",
            Self::OperatorSeconded => "operator_seconded",
            Self::OperatorEnrolled => "operator_enrolled",
            Self::OperatorDisabled => "operator_disabled",
            Self::AccountCreated => "account_created",
            Self::EnrolmentTokenIssued => "enrolment_token_issued",
            Self::EnrolmentTokenRedeemed => "enrolment_token_redeemed",
            Self::EnrolmentTokenExpired => "enrolment_token_expired",
            Self::AuthenticatorRegistered => "authenticator_registered",
            Self::OrgShellCreated => "org_shell_created",
            Self::SettingRequested => "setting_requested",
            Self::SettingSeconded => "setting_seconded",
            Self::SettingApplied => "setting_applied",
            Self::SettingCancelled => "setting_cancelled",
            Self::SettingUnresolvable => "setting_unresolvable",
            Self::SingleOperatorMode => "single_operator_mode",
            // ADR-0055 stream (a).
            Self::PasswordSet => "password_set",
            Self::TotpEnrolled => "totp_enrolled",
            Self::ResetRequested => "reset_requested",
            Self::ResetSpent => "reset_spent",
            Self::BackupCodeUsed => "backup_code_used",
            // ADR-0055 stream (b).
            Self::OperatorRecoveredFromHost => "operator_recovered_from_host",
            Self::OperatorKeyEnrolled => "operator_key_enrolled",
            Self::OperatorSeatHoldCleared => "operator_seat_hold_cleared",
            Self::OperatorAdopted => "operator_adopted",
            Self::OrgGenesis => "org_genesis",
            Self::Rewrap => "rewrap",
            Self::AccountKeyEnrolled => "account_key_enrolled",
            Self::AccountKeySuperseded => "account_key_superseded",
            Self::AccountKeyRetired => "account_key_retired",
            Self::GrantSigned => "grant_signed",
            Self::GrantSeconded => "grant_seconded",
            Self::GrantSuspended => "grant_suspended",
            Self::GrantUnsuspended => "grant_unsuspended",
            Self::GrantRevoked => "grant_revoked",
            Self::AuthHeadAdvanced => "auth_head_advanced",
            Self::FirmwareStaged => "firmware_staged",
            Self::FirmwareFetchIssued => "firmware_fetch_issued",
            Self::FirmwareFetchRedeemed => "firmware_fetch_redeemed",
            // ADR-0055 stream (c)
            Self::ConsolePlacementRequested => "console_placement_requested",
            Self::ConsolePlacementConfirmed => "console_placement_confirmed",
            Self::ConsolePlacementReverted => "console_placement_reverted",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "create" => Some(Self::Create),
            "update" => Some(Self::Update),
            "reencrypt" => Some(Self::Reencrypt),
            "change" => Some(Self::Change),
            "deployment_started" => Some(Self::DeploymentStarted),
            "shipper_gap" => Some(Self::ShipperGap),
            "spool_pressure" => Some(Self::SpoolPressure),
            "account_signin" => Some(Self::AccountSignin),
            "account_signin_failed" => Some(Self::AccountSigninFailed),
            "account_signed_out" => Some(Self::AccountSignedOut),
            "operator_signin_failed" => Some(Self::OperatorSigninFailed),
            "account_disabled" => Some(Self::AccountDisabled),
            "account_enabled" => Some(Self::AccountEnabled),
            "operator_signin" => Some(Self::OperatorSignin),
            "operator_signed_out" => Some(Self::OperatorSignedOut),
            "operator_read" => Some(Self::OperatorRead),
            "operator_bootstrapped" => Some(Self::OperatorBootstrapped),
            "operator_created" => Some(Self::OperatorCreated),
            "operator_seconded" => Some(Self::OperatorSeconded),
            "operator_enrolled" => Some(Self::OperatorEnrolled),
            "operator_disabled" => Some(Self::OperatorDisabled),
            "account_created" => Some(Self::AccountCreated),
            "enrolment_token_issued" => Some(Self::EnrolmentTokenIssued),
            "enrolment_token_redeemed" => Some(Self::EnrolmentTokenRedeemed),
            "enrolment_token_expired" => Some(Self::EnrolmentTokenExpired),
            "authenticator_registered" => Some(Self::AuthenticatorRegistered),
            "org_shell_created" => Some(Self::OrgShellCreated),
            "setting_requested" => Some(Self::SettingRequested),
            "setting_seconded" => Some(Self::SettingSeconded),
            "setting_applied" => Some(Self::SettingApplied),
            "setting_cancelled" => Some(Self::SettingCancelled),
            "setting_unresolvable" => Some(Self::SettingUnresolvable),
            "single_operator_mode" => Some(Self::SingleOperatorMode),
            // ADR-0055 stream (a).
            "password_set" => Some(Self::PasswordSet),
            "totp_enrolled" => Some(Self::TotpEnrolled),
            "reset_requested" => Some(Self::ResetRequested),
            "reset_spent" => Some(Self::ResetSpent),
            "backup_code_used" => Some(Self::BackupCodeUsed),
            // ADR-0055 stream (b).
            "operator_recovered_from_host" => Some(Self::OperatorRecoveredFromHost),
            "operator_key_enrolled" => Some(Self::OperatorKeyEnrolled),
            "operator_seat_hold_cleared" => Some(Self::OperatorSeatHoldCleared),
            "operator_adopted" => Some(Self::OperatorAdopted),
            "org_genesis" => Some(Self::OrgGenesis),
            "rewrap" => Some(Self::Rewrap),
            "account_key_enrolled" => Some(Self::AccountKeyEnrolled),
            "account_key_superseded" => Some(Self::AccountKeySuperseded),
            "account_key_retired" => Some(Self::AccountKeyRetired),
            "grant_signed" => Some(Self::GrantSigned),
            "grant_seconded" => Some(Self::GrantSeconded),
            "grant_suspended" => Some(Self::GrantSuspended),
            "grant_unsuspended" => Some(Self::GrantUnsuspended),
            "grant_revoked" => Some(Self::GrantRevoked),
            "auth_head_advanced" => Some(Self::AuthHeadAdvanced),
            "firmware_staged" => Some(Self::FirmwareStaged),
            "firmware_fetch_issued" => Some(Self::FirmwareFetchIssued),
            "firmware_fetch_redeemed" => Some(Self::FirmwareFetchRedeemed),
            // ADR-0055 stream (c)
            "console_placement_requested" => Some(Self::ConsolePlacementRequested),
            "console_placement_confirmed" => Some(Self::ConsolePlacementConfirmed),
            "console_placement_reverted" => Some(Self::ConsolePlacementReverted),
            _ => None,
        }
    }

    /// Which chains this type may be filed on: plural, because `rewrap` and
    /// `grant_suspended` are filed on two.
    ///
    /// Mirrored by the `chain_entries_type_belongs_to_kind` constraint
    /// (`migrations/0010`, extended by `0011` through its DROP + ADD path), so
    /// the rule also holds for statements this code never issued.
    pub fn kinds(self) -> &'static [ChainKind] {
        match self {
            Self::Create | Self::Update | Self::Reencrypt | Self::Change => &[ChainKind::Design],
            Self::DeploymentStarted
            | Self::ShipperGap
            | Self::SpoolPressure
            | Self::AccountSignin
            | Self::AccountSigninFailed
            | Self::AccountSignedOut
            | Self::OperatorSigninFailed
            | Self::AccountDisabled
            | Self::AccountEnabled
            | Self::OperatorSignin
            | Self::OperatorSignedOut
            | Self::OperatorRead
            | Self::OperatorBootstrapped
            | Self::OperatorCreated
            | Self::OperatorSeconded
            | Self::OperatorEnrolled
            | Self::OperatorDisabled
            | Self::AccountCreated
            | Self::EnrolmentTokenIssued
            | Self::EnrolmentTokenRedeemed
            | Self::EnrolmentTokenExpired
            | Self::AuthenticatorRegistered
            | Self::OrgShellCreated
            | Self::SettingRequested
            | Self::SettingSeconded
            | Self::SettingApplied
            | Self::SettingCancelled
            | Self::SettingUnresolvable
            | Self::SingleOperatorMode
            // ADR-0055 stream (a): `0018` §F files all five on the site chain; a
            // credential act belongs to the account plane, not one organisation.
            | Self::PasswordSet
            | Self::TotpEnrolled
            | Self::ResetRequested
            | Self::ResetSpent
            | Self::BackupCodeUsed => &[ChainKind::Site],
            // ADR-0055 stream (b).
            | Self::OperatorRecoveredFromHost
            | Self::OperatorKeyEnrolled
            | Self::OperatorSeatHoldCleared
            | Self::OperatorAdopted => &[ChainKind::Site],
            // ADR-0055 stream (c)
            | Self::ConsolePlacementRequested
            | Self::ConsolePlacementConfirmed
            | Self::ConsolePlacementReverted => &[ChainKind::Site],
            Self::OrgGenesis
            | Self::AccountKeyEnrolled
            | Self::AccountKeySuperseded
            | Self::AccountKeyRetired
            | Self::GrantSigned
            | Self::GrantSeconded
            | Self::GrantUnsuspended
            | Self::GrantRevoked
            | Self::AuthHeadAdvanced
            | Self::FirmwareStaged
            | Self::FirmwareFetchIssued
            | Self::FirmwareFetchRedeemed => &[ChainKind::Org],
            // **Two types are filed on two kinds.** `rewrap` because the master key
            // is deployment-wide (§7.2). `grant_suspended` because §1.1 gives the
            // operator plane this one authority-adjacent verb: the organisation
            // chain records it for the stewards who may lift it, the site chain
            // records that the operator side did it. An act only on a tenant's
            // chain would be invisible to anyone auditing the operator plane,
            // which §0 calls the takeover route.
            Self::Rewrap | Self::GrantSuspended => &[ChainKind::Site, ChainKind::Org],
        }
    }

    /// Whether this type may appear on that chain kind.
    pub fn may_be_filed_on(self, kind: ChainKind) -> bool {
        self.kinds().contains(&kind)
    }

    /// Whether an entry of this type binds a stored payload version.
    ///
    /// False for every site and organisation type: they record an act. See
    /// [`absent_content_binding`].
    pub fn binds_a_payload(self) -> bool {
        self.kinds() == [ChainKind::Design]
    }
}

/// An entry's type **as the row actually carries it**.
///
/// `entry_type` is text, and a row can be forced in by whoever can disable a
/// trigger (a tier-3 move per `0009`'s header). So the verifier needs somewhere
/// to put a value it cannot parse.
///
/// **It may not be an error.** §11.2 gives verification three outcomes, and
/// "this chain cannot be read" is not one: an `Err` says nothing about the
/// entries before the bad row, which is the claim a tamper-evident log exists to
/// make. One junk type would otherwise make a chain permanently unverifiable, a
/// denial of the control. So it is [`BreakReason::EntryTypeNotRecognised`] at
/// that row, with everything before it reported verified.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StoredEntryType {
    /// A type this build knows.
    Known(EntryType),
    /// Text no [`EntryType`] parses. **Carried, not discarded**, so the break
    /// report can name what was actually in the column.
    Unparsed(String),
}

impl StoredEntryType {
    /// Parse from the column. Never fails: unknown text is carried.
    pub fn from_column(text: &str) -> Self {
        match EntryType::parse(text) {
            Some(t) => Self::Known(t),
            None => Self::Unparsed(text.to_string()),
        }
    }

    /// The text as stored — what the seal covers.
    pub fn as_str(&self) -> &str {
        match self {
            Self::Known(t) => t.as_str(),
            Self::Unparsed(text) => text,
        }
    }

    /// The parsed type, or `None` for text this build does not know.
    pub fn known(&self) -> Option<EntryType> {
        match self {
            Self::Known(t) => Some(*t),
            Self::Unparsed(_) => None,
        }
    }
}

impl From<EntryType> for StoredEntryType {
    fn from(t: EntryType) -> Self {
        Self::Known(t)
    }
}

impl fmt::Display for StoredEntryType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

/// The chain key for one chain at one epoch: §12.2's derivation at the three
/// levels of §7.1, length-prefixed throughout.
///
/// ```text
/// site:   HKDF-Expand(chain_master,
///             LP("fathom/chain/key/site/v1") ‖ LP(deployment_id) ‖ u32(epoch), 32)
/// org:    HKDF-Expand(chain_master,
///             LP("fathom/chain/key/org/v1")  ‖ LP(organisation_id) ‖ u32(epoch), 32)
/// design: HKDF-Expand(chain_master,
///             LP("fathom/chain/key/v1") ‖ LP(tenant_id) ‖ LP(design_id) ‖ u32(epoch), 32)
/// ```
/// **The design case is unchanged.** A different info string would silently stop
/// every existing seal verifying, and render as a forgery alarm.
///
/// **Per chain, which makes grafting fail** (§6's B5 fix): entries lifted into
/// another design, organisation or level do not verify under the destination's
/// key. The length prefixes stop organisation `ab` + design `c` and `a` + `bc`
/// deriving the same key.
pub fn chain_key(chain_master: &Key32, chain: ChainRef<'_>, epoch: i32) -> Key32 {
    let mut info = Vec::new();
    match chain {
        ChainRef::Site { deployment } => {
            crypto::lp(&mut info, SITE_CHAIN_KEY_LABEL);
            crypto::lp(&mut info, deployment.as_bytes());
        }
        ChainRef::Org { organisation } => {
            crypto::lp(&mut info, ORG_CHAIN_KEY_LABEL);
            crypto::lp(&mut info, organisation.as_bytes());
        }
        ChainRef::Design {
            organisation,
            design,
        } => {
            crypto::lp(&mut info, CHAIN_KEY_LABEL);
            crypto::lp(&mut info, organisation.as_bytes());
            crypto::lp(&mut info, design.as_bytes());
        }
    }
    crypto::u32_le(&mut info, epoch as u32);
    crypto::hkdf_expand(chain_master, &info)
}

/// The key that encrypts **site-chain metadata**, at one chain key epoch.
///
/// ```text
/// site_metadata_key_e = HKDF-Expand(chain_master,
///     info = LP("fathom/chain/key/site-metadata/v1") ‖ LP(deployment_id)
///            ‖ u32(chain_key_epoch), 32)
/// ```
///
/// See [`SITE_METADATA_KEY_LABEL`] for why it is per epoch and what a verifier
/// holding `chain_master` can read.
pub fn site_metadata_key(chain_master: &Key32, deployment: &str, epoch: i32) -> Key32 {
    let mut info = Vec::new();
    crypto::lp(&mut info, SITE_METADATA_KEY_LABEL);
    crypto::lp(&mut info, deployment.as_bytes());
    crypto::u32_le(&mut info, epoch as u32);
    crypto::hkdf_expand(chain_master, &info)
}

/// The associated data an encrypted metadata column is sealed under.
///
/// ```text
/// LP("fathom/chain/metadata/aead/v1") ‖ LP(chain_kind) ‖ LP(chain_id)
///     ‖ u64(seq) ‖ u32(key_epoch)
/// ```
///
/// `key_epoch` is `metadata_key_epoch` on an organisation entry and
/// `chain_key_epoch` on a site one — whichever names the key that opened it.
///
/// The seal already binds the ciphertext to its position. This binds it again
/// inside the AEAD, so a blob lifted between two entries of the same chain fails
/// to decrypt rather than decrypting into the wrong entry's report.
pub fn metadata_aad(chain: ChainRef<'_>, seq: i64, key_epoch: i32) -> Vec<u8> {
    let mut aad = Vec::new();
    crypto::lp(&mut aad, AAD_METADATA);
    crypto::lp(&mut aad, chain.kind().as_str().as_bytes());
    crypto::lp(&mut aad, chain.chain_id().as_bytes());
    crypto::u64_le(&mut aad, seq as u64);
    crypto::u32_le(&mut aad, key_epoch as u32);
    aad
}

/// `K_seal` and `K_content` for one chain key epoch.
pub struct Subkeys {
    pub seal: Key32,
    pub content: Key32,
}

impl Subkeys {
    pub fn derive(chain_key: &Key32) -> Self {
        Self {
            seal: crypto::hkdf_expand(chain_key, KDF_SEAL_LABEL),
            content: crypto::hkdf_expand(chain_key, KDF_CONTENT_LABEL),
        }
    }
}

// ---------------------------------------------------------------------------
// The bindings
// ---------------------------------------------------------------------------

/// Everything the **plaintext** binding covers. Rotation-invariant by
/// construction: nothing here is a storage fact, so re-encrypting a version
/// under a new key leaves this value unchanged.
pub struct PlaintextFacts<'a> {
    pub tenant: &'a str,
    pub design: &'a str,
    pub design_version: i64,
    pub payload_schema_version: i32,
    pub payload: &'a [u8],
}

/// Everything the **storage** binding covers: the actual bytes on disk, so a
/// swapped blob is caught without decrypting anything.
pub struct StorageFacts<'a> {
    pub key_id: KeyId,
    pub key_epoch: i32,
    pub wrap_version: i32,
    pub aead_alg_id: i16,
    pub nonce: &'a [u8],
    pub ciphertext: &'a [u8],
}

/// `plaintext_binding`, §11.2.
pub fn plaintext_binding(content_key: &Key32, facts: &PlaintextFacts<'_>) -> [u8; 32] {
    let mut msg = Vec::with_capacity(64 + facts.payload.len());
    crypto::lp(&mut msg, TAG_PLAINTEXT);
    crypto::lp(&mut msg, facts.tenant.as_bytes());
    crypto::lp(&mut msg, facts.design.as_bytes());
    // The columns are signed (non-negative by CHECK); §11.2 writes u64/u32. The
    // cast is bit-preserving and in range.
    crypto::u64_le(&mut msg, facts.design_version as u64);
    crypto::u32_le(&mut msg, facts.payload_schema_version as u32);
    crypto::lp(&mut msg, facts.payload);
    crypto::mac(content_key.expose(), &msg)
}

/// `storage_binding`, §11.2.
pub fn storage_binding(content_key: &Key32, facts: &StorageFacts<'_>) -> [u8; 32] {
    let mut msg = Vec::with_capacity(64 + facts.ciphertext.len());
    crypto::lp(&mut msg, TAG_STORAGE);
    crypto::lp(&mut msg, facts.key_id.as_bytes());
    crypto::u32_le(&mut msg, facts.key_epoch as u32);
    crypto::u32_le(&mut msg, facts.wrap_version as u32);
    crypto::u16_le(&mut msg, facts.aead_alg_id as u16);
    crypto::lp(&mut msg, facts.nonce);
    crypto::lp(&mut msg, facts.ciphertext);
    crypto::mac(content_key.expose(), &msg)
}

/// The value both bindings carry on an entry that binds **no payload**: every
/// site and organisation entry.
///
/// ```text
/// MAC(K_content, LP("fathom/chain/nocontent/v1"))
/// ```
///
/// Keyed and domain-separated, so it neither collides with a real binding nor is
/// recognisable from a dump without the chain key. `content_hash` is then
/// [`content_hash`] of the pair exactly as on a design entry: no verifier branch
/// and no second seal construction. That is why it is a constant, not `NULL`.
pub fn absent_content_binding(content_key: &Key32) -> [u8; 32] {
    let mut msg = Vec::with_capacity(32);
    crypto::lp(&mut msg, TAG_NO_CONTENT);
    crypto::mac(content_key.expose(), &msg)
}

/// The keyed binding over what an entry's metadata **means**.
///
/// ```text
/// metadata_binding = MAC(K_content,
///     LP("fathom/chain/metadata/v1") ‖ LP(canon(metadata)))
/// ```
///
/// # Why this exists
///
/// §11.2's seal covered `canon(metadata)` directly in the MAC. That made §7.3's
/// encrypted metadata impossible: recomputing any seal would need the metadata
/// key, so the routine check (chain key only, no decryption) could not run on
/// the chains that most need it.
///
/// So metadata gets the payload's two-tier treatment:
///
/// | tier | covers | in the clear? |
/// |---|---|---|
/// | seal input `metadata_stored` | the bytes on disk | yes — the column |
/// | `metadata_binding` (this) | what those bytes mean | yes — 32 bytes, keyed |
///
/// Links-only recomputes the seal from stored columns, so a swapped or corrupted
/// ciphertext breaks the seal with only the chain key. Deep also recovers the
/// plaintext (the column on a design chain, decrypted on the others) and
/// recomputes this value.
pub fn metadata_binding(content_key: &Key32, canonical_metadata: &[u8]) -> [u8; 32] {
    let mut msg = Vec::with_capacity(64 + canonical_metadata.len());
    crypto::lp(&mut msg, TAG_METADATA);
    crypto::lp(&mut msg, canonical_metadata);
    crypto::mac(content_key.expose(), &msg)
}

/// `content_hash`, §11.2 — **keyed**, because an unkeyed hash of plaintext is
/// a confirmation oracle against a stolen dump.
pub fn content_hash(content_key: &Key32, plaintext: &[u8; 32], storage: &[u8; 32]) -> [u8; 32] {
    let mut msg = Vec::with_capacity(96);
    crypto::lp(&mut msg, TAG_CONTENT);
    crypto::lp(&mut msg, plaintext);
    crypto::lp(&mut msg, storage);
    crypto::mac(content_key.expose(), &msg)
}

/// The value that stands in for `seal_0`.
///
/// **§11.2 writes `LP(H("fathom/chain/genesis/v1" ‖ tenant_id ‖ design_id))`;
/// this differs in two deliberate ways.**
///
/// 1. The `LP(...)` is read as how the value enters the MAC, not as part of the
///    value: every `seal_{n-1}` already enters the seal input through `LP(...)`,
///    so including it would length-prefix genesis twice.
/// 2. The inner concatenation is **length-prefixed**. Bare, tenant `ab` + design
///    `c` and `a` + `bc` give the same genesis, the splice §11.2 and §12.2 close
///    elsewhere. Harmless in practice (the chain key is per design), but an
///    unprefixed concatenation beside a "length-prefix every variable-length
///    field" rule is what gets copied.
pub fn genesis(chain: ChainRef<'_>) -> [u8; 32] {
    let (first, second) = chain.identity();
    let mut msg = Vec::new();
    crypto::lp(&mut msg, TAG_GENESIS);
    crypto::lp(&mut msg, first.as_bytes());
    crypto::lp(&mut msg, second.as_bytes());
    Sha256::digest(&msg).into()
}

/// Everything a seal covers.
pub struct SealFacts<'a> {
    pub chain_key_epoch: i32,
    pub seq: i64,
    /// Which chain. Its two identity slots enter the MAC exactly where §11.2
    /// puts `LP(tenant_id) ‖ LP(design_id)` — see [`ChainRef`].
    pub chain: ChainRef<'a>,
    pub prev_seal: &'a [u8],
    pub content_hash: &'a [u8],
    pub entry_type: EntryType,
    /// **The metadata column's bytes exactly as stored**: canonical plaintext on
    /// a design chain, the AEAD blob otherwise. The seal covers what is on disk,
    /// so a links-only run catches a swapped ciphertext with the chain key alone.
    pub metadata_stored: &'a [u8],
    /// [`metadata_binding`] over `canon(metadata)` — the keyed value that
    /// covers what those bytes mean. Stored in the clear beside them.
    pub metadata_binding: &'a [u8],
}

/// `seal_n`, §11.2.
pub fn seal(seal_key: &Key32, facts: &SealFacts<'_>) -> [u8; 32] {
    crypto::mac(seal_key.expose(), &seal_message(facts))
}

/// Verify a seal through `digest`'s own constant-time path — never `==` on
/// two byte slices.
pub fn seal_verifies(seal_key: &Key32, facts: &SealFacts<'_>, tag: &[u8]) -> bool {
    crypto::mac_verify(seal_key.expose(), &seal_message(facts), tag)
}

fn seal_message(facts: &SealFacts<'_>) -> Vec<u8> {
    let (first, second) = facts.chain.identity();
    let mut msg = Vec::with_capacity(200 + facts.metadata_stored.len());
    crypto::lp(&mut msg, TAG_SEAL);
    crypto::u32_le(&mut msg, facts.chain_key_epoch as u32);
    crypto::u64_le(&mut msg, facts.seq as u64);
    crypto::lp(&mut msg, first.as_bytes());
    crypto::lp(&mut msg, second.as_bytes());
    crypto::lp(&mut msg, facts.prev_seal);
    crypto::lp(&mut msg, facts.content_hash);
    crypto::lp(&mut msg, facts.entry_type.as_str().as_bytes());
    crypto::lp(&mut msg, facts.metadata_stored);
    crypto::lp(&mut msg, facts.metadata_binding);
    msg
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/// One entry as it was stored, handed to the verifier.
#[derive(Clone, Debug)]
pub struct StoredEntry {
    pub seq: i64,
    /// **The column, parsed or carried** (see [`StoredEntryType`]). A type this
    /// build cannot parse is a break at this entry, never an error that silences
    /// the chain.
    pub entry_type: StoredEntryType,
    pub chain_key_epoch: i32,
    /// `Some` on a design chain; `None` on a site or organisation chain, where an
    /// entry records an act with no version. The migration's
    /// `chain_entries_shape_matches_kind` refuses the two wrong combinations.
    pub design_version: Option<i64>,
    pub prev_seal: Vec<u8>,
    pub plaintext_binding: Vec<u8>,
    pub storage_binding: Vec<u8>,
    pub content_hash: Vec<u8>,
    pub seal: Vec<u8>,
    /// The metadata column as stored: canonical plaintext on a design chain,
    /// AEAD ciphertext on a site or organisation one. **Never rendered as text
    /// without checking which** — see [`EntryMetadata`].
    pub metadata_stored: Vec<u8>,
    /// The clear 32-byte keyed binding beside it.
    pub metadata_binding: Vec<u8>,
}

/// The stored bytes of one payload version, as a verifier sees them — no
/// decryption needed to check a storage binding.
#[derive(Clone, Debug)]
pub struct StoredPayload {
    pub design_version: i64,
    pub key_id: KeyId,
    pub key_epoch: i32,
    pub wrap_version: i32,
    pub aead_alg_id: i16,
    pub nonce: Vec<u8>,
    pub ciphertext: Vec<u8>,
    pub payload_schema_version: i32,
}

/// How much was actually checked. **Named in every report**, because §11.2
/// requires both levels to say which they ran.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Depth {
    /// Links, sequence and storage bindings. No decryption. The routine
    /// check, runnable by an operator holding only the chain key.
    Links,
    /// The above, plus: decrypt every version and recompute its plaintext
    /// binding.
    Deep,
}

/// Whether the content was re-bound to its plaintext — §11.2's fourth
/// sub-state, and the reason [`Depth`] is in every report.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ContentState {
    /// Every version was decrypted and its plaintext binding recomputed.
    Rebound,
    /// **Links verified, content not re-bound.** The design key was
    /// unavailable, or deep verification was not asked for. This is not a
    /// failure and it is not a pass either.
    NotRebound,
}

/// Which check failed first (§11.2), plus extras this implementation adds so a
/// real tamper is never left unsaid.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BreakReason {
    /// The seal does not recompute from what the entry says it covers.
    SealDoesNotRecompute,
    /// The sequence skips or repeats.
    SequenceSkippedOrRepeated,
    /// `prev_seal` does not match entry N−1's seal.
    PrevSealMismatch,
    /// The stored blob's storage binding does not match, and no `reencrypt`
    /// entry accounts for it.
    StorageBindingMismatchUnexplained,
    /// The entry's own `content_hash` is not the keyed combination of its two
    /// bindings.
    ContentHashMismatch,
    /// Deep verification: the payload decrypted, and its plaintext binding is
    /// not the one sealed.
    PlaintextBindingMismatch,
    /// The entry names a payload version that is not in the database.
    PayloadMissing,
    /// **A stored payload version that no entry names.** The other direction of
    /// [`Self::PayloadMissing`], checked separately: walking entries only finds
    /// rows an entry points at. An inserted row, carrying the highest
    /// `design_version`, is what a read of "the latest version" would refuse on.
    PayloadNotNamedByAnyEntry,
    /// **The entry names a chain key epoch this deployment never wrote.** Not a
    /// coverage gap: no such key was minted, so there is none to find. Someone
    /// changed the column.
    ChainKeyEpochNeverWritten,
    /// The metadata recovered for this entry is not what [`metadata_binding`]
    /// committed to.
    ///
    /// On a design chain the column is the plaintext, so this fires on a
    /// links-only run (metadata edited, nothing recomputed). On the other chains
    /// it needs a deep run and means the decrypted value disagrees with the
    /// binding, which only the writer's own key could have produced.
    MetadataBindingMismatch,
    /// **The metadata will not open under this row's own associated data.** Deep
    /// runs only. Distinct from [`Self::MetadataBindingMismatch`]: that means
    /// plaintext came back and is wrong, this means none came back.
    ///
    /// The AAD is `LP(tag) ‖ LP(chain_kind) ‖ LP(chain_id) ‖ u64(seq) ‖
    /// u32(key_epoch)` ([`metadata_aad`]), so a blob moved between entries of one
    /// chain does not decrypt even if the seal was recomputed over it (which a
    /// tier-2 attacker holding the chain key can do). Without the AAD both run
    /// depths would pass it.
    MetadataDoesNotOpenUnderItsOwnAad,
    /// **The `entry_type` column holds text no `EntryType` parses.** Reported at
    /// the row, with everything before it still verified (see [`StoredEntryType`]).
    EntryTypeNotRecognised,
}

impl BreakReason {
    fn describe(self) -> &'static str {
        match self {
            Self::SealDoesNotRecompute => "the seal does not recompute",
            Self::SequenceSkippedOrRepeated => "the sequence number skips or repeats",
            Self::PrevSealMismatch => "prev_seal does not match the previous entry's seal",
            Self::StorageBindingMismatchUnexplained => {
                "the stored bytes do not match the sealed storage binding, and no reencrypt \
                 entry accounts for it"
            }
            Self::ContentHashMismatch => {
                "content_hash is not the keyed combination of the two bindings it claims"
            }
            Self::PlaintextBindingMismatch => {
                "the decrypted payload does not match the sealed plaintext binding"
            }
            Self::PayloadMissing => "the entry names a payload version that is not stored",
            Self::PayloadNotNamedByAnyEntry => {
                "a stored payload version is named by no entry in the history"
            }
            Self::ChainKeyEpochNeverWritten => {
                "the entry names a chain key epoch this deployment has never written, so there \
                 is no retired key to find -- the column was changed"
            }
            Self::MetadataBindingMismatch => {
                "the entry's metadata is not what its metadata_binding committed to"
            }
            Self::MetadataDoesNotOpenUnderItsOwnAad => {
                "the entry's metadata does not decrypt under this entry's own position and key \
                 epoch -- the blob belongs to a different row"
            }
            Self::EntryTypeNotRecognised => {
                "the entry_type column holds text this build does not know, so nothing can say \
                 what this entry records"
            }
        }
    }
}

/// The failing entry's metadata, and **whether what is handed over is readable**.
///
/// An enum, not `Option<Vec<u8>>`: on a site or organisation chain the stored
/// column is ciphertext, and a report that hands over a blob where canonical
/// JSON is expected is one operators stop reading. The question is "present as
/// what", and the type makes the caller match.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EntryMetadata {
    /// `fathom-canon`'s canonical bytes, as sealed. Available on any design-chain
    /// run; on the other chains only on a deep one.
    Plaintext(Vec<u8>),
    /// The stored AEAD blob, on a run that did not decrypt it. **Flagged, not
    /// rendered.** The break is still fully named (`seq`, reason, `entry_type`,
    /// `chain_key_epoch`); only the sentence inside the entry is withheld, and
    /// the report says so.
    Ciphertext(Vec<u8>),
    /// The break is not at an entry at all — a stored payload row no entry
    /// names has no metadata to report.
    None,
}

impl EntryMetadata {
    /// The canonical bytes, or `None` when this run never held them.
    pub fn plaintext(&self) -> Option<&[u8]> {
        match self {
            Self::Plaintext(bytes) => Some(bytes),
            Self::Ciphertext(_) | Self::None => None,
        }
    }
}

/// §11.2's three outcomes, and no fourth: a verifier that can say anything
/// else can say something nobody has to act on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Every seal recomputes, `seq` is contiguous, every entry's storage
    /// binding matches the payload it names directly or via a `reencrypt`
    /// chain, and no stored payload is unaccounted for.
    Verified { entries: usize },
    /// N is the **first** index where one of the checks fails. Everything
    /// before N that was actually verified is reported as such.
    BrokenAt {
        /// The failing entry's `seq`, or `0` when the break is not at an entry (a
        /// stored payload no entry names). Inventing one would send an operator
        /// to an entry that verifies.
        seq: i64,
        reason: BreakReason,
        /// **Counted by verification, never by list position.** An entry that
        /// could not be checked does not count, so the number never claims more
        /// than was done.
        verified_before: usize,
        /// The failing entry's own metadata, **and whether it is readable** (see
        /// [`EntryMetadata`]). On encrypted chains a links-only run holds
        /// ciphertext, and saying so beats printing it.
        metadata: EntryMetadata,
        /// The failing entry's type, always in the clear, including when the
        /// column holds text nothing parses (where naming it is the whole report).
        entry_type: Option<StoredEntryType>,
        /// The failing entry's chain key epoch, always in the clear.
        chain_key_epoch: Option<i32>,
        /// The design version involved, when there is one.
        design_version: Option<i64>,
    },
    /// **A coverage gap, not a failure.** Some entries name a chain key epoch
    /// this verifier was not given. Everything checkable was checked first and
    /// nothing was broken, so this is reached only after a full pass.
    CannotVerifyUnderKeyEpoch {
        epochs: Vec<i32>,
        ranges: Vec<(i64, i64)>,
        verified_before: usize,
    },
}

/// The entries a run could not check, reported **alongside** an outcome, not
/// instead of one.
///
/// §12.6a: verify everything verifiable first; a coverage gap is an additional
/// fact, never an early return. Otherwise one `UPDATE` of any entry's
/// `chain_key_epoch` turns a detected forgery into a coverage gap.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Coverage {
    /// The epochs no key was given for.
    pub epochs: Vec<i32>,
    /// The contiguous `seq` ranges those entries occupy.
    pub ranges: Vec<(i64, i64)>,
    /// How many entries went unchecked.
    pub entries: usize,
}

/// What a verification run says. **Depth and content state travel with the
/// outcome and cannot be dropped by a caller formatting it**: the mechanical
/// half of "content not checked must never render as content verified".
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Report {
    pub outcome: Outcome,
    pub depth: Depth,
    pub content: ContentState,
    /// `Some` when some entries could not be checked at all. **Present whatever
    /// the outcome**, including beside a break: both facts are true and neither
    /// may swallow the other.
    pub coverage: Option<Coverage>,
}

impl Report {
    /// One line an operator can act on. Never says "verified" without saying
    /// in the same breath what was and was not checked.
    pub fn summary(&self) -> String {
        let mut out = match &self.outcome {
            Outcome::Verified { entries } => match (self.depth, self.content) {
                (Depth::Deep, ContentState::Rebound) => format!(
                    "verified: {entries} entries, links and content \
                     (every version decrypted and re-bound to its plaintext)"
                ),
                _ => format!(
                    "verified: {entries} entries, LINKS AND STORED BYTES ONLY -- \
                     CONTENT NOT RE-BOUND. Nothing was decrypted, so this run says the history \
                     is intact, not that the designs are what they were."
                ),
            },
            Outcome::BrokenAt {
                seq,
                reason,
                verified_before,
                design_version,
                entry_type,
                ..
            } => {
                let version = match design_version {
                    Some(v) => format!(" (design version {v})"),
                    None => String::new(),
                };
                // The offending text, quoted, for the one break whose whole content
                // is what was put in the column. Truncated and `Debug`-escaped, so
                // a value chosen to forge a log line cannot.
                let version = match (reason, entry_type) {
                    (
                        BreakReason::EntryTypeNotRecognised,
                        Some(StoredEntryType::Unparsed(text)),
                    ) => {
                        let shown: String = text.chars().take(64).collect();
                        format!("{version} (the column holds {shown:?})")
                    }
                    _ => version,
                };
                if *seq == 0 {
                    format!(
                        "BROKEN: {}{version}. {verified_before} entries verify, and the stored \
                         data does not match what they say is there.",
                        reason.describe()
                    )
                } else {
                    format!(
                        "BROKEN AT ENTRY {seq}: {}{version}. The {verified_before} entries \
                         before it verify.",
                        reason.describe()
                    )
                }
            }
            Outcome::CannotVerifyUnderKeyEpoch {
                epochs,
                ranges,
                verified_before,
            } => {
                let epochs: Vec<String> = epochs.iter().map(i32::to_string).collect();
                let ranges: Vec<String> = ranges.iter().map(|(a, b)| format!("{a}-{b}")).collect();
                format!(
                    "cannot verify under chain key epoch(s) {}: entries {} are not covered by \
                     the key this run was given. That is a coverage gap and not a failure -- \
                     everything else was checked FIRST and {verified_before} entries verify. \
                     Retired chain keys are kept forever; find the one for that epoch.",
                    epochs.join(", "),
                    ranges.join(", ")
                )
            }
        };

        // The additional fact, never the headline. Suppressed for the gap
        // outcome, which is already this sentence said in full.
        if let (Some(coverage), false) = (
            self.coverage.as_ref(),
            matches!(self.outcome, Outcome::CannotVerifyUnderKeyEpoch { .. }),
        ) {
            let epochs: Vec<String> = coverage.epochs.iter().map(i32::to_string).collect();
            out.push_str(&format!(
                " Separately, {} entr{} could not be checked at all: chain key epoch(s) {} were \
                 not given to this run. That is a coverage gap and is not what is reported above.",
                coverage.entries,
                if coverage.entries == 1 { "y" } else { "ies" },
                epochs.join(", ")
            ));
        }
        out
    }
}

impl fmt::Display for Report {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.summary())
    }
}

/// What the verifier is given: the chain keys it holds, by epoch.
pub struct AvailableKeys {
    /// `(epoch, subkeys)`, every epoch this run can check.
    pub by_epoch: Vec<(i32, Subkeys)>,
    /// The highest chain key epoch this deployment has ever written, when the
    /// caller knows it.
    ///
    /// **An epoch above it is an anomaly, not a coverage gap** (§12.6a): no such
    /// key was ever minted. A caller that does not know (an offline verifier with
    /// an exported chain) passes `None` and gets the coverage reading.
    pub written_through: Option<i32>,
}

impl AvailableKeys {
    /// Keys with no claim about what this deployment ever wrote.
    pub fn new(by_epoch: Vec<(i32, Subkeys)>) -> Self {
        Self {
            by_epoch,
            written_through: None,
        }
    }

    /// The same, from a caller that knows the highest epoch ever written here.
    pub fn written_through(mut self, epoch: i32) -> Self {
        self.written_through = Some(epoch);
        self
    }

    fn get(&self, epoch: i32) -> Option<&Subkeys> {
        self.by_epoch
            .iter()
            .find(|(e, _)| *e == epoch)
            .map(|(_, k)| k)
    }
}

/// What a **deep** run is given.
///
/// This module never decrypts: it holds no data key, organisation content key
/// or site metadata key, so every construction here can be driven from a test
/// or an offline verifier. The caller (`designs` or `chains`) opens what it can
/// and hands the plaintext in.
pub struct DeepInputs<'a> {
    /// Decrypted design payloads, by `design_version`. Empty on a site or
    /// organisation chain, which have none.
    pub payloads: &'a [(i64, Vec<u8>)],
    /// Decrypted entry metadata, by `seq`. Empty on a design chain, where the
    /// stored column **is** the canonical plaintext and the verifier reads it
    /// directly.
    pub metadata: &'a [(i64, Vec<u8>)],
    /// The `seq`s whose metadata the caller **held the key for and could not
    /// open**.
    ///
    /// Absence from `metadata` cannot say this: an entry may be missing because
    /// the run held no key for its epoch (§11.2's fourth sub-state, not a
    /// failure) or because the key was right and the AEAD refused (a break,
    /// [`BreakReason::MetadataDoesNotOpenUnderItsOwnAad`]). Only the caller that
    /// tried knows which.
    pub refused_metadata: &'a [i64],
}

/// Verify a chain.
///
/// `entries` must be every entry for the chain, in `seq` order. `payloads` is
/// every stored version — empty for a site or organisation chain. `deep` is
/// `Some` only for a deep run; see [`DeepInputs`].
///
/// # The order, which is the control
///
/// Everything checkable is checked **first**, in one pass in `seq` order, and
/// the first break found is reported. `seq` and `prev_seal` need no key, so they
/// are checked even where the epoch cannot be opened. A coverage gap is
/// collected and reported alongside; it never returns early and never counts
/// toward `verified_before`.
pub fn verify(
    chain: ChainRef<'_>,
    entries: &[StoredEntry],
    payloads: &[StoredPayload],
    keys: &AvailableKeys,
    deep: Option<&DeepInputs<'_>>,
) -> Report {
    let depth = if deep.is_some() {
        Depth::Deep
    } else {
        Depth::Links
    };
    let mut content = if deep.is_some() {
        ContentState::Rebound
    } else {
        ContentState::NotRebound
    };

    // Whether the metadata column holds plaintext (design chain) or AEAD
    // ciphertext (§7.3). The one branch the metadata tier costs: it decides only
    // where the plaintext comes from, never whether the seal is checked.
    let metadata_is_stored_in_the_clear = chain.kind() == ChainKind::Design;

    // **The coverage gap is computed before the pass and reported with whatever
    // the pass finds**, never instead of it (§12.6a): a break at entry 1 must
    // still carry the fact that entry 3 could not be checked. An epoch above
    // what this deployment ever wrote is NOT counted here: there is no retired
    // key, so the pass reports it as a break.
    let uncovered: Vec<(i32, i64)> = entries
        .iter()
        .filter(|e| {
            keys.get(e.chain_key_epoch).is_none()
                && keys
                    .written_through
                    .is_none_or(|highest| e.chain_key_epoch <= highest)
        })
        .map(|e| (e.chain_key_epoch, e.seq))
        .collect();
    let coverage = coverage_of(&uncovered);

    // Counted by verification and by nothing else.
    let mut verified: usize = 0;

    let mut prev_seal = genesis(chain).to_vec();
    let mut expected_seq: i64 = 1;

    for entry in entries {
        // What this run can honestly hand an operator: plaintext on a design
        // chain, else ciphertext unless a deep run decrypted it.
        let reportable_metadata = || {
            if metadata_is_stored_in_the_clear {
                return EntryMetadata::Plaintext(entry.metadata_stored.clone());
            }
            match deep.and_then(|d| d.metadata.iter().find(|(s, _)| *s == entry.seq)) {
                Some((_, bytes)) => EntryMetadata::Plaintext(bytes.clone()),
                None => EntryMetadata::Ciphertext(entry.metadata_stored.clone()),
            }
        };

        // `content` is passed in, not captured: the metadata tier below can
        // downgrade it to `NotRebound` mid-entry, and a borrowing closure would
        // report the stale value.
        let broke = |reason: BreakReason, content: ContentState| Report {
            outcome: Outcome::BrokenAt {
                seq: entry.seq,
                reason,
                verified_before: verified,
                metadata: reportable_metadata(),
                entry_type: Some(entry.entry_type.clone()),
                chain_key_epoch: Some(entry.chain_key_epoch),
                design_version: entry.design_version,
            },
            depth,
            content,
            coverage: coverage.clone(),
        };

        // ---- What needs no key -------------------------------------------
        //
        // Read the type first: it is in the seal input, and returning an ERROR
        // here would let one junk value make a chain permanently unverifiable.
        // §11.2 has three outcomes; "unreadable" is not one.
        let Some(entry_type) = entry.entry_type.known() else {
            return broke(BreakReason::EntryTypeNotRecognised, content);
        };
        if entry.seq != expected_seq {
            return broke(BreakReason::SequenceSkippedOrRepeated, content);
        }
        if entry.prev_seal != prev_seal {
            return broke(BreakReason::PrevSealMismatch, content);
        }
        let sealed_over = prev_seal.clone();
        prev_seal = entry.seal.clone();
        expected_seq += 1;

        // An epoch beyond anything ever written is a changed column, not a key
        // someone else holds. Checked before the key lookup so it reads as an
        // anomaly even when that epoch's key is derivable.
        if keys
            .written_through
            .is_some_and(|highest| entry.chain_key_epoch > highest)
        {
            return broke(BreakReason::ChainKeyEpochNeverWritten, content);
        }

        // ---- What needs the key for this entry's epoch --------------------
        let Some(subkeys) = keys.get(entry.chain_key_epoch) else {
            // Not verified, so not counted. The links either side were checked above.
            continue;
        };

        // The two bindings must combine to the entry's `content_hash`. Otherwise
        // the seal could cover a hash that does not match the bindings beside it,
        // and the storage check below would check something the seal never
        // committed to.
        let recomputed = content_hash(
            &subkeys.content,
            &to32(&entry.plaintext_binding),
            &to32(&entry.storage_binding),
        );
        if recomputed.as_slice() != entry.content_hash.as_slice() {
            return broke(BreakReason::ContentHashMismatch, content);
        }

        let facts = SealFacts {
            chain_key_epoch: entry.chain_key_epoch,
            seq: entry.seq,
            chain,
            prev_seal: &sealed_over,
            content_hash: &entry.content_hash,
            entry_type,
            metadata_stored: &entry.metadata_stored,
            metadata_binding: &entry.metadata_binding,
        };
        if !seal_verifies(&subkeys.seal, &facts, &entry.seal) {
            return broke(BreakReason::SealDoesNotRecompute, content);
        }

        // ---- The metadata's second tier ----------------------------------
        //
        // The seal covered the STORED bytes, so a swapped ciphertext is caught
        // with the chain key alone. This checks those bytes still MEAN what was
        // sealed.
        //
        // On a design chain this runs every time. On the other chains it runs
        // only when a deep run supplied the decryption; an entry that could not be
        // decrypted is `NotRebound`, not verified (§11.2's fourth sub-state).
        let recovered: Option<&[u8]> = if metadata_is_stored_in_the_clear {
            Some(&entry.metadata_stored)
        } else {
            deep.and_then(|d| {
                d.metadata
                    .iter()
                    .find(|(s, _)| *s == entry.seq)
                    .map(|(_, bytes)| bytes.as_slice())
            })
        };
        match recovered {
            Some(bytes) => {
                if metadata_binding(&subkeys.content, bytes).as_slice()
                    != entry.metadata_binding.as_slice()
                {
                    return broke(BreakReason::MetadataBindingMismatch, content);
                }
            }
            // The key was held and the AEAD refused: the blob does not belong at
            // this position and epoch. A tier-2 attacker with the chain key can
            // move a ciphertext to another `seq` and recompute the seal, so
            // nothing else here objects. The associated data is what catches it.
            None if deep.is_some_and(|d| d.refused_metadata.contains(&entry.seq)) => {
                return broke(BreakReason::MetadataDoesNotOpenUnderItsOwnAad, content);
            }
            None if deep.is_some() => {
                // Deep run, but this metadata could not be decrypted: "content
                // not checked" must never render as "content verified".
                content = ContentState::NotRebound;
            }
            None => {}
        }

        // ---- The stored bytes, ENTRY-DRIVEN (§12.6a) ----------------------
        //
        // Driven from entries, not payload rows, to close a gap the seal leaves:
        // it does not cover `design_version`, so a re-pointed entry is
        // unauthenticated, but its storage binding is over the bytes of the
        // version it was written for, not the one it now names. Deleting the
        // entry instead breaks the next `prev_seal`.
        //
        // An entry naming no version (site or organisation) is skipped here: its
        // keyed `absent_content_binding` was already held to the seal by the
        // `content_hash` check above.
        if let Some(version) = entry.design_version {
            let Some(payload) = payloads.iter().find(|p| p.design_version == version) else {
                return broke(BreakReason::PayloadMissing, content);
            };
            let stored = storage_binding(
                &subkeys.content,
                &StorageFacts {
                    key_id: payload.key_id,
                    key_epoch: payload.key_epoch,
                    wrap_version: payload.wrap_version,
                    aead_alg_id: payload.aead_alg_id,
                    nonce: &payload.nonce,
                    ciphertext: &payload.ciphertext,
                },
            );
            if stored.as_slice() != entry.storage_binding.as_slice() {
                // §11.2: a storage-binding mismatch is routine if a `reencrypt`
                // entry accounts for it, broken otherwise. A later `reencrypt` on
                // this version supersedes this binding and is itself checked when
                // the pass reaches it.
                let superseded = entries.iter().any(|later| {
                    later.seq > entry.seq
                        && later.design_version == Some(version)
                        && later.entry_type == StoredEntryType::Known(EntryType::Reencrypt)
                });
                if !superseded {
                    return broke(BreakReason::StorageBindingMismatchUnexplained, content);
                }
            }

            // ---- Deep only: the plaintext --------------------------------
            if let Some(deep) = deep {
                match deep.payloads.iter().find(|(v, _)| *v == version) {
                    Some((_, bytes)) => {
                        let (organisation, design) = chain.identity();
                        let facts = PlaintextFacts {
                            tenant: organisation,
                            design,
                            design_version: version,
                            payload_schema_version: payload.payload_schema_version,
                            payload: bytes,
                        };
                        if plaintext_binding(&subkeys.content, &facts).as_slice()
                            != entry.plaintext_binding.as_slice()
                        {
                            return broke(BreakReason::PlaintextBindingMismatch, content);
                        }
                    }
                    None => {
                        // Deep run, one version not decrypted: the links verified,
                        // but saying "verified" would be the conflation §11.2 forbids.
                        content = ContentState::NotRebound;
                    }
                }
            }
        }

        verified += 1;
    }

    // The other direction; it cannot be folded into the loop. An inserted payload
    // row is named by no entry, so no entry-driven walk reaches it. A break, not a
    // skip: with the highest `design_version` it is what a read of "the latest
    // version" lands on.
    for payload in payloads {
        if !entries
            .iter()
            .any(|e| e.design_version == Some(payload.design_version))
        {
            return Report {
                outcome: Outcome::BrokenAt {
                    seq: 0,
                    reason: BreakReason::PayloadNotNamedByAnyEntry,
                    verified_before: verified,
                    metadata: EntryMetadata::None,
                    entry_type: None,
                    chain_key_epoch: None,
                    design_version: Some(payload.design_version),
                },
                depth,
                content,
                coverage,
            };
        }
    }

    let outcome = match &coverage {
        Some(c) => Outcome::CannotVerifyUnderKeyEpoch {
            epochs: c.epochs.clone(),
            ranges: c.ranges.clone(),
            verified_before: verified,
        },
        None => Outcome::Verified { entries: verified },
    };

    Report {
        outcome,
        depth,
        content,
        coverage,
    }
}

/// The uncovered entries, folded into the epochs they name and the contiguous
/// `seq` ranges they occupy.
fn coverage_of(uncovered: &[(i32, i64)]) -> Option<Coverage> {
    if uncovered.is_empty() {
        return None;
    }
    let mut epochs: Vec<i32> = Vec::new();
    for (epoch, _) in uncovered {
        if !epochs.contains(epoch) {
            epochs.push(*epoch);
        }
    }
    let mut ranges: Vec<(i64, i64)> = Vec::new();
    let mut run: Option<(i64, i64)> = None;
    for (_, seq) in uncovered {
        match run {
            Some((start, last)) if *seq == last + 1 => run = Some((start, *seq)),
            Some(r) => {
                ranges.push(r);
                run = Some((*seq, *seq));
            }
            None => run = Some((*seq, *seq)),
        }
    }
    if let Some(r) = run {
        ranges.push(r);
    }
    Some(Coverage {
        epochs,
        ranges,
        entries: uncovered.len(),
    })
}

/// A stored 32-byte binding. Migration `CHECK`s guarantee 32 bytes; a shorter
/// value must not compare equal to a prefix, so it is zero-padded and simply
/// fails to match.
fn to32(bytes: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let n = bytes.len().min(32);
    out[..n].copy_from_slice(&bytes[..n]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The design chain these tests drive. Written once so the identity slots
    /// cannot drift between the helper that seals and the call that verifies —
    /// which would make a passing run mean nothing.
    const TD: ChainRef<'static> = ChainRef::Design {
        organisation: "T",
        design: "D",
    };

    fn keys_for(epoch: i32) -> AvailableKeys {
        let master = Key32::from_bytes([9u8; 32]);
        let ck = chain_key(&master, TD, epoch);
        AvailableKeys::new(vec![(epoch, Subkeys::derive(&ck))])
    }

    /// **Different bytes per version, which is what the real table holds.**
    /// A helper that gave every version the same ciphertext would make the
    /// entry-driven storage pass untestable: an entry re-pointed at another
    /// version would match the wrong row's binding by accident.
    fn ciphertext_of(version: i64) -> Vec<u8> {
        format!("ciphertext-of-version-{version}").into_bytes()
    }

    fn entry(seq: i64, version: i64, prev: Vec<u8>, keys: &AvailableKeys) -> StoredEntry {
        let sub = keys.get(1).unwrap();
        let pb = plaintext_binding(
            &sub.content,
            &PlaintextFacts {
                tenant: "T",
                design: "D",
                design_version: version,
                payload_schema_version: 1,
                payload: b"payload",
            },
        );
        let sb = storage_binding(
            &sub.content,
            &StorageFacts {
                key_id: Key32::from_bytes([1u8; 32]).id(),
                key_epoch: 1,
                wrap_version: 1,
                aead_alg_id: 1,
                nonce: &[2u8; 12],
                ciphertext: &ciphertext_of(version),
            },
        );
        let ch = content_hash(&sub.content, &pb, &sb);
        let metadata = b"{}".to_vec();
        // A design chain stores its metadata in the clear, so the stored bytes
        // and the bytes the binding covers are the same slice.
        let mb = metadata_binding(&sub.content, &metadata);
        let s = seal(
            &sub.seal,
            &SealFacts {
                chain_key_epoch: 1,
                seq,
                chain: TD,
                prev_seal: &prev,
                content_hash: &ch,
                entry_type: EntryType::Update,
                metadata_stored: &metadata,
                metadata_binding: &mb,
            },
        );
        StoredEntry {
            seq,
            entry_type: StoredEntryType::Known(EntryType::Update),
            chain_key_epoch: 1,
            design_version: Some(version),
            prev_seal: prev,
            plaintext_binding: pb.to_vec(),
            storage_binding: sb.to_vec(),
            content_hash: ch.to_vec(),
            seal: s.to_vec(),
            metadata_stored: metadata,
            metadata_binding: mb.to_vec(),
        }
    }

    fn payload(version: i64) -> StoredPayload {
        StoredPayload {
            design_version: version,
            key_id: Key32::from_bytes([1u8; 32]).id(),
            key_epoch: 1,
            wrap_version: 1,
            aead_alg_id: 1,
            nonce: vec![2u8; 12],
            ciphertext: ciphertext_of(version),
            payload_schema_version: 1,
        }
    }

    fn three() -> (AvailableKeys, Vec<StoredEntry>, Vec<StoredPayload>) {
        let keys = keys_for(1);
        let mut entries = Vec::new();
        let mut prev = genesis(TD).to_vec();
        for seq in 1..=3i64 {
            let e = entry(seq, seq, prev.clone(), &keys);
            prev = e.seal.clone();
            entries.push(e);
        }
        let payloads = (1..=3).map(payload).collect();
        (keys, entries, payloads)
    }

    #[test]
    fn an_untouched_chain_verifies_and_says_what_it_did_not_check() {
        let (keys, entries, payloads) = three();
        let report = verify(TD, &entries, &payloads, &keys, None);
        assert_eq!(report.outcome, Outcome::Verified { entries: 3 });
        assert_eq!(report.content, ContentState::NotRebound);
        // The whole point of the fourth sub-state: this must not read like a
        // content check.
        let summary = report.summary();
        assert!(summary.contains("CONTENT NOT RE-BOUND"), "{summary}");
        assert!(!summary.contains("content verified"), "{summary}");
    }

    #[test]
    fn a_deep_run_says_so_and_reads_differently() {
        let (keys, entries, payloads) = three();
        let plaintexts: Vec<(i64, Vec<u8>)> = (1..=3).map(|v| (v, b"payload".to_vec())).collect();
        let deep = DeepInputs {
            payloads: &plaintexts,
            metadata: &[],
            refused_metadata: &[],
        };
        let report = verify(TD, &entries, &payloads, &keys, Some(&deep));
        assert_eq!(report.depth, Depth::Deep);
        assert_eq!(report.content, ContentState::Rebound);
        assert!(report.summary().contains("links and content"), "{report}");
    }

    #[test]
    fn tampering_with_the_middle_entry_breaks_at_it_and_not_before_it() {
        let (keys, mut entries, payloads) = three();
        // Rewrite what the second entry says happened. Its seal no longer
        // recomputes; the first entry is untouched and must still verify.
        entries[1].metadata_stored = br#"{"who":"someone else"}"#.to_vec();
        let report = verify(TD, &entries, &payloads, &keys, None);
        match report.outcome {
            Outcome::BrokenAt {
                seq,
                reason,
                verified_before,
                ..
            } => {
                assert_eq!(seq, 2);
                assert_eq!(reason, BreakReason::SealDoesNotRecompute);
                assert_eq!(verified_before, 1);
            }
            other => panic!("{other:?}"),
        }
        assert!(report.summary().contains("BROKEN AT ENTRY 2"), "{report}");
    }

    #[test]
    fn a_removed_middle_entry_breaks_the_links() {
        let (keys, mut entries, payloads) = three();
        entries.remove(1);
        match verify(TD, &entries, &payloads, &keys, None).outcome {
            Outcome::BrokenAt { seq, reason, .. } => {
                assert_eq!(seq, 3);
                assert_eq!(reason, BreakReason::SequenceSkippedOrRepeated);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_swapped_blob_is_caught_without_decrypting_anything() {
        let (keys, entries, mut payloads) = three();
        payloads[2].ciphertext = b"someone else's bytes".to_vec();
        match verify(TD, &entries, &payloads, &keys, None).outcome {
            Outcome::BrokenAt { seq, reason, .. } => {
                assert_eq!(seq, 3);
                assert_eq!(reason, BreakReason::StorageBindingMismatchUnexplained);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_missing_chain_key_epoch_is_a_coverage_gap_and_not_a_failure() {
        let (keys, mut entries, payloads) = three();
        entries[2].chain_key_epoch = 2;
        let report = verify(TD, &entries, &payloads, &keys, None);
        match &report.outcome {
            Outcome::CannotVerifyUnderKeyEpoch {
                epochs,
                ranges,
                verified_before,
            } => {
                assert_eq!(epochs, &[2]);
                assert_eq!(ranges, &[(3, 3)]);
                assert_eq!(*verified_before, 2);
            }
            other => panic!("{other:?}"),
        }
        let summary = report.summary();
        assert!(summary.contains("coverage gap"), "{summary}");
        assert!(!summary.contains("BROKEN"), "{summary}");
    }

    #[test]
    fn a_chain_does_not_verify_under_another_designs_key() {
        // §6's B5 fix: per-design chain keys are what make grafting fail.
        let (keys, entries, payloads) = three();
        let master = Key32::from_bytes([9u8; 32]);
        let other_design = ChainRef::Design {
            organisation: "T",
            design: "OTHER",
        };
        let other = AvailableKeys::new(vec![(
            1,
            Subkeys::derive(&chain_key(&master, other_design, 1)),
        )]);
        assert!(matches!(
            verify(other_design, &entries, &payloads, &other, None).outcome,
            Outcome::BrokenAt { seq: 1, .. }
        ));
        // ...and the same entries under the same key but a different tenant
        // do not verify either.
        assert!(matches!(
            verify(
                ChainRef::Design {
                    organisation: "OTHER",
                    design: "D"
                },
                &entries,
                &payloads,
                &keys,
                None
            )
            .outcome,
            Outcome::BrokenAt { seq: 1, .. }
        ));
        // ...and neither does the ORGANISATION chain of the same tenant, which
        // is the new half of the same fix: a different derivation label means
        // an entry cannot be lifted between levels either (§7.1).
        let org = ChainRef::Org { organisation: "T" };
        let org_keys = AvailableKeys::new(vec![(1, Subkeys::derive(&chain_key(&master, org, 1)))]);
        assert!(matches!(
            verify(org, &entries, &payloads, &org_keys, None).outcome,
            Outcome::BrokenAt { seq: 1, .. }
        ));
    }

    #[test]
    fn the_chain_key_derivation_cannot_be_spliced() {
        // §12.2: without length prefixes, tenant `ab` + design `c` and tenant
        // `a` + design `bc` derive the same key.
        let master = Key32::from_bytes([1u8; 32]);
        let d = |o, g| ChainRef::Design {
            organisation: o,
            design: g,
        };
        assert_ne!(
            chain_key(&master, d("ab", "c"), 1).expose(),
            chain_key(&master, d("a", "bc"), 1).expose()
        );
        assert_ne!(
            chain_key(&master, d("a", "b"), 1).expose(),
            chain_key(&master, d("a", "b"), 2).expose()
        );
        // ...and the same for genesis, which this module length-prefixes
        // where §11.2 wrote a bare concatenation. See `genesis`.
        assert_ne!(genesis(d("ab", "c")), genesis(d("a", "bc")));

        // The three levels derive three different keys for the same name, so
        // an entry cannot be spliced between them (§7.1). Checked rather than
        // asserted: the labels are three literals and a copy-paste between
        // them would be invisible in review.
        let site = chain_key(&master, ChainRef::Site { deployment: "X" }, 1);
        let org = chain_key(&master, ChainRef::Org { organisation: "X" }, 1);
        let design = chain_key(&master, d("X", ""), 1);
        assert_ne!(site.expose(), org.expose());
        assert_ne!(site.expose(), design.expose());
        assert_ne!(org.expose(), design.expose());

        // And the identity slots do not collide across levels either: the
        // site chain puts its name in the SECOND slot and the organisation
        // chain in the first, so `genesis` differs for the same string.
        assert_ne!(
            genesis(ChainRef::Site { deployment: "X" }),
            genesis(ChainRef::Org { organisation: "X" })
        );
    }

    // -----------------------------------------------------------------------
    // §12.6a: a coverage gap is a fact reported alongside, never a switch
    // -----------------------------------------------------------------------

    #[test]
    fn one_update_of_an_epoch_column_cannot_silence_a_forgery() {
        // Reproduced against bb04ccb: forge entry 1, then set UNRELATED entry
        // 3's `chain_key_epoch` to an epoch this run holds no key for, and the
        // whole report became "a coverage gap, not a failure -- the 2 entries
        // before it verify", over entries nothing had examined. The forgery
        // was never named.
        let (keys, mut entries, payloads) = three();
        entries[0].metadata_stored = br#"{"who":"someone else"}"#.to_vec();
        entries[2].chain_key_epoch = 2;

        let report = verify(TD, &entries, &payloads, &keys, None);
        match &report.outcome {
            Outcome::BrokenAt {
                seq,
                reason,
                verified_before,
                ..
            } => {
                assert_eq!(*seq, 1);
                assert_eq!(*reason, BreakReason::SealDoesNotRecompute);
                assert_eq!(*verified_before, 0);
            }
            other => panic!("the forgery must be reported, got {other:?}"),
        }
        let summary = report.summary();
        assert!(summary.starts_with("BROKEN AT ENTRY 1"), "{summary}");
        // The gap is still stated -- as an additional fact, not the headline.
        assert!(summary.contains("coverage gap"), "{summary}");
        assert_eq!(report.coverage.as_ref().map(|c| c.entries), Some(1));
    }

    #[test]
    fn verified_before_counts_only_entries_that_were_actually_verified() {
        // Entry 2 cannot be checked at all; entry 3 is forged. One entry
        // verified, and the number must say one -- not "the two before it",
        // which is what a `position()` in a list would have said.
        let (keys, mut entries, payloads) = three();
        entries[1].chain_key_epoch = 2;
        entries[2].metadata_stored = br#"{"who":"someone else"}"#.to_vec();

        match verify(TD, &entries, &payloads, &keys, None).outcome {
            Outcome::BrokenAt {
                seq,
                verified_before,
                ..
            } => {
                assert_eq!(seq, 3);
                assert_eq!(verified_before, 1);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn an_epoch_on_every_entry_claims_nothing_verified() {
        let (keys, mut entries, payloads) = three();
        for e in &mut entries {
            e.chain_key_epoch = 2;
        }
        let report = verify(TD, &entries, &payloads, &keys, None);
        match &report.outcome {
            Outcome::CannotVerifyUnderKeyEpoch {
                verified_before, ..
            } => assert_eq!(*verified_before, 0),
            other => panic!("{other:?}"),
        }
        let summary = report.summary();
        assert!(summary.contains("0 entries verify"), "{summary}");
    }

    #[test]
    fn an_epoch_this_deployment_never_wrote_is_an_anomaly_and_not_a_gap() {
        // The verifier holds the key for epoch 2 -- a chain master derives any
        // epoch -- and knows this deployment has only ever written epoch 1. So
        // there is no retired key to go and find; the column was changed.
        let (keys, mut entries, payloads) = three();
        entries[2].chain_key_epoch = 2;
        let master = Key32::from_bytes([9u8; 32]);
        let mut both = keys.by_epoch;
        both.push((2, Subkeys::derive(&chain_key(&master, TD, 2))));
        let keys = AvailableKeys::new(both).written_through(1);

        let report = verify(TD, &entries, &payloads, &keys, None);
        match &report.outcome {
            Outcome::BrokenAt { seq, reason, .. } => {
                assert_eq!(*seq, 3);
                assert_eq!(*reason, BreakReason::ChainKeyEpochNeverWritten);
            }
            other => panic!("{other:?}"),
        }
        assert!(!report.summary().contains("coverage gap"), "{report}");
    }

    // -----------------------------------------------------------------------
    // §12.6a: the storage pass is entry-driven, and it runs per entry
    // -----------------------------------------------------------------------

    #[test]
    fn an_entry_repointed_at_another_version_is_caught_with_the_seal_unchanged() {
        // The seal does not cover `design_version`, so this edit leaves every
        // seal recomputing. Against bb04ccb it returned `Verified` -- a
        // version destroyed and the history endorsing it. The entry-driven
        // storage pass catches it because entry 2's storage binding is over
        // version 2's bytes and those are not version 3's.
        let (keys, mut entries, mut payloads) = three();
        payloads.retain(|p| p.design_version != 2);
        entries[1].design_version = Some(3);

        match verify(TD, &entries, &payloads, &keys, None).outcome {
            Outcome::BrokenAt { seq, reason, .. } => {
                assert_eq!(seq, 2);
                assert_eq!(reason, BreakReason::StorageBindingMismatchUnexplained);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn the_first_break_is_the_first_break_and_not_the_first_link_break() {
        // A storage break at entry 1 and a link break at entry 3. Checking all
        // the links first and the stored bytes afterwards -- which is what
        // bb04ccb did -- reports entry 3 and claims two entries verified.
        let (keys, mut entries, mut payloads) = three();
        payloads[0].ciphertext = b"someone else's bytes".to_vec();
        entries[2].metadata_stored = br#"{"who":"someone else"}"#.to_vec();

        match verify(TD, &entries, &payloads, &keys, None).outcome {
            Outcome::BrokenAt {
                seq,
                reason,
                verified_before,
                ..
            } => {
                assert_eq!(seq, 1);
                assert_eq!(reason, BreakReason::StorageBindingMismatchUnexplained);
                assert_eq!(verified_before, 0);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_payload_row_no_entry_names_is_a_break_and_not_a_skip() {
        let (keys, entries, mut payloads) = three();
        payloads.push(payload(9));

        let report = verify(TD, &entries, &payloads, &keys, None);
        match &report.outcome {
            Outcome::BrokenAt {
                seq,
                reason,
                verified_before,
                design_version,
                ..
            } => {
                assert_eq!(*seq, 0, "there is no entry to blame, and none is invented");
                assert_eq!(*reason, BreakReason::PayloadNotNamedByAnyEntry);
                assert_eq!(*verified_before, 3);
                assert_eq!(*design_version, Some(9));
            }
            other => panic!("{other:?}"),
        }
        let summary = report.summary();
        assert!(summary.starts_with("BROKEN"), "{summary}");
        assert!(summary.contains("design version 9"), "{summary}");
    }

    #[test]
    fn a_design_whose_whole_chain_was_deleted_does_not_report_verified() {
        // The ciphertext is still there; every entry is gone. "verified: 0
        // entries" was the old answer.
        let (keys, _entries, payloads) = three();
        let report = verify(TD, &[], &payloads, &keys, None);
        assert!(
            matches!(
                report.outcome,
                Outcome::BrokenAt {
                    reason: BreakReason::PayloadNotNamedByAnyEntry,
                    ..
                }
            ),
            "{report}"
        );
    }

    #[test]
    fn an_entry_naming_a_version_that_is_not_stored_is_still_a_break() {
        let (keys, entries, mut payloads) = three();
        payloads.retain(|p| p.design_version != 3);
        match verify(TD, &entries, &payloads, &keys, None).outcome {
            Outcome::BrokenAt { seq, reason, .. } => {
                assert_eq!(seq, 3);
                assert_eq!(reason, BreakReason::PayloadMissing);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_reencrypt_entry_still_accounts_for_the_bytes_it_changed() {
        // The routine case, kept here because the entry-driven pass is what
        // now decides it: entry 1's storage binding no longer matches the
        // stored bytes, and the later `reencrypt` on the same version is the
        // account §11.2 asks a verifier to look for.
        let keys = keys_for(1);
        let sub = keys.get(1).unwrap();
        let mut entries = vec![entry(1, 1, genesis(TD).to_vec(), &keys)];

        // The bytes as a rotation would leave them.
        let rotated = b"re-encrypted bytes".to_vec();
        let sb = storage_binding(
            &sub.content,
            &StorageFacts {
                key_id: Key32::from_bytes([1u8; 32]).id(),
                key_epoch: 2,
                wrap_version: 1,
                aead_alg_id: 1,
                nonce: &[3u8; 12],
                ciphertext: &rotated,
            },
        );
        let pb = entries[0].plaintext_binding.clone();
        let ch = content_hash(&sub.content, &to32(&pb), &sb);
        let metadata = br#"{"entry_type":"reencrypt"}"#.to_vec();
        let mb = metadata_binding(&sub.content, &metadata);
        let prev = entries[0].seal.clone();
        let s = seal(
            &sub.seal,
            &SealFacts {
                chain_key_epoch: 1,
                seq: 2,
                chain: TD,
                prev_seal: &prev,
                content_hash: &ch,
                entry_type: EntryType::Reencrypt,
                metadata_stored: &metadata,
                metadata_binding: &mb,
            },
        );
        entries.push(StoredEntry {
            seq: 2,
            entry_type: StoredEntryType::Known(EntryType::Reencrypt),
            chain_key_epoch: 1,
            design_version: Some(1),
            prev_seal: prev,
            plaintext_binding: pb,
            storage_binding: sb.to_vec(),
            content_hash: ch.to_vec(),
            seal: s.to_vec(),
            metadata_stored: metadata,
            metadata_binding: mb.to_vec(),
        });

        let payloads = vec![StoredPayload {
            design_version: 1,
            key_id: Key32::from_bytes([1u8; 32]).id(),
            key_epoch: 2,
            wrap_version: 1,
            aead_alg_id: 1,
            nonce: vec![3u8; 12],
            ciphertext: rotated,
            payload_schema_version: 1,
        }];

        let report = verify(TD, &entries, &payloads, &keys, None);
        assert_eq!(report.outcome, Outcome::Verified { entries: 2 }, "{report}");
    }
}
