# 87 — Adversarial re-verification of the repaired corpus

> **Status:** Accepted — verification record, final-verdict run 2026-07-28 against the
> working tree at `76fb51a` + the close round's uncommitted repairs. Supersedes in place
> the first-pass record run earlier the same day against `a801d1d`; the Blocker table,
> the cross-reference results and the risk audit below are the re-run, not the original.
>
> Method: independent, same as the first pass. The three corpus YAML files were re-parsed
> from scratch and every structured reference re-resolved by script; the ADR-0011 CI regex
> was re-run by this verifier over every non-`Disruptive` entry; every close-round change
> was read against the finding it claims to close. No repair agent's report was consulted.

**Headline: 10 of 12 Blockers RESOLVED (three of those carrying a named, owner-deferred
remainder), 2 OWNER-DEFERRED outright, 0 STILL-OPEN, 0 PARTIALLY. The close round did what
the first pass asked: R09 landed in full on the data side, the risk framework now exists in
the specs and not only in the ADR, and every contested risk entry has an explicit
disposition. What remains is exactly the work the corpus header already promises a human
expert: named review of 98 entries none of which has been run on a box, the phase-0
fixture gate, and the ADR-0029 rule-authoring tickets.**

---

## 1. Blocker-by-Blocker verdicts

| ID | Verdict | Evidence |
|---|---|---|
| **R01** — two container formats | **RESOLVED** | Unchanged from first pass: `17` §1 rewritten to fixed shards per ADR-0012/0013; `32` §6 defers to `17`; `73` D15 records "Sharded, `S_nodes = 64`"; ownership split in both headers. |
| **R02** — crypto-erasure falsehood | **RESOLVED** | Unchanged from first pass: `36` Q9 withdraws the prior answer by name (ADR-0015); `37` §7.4, §10 P6 and the deletion table corrected consistently. |
| **R03** — no `set` line can be `Disruptive` | **RESOLVED** | All three spec-side amendments now exist. `61` §4 carries ADR-0011's effect definition verbatim ("`Disruptive` iff committing or running the statement can interrupt an established flow, SA or adjacency…"), §3.2 defines `risk_caption_override`, §4.6 specifies the override with the shipped `ipsec.statistics.clear` case, and §14 gate 15 is the decided CI regex. `13` §5.5's `index <n>` row is `Disruptive` with the ADR-0011 rationale, resolving the contradiction in `18` §7.4's favour as decided, and §5.5 documents the caption override. `.context/conventions.md`'s risk-enum section carries the ADR-0011 amendment, so the override is no longer a convention breach. Corpus side: the ten §6.1 reclassifications plus the close round's ten further moves (see §3); gate 15 run by this verifier passes (§3.4). *Named remainder:* the corpus still has no `ipsec.sa.clear-index` entry, so `13` §5.5's row names a command the corpus cannot yet serve — an expert gap-fill item, not a contradiction. |
| **R04** — fabricated AI evidence base | **OWNER-DEFERRED** — staged by ADR-0029, which is Accepted: `21` §§12–13's scenarios are banner-marked "not evidence" and are *not re-run* until the three ticketed rules (`ike.version.v1-in-use`, `ike.proposal.sha1`, `ipsec.traffic-selector.multiple-under-v1`) land. `23` §5.2's `ike.sa.clear-by-peer` → `junos-srx/ike.sa.clear-peer` correction, explicitly named by ADR-0029, was applied by this run (both occurrences). Still outstanding and knowingly so: `22` §8.1's finding list and `25`'s legacy IDs, which the ADR-0029 ID-resolution grep would fail today — deferred with the scenario re-run they belong to. |
| **R05** — `zone.host-inbound.ike-missing` false-fires | **RESOLVED (rule)** — re-verified: anchored on `kind: ZoneMember`, full disjunction including `all`, remediation `add_to_set` on `self`. The decided `must_pass` fixture is **OWNER-DEFERRED** with the whole of R44: the pack still ships zero fixtures, tracked as a phase-0 build gate by ADR-0028/0029. Until that gate exists, nothing protects this rule from regressing the way it broke the first time. |
| **R06** — `INVALID_KE_PAYLOAD` taught as hard failure | **RESOLVED (core)** — the v2 entry is correct (retry semantics, `qualifier: v2`, RFC 7296 §1.2, disjoint-sets-only `breaks_if_wrong`). The v1 sibling `explain:error:junos-srx/INVALID-KEY-INFORMATION` is still unwritten — **OWNER-DEFERRED** to expert authorship, deliberately: writing an IKEv1 error entry from memory, with no box and no named reviewer, is precisely the conventions breach ("never fabricate a vendor behaviour") this report exists to catch. The gap is declared in the explainer header's own comment and fails gate P3, so it cannot ship silently. |
| **R07** — PFS-mismatch timing self-contradiction | **RESOLVED** | Unchanged from first pass: explicit v1/v2 branches in both rules, agreeing with `18` §7.3. |
| **R08** — `ike.dh-group.weak` cannot match | **RESOLVED (condition)** — enum-member condition over all six groups, RFC 8247 levels correct. **OWNER-DEFERRED:** the severity split (groups 1 and 22 at `high`) and `ipsec.pfs.group-weak` (ADR-0029: "not optional"), whose absence is the corpus's one remaining structured dangle (`ipsec.pfs.absent.supersedes`, self-documented in `unresolved_refs`). Deferred with the rest of the ADR-0029 rule-authoring tickets — new rules should land behind the fixture gate, not ahead of it. |
| **R09** — verify ladder wrong on a chassis cluster | **RESOLVED (corpus; every addition carries `review_required`)** | Applied in full on the data side. Seven entries added: `ike.sa.show-node-all` and `ipsec.sa.show-node-all` (canonical, `weight: 3`, per the DECIDED resolution), `chassis.cluster.status.show`, `.interfaces.show`, `.statistics.show`, `.failover.request`, `.failover-reset.request` — commands, qualifiers and field vocabulary syntactically plausible against Junos and all marked unverified-on-a-box in VERIFY comments and `sources_note`. `explain:concept:junos.cluster-sa-anchoring` exists at all three depths with the anchoring model, the false-tunnel-down failure mode, and an honest `sources_note` (SYNTHESISED, from the adjudication, not a box). Cross-linked: `ike.sa.show`, `ipsec.sa.show` and the flow-session entry route `next_if_bad` through the node-all forms and the explainer *before* the down-path, which removes the silent false "tunnel down" from the corpus's own ladder; canonicality table extended to fourteen rows with the two new gate-7 collisions flagged for the reviewer rather than hidden; new concept IDs registered; `domain: chassis` added to `61` §3.2's enum (this run). *Named remainder for the next spec pass:* `18` §4's ladder spec and the rule pack do not yet reference the explainer — the resolution's "both rules and the ladder" is satisfied by the corpus ladder only. |
| **R10** — `prefers-contrast: more` cascade | **RESOLVED** | Unchanged from first pass. |
| **R11** — four keymaps, bare `a` accepts | **RESOLVED** | Unchanged from first pass. |
| **R12** — no ownership register | **OWNER-DEFERRED** — `docs/00-vision/01-ownership.md` still does not exist and `conventions.md` still has no `## Ownership` section. Deferred with a stated reason rather than patched: the register assigns ownership, and ownership is the owner's to assign — a verifier writing it would be the same authority inversion R12 was raised against. The mechanism it needs is demonstrably working (the ADR-0011 amendment now sits in `conventions.md` exactly as ADR-0002 prescribes); the file is a prerequisite for onboarding any second author, and is named in §4's remainder. |

