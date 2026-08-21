//! The estate's **shape** — a short digest of what a step left behind, so a
//! replay can tell the operator that it did not rebuild what he saved.
//!
//! # The defect this exists for
//!
//! The saved workspace is an op log, and replaying a `paste` entry re-runs the
//! parser over the redacted text. The parser changes: the Junos dictionary went
//! from 23.8% to 47.5% line coverage in two days this month (`66`). So the same
//! file, reopened next month, builds a **different estate** — more nodes, and
//! therefore different ULIDs for everything minted after the first new one —
//! and nothing says so. `49` §10a names this and calls the silence the harm:
//! *"every hand-drawn link pointing at nodes that no longer exist."*
//!
//! # Why a digest and not the product
//!
//! `49` §10a's own suggestion is to record what the parse *produced* and replay
//! the product. The page argues the other way in its own words above
//! `journal: []` — the op log *"survives a schema change (the ops re-derive; a
//! serialised graph does not)"* and is *"the only shape multi-writer
//! collaboration can ever carry"* (`75` §2.4). Both are right, and recording
//! the product loses a third thing neither mentions: an operator who pastes a
//! config today and reopens it after the dictionary improves **wants the better
//! reading**. Freezing the product would trade a silent divergence for a silent
//! stagnation, which is not obviously the better bargain and is certainly not a
//! fix.
//!
//! So: keep re-deriving, and **check**. The digest turns a silent divergence
//! into a stated one, which is the actual defect.
//!
//! # What is in it, and what is deliberately not
//!
//! In: every element's **identity** — kind name and ULID — every edge's two
//! **endpoints**, and whether the element is tombstoned.
//!
//! Out: field values, provenance, batch ids, history, and the op log.
//!
//! The line is drawn there for one reason. The identities are exactly what the
//! **rest of the journal names**: a `link`, `place`, `rack`, `field` or `remove`
//! entry carries display ids (`<kind-lower>:<ulid>`), and `Display` is injective
//! over `(kind, ulid)`, so hashing the parts is hashing the names those entries
//! use. A replay whose identities survive can replay everything after it; one
//! whose identities moved cannot, and that is the failure worth reporting.
//!
//! Field values are out because putting them in would destroy the property the
//! journal exists for. A new field on an unrelated kind, a default that changes,
//! a scalar that gains a spelling — every one of those is a schema change the op
//! log is *supposed* to survive, and a digest that fired on them would cry wolf
//! monthly until nobody read it. The known blind spot is stated rather than
//! hidden: a dictionary improvement that only fills in a field on a node that
//! already existed does not move this digest. The page compares the paste's four
//! summary counts alongside it — nodes, edges, residue lines, secrets removed —
//! and a newly-bound line always leaves the residue list, so that case is caught
//! by the counts even though it is invisible here.
//!
//! # Order
//!
//! The combiner is **commutative** (wrapping addition of per-element digests),
//! so the result depends on the set and not on the walk. The store's walk is
//! already deterministic — `BTreeMap` keyed by `NodeId`, whose `Ord` is
//! *(kind declaration order, then ULID)* and which `id.rs` calls part of
//! invariant 9's observable surface — but that order is a function of
//! **declaration position in `schema/`**. Inserting a kind in the middle of the
//! schema would reorder the walk without changing one fact about the network,
//! and a sequential digest would report that as drift. The same argument that
//! makes the journal write an edge-kind **name** and never an ordinal applies to
//! the walk: an exported journal outlives the build that wrote it.
//!
//! # It is not tamper-evidence, and must never be described as such
//!
//! FNV-1a is a **non-cryptographic** hash. RFC 9923, *The FNV Non-Cryptographic
//! Hash Algorithm* (Independent Submission, Informational, February 2026) says
//! it in its own security considerations: *"No assertion of suitability for
//! cryptographic applications is made for the FNV hash algorithms."* Anybody who
//! edits a journal file can recompute this field, and the file is plaintext and
//! says so in its own banner. This detects **drift**, which is an accident. It
//! detects nothing an adversary does, and no sentence in this codebase or on the
//! page may imply otherwise (ADR-0034: the source and the date are named because
//! a security claim is never answered from memory).
//!
//! # It does not leak what the gate destroyed
//!
//! The digest is a function of the graph, and the graph is post-gate: the
//! redaction gate runs *"after shape and before bind"* (`redact.rs`), and
//! `SecretPlaceholder` has no text constructor, so no destroyed byte is
//! reachable from here. `RedactionEntry::orig_len` — the one place a length
//! survives — lives in the ingest report and never enters the store.
//!
//! **The digest is over the graph and never over the capture text.** That is not
//! a detail. A digest over text is a guess-confirmation oracle: hand someone the
//! digest of a document and they can test candidate documents against it. The
//! capture is redacted, so the secret is not in it — but a length oracle was
//! found in exactly this area on 2026-08-21 (`38` §14.9), and the rule that
//! prevents the next one is to hash the *product* and never the *paste*.

use crate::graph::Graph;
use fathom_ir::generated::ir_types::NodeKind;

/// RFC 9923 §2.1's 64-bit `offset_basis`: 14,695,981,039,346,656,037.
const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
/// RFC 9923 §2.1's 64-bit `FNV_Prime`: 2^40 + 2^8 + 0xb3 = 1,099,511,628,211.
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

/// FNV-1a over one element's bytes. RFC 9923 §3: for each octet,
/// `hash = (hash XOR octet) * FNV_Prime mod 2**64`.
///
/// Restarted per element rather than run across the whole walk, because the
/// combiner above it is commutative on purpose (see the module doc).
struct Fnv(u64);

