//! The equipment catalogue — corpus data, not code (ADR-0044 §1, §2 rule 1).
//!
//! ADR-0044 names `catalogue/` as the engine-pack sibling of the statement
//! dictionary (`crates/fathom-ingest/src/dict.rs`): *"equipment: model → ports,
//! positions, numbering, U-height, PSU inlets."* This module is that reader.
//! It is built to look like `dict.rs` on purpose — same error shape, same
//! load/load_platform/from_sources split, same gate-per-mistake philosophy —
//! but it lives here, in `fathom-corpus`, and not beside `dict.rs`, because it
//! has nothing to do with ingest. `dict.rs` is the parser table the six-stage
//! config pipeline binds statements against; a faceplate never sees a config
//! line. `fathom-corpus` is already the crate whose job is "read a corpus/
//! subdirectory into a typed value" (`load.rs`'s commands/explainers/rules/
//! concepts), and the catalogue is exactly one more such subdirectory.
//!
//! One file per model, under `corpus/catalogue/<platform>/<model>.yaml` —
//! mirroring `corpus/dict/<platform>/`'s directory shape, but NOT its merge
//! semantics: a dictionary's files are fragments of one platform's grammar and
//! are merged; a catalogue file is already a whole model on its own, so one
//! bad file only ever costs that one model, never the platform's whole catalog
//! (WO-03's shadowing gate has no equivalent need here — models do not extend
//! each other).
//!
//! DESIGN CHOICE, STATED ONCE: numbering and layout are a PATTERN the reader
//! expands, never a table of positions the file states outright. UI-SPEC's
//! "Ports" section states three rules — odd over even, 12-port groups, uplinks
//! right — as *facts about the hardware*, not options a catalogue author
//! chooses per model. If the file carried literal per-port coordinates, a
//! typo could swap two ports' positions while every number still looked right,
//! or place an uplink left of an access port, and nothing would catch it. A
//! `PortGroup` instead states what is genuinely per-model data — a run of N
//! ports of one kind, in one physical bank, numbered from one starting value,
//! arranged in one of three closed layouts — and [`Faceplate::ports`] is the
//! one place the odd/even and 12-port rules are implemented, so every model
//! gets them for free and none can get them wrong. The uplink-right rule is
//! enforced at LOAD time instead of being an emergent property of expansion,
//! because "uplinks placed after access groups in the file" is a fact about
//! the file the loader can check; nothing later can undo it.
//!
//! Unknown keys are refused, not read past — deliberately unlike
//! `fathom_schema::model`'s loader (*"the loader is deliberately permissive:
//! unknown keys are the reviewer's business"*). That looseness is fine for a
//! schema a human reviews before every merge; it is the wrong default for a
//! signed data pack ADR-0044 rule 1 promises contains nothing but the fields
//! it declares. A key this reader has never heard of is refused here, at load,
//! which is also what stands between this format and ever needing to become
//! one that COULD carry something executable: there is no way to add a new
//! kind of content without also adding the code that understands it.

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use fathom_schema::subset::{parse_profile, Profile};
use fathom_schema::value::Node;

/// UI-SPEC "Ports": ports read in blocks of 12 on the physical box, so the
/// drawing code leaves a gap after every twelfth port of a bank regardless of
/// how many the catalogue declares in one [`PortGroup`]. Fixed by the rule,
/// not by the file — see the module doc's design note.
pub const PAIRED_GROUP_BLOCK: u32 = 12;

/// Generous but finite caps (14 §11.6's spirit: refuse before processing,
/// never trust an unbounded count from a file). No real faceplate is anywhere
/// close to these; they exist so a malformed file fails fast with a message
/// rather than building an implausibly large `Vec` first.
const MAX_PORTS_PER_GROUP: u32 = 576;
const MAX_PORT_NUMBER: u32 = 100_000;
const MAX_RACK_UNITS: u32 = 60;
/// Cap on how many bays `psu_slots` may list (ADR-0050 §3/§4) — no real
/// chassis is anywhere close; same "fail fast on a malformed file" spirit as
/// [`MAX_PORTS_PER_GROUP`].
const MAX_PSU_SLOTS: u32 = 8;
/// Cap on a slot's `position.column` — a PSU bay's column is a small integer
/// by construction (a handful of bays side by side), so this is generous
/// headroom, not an expected value.
const MAX_SLOT_COLUMN: u32 = 16;

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogueError {
    pub file: String,
    pub line: usize,
    pub gate: CatalogueGate,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CatalogueGate {
    Parse,
    UnknownKey,
    VendorUnknown,
    PortKindUnknown,
    LayoutUnknown,
    RoleUnknown,
    FaceUnknown,
    RowUnknown,
    DuplicateFace,
    MissingFrontFace,
    DuplicatePortNumber,
    PortCountMismatch,
    UplinkNotRight,
    ReviewedByMissing,
    /// A port group declared both `names` and `count` (exactly one is
    /// required), or declared `role: management` / `role: console` without
    /// `names` (ADR-0050 §5 — a named port is not numbered).
    PortNamingInvalid,
    /// A model's `form:` is present but is not one of `shelf`, `outlet`,
    /// `board` or `panel` — see [`ModelForm`].
    FormUnknown,
}

/// UI-SPEC "Ports" names four glyphs — "Four glyphs, never confusable" — but
/// that is a statement about the DRAWING, not about what kinds of port real
/// hardware has. This reader is the estate-of-record: it names a fifth kind,
/// `QsfpPlus`, for the transceiver cage that genuinely is QSFP+ and is not
/// SFP+, so a catalogue entry never has to misname the metal to fit a glyph
/// set the screen has not caught up to yet, and a sixth, `C13`, for a PDU's
/// outlets — the female IEC 60320 socket a device's `C14` inlet plugs into
/// (UI-SPEC "Power": *"PDU with C13 outlets in the rack. Each device's PSU
/// inlets"* — C14). `C13` and `C14` are the two ends of the same cord, not
/// synonyms, so the catalogue must say which one a plate has. The client's
/// drawing layer, which has not grown a sixth glyph yet, draws a `C13` port
/// with the `C14` glyph mirrored (`client/src/components/drawing/
/// portGlyph.ts`) — a drawing-layer stopgap, not a reason to misname the
/// metal here (the same reasoning `QsfpPlus` already established). A
/// spelling outside all eight is still a `PortKindUnknown` load error, not a
/// silently accepted synonym.
///
/// `NemaP5_15R`/`NemaP5_15P` are the seventh and eighth kinds, added for a
/// tower UPS's outlet bank and captive input cord (`corpus/catalogue/
/// cyberpower/`): the female NEMA 5-15R receptacle a device's NEMA 5-15P plug
/// seats in, and the male 5-15P plug itself — the mains equivalent of the
/// `C13`/`C14` pair above, gated the same way (two ends of one cord, never
/// one `PortKind` for both). Their tokens are spelled `nema_5_15r`/
/// `nema_5_15p`, all-lowercase and underscored rather than `NEMA 5-15R`
/// verbatim — `token()` returns exactly what `from_token` accepts, same as
/// every other kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum PortKind {
    Rj45,
    SfpPlus,
    QsfpPlus,
    Lc,
    C14,
    C13,
    NemaP5_15R,
    NemaP5_15P,
}

impl PortKind {
    fn from_token(t: &str) -> Option<PortKind> {
        match t {
            "RJ45" => Some(PortKind::Rj45),
            "SFP+" => Some(PortKind::SfpPlus),
            "QSFP+" => Some(PortKind::QsfpPlus),
            "LC" => Some(PortKind::Lc),
            "C14" => Some(PortKind::C14),
            "C13" => Some(PortKind::C13),
            "nema_5_15r" => Some(PortKind::NemaP5_15R),
            "nema_5_15p" => Some(PortKind::NemaP5_15P),
            _ => None,
        }
    }

    pub fn token(self) -> &'static str {
        match self {
            PortKind::Rj45 => "RJ45",
            PortKind::SfpPlus => "SFP+",
            PortKind::QsfpPlus => "QSFP+",
            PortKind::Lc => "LC",
            PortKind::C14 => "C14",
            PortKind::C13 => "C13",
            PortKind::NemaP5_15R => "nema_5_15r",
            PortKind::NemaP5_15P => "nema_5_15p",
        }
    }
}

/// Whether a port group carries user traffic, is one of the plate's uplinks,
/// or is the out-of-band management or console interface (ADR-0050 §5: "they
/// are the reason the rear view exists"). UI-SPEC's "uplinks right" is
/// enforced at load by [`gate_uplinks_right`] for `Access`/`Uplink` only, not
/// by anything in [`Faceplate::ports`]; `Management` and `Console` carry no
/// left/right ordering rule of their own, since real hardware places them
/// wherever the vendor's chassis design puts them, not in a numbered bank.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Access,
    Uplink,
    Management,
    Console,
}

