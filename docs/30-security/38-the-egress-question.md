# 38 — The egress question

> **Status:** Proposed

This document is the companion to `31-threat-model.md` and the security-side counterpart to
`03-non-goals-and-scope.md` §§3–5. `31` models what an attacker can do to Fathom as it is
specified. This document models what Fathom would become if the one property `31` §1.5 calls the
largest single security effect in the product were traded away, and what each possible trade
costs. `36-enterprise-review-qa.md` is where the same material is stated to a customer; `75` §6
is the pattern this document copies.

**The governing rule of this document, stated once, in caps, at the top:**

> **NOTHING IN THIS DOCUMENT IS APPROVED, SCHEDULED OR DESIGNED. IT IS A PRICE LIST. A READER
> LOOKING FOR PERMISSION TO CONNECT FATHOM TO ANYTHING WILL NOT FIND IT HERE, AND THAT IS THE
> DOCUMENT WORKING CORRECTLY.**

The reason it exists is narrow and worth stating plainly. The owner has described a future in
which Fathom might connect to things, explicitly gated on having earned it first. A gate that
lives only in a conversation is not a gate. Without a written statement of what the promise is
worth and what each way of breaking it would cost, that future does not arrive as a decision —
it arrives as a sequence of individually reasonable pull requests, each one small, each one
defensible, and the property is gone before anybody notices it was being spent.

§2 is what is true today. §5 is the ladder and it is the heart of the document. §6 is the one
section to read if you read nothing else. §13 is where the author says what he actually thinks.

---

## 0. Contents

| § | |
|---|---|
| 1 | What this document is, and the four things it is not |
| 2 | The promise today, and how each clause of it is enforced |
| 3 | What the promise buys |
| 4 | The owner's stated future, quoted, and the trust gate — and §4.6, the source-of-truth answer |
| 5 | The capability ladder — E1 to E6, least to most dangerous |
| 6 | The line — the rung that ends "no reachability" |
| 7 | What is already designed for a connected future |
| 8 | The boundary pattern — how a connected capability would have to be shaped |
| 9 | The gate conditions, written as things someone could check |
| 10 | Failure modes |
| 11 | Open decisions |
| 12 | Sources consulted |
| 13 | Disagreements |

---

## 1. What this document is, and the four things it is not

### 1.1 What it is

A price list, in the sense a structural engineer means: a statement of what each load would cost
the structure, written before anybody proposes adding one. Each rung in §5 carries the same seven
fields — what it requires, which invariants it breaks, which ship gates it deletes, the blast
radius if the instance running it is compromised, whether it is reversible, whether a third party
is needed, and what the no-egress alternative delivers and fails to deliver.

### 1.2 The four things it is not

| Not | Because |
|---|---|
| **A roadmap** | No rung has a phase, a week, a trigger date or an owner. `76` has already re-sequenced the build order; a second sequence written here would be a competing specification, which ADR-0001's precedence rule forbids. No effort estimate appears below, and the one sub-week figure in §13.4 is marked as the author's own guess rather than sourced to `71` |
| **A design** | Nothing below specifies a type, a wire format, an API surface or a component boundary for any rung. Where a rung has already been designed elsewhere, §7 cites it and says how stale it is |
| **A recommendation** | §5's `cheaper no-egress alternative` column is analysis, not advocacy. The same fence `75` §6.4 puts around its adjacent pattern applies to every entry in that column: **an alternative is not the answer, and calling it the answer would be answering on the owner's behalf** |
| **A relaxation of anything** | Invariants 1–4 are unchanged by this document. `03` §10 is the only route to changing any of them and this document is not part of it |

### 1.3 The one fact that reframes everything below

`README.md`, line 3: **"This repository contains no code."** And: *"Status: planning. Nothing is
committed to code."*

Every gate named in §2 — X0.8, X0.9, H39, E13, E14, the fourteen checks in `42` §9.4 — is a
**specified** gate. None has ever run, because there is nothing to run it against. Throughout
this document the correct verb is *would be enforced by*, never *is enforced by*, and where the
distinction changes an answer it is marked.

This is not pedantry. It is the difference between "the floor is poured" and "the floor is
drawn", and §9's gate conditions are written on the assumption that the floor gets poured first.

---

## 2. The promise today, and how each clause of it is enforced

### 2.1 "Does not connect" and "cannot connect" are different claims

The two are used interchangeably in conversation and they are not the same. Precisely:

| Claim | Means | Falsified by |
|---|---|---|
| **Does not connect** | No code path in the shipped artifact originates a request, and a test confirms it over an observed session | One code path that was not exercised by the test |
| **Cannot connect** | No arrangement of the shipped code *could* originate a request, because the capability is absent from the execution environment | Nothing short of a different artifact |

**Fathom makes the "cannot" claim for exactly one component and the "does not" claim for
everything else.** The WASM core cannot originate a network request, because a WASM instance has
no ambient authority — everything it touches, it touches through an import the host supplies —
and the committed import allowlist is two entries, neither of them network-capable. That is a
"cannot". The TypeScript UI runs in the same origin and `fetch` exists in its global scope; the
controls there are a policy header and a lint rule, which are "does not".

Stating this correctly matters more than it appears to, because the strongest sentence in the
corpus is one an enthusiastic reader will quote wider than it holds. **`34` §7.5's claim is about
the core, not the product.**

### 2.2 The guarantees, each marked by what kind of thing it is

Three kinds, and the distinction is the whole table:

- **Architectural property** — true because of the shape of the thing. Cannot be violated by a
  code change without also changing the shape, which is visible.
- **Build gate** — true because a check runs and fails the build. Can be violated by deleting the
  check, which is one PR.
- **Policy** — true because we said so. Can be violated by anybody, at any time, silently.

| # | Guarantee | Kind | Mechanism | Where |
|---|---|---|---|---|
| G1 | **The WASM core contains no import capable of originating a network request.** Allowlist is `fathom_entropy` and `fathom_now_ms` | **Architectural property**, scoped to the core, with a build gate proving it | `wasm-objdump -x fathom_core.wasm`, import section compared against a committed list | `34` §7.5, CI form at §10 H39; allowlist contents at `42` §9.4 check 5; also `31` §12 |
| G2 | **The shipped artifact's CSP contains `connect-src 'none'`**, asserted against the final bytes rather than the template | **Build gate** | Ship gate X0.8, run by `xtask assemble`; re-asserted for later phases as X6.7 | `71` §3.6; `03` §3.5 `T-P3-a`; `34` §10.1 H3 |
| G3 | **No network request is issued in a 30-minute scripted session**, verified by a proxy that fails the test on any connection attempt | **Build gate**, and the best-designed one in the corpus | Ship gate X0.9; implemented as `45` §13.4 E13 (CDP interception, cross-checked against `performance.getEntriesByType('resource')`) and E14 (network namespace, no route, no DNS) | `71` §3.6; `45` §13.4; `03` §3.5 `T-P3-c` |
| G4 | **The application never touches a network device.** No SSH, NETCONF, gNMI, vendor API, SNMP or serial. A total compromise yields no reachability | **Architectural property by absence in the design; policy in enforcement terms today** — see §2.4 | Absence of any transport code or transport-capable dependency. Specified enforcement: `03` §3.5 `T-P1-a` (denylist against the *resolved* dependency graph), `T-P1-b`, `T-P1-c` | Invariant 2; `03` §3.1 `N-P-1`; `31` §1.5 |
| G5 | **The application stores no device credential** — no PSK, certificate private key, SNMP community, TACACS key or device password. Emitted config uses placeholders | **Build gate**, plus one architectural property: the ingest gate takes a redacted newtype, so there is no unredacted path to the encryptor | `03` §3.5 `T-P2-a` (golden-output regex set), `T-P2-b` (no credential-family `<input>`), `T-P2-c` (parse-time redaction, fixture with a real-shaped PSK, an SNMP community and a TACACS key) | ADR-0002's replacement text for invariant 3; `03` §3.2 `N-P-2` |
| G6 | **No third-party JavaScript at runtime and no runtime fetch of anything, from anywhere, in any mode** | **Build gate** | `42` §9.4's fourteen checks. Load-bearing: check 1 (no `node`/`npm`/`npx` in the container), check 2 (no `package.json`, no lockfile, no `node_modules`), check 3 (hermetic build — stages run with no route, a fetch attempt fails the build), check 7 (bundle scanner: every `src`, `href`, `url()`, `@import`, `new URL()` resolves to `data:` or a relative path), check 8 (`strings` scan) | `34` §8.1–8.3; `42` §9.4 |
| G7 | **No telemetry, analytics, crash reporting, font CDN, update ping or version check** — structurally, not by default | **Build gate**, falling out of G3 | `34` §8.2 states the register as *"none. Invariant 1. Not 'off by default' — absent"*. `03` §3.3 refuses each proposal by name, including the version check: *"Genuinely valuable and genuinely refused. A version check is a beacon"* | Invariant 1; `03` §3.3; `71` §3.7 |
| G8 | **D1 — the offline single file — has no origin, no server, no browser storage of any kind, and an AI tier ceiling of 0** | **Architectural property for origin, storage and the tier ceiling; the integrity clause is a `material` residual (`34` §11 B10)** — see §2.3 | The shape itself, for the first three. Opaque `file://` origin, no OPFS/IndexedDB/Cache/localStorage/cookies/service worker. Separately: the inline `<script>` is pinned by SHA-256 in `script-src`, which defeats modification of the script **without a matching modification of the policy**, and defeats nothing else | `43` §2.1, §3.14; ADR-0017; the integrity clause's limits at `36` Q18, `34` §11 B10, `34` §2.11 channel 6, `31` §5.1 row 10 |
| G9 | **The server never holds a key.** Zero-knowledge; ciphertext and metadata only | **Vacuous by absence today; policy for the future** | Nothing, because there is no server in what ships. ADR-0016: v1 and the product ship a workspace file plus git. `33` carries `Status: Proposed` | Invariant 4; `03` §3.4 `N-P-4`; ADR-0016 |
| G10 | **No governance process may authorise a release that touches a network device, accepts a credential, opens an unconfigured connection, or places a key on a server** | **Policy**, with a governance cost attached | `03` §10.2 places `N-P` outside what any governance body may authorise; §10.3's only route costs a **new name** | `74` §13.3; `03` §10.2–10.3 |

### 2.3 What each row is worth, honestly

**G1 is the strongest item in the corpus and the only one that is checkable by a stranger in one
command with a tool the project did not write.** `34` §7.5's own words: *"**No import may be
capable of originating a network request.** This is the check that makes `connect-src 'none'` an
architectural property rather than a header."* Read the scope: it is the check that makes the
CSP architectural *for the core*. It says nothing about the UI.

**G2 is weaker than it reads, and `34` says so in a formal Disagreement filed against invariant 1
itself.** `34` §13.1 records that `connect-src` governs fetch-type requests only. `34` §2.11
enumerates eight channels that survive the strictest policy in that document; channels 1 and 2 —
top-level navigation with data in the URL, and `window.open` — are closed only by the `sandbox`
directive, and `<meta>`-delivered policies discard `sandbox` (`34` §2.8). **So D1, the build the
invariant is proudest of, is precisely the build where the invariant's stated mechanism is
weakest.** `34` §1.2 J3 states what the directive actually buys, and it is the honest sentence:

> `connect-src 'none'` *"is not primarily a runtime control — an attacker with code execution has
> other ways out (§2.11). It is primarily an **auditable statement in the artifact** that a
> reviewer can check in ten seconds and that CI can enforce on every build."*

**G3 is the best-designed gate here** because of three rules `45` §13.4 imposes on it: no
allowlist in mode A at all, not for a favicon or a source map or a report endpoint; two
independent instruments, because a single instrument that can be misconfigured is a single point
of failure for the claim the whole product rests on; and E13 runs the **release** artifact, not a
dev build. `03` §3.5 flags its sibling `T-P3-c` as *"the one that will be tempting to skip because
it needs a browser and a proxy"* and *"the only test that checks the property the way a user
checks it"*.

**G8's script-hash clause is the one place in this table where the corpus argues with itself, and
the row is split for that reason.** `34` §2.5 states it at its strongest — *"the CSP hash is
subresource integrity for inline script […] A tampered single file does not run"* — and `43` §3.14
carries the same sentence. Four other places qualify it, all in the same direction, and any
restatement that drops them overstates the guarantee:

| Where | What it says |
|---|---|
| `36` Q18, in its own "what this does not prove" table | *"That a tampered artifact would have failed the test \| **A tampered artifact ships whatever CSP it likes.** That routes back to signatures and reproducible builds, not to this procedure"* |
| `34` §11 B10 | *"A tampered build ships whatever policy it likes"* — residual tagged **`material`**, closable *"never — reproducibility is the answer and it needs an independent rebuilder"* |
| `34` §2.11 channel 6 | *"The policy is **in** the artifact. An attacker who can change the artifact changes the policy first"* |
| `31` §5.1 row 10 | `bounded` — *"a **tampered** build can ship any CSP it likes, which routes this threat back to rows 7 and 9"* |

`43` §5's F8 reconciles the two: the hash *"is D1's one genuine security advantage over the served
build"*, and its residual is *"an attacker replacing the file rewrites the policy too, **which is
why the published hash matters**"*. So the clause is real against an attacker who can alter the
script but not the policy — a truncated download, a partial patch, a proxy rewriting one element —
and worth nothing against one who replaces the file. The origin, storage and tier-ceiling clauses
of G8 are architectural. This one is not, and it should never be quoted as though it were.

**G9 is true the way "no aircraft in this hangar has crashed" is true.** It should be stated
plainly rather than counted as a live guarantee.

**G10 is the strongest non-technical guarantee here and the one most relevant to §4's trust
gate**, because it is what converts "earn the right to connect" from a decision into a cost. It
is also one line away from violation in the ordinary sense; what it buys is that the violation is
expensive and public rather than cheap and quiet.

### 2.4 The gap in G4, stated because it is the largest one found

`03` §3.5 states: *"**A boundary with no test is `N-P` in name only.** These live in `45` and run
on every PR"*, and enumerates fourteen tests `T-P1-a` … `T-INV`.

**None of those IDs appears anywhere in `45-testing-strategy.md`.** Functionally overlapping
checks do exist — `45` §13.4 E13/E14, `42` §9.4's fourteen checks, `34` §8.3, `31` §12 — but
`T-P1-a`, the denylist of network-capable crates checked against the *resolved* dependency graph
rather than the manifest, has no counterpart. That is the single check that would stop a
transitive crate pulling in a socket, a TLS stack or an SSH implementation, and it is the check
that would make invariant 2 architectural rather than aspirational.

The strength of invariant 2 today rests on the fact that nobody has written any code at all.
That is not the same thing as a gate, and a ladder built on the assumption that these gates exist
is standing on a floor that is drawn but not poured.

### 2.5 The invariant a reader will quote is stale

`.context/conventions.md` line 35 still reads **"The application never accepts a credential."**
ADR-0002 (Accepted) replaced that sentence with:

> **"The application stores no device credential."** No PSK, certificate private key, SNMP
> community, TACACS key or device password […] A pasted capture may *contain* a credential; it is
> redacted at the ingest gate and the unredacted text never reaches the encryptor (`14` §9.9).

ADR-0002's Decision says *"This is one edit to `conventions.md`, made once"*. **That edit has not
been made.** Invariants 1, 3, 4, 7 and 9 each have two authoritative texts in this repository
right now. ADR-0001's `docs/00-vision/01-ownership.md` does not exist either, and its precedence
rule is not in `conventions.md`.

This document quotes ADR-0002's text as current. Anyone quoting invariant 3 externally should do
the same, and should fix `conventions.md` first — `31` §11 R15 already flags the requirement:
*"Revisit when: Before invariant 3 is quoted in any external material."*

### 2.6 Two attribution corrections, because this document will be read by the owner

