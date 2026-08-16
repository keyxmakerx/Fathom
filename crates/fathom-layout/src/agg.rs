//! Aggregation — forty identical things drawn as one fact, with the count.
//!
//! `59`'s governing rule, and the reason this file exists:
//!
//! > *"AGGREGATION IS NOT AN OPTIMISATION. IT IS THE STATEMENT THAT FORTY
//! > IDENTICAL THINGS ARE ONE FACT, AND A DIAGRAM THAT DRAWS THEM FORTY TIMES
//! > HAS FAILED TO SAY IT. A COLLAPSE THAT DOES NOT NAME WHAT IT HID AND HOW
//! > MANY THERE WERE IS NOT A BETTER DIAGRAM — IT IS A LIE WITH FEWER
//! > ELEMENTS."*
//!
//! # Why this runs BEFORE layout, when layer filtering runs after
//!
//! The two look like the same kind of thing and they sit on opposite sides of
//! the layout step, for one reason: **aggregation changes what the nodes are;
//! filtering changes which of them are painted.**
//!
//! - A collapsed group is a box that no node in the graph corresponds to. It
//!   has its own extent, its own label, and it is the terminal of every edge
//!   its members had. Nothing downstream — ranking, placement, routing,
//!   labelling — can be given the un-collapsed graph and asked to draw the
//!   collapsed picture, because the thing it must draw is not in the input.
//!   `59` §3.1 says it directly: it is *"a transform on the model, run before
//!   layout"*, and the evidence is that `A2-aggregated.html` added it without
//!   touching the layout engine, the channel allocator, the crossing detector
//!   or the label placer — **all four simply received a smaller graph**.
//! - A layer toggle changes no node's identity and no node's position. `56`
//!   §3.6 is explicit and it is a decision, not an implementation note:
//!   *"layout is computed once, over the union of all layers, and a layer
//!   toggle filters what is drawn. Toggling a layer never moves anything."*
//!   Filtering before layout would give an L3-only view different coordinates
//!   from the same estate's physical view, which is the behaviour that makes
//!   people stop using layer toggles.
//!
//! `59` failure mode 4 names the cost of getting this backwards: aggregation
//! implemented *inside* layout grows a collapsed-group special case in the
//! router, the channel allocator and the label placer, and crossings appear.
//! Conflating the two in the other direction is worse and quieter — the
//! picture would rearrange itself every time a layer was toggled.
//!
//! # Where the expand/collapse state lives, and what that does NOT decide
//!
//! **It is a parameter, not stored state.** [`View`] is passed in on every
//! call; this crate holds nothing between calls, the graph holds nothing, and
//! `schema/` gains no field. Three reasons, in order of weight:
//!
//! 1. **It is not an estate fact.** Nothing about the network changes when a
//!    reader opens a group. `56` §0's governing rule — *"if a fact exists only
//!    in the picture, the picture has become the data structure"* — cuts the
//!    other way here: putting *"I am currently looking at these six"* in the
//!    graph would be inventing estate state out of a scroll position.
//! 2. **A group's identity is derived, so it can stop existing.** The key is
//!    minted from the run's first member (see [`Cell::group`]); add a node in
//!    the middle of a run, or make one member heterogeneous, and the run
//!    splits and the key names a group that is no longer there. Persisting a
//!    key that can stop existing buys a tombstone problem for nothing.
//! 3. **Passing it in keeps layout a pure function.** `lay_out_with(graph,
//!    view)` is reproducible from its two arguments, which is invariant 9 in
//!    the form that matters for a picture: two engineers with the same estate
//!    and the same open groups get the same diagram, and neither has to have
//!    the same history.
//!
//! **Contrast with a pin, which is why this does not answer `56` §3.5.** A pin
//! is a *human assertion about the picture* — `56` §3.5 gives it `Origin::Hand`
//! provenance precisely because it is one, and a human assertion cannot be
//! recomputed from anything. Expansion carries no assertion: it is recomputable
//! from nothing because it means nothing. That is the whole line, and it is
//! narrow. **`56` §3.5's open question — where a pin lives, and where the rest
//! of the view's preferences live — is untouched by this file and is still
//! open.** Nobody should read this module as having answered it.

use fathom_graph::{Graph, NodeId, Origin};
use fathom_ir::generated::ir_types::{EdgeKind, NodeKind};

