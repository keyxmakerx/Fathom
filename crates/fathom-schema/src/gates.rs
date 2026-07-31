//! The mechanically-checkable subset of 62 §18's gates.
//!
//! Codes come from 62 §18.1 (failures) and §18.2 (warnings) where the spec
//! names one. A finding whose code the spec does not name is emitted with a
//! `proposed:` prefix — the gap is 62's to close, not this tool's to paper
//! over, and a proposed code in output is a standing reminder to file it.
//!
//! Deliberately NOT here (they need artifacts that do not exist yet):
//! `schema.scalar.unbound` and `schema.derive.unknown-fn` (need the Rust
//! impls), `schema.emit.unread` / `schema.emit.attr-read` (need emitter read
//! sets), `schema.attrtype.drift`, `schema.codegen.*` (need codegen),
//! `schema.version.bump-too-small`, `schema.migration.*` (need a released
//! snapshot; `schema/released/` is empty), `ext.budget.*` (need workspace
//! data), and `schema.order.inserted` (needs git history).

use crate::model::{EdgeDecl, KindDecl, SchemaTree};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Severity {
    Warning,
    Failure,
}

#[derive(Debug)]
pub struct Finding {
    pub code: String,
    pub severity: Severity,
    pub file: PathBuf,
    pub line: usize,
    pub message: String,
}

/// 62 §2.3's fixed top-level order for schema.yaml.
const TOPLEVEL_ORDER: [&str; 11] = [
    "schema",
    "scalars",
    "classes",
    "kinds",
    "edges",
    "derived_edges",
    "constraints",
    "emission",
    "matching",
    "scopes",
    "naming_eligible",
];

/// Types usable by fields beyond declared scalars and enum files.
/// `NodeId` is 11 §6.5's registered exception, carried as a comment at both
/// use sites in the shipped tree.
const BUILTIN_TYPES: [&str; 1] = ["NodeId"];

/// Endpoint token for workspace-root containment. 11/19 write `*root*`; the
/// tree transcribes it as `root` (a filed form gap, 62 §22).
const ROOT_ENDPOINT: &str = "root";

/// Rust-primitive field types, used throughout 11 §6's and 19's own field
/// tables (`u8` in RedundancyGroup.node_priority, `bool` flags, counters).
const PRIMITIVES: [&str; 9] = ["bool", "u8", "u16", "u32", "u64", "i8", "i16", "i32", "i64"];

