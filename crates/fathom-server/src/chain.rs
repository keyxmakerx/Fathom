//! The tamper-evident history: the constructions from
//! `docs/PHASE-2-STORAGE-DESIGN.md` §11.2 and §12.2, and the verifier that
//! reports §11.2's three outcomes and its fourth sub-state.
//!
//! This module is pure. It touches no database: `designs` and `chains` read
//! the rows and hand them here, which is what lets every construction below be
//! driven from a test with no PostgreSQL at all, and what lets a chain be
//! exported and verified somewhere else.
//!
//! # Three levels, one mechanism
//!
//! `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §7.1 — *"reuse, not
//! reinvention"* — adds a **site** chain (one per deployment) and an
//! **organisation** chain (one per tenant) beside §11.2's per-design one. The
//! seal construction, the length prefixing, `prev_seal`, `chain_key_epoch` on
//! every entry, retired chain keys kept forever and the ordering rules below
//! are **unchanged**. What is per level is the chain key's derivation label
//! ([`chain_key`]), so entries cannot be spliced between levels, and what is
//! per entry is whether it binds a payload at all ([`absent_content_binding`]).
//!
//! A second integrity mechanism would have been the easy way to add two
//! levels and the wrong one: two verifiers drift, and the ordering rule in
//! §12.6a — the one an attack found — would then have to be right twice.
//!
//! # The two things a verifier must never conflate
//!
//! **"Content not checked" must never render the same as "content
//! verified."** Routine verification is links plus storage bindings, no
//! decryption, runnable by an operator holding only the chain key. Deep
//! verification additionally decrypts and recomputes the plaintext binding.
//! **Both must name which they ran** — see [`Report::summary`].
//!
//! # The order of the checks is itself a control (§12.6a)
//!
//! **Everything verifiable is verified first, and a coverage gap is an extra
//! fact reported alongside — never an early return.** Returning the gap first
//! made it a switch: one `UPDATE` of any entry's `chain_key_epoch` turned a
//! detected forgery into *"a coverage gap, not a failure"*, with a summary
//! claiming the earlier entries verified over entries nothing had examined.
//! Any count of what verified comes from verification and never from a
//! position in a list, and an epoch above what this deployment ever wrote is
//! an anomaly rather than a gap, because there is no retired key to find.
//!
//! # What the chain does not do
//!
//! Each seal binds backwards only. Deleting the last three entries leaves the
//! survivors verifying end to end, and restoring last month's tables produces
//! a rollback the chain cryptographically endorses (§6's B4 fix). `seq` is in
//! the MAC input and **does not** detect tail truncation. Only an anchor
//! outside the deployment does, and this order does not build one.

use core::fmt;

use sha2::{Digest, Sha256};

use crate::crypto::{self, Key32, KeyId};

/// The per-design chain key's derivation label (§12.2).
///
/// **Length-prefixed, and that is the fix.** §6 said the chain key is scoped
/// per design; §11.2 then started from it as a given. Without length prefixes
/// on the identity inputs, tenant `ab` + design `c` and tenant `a` + design
/// `bc` derive the **same chain key** — the identical splice §11.2 closed one
/// layer up.
const CHAIN_KEY_LABEL: &[u8] = b"fathom/chain/key/v1";

/// The **site** chain key's derivation label — one chain per deployment.
///
/// Raised by `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §7.1, which does not own
/// it, and landed in `docs/PHASE-2-STORAGE-DESIGN.md` §12.2's table, which
/// does. Domain-separated from the other two so that a genuine run of entries
/// lifted from one level into another does not verify at the other: the seal
/// key is different, whatever the row says.
const SITE_CHAIN_KEY_LABEL: &[u8] = b"fathom/chain/key/site/v1";

/// The **organisation** chain key's derivation label — one chain per tenant.
/// §7.1 again, §12.2's table again.
///
/// This is the chain §12.6 means by *"the tenant-level chain"*: the level a
/// `rewrap` entry is filed on, and the reason re-wrap could not be finished
/// when only per-design chains existed.
const ORG_CHAIN_KEY_LABEL: &[u8] = b"fathom/chain/key/org/v1";

