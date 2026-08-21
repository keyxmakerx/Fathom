//! The codegen view over the schema tree.
//!
//! `fathom_schema::model::SchemaTree` is deliberately "just enough structure
//! for the gates"; codegen needs more (scalar `impl:` paths, cards, docs,
//! enum spelling maps). This module re-reads the same files through the same
//! parser (`fathom_schema::subset` — there is exactly one parser) and builds
//! the richer view, then **cross-checks every shared count and name sequence
//! against the gated model** — a divergence between the two readings is a
//! bug in one of them and refuses generation rather than generating from an
//! unchecked reading.

use fathom_schema::model::SchemaTree;
use fathom_schema::subset;
use fathom_schema::value::Node;
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

/// A generation-time refusal, with enough context to act on.
#[derive(Debug)]
pub struct ExtractError(pub String);

impl std::fmt::Display for ExtractError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

fn err<T>(msg: impl Into<String>) -> Result<T, ExtractError> {
    Err(ExtractError(msg.into()))
}

/// The closed layer vocabulary (62 §4.2; 19 §2.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Layer {
    Config,
    Physical,
    Service,
}

impl Layer {
    pub fn variant(self) -> &'static str {
        match self {
            Layer::Config => "Config",
            Layer::Physical => "Physical",
            Layer::Service => "Service",
        }
    }
}

/// The closed asserted-edge class vocabulary (62 §6.2). Derived edges have
/// none — they live in a separate arena (62 §11.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EdgeClass {
    Containment,
    Reference,
}

impl EdgeClass {
    pub fn variant(self) -> &'static str {
        match self {
            EdgeClass::Containment => "Containment",
            EdgeClass::Reference => "Reference",
        }
    }
}

/// One `scalars:` row: a name bound to an impl path (62 §3.2).
#[derive(Debug)]
pub struct ScalarBind {
    pub name: String,
    /// The declared path, e.g. `fathom_ir::scalar::IpPrefix` — validated to
    /// live under `fathom_ir::` so generated code can reference it as
    /// `crate::...` (the compile-time half of `schema.scalar.unbound`).
    pub impl_path: String,
    pub structured: bool,
}