---

## 2. Independent cross-reference check — re-run

Re-parsed all three corpus files (clean YAML) and re-resolved every structured reference
(`verify`, `next_if_bad`, `related`, `related_rules`, `supersedes`, `links.to`,
`paired_teardown`, `requires.from`, `id_map`, `canonicality`), including all fifteen
close-round additions.

**Corpus-internal (98 commands, 42 explainers, 37 rules — declared counts match parsed):**

| Defect | Where | Severity |
|---|---|---|
| `supersedes: [ipsec.pfs.group-weak]` → rule does not exist | `rules:ipsec.pfs.absent` | Still the only structured dangle in the corpus. Self-documented in `unresolved_refs`; owner-deferred with R08's rule ticket. |
| `explain:concept:junos.commit-and-sa-lifecycle` → explainer does not exist | 11 VERIFY comments in the command corpus + 2 in the rule pack name it as the consolidation target (R46/C7) | Comment-level only (no structured ref). Thirteen markers now cite an entry nobody has written; the count *grew* by two because the close round's new VERIFY markers correctly cite the same target. Expert item. |
| Everything else | — | **Clean.** All new-entry references resolve both ways: the two node-all entries, the five chassis entries, the cluster explainer's `links` (`phase-split`, `sa-output`, `bring-up-order`), its `related_rules`, and the two `paired_teardown`s added this run. Canonicality's 14 rows exactly match the 14 `weight: 3` entries; both gate-7 collisions (the pre-existing eleventh and the two R09 rows) are flagged in NOTEs for the reviewer. `id_map`'s 12 aliases all resolve. `domain` values all validate against `61` §3.2 as amended. |