pub fn run(tree: &SchemaTree) -> Vec<Finding> {
    let mut out: Vec<Finding> = Vec::new();
    let mut push =
        |code: &str, severity: Severity, file: &PathBuf, line: usize, message: String| {
            out.push(Finding {
                code: code.to_owned(),
                severity,
                file: file.clone(),
                line,
                message,
            });
        };

    // ---- schema.yaml.subset ------------------------------------------------
    for (path, e) in &tree.subset_errors {
        push(
            "schema.yaml.subset",
            Severity::Failure,
            path,
            e.line,
            e.message.clone(),
        );
    }

    let sp = &tree.schema_path;

    // ---- schema.order.toplevel --------------------------------------------
    {
        let present: Vec<&str> = tree.toplevel_keys.iter().map(|(k, _)| k.as_str()).collect();
        let mut expected = TOPLEVEL_ORDER
            .iter()
            .filter(|k| present.contains(*k))
            .copied()
            .collect::<Vec<_>>()
            .into_iter();
        for (key, line) in &tree.toplevel_keys {
            if !TOPLEVEL_ORDER.contains(&key.as_str()) {
                push(
                    "schema.order.toplevel",
                    Severity::Failure,
                    sp,
                    *line,
                    format!("unknown top-level key `{key}`"),
                );
                continue;
            }
            match expected.next() {
                Some(want) if want == key => {}
                Some(want) => push(
                    "schema.order.toplevel",
                    Severity::Failure,
                    sp,
                    *line,
                    format!("top-level key `{key}` out of order (expected `{want}` here)"),
                ),
                None => {}
            }
        }
    }

    // ---- duplicates --------------------------------------------------------
    {
        let mut seen: BTreeMap<&str, usize> = BTreeMap::new();
        for k in &tree.kinds {
            if let Some(prev) = seen.insert(&k.name, k.line) {
                push(
                    "schema.kind.duplicate",
                    Severity::Failure,
                    sp,
                    k.line,
                    format!("kind `{}` already declared at line {prev}", k.name),
                );
            }
        }
        let mut seen: BTreeMap<&str, usize> = BTreeMap::new();
        for e in &tree.edges {
            if let Some(prev) = seen.insert(&e.name, e.line) {
                push(
                    "schema.edge.duplicate",
                    Severity::Failure,
                    sp,
                    e.line,
                    format!(
                        "edge `{}` already declared at line {prev} (the WarpResolvesVia precedent, 19 §5.3)",
                        e.name
                    ),
                );
            }
        }
        let mut seen: BTreeMap<&str, usize> = BTreeMap::new();
        for s in &tree.scalars {
            if let Some(prev) = seen.insert(&s.name, s.line) {
                push(
                    "proposed:schema.scalar.duplicate",
                    Severity::Failure,
                    sp,
                    s.line,
                    format!(
                        "scalar `{}` already declared at line {prev} (code not named by 62 §18.1)",
                        s.name
                    ),
                );
            }
        }
    }

    let kind_names: BTreeSet<&str> = tree.kinds.iter().map(|k| k.name.as_str()).collect();
    let class_names: BTreeSet<&str> = tree.classes.iter().map(|c| c.name.as_str()).collect();
    let edge_by_name: BTreeMap<&str, &EdgeDecl> =
        tree.edges.iter().map(|e| (e.name.as_str(), e)).collect();

    // ---- schema.class.unknown-member / schema.class.nested -----------------
    for c in &tree.classes {
        for m in &c.members {
            if class_names.contains(m.as_str()) {
                push(
                    "schema.class.nested",
                    Severity::Failure,
                    sp,
                    c.line,
                    format!("class `{}` member `{m}` is itself a class", c.name),
                );
            } else if !kind_names.contains(m.as_str()) {
                push(
                    "schema.class.unknown-member",
                    Severity::Failure,
                    sp,
                    c.line,
                    format!("class `{}` member `{m}` is not a declared kind", c.name),
                );
            }
        }
    }

    // ---- schema.enum.reserved-variant --------------------------------------
    for ef in &tree.enums {
        for (v, line) in &ef.variants {
            if v.eq_ignore_ascii_case("unknown") {
                push(
                    "schema.enum.reserved-variant",
                    Severity::Failure,
                    &ef.path,
                    *line,
                    format!(
                        "enum `{}` declares `{v}`: unknown arms are generated, never declared (62 §7)",
                        ef.name
                    ),
                );
            }
        }
    }

    // ---- field types resolve ----------------------------------------------
    let scalar_names: BTreeSet<&str> = tree.scalars.iter().map(|s| s.name.as_str()).collect();
    let enum_names: BTreeSet<&str> = tree.enums.iter().map(|e| e.name.as_str()).collect();
    let type_ok = |ty: &str| -> bool {
        let ty = ty.trim();
        if scalar_names.contains(ty) || BUILTIN_TYPES.contains(&ty) || PRIMITIVES.contains(&ty) {
            return true;
        }
        if ty.starts_with("enum {") || ty.starts_with("enum{") {
            return true; // inline enum, declared in place
        }
        if let Some(inner) = ty.strip_prefix("enum(").and_then(|s| s.strip_suffix(')')) {
            return enum_names.contains(inner.trim());
        }
        if let Some(inner) = ty.strip_prefix("set{").and_then(|s| s.strip_suffix('}')) {
            let inner = inner.trim();
            return scalar_names.contains(inner) || enum_names.contains(inner);
        }
        if let Some(inner) = ty.strip_prefix("map(").and_then(|s| s.strip_suffix(')')) {
            return inner.split(',').all(|part| {
                let p = part.trim();
                scalar_names.contains(p)
                    || BUILTIN_TYPES.contains(&p)
                    || PRIMITIVES.contains(&p)
                    // `map(Family, Mtu)` keys by the enum whose file is
                    // lower-cased (`enums/family.yaml`) — 11 §6.4's content.
                    || enum_names.contains(p.to_ascii_lowercase().as_str())
            });
        }
        false
    };
    for k in &tree.kinds {
        for f in &k.fields {
            if let Some(ty) = &f.ty {
                if !type_ok(ty) {
                    push(
                        "proposed:schema.field.unknown-type",
                        Severity::Failure,
                        sp,
                        f.line,
                        format!(
                            "`{}.{}` has type `{ty}` which is no declared scalar, enum file, or accepted shape (code not named by 62 §18.1)",
                            k.name, f.name
                        ),
                    );
                }
            }
        }
    }

    // ---- edge endpoints declared ------------------------------------------
    for e in &tree.edges {
        for (side, list) in [("from", &e.from), ("to", &e.to)] {
            for t in list {
                let ok = t == ROOT_ENDPOINT
                    || kind_names.contains(t.as_str())
                    || class_names.contains(t.as_str());
                if !ok {
                    push(
                        "proposed:schema.edge.unknown-endpoint",
                        Severity::Failure,
                        sp,
                        e.line,
                        format!(
                            "edge `{}` {side} names `{t}`, which is no declared kind, class, or `root` (code not named by 62 §18.1)",
                            e.name
                        ),
                    );
                }
            }
        }
    }

    // ---- identity term gates (62 §8.2, §8.4) -------------------------------
    for k in &tree.kinds {
        let field_names: BTreeSet<&str> = k.fields.iter().map(|f| f.name.as_str()).collect();
        let derived_fields: BTreeSet<&str> = k
            .fields
            .iter()
            .filter(|f| f.derived)
            .map(|f| f.name.as_str())
            .collect();
        for (tier, line) in &k.identity {
            // 62 §8.1's own worked example — `[ edge_in(TunnelEndpoint via
            // IpsecVpn), side ]` — resolves the bare `side` against the named
            // edge's fields, so the tier's edge field-names join the scope.
            let mut edge_fields: BTreeSet<&str> = BTreeSet::new();
            for term in tier {
                let inner = term
                    .strip_prefix("edge_in(")
                    .or_else(|| term.strip_prefix("edge("))
                    .and_then(|s| s.strip_suffix(')'));
                if let Some(inner) = inner {
                    let name = inner.split(" via ").next().unwrap_or("");
                    let name = name.split(':').next().unwrap_or("").trim();
                    if let Some(e) = edge_by_name.get(name) {
                        for f in &e.fields {
                            edge_fields.insert(f.name.as_str());
                        }
                    }
                }
            }
            for term in tier {
                check_identity_term(
                    k,
                    term,
                    *line,
                    &field_names,
                    &derived_fields,
                    &edge_fields,
                    &kind_names,
                    &class_names,
                    &edge_by_name,
                    sp,
                    &mut push,
                );
            }
        }
    }

    // ---- schema.scope.absent-unshipped (62 §9.5's decision) ----------------
    for s in &tree.import_scopes {
        match s.absence.as_deref() {
            Some("nothing") => {}
            Some(other) => push(
                "schema.scope.absent-unshipped",
                Severity::Failure,
                sp,
                s.line,
                format!(
                    "ImportScope `{}` declares absence `{other}`: imports never assert Absent (62 §9.5)",
                    s.format
                ),
            ),
            None => push(
                "schema.scope.absent-unshipped",
                Severity::Failure,
                sp,
                s.line,
                format!("ImportScope `{}` declares no absence semantics", s.format),
            ),
        }
    }

    // ---- schema.identity.unexercised (warning, 62 §18.2) -------------------
    for s in &tree.import_scopes {
        for kn in &s.kinds {
            let Some(kind) = tree.kinds.iter().find(|k| &k.name == kn) else {
                push(
                    "proposed:schema.scope.unknown-kind",
                    Severity::Failure,
                    sp,
                    s.line,
                    format!("ImportScope `{}` claims undeclared kind `{kn}`", s.format),
                );
                continue;
            };
            for t in &s.tiers {
                let idx = *t as usize;
                if idx == 0 || idx > kind.identity.len() {
                    push(
                        "schema.identity.unexercised",
                        Severity::Warning,
                        sp,
                        s.line,
                        format!(
                            "ImportScope `{}` claims tier {t} of `{kn}`, which declares {} tier(s) — a scope/identity mismatch (62 §8.4)",
                            s.format,
                            kind.identity.len()
                        ),
                    );
                }
            }
        }
    }

    // ---- schema.emit.on-inert ----------------------------------------------
    for k in &tree.kinds {
        let inert_kind = k.emits == Some(false);
        for f in &k.fields {
            let emit_active = matches!(f.emit.as_deref(), Some(e) if e != "—");
            if emit_active && (inert_kind || f.derived) {
                let why = if f.derived {
                    "a derived field"
                } else {
                    "an emits: false kind"
                };
                push(
                    "schema.emit.on-inert",
                    Severity::Failure,
                    sp,
                    f.line,
                    format!(
                        "`{}.{}` declares emit `{}` on {why}",
                        k.name,
                        f.name,
                        f.emit.as_deref().unwrap_or("")
                    ),
                );
            }
        }
    }

    // ---- field-key registry ------------------------------------------------
    if let Some(fk) = &tree.field_keys {
        let mut declared: BTreeSet<String> = BTreeSet::new();
        for k in &tree.kinds {
            for f in &k.fields {
                declared.insert(format!("{}.{}", k.name, f.name));
            }
        }
        for e in &tree.edges {
            for f in &e.fields {
                declared.insert(format!("{}.{}", e.name, f.name));
            }
        }

        let mut seen_keys: BTreeMap<i64, &str> = BTreeMap::new();
        let mut last = 0i64;
        let mut registered: BTreeSet<&str> = BTreeSet::new();
        for (name, key, line) in &fk.entries {
            registered.insert(name.as_str());
            if let Some(prev) = seen_keys.insert(*key, name) {
                push(
                    "proposed:schema.fieldkey.reused",
                    Severity::Failure,
                    &fk.path,
                    *line,
                    format!("key {key} assigned to both `{prev}` and `{name}` — a key is assigned once and never reused (62 §17.1)"),
                );
            }
            if *key <= last {
                push(
                    "proposed:schema.fieldkey.nonmonotonic",
                    Severity::Failure,
                    &fk.path,
                    *line,
                    format!("key {key} for `{name}` does not increase over the previous key {last} — the registry is append-only"),
                );
            }
            last = *key;
            if !declared.contains(name.as_str()) {
                // A retired field keeps its key forever, so an unknown name is
                // a warning, not a failure — but at v0.1 nothing has retired.
                push(
                    "proposed:schema.fieldkey.unknown-field",
                    Severity::Warning,
                    &fk.path,
                    *line,
                    format!("`{name}` holds key {key} but no declaration carries that name (retired, or stale)"),
                );
            }
        }
        for name in &declared {
            if !registered.contains(name.as_str()) {
                push(
                    "proposed:schema.fieldkey.missing",
                    Severity::Failure,
                    &fk.path,
                    1,
                    format!("declared field `{name}` has no key in the registry"),
                );
            }
        }
    }

    // ---- schema.platform.unknown-vendor ------------------------------------
    if let Some(p) = &tree.platforms {
        let vendors: BTreeSet<&str> = p.vendors.iter().map(String::as_str).collect();
        for (platform, vendor, line) in &p.platforms {
            if !vendors.contains(vendor.as_str()) {
                push(
                    "schema.platform.unknown-vendor",
                    Severity::Failure,
                    &p.path,
                    *line,
                    format!("platform `{platform}` references vendor `{vendor}`, absent from the vendors block"),
                );
            }
        }
    }

    out.sort_by(|a, b| (&a.file, a.line, &a.code).cmp(&(&b.file, b.line, &b.code)));
    out
}

