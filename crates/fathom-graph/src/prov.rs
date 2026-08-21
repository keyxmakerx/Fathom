//! Provenance: what every write carries (`11` §8.2), cut to what exists at
//! this stage of the build.
//!
//! `11` §8.2's four remaining origins (`Inferred`, `Imported`, `Defaulted`,
//! `Migrated`) and `Hand`'s `step` payload each name a type owned by a
//! subsystem that does not exist yet — `InferenceRuleId`, `ImportFormat`,
//! `MigrationId`, `WalkthroughStepId`. They arrive with those subsystems;
//! adding a variant here is additive, which is how `Parsed` arrived (WO-09
//! §4.2). `Actor` likewise ships `User` only.
//!
//! Timestamps and ULIDs are always caller-supplied: invariant 9 and
//! `fathom-id`'s own rule — *"There is deliberately no `new()` that reads a
//! clock or an RNG"*.

use fathom_id::Ulid;

/// Milliseconds since the Unix epoch, UTC. A stored value, always
/// caller-supplied, rendered as stored and never evaluated against a clock.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Timestamp(pub u64);

/// A provenance record's id. ULID; the record's content is immutable
/// (`11` §8.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ProvenanceId(pub Ulid);

/// Workspace-local and opaque.
///
/// **The clause "never transmitted" was removed from this comment on
/// 2026-08-21.** It is `11` §8.2's sentence and it was true of the client-only
/// artifact, which is the only thing that existed when it was written. `49`
/// makes the product server-hosted and multi-user, so a user id is exactly the
/// thing that *is* transmitted. `11` §8.2 is the document to amend; this
/// comment stops asserting the opposite in the meantime.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct UserId(pub Ulid);

impl UserId {
    /// **Made by a build that had no accounts.**
    ///
    /// Not a person, and deliberately not a *fresh* non-person either. Until
    /// 2026-08-21 every mutating opcode minted its author as
    /// `Ulid::from_parts(at.0, 1)` — derived from the host clock — so a
    /// fifty-operation estate carried up to fifty distinct `UserId`s, none of
    /// which was anybody. `49` §10c called that "the same anonymous nobody";
    /// it was in fact **one nobody per millisecond**, which is worse, because
    /// it looks like authorship data and is noise.
    ///
    /// A ULID's top 48 bits are its minting clock, so `Ulid(0)` is the Unix
    /// epoch and no real account can ever collide with it.
    ///
    /// **It is a value a server READS and never a value a server WRITES.** An
    /// operation that arrives carrying `LOCAL` was made before Fathom had
    /// accounts, and the honest sentence about it stays honest forever: *these
    /// operations came from a file, in this order, made before there were
    /// users.* Rewriting them to name whoever imported the file would assert
    /// something nobody knows.
    pub const LOCAL: UserId = UserId(Ulid(0));
}

/// Who asserted it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Actor {
    User(UserId),
}

/// Three values and no number (`11` §8.3). Not a score: a float invites fake
/// precision, and nobody can defend the difference between 0.7 and 0.8.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Confidence {
    Asserted,
    Derived,
    Heuristic,
}

/// A capture blob's id (`11` §8.4). The blob itself lives in the workspace's
/// capture section, which does not exist yet; this WO mints the id and hands
/// it back so the caller can pair the two (WO-09 §10 item 3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CaptureId(pub Ulid);

/// A half-open byte range into a **redacted** capture (`14` §9.5). Same shape
/// as `fathom_ingest::frame::ByteSpan`, deliberately a distinct type: this
/// crate does not depend on the parser (WO-09 §12 item 2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CaptureSpan {
    pub start: u32,
    pub end: u32,
}

/// How the value got into the graph. A hand-constructed graph carries
/// `Hand`; a graph welded from a paste carries `Parsed`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    Hand,
    /// A parser read it out of a redacted capture (`11` §8.2). `stanza`,
    /// `parser` and `parser_version` are deferred with the subsystems that
    /// own them — there is no capture store and no corpus version in the
    /// tree (WO-09 §3, §10 items 3–4).
    Parsed {
        capture: CaptureId,
        span: CaptureSpan,
    },
}

impl Origin {
    /// The discriminant history retention groups by (`11` §8.6: *"the
    /// earliest entry from each distinct `Origin` discriminant, always"*).
    pub(crate) fn discriminant(self) -> u8 {
        match self {
            Origin::Hand => 0,
            Origin::Parsed { .. } => 1,
        }
    }
}

/// One immutable assertion record (`11` §8.2).
///
/// `supersedes` is store-owned: a caller passes `None` and the store fills it
/// from the field's current provenance on a re-write, which is how `11` §8.6's
/// *"Edits never overwrite"* chain is built. A caller that fills it is
/// refused rather than believed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProvenanceRecord {
    pub id: ProvenanceId,
    pub origin: Origin,
    pub asserted_at: Timestamp,
    pub asserted_by: Actor,
    pub confidence: Confidence,
    pub supersedes: Option<ProvenanceId>,
}
