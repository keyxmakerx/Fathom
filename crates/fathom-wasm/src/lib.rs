//! fathom-wasm: 41 §3.7's raw (ptr, len) ABI over the finder — slice one of
//! the browser core. Safe Rust throughout: both buffers are module-owned
//! `Vec`s; the host writes into a buffer whose address the module published,
//! and the module reads it back only inside a later export call, so no raw
//! pointer is ever dereferenced on this side of the boundary.
//!
//! Import section: empty — the finder needs neither entropy nor time
//! (41 §3.2's X13/X14 serve sealing and provenance, which are not linked
//! here). `tests/artifact_gates.rs` pins that fact against the built module.
//!
//! `#![forbid(unsafe_code)]` cannot be carried by this crate: `#[no_mangle]`
//! is rejected under it (symbol-collision hazard). deny + three per-item
//! allows is the narrowest working form; there is no `unsafe` block to allow.
#![deny(unsafe_code)]

pub mod protocol;
pub mod shell;
pub mod wasmbin;

use std::cell::RefCell;

use crate::shell::Shell;

/// 41 §3.7's opcode table. Stable forever; a new call is a new opcode, never
/// a changed one. Only the two this slice implements are named — an
/// unimplemented opcode is refused by number (protocol::ERR_UNKNOWN_OP).
pub const OP_INIT: u32 = 1;
pub const OP_QUERY: u32 = 4;

/// The inventory face's four opcodes (WO-08 §4.4). 41 §3.7's table holds
/// 1–10; these take the next free numbers. A new call is a new opcode, never
/// a changed one — 2, 3 and 5–10 stay refused by number.
pub const OP_ESTATE_DEMO: u32 = 11;
pub const OP_INV_ROWS: u32 = 12;
pub const OP_ELEMENT: u32 = 13;
pub const OP_EQUIPMENT: u32 = 14;

/// Paste in, estate out: the on-ramp opcode. Takes `14`'s pasted text, runs
/// ingest and the weld, and replaces the held estate with what it understood.
///
/// The host supplies the clock and the entropy **in the frame**, because the
/// module has none of either and must not acquire either: `wasmbin`'s import
/// allowlist is empty and this opcode does not grow it. That is not a
/// workaround — it is `fathom-weld`'s own `Manifest` contract (invariant 9),
/// which exists precisely so the weld cannot read a clock.
pub const OP_PASTE: u32 = 15;

thread_local! {
    static SHELL: RefCell<Shell> = RefCell::new(Shell::new());
    static REQ: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static REPLY: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// Allocate `len` bytes of scratch for the caller to write a request into.
/// One scratch buffer exists; a second call replaces the first. Never traps.
#[allow(unsafe_code)] // #[no_mangle] only; no unsafe block. WO-07 §3 probe 5.
#[no_mangle]
pub extern "C" fn fathom_alloc(len: u32) -> u32 {
    REQ.with(|r| {
        let mut v = r.borrow_mut();
        v.clear();
        v.resize(len as usize, 0);
        v.as_ptr() as usize as u32
    })
}

/// Release the scratch buffer. `ptr`/`len` are accepted for 41 §3.7 signature
/// fidelity and ignored: there is exactly one scratch to free.
#[allow(unsafe_code)] // as above
#[no_mangle]
pub extern "C" fn fathom_free(_ptr: u32, _len: u32) {
    REQ.with(|r| *r.borrow_mut() = Vec::new());
}

/// The one data-plane entry point (41 §3.7). Returns
/// `(reply_ptr as u64) << 32 | reply_len as u64`; 0 means "no reply". The
/// reply lives in a module-owned arena valid until the next `fathom_call`.
/// A failure is a reply with `record_kind = 0`, never a trap (41 §3.9);
/// `req_ptr` must be the live scratch address and `req_len` within it, else
/// the reply is `ERR_BAD_FRAME`.
#[allow(unsafe_code)] // as above
#[no_mangle]
pub extern "C" fn fathom_call(op: u32, req_ptr: u32, req_len: u32) -> u64 {
    let req: Option<Vec<u8>> = REQ.with(|r| {
        let v = r.borrow();
        let live = v.as_ptr() as usize as u32;
        if req_ptr == live && (req_len as usize) <= v.len() {
            Some(v[..req_len as usize].to_vec())
        } else {
            None
        }
    });
    let reply = match req {
        None => protocol::encode_error(
            protocol::ERR_BAD_FRAME,
            "request pointer is not the live scratch buffer",
        ),
        Some(bytes) => SHELL.with(|s| s.borrow_mut().handle(op, &bytes)),
    };
    REPLY.with(|r| {
        let mut v = r.borrow_mut();
        *v = reply;
        if v.is_empty() {
            0
        } else {
            ((v.as_ptr() as usize as u64) << 32) | v.len() as u64
        }
    })
}