impl Role {
    fn from_token(t: &str) -> Option<Role> {
        match t {
            "access" => Some(Role::Access),
            "uplink" => Some(Role::Uplink),
            "management" => Some(Role::Management),
            "console" => Some(Role::Console),
            _ => None,
        }
    }
}

/// The three closed shapes a bank of ports can take on a plate. Every real
/// arrangement seen so far is one of these; a model that needs a fourth is a
/// reason to add one here, argued in the open (like every other change to
/// this reader), never a reason to let a file describe positions freely.
///
/// * `PairedColumns` — UI-SPEC's main rule: consecutive numbers stack in a
///   column, lower number on top. This is what "odd over even" describes when
///   a box is numbered from 1; the EX4300-48P below is numbered from 0, and
///   the very same rule puts its EVEN numbers on top — the rule is about
///   which number of the PAIR is lower, not about the literal word "odd".
/// * `PairedRows` — small uplink/QSFP+ banks: the first half of the count
///   fills the top row left to right, the second half fills the bottom row.
///   Read off the approved design board (`design/rebuild/Faceplate.dc.html`):
///   its 4-port SFP+ uplink bank labels top-left/top-right/bottom-left/
///   bottom-right as `xe-0, xe-1, xe-2, xe-3` in that reading order, which is
///   row-major, not the column pairing the main bank uses.
/// * `SingleRow` — one row, left to right. PSU-adjacent small banks and the
///   two-QSFP+ example in the same board (`et-0/1/0`, `et-0/1/1`, side by
///   side).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Layout {
    PairedColumns,
    PairedRows,
    SingleRow,
}

impl Layout {
    fn from_token(t: &str) -> Option<Layout> {
        match t {
            "paired_columns" => Some(Layout::PairedColumns),
            "paired_rows" => Some(Layout::PairedRows),
            "single_row" => Some(Layout::SingleRow),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Face {
    Front,
    Rear,
}

impl Face {
    fn from_token(t: &str) -> Option<Face> {
        match t {
            "front" => Some(Face::Front),
            "rear" => Some(Face::Rear),
            _ => None,
        }
    }
}

/// A model's physical shape, for the handful of shapes a device's ports and
/// PSU slots alone do not say enough about (ADR-0051 §1's `PassiveNode.form`
/// gaining `shelf` and `outlet`). Optional, and absent for every model this
/// reader carried before it: a rack switch, a patch panel or a PDU is fully
/// described by its faceplates and PSU slots and gains nothing by also
/// stating a `form`. What it names IS what a panel already was before this
/// field existed — `corpus/catalogue/panduit/*.yaml`'s patch panels and ODF
/// carried no `form` and still do not need one, since "a passive plate with
/// front-face ports and no PSU slots" already says "panel" on its own — this
/// field exists for the shapes that fact alone cannot say: a shelf has no
/// ports and no slots at all (nothing to infer a form from), and an outlet
/// box's punchdown rear is expressed with the same `RJ45` kind its front
/// carries (see `corpus/catalogue/icc/`'s header), so nothing else in the
/// file distinguishes it from a patch panel either.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelForm {
    Shelf,
    Outlet,
    Board,
    Panel,
}

impl ModelForm {
    fn from_token(t: &str) -> Option<ModelForm> {
        match t {
            "shelf" => Some(ModelForm::Shelf),
            "outlet" => Some(ModelForm::Outlet),
            "board" => Some(ModelForm::Board),
            "panel" => Some(ModelForm::Panel),
            _ => None,
        }
    }

    pub fn token(self) -> &'static str {
        match self {
            ModelForm::Shelf => "shelf",
            ModelForm::Outlet => "outlet",
            ModelForm::Board => "board",
            ModelForm::Panel => "panel",
        }
    }
}

/// Whether a [`PortGroup`]'s ports are a numbered run or a list of
/// individually named ports (ADR-0050 §5): a bank of access or uplink ports
/// is `Counted`, numbered `start_number .. start_number + count`; the
/// EX4300's `me0` and `con` are `Named` — printed on the box as words, never
/// as part of a numbering pattern, so nothing here invents a number for them.
/// A group carries exactly one of these; [`load_port_groups`] is what
/// refuses a file declaring both, or declaring neither.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PortNumbering {
    Counted { count: u32, start_number: u32 },
    Named { names: Vec<String> },
}

impl PortNumbering {
    /// How many ports this group expands to — the one thing
    /// [`Faceplate::ports`] and the load-time gates need regardless of which
    /// variant they are looking at.
    fn len(&self) -> u32 {
        match self {
            PortNumbering::Counted { count, .. } => *count,
            #[allow(clippy::cast_possible_truncation)]
            PortNumbering::Named { names } => names.len() as u32,
        }
    }
}

/// A run of ports of one `kind`, arranged per `layout` and numbered or named
/// per `numbering`. Everything a wrong catalogue could get wrong about ONE
/// bank lives in these four fields; everything about how banks combine on a
/// plate is a load-time gate, not a field.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortGroup {
    pub kind: PortKind,
    pub role: Role,
    pub layout: Layout,
    pub numbering: PortNumbering,
}

/// One face of one model, front or rear (UI-SPEC's rear view). `port_count`
/// is the number a human would say describing this plate ("a 48-port
/// switch") and is cross-checked against the sum of `groups` at load —
/// [`CatalogueGate::PortCountMismatch`] is what fires when they disagree.
#[derive(Debug, Clone)]
pub struct Faceplate {
    pub face: Face,
    pub port_count: u32,
    pub groups: Vec<PortGroup>,
}

/// Where a port sits once a [`PortGroup`] has been expanded — everything the
/// drawing code needs and nothing it must compute itself (module doc).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Row {
    Top,
    Bottom,
    Single,
}

