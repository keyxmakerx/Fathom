//! `fathom-rules`: fex, the rule condition language (ADR-0009), and the rule engine that
//! turns written rules into the checks the canvas shows.
//!
//! Every check is a written rule with a source. No model decides anything (ADR-0020):
//! a rule is data in `corpus/rules/<id>/rule.yaml`, its condition is a fex expression,
//! and fex is lexed, type-checked, compiled to a 28-opcode VM and run under a step
//! budget by the code in this crate. Nothing in the trusted path is third-party.
//!
//! Where the spec (docs/archive/10-core/12-rule-engine.md) is narrower or wider than this
//! build:
//! - a binding may walk up to `rule::MAX_HOPS` (6) edges, not 12 §4.2's 3, because the
//!   physical layer needs cable → port → interface → unit → address. Bindings are bounded
//!   instead by a per-binding visit cap (`eval::MAX_VISITS`);
//! - the builtin table is the first rule set's (`compile::Builtin`), and grows with rules;
//! - a binding may be `all: Kind`, every live node of a kind (card many), for facts held
//!   once per design rather than reached by an edge, such as a firmware target;
//! - invalidation is per rule, by read set (`engine`), not per instance.

#![forbid(unsafe_code)]

pub mod compile;
pub mod engine;
pub mod eval;
pub mod fixture;
pub mod graph;
pub mod lex;
pub mod overlay;
pub mod pack;
pub mod parse;
pub mod rule;
pub mod schema;
pub mod value;
pub mod version;
pub mod vm;
