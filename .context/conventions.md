# Shared conventions — binding on every document in this repo

Do not redefine these. If you think one is wrong, add a note under `## Disagreements` at the end of
your document (the convention, your objection, your proposed replacement); do not deviate silently.

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

These terms bind filenames, directory names, type names, identifier prefixes and CLI flags, not
only prose (`85` §15.1, ADR-0002).

## Precedence

Where two documents specify the same artifact, exactly one is the **owner**; every other document
references it and does not restate it. The owner is named in the artifact's own header. A document that
needs to change something it does not own raises a `## Disagreements` entry and **may not ship a
second specification in the meantime.** Register: `docs/00-vision/01-ownership.md` (ADR-0001).

## Currency — security is never answered from memory

Owner's law (reasoning in ADR-0034). **Never assert from recall; always look up, every time:** a
vulnerability, advisory or CVE; whether a cryptographic primitive, parameter or construction is
currently sound, or whether something better exists; whether a library is maintained, audited,
deprecated or superseded; a vendor's current behaviour, syntax, defaults or lifecycle.

A lookup counts only if:
1. **It names the source and the date**, and records what was queried, against what, when, and what
   came back, including "nothing found", written as a result. "Checked, clean" is worthless in six
   weeks.
2. **A negative has two independent sources.** A failed query and a clean result look identical from one
   database.
3. **"I could not establish this" outranks a confident guess**, and is never smoothed into something
   more assured.

Security claims are checked without exception. Other outside-world claims are checked when being wrong
costs more than looking. Arithmetic and a file already open need no lookup.

A dated lookup is a record, not a control: it cannot notice it has gone stale. The control is `78` §6's
floor, extended by ADR-0034 §4 with a dependency-vulnerability scan that lands before the first
external crate does.

## The ingest gate only ever grows (ADR-0040 §5)

> **Nothing arriving after the build may reduce what the ingest gate destroys, only increase it.
> Union, never replace.**

This covers any dictionary, rule pack, corpus update, platform definition or client build that reaches
a running Fathom; it stops a stale or hostile client writing a credential into storage shared with
everybody else's data. Intent does not satisfy it: CI must load the shipped detector set and the
arriving one, and fail if the arriving set destroys less on any probe the shipped set destroys. Every
probe follows CLAUDE.md's rule on safety gates: test against what a real device accepts, never against
what the detector needs.

## The residual-risk scale — exactly four values

`none | bounded | material | total`. Pinned by ADR-0002 and adopted by `31`, `32`, `34`, `36` and
`37`. Not extended, not reordered, not renamed.

## Hard invariants — every document must be consistent with these

> **Standing note on invariants 1, 2 and 4. Read before arguing from them.**
> ADR-0040 amends invariant 4, and its own text below carries the scoping. Invariants 1 and 2 are
> unamended and every other invariant binds as written. But the owner has changed what 1 and 2 are
> understood to scope, and several documents argue from the old reading:
> - Invariant 1 applies "only for demo mode like it is currently" (owner, 2026-08-18), not to the full
>   server solution. He took the server pivot (`docs/40-stack/49-the-server-product.md` §1: data on the
>   server, live multi-user editing, multi-tenant) and dropped the single offline HTML file.
> - Invariant 2's "permanent product boundary" is contradicted by his stated long-term intent
>   (`48` §1, `49` §16): monitoring, config pulls, an SCP firmware distribution path.
>
> This note amends nothing. Amending invariant 1 is `03`'s and the owner's (`48` §1, open decision 1);
> ADR-0040 §9 item 3 does not touch it. Do not reason from "the product can never connect to anything,
> permanently" as a settled premise. **Two readings are live and only the owner closes the gap.** Where
> a conclusion depends on which is right, say so rather than pick; `38` §14 is the worked example.

1. **No egress by default.** The application never opens a connection the user did not
   configure. Enforced by `default-src 'none'` with a per-directive allowlist (`connect-src`,
   `img-src`, `font-src`, `form-action` and `frame-src` all constrained), plus the `sandbox`
   directive where the delivery mechanism permits it. No telemetry, analytics, font CDN or error
   reporting. **Top-level navigation is covered by no CSP directive and is closed only by
   `sandbox`. Where `sandbox` cannot be delivered, that channel is open and the artifact must not
   hold secrets.**
