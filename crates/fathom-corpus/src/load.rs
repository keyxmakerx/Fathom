//! Bundle loaders: subset-parsed `Node` trees → the typed model. The corpus
//! bundles use folded (`>`) block scalars, so they parse under
//! `Profile::Corpus` — the one extension the corpus profile carries.

use std::fs;
use std::path::Path;

use fathom_schema::subset::{parse_profile, Profile};
use fathom_schema::value::{Node, Value};

use crate::model::*;

#[derive(Debug, Clone)]
pub struct LoadError {
    pub file: String,
    pub line: usize,
    pub message: String,
}

impl std::fmt::Display for LoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}:{}: {}", self.file, self.line, self.message)
    }
}

fn err(file: &str, line: usize, message: impl Into<String>) -> LoadError {
    LoadError {
        file: file.to_owned(),
        line,
        message: message.into(),
    }
}

/// Which corpus subdirectory a source belongs to. Order is the load order.
///
/// `Concepts` is declared last on purpose. The derived `Ord` is what
/// `load_corpus_sources` sorts by, and it is also the wire order the assembler
/// packs in, so promoting the new variant above an existing one would reorder
/// every frame Fathom has ever built for no gain — a silent determinism change
/// (invariant 9) in a commit that is supposed to move bytes and nothing else.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Section {
    Commands,
    Explainers,
    Rules,
    Concepts,
}

/// One corpus bundle as text. `name` is used verbatim as `LoadError::file`;
/// it is a label, never opened.
#[derive(Debug, Clone)]
pub struct SourceFile {
    pub section: Section,
    pub name: String,
    pub source: String,
}

/// The corpus subdirectories, in load order. One list, named once, because four
/// places have to agree on it: this loader, the artifact assembler, and two test
/// helpers. Until `concepts/` was added they agreed by four separately
/// hand-written copies of the same array — which is a shape that fails by
/// shipping a page missing one whole section while every test that reads the
/// directory itself still passes.
pub const SECTION_DIRS: [(Section, &str); 4] = [
    (Section::Commands, "commands"),
    (Section::Explainers, "explainers"),
    (Section::Rules, "rules"),
    (Section::Concepts, "concepts"),
];

/// Load the seed bundles from a corpus root
/// (`commands/`, `explainers/`, `rules/`, `concepts/`, each holding `*.yaml`).
pub fn load_corpus(root: &Path) -> Result<Corpus, LoadError> {
    let mut files = Vec::new();
    for (section, dir) in SECTION_DIRS {
        for path in yaml_files(&root.join(dir))? {
            let name = path.display().to_string();
            let source =
                fs::read_to_string(&path).map_err(|e| err(&name, 0, format!("read: {e}")))?;
            files.push(SourceFile {
                section,
                name,
                source,
            });
        }
    }
    load_corpus_sources(&files)
}

/// The filesystem-free load path — WO-07's `OP_INIT` and any host without a
/// filesystem. Sorts a copy by `(section, name)` (mirroring `yaml_files`'s
/// sorted listing), refuses a duplicate `(section, name)` with a `LoadError`
/// naming the duplicate (`message` starts `duplicate source`), then loads
/// exactly as `load_corpus` does.
pub fn load_corpus_sources(files: &[SourceFile]) -> Result<Corpus, LoadError> {
    let mut ordered: Vec<&SourceFile> = files.iter().collect();
    ordered.sort_by(|a, b| (a.section, &a.name).cmp(&(b.section, &b.name)));
    for pair in ordered.windows(2) {
        if pair[0].section == pair[1].section && pair[0].name == pair[1].name {
            let name = &pair[1].name;
            return Err(err(name, 0, format!("duplicate source `{name}`")));
        }
    }

    let mut entries = Vec::new();
    let mut bundle = BundleInfo::default();
    let mut declared = DeclaredConcepts::default();
    let mut explainers = Vec::new();
    let mut rules = Vec::new();
    let mut concept_sources = Vec::new();
    for f in ordered {
        match f.section {
            Section::Commands => {
                let (info, mut es, decl) = load_command_bundle(&f.source, &f.name)?;
                bundle = info;
                entries.append(&mut es);
                declared.entries.extend(decl.entries);
            }
            Section::Explainers => {
                explainers.append(&mut load_explainer_bundle(&f.source, &f.name)?);
            }
            Section::Rules => rules.append(&mut load_rule_bundle(&f.source, &f.name)?),
            // Carried as text, not parsed here. `build_concept_table` needs the
            // lexicons to normalise a surface phrase, and the lexicons are
            // built from the entries — which are not loaded yet at this point.
            // Parsing twice to avoid holding a string would cost more than the
            // string.
            Section::Concepts => concept_sources.push((f.name.clone(), f.source.clone())),
        }
    }
    Ok(Corpus {
        bundle,
        entries,
        explainers,
        rules,
        declared_concepts: declared,
        concept_sources,
    })
}