/// A field's resolved type, indices into the sibling tables.
#[derive(Debug, Clone)]
pub enum FieldTy {
    /// Index into [`Extracted::scalars`].
    Scalar(usize),
    Primitive(&'static str),
    /// The registered builtin exception (11 §6.5) — `fathom_id::NodeId`.
    NodeId,
    /// Index into [`Extracted::enums`].
    Enum(usize),
    /// Index into [`Extracted::inline_enums`].
    Inline(usize),
    /// `set{<enum>}` — index into [`Extracted::enums`].
    Set(usize),
    Map(Box<FieldTy>, Box<FieldTy>),
}

#[derive(Debug)]
pub struct FieldGen {
    pub name: String,
    pub ty: FieldTy,
    /// The declared type string, verbatim, for generated documentation.
    pub raw_ty: String,
    pub card: String,
    pub emit: String,
    pub derived: bool,
    pub doc: Vec<String>,
}

impl FieldGen {
    /// Whether the slot holds many values (`0..n` / `1..n` over a non-
    /// collection type renders as `Vec<T>`; map/set types are the
    /// collection themselves regardless of card).
    pub fn many(&self) -> bool {
        matches!(self.card.as_str(), "0..n" | "1..n")
            && !matches!(self.ty, FieldTy::Map(_, _) | FieldTy::Set(_))
    }
}

#[derive(Debug)]
pub struct KindGen {
    pub name: String,
    pub layer: Layer,
    pub emits: bool,
    pub doc: Vec<String>,
    pub fields: Vec<FieldGen>,
    /// The identity tuples, in declared order — tier 1 first.
    ///
    /// **This reaches generated code so that nothing hand-writes it.** The
    /// tuples were parsed here for the gates alone and never emitted, so the
    /// only way for the module to ask *"are these two rows the same thing"*
    /// was a per-kind rule written in Rust — which ADR-0008 forbids, and which
    /// the tree already contains one of (`rack_place`'s reuse-by-label). One
    /// is a special case; two is a pattern, and the pattern's failure mode is
    /// that the owner edits `schema/schema.yaml` and nothing changes.
    ///
    /// Raw term strings exactly as declared. The consumer resolves them
    /// against the field table, so a tuple naming a field that does not exist
    /// fails where the field is looked up rather than silently matching
    /// nothing.
    pub identity: Vec<Vec<String>>,
}

#[derive(Debug)]
pub struct EdgeGen {
    pub name: String,
    /// `Some` on asserted edges, `None` on derived edges.
    pub class: Option<EdgeClass>,
    /// `Some` on derived edges: the producing `InferenceRuleId`.
    pub produced_by: Option<String>,
    pub doc: Vec<String>,
    pub fields: Vec<FieldGen>,
    /// The declared `from:` set with class names expanded to their members
    /// (62 §6.2: class names admitted and expanded at codegen). Empty
    /// exactly when the set is `[root]`. Derived edges carry an empty set.
    pub from_kinds: Vec<String>,
    /// As `from_kinds`, for `to:`.
    pub to_kinds: Vec<String>,
    /// `(min, max)` of the L0 out-bound; `None` max is the `n` token.
    pub out_l0: (u32, Option<u32>),
    /// As `out_l0`, for `in:`.
    pub in_l0: (u32, Option<u32>),
    /// The declared `symmetric:` flag.
    pub symmetric: bool,
    /// `true` exactly when `from:` is `[root]`.
    pub root_from: bool,
}

/// A named enum file under `schema/enums/` (62 §7).
#[derive(Debug)]
pub struct EnumGen {
    /// File stem — the name field declarations reference (`enum(<stem>)`).
    pub stem: String,
    /// Generated Rust type name (`CamelCase` of the stem).
    pub rust_name: String,
    pub variants: Vec<String>,
    /// The whole parsed file, for `schema.json` (spelling maps, defaults).
    pub node: Node,
}

/// An inline enum (`type: "enum { a, b }"`), named `<Owner><Field>` per
/// 62 §7 rule 4.
#[derive(Debug)]
pub struct InlineEnumGen {
    pub rust_name: String,
    pub owner: String,
    pub field: String,
    pub variants: Vec<String>,
}

/// Everything the emitters read. All sequences are declaration order.
pub struct Extracted {
    pub version: String,
    pub scalars: Vec<ScalarBind>,
    pub kinds: Vec<KindGen>,
    pub edges: Vec<EdgeGen>,
    pub derived_edges: Vec<EdgeGen>,
    pub enums: Vec<EnumGen>,
    pub inline_enums: Vec<InlineEnumGen>,
    /// `Kind.field` → wire key, declaration order (append-only registry).
    pub field_keys: Vec<(String, u32)>,
    /// Raw parsed `schema.yaml`, for `schema.json`'s generic blocks.
    pub schema_node: Node,
    /// Raw parsed `platforms.yaml`.
    pub platforms_node: Node,
}

impl Extracted {
    pub fn field_key(&self, owner: &str, field: &str) -> Result<u32, ExtractError> {
        let want = format!("{owner}.{field}");
        match self.field_keys.iter().find(|(n, _)| *n == want) {
            Some((_, k)) => Ok(*k),
            None => err(format!(
                "field `{want}` has no key in schema/field-keys.yaml"
            )),
        }
    }
}

/// Rust-primitive field types, exactly `fathom_schema::gates`' list.
const PRIMITIVES: [&str; 9] = ["bool", "u8", "u16", "u32", "u64", "i8", "i16", "i32", "i64"];

pub fn extract(root: &Path, tree: &SchemaTree) -> Result<Extracted, ExtractError> {
    let schema_node = parse_file(&root.join("schema.yaml"))?;
    let platforms_node = parse_file(&root.join("platforms.yaml"))?;

    let version = match &tree.version {
        Some(v) => v.clone(),
        None => return err("schema.yaml declares no schema.version (62 §16.1)"),
    };

    // ---- enums (files already enumerated, in sorted order, by the model) --
    let mut enums = Vec::new();
    for ef in &tree.enums {
        let node = parse_file(&ef.path)?;
        let variants: Vec<String> = ef.variants.iter().map(|(v, _)| v.clone()).collect();
        if variants.is_empty() {
            return err(format!("enum `{}` declares no variants", ef.name));
        }
        for v in &variants {
            check_token(v, &format!("enum `{}` variant", ef.name))?;
        }
        enums.push(EnumGen {
            stem: ef.name.clone(),
            rust_name: camel(&ef.name)?,
            variants,
            node,
        });
    }
    let enum_idx: BTreeMap<&str, usize> = enums
        .iter()
        .enumerate()
        .map(|(i, e)| (e.stem.as_str(), i))
        .collect();

    // ---- scalars ----------------------------------------------------------
    let mut scalars = Vec::new();
    for s in seq(&schema_node, "scalars")? {
        let name = str_of(s, "name", "scalars row")?;
        let impl_path = str_of(s, "impl", &format!("scalar `{name}`"))?;
        let ok_path = (impl_path.strip_prefix("fathom_ir::scalar::"))
            .or_else(|| impl_path.strip_prefix("fathom_ir::value::"))
            .is_some_and(is_ident);
        if !ok_path {
            return err(format!(
                "scalar `{name}` binds impl `{impl_path}`, which is not a \
                 single identifier under fathom_ir::scalar:: or \
                 fathom_ir::value:: — unresolvable, and unreferenceable from \
                 generated code (schema.scalar.unbound, 62 §18.1)"
            ));
        }
        let structured = s
            .get("structured")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        scalars.push(ScalarBind {
            name,
            impl_path,
            structured,
        });
    }
    let scalar_idx: BTreeMap<&str, usize> = scalars
        .iter()
        .enumerate()
        .map(|(i, s)| (s.name.as_str(), i))
        .collect();

    let mut inline_enums: Vec<InlineEnumGen> = Vec::new();
    let mut cx = TyCx {
        scalar_idx: &scalar_idx,
        enum_idx: &enum_idx,
        inline: &mut inline_enums,
    };

    // ---- kinds ------------------------------------------------------------
    let mut kinds = Vec::new();
    for k in seq(&schema_node, "kinds")? {
        let name = str_of(k, "kind", "kinds row")?;
        let layer = match k.get("layer").and_then(|v| v.as_str()) {
            Some("config") => Layer::Config,
            Some("physical") => Layer::Physical,
            Some("service") => Layer::Service,
            other => {
                return err(format!(
                    "kind `{name}` layer `{}` outside the closed vocabulary (62 §4.2)",
                    other.unwrap_or("<missing>")
                ))
            }
        };
        let emits = match k.get("emits").and_then(|v| v.as_bool()) {
            Some(b) => b,
            None => return err(format!("kind `{name}` declares no emits: flag (62 §4.2)")),
        };
        let fields = fields_of(k, &name, &mut cx)?;
        if fields.is_empty() {
            return err(format!("kind `{name}` declares no fields"));
        }
        // The gated model already parsed and validated these; the second
        // element of each pair is the source line, which codegen does not
        // need. No new parsing, and therefore no second reading to disagree.
        let identity: Vec<Vec<String>> = tree
            .kinds
            .iter()
            .find(|mk| mk.name == name)
            .map(|mk| mk.identity.iter().map(|(terms, _)| terms.clone()).collect())
            .unwrap_or_default();
        kinds.push(KindGen {
            name: name.clone(),
            layer,
            emits,
            doc: doc_of(k),
            fields,
            identity,
        });
    }

    // ---- edges and derived edges ------------------------------------------
    // The endpoint vocabulary the `from:`/`to:` sets resolve against: kind
    // names as declared, plus class names expanded to their members
    // (62 §6.2). Built from the gated model so the two readings cannot
    // disagree about what a class contains.
    let kind_names: BTreeMap<&str, ()> = kinds.iter().map(|k| (k.name.as_str(), ())).collect();
    let mut class_members: BTreeMap<&str, Vec<String>> = BTreeMap::new();
    for c in &tree.classes {
        for m in &c.members {
            if !kind_names.contains_key(m.as_str()) {
                return err(format!(
                    "class `{}` names member `{m}`, which is not a declared kind",
                    c.name
                ));
            }
        }
        class_members.insert(c.name.as_str(), c.members.clone());
    }

    let mut edges = Vec::new();
    for e in seq(&schema_node, "edges")? {
        let name = str_of(e, "edge", "edges row")?;
        let class = match e.get("class").and_then(|v| v.as_str()) {
            Some("containment") => EdgeClass::Containment,
            Some("reference") => EdgeClass::Reference,
            other => {
                return err(format!(
                    "edge `{name}` class `{}` outside the closed vocabulary (62 §6.2)",
                    other.unwrap_or("<missing>")
                ))
            }
        };
        let fields = fields_of(e, &name, &mut cx)?;
        let (from_kinds, root_from) =
            endpoint_set(e, &name, "from", true, &kind_names, &class_members)?;
        let (to_kinds, _) = endpoint_set(e, &name, "to", false, &kind_names, &class_members)?;
        let out_l0 = bound_of(e, &name, "out")?;
        let in_l0 = bound_of(e, &name, "in")?;
        let symmetric = match e.get("symmetric").and_then(|v| v.as_bool()) {
            Some(b) => b,
            None => {
                return err(format!(
                    "edge `{name}` declares no symmetric: flag (62 §6.2)"
                ))
            }
        };
        edges.push(EdgeGen {
            name: name.clone(),
            class: Some(class),
            produced_by: None,
            doc: doc_of(e),
            fields,
            from_kinds,
            to_kinds,
            out_l0,
            in_l0,
            symmetric,
            root_from,
        });
    }
    let mut derived_edges = Vec::new();
    for e in seq(&schema_node, "derived_edges")? {
        let name = str_of(e, "edge", "derived_edges row")?;
        let produced_by = str_of(e, "produced_by", &format!("derived edge `{name}`"))?;
        let fields = fields_of(e, &name, &mut cx)?;
        derived_edges.push(EdgeGen {
            name: name.clone(),
            class: None,
            produced_by: Some(produced_by),
            doc: doc_of(e),
            fields,
            // Derived edges carry no endpoint or bound tables: they live in a
            // separate arena and no store writes them (62 §11.4).
            from_kinds: Vec::new(),
            to_kinds: Vec::new(),
            out_l0: (0, None),
            in_l0: (0, None),
            symmetric: false,
            root_from: false,
        });
    }

    // ---- field keys --------------------------------------------------------
    let Some(fk) = &tree.field_keys else {
        return err("schema/field-keys.yaml missing — the wire registry is a generation input");
    };
    let mut field_keys = Vec::new();
    for (name, key, line) in &fk.entries {
        let k = u32::try_from(*key).ok().filter(|k| *k > 0);
        match k {
            Some(k) => field_keys.push((name.clone(), k)),
            None => {
                return err(format!(
                    "field-keys.yaml:{line}: key {key} for `{name}` outside 1..=u32::MAX"
                ))
            }
        }
    }

    let x = Extracted {
        version,
        scalars,
        kinds,
        edges,
        derived_edges,
        enums,
        inline_enums,
        field_keys,
        schema_node,
        platforms_node,
    };
    cross_check(&x, tree)?;
    Ok(x)
}

/// The two readings — this module's and the gated model's — must agree on
/// every shared fact, or generation refuses.
fn cross_check(x: &Extracted, tree: &SchemaTree) -> Result<(), ExtractError> {
    let ours: Vec<&str> = x.kinds.iter().map(|k| k.name.as_str()).collect();
    let model: Vec<&str> = tree.kinds.iter().map(|k| k.name.as_str()).collect();
    if ours != model {
        return err("extracted kind sequence diverges from the gated model's");
    }
    let ours: Vec<&str> = (x.edges.iter().map(|e| e.name.as_str()))
        .chain(x.derived_edges.iter().map(|e| e.name.as_str()))
        .collect();
    let model: Vec<&str> = tree.edges.iter().map(|e| e.name.as_str()).collect();
    if ours != model {
        return err("extracted edge sequence diverges from the gated model's");
    }
    let ours: Vec<&str> = x.scalars.iter().map(|s| s.name.as_str()).collect();
    let model: Vec<&str> = tree.scalars.iter().map(|s| s.name.as_str()).collect();
    if ours != model {
        return err("extracted scalar sequence diverges from the gated model's");
    }
    let derived_model = tree.edges.iter().filter(|e| e.derived).count();
    if x.derived_edges.len() != derived_model {
        return err("extracted derived-edge count diverges from the gated model's");
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// helpers

struct TyCx<'a> {
    scalar_idx: &'a BTreeMap<&'a str, usize>,
    enum_idx: &'a BTreeMap<&'a str, usize>,
    inline: &'a mut Vec<InlineEnumGen>,
}

fn parse_file(path: &Path) -> Result<Node, ExtractError> {
    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) => return err(format!("{}: {e}", path.display())),
    };
    match subset::parse(&text) {
        Ok(n) => Ok(n),
        // Unreachable after a clean gate run (schema.yaml.subset would have
        // fired), kept as a refusal rather than an assumption.
        Err(e) => err(format!("{}:{}: {}", path.display(), e.line, e.message)),
    }
}

