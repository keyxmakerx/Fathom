# Phase 1 — Taking stock

This is a read-the-code-not-the-docs snapshot of the Fathom project, assembled from eight independent surveys done on 2026-09-11. Its purpose is to separate what is actually built and running from what the documentation merely describes — because the documentation has a known history of describing work that was never built, or that went stale after later decisions overtook it. One survey found that the corpus itself moved again today: `docs/REBUILD-PLAN.md`, `docs/OPEN-QUESTIONS.md`, and `docs/STATE.md` landed, and `CLAUDE.md` was cut down from a long changelog to an 86-line pointer page, all in the same commit. If you are reading a longer version of `CLAUDE.md`, it is stale.

## What is real

**Rust workspace.** 15 crates, **792 tests** (measured by running `cargo test --workspace` on 2026-09-11, not by counting attributes). Split cleanly in two: 11 crates feed only the browser client (`fathom-wasm`, `fathom-ingest`, `fathom-layout`, `fathom-graph`, `fathom-corpus`, `fathom-inventory`, `fathom-weld`, `fathom-find`, `fathom-artifact`, `fathom-canon`, `fathom-schemagen`), and `fathom-server` has **zero internal Fathom dependencies** — it compiles against nothing but external crates (axum, tokio, tokio-postgres, deadpool-postgres, tracing). There is no wiring between the two yet.

**Server.** Runs, answers `/health` against a real PostgreSQL probe, handles SIGTERM cleanly, creates exactly one table (`_fathom_migrations`) — enforced by a test that greps every migration file. 115 crates in the lockfile, 6 direct. No TLS in the binary itself (Caddy terminates it); deny.toml bans the C/C++ TLS providers by name. No auth, no tenants, no users, no graph tables, no POST/PUT/DELETE routes.

**Browser client.** Four of six views work: diagram (zoom, pan, layer aggregation, crossing reduction), inventory (in-place cell editing), finder (Ctrl+K, 98 commands), findings (schema gap reporting). Hand-authored gestures all work: place a box, link two boxes, cable two boxes (with self-minting ports), drag-to-connect from a box's edge. Junos-SRX paste binds 57.4% of a real config's lines, with a credential-redaction gate that runs on paste only. Artifact size is 2.8MB (988KB wasm). Zero network requests, enforced by CSP.

**Schema.** 30 kinds confirmed built and creatable, including the physical-cabling kinds (`Cable`, `PhysicalPort`) that shipped via `OP_CABLE`.

**CI / dependency gates.** Five layers (gate-zero, cargo-deny, cargo-audit, lockfile-lookalikes, crate-cooldown) all pass, all with their own test suites green.

## What is stubbed or half-built

- `fathom-server`: skeleton only, no data operations.
- `fathom-emit` (43 tests) and `fathom-workspace` (15 tests): written, compiled, **not wired into anything** — 58 tests currently run for no consumer.
- Config view and walkthrough view: placeholders, no implementation.
- Rack faceplate (rung-3 per-port drawing): framework exists, drawing does not.
- Phone view: built on an unmerged branch, collided with other work, needs a rebuild.
- Platform port complements: only `junos-srx` has real content; the other five registered platforms don't.

## What was documented but does not exist

- **A working server product.** Nothing beyond a health check and a migrations table exists server-side. No accounts, no tenants, no encryption, no live collaboration, no graph storage.
- **Live multi-user editing**, one of the four stated pivot goals — zero code exists for it anywhere, client or server.
- **WO-12** (first stored row past the key boundary) is *written*, not executed, and its own text says it needs a human read first — four adversarial review rounds each found real defects, including eleven invented citations in an earlier pass.
- **The old CLAUDE.md's exhaustive changelog** is itself an example of the problem: several of its "as of" claims (test counts, byte totals) were already stale by the time this survey ran, and the file has since been replaced with a short pointer page — evidence the project now explicitly treats long changelogs as a liability.
- **ADR-0003** ("no hosted service, no accounts we run") is still Accepted, filed 2026-07-28, and has never been amended or superseded — while every document since the 2026-08-18 pivot assumes a hosted, multi-tenant service. This is a live, unresolved contradiction in the record, not a documentation lag.

## What we keep