/// The **legibility** ceiling (`59` §2.4), which is not `44` §4.7.4's
/// performance ceiling and does not imply it. More than this many like-kind
/// siblings in one group is drawn as one collapsed group with a count.
///
/// Six, and the argument that settles it is `56` §5.4's: its edge vocabulary
/// already replaces an enumerated like-kind list with a named range and a count
/// *above six* (`vlan 10–40 (14)`), authored before the aggregation study
/// existed. Eight would give the diagram two collapse thresholds for one
/// behaviour and no reason for the difference. The supporting derivation is
/// geometric — `56` §5.6's `layer_pitch` 96 px over `51` §14's `--lh-micro`
/// 16 px, the port lattice, is exactly 6 — and above it a like-kind field is
/// taller than a whole rank of the estate plus its routing channel.
///
/// **A constant, never a setting** (`59` §3.2, failure mode 3): a per-workspace
/// threshold's only effect is to make two engineers' screenshots of one estate
/// disagree.
pub const THRESHOLD: usize = 6;

/// How many members an opened **unbounded** group draws at a time (`59` §3.7).
/// Expansion is **windowed**: the picture never offers "expand all" on an
/// unbounded group, because A3's incremental-reveal ladder was measured
/// terminating at 521 elements against the 515 it costs never to aggregate at
/// all — the seventh activation reconstructed exactly the texture the collapse
/// existed to remove.
///
/// A **bounded** group is exempt and expands all at once; see [`bounded`].
pub const WINDOW: usize = THRESHOLD;

/// What the reader currently has open. **Session state, and only ever a
/// parameter** — see the module header for why it is not in `schema/`, not in
/// the graph and not held here.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct View {
    /// `false` is `59` §3.7's `every one drawn` control, retained in the
    /// product and not only in the study: *"an engineer who does not believe
    /// the count is entitled to see the forty."* It is also the meaning
    /// [`crate::lay_out`] has always had, so that function's behaviour is
    /// unchanged by this module.
    pub aggregate: bool,
    /// Group key -> the index of the first member drawn, **sorted by key**.
    ///
    /// A sorted `Vec` and not a `BTreeMap`, which is the other half of the
    /// house rule (invariant 9: *"BTreeMap/BTreeSet and sorted Vec only"*).
    /// The reason is measured, not stylistic: this crate reaches the browser
    /// through a module with a 900 000-byte ceiling (`44` §5.2), and
    /// `order.rs` measured one `BTreeMap<NodeId, u32>` at **11,197 bytes** of
    /// generic tree code that a sorted `Vec` plus `binary_search` gets for
    /// free. The ordering guarantee is identical; only the code size differs.
    open: Vec<(String, usize)>,
}

impl View {
    /// Every node drawn as itself. No group collapses.
    pub fn whole() -> View {
        View {
            aggregate: false,
            open: Vec::new(),
        }
    }

    /// The product default: collapse above [`THRESHOLD`], nothing opened.
    pub fn folded() -> View {
        View {
            aggregate: true,
            open: Vec::new(),
        }
    }

    /// Open `key` at member `at`, replacing any offset it already had.
    pub fn open_at(&mut self, key: &str, at: usize) {
        match self.open.binary_search_by(|(k, _)| k.as_str().cmp(key)) {
            Ok(i) => {
                if let Some(slot) = self.open.get_mut(i) {
                    slot.1 = at;
                }
            }
            Err(i) => self.open.insert(i, (key.to_owned(), at)),
        }
    }

    /// The offset `key` is opened at, or `None` if it is collapsed.
    pub fn opened(&self, key: &str) -> Option<usize> {
        let i = self
            .open
            .binary_search_by(|(k, _)| k.as_str().cmp(key))
            .ok()?;
        self.open.get(i).map(|(_, at)| *at)
    }

    /// The wire form the host sends: one directive per line.
    ///
    /// | line | meaning |
    /// |---|---|
    /// | (empty request) | [`View::folded`] |
    /// | `*` | [`View::whole`] |
    /// | `<group key>` | that group open at its first member |
    /// | `<group key>#<n>` | that group open at member `n` |
    ///
    /// An unparseable offset is read as `0` rather than refused: the worst it
    /// can do is open a group at its start, and a diagram that refuses to draw
    /// because a view preference was malformed is a worse failure than one that
    /// draws the group from the top.
    pub fn parse(request: &str) -> View {
        let mut v = View::folded();
        for line in request.split('\n') {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if line == "*" {
                v.aggregate = false;
                continue;
            }
            match line.split_once('#') {
                Some((key, at)) => v.open_at(key, at.parse().unwrap_or(0)),
                None => v.open_at(line, 0),
            }
        }
        v
    }
}

