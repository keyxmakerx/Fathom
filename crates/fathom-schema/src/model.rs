//! Typed views over the parsed tree — just enough structure for the gates.
//! The loader is deliberately permissive: unknown keys are the reviewer's
//! business; the gates own every refusal with a code.

use crate::subset::{self, SubsetError};
use crate::value::Node;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub struct FieldDecl {
    pub name: String,
    pub ty: Option<String>,
    pub emit: Option<String>,
    pub derived: bool,
    pub line: usize,
}

#[derive(Debug)]
pub struct KindDecl {
    pub name: String,
    pub layer: Option<String>,
    pub emits: Option<bool>,
    pub fields: Vec<FieldDecl>,
    /// Identity tiers, each an ordered list of raw term strings.
    pub identity: Vec<(Vec<String>, usize)>,
    pub line: usize,
}

#[derive(Debug)]
pub struct EdgeDecl {
    pub name: String,
    pub from: Vec<String>,
    pub to: Vec<String>,
    pub out_bound: Option<String>,
    pub l1_out_bound: Option<String>,
    pub fields: Vec<FieldDecl>,
    pub derived: bool,
    pub line: usize,
}

#[derive(Debug)]
pub struct ClassDecl {
    pub name: String,
    pub members: Vec<String>,
    pub line: usize,
}

#[derive(Debug)]
pub struct ScalarDecl {
    pub name: String,
    pub line: usize,
}

#[derive(Debug)]
pub struct ImportScope {
    pub format: String,
    pub kinds: Vec<String>,
    pub tiers: Vec<i64>,
    pub absence: Option<String>,
    pub line: usize,
}

#[derive(Debug)]
pub struct EnumFile {
    pub name: String,
    pub path: PathBuf,
    pub variants: Vec<(String, usize)>,
}

#[derive(Debug)]
pub struct Platforms {
    pub path: PathBuf,
    pub vendors: Vec<String>,
    /// (platform id, vendor ref, line)
    pub platforms: Vec<(String, String, usize)>,
}

#[derive(Debug)]
pub struct FieldKeys {
    pub path: PathBuf,
    /// (dotted name, integer key, line) in declaration order.
    pub entries: Vec<(String, i64, usize)>,
}

/// The field-key table read out of a parsed `schema/field-keys.yaml`.
///
/// Shape: a single top-level map of dotted name -> integer, or the same nested
/// under a `fields:` or `keys:` block. A value that is not an integer is
/// skipped rather than refused — this reads the table, it does not gate it;
/// `gates.rs` does that.
///
/// Public because there are two readers of that file and they must not read it
/// differently: `SchemaTree::load` here, off disk, and `Dictionary::embedded`
/// in `fathom-ingest`, off a compiled-in string in a build with no filesystem.
pub fn field_key_entries(node: &Node) -> Vec<(String, i64, usize)> {
    node.get("fields")
        .and_then(|v| v.as_map())
        .or_else(|| node.get("keys").and_then(|v| v.as_map()))
        .or_else(|| node.as_map())
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| v.as_int().map(|i| (k.clone(), i, v.line)))
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Debug)]
pub struct SchemaTree {
    pub root: PathBuf,
    pub schema_path: PathBuf,
    pub toplevel_keys: Vec<(String, usize)>,
    pub version: Option<String>,
    pub scalars: Vec<ScalarDecl>,
    pub classes: Vec<ClassDecl>,
    pub kinds: Vec<KindDecl>,
    pub edges: Vec<EdgeDecl>,
    pub import_scopes: Vec<ImportScope>,
    pub enums: Vec<EnumFile>,
    pub platforms: Option<Platforms>,
    pub field_keys: Option<FieldKeys>,
    /// Files that parsed; kept for future gates.
    pub parsed_files: Vec<PathBuf>,
    /// Subset violations, one per offending file.
    pub subset_errors: Vec<(PathBuf, SubsetError)>,
}

#[derive(Debug)]
pub enum LoadError {
    Io(PathBuf, std::io::Error),
    MissingSchemaYaml(PathBuf),
}

impl std::fmt::Display for LoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LoadError::Io(p, e) => write!(f, "{}: {e}", p.display()),
            LoadError::MissingSchemaYaml(p) => {
                write!(f, "{}: schema.yaml not found", p.display())
            }
        }
    }
}

