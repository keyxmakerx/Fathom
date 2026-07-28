# 43 — One codebase, four deployments

> **Status:** Proposed

Companion to `34-browser-hardening.md`, which owns the browser platform and already made the
artifact-fork decision this document extends; to `33-sync-protocol.md`, which owns the wire
protocol the two server modes serve; to `35-supply-chain-and-builds.md`, which owns what a release
consists of and how it is verified; and to `17-workspace-format.md`, which owns the bytes on disk.
This document owns the **shapes the product ships in**: what each artifact is, how it is installed,
what it costs to run, what it can and cannot do, and what changes about the threat model when you
move between them.

**The governing rule of this document, stated once, in caps, at the top:**

> **THE DEPLOYMENT MODE IS THE THREAT MODEL. EVERY OTHER DIFFERENCE BETWEEN THESE FOUR IS
> CONVENIENCE; THIS ONE IS NOT.**

The card that generated this project's design language states one governing rule per side and then
spends the side earning it. The rule above is earned in §3.14, §5.9, §6.14 and §7.10, and the short
version is: **in the offline artifact, an attacker who owns the delivery channel owns one file the
user can hash. In the served modes, an attacker who owns the server owns the client, on every
reload, silently.** Everything else — image size, replica count, backup cadence — is downstream of
that sentence.

---

## 0. Contents

| § | Section | |
|---|---|---|
| 1 | One codebase — what actually differs, and what is forbidden to | *read this first* |
| 2 | The four modes, side by side | *the comparison table* |
| 3 | D1 — the offline single file | **DECISION**, and the numbers |
| 4 | D1's threat-model delta, stated as a subtraction | |
| 5 | D2 — Docker single node | *the smallest credible image* |
| 6 | D3 — the enterprise cluster | *including the observability problem* |
| 7 | D4 — the CLI, and `fathom serve` | *the exit-code contract* |
| 8 | Migration between modes | *or these are four products* |
| 9 | Operational runbooks for D2 and D3 | *deploy, upgrade, rotate, restore, compromise* |
| 10 | What this costs, added up | |
| 11 | Open decisions | |
| 12 | Sources | |
| 13 | Proposed amendments to other documents | |
| 14 | Disagreements | |

---

## 1. One codebase — what actually differs, and what is forbidden to

*margin tab: read this first*

### 1.1 The naming collision, resolved before anything else

Two sibling documents already lettered the deployment shapes and they do not agree with the owner's
brief, which names three. This document pins a fourth naming and maps all of them, once, here.

| This document | `34` §2.1 | Brief §1 | Artifact (`35` §2.1) | One sentence |
|---|---|---|---|---|
| **D1** | mode A | "a single offline file" | A1 `fathom-<ver>.html` | One HTML file, opened from disk, no origin, no server, no network |
| **D2** | mode C | "a Docker single-node" | A5 image | One container on one host, sync for a team, TLS terminated in-process |
| **D3** | mode D | "a load-balanced enterprise cluster" | A5 image, many replicas | Stateless app tier, HA index store, object store, customer IdP |
| **D4** | mode E | *(not in the brief)* | A4 native binary | The CLI. Also the thing that produces `34`'s mode B via `fathom serve` |

`34`'s **mode B** — the offline bundle served from loopback — is not a fifth deployment. It is a
subcommand of D4 that produces a browser client with real response headers. It is specified in §7.8
rather than in its own section, because operationally it is "run the CLI", and the CLI is the
install unit.

**RECOMMENDATION — the letters `D1`–`D4` are pinned here and `34`'s `A`–`E` should be retired in
favour of them** at the next edit of that document, because a reader who has both open cannot tell
"mode B" (a served bundle) from "D2" (Docker) without a table. §13 carries the amendment.

### 1.2 What "one codebase" means concretely

```text
                       ┌──────────────────────────────────────────────┐
                       │  fathom-core   (Rust, no_std-friendly, pure)  │
                       │  graph · schema · rules · emitters · parsers  │
                       │  envelope · KDF · AEAD · CBOR · finder index  │
                       │  NO I/O.  NO clock.  NO randomness source.    │
                       └───────┬──────────────────────────┬───────────┘
                               │                          │
                  ┌────────────▼───────────┐  ┌───────────▼────────────┐
                  │ fathom-host-wasm       │  │ fathom-host-native     │
                  │ wasm-bindgen glue      │  │ std fs, std time,      │
                  │ 12 imports, allowlisted│  │ getrandom, rayon       │
                  └────────────┬───────────┘  └───────────┬────────────┘
                               │                          │
        ┌──────────────────────┼──────────┐               ├──────────────┐
        ▼                      ▼          ▼               ▼              ▼
   ┌─────────┐          ┌───────────┐ ┌────────┐   ┌───────────┐  ┌────────────┐
   │  D1     │          │ served UI │ │  D4    │   │  D4       │  │ fathom-sync│
   │ single  │          │ (D2/D3    │ │ serve  │   │ CLI       │  │ (Axum)     │
   │ file    │          │  + serve) │ │        │   │           │  │ D2/D3      │
   └─────────┘          └───────────┘ └────────┘   └───────────┘  └────────────┘
        └──────────── one TypeScript UI, one DOM renderer ────────┘
```

`fathom-core` performs no I/O, reads no clock and generates no randomness. Everything ambient is
passed in. That is not architectural fashion; it is what makes invariant 9 (determinism) testable
and what lets the identical rule evaluation run in a browser tab, in a CI job and in a container
without three code paths that drift.

### 1.3 The five things allowed to differ between modes

Anything not on this list must be identical, and CI enforces the list by building all four and
diffing the core's exported surface.

| # | May differ | Mechanism | Why it has to |
|---|---|---|---|
| 1 | **Transport** | `trait FrameTransport` — `None`, `Loopback`, `HttpSync`, `Git`, `File` | D1 has no network; D3 has one origin |
| 2 | **Storage backing** | `trait WorkspaceStore` — `InMemory`, `FileHandle`, `Directory`, `Opfs` | D1 has no filesystem; D4 has one |
| 3 | **Policy delivery** | `<meta>` vs response headers | D1 has no response (§3.7) |
| 4 | **AI tier ceiling** | build-time feature flag, not a setting | `21` §7.5: an origin set a settings screen can change is not a claim about the artifact |
| 5 | **Which platforms' corpora ship** | build-time corpus selection (`15` D2) | Size, in D1 only |

### 1.4 The seven things forbidden to differ — the anti-fork list

| # | Must be identical everywhere | The failure if it is not |
|---|---|---|
| F1 | **Emitted configuration, byte for byte** | The same graph emits a different `set security ipsec policy` line in CI than in the browser. Now the tool has two opinions and neither can be quoted in a change ticket |
| F2 | **Findings, and their order** | A `high` finding that fires in D4 and not in D1 means the offline user ships the weakness. Invariant 9 |
| F3 | **Finder ranking** | The wedge feature stops being diffable between releases (`16` §9.5) |
| F4 | **The envelope, the KDF parameters, the record layout** | A workspace written in D2 that D1 cannot open is four products |
| F5 | **The rule engine and the `platforms`/`versions` predicates** | Invariant 5 |
| F6 | **Provenance on every emitted line** | Invariant 6. A "lightweight CLI emitter that just returns strings" is the exact retrofit the brief §5.3 warns about |
| F7 | **The three-value `Risk` enum and its rendering** | `ReadOnly` in the browser and `read-only` in the CLI is two vocabularies for the paper card's one legend |

**The test that enforces F1 and F2**, and it is the single most valuable test in the repository:

```text
tests/cross-host/
  fixtures/<n>/workspace.fathom          packed, sealed, committed
  fixtures/<n>/expected.emit.txt         every emit unit, concatenated, LF
  fixtures/<n>/expected.findings.json    canonical JSON, sorted by (rule_id, node_id)
  fixtures/<n>/expected.finder.json      the golden query set's top-3 (16 §9.6)

  runner: for host in [native, wasm-node, wasm-browser-headless]:
            assert blake3(emit(fixture))     == blake3(expected.emit.txt)
            assert blake3(findings(fixture)) == blake3(expected.findings.json)
```

Three hosts, one expectation file, byte comparison. If the WASM build and the native build disagree
about `perfect-forward-secrecy keys group14`, this fails on the commit that caused it rather than in
a customer's change window.

### 1.5 Where "one codebase" is a lie, and it should be said

Three places. Naming them is cheaper than being caught by a reviewer who finds them.

| Place | The honest statement |
|---|---|
| **The sync service** | `fathom-sync` is server-only code that never runs in D1 or D4. It links `fathom-core` only for the envelope's *header* parsing (it must read `format_version` to reject a garbage frame) and for nothing else. It is a second program in the same repository, not a shared runtime |
| **Float and integer width** | WASM is 32-bit. Native is 64-bit. Any `usize` that reaches a serialised value is a divergence waiting to happen. The core uses explicit widths (`u32`, `u64`) in every persisted structure, and a lint bans `usize` in any type deriving the serialisation traits |
| **Concurrency** | The native build can use `rayon` for the rule sweep; WASM cannot (`34` §7.4 — no threads, no `SharedArrayBuffer`). Rule evaluation is therefore written as a pure fold whose parallel and serial forms are asserted equal in CI. **Findings order is defined by the sort, never by completion order** |

---

## 2. The four modes, side by side

*margin tab: the whole document in one table*

> **NOTHING IN THIS TABLE IS A DEFAULT YOU CAN CHANGE AT RUNTIME. EVERY ROW IS FIXED AT BUILD OR AT
> INSTALL.**

### 2.1 The comparison table

| | **D1 offline single file** | **D2 Docker single node** | **D3 enterprise cluster** | **D4 CLI** |
|---|---|---|---|---|
| **Artifact** | `fathom-<ver>.html`, one file | `ghcr.io/…/fathom-sync@sha256:…` | same image, N replicas | `fathom-<ver>-<triple>`, one static binary |
| **Install** | copy the file. Open it | `docker compose up -d`, one file, two volumes | Helm/Kustomize onto an existing cluster | copy the binary onto `PATH` |
| **Origin** | opaque (`file://`) | one `https://` origin | one `https://` origin | none |
| **Runtime footprint** | one browser tab: ≈14 MB idle, ≈55 MB at 50 devices, +64–256 MB transiently at unlock (§3.9) | 1 vCPU, 512 MiB, ≈30 GB disk at 25 users (§5.6) | 3+ replicas × (0.25 vCPU, 256 MiB) + HA Postgres + object store (§6.11) | ≈10 MB RSS idle; ≈550 MB at 500 devices (`17` §13.2) |
| **Sync** | no | yes | yes | yes |
| **Multi-user** | no | yes, ≤32 members/workspace | yes | yes |
| **Git transport** | no (no filesystem) | yes, client-side | yes, client-side | yes |
| **AI tier ceiling** (`21` §7) | **0** | 0, 1, 2 | 0, 1, 2, 3 | 0, 2b |
| **`connect-src`** | `'none'` | `'self'` | `'self'` (+ one inference origin at tiers 1/3) | *n/a* |
| **`sandbox`, COOP/COEP/CORP, `frame-ancestors`, `Permissions-Policy`, reporting** | **none of them** (`34` §2.8) | all | all | *n/a* |
| **Workspace storage** | the user's chosen file only. **Nothing in browser storage** | file on disk + OPFS cache at the served origin | same, plus sealed frames on the server | directory or packed file on the filesystem |
| **Server holds** | — | ciphertext + metadata | ciphertext + metadata | — |
| **Update path** | a human downloads a new file (`35` §8.2) | operator pulls a new digest, restarts | rolling restart (§9.2) | package manager or a new binary |
| **Backup** | the workspace directory; git; `fathom pack` | volume snapshot, ordered (§5.7) | object-store versioning + Postgres PITR (§6.13) | the workspace directory; git |
| **Restore verified by** | the user opening it | **a client with a key** — never the operator (§5.7) | same (§6.13) | the user opening it |
| **Time to patch** | unbounded, unmeasurable | operator's cadence | operator's cadence | operator's cadence |
| **Telemetry** | none, structurally | none | none | none |
| **Who can serve you altered code** | whoever gave you the file, **once** | the operator, **on every reload** | the operator, **on every reload** | whoever gave you the binary, once |
| **Verifiable by a stranger** | one file, one hash, one `<script>` pinned by its own SHA-256 | asset digests vs the published manifest | same | one binary, one hash |

### 2.2 The one row that matters

The last three rows are the deployment-mode threat delta compressed into a table. **Everything else
in this document is elaboration.** D1 pays for its lack of policy headers with a delivery model where
substitution is a one-time event that leaves a hash a human can compare. D2 and D3 buy real headers,
sync and a team — and pay with a party who can change what every user runs, continuously, without
anyone downloading anything.

`31` §5.1 row 2's residual already says the operator can serve altered assets. This document's
contribution is to say that **the choice of deployment mode is the choice of whether that residual
exists at all**, and that it should therefore be presented to a customer as a decision rather than
as a footnote.

---

## 3. D1 — the offline single file

*margin tab: the purest claim*

> **AN ARTIFACT THAT CANNOT STATE A POLICY MUST NOT HOLD SOMETHING WORTH STEALING AT REST — BUT A
> SESSION IS NOT AT REST.**

### 3.1 The question this section has to answer

The owner's brief §1 commits to "a single offline file". `34` §3.3 then decided, correctly and for
good reasons, that the single file holds **no workspace, no passphrase entry, no envelope code and
no ciphertext** — reference content only. `34` §3.4 lists four costs of that decision and says of
the second one, verbatim: *"This is the strongest argument against the decision and it is not
answered by anything below."*

That unanswered cost is a deployment question, so it lands here. The cost, restated:

> An air-gapped or high-assurance site is exactly where an HTML file passes change control and an
> executable does not. That site is, per brief §2.4, the market SaaS competitors structurally cannot
> serve. `34` §3.3's decision removes the product's core capability from precisely the segment it is
> most differentiated for.

So: is D1 genuinely one HTML file with inlined WASM, a small directory, or a signed desktop bundle?
Numbers first, decision at §3.5.

### 3.2 The size budget, itemised

**These are engineering estimates over the corpus sizes the sibling documents already computed, not
measurements. Nothing is built.** Every line says where it comes from.

| Component | Raw | In the file | Basis |
|---|---|---|---|
| `fathom_core.wasm`, `opt-level="z"`, `lto="fat"`, stripped, `wasm-opt -Oz` | **2.0–3.0 MB** | **2.7–4.0 MB** base64 | Estimate. Parsers, graph, rule engine, emitters, canonical CBOR, zstd decode, ChaCha20-Poly1305, Argon2id, BLAKE3, HKDF, X25519, Ed25519 <!-- VERIFY: build the core and measure. This is the single largest number in the budget and it is the one most likely to be wrong. --> |
| Finder index (`finder.idx`) | 1.0 MB | **1.4 MB** base64 | `16` §9.4, which states the 4/3 cost and the 1.4 MB figure directly |
| Explainer corpus, zstd-19, one platform | 320 KB (v1) / 1.3 MB (v2) | **427 KB** / **1.8 MB** base64 | `15` §15.2, which gives both the compressed and base64 figures |
| First-party rule pack, compiled | ~150 KB | ~200 KB base64 | Estimate over `63-rulepack-spec.md`'s entry shape |
| Command corpus bodies (`TEXT`) | 89 KB | 119 KB base64 | `16` §9.4 |
| UI JavaScript, hand-written, no framework, minified | ~250 KB | 250 KB inline text | Estimate. Zero runtime npm dependencies (`34` §8.2) |
| CSS | ~40 KB | 40 KB inline text | Estimate |
| Fonts: Liberation Sans ×3 + DejaVu Sans Mono ×2, WOFF2, subset | ~150 KB | **200 KB** base64 | `34` §8.4 decided subset-and-inline. 5 faces at 25–40 KB |
| Diagram/legend SVG, inline | ~20 KB | 20 KB | |
| **Total, v1 corpus, one platform** | | **≈ 5.4–6.7 MB** | |
| **Total, v2 corpus, all platforms** | | **≈ 8–10 MB** | |

**A discrepancy worth naming rather than smoothing over.** `35` §13.2's worked `fathom verify`
output prints `SIZE 28,114,552 bytes`, and `16` §9.4 assumes "a target single file in the tens of
megabytes". This budget lands at a third of that. Either those figures are illustrative, or the
intended corpus is several times larger than `15` §15.2 costs it at. <!-- VERIFY: reconcile the
single-file size figure across 16 §9.4, 35 §13.2 and this section. One of them is wrong and the
number appears in published material. -->

**Nothing here approaches a platform limit.** The relevant hard caps are the JavaScript engine's
maximum string length — approximately 2²⁹−24 characters in V8, 2³⁰−2 in SpiderMonkey, 2³¹−1 in
JavaScriptCore — which is between 512 MB and 2 GB. A 10 MB inline script is two orders of magnitude
below the tightest of them.

### 3.3 The load-time budget, and the cost that never amortises

The stages, in order, for a ~7 MB file:

| Stage | Estimate | Note |
|---|---|---|
| Read 7 MB from local disk | 10–50 ms | Page cache after the first open |
| HTML parse, of which ~5.5 MB is one `<script>` body | 50–150 ms | The tokeniser still walks every byte |
| SHA-256 over the inline script for the CSP hash check (`34` §2.5) | single-digit to low-tens of ms | Hardware-accelerated on every current desktop CPU |
| base64 → `Uint8Array` for WASM, index, corpus, fonts (~4.5 MB in, ~3.4 MB out) | 30–100 ms | `Uint8Array.fromBase64()` where available; a hand-rolled `atob` loop otherwise <!-- VERIFY: availability of Uint8Array.fromBase64 across the support matrix, and measure the fallback. --> |
| `WebAssembly.compile` of a ~3 MB module | **~150 ms** | Published cross-implementation figures put lowest-tier code generation at roughly 50 ns per WebAssembly code byte — about 20 MB/s on one core. That figure dates from 2020 and is a *code-section* rate, not a whole-module rate <!-- VERIFY: measure compile time for our actual module on the support matrix; the 50 ns/byte figure is old and engine-dependent. --> |
| Instantiate, build the finder's resident structures, first paint | 50–120 ms | `16` §9.4's structures are already in their on-disk form |
| **Cold open, total** | **≈ 300–500 ms** | |

**Three properties of that number are what actually matter, and only one of them is the number.**

