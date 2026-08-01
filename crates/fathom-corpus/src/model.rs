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
}
