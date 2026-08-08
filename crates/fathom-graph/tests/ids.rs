//! Rendered ids read back exactly, and only in one spelling (WO-05 §4.3).

use fathom_graph::{EdgeId, ElementId, IdParseError, NodeId};
use fathom_id::Ulid;
use fathom_ir::generated::ir_types::{EdgeKind, NodeKind};

fn ulid() -> Ulid {
    Ulid::from_parts(1_700_000_000_000, 7).expect("48-bit timestamp")
}

#[test]
fn display_parse_round_trips_every_kind() {
    for kind in NodeKind::ALL {
        let id = NodeId { kind, ulid: ulid() };
        let rendered = id.to_string();
        assert_eq!(NodeId::parse(&rendered), Ok(id), "{rendered}");
        assert_eq!(ElementId::parse(&rendered), Ok(ElementId::Node(id)));
        assert_eq!(
            NodeId::parse(&rendered).expect("just parsed").to_string(),
            rendered,
            "parse(s)?.to_string() == s"
        );
    }
    for kind in EdgeKind::ALL {
        let id = EdgeId { kind, ulid: ulid() };
        let rendered = id.to_string();
        assert_eq!(EdgeId::parse(&rendered), Ok(id), "{rendered}");
        assert_eq!(ElementId::parse(&rendered), Ok(ElementId::Edge(id)));
        assert_eq!(
            EdgeId::parse(&rendered).expect("just parsed").to_string(),
            rendered
        );
    }
}

#[test]
fn node_and_edge_kind_kebabs_are_disjoint() {
    // The fact that makes one rendered id namespace parseable at all.
    let nodes: Vec<String> = NodeKind::ALL
        .iter()
        .map(|k| {
            NodeId {
                kind: *k,
                ulid: ulid(),
            }
            .to_string()
        })
        .map(|s| s.split_once(':').expect("one separator").0.to_owned())
        .collect();
    for e in EdgeKind::ALL {
        let edge_kebab = EdgeId {
            kind: e,
            ulid: ulid(),
        }
        .to_string();
        let edge_kebab = edge_kebab.split_once(':').expect("one separator").0;
        assert!(
            !nodes.iter().any(|n| n == edge_kebab),
            "`{edge_kebab}` names both a node kind and an edge kind"
        );
    }
}

#[test]
fn parse_refuses_unknown_kind_bad_ulid_and_wrong_shape() {
    assert_eq!(
        NodeId::parse("no-such-kind:00000000000000000000000001"),
        Err(IdParseError::UnknownKind {
            kebab: "no-such-kind".to_owned()
        })
    );
    // An edge kebab is not a node id, and vice versa.
    assert!(matches!(
        NodeId::parse("has-device:00000000000000000000000001"),
        Err(IdParseError::UnknownKind { .. })
    ));
    assert!(matches!(
        EdgeId::parse("device:00000000000000000000000001"),
        Err(IdParseError::UnknownKind { .. })
    ));
    // `U` is outside the Crockford alphabet, aliases included.
    assert!(matches!(
        NodeId::parse("device:0000000000000000000000000U"),
        Err(IdParseError::Ulid(_))
    ));
    for bad_shape in [
        "device",
        ":00000000000000000000000001",
        "device:0000000000000000000000001",
        "device:000000000000000000000000012",
        "",
    ] {
        assert_eq!(
            NodeId::parse(bad_shape),
            Err(IdParseError::Shape),
            "{bad_shape:?}"
        );
    }
}

#[test]
fn parse_refuses_noncanonical_ulid_spelling() {
    // Both decode under Crockford's aliases (`I` -> 1, `o` -> 0) to the same
    // value as `00000000000000000000000001`, and both re-encode differently.
    for second_spelling in [
        "device:0000000000000000000000000I",
        "device:o0000000000000000000000001",
    ] {
        assert_eq!(
            NodeId::parse(second_spelling),
            Err(IdParseError::NonCanonicalUlid),
            "{second_spelling}"
        );
        assert_eq!(
            ElementId::parse(second_spelling),
            Err(IdParseError::NonCanonicalUlid)
        );
    }
    // The canonical spelling of the same value is accepted.
    assert_eq!(
        NodeId::parse("device:00000000000000000000000001"),
        Ok(NodeId {
            kind: NodeKind::Device,
            ulid: Ulid(1)
        })
    );
}
