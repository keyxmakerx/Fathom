//! The estate index: search and Inventory across every design (ADR-0079
//! decisions 2 to 4).
//!
//! A design is one encrypted document and the browser holds one at a time, so
//! nothing could find a serial number across a thousand sites. This keeps, per
//! organisation, one row for each device, card, optic, power supply and spare
//! in every design, rebuilt by the server from its own copy of the design after
//! each accepted save or change ([`Scheduler`]).
//!
//! # What is stored, and what the database can learn
//!
//! A row's contents (name, model, serial, owning device, place, addresses) are
//! one canonical JSON object sealed under a key derived from the tenant key for
//! this index alone ([`IndexKeys`]). Search terms are keyed hashes of normalised
//! words and of every prefix of three characters or more ([`terms_of`]). So the
//! database never holds a name, an address or a serial in the clear; what it
//! can learn is which rows share a term, how often a term occurs, and each
//! row's kind, which is in the clear so Inventory can filter by it. ADR-0079
//! decision 3 records that as the price of not decrypting the estate on every
//! keystroke.
//!
//! # Who sees a row
//!
//! Nothing here decides it. [`search`] and [`page`] take the designs the caller
//! may read, which the route works out from the person's grants at the time of
//! the question (decision 4).
//!
//! # Not `Send`
//!
//! [`rows_of`] parses a design into a `Graph`, which is not `Send`; it is
//! synchronous and returns plain rows, and the scheduler runs it under
//! `spawn_blocking`.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use deadpool_postgres::Transaction;
use fathom_canon::Json;
use fathom_graph::snap::Snapshot;
use fathom_ir::generated::ir_types::{
    AddressField, CardField, ChassisField, DeviceField, EdgeKind, ExternalPeerField, IssueField,
    MaintenancePlanField, MountedInField, NodeKind, PhysicalPortField, PlanStepField,
    PowerSupplyField, RackField, StockItemField, StoreField,
};

use crate::crypto::{self, Key32, NONCE_LEN};
use crate::keys::DataKey;

/// The longest prefix kept as a term. A longer word is still a term whole.
const MAX_PREFIX: usize = 32;
/// The shortest prefix kept as a term (decision 3: "core" finds "core-sw-01",
/// "co" does not).
const MIN_PREFIX: usize = 3;
/// A cap on terms per row, so one long free-text field cannot cost a thousand
/// rows.
const MAX_TERMS: usize = 256;
/// Rows on one page of Inventory's Everywhere view.
pub const PAGE: i64 = 100;

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/// The two keys of one organisation's index, derived from its tenant key.
pub struct IndexKeys {
    seal: Key32,
    term: Key32,
}

impl IndexKeys {
    /// HKDF-Expand from the tenant key with this index's own label, so the
    /// index key opens nothing else and nothing else opens the index.
    pub fn derive(tenant_key: &DataKey, organisation: &str) -> Self {
        let mut info = b"fathom estate index 1|".to_vec();
        info.extend_from_slice(organisation.as_bytes());
        let root = crypto::hkdf_expand(&tenant_key.key, &info);
        Self {
            seal: crypto::hkdf_expand(&root, b"seal"),
            term: crypto::hkdf_expand(&root, b"term"),
        }
    }

    fn term_hash(&self, term: &str) -> Vec<u8> {
        crypto::mac(self.term.expose(), term.as_bytes()).to_vec()
    }
}

fn row_aad(organisation: &str, design: &str, element: &str, kind: &str) -> Vec<u8> {
    let mut aad = b"fathom estate row 1".to_vec();
    for part in [organisation, design, element, kind] {
        crypto::lp(&mut aad, part.as_bytes());
    }
    aad
}

// ---------------------------------------------------------------------------
// Rows, from a design
// ---------------------------------------------------------------------------

/// One thing in the estate.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Row {
    /// The node's id; for an optic, the port's.
    pub element: String,
    /// `device`, `card`, `optic`, `power_supply` or `spare`.
    pub kind: &'static str,
    /// What opening the row shows, as a label's link names it (ADR-0075): a device's,
    /// card's or power supply's chassis, an optic's port, a spare's store.
    pub open: String,
    pub name: String,
    pub model: String,
    pub serial: String,
    /// The device it belongs to, by name; empty for a device itself and a spare.
    pub device: String,
    /// Rack and U, or a spare's store and bin.
    pub place: String,
    /// A device's management address and interface addresses, without their
    /// prefix lengths.
    pub addresses: Vec<String>,
    /// A device's ports, so a link between sites can pick one (ADR-0079 decision 5).
    /// Not search terms: port names repeat on every device and would crowd out the rest.
    pub ports: Vec<Port>,
    /// What the Work tab shows of a plan, an issue or a spare that is out (sign-off r74).
    pub work: Option<Work>,
}

/// A piece of work, as the Work tab lists it. The status is each kind's own (r74: "nothing is
/// said twice"): a plan's stage, an issue's stage, a spare's state.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Work {
    /// Still going on: a plan planned or doing, an open issue, a spare on order, away or lent.
    pub open: bool,
    /// The kind's own status word: `planned`, `doing`, `recorded`, `open`, `closed`,
    /// `on_order`, `in_repair` or `lent`.
    pub state: String,
    /// When: a plan's window start, an issue's or a spare's due date, as typed.
    pub when: String,
    /// The account it is assigned to, by id; empty for nobody.
    pub assigned: String,
    /// The same work in an outside tool: a link or a number.
    pub ticket: String,
    /// A plan's main-line steps, and how many of them are marked.
    pub steps: i64,
    pub steps_done: i64,
    /// A plan's steps that went differently.
    pub steps_differently: i64,
    /// Comments: notes on the plan, issue or spare.
    pub comments: i64,
}

/// The term every row of open work carries, and the one every finished one does.
pub const WORK_OPEN: &str = "work:open";
pub const WORK_DONE: &str = "work:done";

/// How a Fathom number is written: `W-42`.
pub fn number_word(n: i64) -> String {
    format!("W-{n}")
}

/// One port on a device's row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Port {
    pub id: String,
    pub name: String,
    /// Where this port's cable lands when it is a link to another design: that
    /// design's id and the port's id there.
    pub far: Option<(String, String)>,
}