impl Row {
    /// Parses a `psu_slots[].position.row` token — the same three words
    /// [`Faceplate::ports`] produces for a port, per ADR-0050 §3's
    /// instruction to place an inlet "like a port" (module doc, catalogue.rs
    /// top). A `PortGroup`'s own row is never read from the file — this is
    /// the one place `Row` is parsed rather than computed.
    fn from_token(t: &str) -> Option<Row> {
        match t {
            "top" => Some(Row::Top),
            "bottom" => Some(Row::Bottom),
            "single" => Some(Row::Single),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Port {
    pub kind: PortKind,
    /// As printed on the physical box (UI-SPEC: "numbered as the label on
    /// the box reads"). May be 0- or 1-based; see [`Layout::PairedColumns`].
    /// `None` for a [`PortNumbering::Named`] port — see `name` below.
    pub number: Option<u32>,
    /// The vendor's own word for a [`PortNumbering::Named`] port (`me0`,
    /// `con`); `None` for a numbered port, exactly the mirror image of
    /// `number` above — a port carries exactly one of the two, never both,
    /// never neither.
    pub name: Option<String>,
    /// `true` exactly when `role == Role::Uplink` — kept as its own field
    /// because it predates `role` here and UI-SPEC's "uplinks right" is
    /// stated in exactly these terms; `role` (below) is the fuller picture,
    /// added for `Management`/`Console` (ADR-0050 §5).
    pub uplink: bool,
    pub role: Role,
    pub row: Row,
    /// 0-based, left to right, continuous across every group on the plate —
    /// gaps between banks are the `group_gap_before` flag, not a skipped
    /// column, so the drawing code chooses its own margin.
    pub column: u32,
    /// A visual break belongs before this port: either it opens a new
    /// [`PortGroup`], or it is the first port of this bank's next 12-port
    /// block (UI-SPEC: "12-port groups").
    pub group_gap_before: bool,
}

impl Faceplate {
    /// Expands every [`PortGroup`] on this plate into positioned, numbered
    /// [`Port`]s. Infallible: [`load_faceplates`] is what makes every group
    /// here internally consistent (no colliding numbers, no plate total that
    /// lies about its own groups, no uplink left of an access port) before a
    /// `Faceplate` ever exists, so this is pure arithmetic over already-gated
    /// data — nothing here can discover a new way for the catalogue to be
    /// wrong.
    pub fn ports(&self) -> Vec<Port> {
        let mut out = Vec::new();
        let mut column_cursor: u32 = 0;
        for (gi, g) in self.groups.iter().enumerate() {
            let base_column = column_cursor;
            let count = g.numbering.len();
            let half = count.div_ceil(2);
            let mut columns_used = 0u32;
            for i in 0..count {
                let (row, col_in_group) = match g.layout {
                    Layout::PairedColumns => {
                        let row = if i % 2 == 0 { Row::Top } else { Row::Bottom };
                        (row, i / 2)
                    }
                    Layout::PairedRows => {
                        if i < half {
                            (Row::Top, i)
                        } else {
                            (Row::Bottom, i - half)
                        }
                    }
                    Layout::SingleRow => (Row::Single, i),
                };
                columns_used = columns_used.max(col_in_group + 1);
                let opens_new_group = i == 0 && gi > 0;
                let opens_12_block = i > 0 && i % PAIRED_GROUP_BLOCK == 0;
                let (number, name) = match &g.numbering {
                    PortNumbering::Counted { start_number, .. } => (Some(start_number + i), None),
                    #[allow(clippy::indexing_slicing)]
                    PortNumbering::Named { names } => (None, Some(names[i as usize].clone())),
                };
                out.push(Port {
                    kind: g.kind,
                    number,
                    name,
                    uplink: g.role == Role::Uplink,
                    role: g.role,
                    row,
                    column: base_column + col_in_group,
                    group_gap_before: opens_new_group || opens_12_block,
                });
            }
            column_cursor = base_column + columns_used;
        }
        out
    }
}

/// Where a [`PsuSlot`] sits on its face — the same `row`/`column` vocabulary
/// [`Port`] carries (ADR-0050 §3: "like any port"), stated by the file rather
/// than expanded from a group, because a chassis has at most a handful of
/// bays and their arrangement follows no numbering pattern worth a
/// [`PortGroup`]-style expansion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SlotPosition {
    pub row: Row,
    pub column: u32,
}

/// A power-supply bay, populated or not — ADR-0050 §3/§4: an inlet is a
/// positioned entry on a faceplate, not a count. `name` is the vendor's own
/// word for the slot ("PSU 0", "PSU 1", "PEM A"), cited under CLAUDE.md rule
/// 1 via the model's own [`Source`]. `hot_swap: false` records a supply that
/// is not field-replaceable — the model still has an inlet, it just has one
/// fixed slot; drawing the inlet mark on the chassis for that case is the
/// client's job, not this reader's (ADR-0050 §4). A model with no inlet at
/// all (a passive panel, or a captive-corded device with no socket to name)
/// omits `psu_slots` entirely rather than listing one — see
/// `corpus/catalogue/panduit/*.yaml` and `corpus/catalogue/apc/*.yaml`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PsuSlot {
    pub name: String,
    pub hot_swap: bool,
    pub face: Face,
    pub position: SlotPosition,
}

/// Where a claim in this file came from — CLAUDE.md rule 1, made a field
/// rather than a comment so a catalogue entry cannot exist without one.
#[derive(Debug, Clone)]
pub struct Source {
    pub cite: String,
    pub read_on: String,
}

#[derive(Debug, Clone)]
pub struct Model {
    pub vendor: String,
    pub model: String,
    pub rack_units: u32,
    pub reviewed_by: String,
    pub source: Source,
    pub faceplates: Vec<Faceplate>,
    /// Empty for a model with no PSU inlet at all (module doc on
    /// [`PsuSlot`]) — never `None` vs. `Some(vec![])`, since an absent
    /// `psu_slots:` key and an explicit empty list mean the same thing here.
    pub psu_slots: Vec<PsuSlot>,
    /// `None` for every model whose faceplates and PSU slots already say
    /// enough on their own (module doc on [`ModelForm`]).
    pub form: Option<ModelForm>,
}

impl Model {
    pub fn faceplate(&self, face: Face) -> Option<&Faceplate> {
        self.faceplates.iter().find(|f| f.face == face)
    }
}

/// A loaded platform's models, keyed by nothing more than the order the files
/// were read in (deterministic: sorted file names, like `Dictionary`'s own
/// file walk).
#[derive(Debug, Default)]
pub struct Catalogue {
    models: Vec<Model>,
}

impl Catalogue {
    /// Loads every `*.yaml` file under `corpus/catalogue/<vendor>/`, one
    /// model per file, and runs every gate below. A gate failure is a load
    /// failure for that vendor's whole catalogue — a model that does not
    /// pass is never half-loaded (mirrors `Dictionary::load_platform`).
    ///
    /// Named `load_platform` for the same reason `Dictionary`'s is: the
    /// directory segment is called `<platform>` in ADR-0044 and in this
    /// crate's `load.rs`. For the catalogue that segment is a vendor id
    /// (`vendor:` inside each file must match it) rather than a config-syntax
    /// platform — see the module doc.
    pub fn load_platform(root: &Path, vendor_dir: &str) -> Result<Catalogue, CatalogueError> {
        let dir = root.join("corpus").join("catalogue").join(vendor_dir);
        let schema_root = root.join("schema");
        let schema = fathom_schema::SchemaTree::load(&schema_root).map_err(|e| CatalogueError {
            file: schema_root.display().to_string(),
            line: 0,
            gate: CatalogueGate::Parse,
            message: format!("schema tree: {e:?}"),
        })?;
        let vendors: BTreeSet<String> = schema
            .platforms
            .map(|p| p.vendors.into_iter().collect())
            .unwrap_or_default();

        let mut files: Vec<std::path::PathBuf> = fs::read_dir(&dir)
            .map_err(|e| CatalogueError {
                file: dir.display().to_string(),
                line: 0,
                gate: CatalogueGate::Parse,
                message: format!("read_dir: {e}"),
            })?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().map(|x| x == "yaml").unwrap_or(false))
            .collect();
        files.sort();

        let mut sources: Vec<(String, String)> = Vec::new();
        for path in &files {
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let text = fs::read_to_string(path).map_err(|e| CatalogueError {
                file: name.clone(),
                line: 0,
                gate: CatalogueGate::Parse,
                message: format!("read: {e}"),
            })?;
            sources.push((name, text));
        }
        Catalogue::from_sources(&sources, vendor_dir, &vendors)
    }

    /// The filesystem-free load path (mirrors `Dictionary::from_sources`), so
    /// the gates can be exercised against synthetic sources in unit tests.
    pub fn from_sources(
        sources: &[(String, String)],
        vendor_dir: &str,
        vendors: &BTreeSet<String>,
    ) -> Result<Catalogue, CatalogueError> {
        let mut models = Vec::new();
        for (name, text) in sources {
            let root = parse_profile(text, Profile::Corpus)
                .map_err(|e| err(name, e.line, CatalogueGate::Parse, e.message))?;
            models.push(load_model(name, &root, vendor_dir, vendors)?);
        }
        Ok(Catalogue { models })
    }

    pub fn models(&self) -> &[Model] {
        &self.models
    }

    pub fn model(&self, model_name: &str) -> Option<&Model> {
        self.models.iter().find(|m| m.model == model_name)
    }
}

// ---------------------------------------------------------------------------
// Loading and the gates
// ---------------------------------------------------------------------------

fn err(file: &str, line: usize, gate: CatalogueGate, message: impl Into<String>) -> CatalogueError {
    CatalogueError {
        file: file.to_owned(),
        line,
        gate,
        message: message.into(),
    }
}

/// Every present key must be one this level of the format declares — refused,
/// not ignored (module doc). The one enforcement point the rest of this file
/// leans on to keep the format closed.
fn refuse_unknown_keys(file: &str, node: &Node, allowed: &[&str]) -> Result<(), CatalogueError> {
    let Some(map) = node.as_map() else {
        return Err(err(file, node.line, CatalogueGate::Parse, "expected a map"));
    };
    for (key, value) in map {
        if !allowed.contains(&key.as_str()) {
            return Err(err(
                file,
                value.line,
                CatalogueGate::UnknownKey,
                format!("unknown key `{key}` (allowed: {})", allowed.join(", ")),
            ));
        }
    }
    Ok(())
}

fn req<'a>(file: &str, node: &'a Node, key: &str) -> Result<&'a Node, CatalogueError> {
    node.get(key).ok_or_else(|| {
        err(
            file,
            node.line,
            CatalogueGate::Parse,
            format!("missing `{key}`"),
        )
    })
}

fn req_str(file: &str, node: &Node, key: &str) -> Result<String, CatalogueError> {
    let v = req(file, node, key)?;
    v.as_str().map(|s| s.to_owned()).ok_or_else(|| {
        err(
            file,
            v.line,
            CatalogueGate::Parse,
            format!("`{key}` is not a string"),
        )
    })
}

/// A required non-negative integer field, refused outside `min..=max`
/// (§11.6's spirit: a cap that fails fast beats an unbounded `Vec` later).
fn req_u32_range(
    file: &str,
    node: &Node,
    key: &str,
    min: u32,
    max: u32,
) -> Result<u32, CatalogueError> {
    let v = req(file, node, key)?;
    let i = v.as_int().ok_or_else(|| {
        err(
            file,
            v.line,
            CatalogueGate::Parse,
            format!("`{key}` is not an integer"),
        )
    })?;
    let n = u32::try_from(i).ok().filter(|n| (min..=max).contains(n));
    n.ok_or_else(|| {
        err(
            file,
            v.line,
            CatalogueGate::Parse,
            format!("`{key}` must be an integer in {min}..={max}, got {i}"),
        )
    })
}

