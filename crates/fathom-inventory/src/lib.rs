//! fathom-inventory: the inventory face's projections (`76` §7.2's S4 slice,
//! part one).
//!
//! **Every join, walk and count happens in this crate.** The JS in the browser
//! artifact renders the strings these functions return into the prototype's
//! markup and computes nothing — ADR-0019's *"Views are pure functions of
//! typed data"* made mechanically checkable, because the projections run under
//! native `cargo test` with no browser and the boundary stays one crossing per
//! user intention.
//!
//! Nothing here writes the graph except `demo_estate()`, and nothing here
//! reads a clock, draws entropy, or touches a network: the estate is
//! constructed in code with every ULID and timestamp pinned (invariant 9).

#![forbid(unsafe_code)]

mod author;
mod demo;
mod element;
mod equipment;
mod inventory;
mod render;

pub use author::{is_authorable, parse_into_slot, AuthorError};
pub use demo::demo_estate;
pub use element::{element_page, parse_display_id, ElementPage, FieldRow};
pub use equipment::{equipment_page, CabledPeer, EquipmentPage, IfaceRow, PortRow};
pub use inventory::{columns, rows, InvKind, Row};