impl Row {
    fn to_json(&self) -> Json {
        let mut m = BTreeMap::new();
        let s = |v: &str| Json::Str(v.to_string());
        m.insert("element".into(), s(&self.element));
        m.insert("kind".into(), s(self.kind));
        m.insert("open".into(), s(&self.open));
        m.insert("name".into(), s(&self.name));
        m.insert("model".into(), s(&self.model));
        m.insert("serial".into(), s(&self.serial));
        m.insert("device".into(), s(&self.device));
        m.insert("place".into(), s(&self.place));
        m.insert(
            "addresses".into(),
            Json::Arr(self.addresses.iter().map(|a| s(a)).collect()),
        );
        if !self.ports.is_empty() {
            let ports = self
                .ports
                .iter()
                .map(|p| {
                    let mut o = BTreeMap::new();
                    o.insert("id".into(), s(&p.id));
                    o.insert("name".into(), s(&p.name));
                    if let Some((design, element)) = &p.far {
                        o.insert("farDesign".into(), s(design));
                        o.insert("farElement".into(), s(element));
                    }
                    Json::Obj(o)
                })
                .collect();
            m.insert("ports".into(), Json::Arr(ports));
        }
        if let Some(w) = &self.work {
            let mut o = BTreeMap::new();
            o.insert("open".into(), Json::Bool(w.open));
            o.insert("state".into(), s(&w.state));
            o.insert("when".into(), s(&w.when));
            o.insert("assigned".into(), s(&w.assigned));
            o.insert("ticket".into(), s(&w.ticket));
            o.insert("steps".into(), Json::Int(w.steps));
            o.insert("stepsDone".into(), Json::Int(w.steps_done));
            o.insert("stepsDifferently".into(), Json::Int(w.steps_differently));
            o.insert("comments".into(), Json::Int(w.comments));
            m.insert("work".into(), Json::Obj(o));
        }
        Json::Obj(m)
    }

    /// What a search matches on.
    fn searchable(&self) -> impl Iterator<Item = &str> {
        [
            self.name.as_str(),
            self.model.as_str(),
            self.serial.as_str(),
            self.device.as_str(),
        ]
        .into_iter()
        .chain(self.addresses.iter().map(String::as_str))
    }
}

fn text(value: &Option<Json>) -> String {
    match value {
        Some(Json::Str(s)) => s.clone(),
        Some(Json::Int(n)) => n.to_string(),
        _ => String::new(),
    }
}

/// An element's fields as the snapshot carries them.
type Fields = Vec<(fathom_ir::bag::FieldKey, Option<Json>)>;

/// Every indexed thing in one design, from its plain face.
pub fn rows_of(plain: &[u8]) -> Result<Vec<Row>, &'static str> {
    let graph = fathom_workspace::read_plain(plain).map_err(|_| "the design could not be read")?;
    let snap = graph
        .to_snapshot()
        .map_err(|_| "the design could not be read")?;
    Ok(rows_of_snapshot(&snap))
}

