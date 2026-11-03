//! Reading and checking. Every problem is collected, not just the first, so
//! the builder can mark each line at once.

use std::collections::{BTreeMap, BTreeSet};

use fathom_schema::subset::{parse_profile, Profile};
use fathom_schema::value::{Node, Value};

use crate::{
    Compare, Condition, Definition, Duration, Family, Field, FieldKind, FieldSet, Job, Lane,
    OverdueAction, OverdueRule, Problem, Scalar, SendBack, Stage, APPROVAL_POWERS,
    DEFINITION_FORMAT, FIELD_SET_FORMAT,
};

const DEFINITION_KEYS: &[&str] = &[
    "fathom",
    "id",
    "name",
    "number",
    "fields",
    "field_sets",
    "stages",
    "lanes",
];
const FIELD_SET_KEYS: &[&str] = &["fathom", "id", "name", "fields"];
const CARRIED_SET_KEYS: &[&str] = &["id", "name", "fields"];
const FIELD_KEYS: &[&str] = &[
    "key", "label", "kind", "required", "choices", "family", "size", "min", "max", "help", "when",
];
const USE_KEYS: &[&str] = &["use"];
const LANE_KEYS: &[&str] = &["id", "name", "starts_after", "stages"];
const STAGE_KEYS: &[&str] = &["id", "name", "approval", "jobs"];
const JOB_KEYS: &[&str] = &[
    "id",
    "name",
    "team",
    "steps",
    "asks",
    "when",
    "due",
    "overdue",
    "optional",
    "makes",
    "needs",
    "send_back",
    "reserves",
    "holds",
];
const SEND_BACK_KEYS: &[&str] = &["to", "label"];
const COMPARE_WORDS: &[&str] = &[
    "is", "is_not", "in", "at_least", "at_most", "set", "not_set",
];
const ESCALATE_ROLES: &[&str] = &["lead", "overseer"];

/// Reads one shared field set file (`fathom: field-set/1`).
pub fn read_field_set(source: &str) -> Result<FieldSet, Vec<Problem>> {
    let mut r = Reader::default();
    let root = match parse_profile(source, Profile::Schema) {
        Ok(n) => n,
        Err(e) => {
            return Err(vec![Problem {
                line: e.line,
                message: e.message,
            }])
        }
    };
    let set = r.field_set(&root, FIELD_SET_KEYS, true);
    if r.problems.is_empty() {
        set.ok_or_else(Vec::new)
    } else {
        Err(r.problems)
    }
}

/// Reads and checks one order definition. `library` is the organisation's
/// shared field sets; a set the file carries itself (`field_sets:`, as an
/// export writes) is used before the library's set of the same id.
pub fn read_definition(source: &str, library: &[FieldSet]) -> Result<Definition, Vec<Problem>> {
    let root = match parse_profile(source, Profile::Schema) {
        Ok(n) => n,
        Err(e) => {
            return Err(vec![Problem {
                line: e.line,
                message: e.message,
            }])
        }
    };
    let mut r = Reader::default();
    let def = r.definition(&root, library);
    match def {
        Some(d) if r.problems.is_empty() => Ok(d),
        _ => {
            let mut p = r.problems;
            if p.is_empty() {
                p.push(Problem {
                    line: root.line,
                    message: "not an order definition".to_owned(),
                });
            }
            p.sort_by_key(|p| p.line);
            Err(p)
        }
    }
}

#[derive(Default)]
struct Reader {
    problems: Vec<Problem>,
}

fn is_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.starts_with(|c: char| c.is_ascii_lowercase())
        && s.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !s.ends_with('-')
}

