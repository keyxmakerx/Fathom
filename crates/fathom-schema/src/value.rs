//! The parsed value tree. Maps preserve declaration order — 62 §2.3 makes
//! declaration order the diff order and the generated iteration order, so an
//! order-losing map type here would destroy the property the subset exists for.

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Int(i64),
    /// Accepted pragmatically: 62 §2.2's table lists integer spellings only,
    /// but the shipped tree carries the residue-guard constants 0.75 / 0.15
    /// (11 §10.4). Filed with 62 §22; parsed rather than refused meanwhile.
    Float(f64),
    Str(String),
    Seq(Vec<Node>),
    /// Key order is declaration order, preserved.
    Map(Vec<(String, Node)>),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Node {
    pub value: Value,
    /// 1-based line in the source file.
    pub line: usize,
}

impl Node {
    pub fn new(value: Value, line: usize) -> Self {
        Node { value, line }
    }

    pub fn as_str(&self) -> Option<&str> {
        match &self.value {
            Value::Str(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_map(&self) -> Option<&[(String, Node)]> {
        match &self.value {
            Value::Map(m) => Some(m),
            _ => None,
        }
    }

    pub fn as_seq(&self) -> Option<&[Node]> {
        match &self.value {
            Value::Seq(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match &self.value {
            Value::Bool(b) => Some(*b),
            _ => None,
        }
    }

    pub fn as_int(&self) -> Option<i64> {
        match &self.value {
            Value::Int(i) => Some(*i),
            _ => None,
        }
    }

    /// Map lookup by key, first match (duplicate keys are a gate's business,
    /// not a lookup's).
    pub fn get(&self, key: &str) -> Option<&Node> {
        self.as_map()?
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v)
    }

    /// Renders scalar-ish values back to a display string for messages.
    pub fn scalar_display(&self) -> String {
        match &self.value {
            Value::Null => "null".to_owned(),
            Value::Bool(b) => b.to_string(),
            Value::Int(i) => i.to_string(),
            Value::Float(f) => f.to_string(),
            Value::Str(s) => s.clone(),
            Value::Seq(_) => "[...]".to_owned(),
            Value::Map(_) => "{...}".to_owned(),
        }
    }
}