/// Deterministic file listing: sorted by file name.
fn yaml_files(dir: &Path) -> Result<Vec<std::path::PathBuf>, LoadError> {
    let mut out = Vec::new();
    let rd = fs::read_dir(dir)
        .map_err(|e| err(&dir.display().to_string(), 0, format!("read_dir: {e}")))?;
    for entry in rd {
        let entry = entry.map_err(|e| err(&dir.display().to_string(), 0, e.to_string()))?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("yaml") {
            out.push(path);
        }
    }
    out.sort();
    Ok(out)
}

fn parse_source(source: &str, file: &str) -> Result<Node, LoadError> {
    parse_profile(source, Profile::Corpus).map_err(|e| err(file, e.line, e.message.clone()))
}

// --- field access helpers ---------------------------------------------------

fn req<'a>(n: &'a Node, key: &str, file: &str) -> Result<&'a Node, LoadError> {
    n.get(key)
        .ok_or_else(|| err(file, n.line, format!("missing required field `{key}`")))
}

fn req_str(n: &Node, key: &str, file: &str) -> Result<String, LoadError> {
    let v = req(n, key, file)?;
    v.as_str()
        .map(|s| s.trim_end().to_owned())
        .ok_or_else(|| err(file, v.line, format!("`{key}` must be a string")))
}

fn opt_str(n: &Node, key: &str) -> Option<String> {
    n.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.trim_end().to_owned())
}

fn opt_int(n: &Node, key: &str) -> Option<i64> {
    n.get(key).and_then(|v| v.as_int())
}

fn opt_bool(n: &Node, key: &str) -> Option<bool> {
    n.get(key).and_then(|v| v.as_bool())
}

fn str_seq(n: &Node, key: &str) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(seq) = n.get(key).and_then(|v| v.as_seq()) {
        for item in seq {
            match &item.value {
                Value::Str(s) => out.push(s.trim_end().to_owned()),
                Value::Int(i) => out.push(i.to_string()),
                _ => {}
            }
        }
    }
    out
}

// --- command bundle ----------------------------------------------------------

fn load_command_bundle(
    source: &str,
    file: &str,
) -> Result<(BundleInfo, Vec<Entry>, DeclaredConcepts), LoadError> {
    let root = parse_source(source, file)?;
    let mut info = BundleInfo::default();
    if let Some(b) = root.get("corpus_bundle") {
        info.id = opt_str(b, "id").unwrap_or_default();
        info.platform = opt_str(b, "platform").unwrap_or_default();
        info.declared_entry_count = opt_int(b, "entry_count").unwrap_or(0);
        info.domains = str_seq(b, "domains");
    }
    let mut declared = DeclaredConcepts::default();
    if let Some(nc) = root.get("new_concepts").and_then(|v| v.as_map()) {
        for (category, list) in nc {
            if let Some(seq) = list.as_seq() {
                for item in seq {
                    if let Some(s) = item.as_str() {
                        declared.entries.push((category.clone(), s.to_owned()));
                    }
                }
            }
        }
    }
    let entries_node = req(&root, "entries", file)?;
    let seq = entries_node
        .as_seq()
        .ok_or_else(|| err(file, entries_node.line, "`entries` must be a sequence"))?;
    let mut entries = Vec::new();
    for item in seq {
        entries.push(load_entry(item, file)?);
    }
    Ok((info, entries, declared))
}