/// The **site metadata** key's derivation label (§7.3, §12.2's table).
///
/// Site-chain metadata is AEAD ciphertext like the organisation chain's, but
/// the site chain exists precisely where no organisation does, so there is no
/// tenant key to reach for. §7.3: *"under a site metadata key derived from
/// `chain_master`"*.
///
/// **Per `chain_key_epoch`, and that is load-bearing rather than tidy.** A
/// chain entry is append-only, so a key rotation can never re-encrypt one. The
/// key that opens an entry must therefore never stop existing, which means
/// epochs kept forever — the same rule retired chain keys and retired data
/// keys already follow.
///
/// **What this costs, stated rather than discovered: a routine verifier
/// holding `chain_master` can read site metadata.** That is acceptable because
/// the site chain records deployment-level acts and holds no tenant data. It
/// is deliberately not true one level down: the organisation content key is a
/// wrapped DEK under the tenant key, which a verifier does not hold and cannot
/// derive, so handing someone the ability to verify a history does not hand
/// them a tenant's access map.
const SITE_METADATA_KEY_LABEL: &[u8] = b"fathom/chain/key/site-metadata/v1";

/// HKDF `info` for the sealing subkey (§12.2).
///
/// **Deliberately not the same literal as the in-MAC domain tag below**, even
/// though they were in §11.2's first draft. Different functions under
/// different keys, so the reuse was not a weakness — but someone would later
/// tidy one occurrence and silently change the other, and the seals written
/// before that day would stop verifying.
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
/// A site or organisation entry records an act, not a version. It still
/// carries both content bindings and a `content_hash`, computed by the same
/// functions over the same shape — so [`seal`] does not change at all, and
/// [`verify`]'s `content_hash` check runs on every entry of every level
/// without a branch. **That is the difference between reusing §11.2's
/// construction and forking it**: there is one seal input in this product, and
/// an entry that carries no payload says so inside the same MAC rather than
/// beside it.
const TAG_NO_CONTENT: &[u8] = b"fathom/chain/nocontent/v1";

/// The in-MAC domain tag for the **metadata binding** — the keyed value that
/// covers what an entry's metadata *means*, as opposed to the bytes stored for
/// it. See [`metadata_binding`].
const TAG_METADATA: &[u8] = b"fathom/chain/metadata/v1";

/// The AEAD associated-data tag for an encrypted metadata column.
const AAD_METADATA: &[u8] = b"fathom/chain/metadata/aead/v1";