2. **The application never touches a network device.** No SSH, no NETCONF, no API. All output is
   copy-paste. This is a permanent product boundary, not a phase-1 limitation.
3. **The application stores no device credential IN THE DESIGN, and never stores one silently.**
   Scoped by ADR-0042 (read it before relying on this paragraph); it formerly read "The application
   stores no device credential". Fathom now keeps a credential vault, by owner decision. What binds: a
   secret is never written into the design graph (which holds a reference only), and never stored
   without being shown to the operator and chosen. The vault's default mode encrypts under a key the
   server does not hold. The ingest gate still runs; it now offers what it finds instead of destroying
   it.

   Original text, describing the gate: **The application stores no device credential.** No PSK,
   certificate private key, SNMP community, TACACS key or device password is ever written to a
   workspace, a sync blob, a git object or an export. Emitted configuration uses placeholders. A pasted
   capture may *contain* a credential; it is redacted at the ingest gate and the unredacted text never
   reaches the encryptor (`14` §9.9). The secrets the application does hold are enumerated in `32`
   §21.3 and `33` §18.3; that list is exhaustive and adding one requires amending this invariant.

   Scope annotation (ADR-0041; the sentence above is not amended): the gate has one caller, `OP_PASTE`,
   so it covers a pasted capture only. It does not cover a value typed by hand into any of the schema's
   nineteen free-text `notes`/`description` fields (`OP_FIELD_SET`, `OP_EQUIP_ADD`, cable and port label
   writes and rack placement parse raw text into a typed slot, ungated). That gap is real and open,
   proved by `docs/80-review/evidence/2026-09-03-the-gate-is-only-on-the-paste-box.mjs`. ADR-0041 does
   not gate that door (a hand-typed value still saves and exports as typed). It MARKS a value that looks
   like a credential wherever it is shown, via the one Rust detector
   `fathom_ingest::redact::looks_like_credential`, and never refuses.
4. **The server never holds secret key material — IN A ZERO-KNOWLEDGE DEPLOYMENT, WHICH THE HOSTED
   MULTI-TENANT SERVER IS NOT.** Amended and scoped by ADR-0040, the written record `49` §3
   decision 4 required before the server held its first byte.
   - Where it binds (the client artifact, and any future customer-managed-key or browser-held-key
     deployment) it binds in full: ciphertext, public keys and metadata only; no passphrase, no
     derived key, no root key, no unwrapped workspace key, and no key-derivation input beyond the
     public salts carried in the clear inside authenticated headers.
   - Where it does not bind (the hosted multi-tenant server) the server holds the keys and says so.
     There is a data key per tenant and per design, wrapped by a master key, from the first stored
     byte. The wrap point is built so a customer-supplied master key can replace the house key later
     without re-encrypting data (ADR-0040 D1, D2).
   - **The words *zero-knowledge*, *end-to-end*, and *we cannot read your data* may not be used
     about a customer until customer-managed keys are live for that customer** (ADR-0040 §6). They
     are false under this scoping, and a false security sentence teaches a reader to discount the
     next one.
   - Invariant 3 is untouched and is the stronger claim. No device credential reaches storage in
     either deployment: the ingest gate destroys it in the browser before upload (ADR-0040 D5) and
     again on arrival (union, never replace; ADR-0040 §5). *Fathom never touches your devices, and
     it destroys every password before it stores anything. There is no credential to steal.* That
     is true today, earned fully on Juniper, and materially weaker on platforms with no dictionary.
     ADR-0040 D8 makes a CI gate on whether a platform is selectable at all.
5. **Findings are data, not code.** One rule engine. Rules carry `platforms` and `versions`
   predicates. No per-vendor engines.
6. **Emitters return `(line, provenance)` pairs, never strings.**
7. **Every node, edge and field carries a stable opaque ID.** Rules, explainers, emitters and
   diagram elements reference IDs, never paths or names. Renaming a device must not invalidate
   anything. The graph contains no natural-key references. The tier-1 identity tuple's hash may be
   persisted as a **recovery** key by `12` §11.4 and by nothing else (ADR-0010).
8. **`acceptable_when` is mandatory on every rule.** A rule that can never be acceptable must say so
   explicitly; it may not omit the field.