1. **No streaming compilation.** `WebAssembly.instantiateStreaming` takes a `Response`, and `fetch`
   against a `file://` URL is refused — browsers treat local files as opaque origins and the fetch
   fails as a CORS error. D1 therefore buffers the whole module and calls `WebAssembly.compile` on
   an `ArrayBuffer`. Compilation cannot overlap with download because there is no download.
2. **No code cache.** Engine-level caching of compiled WebAssembly is keyed to a resource identity
   under an origin. D1 has no origin. **Every open pays the full compile cost, forever.**
   <!-- VERIFY: confirm per-engine that no compiled-module cache applies under file://. If one does,
   this paragraph changes and D1 gets materially faster on second open. -->
3. **A served build pays this once.** The D2/D3 client uses `instantiateStreaming` with an
   `integrity` option (`34` §7.1) and gets engine caching; its warm open is a small fraction of the
   cold one.

So the honest comparison is not "300 ms versus 300 ms". It is **"300–500 ms every single time,
versus 300–500 ms once and then very little"**. For an artifact whose wedge feature is a thing
people open ten times a day (brief §6.1), that is the real cost of the single file — and it is a
cost in patience, not in bytes.

### 3.4 The three candidate shapes, re-evaluated

`34` §3.2 evaluated these against an artifact that holds a workspace at rest. The evaluation below
adds the column that section did not have: **what if the artifact holds a workspace only in memory,
and reads and writes it as a file the user chooses?**

| | **(a) one HTML file** | **(b) small directory + local server** | **(c) signed desktop bundle** |
|---|---|---|---|
| Install friction | none | run one binary | install per OS |
| Passes air-gap change control | **yes, routinely** | binary — sometimes | executable + installer — rarely |
| Full CSP, COOP/COEP/CORP, `sandbox`, reporting | no | yes | yes |
| Browser storage | **not used at all** (§3.8) | OPFS cache | real filesystem |
| Save in place, no download dialog | Chromium only | Chromium only | everywhere |
| Extension exposure | full | full | **none** |
| Supply chain | one artifact, one hash | that plus the CLI we already ship | 3 OS artifacts, notarisation, an updater |
| Verifiable by a stranger | **trivially** | read the file and the server's source | hardest |
| Secret **at rest** in the artifact's own storage | **none** | ciphertext in OPFS | ciphertext on disk |
| Secret **in the session's memory** | the graph, the keys | same | same |

The row `34` §3.3's rule turns on is *"secret at rest in the artifact's own storage"*. The rule is
*"we do not put a secret behind a policy we cannot deliver."* Shape (a) with no browser storage puts
**nothing** at rest behind that policy. What it puts behind the policy is a *session* — and the
session in shape (b) is behind the same policy minus `sandbox`, `frame-ancestors` and reporting.

So the delta between (a) and (b), for a running session, is exactly three things:

| Lost in (a) | What it means, precisely |
|---|---|
| `sandbox` without `allow-top-navigation` / `allow-popups` | After a successful XSS, an attacker in our origin can exfiltrate by navigating or opening a window. `34` §2.11 channels 1 and 2. **This is a post-compromise channel; it is not an attack** |
| `frame-ancestors 'none'` / `X-Frame-Options` | Clickjacking, by another local document. An `https://` page cannot frame a `file://` document |
| Violation reporting | Nobody, including the user, learns that a policy fired |
| *(and, contingently)* `blob:` workers | `34` §3.1 records worker construction under `file://` as unverified. §3.9 handles the fallback |

### 3.5 DECISION — D1 holds a workspace in memory, reads and writes it as a file, and stores nothing in the browser

**PROPOSED CHANGE to `34` §3.3.** That section splits the offline story into a reference-only single
file and a served bundle. This document proposes a narrower split, on a line drawn at *storage*
rather than at *capability*:

> **`fathom-<ver>.html` is a complete product for one session. It opens a packed workspace from a
> file the user selects, holds the graph in memory, runs every engine, emits configuration with
> provenance, raises findings, draws the diagram, produces the verify ladder and the rollback, and
> writes a sealed workspace back out as a file. It uses no browser storage of any kind — no OPFS,
> no IndexedDB, no Cache API, no `localStorage`, no cookies, no service worker. When the tab closes,
> the origin holds nothing, because the origin never held anything.**

Concretely, versus `34` §3.3's table:

| | `34` §3.3 as written | **Proposed** |
|---|---|---|
| `fathom-<ver>.html` | Finder, corpus, explainers, rule prose, guidebook. No workspace, no passphrase, no envelope code | **All of that, plus: passphrase entry, the envelope, walkthroughs, paste-and-explain, the graph, emitters, findings, suppressions, diagram, runbook, export.** No sync, no browser storage, no AI above tier 0 |
| `fathom-<ver>-offline.tar.zst` + `fathom serve` | Everything | Unchanged. Adds persistence-without-ceremony, workers, git, the OPFS cache, and the full header set |

**The three arguments for the change, in the order they actually matter:**

1. **It answers the cost `34` §3.4 concedes is unanswered.** The air-gapped engineer on a jump host
   gets the product, not a lookup table.
2. **`34`'s own rule is satisfied, not bent.** The rule governs secrets *at rest behind an
   undeliverable policy*. With storage removed there is no such secret. The workspace at rest is a
   file on the user's disk, sealed by Argon2id + ChaCha20-Poly1305 (`32`), and its protection has
   never come from a CSP.
3. **It removes an eviction class rather than accepting one.** `34` §4.2 spends a section on the
   browser silently deleting the OPFS cache. D1 cannot be evicted from, because it stores nothing.
   The failure mode "the browser ate my work" does not exist here; the failure mode "I closed the
   tab without saving" does, and §3.12 F3 handles it with the one control that works.

**The three costs, stated:**

1. **No crash recovery.** A tab discard mid-edit loses everything since the last save. In D2 the
   OPFS cache is exactly the mitigation for that, and D1 gives it up. This is the largest cost and
   §3.12 is where it is priced.
2. **Post-XSS exfiltration is easier in D1 than in D2.** Two extra channels, `34` §2.11 rows 1 and
   2. Against an attacker who already has execution in the origin, everything is already lost
   (`31` §6.2) — but "already lost" is not the same as "as easily lost", and pretending otherwise is
   the register the conventions ban.
3. **Save is bad outside Chromium.** §3.8.

**What does not change:** `34` §3.7's phishing control stays, reworded, because the attack it
defends against gets *more* attractive once the real artifact does ask for a passphrase:

```text
  FATHOM · OFFLINE                                      no server · no storage · one session

  THIS BUILD SENDS NOTHING AND STORES NOTHING. IT ASKS FOR YOUR PASSPHRASE ONLY WHEN YOU OPEN A
  WORKSPACE FILE YOU CHOSE. IF IT ASKS BEFORE THAT, IT IS NOT THIS BUILD.
```

**RECOMMENDATION — reject the signed desktop bundle for now, on `34` §3.5's reasoning, unchanged.**
Three OS-specific signed artifacts, two notarisation paths and an update channel is a supply chain
larger than the product, for a project whose whole security argument is that one reproducible build
can be checked by a stranger. `34` §3.5's revisit triggers stand: measurable loss of user work
through the save path, or a customer requirement of "no browser extensions in the same process as
our configurations".

### 3.6 What D1 does and does not carry

| Carried | Not carried | Why not |
|---|---|---|
| Command finder + corpus (one platform by default; `15` D2) | All platforms' corpora | Size. `--all-platforms` build variant exists and costs ~1.4 MB more |
| Explainers at all three depths | — | |
| Walkthroughs, emitters, provenance, findings, suppressions | — | |
| Diagram, and SVG export | — | |
| `diff` / verify ladder / rollback (`18`) | — | |
| Envelope: open and seal a packed workspace | The **directory** form of a workspace | No filesystem. `17` §2.1's packed form is the only shape D1 speaks |
| Rule pack install, from a file the user selects | Rule pack install that persists | No storage. Re-select each session |
| Advisory bundle (`.fadv`) load, from a file | Persistence of it | Same |
| Plaintext export, gated (`17` §15.3) | — | |
| AI tier 0 | Tiers 1, 2a, 2b, 3 | §3.13 |
| — | Sync, members, git, captures beyond the session | |

**On tier 2a.** `21` §7.0's table marks the single-file build as "2a yes". This document takes the
narrower line the owner's assignment states: **D1 is tier 0 only.** The reason is not policy, it is
arithmetic — a WebGPU model needs its weights loaded from a file the user selects (`21` §7.2a), and
with no browser storage those multi-gigabyte weights would be re-selected and re-uploaded to the GPU
on every open. Technically possible; practically nobody will do it twice. §13 carries the amendment.

### 3.7 The CSP and the headers

Unchanged from `34` §2.2's mode A, with one addition and one note.

```html
<meta http-equiv="Content-Security-Policy" content="
  default-src 'none';
  script-src 'sha256-REPLACED_AT_BUILD' 'wasm-unsafe-eval';
  style-src 'sha256-REPLACED_AT_BUILD';
  img-src data:;
  font-src data:;
  connect-src 'none';
  worker-src blob:;
  child-src 'none';
  frame-src 'none';
  form-action 'none';
  base-uri 'none';
  object-src 'none';
  media-src 'none';
  manifest-src 'none';
  require-trusted-types-for 'script';
  trusted-types fathom-dom fathom-worker;
">
<meta name="referrer" content="no-referrer">
```

`worker-src blob:` is now load-bearing rather than speculative, because D1 parses. §3.9 specifies
what happens when blob workers turn out to be unavailable.

Discarded by `<meta>` parsing and therefore absent: `frame-ancestors`, `sandbox`, `report-to`. Not
available at all, because there is no response: COOP, COEP, CORP, `X-Content-Type-Options`,
`X-Frame-Options`, `Integrity-Policy`, `Permissions-Policy`, `Strict-Transport-Security`,
`Cache-Control`, `Clear-Site-Data`. Eleven controls, and `34` §2.10's count of "ten of eleven
unavailable in mode A" is unchanged by this document's decision — which is the point: **the
decision changes what the artifact holds, not what the platform grants.**

### 3.8 Storage — none, and what that does to Save

| Store | D1 uses it? |
|---|---|
| OPFS, IndexedDB, Cache API, `localStorage`, `sessionStorage`, cookies, service worker | **No. None. Not for settings, not for the depth toggle, not for panel widths** |
| A file the user chose | Yes, and only through an explicit gesture |

Enforced by the same canary scan `34` §10 H19–H20 already specify, run against the D1 build with a
full session exercised: after open, unlock, parse, emit, export and lock, the origin's storage must
be empty. Not "contains no plaintext" — **empty**.

**Saving, honestly.** Two paths, and the difference between them is the worst usability fact in D1:

| Path | Where | Behaviour |
|---|---|---|
| File System Access (`showSaveFilePicker`, retained handle) | Chromium-family | The user picks the file once; subsequent saves overwrite in place. Good |
| The download fallback | everywhere else | **Every save produces a new file in the downloads directory.** `site-b.fathom`, `site-b (1).fathom`, `site-b (2).fathom`. The user is now the version control system, and `32` §13.1 already calls this outcome "genuinely poor" |

<!-- VERIFY: current File System Access availability (showSaveFilePicker, retained FileSystemFileHandle, permission re-grant on reload) per browser, and specifically whether any of it functions under file://. If retained handles do not survive under an opaque origin, the Chromium row above collapses into the fallback row and D1's save story is uniformly poor. -->

**The control that makes the fallback survivable** is not a feature, it is a refusal: D1 shows the
unsaved-change count in the masthead at all times, in the margin-tab register, and the `beforeunload`
handler is armed from the first edit.

```text
  FATHOM · OFFLINE                          14 unsaved changes · last saved 11:04 · one session
```

Not a badge. Not a toast. A fact, in the same place, always.

### 3.9 Two platform problems D1 has and D2 does not

**Problem 1 — the Argon2 arena, with no worker to terminate.**

`32` §4.5 puts the keys in a crypto worker for a specific reason: `WebAssembly.Memory` grows and
never shrinks, so a 256 MiB Argon2id arena permanently raises the tab's footprint unless the whole
instance goes away, and terminating the worker is the only way to reclaim it deterministically. If
blob workers are unavailable under `file://`, D1 has no worker to terminate.

**The resolution:** D1 instantiates a **second, separate `WebAssembly.Instance` with its own
`Memory`** for the KDF, derives the KEK, transfers it, and drops every reference to that instance.
Its linear memory then becomes garbage-collectable.

| | Worker (D2) | Second instance (D1) |
|---|---|---|
| Reclaim is | deterministic — `terminate()` returns and the memory is gone | **best-effort — it happens when the GC decides** |
| Keys enter the main thread's JS heap | no | **yes**, as a transferred `ArrayBuffer` |
| Peak footprint | +64–256 MB, released at once | +64–256 MB, released eventually |

Both costs are real and neither is avoidable. **RECOMMENDATION — D1 floors Argon2id `m` at 64 MiB
rather than the 256 MiB ceiling `32` §4.2 allows**, and says so in the limits panel, because a
device that cannot spare 256 MiB in a tab that cannot deterministically release it is a device where
unlock fails in a way the user reads as "wrong passphrase" (`34` §7.5). Cost, stated plainly: a
64 MiB arena is a weaker offline-guess posture than a 256 MiB one, by exactly the factor `32` §4.6's
model gives.

**Problem 2 — no worker means no parse deadline.**

`34` §7.3 is precise that the parse worker's real value is that `worker.terminate()` is synchronous
and unconditional, and that **you cannot interrupt a running WASM loop on the main thread**. If D1
has no worker, a pathological capture freezes the tab with no way back except closing it — and
closing it, in a build with no crash-recovery cache, loses the session.

| Control | Available in D1 without a worker? |
|---|---|
| Input caps — 64 MiB paste, 2×10⁶ lines, 64 KiB longest line, depth 64, 100:1 decompression ratio (`34` §7.4) | **Yes.** Enforced in the core, before a byte reaches a parser, which is why `34` §7.4 requires them enforced twice |
| A fuel counter in the parser — a decrementing budget checked at every loop head, tripping a named error | **Yes**, and D1 is the reason it must exist rather than being a nicety |
| Wall-clock deadline enforced by an external watchdog | **No** |
| Memory cap per parse via a separate instance's declared `maximum` | Yes, at the cost of a second instantiation per parse |

**DECISION — the parser carries an explicit fuel budget in the core, checked at every loop head and
every allocation site, defaulting to a value calibrated so that the largest fixture in the corpus
uses under 25 % of it.** This is a real tax on the parser's inner loop and it exists so that the
one deployment that cannot be rescued from the outside can rescue itself. Measure it; if the tax
exceeds a few percent, move the check to block heads rather than loop heads and accept coarser
granularity.

### 3.10 The update path, and a workspace across versions

**The update path is a human.** `35` §8.2 states it without softening and it is not re-litigated:
there is no channel, there will not be one, and some installs will run a build with a known defect
for years.

What D1 does about it:

| Does | Does not |
|---|---|
| Shows its own build date and age, in the margin-tab register: `build 2026-07-14 · 128 days old` | Say "update available". It cannot know |
| Loads a `.fadv` advisory bundle from a file the user selects, and then says `advisories 2026-11-02 · 3 known-bad versions · this build: not listed` | Retain it. Next session, re-select |
| Says `advisory bundle: none loaded` when none is | Say "no known issues" |

**A workspace across versions.** This is the question people actually get bitten by, and the answer
is already fully determined by `17` §8 — it just needs stating in a deployment context.

Every record's file header carries `format_version` and `schema_version` **in the clear**, ahead of
the ciphertext, precisely so that a build can decide it cannot read a workspace *before* spending
Argon2id on the passphrase (`17` §2.2). The matrix:

| Situation | What happens | What the user sees |
|---|---|---|
| Old D1 opens a workspace written by a newer build, **same schema major** | Opens. Unknown fields in sealed bodies are preserved verbatim and round-tripped, never dropped | Nothing. This is the common case and it must be silent |
| Old D1 opens a workspace written by a newer build, **newer schema major** | **Refused, before the KDF runs** | `this workspace was written by fathom 3.4 (schema 4). This build is 3.1 (schema 3). Get a newer build; nothing has been changed.` |
| New D1 opens an older workspace | Opens, migrates in memory, and **does not write the migration back until the user saves** | One line: `migrating schema 3 → 4 on save. Keep a copy of the old file until you are happy.` |
| Either, with a corrupted or truncated file | Named error with the byte offset, never "wrong passphrase" | `17` §16.1 |

**The rule that makes all four rows safe: a version refusal must never be indistinguishable from a
wrong passphrase.** They are the two failure modes a user will confuse, one is recoverable and one
is not, and confusing them is how somebody concludes their workspace is lost and deletes it. This
is the same discipline as the field card's insistence that `IKE-ID validation failed` is *"easily
misread as a wrong pre-shared key — check identity before you re-type the PSK."* Same failure shape,
same fix: name the thing that actually happened.

### 3.11 Backup and restore

There is no server, so backup is the file, and the tool's contribution is to make that easy to get
right rather than to invent a mechanism.

| Operation | Procedure |
|---|---|
| **Backup** | Copy `site-b.fathom` somewhere else. It is one sealed file. No quiescing, no lock, no export step — `17` §16.3's atomic write means a copy taken at any moment is either the old file or the new one, never a torn one |
| **Versioned backup** | Keep the numbered files the download fallback produces (§3.8). Ugly, and it is a real backup regime |
| **Restore** | Open the copy |
| **Verify a backup** | Open it, and check the workspace summary line against what you expect. There is no other way, and there cannot be: verification requires the key |
| **Off-machine** | The packed workspace is one sealed file with no plaintext but its filename. It can go on a USB stick, an internal share or a mail server with no additional control. `17` §2.2 lists exactly what a holder learns without the key: nothing but the size and the format version |

**The one trap.** Restoring an older copy over a newer one, in a workspace that has ever synced,
trips the rollback detector (`32` §8.2, `33` F1) — because from the client's point of view a
deliberate restore and an attacker replaying an old state are the same event. The override needs a
typed confirmation naming both versions and dates. **That is correct behaviour and it is also the
flow an attacker most wants a user to be practised at.** D1 does not sync, so a pure-D1 user never
meets it; a user who came from D2 (§8) does, and the migration procedure must say so in advance.

### 3.12 Failure modes

