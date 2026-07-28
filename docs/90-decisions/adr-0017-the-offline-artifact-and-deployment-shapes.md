# ADR-0017 — The offline single file is a complete single-session product; shapes are D1–D4; `44` owns the budget

> **Status:** Accepted
> **Date:** 2026-07-28
> **Register entry:** `73` §3.7 (D07); resolves `83` F2 and `81` §7.3
> **Reversal cost:** R2 — concentrated in the build rather than the product
> **Supersedes:** `34` §3.3; `41` §3.10's independent size totals; `43` §3.2's independent budget

## Context

Brief §1: *"deployable as a single offline file, a Docker single-node, or a load-balanced enterprise
cluster, from one codebase."* The single offline file is the one with choices in it, and it is
specified **four times, at four sizes, at two capability levels** (`83` §4.1):

| Document | What the file is | Size |
|---|---|---|
| `34` §3.3 (argued at length) | Read-only reference content. Explicitly *"no workspace, no passphrase entry, no envelope code, no ciphertext, no storage"* | not budgeted |
| `43` §3.5 (marked **proposed change to `34` §3.3**) | *"a complete product for one session"* — opens a packed workspace, runs every engine, emits configuration, writes a sealed workspace back out | 5.4–6.7 MB, WASM 2.0–3.0 MB |
| `44` | Budgets **workspace unlock** on mode A as an accepted budget | ≤3.5 MB target, **4.5 MB hard ceiling**, WASM ≤900 KB |
| `35` §13.2 | A worked `fathom verify` output | prints `SIZE 28,114,552` |

So `44`'s CI check P6 — which blocks a merge — **would reject every build of the artifact `43`
specifies**, and `44` §13 declares no disagreement with anything while its entire §4.8 presumes
`43`'s proposal was accepted. It has not been.

`81` §7.3 adds the finding that matters most: **`36` — the document a customer reads — has already
committed to one side of the live fork**, answering Q39 with *"Mode A — Holds a workspace? no"* and
answering an air-gapped defence customer's Q40 with the capability loss. That is the segment brief
§2.4 identifies as the differentiated market.

Two second-order collisions fall out. `32` §4.3's `p = 1` decision rests on *"the offline single-file
build can never be cross-origin isolated"* — but under `34` §3.3 the single file never runs Argon2id
at all, and the artifact that does (mode B, served by `fathom serve`) sets COOP/COEP and **is**
cross-origin isolated. And the deployment shapes are lettered twice: `34`'s A–E and `43`'s D1–D4,
where *"a reader who has both open cannot tell 'mode B' from 'D2'"*.

## Decision

**Take `43` §3.5. The offline single file is a complete product for one session. Adopt `D1`–`D4`
corpus-wide. `44` owns every size and budget figure. Measure the WASM core before anything depends
on the number.**

1. **Mode A / D1 holds a workspace in memory for one session.** It opens a packed workspace, runs
   every engine, emits configuration and writes a sealed workspace back out. It uses **no browser
   storage of any kind** — no OPFS, no IndexedDB, no Cache API, no `localStorage`, no cookies, no
   service worker. This satisfies `34`'s own rule (*"we do not put a secret behind a policy we cannot
   deliver"*) exactly: with no storage there is no secret at rest behind the undeliverable policy.

2. **`34` §3.3 is rewritten** to reflect this, keeping its masthead phishing control in `43`'s
   reworded form. The two extra post-XSS channels are recorded as a **`material` residual specific to
   mode A** in `34` §11, rather than the capability being removed. `34` §13 gains a disagreement
   naming the owner's brief, because removing the workspace from "a single offline file" contradicts
   brief §1 directly and `conventions.md` requires that to be raised, not assumed.

3. **`36` §1.3, Q39 and Q40 are corrected** before the document is shown to anyone.

4. **`D1`–`D4` replace `34`'s letters everywhere**, per `43` §1.1's recommendation. `44`'s "modes
   B–D" and `43`'s "D2–D4" currently mean different things.

5. **One size table, in `44` §5.3.** `43` §3.2's independent budget and `41` §3.10's independent
   totals are deleted; `41`'s per-component *split* survives and its numbers move to `44`. Two font
   faces, per `44` §5.4 — the only one of the three font counts that is argued rather than asserted.

6. **Measure the WASM core before committing.** `83` §13 item 3 calls this *"the single most
   consequential unmeasured number in the corpus"*: 700 KB or 3 MB is a factor of four and it decides
   B17, B18, the artifact shape and whether mode A is viable at all. `41` §3.10's own `VERIFY` admits
   it is *"a budget, not a measurement"*. **Two-day spike, in phase 0, before the size gate is armed.**

7. **`32` §4.3's `p = 1` keeps the decision and loses argument 2.** Arguments 1 and 3 stand on their
   own; the cross-origin-isolation premise is false for the artifact it governs and must be withdrawn
   or the decision re-argued.

