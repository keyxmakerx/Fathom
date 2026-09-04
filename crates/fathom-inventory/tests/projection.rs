//! WO-08 §4.7.1's integration tests: the pinned expectations of §4.8, asserted
//! against the projections the artifact renders.
//!
//! Cells that carry a scalar's canonical form are asserted by **calling**
//! `Scalar::canonical()`, never by restating WO-01's format — a hand-typed
//! format here is how a fixture fossilises (§9 item 4).

use fathom_graph::{ElementId, Graph, NodeId};
use fathom_inventory::{
    columns, demo_estate, element_page, equipment_page, parse_display_id, rows, InvKind,
};
use fathom_ir::generated::ir_types::{NodeKind, FIELD_KEYS};
use fathom_ir::scalar::{Bandwidth, OsVersion, Scalar};

fn node(g: &Graph, display_id: &str) -> NodeId {
    match parse_display_id(g, display_id).expect("a resolvable display id") {
        ElementId::Node(n) => n,
        ElementId::Edge(e) => panic!("{e} is an edge, not a node"),
    }
}

/// The node behind the inventory row whose first cell is `first`.
fn row_node(g: &Graph, kind: InvKind, first: &str) -> NodeId {
    let r = rows(g, kind)
        .into_iter()
        .find(|r| r.cells[0] == first)
        .unwrap_or_else(|| panic!("no {} row with first cell `{first}`", kind.label()));
    node(g, &r.id)
}

fn cells(g: &Graph, kind: InvKind) -> Vec<Vec<String>> {
    rows(g, kind).into_iter().map(|r| r.cells).collect()
}

fn os() -> String {
    OsVersion("21.4R3".to_owned()).canonical()
}

fn bw(bps: u64) -> String {
    Bandwidth(bps).canonical()
}

#[test]
fn device_rows_render_the_pinned_cells() {
    let g = demo_estate();
    assert_eq!(
        columns(InvKind::Device),
        [
            "hostname",
            "platform",
            "os_version",
            "role",
            "premises",
            "name_conformance"
        ]
    );
    assert_eq!(
        cells(&g, InvKind::Device),
        vec![
            vec![
                "srx-a".to_owned(),
                "junos-srx".to_owned(),
                os(),
                "firewall".to_owned(),
                "Riverside CO".to_owned(),
                "—".to_owned(),
            ],
            vec![
                "hub-a".to_owned(),
                "junos-mx".to_owned(),
                os(),
                "router".to_owned(),
                "Midtown hut".to_owned(),
                "—".to_owned(),
            ],
        ]
    );
}

#[test]
fn physicalport_rows_resolve_the_cabled_peer() {
    let g = demo_estate();
    assert_eq!(
        columns(InvKind::PhysicalPort),
        [
            "label",
            "owner",
            "connector",
            "service",
            "speed_max",
            "cables to"
        ]
    );
    let expected: Vec<Vec<String>> = vec![
        vec![
            "0/3".to_owned(),
            "srx-a".to_owned(),
            "rj45".to_owned(),
            "ethernet".to_owned(),
            bw(1_000_000_000),
            "hub-a · 0/1/0 · RVSD-FW-01".to_owned(),
        ],
        vec![
            "fab".to_owned(),
            "srx-a".to_owned(),
            "sfp".to_owned(),
            "ethernet".to_owned(),
            "—".to_owned(),
            "itself · fab · FAB-0".to_owned(),
        ],
        vec![
            "0/3".to_owned(),
            "srx-a".to_owned(),
            "rj45".to_owned(),
            "ethernet".to_owned(),
            bw(1_000_000_000),
            "—".to_owned(),
        ],
        vec![
            "fab".to_owned(),
            "srx-a".to_owned(),
            "sfp".to_owned(),
            "ethernet".to_owned(),
            "—".to_owned(),
            "itself · fab · FAB-0".to_owned(),
        ],
        vec![
            "0/1/0".to_owned(),
            "hub-a".to_owned(),
            "sfp_plus".to_owned(),
            "ethernet".to_owned(),
            bw(10_000_000_000),
            "srx-a · 0/3 · RVSD-FW-01".to_owned(),
        ],
        vec![
            "0/1/1".to_owned(),
            "hub-a".to_owned(),
            "sfp_plus".to_owned(),
            "ethernet".to_owned(),
            bw(10_000_000_000),
            "—".to_owned(),
        ],
    ];
    assert_eq!(cells(&g, InvKind::PhysicalPort), expected);
}