fn is_key(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.starts_with(|c: char| c.is_ascii_lowercase())
        && s.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

fn parse_duration(s: &str) -> Option<Duration> {
    let (num, unit) = s.split_at(s.len().checked_sub(1)?);
    if num.is_empty() || !num.chars().all(|c| c.is_ascii_digit()) || num.len() > 6 {
        return None;
    }
    let n: u64 = num.parse().ok()?;
    let per = match unit {
        "m" => 1,
        "h" => 60,
        "d" => 60 * 24,
        "w" => 60 * 24 * 7,
        _ => return None,
    };
    Some(Duration { minutes: n * per })
}

impl Reader {
    fn err(&mut self, line: usize, message: impl Into<String>) {
        self.problems.push(Problem {
            line,
            message: message.into(),
        });
    }

    /// Refuses keys not in `allowed` and duplicate keys. Returns the map.
    fn map<'a>(
        &mut self,
        node: &'a Node,
        what: &str,
        allowed: &[&str],
    ) -> Option<&'a [(String, Node)]> {
        let Some(m) = node.as_map() else {
            self.err(node.line, format!("{what} must be a map"));
            return None;
        };
        let mut seen = BTreeSet::new();
        for (k, v) in m {
            if !allowed.contains(&k.as_str()) {
                self.err(
                    v.line,
                    format!(
                        "unknown key `{k}` in {what} (allowed: {})",
                        allowed.join(", ")
                    ),
                );
            }
            if !seen.insert(k.as_str()) {
                self.err(v.line, format!("`{k}` appears twice in {what}"));
            }
        }
        Some(m)
    }

    fn text(&mut self, parent: &Node, key: &str, what: &str, required: bool) -> Option<String> {
        match parent.get(key) {
            None => {
                if required {
                    self.err(parent.line, format!("{what} needs `{key}`"));
                }
                None
            }
            Some(n) => match &n.value {
                Value::Str(s) if !s.trim().is_empty() => Some(s.clone()),
                Value::Int(i) => Some(i.to_string()),
                _ => {
                    self.err(n.line, format!("`{key}` in {what} must be text"));
                    None
                }
            },
        }
    }

    fn id(&mut self, parent: &Node, key: &str, what: &str) -> Option<String> {
        let s = self.text(parent, key, what, true)?;
        if !is_id(&s) {
            let line = parent.get(key).map_or(parent.line, |n| n.line);
            self.err(
                line,
                format!("`{s}` is not a usable id: lowercase letters, digits and hyphens, starting with a letter"),
            );
        }
        Some(s)
    }

    fn bool(&mut self, parent: &Node, key: &str) -> bool {
        match parent.get(key) {
            None => false,
            Some(n) => match n.as_bool() {
                Some(b) => b,
                None => {
                    self.err(n.line, format!("`{key}` must be true or false"));
                    false
                }
            },
        }
    }

    fn texts(&mut self, parent: &Node, key: &str) -> Vec<String> {
        let Some(n) = parent.get(key) else {
            return Vec::new();
        };
        let Some(seq) = n.as_seq() else {
            self.err(n.line, format!("`{key}` must be a list"));
            return Vec::new();
        };
        let mut out = Vec::new();
        for item in seq {
            match &item.value {
                Value::Str(s) if !s.trim().is_empty() => out.push(s.clone()),
                Value::Int(i) => out.push(i.to_string()),
                _ => self.err(item.line, format!("each item of `{key}` must be text")),
            }
        }
        out
    }

    fn duration(&mut self, parent: &Node, key: &str) -> Option<Duration> {
        let n = parent.get(key)?;
        let Some(s) = n.as_str() else {
            self.err(
                n.line,
                format!("`{key}` must be a length of time such as 4h or 2d"),
            );
            return None;
        };
        let d = parse_duration(s);
        if d.is_none() {
            self.err(
                n.line,
                format!(
                    "`{s}` is not a length of time: a number then m, h, d or w, such as 4h or 2d"
                ),
            );
        }
        d
    }

    // ---- definition ---------------------------------------------------------

    fn definition(&mut self, root: &Node, library: &[FieldSet]) -> Option<Definition> {
        self.map(root, "the order definition", DEFINITION_KEYS)?;
        match root.get("fathom").and_then(Node::as_str) {
            Some(DEFINITION_FORMAT) => {}
            Some(other) => self.err(
                root.get("fathom").map_or(1, |n| n.line),
                format!("`fathom: {other}` is not `{DEFINITION_FORMAT}`"),
            ),
            None => self.err(root.line, format!("needs `fathom: {DEFINITION_FORMAT}`")),
        }
        let id = self.id(root, "id", "the order definition");
        let name = self.text(root, "name", "the order definition", true);
        let number = self.text(root, "number", "the order definition", false);
        if let Some(n) = &number {
            if n.is_empty()
                || n.len() > 8
                || !n
                    .chars()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
            {
                self.err(
                    root.get("number").map_or(1, |n| n.line),
                    "`number` is a short code of up to 8 capital letters or digits, such as DIA",
                );
            }
        }

        // Sets the file carries, then the library.
        let mut carried: Vec<FieldSet> = Vec::new();
        if let Some(n) = root.get("field_sets") {
            match n.as_seq() {
                Some(seq) => {
                    for s in seq {
                        if let Some(set) = self.field_set(s, CARRIED_SET_KEYS, false) {
                            if carried.iter().any(|c| c.id == set.id) {
                                self.err(
                                    s.line,
                                    format!("field set `{}` is carried twice", set.id),
                                );
                            } else {
                                carried.push(set);
                            }
                        }
                    }
                }
                None => self.err(n.line, "`field_sets` must be a list"),
            }
        }
        let (fields, used_sets) = self.fields(root, &carried, library);

        let lanes = self.lanes(root, &fields);
        let def = Definition {
            id: id?,
            name: name?,
            number,
            fields,
            field_sets: used_sets,
            lanes,
        };
        self.check_order(&def);
        Some(def)
    }

    fn field_set(&mut self, node: &Node, allowed: &[&str], top: bool) -> Option<FieldSet> {
        self.map(node, "a field set", allowed)?;
        if top {
            match node.get("fathom").and_then(Node::as_str) {
                Some(FIELD_SET_FORMAT) => {}
                _ => self.err(node.line, format!("needs `fathom: {FIELD_SET_FORMAT}`")),
            }
        }
        let id = self.id(node, "id", "a field set");
        let name = self.text(node, "name", "a field set", true);
        let mut fields = Vec::new();
        match node.get("fields").map(|n| (n, n.as_seq())) {
            Some((_, Some(seq))) => {
                for f in seq {
                    if f.get("use").is_some() {
                        self.err(f.line, "a field set cannot use another set");
                        continue;
                    }
                    if let Some(field) = self.field(f, &fields) {
                        fields.push(field);
                    }
                }
            }
            Some((n, None)) => self.err(n.line, "`fields` must be a list"),
            None => self.err(node.line, "a field set needs `fields`"),
        }
        if fields.is_empty() && node.get("fields").is_some() {
            self.err(node.line, "a field set needs at least one field");
        }
        let mut seen = BTreeSet::new();
        for f in &fields {
            if !seen.insert(f.key.clone()) {
                self.err(f.line, format!("field `{}` appears twice", f.key));
            }
        }
        let id = id?;
        for f in &mut fields {
            f.from_set = Some(id.clone());
        }
        Some(FieldSet {
            id,
            name: name?,
            fields,
        })
    }

    fn fields(
        &mut self,
        root: &Node,
        carried: &[FieldSet],
        library: &[FieldSet],
    ) -> (Vec<Field>, Vec<FieldSet>) {
        let mut fields: Vec<Field> = Vec::new();
        let mut used: Vec<FieldSet> = Vec::new();
        let Some(n) = root.get("fields") else {
            return (fields, used);
        };
        let Some(seq) = n.as_seq() else {
            self.err(n.line, "`fields` must be a list");
            return (fields, used);
        };
        for f in seq {
            if f.get("use").is_some() {
                if self.map(f, "a `use` of a field set", USE_KEYS).is_none() {
                    continue;
                }
                let Some(set_id) = self.text(f, "use", "a `use`", true) else {
                    continue;
                };
                let set = carried
                    .iter()
                    .find(|s| s.id == set_id)
                    .or_else(|| library.iter().find(|s| s.id == set_id));
                match set {
                    None => self.err(
                        f.line,
                        format!("no shared field set `{set_id}`: make it under Field sets first, or carry it in `field_sets`"),
                    ),
                    Some(set) if used.iter().any(|u| u.id == set.id) => {
                        self.err(f.line, format!("field set `{set_id}` is used twice"))
                    }
                    Some(set) => {
                        for sf in &set.fields {
                            if fields.iter().any(|e| e.key == sf.key) {
                                self.err(
                                    f.line,
                                    format!("field `{}` from set `{set_id}` clashes with a field of the same key", sf.key),
                                );
                            } else {
                                let mut sf = sf.clone();
                                sf.line = f.line;
                                fields.push(sf);
                            }
                        }
                        used.push(set.clone());
                    }
                }
                continue;
            }
            if let Some(field) = self.field(f, &fields) {
                if fields.iter().any(|e| e.key == field.key) {
                    self.err(f.line, format!("field `{}` appears twice", field.key));
                } else {
                    fields.push(field);
                }
            }
        }
        (fields, used)
    }

    /// One field. `earlier` are the fields declared before it, which its
    /// `when` may name.
    fn field(&mut self, node: &Node, earlier: &[Field]) -> Option<Field> {
        self.map(node, "a field", FIELD_KEYS)?;
        let key = self.text(node, "key", "a field", true);
        if let Some(k) = &key {
            if !is_key(k) {
                self.err(
                    node.line,
                    format!("`{k}` is not a usable field key: lowercase letters, digits and underscores, starting with a letter"),
                );
            }
        }
        let label = self.text(node, "label", "a field", true);
        let kind = match self.text(node, "kind", "a field", true) {
            Some(k) => match FieldKind::from_word(&k) {
                Some(kind) => Some(kind),
                None => {
                    let words: Vec<&str> = FieldKind::ALL.iter().map(|(w, _)| *w).collect();
                    self.err(
                        node.line,
                        format!("`{k}` is not a field kind (one of: {})", words.join(", ")),
                    );
                    None
                }
            },
            None => None,
        };
        let required = self.bool(node, "required");
        let choices = self.texts(node, "choices");
        let help = self.text(node, "help", "a field", false);
        let min = node.get("min").and_then(|n| {
            let v = n.as_int();
            if v.is_none() {
                self.err(n.line, "`min` must be a whole number");
            }
            v
        });
        let max = node.get("max").and_then(|n| {
            let v = n.as_int();
            if v.is_none() {
                self.err(n.line, "`max` must be a whole number");
            }
            v
        });
        let family = node.get("family").and_then(|n| match n.as_str() {
            Some("ipv4") => Some(Family::Ipv4),
            Some("ipv6") => Some(Family::Ipv6),
            _ => {
                self.err(n.line, "`family` is ipv4 or ipv6");
                None
            }
        });
        let size = node.get("size").and_then(|n| match n.as_int() {
            Some(s) if (0..=128).contains(&s) => Some(s as u8),
            _ => {
                self.err(n.line, "`size` is a prefix length such as 29");
                None
            }
        });
        let kind = kind?;

        // Keys that belong to one kind only.
        let line = node.line;
        let is_choice = matches!(kind, FieldKind::Choice | FieldKind::Choices);
        if is_choice {
            if choices.is_empty() {
                self.err(line, "a choice field needs `choices`");
            }
            let mut seen = BTreeSet::new();
            for c in &choices {
                if !seen.insert(c) {
                    self.err(line, format!("choice `{c}` appears twice"));
                }
            }
        } else if node.get("choices").is_some() {
            self.err(line, "`choices` is only for choice and choices fields");
        }
        if kind == FieldKind::Prefix {
            match (family, size) {
                (Some(Family::Ipv4), Some(s)) if s > 32 => {
                    self.err(line, "an IPv4 block is /32 or shorter")
                }
                (Some(_), Some(_)) => {}
                _ => self.err(line, "an address block field needs `family` and `size`"),
            }
        } else if node.get("family").is_some() || node.get("size").is_some() {
            self.err(
                line,
                "`family` and `size` are only for address block (prefix) fields",
            );
        }
        if kind != FieldKind::Number && (min.is_some() || max.is_some()) {
            self.err(line, "`min` and `max` are only for number fields");
        }
        if let (Some(a), Some(b)) = (min, max) {
            if a > b {
                self.err(line, "`min` is above `max`");
            }
        }

        let when = node
            .get("when")
            .and_then(|n| self.condition(n, earlier, "a field's `when`"));
        if let (Some(k), Some(w)) = (&key, &when) {
            if condition_names(w).any(|f| f == k) {
                self.err(line, "a field's `when` cannot name the field itself");
            }
        }
        Some(Field {
            key: key?,
            label: label?,
            kind,
            required,
            choices,
            family,
            size,
            min,
            max,
            help,
            when,
            from_set: None,
            line,
        })
    }

    fn condition(&mut self, node: &Node, fields: &[Field], what: &str) -> Option<Condition> {
        let m = node.as_map().filter(|m| !m.is_empty());
        let Some(m) = m else {
            self.err(
                node.line,
                format!("{what} must be a map such as {{ field: bandwidth, is: 10G }}"),
            );
            return None;
        };
        if m.len() == 1 && (m[0].0 == "all" || m[0].0 == "any") {
            let (k, v) = &m[0];
            let Some(seq) = v.as_seq().filter(|s| !s.is_empty()) else {
                self.err(v.line, format!("`{k}` needs a list of conditions"));
                return None;
            };
            let parts: Vec<Condition> = seq
                .iter()
                .filter_map(|c| self.condition(c, fields, what))
                .collect();
            if parts.len() != seq.len() {
                return None;
            }
            return Some(if k == "all" {
                Condition::All(parts)
            } else {
                Condition::Any(parts)
            });
        }
        let mut allowed = vec!["field"];
        allowed.extend_from_slice(COMPARE_WORDS);
        self.map(node, what, &allowed)?;
        let field_name = self.text(node, "field", what, true)?;
        let ops: Vec<&(String, Node)> = m.iter().filter(|(k, _)| k != "field").collect();
        if ops.len() != 1 {
            self.err(
                node.line,
                format!("{what} needs exactly one of: {}", COMPARE_WORDS.join(", ")),
            );
            return None;
        }
        let Some(field) = fields.iter().find(|f| f.key == field_name) else {
            self.err(
                node.line,
                format!("{what} names `{field_name}`, which is not a field declared before it"),
            );
            return None;
        };
        let (op, v) = (ops[0].0.as_str(), &ops[0].1);
        let compare = match op {
            "is" | "is_not" => {
                let s = self.scalar_for(field, v)?;
                if op == "is" {
                    Compare::Is(s)
                } else {
                    Compare::IsNot(s)
                }
            }
            "in" => {
                let Some(seq) = v.as_seq().filter(|s| !s.is_empty()) else {
                    self.err(v.line, "`in` needs a list");
                    return None;
                };
                let items: Vec<Scalar> = seq
                    .iter()
                    .filter_map(|i| self.scalar_for(field, i))
                    .collect();
                if items.len() != seq.len() {
                    return None;
                }
                Compare::In(items)
            }
            "at_least" | "at_most" => {
                if field.kind != FieldKind::Number {
                    self.err(
                        v.line,
                        format!(
                            "`{op}` is only for number fields; `{}` is not one",
                            field.key
                        ),
                    );
                    return None;
                }
                let Some(i) = v.as_int() else {
                    self.err(v.line, format!("`{op}` needs a whole number"));
                    return None;
                };
                if op == "at_least" {
                    Compare::AtLeast(i)
                } else {
                    Compare::AtMost(i)
                }
            }
            _ => {
                // set / not_set: written `set: true`.
                if v.as_bool() != Some(true) {
                    self.err(v.line, format!("write `{op}: true`"));
                    return None;
                }
                if op == "set" {
                    Compare::Set
                } else {
                    Compare::NotSet
                }
            }
        };
        Some(Condition::Field {
            field: field.key.clone(),
            compare,
        })
    }

    fn scalar_for(&mut self, field: &Field, v: &Node) -> Option<Scalar> {
        let s = match (&v.value, field.kind) {
            (Value::Bool(b), FieldKind::YesNo) => Scalar::Bool(*b),
            (_, FieldKind::YesNo) => {
                self.err(
                    v.line,
                    format!("`{}` is yes/no: compare with true or false", field.key),
                );
                return None;
            }
            (Value::Int(i), FieldKind::Number) => Scalar::Int(*i),
            (_, FieldKind::Number) => {
                self.err(
                    v.line,
                    format!("`{}` is a number: compare with a whole number", field.key),
                );
                return None;
            }
            (Value::Str(s), _) => Scalar::Text(s.clone()),
            (Value::Int(i), _) => Scalar::Text(i.to_string()),
            _ => {
                self.err(v.line, "compare with text, a number, or true/false");
                return None;
            }
        };
        if let (Scalar::Text(t), FieldKind::Choice | FieldKind::Choices) = (&s, field.kind) {
            if !field.choices.contains(t) {
                self.err(
                    v.line,
                    format!(
                        "`{t}` is not one of `{}`'s choices ({})",
                        field.key,
                        field.choices.join(", ")
                    ),
                );
                return None;
            }
        }
        Some(s)
    }

    // ---- lanes, stages, jobs ------------------------------------------------

    fn lanes(&mut self, root: &Node, fields: &[Field]) -> Vec<Lane> {
        match (root.get("stages"), root.get("lanes")) {
            (Some(_), Some(l)) => {
                self.err(
                    l.line,
                    "write `stages` for one lane or `lanes` for several, not both",
                );
                Vec::new()
            }
            (None, None) => {
                self.err(root.line, "an order definition needs `stages` (or `lanes`)");
                Vec::new()
            }
            (Some(s), None) => {
                let stages = self.stages(s, fields);
                vec![Lane {
                    id: "main".to_owned(),
                    name: "Main".to_owned(),
                    starts_after: None,
                    stages,
                    implicit: true,
                    line: s.line,
                }]
            }
            (None, Some(l)) => {
                let Some(seq) = l.as_seq().filter(|s| !s.is_empty()) else {
                    self.err(l.line, "`lanes` needs a list of at least one lane");
                    return Vec::new();
                };
                let mut out = Vec::new();
                for n in seq {
                    if self.map(n, "a lane", LANE_KEYS).is_none() {
                        continue;
                    }
                    let id = self.id(n, "id", "a lane");
                    let name = self.text(n, "name", "a lane", true);
                    let starts_after = self.text(n, "starts_after", "a lane", false);
                    let stages = match n.get("stages") {
                        Some(s) => self.stages(s, fields),
                        None => {
                            self.err(n.line, "a lane needs `stages`");
                            Vec::new()
                        }
                    };
                    if let (Some(id), Some(name)) = (id, name) {
                        out.push(Lane {
                            id,
                            name,
                            starts_after,
                            stages,
                            implicit: false,
                            line: n.line,
                        });
                    }
                }
                out
            }
        }
    }

    fn stages(&mut self, node: &Node, fields: &[Field]) -> Vec<Stage> {
        let Some(seq) = node.as_seq().filter(|s| !s.is_empty()) else {
            self.err(node.line, "`stages` needs a list of at least one stage");
            return Vec::new();
        };
        let mut out = Vec::new();
        for n in seq {
            if self.map(n, "a stage", STAGE_KEYS).is_none() {
                continue;
            }
            let id = self.id(n, "id", "a stage");
            let name = self.text(n, "name", "a stage", true);
            let approval = self.text(n, "approval", "a stage", false);
            if let Some(a) = &approval {
                if !APPROVAL_POWERS.contains(&a.as_str()) {
                    self.err(
                        n.get("approval").map_or(n.line, |x| x.line),
                        format!(
                            "`approval: {a}` must name a team power that signs work off ({})",
                            APPROVAL_POWERS.join(", ")
                        ),
                    );
                }
            }
            let mut jobs = Vec::new();
            match n.get("jobs").map(|j| (j, j.as_seq())) {
                Some((_, Some(seq))) if !seq.is_empty() => {
                    for j in seq {
                        if let Some(job) = self.job(j, fields) {
                            jobs.push(job);
                        }
                    }
                }
                Some((j, _)) => self.err(j.line, "`jobs` needs a list of at least one job"),
                None => self.err(n.line, "a stage needs `jobs`"),
            }
            if let (Some(id), Some(name)) = (id, name) {
                out.push(Stage {
                    id,
                    name,
                    approval,
                    jobs,
                    line: n.line,
                });
            }
        }
        out
    }

    fn job(&mut self, n: &Node, fields: &[Field]) -> Option<Job> {
        self.map(n, "a job", JOB_KEYS)?;
        let id = self.id(n, "id", "a job");
        let name = self.text(n, "name", "a job", true);
        let team = self.id(n, "team", "a job");
        let steps = self.texts(n, "steps");
        let asks = self.texts(n, "asks");
        for a in &asks {
            if !fields.iter().any(|f| &f.key == a) {
                self.err(n.line, format!("`asks` names `{a}`, which is not a field"));
            }
        }
        let when = n
            .get("when")
            .and_then(|w| self.condition(w, fields, "a job's `when`"));
        let due = self.duration(n, "due");
        let optional = self.bool(n, "optional");
        let makes_plan = match n.get("makes") {
            None => false,
            Some(m) if m.as_str() == Some("plan") => true,
            Some(m) => {
                self.err(m.line, "`makes` can only be `plan`");
                false
            }
        };
        let needs = self.texts(n, "needs");
        let send_back = n.get("send_back").and_then(|s| {
            self.map(s, "`send_back`", SEND_BACK_KEYS)?;
            let to = self.id(s, "to", "`send_back`");
            let label = self.text(s, "label", "`send_back`", true);
            Some(SendBack {
                to: to?,
                label: label?,
            })
        });
        let reserves = self.text(n, "reserves", "a job", false);
        if let Some(r) = &reserves {
            match fields.iter().find(|f| &f.key == r) {
                Some(f) if f.kind == FieldKind::Prefix => {}
                Some(_) => self.err(
                    n.line,
                    format!("`reserves` names `{r}`, which is not an address block field"),
                ),
                None => self.err(
                    n.line,
                    format!("`reserves` names `{r}`, which is not a field"),
                ),
            }
        }
        let holds = self.texts(n, "holds");
        let mut seen_holds = BTreeSet::new();
        for h in &holds {
            if !seen_holds.insert(h) {
                self.err(n.line, format!("`holds` names `{h}` twice"));
            }
            match fields.iter().find(|f| &f.key == h) {
                Some(f) if matches!(f.kind, FieldKind::Device | FieldKind::Port) => {}
                Some(_) => self.err(
                    n.line,
                    format!("`holds` names `{h}`, which is not a device or port field"),
                ),
                None => self.err(n.line, format!("`holds` names `{h}`, which is not a field")),
            }
        }
        let overdue = self.overdue(n);
        if !overdue.is_empty() && due.is_none() {
            self.err(n.line, "`overdue` needs a `due` to count from");
        }
        Some(Job {
            id: id?,
            name: name?,
            team: team?,
            steps,
            asks,
            when,
            due,
            overdue,
            optional,
            makes_plan,
            needs,
            send_back,
            reserves,
            holds,
            line: n.line,
        })
    }

    fn overdue(&mut self, job: &Node) -> Vec<OverdueRule> {
        let Some(n) = job.get("overdue") else {
            return Vec::new();
        };
        let Some(seq) = n.as_seq() else {
            self.err(n.line, "`overdue` must be a list of rules");
            return Vec::new();
        };
        let mut out: Vec<OverdueRule> = Vec::new();
        for r in seq {
            if self
                .map(
                    r,
                    "an overdue rule",
                    &["after", "escalate", "reassign", "move_on"],
                )
                .is_none()
            {
                continue;
            }
            let Some(after) = self.duration(r, "after") else {
                if r.get("after").is_none() {
                    self.err(r.line, "an overdue rule needs `after`");
                }
                continue;
            };
            let actions: Vec<&str> = ["escalate", "reassign", "move_on"]
                .into_iter()
                .filter(|k| r.get(k).is_some())
                .collect();
            if actions.len() != 1 {
                self.err(
                    r.line,
                    "an overdue rule does exactly one of: escalate, reassign, move_on",
                );
                continue;
            }
            let action = match actions[0] {
                "escalate" => match r.get("escalate").and_then(Node::as_str) {
                    Some(role) if ESCALATE_ROLES.contains(&role) => {
                        OverdueAction::Escalate(role.to_owned())
                    }
                    _ => {
                        self.err(r.line, "`escalate` is lead or overseer");
                        continue;
                    }
                },
                "reassign" => match r.get("reassign").and_then(Node::as_str) {
                    Some("team") => OverdueAction::ReassignToQueue,
                    Some(slug) if is_id(slug) => OverdueAction::ReassignTo(slug.to_owned()),
                    _ => {
                        self.err(r.line, "`reassign` is `team` or another team's slug");
                        continue;
                    }
                },
                _ => {
                    if r.get("move_on").and_then(Node::as_bool) != Some(true) {
                        self.err(r.line, "write `move_on: true`");
                        continue;
                    }
                    OverdueAction::MoveOn
                }
            };
            if let Some(prev) = out.last() {
                if after < prev.after {
                    self.err(r.line, "overdue rules go in time order: this `after` is earlier than the one before");
                }
            }
            out.push(OverdueRule { after, action });
        }
        out
    }

    // ---- the whole order ----------------------------------------------------

    fn check_order(&mut self, def: &Definition) {
        // Ids are unique across the whole definition, so `needs`, `send_back`
        // and `starts_after` never need a lane to say which one.
        let mut lane_ids = BTreeSet::new();
        let mut stage_at: BTreeMap<&str, (usize, usize)> = BTreeMap::new();
        let mut job_at: BTreeMap<&str, (usize, usize)> = BTreeMap::new();
        for (li, lane) in def.lanes.iter().enumerate() {
            if !lane_ids.insert(lane.id.as_str()) {
                self.err(lane.line, format!("lane `{}` appears twice", lane.id));
            }
            for (si, stage) in lane.stages.iter().enumerate() {
                if stage_at.insert(stage.id.as_str(), (li, si)).is_some() {
                    self.err(stage.line, format!("stage `{}` appears twice", stage.id));
                }
                for job in &stage.jobs {
                    if job_at.insert(job.id.as_str(), (li, si)).is_some() {
                        self.err(job.line, format!("job `{}` appears twice", job.id));
                    }
                }
            }
        }

        for (li, lane) in def.lanes.iter().enumerate() {
            if let Some(after) = &lane.starts_after {
                match stage_at.get(after.as_str()) {
                    None => self.err(lane.line, format!("`starts_after` names `{after}`, which is not a stage")),
                    Some((l, _)) if *l == li => self.err(
                        lane.line,
                        format!("`starts_after` names `{after}` in this same lane; it must be a stage in another lane"),
                    ),
                    Some(_) => {}
                }
            }
            for (si, stage) in lane.stages.iter().enumerate() {
                for job in &stage.jobs {
                    let mut seen = BTreeSet::new();
                    for need in &job.needs {
                        if need == &job.id {
                            self.err(job.line, format!("job `{}` needs itself", job.id));
                        } else if !job_at.contains_key(need.as_str()) {
                            self.err(
                                job.line,
                                format!("`needs` names `{need}`, which is not a job"),
                            );
                        }
                        if !seen.insert(need) {
                            self.err(job.line, format!("`needs` names `{need}` twice"));
                        }
                    }
                    if let Some(sb) = &job.send_back {
                        match stage_at.get(sb.to.as_str()) {
                            Some((l, s)) if *l == li && *s < si => {}
                            Some((l, _)) if *l != li => self.err(
                                job.line,
                                format!("`send_back` goes to `{}` in another lane; it can only go back within its own lane", sb.to),
                            ),
                            Some(_) => self.err(
                                job.line,
                                format!("`send_back` goes to `{}`, which is not an earlier stage", sb.to),
                            ),
                            None => self.err(job.line, format!("`send_back` goes to `{}`, which is not a stage", sb.to)),
                        }
                    }
                    for rule in &job.overdue {
                        if rule.action == OverdueAction::MoveOn {
                            if !job.optional {
                                self.err(
                                    job.line,
                                    "`move_on` is only allowed on a job marked `optional: true`",
                                );
                            }
                            if stage.approval.is_some() {
                                self.err(
                                    job.line,
                                    "`move_on` is not allowed in a stage that needs a sign-off: it waits for a person",
                                );
                            }
                        }
                    }
                }
            }
        }
        if !self.problems.is_empty() {
            return; // the graph below assumes the names resolve
        }
        self.check_loops(def);
    }

    /// Builds the order of work as a graph and refuses a loop: every job must
    /// be able to become ready. Nodes: each stage's start and end, and each
    /// job. A loop here is also how a job left unreachable shows.
    fn check_loops(&mut self, def: &Definition) {
        #[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
        enum N<'a> {
            Start(&'a str),
            End(&'a str),
            Job(&'a str),
        }
        let mut edges: BTreeMap<N, Vec<N>> = BTreeMap::new();
        let mut lines: BTreeMap<N, usize> = BTreeMap::new();
        fn add<'a>(edges: &mut BTreeMap<N<'a>, Vec<N<'a>>>, a: N<'a>, b: N<'a>) {
            edges.entry(b).or_default();
            edges.entry(a).or_default().push(b);
        }
        for lane in &def.lanes {
            for (si, stage) in lane.stages.iter().enumerate() {
                lines.insert(N::Start(&stage.id), stage.line);
                lines.insert(N::End(&stage.id), stage.line);
                if si > 0 {
                    add(
                        &mut edges,
                        N::End(&lane.stages[si - 1].id),
                        N::Start(&stage.id),
                    );
                }
                for job in &stage.jobs {
                    lines.insert(N::Job(&job.id), job.line);
                    add(&mut edges, N::Start(&stage.id), N::Job(&job.id));
                    add(&mut edges, N::Job(&job.id), N::End(&stage.id));
                    for need in &job.needs {
                        add(&mut edges, N::Job(need), N::Job(&job.id));
                    }
                }
            }
            if let (Some(after), Some(first)) = (&lane.starts_after, lane.stages.first()) {
                add(&mut edges, N::End(after), N::Start(&first.id));
            }
        }

        // Kahn: whatever never reaches in-degree zero sits on a loop.
        let mut indeg: BTreeMap<N, usize> = edges.keys().map(|k| (*k, 0)).collect();
        for outs in edges.values() {
            for o in outs {
                *indeg.entry(*o).or_default() += 1;
            }
        }
        let mut ready: Vec<N> = indeg
            .iter()
            .filter(|(_, d)| **d == 0)
            .map(|(k, _)| *k)
            .collect();
        while let Some(n) = ready.pop() {
            for o in edges.get(&n).into_iter().flatten() {
                let d = indeg.get_mut(o).expect("every target is a key");
                *d -= 1;
                if *d == 0 {
                    ready.push(*o);
                }
            }
        }
        let stuck: Vec<&str> = indeg
            .iter()
            .filter(|(_, d)| **d > 0)
            .filter_map(|(k, _)| match k {
                N::Job(j) => Some(*j),
                _ => None,
            })
            .collect();
        if !stuck.is_empty() {
            let first = indeg
                .iter()
                .filter(|(_, d)| **d > 0)
                .filter_map(|(k, _)| lines.get(k))
                .min()
                .copied()
                .unwrap_or(1);
            self.err(
                first,
                format!(
                    "these jobs wait on each other in a loop and could never start: {}. Check `needs`, stage order and `starts_after`",
                    stuck.join(", ")
                ),
            );
        }
    }
}

fn condition_names(c: &Condition) -> Box<dyn Iterator<Item = &str> + '_> {
    match c {
        Condition::Field { field, .. } => Box::new(std::iter::once(field.as_str())),
        Condition::All(cs) | Condition::Any(cs) => Box::new(cs.iter().flat_map(condition_names)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations() {
        assert_eq!(parse_duration("0d"), Some(Duration { minutes: 0 }));
        assert_eq!(parse_duration("4h"), Some(Duration { minutes: 240 }));
        assert_eq!(parse_duration("1w"), Some(Duration { minutes: 10080 }));
        assert_eq!(parse_duration("d"), None);
        assert_eq!(parse_duration("2x"), None);
        assert_eq!(parse_duration("-1d"), None);
        assert_eq!(parse_duration(""), None);
    }

    #[test]
    fn ids_and_keys() {
        assert!(is_id("network-design"));
        assert!(!is_id("Network"));
        assert!(!is_id("a_b"));
        assert!(!is_id("x-"));
        assert!(is_key("wan_v4"));
        assert!(!is_key("wan-v4"));
    }
}
