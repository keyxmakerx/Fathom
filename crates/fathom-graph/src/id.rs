//! The store's composite ids (`11` §13): a kind discriminant plus a ULID.
//!
//! The kind travels inside the id because every consumer that holds an id
//! needs the kind without a store lookup — `62` §13.1's reason for `NodeId`
//! embedding a `Copy` `NodeKind`. The derived `Ord` is (kind declaration
//! order, then ULID), which is the store's iteration order and therefore part
//! of invariant 9's observable surface.

use core::fmt;
use fathom_id::Ulid;
use fathom_ir::generated::ir_types::{EdgeKind, NodeKind};

/// A node's identity: its kind and its ULID.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct NodeId {
    pub kind: NodeKind,
    pub ulid: Ulid,
}

/// An edge's identity. Edges are first-class and carry their own stable id
/// (ADR-0007).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct EdgeId {
    pub kind: EdgeKind,
    pub ulid: Ulid,
}

/// Either kind of graph element. Nodes sort before edges.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ElementId {
    Node(NodeId),
    Edge(EdgeId),
}

impl ElementId {
    /// The ULID, whichever element this is — the key `Graph::resolve_ref`
    /// answers on, because a bare `fathom_id::NodeId` carries nothing else.
    pub fn ulid(self) -> Ulid {
        match self {
            ElementId::Node(n) => n.ulid,
            ElementId::Edge(e) => e.ulid,
        }
    }
}

impl From<NodeId> for ElementId {
    fn from(id: NodeId) -> Self {
        ElementId::Node(id)
    }
}

impl From<EdgeId> for ElementId {
    fn from(id: EdgeId) -> Self {
        ElementId::Edge(id)
    }
}

/// `CamelCase` kind name -> the conventions' `<kind-lower>` segment.
/// `IkeGateway` renders `ike-gateway`.
fn kebab(name: &str) -> String {
    let mut out = String::with_capacity(name.len() + 4);
    for (i, c) in name.chars().enumerate() {
        if c.is_ascii_uppercase() {
            if i > 0 {
                out.push('-');
            }
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

impl fmt::Display for NodeId {
    /// `.context/conventions.md` § *Identifiers*: `<kind-lower>:<ulid>`, with
    /// no product-name prefix (ADR-0005 action 1).
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", kebab(self.kind.name()), self.ulid)
    }
}

impl fmt::Display for EdgeId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", kebab(self.kind.name()), self.ulid)
    }
}

impl fmt::Display for ElementId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ElementId::Node(n) => n.fmt(f),
            ElementId::Edge(e) => e.fmt(f),
        }
    }
}

/// Why a rendered id did not read back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdParseError {
    /// Not `<kebab>:<26 characters>`.
    Shape,
    UnknownKind {
        kebab: String,
    },
    Ulid(fathom_id::DecodeError),
    /// Decodes, but re-encodes differently — a second spelling.
    NonCanonicalUlid,
}

/// The ULID segment, checked for the one spelling it is allowed to have.
///
/// `Ulid::decode` is deliberately Crockford-lenient — case-insensitive, with
/// `I`/`L` aliasing 1 and `O` aliasing 0 (`fathom-id`'s own doc comment, and
/// its `ulid_crockford_aliases_decode` test). A decode-only `parse` would
/// therefore accept `device:0o000…` and silently normalise a hand-edited
/// file, which is the one thing a canonical form exists to stop.
fn parse_ulid(segment: &str) -> Result<Ulid, IdParseError> {
    let decoded = Ulid::decode(segment).map_err(IdParseError::Ulid)?;
    if decoded.encode() != segment {
        return Err(IdParseError::NonCanonicalUlid);
    }
    Ok(decoded)
}

/// Split a rendered id into its kebab kind segment and its ULID segment.
fn split(s: &str) -> Result<(&str, &str), IdParseError> {
    let (kind, ulid) = s.split_once(':').ok_or(IdParseError::Shape)?;
    if kind.is_empty() || ulid.len() != 26 {
        return Err(IdParseError::Shape);
    }
    Ok((kind, ulid))
}

fn node_kind(kebab_name: &str) -> Option<NodeKind> {
    NodeKind::ALL
        .into_iter()
        .find(|k| kebab(k.name()) == kebab_name)
}