**`docs/20-ai/` against the corpus:** `23` §5.2 now cites `junos-srx/ike.sa.clear-peer`
(corrected this run per ADR-0029). The acknowledged remainders stand where ADR-0029 staged
them: `21`'s banner-marked scenarios, `22` §8.1's finding list, `25`'s legacy IDs — all
behind the three rule tickets and the scenario re-run.

---

## 3. Risk-classification audit — all 98 command entries, final

Authorities unchanged: the card's legend, ADR-0011's effect definition, Junos behaviour.
Distribution after the close round: **42 `ReadOnly`, 30 `ChangesConfig`, 26 `Disruptive`.**

### 3.1 The contested list — every entry now has an explicit disposition

The fourteen contests from the first pass, dispositioned:

| Entry | Disposition |
|---|---|
| `ipsec.vpn.gateway.set`, `ipsec.proposal.protocol.set`, `ike.proposal.integrity.set`, `ike.proposal.auth-method.set`, `ike.policy.psk.set`, `ipsec.vpn.ipsec-policy.set` | **Moved to `Disruptive`** — the deferred-at-rekey interruption class, now banded consistently with the reclassified `dh-group`/`encryption` siblings. The proposal-parameter family is no longer split without a principle. |
| `ike.gateway.dpd.set`, `route.static.st0.set` | **Moved to `Disruptive`** — the two entries whose `blast_radius` failed the decided regex while amber. Band moved; prose kept; gate now passes. |
| `ipsec.vpn.vpn-monitor.set`, `ipsec.vpn-monitor-options.set` | **Moved to `Disruptive`** — committing either against a bad target/marginal underlay drops live traffic, multi-tunnel in the options case. |
| `system.commit`, `system.commit-confirmed` | **Upheld `ChangesConfig` as a static default, now annotated** — both entries state in `blast_radius` (plus a machine-readable comment) that generated ladders override the label with the change set's AGGREGATE RISK per ADR-0011 part 6 and `18` §6.4. The contradiction with the ADR is closed by declaration. |
| `ike.policy.mode.set` | **Upheld `ChangesConfig`** — the first pass's weak contest, left amber deliberately: no-op under `version v2-only`, and its `blast_radius` passes the gate. Flagged to the expert reviewer as the one surviving unevenness: on a live v1 gateway a mode flip is the same deferred-break class that sent `psk.set` red. |
| `ipsec.statistics.clear` | **Upheld** — band `ChangesConfig` with `risk_caption_override: "CHANGES STATE — NOT REVERSIBLE BY COMMIT"`, exactly as R18 decided, and now formally legal: `61` §3.2/§4.6 and the conventions amendment both exist. |

### 3.2 The bands, re-swept