/// [`rows_of`] over a snapshot already in hand.
pub fn rows_of_snapshot(snap: &Snapshot) -> Vec<Row> {
    // Live nodes' fields by id, and live edges by kind.
    let mut fields: HashMap<String, (NodeKind, BTreeMap<fathom_ir::bag::FieldKey, Option<Json>>)> =
        HashMap::new();
    for node in &snap.nodes {
        if node.absent_since.is_some() {
            continue;
        }
        let map = node
            .fields
            .iter()
            .map(|f| (f.key, f.value.clone()))
            .collect();
        fields.insert(node.id.to_string(), (node.id.kind, map));
    }
    let field = |id: &str, key: fathom_ir::bag::FieldKey| -> String {
        fields
            .get(id)
            .and_then(|(_, m)| m.get(&key))
            .map(text)
            .unwrap_or_default()
    };

    // from -> [(to, edge fields)] for the edges this walks.
    let mut out_edges: HashMap<(EdgeKind, String), Vec<(String, Fields)>> = HashMap::new();
    for edge in &snap.edges {
        if edge.absent_since.is_some() {
            continue;
        }
        let (from, to) = (edge.from.to_string(), edge.to.to_string());
        if !fields.contains_key(&from) || !fields.contains_key(&to) {
            continue;
        }
        out_edges.entry((edge.id.kind, from)).or_default().push((
            to,
            edge.fields
                .iter()
                .map(|f| (f.key, f.value.clone()))
                .collect(),
        ));
    }
    let targets = |kind: EdgeKind, from: &str| -> Vec<String> {
        out_edges
            .get(&(kind, from.to_string()))
            .map(|v| v.iter().map(|(t, _)| t.clone()).collect())
            .unwrap_or_default()
    };

    // A chassis's rack and U.
    let place_of_chassis = |chassis: &str| -> String {
        let Some(mounts) = out_edges.get(&(EdgeKind::MountedIn, chassis.to_string())) else {
            return String::new();
        };
        let Some((rack, edge_fields)) = mounts.first() else {
            return String::new();
        };
        let label = field(rack, RackField::Label.key());
        let u = edge_fields
            .iter()
            .find(|(k, _)| *k == MountedInField::PositionU.key())
            .map(|(_, v)| text(v))
            .unwrap_or_default();
        match (label.is_empty(), u.is_empty()) {
            (true, _) => String::new(),
            (false, true) => label,
            (false, false) => format!("{label} U{u}"),
        }
    };

    // A port's link to another design: port -> cable -> the cable's other end, an
    // ExternalPeer that names a far design and element.
    let mut far_of_port: HashMap<String, (String, String)> = HashMap::new();
    for ((kind, _cable), ends) in &out_edges {
        if *kind != EdgeKind::Terminates {
            continue;
        }
        let peer = ends
            .iter()
            .find(|(to, _)| matches!(fields.get(to), Some((NodeKind::ExternalPeer, _))));
        let Some((peer, _)) = peer else { continue };
        let design = field(peer, ExternalPeerField::FarDesign.key());
        let element = field(peer, ExternalPeerField::FarElement.key());
        if design.is_empty() || element.is_empty() {
            continue;
        }
        for (to, _) in ends {
            if matches!(fields.get(to), Some((NodeKind::PhysicalPort, _))) {
                far_of_port.insert(to.clone(), (design.clone(), element.clone()));
            }
        }
    }

    let mut rows = Vec::new();
    let mut chassis_owner: HashMap<String, String> = HashMap::new();

    let mut ids: Vec<&String> = fields.keys().collect();
    ids.sort();

    for id in &ids {
        let (kind, _) = &fields[*id];
        if *kind != NodeKind::Device {
            continue;
        }
        let name = field(id, DeviceField::Hostname.key());
        let chassis = targets(EdgeKind::HasChassis, id);
        for c in &chassis {
            chassis_owner.insert(c.clone(), name.clone());
        }
        let first = chassis.first().cloned().unwrap_or_default();
        let mut addresses = Vec::new();
        let management = field(id, DeviceField::ManagementAddress.key());
        if !management.is_empty() {
            addresses.push(management);
        }
        for interface in targets(EdgeKind::HasInterface, id) {
            for unit in targets(EdgeKind::HasUnit, &interface) {
                for address in targets(EdgeKind::HasAddress, &unit) {
                    let value = field(&address, AddressField::Value.key());
                    let bare = value.split('/').next().unwrap_or("").to_string();
                    if !bare.is_empty() && !addresses.contains(&bare) {
                        addresses.push(bare);
                    }
                }
            }
        }
        let mut port_ids: Vec<String> = chassis
            .iter()
            .flat_map(|c| targets(EdgeKind::HasPort, c))
            .collect();
        port_ids.sort();
        port_ids.dedup();
        let ports = port_ids
            .into_iter()
            .map(|port| Port {
                name: field(&port, PhysicalPortField::Label.key()),
                far: far_of_port.get(&port).cloned(),
                id: port,
            })
            .collect();
        rows.push(Row {
            element: (*id).clone(),
            kind: "device",
            open: if first.is_empty() {
                (*id).clone()
            } else {
                first.clone()
            },
            name,
            model: chassis
                .iter()
                .map(|c| field(c, ChassisField::Model.key()))
                .find(|m| !m.is_empty())
                .unwrap_or_default(),
            serial: chassis
                .iter()
                .map(|c| field(c, ChassisField::Serial.key()))
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(" "),
            device: String::new(),
            place: if first.is_empty() {
                String::new()
            } else {
                place_of_chassis(&first)
            },
            addresses,
            ports,
            work: None,
        });
    }

    // Cards, at any depth under a chassis; power supplies; optics in ports.
    for id in &ids {
        let (kind, _) = &fields[*id];
        if *kind != NodeKind::Chassis {
            continue;
        }
        let device = chassis_owner.get(*id).cloned().unwrap_or_default();
        let place = place_of_chassis(id);
        let mut stack = targets(EdgeKind::HasCard, id);
        let mut seen = BTreeSet::new();
        while let Some(card) = stack.pop() {
            if !seen.insert(card.clone()) {
                continue;
            }
            stack.extend(targets(EdgeKind::HasCard, &card));
            let slot = field(&card, CardField::Slot.key());
            let mut name = field(&card, CardField::Name.key());
            if name.is_empty() {
                name = slot.clone();
            }
            rows.push(Row {
                element: card.clone(),
                kind: "card",
                open: (*id).clone(),
                name,
                model: field(&card, CardField::Model.key()),
                serial: field(&card, CardField::Serial.key()),
                device: device.clone(),
                place: place.clone(),
                addresses: Vec::new(),
                ports: Vec::new(),
                work: None,
            });
        }
        let mut ports = targets(EdgeKind::HasPort, id);
        for psu in targets(EdgeKind::FittedIn, id) {
            ports.extend(targets(EdgeKind::HasPort, &psu));
            rows.push(Row {
                element: psu.clone(),
                kind: "power_supply",
                open: (*id).clone(),
                name: field(&psu, PowerSupplyField::Slot.key()),
                model: field(&psu, PowerSupplyField::Model.key()),
                serial: field(&psu, PowerSupplyField::Serial.key()),
                device: device.clone(),
                place: place.clone(),
                addresses: Vec::new(),
                ports: Vec::new(),
                work: None,
            });
        }
        ports.sort();
        for port in ports {
            let optic = fields
                .get(&port)
                .and_then(|(_, m)| m.get(&PhysicalPortField::Transceiver.key()))
                .cloned()
                .flatten();
            let Some(Json::Obj(t)) = optic else { continue };
            let get = |k: &str| match t.get(k) {
                Some(Json::Str(s)) => s.clone(),
                _ => String::new(),
            };
            rows.push(Row {
                element: port.clone(),
                kind: "optic",
                open: port.clone(),
                name: field(&port, PhysicalPortField::Label.key()),
                model: [get("vendor"), get("part"), get("type")]
                    .into_iter()
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
                    .join(" "),
                serial: get("serial"),
                device: device.clone(),
                place: place.clone(),
                addresses: Vec::new(),
                ports: Vec::new(),
                work: None,
            });
        }
    }

    for id in &ids {
        let (kind, _) = &fields[*id];
        if *kind != NodeKind::StockItem {
            continue;
        }
        let store_id = targets(EdgeKind::InStore, id).first().cloned();
        let store = store_id
            .as_ref()
            .map(|s| field(s, StoreField::Name.key()))
            .unwrap_or_default();
        let bin = field(id, StockItemField::Bin.key());
        let mut name = field(id, StockItemField::Name.key());
        if name.is_empty() {
            name = field(id, StockItemField::Part.key());
        }
        let state = field(id, StockItemField::State.key());
        let out = matches!(state.as_str(), "on_order" | "in_repair" | "lent");
        let work = out.then(|| Work {
            open: true,
            state: state.clone(),
            when: field(id, StockItemField::Due.key()),
            assigned: field(id, StockItemField::AssignedTo.key()),
            ticket: field(id, StockItemField::Ticket.key()),
            comments: targets(EdgeKind::HasNote, id).len() as i64,
            ..Work::default()
        });
        rows.push(Row {
            element: (*id).clone(),
            kind: "spare",
            open: store_id.unwrap_or_else(|| (*id).clone()),
            name,
            model: field(id, StockItemField::Model.key()),
            serial: field(id, StockItemField::Serial.key()),
            device: String::new(),
            place: [store, bin]
                .into_iter()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(", "),
            addresses: Vec::new(),
            ports: Vec::new(),
            work,
        });
    }

    // Maintenance plans and "It's down" issues (sign-off r74): the Work tab's own rows.
    let hostname_of = |device: &str| field(device, DeviceField::Hostname.key());
    let place_of_device = |device: &str| {
        targets(EdgeKind::HasChassis, device)
            .first()
            .map(|c| place_of_chassis(c))
            .unwrap_or_default()
    };
    for id in &ids {
        let (kind, _) = &fields[*id];
        match kind {
            NodeKind::MaintenancePlan => {
                let stage = field(id, MaintenancePlanField::Stage.key());
                let mut steps = 0;
                let mut done = 0;
                let mut differently = 0;
                for step in targets(EdgeKind::HasStep, id) {
                    // A step on an If path is not on the line of work until it is taken.
                    if !field(&step, PlanStepField::BranchOf.key()).is_empty() {
                        continue;
                    }
                    steps += 1;
                    match field(&step, PlanStepField::State.key()).as_str() {
                        "done" => done += 1,
                        "went_differently" => {
                            done += 1;
                            differently += 1;
                        }
                        _ => {}
                    }
                }
                rows.push(Row {
                    element: (*id).clone(),
                    kind: "plan",
                    open: (*id).clone(),
                    name: field(id, MaintenancePlanField::Title.key()),
                    model: String::new(),
                    serial: String::new(),
                    device: String::new(),
                    place: String::new(),
                    addresses: Vec::new(),
                    ports: Vec::new(),
                    work: Some(Work {
                        open: stage != "recorded",
                        state: stage,
                        when: field(id, MaintenancePlanField::WindowStart.key()),
                        assigned: field(id, MaintenancePlanField::AssignedTo.key()),
                        ticket: field(id, MaintenancePlanField::Ticket.key()),
                        steps,
                        steps_done: done,
                        steps_differently: differently,
                        comments: targets(EdgeKind::HasNote, id).len() as i64,
                    }),
                });
            }
            NodeKind::Issue => {
                let stage = field(id, IssueField::Stage.key());
                let device = field(id, IssueField::Device.key());
                rows.push(Row {
                    element: (*id).clone(),
                    kind: "issue",
                    open: (*id).clone(),
                    name: field(id, IssueField::Title.key()),
                    model: String::new(),
                    serial: String::new(),
                    device: hostname_of(&device),
                    place: place_of_device(&device),
                    addresses: Vec::new(),
                    ports: Vec::new(),
                    work: Some(Work {
                        open: stage != "closed",
                        state: stage,
                        when: field(id, IssueField::Due.key()),
                        assigned: field(id, IssueField::AssignedTo.key()),
                        ticket: field(id, IssueField::Ticket.key()),
                        comments: targets(EdgeKind::HasNote, id).len() as i64,
                        ..Work::default()
                    }),
                });
            }
            _ => {}
        }
    }
    rows
}

