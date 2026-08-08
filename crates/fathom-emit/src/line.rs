//! Invariant 6 made a type. The field set is `13` §2.2 narrowed to the
//! consumers that exist (WO-04 §12 item 1 records every cut).

use crate::block::BlockId;
use crate::path::StatementPath;
use crate::risk::Risk;

/// Instance-level field reference (13 §2.2). The rule engine's static
/// (kind, field) pair of the same name is 12 §5.1's; 13 §16 OD-1 owns the
/// rename and this crate does not wait for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FieldRef {
    pub node: fathom_graph::NodeId,
    pub field: fathom_ir::bag::FieldKey,
    pub role: FieldRole,
}

/// 13 §2.2's four roles, complete.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldRole {
    Value,
    Subject,
    Referenced,
    Conditioning,
}

/// 13 §2.5's four classes, complete. Declared per statement row in WO-04
/// §4.6, never inferred.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Idempotency {
    Idempotent,
    Accumulating,
    Replacing,
    NonIdempotent,
}

/// A credential placeholder span within `text` (13 §10.3). `hint` is never
/// rendered into `text` — it appears only in the substitution manifest.
#[derive(Debug, Clone)]
pub struct PlaceholderSpan {
    /// Byte offset into `text`.
    pub start: u32,
    pub end: u32,
    pub label: fathom_ir::scalar::SecretLabel,
    pub site: FieldRef,
}

/// One logical junos-srx statement with everything needed to explain it,
/// order it and copy it (53 §6.3.1: the clipboard is built from `text`,
/// and `text` holds one statement).
#[derive(Debug, Clone)]
pub struct EmittedLine {
    /// One logical line. No newlines, no continuation backslashes, no
    /// leading indent (13 §13.3).
    pub text: String,
    pub path: StatementPath,
    /// The node whose stanza this is (13 §2.2).
    pub source_node: fathom_graph::NodeId,
    /// Every (node, field) that contributed a token, in token order
    /// (13 §2.2). Never empty: a line without provenance does not exist
    /// in this crate.
    pub source_fields: Vec<FieldRef>,
    pub risk: Risk,
    pub idempotency: Idempotency,
    pub block: BlockId,
    /// node ordinal × 1000 + statement row (WO-04 §4.5). Within-emit
    /// tiebreak; `path` breaks any residual tie (13 §5.6's key).
    pub order_hint: u32,
    /// Corpus entry point, stamped not resolved (13 §12). Forms:
    /// `explain:field:<Kind>.<snake>` (conventions § Identifiers) and
    /// `explain:kind:<Kind>` (13 §12.2 ladder row 3).
    pub explain: String,
    pub placeholders: Vec<PlaceholderSpan>,
}

impl EmittedLine {
    /// The only constructor. `source_fields` is a non-optional argument, so a
    /// provenance-free line cannot be built by forgetting a field; the test
    /// `every_line_carries_provenance` pins the other half (WO-04 §4.3).
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        text: String,
        path: StatementPath,
        source_node: fathom_graph::NodeId,
        source_fields: Vec<FieldRef>,
        idempotency: Idempotency,
        block: BlockId,
        order_hint: u32,
        explain: &str,
        placeholders: Vec<PlaceholderSpan>,
    ) -> EmittedLine {
        debug_assert!(
            !source_fields.is_empty(),
            "invariant 6: a line without provenance does not exist"
        );
        EmittedLine {
            text,
            path,
            source_node,
            source_fields,
            // Every asserted line in this slice is a `set` statement: it needs
            // a commit and it interrupts no established flow at paste time
            // (ADR-0011 — risk is a property of effect).
            risk: Risk::ChangesConfig,
            idempotency,
            block,
            order_hint,
            explain: explain.to_owned(),
            placeholders,
        }
    }
}
