//! The statement dictionary — corpus data, not code (`14` §2.2, §6).
//!
//! One table drives binding and redaction: *"the dictionary entry that teaches
//! the parser about `pre-shared-key ascii-text` is the same entry that teaches
//! the gate to redact it"* (`14` §9.1). That is why the redaction catalogue
//! cannot drift from the parser — there are not two lists.
//!
//! Entries are parsed with `fathom_schema::subset::parse_profile` under
//! `Profile::Corpus`, the one YAML parser in the workspace. If a construct
//! this module needs cannot be expressed in that subset, the answer is to
//! change the construct: *"This is not a general YAML implementation and must
//! never become one."*

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use fathom_ir::generated::ir_types::{EdgeKind, NodeKind};
use fathom_ir::scalar::SecretLabel;
use fathom_schema::subset::{parse_profile, Profile};
use fathom_schema::value::{Node, Value};

use crate::redact::{RedactLabel, SECRET_WORD_LIST};
use crate::shape::{Stmt, StmtTree};

/// The trie walker's hard budget (`14` §6.3): a pathological input costs 64
/// node visits, never `2^v`.
pub(crate) const VISIT_BUDGET: usize = 64;

/// `14` §6.3's CI constant, read as a per-entry backtracking allowance
/// (WO-03 §12 item 11).
pub(crate) const BACKTRACK_ALLOWANCE: usize = 8;

// ---------------------------------------------------------------------------
// Public surface (WO-03 §4.7)
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub struct Dictionary {
    platform: String,
    entries: Vec<Entry>,
    trie: Vec<DictNode>,
    token_maps: BTreeMap<String, BTreeMap<String, String>>,
    field_keys: BTreeMap<String, u32>,
    known_segments: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DictError {
    pub file: String,
    pub line: usize,
    pub gate: DictGate,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DictGate {
    Parse,
    Shadowing,
    CaptureArity,
    KindUnknown,
    FieldUnknown,
    TypeUnknown,
    EdgeUnknown,
    SecretCoupling,
    ReviewedByMissing,
    TokenMapUnknown,
}

/// The dictionary's source files, compiled in, in the order `load` reads them
/// off disk (`read_dir` then `sort`, so: alphabetical by file name).
///
/// This exists for one caller: the WebAssembly build, which has no filesystem
/// and cannot call `load`. It is deliberately a literal list rather than a
/// directory walk — a macro cannot walk a directory, and a list that silently
/// missed a file would produce a dictionary that parses less than the on-disk
/// one while claiming to be it. `tests/embedded.rs` closes that hole: it reads
/// the directory and fails if this list and the directory disagree by one file
/// or by one byte.
pub const EMBEDDED_DICT_SOURCES: &[(&str, &str)] = &[
    (
        "interfaces.yaml",
        include_str!("../../../corpus/dict/junos-srx/interfaces.yaml"),
    ),
    (
        "protocols-bgp.yaml",
        include_str!("../../../corpus/dict/junos-srx/protocols-bgp.yaml"),
    ),
    (
        "protocols-ospf.yaml",
        include_str!("../../../corpus/dict/junos-srx/protocols-ospf.yaml"),
    ),
    (
        "routing-options.yaml",
        include_str!("../../../corpus/dict/junos-srx/routing-options.yaml"),
    ),
    (
        "security-flow.yaml",
        include_str!("../../../corpus/dict/junos-srx/security-flow.yaml"),
    ),
    (
        "security-ike.yaml",
        include_str!("../../../corpus/dict/junos-srx/security-ike.yaml"),
    ),
    (
        "security-ipsec.yaml",
        include_str!("../../../corpus/dict/junos-srx/security-ipsec.yaml"),
    ),
    (
        "security-zones.yaml",
        include_str!("../../../corpus/dict/junos-srx/security-zones.yaml"),
    ),
    (
        "system.yaml",
        include_str!("../../../corpus/dict/junos-srx/system.yaml"),
    ),
    (
        "token-maps.yaml",
        include_str!("../../../corpus/dict/junos-srx/token-maps.yaml"),
    ),
    (
        "vlans.yaml",
        include_str!("../../../corpus/dict/junos-srx/vlans.yaml"),
    ),
];

/// `schema/field-keys.yaml`, compiled in for the same reason. The registry is
/// append-only (`62` §2.3), so embedding it is embedding an assignment that
/// never changes for an existing field.
pub const EMBEDDED_FIELD_KEYS: &str = include_str!("../../../schema/field-keys.yaml");

impl Dictionary {
    /// `load`, without a filesystem: the same eight files and the same
    /// field-key registry, compiled into the binary.
    ///
    /// Every gate `load` runs, this runs — it is the same `from_sources` call
    /// with the same inputs. The only thing it does not do is read the schema
    /// tree, because the one thing it needs from that tree is the field-key
    /// table and that file is embedded whole.
    pub fn embedded() -> Result<Dictionary, DictError> {
        let sources: Vec<(String, String)> = EMBEDDED_DICT_SOURCES
            .iter()
            .map(|(name, text)| ((*name).to_owned(), (*text).to_owned()))
            .collect();
        Dictionary::from_sources(&sources, embedded_field_keys()?)
    }

    /// Loads `corpus/dict/junos-srx/` and the schema tree beneath `root`, then
    /// runs every gate of WO-03 §4.7. A gate failure is a load failure: a
    /// dictionary that does not pass is never half-loaded.
    pub fn load(root: &Path) -> Result<Dictionary, DictError> {
        let dict_dir = root.join("corpus").join("dict").join("junos-srx");
        let schema_root = root.join("schema");
        let schema = fathom_schema::SchemaTree::load(&schema_root).map_err(|e| DictError {
            file: schema_root.display().to_string(),
            line: 0,
            gate: DictGate::Parse,
            message: format!("schema tree: {e:?}"),
        })?;
        let mut field_keys = BTreeMap::new();
        if let Some(keys) = &schema.field_keys {
            for (name, key, _) in &keys.entries {
                field_keys.insert(name.clone(), *key as u32);
            }
        }

        let mut files: Vec<std::path::PathBuf> = fs::read_dir(&dict_dir)
            .map_err(|e| DictError {
                file: dict_dir.display().to_string(),
                line: 0,
                gate: DictGate::Parse,
                message: format!("read_dir: {e}"),
            })?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().map(|x| x == "yaml").unwrap_or(false))
            .collect();
        files.sort();

        let mut sources: Vec<(String, String)> = Vec::new();
        for path in &files {
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let text = fs::read_to_string(path).map_err(|e| DictError {
                file: name.clone(),
                line: 0,
                gate: DictGate::Parse,
                message: format!("read: {e}"),
            })?;
            sources.push((name, text));
        }
        Dictionary::from_sources(&sources, field_keys)
    }

    pub fn entry_count(&self) -> usize {
        self.entries.len()
    }

    pub fn platform(&self) -> &str {
        &self.platform
    }

    /// The stable dictionary id of the entry a `BindProv.entry` index names —
    /// `<platform>/<dotted-path>` (conventions § *Identifiers*). `None` when
    /// the index is out of range.
    ///
    /// Added by WO-09 §4.2, by name and by nothing else: `BindProv.entry`'s
    /// doc comment already promised the id string was *"reachable through the
    /// Dictionary"* and it was not (WO-09 §12 item 1).
    pub fn entry_id(&self, index: u16) -> Option<&str> {
        self.entries.get(usize::from(index)).map(|e| e.id.as_str())
    }
}

// ---------------------------------------------------------------------------
// The compiled entry (crate-internal)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PathSeg {
    Literal(String),
    Capture(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum KindSpec {
    Fixed(NodeKind),
    /// Resolved from the captured interface name at bind time (§4.7).
    InterfaceLike,
}

/// Every value type a `scalar:` may name in this slice — closed, and welded to
/// `BoundValue` by `bind::value_of`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ValueTy {
    Identifier,
    InterfaceName,
    AuthMethod,
    DhGroup,
    IntegrityAlgorithm,
    EncryptionAlgorithm,
    Seconds,
    Kilobytes,
    IkeVersion,
    IpPrefix,
    InterfaceAddress,
    PeerAddress,
    U32,
    IkePolicyMode,
    IpsecProposalProtocol,
    EstablishTunnels,
    IpsecVpnDfBit,
    AddressFamily,
    /// `11` §4.3's one free-string scalar. Its `parse` cannot fail, which
    /// makes it the only value type here that never produces a
    /// `Diag::ValueUnparsed` — a description binds or the statement did not
    /// match at all.
    Text,
    Fqdn,
    // ---- added 2026-08-15 by the branch-coverage widening. Each one exists
    // ---- because a *measured* section of a documented SRX branch config
    // ---- needed it, not because the catalogue looked incomplete.
    /// `vlans <name> vlan-id N` and `interfaces … unit N vlan-id V`.
    VlanId,
    /// `system time-zone` — `SystemSettings.time_zone`.
    TzName,
    /// `security flow tcp-mss … mss N` — the four `SecurityFlowSettings`
    /// clamp fields are `u16` in the schema, and a value over 65535 is a
    /// typo to diagnose rather than a number to truncate.
    U16,
    // --- the routing slice (2026-08-15) --------------------------------------
    // `RoutingProtocol` and `ProtocolAdjacency` had inventory rows and a place
    // in the diagram's layer model with nothing behind them, because no
    // dictionary entry could name their field types. These are exactly the slot
    // types `schema/schema.yaml` declares on those two kinds plus the
    // `RoutingInstance.router_id` that carries a Junos `routing-options
    // router-id`; nothing here is speculative surface.
    Ip4Addr,
    /// Either family, because Junos accepts both. Serves `NtpServer.address`
    /// from the branch-coverage widening and the routing slice alike -- the two
    /// slices arrived at the same schema scalar independently, and on merge
    /// (2026-08-15) the duplicate variant was collapsed onto this one rather
    /// than kept as a synonym, because two `ValueTy`s spelling one scalar is a
    /// silent fork waiting for the next `from_name` arm to pick the wrong one.
    IpAddr,
    Asn,
    OspfAreaId,
    Bandwidth,
    RoutingProtocolProtocol,
    ProtocolAdjacencyNetworkType,
}

impl ValueTy {
    fn from_name(name: &str) -> Option<ValueTy> {
        Some(match name {
            "Identifier" => ValueTy::Identifier,
            "InterfaceName" => ValueTy::InterfaceName,
            "Text" => ValueTy::Text,
            "Fqdn" => ValueTy::Fqdn,
            "AuthMethod" => ValueTy::AuthMethod,
            "DhGroup" => ValueTy::DhGroup,
            "IntegrityAlgorithm" => ValueTy::IntegrityAlgorithm,
            "EncryptionAlgorithm" => ValueTy::EncryptionAlgorithm,
            "Seconds" => ValueTy::Seconds,
            "Kilobytes" => ValueTy::Kilobytes,
            "IkeVersion" => ValueTy::IkeVersion,
            "IpPrefix" => ValueTy::IpPrefix,
            "InterfaceAddress" => ValueTy::InterfaceAddress,
            "PeerAddress" => ValueTy::PeerAddress,
            "u32" => ValueTy::U32,
            "IkePolicyMode" => ValueTy::IkePolicyMode,
            "IpsecProposalProtocol" => ValueTy::IpsecProposalProtocol,
            "EstablishTunnels" => ValueTy::EstablishTunnels,
            "IpsecVpnDfBit" => ValueTy::IpsecVpnDfBit,
            "AddressFamily" => ValueTy::AddressFamily,
            "VlanId" => ValueTy::VlanId,
            "TzName" => ValueTy::TzName,
            "u16" => ValueTy::U16,
            "Ip4Addr" => ValueTy::Ip4Addr,
            "IpAddr" => ValueTy::IpAddr,
            "Asn" => ValueTy::Asn,
            "OspfAreaId" => ValueTy::OspfAreaId,
            "Bandwidth" => ValueTy::Bandwidth,
            "RoutingProtocolProtocol" => ValueTy::RoutingProtocolProtocol,
            "ProtocolAdjacencyNetworkType" => ValueTy::ProtocolAdjacencyNetworkType,
            _ => return None,
        })
    }

    /// The token-map name this type consults before parsing, if any.
    pub(crate) fn token_map(self) -> Option<&'static str> {
        match self {
            ValueTy::DhGroup => Some("DhGroup"),
            ValueTy::IntegrityAlgorithm => Some("IntegrityAlgorithm"),
            // Junos spells OSPFv3 `ospf3` and the schema spells it `ospf_v3`;
            // Junos spells the OSPF network type `p2p`/`nbma` and the schema
            // spells them `point_to_point`/`non_broadcast`. Both are vendor
            // spellings, which is what a token map is for — the alternative is
            // a second enum in the IR that means the same thing.
            ValueTy::RoutingProtocolProtocol => Some("RoutingProtocolProtocol"),
            ValueTy::ProtocolAdjacencyNetworkType => Some("ProtocolAdjacencyNetworkType"),
            _ => None,
        }
    }
}