// ---------------------------------------------------------------------------
// Terms
// ---------------------------------------------------------------------------

/// Lowercased words of a value, split on whitespace, `,` and `/`.
fn words(value: &str) -> impl Iterator<Item = String> + '_ {
    value
        .split(|c: char| c.is_whitespace() || c == ',' || c == '/')
        .filter(|w| !w.is_empty())
        .map(|w| w.to_lowercase())
}

/// Every term a row is found by: each word whole, and each prefix of
/// [`MIN_PREFIX`] to [`MAX_PREFIX`] characters.
pub fn terms_of(row: &Row) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    out.insert(format!("kind:{}", row.kind));
    if let Some(work) = &row.work {
        out.insert(if work.open { WORK_OPEN } else { WORK_DONE }.to_string());
    }
    for value in row.searchable() {
        for word in words(value) {
            let chars: Vec<char> = word.chars().collect();
            for n in MIN_PREFIX..=chars.len().min(MAX_PREFIX) {
                out.insert(chars[..n].iter().collect());
            }
            out.insert(word);
            if out.len() >= MAX_TERMS {
                return out;
            }
        }
    }
    out
}

/// The terms that lead from a port to its device's row, so a link between sites opens only
/// the devices holding the ports it asks about (sign-off r61), not every device in each design.
/// Kept apart from [`terms_of`] so a device with many ports never crowds out its search words.
/// A search that types one finds only a row it could already read.
fn port_terms(row: &Row) -> impl Iterator<Item = String> + '_ {
    let marker = (!row.ports.is_empty()).then(|| PORTS_INDEXED.to_string());
    row.ports
        .iter()
        .map(|p| format!("port:{}", p.id))
        .chain(marker)
}

/// Carried by every device row indexed with [`port_terms`]: a design with none was indexed
/// before them, and [`devices_holding`] reads its devices whole until its next rebuild.
const PORTS_INDEXED: &str = "ports:indexed";

