//! `13` §4.1's block table, the two ranks this slice populates.

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct BlockId(pub u16);

#[derive(Debug, Clone, Copy)]
pub struct Block {
    pub id: BlockId,
    pub title: &'static str,
    pub rank: u16,
}

/// 13 §4.1 ranks 20 and 30, verbatim titles. The block table is authored
/// data (13 §4.2), fixed here; extending it is a follow-on emitter WO.
pub const BLOCKS: &[Block] = &[
    Block {
        id: BlockId(20),
        title: "PHASE 1 — PROPOSAL, POLICY, GATEWAY",
        rank: 20,
    },
    Block {
        id: BlockId(30),
        title: "PHASE 2 — PROPOSAL, POLICY, VPN",
        rank: 30,
    },
];

/// The rank of a block id. A kind outside the seven cannot enter the walk, so
/// `13` §4.2's `MISCELLANEOUS` fallback is unreachable and not built; an id
/// off the table sorts last rather than panicking.
pub(crate) fn rank(id: BlockId) -> u16 {
    match BLOCKS.iter().find(|b| b.id == id) {
        Some(b) => b.rank,
        None => u16::MAX,
    }
}