/// One drawn box before it has a position: either one node, or a run of
/// like-kind siblings standing for many.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cell {
    /// What the page posts back. A node's display id, or `agg:<display id of
    /// the run's first member>#<offset>` for a group. The `agg:` prefix is what
    /// keeps a group key out of `fathom_inventory::parse_display_id`, which
    /// requires the string to be byte-equal to the element's own rendered id.
    ///
    /// **A cell standing for one node always carries that node's own display
    /// id**, never a group key — see [`residual`]. The page posts this string
    /// to `OP_ELEMENT` whenever [`Cell::count`] is 1, and a group key sent
    /// there is a refusal the reader cannot act on.
    pub key: String,
    pub kind: &'static str,
    /// The node's name, or the group's **named range** — `st0.0–st0.39`.
    ///
    /// Both ends are written in full rather than elided to `st0.0–39`. `59`
    /// §6.9 files the elided form's real defect, found latent in
    /// `A2-aggregated.html`: it took the last *character* of the last member,
    /// so `xe-0/0/2 … xe-0/0/25` rendered `xe-0/0/2–5`. **A range string that
    /// silently lies is worse than no range string**, and the full form cannot
    /// have that class of bug at all.
    pub label: String,
    pub rank: u32,
    /// The run's first member. The sort key within a rank, so cell order is a
    /// pure function of content.
    pub anchor: NodeId,
    /// Every graph node this box stands for. Length 1 for a plain box.
    pub members: Vec<NodeId>,
    /// The group this box belongs to, or empty.
    ///
    /// On a **collapsed** box it carries the offset activating it asks for —
    /// `agg:…#12` — so the residuals of a windowed expansion are page controls
    /// that walk the run in both directions (`59` §3.7). On a **drawn member**
    /// of an opened group it is the bare key, so the host can name the group a
    /// focused element belongs to without a second lookup.
    pub group: String,
    /// `Device.role`'s token when this box stands for exactly one `Device` that
    /// has one, and empty otherwise (ADR-0037).
    ///
    /// **Empty on every collapsed box, deliberately.** A collapsed box stands
    /// for a run of nodes whose aggregation signature matched, and the
    /// signature does not include `role` — so a run can hold a firewall and a
    /// server, and printing either one's role on the box would be a claim about
    /// all of them. The same rule already governs [`Cell::key`] and the pin: a
    /// fact about one node is only printable on a box that stands for one node.
    pub role: String,
}

impl Cell {
    /// How many graph nodes this box stands for. `1` is a plain box.
    pub fn count(&self) -> usize {
        self.members.len()
    }
}

/// The declared attribute set (`59` §3.11), computed per node.
///
/// > *"A group that is not uniform in the attributes the picture encodes may
/// > not collapse silently."*
///
/// Two nodes share a collapsed box only when this is equal, which is `59`
/// §3.14.2's key — *"every allocated channel would render them identically"* —
/// applied to nodes rather than to edges. It is deliberately **not** every
/// field: a group whose members differ only in their IP address is uniform for
/// this purpose, and a group whose members differ in what they are wired to is
/// not.
///
/// **What is in it, and why each is in it:**
///
/// - `origin` — `59` §3.11 names provenance origin explicitly. A hand-authored
///   sibling among thirty-nine parsed ones is the *"one of these forty is not
///   like the others"* case, and it is the single most common reason anyone
///   opens a hub diagram.
/// - `edges` — every live edge incident on the node, as
///   `(edge kind, direction, the kind at the other end)`. This is what the
///   picture actually draws around the node, so it is what must match for two
///   nodes to be drawn as one.
///
/// **What is deliberately NOT in it, and this is a limitation rather than a
/// decision:** `56` §8's evidence *age band*, which `59` §3.11 also names. An
/// age band is `now − asserted_at` and `now` is a host fact this side of the
/// boundary does not have (invariant 9: no clock below the host boundary). The
/// raw `asserted_at` is not a substitute — two hand-authored siblings entered a
/// millisecond apart are not different ages in any sense a reader cares about,
/// and keying on it would stop every hand-built estate aggregating at all. The
/// band joins this set the moment the host clock crosses the boundary as a
/// parameter, which is how `OP_PASTE` already carries it.
///
/// Packed into one sorted `Vec<u32>` rather than a struct of parts, for the
/// byte reason [`View::open`] carries: this crate is compiled into a module
/// with a hard size ceiling, and one `Vec<u32>` is code the module already has.
/// The origin is the leading word; every other word is one incident edge.
type Sig = Vec<u32>;