| # | Failure | Symptom | Handling | Residual |
|---|---|---|---|---|
| **F1** | Browser has no `Uint8Array.fromBase64` and the fallback decode is slow | Cold open takes seconds | Chunked decode with a progress line; never a spinner | `none` |
| **F2** | `blob:` worker construction refused under `file://` | Parsing runs on the main thread | §3.9 problem 2: fuel budget + input caps. The UI says `parsing on the main thread — this tab will not respond for up to N s` | `bounded` — an unresponsive tab is possible and the honest fix is D2 |
| **F3** | Tab discarded or closed with unsaved work | Work since the last save is gone | The permanent unsaved-change count (§3.8) and an armed `beforeunload`. **There is no recovery cache and there will not be one** | `material` — the accepted cost of §3.5 |
| **F4** | `memory.grow` fails on a large workspace | Unlock or open fails | `34` §7.5: a named error — `this workspace needs 256 MiB and this device would not give it` — never "wrong passphrase", never "file corrupt" | `bounded` |
| **F5** | Argon2 arena not reclaimed by the GC before the next unlock | Tab footprint climbs across lock/unlock cycles | §3.9's 64 MiB floor bounds it; the limits panel shows the current footprint | `bounded` |
| **F6** | User opens the file over `http://` from a share instead of `file://` | Now a real origin, real headers absent, storage available — a build that assumed it had none | **The build detects a non-`file:` protocol and refuses to unlock**, with: `this artifact is built for offline use from disk. You are serving it. Use the served bundle instead.` | `none`, once the check exists |
| **F7** | Two copies of the same workspace edited in two tabs | Second save overwrites the first | Neither tab can see the other with no storage. The workspace id + generation in the header lets an open detect that the file changed underneath, and the save path refuses with a diff summary | `material` — one-writer-at-a-time is D1's actual concurrency model and the product must say so |
| **F8** | A tampered `fathom.html` | It does not execute — the CSP hash fails and the console shows the violation | `34` §2.5. **This is D1's one genuine security advantage over the served build** | `bounded` — an attacker replacing the file rewrites the policy too, which is why the published hash matters |

F6 deserves a note. It is not a hypothetical: a network engineer who finds `fathom.html` on a share
will sooner or later put it behind a web server so colleagues can reach it, at which point they have
a build with `connect-src 'none'` and no other headers, running under a real origin, silently
different from both supported modes. Refusing is the only honest option, and the message has to name
the alternative.

### 3.13 What D1 loses, precisely and completely

The owner's assignment asks whether D1 is still a complete product. **It is, for one session, for
one person, on one machine.** Here is the exhaustive subtraction.

| # | Lost | Consequence | Recoverable by |
|---|---|---|---|
| 1 | Sync, members, sharing, the sync-side conflict UI | One person, one machine | D2/D3 |
| 2 | Git transport and the merge driver | No history, no review, no blame on the workspace | D2/D4 |
| 3 | Crash-recovery cache | §3.12 F3 | D2 |
| 4 | Save in place, outside Chromium | §3.8 | D2 (same limit) / D4 (no limit) |
| 5 | `sandbox`, `frame-ancestors`, COOP/COEP/CORP, `Permissions-Policy`, `Integrity-Policy`, `X-Content-Type-Options`, HSTS, `Cache-Control`, `Clear-Site-Data`, violation reporting | §3.7, `34` §2.8 and §2.10 | D2 |
| 6 | Deterministic reclamation of the Argon2 arena | §3.9 | D2 |
| 7 | An externally enforced parse deadline | §3.9 | D2 |
| 8 | Streaming WASM compilation and engine code caching | §3.3 — a fixed cost on every open | D2 |
| 9 | AI tiers 1, 2a, 2b, 3 | §3.6 | D2 (1, 2), D3 (3) |
| 10 | Any update signal at all | `35` §8.2 — unbounded time to patch | any other mode |
| 11 | Persistent rule pack and advisory installs | Re-select per session | D2/D4 |
| 12 | All-platform corpora by default | Cross-vendor Rosetta lookups limited to the built platform | a build variant, or D2 |
| 13 | Multi-writer anything, including two tabs | §3.12 F7 | D2/D3 |

**What it keeps, and this is the list that matters:** one graph, six views. Finder. Walkthroughs.
Paste and reverse-explain. Emitters with provenance. Findings with `acceptable_when`. Suppressions
with reasons. Diagram. Verify ladder and rollback. Export with the plaintext gate. Every invariant.
Byte-identical output to every other mode (§1.4 F1, F2).

A network engineer in a SCIF with a laptop, one HTML file and a USB stick can build a validated
site-to-site IPsec tunnel on an SRX, get the six-object chain in the right order, get the five
plumbing pieces with `host-inbound-traffic system-services ike` present because a rule fires when it
is missing, get the bring-up ladder, get the rollback, and paste it into a change ticket. **That is
the product.** What they cannot do is come back to it tomorrow without having saved a file, or share
it with a colleague without handing them the file.

### 3.14 Threat-model delta versus every other mode

| Threat | D1 | vs D2/D3 | vs D4 |
|---|---|---|---|
| **Server compromise** | **not applicable — there is no server** | D2/D3: server holds ciphertext + metadata (`31` §5.1 rows 1–3) | same as D1 |
| **Operator serves altered client code** | **not applicable** | **D2/D3: live, on every reload, silent** (`31` §5.1 row 2). *The single largest delta in this table* | not applicable |
| **Metadata to a third party** (`31` §7, M1–M10) | **none. Zero channels** | D2/D3: workspace existence, size, change times, per-record activity map (M8, `33` §12.2), member public keys, source addresses | none |
| **Malicious artifact substitution** | One event, one file, one publishable hash. The CSP hash means a tampered file **does not execute** (`34` §2.5) | Asset-level; the served document can be modified independently of assets, and `Integrity-Policy` support is uneven | One binary, one hash, and the OS's own signing where present |
| **Compromised browser / malicious extension** | full compromise (`31` §6.2) | identical | **not applicable — no browser** |
| **Post-XSS automated exfiltration** | **worse**: navigation and `window.open` remain open (`34` §2.11 rows 1–2) | closed by `sandbox` | not applicable |
| **Clickjacking** | no control; practically limited to another local document | `frame-ancestors 'none'` + XFO | not applicable |
| **Lost/stolen endpoint** | identical everywhere: a sealed workspace on a disk | identical | identical |
| **Storage eviction / silent data loss by the browser** | **not applicable — nothing stored** | D2/D3: real, and `34` §4.2 is the mitigation | not applicable |
| **Unbounded time to patch** | **worst** — unbounded and unmeasurable | operator-controlled | operator-controlled |
| **Denial of service by the operator** | **not applicable** | real and unaddressable (`33` §10.5) | not applicable |
| **Coercion of the operator** (`31` §6.6) | **not applicable** | the operator can be compelled to hand over ciphertext and metadata, and to serve altered code | not applicable |

**Read the "not applicable" column as the product's argument.** Eight rows disappear in D1. Two get
worse. That is the trade, and it is the trade a customer should be shown at the point they choose a
deployment mode — not in a security whitepaper they read after choosing.

---

## 4. The bridge — why D2 exists at all, given §3

If D1 removes eight threat rows, why ship anything else?

| Reason | Detail |
|---|---|
| **Two people** | The moment a second engineer must see the same estate, D1's answer is "email the file", which is whole-file overwrite and last-writer-wins (`33` §11.2). That is adequate for one disciplined person and terrible for two |
| **Persistence without ceremony** | §3.12 F3 is a real, repeated, small loss of work. The OPFS cache in D2 is exactly the fix |
| **The policy headers** | §3.13 row 5 |
| **AI above tier 0** | §3.6 |
| **A patch path** | `35` §8.2 |

The honest framing is not "D2 is better". It is **"D2 trades eight threat rows for a team"**, and a
team of one should not make that trade.

---

## 5. D2 — Docker single node

*margin tab: the smallest credible image*

> **ONE BINARY, ONE IMAGE, ONE COMPOSE FILE, TWO VOLUMES. EVERY COMPONENT YOU ADD IS A COMPONENT
> THE CUSTOMER'S SECURITY TEAM HAS TO REVIEW.**

### 5.1 What the node is

One container running `fathom-sync`, which does three things and no others:

1. Serves the static browser bundle (A2), embedded in the binary, with the mode-C headers.
2. Serves the nine sync operations of `33` §2.1.
3. Terminates TLS.

There is no database container, no reverse proxy container, no cache container, no worker container.

**DECISION — the static assets are embedded in the binary, not mounted from a volume.**

| | Embedded | Mounted |
|---|---|---|
| Tampering with the served client requires | replacing the binary | writing one file into a volume |
| Image size | +≈12 MB | +0 |
| Updating the corpus without updating the code | not possible — new image | possible |
| Asset digests attributable to a signed release | **yes, transitively through the binary's digest** | no |

Take the embedded form. The threat that matters in D2 is exactly "someone changes what the client
runs" (§2.2), and a mounted asset directory is a writable path that does it without touching a
signed artifact. Cost, stated: a corpus-only update is a full image release. Given `35` §7.5 already
publishes one manifest per release, that is a cost in release cadence and not in mechanism.

### 5.2 The image

**Base — `gcr.io/distroless/static-debian12:nonroot`, pinned by digest.** Reported at roughly
1.9 MB uncompressed. It contains `ca-certificates`, timezone data, an `/etc/passwd` with a `nonroot`
(65532) entry, and `/tmp`. No shell, no package manager, no libc beyond what a static binary needs.

**Why not `scratch`**, which would be smaller:

| `scratch` lacks | We need it because |
|---|---|
| `ca-certificates` | **OIDC.** The enterprise auth path (`33` §3.3) fetches the IdP's JWKS over TLS. That is the *only* outbound connection `fathom-sync` ever makes, and it is the only reason a CA bundle is in the image |
| `/etc/passwd` entry | `USER 65532:65532` works numerically, but tooling that resolves the uid reports an error, and Kubernetes `runAsNonRoot` checks are cleaner against a real entry |
| `/tmp` | Upload bodies stream to a temp file rather than being buffered in memory (§5.6). A `tmpfs` mount supplies it, but then the image cannot run without one |
| timezone data | Logs are UTC and timestamps are RFC 3339 — genuinely not needed. Listed for completeness |

**RECOMMENDATION — publish a `scratch`-based variant for the OPAQUE-only deployment**, which makes
no outbound connection at all, and let the NetworkPolicy in D3 (§6.10) prove it. An image with no
CA bundle cannot silently start trusting a WebPKI chain, and for an air-gapped customer that is a
claim worth having.

**Size, itemised:**

| Layer | Size | Basis |
|---|---|---|
| `distroless/static-debian12:nonroot` | ≈1.9 MB | Published figure |
| `fathom-sync`, static musl, stripped, LTO | **12–18 MB** | Estimate: tokio, hyper, axum, rustls + ring/aws-lc, rusqlite (bundled SQLite), an OPAQUE implementation, blake3, ed25519-dalek, ciborium <!-- VERIFY: build it and measure. --> |
| Embedded A2 assets, pre-compressed brotli variants alongside identity | **10–14 MB** | §3.2's budget, minus base64 overhead, plus a brotli copy of each compressible asset |
| **Total, uncompressed** | **≈ 24–34 MB** | |
| **Total, compressed pull** | **≈ 12–18 MB** | Estimate |

For context, that is one to two orders of magnitude below a typical JVM or Node service image. It is
**not** remarkable for a static Rust binary, and the interesting number is not the total — it is that
the layer count is two and the attack surface inside the image is one file.

```dockerfile
# Multi-stage. The builder is pinned by digest; the runtime has no package manager
# because there is nothing to install.
ARG SOURCE_DATE_EPOCH
FROM rust@sha256:<digest> AS build
# … cargo build --release --target x86_64-unknown-linux-musl --locked --offline
#     with a vendored registry; the build container has no route (35 §8.3 check 3)

FROM gcr.io/distroless/static-debian12@sha256:<digest>
COPY --from=build /out/fathom-sync /fathom-sync
USER 65532:65532
EXPOSE 8443
ENTRYPOINT ["/fathom-sync"]
CMD ["serve"]
```

Built with BuildKit's `rewrite-timestamp=true` and `ARG SOURCE_DATE_EPOCH`, signed with cosign by
digest. **The claim is content-reproducibility, not byte-reproducibility** — `35` §2.2 and §3.7 own
that distinction and it is not softened here. What a reviewer checks is the application layer's tar
digest against the manifest, which is strictly stronger than a matching image digest because it
verifies contents rather than packaging.

### 5.3 TLS termination — DECISION

**DECISION — `fathom-sync` terminates TLS itself with rustls, reading the certificate and key from
a path, reloading both on `SIGHUP`. No ACME client is built in.**

| Option | Verdict |
|---|---|
| **rustls in-process** | **Chosen.** One container, one process, one thing to review. The TLS configuration is code we control, so `Strict-Transport-Security` and the header set of `34` §2.2 mode C cannot be dropped by a proxy nobody audited |
| A reverse proxy in the compose file (Caddy, nginx, Traefik) | **Supported and documented, not default.** It is a second image, a second configuration language and a second place headers can be added or stripped. Operators who already run one should use it |
| An ACME client in the binary | **Rejected.** It is an outbound connection, a filesystem writer and a scheduled task, in a process whose entire argument is that it does one thing. It also fails in the air-gapped and internal-CA cases, which are most of this product's customers |

**The cost of refusing ACME, stated:** the operator renews certificates with whatever they already
use, and if they use nothing, they will let a certificate expire. The mitigation is a startup and
periodic check that logs `certificate expires in N days` at `warn` below 30 and at `error` below 7,
and exposes it as a metric (§6.12). That is the whole answer. It is not a good one; it is the honest
one for a process that must not make outbound connections.

Minimum configuration: TLS 1.3 only where the customer's clients permit it, TLS 1.2 with the
AEAD suites otherwise, no renegotiation, OCSP stapling if a staple file is supplied (again, no
outbound fetch).

### 5.4 The compose file

```yaml
# compose.yaml — the whole of D2.
name: fathom

services:
  sync:
    # Never a tag. The digest is the artifact; the tag is a pointer (35 §7.4).
    image: ghcr.io/<org>/fathom-sync@sha256:<64 hex>
    restart: unless-stopped
    read_only: true
    user: "65532:65532"
    cap_drop: [ALL]
    security_opt:
      - no-new-privileges:true
    ports:
      - "443:8443"
    environment:
      FATHOM_BIND:            "0.0.0.0:8443"
      FATHOM_ORIGIN:          "https://fathom.corp.example"   # the one origin in the CSP
      FATHOM_TLS_CERT:        "/run/tls/fullchain.pem"
      FATHOM_TLS_KEY:         "/run/tls/privkey.pem"
      FATHOM_STATE:           "/var/lib/fathom"               # index db + server key
      FATHOM_FRAMES:          "/var/lib/fathom/frames"        # content-addressed blobs
      FATHOM_AUTH:            "opaque"                        # or "oidc"
      FATHOM_ENROLMENT:       "token"                         # no open sign-up (33 §10.4)
      FATHOM_QUOTA_BYTES:     "2147483648"                    # per workspace, 33 §10.2
      FATHOM_LOG_FORMAT:      "json"
      FATHOM_LOG_LEVEL:       "info"
      FATHOM_LOG_RETAIN_DAYS: "7"
    volumes:
      - state:/var/lib/fathom
      - ./tls:/run/tls:ro
    tmpfs:
      - /tmp:size=256m,mode=1777,noexec,nosuid,nodev
    healthcheck:
      # distroless has no shell and no curl. The binary is its own health check.
      test: ["CMD", "/fathom-sync", "healthcheck", "--addr", "127.0.0.1:8443"]
      interval: 30s
      timeout: 3s
      retries: 3
      start_period: 10s
    logging:
      driver: json-file
      options: { max-size: "20m", max-file: "5" }

volumes:
  state:
```

Notes that are decisions rather than boilerplate:

| Line | Why |
|---|---|
| `read_only: true` | The container writes only to `/var/lib/fathom` and `/tmp`. If it ever needs a third writable path, that is a design change, not a compose change |
| `tmpfs /tmp` with `noexec` | Upload bodies stream here. `noexec` because nothing in `/tmp` is ever executed and the option costs nothing |
| No `depends_on` | There is nothing to depend on |
| `FATHOM_ENROLMENT: token` | `33` §10.4: enrolment gating is the control that actually matters, because it converts anonymous storage into attributable storage. **Open sign-up is not a supported configuration for a self-hosted instance** |
| `logging` caps | §6.12 — the logs are a metadata store, and an uncapped one is a metadata store that grows forever |

First run:

```bash
$ docker compose run --rm sync init --state /var/lib/fathom
  generated server key      /var/lib/fathom/server.key   (0600, uid 65532)
  generated OPAQUE seed     /var/lib/fathom/opaque.seed  (0600, uid 65532)
  created index             /var/lib/fathom/index.db     (schema 1)
  created frame store       /var/lib/fathom/frames/

  NEXT: mint an enrolment token —  docker compose exec sync enrol --new --label "j.okonkwo"
  BACK UP /var/lib/fathom/server.key AND opaque.seed. LOSING THEM LOGS EVERYONE OUT.
  THEY DECRYPT NOTHING. LOSING THEM IS AN AUTHENTICATION EVENT, NOT A DATA EVENT.
```

That last pair of sentences is the whole zero-knowledge posture in an operational message, and it
should be printed exactly there, where an operator is deciding what to back up.

### 5.5 The storage layer

**DECISION — one `trait FrameStore` + one `trait IndexStore`, two implementations each: SQLite +
local filesystem for D2, PostgreSQL + S3-compatible object storage for D3.**

```rust
/// Blob storage. Content-addressed, immutable, append-only, delete-after-grace.
/// The server cannot read a body and never needs to.
#[async_trait]
pub trait FrameStore: Send + Sync {
    async fn put(&self, d: FrameDigest, body: impl AsyncRead) -> Result<PutOutcome>;
    async fn get(&self, d: FrameDigest) -> Result<impl AsyncRead>;
    async fn exists(&self, ds: &[FrameDigest]) -> Result<Vec<bool>>;
    /// Marks for deletion after the grace period (33 §9.3 step 4). Never immediate.
    async fn tombstone(&self, ds: &[FrameDigest], not_before: Timestamp) -> Result<()>;
    /// Re-reads the body and compares BLAKE3. Key-free integrity. §6.12.
    async fn scrub(&self, d: FrameDigest) -> Result<ScrubOutcome>;
}

pub enum PutOutcome { Stored, AlreadyPresent }   // idempotent by construction
```

