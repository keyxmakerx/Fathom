# ADR-0044 — Engines are signed data packs: loaded by the operator, hosted anywhere, never code

**Status:** Accepted, 2026-09-12
**Owner direction**, stated twice: 2026-08-28, *"proxmox would probably need to be an engine"* (the
sentence behind ADR-0037 §5's open question), and 2026-09-12, *"the engines are separate, or they
should be — basically plugins that can be hosted via git. People should be able to pull from repos,
download/upload directly."*
**Amends:** OPEN-QUESTIONS B10, E1–E4, D1, D8, A3, C1 — each entry records the consequence.

---

## 1. What an engine is

**An engine is everything Fathom knows about one vendor or platform, as data.** One pack:

| Part | What it holds | Exists today |
|---|---|---|
| `engine.yaml` | vendor, platforms, pinned release per family, version, author, signature | no — new |
| `dict/` | the statement dictionary: **parser and redaction in one table** | yes — `corpus/dict/<platform>/` |
| `catalogue/` | equipment: model → ports, positions, numbering, U-height, PSU inlets | no — the format is a Phase 3 dependency |
| `commands/` `concepts/` `explainers/` `rules/` | the teaching corpus | yes — `corpus/` |
| `LICENSE` | the pack's own licence | yes — `corpus/LICENSE`, CC BY-SA 4.0 |

**This is not a new idea imposed on the code; it is what the code already is.** `crates/fathom-ingest/
src/dict.rs` opens with *"The statement dictionary — corpus data, not code"* and reads it from files.
The lexer and binder are generic and dictionary-driven; a new vendor is a new dictionary, not new
Rust. The corpus already carries a separate licence from the code, so the licence boundary already
matches the engine boundary. This record names the boundary and adds four rules to it.

## 2. The four rules

### Rule 1 — Data only. Never code.

An engine contains no executable content: no WebAssembly, no scripts, no expressions evaluated at
load. It is parsed by the same deliberate YAML subset the schema uses (`parse_profile` under
`Profile::Corpus`), which *"is not a general YAML implementation and must never become one."*

This is the whole of the security argument and it is not negotiable. Loading code from a repository
someone else controls is the supply-chain attack this project's dependency posture exists to
prevent — the August 2026 registry attack was exactly that shape. If a vendor needs logic the data
format cannot express, that logic is a contribution to the core, argued through the dependency gate
like everything else. **The dependency ceiling (A3) is therefore untouched by any number of engines.**

### Rule 2 — An engine cannot weaken the redaction gate.

The dictionary is what makes a keyword redactable. So an engine with a thin dictionary is an engine
whose platform leaks — and this is not hypothetical: the register's own correction notes that **nine
of ten** declared platforms carry no secret labels at all, and OPNsense's declares none.

Two fences, one existing and one new:

- **The core floor stays in Rust.** `redact.rs`'s `DetectorSet` — shape-based detection of masked
  values and the like — is engine-independent and applies to every paste regardless of which engines
  are installed. No engine can lower it.
- **A platform whose dictionary carries no secret labels is *redaction-unproven*, and the paste
  sheet refuses configs for it.** Not a warning — a refusal, with the sentence *"this platform's
  engine declares no secrets; a config cannot be accepted until it does."* This turns the silent
  weakness the register found into a loud one. Hand-entered inventory for that platform is unaffected.

The browser-side gate (the WASM build) receives the enabled engines' dictionaries from the server, so
what it redacts depends on what the operator installed. That is a consequence to state, not a flaw.

### Rule 3 — Signed by its author; reviewed per item.

Every engine carries an author signature over the pack. **Unsigned engines load and are shown as
unvouched.** Signature is authorship, not review: each teaching item carries its own `reviewed_by`
(invariant 10), and until a named person is in it the item shows with an ***unreviewed*** label that
clears per item, never per pack. The owner answered on 2026-09-12: the 330 Juniper items ship exactly
this way.

The signature primitive is the one already settled for the admin model — ES256, `p256` — so this
adds no crate. Verification happens at install and at every load.

### Rule 4 — Installed by an operator, recorded in the sealed chain, pinned per design.

Only an operator installs, enables, disables or removes an engine — it is a machine-side act, so it
belongs to the operator custody of ADR-0044's sibling, the admin design. Every such act is a sealed
chain entry naming the engine, its version and its signature fingerprint.

**A design records the engine versions it was drawn against.** Installing a newer engine never
silently changes what an existing design means; it is offered, per design, as an upgrade with a
diff. This is C4's provenance principle applied to knowledge rather than to facts.

## 3. Where engines live, and how they arrive

**In the database**, as a signed bundle, because the container's filesystem is read-only. One table
plus the chain entries above. **On the wire, an engine is one file** — the whole pack serialised into
a single bundle — so that arriving needs no archive decoder and no new crate.

Three ways in, matching ADR-0043's provider shapes so operators learn one pattern:

- **Upload** — the operator hands the bundle to the admin page. This is the v1 path.
- **`command://`** — an operator script produces the bundle; this is how *git* works without Fathom
  carrying git: `git pull && fathom-engine bundle` in a cron job, and the server never dials out.
- **Fetch from a URL** — deferred until the server has an HTTP client justified for some other
  reason. The admin page may fetch a raw bundle URL browser-side where the source permits it.

**Out is symmetric:** an installed engine exports byte-identical, signature intact, so it can be
shared onward. Repositories on any forge — GitHub, Forgejo, GitLab, a bare git server — are the
human-facing source of truth; the bundle is what moves.

**The Juniper engine is the first published engine**, and it ships pre-installed in the image as a
first-run convenience — byte-identical to the published bundle, signed the same way, upgradeable the
same way. Separation is a property of the format, not of whether the image is empty.

## 4. What this changes in decisions already recorded

- **B10 (who funds the content)** — mitigated. The owner funds the Juniper engine and not every
  vendor's; engines are contributable by anyone who has the equipment.
- **E1 (which vendors next)** — becomes *which engines exist*. Owner's kit first.
- **E2 (vouching)** — becomes per-item `reviewed_by` inside a signed pack. Answered.
- **E3 (Calix/Nokia)** — Calix has no engine and needs none: hand-entered inventory. Nokia 7210 SAS
  gets a public-documentation survey; **a platform row still waits for a real config**, and so does
  its engine.
- **E4 (read/write in one file)** — one file per command, inside the engine.
- **D1 (hosts)** — Proxmox is an engine, as the owner said on 2026-08-28. ADR-0037 §5's route
  becomes: a host is a kind whose engine declares no config platform.
- **D8 (naming)** — a naming template is optional, per organisation, and may ship inside an engine
  or be organisation-local. Groundwork only, per the owner.
- **A3 (the crate ceiling)** — unaffected by engines, by Rule 1.
- **C1 (egress list)** — engines add nothing to it in v1; `command://` sources are the operator's
  script's business, not the server's.
- **`schema/platforms.yaml`** — its rule stands and becomes the engine's rule: *a vendor is
  registered when someone names it; a platform is declared only when a real config has been seen.*
  An engine that declares a platform must carry the capture it was written against.

## 5. What it costs

- **Phase 3 dependency:** the catalogue format, and a Juniper catalogue for the models on the
  approved boards, because the rack view draws ports from it. This is the one part that cannot wait.
- **Phase 5:** the engine table, the bundle format, the admin page (install / enable / disable /
  export), the chain entries, the loader change from `corpus/dict` on disk to bundles in the
  database, and the WASM gate receiving dictionaries from the server.
- **Phase 6:** the corpus loader reading from installed engines; the unreviewed label; the
  redaction-unproven refusal on the paste sheet.
- **Nothing in the dependency closure.** Rule 1 is what makes that true.

## 6. What this does not do

It does not make Fathom safe to install an engine from a stranger. An engine is data the gate trusts
to *name* secrets; a malicious dictionary that omits them is caught only by the core floor and the
redaction-unproven refusal, which catches *absence*, not *deliberate omission of one keyword*. Rule 3
is the answer: know who signed it. The operator's register must say so in those words.