/// The bit that separates an incident-edge word from an origin word, so the
/// origin always sorts first and the two can never collide.
const EDGE_TAG: u32 = 1 << 31;
/// Where the edge kind sits inside a packed word — above the 9 bits a
/// `NodeKind` needs (48 kinds) and its direction bit.
const EDGE_SHIFT: u32 = 10;
/// 21 bits, which holds `schema/`'s 89 edge kinds with three orders of
/// magnitude to spare.
const EDGE_MASK: u32 = (1 << 21) - 1;

/// `(edge kind, direction, the kind at the far end)` in one word. The three
/// fields are packed rather than tupled so the comparison is an integer
/// compare; nothing outside this file reads the layout.
fn term(edge: EdgeKind, out: bool, far: NodeKind) -> u32 {
    EDGE_TAG | ((edge as u32) << EDGE_SHIFT) | ((far as u32) << 1) | u32::from(out)
}

/// The edge kind packed into one signature word, or `None` for the origin word.
fn term_edge(word: u32) -> Option<u32> {
    if word & EDGE_TAG == 0 {
        None
    } else {
        Some((word >> EDGE_SHIFT) & EDGE_MASK)
    }
}

/// Is this run's set **bounded**, in the sense `59` §3.7 exempts from
/// windowing?
///
/// > *"One principled exception, and it is per group KIND, not global. LAG
/// > members expand all-or-nothing. An aggregate interface is a **bounded,
/// > unordered** set … so there is no page to walk and no ordering worth
/// > walking it in. The tunnel fan is unbounded and ordered by spoke index.
/// > The window applies to the fan."*
///
/// `59` §9 records the same thing as a DECISION with a RECOMMENDATION to take
/// it — *"expansion is windowed on unbounded groups and all-or-nothing on
/// bounded ones"* — and the previous attempt at this file implemented one
/// `WINDOW` for every kind and reported the decision as complete. It is built
/// here.
///
/// **Read off the signature rather than a hand-written table of kinds.** §9
/// says the rule is *"per group kind"*, and the kind that matters is not
/// `Interface` — most `Interface` runs are an ordinary unbounded port field —
/// it is *"member of an aggregate"*. That is an edge, `MemberOfAggregate` or
/// `MemberOfReth`, and every member of a run shares one signature by
/// construction, so the property is already computed and costs a scan of a
/// short vector. A `NodeKind` table would have had to say `Interface` and would
/// have exempted every port field in the estate from windowing, which is the
/// opposite of what §3.7 argues.
///
/// The rejected alternative is to leave it unbuilt because junos-srx ingest
/// does not yet build an `ae`: that is how the previous attempt shipped an
/// unimplemented DECISION as done, and the guard is fifteen lines.
fn bounded(sig: &[u32]) -> bool {
    const AGG: u32 = EdgeKind::MemberOfAggregate as u32;
    const RETH: u32 = EdgeKind::MemberOfReth as u32;
    sig.iter()
        .filter_map(|w| term_edge(*w))
        .any(|e| e == AGG || e == RETH)
}

fn origin_code(g: &Graph, id: NodeId) -> u32 {
    match g.node(id).and_then(|n| g.provenance(n.existence)) {
        Some(p) => match p.origin {
            Origin::Hand => 0,
            Origin::Parsed { .. } => 1,
        },
        // A node whose existence record cannot be read is its own class. It
        // should be unreachable; grouping it with either of the others would be
        // asserting a provenance nobody established.
        None => 2,
    }
}

