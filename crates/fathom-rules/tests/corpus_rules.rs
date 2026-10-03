//! The shipped rules, loaded through the real schema, and every fixture run through the
//! real graph. A rule that does not compile, or a fixture that does not behave as named,
//! fails here.

use std::fs;
use std::path::{Path, PathBuf};

use fathom_rules::fixture;
use fathom_rules::graph::IrSchema;
use fathom_rules::pack::{load_pack, Source};

pub fn corpus_rules() -> Vec<(String, String)> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../corpus");
    let mut out = Vec::new();
    let mut dirs: Vec<PathBuf> = fs::read_dir(root.join("rules"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort();
    for d in dirs {
        let id = d.file_name().unwrap().to_str().unwrap().to_owned();
        out.push((
            format!("rules/{id}/rule.yaml"),
            fs::read_to_string(d.join("rule.yaml")).unwrap(),
        ));
        let fx = d.join("fixtures");
        let mut files: Vec<PathBuf> = fs::read_dir(&fx)
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect();
        files.sort();
        for f in files {
            let n = f.file_name().unwrap().to_str().unwrap();
            out.push((
                format!("rules/{id}/fixtures/{n}"),
                fs::read_to_string(&f).unwrap(),
            ));
        }
    }
    out
}

#[test]
fn every_rule_loads_and_every_fixture_behaves() {
    let files = corpus_rules();
    let sources: Vec<Source> = files
        .iter()
        .map(|(p, t)| Source { path: p, text: t })
        .collect();
    let loaded = match load_pack(&sources, &IrSchema) {
        Ok(l) => l,
        Err(e) => panic!("{e}"),
    };
    assert!(loaded.pack.rules.len() >= 10);
    let mut bad = Vec::new();
    for f in &loaded.fixtures {
        if let Err(e) = fixture::check(&loaded.pack, f) {
            bad.push(format!("{} / {}: {e}", f.rule, f.name));
        }
    }
    assert!(bad.is_empty(), "\n{}", bad.join("\n"));
}