fn seq<'a>(node: &'a Node, key: &str) -> Result<&'a [Node], ExtractError> {
    match node.get(key).and_then(|v| v.as_seq()) {
        Some(s) => Ok(s),
        None => err(format!(
            "schema.yaml block `{key}:` missing or not a sequence"
        )),
    }
}

fn str_of(node: &Node, key: &str, what: &str) -> Result<String, ExtractError> {
    match node.get(key).and_then(|v| v.as_str()) {
        Some(s) => Ok(s.to_owned()),
        None => err(format!("{what}: `{key}:` missing or not a string")),
    }
}

/// Doc text as trimmed lines; empty when absent.
fn doc_of(node: &Node) -> Vec<String> {
    match node.get("doc").and_then(|v| v.as_str()) {
        Some(d) => d.lines().map(|l| l.trim_end().to_owned()).collect(),
        None => Vec::new(),
    }
}

fn fields_of(node: &Node, owner: &str, cx: &mut TyCx<'_>) -> Result<Vec<FieldGen>, ExtractError> {
    let Some(list) = node.get("fields").and_then(|v| v.as_seq()) else {
        return err(format!("`{owner}` declares no fields: block"));
    };
    let mut out = Vec::new();
    for f in list {
        let name = str_of(f, "name", &format!("field of `{owner}`"))?;
        let raw_ty = str_of(f, "type", &format!("`{owner}.{name}`"))?;
        let ty = parse_ty(&raw_ty, owner, &name, cx)?;
        let card = str_of(f, "card", &format!("`{owner}.{name}`"))?;
        if !matches!(card.as_str(), "1" | "0..1" | "0..n" | "1..n") {
            return err(format!(
                "`{owner}.{name}` card `{card}` outside 62 §4.3's vocabulary"
            ));
        }
        let emit = match f.get("emit") {
            Some(v) => v.scalar_display(),
            None => return err(format!("`{owner}.{name}` declares no emit (62 §4.3)")),
        };
        out.push(FieldGen {
            name,
            ty,
            raw_ty,
            card,
            emit,
            derived: f.get("derived").is_some(),
            doc: doc_of(f),
        });
    }
    Ok(out)
}

