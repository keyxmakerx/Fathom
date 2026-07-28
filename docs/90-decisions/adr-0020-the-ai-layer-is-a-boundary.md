# ADR-0020 — The AI layer ships as a boundary; no model in v1; tier 0 is the default forever

> **Status:** Accepted
> **Date:** 2026-07-28
> **Register entry:** `73` §7.1 (D21), §7.2 (D22); resolves `85` F12 against `21` §7.3
> **Reversal cost:** R2 for the boundary; R5 for the default, because a default is a claim in a security review
> **Supersedes:** `21` §7.3's browser-loopback sidecar as the primary shape; `21` §7.0's tier-2a row

## Context

The owner's added requirement is explicit and new relative to the brief: *"There needs to be a
supervisor AI and sub agents."* It has to be reconciled with brief §6.1's *"deterministic — fuzzy
matching plus a synonym map, no model at runtime"*, with invariant 1, with invariant 9, and with a
single offline file.

`73` §7.1 separates two questions that must not be conflated.

**Does the boundary ship?** The boundary is `resolve()` with the model arm unreachable and the
compiler proving it, the `Proposal` type and its verbs, the tool broker and capability grants, the
audit record, `fathom-verify` which never links `fathom-ai`, and the `xtask check-deps` edge. Plus
the under-determination surface, which is the deterministic answer to the four `Underdetermined`
cases and is good product on its own — `21` §7.1 is right that the `NoHit` screen is the finder's
weakest surface.

**Does a model ship, and at which tier?** `21` §7 gives five tiers. The reproducibility guarantee is
identical at every one, because the model cannot emit a line of config, fire a finding or change a
ranking. `85` §13 confirms this independently: *"I looked for a path from model output to an emitted
byte and there is none."*

On the sidecar, `21` and `24` disagree and nobody filed it (`85` F12). `21` §7.3 specifies tier 2b as
a served page reaching `llama-server` over loopback, with `connect-src http://127.0.0.1:<port>` in
its CSP table, and rates *"tier 2 is the tier this product should want people on"*. `24` §3.7 rejects
that shape outright with a decisive argument: the Local Network Access permission prompt, *"whose
wording we do not write, shown at a moment we do not choose, whose denial is sticky, describing an
action that a security-conscious network engineer — which is precisely our user — is correctly
trained to deny. That last point is not ironic, it is fatal."*

`24` §3.8 then prices the correction honestly, including the line that matters most: **"the shape we
chose for security reasons is the one the most security-constrained users cannot run."**

## Decision

**The boundary ships. No model ships in v1. Tier 0 is the default and the development default,
forever. When a model does ship, the first tier with one is a native shell that owns the sidecar as
a child process — not a browser page reaching loopback.**

1. **Phase 6a only** under ADR-0006: the boundary, the broker, the capability grants, the audit
   types, and the under-determination surface. 4–6 solo weeks.
2. **Tier 0 stays the build the team develops against day to day.** `21` §7.1 states the rot
   mechanism precisely: the moment tier 1 becomes the development default, the under-determination
   surface stops being tuned, someone puts a feature behind an AI call, and the offline single file
   becomes a demo. This belongs in the definition of done for every PR after phase 6, not only in
   that phase's exit criteria.
3. **`21` §7.3 is rewritten from `24` §§2–3.** Tier 2b becomes *"native shell (primary) / served
   loopback flavour (secondary)"*, `21` §7.5's CSP table gains `24` §3.2's, and `24` §11 gains a
   third disagreement naming `21` §7.3 explicitly. `34` §2.2's mode table has no loopback row at all,
   so three documents currently describe three different CSP surfaces for local inference; after this
   there is one, owned by `34` per ADR-0001.
4. **`21` §7.0's tier-2a row is set to `no` for the single file**, and §7.6's degradation table is
   regenerated. The row promises in-page WebGPU inference with 1–2 GB of user-supplied weights in an
   artifact that `44` §6.2 caps at 1.5 GB resident and that ADR-0017 gives one session of memory.
5. **`24` §3.8's sentence is carried into `21` §7 and into `36`.** The segment the security posture
   was built for gets a product with no AI layer — *"not a degraded one, none"* — and that must be
   said in the document a customer reads, not discovered by them.

## Consequences

### Positive