/// Which of the three chains an entry belongs to.
///
/// `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §7.1. The per-design edit chain is
/// §11.2's, unchanged; the site and organisation chains are this order's.
///
/// **`read` is not here.** §7.2's per-design read chain (`payload_decrypted`)
/// carries an open volume question — one entry per decryption is the honest
/// maximum and costs two orders of magnitude more rows than the deduplicated
/// alternative — and §15.6 does not put it in this stage. Its derivation label
/// is reserved in §12.2's table and nothing writes it.
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
/// # The two identity slots, and why they are the same two §11.2 already had
///
/// §11.2's seal covers `LP(tenant_id) ‖ LP(design_id)`. Those are not two
/// concepts the seal cares about — they are *the chain's identity, length
/// prefixed, in two parts*. So the three levels fill the same two slots:
///
/// | chain | first slot | second slot |
/// |---|---|---|
/// | site | `""` | deployment id |
/// | organisation | organisation id | `""` |
/// | design | organisation id | design id |
///
/// **The design case is byte-for-byte what it was**, so every seal written
/// before this existed still verifies. The empty slots are unambiguous because
/// every slot is length-prefixed — `LP("")` is four zero bytes and cannot be
/// confused with anything.
///
/// The identity slots are not what keeps the levels apart, though. The chain
/// KEY is derived under a different label per level (§7.1), so an entry moved
/// between levels is sealed under a key the destination's verifier never
/// derives. The slots are the second layer.
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
    /// **The same content, different bytes** — a rotation re-encrypted this
    /// version under a new key (§11.2, §12.6). The entry carries
    /// `plaintext_binding` across unchanged, which is itself the proof that
    /// the content did not change when the bytes did, and its metadata
    /// records the epochs, wrap versions and storage bindings on both sides.
    ///
    /// This is what stops a routine key rotation looking exactly like an
    /// attack, and so stops operators learning to dismiss the alarm.
    Reencrypt,

    // ---- Site chain (§7.2) ------------------------------------------------
    /// This deployment started. The site chain's first entry, and one more on
    /// every start after that.
    ///
    /// §7.2 lists thirty-odd site entry types. This is one of the four this
    /// order writes; the rest arrive with the surfaces that cause them,
    /// because an entry type nothing emits is a name in a `CHECK` constraint
    /// pretending to be a control.
    DeploymentStarted,
    /// **The audit destination has not taken anything for a while** — §9's
    /// `shipper_gap`, written when the spool's oldest unshipped entry passes
    /// one of §9's escalation points (the first hour, the sixth hour, and the
    /// age bound itself). See `audit::SpoolBounds`.
    ShipperGap,
    /// **The spool has passed a bound** — §9's `spool_pressure`. Written when
    /// the spool passes its age bound or its size bound, which is the point at
    /// which §9's degrade table stops design writes and keeps reads serving.
    SpoolPressure,

    // ---- Organisation chain (§7.2) ---------------------------------------
    /// The first entry on an organisation's chain.
    OrgGenesis,

    // ---- The authority layer's acts (§7.2, migration 0011) ---------------
    //
    // Nine types, every one of them written by `grants.rs`. §7.2 lists more
    // for this chain (`scope_moved`, `devices_reparented`,
    // `recovery_holders_set`, `break_glass_*`, `member_added|removed`,
    // `authority_rollback`); they arrive with the surfaces that cause them,
    // because an entry type nothing emits is a name in a `CHECK` constraint
    // pretending to be a control.
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
    /// A grant was suspended: by a steward, or by an operator, which is the
    /// one authority-adjacent act §1.1 gives the operator plane.
    GrantSuspended,
    /// A steward lifted a suspension. An operator cannot: `0011`'s own
    /// `CHECK` refuses `unsuspend` for an operator principal.
    GrantUnsuspended,
    /// A grant was revoked — the positive, append-only fact §3.2 requires in
    /// place of a nullable column whose absence means live.
    GrantRevoked,
    /// The organisation's authority head moved to a new epoch (§3.4). Written
    /// by every one of the acts above, in the same transaction, because the
    /// head is what makes the current state of the SET authenticated rather
    /// than only the author of each row.
    AuthHeadAdvanced,
    /// **A re-wrap happened** — §12.6's whole point.
    ///
    /// Custody changed and exposure did not. The entry names the old and the
    /// new master identity, which key rows moved, who ran it, and — as a
    /// statement of fact inside the sealed metadata — that no payload was
    /// re-encrypted. Rotation writes a `reencrypt` entry per version because it
    /// changes bytes; re-wrap changes no bytes at all, so without this entry
    /// the operation that changes *who can decrypt everything* would be the
    /// only key operation in the product with no audit trail.
    ///
    /// **The one type filed on two kinds.** A re-wrap is deployment-wide,
    /// because the master key is: one summary entry lands on the site chain
    /// naming both master identities and how many tenants moved, and one entry
    /// lands on each affected organisation's chain naming that tenant's own
    /// epochs. §7.2 puts the record of the fact on the tenant-level chain and
    /// leaves room for the site-level summary; `keys::rewrap_master_key`
    /// writes both, in one transaction, or neither.
    Rewrap,
}