/// The `set{…}` enum fields this slice appends into (§4.8).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SetEnumTy {
    Family,
    HostService,
    /// `host-inbound-traffic protocols ospf|bgp|bfd|all`. The twin of
    /// `HostService` on both `Zone` and the `ZoneMember` edge; its absence
    /// was why `set security zones security-zone trust host-inbound-traffic
    /// protocols all` was residue while the `system-services` line beside it
    /// bound (measured 2026-08-15).
    HostProtocol,
}

impl SetEnumTy {
    fn from_name(name: &str) -> Option<SetEnumTy> {
        match name {
            "Family" => Some(SetEnumTy::Family),
            "HostService" => Some(SetEnumTy::HostService),
            "HostProtocol" => Some(SetEnumTy::HostProtocol),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) enum ValueSpec {
    From {
        from: String,
        ty: ValueTy,
    },
    ConstEnum {
        ty: ValueTy,
        token: String,
    },
    AppendFrom {
        ty: SetEnumTy,
        from: String,
    },
    AppendConst {
        ty: SetEnumTy,
        token: String,
    },
    /// A Junos *flag* statement — `passive;`, `disable;` — whose whole content
    /// is its own presence. There is no argument to capture, so the value
    /// cannot come `from:` anywhere: the entry states it, and the entry's path
    /// is what makes the statement true. Written as a full `bool` rather than
    /// a presence marker because the schema slot is `bool` and a future
    /// `passive false` (Junos `delete`, or a vendor that spells the negative)
    /// has somewhere to land without a second construct.
    ///
    /// The polarity lives in the corpus because it is a vendor fact: Junos
    /// spells the negative (`set interfaces ge-0/0/4 disable`) and the IR
    /// stores the positive (`Interface.admin_up`), so a hard-coded `true` here
    /// would make `disable` unmodellable.
    ConstBool {
        value: bool,
    },
    /// `14` §9.1: the binder constructs the placeholder from the entry's
    /// label and never reads the redacted argument's text.
    Secret {
        label: SecretLabel,
    },
}

#[derive(Debug, Clone)]
pub(crate) struct FieldSpec {
    pub(crate) field: String,
    pub(crate) value: ValueSpec,
}

#[derive(Debug, Clone)]
pub(crate) struct NodeSpec {
    pub(crate) kind: KindSpec,
    pub(crate) owner: Option<usize>,
    pub(crate) key: Option<String>,
    pub(crate) fields: Vec<FieldSpec>,
}

#[derive(Debug, Clone)]
pub(crate) enum EdgeTarget {
    ByName { kind: NodeKind, from: String },
    InterfaceUnit { from: String },
}

#[derive(Debug, Clone)]
pub(crate) struct EdgeSpec {
    pub(crate) kind: EdgeKind,
    pub(crate) from: usize,
    pub(crate) to: EdgeTarget,
    pub(crate) ordinal_from_position: bool,
    pub(crate) fields: Vec<FieldSpec>,
}

#[derive(Debug, Clone)]
pub(crate) struct Entry {
    pub(crate) id: String,
    pub(crate) path: Vec<PathSeg>,
    pub(crate) partial: bool,
    pub(crate) secret: Option<RedactLabel>,
    pub(crate) secret_exempt: bool,
    /// `where:` — the tokens a named capture is allowed to take, as
    /// (path index, allowed tokens) with the tokens sorted. Empty on an
    /// unconstrained entry, which is nearly all of them.
    ///
    /// WHY THIS EXISTS. A free capture claims every token in its position, and
    /// Junos reuses statement SHAPES across protocols that share nothing else.
    /// `[protocols, $proto, group, $g, neighbor, $n]` was written for BGP and
    /// also claimed RIP's `neighbor neighbor-name` at
    /// `[edit protocols rip group group-name ]` -- documented, and its
    /// `neighbor-name` is an INTERFACE name, not a peer address
    /// (https://www.juniper.net/documentation/us/en/software/junos/cli-reference/topics/ref/statement/neighbor-edit-protocols-rip.html,
    /// read 2026-08-15). One legal RIP line therefore put a `rip`
    /// `RoutingProtocol` and a fieldless `ProtocolAdjacency` into the estate of
    /// record: a peer that does not exist, in the register the product asks to
    /// be trusted. Same mechanism, smaller blast radius: `set protocols ospf
    /// local-as 65001` and `set protocols bgp reference-bandwidth 100` are not
    /// legal Junos and both bound.
    ///
    /// REJECTED ALTERNATIVE: spell the protocol as a path LITERAL and drop the
    /// capture. It works, and it costs the two things the capture buys --
    /// `key: "$proto"`, which is what keeps `ospf` and `ospf3` from colliding
    /// onto one `RoutingProtocol` node, and `from: "$proto"`, which is what
    /// carries the protocol word through the `ospf3 -> ospf_v3` token map into
    /// the field. Recovering both means one entry per protocol word plus a
    /// `const_enum` per entry: ten OSPF entries where there are five, and a
    /// second place for the token map to be forgotten.
    pub(crate) constraints: Vec<(usize, Vec<String>)>,
    pub(crate) nodes: Vec<NodeSpec>,
    pub(crate) edges: Vec<EdgeSpec>,
}

impl Entry {
    /// The token index a capture name occupies in this entry's path.
    pub(crate) fn capture_pos(&self, name: &str) -> Option<usize> {
        self.path
            .iter()
            .position(|s| matches!(s, PathSeg::Capture(n) if n == name))
    }

    /// Does this entry's `where:` hold against a statement's segments?
    ///
    /// Unconstrained entries answer `true` without looking, which is every
    /// entry that does not spell a `where:`.
    ///
    /// A statement that FAILS this test matches no entry, so the ingest gate
    /// treats it as unknown: every token from the longest known prefix is an
    /// argument, the base64 detector is armed, and the raw secret-word walk
    /// runs over the physical line. That is strictly more destruction than a
    /// match, so narrowing a capture can never open a credential path.
    pub(crate) fn constraints_hold(&self, segs: &[&str]) -> bool {
        self.constraints.iter().all(|(at, allowed)| {
            segs.get(*at)
                .is_some_and(|t| allowed.iter().any(|a| a == t))
        })
    }

    /// The last capture position — the argument the path detector redacts on
    /// a `secret:` entry (§12 item 15).
    pub(crate) fn secret_pos(&self) -> Option<usize> {
        self.path
            .iter()
            .rposition(|s| matches!(s, PathSeg::Capture(_)))
    }
}

#[derive(Debug, Clone, Default)]
struct DictNode {
    /// Literal children, sorted by segment text for deterministic iteration.
    literal: Vec<(String, usize)>,
    /// At most one capture child. Literal always wins (`14` §6.3).
    capture: Option<usize>,
    entry: Option<usize>,
}

/// One statement's dictionary lookup, computed once and read by both the gate
/// and the binder so the two can never disagree about what a path means.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Match {
    pub(crate) entry: Option<usize>,
    /// Segments the matched entry consumed; 0 when nothing matched.
    pub(crate) consumed: usize,
    /// Leading path segments the trie recognised (`14` §8.3's `Unmapped`).
    pub(crate) known_prefix: usize,
}

impl Dictionary {
    pub(crate) fn entry(&self, idx: usize) -> Option<&Entry> {
        self.entries.get(idx)
    }