const MODEL_KEYS: &[&str] = &[
    "vendor",
    "model",
    "rack_units",
    "reviewed_by",
    "source",
    "faceplates",
    "psu_slots",
    "form",
];
const SOURCE_KEYS: &[&str] = &["cite", "read_on"];
const FACEPLATE_KEYS: &[&str] = &["face", "port_count", "port_groups"];
const GROUP_KEYS: &[&str] = &["kind", "role", "layout", "count", "start_number", "names"];
const PSU_SLOT_KEYS: &[&str] = &["name", "hot_swap", "face", "position"];
const POSITION_KEYS: &[&str] = &["row", "column"];

fn load_model(
    file: &str,
    root: &Node,
    expected_vendor_dir: &str,
    vendors: &BTreeSet<String>,
) -> Result<Model, CatalogueError> {
    refuse_unknown_keys(file, root, MODEL_KEYS)?;

    // `vendor:` is a foreign key into `schema/platforms.yaml`'s `vendors:`
    // block (that file's own comment: "hardware-catalogue vendors are the
    // same namespace"), and it is also what `corpus/catalogue/<vendor>/`
    // groups files by — one check does both jobs, so there is no second
    // `platform:` field that could say something different from the
    // directory a file actually lives in.
    let vendor = req_str(file, root, "vendor")?;
    if !vendors.is_empty() && !vendors.contains(&vendor) {
        return Err(err(
            file,
            root.line,
            CatalogueGate::VendorUnknown,
            format!("`{vendor}` is not a vendor id in schema/platforms.yaml"),
        ));
    }
    if vendor != expected_vendor_dir {
        return Err(err(
            file,
            root.line,
            CatalogueGate::Parse,
            format!("vendor `{vendor}` disagrees with directory `{expected_vendor_dir}`"),
        ));
    }

    let model_name = req_str(file, root, "model")?;
    let rack_units = req_u32_range(file, root, "rack_units", 1, MAX_RACK_UNITS)?;

    // Presence only, exactly like `dict.rs`'s `reviewed_by` gate: this loader
    // checks a name is IN the field, not that it is a real one. The
    // `<named human>` placeholder used throughout `corpus/` (invariant 10)
    // still counts as present, which is the point of the placeholder.
    if root.get("reviewed_by").and_then(|n| n.as_str()).is_none() {
        return Err(err(
            file,
            root.line,
            CatalogueGate::ReviewedByMissing,
            format!("`{model_name}` has no `reviewed_by` (invariant 10)"),
        ));
    }
    let reviewed_by = req_str(file, root, "reviewed_by")?;

    let source = load_source(file, req(file, root, "source")?)?;
    let faceplates = load_faceplates(file, req(file, root, "faceplates")?)?;
    if !faceplates.iter().any(|f| f.face == Face::Front) {
        return Err(err(
            file,
            root.line,
            CatalogueGate::MissingFrontFace,
            format!("`{model_name}` declares no `front` faceplate"),
        ));
    }

    let psu_slots = match root.get("psu_slots") {
        None => Vec::new(),
        Some(n) => load_psu_slots(file, n)?,
    };

    let form = match root.get("form") {
        None => None,
        Some(n) => {
            let tok = n
                .as_str()
                .ok_or_else(|| err(file, n.line, CatalogueGate::Parse, "`form` is not a string"))?;
            Some(ModelForm::from_token(tok).ok_or_else(|| {
                err(
                    file,
                    n.line,
                    CatalogueGate::FormUnknown,
                    format!("`{tok}` is not one of shelf, outlet, board, panel"),
                )
            })?)
        }
    };

    Ok(Model {
        vendor,
        model: model_name,
        rack_units,
        reviewed_by,
        source,
        faceplates,
        psu_slots,
        form,
    })
}

fn load_source(file: &str, node: &Node) -> Result<Source, CatalogueError> {
    refuse_unknown_keys(file, node, SOURCE_KEYS)?;
    let cite = req_str(file, node, "cite")?;
    let read_on = req_str(file, node, "read_on")?;
    if !looks_like_date(&read_on) {
        return Err(err(
            file,
            node.line,
            CatalogueGate::Parse,
            format!("`read_on: {read_on}` is not `YYYY-MM-DD`"),
        ));
    }
    Ok(Source { cite, read_on })
}

/// A cheap shape check, not a calendar: `YYYY-MM-DD`, digits and dashes only.
/// Enough to catch a citation that forgot a date entirely (an empty string,
/// or free text) without this reader carrying a date library it uses nowhere
/// else.
fn looks_like_date(s: &str) -> bool {
    let bytes = s.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes.iter().enumerate().all(|(i, b)| match i {
            4 | 7 => true,
            _ => b.is_ascii_digit(),
        })
}

fn load_faceplates(file: &str, node: &Node) -> Result<Vec<Faceplate>, CatalogueError> {
    let seq = node.as_seq().ok_or_else(|| {
        err(
            file,
            node.line,
            CatalogueGate::Parse,
            "`faceplates` is not a list",
        )
    })?;
    let mut out = Vec::new();
    let mut seen_faces: BTreeSet<Face> = BTreeSet::new();
    for item in seq {
        refuse_unknown_keys(file, item, FACEPLATE_KEYS)?;
        let face_tok = req_str(file, item, "face")?;
        let face = Face::from_token(&face_tok).ok_or_else(|| {
            err(
                file,
                item.line,
                CatalogueGate::FaceUnknown,
                format!("`{face_tok}` is not `front` or `rear`"),
            )
        })?;
        if !seen_faces.insert(face) {
            return Err(err(
                file,
                item.line,
                CatalogueGate::DuplicateFace,
                format!("`{face_tok}` is declared twice"),
            ));
        }
        let stated_count = req_u32_range(file, item, "port_count", 0, MAX_PORTS_PER_GROUP * 8)?;
        let groups = load_port_groups(file, req(file, item, "port_groups")?)?;

        let derived: u32 = groups.iter().map(|g| g.numbering.len()).sum();
        if derived != stated_count {
            return Err(err(
                file,
                item.line,
                CatalogueGate::PortCountMismatch,
                format!(
                    "`port_count: {stated_count}` disagrees with the plate's own groups, \
                     which sum to {derived}"
                ),
            ));
        }

        gate_no_duplicate_numbers(file, item.line, &groups)?;
        gate_uplinks_right(file, item.line, &groups)?;

        out.push(Faceplate {
            face,
            port_count: stated_count,
            groups,
        });
    }
    Ok(out)
}

/// One port's identity within a [`PortKind`] — either a silkscreen number or
/// a vendor-printed name, the same two-shape split [`PortNumbering`] carries,
/// used here as the set element [`gate_no_duplicate_numbers`] de-duplicates
/// against.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum PortIdentity {
    Number(u32),
    Name(String),
}

/// Numbers (or names) only collide within one [`PortKind`], not across the
/// whole plate: real hardware routinely prints "1" under both the first
/// copper port and the first SFP+ uplink, and the glyph is what tells them
/// apart (UI-SPEC: "Four glyphs, never confusable"). The EX4300-48P below
/// does exactly this — its 48 RJ45 ports and its 4 SFP+ uplinks are both
/// numbered from 0. What IS a mistake is two groups of the SAME kind
/// claiming the same number or the same name.
fn gate_no_duplicate_numbers(
    file: &str,
    line: usize,
    groups: &[PortGroup],
) -> Result<(), CatalogueError> {
    let mut seen: BTreeSet<(PortKind, PortIdentity)> = BTreeSet::new();
    for g in groups {
        match &g.numbering {
            PortNumbering::Counted {
                count,
                start_number,
            } => {
                for i in 0..*count {
                    let number = start_number + i;
                    if !seen.insert((g.kind, PortIdentity::Number(number))) {
                        return Err(err(
                            file,
                            line,
                            CatalogueGate::DuplicatePortNumber,
                            format!(
                                "{} port number {number} is claimed by more than one group",
                                g.kind.token()
                            ),
                        ));
                    }
                }
            }
            PortNumbering::Named { names } => {
                for name in names {
                    if !seen.insert((g.kind, PortIdentity::Name(name.clone()))) {
                        return Err(err(
                            file,
                            line,
                            CatalogueGate::DuplicatePortNumber,
                            format!(
                                "{} port name `{name}` is claimed by more than one group",
                                g.kind.token()
                            ),
                        ));
                    }
                }
            }
        }
    }
    Ok(())
}

