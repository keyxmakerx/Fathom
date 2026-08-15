//! Typed corpus model per 61 §3 (the entry field reference), restricted to the
//! fields the finder core reads. Field names follow the spec exactly; a field
//! not listed in 61 §3 does not exist here.

/// The risk enum. Exactly three values, never a fourth (conventions; 61 §4.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Risk {
    ReadOnly,
    ChangesConfig,
    Disruptive,
}

impl Risk {
    pub fn parse(s: &str) -> Option<Risk> {
        match s {
            "ReadOnly" => Some(Risk::ReadOnly),
            "ChangesConfig" => Some(Risk::ChangesConfig),
            "Disruptive" => Some(Risk::Disruptive),
            _ => None,
        }
    }

    /// The band label, verbatim from the card (61 §4.1).
    pub fn label(self) -> &'static str {
        match self {
            Risk::ReadOnly => "READ-ONLY — SAFE ON PRODUCTION",
            Risk::ChangesConfig => "CHANGES CONFIG — NEEDS A COMMIT",
            Risk::Disruptive => "DISRUPTIVE — DROPS LIVE TRAFFIC",
        }
    }

    /// The ranking prior, 16 §8.3: a safety control, not a relevance signal.
    pub fn prior_milli(self) -> i64 {
        match self {
            Risk::ReadOnly => 50,
            Risk::ChangesConfig => -100,
            Risk::Disruptive => -250,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Operational,
    Configuration,
    Shell,
    PipeFilter,
}

impl Mode {
    pub fn parse(s: &str) -> Option<Mode> {
        match s {
            "operational" => Some(Mode::Operational),
            "configuration" => Some(Mode::Configuration),
            "shell" => Some(Mode::Shell),
            "pipe-filter" => Some(Mode::PipeFilter),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Status {
    Draft,
    #[default]
    Active,
    Deprecated,
    Withdrawn,
}

impl Status {
    pub fn parse(s: &str) -> Option<Status> {
        match s {
            "draft" => Some(Status::Draft),
            "active" => Some(Status::Active),
            "deprecated" => Some(Status::Deprecated),
            "withdrawn" => Some(Status::Withdrawn),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct OutputField {
    pub field: String,
    pub means: String,
    pub want: Option<String>,
    pub tell: Option<String>,
    pub join_key: bool,
}

#[derive(Debug, Clone)]
pub struct SlotDecl {
    pub name: String,
    /// `binds: null` means runtime-only — the value comes out of another
    /// command's output, never the graph (16 §16.4).
    pub binds_graph: bool,
    pub accepts: Vec<String>,
    pub placeholder: String,
    pub required: bool,
}

#[derive(Debug, Clone)]
pub struct Requires {
    pub slot: String,
    pub from: String,
    pub field: String,
}

#[derive(Debug, Clone, Default)]
pub struct Explain {
    pub terse: String,
    pub explained: String,
    pub teaching: String,
}

/// 61 §3.1's `verified_on` — `{ platform, version }`, *"the box the author
/// actually ran this on"*.
///
/// Its ABSENCE is the thing that matters, and it is why this type exists at
/// all. 61 §3.1: *"Absent ⇒ the entry renders an `unverified` margin tab. This
/// is the field that keeps the corpus honest and it is deliberately not
/// required, because requiring it would produce fabricated values."* ADR-0027
/// §2 says the same in the UI's words.
///
/// It is a different claim from `reviewed_by`. A named human read the entry;
/// this says somebody put it into a box and watched what came back. The corpus
/// today has neither, but the two will not arrive together — the named expert
/// review is queued and the conformance lab is not — so the loader must be able
/// to tell them apart. Before 2026-08-15 it could not: the field was simply not
/// parsed, and the module keyed ADR-0027's label on `reviewed_by` instead.
///
/// The platform is carried separately from the entry's own `platform` on
/// purpose: `Entry::platform` says what the entry is *for*, this says what it
/// was *run on*, and `derive_for` (61 §3.2) exists precisely to make sibling
/// entries for other platforms with **no inherited `verified_on`**.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedOn {
    pub platform: String,
    pub version: String,
}

/// One command entry, 61 §3.
#[derive(Debug, Clone)]
pub struct Entry {
    pub id: String,
    pub line: usize,
    pub cmd: String,
    pub mode: Mode,
    pub platform: String,
    pub risk: Risk,
    pub risk_caption_override: Option<String>,
    pub blast_radius: Option<String>,
    pub reversible: Option<String>,
    pub scope_required: Vec<String>,
    pub commit_model: Option<String>,
    pub domain: String,
    pub weight: i64,
    pub tags: Vec<String>,
    pub status: Status,
    pub title: Option<String>,
    pub answers: String,
    pub aka: Vec<String>,
    pub concepts: Vec<String>,
    pub symptoms: Vec<String>,
    pub read_field: String,
    pub output_fields: Vec<OutputField>,
    pub slots: Vec<SlotDecl>,
    pub requires: Vec<Requires>,
    pub supplies: Vec<String>,
    pub next_if_bad: Vec<String>,
    pub related: Vec<String>,
    pub related_rules: Vec<String>,
    pub explain: Explain,
    pub reviewed_by: String,
    /// 61 §3.1, required: *"ISO. Lint warns past 24 months."* Loaded because
    /// ADR-0027 §3's stamp is three facts and this is the only date `61` §3
    /// declares — see `fathom_wasm::protocol::verification_stamp` for why it is
    /// printed as a review date and never as a verification date.
    pub reviewed_on: String,
    /// 61 §3.1, optional. `None` ⇒ nobody has run this on a box ⇒ ADR-0027 §2's
    /// **unverified**. This is the field the label keys on.
    pub verified_on: Option<VerifiedOn>,
    pub versions: String,
}

/// An explainer entry — only what the finder needs: the id (so `next_if_bad`
/// references resolve), the class, the title (concept labels), reviewed_by
/// (invariant-10 inventory).
#[derive(Debug, Clone)]
pub struct ExplainerEntry {
    pub id: String,
    pub class: String,
    pub title: Option<String>,
    pub reviewed_by: Option<String>,
}

/// A rule, id-and-reviewer only — loaded so `related_rules` references can be
/// checked and the invariant-10 inventory covers the whole bundle set.
#[derive(Debug, Clone)]
pub struct RuleLite {
    pub id: String,
    pub reviewed_by: Option<String>,
}

/// Declared-but-not-yet-authored concept ids from the command bundle's
/// `new_concepts` block, keyed by proposed kind category.
#[derive(Debug, Clone, Default)]
pub struct DeclaredConcepts {
    /// (kind category name, concept path without the `concept:` prefix)
    pub entries: Vec<(String, String)>,
}

#[derive(Debug, Clone, Default)]
pub struct BundleInfo {
    pub id: String,
    pub platform: String,
    pub declared_entry_count: i64,
    pub domains: Vec<String>,
}

/// The loaded seed corpus: command bundle + explainer bundle + rule bundle.
#[derive(Debug, Clone)]
pub struct Corpus {
    pub bundle: BundleInfo,
    pub entries: Vec<Entry>,
    pub explainers: Vec<ExplainerEntry>,
    pub rules: Vec<RuleLite>,
    pub declared_concepts: DeclaredConcepts,
    /// `corpus/concepts/*.yaml` as `(name, text)`, in load order — the seed
    /// concept graph, held as text until `build_concept_table` has lexicons to
    /// normalise its surfaces with.
    ///
    /// Text rather than a parsed tree because this crate used to get the graph
    /// from `include_str!("seed_concepts.yaml")`, which put 8 782 bytes of YAML
    /// in the WebAssembly data section against `44` §5.2's ceiling. It travels
    /// over `OP_INIT` with the rest of the corpus now.
    pub concept_sources: Vec<(String, String)>,
}