1. **"The single best security decision in the design" is `31` §1.5's own judgement, not the
   owner's.** The owner's sentence, `.context/owner-brief.md`, is: *"This removes the
   highest-value secret from the application entirely and shrinks the threat model more than any
   cryptographic control."* `31` quotes that and then adds its own assessment. Attributing the
   stronger phrase to the brief would be exactly the kind of drift `31` §10 exists to prevent.
2. **`31` §1.5 concedes a crack in the same paragraph and any restatement omitting it will be
   caught:** *"There is one crack in invariant 3 and §14 names it: at tier 1 the application does
   accept and store a provider API key."* Under ADR-0020 no model and therefore no tier-1
   deployment ships in v1, but the crack is in the text and should travel with the claim.

---

## 3. What the promise buys

Not "security" in the abstract. Five specific things, each of which disappears at a nameable rung
in §5.

### 3.1 There is no credential store to steal

`31` §1.5, invariant 3's row: *"Every attack whose prize is a PSK, a certificate private key, an
SNMP community, a TACACS key or a device password. The application has none to lose."* Emitted
config reads `pre-shared-key ascii-text "<PSK>"` and the engineer pastes the real value into
their own terminal. An attacker who owns the machine, breaks the passphrase and reads the whole
decrypted workspace gets a map. They do not get a key.

**And the clause ADR-0002 says must travel with that, verbatim, because this is the section that
prices the promise.** ADR-0002's Negative section, on the amended invariant 3:

> *"Every amended invariant is weaker than the sentence it replaces, and the weaker sentences are
> the true ones. […] `14` §9.9's own imperative says it plainly:* `FATHOM DOES NOT KEEP YOUR KEYS.
> IT STILL SEES THEM FOR AS LONG AS THE PASTE TAKES.` ***That sentence now has to be said out
> loud.***"

Its scope, from `14` §9.9, so the concession is bounded rather than either dropped or inflated. The
window is one ingest, it is transient, and every reader of it is an attacker `31` §6 already places
out of scope: *"A compromised browser reads it… A malicious extension with host permissions reads
it… A devtools breakpoint reads it… The JS string that fed WASM **cannot be zeroed**"*. `14` §9.9's
own conclusion is the sentence a restatement must not omit: **redaction is *"not a confidentiality
control"*; it is *"a retention control"***, and what it changes is the secret's lifetime *"from
indefinite to the duration of one ingest"*.

**That is what §3.1 is actually pricing.** `14` §9.9's second table — the PSK never written to the
workspace, never committed to git, never in field history, never in an export, a support bundle or
a stolen laptop — is the value. The three seconds of a paste is the cost, and it is stated here
rather than in a footnote because ADR-0002 requires it to be.

**Lost at:** E4, E2, E5b, E3a.

### 3.2 There is no reachability to inherit

`31` §1.5, invariant 2's row, verbatim:

> *"Every attack whose prize is a live session to a network element. There is no SSH client, no
> NETCONF stack, no credential store, no jump path. **A total compromise of Fathom yields no
> reachability.**"*

That sentence is not one claim among many. It is quoted in three rendered design studies under
`design/concepts/` and it is the thing `58` treats the UI as forbidden to contradict. It is the
product's security identity in one line.

**Lost at:** E4, E2, E5b, E3a. §6 is about nothing else.

### 3.3 There is no telemetry to subpoena, to leak, or to be asked for

`34` §8.2 states the register of third-party services as *"none. Invariant 1. Not 'off by default'
— absent."* There is no event stream, no crash corpus, no funnel. The cost is paid in the same
document that states the benefit — `71` §3.7: *"**You cannot measure adoption.** Invariant 1
forbids telemetry, analytics and error reporting, structurally and permanently. There is no
funnel, no DAU, no retention curve, and there never will be. This is a real cost of the security
posture and it should be stated in the same breath as the benefit."*

What it buys is that there is no answer to give a subpoena, no dataset to breach, no retention
schedule to argue about in a DPA, and no quiet accumulation that becomes a liability three years
later. `37` is short in the places it is short for this reason.

**Lost at:** any rung that ships an origin, which begins at E1.

### 3.4 A stranger can verify the claim by reading the artifact's own bytes

This is the property most likely to be undervalued internally and most likely to be the reason
the tool gets onto a locked-down laptop.

`34` §1.2 J3's success criterion is *"An enterprise reviewer with `curl -I` and DevTools confirms
items 1, 2, 3 and 7 without our help."* `36` Q12 is a forty-minute canary procedure a reviewer
executes on a running instance — *"no cooperation from us"* — and `36` Q17 is a five-minute
no-egress procedure in the same form. `34` §7.5's import check is one command against a file the reviewer already has.

A security claim you have to be trusted for is worth much less than one that can be checked. The
offline artifact's claim can be checked, by someone who does not like us, in an afternoon.

**Lost at:** partially at E1, because `36` Q13 already concedes that the procedure proves the
deployment you ran and not a hosted one. Wholly for any capability whose behaviour depends on a
remote party's conduct.

### 3.5 The enterprise review is short because the answers are structural

The difference between *"we do not send your data anywhere"* and *"the artifact has no import
capable of originating a request, here is the command"* is the difference between a conversation
and a check. Most of `36`'s length is spent explaining why the answers are boring. That is the
asset.

Two of `36`'s own disciplines are what keeps it credible and both are worth preserving into any
future version: Q18 asks *"what does that procedure not prove?"* and Q13 answers *"does this prove
the hosted service behaves the same way? **No.**"* `31` §10.2's instruction on the review pack
applies here too: *"The temptation in review will be to add 'but' to the end of that. **Do not.**"*

---

## 4. The owner's stated future, quoted, and the trust gate

### 4.1 What was said

**Provenance, stated first, because §4.2's entire trust-gate reading is parsed out of two passages
and neither is in a file.** Both are *"Owner, in conversation"*. Neither appears anywhere else in
this repository — not in `.context/owner-brief.md`, not in any document, not in any ADR — so a
reader cannot check either one by grep, and §12 carries a row for each in `75` §15's form. This
document is the only record. `75` §15 sets the standard being followed here, including its
discipline of marking a paraphrase as a live defect rather than citing it as a quotation.

Verbatim, and it is the source of authority for this document existing at all:

> *"in regards to your thoughts on staleness, that's just because this is essentially a demo very
> that is more important to have security because of it. eventually having a shared synced
> database, with load balancing and other solutions as an option will be the goal but would
> require such a massive amount of security and probably even 3rd party vendors involved in such
> a thing.*
>
> *then there is also the face I'd like to add monitoring to it, and even perhaps the ability to
> use the info from those engines to try to pull configs down and back them up.*
>
> *we could add snmp, integrations with active director or tacsis, one login, we could do a bunch
> of things which would all be far reaching and only if they think you've developed a current
> secure foundation that is incredibly useful."*

### 4.2 What it does and does not change

Earlier, and emphatically: *"Fathom is not a ssh client, it will not connect to anything ever!"*
That instruction shaped several documents and at least one rendered design study.

> **A caveat on that sentence, and it is load-bearing.** It is recorded here as a verbatim
> quotation from conversation and it exists nowhere else in the repository. If it is in fact a
> reconstruction rather than a transcript, the reading below is built on a paraphrase, and `75`
> §15's rule applies: that is a live defect, not a citation. **Whoever can check it against the
> original should, and should correct this line rather than leaving the quotation marks to do work
> they may not be entitled to.** The substance is corroborated independently — invariant 2,
> `03` §3.1's `N-P-1` and `31` §1.5 all say the same thing in files — so the *boundary* does not
> rest on this sentence. Only the reading of the owner's *intent* does.

**It has not been reversed.** Read the governing clause of the later statement: this happens
*"only if they think you've developed a current secure foundation that is incredibly useful."*
Connected capability is described as a later goal, conditioned on a foundation existing first,
expected to require *"such a massive amount of security"*, and framed as something a third party
would have to be satisfied by. The current build is *"essentially a demo"* and security matters
**more** because of that, not less.

The reading this document takes from that — a **restatement of the owner's condition**, not an
instruction issued by this document, and not a licence for anyone to act on any of it:

> **The offline foundation comes first. The right to connect is earned, not scheduled. And the
> constraint that follows for *whoever eventually decides* is that a later decision must remain
> possible rather than be foreclosed — which is a constraint on how the offline work is shaped,
> not a reason to start any connected work.**

> **THIS IS NOT AN INSTRUCTION TO BUILD ANYTHING, INCLUDING A BOUNDARY.** Read as a task list it
> says: build the offline foundation, and there is nothing else on it. "Earning it later is
> possible rather than retrofitted" is discharged entirely by **not doing** things — not putting a
> connection behind a runtime setting, not letting the sync build become the development default
> (§8.3 B1–B2, F6 in §10). It is discharged by declining, not by shipping. Nothing in §7's
> inventory, §8's shape or §9's gates converts this sentence into permission, and §5's rungs are
> every one of them NOT APPROVED regardless of how well the foundation goes.

That is a trust gate, not a feature flag, and the distinction is the whole of §8.

### 4.3 The owner's inference about the demo stage is correct, and the corpus supports it

There is no "demo mode", "pilot build" or "pre-release posture" anywhere in the corpus. What
exists instead is four things that together define the current posture precisely:

| | What it says |
|---|---|
| **ADR-0006** | *"v1 is phase 0 alone"* — a command reference that closes the vocabulary gap, offline, deterministically. *"Nothing about a graph."* It explicitly forbids calling that "v1 of a network engineering platform" |
| **ADR-0004** | The repository becomes public at the phase-0 release, with full history. *"Development in a private repository until there is something reviewable is not secrecy; it is not publishing a half-verified command as though it were verified."* Its Negative section: *"Publishing with full history publishes the mistakes"* |
| **`71` §3.7** | The closest thing to a pilot posture: *"A named pilot group — 8 to 12 engineers, at least 3 outside the project. What it tells you: whether they open it unprompted in week 3. **Ask; do not infer.**"* |
| **`71` §12** | Nine kill points, one per phase plus two global. The corpus already assumes this may not become a shipped thing |

At this stage the security posture is the only property that is fully specified and the only one
a stranger can check before there is a product to judge. Making it stronger while there is nothing
to lose is cheap; making it stronger after a connected capability has shipped is not.

### 4.4 The tension between the owner's gate and the corpus's gate — named, not resolved

These are two different gates and they must not be quietly merged.

| | The gate | Where |
|---|---|---|
| **The owner's** | Security **and** usefulness. *"only if they think you've developed a current secure foundation that is incredibly useful"* | §4.1 |
| **The corpus's** | Security only. An amendment issue must argue *"why the boundary is wrong — **not** why the feature is useful. **Usefulness is assumed**"* | `03` §10.1 step 1 |

`03` §10.1 rules usefulness out of the *argument* deliberately, because "but it would be useful"
is the universal solvent for boundaries and every refused proposal in `03` §4 is useful. The
owner's formulation puts usefulness back in as a *precondition* rather than as an argument, which
is a different move and a defensible one: it says the foundation must be worth trusting before
anyone is asked to trust it further.

**RECOMMENDATION — treat them as sequential rather than competing.** Usefulness is a gate on
whether the conversation happens at all (§9 G-U). The boundary argument, if the conversation
happens, still may not cite usefulness. That reading satisfies both texts and is how §9 is
written. It is recorded here as a reading, not as a decision; D-38.4 in §11 leaves it open.

### 4.5 The staleness remark, and the answer the corpus already has

The owner's staleness concern and the corpus's `T-freshness` test are asking the same question and
reaching for opposite tools. He reaches for a connection. The corpus reaches for a date.

`03` §5.3's patch to the scope rule: *"If a feature's value depends on the input being fresh, it
is monitoring wearing a paste button. `T-freshness`: a review question, not a CI test — does this
feature get worse if the input is a week old?"*

`35` §8.3 has the resolution already written, and it is the single most reusable paragraph in the
corpus for this conversation:

> *"The distinction between "I am 128 days old" and "I am out of date" is exactly the distinction
> the field card draws between a tunnel reading `UP` and a tunnel passing traffic. The first is a
> fact about the local object. The second is a claim about the world that the local object is not
> in a position to make."*

`35` §8.3's two-column table of what the app may and may not say, and `03` §9.6's placement of
provenance-age display *in* scope on the grounds that *"it states when we learned something, never
whether it is still true"*, are the offline answer to staleness. They are not a substitute for
monitoring and are not offered as one. They are a substitute for the specific worry that a user
cannot tell how old a fact is.

**§4.6 is the reason that answer may no longer be sufficient, and it should be read immediately
after this section.**

### 4.6 The source-of-truth answer, which moves three arguments in this document

`77-service-model-requirements.md` §10 records a second owner answer, and it was missing from this
document until now. Asked directly whether Fathom becomes the system of record for the estate, the
owner answered:

> **"Yes — it's where the estate lives."**

**Neither `77` nor this document records a date for that exchange or for §4.1's passage, so their
order is unknown.** That is a real gap and it is not papered over here: the two answers pull in
different directions on staleness, and which one is later matters. `77`'s own status line is
*"a capture, not a specification […] Decides nothing"*, so what follows is a recorded owner answer
with unresolved consequences, not a decision. `77` §11 C2 logs the collision and leaves it open.

`77` §10 states three consequences, and each lands on a specific passage above:

| `77` §10 says | Where it lands here |
|---|---|
| **"Staleness becomes a defect, not a gap."** *"A modelling tool that is out of date is merely unhelpful. A source of truth that is out of date is **wrong**, and people act on it. The product needs a visible answer to 'how current is this', and it cannot poll for one — invariant 2 is permanent"* | **§4.5.** The age-not-staleness answer (`35` §8.3, `03` §9.6) is a *display discipline*: it tells the user when a fact was learned and refuses to claim it is still true. Against a design sketch that is sufficient. Against a system of record `77` says it is not, and the gap it leaves is exactly the one E2 is proposed to fill. **The answer in §4.5 does not become wrong; it becomes incomplete, and the missing part has no offline answer written anywhere yet** |
| **"The threat model changes."** *"An authoritative estate record is a higher-value target than a design sketch. `31` was written for the latter"* | **§5.2 and §6.2.** §5.2's coverage comparison for E3b is computed against a workspace that is a design sketch. If the workspace is already the system of record, the delta E3b adds is smaller than §5.2 states, and the baseline it is measured against is more valuable than `31` models. §6.2's *"a threat model whose top-ranked asset changes is not the same threat model with an extra row"* was written about crossing the line. **By the owner's own answer it applies below the line as well** |
| **"Loss becomes severe."** *"Losing a design costs an afternoon. Losing the system of record costs the estate. Backup, export and recovery move from convenience to requirement"* | **§5.3.** This is the strongest argument for E1 anywhere in the corpus and it is not a security argument, which is why it is recorded here rather than in E1's alternatives column. It does not change E1's price. It changes what the git-plus-file alternative is being asked to carry |

**The direct collision, which this document does not resolve and cannot.** `31` §10.1's register of
what is *not* claimed contains the row *"The graph records provenance and the age of parsed nodes |
That the inventory reflects reality. **Brief §6.5 scopes the diagram as a design tool, not a source
of truth**, precisely because documentation rots"*. That row and `77` §10's answer cannot both
stand. `52` §3.7 positions the inventory against NetBox rather than as a replacement, which `77`
§10 also flags for rewrite.

> **This document treats the source-of-truth question as UNRESOLVED**, and says so rather than
> quietly adopting either reading, for two reasons. First, `31` §10's register is the corpus's own
> instrument against exactly this kind of drift, and a security document that silently re-scoped
> the product's central asset would be the drift. Second, resolving it belongs to `31`, `52` and
> the brief under ADR-0001, not to `38`. **The consequence of leaving it open is that §4.5, §5.2
> and §6.2 are each computed against the design-sketch reading, and every one of them gets worse —
> not better — under the source-of-truth reading.** D-38.7 in §11 carries it.

---

## 5. The capability ladder — E1 to E6, least to most dangerous

> **EVERY RUNG BELOW IS: NOT APPROVED. NOT SCHEDULED. NOT DESIGNED. RECORDED HERE ONLY SO THAT
> THE PRICE IS FINDABLE BY WHOEVER ASKS NEXT.**

### 5.0 The ordering axis, and why the owner's six are not six

The obvious axis is difficulty. It is the wrong one — difficulty is a fact about us, and the
question is a fact about the user's network. Two questions decide the whole order and both are
answerable from the source in a review comment:

| | The question | What it catches |
|---|---|---|
| **The direction test** | What is on the far end of the connection? | A cooperating enterprise service the customer already trusts with more than this (an IdP, a git remote, an object store) is a categorically different risk class from production network equipment |
| **The credential-class test** | Does it need a secret that is valuable **on a device**? | Catches the capability that grants reachability without exercising it, which the direction test alone rates as safe |

Neither test is currently written down as a rule anywhere in the corpus. Both are proposed here,
and §11 D-38.1 asks whether they should be added to `03` §5 where they would belong.

**Two of the owner's six entries split into halves that sit at opposite ends of the order.** This
is the most important structural finding in the document:

| Named as | Actually is |
|---|---|
| E3 — "pull configs down and back them up" | **E3b**, the paste loop, which breaks no invariant at all, and **E3a**, collection, which is the most dangerous rung here |
| E5 — "active director or tacsis, one login" | **E5a**, SSO for the sync account, the safest rung here, and **E5b**, a TACACS+ password relay, the second most dangerous |

Presenting either as one capability would be wrong, and in E5's case actively hazardous, because
the safe half is already designed and would be cited as cover for the dangerous half.

**The order:** E5a → E3b → E1 → **[THE LINE, §6]** → E4 → E2 → E5b → E3a. E6 is not a rung; it is
the procedure for placing rungs that do not exist yet (§5.9).

---

### 5.1 E5a — enterprise SSO for the sync account only (AD via OIDC/SAML, OneLogin, Okta-shaped IdPs)

| Field | |
|---|---|
| **Status** | NOT APPROVED · NOT SCHEDULED · already designed for, which is not the same as approved |
| **What it requires** | One outbound TLS connection from the `fathom-sync` **server** to the customer's own IdP, to fetch JWKS and exchange an ID token for a session token. Not an outbound connection from the browser application. No device credential. Presupposes a server, therefore presupposes E1 |
| **Invariants broken** | **None of the four.** Invariant 1 governs *the application*; the browser app opens nothing new. Invariant 2 untouched — an IdP is not a network device. Invariant 3 untouched — an SSO identity is not a PSK, certificate key, SNMP community, TACACS key or device password. Invariant 4 untouched, deliberately |
| **Boundary class** | None. `33` §3.1 was written for this case |
| **Ship gates it would delete** | None in the offline artifact. X0.8/X0.9 continue to hold for D1 under `71` X6.7 |
| **Blast radius** | Total compromise of a `fathom-sync` running OIDC yields ciphertext for every workspace, the metadata channels M1–M11, source addresses, public keys, and additionally an authentication log — who logged in and when. **Zero plaintext.** `33` §3.1: *"A phished account password yields the ability to write garbage and to read ciphertext. It does not yield a single plaintext byte."* Zero device reachability; §3.2's sentence survives intact. Worst realistic case is an attacker writing garbage as a valid user — integrity and availability, not confidentiality, and detectable because the client validates what it decrypts |
| **Reversible** | **Yes, more cleanly than anything else here.** Build/install-time selection (`43` §5.4's `FATHOM_AUTH: "opaque" # or "oidc"`), not a runtime setting, contained entirely in the server's auth path. Reverting costs one OPAQUE re-registration and zero bytes re-encrypted, because the account credential was never in the confidentiality path. The only irreversible residue is what the IdP already logged |
| **Third party** | The customer's own IdP, which they already run and already trust with far more than this. **No third-party vendor is introduced by the project** |
| **Cheaper no-egress alternative** | OPAQUE (RFC 9807), `33` §3.2 — already the default, zero outbound connections, and `43` §5.2 recommends a `scratch`-based image variant with no CA bundle at all, which makes "no outbound connection" a checkable property rather than a claim |
| **Coverage of that alternative** | High and not total. OPAQUE gives authentication. It does not give the customer's identity *lifecycle*: deprovision-on-termination, group-based access, inherited MFA policy, and an authentication trail in the system the security team already reviews. For a five-person team, OPAQUE plus an enrolment token is ~100% of the value. For a 200-engineer organisation with a joiner-mover-leaver process it is not, and the missing part is not convenience — it is an offboarding control. **Stated as coverage analysis, per §1.2, and not as a business case.** The 200-engineer organisation is a hypothetical, no such customer exists, and the sentence is here to size the gap in OPAQUE, not to argue that the gap should be filled |