impl SchemaTree {
    pub fn load(root: &Path) -> Result<SchemaTree, LoadError> {
        let schema_path = root.join("schema.yaml");
        if !schema_path.is_file() {
            return Err(LoadError::MissingSchemaYaml(root.to_path_buf()));
        }

        let mut tree = SchemaTree {
            root: root.to_path_buf(),
            schema_path: schema_path.clone(),
            toplevel_keys: Vec::new(),
            version: None,
            scalars: Vec::new(),
            classes: Vec::new(),
            kinds: Vec::new(),
            edges: Vec::new(),
            import_scopes: Vec::new(),
            enums: Vec::new(),
            platforms: None,
            field_keys: None,
            parsed_files: Vec::new(),
            subset_errors: Vec::new(),
        };

        if let Some(node) = tree.parse_file(&schema_path)? {
            tree.load_schema_yaml(&node);
        }

        let enums_dir = root.join("enums");
        if enums_dir.is_dir() {
            let mut paths: Vec<PathBuf> = fs::read_dir(&enums_dir)
                .map_err(|e| LoadError::Io(enums_dir.clone(), e))?
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| p.extension().is_some_and(|x| x == "yaml"))
                .collect();
            paths.sort();
            for p in paths {
                if let Some(node) = tree.parse_file(&p)? {
                    let name = p
                        .file_stem()
                        .map(|s| s.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    let variants = node
                        .get("variants")
                        .and_then(|v| v.as_seq())
                        .map(|s| {
                            s.iter()
                                .filter_map(|n| n.as_str().map(|t| (t.to_owned(), n.line)))
                                .collect()
                        })
                        .unwrap_or_default();
                    tree.enums.push(EnumFile {
                        name,
                        path: p,
                        variants,
                    });
                }
            }
        }

        let platforms_path = root.join("platforms.yaml");
        if platforms_path.is_file() {
            if let Some(node) = tree.parse_file(&platforms_path)? {
                let vendors = node
                    .get("vendors")
                    .and_then(|v| v.as_map())
                    .map(|m| m.iter().map(|(k, _)| k.clone()).collect())
                    .unwrap_or_default();
                let platforms = node
                    .get("platforms")
                    .and_then(|v| v.as_map())
                    .map(|m| {
                        m.iter()
                            .map(|(k, v)| {
                                let vendor = v
                                    .get("vendor")
                                    .and_then(|x| x.as_str())
                                    .unwrap_or("")
                                    .to_owned();
                                (k.clone(), vendor, v.line)
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                tree.platforms = Some(Platforms {
                    path: platforms_path,
                    vendors,
                    platforms,
                });
            }
        }

        let keys_path = root.join("field-keys.yaml");
        if keys_path.is_file() {
            if let Some(node) = tree.parse_file(&keys_path)? {
                tree.field_keys = Some(FieldKeys {
                    path: keys_path,
                    entries: field_key_entries(&node),
                });
            }
        }

        // Parse-only files: syntax is gated, content is other tools' business.
        let st = root.join("service-types").join("builtin.yaml");
        if st.is_file() {
            let _ = tree.parse_file(&st)?;
        }

        Ok(tree)
    }

    fn parse_file(&mut self, path: &Path) -> Result<Option<Node>, LoadError> {
        let text = fs::read_to_string(path).map_err(|e| LoadError::Io(path.to_path_buf(), e))?;
        match subset::parse(&text) {
            Ok(node) => {
                self.parsed_files.push(path.to_path_buf());
                Ok(Some(node))
            }
            Err(e) => {
                self.subset_errors.push((path.to_path_buf(), e));
                Ok(None)
            }
        }
    }

    fn load_schema_yaml(&mut self, node: &Node) {
        if let Some(map) = node.as_map() {
            for (k, v) in map {
                self.toplevel_keys.push((k.clone(), v.line));
            }
        }
        self.version = node
            .get("schema")
            .and_then(|s| s.get("version"))
            .and_then(|v| v.as_str().map(str::to_owned));

        if let Some(scalars) = node.get("scalars").and_then(|v| v.as_seq()) {
            for s in scalars {
                if let Some(name) = s.get("name").and_then(|n| n.as_str()) {
                    self.scalars.push(ScalarDecl {
                        name: name.to_owned(),
                        line: s.line,
                    });
                }
            }
        }

        if let Some(classes) = node.get("classes").and_then(|v| v.as_seq()) {
            for c in classes {
                let name = c.get("class").or_else(|| c.get("name"));
                if let Some(name) = name.and_then(|n| n.as_str()) {
                    let members = c
                        .get("members")
                        .and_then(|m| m.as_seq())
                        .map(|s| {
                            s.iter()
                                .filter_map(|n| n.as_str().map(str::to_owned))
                                .collect()
                        })
                        .unwrap_or_default();
                    self.classes.push(ClassDecl {
                        name: name.to_owned(),
                        members,
                        line: c.line,
                    });
                }
            }
        }

        if let Some(kinds) = node.get("kinds").and_then(|v| v.as_seq()) {
            for k in kinds {
                let Some(name) = k.get("kind").and_then(|n| n.as_str()) else {
                    continue;
                };
                let fields = load_fields(k.get("fields"));
                let identity = k
                    .get("identity")
                    .and_then(|i| i.as_seq())
                    .map(|tiers| {
                        tiers
                            .iter()
                            .filter_map(|tier| {
                                tier.as_seq().map(|terms| {
                                    (
                                        terms
                                            .iter()
                                            .filter_map(|t| t.as_str().map(str::to_owned))
                                            .collect(),
                                        tier.line,
                                    )
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                self.kinds.push(KindDecl {
                    name: name.to_owned(),
                    layer: k.get("layer").and_then(|v| v.as_str().map(str::to_owned)),
                    emits: k.get("emits").and_then(|v| v.as_bool()),
                    fields,
                    identity,
                    line: k.line,
                });
            }
        }

        for (block, derived) in [("edges", false), ("derived_edges", true)] {
            if let Some(edges) = node.get(block).and_then(|v| v.as_seq()) {
                for e in edges {
                    let name = e.get("edge").or_else(|| e.get("name"));
                    let Some(name) = name.and_then(|n| n.as_str()) else {
                        continue;
                    };
                    let list = |key: &str| -> Vec<String> {
                        e.get(key)
                            .and_then(|v| v.as_seq())
                            .map(|s| {
                                s.iter()
                                    .filter_map(|n| n.as_str().map(str::to_owned))
                                    .collect()
                            })
                            .unwrap_or_default()
                    };
                    self.edges.push(EdgeDecl {
                        name: name.to_owned(),
                        from: list("from"),
                        to: list("to"),
                        // `out` is either a bare range string or a two-level
                        // flow map `{ l0: "...", l1: "..." }` (62 §6.2).
                        out_bound: e.get("out").and_then(|v| {
                            v.as_str()
                                .map(str::to_owned)
                                .or_else(|| v.get("l0").and_then(|x| x.as_str().map(str::to_owned)))
                        }),
                        l1_out_bound: e
                            .get("out")
                            .and_then(|v| v.get("l1"))
                            .and_then(|v| v.as_str().map(str::to_owned)),
                        fields: load_fields(e.get("fields")),
                        derived,
                        line: e.line,
                    });
                }
            }
        }

        if let Some(imports) = node
            .get("scopes")
            .and_then(|s| s.get("import"))
            .and_then(|v| v.as_seq())
        {
            for i in imports {
                let Some(format) = i.get("format").and_then(|n| n.as_str()) else {
                    continue;
                };
                let kinds = i
                    .get("kinds")
                    .and_then(|v| v.as_seq())
                    .map(|s| {
                        s.iter()
                            .filter_map(|n| n.as_str().map(str::to_owned))
                            .collect()
                    })
                    .unwrap_or_default();
                let tiers = i
                    .get("tiers")
                    .and_then(|v| v.as_seq())
                    .map(|s| s.iter().filter_map(|n| n.as_int()).collect())
                    .unwrap_or_default();
                self.import_scopes.push(ImportScope {
                    format: format.to_owned(),
                    kinds,
                    tiers,
                    absence: i.get("absence").map(|n| n.scalar_display()),
                    line: i.line,
                });
            }
        }
    }
}

fn load_fields(node: Option<&Node>) -> Vec<FieldDecl> {
    let Some(seq) = node.and_then(|v| v.as_seq()) else {
        return Vec::new();
    };
    seq.iter()
        .filter_map(|f| {
            let name = f.get("name").and_then(|n| n.as_str())?;
            Some(FieldDecl {
                name: name.to_owned(),
                ty: f.get("type").and_then(|v| v.as_str().map(str::to_owned)),
                emit: f.get("emit").map(|v| v.scalar_display()),
                derived: f.get("derived").is_some(),
                line: f.line,
            })
        })
        .collect()
}
