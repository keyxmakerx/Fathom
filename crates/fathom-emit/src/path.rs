//! `13` §3's addressing scheme, cut to one platform (WO-04 §12 item 1).
//!
//! The path is worth more than the emitted text, because the text is a
//! rendering and the path is the fact. P1 (total order) is the derived `Ord`;
//! P2 (uniqueness within one emit) is enforced in [`crate::order`].

/// `13` §3's addressing scheme. This crate emits one platform (junos-srx), so
/// the `plat` field is not carried; `PLATFORM` names it for reports and for
/// the future multi-platform widening.
pub const PLATFORM: &str = "junos-srx";

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct StatementPath {
    pub tokens: Vec<PathToken>,
}

/// Derived Ord breaks discriminant ties first: Kw < Name < Index < Member
/// (13 §3.1 P1). `Member` marks the identity-bearing value of an
/// accumulating statement — `… proposals IKE-P1` and `… proposals IKE-P2`
/// are two statements, not one with two values (13 §3).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum PathToken {
    Kw(&'static str),
    Name(String),
    Index(u32),
    Member(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discriminant_order_is_kw_name_index_member() {
        let kw = PathToken::Kw("security");
        let name = PathToken::Name(String::from("AAA"));
        let index = PathToken::Index(0);
        let member = PathToken::Member(String::from("AAA"));
        assert!(kw < name);
        assert!(name < index);
        assert!(index < member);
    }

    #[test]
    fn paths_order_lexicographically_over_tokens() {
        let a = StatementPath {
            tokens: vec![PathToken::Kw("security"), PathToken::Kw("ike")],
        };
        let b = StatementPath {
            tokens: vec![
                PathToken::Kw("security"),
                PathToken::Kw("ike"),
                PathToken::Name(String::from("IKE-P1")),
            ],
        };
        assert!(a < b, "a prefix sorts before its extension");
    }
}
