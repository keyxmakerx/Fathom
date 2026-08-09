//! Deterministic ULID minting from caller-supplied parts (WO-09 §4.4).
//!
//! Every id in one apply shares `at`'s millisecond and takes the next value of
//! an 80-bit counter based at `entropy`. `crates/fathom-inventory/src/demo.rs`
//! is the shipped precedent. No clock, no RNG (invariant 9), and no
//! `fathom_id` constructor that reads either exists to call.
//!
//! **The counter is not entropy, and the cost is stated.** `11` §10.1 prices
//! ULID's low 80 bits as unpredictability; a counter based at one
//! host-supplied value gives that up *within* an apply — ids minted by one
//! paste are adjacent, so their ordering leaks the order the weld wrote them.
//! That is acceptable because `11` §10.1 also says **"IDs never leave the
//! workspace"**, the whole workspace is one encryptor's plaintext, and the
//! alternative — one host call per id — is exactly the nondeterminism
//! invariant 9 quarantines at the host boundary.
//!
//! `ProvenanceId`s and element ULIDs draw from the **same** counter: the
//! store's `by_ulid` uniqueness map covers nodes and edges, provenance ids
//! live in a separate map, and one namespace makes a collision
//! unrepresentable rather than merely unlikely.

use fathom_graph::Timestamp;
use fathom_id::Ulid;

/// The bits a ULID carries below its 48-bit millisecond timestamp.
const COUNTER_BITS: u32 = 80;
const COUNTER_MASK: u128 = (1u128 << COUNTER_BITS) - 1;

/// One apply's id source: a fixed millisecond and a walking 80-bit counter.
pub struct Mint {
    at: u64,
    base: u128,
    cursor: u128,
    issued: u32,
    spent: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MintError {
    /// `at` exceeds `Ulid::TIMESTAMP_MAX_MS`.
    TimestampOverflow,
    /// The 80-bit counter wrapped back to its base within one apply.
    ///
    /// Refused at the earlier of two points: the counter returning to `base`,
    /// and the counter wrapping the 80-bit space back to zero. They are the
    /// same event when `entropy`'s low 80 bits are zero, and the second is
    /// always at or before the first, so refusing at it can never let a value
    /// be issued twice. It is also the only one of the two an in-module test
    /// can reach without 2^80 calls, which is why `new` is documented as
    /// taking the base it is given rather than normalising it.
    Exhausted,
}

impl Mint {
    /// A mint fixed at `at`, walking upward from `entropy`'s low 80 bits.
    pub fn new(at: Timestamp, entropy: u128) -> Result<Mint, MintError> {
        if at.0 > Ulid::TIMESTAMP_MAX_MS {
            return Err(MintError::TimestampOverflow);
        }
        let base = entropy & COUNTER_MASK;
        Ok(Mint {
            at: at.0,
            base,
            cursor: base,
            issued: 0,
            spent: false,
        })
    }

    /// The next id. Monotonic in the counter, and therefore monotonic in the
    /// ULID's own lexicographic order until the counter wraps — at which point
    /// it refuses instead of wrapping.
    ///
    /// The name is WO-09 §4.4's, which is why the `Iterator::next` lint is
    /// allowed here rather than the method renamed: a `Mint` is not an
    /// iterator — it is fallible and it ends by refusing, not by returning
    /// `None`.
    #[allow(clippy::should_implement_trait)]
    pub fn next(&mut self) -> Result<Ulid, MintError> {
        if self.spent {
            return Err(MintError::Exhausted);
        }
        // `new` already refused an out-of-range `at`; mapping rather than
        // unwrapping keeps that fact checkable instead of asserted.
        let id =
            Ulid::from_parts(self.at, self.cursor).map_err(|_| MintError::TimestampOverflow)?;
        let advanced = self.cursor.wrapping_add(1) & COUNTER_MASK;
        if advanced == 0 || advanced == self.base {
            self.spent = true;
        }
        self.cursor = advanced;
        self.issued = self.issued.saturating_add(1);
        Ok(id)
    }

    /// How many ids this mint has issued. Reported in `WeldOutput`.
    pub fn issued(&self) -> u32 {
        self.issued
    }
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
mod tests {
    use super::*;

    /// 2026-08-08T00:00:00Z, a stored value like every other timestamp here.
    const TS: u64 = 1_786_147_200_000;

    #[test]
    fn the_counter_is_monotonic_and_shares_one_millisecond() {
        let mut mint = Mint::new(Timestamp(TS), 41).unwrap();
        let mut previous = None;
        for step in 0..64u128 {
            let id = mint.next().unwrap();
            assert_eq!(id.timestamp_ms(), TS);
            assert_eq!(id.0 & COUNTER_MASK, 41 + step);
            if let Some(before) = previous {
                assert!(id > before, "ids must ascend");
            }
            previous = Some(id);
        }
    }

    #[test]
    fn issued_counts_every_id_and_nothing_else() {
        let mut mint = Mint::new(Timestamp(TS), 0).unwrap();
        assert_eq!(mint.issued(), 0);
        for expected in 1..=10u32 {
            mint.next().unwrap();
            assert_eq!(mint.issued(), expected);
        }
    }

    #[test]
    fn a_timestamp_past_the_48_bit_bound_is_refused() {
        assert_eq!(
            Mint::new(Timestamp(Ulid::TIMESTAMP_MAX_MS + 1), 0).err(),
            Some(MintError::TimestampOverflow)
        );
        assert!(Mint::new(Timestamp(Ulid::TIMESTAMP_MAX_MS), 0).is_ok());
    }

    #[test]
    fn a_wrapped_counter_is_refused_rather_than_reissued() {
        // Based at the top of the 80-bit space: one id, then the wrap.
        let mut mint = Mint::new(Timestamp(TS), COUNTER_MASK).unwrap();
        assert_eq!(mint.next().unwrap().0 & COUNTER_MASK, COUNTER_MASK);
        assert_eq!(mint.next(), Err(MintError::Exhausted));
        assert_eq!(mint.next(), Err(MintError::Exhausted));
        assert_eq!(mint.issued(), 1);
    }

    #[test]
    fn the_base_is_the_low_eighty_bits_of_the_entropy_given() {
        let mut mint = Mint::new(Timestamp(TS), (7u128 << COUNTER_BITS) | 9).unwrap();
        assert_eq!(mint.next().unwrap().0 & COUNTER_MASK, 9);
    }
}