fn parse_ty(
    raw: &str,
    owner: &str,
    field: &str,
    cx: &mut TyCx<'_>,
) -> Result<FieldTy, ExtractError> {
    let t = raw.trim();
    if let Some(&i) = cx.scalar_idx.get(t) {
        return Ok(FieldTy::Scalar(i));
    }
    if let Some(p) = PRIMITIVES.iter().find(|p| **p == t) {
        return Ok(FieldTy::Primitive(p));
    }
    if t == "NodeId" {
        return Ok(FieldTy::NodeId);
    }
    if let Some(inner) = t.strip_prefix("enum(").and_then(|s| s.strip_suffix(')')) {
        return match cx.enum_idx.get(inner.trim()) {
            Some(&i) => Ok(FieldTy::Enum(i)),
            None => err(format!(
                "`{owner}.{field}` names enum file `{}` which does not exist",
                inner.trim()
            )),
        };
    }
    if let Some(rest) = t.strip_prefix("enum") {
        let rest = rest.trim_start();
        if let Some(inner) = rest.strip_prefix('{').and_then(|s| s.strip_suffix('}')) {
            let variants: Vec<String> = inner
                .split(',')
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
                .collect();
            if variants.is_empty() {
                return err(format!("`{owner}.{field}` declares an empty inline enum"));
            }
            for v in &variants {
                check_token(v, &format!("`{owner}.{field}` inline variant"))?;
            }
            let rust_name = format!("{owner}{}", camel(field)?);
            let idx = cx.inline.len();
            cx.inline.push(InlineEnumGen {
                rust_name,
                owner: owner.to_owned(),
                field: field.to_owned(),
                variants,
            });
            return Ok(FieldTy::Inline(idx));
        }
    }
    if let Some(inner) = t.strip_prefix("set{").and_then(|s| s.strip_suffix('}')) {
        return match cx.enum_idx.get(inner.trim()) {
            Some(&i) => Ok(FieldTy::Set(i)),
            None => err(format!(
                "`{owner}.{field}`: set over `{}` — only enum-file members \
                 are generatable today",
                inner.trim()
            )),
        };
    }
    if let Some(inner) = t.strip_prefix("map(").and_then(|s| s.strip_suffix(')')) {
        let Some((k, v)) = inner.split_once(',') else {
            return err(format!("`{owner}.{field}` map type without two parts"));
        };
        let key = parse_map_part(k.trim(), owner, field, cx)?;
        let val = parse_map_part(v.trim(), owner, field, cx)?;
        return Ok(FieldTy::Map(Box::new(key), Box::new(val)));
    }
    err(format!(
        "`{owner}.{field}` type `{raw}` is not generatable — no declared \
         scalar, primitive, enum, set, or map shape matched"
    ))
}