/// One pass over the edge arena rather than `nodes × EdgeKind::ALL × 2`
/// lookups. The result is parallel to `live`, which is sorted, so a lookup is a
/// binary search and no second keyed collection exists.
///
/// The signature is only ever compared for equality, so **the multiset is the
/// value** and the order the arena happened to yield the edges in must not be
/// part of it. Two nodes with the same incident edges created in a different
/// order are the same to the picture, and a run that split on that would be a
/// diagram whose grouping depended on typing order.
///
/// Each word is therefore inserted in place rather than pushed and the whole
/// vector sorted afterwards. That is `O(k²)` in one node's degree — under ten
/// for everything junos-srx builds — against a `sort_unstable` over `u32`,
/// which is a pdqsort instantiation this module does not otherwise have.
/// **Measured 2026-08-15, both ways, release `wasm32-unknown-unknown`: 890,872
/// bytes with the sort, 886,317 with the insert — 4,555 bytes**, against `44`
/// §5.2's 900,000-byte ceiling with 29,023 free when this work started. A
/// quadratic loop over a node's own edges is the cheaper of the two by a wide
/// margin and it is the same answer for the same reason `order.rs` gave up its
/// `BTreeMap`.
fn signatures(g: &Graph, live: &[NodeId]) -> Vec<Sig> {
    let mut out: Vec<Sig> = live.iter().map(|id| vec![origin_code(g, *id)]).collect();
    let add = |s: &mut Sig, w: u32| {
        let at = s.binary_search(&w).unwrap_or_else(|i| i);
        s.insert(at, w);
    };
    for e in g.edges() {
        // A line to a tombstoned node is not drawn, so it is not part of what
        // the picture claims about either end.
        if e.absent_since.is_some() {
            continue;
        }
        let (Ok(a), Ok(b)) = (live.binary_search(&e.from), live.binary_search(&e.to)) else {
            continue;
        };
        if let Some(s) = out.get_mut(a) {
            add(s, term(e.id.kind, true, e.to.kind));
        }
        if let Some(s) = out.get_mut(b) {
            add(s, term(e.id.kind, false, e.from.kind));
        }
    }
    out
}

/// Every live node the picture is *about*, in `NodeId` order.
///
/// `LayoutPin` is dropped here and nowhere else (ADR-0035). A pin is not a thing
/// on the network — it is the assertion *"a person put this box here"*, stored in
/// the graph because that is the only place an assertion can survive an export
/// and reach a colleague. Drawing it would put one box per placed box on the
/// canvas, each hanging off its subject by a containment line, which is the
/// picture describing its own bookkeeping.
///
/// Dropping it here rather than in `lay_out` is deliberate: `at` — the node → box
/// map every later stage indexes — is built from this list, so a pin is absent
/// from ordering, routing and the aggregation signature by construction rather
/// than by three more filters that could disagree.
fn live_nodes(g: &Graph) -> Vec<NodeId> {
    NodeKind::ALL
        .into_iter()
        .filter(|k| !matches!(k, NodeKind::LayoutPin))
        .flat_map(|k| g.nodes_of_kind(k))
        .filter(|n| n.absent_since.is_none())
        .map(|n| n.id)
        .collect()
}