impl Fnv {
    fn new() -> Fnv {
        Fnv(FNV_OFFSET)
    }

    #[inline(never)]
    fn eat(&mut self, bytes: &[u8]) {
        for b in bytes {
            self.0 = (self.0 ^ u64::from(*b)).wrapping_mul(FNV_PRIME);
        }
    }
}

/// One element's identity, fed in a fixed order: a tag byte that separates a
/// node from an edge, the kind's **declared name**, the ULID, and the tombstone
/// flag.
///
/// The kind travels as its name and never as `NodeKind::index()`. The index is
/// declaration position, which moves when `schema/` gains a kind anywhere but
/// the end; the name moves only when the kind is renamed, which is a real change
/// to the vocabulary and should move the digest.
fn element(tag: u8, kind: &str, ulid: u128, absent: bool) -> Fnv {
    let mut h = Fnv::new();
    h.eat(&[tag]);
    h.eat(kind.as_bytes());
    // A length byte between the name and the ULID would be redundant: the ULID
    // is fixed-width and follows, so no two (name, ulid) pairs can produce the
    // same byte string by running together.
    h.eat(&ulid.to_le_bytes());
    h.eat(&[u8::from(absent)]);
    h
}

/// The estate's shape digest: the set of element identities and edge endpoints
/// this graph holds.
///
/// Defined over **the whole held estate after a step**, not over one operation's
/// product. Today `OP_PASTE` replaces what is held, so for a paste the two are
/// the same thing; when it becomes *"add to this design"* (`49` §19 phase 0,
/// item 2) this definition still means what it says and needs no edit.
pub fn shape_digest(graph: &Graph) -> u64 {
    let mut total: u64 = 0;
    // WALKED BY KIND, and the reason is bytes, not taste. `nodes_of_kind`'s
    // range iterator is already linked into the module (the inventory uses it);
    // `nodes()`'s whole-map iterator is not, and asking for it costs a further
    // 252 bytes of a module with 203 to spare. The combiner below is
    // commutative, so the walk is free to take whichever shape is cheapest —
    // which is the whole point of making it commutative.
    for kind in NodeKind::ALL {
        for n in graph.nodes_of_kind(kind) {
            let h = element(
                b'N',
                n.id.kind.name(),
                n.id.ulid.0,
                n.absent_since.is_some(),
            );
            total = total.wrapping_add(h.0);
        }
    }
    for e in graph.edges() {
        let mut h = element(
            b'E',
            e.id.kind.name(),
            e.id.ulid.0,
            e.absent_since.is_some(),
        );
        // The endpoints, in the same shape and in a fixed order. `from` before
        // `to`: an edge kind may be declared symmetric (`11` §6.4), but the
        // stored edge still has a direction and a store that reversed one has
        // changed something an operator can see on the diagram.
        h.eat(e.from.kind.name().as_bytes());
        h.eat(&e.from.ulid.0.to_le_bytes());
        h.eat(e.to.kind.name().as_bytes());
        h.eat(&e.to.ulid.0.to_le_bytes());
        total = total.wrapping_add(h.0);
    }
    total
}

/// [`shape_digest`] as 16 lowercase hex characters — the form that travels over
/// the protocol and is written into the journal file.
///
/// Hex, not Crockford base32: `fathom-id`'s encoding is what an **identity**
/// looks like in this product, and a digest that reads like a ULID would be
/// taken for one. All 64 bits are kept — RFC 9923's security considerations name
/// weak diffusion in FNV's low-order bits, so nothing here truncates.
pub fn shape_hex(graph: &Graph) -> String {
    hex(shape_digest(graph))
}

/// 64 bits as 16 lowercase hex characters, most significant nibble first.
fn hex(d: u64) -> String {
    let mut out = String::with_capacity(16);
    for i in (0..16).rev() {
        let nibble = ((d >> (i * 4)) & 0xf) as u8;
        out.push(char::from(if nibble < 10 {
            b'0' + nibble
        } else {
            b'a' + nibble - 10
        }));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// FNV-1a's published 64-bit vectors, so the arithmetic here is the
    /// specified algorithm and not something that merely resembles it.
    ///
    /// ADR-0034 — the source and the date. RFC 9923, *The FNV Non-Cryptographic
    /// Hash Algorithm* (Independent Submission, Informational, February 2026)
    /// gives the constants and the pseudocode; these two values were derived
    /// independently from that pseudocode and cross-checked against the FNV
    /// authors' own reference test suite (`lcn2/fnv`, `test_fnv.c`), which is a
    /// second source rather than a restatement of the first.
    #[test]
    fn fnv1a_matches_the_published_vectors() {
        let mut h = Fnv::new();
        h.eat(b"a");
        assert_eq!(h.0, 0xaf63_dc4c_8601_ec8c);

        let mut h = Fnv::new();
        h.eat(b"foobar");
        assert_eq!(h.0, 0x8594_4171_f739_67e8);

        // The empty input is the offset basis untouched.
        assert_eq!(Fnv::new().0, FNV_OFFSET);
    }

    #[test]
    fn hex_is_sixteen_lowercase_characters() {
        let hex = super::hex(0x0123_4567_89ab_cdef);
        assert_eq!(hex, "0123456789abcdef");
        assert_eq!(super::hex(0), "0000000000000000");
        assert_eq!(super::hex(u64::MAX), "ffffffffffffffff");
    }
}