/// Map parts additionally admit a bare enum stem, spelled either exactly or
/// capitalised (`map(Family, Mtu)` keys by `enums/family.yaml` — the gated
/// model's own resolution rule).
fn parse_map_part(
    part: &str,
    owner: &str,
    field: &str,
    cx: &mut TyCx<'_>,
) -> Result<FieldTy, ExtractError> {
    if let Some(&i) = cx.enum_idx.get(part) {
        return Ok(FieldTy::Enum(i));
    }
    if let Some(&i) = cx.enum_idx.get(part.to_ascii_lowercase().as_str()) {
        return Ok(FieldTy::Enum(i));
    }
    parse_ty(part, owner, field, cx)
}

/// The workspace-root token in a containment `from:` set. `62`'s grammar has
/// no root token; `schema.yaml`'s containment section transcribes `11` §7.2's
/// *root* as this literal and files the form gap. It is admitted here in
/// `from:` only, alone, and never in `to:`.
const ROOT_TOKEN: &str = "root";

/// One `from:`/`to:` set, expanded. Returns `(kinds, is_root)`; `is_root` is
/// true exactly when the declared set is `[root]`, in which case `kinds` is
/// empty. Refuses rather than generates from a divergent reading: an unknown
/// name, an empty set, `root` in `to:`, or `root` with company.
fn endpoint_set(
    node: &Node,
    edge: &str,
    key: &str,
    allow_root: bool,
    kind_names: &BTreeMap<&str, ()>,
    class_members: &BTreeMap<&str, Vec<String>>,
) -> Result<(Vec<String>, bool), ExtractError> {
    let Some(list) = node.get(key).and_then(|v| v.as_seq()) else {
        return err(format!("edge `{edge}`: `{key}:` missing or not a sequence"));
    };
    let mut names: Vec<&str> = Vec::new();
    for n in list {
        match n.as_str() {
            Some(s) => names.push(s),
            None => return err(format!("edge `{edge}`: `{key}:` holds a non-string entry")),
        }
    }
    if names.is_empty() {
        return err(format!("edge `{edge}`: `{key}:` is empty"));
    }
    if names.contains(&ROOT_TOKEN) {
        if !allow_root {
            return err(format!(
                "edge `{edge}`: the `{ROOT_TOKEN}` token is admitted in `from:` only, \
                 never in `{key}:`"
            ));
        }
        if names.len() != 1 {
            return err(format!(
                "edge `{edge}`: `{key}: [{ROOT_TOKEN}]` admits no other member"
            ));
        }
        return Ok((Vec::new(), true));
    }
    let mut out: Vec<String> = Vec::new();
    for n in names {
        if let Some(members) = class_members.get(n) {
            out.extend(members.iter().cloned());
        } else if kind_names.contains_key(n) {
            out.push(n.to_owned());
        } else {
            return err(format!(
                "edge `{edge}`: `{key}:` names `{n}`, which is neither a declared kind \
                 nor a declared class"
            ));
        }
    }
    Ok((out, false))
}

