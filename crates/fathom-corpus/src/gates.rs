//! The mechanically-checkable subset of 61 §14's CI gates, run over the loaded
//! corpus — the same discipline as `fathom-schema`'s gates. Everything here is
//! an *inventory*: this crate ships nothing, so even invariant-10 violations
//! report as warnings; the hard-failing build gate belongs to the shipping
//! pipeline, which does not exist yet.

use std::collections::BTreeSet;

use fathom_id::{CommandId, ConceptId};

use crate::concepts::ConceptKind;
use crate::index::CorpusIndex;
use crate::model::Risk;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Warning,
    Error,
}

#[derive(Debug, Clone)]
pub struct Finding {
    pub severity: Severity,
    /// Stable code, `corpus.<gate>.<check>`.
    pub code: &'static str,
    pub subject: String,
    pub message: String,
}

fn finding(
    out: &mut Vec<Finding>,
    severity: Severity,
    code: &'static str,
    subject: &str,
    message: impl Into<String>,
) {
    out.push(Finding {
        severity,
        code,
        subject: subject.to_owned(),
        message: message.into(),
    });
}

/// 61 §14 gate 15's consequence patterns, hand-matched (no regex dependency).
fn blast_radius_names_disruption(text: &str) -> bool {
    let t = text.to_lowercase();
    if t.contains("blackhole") || t.contains("traffic stops") || t.contains("never comes up") {
        return true;
    }
    if t.contains("stops negotiating") {
        return true;
    }
    if let Some(pos) = t.find("drops ") {
        let rest = &t[pos..];
        if rest.contains("adjacency") || rest.contains("traffic") {
            return true;
        }
    }
    false
}