> **THIS ENTRY'S SEVEN FIELDS ALL READ "CHEAP" AND THAT IS NOT AN APPROVAL.** E5a breaks no
> invariant, deletes no gate, has no boundary class, reverses cleanly and introduces no vendor.
> Six independent zeroes. **A rung with no price is still a rung nobody has decided to climb**, and
> three things make that concrete rather than a formality. First, it *"presupposes a server,
> therefore presupposes E1"* — and ADR-0016 has already decided **against** E1 for v1 in favour of
> a file plus git, so E5a is downstream of a decision that currently points the other way. Second,
> G-F1 through G-F6 in §9 are all **Not met**, and G-R1 requires all of them before any rung is
> discussed. Third, `43` §14.3's gap below is a live prerequisite. **The correct reading of a
> cost-free row is "this is what it would cost", not "this is free, so do it."**

`33` §3.1's second reason for separating the account credential from the workspace key was written
for exactly this and says so:

> *"A self-hosted deployment will want the account credential to be OIDC or SAML against the
> customer's IdP. That must be possible **without the IdP being able to decrypt anything**, which
> is only true if the account credential is not in the confidentiality path at all. This is the
> single strongest practical argument and it will come up in the first enterprise conversation."*

**The one real gap, recorded by the corpus against itself.** `43` §14.3: invariant 1 constrains
*the application* and says nothing about *the service*. §6.10's default-deny NetworkPolicy is the
enforcement, and *"it is currently a convention this document invented rather than an invariant
anything holds it to."* A proposed addition to invariant 1 is drafted there and **not adopted**.
That gap is a prerequisite in §9, not a reason to build this — **and closing it is not a reason to
build this either.** No combination of prerequisites in this document adds up to permission; §9's
masthead says the whole set buys a conversation, and D-38.5 asks for the gap to be closed on its
own merits regardless of whether E5a is ever discussed.

---

### 5.2 E3b — config backup and restore via the paste loop (this is `75` C-05)

| Field | |
|---|---|
| **Status** | NOT APPROVED · NOT SCHEDULED · recorded and analysed at length in `75` §7, which decides nothing |
| **What it requires** | **Nothing new.** Fathom teaches the backup command → the user runs it in their own terminal → the user pastes the output back → Fathom stores it as a snapshot and diffs it against the previous one → Fathom hands back the restore commands to copy. Every step is inside `03` §5.1's capability closure. `75` §7.1: *"**No invariant-1 or invariant-2 question arises anywhere in the loop**, which is what makes the refusal in §7.2 surprising rather than obvious"* |
| **Invariants broken** | **None.** Not one of the four |
| **Boundary class** | `N-R-10`, **Refused** — and the refusal is a risk-concentration argument, not an invariant argument: *"Long-horizon storage of every device's full config makes the workspace an archive of the estate's most sensitive material, which raises the impact of an endpoint compromise well past what `31` assumes."* `N-R-10`'s refused-adjacent names this exact proposal: *"Keep the original pasted config text in the workspace so we can re-parse it later"* |
| **Ship gates it would delete** | None |
| **Blast radius** | An attacker who compromises an endpoint holding a snapshot workspace obtains, after defeating the passphrase, the full pasted configuration of every device backed up: every ACL and its ordering, every tunnel endpoint and peer address, every management IP, every routing adjacency, every NAT rule, the naming scheme, the vendor and version of each box. That is a reconnaissance package worth substantially more than a graph, which is `N-R-10`'s argument and it should not be softened. **On secrets, the honest answer is that `75` §7.6 records this as an open question and this document must not close it** — see the four questions below the table. It does **not** contain reachability. **The honest sentence: E3b turns a compromised laptop from a leak of what the network should look like into a leak of what it does look like** — and it adds a dimension `31` does not model, per `75` §7.7: a *series* of snapshots discloses *"not what the estate looks like, but **when each thing changed, and therefore when each window of exposure opened**"*, which composes badly with `31`'s existing ranking of maintenance dates as the highest-value metadata channel |
| **Reversible** | **Partially, and the irreversible part is data rather than architecture.** No egress to switch off and no server to decommission. But snapshots already written stay written, and a workspace already committed to git has already distributed them. Retreat requires a workspace migration dropping the capture record class, plus rewriting whatever history carried them |
| **Third party** | **None. Zero.** Recorded as a price of zero on one axis, **not as an argument in the rung's favour** — §5.4's E4 has the same zero and is refused *"Never"*, which is why that entry states plainly that *"absence of a third party is not evidence of low risk"*. The same sentence applies here |
| **Cheaper no-egress alternative** | There is no cheaper one — **E3b is itself the no-egress alternative to E3a.** The comparison runs the other way: against what already ships with no boundary change, which is the workspace being git-versionable and diffable by construction plus parsed-node provenance recording the source config's date |
| **Coverage of that alternative** | It gets you history of the *graph* at whatever granularity you commit, a structural diff, and a date on every fact. It does not get you the raw text, so it does not get you a byte-level diff, a re-parse under a newer parser, or a restore |

**The secrets question, carried as `75` §7.6 states it and not as an answer.** An earlier draft of
this document asserted flatly that a snapshot *"does not contain usable secrets — `T-P2-c` redacts
at parse time and the ingest gate takes a redacted newtype"*. That is the argument, not the
finding, and asserting it is the single move that most lowers E3b's price. `75` §7.6 heads the
material **"Recorded as a question, not an answer, and there are four of them"**:

| # | `75` §7.6's question | State |
|---|---|---|
| 1 | Does storing a snapshot add **any** new credential exposure over what `14` §9's gate already produces on every paste? | *"**The structural argument says no**"* — `14` §9 makes `CaptureStore::insert` take a redacted newtype, so the stored snapshot **is** the redacted capture. An argument. **Open** |
| 2 | Does a **series** of snapshots change that answer? | `75` §7.7 argues it changes the threat model even if it does not change the per-artefact exposure. **Open** |
| 3 | *"`14` §9.9's own limit — redaction is **'a retention control, not a confidentiality control'** — is stated for a transient paste. **Does it read the same way for an artefact deliberately kept?**"* | **Open, and it is the one an optimistic reading omits.** `14` §9.9's whole value proposition is that the gate changes a secret's lifetime *"from indefinite to the duration of one ingest"*. A snapshot series is the deliberate re-introduction of indefinite lifetime for the artefact around the redacted value |
| 4 | Can a restore replayed from a snapshot restore a `$9$` value? | **No** — see fact 2 below. This is the one of the four that `75` treats as settled in substance |

**And the objection `03` §4.10 already states in its own words**, which no structural argument
about newtypes answers on its face: keeping the pasted text *"converts the workspace from a graph
into a config archive, multiplies its plaintext-equivalent value, and **undermines the redaction in
`T-P2-c` by keeping the pre-redaction text**"*. Whether that clause describes E3b at all depends
on which reading of `N-R-10` is correct, and per `75` §7.3 ***"nothing in the corpus picks a
reading"*** — see D-38.9 in §11. **Under the literal reading the objection lands directly; under
the narrow reading it does not. This document does not pick, and no price for E3b is final until
somebody does.**

**Two further facts that must travel with any claim about this rung.**