8. **No desktop app in v1.** `43` §3.5's rejection of the signed desktop bundle stands for the
   *offline mode*. `24` §3.7's native shell is the **AI transport** and a fourth artifact, existing
   only if ADR-0020 says a model ships — which for v1 it does not.

9. **`35` §13.2's 28 MB worked output is corrected** to a figure from `44` §5.3. The number appears
   in published material.

## Consequences

### Positive

- The air-gapped engineer — the user the entire security posture exists for — gets a usable tool
  rather than a lookup table. `36` Q40 stops telling a defence customer to get a binary through
  change control.
- One artifact definition, one size table, one lettering scheme. Five documents stop deriving from
  four different files.
- Mode A with no browser storage is genuinely simpler to reason about than mode A with an OPFS
  cache, and it lets ADR-0012 delete `32` D14's OPFS branch cleanly.
- The size gate becomes meaningful. A CI check that would reject the artifact the deployment document
  specifies is worse than no check.

### Negative

- **No crash recovery, at all.** A discarded tab loses everything since the last save. `43` §3.12
  prices this and it is the largest single cost of mode A: the user most likely to be in mode A is
  on an unfamiliar machine in a controlled environment, which is exactly where a tab gets closed.
  There is no mitigation available that does not reintroduce browser storage.
- **Two extra post-XSS exfiltration channels, permanently, in the flagship shape**, because `sandbox`
  and `frame-ancestors` cannot be delivered by `<meta>`. This is recorded as `material` rather than
  fixed, and `34` §2.11's four-part `sandbox` VERIFY — one afternoon of work, on which three
  documents' residual tags depend — is still unresolved.
- **The save path is poor outside Chromium.** `32` §13.1 calls the fallback *"genuinely poor"*:
  `workspace (14).fathom` in Downloads. And `34` §7.2's sub-risk is unverified — `sandbox` without
  `allow-popups` plausibly blocks `showSaveFilePicker`, which is the only good save path there is.
- **The size budget may not be achievable.** If the WASM core measures at 2–3 MB, mode A is 8–10 MB
  and `44`'s 4.5 MB ceiling is not a budget but a wish. The decision then is corpus-slicing, which
  degrades the artifact for the exact user it was expanded to serve.
- **Rewriting `34` §3.3 means overturning an argued decision with a better-argued one**, and `34` is
  the second-strongest document in the corpus. Its author's reasoning was sound given what it knew;
  it did not know about `43` §3.5.
- **Renaming A–E to D1–D4 touches every security document**, and a partial rename is worse than
  either scheme.

## Alternatives considered

| Option | Strongest argument for it, in its own terms | Why rejected |
|---|---|---|
| **`34` §3.3: reference content only** | *"We do not put a secret behind a policy we cannot deliver."* Mode A cannot deliver `sandbox`, `frame-ancestors` or violation reporting, so putting a workspace there means putting the user's estate behind a CSP that is missing three directives. It is the conservative, defensible position and it is argued at length | `43` §3.5 satisfies the same rule by a different route: with no browser storage there is no secret at rest to protect. And it answers the cost `34` §3.4 concedes is unanswered — an air-gapped user with a reference table and no tool |
| **Desktop app as the offline shape** | Real headers, real storage, real crash recovery, and it is what every other product does | Three OS artifacts, two notarisation paths and an update channel — a supply chain larger than the product, for a project whose entire security argument is that one reproducible build can be checked by a stranger. `31` §7 also forbids silent auto-update, and the pressure to add one is constant |
| **Mode B only; drop the single file** | Everything works properly, and `fathom serve` ships anyway with the CLI | It removes the deployment the flagship threat model exists for. An engineer on an air-gapped jump host cannot install a binary |
| **Keep both letterings with a mapping table** | No rename, no churn across the security corpus | A mapping table is a second thing to keep in sync, and `43` §1.1 already noticed the collision and resolved it in public — which is the behaviour that would have prevented this schism had it been applied to the format |
| **Arm the size gate now at 4.5 MB** | Forces discipline early | It would reject the specified artifact and the specification would be changed to fit the gate, backwards. Measure first, then set the number |

## Revisit if

- The measured WASM core lands above ~1.5 MB, at which point mode A's viability is a real question
  and the answer is corpus slicing, not a bigger ceiling.
- `34` §2.11's `sandbox` VERIFY fails, which makes egress channels 1 and 2 `material` in **every**
  mode and reopens `34` §3.3's artifact split on its original terms.
- Measurable loss of user work through mode A's save path — `34` §3.5's own revisit trigger. Then
  mode B becomes the recommended shape and mode A becomes the reference shape, which is `34`'s
  position arrived at with evidence.
- A customer requires *"no browser extensions in the same process as our configurations"*, the other
  named trigger, which makes the desktop shell the enterprise answer and couples it to ADR-0020.