impl EntryType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::Update => "update",
            Self::Reencrypt => "reencrypt",
            Self::DeploymentStarted => "deployment_started",
            Self::ShipperGap => "shipper_gap",
            Self::SpoolPressure => "spool_pressure",
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
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "create" => Some(Self::Create),
            "update" => Some(Self::Update),
            "reencrypt" => Some(Self::Reencrypt),
            "deployment_started" => Some(Self::DeploymentStarted),
            "shipper_gap" => Some(Self::ShipperGap),
            "spool_pressure" => Some(Self::SpoolPressure),
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
            _ => None,
        }
    }

    /// Which chains this type may be filed on — **plural, because `rewrap` is
    /// filed on two.**
    ///
    /// Mirrored by `chain_entries_type_belongs_to_kind`, created in
    /// `migrations/0010_entry_type_belongs_to_kind.sql` and extended by
    /// `migrations/0011_authority.sql` through that file's documented DROP +
    /// ADD path, so the rule holds for a statement this code never issued as
    /// well as for one it did.
    ///
    /// **Corrected 2026-09-12.** This read `chain_kind(self) -> ChainKind`
    /// and its doc said the constraint was in
    /// `0009_chains_at_three_levels.sql`. It was not: 0009 dropped 0007's
    /// `CHECK (entry_type IN (...))` and added nothing in its place, so
    /// `entry_type` was free text and the runtime role could insert one no
    /// verifier could parse. 0010 adds the constraint this now mirrors.
    pub fn kinds(self) -> &'static [ChainKind] {
        match self {
            Self::Create | Self::Update | Self::Reencrypt => &[ChainKind::Design],
            Self::DeploymentStarted | Self::ShipperGap | Self::SpoolPressure => &[ChainKind::Site],
            Self::OrgGenesis
            | Self::AccountKeyEnrolled
            | Self::AccountKeySuperseded
            | Self::AccountKeyRetired
            | Self::GrantSigned
            | Self::GrantSeconded
            | Self::GrantSuspended
            | Self::GrantUnsuspended
            | Self::GrantRevoked
            | Self::AuthHeadAdvanced => &[ChainKind::Org],
            Self::Rewrap => &[ChainKind::Site, ChainKind::Org],
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
/// `entry_type` is a text column. Until `0010` there was no constraint on it
/// at all, and even with one a row can be forced in by whoever can disable a
/// trigger — which `0009`'s own header rates a tier-3 move and
/// `tests/support::tamper` performs in the open. So the verifier has to have
/// somewhere to put a value it cannot parse.
///
/// **It may not be an error.** §11.2 gives verification exactly three
/// outcomes, and *"this chain cannot be read at all"* is not one of them: an
/// `Err` return says nothing about the entries before the bad row, which is
/// precisely the claim a tamper-evident log exists to make. One junk type
/// inserted by the runtime role would otherwise make a chain permanently
/// unverifiable, which is a denial of the control rather than a detection of
/// it. So it is [`BreakReason::EntryTypeNotRecognised`] at that row, with
/// everything before it reported verified.
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

/// The chain key for one chain at one epoch — §12.2's derivation, extended to
/// the three levels §7.1 adds and length-prefixed throughout.
///
/// ```text
/// site:   HKDF-Expand(chain_master,
///             LP("fathom/chain/key/site/v1") ‖ LP(deployment_id) ‖ u32(epoch), 32)
/// org:    HKDF-Expand(chain_master,
///             LP("fathom/chain/key/org/v1")  ‖ LP(organisation_id) ‖ u32(epoch), 32)
/// design: HKDF-Expand(chain_master,
///             LP("fathom/chain/key/v1") ‖ LP(tenant_id) ‖ LP(design_id) ‖ u32(epoch), 32)
/// ```
///
/// **The design case is unchanged**, which is the requirement rather than a
/// courtesy: a different info string here would silently stop every seal
/// already in the database from verifying, and the failure would render as a
/// forgery alarm.
///
/// **Per chain, which is what makes grafting fail** (§6's B5 fix, now at three
/// levels): a genuine run of entries lifted from one design into another — or
/// from one organisation's chain into another's, or between levels — does not
/// verify under the destination's chain key. The length prefixes are what stop
/// organisation `ab` + design `c` and organisation `a` + design `bc` deriving
/// the same key.
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
/// See [`SITE_METADATA_KEY_LABEL`] for why it is derived rather than wrapped,
/// why it is per epoch, and what a verifier holding `chain_master` can
/// therefore read.
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
/// **The seal already binds the ciphertext to its position**, because
/// `metadata_stored` and `seq` are both in the seal input. This binds it a
/// second time inside the AEAD, so a blob lifted between two entries of the
/// same chain fails to decrypt at all rather than decrypting into the wrong
/// entry's report — the same reason §4 binds a wrapped key to its identity
/// instead of trusting the row it was read from.
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
    // The database column is `bigint`/`int` (signed, and non-negative by a
    // CHECK constraint); §11.2 writes u64/u32. The cast is bit-preserving and
    // the value is in range, so the two spellings are the same bytes.
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

/// The value both bindings carry on an entry that binds **no payload** — every
/// site and organisation entry.
///
/// ```text
/// MAC(K_content, LP("fathom/chain/nocontent/v1"))
/// ```
///
/// It is keyed and domain-separated, so it can neither collide with a real
/// binding nor be recognised from a dump without the chain key. Both slots
/// carry it, `content_hash` is then [`content_hash`] of the pair exactly as on
/// a design entry, and the seal input is byte-identical in shape. **No branch
/// in the verifier and no second seal construction** — which is the whole
/// reason it is a constant rather than a `NULL` column.
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
/// # Why this exists, and what it replaced
///
/// §11.2's seal ended `‖ LP(canon(metadata))` — the plaintext, directly in the
/// MAC. That made §7.3's encrypted metadata impossible: recomputing **any**
/// seal would have needed the metadata key, so §11.2's routine check — links
/// and bindings, no decryption, runnable by an operator holding only the chain
/// key — would not have run at all on the chains that most need checking.
///
/// So metadata gets the two-tier treatment the *payload* already had:
///
/// | tier | covers | in the clear? |
/// |---|---|---|
/// | seal input `metadata_stored` | the bytes on disk | yes — the column |
/// | `metadata_binding` (this) | what those bytes mean | yes — 32 bytes, keyed |
///
/// Links-only recomputes the seal from stored columns alone, so **a swapped or
/// corrupted ciphertext breaks the seal with no key but the chain key**.
/// Deep additionally recovers the plaintext — from the column on a design
/// chain, by decrypting on a site or organisation one — and recomputes this
/// value. Binding only the plaintext would have left the ciphertext covered by
/// nothing on the one run §11.2 calls routine.
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
/// **§11.2 writes this as `LP(H("fathom/chain/genesis/v1" ‖ tenant_id ‖
/// design_id))` and this implementation differs from that line in two
/// deliberate ways, both reported back rather than quietly taken.**
///
/// 1. The `LP(...)` is read as *how the value enters the MAC*, not as part of
///    the value. Every `seal_{n-1}` enters the seal input through `LP(...)`
///    already, so treating the outer prefix as part of the stored value would
///    length-prefix the genesis value twice and nothing else once.
/// 2. The inner concatenation is **length-prefixed**, where §11.2 writes it
///    bare. Bare, tenant `ab` + design `c` and tenant `a` + design `bc` give
///    the same genesis — the exact splice the same section closes one line
///    above and §12.2 closes again for the chain-key derivation. It is
///    harmless in practice, because the chain key is already per design, but
///    an unprefixed concatenation sitting next to a rule that says
///    "length-prefix every variable-length field" is what gets copied.
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
    /// **The metadata column's bytes, exactly as they are stored** — the
    /// canonical plaintext on a design chain, the AEAD blob on a site or
    /// organisation one. The seal covers what is on disk, which is what lets
    /// a links-only run catch a swapped ciphertext with the chain key alone.
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
    /// **The column, parsed or carried** — see [`StoredEntryType`]. A type
    /// this build cannot parse is a break at this entry, never an error that
    /// silences the whole chain.
    pub entry_type: StoredEntryType,
    pub chain_key_epoch: i32,
    /// `Some` on a design chain, `None` on a site or organisation chain —
    /// where an entry records an act and there is no version to bind. The
    /// column is nullable for exactly this reason and the migration's
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

/// Which of the four things failed first (§11.2), plus the three this
/// implementation adds because a verifier that cannot say them would have to
/// stay silent about a real tamper.
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
    /// **A stored payload version that no entry in the history names.** The
    /// other direction of [`Self::PayloadMissing`], and it has to be checked
    /// separately: walking entries can only ever find a row an entry points
    /// at. An inserted payload row is invisible to that walk, verifies as
    /// nothing, and — carrying the highest `design_version` — is what a read
    /// of "the latest version" then refuses on.
    PayloadNotNamedByAnyEntry,
    /// **The entry names a chain key epoch this deployment has never
    /// written.** Not a coverage gap: there is no retired key to go and find,
    /// because no such epoch was ever minted. Someone changed the column.
    ChainKeyEpochNeverWritten,
    /// The metadata recovered for this entry is not what
    /// [`metadata_binding`] committed to.
    ///
    /// Reachable on every chain, but by two different routes. On a design
    /// chain the stored column *is* the plaintext, so this fires on a
    /// links-only run: someone edited the metadata and recomputed nothing.
    /// On a site or organisation chain the stored column is ciphertext bound
    /// by the seal, so reaching this needs a deep run and means the
    /// **decrypted** value disagrees with the binding — which the writer's own
    /// key would have had to produce.
    MetadataBindingMismatch,
    /// **The metadata will not open under this row's own associated data.**
    /// Deep runs only, and deliberately distinct from
    /// [`Self::MetadataBindingMismatch`]: a binding mismatch means the
    /// plaintext came back and is not what was committed to, this means no
    /// plaintext came back at all.
    ///
    /// The AEAD's associated data is
    /// `LP(tag) ‖ LP(chain_kind) ‖ LP(chain_id) ‖ u64(seq) ‖ u32(key_epoch)`
    /// ([`metadata_aad`]), so a blob lifted from one entry to another of the
    /// same chain does not decrypt even for someone who recomputed the seal
    /// over it — which a tier-2 attacker holding the chain key can do. Without
    /// the AAD, that move would decrypt into the wrong entry's report and both
    /// a links-only and a deep run would pass it.
    MetadataDoesNotOpenUnderItsOwnAad,
    /// **The `entry_type` column holds text no `EntryType` parses.** See
    /// [`StoredEntryType`]: it is reported here, at the row, with everything
    /// before it still verified, rather than as an error that makes the whole
    /// chain unreadable for ever.
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

/// The failing entry's metadata, and **whether what is being handed over is
/// readable**.
///
/// An enum rather than a `Vec<u8>` or an `Option<Vec<u8>>`, and the reason is
/// the one thing this whole tier is for: on a site or organisation chain the
/// stored column is ciphertext, and a break report that handed an operator a
/// blob where they expected canonical JSON would be a report they stop reading.
/// `Option` would say "present or absent" and the question here is "present as
/// what". The type makes the caller match, so a renderer cannot print the
/// wrong one by default.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EntryMetadata {
    /// `fathom-canon`'s canonical bytes — the metadata as it was sealed.
    /// A design chain yields these on any run; a site or organisation chain
    /// only on a deep one.
    Plaintext(Vec<u8>),
    /// The stored AEAD blob, on a run that did not decrypt it. **Flagged, not
    /// rendered.** The break is still fully named — `seq`, the reason,
    /// `entry_type` and `chain_key_epoch` all travel in the report beside this
    /// — so an operator has everything they need except the sentence inside
    /// the entry, and is told exactly that rather than shown noise.
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
        /// The failing entry's `seq`, or `0` when the break is not at an entry
        /// at all — a stored payload no entry names has no `seq` to report,
        /// and inventing one would send an operator to an entry that verifies.
        seq: i64,
        reason: BreakReason,
        /// **Counted by verification, never by a position in a list.** An
        /// entry that could not be checked — no key for its epoch — does not
        /// count towards this, so the number never claims more than was done.
        verified_before: usize,
        /// The failing entry's own metadata, so a reader has something to act
        /// on rather than an index — **and whether it is readable**. See
        /// [`EntryMetadata`]: on a site or organisation chain a links-only run
        /// holds ciphertext, and saying so beats printing it.
        metadata: EntryMetadata,
        /// The failing entry's type, always in the clear, so a break on an
        /// encrypted chain still names what kind of act it was — **including
        /// when the column holds text nothing parses**, which is the one case
        /// where naming it is the whole report.
        entry_type: Option<StoredEntryType>,
        /// The failing entry's chain key epoch, always in the clear.
        chain_key_epoch: Option<i32>,
        /// The design version involved, when there is one.
        design_version: Option<i64>,
    },
    /// **A coverage gap, not a failure.** Some entries name a chain key epoch
    /// this verifier was not given — **and everything that could be checked
    /// was checked first, and nothing was broken.** This outcome can only be
    /// reached after a full pass.
    CannotVerifyUnderKeyEpoch {
        epochs: Vec<i32>,
        ranges: Vec<(i64, i64)>,
        verified_before: usize,
    },
}

