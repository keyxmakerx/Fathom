//! fathom-schemagen: 62 §17's generator.
//!
//! Reads the `schema/` tree through `fathom-schema` (one parser, one gated
//! model — this crate adds a codegen view, not a second parser), refuses to
//! generate while any failure-severity gate fires, and deterministically
//! emits the five generated artifacts (62 §17.1):
//!
//! | artifact | repo path |
//! |---|---|
//! | typed IR enums + field-key table | `crates/fathom-ir/src/generated/ir_types.rs` |
//! | typed fallible accessors | `crates/fathom-ir/src/generated/accessors.rs` |
//! | the canonical, content-hashed schema | `schema/generated/schema.json` |
//! | the UI-boundary mirror | `schema/generated/ir_types.ts` |
//! | the declared migration chain | `schema/migrations/manifest.toml` |
//!
//! Determinism (62 §17.2), by construction and by test: output is a function
//! of the tree's bytes alone — no timestamps, no environment reads, no
//! absolute paths in any output, `BTreeMap`/declaration-order iteration
//! everywhere. `schema.codegen.stale` and `schema.codegen.nondeterministic`
//! run as cargo tests in this crate (tests/determinism.rs), so CI-by-test
//! exists from day one.

#![forbid(unsafe_code)]

pub mod extract;
pub mod json;
pub mod rust_gen;
pub mod ts_gen;

use extract::{ExtractError, Extracted};
use fathom_schema::gates::{Finding, Severity};
use json::Json;
use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::Path;

/// One generated file: repo-root-relative path plus exact bytes.
pub struct Artifact {
    pub repo_path: &'static str,
    pub bytes: Vec<u8>,
}

/// The full artifact set, fixed order.
pub const ARTIFACT_PATHS: [&str; 5] = [
    "crates/fathom-ir/src/generated/ir_types.rs",
    "crates/fathom-ir/src/generated/accessors.rs",
    "schema/generated/schema.json",
    "schema/generated/ir_types.ts",
    "schema/migrations/manifest.toml",
];

#[derive(Debug)]
pub enum GenError {
    /// The tree could not be loaded at all.
    Load(String),
    /// Failure-severity gates fired — gates first, then codegen; never
    /// generate from a broken tree.
    Gates(Vec<Finding>),
    /// The codegen view could not be built or emitted.
    Extract(ExtractError),
}

impl std::fmt::Display for GenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GenError::Load(e) => write!(f, "cannot load schema tree: {e}"),
            GenError::Gates(findings) => {
                writeln!(
                    f,
                    "refusing to generate: {} failure-severity gate finding(s):",
                    findings.len()
                )?;
                for g in findings {
                    writeln!(
                        f,
                        "  {}  {}:{}  {}",
                        g.code,
                        g.file.display(),
                        g.line,
                        g.message
                    )?;
                }
                Ok(())
            }
            GenError::Extract(e) => write!(f, "{e}"),
        }
    }
}

impl From<ExtractError> for GenError {
    fn from(e: ExtractError) -> Self {
        GenError::Extract(e)
    }
}

/// Run the gates, build the codegen view, emit all five artifacts.
/// Pure with respect to the filesystem beyond reading `schema_root`.
pub fn generate(schema_root: &Path) -> Result<Vec<Artifact>, GenError> {
    let (tree, findings) =
        fathom_schema::check(schema_root).map_err(|e| GenError::Load(e.to_string()))?;
    let failures: Vec<Finding> = findings
        .into_iter()
        .filter(|f| f.severity == Severity::Failure)
        .collect();
    if !failures.is_empty() {
        return Err(GenError::Gates(failures));
    }

    let x = extract::extract(schema_root, &tree)?;
    Ok(vec![
        Artifact {
            repo_path: ARTIFACT_PATHS[0],
            bytes: rust_gen::ir_types(&x)?.into_bytes(),
        },
        Artifact {
            repo_path: ARTIFACT_PATHS[1],
            bytes: rust_gen::accessors(&x)?.into_bytes(),
        },
        Artifact {
            repo_path: ARTIFACT_PATHS[2],
            bytes: schema_json(&x)?.to_canonical_bytes(),
        },
        Artifact {
            repo_path: ARTIFACT_PATHS[3],
            bytes: ts_gen::ir_types_ts(&x).into_bytes(),
        },
        Artifact {
            repo_path: ARTIFACT_PATHS[4],
            bytes: migrations_manifest(&x).into_bytes(),
        },
    ])
}

