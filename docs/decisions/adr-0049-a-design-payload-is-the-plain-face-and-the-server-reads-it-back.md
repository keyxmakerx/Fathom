# ADR-0049 — A design payload is the plain face, and the server reads it back before storing it

**Status:** Accepted, 2026-09-16
**Context:** Session 4 of `docs/NEXT.md` gives the browser its first document: racks, chassis and
ports, saved through Session 2's endpoints. `docs/PHASE-2-STORAGE-DESIGN.md` §3 settled that the
payload is encrypted whole and stored opaque; it never said what the bytes are. The retired client
never reached this question.

## The decision

1. **A design payload is a `fathom-plain 1` document** — `crates/fathom-workspace`'s plaintext
   face: the magic line, the warning line, `schema <version>`, a blank line, then the graph
   snapshot as canonical JSON (`fathom-canon`'s rules, `fathom-graph`'s `Snapshot` shape). It is
   the one graph format the Rust engine reads, so a design the browser saves is a design the
   walkthrough, the checker and the inventory can open on the server later without a converter.
   The warning line is true in transit only until the server encrypts it; it stays because the
   format is the format.
2. **The server reads every payload back before storing it.** `save_design_handler` parses the
   bytes with `fathom_workspace::read_plain` and refuses, with the typed error surfaced, anything
   the engine cannot read. The browser writes the format in TypeScript; the Rust reader is the
   referee, so any drift between the two is caught at save and never persists.
3. **The browser's writer is proved against Rust-made vectors.** A Rust test writes small graphs
   with `write_plain` into fixtures under the client tree, and the TypeScript reader and writer
   must reproduce them byte for byte — the same cross-language pattern as the session vectors.
4. **The schema version prefix stays.** The save route's four-byte prefix and the face's line 3
   both name the schema version; they must agree, and the server checks that they do. *Settled
   while building, 2026-09-16:* the schema version is the string `0.N` and the prefix is a `u32`,
   so the prefix carries **N**, the minor number — `0.5` puts `5` on the wire, little-endian. No
   prior art existed for this; it is named in `design_api.rs` and here, and is revisited if the
   schema ever reaches `1.0`.

## What this rules out

A JSON shape of the browser's own devising, however convenient, and any second "browser format"
converted on the server. One graph, several views — `CLAUDE.md`'s first sentence — includes the
bytes.