    pub(crate) fn token_map(&self, map: &str, token: &str) -> Option<&str> {
        self.token_maps.get(map)?.get(token).map(|s| s.as_str())
    }

    pub(crate) fn field_key(&self, owner: &str, field: &str) -> Option<u32> {
        self.field_keys.get(&format!("{owner}.{field}")).copied()
    }

    pub(crate) fn is_known_segment(&self, seg: &str) -> bool {
        self.known_segments.contains(seg)
    }

    pub(crate) fn match_statements(&self, tree: &StmtTree, stmts: &[Stmt]) -> Vec<Match> {
        stmts
            .iter()
            .map(|stmt| {
                let segs: Vec<&str> = stmt
                    .path
                    .iter()
                    .map(|idx| crate::shape::seg_text(tree, *idx))
                    .collect();
                self.lookup(&segs).0
            })
            .collect()
    }

    /// The trie walk (`14` §6.3): literal first, capture as fallback,
    /// backtracking when a branch dead-ends, deepest terminal wins, hard
    /// budget of [`VISIT_BUDGET`] node visits. Iterative with an explicit
    /// stack — never recursive on user-controlled depth (`14` §11.6).
    ///
    /// Returns the match and the visit count, which is what the load-time
    /// budget gate measures.
    pub(crate) fn lookup(&self, segs: &[&str]) -> (Match, usize) {
        struct Frame {
            node: usize,
            depth: usize,
            stage: u8,
            /// Edges already followed from this node. The second and later
            /// ones cost an extra visit: the node is re-inspected on
            /// backtrack (§4.7's visit definition).
            taken: u8,
        }
        let mut visits = 1usize; // the root counts one
        let mut best: Option<(usize, usize)> = None; // (entry, depth)
        let mut known_prefix = 0usize;
        // The shallowest position at which a `where:` turned this statement
        // away. See the clamp below `known_prefix`'s final value for what it
        // is for; `usize::MAX` means "no entry was rejected".
        let mut rejected_at = usize::MAX;
        let mut stack = vec![Frame {
            node: 0,
            depth: 0,
            stage: 0,
            taken: 0,
        }];
        while let Some(frame) = stack.last_mut() {
            let node = match self.trie.get(frame.node) {
                Some(n) => n,
                None => break,
            };
            if frame.stage == 0 {
                if frame.depth > known_prefix {
                    known_prefix = frame.depth;
                }
                // The `where:` test runs HERE, at the terminal, and not in the
                // trie walk: the trie folds every capture at a node onto one
                // child, so `protocols $proto` is a single edge shared by the
                // OSPF and BGP entries and there is nothing per-entry to gate
                // on until an entry is in hand. Rejecting at the terminal
                // leaves the walk itself untouched -- `known_prefix` and the
                // visit budget are unchanged -- and lets a shorter `partial`
                // entry still win, which is what should happen.
                if let Some(e) = node.entry {
                    let entry = self.entries.get(e);
                    let holds = entry.is_some_and(|entry| entry.constraints_hold(segs));
                    if holds {
                        if best.map(|(_, d)| frame.depth > d).unwrap_or(true) {
                            best = Some((e, frame.depth));
                        }
                    } else if let Some(entry) = entry {
                        // Where the statement stopped being the entry the trie
                        // walked to. The first constrained position is the
                        // divergence point by definition: everything before it
                        // agreed, everything from it on is a statement this
                        // dictionary has never described.
                        if let Some(at) = entry.constraints.iter().map(|(at, _)| *at).min() {
                            rejected_at = rejected_at.min(at);
                        }
                    }
                }
            }
            if visits >= VISIT_BUDGET {
                break;
            }
            let token = segs.get(frame.depth).copied();
            let next = match (frame.stage, token) {
                (0, Some(t)) => {
                    frame.stage = 1;
                    node.literal
                        .binary_search_by(|(seg, _)| seg.as_str().cmp(t))
                        .ok()
                        .and_then(|i| node.literal.get(i))
                        .map(|(_, child)| *child)
                }
                (1, Some(_)) => {
                    frame.stage = 2;
                    node.capture
                }
                _ => {
                    frame.stage = 3;
                    None
                }
            };
            match next {
                Some(child) => {
                    let depth = frame.depth + 1;
                    visits += if frame.taken == 0 { 1 } else { 2 };
                    frame.taken = frame.taken.saturating_add(1);
                    stack.push(Frame {
                        node: child,
                        depth,
                        stage: 0,
                        taken: 0,
                    });
                }
                None => {
                    if frame.stage >= 3 {
                        stack.pop();
                    }
                }
            }
        }
        let (entry, consumed) = match best {
            Some((e, d)) => (Some(e), d),
            None => (None, 0),
        };

        // TWO CLAMPS ON `known_prefix`, BOTH SECURITY GUARDS. The gate turns
        // `known_prefix` into the argument list for an unmatched statement
        // (`redact::gate_statement`: `args.extend(known_prefix..segs.len())`),
        // so a `known_prefix` that is too LARGE means tokens nobody looks at.
        //
        // (a) A statement rejected by a `where:` still walked the trie to full
        //     depth, because the trie is shared and knows nothing about
        //     constraints. Found by its own regression test, not by review:
        //     `set protocols rip group G neighbor ge-0/0/9.0
        //     authentication-key <key>` reached depth 8 of 8, `args` came out
        //     EMPTY, and the key was stored verbatim. Narrowing a capture had
        //     silently disarmed the gate on the statements it narrowed away —
        //     the precise mistake this whole reconciliation exists to fix,
        //     reintroduced one layer down. Clamping to the divergence point
        //     puts every token from the rejected capture onward back in front
        //     of the detectors.
        //
        // (b) The general case, which predates `where:`: if the trie happens
        //     to spell a statement's whole path without terminating on an
        //     entry, `known_prefix == segs.len()` and `args` is empty for that
        //     reason alone. A set-form statement's last token is its argument
        //     by construction, so when NOTHING matched it is always examined.
        //     This can only add detector work; a token still has to trip a
        //     detector to be destroyed, and a bare keyword trips none.
        if entry.is_none() {
            known_prefix = known_prefix.min(rejected_at);
            known_prefix = known_prefix.min(segs.len().saturating_sub(1));
        }

        (
            Match {
                entry,
                consumed,
                known_prefix,
            },
            visits,
        )
    }
}

// ---------------------------------------------------------------------------
// Loading and the gates
// ---------------------------------------------------------------------------

fn err(file: &str, line: usize, gate: DictGate, message: impl Into<String>) -> DictError {
    DictError {
        file: file.to_owned(),
        line,
        gate,
        message: message.into(),
    }
}

fn label_from_token(token: &str) -> Option<RedactLabel> {
    [
        RedactLabel::Psk,
        RedactLabel::CertKey,
        RedactLabel::SnmpCommunity,
        RedactLabel::TacacsKey,
        RedactLabel::Password,
        RedactLabel::Unknown,
    ]
    .into_iter()
    .find(|l| l.token() == token)
}

/// `EMBEDDED_FIELD_KEYS`, parsed into the map `from_sources` wants.
///
/// The same reading `SchemaTree::load` performs — literally the same function,
/// `fathom_schema::model::field_key_entries`, so the two paths cannot drift.
/// A negative or over-wide key is refused rather than wrapped: the registry is
/// a `u32` on the wire (`11` §14.1) and a value that does not fit it is a
/// defect in the file, not something to round.
fn embedded_field_keys() -> Result<BTreeMap<String, u32>, DictError> {
    let node = fathom_schema::subset::parse(EMBEDDED_FIELD_KEYS).map_err(|e| DictError {
        file: "schema/field-keys.yaml".to_owned(),
        line: e.line,
        gate: DictGate::Parse,
        message: e.message,
    })?;
    let mut keys = BTreeMap::new();
    for (name, key, line) in fathom_schema::model::field_key_entries(&node) {
        let key = u32::try_from(key).map_err(|_| DictError {
            file: "schema/field-keys.yaml".to_owned(),
            line,
            gate: DictGate::Parse,
            message: format!("field key `{name}` is {key}, which is not a u32"),
        })?;
        keys.insert(name, key);
    }
    Ok(keys)
}

impl Dictionary {
    /// The filesystem-free load path, so the gates can be exercised against
    /// synthetic sources in unit tests.
    pub(crate) fn from_sources(
        sources: &[(String, String)],
        field_keys: BTreeMap<String, u32>,
    ) -> Result<Dictionary, DictError> {
        let mut platform: Option<String> = None;
        let mut entries: Vec<Entry> = Vec::new();
        let mut token_maps: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();

        for (name, text) in sources {
            let root = parse_profile(text, Profile::Corpus)
                .map_err(|e| err(name, e.line, DictGate::Parse, e.message))?;
            let plat = root
                .get("platform")
                .and_then(|n| n.as_str())
                .ok_or_else(|| err(name, root.line, DictGate::Parse, "missing `platform`"))?;
            match &platform {
                None => platform = Some(plat.to_owned()),
                Some(p) if p == plat => {}
                Some(p) => {
                    return Err(err(
                        name,
                        root.line,
                        DictGate::Parse,
                        format!("platform `{plat}` disagrees with `{p}`"),
                    ))
                }
            }
            if let Some(maps) = root.get("token_maps") {
                if root.get("reviewed_by").and_then(|n| n.as_str()).is_none() {
                    return Err(err(
                        name,
                        root.line,
                        DictGate::ReviewedByMissing,
                        "token maps are corpus content: the file needs `reviewed_by`",
                    ));
                }
                load_token_maps(name, maps, &mut token_maps)?;
            }
            if let Some(list) = root.get("entries") {
                let items = list.as_seq().ok_or_else(|| {
                    err(name, list.line, DictGate::Parse, "`entries` is not a list")
                })?;
                for item in items {
                    entries.push(load_entry(name, item, &field_keys)?);
                }
            }
        }

        let platform = platform.unwrap_or_default();
        gate_shadowing(&entries)?;
        gate_secret_coupling(&entries)?;

        let mut known_segments = BTreeSet::new();
        for entry in &entries {
            for seg in &entry.path {
                if let PathSeg::Literal(text) = seg {
                    known_segments.insert(text.clone());
                }
            }
        }

        let trie = build_trie(&entries)?;
        let dict = Dictionary {
            platform,
            entries,
            trie,
            token_maps,
            field_keys,
            known_segments,
        };
        gate_lookup_budget(&dict)?;
        Ok(dict)
    }
}

fn load_token_maps(
    file: &str,
    maps: &Node,
    out: &mut BTreeMap<String, BTreeMap<String, String>>,
) -> Result<(), DictError> {
    let entries = maps.as_map().ok_or_else(|| {
        err(
            file,
            maps.line,
            DictGate::Parse,
            "`token_maps` is not a map",
        )
    })?;
    for (name, node) in entries {
        if ValueTy::from_name(name)
            .and_then(|t| t.token_map())
            .is_none()
        {
            return Err(err(
                file,
                node.line,
                DictGate::TokenMapUnknown,
                format!("`{name}` is not a type this slice token-maps"),
            ));
        }
        let rows = node.as_map().ok_or_else(|| {
            err(
                file,
                node.line,
                DictGate::Parse,
                format!("token map `{name}` is not a map"),
            )
        })?;
        let mut table = BTreeMap::new();
        for (token, value) in rows {
            let text = match &value.value {
                Value::Str(s) => s.clone(),
                Value::Int(i) => i.to_string(),
                _ => {
                    return Err(err(
                        file,
                        value.line,
                        DictGate::Parse,
                        format!("token map `{name}` value for `{token}` is not text"),
                    ))
                }
            };
            table.insert(token.clone(), text);
        }
        out.insert(name.clone(), table);
    }
    Ok(())
}

fn load_entry(
    file: &str,
    node: &Node,
    field_keys: &BTreeMap<String, u32>,
) -> Result<Entry, DictError> {
    let line = node.line;
    let id = node
        .get("id")
        .and_then(|n| n.as_str())
        .ok_or_else(|| err(file, line, DictGate::Parse, "entry has no `id`"))?
        .to_owned();
    if node.get("versions").and_then(|n| n.as_str()).is_none() {
        return Err(err(
            file,
            line,
            DictGate::Parse,
            format!("`{id}` has no `versions`"),
        ));
    }
    if node.get("reviewed_by").and_then(|n| n.as_str()).is_none() {
        return Err(err(
            file,
            line,
            DictGate::ReviewedByMissing,
            format!("`{id}` has no `reviewed_by` (invariant 10)"),
        ));
    }
    let path_node = node
        .get("path")
        .ok_or_else(|| err(file, line, DictGate::Parse, format!("`{id}` has no `path`")))?;
    let mut path = Vec::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for seg in path_node.as_seq().ok_or_else(|| {
        err(
            file,
            path_node.line,
            DictGate::Parse,
            "`path` is not a list",
        )
    })? {
        let text = seg
            .as_str()
            .map(|s| s.to_owned())
            .unwrap_or_else(|| seg.scalar_display());
        if let Some(name) = text.strip_prefix('$') {
            if !seen.insert(name.to_owned()) {
                return Err(err(
                    file,
                    seg.line,
                    DictGate::CaptureArity,
                    format!("`{id}` repeats capture `${name}`"),
                ));
            }
            path.push(PathSeg::Capture(name.to_owned()));
        } else {
            path.push(PathSeg::Literal(text));
        }
    }
    if path.is_empty() {
        return Err(err(
            file,
            line,
            DictGate::Parse,
            format!("`{id}` has an empty path"),
        ));
    }

    let partial = node
        .get("partial")
        .and_then(|n| n.as_bool())
        .unwrap_or(false);
    let secret = match node.get("secret") {
        None => None,
        Some(s) => {
            let token = s.get("label").and_then(|n| n.as_str()).ok_or_else(|| {
                err(
                    file,
                    s.line,
                    DictGate::SecretCoupling,
                    format!("`{id}` has `secret` without a `label`"),
                )
            })?;
            Some(label_from_token(token).ok_or_else(|| {
                err(
                    file,
                    s.line,
                    DictGate::SecretCoupling,
                    format!("`{id}`: `{token}` is not a RedactLabel token"),
                )
            })?)
        }
    };
    let secret_exempt = match node.get("secret_exempt") {
        None => false,
        Some(s) => {
            if s.get("reason").and_then(|n| n.as_str()).is_none() {
                return Err(err(
                    file,
                    s.line,
                    DictGate::SecretCoupling,
                    format!("`{id}`: `secret_exempt` needs a written `reason`"),
                ));
            }
            true
        }
    };

    // `where: { <capture>: [<token>, …] }`. Gated hard on both halves: a
    // constraint naming a capture the path does not hold is a typo that would
    // silently constrain nothing, and an empty token list is an entry that can
    // never match, which is a mistake rather than an intention.
    let mut constraints: Vec<(usize, Vec<String>)> = Vec::new();
    if let Some(w) = node.get("where") {
        let map = w.as_map().ok_or_else(|| {
            err(
                file,
                w.line,
                DictGate::Parse,
                format!("`{id}`: `where` is not a map of capture to token list"),
            )
        })?;
        for (name, list) in map {
            let at = path
                .iter()
                .position(|s| matches!(s, PathSeg::Capture(n) if n == name))
                .ok_or_else(|| {
                    err(
                        file,
                        list.line,
                        DictGate::CaptureArity,
                        format!("`{id}`: `where` names `${name}`, which is not in path"),
                    )
                })?;
            let seq = list.as_seq().ok_or_else(|| {
                err(
                    file,
                    list.line,
                    DictGate::Parse,
                    format!("`{id}`: `where.{name}` is not a list of tokens"),
                )
            })?;
            let mut allowed: Vec<String> = seq
                .iter()
                .map(|n| {
                    n.as_str()
                        .map(|t| t.to_owned())
                        .unwrap_or_else(|| n.scalar_display())
                })
                .collect();
            if allowed.is_empty() {
                return Err(err(
                    file,
                    list.line,
                    DictGate::Parse,
                    format!("`{id}`: `where.{name}` is empty, so the entry can never match"),
                ));
            }
            allowed.sort();
            allowed.dedup();
            constraints.push((at, allowed));
        }
        constraints.sort_by_key(|(at, _)| *at);
    }

    let mut nodes: Vec<NodeSpec> = Vec::new();
    let mut edges: Vec<EdgeSpec> = Vec::new();
    if let Some(binds) = node.get("binds") {
        let mut names: Vec<String> = Vec::new();
        if let Some(list) = binds.get("nodes") {
            for spec in list
                .as_seq()
                .ok_or_else(|| err(file, list.line, DictGate::Parse, "`nodes` is not a list"))?
            {
                let (name, node_spec) = load_node(file, &id, spec, &names, &path, field_keys)?;
                names.push(name);
                nodes.push(node_spec);
            }
        }
        if let Some(list) = binds.get("edges") {
            for spec in list
                .as_seq()
                .ok_or_else(|| err(file, list.line, DictGate::Parse, "`edges` is not a list"))?
            {
                edges.push(load_edge(file, &id, spec, &names, &path, field_keys)?);
            }
        }
    }

    Ok(Entry {
        id,
        path,
        partial,
        secret,
        secret_exempt,
        constraints,
        nodes,
        edges,
    })
}

fn capture_exists(path: &[PathSeg], name: &str) -> bool {
    path.iter()
        .any(|s| matches!(s, PathSeg::Capture(n) if n == name))
}

fn capture_ref(
    file: &str,
    id: &str,
    line: usize,
    node: &Node,
    key: &str,
    path: &[PathSeg],
) -> Result<Option<String>, DictError> {
    let text = match node.get(key).and_then(|n| n.as_str()) {
        None => return Ok(None),
        Some(t) => t,
    };
    let name = text.strip_prefix('$').ok_or_else(|| {
        err(
            file,
            line,
            DictGate::CaptureArity,
            format!("`{id}`: `{key}: {text}` is not a capture reference"),
        )
    })?;
    if !capture_exists(path, name) {
        return Err(err(
            file,
            line,
            DictGate::CaptureArity,
            format!("`{id}`: `${name}` is used in binds but is not in path"),
        ));
    }
    Ok(Some(name.to_owned()))
}

/// The four kinds `@interface_like` can resolve to, so the loader can prove a
/// field name has a wire key for every one of them.
pub(crate) const INTERFACE_LIKE: [NodeKind; 4] = [
    NodeKind::Interface,
    NodeKind::AggregateInterface,
    NodeKind::RethInterface,
    NodeKind::TunnelInterface,
];

fn load_node(
    file: &str,
    id: &str,
    spec: &Node,
    names: &[String],
    path: &[PathSeg],
    field_keys: &BTreeMap<String, u32>,
) -> Result<(String, NodeSpec), DictError> {
    let line = spec.line;
    let as_name = spec
        .get("as")
        .and_then(|n| n.as_str())
        .ok_or_else(|| {
            err(
                file,
                line,
                DictGate::Parse,
                format!("`{id}`: node has no `as`"),
            )
        })?
        .to_owned();
    let kind_name = spec.get("kind").and_then(|n| n.as_str()).ok_or_else(|| {
        err(
            file,
            line,
            DictGate::KindUnknown,
            format!("`{id}`: node has no `kind`"),
        )
    })?;
    let kind = if kind_name == "@interface_like" {
        KindSpec::InterfaceLike
    } else {
        KindSpec::Fixed(NodeKind::from_name(kind_name).ok_or_else(|| {
            err(
                file,
                line,
                DictGate::KindUnknown,
                format!("`{id}`: `{kind_name}` is not a NodeKind"),
            )
        })?)
    };
    let owner = match spec.get("owner").and_then(|n| n.as_str()) {
        None => None,
        Some(owner) => Some(names.iter().position(|n| n == owner).ok_or_else(|| {
            err(
                file,
                line,
                DictGate::Parse,
                format!("`{id}`: owner `{owner}` is not an earlier node"),
            )
        })?),
    };
    let key = capture_ref(file, id, line, spec, "key", path)?;

    let owners: Vec<String> = match kind {
        KindSpec::Fixed(k) => vec![k.name().to_owned()],
        KindSpec::InterfaceLike => INTERFACE_LIKE.iter().map(|k| k.name().to_owned()).collect(),
    };
    let mut fields = Vec::new();
    if let Some(list) = spec.get("fields") {
        for f in list
            .as_seq()
            .ok_or_else(|| err(file, list.line, DictGate::Parse, "`fields` is not a list"))?
        {
            fields.push(load_field(file, id, f, path, &owners, field_keys)?);
        }
    }
    Ok((
        as_name,
        NodeSpec {
            kind,
            owner,
            key,
            fields,
        },
    ))
}

fn load_edge(
    file: &str,
    id: &str,
    spec: &Node,
    names: &[String],
    path: &[PathSeg],
    field_keys: &BTreeMap<String, u32>,
) -> Result<EdgeSpec, DictError> {
    let line = spec.line;
    let kind_name = spec.get("kind").and_then(|n| n.as_str()).ok_or_else(|| {
        err(
            file,
            line,
            DictGate::EdgeUnknown,
            format!("`{id}`: edge has no `kind`"),
        )
    })?;
    let kind = EdgeKind::from_name(kind_name).ok_or_else(|| {
        err(
            file,
            line,
            DictGate::EdgeUnknown,
            format!("`{id}`: `{kind_name}` is not an EdgeKind"),
        )
    })?;
    let from_name = spec.get("from").and_then(|n| n.as_str()).ok_or_else(|| {
        err(
            file,
            line,
            DictGate::Parse,
            format!("`{id}`: edge has no `from`"),
        )
    })?;
    let from = names.iter().position(|n| n == from_name).ok_or_else(|| {
        err(
            file,
            line,
            DictGate::Parse,
            format!("`{id}`: edge `from: {from_name}` names no bound node"),
        )
    })?;
    let to_node = spec.get("to").ok_or_else(|| {
        err(
            file,
            line,
            DictGate::Parse,
            format!("`{id}`: edge has no `to`"),
        )
    })?;
    let to = if let Some(by_name) = to_node.get("by_name") {
        let kind_name = by_name
            .get("kind")
            .and_then(|n| n.as_str())
            .ok_or_else(|| {
                err(
                    file,
                    by_name.line,
                    DictGate::KindUnknown,
                    format!("`{id}`: `by_name` has no `kind`"),
                )
            })?;
        let kind = NodeKind::from_name(kind_name).ok_or_else(|| {
            err(
                file,
                by_name.line,
                DictGate::KindUnknown,
                format!("`{id}`: `{kind_name}` is not a NodeKind"),
            )
        })?;
        let from =
            capture_ref(file, id, by_name.line, by_name, "from", path)?.ok_or_else(|| {
                err(
                    file,
                    by_name.line,
                    DictGate::CaptureArity,
                    format!("`{id}`: `by_name` has no `from`"),
                )
            })?;
        EdgeTarget::ByName { kind, from }
    } else if let Some(unit) = to_node.get("interface_unit") {
        let text = unit.as_str().unwrap_or("");
        let name = text.strip_prefix('$').ok_or_else(|| {
            err(
                file,
                unit.line,
                DictGate::CaptureArity,
                format!("`{id}`: `interface_unit: {text}` is not a capture reference"),
            )
        })?;
        if !capture_exists(path, name) {
            return Err(err(
                file,
                unit.line,
                DictGate::CaptureArity,
                format!("`{id}`: `${name}` is used in binds but is not in path"),
            ));
        }
        EdgeTarget::InterfaceUnit {
            from: name.to_owned(),
        }
    } else {
        return Err(err(
            file,
            to_node.line,
            DictGate::Parse,
            format!("`{id}`: edge `to` is neither `by_name` nor `interface_unit`"),
        ));
    };
    let ordinal_from_position = spec
        .get("ordinal_from_position")
        .and_then(|n| n.as_bool())
        .unwrap_or(false);
    if ordinal_from_position && field_keys.get(&format!("{kind_name}.ordinal")).is_none() {
        return Err(err(
            file,
            line,
            DictGate::FieldUnknown,
            format!("`{id}`: `{kind_name}.ordinal` has no wire key"),
        ));
    }
    let owners = vec![kind_name.to_owned()];
    let mut fields = Vec::new();
    if let Some(list) = spec.get("fields") {
        for f in list
            .as_seq()
            .ok_or_else(|| err(file, list.line, DictGate::Parse, "`fields` is not a list"))?
        {
            fields.push(load_field(file, id, f, path, &owners, field_keys)?);
        }
    }
    Ok(EdgeSpec {
        kind,
        from,
        to,
        ordinal_from_position,
        fields,
    })
}

fn load_field(
    file: &str,
    id: &str,
    spec: &Node,
    path: &[PathSeg],
    owners: &[String],
    field_keys: &BTreeMap<String, u32>,
) -> Result<FieldSpec, DictError> {
    let line = spec.line;
    let field = spec
        .get("field")
        .and_then(|n| n.as_str())
        .ok_or_else(|| {
            err(
                file,
                line,
                DictGate::Parse,
                format!("`{id}`: field has no name"),
            )
        })?
        .to_owned();
    for owner in owners {
        if field_keys.get(&format!("{owner}.{field}")).is_none() {
            return Err(err(
                file,
                line,
                DictGate::FieldUnknown,
                format!("`{id}`: `{owner}.{field}` has no wire key"),
            ));
        }
    }

    if let Some(label) = spec.get("secret_placeholder").and_then(|n| n.as_str()) {
        let label = label_from_token(label)
            .and_then(|l| l.to_secret_label())
            .ok_or_else(|| {
                err(
                    file,
                    line,
                    DictGate::TypeUnknown,
                    format!("`{id}`: `{label}` is not a graph-side SecretLabel"),
                )
            })?;
        return Ok(FieldSpec {
            field,
            value: ValueSpec::Secret { label },
        });
    }
    // `const_bool` is read with `as_bool`, never with a string compare: a
    // `const_bool: "false"` typo must fail the load rather than bind `true`
    // because a non-empty string looked truthy.
    if let Some(node) = spec.get("const_bool") {
        let value = node.as_bool().ok_or_else(|| {
            err(
                file,
                line,
                DictGate::TypeUnknown,
                format!("`{id}`: `const_bool` is not `true` or `false`"),
            )
        })?;
        return Ok(FieldSpec {
            field,
            value: ValueSpec::ConstBool { value },
        });
    }
    if let Some(text) = spec.get("const_enum").and_then(|n| n.as_str()) {
        let (ty, token) = split_enum_token(file, id, line, text)?;
        let ty = ValueTy::from_name(&ty).ok_or_else(|| {
            err(
                file,
                line,
                DictGate::TypeUnknown,
                format!("`{id}`: `{ty}` is not a value type"),
            )
        })?;
        return Ok(FieldSpec {
            field,
            value: ValueSpec::ConstEnum { ty, token },
        });
    }
    if let Some(text) = spec.get("append_enum").and_then(|n| n.as_str()) {
        return match capture_ref(file, id, line, spec, "from", path)? {
            Some(from) => {
                let ty = SetEnumTy::from_name(text).ok_or_else(|| {
                    err(
                        file,
                        line,
                        DictGate::TypeUnknown,
                        format!("`{id}`: `{text}` is not a set-valued enum"),
                    )
                })?;
                Ok(FieldSpec {
                    field,
                    value: ValueSpec::AppendFrom { ty, from },
                })
            }
            None => {
                let (name, token) = split_enum_token(file, id, line, text)?;
                let ty = SetEnumTy::from_name(&name).ok_or_else(|| {
                    err(
                        file,
                        line,
                        DictGate::TypeUnknown,
                        format!("`{id}`: `{name}` is not a set-valued enum"),
                    )
                })?;
                Ok(FieldSpec {
                    field,
                    value: ValueSpec::AppendConst { ty, token },
                })
            }
        };
    }
    let ty_name = spec.get("scalar").and_then(|n| n.as_str()).ok_or_else(|| {
        err(
            file,
            line,
            DictGate::TypeUnknown,
            format!("`{id}`: field `{field}` names no value source"),
        )
    })?;
    let ty = ValueTy::from_name(ty_name).ok_or_else(|| {
        err(
            file,
            line,
            DictGate::TypeUnknown,
            format!("`{id}`: `{ty_name}` is not a value type this slice binds"),
        )
    })?;
    let from = capture_ref(file, id, line, spec, "from", path)?.ok_or_else(|| {
        err(
            file,
            line,
            DictGate::CaptureArity,
            format!("`{id}`: field `{field}` has no `from`"),
        )
    })?;
    Ok(FieldSpec {
        field,
        value: ValueSpec::From { from, ty },
    })
}

fn split_enum_token(
    file: &str,
    id: &str,
    line: usize,
    text: &str,
) -> Result<(String, String), DictError> {
    match text.split_once('.') {
        Some((ty, token)) => Ok((ty.to_owned(), token.to_owned())),
        None => Err(err(
            file,
            line,
            DictGate::TypeUnknown,
            format!("`{id}`: `{text}` is not spelled `Enum.token`"),
        )),
    }
}

/// `14` §6.5's shadowing gate: no entry's path is a strict prefix of another's
/// unless the shorter one declares `partial: true`. Two entries with the same
/// path are a duplicate, which the same gate refuses.
fn gate_shadowing(entries: &[Entry]) -> Result<(), DictError> {
    for (i, a) in entries.iter().enumerate() {
        for b in entries.iter().skip(i + 1) {
            let shorter = if a.path.len() <= b.path.len() { a } else { b };
            let longer = if a.path.len() <= b.path.len() { b } else { a };
            let prefix = longer.path.iter().take(shorter.path.len());
            if !shorter.path.iter().eq(prefix) {
                continue;
            }
            if shorter.path.len() == longer.path.len() {
                return Err(err(
                    "corpus/dict/junos-srx",
                    0,
                    DictGate::Shadowing,
                    format!("`{}` and `{}` have the same path", a.id, b.id),
                ));
            }
            if !shorter.partial {
                return Err(err(
                    "corpus/dict/junos-srx",
                    0,
                    DictGate::Shadowing,
                    format!(
                        "`{}` is a strict prefix of `{}` without `partial: true`",
                        shorter.id, longer.id
                    ),
                ));
            }
        }
    }
    Ok(())
}

/// `14` §9.11 gate 2, widened to the detector's own rule (§12 item 9): for
/// every capture position, walk back over the two nearest preceding literal
/// segments; a hit in [`SECRET_WORD_LIST`] requires the entry to declare
/// itself one way or the other. One rule for gate and detector, so they
/// cannot drift.
fn gate_secret_coupling(entries: &[Entry]) -> Result<(), DictError> {
    for entry in entries {
        for (idx, seg) in entry.path.iter().enumerate() {
            if !matches!(seg, PathSeg::Capture(_)) {
                continue;
            }
            let hit = leaf_name_walk(&entry.path, idx);
            if hit && entry.secret.is_none() && !entry.secret_exempt {
                return Err(err(
                    "corpus/dict/junos-srx",
                    0,
                    DictGate::SecretCoupling,
                    format!(
                        "`{}` has a secret-word path segment before a capture and declares \
                         neither `secret:` nor `secret_exempt:`",
                        entry.id
                    ),
                ));
            }
        }
    }
    Ok(())
}

/// §4.6's two-position leaf-name walk over a dictionary path: from `at`
/// towards the root, over the two nearest preceding **literal** segments;
/// captures are skipped and do not consume a position.
pub(crate) fn leaf_name_walk(path: &[PathSeg], at: usize) -> bool {
    let mut visited = 0usize;
    for seg in path.iter().take(at).rev() {
        let text = match seg {
            PathSeg::Literal(t) => t,
            PathSeg::Capture(_) => continue,
        };
        if is_secret_word(text) {
            return true;
        }
        visited += 1;
        if visited == 2 {
            break;
        }
    }
    false
}

/// The secret-word test: case-folded, hyphens and underscores equal
/// (`14` §9.4).
pub(crate) fn is_secret_word(text: &str) -> bool {
    let fold = |s: &str| {
        s.chars()
            .map(|c| {
                if c == '_' {
                    '-'
                } else {
                    c.to_ascii_lowercase()
                }
            })
            .collect::<String>()
    };
    let needle = fold(text);
    SECRET_WORD_LIST.iter().any(|w| fold(w) == needle)
}

fn build_trie(entries: &[Entry]) -> Result<Vec<DictNode>, DictError> {
    let mut trie: Vec<DictNode> = vec![DictNode::default()];
    for (idx, entry) in entries.iter().enumerate() {
        let mut node = 0usize;
        for seg in &entry.path {
            let next = match seg {
                PathSeg::Literal(text) => {
                    let found = trie
                        .get(node)
                        .and_then(|n| n.literal.iter().find(|(s, _)| s == text).map(|(_, c)| *c));
                    match found {
                        Some(c) => c,
                        None => {
                            let c = trie.len();
                            trie.push(DictNode::default());
                            if let Some(n) = trie.get_mut(node) {
                                n.literal.push((text.clone(), c));
                                n.literal.sort_by(|a, b| a.0.cmp(&b.0));
                            }
                            c
                        }
                    }
                }
                PathSeg::Capture(_) => {
                    let found = trie.get(node).and_then(|n| n.capture);
                    match found {
                        Some(c) => c,
                        None => {
                            let c = trie.len();
                            trie.push(DictNode::default());
                            if let Some(n) = trie.get_mut(node) {
                                n.capture = Some(c);
                            }
                            c
                        }
                    }
                }
            };
            node = next;
        }
        match trie.get_mut(node) {
            Some(n) if n.entry.is_none() => n.entry = Some(idx),
            _ => {
                return Err(err(
                    "corpus/dict/junos-srx",
                    0,
                    DictGate::Shadowing,
                    format!("`{}` compiles onto an occupied trie terminal", entry.id),
                ))
            }
        }
    }
    Ok(trie)
}

/// `14` §6.3's CI assertion, read per §12 item 11: an entry's own-path lookup
/// costs its straight-line walk plus at most [`BACKTRACK_ALLOWANCE`] extra
/// visits.
///
/// `DictGate` has no budget variant and adding one would be a WO-03 §7
/// trigger 3, so an over-budget entry is reported as `Shadowing` — which is
/// also its cause: backtracking happens exactly where one entry's literal
/// branch shadows another's capture branch (§12 item 16).
fn gate_lookup_budget(dict: &Dictionary) -> Result<(), DictError> {
    for entry in &dict.entries {
        let segs: Vec<String> = entry
            .path
            .iter()
            .map(|s| match s {
                PathSeg::Literal(t) => t.clone(),
                PathSeg::Capture(n) => format!("${n}"),
            })
            .collect();
        let refs: Vec<&str> = segs.iter().map(|s| s.as_str()).collect();
        let (_, visits) = dict.lookup(&refs);
        let allowed = entry.path.len() + 1 + BACKTRACK_ALLOWANCE;
        if visits > allowed {
            return Err(err(
                "corpus/dict/junos-srx",
                0,
                DictGate::Shadowing,
                format!(
                    "`{}` costs {visits} trie visits, over the {allowed} its path allows",
                    entry.id
                ),
            ));
        }
    }
    Ok(())
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

    pub(crate) fn repo_root() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(2)
            .expect("the crate lives two levels under the repo root")
            .to_path_buf()
    }