/// The terms a query asks for: each word, cut to [`MAX_PREFIX`] characters so a
/// long word still matches its longest stored prefix.
pub fn query_terms(query: &str) -> Vec<String> {
    let mut out: Vec<String> = words(query)
        .map(|w| w.chars().take(MAX_PREFIX).collect())
        .collect();
    out.sort();
    out.dedup();
    out
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/// Replace one design's rows with `rows`, built at `version`. In the caller's
/// tenant transaction.
pub async fn replace_design(
    tx: &Transaction<'_>,
    keys: &IndexKeys,
    organisation: &str,
    design: &str,
    version: i64,
    rows: &[Row],
) -> Result<(), String> {
    let db = |e: tokio_postgres::Error| e.to_string();
    tx.execute(
        "DELETE FROM estate_rows WHERE organisation_id = $1 AND design_id = $2",
        &[&organisation, &design],
    )
    .await
    .map_err(db)?;
    let work: Vec<&str> = rows
        .iter()
        .filter(|r| r.work.is_some())
        .map(|r| r.element.as_str())
        .collect();
    let numbers = give_numbers(tx, organisation, design, &work).await?;
    let mut elements = Vec::with_capacity(rows.len());
    let mut kinds = Vec::with_capacity(rows.len());
    let mut sealed = Vec::with_capacity(rows.len());
    let mut nonces = Vec::with_capacity(rows.len());
    let mut term_hashes: Vec<Vec<u8>> = Vec::new();
    let mut term_elements: Vec<String> = Vec::new();
    for row in rows {
        let nonce = crypto::random_nonce().map_err(|e| format!("{e:?}"))?;
        let aad = row_aad(organisation, design, &row.element, row.kind);
        let number = numbers.get(&row.element).copied();
        let mut json = row.to_json();
        if let (Some(n), Json::Obj(m)) = (number, &mut json) {
            m.insert("number".into(), Json::Int(n));
        }
        let body = crypto::seal(&keys.seal, &nonce, &json.to_canonical_bytes(), &aad)
            .map_err(|e| format!("{e:?}"))?;
        elements.push(row.element.clone());
        kinds.push(row.kind.to_string());
        sealed.push(body);
        nonces.push(nonce.to_vec());
        let number_term = number.map(|n| number_word(n).to_lowercase());
        for term in terms_of(row)
            .into_iter()
            .chain(port_terms(row))
            .chain(number_term)
        {
            term_hashes.push(keys.term_hash(&term));
            term_elements.push(row.element.clone());
        }
    }
    tx.execute(
        "INSERT INTO estate_rows \
             (organisation_id, design_id, element_id, kind, design_version, sealed, nonce) \
         SELECT $1, $2, e, k, $3, s, n \
         FROM unnest($4::text[], $5::text[], $6::bytea[], $7::bytea[]) AS t(e, k, s, n)",
        &[
            &organisation,
            &design,
            &version,
            &elements,
            &kinds,
            &sealed,
            &nonces,
        ],
    )
    .await
    .map_err(db)?;
    tx.execute(
        "INSERT INTO estate_terms (organisation_id, term, design_id, element_id) \
         SELECT DISTINCT $1, t, $2, e FROM unnest($3::bytea[], $4::text[]) AS u(t, e)",
        &[&organisation, &design, &term_hashes, &term_elements],
    )
    .await
    .map_err(db)?;
    tx.execute(
        "INSERT INTO estate_built (organisation_id, design_id, design_version) \
         VALUES ($1, $2, $3) \
         ON CONFLICT (organisation_id, design_id) DO UPDATE SET design_version = $3",
        &[&organisation, &design, &version],
    )
    .await
    .map_err(db)?;
    Ok(())
}

/// The Fathom number of each of `elements` in `design`, giving the next numbers in the
/// organisation to any that has none yet (sign-off r74). A number is given once and kept: it
/// outlives the index rows, which are replaced whole, and goes only with its design. In the
/// caller's tenant transaction; the advisory lock keeps two rebuilds in one organisation from
/// reading the same highest number, and the unique key would refuse it if they did.
pub async fn give_numbers(
    tx: &Transaction<'_>,
    organisation: &str,
    design: &str,
    elements: &[&str],
) -> Result<BTreeMap<String, i64>, String> {
    let db = |e: tokio_postgres::Error| e.to_string();
    let mut out = numbers_in(tx, organisation, design).await?;
    let missing: Vec<&str> = elements
        .iter()
        .copied()
        .filter(|e| !out.contains_key(*e))
        .collect();
    if missing.is_empty() {
        return Ok(out);
    }
    tx.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended('fathom work numbers|' || $1, 0))",
        &[&organisation],
    )
    .await
    .map_err(db)?;
    let top: i64 = tx
        .query_one(
            "SELECT coalesce(max(number), 0) FROM work_numbers WHERE organisation_id = $1",
            &[&organisation],
        )
        .await
        .map_err(db)?
        .get(0);
    let mut sorted = missing;
    sorted.sort();
    for (i, element) in sorted.into_iter().enumerate() {
        let number = top + 1 + i as i64;
        tx.execute(
            "INSERT INTO work_numbers (organisation_id, design_id, element_id, number) \
             VALUES ($1, $2, $3, $4)",
            &[&organisation, &design, &element, &number],
        )
        .await
        .map_err(db)?;
        out.insert(element.to_string(), number);
    }
    Ok(out)
}

/// Every Fathom number given in `design`, by element.
pub async fn numbers_in(
    tx: &Transaction<'_>,
    organisation: &str,
    design: &str,
) -> Result<BTreeMap<String, i64>, String> {
    let rows = tx
        .query(
            "SELECT element_id, number FROM work_numbers \
             WHERE organisation_id = $1 AND design_id = $2",
            &[&organisation, &design],
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows.iter().map(|r| (r.get(0), r.get(1))).collect())
}

/// Open work (or finished work, with `done`) in `designs`, at most `limit`, newest numbers
/// first: the Work tab (sign-off r74).
pub async fn work(
    tx: &Transaction<'_>,
    keys: &IndexKeys,
    organisation: &str,
    designs: &[String],
    done: bool,
    limit: i64,
) -> Result<Vec<Hit>, String> {
    if designs.is_empty() {
        return Ok(Vec::new());
    }
    let term = keys.term_hash(if done { WORK_DONE } else { WORK_OPEN });
    let rows = tx
        .query(
            "SELECT t.design_id, t.element_id FROM estate_terms t \
             LEFT JOIN work_numbers n ON n.organisation_id = t.organisation_id \
                  AND n.design_id = t.design_id AND n.element_id = t.element_id \
             WHERE t.organisation_id = $1 AND t.term = $2 AND t.design_id = ANY($3) \
             ORDER BY n.number DESC NULLS LAST, t.design_id, t.element_id \
             LIMIT $4",
            &[&organisation, &term, &designs, &limit.clamp(1, 1000)],
        )
        .await
        .map_err(|e| e.to_string())?;
    let pairs: Vec<(String, String)> = rows.iter().map(|r| (r.get(0), r.get(1))).collect();
    open_rows(tx, keys, organisation, &pairs).await
}

/// One result, opened.
#[derive(Clone, Debug)]
pub struct Hit {
    pub design: String,
    pub row: Json,
}