- The owner's requirement is architecturally satisfied and testable **without a model existing**, and
  the expensive failure — retrofitting a boundary around a model that already ships — is the one
  thing this ordering prevents.
- The reproducibility guarantee costs nothing to keep, because shipping the boundary without a model
  loses nothing a user can observe, while shipping a model without the boundary loses everything.
- The under-determination surface is a real product improvement that arrives at tier 0, offline, in
  the single file, for every user.
- `24`'s LNA argument saves the project from shipping a feature whose first interaction is a browser
  permission prompt that its own users are trained to deny.
- No model in v1 means no consent UI, no redaction profiles, no pre-flight, no armed-state indicator
  and no egress log on the critical path — most of tier 1's work, none of which is model work.

### Negative

- **The owner asked for a supervisor AI and is getting, in v1, a boundary with nothing behind it.**
  That is a deferral of a direct instruction and it must be stated to them in one sentence rather
  than reported as satisfied. ADR-0021 makes the related admission about what the supervisor actually
  is.
- **4–6 weeks of scaffolding for a capability that may never be built.** `71` §12.7 already contains
  its own kill line — *"after a full release cycle, no pilot user can point to a decision the AI
  layer improved → ship tier 0 and stop"* — so this is 4–6 weeks spent before the condition that
  would justify it has been tested.
- **The AI layer is absent for the segment that is the strategic case and present for the segment
  that has alternatives** (`85` §10). Air-gapped, defence, OT and regulated get no AI layer at all;
  the desk engineer who could use one already has a browser tab and a chat window.
- **A native shell is a desktop application**, which ADR-0017 refused for the offline mode and which
  brings three OS artifacts, two notarisation paths and an update channel. Deciding that the shell is
  the *AI transport* and not the *offline mode* keeps the knot untied, and it only stays untied while
  no model ships.
- **Tier 0 as the permanent default is a promise that will be under pressure from the first demo.**
  A default is R5 because it is a claim in a security review; it is also the thing a product manager
  changes to make a feature discoverable.

## Alternatives considered

| Option | Strongest argument for it, in its own terms | Why rejected |
|---|---|---|
| **Ship tier 1 (BYOK hosted) first** | It is the only tier with real reach: no install, works on any machine, and it is what "there needs to be a supervisor AI" ordinarily means. It also exercises the consent machinery early, when it is cheapest to change | It breaks the confidentiality claim for what is sent, in the product whose market is confidentiality. It requires the entire consent, redaction, pre-flight and egress-log programme before any model value is observable. And `81` §2.2.1 shows the field classification is currently backwards on the highest-value asset |
| **Ship tier 2b as a browser page reaching loopback (`21` §7.3)** | No egress, every invariant intact, no desktop artifact, and llama.cpp-class servers support grammar-constrained decoding which removes a whole failure class | `24` §3.4's LNA argument. The first thing the user sees is a permission prompt they are correctly trained to deny, and the denial is sticky |
| **Do not ship the boundary either** | Zero cost, and `21` §7.1's tier 0 is *"not second-class"* | Retrofitting a boundary around a shipped model is how the model ends up in the artifact path. The boundary is the half that is architecturally load-bearing and the half that is cheap |
| **Ship tier 2a (in-page WebGPU)** | Truly offline, no install, no prompt, and it keeps the single-file story intact | 1–2 GB of weights against a 1.5 GB resident ceiling and a one-session memory model. `24` §2.3 also caps the honest WASM/WebGPU job at ≤1 B parameters, which is below what the subagents need |
| **Ship a model and skip the boundary** | Fastest path to something demonstrable | It is the one failure mode X6.1 exists to catch, and it is unrecoverable: once a model's output reaches an emitter, invariant 9 is gone and the product's entire differentiation with it |

## Revisit if

- A full release cycle passes and no pilot user can point to a decision the AI layer improved —
  `71` §12.7 fires, tier 0 ships, and the boundary remains as architecture. That is a success
  condition for this ADR, not a failure.
- `shadow_rule_rate` shows subagents routinely producing rule-shaped output — admission criterion A1
  working, and the answer is to write the rule.
- X6.1 fails: artifacts differ between AI-on and AI-off sessions. Stop and fix the boundary;
  everything else in the phase is worthless if the model can touch the artifact path.
- Tier 0's acceptance suite is quietly weakened to accommodate an AI-dependent feature. Revert the
  feature — the rot has started.