#[test]
fn premises_rows_count_devices_via_atpremises() {
    let g = demo_estate();
    assert_eq!(
        columns(InvKind::Premises),
        ["label", "clli", "form", "street", "devices"]
    );
    assert_eq!(
        cells(&g, InvKind::Premises),
        vec![
            vec![
                "Riverside CO".to_owned(),
                "RVSDTX01".to_owned(),
                "central_office".to_owned(),
                "101 Riverside Dr".to_owned(),
                "1".to_owned(),
            ],
            vec![
                "Midtown hut".to_owned(),
                "MDTNTX01".to_owned(),
                "hut".to_owned(),
                "88 Frontage Rd".to_owned(),
                "1".to_owned(),
            ],
            vec![
                "Bramble Logistics HQ".to_owned(),
                // asserted Absent, never the Unknown em dash.
                "absent".to_owned(),
                "customer_premises".to_owned(),
                "1200 Commerce Pkwy".to_owned(),
                "0".to_owned(),
            ],
        ]
    );
}

/// The kinds the *demo* estate contains. It is a hand-built estate of sites,
/// devices, ports and premises; the six kinds added on 2026-08-10 are what a
/// **pasted config** builds, and the demo has none of them. Their rows are
/// asserted where that data exists — `crates/fathom-wasm/tests/paste.rs`.
const DEMO_KINDS: [InvKind; 3] = [InvKind::Device, InvKind::PhysicalPort, InvKind::Premises];

#[test]
fn opinions_cells_are_all_em_dash() {
    let g = demo_estate();
    let mut seen = 0usize;
    for kind in InvKind::ALL {
        let rs = rows(&g, kind);
        // The guard against a vacuous test, narrowed to the kinds this estate
        // actually has rather than deleted: a projection that silently returned
        // nothing would otherwise pass this test by having nothing to check.
        if DEMO_KINDS.contains(&kind) {
            assert!(
                !rs.is_empty(),
                "{} has rows in the demo estate",
                kind.label()
            );
        }
        seen += rs.len();
        for r in rs {
            assert_eq!(r.opinions, "—", "{}", kind.label());
        }
    }
    assert!(seen > 0, "the demo estate projected no rows at all");
}

/// Every kind must answer `columns` and `rows` without panicking, and the two
/// must agree on width — including on an estate that contains none of that
/// kind, where a header with the wrong column count is invisible until somebody
/// pastes the config that fills it.
#[test]
fn every_kind_projects_a_consistent_width() {
    let g = demo_estate();
    for kind in InvKind::ALL {
        let cols = columns(kind).len();
        assert!(cols > 0, "{} declares no columns", kind.label());
        for r in rows(&g, kind) {
            assert_eq!(
                r.cells.len(),
                cols,
                "{} row has {} cells against {cols} columns",
                kind.label(),
                r.cells.len()
            );
        }
    }
}