/// The transform: the estate's live nodes, folded into the boxes the layout
/// will place.
///
/// # The two orderings, both declared
///
/// The un-aggregated picture and the aggregated one are ordered by different
/// rules, and **the un-aggregated rule is the one this crate has always had**:
///
/// | view | cell order within a rank |
/// |---|---|
/// | [`View::whole`] | `NodeId` — every node its own box, exactly as `lay_out` ordered them before this file existed |
/// | [`View::folded`] | drawn parent, then the run's anchor `NodeId`; members of one run adjacent, in `NodeId` order |
///
/// The whole branch is separate code rather than the folded branch with runs
/// of one, and that is deliberate. Run detection groups like-kind siblings
/// together, and **two runs interleave in `NodeId` order** — so drawing a run's
/// members individually through the folded path would emit them adjacent and
/// silently reorder rows in the un-aggregated picture. That is a behaviour
/// change to a shipped function, `tests/agg.rs` pins the coordinates against
/// it, and this branch is how it is prevented rather than merely intended.
///
/// Deterministic by construction — every collection is a sorted `Vec`, the walk
/// is rank by rank, and `NodeId` is `(kind, ULID)`, which is a total order that
/// is a pure function of content.
///
/// # Why the bucket key is the DRAWN parent and not the graph parent
///
/// Siblings are *"same kind, same parent"* (`59` §3.1) — and once a parent has
/// collapsed, the parent its children are siblings under is the collapsed box,
/// not the forty graph nodes inside it. Keying on the graph parent instead
/// looks right and produces exactly `59` failure mode 16 one level down: forty
/// units collapse into one box and the forty addresses hanging off them are
/// still drawn forty times, each a bucket of one, because no two of them share
/// a graph parent. Measured in Chromium on a forty-tunnel paste before this was
/// fixed: **46 boxes, of which 40 were the addresses.**
///
/// Doing it this way is why the fold runs rank by rank: rank `r`'s buckets need
/// rank `r − 1`'s answer.
pub(crate) fn fold(g: &Graph, view: &View) -> (Vec<Cell>, Vec<(NodeId, usize)>) {
    let live = live_nodes(g);
    if live.is_empty() {
        return (Vec::new(), Vec::new());
    }

    if !view.aggregate {
        // `lay_out`'s original body, unchanged: rank, then `NodeId`. `sort` is
        // stable and the key is total, so this is a pure function of content.
        let mut ranked: Vec<(u32, NodeId)> =
            live.iter().map(|id| (crate::depth(g, *id), *id)).collect();
        ranked.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
        let mut cell_of: Vec<u32> = vec![0; live.len()];
        for (j, (_, id)) in ranked.iter().enumerate() {
            if let Ok(i) = live.binary_search(id) {
                if let Some(slot) = cell_of.get_mut(i) {
                    *slot = j as u32;
                }
            }
        }
        let cells: Vec<Cell> = ranked
            .iter()
            .map(|(r, id)| single(g, *id, *r, String::new()))
            .collect();
        return (cells, placed(&live, &cell_of));
    }

    let sig = signatures(g, &live);
    let rank: Vec<u32> = live.iter().map(|id| crate::depth(g, *id)).collect();
    let deepest = rank.iter().copied().max().unwrap_or(0);

    // Which box each node ended up in, parallel to `live`. `NO_PARENT` is both
    // "this is a root" and "this node's owner is not drawn", which are the same
    // thing to a picture.
    const NO_PARENT: u32 = u32::MAX;
    let mut cell_of: Vec<u32> = vec![NO_PARENT; live.len()];
    let mut cells: Vec<Cell> = Vec::new();

    for r in 0..=deepest {
        // `(drawn parent box, node, index into sig)`. A root's `NO_PARENT`
        // bucket is a real bucket and not a leftover: `59` §3.3's Peer level
        // collapses like-kind siblings that hang off nothing, which is what a
        // lateral column of forty spoke devices is.
        let mut bucket: Vec<(u32, NodeId, u32)> = Vec::new();
        for (i, id) in live.iter().enumerate() {
            if rank.get(i) != Some(&r) {
                continue;
            }
            let parent = g
                .owner(*id)
                .and_then(|o| live.binary_search(&o).ok())
                .and_then(|oi| cell_of.get(oi).copied())
                .unwrap_or(NO_PARENT);
            bucket.push((parent, *id, i as u32));
        }
        bucket.sort_unstable();

        let mut i = 0usize;
        while let Some(&(parent, first, si)) = bucket.get(i) {
            // A run is maximal in (same drawn parent, same kind, same
            // signature) AND contiguous in NodeId order. Contiguity is what
            // carries `59` §9's recommendation for a heterogeneous group: the
            // exception is drawn adjacent to the aggregate, in index order
            // relative to it, and the range splits around it — `SPOKE-01–16`,
            // `SPOKE-17`, `SPOKE-18–40` — rather than the aggregate keeping a
            // range string that covers a member it is not standing for.
            let mut j = i + 1;
            while let Some(&(p, n, sj)) = bucket.get(j) {
                if p != parent
                    || n.kind != first.kind
                    || sig.get(sj as usize) != sig.get(si as usize)
                {
                    break;
                }
                j += 1;
            }
            let run: Vec<NodeId> = bucket
                .get(i..j)
                .unwrap_or_default()
                .iter()
                .map(|(_, n, _)| *n)
                .collect();

            let from = cells.len();
            let uncapped = sig.get(si as usize).map(|s| !bounded(s)).unwrap_or(true);
            emit(g, view, r, &run, uncapped, &mut cells);
            for (ci, c) in cells.iter().enumerate().skip(from) {
                for m in &c.members {
                    if let Ok(mi) = live.binary_search(m) {
                        if let Some(slot) = cell_of.get_mut(mi) {
                            *slot = ci as u32;
                        }
                    }
                }
            }
            i = j;
        }
    }

    // Already in rank order, and within a rank in (drawn parent, anchor) order,
    // which puts a parent's children adjacent. No final sort: adding one would
    // be a second ordering rule that could disagree with this one, and it is a
    // `sort_unstable` instantiation over `Cell` that `order.rs` measured the
    // price of (one sort, 5,052 bytes) against a 900 000-byte ceiling.
    let at = placed(&live, &cell_of);
    (cells, at)
}

/// Every live node paired with the box it is drawn in, **in `NodeId` order**.
///
/// Built from `live` — which is sorted, because `lay_out` walks `NodeKind::ALL`
/// and `Graph::nodes_of_kind` is a range scan — rather than from the cells and
/// then sorted. The two produce the same slice; only one of them instantiates a
/// `sort_unstable` over `(NodeId, usize)`, and `order.rs` measured what a sort
/// costs in a module with 29,023 bytes of headroom.
fn placed(live: &[NodeId], cell_of: &[u32]) -> Vec<(NodeId, usize)> {
    live.iter()
        .zip(cell_of.iter())
        .map(|(id, c)| (*id, *c as usize))
        .collect()
}