/// UI-SPEC: "uplinks right". Enforced here, on the FILE, rather than left as
/// an emergent property of [`Faceplate::ports`]'s left-to-right expansion:
/// once an `uplink` group has been seen, no later `access` group is legal on
/// the same plate, so an author cannot write uplinks first and have them
/// silently land on the left. `Management` and `Console` groups carry no
/// such rule (`Role`'s own doc comment) and pass through untouched.
fn gate_uplinks_right(file: &str, line: usize, groups: &[PortGroup]) -> Result<(), CatalogueError> {
    let mut seen_uplink = false;
    for g in groups {
        match g.role {
            Role::Uplink => seen_uplink = true,
            Role::Access if seen_uplink => {
                return Err(err(
                    file,
                    line,
                    CatalogueGate::UplinkNotRight,
                    "an access group follows an uplink group on the same plate — \
                     uplinks must be listed last, so they draw on the right"
                        .to_owned(),
                ));
            }
            Role::Access | Role::Management | Role::Console => {}
        }
    }
    Ok(())
}

fn load_port_groups(file: &str, node: &Node) -> Result<Vec<PortGroup>, CatalogueError> {
    let seq = node.as_seq().ok_or_else(|| {
        err(
            file,
            node.line,
            CatalogueGate::Parse,
            "`port_groups` is not a list",
        )
    })?;
    let mut out = Vec::new();
    for item in seq {
        refuse_unknown_keys(file, item, GROUP_KEYS)?;
        let kind_tok = req_str(file, item, "kind")?;
        let kind = PortKind::from_token(&kind_tok).ok_or_else(|| {
            err(
                file,
                item.line,
                CatalogueGate::PortKindUnknown,
                format!(
                    "`{kind_tok}` is not one of RJ45, SFP+, QSFP+, LC, C14, C13, \
                     nema_5_15r, nema_5_15p"
                ),
            )
        })?;
        let role_tok = req_str(file, item, "role")?;
        let role = Role::from_token(&role_tok).ok_or_else(|| {
            err(
                file,
                item.line,
                CatalogueGate::RoleUnknown,
                format!("`{role_tok}` is not `access`, `uplink`, `management` or `console`"),
            )
        })?;
        let layout_tok = req_str(file, item, "layout")?;
        let layout = Layout::from_token(&layout_tok).ok_or_else(|| {
            err(
                file,
                item.line,
                CatalogueGate::LayoutUnknown,
                format!("`{layout_tok}` is not `paired_columns`, `paired_rows` or `single_row`"),
            )
        })?;

        // Exactly one of `names` (individually named ports — ADR-0050 §5) or
        // `count`/`start_number` (a numbered bank) may be present; a
        // `management`/`console` group is always named, since a management
        // or console port is never part of a numbered run.
        let has_names = item.get("names").is_some();
        let has_count = item.get("count").is_some();
        let numbering = match (has_names, has_count) {
            (true, true) => {
                return Err(err(
                    file,
                    item.line,
                    CatalogueGate::PortNamingInvalid,
                    "a port group cannot declare both `names` and `count`".to_owned(),
                ));
            }
            (true, false) => PortNumbering::Named {
                names: load_names(file, req(file, item, "names")?)?,
            },
            (false, true) => {
                if matches!(role, Role::Management | Role::Console) {
                    return Err(err(
                        file,
                        item.line,
                        CatalogueGate::PortNamingInvalid,
                        format!(
                            "a `{role_tok}` group must declare `names`, not `count` — a \
                             management or console port is named, not numbered"
                        ),
                    ));
                }
                PortNumbering::Counted {
                    count: req_u32_range(file, item, "count", 1, MAX_PORTS_PER_GROUP)?,
                    start_number: req_u32_range(file, item, "start_number", 0, MAX_PORT_NUMBER)?,
                }
            }
            (false, false) => {
                return Err(err(
                    file,
                    item.line,
                    CatalogueGate::PortNamingInvalid,
                    "a port group must declare either `names` or `count`".to_owned(),
                ));
            }
        };

        out.push(PortGroup {
            kind,
            role,
            layout,
            numbering,
        });
    }
    Ok(out)
}

/// `names:` — a list of vendor-printed port words (`me0`, `con`), never
/// empty, never past the same generous cap a numbered bank is held to.
fn load_names(file: &str, node: &Node) -> Result<Vec<String>, CatalogueError> {
    let seq = node.as_seq().ok_or_else(|| {
        err(
            file,
            node.line,
            CatalogueGate::Parse,
            "`names` is not a list",
        )
    })?;
    if seq.is_empty() {
        return Err(err(
            file,
            node.line,
            CatalogueGate::Parse,
            "`names` must not be empty",
        ));
    }
    if seq.len() > MAX_PORTS_PER_GROUP as usize {
        return Err(err(
            file,
            node.line,
            CatalogueGate::Parse,
            format!(
                "`names` has {} entries, more than {MAX_PORTS_PER_GROUP}",
                seq.len()
            ),
        ));
    }
    let mut out = Vec::new();
    for n in seq {
        let s = n.as_str().ok_or_else(|| {
            err(
                file,
                n.line,
                CatalogueGate::Parse,
                "a `names` entry is not a string",
            )
        })?;
        if s.is_empty() {
            return Err(err(
                file,
                n.line,
                CatalogueGate::Parse,
                "a `names` entry must not be empty",
            ));
        }
        out.push(s.to_owned());
    }
    Ok(out)
}

fn load_psu_slots(file: &str, node: &Node) -> Result<Vec<PsuSlot>, CatalogueError> {
    let seq = node.as_seq().ok_or_else(|| {
        err(
            file,
            node.line,
            CatalogueGate::Parse,
            "`psu_slots` is not a list",
        )
    })?;
    if seq.len() > MAX_PSU_SLOTS as usize {
        return Err(err(
            file,
            node.line,
            CatalogueGate::Parse,
            format!(
                "`psu_slots` has {} entries, more than {MAX_PSU_SLOTS}",
                seq.len()
            ),
        ));
    }
    let mut out = Vec::new();
    for item in seq {
        refuse_unknown_keys(file, item, PSU_SLOT_KEYS)?;
        let name = req_str(file, item, "name")?;
        if name.is_empty() {
            return Err(err(
                file,
                item.line,
                CatalogueGate::Parse,
                "a `psu_slots` entry's `name` must not be empty",
            ));
        }
        let hot_swap = req(file, item, "hot_swap")?.as_bool().ok_or_else(|| {
            err(
                file,
                item.line,
                CatalogueGate::Parse,
                "`hot_swap` is not `true` or `false`",
            )
        })?;
        let face_tok = req_str(file, item, "face")?;
        let face = Face::from_token(&face_tok).ok_or_else(|| {
            err(
                file,
                item.line,
                CatalogueGate::FaceUnknown,
                format!("`{face_tok}` is not `front` or `rear`"),
            )
        })?;
        let position = load_slot_position(file, req(file, item, "position")?)?;
        out.push(PsuSlot {
            name,
            hot_swap,
            face,
            position,
        });
    }
    Ok(out)
}

