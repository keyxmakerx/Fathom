//! Loading a pack from corpus text, and the fixture gate.
//!
//! Layout (63 §2): `rules/<id>/rule.yaml` and `rules/<id>/fixtures/{fire,pass}-*.yaml`.
//! A rule with no `fire-` fixture and no `pass-` fixture does not load: a rule nobody has
//! shown firing, and shown not firing, is a specification and not a rule.

use crate::engine::Pack;
use crate::rule::{lerr, load_rule, LoadError};
use crate::schema::Schema;

/// One file of the corpus, by path relative to the corpus root (`rules/<id>/rule.yaml`).
pub struct Source<'a> {
    pub path: &'a str,
    pub text: &'a str,
}

pub struct Fixture {
    pub rule: String,
    pub name: String,
    pub fire: bool,
    pub text: String,
}

pub struct Loaded {
    pub pack: Pack,
    pub fixtures: Vec<Fixture>,
}

pub fn load_pack(files: &[Source<'_>], schema: &dyn Schema) -> Result<Loaded, LoadError> {
    let mut sorted: Vec<&Source<'_>> = files.iter().collect();
    sorted.sort_by_key(|s| s.path);
    let mut rules = Vec::new();
    let mut fixtures = Vec::new();
    for s in &sorted {
        let parts: Vec<&str> = s.path.split('/').collect();
        match parts.as_slice() {
            ["rules", dir, "rule.yaml"] => {
                rules.push(load_rule(s.text, s.path, dir, schema)?);
            }
            ["rules", dir, "fixtures", name] if name.ends_with(".yaml") => {
                let fire = if name.starts_with("fire-") {
                    true
                } else if name.starts_with("pass-") {
                    false
                } else {
                    return Err(lerr(
                        s.path,
                        0,
                        "a fixture is named fire-<what>.yaml or pass-<what>.yaml",
                    ));
                };
                fixtures.push(Fixture {
                    rule: (*dir).to_owned(),
                    name: (*name).to_owned(),
                    fire,
                    text: s.text.to_owned(),
                });
            }
            _ => {}
        }
    }
    for r in &rules {
        for want in [true, false] {
            if !fixtures
                .iter()
                .any(|f| f.rule == r.meta.id && f.fire == want)
            {
                return Err(lerr(
                    &format!("rules/{}", r.meta.id),
                    0,
                    format!(
                        "needs at least one {} fixture (63 §15)",
                        if want { "fire-" } else { "pass-" }
                    ),
                ));
            }
        }
    }
    Ok(Loaded {
        pack: Pack { rules },
        fixtures,
    })
}