#[test]
fn equipment_page_ports_never_name_an_interface() {
    let g = demo_estate();
    let srx = row_node(&g, InvKind::Device, "srx-a");
    let page = equipment_page(&g, srx).expect("srx-a has an equipment page");
    let got: Vec<(String, String, String, String, Option<String>)> = page
        .ports
        .iter()
        .map(|p| {
            (
                p.label.clone(),
                p.chassis.clone(),
                p.connector.clone(),
                p.service.clone(),
                p.cabled.as_ref().map(|c| c.text.clone()),
            )
        })
        .collect();
    assert_eq!(
        got,
        vec![
            (
                "0/3".to_owned(),
                "0".to_owned(),
                "rj45".to_owned(),
                "ethernet".to_owned(),
                Some("hub-a · 0/1/0 · RVSD-FW-01".to_owned())
            ),
            (
                "fab".to_owned(),
                "0".to_owned(),
                "sfp".to_owned(),
                "ethernet".to_owned(),
                Some("itself · fab · FAB-0".to_owned())
            ),
            (
                "0/3".to_owned(),
                "1".to_owned(),
                "rj45".to_owned(),
                "ethernet".to_owned(),
                None
            ),
            (
                "fab".to_owned(),
                "1".to_owned(),
                "sfp".to_owned(),
                "ethernet".to_owned(),
                Some("itself · fab · FAB-0".to_owned())
            ),
        ]
    );

    // 19 §3.2: a port exists because hardware exists; an interface exists
    // because configuration exists. No configuration name may appear here.
    for p in &page.ports {
        let mut fields = vec![
            p.id.clone(),
            p.label.clone(),
            p.chassis.clone(),
            p.connector.clone(),
            p.service.clone(),
        ];
        if let Some(c) = &p.cabled {
            fields.push(c.text.clone());
            fields.push(c.far_device.clone());
        }
        for f in fields {
            for name in ["ge-0/0/3", "ge-5/0/3", "reth0", "st0"] {
                assert!(!f.contains(name), "port field `{f}` names {name}");
            }
        }
    }
}

#[test]
fn equipment_page_interfaces_join_only_through_occupies() {
    let g = demo_estate();
    let srx = row_node(&g, InvKind::Device, "srx-a");
    let page = equipment_page(&g, srx).expect("srx-a has an equipment page");
    let got: Vec<(String, &str, String)> = page
        .interfaces
        .iter()
        .map(|i| (i.name.clone(), i.kind_word, i.ports.clone()))
        .collect();
    assert_eq!(
        got,
        vec![
            (
                "ge-0/0/3".to_owned(),
                "Interface",
                "0/3 · chassis 0".to_owned()
            ),
            (
                "ge-5/0/3".to_owned(),
                "Interface",
                "0/3 · chassis 1".to_owned()
            ),
            ("reth0".to_owned(), "RethInterface", "—".to_owned()),
            ("reth0.0".to_owned(), "LogicalUnit", "—".to_owned()),
            ("st0".to_owned(), "TunnelInterface", "—".to_owned()),
            ("st0.0".to_owned(), "LogicalUnit", "—".to_owned()),
        ]
    );
}

#[test]
fn far_end_navigation_crosses_devices() {
    let g = demo_estate();
    let hub = row_node(&g, InvKind::Device, "hub-a");
    let srx = row_node(&g, InvKind::Device, "srx-a");
    let page = equipment_page(&g, hub).expect("hub-a has an equipment page");
    let p = page
        .ports
        .iter()
        .find(|p| p.label == "0/1/0")
        .expect("hub-a carries 0/1/0");
    let c = p.cabled.as_ref().expect("0/1/0 is cabled");
    assert_eq!(c.text, "srx-a · 0/3 · RVSD-FW-01");
    assert_eq!(c.far_device, srx.to_string());
}

#[test]
fn element_page_distinguishes_unset_from_asserted_absent() {
    let g = demo_estate();
    let bramble = row_node(&g, InvKind::Premises, "Bramble Logistics HQ");
    let page = element_page(&g, bramble).expect("a live node has a page");
    let prov = |name: &str| {
        page.fields
            .iter()
            .find(|f| f.name == name)
            .unwrap_or_else(|| panic!("no field `{name}`"))
            .provenance
            .clone()
    };
    assert_eq!(prov("clli"), "absent — asserted · hand · 2026-07-31");
    assert_eq!(prov("region"), "unset");
    assert_eq!(prov("label"), "hand · 2026-07-31");
}