    fn dict() -> Dictionary {
        Dictionary::load(&repo_root()).expect("the shipped dictionary loads")
    }

    #[test]
    fn shipped_dictionary_compiles() {
        let d = dict();
        assert_eq!(d.platform(), "junos-srx");
        // 39 through WO-03; +3 on 2026-08-10 — `system domain-name` and
        // `description` at both the interface and the unit level, the three
        // statements a 26-line branch config produced as residue.
        //
        // +27 on 2026-08-15, chosen by measurement rather than by taste:
        // `tests/branch_coverage.rs` binds a documented SRX branch
        // configuration and reports the miss rate by section, and these are
        // the sections that miss the most and are reachable without shaping a
        // stub value type. See docs/60-content/66-junos-coverage-measurement.md.
        //
        // +12 on 2026-08-15 — the routing slice: five OSPF, six BGP (three
        // that bind and three `secret:`-only catalogue entries for the BGP
        // TCP-MD5 key, one per documented hierarchy level) and
        // `routing-options router-id`.
        assert_eq!(d.entry_count(), 81);
    }

    /// The precise half of `lookup_budget_within_8`: the gate runs inside
    /// `load`, and this measures the visit counts it checks.
    #[test]
    fn lookup_budget_within_8() {
        let d = dict();
        for entry in &d.entries {
            // The synthetic probe must be a statement the entry could legally
            // match, so a capture carrying a `where:` is filled with one of the
            // tokens it allows rather than with `$name`. Substituting a legal
            // token STRENGTHENS the round trip -- it is the only spelling that
            // can still reach the terminal -- where leaving `$name` in place
            // would have turned every constrained entry into a silent
            // no-match and the round-trip assertion below into a tautology.
            let segs: Vec<String> = entry
                .path
                .iter()
                .enumerate()
                .map(|(at, s)| match s {
                    PathSeg::Literal(t) => t.clone(),
                    PathSeg::Capture(n) => entry
                        .constraints
                        .iter()
                        .find(|(i, _)| *i == at)
                        .and_then(|(_, allowed)| allowed.first().cloned())
                        .unwrap_or_else(|| format!("${n}")),
                })
                .collect();
            let refs: Vec<&str> = segs.iter().map(|s| s.as_str()).collect();
            let (m, visits) = d.lookup(&refs);
            assert!(
                visits <= entry.path.len() + 1 + BACKTRACK_ALLOWANCE,
                "{} costs {visits} visits",
                entry.id
            );
            assert!(visits <= VISIT_BUDGET);
            assert_eq!(
                m.consumed,
                entry.path.len(),
                "{} did not match itself",
                entry.id
            );
        }
    }