`PutOutcome::AlreadyPresent` is not an optimisation. It is what makes the disaster-recovery
procedure in §6.13 and §9.5 work: a client can re-upload every frame it holds, unconditionally,
and the store converges. Frames are a set, not a sequence (`17` §5.3), and content-addressing makes
that property operational rather than notional.

| | **D2** | **D3** |
|---|---|---|
| Index (workspaces, members, generation, index roots, quota, sessions, accounts) | SQLite, WAL mode, one file | PostgreSQL 15+, synchronous replication |
| Frame bodies | Filesystem, `frames/<first two hex>/<digest>` | S3-compatible object storage, key = `w/<wid>/<digest>` |
| Why not one backend for both | A single-node install that requires an operator to run PostgreSQL is a single-node install nobody runs. A cluster on SQLite is not a cluster | |

**The cost, and it is the standard one:** two backends, two sets of migrations, and the bugs will be
in the one that gets less traffic. The mitigations are that the trait surface is nine methods, that
the same integration suite runs against both in CI, and that D2's SQLite path is the one the
developers use daily so it is not the neglected one.

**The `Cargo.lock` question, pre-empted:** brief §6.4 says "no Postgres, no migrations, no ORM". That
is a statement about **the workspace**, which is a document and remains one in every mode. It is not
a statement about the sync service's index, which stores workspace ids, member public keys,
generations and quota counters — none of which is workspace content and all of which needs a
transactional store. Saying this out loud once prevents a reviewer from reading the compose file as a
contradiction of the brief.

### 5.6 Resource footprint

| Resource | Idle | 25 active users | Basis |
|---|---|---|---|
| CPU | <1 % of one core | ≈0.2 core sustained; bursts on BLAKE3 of uploads | Digest work dominates; 33 §10.2 caps a batch at 256 frames / 16 MiB |
| RSS | ≈35 MB | ≈150 MB | Base ≈35 MB + SQLite page cache (default 64 MiB) + per-connection buffers |
| Per-upload memory | **64 KiB**, not 16 MiB | | **The body streams to `/tmp` and is digested as it streams.** Buffering a 16 MiB body per concurrent upload is how this process becomes the memory problem: 64 concurrent uploads × 16 MiB is 1 GB |
| Disk — index | ≈2 MB per workspace | | Members, index entries, generation history |
| Disk — frames | **2–3× the compacted workspace size**, plus 7 days of tombstoned frames | | `33` §9.5's trigger compacts a record at 2× baseline, so steady state sits between 1× and 2×; the grace period (`33` §9.3) adds whatever was deleted in the last week |
| **Disk, 25 users × one 500-device workspace each** | | **≈ 4–6 GB** | 80 MB compacted (`17` §13.2) × 2.5 × 25, plus grace |
| **Disk, the pathological case** | | **≈ 25 GB** | 25 workspaces that never compact, at `33` §9.2's 12.6× amplification over two years |

**Provision 30 GB and alert at 60 %.** The gap between 6 GB and 25 GB is entirely "does anyone
compact", and §6.12 explains why that is the one content-blind health signal that genuinely matters.

**A single node's ceiling.** The binding constraint is not CPU and not RAM; it is that one host is
one failure domain and one upgrade is one outage. As a capacity number: a 500-device workspace
uploads ≈840 KB per device re-parse (`33` §9.2) and ≈350 B per field edit. A team of ten doing
normal work generates single-digit MB per day. **D2 is not capacity-limited for any team that fits
in `33` §10.2's 32-member cap.** It is availability-limited, and that is what D3 is for.

### 5.7 Backup and restore

**The order rule, and it is the only thing in this section that will bite you:**

> **Snapshot the frame store FIRST, the index SECOND. Never the other way round.**

Because frames are content-addressed and append-only, a frame in the store that the index does not
reference is harmless garbage collected later. An index entry referencing a frame that is not in the
store is a workspace that cannot be fully synced. Snapshotting the index first and the frames second
guarantees the second failure whenever a write lands between them.

```bash
# Backup — D2, on the host, with the service running.
# 1. Frames first. Content-addressed and append-only, so this needs no quiescing.
restic backup /var/lib/docker/volumes/fathom_state/_data/frames

# 2. Index second, via SQLite's online backup API (never `cp` a WAL-mode database).
docker compose exec sync index-backup --out /var/lib/fathom/index.backup.db
restic backup /var/lib/docker/volumes/fathom_state/_data/index.backup.db

# 3. Server secrets. These change almost never and they are not in the data path.
restic backup /var/lib/docker/volumes/fathom_state/_data/server.key \
              /var/lib/docker/volumes/fathom_state/_data/opaque.seed
```

**Restore:**

```bash
docker compose down
restic restore latest --target /var/lib/docker/volumes/fathom_state/_data
docker compose up -d
docker compose exec sync fsck --index --frames        # cross-check, key-free
```

`fsck --index --frames` verifies, without any key: every digest the index references exists in the
store; every stored frame's bytes hash to its name; the member log's Ed25519 signatures verify
against the recorded admin keys; the generation counter is monotonic. **That is the complete set of
things an operator can check.** It does not and cannot verify that any workspace is openable.

**The verification problem, stated plainly.** The operator cannot verify a restore, because
verification requires a key and the operator has none. This is not a gap to be closed; it is the
security property working as designed, appearing as an operational inconvenience.

**The procedure that works:**

> **Keep one canary workspace. It contains only synthetic devices. Its passphrase is held by the
> operations team in whatever they already use for shared secrets. Every restore drill ends with a
> real client opening the canary workspace from the restored server and checking the device count
> and a known finding. A drill that does not include that step has verified nothing.**

The canary must contain no real data, because its passphrase is by definition shared with the
operators, and the whole point of the design is that operators cannot read real data.

### 5.8 Failure modes

| # | Failure | Symptom | Handling | Residual |
|---|---|---|---|---|
| D2-F1 | Disk full | Uploads 507/500; clients keep working offline | Frame store checks free space before accepting; refuses at 5 % with a distinct error and a metric | `bounded` — clients are offline-first (`33` §8.2), so a full disk is a sync outage, not a work outage |
| D2-F2 | Certificate expired | Every client fails to connect | §5.3's expiry metric and log escalation | `material` — the accepted cost of no ACME |
| D2-F3 | SQLite corruption | Index unreadable | Restore per §5.7. Frames are unaffected and can be re-indexed from clients' re-push (§9.5) | `bounded` |
| D2-F4 | Host compromise | The attacker serves altered client code to every user on the next reload | §9.6. **This is the mode's defining risk and it is not mitigated by anything in the container** | `material` |
| D2-F5 | Operator loses `server.key` / `opaque.seed` | Every session invalid, every account must re-register | Restore from backup; otherwise re-enrol everyone. **No workspace content is affected** | `bounded` |
| D2-F6 | Nobody compacts | Disk grows at up to 12.6× the useful rate (`33` §9.2) | The per-record frame-count metric (§6.12) and a quota that eventually refuses writes | `material` — compaction is the client's job and nobody wants to do it (`33` §14) |
| D2-F7 | Upgrade requires a restart, and a restart is an outage | Minutes of sync unavailability | Clients are offline-first. **Say this in the release notes so the operator does not schedule a change window they do not need** | `none` |
| D2-F8 | Two containers pointed at one volume | SQLite corruption, duplicate writes | A lock file with the pid and boot id; the second instance refuses to start | `none`, once implemented |

### 5.9 Threat-model delta versus D1 and D3

| Delta | Versus D1 | Versus D3 |
|---|---|---|
| **Adds: a party who can change what every client runs** | New, and it is the largest single change (§2.2) | Same party, larger blast radius in D3 |
| **Adds: metadata at rest on a server** | M1–M10 become live (`31` §7); M8's per-record activity map becomes live (`33` §12.2) | Identical channels; D3 additionally exposes them to the object-store and database operators |
| **Adds: an availability dependency** | D1 has none | D3 has fewer single points |
| **Removes: the file-substitution-once model** | The published hash no longer covers what a user runs day to day | same |
| **Gains: full policy headers** | §3.13 row 5 | identical |
| **Gains: violation reporting to a same-origin endpoint** | D1 has none | identical |
| **Compared with D3: fewer parties** | — | **D2's ciphertext is on one host the customer controls. D3's is in a database and an object store, each with its own operators, its own backups and its own access log** |
| **Compared with D3: no IdP** | — | D3 with OIDC tells the customer's IdP who logged in and when. That is a real disclosure to a real system, and `33` §3.1 argument 2 is why it discloses nothing else |

**The under-appreciated one:** D2 with OPAQUE and no outbound network is a deployment in which the
sync service makes **no connection to anything**. A default-deny egress rule proves it. D3 with OIDC
cannot make that claim, because it must reach the IdP. §6.10 makes that the only permitted egress
and puts it in a NetworkPolicy where a reviewer can read it.

---

## 6. D3 — the enterprise cluster

*margin tab: what you can watch when you cannot look*

> **A 200 PROVES STORAGE, NOT CORRECTNESS. THE SA PROVES CRYPTO, NOT REACHABILITY.**

That second clause is the field card's, about a tunnel that reads `UP` while passing zero packets.
It is the exact shape of D3's operational problem and §6.12 is the section it governs.

### 6.1 Reference architecture

```text
  ┌───────────────────────────────────────────────────────────────────────────────┐
  │  CLIENTS — browsers and CLIs.  Each holds the workspace key.                   │
  │  Everything below this line is ciphertext and metadata. Permanently.           │
  └───────────────────────────────────────────────────────────────────────────────┘
        │  TLS 1.3 · one origin · Authorization: Bearer <token> · NEVER a cookie
        ▼
  ┌── edge ───────────────────────────────────────────────────────────────────────┐
  │  L7 load balancer / Gateway API                                                │
  │  · terminates or passes through TLS      · adds NO headers                     │
  │  · strips NO headers                     · logs NO bodies                      │
  │  · no session affinity needed (§6.6)     · request body limit 16 MiB (33 §10.2)│
  └──────┬────────────────────────────────────────────────────────────────────────┘
         │
  ┌──────▼──────┐   ┌─────────────┐   ┌─────────────┐        stateless · N ≥ 3
  │ fathom-sync │   │ fathom-sync │   │ fathom-sync │        one zone each
  │  replica 1  │   │  replica 2  │   │  replica 3  │        HPA on CPU + inflight
  └──┬───────┬──┘   └──┬───────┬──┘   └──┬───────┬──┘
     │       │         │       │         │       │
     │       └─────────┼───────┴─────────┼───────┘
     │                 │                 │
     ▼                 ▼                 ▼               ▼ (egress: ONE destination)
 ┌────────────────┐  ┌──────────────────────┐   ┌────────────────────┐
 │ INDEX STORE    │  │ FRAME STORE          │   │ CUSTOMER IdP       │
 │ PostgreSQL HA  │  │ S3-compatible object │   │ OIDC discovery +   │
 │ · workspaces   │  │ · sealed frame bodies│   │ JWKS               │
 │ · members+keys │  │ · content-addressed  │   │ learns WHO, never  │
 │ · generation   │  │ · versioned          │   │ WHAT (33 §3.1)     │
 │ · quota        │  │ · object-lock on the │   └────────────────────┘
 │ · session hash │  │   backup bucket      │
 │ NO CONTENT     │  │ NO READABLE CONTENT  │
 └────────────────┘  └──────────────────────┘
         │                     │
         └──────── backups ────┴────► PITR + versioned bucket + object lock (§6.13)

  OUT OF BAND, and deliberately so:
    · metrics  → Prometheus, NO workspace-id labels ever (§6.12)
    · logs     → 7-day retention, no bodies, no workspace ids above debug (§6.12)
    · the scrubber → a CronJob that re-hashes stored frames. Key-free. (§6.12)
```

### 6.2 The app tier is stateless, and what that requires

`fathom-sync` holds no per-request state between requests and no per-user state in memory beyond a
short-lived cache. Concretely, the things a naive implementation would keep in process and where
they actually live:

| State | Where it lives | Why not in the process |
|---|---|---|
| Sessions | Index store, **hashed** (§6.6) | Any replica must serve any request |
| The OPAQUE `flow` token between the two auth round trips | Index store, 30-second TTL (`33` §2.3) | The second round trip may land on a different replica |
| Rate-limit buckets (GCRA, one timestamp per key, `33` §10.2) | Index store, with a per-replica write-behind of ≤1 s | **Honest cost: a client can exceed the limit by up to N replicas × burst during the write-behind window.** Accepted; the limits are anti-abuse, not security |
| Upload bodies | `/tmp` (emptyDir), deleted on completion | §5.6 |
| The live `events` channel (SSE) | In process, and it is the one stateful thing | §6.7 |

**There is no shared cache tier.** No Redis, no memcached. The index store is the only coordination
point, and adding a cache would add a component that holds session material — which is exactly the
component §6.6 exists to avoid.

### 6.3 The sync service

`33` owns the protocol completely. What D3 adds is operational shape:

| Property | Value |
|---|---|
| Endpoints | Nine (`33` §2.1); one of them optional |
| Non-`O(1)` work | Index descent only, rate-limited separately at 20/min per session |
| Wire codec | Canonical CBOR (RFC 8949) |
| Server-side crypto | Ed25519 verification of member signatures and compaction claims; BLAKE3 of frame bodies. **No AEAD, no KDF, no key handling of workspace material — because there is none** |
| CPU profile | Digest-bound on upload, I/O-bound otherwise |
| Idempotency | `POST /frames` is idempotent by content address; `POST /compact` by claim signature |
| Request → storage fan-out | One index transaction + N object puts, ordered **objects first, index second** — the same rule as §5.7, for the same reason |

That last row is the durability rule of the whole service and it is worth stating as code:

```rust
// Objects first, index second. Always. A crash between them leaves unreferenced
// blobs, which the scrubber sweeps. The reverse leaves dangling references, which
// nothing can repair without the client that wrote them.
async fn accept_frames(&self, wid: WorkspaceId, frames: Vec<Frame>) -> Result<Generation> {
    for f in &frames {
        self.frames.put(f.digest, f.body()).await?;        // idempotent, content-addressed
    }
    let gen = self.index.transaction(|tx| {                  // one transaction
        tx.check_member(wid, caller)?;                       // availability ACL (33 §3.5)
        tx.check_quota(wid, total_bytes)?;
        tx.insert_index_entries(wid, &frames)?;
        tx.bump_generation(wid)                              // monotonic, per 33 §1.1
    }).await?;
    Ok(gen)
}
```

### 6.4 The storage layer

| | Choice | Why |
|---|---|---|
| Index | PostgreSQL, synchronous replication, two replicas minimum | It is a small relational workload with hard transactional requirements on `generation`. Nothing exotic |
| Frames | S3-compatible object storage, versioning on, object-lock on the backup bucket | Blobs are immutable and content-addressed, which is exactly what object storage is good at, and it moves the biggest capacity problem out of the database |
| Encryption at rest | Whatever the customer's storage already does | **It buys nothing against our threat model, because the bodies are already sealed.** It buys compliance-checkbox coverage and that is a legitimate reason. Do not describe it as a confidentiality control |
| Retention of tombstoned frames | 7 days (`33` §9.3), then a scheduled deletion pass | The grace period is not optional; a client that fetched an index before a compaction claim and frames after it would otherwise get 404s mid-sync |

**Index size, for capacity planning:** one row per index entry, per record, per workspace. A
500-device workspace has ≈2 100 records (`17` §13.2) and, before compaction, tens of frames each.
Budget ≈50 MB of PostgreSQL per 500-device workspace including indexes, which makes the database
small and the object store large. That asymmetry is the design working: **the thing that grows is
opaque, and the thing that must be transactional is tiny.**

### 6.5 Horizontal scaling

| Axis | Bound | What to do |
|---|---|---|
| Request rate | App tier is stateless; scale replicas | HPA on CPU (target 60 %) **and** on in-flight requests |
| Upload throughput | Object-store PUT rate and the digest CPU | Scale replicas; the object store scales itself |
| Index writes | One transaction per upload batch, per workspace | `generation` is a per-workspace serialisation point, so **two clients on one workspace serialise; a thousand clients on a thousand workspaces do not.** The workload is embarrassingly partitioned by workspace |
| Index descents | Rate-limited at 20/min/session | Read replicas, if it ever matters. It probably will not |
| SSE connections | 4 per account (`33` §10.5), one file descriptor each | This is the only reason to care about connection counts. §6.7 |

**The scaling story is boring, and that is a design outcome.** There is no server-side merge, no
server-side search, no server-side validation and no server-side rendering, because the server
cannot read anything. `33` §14 lists that as a cost — "the server cannot help with anything" — and
this is the one place it shows up as a benefit.

### 6.6 Sessions, with no server-side secret

The requirement is that no secret held on the server can be used to impersonate a user or to read
anything. Two candidate designs and one decision:

| | **Signed tokens** (JWT-shaped) | **Random tokens, stored hashed** |
|---|---|---|
| Server holds | a signing key — **a secret every replica needs, that must be distributed and rotated** | BLAKE3 of each live token |
| A stolen database yields | nothing directly, but a stolen *signing key* yields arbitrary sessions | **nothing usable — a hash is not a token** |
| Revocation | needs a denylist, i.e. state, i.e. the thing the design was avoiding | a `DELETE` |
| Adding a replica requires | distributing the signing key | **nothing** |
| Lookup cost | none | one indexed read per request, cacheable |

**DECISION — session tokens are 32 bytes of CSPRNG output, transmitted in an `Authorization: Bearer`
header, never in a cookie, and stored server-side only as `BLAKE3(token)`.**

```rust
pub struct SessionRow {
    pub token_hash: [u8; 32],     // BLAKE3 of the bearer token. The token itself is
                                  // never written down anywhere on the server.
    pub account:    AccountId,
    pub client:     ClientId,
    pub issued:     Timestamp,
    pub expires:    Timestamp,    // absolute; no sliding renewal
    pub last_seen:  Timestamp,    // coarsened to 60 s — see §6.12 on log hygiene
}
```

Consequences, each of which is the point:

1. **No shared secret between replicas.** Scaling out requires distributing nothing. This is the
   single strongest argument for the design and it is an operational one, not a cryptographic one.