#[test]
fn element_page_shows_the_full_id_and_declared_fields() {
    let g = demo_estate();
    let srx = row_node(&g, InvKind::Device, "srx-a");
    let page = element_page(&g, srx).expect("a live node has a page");

    // ADR-0005: `<kind-lower>:<ulid>` and no product-name prefix — `device:`
    // (7) + fathom-id's 26-character Crockford encoding = 33 characters.
    // WO-08 §3.1's `fathom:device:`/40 is corrected in §12 item 9.
    assert_eq!(page.id.len(), 33, "{}", page.id);
    assert!(page.id.starts_with("device:"), "{}", page.id);
    let (_, ulid) = page.id.rsplit_once(':').expect("one separator");
    assert_eq!(ulid.len(), 26);
    assert!(fathom_id::Ulid::decode(ulid).is_ok(), "round-trips");
    assert_eq!(page.kind_word, "Device");
    assert_eq!(page.name, "srx-a");
    assert_eq!(
        page.context.as_deref(),
        Some("site Riverside · premises Riverside CO")
    );

    let expected: Vec<&str> = NodeKind::Device
        .fields()
        .iter()
        .map(|k| {
            let (wire, _) = FIELD_KEYS
                .iter()
                .find(|(_, v)| *v == k.0)
                .expect("a registered key");
            wire.split_once('.').expect("Kind.field").1
        })
        .collect();
    let got: Vec<&str> = page.fields.iter().map(|f| f.name).collect();
    assert_eq!(got, expected);
}

#[test]
fn display_id_round_trips() {
    let g = demo_estate();
    for kind in InvKind::ALL {
        for r in rows(&g, kind) {
            let resolved = parse_display_id(&g, &r.id).expect("every row id resolves");
            assert_eq!(resolved.to_string(), r.id);
            match resolved {
                ElementId::Node(n) => {
                    assert_eq!(element_page(&g, n).expect("a page").id, r.id)
                }
                ElementId::Edge(e) => panic!("{e} is an edge"),
            }
        }
    }

    let srx = row_node(&g, InvKind::Device, "srx-a").to_string();
    let (_, ulid) = srx.rsplit_once(':').expect("one separator");
    assert!(
        parse_display_id(&g, &format!("premises:{ulid}")).is_none(),
        "a wrong kind prefix is refused"
    );
    assert!(
        parse_display_id(&g, &srx[..srx.len() - 1]).is_none(),
        "a truncated ULID is refused"
    );
}

/// **NO KIND WITH A BOUND NAME MAY RENDER AS A ULID.**
///
/// The class, pinned, after this defect shipped twice. On 2026-08-10 seven
/// security kinds showed `ikegateway:01KZ…` for a config Fathom had understood
/// perfectly; they were given arms. On 2026-08-15 the routing and VLAN kinds
/// arrived with their names bound in the graph and no arm, and three ULID blobs
/// sat on the canvas where an operator's VLANs should have been — found by an
/// adversarial pass driving the shipped artifact, not by any test here.
///
/// The rule this asserts is not "every kind has an arm". A kind that CAN have
/// many instances and whose naming nobody has decided is honestly a ULID —
/// `display_name`'s fall-through says so and that is deliberate. The rule is
/// narrower and is the one that was actually broken: **if the graph holds a
/// name for a node, the name is what the operator sees.**
#[test]
fn a_bound_name_is_never_rendered_as_a_ulid() {
    let g = demo_estate();
    let mut offenders: Vec<String> = Vec::new();

    for kind in InvKind::ALL {
        for row in rows(&g, kind) {
            let id = node(&g, &row.id);
            let page = element_page(&g, id).expect("a live node has a page");
            // The Display form is `<kind-lower>:<ulid>`; a name equal to it is
            // the fall-through arm firing.
            if page.name != id.to_string() {
                continue;
            }
            // It fell through. That is only acceptable if the node really has
            // no name to show — i.e. no field whose value is set and whose name
            // ends in `name`, `hostname`, `label`, `value` or `address`.
            let nameable = page.fields.iter().any(|f| {
                let n = f.name;
                (n.ends_with("name")
                    || n.ends_with("hostname")
                    || n.ends_with("label")
                    || n.ends_with("value")
                    || n.ends_with("address"))
                    && f.value != "—"
                    && f.value != "absent"
                    && !f.value.is_empty()
            });
            if nameable {
                let named: Vec<&str> = page
                    .fields
                    .iter()
                    .filter(|f| f.value != "—" && !f.value.is_empty())
                    .map(|f| f.name)
                    .collect();
                offenders.push(format!(
                    "{} renders as its own id while holding {named:?}",
                    id.kind.name()
                ));
            }
        }
    }

    assert!(
        offenders.is_empty(),
        "a kind whose name IS in the graph is showing the operator a ULID \
         instead — the 2026-08-10 defect, returning: {offenders:#?}"
    );
}