pub fn run(index: &CorpusIndex) -> Vec<Finding> {
    let mut out = Vec::new();
    let corpus = &index.corpus;

    let entry_ids: BTreeSet<&str> = corpus.entries.iter().map(|e| e.id.as_str()).collect();
    let explainer_ids: BTreeSet<&str> = corpus.explainers.iter().map(|e| e.id.as_str()).collect();
    let rule_ids: BTreeSet<&str> = corpus.rules.iter().map(|r| r.id.as_str()).collect();
    let declared: BTreeSet<String> = corpus
        .declared_concepts
        .entries
        .iter()
        .map(|(_, p)| format!("concept:{p}"))
        .collect();

    // Gate 1 — id format (fathom_id::CommandId), id/platform/domain agreement.
    for e in &corpus.entries {
        match CommandId::parse(&e.id) {
            Err(err) => finding(
                &mut out,
                Severity::Error,
                "corpus.id.format",
                &e.id,
                format!("id does not parse as a CommandId: {err:?}"),
            ),
            Ok(cid) => {
                if cid.platform() != e.platform {
                    finding(
                        &mut out,
                        Severity::Error,
                        "corpus.id.platform",
                        &e.id,
                        format!("id platform != `platform: {}`", e.platform),
                    );
                }
                let first = cid.path().split('.').next().unwrap_or("");
                if first != e.domain {
                    finding(
                        &mut out,
                        Severity::Error,
                        "corpus.id.domain",
                        &e.id,
                        format!(
                            "first id segment `{first}` != `domain: {}` (bundle F1 scheme)",
                            e.domain
                        ),
                    );
                }
                if !corpus.bundle.domains.is_empty() && !corpus.bundle.domains.contains(&e.domain) {
                    finding(
                        &mut out,
                        Severity::Error,
                        "corpus.domain.enum",
                        &e.id,
                        format!("domain `{}` not in the bundle's domain list", e.domain),
                    );
                }
            }
        }
    }

    // Invariant 10 — reviewed_by must be a named human. Warning inventory
    // here; the hard failure belongs to shipping.
    for e in &corpus.entries {
        if e.reviewed_by.starts_with('<') {
            finding(
                &mut out,
                Severity::Warning,
                "corpus.reviewed_by.placeholder",
                &e.id,
                format!(
                    "reviewed_by is `{}` — invariant 10 unsatisfied",
                    e.reviewed_by
                ),
            );
        }
    }
    for x in &corpus.explainers {
        if x.reviewed_by.as_deref().is_none_or(|r| r.starts_with('<')) {
            finding(
                &mut out,
                Severity::Warning,
                "corpus.reviewed_by.placeholder",
                &x.id,
                "explainer reviewed_by is a placeholder — invariant 10 unsatisfied",
            );
        }
    }
    for r in &corpus.rules {
        if r.reviewed_by.as_deref().is_none_or(|v| v.starts_with('<')) {
            finding(
                &mut out,
                Severity::Warning,
                "corpus.reviewed_by.placeholder",
                &r.id,
                "rule reviewed_by is a placeholder — invariant 10 unsatisfied",
            );
        }
    }
    for c in &index.concepts.concepts {
        if c.seed {
            finding(
                &mut out,
                Severity::Warning,
                "corpus.reviewed_by.placeholder",
                &c.id,
                "seed concept — transcribed from 16/61 worked examples, unreviewed",
            );
        }
    }

    // Gate 2 — reference integrity for next_if_bad / related / related_rules /
    // requires.from / concepts.
    for e in &corpus.entries {
        for t in &e.next_if_bad {
            let ok = entry_ids.contains(t.as_str())
                || explainer_ids.contains(t.as_str())
                || rule_ids.contains(t.as_str());
            if !ok {
                finding(
                    &mut out,
                    Severity::Error,
                    "corpus.ref.next_if_bad",
                    &e.id,
                    format!("dangling next_if_bad target `{t}`"),
                );
            }
        }
        for t in &e.related {
            if !entry_ids.contains(t.as_str()) {
                finding(
                    &mut out,
                    Severity::Error,
                    "corpus.ref.related",
                    &e.id,
                    format!("dangling related target `{t}`"),
                );
            }
        }
        for t in &e.related_rules {
            if !rule_ids.contains(t.as_str()) {
                finding(
                    &mut out,
                    Severity::Warning,
                    "corpus.ref.related_rules",
                    &e.id,
                    format!("related_rules target `{t}` not in the loaded rule bundle"),
                );
            }
        }
        for r in &e.requires {
            if !entry_ids.contains(r.from.as_str()) {
                finding(
                    &mut out,
                    Severity::Error,
                    "corpus.ref.requires",
                    &e.id,
                    format!("requires.from `{}` does not resolve", r.from),
                );
            }
        }
        for cid in e.concepts.iter().chain(e.symptoms.iter()) {
            if ConceptId::parse(cid).is_err() {
                finding(
                    &mut out,
                    Severity::Error,
                    "corpus.concept.format",
                    &e.id,
                    format!("concept id `{cid}` does not parse"),
                );
            } else if !declared.contains(cid)
                && index
                    .concepts
                    .by_id
                    .get(cid)
                    .is_none_or(|&o| !index.concepts.concepts[o as usize].seed)
            {
                finding(
                    &mut out,
                    Severity::Warning,
                    "corpus.concept.undeclared",
                    &e.id,
                    format!("concept `{cid}` is neither seed nor in `new_concepts` (gate 2 will fail it once concepts/ exists)"),
                );
            }
        }
    }

    // Gate 3 — required destructive-command fields.
    for e in &corpus.entries {
        if e.risk != Risk::ReadOnly {
            if e.blast_radius.is_none() {
                finding(
                    &mut out,
                    Severity::Error,
                    "corpus.risk.blast_radius",
                    &e.id,
                    "risk != ReadOnly requires blast_radius",
                );
            }
            if e.reversible.is_none() {
                finding(
                    &mut out,
                    Severity::Error,
                    "corpus.risk.reversible",
                    &e.id,
                    "risk != ReadOnly requires reversible",
                );
            }
        }
        if e.mode == crate::model::Mode::Configuration && e.commit_model.is_none() {
            finding(
                &mut out,
                Severity::Error,
                "corpus.mode.commit_model",
                &e.id,
                "mode: configuration requires commit_model",
            );
        }
    }

    // Gate 4 (subset) — answers ends in `?`.
    for e in &corpus.entries {
        if !e.answers.trim_end().ends_with('?') {
            finding(
                &mut out,
                Severity::Warning,
                "corpus.answers.question",
                &e.id,
                "answers does not end in `?`",
            );
        }
    }

    // Gate 2 (slots) — every {{slot}} declared and vice versa.
    for e in &corpus.entries {
        let used: BTreeSet<&str> = e
            .cmd
            .split_whitespace()
            .filter_map(|t| t.strip_prefix("{{").and_then(|r| r.strip_suffix("}}")))
            .collect();
        for u in &used {
            if !e.slots.iter().any(|s| s.name == *u) {
                finding(
                    &mut out,
                    Severity::Error,
                    "corpus.slot.undeclared",
                    &e.id,
                    format!("`{{{{{u}}}}}` has no slots entry"),
                );
            }
        }
        for s in &e.slots {
            if !used.contains(s.name.as_str()) {
                finding(
                    &mut out,
                    Severity::Error,
                    "corpus.slot.unused",
                    &e.id,
                    format!("slot `{}` never appears in cmd", s.name),
                );
            }
        }
    }

    // Gate 6 (subset) — concept hygiene: ≥1 Object, ≥1 Action, ≤6 total.
    for (eord, e) in corpus.entries.iter().enumerate() {
        let kinds: Vec<ConceptKind> = index.e2c[eord]
            .iter()
            .map(|&c| index.concepts.get(c).kind)
            .collect();
        if !kinds.contains(&ConceptKind::Object) {
            finding(
                &mut out,
                Severity::Warning,
                "corpus.concept.no_object",
                &e.id,
                "entry carries no Object concept — unfindable by subject",
            );
        }
        if !kinds.contains(&ConceptKind::Action) {
            finding(
                &mut out,
                Severity::Warning,
                "corpus.concept.no_action",
                &e.id,
                "entry carries no Action concept",
            );
        }
        if e.concepts.len() > 6 {
            finding(
                &mut out,
                Severity::Warning,
                "corpus.concept.too_many",
                &e.id,
                format!("{} concepts (cap 6)", e.concepts.len()),
            );
        }
    }

    // Gate 6 — orphan concepts (zero direct carriers and no narrower carriers).
    for (ord, c) in index.concepts.concepts.iter().enumerate() {
        if c.entry_count == 0 {
            let narrower_carried = c
                .narrower
                .iter()
                .any(|&n| !index.c2e[n as usize].is_empty());
            if !narrower_carried {
                finding(
                    &mut out,
                    Severity::Warning,
                    "corpus.concept.orphan",
                    &c.id,
                    "no corpus entry carries this concept",
                );
            }
        }
        let _ = ord;
    }

    // Gate 7 — at most one weight:3 per (concept, platform).
    {
        let mut threes: Vec<(u32, &str, &str)> = Vec::new(); // (concept, platform, entry)
        for (eord, e) in corpus.entries.iter().enumerate() {
            if e.weight == 3 {
                for &c in &index.e2c[eord] {
                    threes.push((c, e.platform.as_str(), e.id.as_str()));
                }
            }
        }
        threes.sort();
        let mut i = 0;
        while i < threes.len() {
            let mut j = i + 1;
            while j < threes.len() && threes[j].0 == threes[i].0 && threes[j].1 == threes[i].1 {
                j += 1;
            }
            if j - i > 1 {
                let ids: Vec<&str> = threes[i..j].iter().map(|t| t.2).collect();
                finding(
                    &mut out,
                    Severity::Warning,
                    "corpus.weight.canonicality",
                    &index.concepts.get(threes[i].0).id.clone(),
                    format!(
                        "{} entries claim weight 3 on ({}, {}): {}",
                        j - i,
                        index.concepts.get(threes[i].0).id,
                        threes[i].1,
                        ids.join(", ")
                    ),
                );
            }
            i = j;
        }
    }

    // Gate 10 — requires/supplies consistency.
    for e in &corpus.entries {
        for r in &e.requires {
            if let Some(supplier) = corpus.entries.iter().find(|s| s.id == r.from) {
                if !supplier.output_fields.iter().any(|f| f.field == r.field) {
                    finding(
                        &mut out,
                        Severity::Error,
                        "corpus.requires.field",
                        &e.id,
                        format!(
                            "requires field `{}` not in `{}`'s output_fields",
                            r.field, r.from
                        ),
                    );
                }
                if !supplier.supplies.iter().any(|s| s == &r.field) {
                    finding(
                        &mut out,
                        Severity::Warning,
                        "corpus.requires.supplies",
                        &e.id,
                        format!(
                            "supplier `{}` does not list `{}` in supplies",
                            r.from, r.field
                        ),
                    );
                }
            }
        }
        // Weight range while we are here (gate 1's enum-shape discipline).
        if !(0..=3).contains(&e.weight) {
            finding(
                &mut out,
                Severity::Error,
                "corpus.weight.range",
                &e.id,
                format!("weight {} outside 0..=3", e.weight),
            );
        }
    }

    // Gate 15 — risk is effect: a blast_radius that names dropped traffic on a
    // non-Disruptive entry.
    for e in &corpus.entries {
        if let Some(br) = &e.blast_radius {
            if e.risk != Risk::Disruptive && blast_radius_names_disruption(br) {
                finding(
                    &mut out,
                    Severity::Error,
                    "corpus.risk.effect",
                    &e.id,
                    "blast_radius names dropped traffic but risk is not Disruptive (ADR-0011)",
                );
            }
        }
    }

    // Bundle count agreement.
    if corpus.bundle.declared_entry_count != 0
        && corpus.bundle.declared_entry_count != corpus.entries.len() as i64
    {
        finding(
            &mut out,
            Severity::Error,
            "corpus.bundle.entry_count",
            &corpus.bundle.id,
            format!(
                "bundle declares {} entries, {} loaded",
                corpus.bundle.declared_entry_count,
                corpus.entries.len()
            ),
        );
    }

    out
}