    #[test]
    fn longest_match_wins_over_the_partial_entry() {
        let d = dict();
        let short = d.lookup(&[
            "security",
            "zones",
            "security-zone",
            "VPN",
            "interfaces",
            "st0.0",
        ]);
        let long = d.lookup(&[
            "security",
            "zones",
            "security-zone",
            "WAN",
            "interfaces",
            "reth0.0",
            "host-inbound-traffic",
            "system-services",
            "ike",
        ]);
        assert_eq!(short.0.consumed, 6);
        assert_eq!(long.0.consumed, 9);
        assert_ne!(short.0.entry, long.0.entry);
    }

    #[test]
    fn unmapped_paths_report_their_known_prefix() {
        let d = dict();
        assert_eq!(
            d.lookup(&["security", "idp", "idp-policy", "Recommended"])
                .0,
            Match {
                entry: None,
                consumed: 0,
                known_prefix: 1
            }
        );
        // `routing-options` became a known segment on 2026-08-15, when
        // `routing-options router-id` landed. The static route is still
        // unmapped — nothing in the dictionary reaches `static` — but the
        // reported prefix is now 1 rather than 0, which is the point of the
        // number: it tells the reader how far Fathom followed before it lost
        // the path, and it followed one segment further than it used to.
        assert_eq!(
            d.lookup(&["routing-options", "static", "route", "10.2.0.0/16"])
                .0,
            Match {
                entry: None,
                consumed: 0,
                known_prefix: 1
            }
        );
    }