/// One cardinality bound, at the L0 level (62 §6.2). Accepts a bare integer
/// `N`, a range `A..B` with `B` an integer or `n`, or the two-level map form
/// `{ l0: <range>, l1: <range> }` whose `l1` entry is read and discarded here
/// — the lower/relaxed level is not the store's to enforce (11 §7.1).
fn bound_of(node: &Node, edge: &str, key: &str) -> Result<(u32, Option<u32>), ExtractError> {
    let Some(v) = node.get(key) else {
        return err(format!(
            "edge `{edge}` declares no `{key}:` bound (62 §6.2)"
        ));
    };
    if let Some(s) = v.as_str() {
        return parse_range(s, edge, key);
    }
    if v.as_map().is_some() {
        let Some(l0) = v.get("l0").and_then(|x| x.as_str()) else {
            return err(format!(
                "edge `{edge}`: `{key}:` is a map without an `l0:` string entry"
            ));
        };
        if v.get("l1").and_then(|x| x.as_str()).is_none() {
            return err(format!(
                "edge `{edge}`: `{key}:` two-level bound without an `l1:` string entry"
            ));
        }
        // The l1 range is validated for form and discarded: this work order
        // generates the L0 tables only.
        let _ = parse_range(
            v.get("l1").and_then(|x| x.as_str()).expect("checked"),
            edge,
            key,
        )?;
        return parse_range(l0, edge, key);
    }
    err(format!(
        "edge `{edge}`: `{key}:` is neither a range string nor a two-level map"
    ))
}