fn load_slot_position(file: &str, node: &Node) -> Result<SlotPosition, CatalogueError> {
    refuse_unknown_keys(file, node, POSITION_KEYS)?;
    let row_tok = req_str(file, node, "row")?;
    let row = Row::from_token(&row_tok).ok_or_else(|| {
        err(
            file,
            node.line,
            CatalogueGate::RowUnknown,
            format!("`{row_tok}` is not `top`, `bottom` or `single`"),
        )
    })?;
    let column = req_u32_range(file, node, "column", 0, MAX_SLOT_COLUMN)?;
    Ok(SlotPosition { row, column })
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

    fn repo_root() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(2)
            .expect("the crate lives two levels under the repo root")
            .to_path_buf()
    }

    fn juniper_vendors() -> BTreeSet<String> {
        let mut v = BTreeSet::new();
        v.insert("juniper".to_owned());
        v
    }

    fn source(text: &str) -> Vec<(String, String)> {
        vec![("t.yaml".to_owned(), text.to_owned())]
    }

    // A minimal, otherwise-good 12-port model with a 2-port uplink group, used
    // by several gate tests below as the thing ONE field gets broken on.
    fn good_model_text(extra_top_level: &str) -> String {
        format!(
            "vendor: juniper\n\
             model: TEST-12P\n\
             rack_units: 1\n\
             reviewed_by: <named human>\n\
             {extra_top_level}\
             source:\n  \
               cite: \"a test fixture, not a real datasheet\"\n  \
               read_on: \"2026-09-14\"\n\
             faceplates:\n  \
               - face: front\n    \
                 port_count: 14\n    \
                 port_groups:\n      \
                   - {{ kind: \"RJ45\", role: access, layout: paired_columns, count: 12, start_number: 1 }}\n      \
                   - {{ kind: \"SFP+\", role: uplink, layout: paired_rows, count: 2, start_number: 1 }}\n"
        )
    }

    #[test]
    fn a_good_catalogue_parses() {
        let text = good_model_text("");
        let cat = Catalogue::from_sources(&source(&text), "juniper", &juniper_vendors())
            .expect("a well-formed catalogue file loads");
        assert_eq!(cat.models().len(), 1);
        let m = cat.model("TEST-12P").expect("model is reachable by name");
        assert_eq!(m.vendor, "juniper");
        assert_eq!(m.rack_units, 1);
        let front = m.faceplate(Face::Front).expect("front face present");
        assert_eq!(front.port_count, 14);
        assert_eq!(front.groups.len(), 2);
        assert_eq!(m.form, None, "a model with no `form:` key carries None");
    }

    #[test]
    fn a_declared_form_round_trips() {
        // A shelf has no ports and no slots (`corpus/catalogue/tripplite/`) —
        // nothing else in the file could say "this is a shelf", which is
        // exactly why `form` exists (module doc on `ModelForm`).
        let text = good_model_text("form: shelf\n");
        let cat = Catalogue::from_sources(&source(&text), "juniper", &juniper_vendors())
            .expect("a recognised `form` value loads");
        let m = cat.model("TEST-12P").expect("model present");
        assert_eq!(m.form, Some(ModelForm::Shelf));
    }

    #[test]
    fn an_unrecognised_form_is_refused() {
        let text = good_model_text("form: gazebo\n");
        let e = Catalogue::from_sources(&source(&text), "juniper", &juniper_vendors())
            .expect_err("`gazebo` is not one of shelf, outlet, board, panel");
        assert_eq!(e.gate, CatalogueGate::FormUnknown);
    }

    #[test]
    fn unknown_key_is_refused() {
        // A key shaped like it could carry something to run, at the level
        // most exposed to a copy-pasted third-party file: the model's own
        // top level. `refuse_unknown_keys` is what stands between the format
        // and ever needing to interpret it.
        let text = good_model_text("script: \"rm -rf /\"\n");
        let e = Catalogue::from_sources(&source(&text), "juniper", &juniper_vendors())
            .expect_err("an unrecognised top-level key must be refused");
        assert_eq!(e.gate, CatalogueGate::UnknownKey);
    }

    #[test]
    fn executable_shaped_content_is_refused_the_same_way() {
        // A folded block scalar under an unknown key, the closest this
        // deliberately non-executable format comes to "looks like a script".
        // Refused for the same reason as the plain-string case: the key does
        // not exist, so its value — however it is spelled — is never looked
        // at, let alone run.
        let text = good_model_text("hook: >\n  eval(fetch_and_run())\n");
        let e = Catalogue::from_sources(&source(&text), "juniper", &juniper_vendors())
            .expect_err("an unknown key stays refused regardless of its value's shape");
        assert_eq!(e.gate, CatalogueGate::UnknownKey);
    }

    #[test]
    fn qsfp_plus_parses_as_its_own_kind() {
        // The fifth kind, not one of UI-SPEC's four drawn glyphs: a QSFP+
        // group must round-trip as `PortKind::QsfpPlus`, not be refused and
        // not collapse into `SfpPlus`.
        let text = "vendor: juniper\n\
             model: TEST-QSFP\n\
             rack_units: 1\n\
             reviewed_by: <named human>\n\
             source:\n  cite: \"fixture\"\n  read_on: \"2026-09-14\"\n\
             faceplates:\n  \
               - face: front\n    \
                 port_count: 2\n    \
                 port_groups:\n      \
                   - { kind: \"QSFP+\", role: access, layout: single_row, count: 2, start_number: 0 }\n";
        let cat = Catalogue::from_sources(&source(text), "juniper", &juniper_vendors())
            .expect("a QSFP+ group is a recognised kind, not a load error");
        let m = cat.model("TEST-QSFP").expect("model present");
        let ports = m.faceplate(Face::Front).expect("front face").ports();
        assert_eq!(ports.len(), 2);
        assert!(ports.iter().all(|p| p.kind == PortKind::QsfpPlus));
        assert_eq!(PortKind::QsfpPlus.token(), "QSFP+");
    }

    #[test]
    fn c13_parses_as_its_own_kind_distinct_from_c14() {
        // The sixth kind: a PDU's outlet is `C13`, a device's inlet is `C14`
        // — the two ends of one cord, never the same `PortKind` even though
        // the client mirrors one glyph for both (see the enum's doc comment).
        let text = "vendor: juniper\n\
             model: TEST-C13\n\
             rack_units: 1\n\
             reviewed_by: <named human>\n\
             source:\n  cite: \"fixture\"\n  read_on: \"2026-09-16\"\n\
             faceplates:\n  \
               - face: front\n    \
                 port_count: 2\n    \
                 port_groups:\n      \
                   - { kind: \"C13\", role: access, layout: single_row, count: 2, start_number: 1 }\n";
        let cat = Catalogue::from_sources(&source(text), "juniper", &juniper_vendors())
            .expect("a C13 group is a recognised kind, not a load error");
        let m = cat.model("TEST-C13").expect("model present");
        let ports = m.faceplate(Face::Front).expect("front face").ports();
        assert_eq!(ports.len(), 2);
        assert!(ports.iter().all(|p| p.kind == PortKind::C13));
        assert!(ports.iter().all(|p| p.kind != PortKind::C14));
        assert_eq!(PortKind::C13.token(), "C13");
    }

    #[test]
    fn nema_5_15_parses_as_two_kinds_distinct_from_each_other_and_from_c13_c14() {
        // The seventh and eighth kinds: a tower UPS's outlet bank is
        // `NemaP5_15R`, its captive input cord's plug is `NemaP5_15P` — the
        // mains equivalent of the `C13`/`C14` split just above, and never the
        // same `PortKind` as either.
        let text = "vendor: juniper\n\
             model: TEST-NEMA\n\
             rack_units: 1\n\
             reviewed_by: <named human>\n\
             source:\n  cite: \"fixture\"\n  read_on: \"2026-09-18\"\n\
             faceplates:\n  \
               - face: front\n    \
                 port_count: 1\n    \
                 port_groups:\n      \
                   - { kind: \"nema_5_15p\", role: access, layout: single_row, count: 1, start_number: 1 }\n  \
               - face: rear\n    \
                 port_count: 2\n    \
                 port_groups:\n      \
                   - { kind: \"nema_5_15r\", role: access, layout: single_row, count: 2, start_number: 1 }\n";
        let cat = Catalogue::from_sources(&source(text), "juniper", &juniper_vendors())
            .expect("nema_5_15r and nema_5_15p are recognised kinds, not a load error");
        let m = cat.model("TEST-NEMA").expect("model present");
        let front = m.faceplate(Face::Front).expect("front face").ports();
        assert!(front.iter().all(|p| p.kind == PortKind::NemaP5_15P));
        let rear = m.faceplate(Face::Rear).expect("rear face").ports();
        assert!(rear.iter().all(|p| p.kind == PortKind::NemaP5_15R));
        assert!(rear.iter().all(|p| p.kind != PortKind::NemaP5_15P));
        assert!(rear
            .iter()
            .all(|p| p.kind != PortKind::C13 && p.kind != PortKind::C14));
        assert_eq!(PortKind::NemaP5_15R.token(), "nema_5_15r");
        assert_eq!(PortKind::NemaP5_15P.token(), "nema_5_15p");
    }

    #[test]
    fn duplicate_port_number_is_refused_for_qsfp_plus_too() {
        // The per-kind duplicate-number gate (`gate_no_duplicate_numbers`)
        // keys on `PortKind`, not on a hard-coded set of the original four —
        // two overlapping QSFP+ groups must be caught exactly like two
        // overlapping RJ45 groups are above.
        let text = "vendor: juniper\n\
             model: TEST-QDUP\n\
             rack_units: 1\n\
             reviewed_by: <named human>\n\
             source:\n  cite: \"fixture\"\n  read_on: \"2026-09-14\"\n\
             faceplates:\n  \
               - face: rear\n    \
                 port_count: 4\n    \
                 port_groups:\n      \
                   - { kind: \"QSFP+\", role: uplink, layout: single_row, count: 2, start_number: 0 }\n      \
                   - { kind: \"QSFP+\", role: uplink, layout: single_row, count: 2, start_number: 1 }\n";
        let e = Catalogue::from_sources(&source(text), "juniper", &juniper_vendors())
            .expect_err("QSFP+ port number 1 is now claimed by both groups");
        assert_eq!(e.gate, CatalogueGate::DuplicatePortNumber);
    }

    #[test]
    fn duplicate_port_number_is_refused() {
        // Two RJ45 groups whose ranges overlap (1-12 and 10-13) — a real
        // mistake, unlike two DIFFERENT kinds sharing a starting number
        // (which is normal hardware and is what `good_model_text` itself
        // does with its RJ45 and SFP+ groups).
        let text = "vendor: juniper\n\
             model: TEST-DUP\n\
             rack_units: 1\n\
             reviewed_by: <named human>\n\
             source:\n  cite: \"fixture\"\n  read_on: \"2026-09-14\"\n\
             faceplates:\n  \
               - face: front\n    \
                 port_count: 16\n    \
                 port_groups:\n      \
                   - { kind: \"RJ45\", role: access, layout: paired_columns, count: 12, start_number: 1 }\n      \
                   - { kind: \"RJ45\", role: uplink, layout: paired_rows, count: 4, start_number: 10 }\n";
        let e = Catalogue::from_sources(&source(text), "juniper", &juniper_vendors())
            .expect_err("ports 10, 11 and 12 are now RJ45 numbers claimed by both groups");
        assert_eq!(e.gate, CatalogueGate::DuplicatePortNumber);
    }

    #[test]
    fn port_count_disagreeing_with_the_plate_is_refused() {
        let text = good_model_text("").replace("port_count: 14", "port_count: 13");
        let e = Catalogue::from_sources(&source(&text), "juniper", &juniper_vendors())
            .expect_err("13 disagrees with the 12+2 the groups actually declare");
        assert_eq!(e.gate, CatalogueGate::PortCountMismatch);
    }

    #[test]
    fn uplink_before_access_is_refused() {
        let text = good_model_text("").replacen(
            "port_groups:\n      \
               - { kind: \"RJ45\", role: access, layout: paired_columns, count: 12, start_number: 1 }\n      \
               - { kind: \"SFP+\", role: uplink, layout: paired_rows, count: 2, start_number: 1 }\n",
            "port_groups:\n      \
               - { kind: \"SFP+\", role: uplink, layout: paired_rows, count: 2, start_number: 1 }\n      \
               - { kind: \"RJ45\", role: access, layout: paired_columns, count: 12, start_number: 1 }\n",
            1,
        );
        let e = Catalogue::from_sources(&source(&text), "juniper", &juniper_vendors())
            .expect_err("the uplink group now precedes the access group");
        assert_eq!(e.gate, CatalogueGate::UplinkNotRight);
    }

    #[test]
    fn vendor_not_in_platforms_yaml_is_refused() {
        let text =
            good_model_text("").replace("vendor: juniper", "vendor: definitely-not-a-vendor");
        let e = Catalogue::from_sources(&source(&text), "juniper", &juniper_vendors())
            .expect_err("the vendor id has no row in the registry passed in");
        assert_eq!(e.gate, CatalogueGate::VendorUnknown);
    }

    #[test]
    fn reviewed_by_is_mandatory() {
        let text = good_model_text("").replace("reviewed_by: <named human>\n", "");
        let e = Catalogue::from_sources(&source(&text), "juniper", &juniper_vendors())
            .expect_err("a model with no reviewed_by must be refused");
        assert_eq!(e.gate, CatalogueGate::ReviewedByMissing);
    }

    #[test]
    fn numbering_is_odd_over_even_in_12port_groups_with_uplinks_right() {
        // A single 24-port access bank plus a 4-port uplink bank, numbered
        // from 1 — the literal UI-SPEC wording, checked digit for digit.
        let text = "vendor: juniper\n\
             model: TEST-24P\n\
             rack_units: 1\n\
             reviewed_by: <named human>\n\
             source:\n  cite: \"fixture\"\n  read_on: \"2026-09-14\"\n\
             faceplates:\n  \
               - face: front\n    \
                 port_count: 28\n    \
                 port_groups:\n      \
                   - { kind: \"RJ45\", role: access, layout: paired_columns, count: 24, start_number: 1 }\n      \
                   - { kind: \"SFP+\", role: uplink, layout: paired_rows, count: 4, start_number: 1 }\n";
        let cat = Catalogue::from_sources(&source(text), "juniper", &juniper_vendors())
            .expect("a real 24+4 layout loads");
        let m = cat.model("TEST-24P").expect("model present");
        let ports = m.faceplate(Face::Front).expect("front face").ports();

        // Odd over even, for every one of the 24 access ports.
        for p in ports.iter().filter(|p| p.kind == PortKind::Rj45) {
            let number = p.number.expect("a Counted port always has a number");
            let want_row = if number % 2 == 1 {
                Row::Top
            } else {
                Row::Bottom
            };
            assert_eq!(p.row, want_row, "port {number} is on the wrong row");
        }

        // A gap opens the 13th access port (0-based index 12) — the boundary
        // between the two 12-port blocks of the one 24-port group.
        let port_13 = ports
            .iter()
            .find(|p| p.kind == PortKind::Rj45 && p.number == Some(13))
            .expect("port 13 exists");
        assert!(
            port_13.group_gap_before,
            "the second 12-block must open a gap"
        );
        let port_2 = ports
            .iter()
            .find(|p| p.kind == PortKind::Rj45 && p.number == Some(2))
            .expect("port 2 exists");
        assert!(!port_2.group_gap_before, "no gap mid-block");

        // Uplinks right: every uplink port's column is to the right of every
        // access port's column, and the first uplink opens a new-group gap.
        let max_access_column = ports
            .iter()
            .filter(|p| !p.uplink)
            .map(|p| p.column)
            .max()
            .expect("access ports exist");
        let min_uplink_column = ports
            .iter()
            .filter(|p| p.uplink)
            .map(|p| p.column)
            .min()
            .expect("uplink ports exist");
        assert!(min_uplink_column > max_access_column);
        let first_uplink = ports
            .iter()
            .find(|p| p.uplink && p.number == Some(1))
            .expect("uplink port 1 exists");
        assert!(first_uplink.group_gap_before);

        // paired_rows, read off the design board: top row is the first half
        // in reading order (1, 2), bottom row is the second half (3, 4).
        let by_number = |n: u32| {
            ports
                .iter()
                .find(|p| p.uplink && p.number == Some(n))
                .unwrap_or_else(|| panic!("uplink port {n} exists"))
        };
        assert_eq!(by_number(1).row, Row::Top);
        assert_eq!(by_number(2).row, Row::Top);
        assert_eq!(by_number(3).row, Row::Bottom);
        assert_eq!(by_number(4).row, Row::Bottom);
    }

    #[test]
    fn a_rear_face_model_round_trips() {
        let text = "vendor: juniper\n\
             model: TEST-REAR\n\
             rack_units: 1\n\
             reviewed_by: <named human>\n\
             source:\n  cite: \"fixture\"\n  read_on: \"2026-09-14\"\n\
             faceplates:\n  \
               - face: front\n    \
                 port_count: 2\n    \
                 port_groups:\n      \
                   - { kind: \"RJ45\", role: access, layout: single_row, count: 2, start_number: 1 }\n  \
               - face: rear\n    \
                 port_count: 2\n    \
                 port_groups:\n      \
                   - { kind: \"SFP+\", role: uplink, layout: single_row, count: 2, start_number: 0 }\n\
             psu_slots:\n  \
               - { name: \"PSU 0\", hot_swap: true, face: rear, position: { row: single, column: 0 } }\n  \
               - { name: \"PSU 1\", hot_swap: true, face: rear, position: { row: single, column: 1 } }\n";
        let cat = Catalogue::from_sources(&source(text), "juniper", &juniper_vendors())
            .expect("a model with a rear faceplate loads");
        let m = cat.model("TEST-REAR").expect("model present");
        assert!(m.faceplate(Face::Front).is_some());
        let rear = m.faceplate(Face::Rear).expect("rear face present");
        let ports = rear.ports();
        assert_eq!(ports.len(), 2);
        assert_eq!(ports[0].number, Some(0));
        assert_eq!(ports[1].number, Some(1));
        assert!(ports.iter().all(|p| p.row == Row::Single));
        assert_eq!(m.psu_slots.len(), 2);
        assert_eq!(m.psu_slots[0].name, "PSU 0");
        assert!(m.psu_slots[0].hot_swap);
        assert_eq!(m.psu_slots[0].face, Face::Rear);
        assert_eq!(m.psu_slots[0].position.row, Row::Single);
        assert_eq!(m.psu_slots[0].position.column, 0);
        assert_eq!(m.psu_slots[1].position.column, 1);
    }

    #[test]
    fn psu_slots_absent_is_an_empty_list_not_an_error() {
        // A passive panel or a captive-corded device omits `psu_slots`
        // entirely — see `corpus/catalogue/panduit/*.yaml` and
        // `corpus/catalogue/apc/*.yaml`.
        let text = good_model_text("");
        let cat = Catalogue::from_sources(&source(&text), "juniper", &juniper_vendors())
            .expect("a model with no psu_slots key loads");
        let m = cat.model("TEST-12P").expect("model present");
        assert!(m.psu_slots.is_empty());
    }

    #[test]
    fn a_named_group_round_trips_with_no_number() {
        // The EX4300's `me0`/`con` shape: a management group naming one
        // port, no `count`, no `start_number`.
        let text = "vendor: juniper\n\
             model: TEST-NAMED\n\
             rack_units: 1\n\
             reviewed_by: <named human>\n\
             source:\n  cite: \"fixture\"\n  read_on: \"2026-09-16\"\n\
             faceplates:\n  \
               - face: front\n    \
                 port_count: 1\n    \
                 port_groups:\n      \
                   - { kind: \"RJ45\", role: access, layout: single_row, count: 1, start_number: 1 }\n  \
               - face: rear\n    \
                 port_count: 2\n    \
                 port_groups:\n      \
                   - { kind: \"RJ45\", role: management, layout: single_row, names: [me0] }\n      \
                   - { kind: \"RJ45\", role: console, layout: single_row, names: [con] }\n";
        let cat = Catalogue::from_sources(&source(text), "juniper", &juniper_vendors())
            .expect("a named management/console group loads");
        let m = cat.model("TEST-NAMED").expect("model present");
        let ports = m.faceplate(Face::Rear).expect("rear face").ports();
        assert_eq!(ports.len(), 2);
        let me0 = ports
            .iter()
            .find(|p| p.name.as_deref() == Some("me0"))
            .expect("me0 present");
        assert_eq!(me0.number, None);
        assert_eq!(me0.role, Role::Management);
        let con = ports
            .iter()
            .find(|p| p.name.as_deref() == Some("con"))
            .expect("con present");
        assert_eq!(con.number, None);
        assert_eq!(con.role, Role::Console);
    }

    #[test]
    fn a_group_with_both_names_and_count_is_refused() {
        let text = "vendor: juniper\n\
             model: TEST-BOTH\n\
             rack_units: 1\n\
             reviewed_by: <named human>\n\
             source:\n  cite: \"fixture\"\n  read_on: \"2026-09-16\"\n\
             faceplates:\n  \
               - face: front\n    \
                 port_count: 1\n    \
                 port_groups:\n      \
                   - { kind: \"RJ45\", role: access, layout: single_row, names: [me0], count: 1, start_number: 0 }\n";
        let e = Catalogue::from_sources(&source(text), "juniper", &juniper_vendors())
            .expect_err("a group cannot declare both names and count");
        assert_eq!(e.gate, CatalogueGate::PortNamingInvalid);
    }

    #[test]
    fn a_management_group_without_names_is_refused() {
        let text = "vendor: juniper\n\
             model: TEST-MGMT-NONAMED\n\
             rack_units: 1\n\
             reviewed_by: <named human>\n\
             source:\n  cite: \"fixture\"\n  read_on: \"2026-09-16\"\n\
             faceplates:\n  \
               - face: rear\n    \
                 port_count: 1\n    \
                 port_groups:\n      \
                   - { kind: \"RJ45\", role: management, layout: single_row, count: 1, start_number: 0 }\n";
        let e = Catalogue::from_sources(&source(text), "juniper", &juniper_vendors())
            .expect_err("a management group must name its port, not number it");
        assert_eq!(e.gate, CatalogueGate::PortNamingInvalid);
    }

    #[test]
    fn missing_front_face_is_refused() {
        let text = "vendor: juniper\n\
             model: TEST-NOFRONT\n\
             rack_units: 1\n\
             reviewed_by: <named human>\n\
             source:\n  cite: \"fixture\"\n  read_on: \"2026-09-14\"\n\
             faceplates:\n  \
               - face: rear\n    \
                 port_count: 1\n    \
                 port_groups:\n      \
                   - { kind: \"C14\", role: access, layout: single_row, count: 1, start_number: 1 }\n";
        let e = Catalogue::from_sources(&source(text), "juniper", &juniper_vendors())
            .expect_err("a model with only a rear face must be refused");
        assert_eq!(e.gate, CatalogueGate::MissingFrontFace);
    }

    #[test]
    fn the_shipped_juniper_catalogue_loads() {
        let cat = Catalogue::load_platform(&repo_root(), "juniper")
            .expect("the shipped Juniper catalogue loads");
        assert!(!cat.models().is_empty(), "at least one real model ships");
        let ex = cat
            .model("EX4300-48P")
            .expect("the EX4300-48P entry is reachable by name");
        assert_eq!(ex.vendor, "juniper");
        let front = ex.faceplate(Face::Front).expect("front face present");
        let ports = front.ports();
        assert_eq!(
            ports.iter().filter(|p| p.kind == PortKind::Rj45).count(),
            48
        );
        // Numbered from 0, per the approved design board — see the module
        // doc on `Layout::PairedColumns`.
        assert!(ports
            .iter()
            .any(|p| p.number == Some(0) && p.row == Row::Top));
        assert!(ports
            .iter()
            .any(|p| p.number == Some(1) && p.row == Row::Bottom));

        // The front uplink module genuinely is SFP+ (EX-UM-4X4SFP); the rear
        // built-in ports genuinely are QSFP+ — the catalogue must say so,
        // not collapse the rear ports into the nearer-but-wrong glyph.
        assert_eq!(
            ports.iter().filter(|p| p.kind == PortKind::SfpPlus).count(),
            4
        );
        let rear = ex.faceplate(Face::Rear).expect("rear face present");
        let rear_ports = rear.ports();
        // 4 built-in QSFP+ uplinks, plus the rear-panel `me0` management and
        // `con` console RJ45 ports (ADR-0050 §5) — see the file's own header
        // for the citation and date these were added under.
        assert_eq!(rear_ports.len(), 6);
        assert_eq!(
            rear_ports
                .iter()
                .filter(|p| p.kind == PortKind::QsfpPlus)
                .count(),
            4
        );
        let me0 = rear_ports
            .iter()
            .find(|p| p.name.as_deref() == Some("me0"))
            .expect("me0 present on the rear face");
        assert_eq!(me0.kind, PortKind::Rj45);
        assert_eq!(me0.role, Role::Management);
        assert_eq!(me0.number, None);
        let con = rear_ports
            .iter()
            .find(|p| p.name.as_deref() == Some("con"))
            .expect("con present on the rear face");
        assert_eq!(con.kind, PortKind::Rj45);
        assert_eq!(con.role, Role::Console);
        assert_eq!(con.number, None);

        // Both PSUs are recorded as positioned, hot-swappable rear slots
        // (ADR-0050 §3/§4), not a count.
        assert_eq!(ex.psu_slots.len(), 2);
        assert!(ex.psu_slots.iter().all(|s| s.hot_swap));
        assert!(ex.psu_slots.iter().all(|s| s.face == Face::Rear));
    }

    #[test]
    fn the_shipped_shelf_has_no_ports_and_carries_its_form() {
        let cat = Catalogue::load_platform(&repo_root(), "tripplite")
            .expect("the shipped Tripp Lite catalogue loads");
        let m = cat
            .model("SRSHELF2P1U")
            .expect("the SRSHELF2P1U entry is reachable by name");
        assert_eq!(m.form, Some(ModelForm::Shelf));
        assert!(m.psu_slots.is_empty(), "a shelf has no PSU inlet");
        let front = m.faceplate(Face::Front).expect("front face present");
        assert_eq!(front.port_count, 0);
        assert!(front.ports().is_empty(), "a shelf has no ports at all");
    }

    #[test]
    fn the_shipped_outlet_box_has_rj45_front_and_a_punchdown_rear() {
        let cat =
            Catalogue::load_platform(&repo_root(), "icc").expect("the shipped ICC catalogue loads");
        let m = cat
            .model("IC107SBTWH")
            .expect("the IC107SBTWH entry is reachable by name");
        assert_eq!(m.form, Some(ModelForm::Outlet));
        let front = m
            .faceplate(Face::Front)
            .expect("front face present")
            .ports();
        assert_eq!(front.len(), 12);
        assert!(front.iter().all(|p| p.kind == PortKind::Rj45));
        let rear = m.faceplate(Face::Rear).expect("rear face present").ports();
        assert_eq!(
            rear.len(),
            12,
            "twelve punchdown positions, expressed as the nearest kind the format has"
        );
        assert!(rear.iter().all(|p| p.kind == PortKind::Rj45));
    }

    #[test]
    fn the_shipped_tower_ups_has_nema_outlets_and_no_psu_slots() {
        let cat = Catalogue::load_platform(&repo_root(), "cyberpower")
            .expect("the shipped CyberPower catalogue loads");
        let m = cat
            .model("PR1500LCDRT2U")
            .expect("the PR1500LCDRT2U entry is reachable by name");
        assert_eq!(m.rack_units, 2);
        assert!(
            m.psu_slots.is_empty(),
            "the input cord is captive — no inlet socket to name"
        );
        let rear = m.faceplate(Face::Rear).expect("rear face present").ports();
        assert_eq!(rear.len(), 8);
        assert!(rear.iter().all(|p| p.kind == PortKind::NemaP5_15R));
        let front = m.faceplate(Face::Front).expect("front face present");
        assert!(
            front.ports().is_empty(),
            "the LCD/button panel has no ports"
        );
    }
}
