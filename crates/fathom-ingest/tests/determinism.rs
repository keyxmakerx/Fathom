//! Invariant 9 at the ingest boundary: same paste + same dictionary ⇒
//! identical output, field for field and byte for byte.
//!
//! The crate holds no `HashMap`, no `HashSet`, no clock, no RNG and reads no
//! environment; every ordering is input order or an explicitly stated sort.
//! This test is what keeps that true.

use std::path::{Path, PathBuf};

use fathom_ingest::dict::Dictionary;
use fathom_ingest::ingest;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("the crate lives two levels under the repo root")
        .to_path_buf()
}

#[test]
fn ingest_twice_identical() {
    let dict = Dictionary::load(&repo_root()).expect("the shipped dictionary loads");
    let paste = std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/junos-srx-s0-synthetic.txt"),
    )
    .expect("the fixture is checked in");

    let a = ingest(&paste, &dict).expect("within the caps");
    let b = ingest(&paste, &dict).expect("within the caps");

    assert_eq!(a.capture, b.capture);
    assert_eq!(a.drops, b.drops);
    assert_eq!(a.fragment, b.fragment);
    assert_eq!(a.scope, b.scope);
    assert_eq!(a.uses_groups, b.uses_groups);
    assert_eq!(a.truncated, b.truncated);
    assert_eq!(format!("{:?}", a.ledger), format!("{:?}", b.ledger));
    assert_eq!(format!("{:?}", a.residue), format!("{:?}", b.residue));
    assert_eq!(format!("{a:?}"), format!("{b:?}"));

    // A second dictionary load must compile to the same table, or "same
    // dictionary" would not be a well-defined input.
    let dict2 = Dictionary::load(&repo_root()).expect("the shipped dictionary loads");
    let c = ingest(&paste, &dict2).expect("within the caps");
    assert_eq!(format!("{a:?}"), format!("{c:?}"));
}