fn edge_kind(kebab_name: &str) -> Option<EdgeKind> {
    EdgeKind::ALL
        .into_iter()
        .find(|k| kebab(k.name()) == kebab_name)
}

impl NodeId {
    /// The exact inverse of [`fmt::Display`]:
    /// `parse(x.to_string()) == Ok(x)` for every kind, and
    /// `parse(s)?.to_string() == s` for every accepted `s`.
    pub fn parse(s: &str) -> Result<NodeId, IdParseError> {
        let (kebab_name, ulid_text) = split(s)?;
        let kind = node_kind(kebab_name).ok_or_else(|| IdParseError::UnknownKind {
            kebab: kebab_name.to_owned(),
        })?;
        Ok(NodeId {
            kind,
            ulid: parse_ulid(ulid_text)?,
        })
    }
}

impl EdgeId {
    /// The exact inverse of [`fmt::Display`].
    pub fn parse(s: &str) -> Result<EdgeId, IdParseError> {
        let (kebab_name, ulid_text) = split(s)?;
        let kind = edge_kind(kebab_name).ok_or_else(|| IdParseError::UnknownKind {
            kebab: kebab_name.to_owned(),
        })?;
        Ok(EdgeId {
            kind,
            ulid: parse_ulid(ulid_text)?,
        })
    }
}

impl ElementId {
    /// The exact inverse of [`fmt::Display`]. Node and edge kind names are
    /// disjoint sets (pinned by `node_and_edge_kind_kebabs_are_disjoint`),
    /// which is what makes one rendered id namespace parseable.
    pub fn parse(s: &str) -> Result<ElementId, IdParseError> {
        let (kebab_name, ulid_text) = split(s)?;
        if let Some(kind) = node_kind(kebab_name) {
            return Ok(ElementId::Node(NodeId {
                kind,
                ulid: parse_ulid(ulid_text)?,
            }));
        }
        if let Some(kind) = edge_kind(kebab_name) {
            return Ok(ElementId::Edge(EdgeId {
                kind,
                ulid: parse_ulid(ulid_text)?,
            }));
        }
        Err(IdParseError::UnknownKind {
            kebab: kebab_name.to_owned(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ulid(n: u128) -> Ulid {
        Ulid::from_parts(1_700_000_000_000, n).expect("48-bit timestamp")
    }

    #[test]
    fn ike_gateway_renders_kebab() {
        let id = NodeId {
            kind: NodeKind::IkeGateway,
            ulid: ulid(7),
        };
        let rendered = id.to_string();
        let (kind, ulid_text) = rendered.split_once(':').expect("one separator");
        assert_eq!(kind, "ike-gateway");
        assert_eq!(ulid_text.len(), 26, "26-character Crockford encoding");
        // ADR-0005 action 1: the product name is in no identifier.
        assert!(!rendered.contains("fathom"));
    }

    #[test]
    fn kebab_covers_every_shipped_kind_and_edge() {
        for k in NodeKind::ALL {
            let s = kebab(k.name());
            assert!(
                !s.is_empty() && !s.starts_with('-') && !s.ends_with('-'),
                "{s}"
            );
            assert!(s
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'));
        }
        for e in EdgeKind::ALL {
            let s = kebab(e.name());
            assert!(s
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'));
        }
        assert_eq!(kebab("Site"), "site");
        assert_eq!(kebab("L3Interface"), "l3-interface");
    }

    #[test]
    fn ordering_follows_kind_then_ulid() {
        let a = NodeId {
            kind: NodeKind::Site,
            ulid: ulid(9),
        };
        let b = NodeId {
            kind: NodeKind::Device,
            ulid: ulid(1),
        };
        // Site is declared before Device, so kind wins over the ULID.
        assert!(a < b);
        let c = NodeId {
            kind: NodeKind::Site,
            ulid: ulid(10),
        };
        assert!(a < c);
        // Nodes sort before edges.
        assert!(
            ElementId::Node(a)
                < ElementId::Edge(EdgeId {
                    kind: EdgeKind::HasDevice,
                    ulid: ulid(0)
                })
        );
    }
}