- The whole Rust engine: schema, graph, ingest, layout, IR — server and client both build on it.
- The opcode protocol (27 stateless, reproducible operations) — it's the part of the client proven to survive an architecture change.
- The gesture UX patterns: place/link/cable/drag, selection+details panel, in-place cell editing, accessible combobox search, modal framework, keyboard shortcuts.
- The redaction/secret-detection heuristics.
- The dependency-gate design (five layers, closure pattern for transitive crates).
- Server posture: distroless container, Secret-wrapper redaction, TLS-at-the-edge-only, migration checksums.

## What we discard

- The single offline HTML file and its 900,000-byte ceiling — already retired 2026-08-21.
- `fathom-artifact` (offline HTML assembly) and the base64-embedded-wasm delivery model.
- CSP zero-egress as an architectural constraint — the server changes this threat model entirely.
- Any browser-only glue crate whose only consumer was the offline artifact.

## What to borrow from the reference project

The reference frontend (`homelable`, React+Vite+Zustand+@xyflow/react) is architecturally the closest thing to what Fathom's client rebuild needs, despite different domains. Specific, actionable patterns:

1. **One shared node component + a kind→props dispatch map** (`nodeTypes.ts` / `BaseNode.tsx`) — directly maps onto Fathom's 51 kinds instead of 51 components.
2. **One shared edge component + a small role/style map** (`edgeTypes.ts`) — same idea for Fathom's 95 edge kinds.
3. **A store-per-view-kind, not one mega-store** — homelable's separate network canvas vs. rack canvas (own store, own serializer, own backend routes) is a working precedent for Fathom's own physical/logical fork at the chassis.
4. **Provenance-gated autosave** (`useAutosave.ts`, ~72 lines) — pins document id at arm time, re-checks at fire time, skips if stale. Directly reusable against the exact race WO-12/server work will hit.
5. **Do not copy** the whole-document REST save (last-write-wins) or the status-only WebSocket — neither is compatible with live multi-user editing, which has to be designed from scratch.

## Rebuild order

1. **Resolve ADR-0003 vs. the pivot** — every later step assumes a hosted service; an Accepted ADR says the opposite. Building on top of an unresolved contradiction wastes work if it's ever enforced.
2. **Decide key custody (WO-12's open question)** — the server cannot store its first real row until this is settled; it's already flagged as needing human review, not more building.
3. **Wire `fathom-server` to `fathom-graph`/`fathom-ingest`/`fathom-ir`** — the two halves of the codebase are currently fully separate; nothing else server-side is meaningful until this exists.
4. **Define what "live multi-user editing" means** (presence+lock vs. true concurrency) — this decides the shape of both the server API and the client rebuild by an order of magnitude; get it wrong and Phase 3 must be redone.
5. **Rebuild the client shell** against the decided sync model, borrowing the reference project's node/edge dispatch and store-per-view patterns.
6. **Reconnect the orphaned crates** (`fathom-emit`, `fathom-workspace`) once there's a server to consume them.
7. **Resolve the dependency ceiling** (currently unacknowledged for the coming npm tree) before it becomes an emergency the way the byte ceiling once did.

## Surprises and contradictions

- ~~**Test count disagreement**: 792 vs 904.~~ **RESOLVED 2026-09-11, same day.** `cargo test --workspace` was run directly: **792 passed, 0 failed, 0 ignored**. A grep of `#[test]` attributes gives 758. Neither measurement supports 904 — that figure was a survey error and is withdrawn. The run is authoritative.
- **ADR-0003 vs. everything since 2026-08-18**: confirmed by direct read, not hearsay — this is a real, unresolved contradiction, not a stale doc.
- **The 160-package dependency ceiling** is not even mentioned in the newest rebuild plan, despite the rebuild being the single largest dependency-adding event in the project's history.
- **The reference project's security philosophy is the opposite of Fathom's**: it actively scans networks and gives an MCP server write access; Fathom's whole premise is passive, human-pasted, redacted-at-the-gate data. Nothing from its scanning/MCP layer should be copied.
- **The owner personally overrode a security recommendation** on 2026-09-11 (today), taking "latest stable" for web packages instead of applying the crate cooldown gate to npm too.
- **The system-reminder copy of CLAUDE.md used to start this task is itself stale** relative to the actual repository, which now runs a short pointer page — a live demonstration of the exact problem this document exists to correct.