async fn open_rows(
    tx: &Transaction<'_>,
    keys: &IndexKeys,
    organisation: &str,
    pairs: &[(String, String)],
) -> Result<Vec<Hit>, String> {
    if pairs.is_empty() {
        return Ok(Vec::new());
    }
    let designs: Vec<&str> = pairs.iter().map(|(d, _)| d.as_str()).collect();
    let elements: Vec<&str> = pairs.iter().map(|(_, e)| e.as_str()).collect();
    let rows = tx
        .query(
            "SELECT r.design_id, r.element_id, r.kind, r.sealed, r.nonce \
             FROM unnest($2::text[], $3::text[]) WITH ORDINALITY AS p(d, e, i) \
             JOIN estate_rows r ON r.organisation_id = $1 AND r.design_id = p.d \
                               AND r.element_id = p.e \
             ORDER BY p.i",
            &[&organisation, &designs, &elements],
        )
        .await
        .map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let design: String = row.get(0);
        let element: String = row.get(1);
        let kind: String = row.get(2);
        let sealed: Vec<u8> = row.get(3);
        let nonce: Vec<u8> = row.get(4);
        let Ok(nonce) = <[u8; NONCE_LEN]>::try_from(nonce.as_slice()) else {
            continue;
        };
        let aad = row_aad(organisation, &design, &element, &kind);
        // A row that does not open was written under a key this server no longer
        // derives; it is skipped and rebuilt on the design's next save.
        let Ok(plain) = crypto::open(&keys.seal, &nonce, &sealed, &aad) else {
            continue;
        };
        let Ok(json) = Json::parse_canonical(&plain) else {
            continue;
        };
        out.push(Hit { design, row: json });
    }
    Ok(out)
}

/// Things matching every word of `query`, in the `designs` given, at most
/// `limit`, ordered by design and then element.
pub async fn search(
    tx: &Transaction<'_>,
    keys: &IndexKeys,
    organisation: &str,
    designs: &[String],
    query: &str,
    kind: Option<&str>,
    limit: i64,
) -> Result<Vec<Hit>, String> {
    let mut terms = query_terms(query);
    if let Some(kind) = kind {
        terms.push(format!("kind:{kind}"));
    }
    if terms.is_empty() || designs.is_empty() {
        return Ok(Vec::new());
    }
    let hashes: Vec<Vec<u8>> = terms.iter().map(|t| keys.term_hash(t)).collect();
    let rows = tx
        .query(
            "SELECT design_id, element_id FROM estate_terms \
             WHERE organisation_id = $1 AND term = ANY($2) AND design_id = ANY($3) \
             GROUP BY design_id, element_id \
             HAVING count(*) = $4 \
             ORDER BY design_id, element_id \
             LIMIT $5",
            &[
                &organisation,
                &hashes,
                &designs,
                &(hashes.len() as i64),
                &limit.clamp(1, 500),
            ],
        )
        .await
        .map_err(|e| e.to_string())?;
    let pairs: Vec<(String, String)> = rows.iter().map(|r| (r.get(0), r.get(1))).collect();
    open_rows(tx, keys, organisation, &pairs).await
}

/// One page of the Everywhere view: every indexed thing in `designs`, of
/// `kind` when given, after `after` (a design id and element id), in order.
pub async fn page(
    tx: &Transaction<'_>,
    keys: &IndexKeys,
    organisation: &str,
    designs: &[String],
    kind: Option<&str>,
    after: Option<(&str, &str)>,
    limit: i64,
) -> Result<Vec<Hit>, String> {
    if designs.is_empty() {
        return Ok(Vec::new());
    }
    let (after_design, after_element) = after.unwrap_or(("", ""));
    let rows = tx
        .query(
            "SELECT design_id, element_id FROM estate_rows \
             WHERE organisation_id = $1 AND design_id = ANY($2) \
               AND ($3::text IS NULL OR kind = $3) \
               AND (design_id, element_id) > ($4, $5) \
             ORDER BY design_id, element_id \
             LIMIT $6",
            &[
                &organisation,
                &designs,
                &kind,
                &after_design,
                &after_element,
                &limit.clamp(1, 500),
            ],
        )
        .await
        .map_err(|e| e.to_string())?;
    let pairs: Vec<(String, String)> = rows.iter().map(|r| (r.get(0), r.get(1))).collect();
    open_rows(tx, keys, organisation, &pairs).await
}

/// Every drawn address in the organisation's designs, as the index holds them (a device's
/// management and interface addresses, without their prefix lengths): what the IP plan
/// store's next free skips (ADR-0083 decision 4). Server-side only; nothing here is answered
/// to a person, so it reads every design, not just the ones the caller may open.
pub async fn all_addresses(
    tx: &Transaction<'_>,
    keys: &IndexKeys,
    organisation: &str,
) -> Result<Vec<String>, String> {
    let rows = tx
        .query(
            "SELECT design_id, element_id FROM estate_rows \
             WHERE organisation_id = $1 AND kind = 'device'",
            &[&organisation],
        )
        .await
        .map_err(|e| e.to_string())?;
    let pairs: Vec<(String, String)> = rows.iter().map(|r| (r.get(0), r.get(1))).collect();
    let mut out = Vec::new();
    for hit in open_rows(tx, keys, organisation, &pairs).await? {
        if let Json::Obj(m) = hit.row {
            if let Some(Json::Arr(addresses)) = m.get("addresses") {
                out.extend(addresses.iter().filter_map(|a| match a {
                    Json::Str(s) => Some(s.clone()),
                    _ => None,
                }));
            }
        }
    }
    Ok(out)
}

