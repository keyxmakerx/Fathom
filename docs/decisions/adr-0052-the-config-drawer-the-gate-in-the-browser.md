# ADR-0052 — The config drawer: the gate in the browser, a capture on the device

**Status:** accepted 2026-09-18 on the owner's "continue" over the Session 6(c) plan.
**Binds with:** ADR-0010 (re-identification is a proposal to a human), ADR-0041 (a typed
credential is marked, never refused), ADR-0042 (the vault), ADR-0049 (the payload is the plain face).

## Context

The redaction gate lives in `crates/fathom-ingest` and runs only inside `crates/fathom-wasm`, a
module with a raw three-function ABI that no browser loads today. The server stores only the
design payload and has no ingest dependency, so CLAUDE.md rule 4 holds only if the gate runs in
the browser before anything reaches the document. The interface page wants a drawer under the
faceplate with a gutter per line: built graph, kept as text, destroyed at the gate.

## Decision

1. **The module ships as a file, never a package.** A script builds `fathom-wasm` for wasm32 and
   copies the artefact under the client's public directory, ignored by git, with its digest; the
   existing artefact gate asserts the shipped bytes match the source build. The browser fetches it
   and instantiates it with no imports; a small TypeScript client speaks the raw ABI and decodes
   the module's own face format. Face and error codes are generated from Rust, never typed twice.
2. **A line's fate travels on the wire.** Two faces join the paste reply: one per line with its
   outcome (built, kept, noise, quarantined) and the display id of what it built; one per destroyed
   value with the span and the label. No original length ever travels; the black block is fixed
   width and says what it was: "psk · destroyed at the gate".
3. **The capture is a node on the device.** Schema 0.9 adds `Capture`, owned by `Device`, holding
   the redacted text, the platform and the line count; its id is the weld's capture id, so every
   field's parsed origin resolves to it with no join. "Kept as text" is this text. On reopen the
   gutter is derived from provenance spans and redaction markers, never stored twice.
4. **The module mirrors the document.** Two doors load the plain face into the module and export
   it back, so the weld is never reimplemented in JavaScript and every save carries what the gate
   let through. A third door pastes under a placed device: the person choosing this faceplate is
   the human answer ADR-0010 asks for, and the config's fields land on that device as
   supersessions.
5. **Scope of 6(c).** The drawer with all three marks and attach-to-device; the inside stop for a
   Junos SRX from the existing inside door; view-only for a reader gated in the client and
   proven at the server. Not this session: a Proxmox host, which has no dictionary and no guest or
   bridge kinds yet; unreachable-policy hatching; the assistant panel.

**Amended the same day, from the checker.** A second paste into a device that already carries a
live capture duplicated every node the first one built. Until "replace a capture" exists, which
tombstones everything whose origin is that capture and then pastes, the door refuses a second
paste and says so. Automatic reconciliation stays forbidden (ADR-0010).

## Consequences

The board that drew an SNMP community as kept-as-text is wrong and the gate is right; the board
changes. A pasted credential is proven absent from the save payload by a driven browser run that
captures the request body, and from the page. Large pastes are capped in the drawer and say so.
