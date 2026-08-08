//! The emitter entry point and the output type you cannot take the lines out
//! of without the report (`13` §7.2).

use crate::block::{Block, BlockId, BLOCKS};
use crate::junos;
use crate::line::EmittedLine;
use crate::order;
use crate::plan;
use crate::report::{EmitReport, Substitution};
use fathom_graph::{Graph, NodeId};
use fathom_ir::generated::ir_types::NodeKind;

/// The emit unit selector (11 §9.2). One variant in this slice.
#[derive(Debug, Clone, Copy)]
pub enum EmitScope {
    IpsecVpn(NodeId),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EmitError {
    UnknownNode {
        node: NodeId,
    },
    NotAnIpsecVpn {
        node: NodeId,
    },
    /// Kahn terminated early (WO-04 §4.8 makes this unreachable for this
    /// closure; returned rather than panicked if it ever is not).
    OrderingCycle,
}

pub struct EmitOutput {
    lines: Vec<EmittedLine>,
    blocks: Vec<Block>,
    report: EmitReport,
}

impl EmitOutput {
    /// The ONLY accessor (13 §7.2: "There is no `fn lines(&self)`."). The
    /// caller cannot take the lines without the report.
    pub fn parts(&self) -> (&[EmittedLine], &[Block], &EmitReport) {
        (&self.lines, &self.blocks, &self.report)
    }

    /// The paste payload: `text` per line, `\n`-joined, one trailing
    /// newline, no blank lines, no comments, no headers — the parseable
    /// form G8 round-trips and 53 §6.3's copy rules require. Refuses while
    /// the report carries blockers or conflicts.
    pub fn render_config(&self) -> Result<String, RenderRefused> {
        if !self.report.conflicts.is_empty() {
            return Err(RenderRefused::Conflicts {
                count: self.report.conflicts.len(),
            });
        }
        if !self.report.blockers.is_empty() {
            return Err(RenderRefused::Blockers {
                count: self.report.blockers.len(),
            });
        }
        let mut out = String::new();
        for line in &self.lines {
            out.push_str(&line.text);
            out.push('\n');
        }
        Ok(out)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RenderRefused {
    Conflicts { count: usize },
    Blockers { count: usize }, // checked after conflicts
}

/// The emitter (13 §1's total function, junos-srx). Pure: reads the graph
/// and its own const tables; no clock, no RNG, no I/O (invariant 9).
pub fn emit(graph: &Graph, scope: EmitScope) -> Result<EmitOutput, EmitError> {
    let EmitScope::IpsecVpn(root) = scope;
    if graph.node(root).is_none() {
        return Err(EmitError::UnknownNode { node: root });
    }
    if root.kind != NodeKind::IpsecVpn {
        return Err(EmitError::NotAnIpsecVpn { node: root });
    }

    let unit = plan::walk(graph, root);
    let mut lines = Vec::new();
    let mut report = EmitReport::default();
    for member in &unit {
        junos::emit_node(graph, member, &unit, &mut lines, &mut report);
    }
    junos::collect_gaps(graph, &unit, &mut report);

    let lines = order::finalise(lines, &mut report)?;
    report.blockers.sort_by_key(|b| {
        (
            crate::block::rank(b.block),
            b.order_hint,
            b.node,
            b.field.map(|k| k.0),
        )
    });
    report.substitutions = manifest(graph, &lines);

    Ok(EmitOutput {
        lines,
        blocks: BLOCKS.to_vec(),
        report,
    })
}

/// `13` §10.4's manifest, built after ordering so the line index is the one a
/// reader counts. The hint is read from the graph at manifest time and never
/// travels through `EmittedLine.text` (13 §10.1).
fn manifest(graph: &Graph, lines: &[EmittedLine]) -> Vec<Substitution> {
    let mut out = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        for span in &line.placeholders {
            let token = line
                .text
                .get(span.start as usize..span.end as usize)
                .unwrap_or_default()
                .to_owned();
            let hint = graph.node(span.site.node).and_then(|n| {
                fathom_ir::bag::typed::<fathom_ir::scalar::SecretPlaceholder, _>(n, span.site.field)
                    .ok()
                    .and_then(|p| p.hint().map(|h| h.as_str().to_owned()))
            });
            out.push(Substitution {
                line: u32::try_from(i).unwrap_or(u32::MAX),
                token,
                site: span.site,
                hint,
            });
        }
    }
    out
}

/// Block assignment is by source kind (WO-04 §4.5).
pub(crate) fn block_of(kind: NodeKind) -> BlockId {
    match kind {
        NodeKind::IkeProposal | NodeKind::IkePolicy | NodeKind::IkeGateway => BlockId(20),
        _ => BlockId(30),
    }
}