#[allow(clippy::too_many_arguments)]
fn check_identity_term(
    kind: &KindDecl,
    term: &str,
    line: usize,
    field_names: &BTreeSet<&str>,
    derived_fields: &BTreeSet<&str>,
    edge_fields: &BTreeSet<&str>,
    kind_names: &BTreeSet<&str>,
    class_names: &BTreeSet<&str>,
    edge_by_name: &BTreeMap<&str, &EdgeDecl>,
    sp: &PathBuf,
    push: &mut impl FnMut(&str, Severity, &PathBuf, usize, String),
) {
    let term = term.trim();
    if let Some(inner) = term
        .strip_prefix("owner(")
        .and_then(|s| s.strip_suffix(')'))
    {
        let inner = inner.trim();
        if !kind_names.contains(inner) && !class_names.contains(inner) {
            push(
                "proposed:schema.identity.unknown-owner",
                Severity::Failure,
                sp,
                line,
                format!(
                    "`{}` identity term `owner({inner})`: no such kind or class",
                    kind.name
                ),
            );
        }
        return;
    }
    if let Some(inner) = term
        .strip_prefix("edge_in(")
        .and_then(|s| s.strip_suffix(')'))
    {
        let mut parts = inner.split(" via ");
        let e = parts.next().unwrap_or("").trim();
        let k = parts.next().unwrap_or("").trim();
        if !edge_by_name.contains_key(e) {
            push(
                "proposed:schema.identity.unknown-edge",
                Severity::Failure,
                sp,
                line,
                format!(
                    "`{}` identity term `edge_in({e} via {k})`: no such edge",
                    kind.name
                ),
            );
        }
        if !k.is_empty() && !kind_names.contains(k) && !class_names.contains(k) {
            push(
                "proposed:schema.identity.unknown-owner",
                Severity::Failure,
                sp,
                line,
                format!(
                    "`{}` identity term `edge_in({e} via {k})`: no such kind or class `{k}`",
                    kind.name
                ),
            );
        }
        return;
    }
    if let Some(inner) = term.strip_prefix("edge(").and_then(|s| s.strip_suffix(')')) {
        // `edge(Terminates:A)` carries an end qualifier the 62 §8.1 grammar
        // does not have — a filed form-vs-content note in the tree. The edge
        // is resolved by the name before the qualifier.
        let name = inner.split(':').next().unwrap_or("").trim();
        match edge_by_name.get(name) {
            None => push(
                "proposed:schema.identity.unknown-edge",
                Severity::Failure,
                sp,
                line,
                format!(
                    "`{}` identity term `edge({inner})`: no such edge",
                    kind.name
                ),
            ),
            Some(e) => {
                // A qualified term (`edge(Terminates:A)`) selects exactly one
                // end of a multi-ended edge — unambiguous by construction,
                // which is the qualifier's whole job (the tree's filed
                // form-vs-content note on Cable). Otherwise the tightest
                // declared out-bound governs: relaxed L0 with tight L1 is
                // unambiguous per hop (62 §6.2).
                let qualified = inner.contains(':');
                let bound = e.l1_out_bound.as_deref().or(e.out_bound.as_deref());
                let tight = qualified || matches!(bound, Some("1") | Some("0..1"));
                if !tight {
                    push(
                        "schema.identity.ambiguous-edge",
                        Severity::Failure,
                        sp,
                        line,
                        format!(
                            "`{}` identity term `edge({inner})`: `{}` has out-bound `{}`, not 1 or 0..1 (62 §8.2)",
                            kind.name,
                            e.name,
                            bound.unwrap_or("unstated")
                        ),
                    );
                }
            }
        }
        return;
    }
    // A dotted field path. The head must be a real field on the kind; ext and
    // attribute paths are barred as identity terms outright.
    let head = term.split('.').next().unwrap_or(term);
    if head == "ext" {
        push(
            "schema.identity.ext-term",
            Severity::Failure,
            sp,
            line,
            format!(
                "`{}` identity term `{term}` reaches into the extension bag (62 §8.2)",
                kind.name
            ),
        );
        return;
    }
    if head == "attributes" {
        push(
            "schema.identity.attr-term",
            Severity::Failure,
            sp,
            line,
            format!(
                "`{}` identity term `{term}` reaches into an attributes map (62 §8.2)",
                kind.name
            ),
        );
        return;
    }
    if derived_fields.contains(head) {
        push(
            "schema.identity.derived-term",
            Severity::Failure,
            sp,
            line,
            format!(
                "`{}` identity term `{term}` names a derived field (62 §8.2)",
                kind.name
            ),
        );
        return;
    }
    if !field_names.contains(head) && !edge_fields.contains(head) {
        push(
            "proposed:schema.identity.unknown-field",
            Severity::Failure,
            sp,
            line,
            format!(
                "`{}` identity term `{term}`: no field named `{head}` on this kind",
                kind.name
            ),
        );
    }
}
