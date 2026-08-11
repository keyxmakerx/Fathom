//! Stage 3 — shape: tokens become one shared CST.
//!
//! `14` §5.1's eleven-line grammar, and its one law: *"every token becomes a
//! path segment and `args` is empty for `display set`."* The shaper does not
//! decide where the path ends — the binder does (`14` §2.4).

use std::collections::BTreeMap;

use crate::frame::{self, ByteSpan, LineClass, LineOrdinal, LineOutcome, Outcome, ShapeError};
use crate::lex::{self, Token, TokenKind, JUNOS_SET};
use crate::redact;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct SegId(pub u32);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct StmtIdx(pub u32);

#[derive(Debug)]
pub struct StmtTree {
    pub arena: Vec<StmtNode>,
    pub roots: Vec<StmtIdx>,
    /// Interned segment text, owned — quoted segments intern escape-resolved,
    /// so a segment cannot slice the capture (§12 item 10). The gate re-points
    /// redacted positions at freshly interned marker segments (§4.6 rule 1);
    /// the binder reads token text from here and nowhere else (§4.6 rule 2).
    pub segs: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct StmtNode {
    pub seg: SegId,
    pub parent: Option<StmtIdx>,
    pub children: Vec<StmtIdx>, // ordered as read (14 §2.4)
    pub span: frame::ByteSpan,  // the whole statement
    pub line: frame::LineOrdinal,
    /// True on the deepest node of each `set` statement's path — the
    /// terminal the binder visits (14 §7.1: only terminals bind).
    pub terminal: bool,
    /// None until stage 4; the gate sets it when it redacts this node's
    /// token and re-points `seg` at a marker segment (§4.6 rule 1). The
    /// binder trusts this flag, never the segment text (§4.6 rule 2).
    pub redacted: Option<redact::RedactLabel>,
}

/// The 12 config-mode verbs (14 §4.3), for continuation decidability. Only
/// `set` shapes in this slice (§4.1; §12 item 3).
pub const VERBS: [&str; 12] = [
    "set",
    "deactivate",
    "delete",
    "activate",
    "annotate",
    "insert",
    "rename",
    "copy",
    "protect",
    "unprotect",
    "wildcard",
    "replace:",
];

/// 14 §11.6's depth cap, applied to a set statement's path length.
pub(crate) const MAX_SEGMENTS: usize = 64;

// ---------------------------------------------------------------------------
// The shaper. Private: the stages are an implementation, not an API.
// ---------------------------------------------------------------------------

/// One shaped `set` statement: the terminal node, the path that reaches it,
/// and the token position behind each path segment. The token positions are
/// what the gate rewrites; the segments are what the binder reads.
#[derive(Debug, Clone)]
pub(crate) struct Stmt {
    pub(crate) line: LineOrdinal,
    pub(crate) span: ByteSpan,
    pub(crate) path: Vec<StmtIdx>,
    pub(crate) tokens: Vec<Token>,
    /// Position within an expanded bracket list, 0 when there was none —
    /// what `ordinal_from_position` numbers a `UsesProposal` edge from.
    pub(crate) list_pos: u32,
}

/// Tokens of a line the shaper refused, kept so the gate can run the
/// value-shape detectors at maximum aggression (`14` §9.7).
#[derive(Debug, Clone)]
pub(crate) struct UnshapedLine {
    pub(crate) line: LineOrdinal,
    pub(crate) span: ByteSpan,
    pub(crate) tokens: Vec<Token>,
}

pub(crate) struct Shaped {
    pub(crate) tree: StmtTree,
    pub(crate) outcomes: Vec<Outcome>,
    pub(crate) stmts: Vec<Stmt>,
    pub(crate) unshaped: Vec<UnshapedLine>,
    /// Noise lines, lexed, for the gate only. Their `LineOutcome` is `Noise`
    /// and stays `Noise`; they are here so no line reaches the end of ingest
    /// without a detector having looked at it (`14` §9.1's gate is the whole
    /// point, and a line it never sees is a line it never gated).
    pub(crate) noise: Vec<UnshapedLine>,
}

pub(crate) fn shape(capture: &str, framed: &frame::Framed) -> Shaped {
    let mut tree = StmtTree {
        arena: Vec::new(),
        roots: Vec::new(),
        segs: Vec::new(),
    };
    let mut intern: BTreeMap<String, SegId> = BTreeMap::new();
    let mut outcomes: Vec<Outcome> = Vec::new();
    let mut stmts: Vec<Stmt> = Vec::new();
    let mut unshaped: Vec<UnshapedLine> = Vec::new();
    let mut noise: Vec<UnshapedLine> = Vec::new();

    for (idx, line) in framed.lines.iter().enumerate() {
        let span = ByteSpan {
            start: line.pieces.first().map(|p| p.start).unwrap_or(0),
            end: line.pieces.last().map(|p| p.end).unwrap_or(0),
        };
        match &line.class {
            LineClass::Blank => {
                outcomes.push(Outcome::new(LineOutcome::Blank));
                continue;
            }
            LineClass::Noise(class) => {
                outcomes.push(Outcome::new(LineOutcome::Noise { class: *class }));
                // A noise line is not a statement, and until 2026-08-10 that
                // meant no detector ever looked at it — `gate` sweeps `stmts`
                // and `unshaped`, and a noise line was in neither. So
                //
                //   admin@srx-a> set security ike policy P pre-shared-key ascii-text S
                //
                // classified as `NoiseClass::Prompt` and kept the key in the
                // capture, in plaintext, with `drops = 0`. **A prompt prefix is
                // what copying out of a terminal session produces by default**,
                // which makes this the likeliest paste in the world rather than
                // a contrived one. Demonstrated against the shipped code before
                // it was fixed; `tests/noise_gate.rs` is the standing proof.
                //
                // The line's OUTCOME stays `Noise` — it really is noise and the
                // ledger should say so. What changes is that its tokens are now
                // handed to the gate, which quarantines the line if any detector
                // fires and leaves it untouched otherwise (`14` §9.7).
                noise.push(UnshapedLine {
                    line: line.ordinal,
                    span,
                    tokens: lex_line(capture, line),
                });
                continue;
            }
            LineClass::Statement => {}
        }
        if let Some(Some(err)) = framed.frame_errors.get(idx) {
            outcomes.push(Outcome::new(LineOutcome::Unshaped { reason: *err }));
            // Refused, and still gated. This arm and the two below wrote
            // `Unshaped` into the ledger and then dropped the line, so no
            // detector ever saw it — the same defect as the `Noise` arm above,
            // in three more places. An unterminated quote is a CLIPPED OR
            // WRAPPED TERMINAL PASTE, one of the likeliest pastes there is, and
            // a pre-shared key on such a line survived verbatim with drops = 0.
            noise.push(UnshapedLine {
                line: line.ordinal,
                span,
                tokens: lex_line(capture, line),
            });
            continue;
        }

        // Lex each physical piece separately: the backslash join replaces the
        // `\` and the following newline with exactly one space, and a join
        // only ever happens at a token boundary (the `\` must be unquoted),
        // so piecewise scanning yields the same token sequence with spans
        // that still slice back to the capture.
        let mut tokens: Vec<Token> = Vec::new();
        let mut lex_error = None;
        let last = line.pieces.len().saturating_sub(1);
        for (piece_idx, piece) in line.pieces.iter().enumerate() {
            let mut piece = *piece;
            if piece_idx < last {
                // Drop the trailing `\` (14 §4.3's join rule).
                piece.end = piece.end.saturating_sub(1);
            }
            if let Err(e) = lex::scan(capture, piece, &JUNOS_SET, &mut tokens) {
                lex_error = Some(e);
                break;
            }
        }
        if let Some(err) = lex_error {
            outcomes.push(Outcome::new(LineOutcome::Unshaped { reason: err }));
            // `tokens` holds whatever was scanned before the error; the gate
            // takes it as-is. Half a line examined beats a whole line
            // unexamined, and `lex_line` re-scans best-effort in case the
            // failure happened on the first piece.
            noise.push(UnshapedLine {
                line: line.ordinal,
                span,
                tokens: if tokens.is_empty() {
                    lex_line(capture, line)
                } else {
                    tokens
                },
            });
            continue;
        }

        let verb = tokens
            .first()
            .filter(|t| t.kind == TokenKind::Bare)
            .map(|t| lex::token_text(capture, t));
        let verb = match verb {
            Some(v) if VERBS.contains(&v) => v,
            _ => {
                outcomes.push(Outcome::new(LineOutcome::Unshaped {
                    reason: ShapeError::NotVerbInitial,
                }));
                unshaped.push(UnshapedLine {
                    line: line.ordinal,
                    span,
                    tokens,
                });
                continue;
            }
        };
        if verb != "set" {
            outcomes.push(Outcome::new(LineOutcome::Unshaped {
                reason: ShapeError::UnsupportedVerb,
            }));
            unshaped.push(UnshapedLine {
                line: line.ordinal,
                span,
                tokens,
            });
            continue;
        }

        let body: Vec<Token> = tokens.iter().skip(1).copied().collect();
        let expanded = match expand_lists(&body) {
            Ok(e) => e,
            Err(reason) => {
                outcomes.push(Outcome::new(LineOutcome::Unshaped { reason }));
                unshaped.push(UnshapedLine {
                    line: line.ordinal,
                    span,
                    tokens,
                });
                continue;
            }
        };
        if expanded.iter().any(|path| path.len() > MAX_SEGMENTS) {
            outcomes.push(Outcome::new(LineOutcome::Unshaped {
                reason: ShapeError::TooManySegments,
            }));
            // The third bypass. A line refused for depth is still a line whose
            // tokens may carry a credential, and `14` §11.6's cap is a
            // resource guard, not a judgement that the content is harmless.
            noise.push(UnshapedLine {
                line: line.ordinal,
                span,
                tokens,
            });
            continue;
        }

        // The line shaped. Its outcome is decided by bind; Unmapped with a
        // zero known prefix is the placeholder until then.
        outcomes.push(Outcome::new(LineOutcome::Unmapped { known_prefix: 0 }));
        for (list_pos, path_tokens) in expanded.into_iter().enumerate() {
            let path = insert(
                capture,
                &mut tree,
                &mut intern,
                &path_tokens,
                span,
                line.ordinal,
            );
            stmts.push(Stmt {
                line: line.ordinal,
                span,
                path,
                tokens: path_tokens,
                list_pos: list_pos as u32,
            });
        }
    }

    Shaped {
        tree,
        outcomes,
        stmts,
        unshaped,
        noise,
    }
}

/// Lex a line best-effort, for the gate. A lex error yields whatever tokens
/// were scanned before it rather than nothing: this feeds a detector sweep, and
/// half a line examined beats a whole line unexamined. The statement path
/// deliberately does NOT do this — there, a lex error is a refusal, because a
/// half-lexed statement would bind wrong facts.
fn lex_line(capture: &str, line: &frame::LogicalLine) -> Vec<Token> {
    let mut tokens: Vec<Token> = Vec::new();
    let last = line.pieces.len().saturating_sub(1);
    for (piece_idx, piece) in line.pieces.iter().enumerate() {
        let mut piece = *piece;
        if piece_idx < last {
            piece.end = piece.end.saturating_sub(1);
        }
        if lex::scan(capture, piece, &JUNOS_SET, &mut tokens).is_err() {
            break;
        }
    }
    tokens
}

/// A bracket list `[ a b ]` expands the statement into one path per list
/// member, in list order, all sharing the line's span (§4.5). Iterative: the
/// work list is drained, never recursed into.
fn expand_lists(body: &[Token]) -> Result<Vec<Vec<Token>>, ShapeError> {
    let mut pending: Vec<Vec<Token>> = vec![body.to_vec()];
    let mut done: Vec<Vec<Token>> = Vec::new();
    while let Some(path) = pending.pop() {
        let open = path.iter().position(|t| t.kind == TokenKind::ListOpen);
        let open = match open {
            Some(o) => o,
            None => {
                if path.iter().any(|t| t.kind == TokenKind::ListClose) {
                    return Err(ShapeError::UnterminatedBracket);
                }
                done.push(path);
                continue;
            }
        };
        let close = match path
            .iter()
            .skip(open + 1)
            .position(|t| t.kind == TokenKind::ListClose)
        {
            Some(c) => open + 1 + c,
            None => return Err(ShapeError::UnterminatedBracket),
        };
        let members: Vec<Token> = path
            .iter()
            .skip(open + 1)
            .take(close - open - 1)
            .copied()
            .collect();
        if members.iter().any(|t| t.kind == TokenKind::ListOpen) {
            return Err(ShapeError::UnterminatedBracket);
        }
        let head: Vec<Token> = path.iter().take(open).copied().collect();
        let tail: Vec<Token> = path.iter().skip(close + 1).copied().collect();
        if members.is_empty() {
            let mut one = head;
            one.extend(tail);
            pending.push(one);
            continue;
        }
        // Push in reverse so the drained order is list order.
        for member in members.iter().rev() {
            let mut one = head.clone();
            one.push(*member);
            one.extend(tail.iter().copied());
            pending.push(one);
        }
    }
    Ok(done)
}

/// Inserts one path, sharing nodes with every statement that shares a prefix
/// (`14` §5.1). Returns the node index of each path position.
fn insert(
    capture: &str,
    tree: &mut StmtTree,
    intern: &mut BTreeMap<String, SegId>,
    tokens: &[Token],
    span: ByteSpan,
    line: LineOrdinal,
) -> Vec<StmtIdx> {
    let mut path = Vec::with_capacity(tokens.len());
    let mut parent: Option<StmtIdx> = None;
    for token in tokens {
        let text = lex::interned_text(capture, token, &JUNOS_SET);
        let seg = match intern.get(&text) {
            Some(s) => *s,
            None => {
                let id = SegId(tree.segs.len() as u32);
                tree.segs.push(text.clone());
                intern.insert(text, id);
                id
            }
        };
        let siblings: &[StmtIdx] = match parent {
            Some(StmtIdx(p)) => tree
                .arena
                .get(p as usize)
                .map(|n| n.children.as_slice())
                .unwrap_or(&[]),
            None => tree.roots.as_slice(),
        };
        let existing = siblings
            .iter()
            .copied()
            .find(|StmtIdx(c)| tree.arena.get(*c as usize).map(|n| n.seg) == Some(seg));
        let idx = match existing {
            Some(idx) => idx,
            None => {
                let idx = StmtIdx(tree.arena.len() as u32);
                tree.arena.push(StmtNode {
                    seg,
                    parent,
                    children: Vec::new(),
                    span,
                    line,
                    terminal: false,
                    redacted: None,
                });
                match parent {
                    Some(StmtIdx(p)) => {
                        if let Some(node) = tree.arena.get_mut(p as usize) {
                            node.children.push(idx);
                        }
                    }
                    None => tree.roots.push(idx),
                }
                idx
            }
        };
        path.push(idx);
        parent = Some(idx);
    }
    if let Some(StmtIdx(last)) = path.last().copied() {
        if let Some(node) = tree.arena.get_mut(last as usize) {
            node.terminal = true;
        }
    }
    path
}

/// `14` §5.1's group DECISION, detect half: any statement whose first path
/// segment is `groups` or `apply-groups`.
pub(crate) fn uses_groups(tree: &StmtTree) -> bool {
    tree.roots.iter().any(|StmtIdx(r)| {
        tree.arena
            .get(*r as usize)
            .and_then(|n| tree.segs.get(n.seg.0 as usize))
            .map(|s| s == "groups" || s == "apply-groups")
            .unwrap_or(false)
    })
}

/// The segment text behind a node, post-gate (§4.6 rule 2: the binder reads
/// segments and nothing else).
pub(crate) fn seg_text(tree: &StmtTree, idx: StmtIdx) -> &str {
    tree.arena
        .get(idx.0 as usize)
        .and_then(|n| tree.segs.get(n.seg.0 as usize))
        .map(|s| s.as_str())
        .unwrap_or("")
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
mod tests {
    use super::*;

    fn shaped(paste: &str) -> (String, Shaped) {
        let framed = frame::frame(paste.as_bytes()).expect("frames");
        let capture = framed.capture.clone();
        let s = shape(&capture, &framed);
        (capture, s)
    }

    #[test]
    fn shared_prefix_statements_share_nodes() {
        let (_, s) = shaped("set security ike gateway GW-B address 203.0.113.10\nset security ike gateway GW-B version v2-only\n");
        assert_eq!(s.stmts.len(), 2);
        // security/ike/gateway/GW-B are shared; two leaves diverge.
        assert_eq!(s.stmts[0].path[3], s.stmts[1].path[3]);
        assert_ne!(s.stmts[0].path[4], s.stmts[1].path[4]);
        assert_eq!(s.tree.roots.len(), 1);
    }

    #[test]
    fn bracket_list_yields_one_terminal_per_member() {
        let (capture, s) = shaped("set security ike policy IKE-POL proposals [ P1 P2 ]\n");
        assert_eq!(s.stmts.len(), 2);
        assert_eq!(seg_text(&s.tree, *s.stmts[0].path.last().unwrap()), "P1");
        assert_eq!(seg_text(&s.tree, *s.stmts[1].path.last().unwrap()), "P2");
        assert_eq!(s.stmts[0].span, s.stmts[1].span);
        assert!(capture.contains("P2"));
    }

    #[test]
    fn deactivate_is_an_unsupported_verb() {
        let (_, s) = shaped("deactivate security ike gateway GW-B\n");
        assert_eq!(
            s.outcomes[0].outcome,
            LineOutcome::Unshaped {
                reason: ShapeError::UnsupportedVerb
            }
        );
    }

    #[test]
    fn clipped_head_is_not_verb_initial() {
        let (_, s) = shaped("ecurity ike policy IKE-POL\n");
        assert_eq!(
            s.outcomes[0].outcome,
            LineOutcome::Unshaped {
                reason: ShapeError::NotVerbInitial
            }
        );
        assert_eq!(s.unshaped.len(), 1);
        assert_eq!(s.unshaped[0].tokens.len(), 4);
    }

    #[test]
    fn unterminated_bracket_is_a_shape_error() {
        let (_, s) = shaped("set a b [ c d\n");
        assert_eq!(
            s.outcomes[0].outcome,
            LineOutcome::Unshaped {
                reason: ShapeError::UnterminatedBracket
            }
        );
    }

    #[test]
    fn too_many_segments_refuses_the_line() {
        let mut paste = String::from("set");
        for i in 0..MAX_SEGMENTS + 1 {
            paste.push_str(&format!(" s{i}"));
        }
        paste.push('\n');
        let (_, s) = shaped(&paste);
        assert_eq!(
            s.outcomes[0].outcome,
            LineOutcome::Unshaped {
                reason: ShapeError::TooManySegments
            }
        );
    }

    #[test]
    fn backslash_continuation_is_one_statement() {
        let (_, s) = shaped(
            "set security ike gateway GW-B dead-peer-detection \\\n  always-send interval 10\n",
        );
        assert_eq!(s.stmts.len(), 1);
        assert_eq!(s.stmts[0].path.len(), 8);
    }

    #[test]
    fn groups_are_detected_never_expanded() {
        let (_, s) = shaped("set groups G1 system host-name x\n");
        assert!(uses_groups(&s.tree));
    }
}
