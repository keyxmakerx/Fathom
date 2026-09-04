# Shared conventions — binding on every document in this repo

Many documents in `docs/` are authored independently. These conventions are pinned so
they compose. **Do not redefine any of these.** If you believe one is wrong, do not
silently deviate — add a note under a `## Disagreements` heading at the end of your
document, stating the convention, your objection, and your proposed replacement.

## Terminology

| Term | Means | Never say |
|---|---|---|
| **workspace** | one encrypted document holding one user's/team's graph + suppressions + settings | "project", "database", "file" |
| **graph** | the typed IR — the single data structure the whole product projects from | "model" (ambiguous with ML model), "schema" (that's the type definition) |
| **node** / **edge** | graph elements | "object", "record", "entity" |
| **kind** | a node's type discriminant (`Device`, `IkeGateway`, …) | "type", "class" |
| **model** | an ML model, only | anything else — except that *threat model* may be abbreviated to "the model" inside `30-security/` only (`83` §9.1) |
| **rule** | one declarative finding definition | "check", "policy" (collides with security policy) |
| **rule pack** | a signed, versioned bundle of rules | "ruleset" |
| **finding** | one rule firing against one node | "issue", "error", "violation" |
| **suppression** | a recorded, reasoned waiver of a finding | "ignore", "mute" |
| **emitter** | graph → vendor config lines | "generator", "template" |
| **explainer** | corpus entry rendering a node/field/line at a depth | "docs", "help" |
| **corpus** | the authored YAML content — commands, explainers, rules | "content", "knowledge base" |
| **platform** | a vendor+family target (`junos-srx`, `panos`, `ios-xe`) | "vendor" (a vendor has many platforms) |
| **supervisor** / **subagent** | the AI layer's orchestrator and its workers | "agent" unqualified |
| **provenance** | how a value got into the graph, and when | "source" |
| **record** | a unit of encryption in the workspace container; holds many nodes and edges | never a graph element — that is a node or an edge |

**These terms bind filenames, directory names, type names, identifier prefixes and CLI flags,
not only prose** (`85` §15.1, ADR-0002).

## Precedence — who owns a settled question

> **Precedence.** Where two documents specify the same artifact, exactly one is the **owner** of
> that artifact and every other document references it rather than restating it. The owner is named
> in the artifact's own document header. A document that needs to change something it does not own
> raises a `## Disagreements` entry and **may not ship a second specification in the meantime.**

The register is `docs/00-vision/01-ownership.md` (ADR-0001).

## Currency — security is never answered from memory

Stated as law by the owner, 2026-08-08; ADR-0034 carries the reasoning.

**Never assert from recall, always look up, every time:** a known vulnerability, advisory or CVE;
whether a cryptographic primitive, parameter or construction is currently sound and whether
something better now exists; whether a library is maintained, audited, deprecated or superseded; a
vendor's current behaviour, syntax, defaults or lifecycle.

Three rules make a lookup count:

1. **Name the source and the date.** *"Checked, clean"* is worthless six weeks later. Record what
   was queried, against what, when, and what came back — including *"nothing found"*, which is a
   result and is written as one.
2. **Two independent sources for a negative.** A failed query and a clean result look identical from
   one database.
3. **"I could not establish this" outranks a confident guess**, always, and is never smoothed into
   something more assured.

The ranking is the owner's — *"for pretty much anything but security the most"*. Security claims are
checked without exception; other outside-world claims are checked when being wrong costs more than
looking. This does not apply to arithmetic or to a file already open.

**A dated lookup is a record, not a control** — it cannot notice it has gone stale. The control is
`78` §6's floor, which ADR-0034 §4 extends with a dependency-vulnerability scan, landing before the
first external crate does.

## The ingest gate only ever grows — ratified 2026-09-03

> **Nothing arriving after the build may reduce what the ingest gate destroys, only increase
> it. Union, never replace.**

Proposed by `38` §14 on 2026-08-17 and cited as unratified for seventeen days; **ratified by
ADR-0040 §5**. It applies to any dictionary, rule pack, corpus update, platform definition or
client build that reaches a running Fathom. On a shared server it is what stops a stale or
hostile client writing a credential into storage that everybody else's data sits next to.

**It is not satisfied by intent.** ADR-0040 §5 requires the check in CI: load the shipped
detector set, load the arriving one, and fail if the arriving set destroys less on any probe
the shipped set destroys. CLAUDE.md rule 0 governs every probe written for it — a safety gate
is tested against what a device accepts, never against what the detector needs.

## The residual-risk scale — exactly four values

`none | bounded | material | total`. Pinned by ADR-0002 and already adopted by `31`, `32`, `34`,
`36` and `37`. Not extended, not reordered, not renamed.

## Hard invariants — every document must be consistent with these

> **Standing note — read this before arguing from invariants 1, 2 or 4 (added 2026-08-28,
> revised 2026-09-03).**
> **INVARIANT 4 IS NOW AMENDED — by ADR-0040, and its own text below carries the scoping.** It
> is the first invariant in this file to be formally amended rather than merely re-read, and
> ADR-0040 §4 pays ADR-0002's precedent cost in the open. **Invariants 1 and 2 remain unamended
> and every other one still binds as written.** But the owner has changed what those two are
> understood to *scope*, and several documents in this corpus argue from the old reading. On 2026-08-18 he said, of invariant 1: *"this would be after we were full
> server solution, so it wouldn't be that main rule anymore, that main rule is only for demo mode
> like it is currently."* On 2026-08-18/21 he took the pivot decisions in
> `docs/40-stack/49-the-server-product.md` §1 — data on the server, live multi-user editing,
> multi-tenant — and accepted their consequence: **the single offline HTML file is dropped.** And
> invariant 2's *"permanent product boundary"* sentence is contradicted by his stated long-term
> intent, recorded in `48` §1 and `49` §16: monitoring, config pulls, and an SCP firmware
> distribution path.
>
> **Nothing in THIS NOTE amends anything** — invariant 4's amendment is in its own text below,
> under ADR-0040. Amending invariant 1 is still `03`'s and the owner's (`48` §1, open decision
> 1), and `48` deliberately declined to do it; ADR-0040 §9 item 3 deliberately does not touch
> it either. What this note exists to
> stop is a fresh session reading this file first — as CLAUDE.md rule 2 tells it to — and then
> reasoning from *"the product can never connect to anything, permanently"* as a settled premise
> when the owner has said it governs the client-only mode he calls the demo. **Two readings are
> live and only the owner closes the gap.** Where a document's conclusion depends on which reading
> is right, say so rather than picking; `38` §14 is the worked example, and its finding stands on
> its own merits for the client artifact regardless of how the invariant is finally scoped.

1. **No egress by default.** The application never opens a connection the user did not
   configure. Enforced by `default-src 'none'` with a per-directive allowlist —
   `connect-src`, `img-src`, `font-src`, `form-action` and `frame-src` all constrained —
   plus the `sandbox` directive where the delivery mechanism permits it. No telemetry, no
   analytics, no font CDN, no error reporting. **Top-level navigation is not covered by any
   CSP directive and is closed only by `sandbox`; where `sandbox` cannot be delivered, that
   channel is open and the artifact must not hold secrets.**
2. **The application never touches a network device.** No SSH, no NETCONF, no API. All
   output is copy-paste. This is a permanent product boundary, not a phase-1 limitation.
3. **The application stores no device credential.** No PSK, certificate private key, SNMP
   community, TACACS key or device password is ever written to a workspace, a sync blob, a
   git object or an export. Emitted configuration uses placeholders. A pasted capture may
   *contain* a credential; it is redacted at the ingest gate and the unredacted text never
   reaches the encryptor (`14` §9.9). The secrets the application does hold are enumerated
   in `32` §21.3 and `33` §18.3, and that enumeration is exhaustive: adding one requires
   amending this invariant.
   **Annotated 2026-09-03 (ADR-0041), scope only — the sentence above is not amended.** The
   redaction this invariant promises is the INGEST GATE's, and the gate has exactly one
   caller: `OP_PASTE`. It covers a pasted capture. It does not cover a value typed by hand
   into any of the schema's nineteen free-text `notes`/`description` fields — `OP_FIELD_SET`,
   `OP_EQUIP_ADD`, the cable and port label writes, and rack placement all parse raw text
   straight into a typed slot, ungated. That gap is real, is not closed by this note, and is
   proved through the shipped artifact by
   `docs/80-review/evidence/2026-09-03-the-gate-is-only-on-the-paste-box.mjs`. ADR-0041's
   answer is not to gate that door — a hand-typed value still saves and exports exactly as
   typed — but to MARK a value that looks like a credential wherever it is shown, via the one
   Rust detector `fathom_ingest::redact::looks_like_credential`, never a refusal.
4. **The server never holds secret key material — IN A ZERO-KNOWLEDGE DEPLOYMENT, WHICH THE
   HOSTED MULTI-TENANT SERVER IS NOT.** Amended and scoped by **ADR-0040 (2026-09-03)**, the
   written record `49` §3 decision 4 required before the server held its first byte. Where it
   binds — the client artifact, and any future customer-managed-key or browser-held-key
   deployment — it binds in full and unchanged: zero-knowledge; ciphertext, public keys and
   metadata only; no passphrase, no derived key, no root key, no unwrapped workspace key, and
   no key-derivation input beyond the public salts carried in the clear inside authenticated
   headers.
   **Where it does not bind — the hosted multi-tenant server — the server holds the keys and
   says so.** A data key per tenant and per design, wrapped by a master key, from the first
   stored byte, with the wrap point built so a customer-supplied master key can replace the
   house key later without re-encrypting data (ADR-0040 D1, D2). **The words
   *zero-knowledge*, *end-to-end*, and *we cannot read your data* may not be used about a
   customer until customer-managed keys are live for that customer** (ADR-0040 §6) — they are
   false under this scoping, and a false security sentence teaches a reader to discount the
   next one.
   **What does not change, and is the stronger claim anyway:** invariant 3 stands untouched.
   No device credential reaches storage in either deployment, because the ingest gate destroys
   it **in the browser, before upload** (ADR-0040 D5) and again on arrival — union, never
   replace (ADR-0040 §5). *Fathom never touches your devices, and it destroys every password
   before it stores anything. There is no credential to steal.* That sentence is true today,
   earned fully on Juniper, and materially weaker on platforms with no dictionary — which
   ADR-0040 D8 makes a CI gate on whether a platform is selectable at all.
5. **Findings are data, not code.** One rule engine. Rules carry `platforms` and
   `versions` predicates. No per-vendor engines.
6. **Emitters return `(line, provenance)` pairs, never strings.**
7. **Every node, edge and field carries a stable opaque ID.** Rules, explainers,
   emitters and diagram elements reference IDs, never paths or names. Renaming a device
   must not invalidate anything. The graph contains no natural-key references; the tier-1
   identity tuple's hash may be persisted as a **recovery** key by `12` §11.4 and by
   nothing else (ADR-0010).
8. **`acceptable_when` is mandatory on every rule.** A rule that can never be
   acceptable must say so explicitly; it may not omit the field.
9. **Determinism where it is observable.** Same workspace + same corpus version + same
   build ⇒ byte-identical emitted config, byte-identical findings, identical finder
   ranking. Anything non-deterministic is quarantined behind the AI layer's boundary and
   labelled as such in the UI.
   Determinism is a property of *emitted* artifacts — config, findings, finder ranking,
   exports. The AI session log and the egress log are quarantined records: inside the
   workspace, never inputs to an emitter, excluded from every determinism assertion
   (`81` §13.2).
   "Same workspace" means the same **converged** workspace state (`17` §21.1). The tuple is
   workspace + corpus version + **rule-pack version set** + build (`24` §11.1).
10. **The corpus is human-authored and reviewed.** No model output ships in the corpus
    without a named human reviewer recorded in the entry's `reviewed_by`.

## The risk enum — exactly three values, everywhere

```
ReadOnly       #1F6F4A on #EEF5F1   "READ-ONLY — SAFE ON PRODUCTION"
ChangesConfig  #A8571B on #FBF3EA   "CHANGES CONFIG — NEEDS A COMMIT"
Disruptive     #8C2F2F on #F8EFEF   "DISRUPTIVE — DROPS LIVE TRAFFIC"
```

Do not add a fourth. Do not reuse these colours for anything else (not for finding
severity, not for status, not for diff). Finding severity is a separate scale rendered
in neutrals with a weight/rule treatment — see the design docs.

**Amendment (ADR-0011 — risk is a property of effect).** The three values, their colours
and their ordering are unchanged. Two refinements: risk is assigned by *effect*, not by
command mode — `Disruptive` iff committing or running the statement can interrupt an
established flow, SA or adjacency on a device already carrying traffic. And the caption is
separable from the band: *"Exactly three bands. The caption is the default rendering of the
band and may be overridden per corpus entry where the default is untrue; the ink, wash and
ordering may not."* The override field is `risk_caption_override` (`61` §4.6). See
`docs/90-decisions/adr-0011-risk-is-a-property-of-effect.md`.

## Identifiers

- Node IDs: `<kind-lower>:<ulid>` — ULID for lexicographic sortability and
  monotonic-in-time generation without a coordinator. Opaque to users.
- Rule IDs: dotted, stable forever, namespaced by domain: `ipsec.pfs.absent`,
  `zone.host-inbound.ike-missing`, `mtu.mss-clamp.absent`.
- Command corpus IDs: `<platform>/<dotted-path>` — `junos-srx/ipsec.sa.show`.
- Explainer IDs: mirror the thing they explain — `explain:rule:ipsec.pfs.absent`,
  `explain:field:IkeGateway.external_interface`.
- Corpus and rule-pack versions: semver, with the *content* hash published alongside.

## Document conventions

- Every doc opens with a `> **Status:**` line: `Proposed`, `Accepted`, `Contested`, or
  `Reconstructed` (for sections rebuilt from a truncated source).
- Mark forks as **DECISION —** and opinions as **RECOMMENDATION —**, matching the
  owner's brief.
- State trade-offs honestly and in the owner's voice: name the thing you lose, do not
  bury it. See `.context/design-language.md` § *Voice*.
- Prefer tables over bullet lists for anything comparative.
- Code fences are labelled with a language. Rust for core types, YAML for corpus,
  TypeScript only for UI-boundary types.
- No marketing language anywhere. No "powerful", "seamless", "leverage", "robust",
  "cutting-edge", "revolutionise". No em-dash-free hedging either — be direct.
- Cite real standards precisely (RFC number + section). If you are not certain a
  citation is correct, write the claim without the citation rather than inventing one.
  **Never fabricate a reference, a benchmark number, or a vendor behaviour.** If a
  vendor detail is uncertain, mark it `<!-- VERIFY -->` inline.

## Length and depth

These are reference documents for an implementer, not summaries. Depth is the point.
A document that could be replaced by three bullet points has failed. Include concrete
type definitions, concrete algorithms, concrete failure modes, and worked examples
drawn from the SRX field card in `.context/field-card-srx-ipsec.txt`.
