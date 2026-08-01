//! `fathom find` — query in, ranked list out, with scores and the why
//! (per-matcher contributions; `--why` adds per-term and per-concept rows).
//!
//! Usage: fathom-find [--corpus DIR] [--why] [--gates] QUERY…

use std::path::PathBuf;
use std::process::ExitCode;

use fathom_corpus::gates;
use fathom_corpus::CorpusIndex;
use fathom_find::{Finder, CONFIDENT_MILLI};

fn main() -> ExitCode {
    let mut corpus_dir = PathBuf::from("corpus");
    let mut why = false;
    let mut show_gates = false;
    let mut query_parts: Vec<String> = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--corpus" => match args.next() {
                Some(dir) => corpus_dir = PathBuf::from(dir),
                None => {
                    eprintln!("--corpus needs a directory");
                    return ExitCode::FAILURE;
                }
            },
            "--why" => why = true,
            "--gates" => show_gates = true,
            _ => query_parts.push(arg),
        }
    }

    let index = match CorpusIndex::load(&corpus_dir) {
        Ok(i) => i,
        Err(e) => {
            eprintln!("corpus load failed: {e}");
            return ExitCode::FAILURE;
        }
    };

    if show_gates {
        print_gates(&index);
        if query_parts.is_empty() {
            return ExitCode::SUCCESS;
        }
    }
    if query_parts.is_empty() {
        eprintln!("usage: fathom-find [--corpus DIR] [--why] [--gates] QUERY…");
        return ExitCode::FAILURE;
    }
    let query = query_parts.join(" ");
    let finder = Finder::new(index);
    let result = finder.search(&query);
    let idx = &finder.index;

    println!("query: {query}");
    println!(
        "g_syn: {:.3}   query concepts: {}",
        result.g_syn,
        result
            .query_concepts
            .concepts
            .iter()
            .map(|qc| {
                format!(
                    "{}{} {:.2}",
                    idx.concepts.get(qc.ord).id.trim_start_matches("concept:"),
                    if qc.derived { "*" } else { "" },
                    f64::from(qc.conf_milli) / 1000.0
                )
            })
            .collect::<Vec<_>>()
            .join(" · ")
    );
    if result.ladder_group_trigger {
        println!(
            "note: broad State concept fired — ladder group would render here; \
             no ladder documents are authored in corpus/ yet (16 §17.3 TODO), \
             so rows carry their entry-local `if bad` chain instead"
        );
    }
    if let Some(rev) = &result.reverse {
        let e = idx.entry(rev.entry);
        println!();
        println!("─ reverse (shape D) ─────────────────────────────────");
        println!("  matched: {}  →  {}", idx.display_cmd(rev.entry), e.id);
        for (slot, value) in &rev.captures {
            println!("  {slot} := {value}   (you typed it)");
        }
        if !rev.full && !rev.leftover.is_empty() {
            println!("  not in corpus: {}", rev.leftover.join(" "));
        }
        if let Some(f) = &result.filter_clause {
            println!("  | {f}   (filter clause, held aside)");
        }
        println!("  {}", e.answers);
        println!("  read: {}", e.read_field);
        println!("─ flat results below ────────────────────────────────");
    }
    println!();
    if result.shown.is_empty() {
        println!("nothing above the cutoff for \"{query}\"");
        if !result.below.is_empty() {
            println!("nearest commands:");
            for r in &result.below {
                println!(
                    "  {:5.2}  {}",
                    r.score_milli as f64 / 1000.0,
                    idx.display_cmd(r.entry)
                );
            }
        }
        return ExitCode::SUCCESS;
    }
    for (rank, r) in result.shown.iter().enumerate() {
        let e = idx.entry(r.entry);
        let band = if r.score_milli >= CONFIDENT_MILLI {
            ""
        } else {
            "  (below the confident band)"
        };
        println!(
            "{:2}. {:5.2}  {}",
            rank + 1,
            r.score_milli as f64 / 1000.0,
            idx.display_cmd(r.entry)
        );
        println!("           {}   {}{}", e.risk.label(), e.id, band);
        println!(
            "           [concept {:.3} | lexical {:.3} | syntax {:.3} | context {:.3} | prior {:+.3}]",
            r.contributions.concept,
            r.contributions.lexical,
            r.contributions.syntax,
            r.contributions.context,
            r.contributions.prior
        );
        println!("           {}", e.answers);
        println!("           read: {}", e.read_field);
        if let Some(first) = e.next_if_bad.first() {
            println!("           if bad: {first}");
        }
        if why {
            let terms = fathom_find::lexical::query_terms(&fathom_corpus::normalize::normalize(
                &query,
                &idx.lexicons,
            ));
            let mut term_rows = Vec::new();
            fathom_find::lexical::bm25(idx, &terms, r.entry, Some(&mut term_rows));
            let mut concept_rows = Vec::new();
            fathom_find::conceptm::concept_score(
                idx,
                &result.query_concepts,
                r.entry,
                Some(&mut concept_rows),
            );
            for (t, v) in term_rows {
                println!("             term    {t:<24} {v:.3}");
            }
            for (c, v) in concept_rows {
                println!(
                    "             concept {:<24} {v:.3}",
                    idx.concepts.get(c).id.trim_start_matches("concept:")
                );
            }
        }
    }
    ExitCode::SUCCESS
}

fn print_gates(index: &CorpusIndex) {
    let findings = gates::run(index);
    let errors = findings
        .iter()
        .filter(|f| f.severity == gates::Severity::Error)
        .count();
    let warnings = findings.len() - errors;
    println!("─ corpus gate inventory (61 §14, mechanically-checkable subset) ─");
    println!(
        "  {} findings: {errors} errors, {warnings} warnings over {} entries / {} explainers / {} rules",
        findings.len(),
        index.corpus.entries.len(),
        index.corpus.explainers.len(),
        index.corpus.rules.len(),
    );
    let mut by_code: Vec<(&str, usize)> = Vec::new();
    for f in &findings {
        match by_code.iter_mut().find(|(c, _)| *c == f.code) {
            Some((_, n)) => *n += 1,
            None => by_code.push((f.code, 1)),
        }
    }
    for (code, n) in &by_code {
        println!("  {n:4} × {code}");
    }
    for f in &findings {
        if f.severity == gates::Severity::Error {
            println!("  ERROR {} — {}: {}", f.code, f.subject, f.message);
        }
    }
    println!("──────────────────────────────────────────────────────────────────");
}