9. **Determinism where it is observable.** Same converged workspace state (`17` §21.1) + same corpus
   version + same rule-pack version set + same build (`24` §11.1) ⇒ byte-identical emitted config,
   byte-identical findings, identical finder ranking. Determinism covers *emitted* artifacts:
   config, findings, finder ranking, exports. Anything non-deterministic is quarantined behind the
   AI layer's boundary and labelled as such in the UI. The AI session log and the egress log are
   quarantined records: inside the workspace, never inputs to an emitter, excluded from every
   determinism assertion (`81` §13.2).
10. **The corpus is human-authored and reviewed.** No model output ships in the corpus without a
    named human reviewer recorded in the entry's `reviewed_by`.
11. **A migration that reads an existing table must handle forced row-level security, and say so.**
    A migration runs with no tenant context, so a `SELECT` against a table behind
    `FORCE ROW LEVEL SECURITY` returns **zero rows, silently**: a backfill that reports success and
    copies nothing. On an empty database, where migrations get tested, the bug is invisible, so it
    surfaces on the first deployment with data. Wrap such a read in `NO FORCE` / `FORCE`, and
    comment that the pair is load-bearing so nobody tidies it away.

## The risk enum — exactly three values, everywhere

```
ReadOnly       #1F6F4A on #EEF5F1   "READ-ONLY — SAFE ON PRODUCTION"
ChangesConfig  #A8571B on #FBF3EA   "CHANGES CONFIG — NEEDS A COMMIT"
Disruptive     #8C2F2F on #F8EFEF   "DISRUPTIVE — DROPS LIVE TRAFFIC"
```

Do not add a fourth. Do not reuse these colours for anything else (not finding severity, status or
diff). Finding severity is a separate scale, rendered in neutrals with a weight/rule treatment; see
the design docs.

**Amendment (ADR-0011, `docs/90-decisions/adr-0011-risk-is-a-property-of-effect.md`).** The values,
colours and ordering are unchanged. Risk is assigned by *effect*, not command mode: `Disruptive` iff
committing or running the statement can interrupt an established flow, SA or adjacency on a device
already carrying traffic. The caption is separable from the band: it is the default rendering and
may be overridden per corpus entry where the default is untrue; the ink, wash and ordering may not.
The override field is `risk_caption_override` (`61` §4.6).

## Identifiers

- Node IDs: `<kind-lower>:<ulid>`. ULIDs sort lexicographically and generate monotonically in time
  without a coordinator. Opaque to users.
- Rule IDs: dotted, stable forever, namespaced by domain: `ipsec.pfs.absent`,
  `zone.host-inbound.ike-missing`, `mtu.mss-clamp.absent`.
- Command corpus IDs: `<platform>/<dotted-path>`, e.g. `junos-srx/ipsec.sa.show`.
- Explainer IDs mirror the thing they explain: `explain:rule:ipsec.pfs.absent`,
  `explain:field:IkeGateway.external_interface`.
- Corpus and rule-pack versions: semver, with the *content* hash published alongside.

## Document conventions

- Every doc opens with a `> **Status:**` line: `Proposed`, `Accepted`, `Contested`, or
  `Reconstructed` (sections rebuilt from a truncated source).
- Mark forks **DECISION —** and opinions **RECOMMENDATION —**.
- State trade-offs honestly, in the owner's voice: name the thing you lose. See
  `.context/design-language.md` § *Voice*.
- Prefer tables over bullet lists for anything comparative.
- Label code fences with a language. Rust for core types, YAML for corpus, TypeScript only for
  UI-boundary types.
- No marketing language: no "powerful", "seamless", "leverage", "robust", "cutting-edge",
  "revolutionise". No hedging either; be direct.
- Cite real standards precisely (RFC number + section). If unsure a citation is correct, write the
  claim without it. **Never fabricate a reference, a benchmark number, or a vendor behaviour.** Mark
  an uncertain vendor detail `<!-- VERIFY -->` inline.

## Code comments

- Plain and short: what the code does or why, in a line or two. No paragraphs.
- No session history, brief items or "this task". Name the ADR or doc when the reason lives there.
- When you edit code under a long comment, cut the comment down.

## Length and depth

Reference documents for an implementer, not summaries. A document that could be replaced by three
bullet points has failed. Include concrete type definitions, algorithms, failure modes, and worked
examples drawn from the SRX field card in `.context/field-card-srx-ipsec.txt`.