fn parse_range(raw: &str, edge: &str, key: &str) -> Result<(u32, Option<u32>), ExtractError> {
    let t = raw.trim();
    let bad = |what: &str| -> ExtractError {
        ExtractError(format!(
            "edge `{edge}`: `{key}: \"{raw}\"` — {what} (62 §6.2's bound grammar is \
             `N`, `A..B` or `A..n`)"
        ))
    };
    let int = |s: &str| -> Result<u32, ExtractError> {
        s.parse::<u32>().map_err(|_| bad("not an integer"))
    };
    match t.split_once("..") {
        None => {
            let n = int(t)?;
            Ok((n, Some(n)))
        }
        Some((lo, hi)) => {
            let min = int(lo)?;
            if hi == "n" {
                return Ok((min, None));
            }
            let max = int(hi)?;
            if max < min {
                return Err(bad("upper bound below the lower bound"));
            }
            Ok((min, Some(max)))
        }
    }
}

fn is_ident(s: &str) -> bool {
    !s.is_empty()
        && !s.as_bytes()[0].is_ascii_digit()
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

fn check_token(s: &str, what: &str) -> Result<(), ExtractError> {
    let ok = !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
    if ok {
        Ok(())
    } else {
        err(format!("{what} `{s}`: tokens are lower_snake ASCII"))
    }
}

/// `lower_snake` (or kebab) token → `CamelCase` type/variant name.
pub fn camel(token: &str) -> Result<String, ExtractError> {
    let mut out = String::new();
    for part in token.split(['_', '-']) {
        if part.is_empty() {
            return err(format!("token `{token}` has an empty segment"));
        }
        let mut chars = part.chars();
        let first = chars.next().expect("non-empty");
        if !first.is_ascii_lowercase() {
            return err(format!("token `{token}` segment `{part}` must start a-z"));
        }
        out.push(first.to_ascii_uppercase());
        out.push_str(chars.as_str());
    }
    Ok(out)
}

/// `CamelCase` name → `snake_case` module/function name.
pub fn snake(name: &str) -> String {
    let mut out = String::new();
    for (i, c) in name.chars().enumerate() {
        if c.is_ascii_uppercase() {
            if i > 0 {
                out.push('_');
            }
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

/// Escape Rust keywords in generated identifier position.
pub fn rust_ident(name: &str) -> String {
    const KEYWORDS: [&str; 38] = [
        "as", "async", "await", "break", "const", "continue", "dyn", "else", "enum", "extern",
        "false", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut",
        "pub", "ref", "return", "static", "struct", "trait", "true", "type", "union", "unsafe",
        "use", "where", "while", "yield", "try", "box",
    ];
    if KEYWORDS.contains(&name) {
        format!("r#{name}")
    } else {
        name.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn camel_handles_digits_and_kebab() {
        assert_eq!(camel("cable_end").unwrap(), "CableEnd");
        assert_eq!(camel("sfp28").unwrap(), "Sfp28");
        assert_eq!(camel("on-traffic").unwrap(), "OnTraffic");
        assert_eq!(camel("a").unwrap(), "A");
        assert!(camel("Bad").is_err());
        assert!(camel("__").is_err());
    }

    #[test]
    fn snake_reverses_camel() {
        assert_eq!(snake("IkeGateway"), "ike_gateway");
        assert_eq!(snake("Site"), "site");
    }

    #[test]
    fn keywords_are_escaped() {
        assert_eq!(rust_ident("type"), "r#type");
        assert_eq!(rust_ident("name"), "name");
    }
}
