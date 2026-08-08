//! fathom-emit: the junos-srx emitters — graph to `(line, provenance)` pairs.
//!
//! One platform (`junos-srx`), one emit unit (`11` §9.2's `IpsecVpn` closure),
//! seven covered kinds. Every emitted statement is one logical line carrying
//! the provenance that produced it (conventions invariant 6: *"Emitters return
//! `(line, provenance)` pairs, never strings."*), its risk band, its
//! idempotency class and its explain key, together with an `EmitReport` no
//! caller can take the lines without (`13` §7.2).
//!
//! **Assert-only.** Nothing here retracts, deactivates or reorders: `LineForm`,
//! `Phase` and `Reversibility` wait for `18`, and every line is a `set`
//! statement. The narrowings this crate ships against `13`'s specified shapes
//! are recorded in WO-04 §12, by item number:
//!
//! - item 1 — `String`/`Vec` for `CompactString`/`SmallVec`; no `LineId`
//!   (`13` §2.3 needs a hash and the workspace has none); no `LineForm`, no
//!   `Phase`, no `Reversibility`, no `rules_applied`; explain keys as strings;
//!   private kind-emitter functions instead of `13` §6.2's `Platform` /
//!   `KindEmitter` trait registry and §6.3's typestate builder; the idempotency
//!   classes, the block table and the gap declarations as crate consts rather
//!   than reviewed corpus data.
//! - item 2 — depth-first **post-order** ordinals, against `11` §9.2's word
//!   "pre-order", because post-order is what reproduces the card's own object
//!   chain that the same sentence promises.
//! - item 3, item 6 — the round-trip criterion is `13` §11.1 E1's text fixed
//!   point, never graph equality, with the agreement clause narrowed to what
//!   presence-dependent ledgers can carry.
//! - item 4 — `FieldRef` is `13` §2.2's instance-level triple; the rule
//!   engine's static pair of the same name is `13` §16 OD-1's business.
//! - item 5 — no `WrapPolicy`: `text` is unwrapped, which is the whole of the
//!   clipboard half of `53` §6.3.1's contract.
//!
//! Deliberately outside this crate: any second platform, the statement
//! dictionary, a template engine, defaults, diff/verify/rollback, the plumbing
//! statements, rule-engine wiring, and any UI.

#![forbid(unsafe_code)]

pub mod block;
pub mod junos;
pub mod line;
pub mod order;
pub mod output;
pub mod path;
pub mod plan;
pub mod report;
pub mod risk;

pub use block::{Block, BlockId, BLOCKS};
pub use line::{EmittedLine, FieldRef, FieldRole, Idempotency, PlaceholderSpan};
pub use output::{emit, EmitError, EmitOutput, EmitScope, RenderRefused};
pub use path::{PathToken, StatementPath, PLATFORM};
pub use report::{BlockReason, Blocker, EmitConflict, EmitReport, GapEntry, Substitution};
pub use risk::Risk;