/// The entries a run could not check, reported **alongside** an outcome rather
/// than instead of one.
///
/// §12.6a: *"verify everything verifiable first and report every break found;
/// a coverage gap is an additional fact reported alongside, never an early
/// return."* Before that rule, one `UPDATE` of any entry's `chain_key_epoch`
/// turned a detected forgery into a coverage gap and sent the operator to look
/// for a retired key that does not exist.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Coverage {
    /// The epochs no key was given for.
    pub epochs: Vec<i32>,
    /// The contiguous `seq` ranges those entries occupy.
    pub ranges: Vec<(i64, i64)>,
    /// How many entries went unchecked.
    pub entries: usize,
}

/// What a verification run says. **The depth and the content state travel with
/// the outcome and cannot be dropped by a caller formatting it**, which is the
/// mechanical half of *"content not checked must never render the same as
/// content verified"*.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Report {
    pub outcome: Outcome,
    pub depth: Depth,
    pub content: ContentState,
    /// `Some` when some entries could not be checked at all. **Present
    /// whatever the outcome is**, including beside a break: "I could not check
    /// these" and "this one is broken" are both true at once and the second
    /// must not be swallowed by the first.
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
                // The text itself, quoted, for the one break whose whole
                // content is what somebody put in the column. Truncated and
                // escaped by `Debug`, so a value chosen to forge a log line
                // cannot.
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
    /// **An epoch above it is an anomaly, not a coverage gap** (§12.6a): no
    /// such key was ever minted, so there is nothing to go and find. A caller
    /// that genuinely does not know — an offline verifier handed an exported
    /// chain — passes `None` and gets the coverage reading.
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
/// This module never decrypts anything. It holds no data key, no organisation
/// content key and no site metadata key, and it should not: every construction
/// in this file has to be drivable from a test with no PostgreSQL and from an
/// offline verifier with an exported chain. The caller — `designs` or `chains`
/// — opens what it can and hands the plaintext in, exactly as it already did
/// for payloads.
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
    /// Absence from `metadata` alone cannot say this. An entry can be missing
    /// from that list for two reasons that must not read alike: the run held
    /// no key for its epoch (§11.2's fourth sub-state — *content not
    /// re-bound*, not a failure), or the key was right and the AEAD refused
    /// (a break, [`BreakReason::MetadataDoesNotOpenUnderItsOwnAad`]). Only the
    /// caller that tried the decryption knows which, so it says so here rather
    /// than leaving the verifier to guess the kinder of the two.
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
/// Everything checkable is checked **first**, in one pass, in `seq` order, and
/// the first break found is the one reported. `seq` and `prev_seal` need no
/// key at all, so they are checked even for an entry whose epoch this run
/// cannot open. A coverage gap is collected as it is met and reported
/// alongside; it never returns early and it never contributes to
/// `verified_before`.
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

    // Whether the metadata column holds the plaintext or a blob. A design
    // chain stores canonical bytes; the other two store AEAD ciphertext
    // (§7.3). This is the ONE branch the metadata tier costs, and it decides
    // only where the plaintext comes from -- never whether the seal is checked.
    let metadata_is_stored_in_the_clear = chain.kind() == ChainKind::Design;

    // **The coverage gap is collected before the pass and reported with
    // whatever the pass finds** -- never instead of it (§12.6a). Working it
    // out first costs one key lookup per entry and means a break found at
    // entry 1 still carries the fact that entry 3 could not be checked;
    // collecting it as the pass went would lose that, because the pass stops
    // at the break.
    //
    // An epoch above what this deployment ever wrote is deliberately NOT
    // counted here: there is no retired key to find, so it is an anomaly and
    // the pass reports it as a break.
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
        // What this run can honestly hand an operator for this entry. On a
        // design chain the column is the plaintext; on the other two it is
        // ciphertext unless a deep run supplied the decryption.
        let reportable_metadata = || {
            if metadata_is_stored_in_the_clear {
                return EntryMetadata::Plaintext(entry.metadata_stored.clone());
            }
            match deep.and_then(|d| d.metadata.iter().find(|(s, _)| *s == entry.seq)) {
                Some((_, bytes)) => EntryMetadata::Plaintext(bytes.clone()),
                None => EntryMetadata::Ciphertext(entry.metadata_stored.clone()),
            }
        };

        // `content` is passed in rather than captured: the metadata tier below
        // can downgrade it to `NotRebound` part-way through this entry, and a
        // closure that had borrowed it would then report the value from before
        // the downgrade -- which is the one thing this field must never do.
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
        // The type is read before anything else is claimed about this entry.
        // It is in the seal input, so a run that carried on would be sealing
        // over text it could not name -- and a verifier that returned an ERROR
        // here would let one junk value, insertable by the runtime role
        // before `0010`, make a whole chain permanently unverifiable. §11.2
        // has three outcomes and "unreadable" is not one of them.
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

        // An epoch beyond anything this deployment ever wrote is a changed
        // column, not a key somebody else holds -- checked before the key
        // lookup so that it reads as the anomaly it is even when a key for
        // that epoch happens to be derivable.
        if keys
            .written_through
            .is_some_and(|highest| entry.chain_key_epoch > highest)
        {
            return broke(BreakReason::ChainKeyEpochNeverWritten, content);
        }

        // ---- What needs the key for this entry's epoch --------------------
        let Some(subkeys) = keys.get(entry.chain_key_epoch) else {
            // Not verified, and so not counted. The links either side of it
            // were checked above; nothing sealed under a key this run does not
            // hold is claimed to be anything.
            continue;
        };

        // The entry's own two bindings must combine to the content_hash it
        // carries — otherwise a seal could cover a content_hash that is not
        // the bindings beside it, and the storage check below would be
        // checking something the seal never committed to.
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
        // The seal above already covered the STORED bytes, so a swapped or
        // corrupted ciphertext is caught with the chain key alone. This is the
        // other half: that those bytes still MEAN what was sealed.
        //
        // On a design chain the plaintext is the column, so this runs on every
        // run. On a site or organisation chain it runs only when a deep run
        // supplied the decryption — and an entry that could not be decrypted
        // is `NotRebound` rather than verified, which is §11.2's fourth
        // sub-state doing exactly the job it was written for one tier down.
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
            // Held the key and the AEAD refused. That is not "could not
            // check": it is a blob that does not belong at this position under
            // this key epoch, and the associated data is what says so. A
            // tier-2 attacker holding the chain key can move a ciphertext to
            // another `seq` and recompute that row's seal over it, so nothing
            // ELSE in this verifier objects -- which is exactly why the AEAD's
            // associated data is not decoration.
            None if deep.is_some_and(|d| d.refused_metadata.contains(&entry.seq)) => {
                return broke(BreakReason::MetadataDoesNotOpenUnderItsOwnAad, content);
            }
            None if deep.is_some() => {
                // Asked for a deep run and this entry's metadata could not be
                // decrypted. "Content not checked" must never render the same
                // as "content verified".
                content = ContentState::NotRebound;
            }
            None => {}
        }

        // ---- The stored bytes, ENTRY-DRIVEN (§12.6a) ----------------------
        //
        // For each entry, the payload it names. Driving this from the entries
        // rather than from the payload rows is what closes the gap the seal
        // itself leaves: the seal does not cover `design_version`, so an entry
        // re-pointed at another version is unauthenticated — but the storage
        // binding it carries is over the bytes of the version it was written
        // for, and those are not the bytes of the version it now names.
        // Deleting the entry instead breaks the next entry's `prev_seal`.
        //
        // An entry that names no version has nothing to do here — a site or
        // organisation entry records an act. Its two bindings are the keyed
        // `absent_content_binding`, and the `content_hash` check above already
        // held them to what the seal committed to, so this is a skip and not
        // an unchecked path.
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
                // §11.2: *"a verifier meeting a storage-binding mismatch looks
                // for a reencrypt entry accounting for it: found, routine;
                // absent, broken."* A later `reencrypt` on this same version is
                // exactly that account -- it supersedes this entry's storage
                // binding, and is itself checked when the pass reaches it.
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
                        // Asked for a deep run and one version could not be
                        // decrypted: the links still verified, and saying
                        // "verified" here would be the exact conflation §11.2
                        // forbids.
                        content = ContentState::NotRebound;
                    }
                }
            }
        }

        verified += 1;
    }

    // The other direction, and it cannot be folded into the loop above: an
    // inserted payload row is named by no entry, so no entry-driven walk can
    // reach it. It is a break and not a skip -- being the highest
    // `design_version`, it is what a read of "the latest version" lands on.
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

/// A stored 32-byte binding. A column shorter than 32 cannot occur — the
/// migration `CHECK`s it — and a value that somehow is shorter must not
/// silently compare equal to a prefix, so it is zero-padded into a fixed
/// array and will simply fail to match.
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
