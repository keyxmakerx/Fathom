//! Minting identifiers.
//!
//! `fathom-id` gives the shape (`Ulid`) but deliberately no constructor that
//! reads a clock or an RNG -- that boundary belongs to the WASM engine core
//! (`fathom-id`'s own doc comment: "the only two the WASM core is permitted").
//! This server is not that core, so it mints its own.

use std::io::Read;
use std::time::{SystemTime, UNIX_EPOCH};

use fathom_id::Ulid;

/// A fresh ULID: the current millisecond timestamp, and 80 bits read from
/// `/dev/urandom`.
///
/// **Why a file read and not a crate.** This task may add no external crate.
/// `/dev/urandom` is the kernel's CSPRNG exposed as a special file --
/// reading it needs nothing beyond `std::fs`, which is already linked. Fathom
/// ships only as Linux containers (`docker-compose.yml`, `deploy/compose.yaml`),
/// where the device is always present, so this is not a portability gap.
///
/// These ids are primary keys, not secrets -- their job is to never collide,
/// not to be unpredictable -- so the kernel CSPRNG is more than the job needs
/// rather than a corner cut to get it.
pub fn new_ulid() -> Ulid {
    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock is before 1970")
        .as_millis() as u64;

    // 16 bytes read, only the low 80 bits (10 bytes) of the resulting u128
    // are kept by `Ulid::from_parts` -- reading a round number of bytes is
    // simpler than reading exactly 10 and shifting.
    let mut buf = [0u8; 16];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut buf))
        .expect("/dev/urandom must be readable on the Linux hosts this server runs on");
    let random = u128::from_be_bytes(buf);

    Ulid::from_parts(timestamp_ms, random)
        .expect("a millisecond Unix timestamp fits 48 bits until the year 10889")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_calls_never_collide() {
        let a = new_ulid();
        let b = new_ulid();
        assert_ne!(a, b);
    }

    #[test]
    fn the_timestamp_component_is_now() {
        let before = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let id = new_ulid();
        let after = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        assert!(
            id.timestamp_ms() >= before,
            "{} < {before}",
            id.timestamp_ms()
        );
        assert!(
            id.timestamp_ms() <= after,
            "{} > {after}",
            id.timestamp_ms()
        );
    }

    #[test]
    fn it_round_trips_through_the_same_encoding_fathom_id_uses_everywhere_else() {
        let id = new_ulid();
        let text = id.encode();
        assert_eq!(text.len(), 26);
        assert_eq!(Ulid::decode(&text).unwrap(), id);
    }

    #[test]
    fn a_thousand_ids_are_all_distinct() {
        // Cheap collision smoke test -- 80 bits of randomness makes an actual
        // collision here astronomically unlikely; this exists to catch a
        // broken RNG path (e.g. an all-zero buffer) rather than to prove the
        // birthday bound.
        let mut seen = std::collections::HashSet::new();
        for _ in 0..1000 {
            assert!(seen.insert(new_ulid().encode()));
        }
    }
}