/// One run, as the boxes that stand for it.
///
/// `uncapped` is `!`[`bounded`] — true for a fan that must be windowed, false
/// for a set with a natural cap, which expands all at once (`59` §3.7, §9).
fn emit(g: &Graph, view: &View, rank: u32, run: &[NodeId], uncapped: bool, out: &mut Vec<Cell>) {
    // Below the threshold aggregation is a no-op, byte for byte — `59` §2.5
    // measured the aggregated and un-aggregated canvases identical at four
    // spokes. That is the whole cost story: there is no regression to weigh
    // against the gain, and the reth pair, the chassis pair and the two trunk
    // ports are all left alone because they never reach six (`59` §3.4).
    if run.len() <= THRESHOLD {
        for id in run {
            out.push(single(g, *id, rank, String::new()));
        }
        return;
    }
    let Some(first) = run.first() else { return };
    let key = format!("agg:{first}");

    let Some(at) = view.opened(&key) else {
        residual(g, &key, rank, run, 0, out);
        return;
    };

    if !uncapped {
        // `59` §3.7's one principled exception. A bounded, unordered set has no
        // page worth walking, so it opens whole. There is then no residual and
        // therefore no drawn control: the group is collapsed again through
        // `53` §3.7's Escape ladder, and its state belongs in the Outline
        // (`55` §4.5, `56` §7), which this slice does not draw. **That is a
        // named limitation, not a claim that it is complete** — it is reachable
        // only for LAG and reth member sets, which junos-srx ingest does not
        // build today.
        for id in run {
            out.push(single(g, *id, rank, key.clone()));
        }
        return;
    }

    // Windowed. The picture never offers "expand all" on an unbounded group,
    // so the most it can ever draw for one run is a window plus two residuals
    // — WINDOW + 2 boxes, which at WINDOW = 6 is 8. Above six members that is
    // never more than the un-aggregated form (`59` X6, and A3's ladder is the
    // measured failure it was written against).
    let at = at.min(run.len().saturating_sub(1));
    if at > 0 {
        // **The leading residual steps the window BACK by one window**, which
        // is what makes `59` §3.7's *"a hundred and twenty spokes can be walked
        // six at a time"* true in both directions. Opening it at 0 instead —
        // the previous attempt's bug — makes backwards a single jump to the
        // start, so a reader at member 108 of 120 needs eighteen forward
        // activations to get back to 102.
        residual(
            g,
            &key,
            rank,
            run.get(..at).unwrap_or_default(),
            at.saturating_sub(WINDOW),
            out,
        );
    }
    let end = (at + WINDOW).min(run.len());
    for id in run.get(at..end).unwrap_or_default() {
        out.push(single(g, *id, rank, key.clone()));
    }
    if end < run.len() {
        residual(g, &key, rank, run.get(end..).unwrap_or_default(), end, out);
    }
}

fn single(g: &Graph, id: NodeId, rank: u32, group: String) -> Cell {
    Cell {
        key: id.to_string(),
        kind: id.kind.name(),
        label: crate::label_of(g, id),
        rank,
        anchor: id,
        members: vec![id],
        group,
        // The only place a role is read. `residual` builds the collapsed boxes
        // and leaves this empty by construction rather than by remembering to.
        role: fathom_inventory::role_word(g, id).unwrap_or_default(),
    }
}