2. **A stolen index database does not yield a live session.** It yields hashes.
3. **Revocation is immediate and real** — modulo the cache in point 5.
4. **No cookies anywhere**, in any mode. `31` §5.1 row 16, and it removes CSRF as a category rather
   than mitigating it.
5. **The cache, and its honest cost.** Each replica caches `token_hash → (account, expires)` for
   **10 seconds**. Revocation therefore takes up to 10 seconds to propagate. That is a deliberate
   trade of revocation latency for one database read per request, and 10 s is chosen because it is
   short enough that no realistic attack fits inside it and long enough to remove the read from the
   hot path.

**What secrets the server does hold, stated without evasion**, because "zero server-side secrets" is
a claim a reviewer will test:

| Secret | Needed for | Can it decrypt a workspace? | Rotation |
|---|---|---|---|
| TLS private key | Transport | **No** | Normal certificate lifecycle |
| OPAQUE server private key + OPRF seed (`33` §3.2) | Authentication, OPAQUE deployments only | **No** | Expensive — every account re-registers. This is a reason to prefer OIDC in D3 |
| OIDC client secret | Authentication, OIDC deployments only | **No** | Rotate at the IdP; a config reload |
| *(nothing else)* | | | |

**The precise claim, which is the one to put in the review pack:** *no secret held by the server, in
any deployment mode, is in the confidentiality path.* Compromise of every server-side secret
simultaneously yields the ability to impersonate accounts and to serve altered client code. It
yields no plaintext. And note which of those two is actually worse: serving altered client code is
how an attacker gets plaintext, from the users, later — which is why §9.6's runbook leads with the
artifact and not with the database.

**In D3, prefer OIDC.** It removes the one server-side authentication secret that is expensive to
rotate, it gives the customer their own MFA and lifecycle, and `33` §3.1's separation means the IdP
learns who logged in and nothing else.

### 6.7 The live channel, and why it is the only stateful thing

`GET /v1/w/{wid}/events` (`33` §2.9) is Server-Sent Events, one long-lived HTTP response per client.
It is strictly an optimisation over polling and everything degrades to polling when it fails
(`33` F9).

Operationally it has three properties that matter and they all come from the connection being long:

| Property | Consequence |
|---|---|
| A connection pins a client to a replica for its lifetime | **Set a maximum connection lifetime of 15 minutes, server-side.** Otherwise a rolling restart waits on connections that never end, and a drain that never completes is an upgrade that never completes |
| A connection is a file descriptor and a task | 4 per account (`33` §10.5). At 500 accounts that is 2 000 descriptors across the fleet — unremarkable, but it is the number that sizes `ulimit` |
| A proxy in the path may buffer it | Some do. The client detects "no event and no heartbeat in 90 s" and falls back to polling, permanently for that session. **No configuration, no error message** |

Heartbeat every 30 s as an SSE comment line. It is 2 bytes and it makes every intermediary behave.

### 6.8 Upgrades with no downtime, given the clients hold the keys

This is where D3 is genuinely different from an ordinary web service, and the difference is a
subtraction: **there is no data migration, because the server cannot read the data.**

| Migration kind | Who performs it | When |
|---|---|---|
| Server index schema | The server, expand-contract across two releases | Deploy time |
| Wire protocol | Nobody — `/v1` is additive-only within a major | — |
| Workspace format / graph schema | **The client, in memory, on open** (`17` §8, `11` §11) | When a user opens a workspace with a newer build |
| Frame bodies | **Never. Nothing on the server ever rewrites a frame** | — |

**The five rules that make a rolling restart safe:**

1. **Expand-contract, always.** Release *N* adds a column and writes both old and new. Release *N+1*
   reads only the new and drops the old. Two releases of overlap, never one. A migration that
   requires all replicas to be on the new version at once is an outage by definition.
2. **`/v1` is additive-only.** New fields are optional CBOR map entries. **Unknown map keys in
   *wire* bodies are ignored; unknown map keys in *sealed* bodies are rejected.** Those two rules
   look contradictory and are not: the wire is a negotiation between versions and must tolerate
   skew; a sealed body is covered by AAD and by invariant 9's determinism, and silently accepting
   an unknown field there is how two builds disagree about a workspace's contents.
3. **Old clients must keep working for the full support window.** The server declares
   `min_supported` and says so in `GET /v1/workspaces`; below it the client is told plainly rather
   than failing at a random endpoint.
4. **Drain properly.** `preStop` sleeps 5 s (so the endpoint is removed from the LB before the
   process starts refusing), then the process stops accepting, finishes in-flight requests, closes
   SSE connections with a `retry:` hint, and exits. `terminationGracePeriodSeconds: 60`.
5. **The one upgrade that is not zero-downtime is a graph schema major**, and it is not a server
   event at all. Clients that were offline across it hit `33` §8.5's quarantine-and-migrate path.
   The server cannot help, cannot detect it, and must not pretend to.

**Canary, in the field card's shape.** The card's first bring-up step is `commit confirmed 5` —
a change that reverts itself unless someone actively confirms it. The deployment analogue:

```text
  1  deploy ONE replica of N+1;  keep N-1 replicas on N
  2  watch for 10 minutes:
       5xx rate on the canary          must not exceed baseline + 0.1 pp
       409 GenerationConflict rate     must not exceed baseline × 1.5
       p99 POST /frames                must not exceed baseline × 1.5
       accept-to-index error count     must be zero
  3  any threshold crossed  →  scale the canary to zero. That is the whole rollback.
  4  otherwise  →  roll the remainder, one replica at a time, same watch, shorter window
```

Stop at the first failure. The card's ladder says the same thing about tunnels and for the same
reason: a partial success that you push past becomes a diagnosis you cannot make later.

### 6.9 High availability