/// **THE RULE ABOVE, ASKED OF THE SCHEMA INSTEAD OF THE DEMO ESTATE.**
///
/// `a_bound_name_is_never_rendered_as_a_ulid` walks `InvKind::ALL` over the
/// demo estate, and the demo estate holds no `SecurityPolicy`, no `PolicySet`
/// and no `TrafficSelector` — so on 2026-09-04 it was green while a policy
/// picked from the inventory of a real paste titled its inspector
/// `security-policy:01M1…`, with `trust-to-untrust` bound on the node since
/// 2026-08-28. Rule 0: a gate tested against what its fixture happens to hold
/// is a gate tested against what the assertion needs.
///
/// This one names no kind. For EVERY kind `schema/` declares, for every field
/// of it whose bare name is `name`, `label` or `hostname`, it builds a fresh
/// graph, inserts one bare node, writes the field through the same
/// `parse_into_slot` + `set_field_boxed` path the inventory's own cell editor
/// uses, and requires the element page's name to be that field's rendered
/// value. Run against `display_name` without the schema-driven arm it failed
/// on SIXTEEN kinds (2026-09-04, `SecurityPolicy` among them); with it, the
/// only way to fail is a kind whose bound name is not shown — which is the
/// defect, exactly.
///
/// The count of fields exercised is pinned to at least the number measured
/// on schema 0.5, so the test cannot go vacuous by every field becoming
/// unauthorable or by the walk finding nothing.
#[test]
fn every_kind_whose_schema_names_it_shows_that_name() {
    use fathom_graph::{
        Actor, BatchId, Confidence, Origin, ProvenanceId, ProvenanceRecord, Timestamp, UserId,
    };
    use fathom_id::Ulid;
    use fathom_inventory::{is_authorable, parse_into_slot};

    const TS0: u64 = 1_785_456_000_000;
    let ulid = |k: u128| Ulid::from_parts(TS0, k).expect("TS0 fits 48 bits");
    let prov = |k: u128| ProvenanceRecord {
        id: ProvenanceId(ulid(9000 + k)),
        origin: Origin::Hand,
        asserted_at: Timestamp(TS0),
        asserted_by: Actor::User(UserId(ulid(1))),
        confidence: Confidence::Asserted,
        supersedes: None,
    };
    // One spelling per grammar the three field names are declared under:
    // `Identifier` and `Text` take the first, `InterfaceName` the second.
    // The first that parses is written; a field none parses is a FAILURE,
    // not a skip, because a silently skipped kind is the whole point.
    const TOKENS: [&str; 2] = ["trust-to-untrust", "ge-0/0/7"];

    let mut exercised = 0usize;
    let mut offenders: Vec<String> = Vec::new();
    let mut k_seed: u128 = 100;

    for kind in NodeKind::ALL {
        for key in kind.fields() {
            let (wire, _) = FIELD_KEYS
                .iter()
                .find(|(_, v)| *v == key.0)
                .expect("a registered key");
            let bare = wire.split_once('.').expect("Kind.field").1;
            if bare != "name" && bare != "label" && bare != "hostname" {
                continue;
            }
            assert!(
                is_authorable(*key),
                "{wire} is a name field nobody can type — widen TOKENS or the parser"
            );
            let parsed = TOKENS
                .iter()
                .find_map(|t| parse_into_slot(*key, t).ok())
                .unwrap_or_else(|| panic!("no token in TOKENS parses as {wire}"));

            let mut g = Graph::new();
            k_seed += 1;
            g.begin_batch(BatchId(ulid(k_seed)), "name test")
                .expect("a fresh batch");
            let id = g
                .insert_node(kind, ulid(k_seed + 1), prov(k_seed))
                .expect("any kind is insertable bare (11 §9.1)");
            g.set_field_boxed(ElementId::Node(id), *key, parsed, prov(k_seed + 2))
                .expect("the parsed slot matches the declared type");
            g.end_batch().expect("the batch closes");

            let page = element_page(&g, id).expect("a live node has a page");
            let rendered = page
                .fields
                .iter()
                .find(|f| f.name == bare)
                .map(|f| f.value.clone())
                .expect("the field is on its own page");
            exercised += 1;
            if page.name != rendered {
                offenders.push(format!(
                    "{wire} is bound as `{rendered}` and the page is named `{}`",
                    page.name
                ));
            }
        }
    }

    assert!(
        exercised >= 35,
        "only {exercised} name fields were exercised — schema 0.5 declares 35; \
         a walk that finds fewer is not covering the class"
    );
    assert!(
        offenders.is_empty(),
        "a kind whose name IS in the graph is showing a ULID instead: {offenders:#?}"
    );
}