/// A collapsed box standing for `members`, or — **when there is exactly one
/// member — that member, drawn as itself.**
///
/// `opens_at` is the window offset activating it asks for, which is what makes
/// the two residuals of an opened group into page controls.
///
/// # A group of one is not a group
///
/// `59` §3.14.2 states the rule in terms, for the edge level: *"A group of one
/// is drawn as itself. There is no `1 link`."* It holds one level down for the
/// same reason. A one-member residual has no cardinal worth printing, no range
/// (both ends of `st0.12–st0.12` are the same name), and nothing to hide — and
/// the box it would draw is a control that walks the window to a position
/// showing exactly the member already in front of the reader.
///
/// **This is the defect a reviewer drove in Chromium.** A run whose length is
/// `1 mod WINDOW` — 13, 19, 25, 31 — leaves a trailing residual of exactly one
/// member. The previous attempt minted it with a group key as its display id
/// and `count == 1`, so the page took its plain-box branch and posted
/// `agg:logical-unit:01M0…#12` to `OP_ELEMENT`, which refused with code 6;
/// keyboard activation did nothing at all. The fix is not in the page. **A cell
/// standing for one node must carry that node's own display id**, and this
/// function is the only place a cell standing for many is made.
///
/// The rejected alternative is to draw *every* residual of `THRESHOLD` or fewer
/// members as its members. It is tempting — nothing is hidden either way — and
/// it is wrong: at thirteen members, a window of six plus six plain leading
/// boxes plus one trailing box is thirteen boxes, which is the un-aggregated
/// picture exactly, and the collapse would have bought nothing.
fn residual(
    g: &Graph,
    key: &str,
    rank: u32,
    members: &[NodeId],
    opens_at: usize,
    out: &mut Vec<Cell>,
) {
    let (Some(first), Some(last)) = (members.first(), members.last()) else {
        // A group of nothing is not a box, and inventing an anchor for it would
        // need a `NodeId` no node has.
        return;
    };
    if first == last {
        out.push(single(g, *first, rank, key.to_owned()));
        return;
    }
    // U+2013 EN DASH. A range, not a hyphenated name.
    let label = format!(
        "{}–{}",
        crate::label_of(g, *first),
        crate::label_of(g, *last)
    );
    // One string, used as both the box's id and its activation target: a
    // collapsed box is never a selection, so there is nothing for a separate id
    // to say. `#<offset>` is unique per box because a group is either collapsed
    // (one box at offset 0) or opened (at most a leading residual and a
    // trailing one, which ask for different offsets).
    let id = format!("{key}#{opens_at}");
    out.push(Cell {
        key: id.clone(),
        kind: first.kind.name(),
        label,
        rank,
        anchor: *first,
        members: members.to_vec(),
        group: id,
        // See `Cell::role`: a box standing for many nodes has no one node's
        // role to print, and the aggregation signature does not include role.
        role: String::new(),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_of_nothing_is_the_folded_default() {
        assert_eq!(View::parse(""), View::folded());
        assert!(View::parse("").aggregate);
    }

    #[test]
    fn a_star_asks_for_every_one_drawn() {
        let v = View::parse("*");
        assert!(!v.aggregate, "`*` is 59 §3.7's un-aggregated control");
    }

    #[test]
    fn an_offset_travels_with_its_key() {
        let v = View::parse("agg:device:01AAA#12\nagg:logical-unit:01BBB");
        assert_eq!(v.opened("agg:device:01AAA"), Some(12));
        assert_eq!(v.opened("agg:logical-unit:01BBB"), Some(0));
        assert_eq!(v.opened("agg:device:01CCC"), None);
    }

    /// A malformed offset opens the group at its start rather than refusing to
    /// draw. A view preference must never be able to blank the picture.
    #[test]
    fn a_malformed_offset_reads_as_zero() {
        assert_eq!(
            View::parse("agg:device:01AAA#no").opened("agg:device:01AAA"),
            Some(0)
        );
    }

    /// The packing must round-trip the edge kind, or [`bounded`] silently
    /// answers `false` for every group and `59` §3.7's exemption is unbuilt
    /// again with nothing to say so.
    #[test]
    fn a_packed_term_gives_its_edge_kind_back() {
        for edge in [
            EdgeKind::MemberOfAggregate,
            EdgeKind::MemberOfReth,
            EdgeKind::HasUnit,
        ] {
            for far in [NodeKind::Device, NodeKind::LearnedRoute] {
                for out in [true, false] {
                    assert_eq!(
                        term_edge(term(edge, out, far)),
                        Some(edge as u32),
                        "{edge:?} {far:?} {out}"
                    );
                }
            }
        }
        assert_eq!(term_edge(0), None, "an origin word is not an edge word");
        assert_eq!(term_edge(2), None);
    }

    #[test]
    fn a_lag_member_set_is_bounded_and_a_tunnel_fan_is_not() {
        let fan = vec![1, term(EdgeKind::HasUnit, false, NodeKind::TunnelInterface)];
        assert!(!bounded(&fan), "a unit fan is unbounded and is windowed");
        let lag = vec![
            1,
            term(
                EdgeKind::MemberOfAggregate,
                true,
                NodeKind::AggregateInterface,
            ),
        ];
        assert!(bounded(&lag), "59 §3.7 exempts an aggregate's members");
        let reth = vec![
            1,
            term(EdgeKind::MemberOfReth, true, NodeKind::RethInterface),
        ];
        assert!(bounded(&reth));
    }
}