1. **`N-R-10`'s own test already contradicts four core documents today, before this capability
   exists.** The test reads *"no field stores raw device configuration text beyond the current
   parse session."* `75` §7.3 establishes the contradiction against `11` §8.4 (`Capture.text:
   Arc<str>`), `17` §4.2 (record class `0x13`), `17` §4.5, `17` §13.1's per-device sealed budget,
   and `37` §2.2's personal-data inventory. `75` §7.2's masthead is the correct framing: **"THIS IS
   A BOUNDARY CONVERSATION, NOT A FEATURE CONVERSATION."**
2. **A restore replayed from a stored snapshot cannot restore any `$9$` value**, because the
   snapshot has a placeholder where the box had a key. `75` §7.6 flags this as the thing that gets
   discovered late if it is not written down now. **This is a config-structure backup, never a
   bare-metal restore**, and calling it "backup" without that sentence is the overclaim `31` §10
   exists to prevent.

`N-R-10`'s door is one clause: *"A user-initiated, explicitly-labelled attachment is a §10
amendment, not a default."* An amendment landed once is a precedent, and ADR-0002 already priced
that: *"Editing an invariant sets a precedent that invariants are editable. They were load-bearing
precisely because they read as fixed."*

---

### 5.3 E1 — shared synced database, load balancing, HA, DR, "and other solutions"

| Field | |
|---|---|
| **Status** | NOT APPROVED · NOT SCHEDULED · specified in depth, deferred by ADR-0016, partly superseded by ADR-0013 |
| **What it requires** | An outbound connection from the application to exactly **one** configured origin; a server (`fathom-sync`); an account credential; a database and an object store; optionally an L7 load balancer, N≥3 stateless replicas and PITR. Not a device connection. Not a device credential. No agent on anything |
| **Invariants broken** | **None.** Invariant 1's own text anticipates this: *"`connect-src` is `'none'` in the offline build and **exactly one origin in the sync build**."* Sync is the user-configured connection the invariant carves out. Invariants 2 and 3 untouched. Invariant 4 is not broken because `32`/`33` specify a server that structurally cannot hold a key |
| **Boundary class** | `N-D-1` and `N-D-2` are **Deferred**, and `03` §4.13 is explicit about why the class matters: *"Both are `N-D` rather than `N-R` because they are scale problems, not principle problems. Neither requires breaking an invariant […] if a proposal needs an invariant relaxed, it is `N-P` or `N-R`; if it needs engineering, it is `N-D`"* |
| **Ship gates it would delete** | **None, if the split in §8 is respected.** X0.8/X0.9 do not hold for the sync build target, but `71` X6.7 already requires that the offline single file *"still carries `connect-src 'none'` in its final bytes"*. That is a build split, not a gate deletion, and it is the difference between E1 and everything above the line |
| **Blast radius** | Total compromise of the sync server yields every workspace's ciphertext; M1–M11 — that an account has a workspace, roughly how large, every timestamp at which it changed, a per-record activity map (M8) and which *kind* of record changed (M11, ADR-0015); every client's public key and source address; and the ability to withhold, reorder or delete bytes. **Zero plaintext, zero device reachability.** `33` §1.3's customer-facing sentence: *"The server cannot read your workspace. It can see that you have one, roughly how big it is, and every time you change it"* — with `36` Q11 adding *"…and which kind of record changed"* |
| **Reversible** | **Partially.** Architecturally yes: the deployment mode is fixed at build or install, D1 continues to exist with its own hash, a customer can stop syncing and keep working. Three things do not reverse: ciphertext already uploaded is already copied wherever it was copied; metadata already observed is already observed; and organisationally, `33` §14's last row — *"The server cannot help with anything — no server-side search, no server-side validation, no server-side recovery, no 'we can restore your workspace'. **Every one of those will be asked for**"* |
| **Third party** | **None for confidentiality.** Self-hosted D2 (a complete `compose.yaml` at `43` §5.4) and D3 (`43` §6, down to Kubernetes manifests, NetworkPolicy, PITR and blob-store-loss runbooks) require zero third-party vendors, because the server is a hostile disk by design. Third parties become relevant only for the case `73` D20 already answered **No** to — the project operating a hosted multi-tenant service, which is `N-D-1` |
| **Cheaper no-egress alternative** | **Already decided, and decided in favour of the alternative.** ADR-0016 (Accepted): *"v1 and the product (ADR-0006's phases 0–3) ship a workspace file plus git. No multi-writer convergence. Single-writer sync with an advisory lock is the next step when a sync service is built at all. Multi-writer only on evidence"* |
| **Coverage of that alternative** | A workspace file plus git delivers multi-device access, full history, diff, branch, review, backup and remote replication, with zero egress by Fathom because the push is the user's own tool. For a team of one to five engineers who do not edit the same workspace in the same minute, that is most of E1's value at zero security cost and zero new metadata. **The missing part is concurrent multi-writer editing and an availability SLA** |

**Three prices specific to this rung, each already written down.**

1. **The one permanent cryptographic exposure in the corpus lives here.** `32` D15: *"the
   shared-workspace HPKE wrap is the harvest-now-decrypt-later exposure"*, tracked as residual C3,
   `material`, until suite `0x02` ships. An adversary who copies the keyholder table today
   decrypts it on the day a CRQC exists. **This is the only exposure on the safe tier that cannot
   be undone by any future action.** It is why E1 is ranked third rather than second.
2. **`43` §3.14's "metadata to a third party — none. Zero channels" becomes M1–M11.** `33` §12
   closes honestly: *"M8 is real, it is not fully mitigated, and the customer for whom a per-record
   activity map is disqualifying should not sync."*
3. **The missing concurrency is the most expensive and most silently dangerous work in the
   corpus.** ADR-0016: *"**The failure mode is the worst kind.** A convergence bug in a
   hand-rolled CRDT is silent data loss on a firewall policy, discovered when the policy does not
   do what the workspace says it does."* `83` §12.2 costs the CRDT alone at 8–12 solo weeks inside
   a phase-5 total re-estimated at 48–69 weeks against `71`'s budget of 16–24.

**The owner's second hypothesis is correct and he undersells it.** He expects E1 *"would require
such a massive amount of security and probably even 3rd party vendors."* For confidentiality, no
third party is needed — `32` and `33` already specify a server that cannot read what it stores:
*"THE SERVER IS A DUMB, HOSTILE, AVAILABLE DISK. IT ORDERS BYTES AND COUNTS THEM. EVERYTHING ELSE
IS THE CLIENT'S JOB."* The massive amount of security he anticipates has largely been written
already. What has not been written is the 48–69 weeks of it, and ADR-0016 has already decided
against building it now in favour of git.

---

> ## ── THE LINE ──
>
> **EVERY RUNG PAST THIS POINT IS *ABOVE THE LINE*: A DIFFERENT SECURITY POSTURE REQUIRING A
> DIFFERENT THREAT MODEL, NOT A BIGGER VERSION OF THIS ONE. §6 IS ABOUT NOTHING ELSE AND SHOULD
> BE READ BEFORE §§5.4–5.7.**

---

### The gate count above the line depends on the target artifact, and on the CLI it is zero

> **READ THIS BEFORE THE `Ship gates it would delete` CELL IN ANY OF §§5.4–5.7. IT IS A DEFECT IN
> THE GATES, NOT A LICENCE, AND IT MAKES THE SAFEST-LOOKING NUMBER IN THIS DOCUMENT THE LEAST
> INFORMATIVE ONE.**

Those cells used to read "X0.8, X0.9, H39" flat, which assumes the browser artifact. All three are
browser-artifact gates and **none of them mechanically fires on D4, the CLI**:

| Gate | What it actually checks | Why D4 escapes it |
|---|---|---|
| **X0.8** | *"CSP of the shipped artifact contains `connect-src 'none'`, asserted against the final bytes"* (`71` §3.6), run by `xtask assemble` | `43` §2.1 gives D4 `connect-src` = ***n/a*** and *n/a* for the whole policy-header row. There is no CSP in a static binary to assert against |
| **X0.9** | *"No network request is issued in a 30-minute scripted session. Verified by a proxy"* (`71` §3.6), implemented as `45` §13.4 E13 — Chromium with `Fetch.enable`/`Network.enable`, cross-checked against `performance.getEntriesByType('resource')` — and E14, *"the same suite"* in a namespace | Both instruments are browser instruments running browser flows. Neither is defined against a CLI invocation |
| **H39** | *"WASM import allowlist — `wasm-objdump -x`, compare to the committed allowlist"* (`34` §10's hardening checklist) | D4 is *"one static binary"*, native per platform triple (`43` §7.2). There is no `fathom_core.wasm` in the artifact to objdump. `43` §1.5 makes the split explicit — `rayon` parallelism *"applies here where it does not in WASM"* |

**And the CLI is the likely delivery vehicle for all four rungs above the line, not an edge case.**
§5.4's E4 requires *"a UDP socket from the application"*; a browser cannot open a UDP socket at
all, so E4 cannot arrive in D1/D2/D3 in the first place. E2's unattended poll needs a process that
outlives a tab. E3a needs SSH or NETCONF. `03` §3.1's refused-adjacent 2 already names the arrival
in one sentence — ***"A CLI that runs on the engineer's jump host, where the credentials already
are"*** — and refuses it precisely because *"a CLI that connects is a device-touching application
wearing a different hat"*, the application being *"one artifact with one set of invariants across
all […] deployment modes"*.

**So a gate-counting review passes E4, E2 and E3a on the CLI route exactly as §5.6 says it passes
E5b.** §5.9 step 6 makes the count load-bearing — *"the count is the ladder"* — and on this route
the count is zero for every rung above the line. **The count is not the ladder when the target is
D4.** §13.1 extends this to all four rungs, and G-R6 in §9.3 is amended to require the artifact to
be named alongside the gates, because "deletes no gates" and "deletes no gates *in this artifact*"
are different sentences and only one of them is true.

**The correct conclusion is that D4 needs equivalents of all three** — a `connect-src`-shaped
egress assertion for the CLI, a no-route run of the CLI suite, and a linked-symbol or
resolved-dependency check standing in for the import allowlist — **and G-F3's `T-P1-a` is the only
one of the three that anybody has drafted.** Recorded as D-38.8 in §11. Until then, `03`'s prose
boundaries are the only thing standing between the CLI and every rung above the line, which is
exactly the state `03` §3.5 calls ***"`N-P` in name only."***

---

### 5.4 E4 — SNMP

| Field | |
|---|---|
| **Status** | NOT APPROVED · NOT SCHEDULED · NOT DESIGNED · refused on three independent grounds |
| **What it requires** | A UDP socket from the application to a production network device, and an SNMP credential |
| **Invariants broken** | **1, 2 and 3, simultaneously.** `03` §4.5 `N-R-5`'s "Why refused" is verbatim: *"`N-P-1`, `N-P-2` and `N-P-3` simultaneously."* Invariant 2 names SNMP in its own statement. Invariant 3 names SNMP communities in its own statement. It also fails `03` §5.1 on the projection clause and the capability closure, and fails `T-freshness` for anything a sweep is normally used for |
| **Boundary class** | `N-R-5`, Refused. *"Reopens if: **Never.** The input side is already open: any text the user can paste is fair game"* |
| **Ship gates it would delete** | **In D1/D2/D3: X0.8, X0.9, H39. In D4, the CLI: none of the three** — see the note under the line. And E4 needs a **UDP socket**, which a browser cannot open at all, so D4 or a native shell is the *only* place E4 can arrive. **The gate count for the delivery vehicle that can actually carry this rung is zero** |
| **Blast radius** | Read credentials for the entire estate in one place, plus a client already configured with every device address. With those an attacker walks every MIB on every box: interface tables and counters, ARP and ND caches, the full routing table, bridge and MAC tables, chassis inventory with serials, software versions, config revision numbers, uptime. A complete reconnaissance picture — where everything is, what runs on it, what is patched, which links carry traffic — without touching a config file and, on most estates, without an alert. With v1/v2c there is a second-order harm that is worse: the community string is usually reused estate-wide and present in every device's config, so post-breach rotation is an estate-wide change-control event, which in practice means it is not done |
| **Reversible** | **No.** Turning the feature off does not un-disclose a credential. For v2c, remediation is a config change on every device |
| **Third party** | **None — and that is what makes it seductive.** SNMP needs no vendor, no cloud, no IdP and no licence. It is a socket and a string. Absence of a third party is not evidence of low risk |
| **Cheaper no-egress alternative** | Already in scope on the input side, and `03` §4.5 states it as the point of the entry: *"'Paste the output of `show lldp neighbors` and we will build the topology.' **This one is *in scope*, and stating that is the point: it is text the user gathered, not a network the tool probed.** The refused version is Fathom gathering it"* |
| **Coverage of that alternative** | For **topology**, close to complete, because an SNMP topology sweep derives its answer from the same LLDP MIB the CLI command prints. For **inventory** — serials, chassis, software versions — likewise. For anything **counter-based or time-varying** — utilisation, error rates, live interface state — near zero, and that gap needs no apology, because that class fails `T-freshness` and is `N-R-1` monitoring regardless of transport. The honest residual is unattended re-sweep on a schedule, which is exactly the refused thing |

**On SNMPv3, tested rather than assumed.** v1/v2c community strings are plaintext estate-wide read
passwords. v3 USM is genuinely better cryptography — per-user auth and priv keys, HMAC
authentication, encryption, a localized key per engine. **The version changes the shape of the
credential and changes nothing about the classification.** It improves how the secret crosses the
wire and makes the object Fathom would hold *more* valuable, not less: a long-lived per-user
secret is precisely the class invariant 3 removes. It improves neither invariant 1 (still a
socket) nor invariant 2 (which does not care about the payload). SET exists in every version, so
`03` §3.1's refuted read-only argument applies unchanged: *"`show security ipsec statistics` is
read-only but `clear security ipsec statistics` differs by one word, and the moment a connection
exists the only thing preventing a write is the application's own filtering."*

**A gap worth recording:** the strings "SNMPv3", "v2c" and "USM" appear nowhere in the corpus.
SNMP is treated monolithically in all of its mentions. Someone will eventually propose v3 as if
the cryptography were the objection. It never was.

`71` §13.2 already states the one legitimate form and its trigger: *"the only legitimate form is a
**separate** tool that emits a paste-able file. **Trigger: someone building that tool, not us.**"*

---

### 5.5 E2 — monitoring

| Field | |
|---|---|
| **Status** | NOT APPROVED · NOT SCHEDULED · NOT DESIGNED · *"Reopens if: **Never as monitoring**"* |
| **What it requires** | A connection to production equipment on a repeating interval, **with** a credential held persistently so the poll runs unattended. In the softer "import an alert feed" form: a connection to the customer's NMS plus an API token for it, which moves the credential but not the egress or the freshness dependency |
| **Invariants broken** | 1, 2 and 3. Fails all three clauses of `03` §5.1 — not a projection, needs `open_socket` and `read_credential`, and is the definitional failure case of `T-freshness`, because freshness *is* monitoring's value proposition |
| **Boundary class** | `N-R-1`, Refused |
| **Ship gates it would delete** | **In D1/D2/D3: X0.8, X0.9, H39. In D4, the CLI: none of the three** — see the note under the line. An unattended repeating poll needs a process that outlives a browser tab, so **D4 is the likelier vehicle here too**, and on that route a gate-counting review passes E2 |
| **Blast radius** | A credential set for every monitored device **and** a poller already authenticated and already reaching them on a schedule. The standing nature is what makes it worse than a one-shot connection: the attacker inherits working sessions rather than building them, hides inside a traffic pattern the network's own baselining has learned to ignore, and keeps access across restarts because it must, for the polling to be unattended. Even the most conservative read-only reachability check is pre-refuted by `03` §3.1's one-word `clear` example: *"`show security ipsec statistics` is read-only but `clear security ipsec statistics` differs by one word, and the moment a connection exists the only thing preventing a write is the application's own filtering."* One character further along the same axis is `clear security ipsec security-associations index <id>`, which `18` §7.4 and `82` line 715 both classify **`Disruptive`** — it tears an SA down. A poller with a credential and a typo reaches both |
| **Reversible** | **No, in three independent ways.** (1) Credential disclosure: rotate estate-wide; the feature flag does not un-disclose. (2) Product drift: `03` §4.1 — *"the panel would be the most-looked-at surface in the product, which means the whole product would drift toward serving it"* — and a product that has reorganised around a live panel does not reorganise back by deleting the panel. (3) Governance: `03` §10.3, including the rename |
| **Third party** | None in the direct-poll form. In the alert-feed form, the customer's existing NMS — which is also the argument against it, since a customer who has a feed to import already has the monitoring, and Fathom would be a second pane of glass over a system they already watch |
| **Cheaper no-egress alternative** | **The strongest one on the list, already specified in three pieces** — see below |
| **Coverage of that alternative** | Delivers the **diagnostic** value of monitoring at close to complete: why is it wrong, what does the config not cover, what did the capture contradict. Delivers the **alerting** value at zero. Alerting is what an NMS is for, every estate that would want E2 already runs one, and competing with it is a different product |

**The decision procedure, one sentence, `03` §4.1:** *"Fathom knows what should be true because the
graph says so. Monitoring knows what is true because it asked. Every proposal is decided by which
of those two it needs."*

**The three pieces of the alternative, all already written:**

| Piece | What it is | Where |
|---|---|---|
| **Monitoring as configuration and as knowledge** | Emitting and explaining `vpn-monitor` and `vpn-monitor-options interval 10 threshold 5`; explaining that vpn-monitor pings through the tunnel and tears the SA down on failure, taking st0 with it, which is what lets a route over st0 fail over — and that without it a route out st0 stays "good" while traffic blackholes; that DPD's time-to-declare-dead is `interval × threshold`, that the Junos default of 10 × 5 is 50 seconds of blackhole before failover even starts; a finding when `vpn-monitor` is absent on a tunnel carrying a routing adjacency | `03` §4.1, already in scope |
| **Provenance age, never staleness** | *"this node was parsed from a config on 2026-05-12."* `03` §9.6: *"It is provenance, not monitoring: it states when we learned something, never whether it is still true."* `35` §8.3's two-column table of what the app may and may not say | `03` §9.6; `35` §8.3 |
| **The one-shot paste diff** | Paste `show security ipsec sa` and Fathom reconciles it against the graph: which tunnels the config says should be up and the capture says are not | Inside `03` §5.1's closure |

This is arguably the more valuable half of what "monitoring" means to a network engineer, because
it tells you *why your monitoring will fail to catch something*, which the NMS you already run
cannot tell you — it only tells you what it caught.

> **This paragraph is not a proposal.** Two of the three pieces are already in scope and the third
> is not assembled anywhere. Assembling specified pieces into a named capability is a decision,
> and this document does not make one. **The owner asked for monitoring. A diff of a paste is not
> monitoring**, and calling it the answer would be answering on his behalf.

---

### 5.6 E5b — TACACS+ as an authentication backend for Fathom

| Field | |
|---|---|
| **Status** | NOT APPROVED · NOT SCHEDULED · NOT DESIGNED · **not covered anywhere in the corpus, which is itself the finding** |
| **The two readings** | **Reading 1 — TACACS keys as device credentials.** Fully covered, permanently refused, named in invariant 3's own text, in `N-P-2`'s statement and in `T-P2-c`'s redaction fixture. Nothing more to say. **Reading 2 — TACACS+ (RFC 8907) as the login backend for the Fathom account**, i.e. "sign in with the same credentials you use on a switch." Every TACACS mention in the corpus is reading 1. Reading 2 appears nowhere |
| **What reading 2 requires** | `fathom-sync` accepts the user's password **directly** — TACACS+ is not a browser protocol; there is no redirect flow, no token exchange, no JWKS — relays it to the customer's TACACS+ server, and holds a TACACS+ shared secret to do so |
| **Invariants broken** | Invariant 3 in substance if not in letter, and it destroys the architectural property that makes E5a safe. `33` §3.1's construction works because with OIDC the IdP holds the password and the server never sees it. TACACS+ has no such flow: the server sees the cleartext password on every login. In most estates that password **is** the engineer's device login, which makes `fathom-sync` a collection point for device credentials — the exact object invariant 3 exists to keep out of the product. Invariant 2 is not broken; invariant 4 is not broken. The blast radius lands on production anyway |
| **Boundary class** | Unclassified. `N-P-2` covers reading 1 only |
| **Ship gates it would delete** | **None, in any artifact — and that is the trap.** A gate-counting review passes this. Per the note under the line, that is no longer the distinguishing feature it was once described as: E4, E2 and E3a also delete zero gates on the CLI route, which is the route each of them would actually take |
| **Blast radius** | An attacker who compromises a `fathom-sync` configured for TACACS+ harvests, in cleartext at the point of relay, the device login password of every engineer who signs in, for as long as the compromise goes undetected. On a typical estate those are privileged interactive accounts with enable or configure rights on every box in the realm. **This produces E3a-class blast radius — full interactive reachability to production, with human credentials that are more privileged and more reused than any service account — while being filed under the same word as E5a, which produces almost none.** It also yields the TACACS+ shared secret, which permits spoofing authorisation responses to any device trusting that server. Note that RFC 8907's body obfuscation is an MD5-based construction the RFC itself disclaims as insufficient, directing deployments to run it over a secure transport |
| **Reversible** | **No.** Every password relayed during the compromise window is disclosed, and those are human credentials reused off-estate as well as on it. Remediation is a forced password reset for every network engineer plus rotation of the shared secret on every device that trusts the server. Contrast E5a, where the equivalent is one OPAQUE re-registration, zero bytes re-encrypted, no device touched |
| **Third party** | The customer's TACACS+ infrastructure. But the argument that decides it is different: essentially every estate running TACACS+ for device login also runs an IdP, because they need one for everything that is not a switch. **E5a is available to almost every customer who would ask for E5b, at a fraction of the risk** |
| **Cheaper no-egress alternative** | **E5a**, which is not merely cheaper but strictly better on every axis: same single-sign-on outcome, same lifecycle and deprovisioning benefit, standards-native in a browser, and decisively — the customer's IdP holds the password, so `fathom-sync` never sees it |
| **Coverage of that alternative** | E5a delivers essentially all of what a user asking to "log in with my work credentials" wants. The genuine residual case is an estate with a TACACS+ server and no IdP at all, and for that the answer is already written and needs no new capability: OPAQUE plus an enrolment token, no outbound connection, `scratch` image with no CA bundle. `33` §3.3's third deployment row also answers the hardest version: *"No server at all — the whole document is inapplicable"* |

> **A future document must state explicitly that E5a does not cover E5b**, or `33` §3.3's OIDC
> design will be cited as approval for a password relay. That is the specific failure this entry
> exists to prevent.

---

### 5.7 E3a — pulling configs down from devices

| Field | |
|---|---|
| **Status** | NOT APPROVED · NOT SCHEDULED · NOT DESIGNED · permanently refused, and the refusal has no reopening condition |
| **What it requires** | An authenticated session to every production device — SSH, NETCONF, gNMI or a vendor API — with a credential of sufficient privilege to read the full running configuration, held for as long as collection runs. In the scheduled form, held permanently |
| **Invariants broken** | 1, 2 and 3 — **and it is the only rung that breaks invariant 3 twice**: once for the credential it must accept to log in, and once for the credential material it retrieves and stores, because a full device configuration contains PSKs, `$9$`-encoded Junos secrets (reversible, not hashed), SNMP communities, TACACS keys, RADIUS secrets and local user hashes |
| **Boundary class** | `N-R-10`'s "Why refused" is one sentence: *"Collection is `N-P-1`."* And `N-P-1`'s "What would reopen it" is one word: *"Nothing. `74` §13.3"* |
| **Ship gates it would delete** | **In D1/D2/D3: X0.8, X0.9, H39. In D4, the CLI: none of the three** — see the note under the line. Scheduled collection over SSH or NETCONF is a CLI-shaped capability, and `03` §3.1's refused-adjacent 2 is the exact proposal: *"A CLI that runs on the engineer's jump host, where the credentials already are"*. **The most dangerous rung on this list deletes zero gates on the route it would actually take** |
| **Blast radius** | The maximum available on this list, and it is three things at once: (1) a working credential per device, at read-config privilege, which on most platforms is administrative or one `configure` away from it; (2) a client already holding the address of every device in the estate; (3) an archive of every device's complete configuration — every ACL and its evaluation order, every tunnel endpoint and peer identity, every management and out-of-band address, every routing adjacency and its authentication, every NAT and PAT mapping, the local user database, and reversible or crackable device secrets. They can reach every box, they know which one to reach and what is on it, they know which paths are unmonitored because they can read the monitoring config, and they hold secrets that let them come back after the first credential is rotated. **This rung ends "a total compromise of Fathom yields no reachability" and it also ends the separate property that Fathom holds nothing worth stealing** |
| **Reversible** | **No, and less so than anything else here.** Credentials: rotate estate-wide. Retrieved secrets: every PSK, `$9$` value, community and TACACS key in the archive is disclosed and must be changed *on the device* — that is not a rotation, it is a re-keying of the estate's security associations, with tunnel downtime. Governance: `03` §10.3 in full, plus deleting three gates if it is built into the browser artifact and **none at all if it is built into the CLI**. And the claim it destroys is the one `36` says sells the product — that the shipped artifact cannot reach a device, *"which is the claim that gets the tool onto a locked-down laptop"* (`03` §3.1 refused-adjacent 5). Once false, that claim cannot be made true again by removing the feature, because the artifact that made it was a different artifact with a different name |
| **Third party** | None, and again the absence is not comfort. `N-R-10`'s "Use instead" names Oxidized, RANCID, Nautobot's config-backup app and the vendor's own. `03` §4.5 notes the adjacent category is the most mature in the survey. **Building a worse version of a solved problem at the cost of the one property nobody else has is the trade being proposed** |
| **Cheaper no-egress alternative** | E3b, §5.2, which the owner has already been shown as `75` C-05 |
| **Coverage of that alternative** | For a single engineer working a change on a handful of devices: the teaching, which E3a does not deliver at all and which `75` §7.1 identifies as the actual request — *"**The load-bearing part is 'copy paste copy and paste', not 'backup'**"* — plus the diff, the restore commands and version history. Most of the value for that user, at zero egress and zero credentials. What it does not deliver, stated rather than finessed: unattended collection across hundreds of devices with no human in the loop, which is what E3a is *for* at estate scale; and a complete restore, per §5.2's `$9$` limit |

`03` §3.1 pre-refutes all five escape hatches that will be proposed for this rung, in the order
they will be proposed. They are worth having in one place because each will arrive sounding
reasonable:

| # | The proposal | Why it is refused |
|---|---|---|
| 1 | "Just read-only. Only `show` commands" | Needs a credential (`N-P-2`) and egress (`N-P-3`), and read-only is not enforceable from the client side — `clear security ipsec statistics` differs by one word |
| 2 | "A CLI on the engineer's jump host, where the credentials already are" | *"A CLI that connects is a device-touching application wearing a different hat"* |
| 3 | "Generate an Ansible playbook and offer a Run button" | *"The button is the boundary"* |
| 4 | "A browser extension that types into your existing SSH session" | *"the most seductive version, because it is technically true"* — refused anyway, because the blast radius of a wrong emitted line changes from "the user reads it first" to "it executed". **The user's review step is the safety control** |
| 5 | "An optional plugin, off by default" | *"**An invariant with an opt-out is not an invariant.**"* |

---

### 5.8 The ladder in one table

> **THIS TABLE IS THE MOST SCREENSHOT-ABLE OBJECT IN THIS DOCUMENT AND IT AUTHORISES NOTHING.
> EVERY ROW IN IT — INCLUDING THE THREE BELOW THE LINE WHOSE COST COLUMNS READ "NONE" — IS NOT
> APPROVED, NOT SCHEDULED AND NOT DESIGNED. THE STATUS COLUMN IS THE FIRST COLUMN FOR THAT
> REASON. A ROW WHOSE COSTS ARE ALL ZERO IS A CHEAP ROW, NOT A PERMITTED ONE.**

| Rung | **Status** | Invariants broken | Gates deleted (**browser artifact / D4 CLI**) | Reachability after total compromise | Reversible | Boundary class |
|---|---|---|---|---|---|---|
| **E5a** SSO for the sync account | **NOT APPROVED** · not scheduled · not designed *as a decision*; designed *as a shape* at `33` §3.1 | none | none / none | none | yes, cleanly | none — designed for at `33` §3.1 |
| **E3b** backup via the paste loop | **NOT APPROVED** · not scheduled · `75` §7 analyses it and decides nothing | none | none / none | none | data, not architecture | `N-R-10`, **Refused** |
| **E1** shared synced database | **NOT APPROVED** · not scheduled · specified, and ADR-0016 already decided **against** it for v1 | none | none, given §8's split / none | none | partially; one exposure never | `N-D-1`/`N-D-2`, Deferred |
| — | — | — | **THE LINE (§6)** | — | — | — |
| **E4** SNMP | **NOT APPROVED** · not scheduled · not designed · **refused, "Reopens if: Never"** | 1, 2, 3 | X0.8, X0.9, H39 / **none — and D4 is the only vehicle** | **full read of the estate** | no | `N-R-5`, **Refused** — "Never" |
| **E2** monitoring | **NOT APPROVED** · not scheduled · not designed · **refused, "Never as monitoring"** | 1, 2, 3 | X0.8, X0.9, H39 / **none** | **full, standing, unattended** | no, three ways | `N-R-1`, **Refused** — "Never as monitoring" |
| **E5b** TACACS+ password relay | **NOT APPROVED** · not scheduled · not designed · **unclassified, which is the finding** | 3 in substance | **none / none — the trap** | **full interactive, human credentials** | no | unclassified |
| **E3a** pulling configs down | **NOT APPROVED** · not scheduled · not designed · **permanently refused, no reopening condition** | 1, 2, 3 (twice) | X0.8, X0.9, H39 / **none** | **full, plus the archive** | no | `N-R-10` → `N-P-1`, permanent |

**Three things this table does not say, listed because the layout implies all three.** (1) It is
not a sequence — §13.2 argues the rows above the line are the first step of a different staircase,
not the next step after E1. (2) A "none" in the gates column is a statement about *mechanism*, not
about *permission*; four of the eight rows read "none" in the CLI column and **not one of the
eight is approved.** (3) Ordering by danger is not ordering by readiness; nothing here is ready, because
per §1.3 the artifact all of it would attach to does not exist.

---

### 5.9 E6 — "a bunch of things": not a rung, a procedure

The owner's sixth entry is open-ended by construction, so what it needs is not a classification but
a decision procedure cheap enough to run in a review comment. Ad-hoc judgement is known to fail
here: `03` §12 D7 warns that *"Deferred boundaries with no review date become permanent by neglect
rather than by decision"*, and ADR-0002 warns that *"An enumerated secret list rots […] a stale
invariant is worse than a vague one."*

`03` §5 supplies most of the procedure and says why a rule beats a list: *"§4 is a list, and lists
are incomplete by construction. This is the rule that decides the cases the list does not cover"*,
with §5.2 showing all twelve existing refusals fall out of the rule, *"which is the evidence the
rule is the right one."*

**The seven steps, in cost order, stopping at the first failure:**

| # | Step | Source | Verdict on failure |
|---|---|---|---|
| 1 | **Capability closure.** Does it need a verb outside `{read_workspace, read_corpus, read_user_text, write_workspace, write_clipboard, write_screen}`? | `03` §5.1 | `open_socket`, `read_credential` or `execute_on_device` means *"a §10.3 decision, not a feature."* Stop |
| 2 | **`T-freshness`.** Does it get worse if the input is a week old? | `03` §5.3 | Yes means it is monitoring wearing a paste button — `N-R-1` |
| 3 | **The direction test.** What is on the far end of the connection? | proposed here, §5.0 | Production network equipment is a different risk class from a cooperating enterprise service. Evidence on both sides already exists: `33` §3.1's *"does not yield a single plaintext byte"* against `31` §1.5's reachability row |
| 4 | **The credential-class test.** Does it need a secret that is valuable **on a device**? | proposed here, §5.0 | Device-class secrets are `N-P-2`, and no protocol improvement changes the class. SNMPv3 over v2c improves transit and worsens the object; TACACS+ improves nothing that matters |
| 5 | **The sorter.** Invariant relaxation, or engineering? | `03` §4.13 | Relaxation → `N-P`/`N-R`. Engineering → `N-D` |
| 6 | **The gate count, *per target artifact*.** Name the ship gates it deletes, individually, **and name the artifact you counted them in** | `75` §6.3 | *"It is not blocked by scheduling. **Its arrival requires deleting three build gates.**"* A capability that deletes none is a different animal from one that deletes three — **but a count of zero is evidence only when the artifact is named.** X0.8, X0.9 and H39 are all browser-artifact gates and none fires on D4 (see the note under the line in §5), so "deletes no gates" is true of E4, E2, E3a and E5b on the CLI route and means nothing. **Where the count is zero, step 6 has produced no information and steps 1–5 are the whole answer** |
| 7 | **If it deletes any:** `03` §10.3 in full, including the new name | `03` §10.3; `74` §13.3 | — |

Steps 3 and 4 are additions proposed by this document, and both are needed. Step 3 alone rates E5b
as safe. Step 4 alone rates E1 as dangerous. Together they reproduce the order in §5.8.

**Step 6 is the one that fails silently, and it fails for four of the eight rungs.** It is a count
of browser-artifact gates, and the four rungs above the line would arrive in the CLI, where the
count is zero. **It is the cheapest step to run and the one most likely to be run alone**, which is
the combination that produces a wrong answer confidently. Steps 1 and 4 catch all four; step 6
catches none of them on their actual delivery route.

**Two further requirements on every future entry:**

1. **It must be able to complete this sentence concretely:** *"An attacker who compromises a Fathom
   instance with X enabled obtains [what they can reach] and [what they can do to a production
   network]."* A proposal that cannot complete it has not been analysed. The calibration points
   are in §5.8's third column.
2. **It must answer the standing question first, not last:** what is the export- or import-shaped
   version, what proportion of the value does it actually deliver, and what specifically is in the
   part it does not? The corpus has **two** specified examples of an export- or import-shaped
   substitution for a capability that would otherwise need egress — **and every one of them is
   specified rather than shipped.** Per §1.3, nothing has been tried, because `README.md` line 3
   reads *"This repository contains no code"*; the correct verb is *would be*, and a claim that
   these have "worked" would be exactly the specified-vs-shipped substitution §1.3 exists to stop,
   in the paragraph most likely to encourage building one — which is F1 in §10, this document's own
   predicted failure:

   | | What it is | Why it counts, or does not |
   |---|---|---|
   | `16` §3.6's miss log | *"Never transmitted (invariant 1). **Exporting it is an explicit menu action producing a file the user reads before sending.**"* The corpus repo has an issue template that takes the file | **A genuine export-shaped substitution.** Specified. Never run |
   | `35` §8.4's `.fadv` advisory bundle | A signed, installable file with *"the same shape, trust root and install path as a rule pack"*, riding the removable media an air-gapped site already carries | **A genuine import-shaped substitution.** Specified. Never run |
   | `35` §8.3's age-not-staleness table | A two-column table of what the app **may** and **must not** say — *"'Update available' — it does not know that"* | **Not a substitution.** It is a **display discipline**: a refusal to make a claim, not a way of delivering the claim's value by another route |
   | `71` §13.2's SNMP/LLDP row | *"the only legitimate form is a **separate** tool that emits a paste-able file. **Trigger: someone building that tool, not us.**"* | **Not a substitution.** It is a **delegation rule** — it says the value is somebody else's to deliver, and explicitly not ours |

   `35` §8.4 also models how to state the limit rather than hide it: *"a site that carries nothing
   in learns nothing […] **Nothing helps that case. Saying so is better than shipping something
   that appears to.**"* That sentence is the discipline this requirement is asking for, and it is
   the reason the count above is two rather than four.

---

## 6. The line — the rung that ends "no reachability"

> **THE LINE FALLS BETWEEN E1 AND E4. EVERYTHING ABOVE IT IS A DIFFERENT SECURITY POSTURE
> REQUIRING A DIFFERENT THREAT MODEL, NOT A BIGGER VERSION OF THIS ONE.**

### 6.1 The property, and what crosses it

`31` §1.5's sentence again, because this section is about nothing else:

> **A total compromise of Fathom yields no reachability.**

Below the line — E5a, E3b, E1 — nothing reaches production network equipment and that sentence
survives intact. Above it — E4, E2, E5b, E3a — it does not survive at all.

**The first rung whose arrival ends it is E4.** Not because SNMP is the worst thing on the list;
it is the least-worst of the four. It is first because it is the cheapest, the most familiar, and
the one for which the argument *"it's just a read"* is most available. If the property is ever
lost, it will most likely be lost here.

**The rung that ends it most completely is E3a**, which ends both this property and the separate
property that Fathom holds nothing worth stealing.

**The rung that ends it without appearing to is E5b**, and it is the reason the direction test in
§5.0 is not sufficient on its own. A TACACS+ password relay never has Fathom open a socket to a
switch. Invariant 2 is formally untouched. An attacker who compromises that server nonetheless
harvests engineers' device login passwords in cleartext at the relay. **Reachability granted is as
bad as reachability exercised**, and any ladder built on invariant 2 alone would rank E5b as safe.

### 6.2 Why "a different threat model" is the literal truth and not a figure of speech

`31` is written on four load-bearing assumptions, and crossing the line falsifies three of them at
once:

| `31` assumes | Above the line |
|---|---|
| The highest-value asset is the workspace, and its worst-case loss is disclosure of a map | The highest-value asset is a credential set, and its worst-case loss is control of the estate |
| The attacker's prize tops out at information | The attacker's prize is action on production infrastructure |
| §6's out-of-scope rows (compromised browser, compromised endpoint) are survivable, because a compromised endpoint yields a file | A compromised endpoint yields a session |
| §1.5's four deleted branches stay deleted | Two or three of the four branches come back, and §8's attack trees are re-rooted |

A threat model whose top-ranked asset changes is not the same threat model with an extra row.
**`31` would have to be rewritten, not extended**, and §5's attack trees rebuilt against a
different goal. That is the work item nobody prices when they propose a read-only poll.

### 6.3 What crossing costs procedurally, stated so it is visible before rather than after

Every rung above the line requires `03` §10.3, because each breaks at least one `N-P` boundary and
`74` §13.3 places those outside what any governance body may authorise:

| Step | |
|---|---|
| 1 | A decision record arguing the change, with the threat-model delta explicit (`31`) |
| 2 | **A new name** (`74` §12), because users who trusted the old guarantee must not be silently moved onto a new one |
| 3 | A migration path that lets a user keep the old artifact working |
| 4 | The old artifact remains published, with its hashes, indefinitely |

`03` §10.3: *"**Step 2 is the real cost and it is deliberate.** A rename discards the accumulated
trust, which is exactly the price that should be paid for discarding the property that earned
it."*

Plus, per `75` §6.3's arithmetic applied to these rungs, the deletion of three build gates — X0.8,
X0.9 and H39 — **in the browser artifact only**. **These rungs are not blocked by scheduling. Their
arrival requires renaming the product, and, if they arrive in D1/D2/D3, deleting three build
gates.**

**The rename is the part that holds in every artifact; the gate count is not.** Per the note under
the line in §5, all three gates are browser-artifact gates and none fires on D4, which is the
delivery vehicle E4, E2 and E3a would actually take. So the arithmetic in this section is the
*upper* bound on the mechanical cost of crossing, not the floor. The floor is `03` §10.3 and `74`
§13.3, which are procedural and which no artifact escapes — **which is why step 7 of §5.9 and G-R9
in §9.3, not the gate count, are what actually guard this line.**

---

## 7. What is already designed for a connected future

> **THIS SECTION IS AN INVENTORY OF PAPER. NOTHING IN IT IS BUILT, AND "ALREADY DESIGNED" IS NOT A
> STEP TOWARD APPROVAL — IT IS A REASON NOT TO WRITE THE SAME DOCUMENT TWICE.** Read as "the work
> is done", this table is the most misleading object in the document. Per §1.3 not one line of it
> has been executed; per ADR-0016 the largest item was decided **against** for v1; per its own
> header the sync protocol *"must be rebuilt against whole records before implementation"*.
> **A completed design for a capability nobody has approved is not a partially-approved
> capability. It is a document.**

The owner expects E1 to need *"such a massive amount of security"*. Much of it is written. This
section exists so that nobody re-designs it, and so that nobody mistakes "written" for "ready".

| What | Where | Status, honestly |
|---|---|---|
| **The sync protocol** — nine operations, OPAQUE authentication, the account/workspace credential separation, the member list and its exact weakness, client-driven compaction, offline-first backlog handling, quotas, metadata channels, failure modes F1–F10 | `33` | **Specified, deferred, and partly superseded.** Its own header records that ADR-0013 removed the frames every operation is built on, so *"every operation below that takes or returns frames […] must be rebuilt against whole records before implementation"*; ADR-0016 deferred the CRDT. ADR-0016 names the risk: *"`33` becomes a large, specified, unbuilt document, which is the state most likely to rot"* |
| **The server's trust model** — four jobs, six prohibitions, and what it unavoidably learns | `33` §§1.1–1.3 | **Complete and unaffected by ADR-0013/0016**, because it is an argument rather than a wire format |
| **The key hierarchy** — passphrase → Argon2id → keyholder parent key → `RK_e` → `WK_e` → per-record `K_enc`/`K_cmt`, with fifteen decisions D1–D15 | `32` §§1, 3, 7, 9 | **Complete and owned.** ADR-0012 gives `32` sole ownership; ADR-0014 corrects four specifics. Its honest limit is written: *"It is not compartmentation today: every per-record subkey is derived from `WK_e`, so holding `WK_e` holds every record"* |
| **The one permanent cryptographic residual** — shared-workspace HPKE wrap, harvest-now-decrypt-later | `32` D15, §10.7, residual C3 | **`material`, open until suite `0x02`.** This is the price of E1 that no later decision undoes |
| **D2 — the Docker single node** — a complete `compose.yaml`, distroless base pinned by digest, static assets embedded in the binary, in-process rustls TLS, enrolment-token gating | `43` §§5.1–5.4 | **Complete to the level of a runnable file** |
| **D3 — the enterprise cluster** — L7 load balancer that adds no headers and strips none, stateless app tier at N≥3, HA index store, object store with versioning and object-lock, zero-downtime upgrade, Kubernetes manifests, default-deny NetworkPolicy, observability that does not leak, DR | `43` §6, runbooks at §9 | **Drawn in full, including the honest costs** — no shared cache tier, and a rate-limit write-behind window a client can exceed by N replicas × burst, *"Accepted; the limits are anti-abuse, not security"* |
| **Enterprise SSO** — OIDC/SAML for the account credential, and the reason it does not touch confidentiality | `33` §3.1 reason 2, §3.3; `43` §5.2, §6.1, §6.10, §6.14 | **The most complete design of the six named capabilities, and not a boundary problem — which is a statement about the paper and not about its status.** The separation in §3.1 was built for it. It is still NOT APPROVED (§5.1), it still presupposes E1, and ADR-0016 has decided against E1 for v1. **Completeness of a design is the axis on which this column is scored; it is not evidence of anything else** |
| **The enterprise review** — data location, proving the server cannot read it, proving no egress, the browser, AI, air gap, self-hosting, certification, continuity | `36` | **Complete and customer-facing.** Q12's forty-minute canary procedure is executable by a reviewer with no cooperation from us; Q17 is the five-minute no-egress form. Q13's discipline is what keeps it credible: *"Does this prove the hosted service behaves the same way? **No.**"* |
| **The three forks, already answered** | `73` §6.2 D18, §6.3 D19, §6.4 D20 | **D18** — does v1 have multi-writer sync at all? *No. File plus git. Single-writer with a lock in v2.* **D19** — the CRDT: hand-rolled, four convergent types, Loro as the named fallback, decided at week 4 of the phase and not week 12. **D20** — do we operate a hosted sync service? *No. Self-host only*, with the blast radius stated: adding hosting later is contractual and organisational, not architectural — the protocol is identical |
| **Processor status and the DPA we can honestly sign** | `37` §§4–5 | Written, including the hosted case |

**What this means for the owner's expectation about third-party vendors.** For confidentiality,
none is needed. The server is a hostile disk by design, and D2 and D3 are both self-hosted. Third
parties enter only for the case `73` D20 already answered No to. The owner's intuition here is
wrong in a favourable direction — and E5b is the reminder that it can be wrong in the other
direction too, where a familiar in-house protocol carries more risk than an external service.

---

## 8. The boundary pattern — how a connected capability would have to be shaped

> Nothing here authorises building any capability. It states the shape a capability would have to
> take **if** one were ever authorised, so that authorising it later is possible rather than a
> retrofit.

### 8.1 The pattern already exists in this corpus and it is the AI layer

ADR-0020 is the canonical worked example, and its move is to separate two questions that get
conflated: **does the boundary ship?** and **does the capability ship?** It answers yes to the
first and no to the second.

> *"The boundary ships. No model ships in v1. Tier 0 is the default and the development default,
> forever."*

Its rationale generalises exactly: *"shipping the boundary without a model loses nothing a user can
observe, while shipping a model without the boundary loses everything."* And the failure it
prevents: *"Retrofitting a boundary around a shipped model is how the model ends up in the artifact
path."*

Substitute "connection" for "model" and the sentence describes the *shape* §8 is about.

> **THE TRANSPOSITION DOES NOT CARRY THE PERMISSION, AND THIS IS THE PASSAGE MOST LIKELY TO BE
> QUOTED AS IF IT DID.** ADR-0020 is authority for the AI layer's boundary and for nothing else.
> There is no ADR authorising an egress boundary, and this document is not one — ADR-0001's
> precedence rule puts that decision in `03` and in an ADR, not here. Three disanalogies, and each
> one is load-bearing:
>
> | | The AI layer | An egress boundary |
> |---|---|---|
> | **What the boundary sits between** | Two crates in an artifact that ships either way. `21` §2.1's dependency edge costs a CI rule | A build split producing **a second artifact** (§8.3 B1), plus a server, plus `43` §14.3's unclosed gap on whether invariant 1 governs it |
> | **What was decided** | ADR-0020, **Accepted**: the boundary ships. A decision exists | **No decision exists.** ADR-0016 decided the nearest question — E1 — and decided *against* it for v1 |
> | **What "the capability" would break** | Tier 0 is the default forever; tier 1 breaks no invariant | E4, E2, E5b and E3a break invariants 1, 2 and 3 and need `03` §10.3 plus a rename. §8.5 says the pattern *"does not solve"* any of them |
>
> **So: "the boundary is not the capability" is true, and it is not a reason to build the
> boundary.** ADR-0020's own argument for shipping one was that the model was coming anyway and the
> retrofit was the danger. Nothing here is coming anyway. Building an egress boundary now would
> mean building a second artifact and a server for a capability that is NOT APPROVED at every rung
> in §5, ahead of an artifact that per §1.3 does not exist — which is §13.5's point exactly.
> **§8 answers "what shape would it have to be?" It does not answer "should we?", and the answer
> to that question today is no, at every rung, with no exceptions.**

### 8.2 What "a boundary" concretely means here, itemised from `21` §2

The AI layer's enforcement is worth listing because it shows that "boundary" is a set of
mechanisms rather than a discipline:

| # | Mechanism | Why it is not documentation |
|---|---|---|
| 1 | A **crate-dependency edge CI fails on** — `fathom-core` does not depend on `fathom-ai`; plus `xtask check-deps`, plus a `fathom-verify` that never links `fathom-ai` | `21` §2.1 calls R1 *"the cheapest and most reliable control in this document"* |
| 2 | A **type that cannot be constructed** outside one call site — the only write path is `Workspace::apply_proposal(&Proposal, &HumanReview)` and `HumanReview` cannot be built except by the UI accept handler | There is no `Graph::apply_from_supervisor` to misuse |
| 3 | **Capability grants as bitflags**, per subagent, with deliberate holes | The supervisor never holds `CAPTURE_READ`; `EMIT_LINES` is nobody's default |
| 4 | A **broker that checks capability before argument validation**, so a forbidden call cannot be used to probe the argument schema, with redaction inside the broker before anything crosses a transport | Ordering is the control |
| 5 | An **audit record per call** | — |

`34` §2.9 states the generalisable move in one sentence, about a Trusted Types policy whose
`createHTML` always throws: *"A policy whose `createHTML` always throws is not a workaround. It is
the design stated in executable form: **there is no supported way to turn a string into markup in
this application**, and the sink is where that is enforced rather than where it is documented."*

**When you want a capability to be unavailable, make the call site raise rather than the review
comment.**

### 8.3 The four rules any connected capability would have to satisfy

| # | Rule | Source and reason |
|---|---|---|
| **B1** | **A different artifact, not a mode.** The build with the capability and the build without it are separate artifacts with separately published hashes. The offline artifact's guarantees remain provable in its own bytes, and `71` X6.7 continues to hold: *"The offline single file […] still carries `connect-src 'none'` in its final bytes"* | `43` §2.1: **"NOTHING IN THIS TABLE IS A DEFAULT YOU CAN CHANGE AT RUNTIME. EVERY ROW IS FIXED AT BUILD OR AT INSTALL."** `43` §1.3/§1.4 permit exactly five variations between deployment modes and forbid seven, with CI building all four and diffing the core's exported surface |
| **B2** | **Fixed at build time, never a setting.** The origin set, the tier ceiling and the capability itself are build-time facts | `21` §7.5, `34` §2.4: *"an origin set a settings screen can change is not a claim about the artifact."* A security claim a settings screen can revoke is not a claim about the artifact |
| **B3** | **The boundary is a type and a dependency edge, not a convention.** The core cannot express the capability; the component that can is a separate crate the core does not link, and CI fails on the reversed edge | ADR-0020 / `21` §2.1. This is what makes B1 checkable rather than asserted |
| **B4** | **The customer chooses the artifact, and the choice is presented as a decision** | `43` §2.2: *"the choice of deployment mode is the choice of whether that residual exists at all, and it should therefore be presented to a customer as a decision rather than as a footnote"* |

### 8.4 Why this shape and not a feature flag

Because a feature flag is a claim about our conduct and a separate artifact is a claim about the
artifact, and only the second survives contact with a reviewer who does not trust us. `03` §3.1's
fifth refused adjacent already states the consequence of getting this wrong: *"**An invariant with
an opt-out is not an invariant.** It also destroys the claim in `36` that the shipped artifact
cannot reach a device, which is the claim that gets the tool onto a locked-down laptop."*

And because ADR-0020 has already documented the rot mechanism for exactly this shape: *"the moment
tier 1 becomes the development default, the under-determination surface stops being tuned, someone
puts a feature behind an AI call, and the offline single file becomes a demo."* Replace "AI call"
with "sync call" and the sentence describes the most likely way E1 damages D1 without anyone
deciding that it should.

### 8.5 What this pattern does not solve

It does not solve E4, E2, E5b or E3a. **A boundary bounds a capability; it does not change what the
capability does when it is used.** A perfectly-bounded SNMP component still holds read credentials
for the estate, and a compromise of the machine it runs on still yields them. Above the line, the
shape of the component is a second-order question. That is what §6 means by "a different threat
model, not a bigger version of this one."

---

## 9. The gate conditions, written as things someone could check

> These are prerequisites, not permissions. Satisfying every one of them authorises **a
> conversation**, not a capability. No rung below the line becomes approved by clearing these.
>
> **AND THE READING THIS SECTION MUST NOT SUPPORT: THAT A RUNG ABOVE THE LINE BECOMES APPROVABLE
> WITH `03` §10.3.** §9 is a list of things that are necessary. It is not a list of things that
> are sufficient, and it is not a route. Three of the four rungs above the line are refused with
> *"Reopens if: **Never**"*, *"Never as monitoring"* and *"Nothing. `74` §13.3"* — **a procedure
> cannot be applied to a decision whose reopening condition is "never".** `03` §10.3 is what a
> retirement *would* cost if `03` ever chose to retire a boundary; `03` owns that choice under
> ADR-0001 and has declined it in writing for `N-P-1`, `N-R-1` and `N-R-5`. **Clearing twenty
> boxes does not convert a "never" into a "yes". It converts nothing into anything.**
>
> §13.1 goes further and argues two rungs should read NEVER rather than LATER. That is filed as a
> disagreement, which means `03` has not adopted it — **it does not mean the opposite has been
> adopted.** Nothing above the line is approvable today by any route in this document.

### 9.1 The foundation gates — required before any rung is discussed

| ID | Condition | How you check it | Status today |
|---|---|---|---|
| **G-F1** | **The artifact exists.** There is a shipped phase-0 build with a published hash | `README.md` no longer says "This repository contains no code" | **Not met.** `README.md` line 3 |
| **G-F2** | **X0.8, X0.9 and H39 have run and passed on a real artifact**, not been specified | Three green checks in CI history, against the release build, with E13 running the release artifact per `45` §13.4 | **Not met** — nothing to run them against |
| **G-F3** | **`T-P1-a` exists.** A denylist of network-capable crates checked against the *resolved* dependency graph, failing the build on any hit | The check has an ID that appears in `45`, and a PR adding a socket-capable transitive dependency fails | **Not met.** §2.4 — the ID appears in `03` §3.5 and nowhere in `45` |
| **G-F4** | **The invariant texts are reconciled.** ADR-0002's single promised edit to `conventions.md` is made; ADR-0001's ownership document and precedence rule exist | `conventions.md` invariant 3 reads *"stores no device credential"*; `docs/00-vision/01-ownership.md` exists | **Not met.** §2.5 |
| **G-F5** | **`34` §2.11's four-part `sandbox` VERIFY is resolved** in Chromium, Firefox and WebKit, and the residual tags in `34` §11 B3, ADR-0017 and the documents depending on them are updated from that one measurement | The `<!-- VERIFY -->` block in `34` §2.11 is gone and replaced by a result | **Not met** |
| **G-F6** | **Invariant 1 covers the service, not only the application**, or the gap is accepted in writing with a named owner | `43` §14.3's drafted addition to invariant 1 is either adopted or explicitly refused in an ADR | **Not met** — drafted, not adopted |

**G-F1 through G-F3 are the "foundation" in the owner's sentence, stated as things a stranger can
verify.** A foundation that has never been built is not a secure foundation; it is a secure
design, which is a different and lesser claim, and `31` §10's register exists precisely to stop
that substitution.

### 9.2 The usefulness gate — the owner's clause, made checkable

`71` §3.7 already specifies the instrument and the discipline:

> *"**A named pilot group** — 8 to 12 engineers, at least 3 outside the project. What it tells you:
> whether they open it unprompted in week 3. **Ask; do not infer.**"*

| ID | Condition |
|---|---|
| **G-U1** | The threshold for "incredibly useful" is **written down before phase 0 starts**, not after the data arrives. `71` §3.7: *"A number chosen after the fact is not evidence"* |
| **G-U2** | The pilot group exists, has at least three members outside the project, and has been **asked** rather than measured, because invariant 1 forbids the measurement |
| **G-U3** | The written threshold is met |

Per §4.4, this gate governs whether the conversation happens. It does not become an argument
inside the conversation.

### 9.3 The per-rung gates

Applied to a specific rung, in order, stopping at the first failure. This is §5.9's procedure with
the foundation gates in front of it.

| ID | Condition |
|---|---|
| **G-R1** | G-F1 … G-F6 and G-U1 … G-U3 are all met |
| **G-R2** | The rung passes `03` §5.1's capability closure, or the proposal states plainly that it does not and is therefore a §10.3 decision |
| **G-R3** | The rung passes `T-freshness` |
| **G-R4** | The direction test and the credential-class test are answered in writing, with the far end of the connection named and the credential class named |
| **G-R5** | The blast-radius sentence in §5.9 is completed concretely, and reviewed by someone who did not write it |
| **G-R6** | The ship gates it would delete are named **individually**, per `75` §6.3, **and the target artifact they were counted in is named alongside them.** A count of zero is not an answer until D1/D2/D3 and D4 have been counted separately — X0.8, X0.9 and H39 are all browser-artifact gates and none fires on the CLI (see the note under the line in §5) |
| **G-R7** | The no-egress alternative is analysed first, with the proportion of value it delivers stated and the missing part named specifically |
| **G-R8** | The shape satisfies B1–B4 in §8.3 — a separate artifact, build-time, a type-and-dependency boundary, and a customer-visible choice |
| **G-R9** | **This is a wall, not a box.** If any `N-P` boundary is crossed, `03` §10.3 is not a step someone on this list performs — it is a decision only `03` can take, under ADR-0001, and for `N-P-1`, `N-R-1` and `N-R-5` it has already declined in writing with no reopening condition. Where a reopening condition exists at all, `03` §10.3 in full means: a decision record with the threat-model delta explicit, **a new name**, a migration path, and the old artifact published with its hashes indefinitely. **Reaching G-R9 with a rung whose reopening condition is "Never" means the rung has failed, not that the last box is open** |
| **G-R10** | `31` is rewritten rather than extended if the top-ranked asset changes (§6.2) — and per §4.6, `77` §10's source-of-truth answer may already have triggered this **below** the line |

### 9.4 What no gate can supply

Two things, stated so that clearing every gate above is not mistaken for having cleared them:

1. **`36` Q13's limit.** A verification procedure proves the deployment the reviewer ran. It does
   not prove a hosted one. No gate here changes that.
2. **`31` §10's row that costs the most:** *"No security audit claim of any kind […] the product
   has been independently audited, penetration-tested, formally verified, or validated against
   FIPS 140, Common Criteria or anything else. **None of that has happened.**"* Every gate in this
   section is self-assessment. That is worth less than an audit and should never be described as
   equivalent to one.

---

## 10. Failure modes

How this document, or the posture it describes, fails.

| # | Failure | Why it happens | What reduces it |
|---|---|---|---|
| **F1** | **This document is read as a roadmap.** Somebody finds §5, reads the `cheaper no-egress alternative` column, and builds one | It is the most useful-looking column and it lists things that already partly exist. `75` §6.4 predicted exactly this failure for its own §6.4 | The fences in §1.2, §5.1, §5.5, §5.8, §7 and §8.1, and `75` §6.4's sharpest row applied here: **the owner asked for monitoring; a diff of a paste is not monitoring**, and calling it the answer would be answering on his behalf. Also §5.9's correction that the no-egress substitutions are **specified, never shipped** — a column of things that "worked" is a far stronger invitation than a column of things that are drawn |
| **F2** | **The ladder is flattened into one thing.** E3 and E5 are treated as single capabilities, and E5a's completed design is cited as cover for E5b | They are named with one word each in the source instruction, and one half of each is genuinely safe | §5.0's split, §5.6's explicit warning, and §5.8's table where the two halves sit at opposite ends |
| **F3** | **The line is crossed by a small step.** Not by a proposal to build SNMP, but by "just one reachability check for the status panel", which `03` §4.1 already names as the refused adjacent | Every crossing is small at the moment it is made. `03` §3.2's warning generalises: *"The word 'barely' in a scope argument is a warning sign in itself"* | §6, and G-R6's requirement to name the deleted gates individually, which makes a small step produce a large list |
| **F4** | **The gates are assumed rather than checked.** A future reviewer reads §2's table, sees "build gate", and assumes it runs | Nothing in a specification distinguishes a specified gate from a running one | §1.3, §2.4, and G-F2 phrased as CI history rather than as documentation |
| **F10** | **A rung is cleared by a gate count taken in the wrong artifact.** A reviewer runs §5.9's seven steps, reaches step 6, counts zero deleted gates for an SNMP or a collection feature, and reports the capability as cheap | X0.8, X0.9 and H39 are browser-artifact gates; D4 has no CSP, no browser session and no WASM core (`43` §2.1, §7.2). Step 6 is the cheapest step to run and the likeliest to be run alone, and it returns the safest possible answer for the four most dangerous rungs | The note under the line in §5, G-R6's requirement to name the artifact alongside the gates, §5.9's warning that step 6 fails silently, and D-38.8. **Structurally, only D4 equivalents of the three gates fix it** |
| **F5** | **The stale invariant is quoted externally.** Somebody quotes `conventions.md` invariant 3 in a customer conversation and is corrected by ADR-0002 | The stale text is in the more findable file | G-F4, and `31` §11 R15's existing flag: *"Revisit when: Before invariant 3 is quoted in any external material"* |
| **F6** | **E1 damages D1 without anyone deciding it should.** The sync build becomes the development default, D1 stops being exercised, and the offline artifact becomes a demo | ADR-0020 documents this exact mechanism for the AI layer: *"the moment tier 1 becomes the development default […] the offline single file becomes a demo"* | B1 and B2 in §8.3, plus ADR-0020's own remedy — put "tier 0 / offline is the development default" in the definition of done for every PR, not only in a phase's exit criteria |
| **F7** | **This document rots into a wish list.** Rungs accumulate, nothing ever leaves, and the ladder reads as a backlog | `75` §1's masthead names it: **"A REGISTER NOTHING EVER LEAVES IS A WISH LIST"** | Every rung must carry a review date or an explicit "never", per `03` §12 D7: *"Deferred boundaries with no review date become permanent by neglect rather than by decision."* D-38.3 in §11 asks for one |
| **F8** | **The trust gate is satisfied by assertion.** Somebody decides the foundation is secure and useful because they think it is | Both halves of the owner's gate are judgements unless instrumented | §9's gates are written as things a stranger checks, and G-U1 requires the threshold before the data |
| **F9** | **A vendor takes the artifact, adds egress, and ships it under a name users recognise** | ADR-0004 licences the core Apache-2.0 and its own Negative section concedes: *"**a vendor may take the client, close it, add a telemetry endpoint and sell it** […] There is no licence remedy. The trademark (ADR-0005) is the only lever, and under ADR-0003 there is no entity to enforce it"* | Nothing this document can do. Recorded because it is the failure mode of G10 in §2.2 and it is not hypothetical |

---

## 11. Open decisions

Forks this document surfaces and does not close. None is scheduled.

| ID | The fork | Recommendation | Consequence of not deciding |
|---|---|---|---|
| **D-38.1** | Should the **direction test** and the **credential-class test** (§5.0, §5.9 steps 3–4) be added to `03` §5 as part of the scope rule, where they would belong, rather than living only here? | **Yes.** `03` §5 is the document that owns the scope rule under ADR-0001, and a test that lives in a security document will not be applied by someone triaging a feature request | E5b-shaped proposals are reviewed against invariant 2 alone and pass |
| **D-38.2** | Is **E5b reading 2** classified, and as what? It is currently unclassified — every TACACS mention in the corpus is reading 1 | Classify it, and the argument in §5.6 says `N-P`-adjacent rather than `N-R`. But the classification is `03`'s to make, not this document's | `33` §3.3's OIDC path is cited as approval for a password relay, which is F2 |
| **D-38.3** | Does each rung get a **review date** or an explicit **never**? | Every rung gets one or the other. `03` §12 D7 already recommends annual review for `N-D-1`; the same discipline applies here | F7 — the ladder becomes permanent by neglect |
| **D-38.4** | Are the owner's gate and `03` §10.1's gate **sequential** (§4.4's reading) or genuinely in conflict? | §4.4's sequential reading, but this is the owner's call and it is recorded as a reading, not a decision | Two different gates are cited in the same argument by two different people |
| **D-38.5** | Does **G-F6** get resolved by adopting `43` §14.3's drafted addition to invariant 1, or by explicitly refusing it? | Adopt or refuse in an ADR; leaving it drafted is the worst of the three | The service's egress is governed by a convention `43` invented, which is `43`'s own assessment of it |
| **D-38.6** | Is the **E3b/E1 ordering** in §5.8 right? | Argued both ways in §5.2 and §5.3 and it is genuinely close. E3b adds no server and no egress but makes the local workspace an estate map; E1 adds a server that cannot read anything but drags in M1–M11 and the one exposure that never reverses. The tiebreak used here is irreversibility | The order is cited as settled when it is not |
| **D-38.7** | Is the workspace a **design sketch or the system of record**? `77` §10 records the owner answering *"Yes — it's where the estate lives"*; `31` §10.1 records *"Brief §6.5 scopes the diagram as a design tool, **not a source of truth**"*. Neither exchange is dated, so their order is unknown | **Decide it in `31` and the brief, not here** — §4.6 states why `38` cannot. `77` §11 C2 already logs the collision and `77` §10 flags `52` §3.7 for rewrite. The security-side consequence is the one to state first: `31` was written for a design sketch, and if the answer is "system of record" then `31` §2's asset ranking is wrong **below** the line as well as above it | §4.5's staleness answer, §5.2's coverage comparison and §6.2's threat-model argument are each computed against the design-sketch reading, and each gets **worse** under the other. Nobody notices until an incident |
| **D-38.8** | **The three ship gates are browser-artifact gates. Does D4 get equivalents?** X0.8 has no CSP to assert against, X0.9's instruments are Chromium and a browser suite, H39 has no WASM to objdump (`43` §2.1, §7.2; `45` §13.4) | **Yes, and it is independent of any capability conversation.** Three checks: an egress assertion for the CLI, a no-route run of the CLI suite, and a linked-symbol or resolved-dependency check standing in for the import allowlist. Only the third has been drafted anywhere, as `T-P1-a` (G-F3, §13.4) | E4, E2, E3a and E5b all delete **zero** gates on the route they would actually arrive by, and `75` §6.3's gate arithmetic — which §5.9 step 6 makes load-bearing — returns the safest possible answer for the four most dangerous rungs |
| **D-38.9** | Which reading of **`N-R-10`'s test** is correct — literal (*no raw configuration text stored at all*) or narrow (*no **pre-redaction** raw text stored*)? | **`03` must pick one, and `75` §7.3's recommendation is the right one: settle the reading before anything else in the E3b entry is discussed.** `75` §7.3: *"**Nothing in the corpus picks a reading**, and nobody has noticed the collision"* — while `11` §8.4, `17` §4.2, §4.5, §13.1 and `37` §2.2 already specify a stored capture. This document does not pick, which is why §5.2's price is provisional | Under the literal reading `11` §8.4 is a live boundary breach today; under the narrow reading much of E3b is already licensed and the argument is about volume and series. **Running both conversations together produces a decision about a capability when the disagreement is about a sentence** (`75` §7.3) |

---

## 12. Sources consulted

**The two owner quotations first, in `75` §15's form, because §4's entire reading rests on them and
neither exists in any file in this repository.**

| Claim | Source |
|---|---|
| **The owner's statement of the connected future, verbatim** — *"in regards to your thoughts on staleness, that's just because this is essentially a demo…"*, through *"…only if they think you've developed a current secure foundation that is incredibly useful"* | **Owner, in conversation. Quoted in full at §4.1**, and it is the source of authority for this document existing at all. It supplies E1, E2, E3, E5 and E6, the trust gate read in §4.2, the usefulness clause in §4.4, and the staleness remark answered in §4.5. **Undated, and it appears nowhere else in this repository** |
| **The earlier instruction, verbatim** — *"Fathom is not a ssh client, it will not connect to anything ever!"* | **Owner, in conversation, earlier. Quoted at §4.2.** Undated, and it likewise appears nowhere else in this repository. §4.2 carries a caveat marking it as a possible reconstruction rather than a transcript; per `75` §15's discipline, if it is a paraphrase that is **a live defect and not a citation**, and the line should be corrected rather than left in quotation marks. The boundary itself does not depend on it — invariant 2, `03` §3.1 `N-P-1` and `31` §1.5 all state it in files |
| **The owner's source-of-truth answer, verbatim** — *"Yes — it's where the estate lives"* | Owner, in conversation, **as recorded by `77` §10**, not by this document. Quoted at §4.6. Also undated there, so its order relative to the §4.1 passage is unknown |

| What | Where |
|---|---|
| The four hard invariants, verbatim; the terminology table; the document conventions | `.context/conventions.md` |
| The brief's sentence on invariant 3, and the correction to its attribution | `.context/owner-brief.md` |
| §8.4's field-history retention of superseded values, cited in `14` §9.9's leak table | `docs/10-core/11-ir-schema.md` §8.4 |
| §9.9's redaction analysis — what it does not protect against, *"a retention control, not a confidentiality control"*, the leak table and the `FATHOM DOES NOT KEEP YOUR KEYS` imperative | `docs/10-core/14-parsers-and-ingest.md` §9.9 |
| §3.6's miss log — local, never transmitted, exported by an explicit menu action | `docs/10-core/16-command-finder.md` §3.6 |
| Record class `0x13` and the capture blob; §4.5's write-once content-addressed captures; §13.1's per-device sealed budget | `docs/10-core/17-workspace-format.md` §4.2, §4.5, §13.1 |
| §7.4's `Disruptive` classification of `clear security ipsec security-associations index <id>` | `docs/10-core/18-diff-verify-rollback.md` §7.4 |
| §2.1's dependency-edge control and §7.5's build-time origin set | `docs/20-ai/21-ai-layer-architecture.md` §2.1, §7.5 |
| `31` §1.5's reachability sentence treated as a thing the UI may not contradict | `docs/50-design/58-ui-direction-study.md` |
| The build order this document does not re-sequence | `docs/70-ops/76-scope-expansion-analysis.md` |
| **§10's source-of-truth answer and its three consequences; §11 C2's collision** | `docs/70-ops/77-service-model-requirements.md` |
| The reconciled risk banding of `clear security ipsec statistics` (**`ChangesConfig`**, with a caption override) and of `clear security ipsec security-associations index <n>` (**`Disruptive`**) | `docs/80-review/80-reconciliation.md` R18 and §6.1; `docs/80-review/82-critique-network-domain.md` §2 and §17's risk-audit table |
| The corpus entry `junos-srx/ipsec.statistics.clear` — `risk: ChangesConfig`, unscoped, a counter reset | `corpus/commands/junos-srx-ipsec.yaml` |
| "This repository contains no code"; "Status: planning" | `README.md` |
| §1.5's four deleted branches and the reachability sentence; §2's asset ranking; §5.1 row 10's tampered-build residual; §6's out-of-scope rows; §10's register of what is not claimed and §10.1's *"a design tool, not a source of truth"* row; §11 R15; §12's CI list | `docs/30-security/31-threat-model.md` |
| The key hierarchy; D15's PQ posture; §10.7 and residual C3 | `docs/30-security/32-cryptography.md` |
| The server's four jobs and six prohibitions; §3.1's credential separation and its second reason; §3.2 OPAQUE; §3.3's deployment table; §12's metadata channels; §14's costs | `docs/30-security/33-sync-protocol.md` |
| §1.2 J3; §2.5's `script-src` hash and its scope; §2.8's `<meta>` restrictions; §2.9's Trusted Types policy; §2.11's eight surviving channels **including channel 6, the tampered build**; §7.5's import allowlist; §8.1–8.3; §10 H39; §11 B3 and **B10, the `material` tampered-build residual**; §13.1's Disagreement against invariant 1 | `docs/30-security/34-browser-hardening.md` |
| §8.3's age-not-staleness table; §8.4's advisory bundle | `docs/30-security/35-supply-chain-and-builds.md` |
| The enterprise review; Q11, Q12's forty-minute canary procedure, Q13, Q17, Q18 | `docs/30-security/36-enterprise-review-qa.md` |
| §2.2's personal-data inventory; §§4–5 processor status and DPA | `docs/30-security/37-privacy-and-compliance.md` |
| §§3.1–3.5 the four `N-P` boundaries and their tests; §4.1 `N-R-1`; §4.5 `N-R-5`; §4.10 `N-R-10`; §4.13 `N-D-1`/`N-D-2`; §5 the scope rule and `T-freshness`; §9.6 provenance age; §10 retirement; §12 D1 and D7 | `docs/00-vision/03-non-goals-and-scope.md` |
| §3.6's fourteen `42` §9.4 checks; check 5's allowlist contents | `docs/40-stack/42-no-node-runtime.md` |
| §1.3/§1.4 the five permitted and seven forbidden variations; §1.5 on WASM versus native; **§2.1's masthead and its D1–D4 comparison table, including D4's *n/a* for `connect-src` and for the whole policy-header row**; §2.2; §3.14; §5's F8 tampered-file row; §§5.1–5.4 D2; §6 D3; §6.10 NetworkPolicy; §6.14; **§7.1–7.2, D4 as one native static binary**; §14.3's unadopted addition to invariant 1 | `docs/40-stack/43-deployment-modes.md` |
| §13.4 E13 and E14 | `docs/40-stack/45-testing-strategy.md` |
| §3.6 X0.8 and X0.9 as written, including their gate column; §3.7 the pilot group and the adoption cost; §12's kill points; §13.1 and §13.2's refusal and deferral tables; §14.1's estimate assumptions — **cited only to say that `71` contains no prohibition on estimating below a person-week, contrary to an earlier draft of §1.2** | `docs/70-ops/71-roadmap.md` |
| §6.2 D18, §6.3 D19, §6.4 D20 | `docs/70-ops/73-open-decisions.md` |
| §12 the trademark and modified builds; §13.3 | `docs/70-ops/74-governance-and-licensing.md` |
| §1 the register's rule; §6 C-04 and its structure; §6.3 the three gates; §6.4 the fence; §6.5; §7 C-05 — **§7.1, §7.2's masthead, §7.3's two unsettled readings of `N-R-10`, §7.6's four open questions, §7.7's temporal-inference finding**; §15's form for citing a conversation, which §12 above copies | `docs/70-ops/75-capability-register.md` |
| §12.2's CRDT cost inside the phase-5 re-estimate | `docs/80-review/83-critique-coherence.md` |
| ADR-0001 ownership and precedence; ADR-0002 invariant amendments, **including its Negative section's imperative quoted in §3.1**; ADR-0004 licence and publication; ADR-0006 v1 is the finder; ADR-0012, ADR-0013, ADR-0014 the workspace container; ADR-0015 the claims register; ADR-0016 git is the sync for v1; ADR-0017 the offline artifact; ADR-0020 the AI layer is a boundary | `docs/90-decisions/` |
| RFC 9807 (OPAQUE), RFC 8907 (TACACS+) | cited by number where used |

---

## 13. Disagreements

Under `.context/conventions.md`'s rule, these are objections and opinions, stated in the author's
voice rather than smuggled into the body.

### 13.1 Two rungs should read NEVER, not LATER, and the register should say so

**The disagreement.** §5 presents eight rungs on one axis, which is the right way to compare them
and the wrong way to leave them. Two of them — **E3a** (pulling configs down) and **E5b** (a
TACACS+ password relay) — should not be on a ladder at all, because a ladder implies a top, and
these are not the top of anything Fathom could be.

**The argument, and it is a product argument rather than a security one.** What makes Fathom worth
using is not that it is careful with credentials. It is that it has none. That is the property
that gets it onto a locked-down laptop; it is why `36` is short; it is what `31` §1.5 means by
*"the largest single security effect in the product and it cost nothing."* A tool that holds
device credentials is competing with Oxidized, RANCID, NAPALM, Nornir, NSO and Apstra — all
mature, all free or funded, all better at it — and it is competing with them having spent the one
thing none of them has. **The trade is: give up the only differentiator, to enter the most crowded
category in the survey, in order to do a worse job.** `03` §4.5 and `03` §4.10 already say the
category is the most mature one; what they do not say, and what I am saying, is that the trade is
not close.

E5b deserves a second sentence of its own, because it is the one that will not be caught. It
arrives labelled as an identity feature, alongside a genuinely safe identity feature that is
already designed. It deletes no ship gate. It does not open a socket to a switch. A gate-counting
review passes it. And it turns `fathom-sync` into a place where every network engineer in the
organisation types their device password.

**And the correction I have to make to my own earlier draft is the more serious half of this
disagreement.** I wrote that E5b was *"the only rung here where the risk is invisible to every
mechanism the corpus currently has."* That was wrong, and wrong in the direction that flatters the
corpus. **It is true of all four rungs above the line in the form each would actually arrive in.**
X0.8, X0.9 and H39 are browser-artifact gates; D4 has no CSP, no browser session and no WASM core
to objdump (`43` §2.1, §7.2). E4 needs a UDP socket a browser cannot open. E2 needs a process that
outlives a tab. E3a needs SSH or NETCONF, and `03` §3.1 already names its arrival as *"a CLI that
runs on the engineer's jump host, where the credentials already are."* **Every one of them deletes
zero gates on the CLI, so a gate-counting review passes E4, E2 and E3a exactly as it passes E5b.**

What actually catches them is `03` — `N-P-1`, `N-P-2`, `N-P-3` and the capability closure — which
is *prose a reviewer has to read and apply*, not a check that fires. `03` §3.5's own sentence is
the standard the corpus set for itself and does not meet here: ***"A boundary with no test is `N-P`
in name only."*** That is why D-38.1 and D-38.2 exist, why D-38.8 now exists, and why §13.4's
finding about `T-P1-a` is the largest one in this document rather than a footnote: **the mechanical
half of the boundary is browser-only, and the CLI is where every dangerous rung would land.**

**The proposed replacement.** `03` §4 should carry E3a as a restatement of `N-P-1` with no
reopening clause, and should classify E5b explicitly. This document's §5.8 marks them as
permanent, but a security document cannot create a boundary; `03` owns that under ADR-0001, and
until `03` acts, this is an argument and not a rule.

### 13.2 E4 is misranked relative to how it will actually arrive, and the ladder cannot fix that

**The disagreement.** §5.8 ranks E4 as the least-worst rung above the line, which is correct on the
merits and possibly harmful in practice. E4 is the cheapest crossing, the most familiar, and the
one with the most available justification (*"it's read-only"*, *"it's just a community string"*).
Ranking it fourth invites the reading that it is the natural next step after E1.

It is not a next step. It is the first step of a different staircase. §6 says that in words; the
table in §5.8 said the opposite in layout, because a table sorted by danger looks like a sequence.
**RECOMMENDATION — if this document is ever rendered, the line in §5.8 should be a visual break
heavy enough that no reader takes the two halves as one list.** `58` already treats `31` §1.5's
reachability sentence as a thing the UI may not contradict; the same discipline applies to a
document's own layout.

**A second layout defect in the same table, which I missed on the first pass and which is worse
than the ordering one.** §5.8 had no status column. Every per-rung entry in §§5.1–5.7 opens with
NOT APPROVED · NOT SCHEDULED, and the one object in this document a reader is most likely to
screenshot and paste into a ticket carried none of it — E5a's row read `none / none / none / yes,
cleanly / none`, five columns of zero with nothing anywhere in the row saying it was not approved.
**A summary table that drops the status of every row it summarises is not a summary; it is a
different document.** Status is now the first column, before the costs, and the table carries its
own masthead. `52` §5.6.3's discipline for the inventory view is the right analogy: a compressed
row must not be able to imply something the expanded record denies. `31` §10's register exists to
stop precisely this class of drift — a claim that gets stronger each time it is restated more
briefly — and a summary table inside a security document is a restatement like any other.

### 13.3 The owner is right that the offline foundation comes first, and the reason is not the one usually given

**Where I agree.** The usual argument for building the secure thing first is that retrofitting
security is expensive. That is true and it is not the strongest argument available here.

The strongest argument is that **the offline artifact is the only version of this product a
stranger can evaluate without trusting us.** Every guarantee in §2 that is worth anything is worth
it because a reviewer can check it: read the CSP out of the bytes, run `wasm-objdump` against the
import section, put the thing behind a proxy for half an hour. That is a rare property. Most
security tools ask to be believed. This one can be checked in an afternoon by someone who does not
like us.

The moment a connection exists, the evaluable surface shrinks to what the reviewer can observe
from outside, and `36` Q13 already concedes the limit: a procedure proves the deployment you ran,
not the one we operate. **So the offline artifact is not a lesser version of anything. It is the
version whose claims are provable, and a connected version — if one were ever decided on, which
none has been — could only inherit credibility from it, never lend credibility to it.** That
asymmetry runs in one direction only, which is precisely why the order matters and why "we will
add security later" is not available as a plan.

**And the asymmetry is not an argument for a connected version.** It says what such a version
would have to be built *after*; it says nothing about whether one should exist. A conditional is
not a presupposition, and every rung in §5 is refused, deferred or unapproved today. The premise
of this whole subsection is that the offline artifact does not exist yet either — §1.3 — so the
only thing that follows from it is that phase 0 comes first.

That is also why the owner's own framing — *"this is essentially a demo […] that is more important
to have security because of it"* — is correct and, I think, undersold. At this stage the security
posture is the only fully specified property and the only one anybody outside the project can
judge. It is the product's entire evidence base until there is a product.

**Where I disagree with the corpus rather than the owner.** `03` §10.1's *"Usefulness is assumed"*
is right for an amendment argument and wrong as a general posture, and §4.4's sequential reading
papers over a real difference. A boundary that is never tested against a user is not disciplined,
it is untested. The owner's gate is better than the corpus's on this specific point, because it
requires the thing to be worth trusting before anyone is asked to trust it further, and `71`
§3.7's pilot group is the only instrument in the corpus that could tell you. **RECOMMENDATION —
`03` §10.1 keeps its rule for the argument, and G-U1's written-in-advance threshold is added as a
precondition for the conversation. Both texts survive and neither is weakened.**

### 13.4 The foundation the gates assume does not exist, and that is the largest finding here

**The disagreement is with the corpus's own confidence.** `03` §3.5 states that its fourteen
boundary tests *"live in `45` and run on every PR"*. None of those IDs is in `45`. `T-P1-a`, the
resolved-dependency-graph denylist, has no counterpart anywhere I could find, and it is the single
check that would make invariant 2 architectural rather than aspirational.

Invariant 2 is currently true because no code exists. That is not a gate, it is an absence of
opportunity, and the difference will matter the first time a crate is added for parsing that
transitively pulls in a TLS stack for a feature nobody enabled. **The strongest guarantee in §2 —
G1, the import allowlist — is strong precisely because it is a check on the *resolved* artifact
rather than on intent. `T-P1-a` is the same idea one level down, and it is missing.**

**RECOMMENDATION — G-F3 is the highest-value item in §9, it is cheap, and it should not wait for a
capability conversation to justify it.** A denylist against the resolved graph is, in my own
estimate and not on any authority in `71`, a day of work — `71` §14.1's assumptions table is the
only estimating instrument in the corpus and it does not cover a check this small. Cheap or not, it
is the difference between a promise and a property.

### 13.5 The document I did not write, and would not

I was asked for a price list and a ladder, and there is a version of this document that would be
more useful to somebody who wants to build these things: one that sequences them, prices them in
weeks, and names the smallest safe first step.

I think that document would be actively harmful right now, and not because the capabilities are
bad. It would be harmful because **the artifact it would be built on top of does not exist**, and
a plan for extending a thing that has not been built is the most reliable way to never build the
thing. `71` §12's nine kill points already assume the current corpus may not become a shipped
product. A connected-capability roadmap written before phase 0 ships would be the strongest
possible signal that the project has stopped believing in phase 0.

`75` §6.4's closing line is the right one to end on, and it is meant literally:

> **Nobody should build anything from this document.**