/// The one kind the graph holds NOTHING to name, and the arm that says so.
///
/// A `PolicySet` is keyed on its zone pair at ingest and the pair is dropped
/// with the fragment; `PolicyScope` is a unit struct; no `PolicySet → Zone`
/// edge is declared. Its display name is therefore its id — deliberately,
/// and the arm in `display_name` records why. This pins that state so the
/// day the type grows a shape and somebody writes the arm, this test fails
/// and is rewritten to assert the pair, rather than the ULID going on
/// showing over a scope nobody noticed had become readable.
#[test]
fn a_policy_set_is_its_id_because_the_graph_holds_no_scope() {
    use fathom_graph::{
        Actor, BatchId, Confidence, Origin, ProvenanceId, ProvenanceRecord, Timestamp, UserId,
    };
    use fathom_id::Ulid;

    const TS0: u64 = 1_785_456_000_000;
    let ulid = |k: u128| Ulid::from_parts(TS0, k).expect("TS0 fits 48 bits");
    let prov = ProvenanceRecord {
        id: ProvenanceId(ulid(9001)),
        origin: Origin::Hand,
        asserted_at: Timestamp(TS0),
        asserted_by: Actor::User(UserId(ulid(1))),
        confidence: Confidence::Asserted,
        supersedes: None,
    };
    let mut g = Graph::new();
    g.begin_batch(BatchId(ulid(500)), "policy set")
        .expect("a fresh batch");
    let id = g
        .insert_node(NodeKind::PolicySet, ulid(2), prov)
        .expect("a bare policy set");
    g.end_batch().expect("the batch closes");

    let page = element_page(&g, id).expect("a page");
    assert_eq!(page.name, id.to_string());
    assert!(
        !NodeKind::PolicySet.fields().iter().any(|k| {
            let (wire, _) = FIELD_KEYS
                .iter()
                .find(|(_, v)| *v == k.0)
                .expect("registered");
            matches!(
                wire.split_once('.').map(|p| p.1),
                Some("name" | "label" | "hostname")
            )
        }),
        "PolicySet grew a name field; give display_name an arm and rewrite this test"
    );
    assert_eq!(
        core::mem::size_of::<fathom_ir::value::PolicyScope>(),
        0,
        "PolicyScope has a shape now — the zone pair is storable, and the \
         PolicySet arm in display_name should render it rather than the id"
    );
}