/// The device rows holding the far ports `ends` (design, port) name, opened: what a link
/// between sites reads to find its far port and whether that port links back (ADR-0079
/// decision 5). Found through [`port_terms`], so one request opens at most the devices it
/// asks about. A design indexed before port terms is read whole, as before, until its next
/// rebuild.
pub async fn devices_holding(
    tx: &Transaction<'_>,
    keys: &IndexKeys,
    organisation: &str,
    ends: &[(String, String)],
) -> Result<Vec<Hit>, String> {
    if ends.is_empty() {
        return Ok(Vec::new());
    }
    let mut designs: Vec<String> = ends.iter().map(|(d, _)| d.clone()).collect();
    designs.sort();
    designs.dedup();
    let mut hashes: Vec<Vec<u8>> = ends
        .iter()
        .map(|(_, port)| keys.term_hash(&format!("port:{port}")))
        .collect();
    let marker = keys.term_hash(PORTS_INDEXED);
    hashes.push(marker.clone());
    let rows = tx
        .query(
            "SELECT DISTINCT design_id, element_id, term = $4 FROM estate_terms \
             WHERE organisation_id = $1 AND term = ANY($2) AND design_id = ANY($3) \
             ORDER BY design_id, element_id",
            &[&organisation, &hashes, &designs, &marker],
        )
        .await
        .map_err(|e| e.to_string())?;
    let mut pairs: Vec<(String, String)> = Vec::new();
    let mut indexed: BTreeSet<String> = BTreeSet::new();
    for row in &rows {
        let (design, element, is_marker): (String, String, bool) =
            (row.get(0), row.get(1), row.get(2));
        if is_marker {
            indexed.insert(design);
        } else {
            pairs.push((design, element));
        }
    }
    pairs.sort();
    pairs.dedup();
    let older: Vec<String> = designs
        .into_iter()
        .filter(|d| !indexed.contains(d))
        .collect();
    let mut out = open_rows(tx, keys, organisation, &pairs).await?;
    out.extend(devices_in(tx, keys, organisation, &older).await?);
    Ok(out)
}

/// Every device row in `designs`, opened: a design's whole list, for one indexed before
/// [`port_terms`].
async fn devices_in(
    tx: &Transaction<'_>,
    keys: &IndexKeys,
    organisation: &str,
    designs: &[String],
) -> Result<Vec<Hit>, String> {
    if designs.is_empty() {
        return Ok(Vec::new());
    }
    let rows = tx
        .query(
            "SELECT design_id, element_id FROM estate_rows \
             WHERE organisation_id = $1 AND design_id = ANY($2) AND kind = 'device' \
             ORDER BY design_id, element_id",
            &[&organisation, &designs],
        )
        .await
        .map_err(|e| e.to_string())?;
    let pairs: Vec<(String, String)> = rows.iter().map(|r| (r.get(0), r.get(1))).collect();
    open_rows(tx, keys, organisation, &pairs).await
}

/// The version each of `designs` was last indexed at.
pub async fn built_versions(
    tx: &Transaction<'_>,
    organisation: &str,
    designs: &[String],
) -> Result<HashMap<String, i64>, String> {
    let rows = tx
        .query(
            "SELECT design_id, design_version FROM estate_built \
             WHERE organisation_id = $1 AND design_id = ANY($2)",
            &[&organisation, &designs],
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows.iter().map(|r| (r.get(0), r.get(1))).collect())
}

// ---------------------------------------------------------------------------
// When to rebuild
// ---------------------------------------------------------------------------

/// How long a design must be quiet before its rows are rebuilt, so a burst of
/// live changes costs one rebuild.
pub const QUIET: Duration = Duration::from_secs(5);

/// Which designs are waiting to be rebuilt. A design asked for again while it
/// waits is not queued twice; the rebuild reads the design as it is when it
/// runs, so it always catches up to the newest version.
#[derive(Clone, Default)]
pub struct Scheduler {
    waiting: Arc<Mutex<BTreeSet<String>>>,
}

impl Scheduler {
    /// Mark `design` as waiting. `true` when the caller should start the
    /// rebuild (it was not already waiting).
    pub fn claim(&self, design: &str) -> bool {
        self.waiting
            .lock()
            .map(|mut w| w.insert(design.to_string()))
            .unwrap_or(false)
    }

