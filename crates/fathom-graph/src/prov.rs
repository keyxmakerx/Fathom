//! Provenance: what every write carries (`11` §8.2), cut to what exists at
//! this stage of the build.
//!
//! `11` §8.2's five further origins (`Parsed`, `Inferred`, `Imported`,
//! `Defaulted`, `Migrated`) and `Hand`'s `step` payload each name a type owned
//! by a subsystem that does not exist yet — `CaptureId`, `InferenceRuleId`,
//! `ImportFormat`, `MigrationId`, `WalkthroughStepId`. They arrive with those
//! subsystems; adding a variant here is additive. `Actor` likewise ships
//! `User` only.
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

/// Workspace-local, opaque, never transmitted (`11` §8.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct UserId(pub Ulid);

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

/// How the value got into the graph. A hand-constructed graph carries
/// `Hand` and nothing else at this stage.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    Hand,
}

impl Origin {
    /// The discriminant history retention groups by (`11` §8.6: *"the
    /// earliest entry from each distinct `Origin` discriminant, always"*).
    pub(crate) fn discriminant(self) -> u8 {
        match self {
            Origin::Hand => 0,
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
