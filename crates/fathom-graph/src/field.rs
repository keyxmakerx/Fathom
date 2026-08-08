//! The erased field slot, its three stored presence states, and the bounded
//! value history (`11` §5.2, §8.6).
//!
//! **The store holds exactly three presence states.** `Presence::Default` is
//! never stored: `11` §5.3 — *"never materialised into the stored graph"* —
//! makes `Default` a read-time synthesis owned by the defaults subsystem. A
//! missing slot **is** `Unknown` (*"The normal state of most of the graph"*);
//! an `Absent` slot is stored explicitly, with its provenance, because
//! somebody actually looked (`11` §8.5).

use crate::prov::{Origin, ProvenanceId};

/// What the store records about a field. The fourth state, `Default`,
/// arrives with the defaults subsystem.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoredPresence {
    Set,
    Absent,
    Unknown,
}

/// A field's current state as a reader sees it. `prov` is `None` exactly for
/// `Unknown` — there is no slot, so there is nothing to attribute.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FieldInfo {
    pub presence: StoredPresence,
    pub prov: Option<ProvenanceId>,
}

/// One superseded state of a field. The value is moved in, never cloned —
/// the store does not require slot types to be `Clone`.
pub struct HistoryEntry {
    pub presence: StoredPresence,
    pub value: Option<Box<dyn core::any::Any>>,
    pub prov: ProvenanceId,
}

/// The bounded value history of one field (`11` §8.6's side table).
///
/// Retention is `11` §8.6 verbatim: the most recent 16 entries, **plus** the
/// earliest entry from each distinct `Origin` discriminant, always. Anything
/// else is dropped and counted — silent truncation is how a provenance
/// feature becomes a lie.
pub struct FieldHistory {
    entries: Vec<HistoryEntry>,
    /// `Origin::discriminant()` per entry, index-aligned with `entries`.
    origins: Vec<u8>,
    truncated: u32,
}

/// `11` §8.6: "the most recent 16 entries".
const RECENT: usize = 16;

impl FieldHistory {
    pub(crate) fn new() -> FieldHistory {
        FieldHistory {
            entries: Vec::new(),
            origins: Vec::new(),
            truncated: 0,
        }
    }

    /// Oldest first.
    pub fn entries(&self) -> &[HistoryEntry] {
        &self.entries
    }

    /// `11` §8.6's `HistoryTruncated { count }` — how many entries the
    /// retention rule dropped.
    pub fn truncated(&self) -> u32 {
        self.truncated
    }

    pub(crate) fn push(&mut self, entry: HistoryEntry, origin: Origin) {
        self.entries.push(entry);
        self.origins.push(origin.discriminant());
        self.prune();
    }

    fn prune(&mut self) {
        let n = self.entries.len();
        if n <= RECENT {
            return;
        }
        let mut keep = vec![false; n];
        for k in keep.iter_mut().skip(n - RECENT) {
            *k = true;
        }
        // The earliest entry of each distinct origin discriminant, always.
        let mut seen: Vec<u8> = Vec::new();
        for (i, disc) in self.origins.iter().enumerate() {
            if !seen.contains(disc) {
                seen.push(*disc);
                keep[i] = true;
            }
        }
        let dropped = keep.iter().filter(|k| !**k).count();
        if dropped == 0 {
            return;
        }
        let mut it = keep.iter();
        self.entries.retain(|_| *it.next().expect("index-aligned"));
        let mut it = keep.iter();
        self.origins.retain(|_| *it.next().expect("index-aligned"));
        self.truncated += u32::try_from(dropped).unwrap_or(u32::MAX);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prov::ProvenanceId;
    use fathom_id::Ulid;

    fn entry(n: u128) -> (HistoryEntry, ProvenanceId) {
        let id = ProvenanceId(Ulid::from_parts(1_700_000_000_000, n).expect("48-bit"));
        (
            HistoryEntry {
                presence: StoredPresence::Set,
                value: None,
                prov: id,
            },
            id,
        )
    }

    #[test]
    fn retention_keeps_sixteen_plus_the_earliest_origin() {
        let mut h = FieldHistory::new();
        let mut ids = Vec::new();
        for n in 0..40u128 {
            let (e, id) = entry(n);
            ids.push(id);
            h.push(e, Origin::Hand);
        }
        // 16 most recent + the earliest entry of the one shipped origin.
        assert_eq!(h.entries().len(), RECENT + 1);
        assert_eq!(h.truncated(), 40 - (RECENT as u32 + 1));
        assert_eq!(h.entries()[0].prov, ids[0], "the earliest survives");
        assert_eq!(
            h.entries().last().expect("non-empty").prov,
            ids[39],
            "the newest is last"
        );
    }

    #[test]
    fn retention_is_a_no_op_below_the_bound() {
        let mut h = FieldHistory::new();
        for n in 0..RECENT as u128 {
            h.push(entry(n).0, Origin::Hand);
        }
        assert_eq!(h.entries().len(), RECENT);
        assert_eq!(h.truncated(), 0);
    }
}