fn load_entry(n: &Node, file: &str) -> Result<Entry, LoadError> {
    let id = req_str(n, "id", file)?;
    let platform = req_str(n, "platform", file)?;
    let mode_s = req_str(n, "mode", file)?;
    let mode = Mode::parse(&mode_s)
        .ok_or_else(|| err(file, n.line, format!("{id}: unknown mode `{mode_s}`")))?;
    let risk_s = req_str(n, "risk", file)?;
    let risk = Risk::parse(&risk_s).ok_or_else(|| {
        err(
            file,
            n.line,
            format!("{id}: unknown risk `{risk_s}` (exactly three spellings exist)"),
        )
    })?;
    let status = match opt_str(n, "status") {
        None => Status::Active,
        Some(s) => Status::parse(&s)
            .ok_or_else(|| err(file, n.line, format!("{id}: unknown status `{s}`")))?,
    };
    let mut output_fields = Vec::new();
    if let Some(seq) = n.get("output_fields").and_then(|v| v.as_seq()) {
        for f in seq {
            output_fields.push(OutputField {
                field: req_str(f, "field", file)?,
                means: opt_str(f, "means").unwrap_or_default(),
                want: opt_str(f, "want").filter(|w| w != "any"),
                tell: opt_str(f, "tell"),
                join_key: opt_bool(f, "join_key").unwrap_or(false),
            });
        }
    }
    let mut slots = Vec::new();
    if let Some(seq) = n.get("slots").and_then(|v| v.as_seq()) {
        for s in seq {
            let binds_graph = match s.get("binds") {
                Some(b) => !matches!(b.value, Value::Null),
                None => false,
            };
            slots.push(SlotDecl {
                name: req_str(s, "name", file)?,
                binds_graph,
                accepts: str_seq(s, "accepts"),
                placeholder: req_str(s, "placeholder", file)?,
                required: opt_bool(s, "required").unwrap_or(true),
            });
        }
    }
    let mut requires = Vec::new();
    if let Some(seq) = n.get("requires").and_then(|v| v.as_seq()) {
        for r in seq {
            requires.push(Requires {
                slot: req_str(r, "slot", file)?,
                from: req_str(r, "from", file)?,
                field: req_str(r, "field", file)?,
            });
        }
    }
    let explain = match n.get("explain") {
        Some(e) => Explain {
            terse: opt_str(e, "terse").unwrap_or_default(),
            explained: opt_str(e, "explained").unwrap_or_default(),
            teaching: opt_str(e, "teaching").unwrap_or_default(),
        },
        None => Explain::default(),
    };
    Ok(Entry {
        line: n.line,
        cmd: req_str(n, "cmd", file)?,
        mode,
        platform,
        risk,
        risk_caption_override: opt_str(n, "risk_caption_override"),
        blast_radius: opt_str(n, "blast_radius"),
        reversible: opt_str(n, "reversible"),
        scope_required: str_seq(n, "scope_required"),
        commit_model: opt_str(n, "commit_model"),
        domain: req_str(n, "domain", file)?,
        weight: opt_int(n, "weight").unwrap_or(1),
        tags: str_seq(n, "tags"),
        status,
        title: opt_str(n, "title"),
        answers: req_str(n, "answers", file)?,
        aka: str_seq(n, "aka"),
        concepts: str_seq(n, "concepts"),
        symptoms: str_seq(n, "symptoms"),
        read_field: req_str(n, "read_field", file)?,
        output_fields,
        slots,
        requires,
        supplies: str_seq(n, "supplies"),
        next_if_bad: str_seq(n, "next_if_bad"),
        related: str_seq(n, "related"),
        related_rules: str_seq(n, "related_rules"),
        explain,
        reviewed_by: req_str(n, "reviewed_by", file)?,
        reviewed_on: req_str(n, "reviewed_on", file)?,
        verified_on: load_verified_on(n, file)?,
        versions: opt_str(n, "versions").unwrap_or_else(|| "*".to_owned()),
        id,
    })
}

/// 61 §3.1's `verified_on: { platform, version }`, optional.
///
/// A present-but-malformed table is REFUSED, never quietly read as absent.
/// Absence is the honest default and it is what ADR-0027 §2 renders as
/// `unverified`; degrading a typo into it would turn a broken entry into one
/// that looks correct, and degrading it the other way — accepting a table that
/// does not name a box — would claim a bench run from nothing. Both directions
/// are silent, so neither is allowed.
fn load_verified_on(n: &Node, file: &str) -> Result<Option<VerifiedOn>, LoadError> {
    let Some(v) = n.get("verified_on") else {
        return Ok(None);
    };
    if v.as_map().is_none() {
        return Err(err(
            file,
            v.line,
            "`verified_on` must be a `{ platform, version }` table (61 §3.1)",
        ));
    }
    Ok(Some(VerifiedOn {
        platform: req_str(v, "platform", file)?,
        version: req_str(v, "version", file)?,
    }))
}

// --- explainer bundle --------------------------------------------------------

fn load_explainer_bundle(source: &str, file: &str) -> Result<Vec<ExplainerEntry>, LoadError> {
    let root = parse_source(source, file)?;
    let entries_node = req(&root, "entries", file)?;
    let seq = entries_node
        .as_seq()
        .ok_or_else(|| err(file, entries_node.line, "`entries` must be a sequence"))?;
    let mut out = Vec::new();
    for item in seq {
        out.push(ExplainerEntry {
            id: req_str(item, "id", file)?,
            class: opt_str(item, "class").unwrap_or_default(),
            title: opt_str(item, "title"),
            reviewed_by: opt_str(item, "reviewed_by"),
        });
    }
    Ok(out)
}

// --- rule bundle -------------------------------------------------------------

fn load_rule_bundle(source: &str, file: &str) -> Result<Vec<RuleLite>, LoadError> {
    let root = parse_source(source, file)?;
    let rules_node = req(&root, "rules", file)?;
    let seq = rules_node
        .as_seq()
        .ok_or_else(|| err(file, rules_node.line, "`rules` must be a sequence"))?;
    let mut out = Vec::new();
    for item in seq {
        out.push(RuleLite {
            id: req_str(item, "id", file)?,
            reviewed_by: opt_str(item, "reviewed_by"),
        });
    }
    Ok(out)
}