| Component | HA posture | Failure behaviour |
|---|---|---|
| App tier | ≥3 replicas, `topologySpreadConstraints` across zones, `PodDisruptionBudget: minAvailable: 2` | Losing one replica is invisible |
| Index store | PostgreSQL with synchronous replication and automated failover (CloudNativePG, Patroni, or the cloud provider's) | 10–30 s of write unavailability during failover. Clients retry; they are offline-first |
| Frame store | The object store's own durability | Regional outage = sync outage |
| Edge | Whatever the customer already runs | — |
| IdP | The customer's | **Existing sessions survive an IdP outage; new logins do not.** Absolute session expiry (§6.6) means a long IdP outage eventually locks everyone out. Say so; do not compensate with sliding sessions |
| **Clients** | **Every client is a full replica of the workspaces it holds** | §6.13 |

That last row is not a joke. It is the actual availability story: **`33` §8.2 makes clients
offline-first, so a total service outage stops synchronisation and does not stop work.** An engineer
mid-change during a cluster failure continues, saves locally, and syncs when it returns. The service
is not on the critical path of the product's core loop, which is a property most SaaS cannot claim
and which should be stated in the SLA as a feature rather than discovered as a surprise.

### 6.10 Kubernetes manifests, in outline

Not a Helm chart. The set of objects, with the fields that are decisions.

```yaml
# ── Deployment ────────────────────────────────────────────────────────────────
apiVersion: apps/v1
kind: Deployment
metadata: { name: fathom-sync }
spec:
  replicas: 3
  strategy: { type: RollingUpdate, rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } }
  template:
    spec:
      automountServiceAccountToken: false          # it calls no Kubernetes API
      securityContext:
        runAsNonRoot: true
        runAsUser: 65532
        fsGroup: 65532
        seccompProfile: { type: RuntimeDefault }
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector: { matchLabels: { app: fathom-sync } }
      containers:
        - name: sync
          image: ghcr.io/<org>/fathom-sync@sha256:<digest>   # digest, never a tag
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: [ALL] }
          ports: [{ containerPort: 8443, name: https }]
          resources:
            requests: { cpu: 100m, memory: 128Mi }
            limits:   { cpu: "1",   memory: 512Mi }        # no CPU limit if you
                                                           # care about p99 latency
          env:
            - { name: FATHOM_AUTH,   value: "oidc" }
            - { name: FATHOM_ORIGIN, value: "https://fathom.corp.example" }
          envFrom:
            - secretRef: { name: fathom-sync-secrets }      # DB URL, OIDC client secret
          volumeMounts:
            - { name: tmp, mountPath: /tmp }
          startupProbe:                                     # tolerates migration wait
            httpGet: { path: /healthz, port: https, scheme: HTTPS }
            failureThreshold: 30
            periodSeconds: 2
          livenessProbe:                                    # process only — NO deps
            httpGet: { path: /healthz, port: https, scheme: HTTPS }
            periodSeconds: 10
          readinessProbe:                                   # deps, and read the note
            httpGet: { path: /readyz, port: https, scheme: HTTPS }
            periodSeconds: 5
          lifecycle:
            preStop: { exec: { command: ["/fathom-sync", "drain", "--wait", "5s"] } }
      terminationGracePeriodSeconds: 60
      volumes:
        - name: tmp
          emptyDir: { medium: Memory, sizeLimit: 512Mi }
```

**The probe note, and it is the one that causes outages.** `/readyz` must **not** fail when the
object store is briefly unwritable. If it does, a transient object-store blip marks every replica
unready simultaneously and the load balancer removes the entire fleet — converting a degradation into
a total outage. `/readyz` checks the index store only; object-store health is a *metric* and a
*degraded read-only mode* in which `GET` succeeds and `POST /frames` returns 503. Clients handle 503
by staying offline, which they do well.

```yaml
# ── The rest of the set ───────────────────────────────────────────────────────
kind: Service              # ClusterIP, one port, no session affinity (§6.6)
kind: PodDisruptionBudget  # minAvailable: 2
kind: HorizontalPodAutoscaler
  # metrics: CPU 60 %, plus a custom metric on in-flight requests. Scale-down
  # stabilisation 300 s, because SSE connections make rapid scale-down expensive.
kind: Gateway / HTTPRoute  # or Ingress. Body limit 16 MiB. Adds no headers.
kind: Secret                # DB URL, OIDC client secret. Ideally an ExternalSecret.
kind: ConfigMap             # non-secret configuration only
kind: ServiceMonitor        # scrape /metrics on a separate port, cluster-internal only
kind: CronJob               # 1. the frame scrubber (§6.12), nightly, off-peak
                            # 2. the tombstone sweeper (grace period expiry), hourly
kind: Job                   # schema migration, expand phase, gated on release N
kind: NetworkPolicy         # ↓ this one is a security control, not plumbing
```

```yaml
# ── NetworkPolicy — default-deny egress, and the allowlist is the claim ────────
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: fathom-sync }
spec:
  podSelector: { matchLabels: { app: fathom-sync } }
  policyTypes: [Ingress, Egress]
  ingress:
    - from: [{ podSelector: { matchLabels: { app: gateway } } }]
      ports: [{ port: 8443 }]
  egress:
    - to: [{ podSelector: { matchLabels: { app: postgres } } }]
      ports: [{ port: 5432 }]
    - to: [{ ipBlock: { cidr: <object-store CIDR> } }]
      ports: [{ port: 443 }]
    - to: [{ namespaceSelector: { matchLabels: { name: kube-system } },
             podSelector: { matchLabels: { k8s-app: kube-dns } } }]
      ports: [{ port: 53, protocol: UDP }]
    # OIDC only. Delete this rule for an OPAQUE deployment and the service has
    # no route to anything outside the cluster. That deletion IS the air-gap claim.
    - to: [{ ipBlock: { cidr: <IdP CIDR> } }]
      ports: [{ port: 443 }]
```

That comment is the point of the object. Invariant 1 says the application opens no connection the
user did not configure; the NetworkPolicy is the same statement about the *server*, in a form the
customer's own platform team can read and enforce without trusting us.

### 6.11 Resource footprint

| Component | Sizing | Basis |
|---|---|---|
| App replica | 100 m CPU / 128 MiB requested; 1 CPU / 512 MiB limit | §5.6, minus SQLite's page cache |
| App tier, 500 users | 3–5 replicas | Digest-bound bursts; the steady rate is tiny |
| PostgreSQL | 2 vCPU / 8 GB RAM / 100 GB SSD for 500 workspaces | §6.4's ≈50 MB per 500-device workspace, ×2 for indexes and WAL headroom |
| Object store | **1–2 TB for 500 × 500-device workspaces** | 80 MB compacted × 2.5 amplification × 500 ≈ 100 GB; the upper figure assumes poor compaction discipline at `33` §9.2's 12.6× |
| Metrics + logs | Sized by cardinality, and §6.12 is why that is small | |

**The number to watch is the object store, and its variance is entirely behavioural.** Between "everyone
compacts" and "nobody compacts" is a factor of five to twelve. That is not a capacity-planning
uncertainty you can engineer away from the server side, because compaction is a client operation the
server cannot perform (`33` §9.1).

### 6.12 Observability that does not leak — the genuine problem

*margin tab: what the log means*

> **THE DASHBOARD IS GREEN AND EVERY CLIENT IS BROKEN. YOU WILL NOT LEARN THIS FROM THE SERVER.**

#### 6.12.1 The problem, stated precisely

The service returns 200 for a well-formed upload of bytes it cannot read. It returns 200 for a
download of bytes nobody can decrypt. It returns 200 for a frame that is padding, for a frame that
is a corrupted seal, and for a frame written by a client whose CRDT has diverged from every other
client's. **Every server-side success metric is a statement about transport and storage, and none of
them is a statement about the product working.**

The field card's version of the same fact: *"The SA proves crypto, not reachability."* A tunnel can
read `UP` while passing zero packets, and the fix is to stop reading proposals and go look at the
plumbing. Here the plumbing is on the client, where you cannot look.

#### 6.12.2 What the server can genuinely measure, and what each thing means

| Signal | Means | Does **not** mean |
|---|---|---|
| Request rate, latency, status distribution per endpoint | The service is reachable and fast | Anything about correctness |
| **Frame-store scrub result** (§6.12.3) | **The ciphertext we accepted is the ciphertext we still hold** | That it decrypts |
| **Index/frame cross-reference** (`fsck --index --frames`) | Every referenced digest exists; no dangling references | Same |
| **Member-log signature verification** | The member list has not been edited outside the protocol | That the members are the right people |
| **Frames per record, distribution** | **Compaction lag.** `33` §9.5 triggers at 512 frames or 2× baseline; a record above that means no client has compacted it | Which record, or what it is |
| Bytes per workspace vs quota | Capacity, and abuse | Content |
| `409 GenerationConflict` rate | Write contention | Whether the merge succeeded |
| `409` rate **with generation not advancing** | **A client stuck in a retry loop.** This is the one derived signal worth alerting on | Which client is at fault |
| Unreferenced blob count and age | Clients crashing between the object put and the index commit | |
| Auth failure rate per account | Credential stuffing | |
| Upload size histogram | Padding behaviour is working (all sizes are Padmé buckets) | Content — that is the point of the padding |
| Certificate expiry days | §5.3 | |

#### 6.12.3 The one strong guarantee available without a key

**Frames are content-addressed by BLAKE3.** Therefore an operator can re-read every stored body,
hash it, compare it to its own name, and prove bit-for-bit durability **without any key, without any
plaintext, and without any trust in the client.**

```text
  fathom-sync scrub --rate 20MiB/s --since 30d

  scanned      412,884 frames   (2.4 TB)
  verified     412,881
  MISMATCH           2   w/… /a91c…  w/… /7d02…      ← bit rot or tampering. Restore.
  MISSING            1   w/… /3f1c…                  ← referenced by index, not present
  unreferenced   1,204   (oldest 3 d)                 ← sweep after grace
```

This is the answer to "what can you usefully monitor when you cannot read the data": **integrity,
completely; availability, completely; correctness, not at all.** Say all three parts. A durability
SLO backed by a scrubber is a real promise. A correctness SLO would be a lie.

Run it as a nightly CronJob at a bandwidth cap, covering everything on a 30-day cycle, plus every
object written in the last 24 hours.

#### 6.12.4 The metrics cardinality trap — your TSDB is a metadata store

This is the mistake this section exists to prevent, and it is one nobody catches in review because
it looks like good practice.

> **A `workspace_id` label on a Prometheus counter reconstructs `33` §12.2's per-record activity map
> — the exact disclosure the protocol spent a section minimising — in an unencrypted time-series
> database, with a 15-day retention, under a different access-control system, exported to a
> dashboard anyone in the platform team can read.**

The rules:

| # | Rule | Reason |
|---|---|---|
| M1 | **No `workspace_id`, `record_id`, `account_id`, `client_id` or `username_hash` as a metric label. Ever** | The above |
| M2 | Per-workspace counters exist **only in the index store**, where quota enforcement needs them, and are read on demand rather than exported | Quota is a legitimate need; a time series is not |
| M3 | Histograms are exported without exemplars | An exemplar carries a trace id which carries a request which carries an identity |
| M4 | The compaction-lag signal is exported as a **distribution**, not per workspace: `fathom_record_frames_bucket` | An operator needs to know "37 records across the fleet are above threshold", not which |
| M5 | Answering "which workspace needs compaction" is an **operator query against the index store**, logged as an administrative action | It is occasionally necessary. It should leave a trace |
| M6 | `/metrics` is on a separate listener, cluster-internal, never on the public route | |

#### 6.12.5 Log hygiene

| # | Rule |
|---|---|
| L1 | **No request or response bodies. Ever. Not truncated, not hashed, not at debug** |
| L2 | Workspace ids and record ids appear at `debug` only. `debug` is off, and turning it on is itself logged at `warn` with the operator's identity |
| L3 | Source addresses are recorded at full precision for 24 hours (abuse response needs them) and truncated to /24 and /48 thereafter. **The trade is named: full-precision retention is a metadata store; truncation blinds abuse investigation after a day** |
| L4 | Default retention 7 days. An operator who extends it is extending a metadata store and the configuration comment says so |
| L5 | Error responses log the closed `SyncError` variant and nothing derived from the request body |
| L6 | Every administrative action — member forced out, quota changed, retention changed, debug enabled, a query against the index store — logs actor, action, target and time, to a separate stream with a longer retention |

L6 is the exception that proves the rule: the only thing worth keeping for a long time is what the
**operator** did, because that is the one party the customer cannot otherwise observe.

#### 6.12.6 The SLOs you can write, and the one you cannot

| SLO | Measurable? | Target |
|---|---|---|
| Availability — `POST /frames` success rate excluding 4xx | yes | 99.9 % monthly |
| Latency — p99 `POST /frames` under 16 MiB | yes | < 800 ms |
| **Durability — scrub mismatches per frame-year** | **yes, and honestly** (§6.12.3) | 0 mismatches; any mismatch is an incident |
| Freshness — time from upload to visibility on another client's poll | yes | < 1 poll interval, or < 2 s with SSE |
| **Correctness — clients converge on the same graph** | **no. Structurally not measurable server-side** | — |
| **Usefulness — engineers get correct configuration** | **no** | — |

> **We publish no correctness SLO and no error budget on data integrity beyond durability, because we
> cannot observe either. An operator who claims one is claiming to know something the architecture
> prevents them from knowing.**

That sentence goes in the SLA. It reads as a weakness and it is the strongest thing in the document,
because the alternative is a number somebody made up.

#### 6.12.7 The client-side blind spot, and what replaces telemetry

Invisible from the server, permanently:

| Invisible | Why it matters |
|---|---|
| A client that cannot decrypt anything | It looks identical to a client that stopped working. **Both are silence** |
| CRDT divergence (`33` F6) | The largest residual in the sync design, and the server cannot see it |
| A removed member who still holds WK (`33` F10) | Inherent to any end-to-end-encrypted system |
| Emit blocked by a `Conflicted` field | The user is stuck; the server sees a healthy account |
| A user who gave up | Indistinguishable from a user on holiday |
| Whether the emitted configuration was correct | Not our business, and out of reach |

**There is no telemetry and there will not be. Invariant 1.** What replaces it:

1. **`fathom diagnose`** — user-initiated, writes a file, **shows the operator-safe contents to the
   user before anything leaves**, and sends nothing itself. Contents: build identity, corpus and
   pack versions with hashes, workspace id, generation, record and frame counts, the `fsck` result,
   the conflict count by field class, timings. **No node names, no addresses, no findings, no
   configuration.** It reuses `fathom redact`'s existing machinery.
2. **`fathom fsck --compare`** (`33` F6) — two workspace copies in, the first field where they differ
   out. The only tool that detects divergence, and it requires two humans with two copies.
3. **The support conversation.** A customer says "sync is broken"; the operator can prove the service
   accepted and returned exactly the bytes it was given, and then the investigation moves to the
   client where the operator cannot go. **That is the honest support model and it should be in the
   contract**, because discovering it during an incident is worse.

### 6.13 Disaster recovery

#### 6.13.1 The asymmetry that makes this tractable

**The server is not the backup. The clients are.** Every client that has synced a workspace holds
the frames it has seen, and `33` §9.3 already requires clients to retain their own frames until they
have verified that a compaction baseline covers them. Frames are a set (`17` §5.3) and are
content-addressed, so re-uploading is idempotent (§5.5).

| Loss | Recovery |
|---|---|
| Frame store lost, index intact | Restore from the versioned bucket. Then `fathom sync repush` from any client per workspace fills gaps; the index tells you which digests are missing |
| Index lost, frames intact | Restore from PITR. Then **the index can be partially rebuilt from clients**: each client uploads its index root and version vector, and the server rebuilds the entry set. `generation` restarts at the highest a client attests to — and because `attest` is signed by a member (`33` §2.4), **the server cannot be the authority on its own honesty here, which is exactly what makes this recovery trustworthy** |
| Both lost, active clients exist | Rebuild from clients. Slow, complete, and requires each workspace to have at least one client that opens it |
| Both lost, **no active client for a workspace** | **Unrecoverable.** A workspace nobody has opened since before the backups failed is gone. The server cannot reconstruct what it never could read |

That last row is not softened anywhere and it must be in the customer-facing documentation.

#### 6.13.2 Targets and procedure

| | Target | Mechanism |
|---|---|---|
| RPO, index | 5 minutes | PostgreSQL PITR, WAL archived continuously |
| RPO, frames | ~0 | Object versioning; objects are immutable so there is nothing to lose but the newest writes |
| RTO | 60 minutes to service; hours to complete via client re-push | |
| Backup immutability | Object lock on the backup bucket; a separate credential the app tier does not hold | An attacker with app-tier credentials must not be able to delete backups |
| Restore order | **Frames first, index second.** §5.7's rule, at cluster scale | |
| Restore verification | **The canary workspace, opened by a real client.** §5.7 | |

Drill quarterly. A DR drill that stops at "PostgreSQL came up" has tested PostgreSQL.

### 6.14 Threat-model delta versus D1 and D2

| Delta | Detail |
|---|---|
| **More parties hold ciphertext** | The database operator, the object-store operator, the backup system, and every one of their access logs. Each is a place `31` §7's metadata channels are observable |
| **The IdP learns identity and timing** | New in D3 with OIDC. It learns nothing about content (`33` §3.1) and this is worth stating in exactly those words |
| **A larger, longer-lived operator surface** | D2's operator is often the customer's one admin. D3's is a platform team, a DBA team, a storage team and whoever holds the object-store credentials |
| **Metrics and logs are a second metadata store** | §6.12.4. Not present in D1, small in D2, and in D3 it is a whole platform with its own retention and its own access control |
| **A larger blast radius for altered client code** | One image change reaches every user in the organisation on their next reload |
| **Better availability, and availability was never the confidentiality claim** | `33` §10.5: zero-knowledge protects contents and never availability |
| **Unchanged: everything about confidentiality** | The server holds no key in D3 exactly as in D2. Scaling out changes the metadata surface and the operator count. **It changes nothing about what can be read** |

---

## 7. D4 — the CLI

*margin tab: the one that goes in a pipeline*

> **EXIT 1 MEANS I RAN AND FOUND PROBLEMS. EVERY OTHER NON-ZERO MEANS I COULD NOT DO THE JOB. IF CI
> CANNOT TELL THOSE APART, THE TOOL IS UNUSABLE IN CI.**

### 7.1 What the CLI is for

Four jobs, and they are not the browser's jobs:

| Job | Why the CLI and not the browser |
|---|---|
| **Air-gapped emit** | A machine with no browser, or a change process that runs from a terminal |
| **CI linting of configurations against rule packs** | The graph and the rules are the same; the invocation is `fathom lint` in a pipeline |
| **Corpus and rule-pack authoring and validation** | Authors work in a repository, not a tab |
| **Workspace inspection and repair** | `fsck`, `grep`, `show`, `diff`, `compact`, `git` — operations on a directory |

It also produces `34`'s mode B via `fathom serve` (§7.8), which is why the CLI is the install unit
for the offline-with-persistence deployment.

### 7.2 Install and footprint

One static binary. `x86_64-unknown-linux-musl` (fully static, byte-reproducible per `35` §2.1),
`aarch64-apple-darwin` and `x86_64-pc-windows-msvc` (signed; the *unsigned* digest is what the
manifest claims, per `35` §2.3).

| | Value |
|---|---|
| Size | 15–25 MB, including the corpus and the finder index <!-- VERIFY: measure. --> |
| RSS, idle | ≈10 MB |
| RSS, 500-device workspace, everything loaded | ≈550 MB (`17` §13.2) |
| RSS, 500-device workspace, lazy provenance | ≈140 MB (`17` §13.2) |
| Full rule sweep, 500 devices | ≈11 s (`17` §13.2), and `rayon` parallelism applies here where it does not in WASM (§1.5) |
| Dependencies | None. No runtime, no interpreter, no shared library beyond the platform's |
| Network | **None, unless explicitly asked.** `fathom verify` fetches nothing by default (`35` §13.2); `fathom sync` is the only subcommand that opens a connection and it needs a configured origin |

### 7.3 The command surface

Grouped by job. `<ws>` is a workspace path — directory or packed (`17` §2.1); the loader `stat`s it
and branches.

**Workspace**

| Command | Does |
|---|---|
| `fathom new <ws>` | Create a workspace. Generates a passphrase by default (`31` §2.4) and prints it once |
| `fathom open <ws>` | Unlock and print the summary. Mostly a passphrase check |
| `fathom show <ws> [selector] [--plain] [--depth terse\|explained\|teaching]` | Render nodes, fields, provenance |
| `fathom grep <ws> <pattern> [--kind K] [--field-class C]` | Search the graph. Never the ciphertext |
| `fathom stat <ws>` | Counts, sizes, record and frame distribution, compaction pressure |
| `fathom fsck <ws> [--crypto] [--compare <other>]` | Integrity. `--compare` is the divergence detector (`33` F6) |
| `fathom pack <dir> -o <file>` / `fathom unpack <file> -o <dir>` | `17` §2.1's deterministic round trip |
| `fathom compact <ws> [--record R]` | `33` §9.5, run deliberately |
| `fathom workspace purge <ws> --node <id> --reason "…"` | Hard removal, logged |

**Ingest and emit**

| Command | Does |
|---|---|
| `fathom ingest <ws> --platform junos-srx --file capture.txt` | Parse a `display set` capture into the graph, with provenance |
| `fathom import --into <ws> <file>` | `17` §14 — reconciliation, never replace |
| `fathom emit <ws> --device <id> [--unit U] [--format set\|conf\|json] [--annotate]` | Configuration, with provenance. **The air-gapped path** |
| `fathom explain <ws> --line <n>` / `--node <id>` / `--rule <id>` | The explainer, at a depth |
| `fathom diff <ws> --from <rev> --to <rev>` | Graph diff (`18`) |
| `fathom runbook <ws> --from <rev> --to <rev>` | **The verify ladder and the rollback** for that change (`18`) |
| `fathom find <query> [--platform P] [--workspace <ws>]` | The command finder, with context interpolation when a workspace is given |
| `fathom export <ws> --format …  --reason "…"` | Plaintext export, through `17` §15.3's gate |
| `fathom export-log <ws> --format json` | Who exported what, when, why |

**Rules, corpus, packs**

| Command | Does |
|---|---|
| `fathom lint config --platform P --file f [--pack …] [--fail-on S] [--baseline b]` | **Lint a raw configuration** without a workspace. §7.5 |
| `fathom lint <ws> [--fail-on S] [--baseline b]` | Lint a workspace |
| `fathom rule new <id>` / `fathom rule test <id>` / `fathom rule explain <id>` | Authoring, with the fixture discipline `63` requires |
| `fathom corpus check` / `build` / `golden` | Validate, build the finder index, run the golden query set (`16` §9.6) |
| `fathom pack build` / `sign` / `verify` / `install` / `list` | Rule-pack lifecycle (`12` §13) |
| `fathom advisories install <f.fadv>` / `list` | `35` §8.4 |

**Sync, transport, artifacts**

| Command | Does |
|---|---|
| `fathom sync init <ws> --origin https://… ` | Enrol this client; generate its keypair; sign into the member list |
| `fathom sync push` / `pull` / `status` / `repush` | `repush` is the DR path (§6.13) |
| `fathom git install` / `git show-record` | The merge driver (`17` §12.3) — it cannot be committed, so it must be installed |
| `fathom serve [--port 7440] [--bind 127.0.0.1] [--open]` | §7.8 |
| `fathom verify <artifact> [--rebuild] [--json] [--strict]` | `35` §13.2, unchanged |
| `fathom diagnose <ws> --out f.json` | §6.12.7 |
| `fathom redact <file>` | Existing |

**Naming collision, resolved.** `fathom verify` is pinned by `35` §13.2 to artifact verification. The
brief's `runbook = verify(diff(graph))` therefore ships as **`fathom runbook`**, not `fathom verify`.
Two different meanings of "verify" on one command line is the kind of ambiguity that ends with
somebody running the wrong one in a change window.

### 7.4 The exit-code contract

**This is an interface. It is versioned, it does not change within a major, and every subcommand
obeys it.**

| Code | Name | Means | What CI should do |
|---|---|---|---|
| **0** | `Ok` | Ran; nothing to report at or above the threshold | Pass |
| **1** | `Findings` | **Ran successfully and found problems** — findings at or above `--fail-on`, a failed check, a non-empty diff where one was asserted | **Fail the build. This is the only code that means the input is wrong** |
| **2** | `CouldNotComplete` | Usage error, missing argument, or a requested check that could not be attempted | Fail the build as a **tooling** error |
| **3** | `BadInput` | Input unreadable, unparseable or not the format claimed | Fail as a tooling/input error |
| **4** | `IntegrityFailure` | Signature, digest, AEAD tag, manifest or trust-store failure | **Fail loudly. Never retry** |
| **5** | `Locked` | A passphrase is required and none was available non-interactively | Fail; fix the credential path |
| **6** | `VersionMismatch` | Workspace, schema or pack needs a different build (`17` §8.2) | Fail; upgrade the tool |
| **7** | `Conflicted` | Unresolved `Conflicted` fields block the requested emit (`33` §7.1) | Fail; a human must choose |
| **8** | `Internal` | A bug. Panic, trap, invariant violation | Fail; open an issue with `--json` output attached |
| **9–63** | *reserved* | | |
| **130** | | Interrupted (SIGINT), `128 + 2` | |

Deliberately avoided: **64–78**, which BSD `sysexits.h` claims; **125–127**, which shells and
container runtimes use for "command not found" and "not executable". Colliding with either produces
a CI failure that reads as a tool that is not installed.

**Reconciliation with `35` §13.2**, which pins `fathom verify` to `0` pass / `1` a check failed /
`2` a check could not be attempted / `3` malformed input. Those map onto the table above exactly:
`1` = `Findings` (a failed check *is* a finding about an artifact), `2` = `CouldNotComplete` (a check
that could not be attempted is work that could not be completed), `3` = `BadInput`. No change is
needed to either document; `verify --strict` additionally promotes "not attempted" from `2` to `1`
for pipelines that want it to be a failure.

**The rule that makes the contract worth having**, stated once:

> **Exit 1 is the only code that means "your configuration has a problem". Every other non-zero code
> means "Fathom could not tell you whether your configuration has a problem." A pipeline that treats
> them alike will one day pass a build because the tool crashed.**

And the corollary: **`--format json` writes a machine-readable result to stdout on every exit code,
including 8.** Human text goes to stderr. A pipeline must never have to parse prose.

### 7.5 CI linting, worked

The most valuable CI use is linting configurations that are already in a repository, against a
signed rule pack, with a baseline so that an existing estate does not fail the build on day one.

```yaml
# .github/workflows/network-lint.yml  (or the GitLab/Jenkins equivalent — the tool
# is a static binary and a contract, not a plugin)
- name: Install fathom
  run: |
    curl -sSfLO "${FATHOM_URL}/fathom-${VER}-x86_64-unknown-linux-musl"
    curl -sSfLO "${FATHOM_URL}/MANIFEST-${VER}.txt"
    curl -sSfLO "${FATHOM_URL}/MANIFEST-${VER}.txt.minisig"
    minisign -Vm "MANIFEST-${VER}.txt" -P "${FATHOM_PUBKEY}"        # not our tool
    grep -F "$(sha256sum fathom-${VER}-x86_64-unknown-linux-musl)" "MANIFEST-${VER}.txt"
    install -m 0755 "fathom-${VER}-x86_64-unknown-linux-musl" /usr/local/bin/fathom

- name: Lint SRX configurations
  run: |
    fathom lint config \
      --platform junos-srx \
      --version 21.4 \
      --glob 'configs/**/*.set' \
      --pack fathom.ipsec@2.9.0 \
      --pack acme.internal.baseline@4.2.0 \
      --fail-on high \
      --baseline .fathom-baseline.json \
      --format json --out findings.json
```

Output, in the card's register — two-column, hairline rules, no vertical rules, the left column the
lookup key:

```text
  configs/site-b/srx345-fw01.set

  ▌ HIGH        ipsec.pfs.absent                    IPSEC-POL
    Perfect Forward Secrecy is not configured on this IPsec policy.
    Without PFS, Phase 2 keys derive from Phase 1 key material; one compromised
    IKE SA secret unlocks every data key derived under it, including previously
    recorded traffic.
    IF MISMATCHED   PFS on one side and absent on the other fails Phase 2 while
                    Phase 1 stays up — "IKE looks fine but the tunnel keeps dropping."
    FIX             set security ipsec policy IPSEC-POL \
                      perfect-forward-secrecy keys group14
    ACCEPTABLE WHEN Interoperating with a peer that cannot support it. Document the
                    exception and compensate with shorter Phase 2 lifetimes.
    SOURCE          RFC 7296 §1.3.2

  ▌ HIGH        zone.host-inbound.ike-missing       zone WAN / reth0.0
    The WAN zone permits no inbound IKE, so the peer's Phase 1 is dropped before
    it is processed. Phase 1 times out with nothing useful in the log.
    FIX             set security zones security-zone WAN interfaces reth0.0 \
                      host-inbound-traffic system-services ike
    ACCEPTABLE WHEN Never on a zone that terminates a tunnel. Explicitly not
                    acceptable; recorded here rather than omitted.

  ▌ MEDIUM      mtu.mss-clamp.absent                VPN-B
    No TCP MSS clamp for tunnelled traffic. Handshakes complete and bulk transfers
    stall — the classic "ping works, SSH connects, then ls hangs."
    FIX             set security flow tcp-mss ipsec-vpn mss 1360
    ACCEPTABLE WHEN The path MTU is known-good end to end and documented.

  ▌ suppressed  ike.dpd.absent                      GW-B
    suppressed 2026-04-11 by j.okonkwo — "backup tunnel, monitored out of band,
    CHG-2026-0102"

  ─────────────────────────────────────────────────────────────────────────────
  14 files · 41 findings · 3 at or above high · 1 suppressed · 37 in baseline
  exit 1
```

Every one of those findings, its `symptom_if_mismatched` text and its remediation comes from the
owner's SRX IPsec field card — side 2 for PFS and the three rules, side 1's plumbing piece #3 and
"Miss #3 and Phase 1 times out with nothing useful in the log" for `host-inbound`, side 4's MTU story
and the tell-tale symptom for the MSS clamp. **The card is the acceptance test for whether the
corpus is any good.** If `fathom lint` cannot produce that output, the rule pack is not finished.

**Two flags that decide whether anyone adopts this:**

| Flag | Why it is load-bearing |
|---|---|
| `--baseline .fathom-baseline.json` | An existing estate has hundreds of findings. Without a baseline, the first CI run fails and the job is disabled that afternoon. `fathom lint --baseline-update` regenerates it, and the file is reviewed in a pull request so waiving is visible |
| `--fail-on <severity>` | Default `high`. Teams ratchet down over time |

**Determinism in CI** is not optional and needs pinning explicitly, because a rule pack update that
silently changes a build's result is the fastest way to lose trust:

```bash
fathom lint config --pack fathom.ipsec@2.9.0 --corpus 4.2.1 --no-ai --frozen
```

`--frozen` refuses to run if any pack or corpus version is not pinned exactly. `--no-ai` is
redundant in the CLI's default build and is accepted so a pipeline can assert it.

### 7.6 Corpus authoring and validation

The corpus is human-authored and reviewed (invariant 10), and the CLI is the authoring tool.

```bash
fathom rule new ipsec.pfs.absent          # scaffolds the YAML with every mandatory field,
                                          # including acceptable_when, which cannot be omitted
fathom rule test ipsec.pfs.absent         # runs the rule against its positive and negative
                                          # fixtures; a rule without both does not build
fathom corpus check                       # schema, ids, cross-references, reviewed_by present,
                                          # every explainer id resolves, every rosetta target exists
fathom corpus golden                      # the ~120 pinned queries (16 §9.6); reports rank changes
fathom corpus build -o dist/              # finder.idx + finder.toml + content hash, byte-deterministic
fathom pack build corpus/ipsec -o fathom.ipsec-2.9.0.fpack
fathom pack sign fathom.ipsec-2.9.0.fpack --key …
fathom pack verify fathom.ipsec-2.9.0.fpack
```

Exit codes matter here too: `corpus check` returns `1` for a content problem the author must fix and
`2` if it could not check (a missing fixture directory, a broken workspace). An author who cannot
tell those apart will "fix" the wrong thing.

**`fathom corpus golden` reporting a rank change is not a failure.** It is a diff for review, and it
exits `1` only when a pinned top-3 loses its expected entry. The finder's ranking is observable
behaviour under invariant 9, so a change to it belongs in a pull request, not in a release note
nobody reads.

### 7.7 Workspace inspection

```text
$ fathom stat site-b.fathom

  WORKSPACE     site-b.fathom          directory form
  FORMAT        1                      SCHEMA 3.2
  GENERATION    1,204                  last local write 2026-07-28T09:14:02Z

  DEVICES       47        NODES 15,208        EDGES 34,110
  RECORDS       211       FRAMES 3,880        CAPTURES 12
  ON DISK       8.1 MB    of which frames 6.9 MB, captures 0.9 MB

  COMPACTION    ▌ 4 records above the 512-frame trigger — compaction is overdue
                  fathom compact site-b.fathom

  FINDINGS      212       high 14   medium 61   low 137
  SUPPRESSIONS  18        oldest 2025-11-02, 3 with no reason recorded
  CONFLICTS     0

  PINS          corpus 4.2.1   packs  fathom.ipsec 2.9.0, acme.internal.baseline 4.2.0
  BUILD         fathom 3.1.4   built 2026-07-14 · 14 days old
```

`3 with no reason recorded` is deliberately in that summary. A suppression is a written record of an
accepted risk (`31` §2.3), and one without a reason is the failure mode the whole suppression design
exists to prevent. Surfacing the count where an operator looks weekly is cheaper than a policy.

### 7.8 `fathom serve` — the offline workspace deployment

Specified in `34` §3.6 and not re-decided. The operational summary:

```text
fathom serve [--port 7440] [--bind 127.0.0.1] [--open]

  Serves the offline bundle from loopback with real response headers.
  No workspace passes through this process. No API. No upload. No proxy. No TLS.
```

| Property | Value |
|---|---|
| Binds | `127.0.0.1` and `[::1]` only. A non-loopback `--bind` is a **startup error**, not a warning |
| `Host` header | Validated; anything else is 421 (DNS rebinding) |
| Files served | From a manifest embedded at build time. There is no filesystem lookup, so there is no path to traverse |
| CORS | None emitted, plus `Cross-Origin-Resource-Policy: same-origin` |
| Headers | `34` §2.2 mode B in full |
| Port | **Fixed by default**, because browser storage is keyed by origin and a random port means a fresh origin and a cold OPFS cache every run. The cost is that another local process can bind 7440 after we exit and inherit our origin, including the cache — which holds ciphertext it could have read off the disk anyway |
| Footprint | ≈8 MB RSS, one idle core |

**This is the deployment for an offline user who wants persistence and the full header set** — the
one D1 gives up in §3.5's trade. The install is "copy one binary", which is a lower bar than Docker
and a higher bar than "open a file", and that gap is exactly the population §3 is about.

### 7.9 Failure modes

| # | Failure | Handling |
|---|---|---|
| D4-F1 | Passphrase needed in a non-interactive context | Exit `5`. Reads from `FATHOM_PASSPHRASE_FILE` (a path, never an environment variable holding the value — environment variables appear in `ps` and in container inspect output) |
| D4-F2 | 5 000-device workspace, memory pressure | `--lazy-provenance` (`17` §13.2), and a named error rather than an OOM kill |
| D4-F3 | Interrupted mid-save | `17` §16.3's atomic write. The workspace is the old one or the new one |
| D4-F4 | Two CLI processes on one workspace directory | Lock file with pid and boot id; the second exits `2` with the holder's identity |
| D4-F5 | Terminal is not a TTY | No colour, no progress, no cursor movement. The three `Risk` values render as their words, never as colour alone — the legend is the content, not the styling |
| D4-F6 | Pack signature fails | Exit `4`. **Never a prompt to continue.** An override needs a separate, explicit flag that names the key fingerprint being trusted |

### 7.10 Threat-model delta

| Delta | Detail |
|---|---|
| **No browser** | The whole of `31` §6.2 — compromised browser, malicious extension, DevTools — disappears. **This is the single largest threat reduction of any mode** |
| **No CSP, and none needed** | There is no DOM, no renderer, no injection sink |
| **A new actor: the CI system** | A pipeline that lints configurations holds those configurations, and its logs hold the findings. `31` §2.2 ranks the findings list *above* the configuration as an asset, so **CI logs are more sensitive than the repository they lint.** Say this in the CI documentation, in those words |
| **A new artifact: `findings.json`** | It is a ranked list of the estate's weaknesses with the syntax to fix each one attached. `17` §15.5's export header exists for exactly this and the CLI writes it into the JSON as a `_warning` key |
| **Passphrase handling on a shared host** | A path, never an environment variable (D4-F1). Argument vectors and environments are readable by other processes |
| **Same envelope, same workspace, same everything else** | Invariant 4 holds identically |

---

## 8. Migration between modes

*margin tab: or these are four products*

> **A DEPLOYMENT MODE YOU CANNOT LEAVE IS A LOCK-IN YOU DID NOT DISCLOSE.**

### 8.1 The matrix

| From ↓ To → | **D1** | **D2 / D3** | **D4** |
|---|---|---|---|
| **D1** | — | §8.3 | Save the packed workspace; open it with the CLI. **Nothing to convert** |
| **D2 / D3** | §8.4 | `fathom sync init --origin <new>` and push. Members re-enrol | Point the CLI at the same directory |
| **D4** | `fathom pack` → open the file in D1 | `fathom sync init` | — |

**Every cell is a file copy or one command, and that is not an accident.** It is the payoff of two
earlier decisions: the workspace is a document, not a database (brief §6.4), and the packed form is a
byte-deterministic function of the directory form (`17` §2.1). If either had gone the other way,
these cells would say "export, transform, import, hope".

### 8.2 The one genuine conversion, and it is small

| What differs between modes | Conversion |
|---|---|
| Packed vs directory form | `fathom pack` / `fathom unpack`. Byte-deterministic both ways |
| Sync membership and client keys | **Not part of the workspace's content.** Added by `sync init`, removed by leaving. A workspace does not know whether it has ever synced, except through the generation counter |
| The AI store (`17` §3) | Carried, and it is inert at tier 0 |
| The OPFS cache | Never migrated. It is a cache |
| Rule packs and corpus pins (`17` §8) | Carried in the workspace. **A workspace that pins `fathom.ipsec@2.9.0` and moves to a build without that pack refuses to lint until it is installed**, rather than silently linting with a different pack |

### 8.3 Worked path: a user starts offline and later joins a team

The realistic story: someone downloads `fathom.html`, uses it for a month, builds three sites, and
then their colleague wants in.

```text
  1  In D1, save the workspace.               site-b.fathom  (packed, one file)

  2  Install the CLI. Unpack.
     $ fathom unpack site-b.fathom -o site-b.fathom.d
     $ mv site-b.fathom.d site-b.fathom          # the directory form; same name (17 §2.1)

  3  Put it under git, if the team wants review rather than continuous sync.
     $ git init && fathom git install && git add -A && git commit
     ── STOP HERE IF GIT IS ENOUGH. Most two-person teams never need step 4. ──

  4  Otherwise, enrol against the sync service.
     $ fathom sync init site-b.fathom --origin https://fathom.corp.example
       enrolment token: ●●●●●●●●
       generated client keypair            fathom:client:01JZQ8…
       signed self into the member list    using K_admin derived from the passphrase
       uploading 211 records / 3,880 frames … 8.1 MB
       generation 1 → 1,204

  5  The colleague, on their machine:
     $ fathom sync clone --origin https://fathom.corp.example --workspace <wid>
       passphrase: ●●●●●●●●            ← mode 1, passphrase-shared (33 §11.1)
```

Step 5 is `33` §11.1's mode 1 and its entire enrolment flow is "type the passphrase". The key-wrapped
mode 2 exists for teams where someone must be removable without a re-key, and it is not on the path
of the common case.

**The four things this user must be told, before step 4 and not after:**

| # | |
|---|---|
| 1 | **Metadata starts existing.** `31` §7's M1–M10 were all inapplicable in D1 and are now live: the server sees that a workspace exists, roughly how big it is, and every time it changes. `33` §12.2's per-record activity map is live from the first push. This is a one-way door for everything already uploaded |
| 2 | **Rollback detection now applies.** Restoring an older copy over a newer one trips the check and needs a typed override (§3.11). Practise it once, deliberately, on the canary |
| 3 | **Removing the colleague later costs a re-key** — a full re-encryption and rename (`33` §3.6), 80 MB at 500 devices — and it does not un-read what they already read (`32` §9.4) |
| 4 | **Suppressions become shared assertions.** A waiver one person recorded is now a waiver the team inherits. That is the design working (`31` §2.3), and it changes the social meaning of the field |

### 8.4 Worked path: a team self-hosts and later air-gaps

The reverse, and it is easier — with one hard part.

```text
  1  Compact first. Otherwise you carry up to 12.6× the bytes you need (33 §9.2).
     $ fathom compact site-b.fathom --all
       compacting 211 records · 6.9 MB → 2.4 MB

  2  Confirm every member has pulled everything they need, because after step 4
     the server is gone and the frames only exist where somebody kept them.
     $ fathom sync status site-b.fathom
       all members current as of 2026-07-28T09:14:02Z

  3  Leave the service. This removes THIS client from the member list; it does not
     delete the server's copy and it does not revoke anyone's key.
     $ fathom sync leave site-b.fathom
     $ fathom pack site-b.fathom -o site-b-airgap.fathom

  4  Delete the server-side copy, deliberately and separately.
     $ fathom sync delete --origin https://… --workspace <wid> --confirm <wid>

  5  Carry site-b-airgap.fathom across on removable media. Carry the artifacts too:
       fathom-3.1.4.html          MANIFEST-3.1.4.txt      MANIFEST-3.1.4.txt.minisig
       fathom.ipsec-2.9.0.fpack   advisories-2026-07-02.fadv (+ .minisig)

  6  On the far side, verify before opening anything.
     $ minisign -Vm MANIFEST-3.1.4.txt -P <published key>
     $ sha256sum -c <(grep fathom-3.1.4.html MANIFEST-3.1.4.txt)
```

**The hard part is step 5, and it is a process problem rather than a tooling one.** An air-gapped
site that carries nothing in learns nothing (`35` §8.4). The workspace crosses once; the advisories
must cross repeatedly, forever, or the install runs a known-defective build indefinitely. The tooling
contribution is that `.fadv` rides the same trip as `.fpack` on the same media with the same
verification, so there is exactly one procedure to maintain rather than two.

**What is lost in the direction D2 → D1**, and it must be said before step 3 rather than discovered
after: multi-writer sync, the OPFS cache, tiers above 0, and — if the destination is D1 rather than
`fathom serve` — persistence without an explicit save, git, and workers. If the destination is
`fathom serve`, only sync and the AI tiers are lost.

### 8.5 The migration that does not exist

**There is no migration from "I only ever used the reference artifact" to anything**, because before
§3.5's decision that artifact held no workspace and therefore produced nothing to migrate. This is
the strongest practical argument for §3.5: under `34` §3.3 as written, a user's first month of work
in the single file is not work, it is reading. Under §3.5 it is a file, and every cell in §8.1's
matrix has something to move.

---

## 9. Operational runbooks for D2 and D3

*margin tab: run this first*

> **CORRELATE BEFORE YOU THEORISE.**

The card's advice for a flapping tunnel is `show system commit` — if the newest commit lines up with
the first flap, you have your answer and it is not PFS. The server equivalent is the deployment log:
**check what changed before you investigate what broke.** Every runbook below starts there.

### 9.1 R1 — Deploy (D2)

```text
  1  Verify the image you are about to run.
       cosign verify --certificate-identity-regexp '…' \
                     --certificate-oidc-issuer '…' ghcr.io/<org>/fathom-sync@sha256:<d>
       # and check the app layer's tar digest against MANIFEST (35 §3.7)
  2  Write compose.yaml with the DIGEST, not a tag.
  3  docker compose run --rm sync init --state /var/lib/fathom
  4  BACK UP server.key and opaque.seed NOW, before anyone enrols.
  5  Install the TLS certificate and key at ./tls. Check the expiry date.
  6  docker compose up -d
  7  docker compose exec sync healthcheck --verbose
  8  From a real client: enrol, create the canary workspace, sync, close, reopen.
  9  Record in the change ticket: image digest, manifest version, TLS expiry date,
     and the sha256 of the served bundle's index document.
```

Step 9's last item is what lets a user later compare what they were served against what was
published (`35` §13.3). Recording it at deploy time costs nothing and is impossible to reconstruct
afterwards.

### 9.2 R2 — Upgrade (D2 and D3)

**D2** — a restart, and it is an outage of minutes that costs users nothing because clients are
offline-first (D2-F7).

```text
  1  Read the release notes for a SCHEMA MAJOR. If there is one, this is not a
     server upgrade, it is a client rollout. Go to R2b.
  2  Back up (§5.7), in the order given. Frames first.
  3  Verify the new image digest (R1 step 1).
  4  docker compose pull && docker compose up -d
  5  healthcheck; then open the canary workspace from a real client.
  6  If it fails: docker compose down, restore the PREVIOUS digest, up -d.
     The frame store is append-only and content-addressed, so a rollback of the
     binary needs no rollback of the data — unless step 1 was wrong.
```

**D3** — rolling, per §6.8, with the canary of §6.8's `commit confirmed 5` shape.

```text
  1  Confirm the migration is expand-phase only. A contract-phase migration must
     be a separate release, one version later. If the release notes do not say
     which phase it is, do not deploy it.
  2  Run the expand Job. It must be safe against replicas on release N.
  3  Deploy ONE canary replica. Watch 10 minutes against §6.8's four thresholds.
  4  Roll the remainder, maxUnavailable: 0, one at a time.
  5  Confirm all replicas report the new build in /healthz.
  6  The contract migration ships in the NEXT release. Do not shortcut it because
     "everything is already on N+1" — a rollback puts something back on N.
```

**R2b — a graph schema major.** Not a server operation.

```text
  1  The server is unchanged. Do not deploy anything.
  2  Announce the client rollout window. Clients that open a workspace on the new
     build migrate it in memory and write the migration on the next save (§3.10).
  3  Clients that were offline across the boundary hit 33 §8.5's quarantine path
     on reconnect. That path needs a human. Staff for it.
  4  Old clients refuse to open migrated workspaces, cleanly, before the KDF runs.
     That refusal is correct behaviour and the support script must say so.
```

### 9.3 R3 — Rotate

Four different things get called "rotation" and they cost wildly different amounts. Getting them
confused is how somebody re-encrypts 80 MB to fix a certificate.

| Rotate | Cost | Procedure | Affects workspace content? |
|---|---|---|---|
| **TLS certificate** | Seconds | Replace the files; `SIGHUP`. No restart, no downtime | No |
| **Session tokens** (force everyone to re-authenticate) | Seconds | `DELETE FROM sessions`. Every client re-authenticates on its next request | No |
| **OIDC client secret** | Minutes | Rotate at the IdP, update the Secret, rolling restart | No |
| **OPAQUE server key / OPRF seed** | **Expensive** — every account re-registers | Only for a suspected compromise of the seed. §9.6 | No |
| **A user's account password** | Seconds | OPAQUE re-registration, or the IdP. **Zero bytes re-encrypted** (`33` §3.1) | No |
| **A workspace passphrase** | ~200 bytes | Re-wrap the workspace key under a new KEK (`32` §9.1) | No — the root key is unchanged |
| **The workspace root key** (a re-key) | **80 MB at 500 devices, plus a full filename rename** (`33` §3.6) | Client-side, by an admin member. The server does nothing and cannot help | **Yes — every record is re-sealed** |

**The two sentences an operator must be able to say from memory:**

> **Nothing the operator rotates touches a workspace. Everything that touches a workspace is rotated
> by a client, using a key the operator has never held.**

### 9.4 R4 — Restore

Covered mechanically in §5.7 (D2) and §6.13 (D3). The runbook adds the parts people get wrong under
pressure:

```text
  1  STOP WRITES FIRST. In D3, scale the app tier to zero. A restore racing live
     writes produces an index that references frames from two eras.
  2  Frames first. Index second. Always. (§5.7)
  3  fsck --index --frames. Key-free, and it is the only server-side check that exists.
  4  Bring up ONE replica. Do not scale out until step 5 passes.
  5  Open the CANARY workspace from a real client. Check the device count and one
     known finding. THIS IS THE ONLY VERIFICATION THAT EXISTS. A restore that has
     not been opened by a client has not been verified, and you cannot verify it
     yourself, ever, by design.
  6  Scale out. Announce.
  7  Tell users what the RPO gap actually was, in wall-clock terms, and tell them
     that any client holding newer frames should run `fathom sync repush`. Most of
     the gap will close by itself, because the clients are the real backup.
```

Step 7 is the one that is easy to skip and is the one that recovers the most data.

### 9.5 R5 — Frame store loss with an intact index

Worth its own runbook because it is the failure the architecture handles unusually well and nobody
expects it to.

```text
  1  Restore from the versioned bucket. Most digests come back.
  2  fsck --index --frames  lists every digest referenced but missing.
  3  Publish that list to clients (it is just digests; it discloses nothing new —
     the index already held them).
  4  Each client runs:  fathom sync repush --missing-only
     Frames are content-addressed and idempotent (§5.5 PutOutcome::AlreadyPresent),
     so this converges with no coordination and no duplicate storage.
  5  Re-run fsck. Anything still missing exists on no client and is genuinely gone.
  6  For those records, clients hold their own state and will re-assert it on the
     next save, because ops are state-carrying (33 §9.4) — a client does not need
     the history a missing frame contained in order to write the current value.
```

Step 6 is the deep property: because ops carry whole values rather than deltas, losing history is not
the same as losing state. That was designed for offline clients and compaction; it pays out here.

### 9.6 R6 — Suspected compromise

*margin tab: what you can honestly say*

> **YOU CANNOT ASSESS THE IMPACT OF THIS BREACH ON CUSTOMER DATA. THAT IS THE DESIGN WORKING. SAY SO
> FIRST, THEN SAY EXACTLY WHAT YOU CAN SEE.**

#### 9.6.1 The first sixty minutes

```text
  1  Preserve. Snapshot disks, take the container's filesystem, copy the logs
     OFF the host before anything else. You will want the artifact digests.
  2  CORRELATE BEFORE YOU THEORISE. What changed? Deployment log, image digest
     history, admin action log (§6.12.5 L6), certificate changes, IdP config.
  3  ANSWER THE ARTIFACT QUESTION FIRST, NOT THE DATABASE QUESTION.
       - What is the sha256 of the bundle currently being served?
       - Does it match the published manifest for the running version?
     An attacker who served altered client code has a path to plaintext, from
     users, going forward. An attacker with the database does not. Triage in
     that order.
  4  If the served bundle does not match: this is the severe case. Take the
     service down. Do not "fix it in place". Users must be told to stop using it,
     by a channel that is not the service.
  5  Rotate: TLS key, session table, OIDC client secret, OPAQUE seed if the state
     volume was reachable. (§9.3 — none of this touches workspace content.)
  6  Redeploy from a verified digest onto a rebuilt host.
```

#### 9.6.2 What was exposed, and what was not — the table to fill in

| Category | Exposed if the server was compromised | Notes |
|---|---|---|
| Workspace plaintext | **No — structurally impossible** | The server never held a key (invariant 4) |
| Workspace keys, passphrases | **No** | Never transmitted in any form |
| Device names, addresses, topology, findings, suppressions | **No** | All inside the sealed bodies |
| Sealed frame bodies | **Yes** — the ciphertext | Useless without a key; `32` §4.6 prices the offline-guess cost against a passphrase |
| Workspace ids, generations, index roots | **Yes** | |
| **Per-record change time series** | **Yes** | `33` §12.2's M8. This is a fine-grained activity map: which parts of an estate were worked on, when, by which client key. **It is the most sensitive thing in this table** |
| Frame sizes (Padmé buckets) and counts | **Yes** | |
| Member client public keys, roles, add/remove times | **Yes** | |
| Account identifiers, `username_hash` | **Yes** | The hash uses a *published* salt — it is obfuscation, not protection (`33` §2.3) |
| OPAQUE registration records | **Yes** | OPAQUE is specifically designed so this does not enable pre-computation against the password |
| Session token hashes | **Yes** | Not usable as tokens (§6.6) |
| Source addresses and access times | **Yes** | Per §6.12.5's retention |
| Quota state | **Yes** | |

#### 9.6.3 What the attacker can do going forward, with what they took

| Capability | Have it? | Detail |
|---|---|---|
| Read any workspace | **No** | |
| Forge a frame that a client accepts | **No** | It would fail its AEAD tag |
| Drop, delay, duplicate or reorder frames | **Yes** | `33` §1.2. Availability and consistency, never confidentiality |
| Serve a stale `generation` (rollback) | **Yes**, and clients detect it — `attest` is signed by a member and clients track the highest generation seen (`33` F1) | The override flow is the thing to warn users about |
| Add a member row directly in the database | **Yes**, bypassing the signature check the API enforces | **It grants write, not read.** The workspace key is wrapped client-to-client; an injected key has nothing wrapped to it. Clients that check the signed member log (`32` §10.3) detect the injection |
| Deny service | **Yes**, completely | Unaddressable by construction |
| **Serve altered client code** | **Yes, if they controlled the served artifact** | **This is the path to plaintext, and it is why §9.6.1 step 3 comes before the database** |

#### 9.6.4 The customer statement

Write it in the card's register: state the governing fact once, then the facts, then what to do. No
reassurance that is not a fact.

```text
  WHAT HAPPENED
  On <date> we identified unauthorised access to <component> of the Fathom sync
  service between <t0> and <t1>.

  WHAT THIS SERVICE HOLDS
  Sealed ciphertext and metadata. It has never held a decryption key, a passphrase,
  or any plaintext from any workspace. This is not a policy; it is the architecture,
  and it is verifiable in the published source.

  WHAT WE KNOW WAS EXPOSED
  · sealed frame bodies (ciphertext)
  · workspace identifiers, sizes, frame counts and generation numbers
  · PER-RECORD CHANGE TIMESTAMPS — a record of when parts of your estate were
    edited, though not what they are or what changed
  · member public keys and the times members were added or removed
  · account identifiers, source addresses and access times
  · OPAQUE authentication records and session token hashes

  WHAT WE KNOW WAS NOT EXPOSED
  · the contents of any workspace
  · any workspace key or passphrase
  · any device name, address, configuration, finding or suppression

  WHAT WE CANNOT DETERMINE, AND WILL NOT CLAIM
  We cannot tell whose data is whose beyond an account identifier, so we cannot
  tell you whether your organisation was specifically targeted. We cannot tell you
  what an attacker inferred from the metadata above. We will not tell you the data
  was encrypted and therefore the impact is nil — the metadata IS impact, and the
  activity map in particular is information about your estate.

  WHAT WE DID
  <artifact check result — the sentence customers actually need>
  · rotated TLS key material, invalidated all sessions, rotated authentication
    secrets, rebuilt the host from a verified image digest <sha256:…>

  WHAT YOU SHOULD DO
  1  Change your Fathom ACCOUNT password. You do NOT need to change your workspace
     passphrase for confidentiality reasons — it was never transmitted.
  2  Open each workspace and confirm its generation is not lower than you expect.
     If it is, do NOT accept the rollback override; contact us.
  3  Run `fathom fsck --compare` against a local copy taken before <t0>.
  4  Review your member list against the signed member log inside your workspace,
     not against what our server shows you.
  5  If your threat model treats a per-record activity map as disqualifying, the
     supported answer is to stop syncing and run offline. We will help you migrate.
```

**Three things that statement deliberately does not say**, and each omission is a decision:

| Not said | Why |
|---|---|
| "No customer data was affected" | Metadata was affected. Saying otherwise is false, and it is the sentence that ends a company's credibility when the activity map turns up later |
| "Your data was encrypted, so there is no impact" | Same |
| "We have completed our investigation" | Say what you know when you know it. `35` §12.6's discipline applies here too |

**And the one it must say if it applies**, in the first line rather than the fifth: *the artifact we
served did not match the published digest between t0 and t1, and any configuration produced during
that window should be reviewed against a known-good build.* That is the only finding in this runbook
that requires customers to re-check work they already did.

---

## 10. What this costs, added up

| Cost | Detail |
|---|---|
| **Four artifacts to test, not one** | Every release runs the cross-host determinism suite (§1.4) on three hosts, plus a container build, plus a compose smoke test, plus a Kubernetes smoke test. That is the price of F1 and F2 being true |
| **Two storage backends** | §5.5. SQLite and PostgreSQL, filesystem and object store, one trait, two sets of bugs |
| **D1 has no crash recovery** | §3.12 F3, and it is the accepted cost of §3.5's decision |
| **D1 re-compiles the WASM on every open** | §3.3. Roughly 300–500 ms, forever, in the mode whose wedge feature is opened ten times a day |
| **The operator can never verify anything about the data** | §5.7, §6.12, §9.4. Every restore drill needs a client with a key; every incident statement has a paragraph beginning "we cannot determine" |
| **No correctness SLO** | §6.12.6. This will be asked for in every enterprise procurement and the answer is a refusal |
| **Compaction is nobody's job and it sets your storage bill** | §6.11. A factor of five to twelve, decided by client behaviour the server cannot influence |
| **No ACME** | §5.3. Somebody will let a certificate expire |
| **A schema major is a client rollout with a human on standby** | §9.2 R2b. There is no server-side migration and there cannot be |
| **An air-gapped install must carry advisories in, forever** | §8.4. Nothing else can reach it, and most sites will do this twice and then stop |
| **Two credentials, two rotations, four things called "rotate"** | §9.3 |

---

## 11. Open decisions

| # | Decision | Options | Leaning |
|---|---|---|---|
| **P-1** | Does D1 hold a workspace, per §3.5, or stay reference-only per `34` §3.3? | (a) §3.5 (b) `34` §3.3 unchanged (c) ship both, as two files | **(a)** — but this is a change to an accepted sibling decision and it is the largest open question in this document |
| **P-2** | `scratch` variant for OPAQUE-only deployments | (a) ship it (b) distroless only | (a). The claim "this image contains no CA bundle" is worth an image |
| **P-3** | Session cache TTL | (a) 10 s (b) 0, always hit the store (c) 60 s | (a). Revisit if the index store shows read pressure |
| **P-4** | Per-workspace metrics for the operator | (a) never (b) an opt-in the customer turns on for their own instance | (a) for a hosted instance; (b) is defensible for a self-hosted one where operator and data owner are the same organisation. **Never for a multi-tenant instance** |
| **P-5** | Does `fathom serve` ever get TLS? | (a) never — loopback is already a secure context (b) optional, for a LAN-local install | (a). (b) is D2 with extra steps and no headers guarantee |
| **P-6** | Is `--baseline` a file in the repository or a workspace record? | (a) file (b) record | (a) for `lint config`, which has no workspace; (b) for `lint <ws>`. Both, and they must not diverge |
| **P-7** | D1's Argon2id `m` floor | (a) 64 MiB (b) 256 MiB as elsewhere | (a), per §3.9, and it is a real weakening that the limits panel must state |
| **P-8** | Retention of full-precision source addresses | (a) 24 h then truncate (b) 7 d (c) never store | (a). (c) makes abuse response impossible; (b) is a metadata store |

---

## 12. Sources

| Claim | Source |
|---|---|
| `gcr.io/distroless/static-debian12` is approximately 1.9 MB uncompressed and contains ca-certificates, tzdata, an `/etc/passwd` nonroot entry and `/tmp` | GoogleContainerTools/distroless project documentation |
| Lowest-tier WebAssembly code generation throughput benchmarks at roughly 50 ns per code byte, ≈160 Mbps single-core, as a cross-implementation figure; SpiderMonkey generates code about twice as fast as V8 in both tiers | Andy Wingo, *understanding webassembly code generation throughput*, 2020. **Dated; measure before quoting** |
| V8's Liftoff is a one-pass baseline compiler emitting code at "tens of megabytes per second"; modules are compiled by Liftoff first and re-compiled by TurboFan in the background | V8 blog, *Liftoff: a new baseline compiler for WebAssembly in V8*; V8 docs, *WebAssembly compilation pipeline* |
| Maximum JavaScript string length: ≈2²⁹−24 in V8, 2³⁰−2 in SpiderMonkey, 2³¹−1 in JavaScriptCore | MDN, `String: length`; engine documentation |
| `fetch` against a `file://` URL is refused because local files are treated as opaque origins, so `WebAssembly.instantiateStreaming` cannot be used from a local file | MDN, *Reason: CORS request not HTTP*; MDN, `WebAssembly.instantiateStreaming()` |
| `wasm-opt -Oz` typically reduces Rust-generated WebAssembly by 10–30 % over LLVM output; `opt-level="z"`, `lto`, `codegen-units=1`, `panic="abort"` are the size-relevant profile settings | Rust and WebAssembly book, *Shrinking .wasm Size*; and `35` §3.6, which pins the tool and flags |
| BuildKit `rewrite-timestamp=true`, `ARG SOURCE_DATE_EPOCH`, the base-layer rewrite issue, and the content-vs-byte reproducibility distinction | `35` §2.2, §3.7 |
| Deployment modes A–E, per-mode CSP, the `<meta>`-discarded directives, `'wasm-unsafe-eval'`, Trusted Types, the storage decision, the worker topology, input caps, the mode A/B artifact split and its four costs | `34` §§2, 3, 4, 7 |
| Nine sync operations, OPAQUE, the account/workspace credential separation, the OIDC enterprise path, member-list weakness, quotas and limits, compaction and its growth arithmetic, metadata channel M8, failure modes F1–F10 | `33` §§1, 2, 3, 9, 10, 11, 12, 13 |
| Workspace directory and packed forms, the deterministic archive, plaintext header fields, size budgets, atomic writes, `fsck`, the export header | `17` §§2, 3, 13, 15, 16 |
| Artifact register A1–A11, the release contents, the update channel per mode, staleness versus age, the advisory bundle, `fathom verify`'s exit codes | `35` §§2, 7, 8, 13 |
| AI tiers 0–3, what tier 0 is, the single-file build's tier ceiling | `21` §7 |
| Finder index size and the 4/3 base64 cost; the golden query set | `16` §§9.4, 9.6 |
| Explainer corpus compressed and base64 sizes at v1 and v2 | `15` §15.2 |
| Findings outrank configuration as an asset; metadata channels M1–M10; the limits panel; residual scale | `31` §§2.2, 6.8, 7 |
| `perfect-forward-secrecy keys group14`; PFS on one side and absent on the other fails Phase 2 while Phase 1 stays up; the six-object chain; the five plumbing pieces; `host-inbound-traffic system-services ike` and "Miss #3 and Phase 1 times out with nothing useful in the log"; DPD 10 × 3; the bring-up ladder and "stop at the first failure"; the MTU tell-tale symptom and `tcp-mss ipsec-vpn mss 1360`; "the SA proves crypto, not reachability"; "correlate before you theorise"; `commit confirmed 5` | Owner's SRX IPsec field card, sides 1, 2, 3 and 4 |

---

## 13. Proposed amendments to other documents

**A1 — `34` §3.3, the artifact split.**
*The text:* the reference artifact contains "No workspace, no passphrase entry, no envelope code, no
ciphertext, no storage."
*The objection:* the rule that generates the split — *we do not put a secret behind a policy we
cannot deliver* — governs secrets **at rest in the artifact's own storage**. An artifact that uses no
browser storage at all has no such secret. §3.4 shows the residual delta is three items, two of which
are post-compromise channels.
*Proposed replacement:* §3.5's decision, with §3.8's no-storage rule as a CI-enforced invariant and
§3.9's two platform mitigations as prerequisites. `34` §3.4's four costs are re-priced by §3.13.

**A2 — `34` §2.1 and `21` §7, the mode lettering.**
Retire `A`–`E` in favour of `D1`–`D4` plus "`fathom serve` mode", per §1.1. A reader with both
documents open currently cannot distinguish "mode B" from "D2" without a mapping table.

**A3 — `21` §7.0, the single-file row for tier 2.**
*The text:* single-file build, tier 2: "2a yes".
*The objection:* with no browser storage (§3.8), multi-gigabyte weights are re-selected and
re-uploaded to the GPU on every open. Technically available, practically unusable.
*Proposed replacement:* "2a technically available, not supported — no weight caching without an
origin."

**A4 — `35` §13.2's illustrative artifact size.**
`SIZE 28,114,552 bytes` in the worked `fathom verify` output is roughly four times this document's
itemised budget (§3.2). One of the two is wrong and the number reaches published material. Reconcile
before either is quoted.

**A5 — `33` §15, add an open decision.**
The observability position in §6.12.4 (no workspace-id metric labels, ever) constrains what an
operator can be given, and `33` does not currently say anything about the operator's telemetry being
a second metadata store. Add it to that document's metadata section by reference.

---

## 14. Disagreements

### 14.1 The conventions pin no residual-risk scale, and three documents now use one

`31` §14.3 already raises this and proposes a four-value scale; `33` §13 adopts it explicitly. This
document uses `none` / `bounded` / `material` in §3.12, §5.8 and §7.9 for the same reason: without a
pinned scale every author invents one and the documents stop composing.

**Objection:** the conventions pin the three-value `Risk` enum with great care and then leave the
residual scale unpinned, so the one scale that appears in every security-adjacent document is the one
with no definition.

**Proposed replacement:** pin `none | bounded | material | unmitigated` in `conventions.md`, with the
explicit note — as `31` §1.4 already insists — that it is **not** the `Risk` enum, must never use the
three `Risk` colours, and is rendered in neutrals.

### 14.2 The conventions have no term for a deployment shape, and this document had to invent one

`34` calls them modes A–E, the brief names three by description, `35` calls them by artifact number,
and this document pins D1–D4. Four vocabularies for one concept, across four documents, all of which
cross-reference each other.

**Proposed replacement:** add to the terminology table:

| Term | Means | Never say |
|---|---|---|
| **deployment mode** | one of the four shapes the product ships in: `D1` offline, `D2` single node, `D3` cluster, `D4` CLI | "edition", "tier" (that is the AI layer), "version" |

### 14.3 Invariant 1 is about the application, and the server needs the same sentence

Invariant 1 says the *application* never opens a connection the user did not configure. It says
nothing about the sync service, which in the OPAQUE configuration opens none and in the OIDC
configuration opens exactly one. §6.10's NetworkPolicy is the enforcement, and it is currently a
convention this document invented rather than an invariant anything holds it to.

**Proposed addition to invariant 1:** *"The sync service opens no outbound connection except, where
OIDC is configured, to the operator's identity provider. This is enforced by a default-deny egress
policy shipped with the deployment manifests, and its absence in a deployment is a finding."*

I do not disagree with any convention as written. The three entries above are gaps rather than
errors, and every convention in `conventions.md` is obeyed in this document as it stands.