/// `schema.json` — canonical, content-hashed, one file for many consumers
/// (62 §17.1): every top-level block of `schema.yaml` (kinds with fields and
/// identity nested, edges, derived edges, scalars, classes, constraints,
/// emission, matching, scopes, naming_eligible, and the version), plus
/// enums, platforms, and the field-key registry. Completeness is not
/// optional: `schema/released/` snapshots are this file, and the bump
/// checker (62 §16.4) classifies released-snapshot diffs against §16.2's
/// table — whose rows include constraint changes — so an uncarried block is
/// a class of schema change the checker is permanently blind to. A
/// cross-check below refuses generation if any tree block goes uncarried.
fn schema_json(x: &Extracted) -> Result<Json, GenError> {
    let conv = |key: &str| -> Result<Json, GenError> {
        let node = x.schema_node.get(key).ok_or_else(|| {
            GenError::Extract(ExtractError(format!("schema.yaml lacks `{key}:`")))
        })?;
        json::from_node(node, "schema.yaml").map_err(|e| GenError::Extract(ExtractError(e)))
    };

    let mut root = BTreeMap::new();
    // "$" sorts before every ASCII letter, so the marker opens the file —
    // JSON admits no comment, this key is the header rule's honest form.
    root.insert(
        "$generated".to_owned(),
        Json::Str(rust_gen::HEADER.to_owned()),
    );
    root.insert("classes".to_owned(), conv("classes")?);
    root.insert("kinds".to_owned(), conv("kinds")?);
    root.insert("edges".to_owned(), conv("edges")?);
    root.insert("derived_edges".to_owned(), conv("derived_edges")?);
    root.insert("scalars".to_owned(), conv("scalars")?);
    root.insert("constraints".to_owned(), conv("constraints")?);
    root.insert("emission".to_owned(), conv("emission")?);
    root.insert("matching".to_owned(), conv("matching")?);
    root.insert("scopes".to_owned(), conv("scopes")?);
    root.insert("naming_eligible".to_owned(), conv("naming_eligible")?);

    let mut enums = Vec::new();
    for e in &x.enums {
        let converted = json::from_node(&e.node, &format!("enums/{}.yaml", e.stem))
            .map_err(|er| GenError::Extract(ExtractError(er)))?;
        let Json::Obj(mut map) = converted else {
            return Err(GenError::Extract(ExtractError(format!(
                "enums/{}.yaml is not a map",
                e.stem
            ))));
        };
        for key in ["name", "rust_name"] {
            if map.contains_key(key) {
                return Err(GenError::Extract(ExtractError(format!(
                    "enums/{}.yaml declares reserved key `{key}`",
                    e.stem
                ))));
            }
        }
        map.insert("name".to_owned(), Json::Str(e.stem.clone()));
        map.insert("rust_name".to_owned(), Json::Str(e.rust_name.clone()));
        enums.push(Json::Obj(map));
    }
    root.insert("enums".to_owned(), Json::Arr(enums));

    root.insert(
        "platforms".to_owned(),
        json::from_node(&x.platforms_node, "platforms.yaml")
            .map_err(|e| GenError::Extract(ExtractError(e)))?,
    );

    let field_keys = x
        .field_keys
        .iter()
        .map(|(name, key)| {
            let mut m = BTreeMap::new();
            m.insert("key".to_owned(), Json::Int(i64::from(*key)));
            m.insert("name".to_owned(), Json::Str(name.clone()));
            Json::Obj(m)
        })
        .collect();
    root.insert("field_keys".to_owned(), Json::Arr(field_keys));

    let mut schema = BTreeMap::new();
    schema.insert("version".to_owned(), Json::Str(x.version.clone()));
    root.insert("schema".to_owned(), Json::Obj(schema));

    // The completeness cross-check: every top-level block of schema.yaml
    // must be carried, or the released-snapshot diff (62 §16.4) is blind to
    // a whole class of change. A new block added to the tree (and to the
    // schema.order.toplevel vocabulary) that is not also carried here is a
    // generation refusal, not a silent omission.
    if let Some(entries) = x.schema_node.as_map() {
        for (key, _) in entries {
            if !root.contains_key(key) {
                return Err(GenError::Extract(ExtractError(format!(
                    "schema.yaml block `{key}:` is not carried by schema.json — \
                     the bump checker (62 §16.4) could not classify changes to it"
                ))));
            }
        }
    }

    Ok(Json::Obj(root))
}

/// `schema/migrations/manifest.toml` — the declared chain (62 §17.1),
/// checked complete from 1.0 by CI once anything releases.
fn migrations_manifest(x: &Extracted) -> String {
    let mut o = String::new();
    let _ = writeln!(o, "# {}.", rust_gen::HEADER);
    o.push_str(
        "#\n\
         # The declared migration chain (62 §17.1; 11 §11.5). It is empty and\n\
         # honestly so: pre-1.0 nothing has been released — schema/released/\n\
         # holds no snapshot, no major bump has occurred, and no Migration\n\
         # impl exists. The chain-completeness gate\n\
         # (schema.migration.chain-broken) becomes checkable at the first\n\
         # release; an aspirationally populated chain today would be exactly\n\
         # the invented claim the house rules forbid.\n\n",
    );
    let _ = writeln!(o, "schema_version = \"{}\"", x.version);
    o.push_str("migrations = []\n");
    o
}