The 26 `Disruptive`: the original 14 (all upheld in the first pass), the ten moves above,
and the two R09 failover entries (`request chassis cluster failover` and its reset — the
reset is correctly red: with preemption, clearing the flag can itself move the group). The
42 `ReadOnly`: all `show`/`ping`/`monitor` forms including the five new cluster/`node all`
readers; all correct. One pre-existing naming defect stands for the reviewer:
**`ipsec.sa.clear-vpn`'s `cmd` is still the unscoped `clear security ipsec
security-associations`** — right band, id promises a scoping the command does not have.
C11's `match -i error` hazard now carries its decided VERIFY marker (applied this run).

### 3.3 The decided CI gate, re-run against the shipped file

ADR-0011's regex (`/blackhole|traffic stops|drops .*(adjacency|traffic)|never comes up|stops negotiating/i`),
applied by this verifier to the `blast_radius` of all 72 non-`Disruptive` entries:
**zero matches. Gate 15 passes.** The gate is also now specified where authors will meet
it (`61` §14 gate 15), not only inside the ADR.

### 3.4 Remaining decided domain items (C-series and rule-pack) — final states

| Item | State |
|---|---|
| C1–C6 | Applied and verified (first pass; unchanged). |
| C7 / R46 | Half-applied: VERIFY markers universal; the consolidating explainer unwritten (13 citing markers). Expert item. |
| C8 (split `ike.dpd.absent`) · M23 (re-anchor `no-next-hop-st0`) · M24 (split `zone-pair.one-directional`) | Not applied — owner-deferred with the ADR-0029 rule-authoring tickets, behind the fixture gate. |
| C9 | **Applied** — this is R09, see §1. |
| C10 (`State: Installed` vs summary output) | Not applied — needs a box; the new `ipsec.sa.show-node-all` correctly inherits the C10 VERIFY caveat by comment. Expert item, and the ladder hangs on it. |
| C11 (`match -i error`) | **Applied this run** — decided VERIFY marker now on the entry. Still needs a box. |
| C12 | Half-applied (measured-DF-ping preference documented; `mtu 1400` remediation still bare). Expert item. |
| C13, C14, C15 | Applied; and the close round's count changes are re-propagated by this run (91→98, 41→42 in `71`, `72`, `01`). |
| R44 (fixtures, `reviewed_by`) | Unchanged, honestly declared: zero fixtures, 98/98 command entries (and all rules and explainers) on placeholder reviewers. Phase-0 gate per ADR-0028/0029. |
| R45 (severity budget) | Unchanged: pack still fails V25 as written and says so; `63` carries no amendment. The decided fork is explicitly the reviewer's. |

---

## 4. Edits made by this verification run

Surgical, each traceable; listed for the record:

| File | Change | Per |
|---|---|---|
| `docs/20-ai/23-ai-safety-and-injection.md` | `ike.sa.clear-by-peer` → `junos-srx/ike.sa.clear-peer` (both §5.2 occurrences) | ADR-0029 (named correction); R04 |
| `docs/60-content/61-command-corpus-spec.md` | `chassis` added to §3.2's `domain` enum | R09 (the seven cluster entries must validate) |
| `corpus/commands/junos-srx-ipsec.yaml` | VERIFY marker on `interface.wan.errors.show`'s `match -i error` | C11 (DECIDED) |
| `corpus/commands/junos-srx-ipsec.yaml` | `paired_teardown` added to both failover entries (mutual, mirroring the traceoptions pattern) | R09 + `61` §4.4 (`paired` requires the pair named) |
| `docs/70-ops/71-roadmap.md`, `docs/70-ops/72-risks.md`, `docs/00-vision/01-vision-and-thesis.md` | seed-corpus counts 91→98 (and 41→42 explainers) | C15's consistency principle, counts moved by R09 |
| `docs/80-review/87-verification-report.md` | this report, refreshed in place | the work order |

---

## 5. Fit to ship?

**Fit to hand to the expert reviewer ADR-0028 requires — and not fit to ship to a user
until that named review and the phase-0 fixture gate complete, which is the corpus's own
stated bar, not a new one.**

Every Blocker is now either resolved in the files or deferred by an Accepted decision with
its reason recorded above. Nothing found in this pass contradicts an Accepted ADR, the
corpus parses clean with one self-documented dangle, the decided CI gate passes, and where
the corpus does not know something it now says so in a machine-findable way. The honest
remainder — the specific items that need a human expert's eyes, in order:

1. **The cluster material (R09) end-to-end, hardest first.** Seven command entries and the
   `cluster-sa-anchoring` explainer were written from the adjudication, not a box. Syntax,
   `node` qualifier forms, per-node banners, the empty-node rendering, SA re-anchoring on
   failover, and preemption-on-reset behaviour all need a cluster and a named reviewer.
2. **The two ladder-critical VERIFYs:** C10 (`State: Installed` vs summary output — the
   field the whole verify ladder hangs on) and C11 (`match -i error`).
3. **The 36 VERIFY markers generally, and R46 specifically:** commit-time SA behaviour per
   train, plus authoring `explain:concept:junos.commit-and-sa-lifecycle`, which 13 markers
   already cite.
4. **The ADR-0029 rule tickets:** `ipsec.pfs.group-weak` (clears the last dangle), the R08
   severity split, C8's DPD split, M23's re-anchor, M24's directional split, and the three
   AI-scenario rules — all behind the R44 fixture gate, which is itself the first build task.
5. **The R45 fork:** demote one `high` or amend `63`; the pack fails V25 until a human picks.
6. **Judgement calls flagged, not made:** the three gate-7 canonicality collisions,
   `ipsec.sa.clear-vpn`'s id/cmd scoping mismatch, the missing `ipsec.sa.clear-index`
   entry, `ike.policy.mode.set`'s amber, and propagating `node` awareness into `18` §4's
   ladder spec and the rule pack.
7. **Governance (R12):** the owner writes `01-ownership.md` and the conventions
   `## Ownership` section before any second author touches the corpus.
8. **Invariant 10, the bar itself:** 98 command entries, 42 explainers and 37 rules all
   carry `reviewed_by: <named human>` placeholders the build must reject. The corpus is,
   by its own rules, a reviewed corpus or it is nothing — and the review is now the only
   thing standing between this material and a shippable seed.