    /// The rebuild is about to read the design: anything later queues again.
    pub fn release(&self, design: &str) {
        if let Ok(mut w) = self.waiting.lock() {
            w.remove(design);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row() -> Row {
        Row {
            element: "e1".into(),
            kind: "device",
            open: "e1".into(),
            name: "core-sw-01".into(),
            model: "EX4300-48T".into(),
            serial: "PE3714AF0123".into(),
            device: String::new(),
            place: "A-01 U12".into(),
            addresses: vec!["10.20.0.1".into()],
            ports: Vec::new(),
            work: None,
        }
    }

    #[test]
    fn a_device_with_ports_is_found_by_each_port_and_says_it_was_indexed_so() {
        let mut r = row();
        let none: Vec<String> = port_terms(&r).collect();
        assert!(none.is_empty(), "no ports, no port terms: {none:?}");
        r.ports = vec![Port {
            id: "physical-port:p1".into(),
            name: "xe-0/0/1".into(),
            far: None,
        }];
        let terms: Vec<String> = port_terms(&r).collect();
        assert_eq!(terms, ["port:physical-port:p1", PORTS_INDEXED]);
        assert!(
            terms.iter().all(|t| !terms_of(&r).contains(t)),
            "port terms stay out of the search words"
        );
    }

    #[test]
    fn a_row_is_found_by_whole_words_and_prefixes_of_three_or_more() {
        let t = terms_of(&row());
        for found in [
            "core-sw-01",
            "cor",
            "core",
            "core-sw",
            "ex4300-48t",
            "ex4",
            "pe3714af0123",
            "10.20.0.1",
            "10.",
            "kind:device",
        ] {
            assert!(t.contains(found), "{found} missing from {t:?}");
        }
        for not in ["co", "sw-01", "48t", "a-01"] {
            assert!(!t.contains(not), "{not} should not be a term");
        }
    }

    #[test]
    fn a_query_is_lowercased_split_and_cut_to_the_longest_prefix() {
        assert_eq!(
            query_terms("  Core-SW  10.20.0.1 core-sw "),
            vec!["10.20.0.1", "core-sw"]
        );
        let long = "x".repeat(40);
        assert_eq!(query_terms(&long), vec!["x".repeat(MAX_PREFIX)]);
    }

    #[test]
    fn the_keys_differ_by_organisation_and_from_each_other() {
        let tenant = DataKey {
            key: Key32::from_bytes([7; 32]),
            epoch: 1,
            id: Key32::from_bytes([7; 32]).id(),
        };
        let a = IndexKeys::derive(&tenant, "org-a");
        let b = IndexKeys::derive(&tenant, "org-b");
        assert_ne!(a.term_hash("core"), b.term_hash("core"));
        assert_ne!(a.seal.expose(), a.term.expose());
    }

    #[test]
    fn the_scheduler_queues_a_design_once_until_released() {
        let s = Scheduler::default();
        assert!(s.claim("d1"));
        assert!(!s.claim("d1"));
        s.release("d1");
        assert!(s.claim("d1"));
    }

    fn prov(seed: u128) -> fathom_graph::ProvenanceRecord {
        use fathom_graph::{
            Actor, Confidence, Origin, ProvenanceId, ProvenanceRecord, Timestamp, UserId,
        };
        ProvenanceRecord {
            id: ProvenanceId(fathom_id::Ulid(seed * 10 + 2)),
            origin: Origin::Hand,
            asserted_at: Timestamp(0),
            asserted_by: Actor::User(UserId(fathom_id::Ulid(seed * 10 + 3))),
            confidence: Confidence::Asserted,
            supersedes: None,
        }
    }

    #[test]
    fn a_design_gives_its_device_card_power_supply_and_optic() {
        use fathom_graph::{BatchId, Graph};
        use fathom_id::Ulid;
        use fathom_ir::{scalar, value};
        let mut g = Graph::new();
        g.begin_batch(BatchId(Ulid(1)), "estate fixture").unwrap();
        let p = prov(1);
        let device = g
            .insert_node(NodeKind::Device, Ulid(10), p.clone())
            .unwrap();
        g.set_field(
            device.into(),
            DeviceField::Hostname.key(),
            scalar::Identifier("core-sw-01".into()),
            p.clone(),
        )
        .unwrap();
        let chassis = g
            .insert_node(NodeKind::Chassis, Ulid(11), p.clone())
            .unwrap();
        g.set_field(
            chassis.into(),
            ChassisField::Model.key(),
            scalar::Identifier("EX4300-48T".into()),
            p.clone(),
        )
        .unwrap();
        g.set_field(
            chassis.into(),
            ChassisField::Serial.key(),
            scalar::Identifier("PE3714AF0123".into()),
            p.clone(),
        )
        .unwrap();
        g.insert_edge(EdgeKind::HasChassis, Ulid(12), device, chassis, p.clone())
            .unwrap();
        let card = g.insert_node(NodeKind::Card, Ulid(13), p.clone()).unwrap();
        g.set_field(
            card.into(),
            CardField::Model.key(),
            scalar::Identifier("EX-UM-4X4SFP".into()),
            p.clone(),
        )
        .unwrap();
        g.insert_edge(EdgeKind::HasCard, Ulid(14), chassis, card, p.clone())
            .unwrap();
        let psu = g
            .insert_node(NodeKind::PowerSupply, Ulid(15), p.clone())
            .unwrap();
        g.set_field(
            psu.into(),
            PowerSupplyField::Slot.key(),
            scalar::Text("PSU 0".into()),
            p.clone(),
        )
        .unwrap();
        g.insert_edge(EdgeKind::FittedIn, Ulid(16), chassis, psu, p.clone())
            .unwrap();
        let port = g
            .insert_node(NodeKind::PhysicalPort, Ulid(17), p.clone())
            .unwrap();
        g.set_field(
            port.into(),
            PhysicalPortField::Label.key(),
            scalar::Text("xe-0/2/0".into()),
            p.clone(),
        )
        .unwrap();
        g.set_field(
            port.into(),
            PhysicalPortField::Transceiver.key(),
            value::Transceiver {
                r#type: Some(scalar::Text("10GBASE-LR".into())),
                vendor: Some(scalar::Text("Juniper".into())),
                part: Some(scalar::Identifier("EX-SFP-10GE-LR".into())),
                serial: Some(scalar::Identifier("ABC123".into())),
                wavelength_nm: None,
            },
            p.clone(),
        )
        .unwrap();
        g.insert_edge(EdgeKind::HasPort, Ulid(18), chassis, port, p.clone())
            .unwrap();
        // A link to another site: the port's cable ends on an ExternalPeer naming the
        // far design and port.
        let peer = g
            .insert_node(NodeKind::ExternalPeer, Ulid(19), p.clone())
            .unwrap();
        g.set_field(
            peer.into(),
            ExternalPeerField::Label.key(),
            scalar::Text("DC East · core-sw-02".into()),
            p.clone(),
        )
        .unwrap();
        g.set_field(
            peer.into(),
            ExternalPeerField::FarDesign.key(),
            scalar::Identifier("design-east".into()),
            p.clone(),
        )
        .unwrap();
        g.set_field(
            peer.into(),
            ExternalPeerField::FarElement.key(),
            scalar::Identifier("physical-port:far".into()),
            p.clone(),
        )
        .unwrap();
        let cable = g.insert_node(NodeKind::Cable, Ulid(20), p.clone()).unwrap();
        g.insert_edge(EdgeKind::Terminates, Ulid(21), cable, port, p.clone())
            .unwrap();
        g.insert_edge(EdgeKind::Terminates, Ulid(22), cable, peer, p.clone())
            .unwrap();
        g.end_batch().unwrap();

        let rows = rows_of_snapshot(&g.to_snapshot().unwrap());
        let kinds: Vec<&str> = rows.iter().map(|r| r.kind).collect();
        assert_eq!(
            kinds,
            vec!["device", "card", "power_supply", "optic"],
            "{rows:#?}"
        );
        assert_eq!(rows[0].model, "EX4300-48T");
        assert_eq!(rows[0].serial, "PE3714AF0123");
        assert!(rows[1..].iter().all(|r| r.device == "core-sw-01"));
        assert_eq!(rows[3].serial, "ABC123");
        assert!(rows[3].model.contains("EX-SFP-10GE-LR"));
        assert_eq!(
            rows[0].ports,
            vec![Port {
                id: port.to_string(),
                name: "xe-0/2/0".into(),
                far: Some(("design-east".into(), "physical-port:far".into())),
            }]
        );
    }
}
