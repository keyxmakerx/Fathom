# What is actually built

**Last confirmed:** 2026-09-11. Read numbers off a real run, not off this page.

This page records what exists. It is not a changelog — history lives in `docs/archive/`.

---

## Working and keeping

**The Rust engine.** Schema toolchain, typed graph store, config ingest with the redaction gate,
the fragment-to-store weld, the finder, emitters, layout. Around 792 tests passing. Zero external
dependencies on the client side, deliberately.

**The schema.** Real and enforced — roughly 51 kinds, 95 edges, 61 scalars at version 0.5. Read
the actual numbers off `fathom-schema-check`; this line has been wrong before.

**The server.** `crates/fathom-server` starts, answers a health check through a real PostgreSQL,
shuts down cleanly, and runs behind TLS in a composed stack. **It stores nothing yet** — exactly
one table exists, the migrations table. That was deliberate: no row gets written before key
custody is settled, and it now is.

**The dependency gate.** Five layers, none redundant: approval records per crate, lookalike-name
detection, a publication cooldown, licence and source allowlisting, and a vulnerability database
check. 115 external crate versions in the lockfile after the server landed (the lockfile
holds 132 entries; 17 of them are our own workspace crates, which no gate reviews).

**The engine seam.** As of 2026-09-12 the server depends on `fathom-schema`, `fathom-graph` and
`fathom-id`. It loads the `schema/` tree once at startup and serves `GET /schema/kinds` off the
loaded tree. Before this, the two halves of the codebase shared nothing. It still stores nothing:
`tests/stores_nothing.rs` is unchanged and still passes. `fathom-graph` and `fathom-id` have no
caller yet.

**Key handling.** Decided and ratified: a data key per tenant and per design, wrapped by a master
key, custody switched by re-wrapping keys rather than re-encrypting data.

---

## Being replaced

**The browser client.** Currently a single large HTML file assembled by Rust. Four views work
(diagram, inventory, finder, findings); two were never built (walkthrough, config). The gestures
are proven — placing boxes, drawing links, cabling, drag-to-connect — each with browser tests
behind it. **The interaction design is worth keeping; the implementation is not.**

**The layout engine.** Works, and is cubic — 36,481 nodes took 244 seconds when measured. Being
replaced with a standard algorithm.

---

## Never built

- Walkthrough view — the teaching half of the product.
- Config view.
- Engine manager — how equipment types are registered and kept current.
- Automatic correlation across separately-pasted configs.
- Anything that discovers a network live. Everything today comes from pasted text.

---

## Known limits worth remembering

**The server refuses to start on a broken schema, deliberately.** `EngineState::load` runs every
gate and will not serve a vocabulary that fails one. Before 2026-09-12 it started anyway, reported
healthy, and served an empty kind list — an independent check reproduced that against a live
database. A broken tree is now a startup failure naming the gate and the file, exit 7.

`deploy/Dockerfile` copies `schema/` into the distroless runtime stage from the build stage, so the
image ships exactly the tree it was built against. `FATHOM_SCHEMA_ROOT` overrides the path. Both
landed 2026-09-12 after the same check found the image crash-looped with no schema beside the binary
and no way for an operator to point it elsewhere.

- **Typed values are not redacted.** The gate runs on paste only. A password typed by hand into a
  field is stored and exported as written — it gets a warning mark beside it, and that is the
  decision, not a bug.
- **Juniper is the only platform with real content behind it.** Five others are registered and
  empty. A pasted Juniper branch config binds about 57% of its lines.
- **Nothing creates cables or ports from a config.** Only by hand.

---

## Reference

`/home/user/pouzor/homelable` — a smaller, well-built homelab visualization tool being used as a
reference for the client rebuild. React, and it solves several problems we hand-built.