    #[test]
    fn shadowing_gate_refuses_an_undeclared_prefix() {
        let sources = vec![(
            "t.yaml".to_owned(),
            "platform: junos-srx\nentries:\n  \
             - { id: a, path: [security, ike], versions: \"*\", reviewed_by: x }\n  \
             - { id: b, path: [security, ike, mode], versions: \"*\", reviewed_by: x }\n"
                .to_owned(),
        )];
        let e = Dictionary::from_sources(&sources, BTreeMap::new()).unwrap_err();
        assert_eq!(e.gate, DictGate::Shadowing);
    }

    #[test]
    fn secret_coupling_gate_refuses_an_undeclared_secret_word() {
        let sources = vec![(
            "t.yaml".to_owned(),
            "platform: junos-srx\nentries:\n  \
             - { id: a, path: [system, radius-server, secret, \"$v\"], versions: \"*\", reviewed_by: x }\n"
                .to_owned(),
        )];
        let e = Dictionary::from_sources(&sources, BTreeMap::new()).unwrap_err();
        assert_eq!(e.gate, DictGate::SecretCoupling);
    }

    #[test]
    fn reviewed_by_is_mandatory() {
        let sources = vec![(
            "t.yaml".to_owned(),
            "platform: junos-srx\nentries:\n  - { id: a, path: [system, x], versions: \"*\" }\n"
                .to_owned(),
        )];
        let e = Dictionary::from_sources(&sources, BTreeMap::new()).unwrap_err();
        assert_eq!(e.gate, DictGate::ReviewedByMissing);
    }

