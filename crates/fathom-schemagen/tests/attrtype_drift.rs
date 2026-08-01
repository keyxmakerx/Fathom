//! Gate `schema.attrtype.drift` (62 §18.1): "§13.3's table disagrees with
//! the generated `AttrType` enum" — run as a cargo test here, because the
//! table IS mechanically extractable: 62 §13.3 carries the enum as a fenced
//! `rust` block, and the shipped `AttrType` lives in `fathom_ir::value` with
//! a machine-readable `ALL`. A drift in either direction fails this test.

use std::fs;
use std::path::Path;

#[test]
fn attr_type_matches_62_section_13_3() {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("repo root");
    let doc = fs::read_to_string(repo.join("docs/60-content/62-schema-spec.md"))
        .expect("62-schema-spec.md readable");

    let section = doc
        .split("### 13.3")
        .nth(1)
        .expect("62 §13.3 present — if renumbered, this gate moved with it");
    let fence = section
        .split("```rust")
        .nth(1)
        .expect("62 §13.3 opens with the AttrType rust fence")
        .split("```")
        .next()
        .expect("fence closes");
    assert!(
        fence.contains("enum AttrType"),
        "the first rust fence after §13.3 no longer declares AttrType"
    );

    let open = fence.find('{').expect("enum body opens");
    let close = fence.rfind('}').expect("enum body closes");
    let spec_variants: Vec<&str> = fence[open + 1..close]
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();

    let shipped: Vec<&str> = fathom_ir::value::AttrType::ALL
        .iter()
        .map(|t| t.name())
        .collect();

    assert_eq!(
        spec_variants, shipped,
        "schema.attrtype.drift: 62 §13.3's enum and fathom_ir::value::AttrType \
         disagree (order included — declaration order is data)"
    );
}
