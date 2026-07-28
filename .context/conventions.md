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
| **model** | an ML model, only | anything else |
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

## Hard invariants — every document must be consistent with these

1. **No egress by default.** The application never opens a connection the user did not
   configure. `connect-src` is `'none'` in the offline build and exactly one origin in
   the sync build. No telemetry, no analytics, no font CDN, no error reporting.
2. **The application never touches a network device.** No SSH, no NETCONF, no API. All
   output is copy-paste. This is a permanent product boundary, not a phase-1 limitation.
3. **The application never accepts a credential.** No PSKs, no certificates with private
   keys, no SNMP communities, no TACACS keys, no device passwords. Emitted config uses
   placeholders. The one exception is the workspace passphrase, which never leaves the
   client and is never transmitted in any form.
4. **The server never holds a key.** Zero-knowledge. Ciphertext and metadata only.
5. **Findings are data, not code.** One rule engine. Rules carry `platforms` and
   `versions` predicates. No per-vendor engines.
6. **Emitters return `(line, provenance)` pairs, never strings.**
7. **Every node, edge and field carries a stable opaque ID.** Rules, explainers,
   emitters and diagram elements reference IDs, never paths or names. Renaming a device
   must not invalidate anything.
8. **`acceptable_when` is mandatory on every rule.** A rule that can never be
   acceptable must say so explicitly; it may not omit the field.
9. **Determinism where it is observable.** Same workspace + same corpus version + same
   build ⇒ byte-identical emitted config, byte-identical findings, identical finder
   ranking. Anything non-deterministic is quarantined behind the AI layer's boundary and
   labelled as such in the UI.
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

## Identifiers

- Node IDs: `fathom:<kind-lower>:<ulid>` — ULID for lexicographic sortability and
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