    #[test]
    fn capture_arity_gate_refuses_a_dangling_reference() {
        let sources = vec![(
            "t.yaml".to_owned(),
            "platform: junos-srx\nentries:\n  \
             - { id: a, path: [system, x, \"$v\"], binds: { nodes: [ { as: n0, kind: Device, key: \"$nope\" } ] }, versions: \"*\", reviewed_by: x }\n"
                .to_owned(),
        )];
        let e = Dictionary::from_sources(&sources, BTreeMap::new()).unwrap_err();
        assert_eq!(e.gate, DictGate::CaptureArity);
    }

    /// WO-09 §5 step 2: every index inside `entry_count()` names an entry,
    /// every index outside it names none.
    #[test]
    fn entry_id_is_reachable_inside_the_entry_count() {
        let d = dict();
        let count = u16::try_from(d.entry_count()).expect("39 entries fit u16");
        for index in 0..count {
            let id = d.entry_id(index).expect("an index inside the count");
            assert!(!id.is_empty(), "entry {index} has no id");
            assert_eq!(Some(id), d.entries[usize::from(index)].id.as_str().into());
        }
        assert_eq!(d.entry_id(count), None);
        assert_eq!(d.entry_id(u16::MAX), None);
    }

    #[test]
    fn token_maps_resolve_the_vendor_spellings() {
        let d = dict();
        assert_eq!(d.token_map("DhGroup", "group14"), Some("14"));
        assert_eq!(
            d.token_map("IntegrityAlgorithm", "sha-256"),
            Some("hmac-sha-256-128")
        );
        assert_eq!(d.token_map("DhGroup", "group999"), None);
    }
}
