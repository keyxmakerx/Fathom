# 87 — Adversarial re-verification of the repaired corpus

> **Status:** Accepted — verification record, run 2026-07-28 against the working tree at
> `a801d1d` + uncommitted repairs ("Checkpoint: repair pass in progress").
>
> Method: independent. The three corpus YAML files were re-parsed from scratch and every
> cross-reference re-resolved by script; no repair agent's report was consulted. Every risk
> value was re-read against the field card's three-colour legend, ADR-0011's effect
> definition, and Junos behaviour. Each of the twelve Blockers in `80-reconciliation.md`
> was re-checked against the files it names.

**Headline: 5 of 12 Blockers RESOLVED, 6 PARTIALLY, 1 (R09) STILL-OPEN with nothing
applied. The corpus data is in far better shape than the specification documents that
govern it — the repair round fixed the YAML and under-delivered on the docs the YAML is
supposed to be checked against. The README's claim that "all twelve blockers are closed in
`docs/90-decisions/`" is true of the *decisions* and not yet of the *files*.**

---

## 1. Blocker-by-Blocker verdicts

| ID | Verdict | Evidence |
|---|---|---|
| **R01** — two container formats | **RESOLVED** | `17` §1 rewritten to fixed shards (`S_nodes`/`S_edges` fixed at creation), whole-record rewrite, merge driver deleted, per ADR-0012/0013 (`17` lines 72–96, 214, 294–327). `32` §6 replaced with a deferral to `17` (`32` line 654–660). `73` D15 now records "Sharded, `S_nodes = 64`". Ownership split visible in both documents' headers. |
| **R02** — crypto-erasure falsehood | **RESOLVED** | `36` Q9 (lines 237–247) now states crypto-erasure is not available against a backup containing the keyholder record and *withdraws* the prior answer by name (ADR-0015). `37` §7.4 retitled "Crypto-erasure — not available here (rewritten per ADR-0015)"; `37` §10 P6 row and the deletion table (line 561) corrected consistently. |
| **R03** — no `set` line can be `Disruptive` | **PARTIALLY** | *Applied:* all ten §6.1 reclassifications verified in `corpus/commands/junos-srx-ipsec.yaml` (now 37 ReadOnly / 40 ChangesConfig / 14 Disruptive); the `ike.mode.aggressive-with-psk` remediation line carries `risk: Disruptive`; `ipsec.statistics.clear` carries the R18 caption override. *Not applied:* **`13` §5.5 line 604 still labels `clear security ipsec security-associations index <n>` `ChangesConfig`** — the exact contradiction with `18` §7.4 that R03 part 4 decided in `18`'s favour — and the row still names a command the corpus does not contain (no `ipsec.sa.clear-index` entry was added either). **`61` §4 was not amended**: no effect-based definition of `Disruptive` ("iff committing or running the statement can interrupt an established flow, SA or adjacency"), no `risk_caption_override` field in `61` §3.2, and the ADR-0011 CI regex gate is specified nowhere outside the ADR. `.context/conventions.md`'s risk-enum section is unamended, so the caption override the corpus now uses is formally a convention breach until §9.2's amendment lands. Two shipped `blast_radius` strings fail the decided regex while amber — see §3.4. |
| **R04** — fabricated AI evidence base | **PARTIALLY** | `21` §12 and §13 now open with "Superseded (R04, …). Retained as the design argument it was; not evidence" banners, consistent with ADR-0029's staging (scenarios not re-run until the three ticketed rules land). *Not applied:* **`23` §5.2 still cites `ike.sa.clear-by-peer` twice** (lines 497–498) where ADR-0029 explicitly corrects it to `junos-srx/ike.sa.clear-peer`; `22` §8.1's worked finding list (lines ~2090) still shows `ike.dh-group.legacy`, `ike.version.v1`, `ike.auth-algorithm.sha1` — none resolve, no banner; `25` §6.3/§7 still cite `mtu.st0.show`, `flow.tcp-mss.show`, `ping.dnf-sized` (legacy IDs; two are id_map aliases, one is not); the ID-resolution CI grep is stated only inside ADR-0029, not in `45-testing-strategy.md` or `35`. The three missing-rule tickets exist only as a sentence in ADR-0029. |
| **R05** — `zone.host-inbound.ike-missing` false-fires | **PARTIALLY (rule fixed; fixture absent)** | Verified in `corpus/rules/ipsec-junos-srx.yaml`: the rule is re-anchored on `kind: ZoneMember`, the condition implements the full disjunction including `all` on both the edge and the zone-wide set, and the remediation is `add_to_set` on `self` (the edge), emitting the per-interface form. `acceptable_when` rewritten per M26. The decided `must_pass` fixture that is literally side 1 piece #3 does **not** exist — the pack still contains zero fixtures (its own header says so), which is the mechanism (R44) that let R05 through the first time. |
| **R06** — `INVALID_KE_PAYLOAD` taught as hard failure | **PARTIALLY** | Explainer verified rewritten around retry semantics ("returns INVALID_KE_PAYLOAD carrying the group number it wants… appears exactly once"), `subject.qualifier: v2` present, re-cited to RFC 7296 §1.2, `misdiagnosed_as` deleted, `breaks_if_wrong` corrected to disjoint-sets-only. *Not applied:* **`explain:error:junos-srx/INVALID-KEY-INFORMATION` (the v1 sibling) was never written** — the explainer corpus has 41 entries and it is not among them. |
| **R07** — PFS-mismatch timing self-contradiction | **RESOLVED** | `ipsec.pfs.group-mismatch.why` and `.symptom_if_mismatched` now carry explicit v1 (immediate Quick Mode failure, `NO_PROPOSAL_CHOSEN`) and v2 (installs at `IKE_AUTH`, fails at first `CREATE_CHILD_SA`, force with `clear … index <id>`) branches; `ipsec.pfs.absent.symptom_if_mismatched` matches; both agree with `18` §7.3. The contradiction is gone. (Implemented as prose branches rather than structured version predicates — defensible, since IKE version is a config property, not a Junos train, and `versions:` cannot express it.) |
| **R08** — `ike.dh-group.weak` cannot match | **PARTIALLY** | Condition verified fixed: `dh_group in [group1, group2, group5, group22, group23, group24]` — enum members, all six groups. `why` states all four RFC 8247 levels correctly. *Not applied:* **severity is still flat `medium`** — the decided split (groups 1 and 22 at `high` as MUST NOT) is absent; and **`ipsec.pfs.group-weak` is still unwritten** ("not optional" per R08 and ADR-0029), leaving a dangling `supersedes:` on `ipsec.pfs.absent` that the file's own `unresolved_refs` section documents. |
| **R09** — verify ladder wrong on a chassis cluster | **STILL-OPEN** | Nothing applied. The command corpus has exactly 91 entries; zero contain a `node` qualifier; none of `show chassis cluster status`/`interfaces`/`statistics` or `request chassis cluster failover` exist; `explain:concept:junos.cluster-sa-anchoring` is not in the explainer corpus; `18` §7's ladder is unchanged (no `node` mention). The silent false "tunnel down" on the corpus's own worked topology — the failure the register says "blocks ship because the failure is silent" — still ships. |
| **R10** — `prefers-contrast: more` cascade | **RESOLVED** | `55` §2.6 carries the three-block rewrite verbatim (light AAA under `:root, :root[data-theme="light"]`; dark AAA under `(prefers-contrast: more) and (prefers-color-scheme: dark)` with `:root:not([data-theme="light"])`; and separately under `:root[data-theme="dark"]`), with the defect documented in a comment. §2.7 amended: the gating check moves to the resolved cascade under all eight theme×contrast×forced-colors states; hand-typed tables replaced by generated values / `≥ 7.0`. |
| **R11** — four keymaps, bare `a` accepts | **RESOLVED** | `53` §3.8 keeps `⇧A`/`⇧R` and says the binding is a security control. `54` §23/§15/§19 and `55` §4.5.6 verified replaced with "Superseded — R11, ADR-0024" pointers; `54`'s AI-review section explicitly retires the bare-letter Accept; `52`/`54`/`55` headers all name `53` as sole keymap owner; scoping fixes (`n`/`p` diff-scoped, `Esc` one-level) present. |
| **R12** — no ownership register | **PARTIALLY** | ADR-0001 is Accepted and its precedence rule is being *used* (ownership citations now appear inline throughout `17`, `32`, `52`, `54`, `55`). But **`docs/00-vision/01-ownership.md` does not exist** — the file ADR-0001 says "is written before any other item in this ADR set is executed" — and `.context/conventions.md` contains **no `## Ownership` section** and none of the R17/ADR-0002 invariant amendments. The register that prevents recurrence is still only a decision about a register. |

---

## 2. Independent cross-reference check

Re-parsed all three corpus files and resolved every structured reference
(`verify`, `next_if_bad`, `related`, `supersedes`, `links.to`, `id_map`, `canonicality`),
then swept raw text for ID-shaped literals. Results:

**Corpus-internal (91 commands, 37 rules, 41 explainers):**

| Defect | Where | Severity |
|---|---|---|
| `supersedes: [ipsec.pfs.group-weak]` → rule does not exist | `rules:ipsec.pfs.absent` | The only structured dangle in the corpus. Self-documented in `unresolved_refs`, which also concedes ADR-0029 "decides it is not optional". |
| `explain:concept:junos.commit-and-sa-lifecycle` → explainer does not exist | 9 VERIFY comments in the command corpus + 2 in the rule pack point at it as the consolidation target (R46/C7) | The VERIFY half of R46 was applied; the consolidate-into-one-explainer half was not, so eleven markers reference an entry nobody wrote. |
| `id_map` legacy aliases | 12 rows | All map to real entries; correct. |
| Everything else | — | Clean. All `verify`/`next_if_bad`/`related`/`links` resolve. Canonicality's 11 rows match the 11 `weight: 3` entries (header F6 now correctly says "Eleven" — C14 applied). Counts verified: 91 entries; 37 rules at 13 high / 13 medium / 8 low / 3 info; `severity_distribution.v25_status` honestly records the 16% failure (C13 applied). `71`/`72` now say "91 seed" (C15 applied). |

**`docs/20-ai/` against the corpus (the R04 sweep):** unresolved rule/corpus/explainer IDs
remain in all five documents. In `21` they sit inside the two scenarios now banner-marked
"not evidence" — acknowledged and acceptable under ADR-0029's staging. **Unacknowledged**
remainders: `22` §8.1's finding list (`ike.dh-group.legacy`, `ike.version.v1`,
`ike.auth-algorithm.sha1`, `ike.proposal.mismatch`); `23` §5.2 (`ike.sa.clear-by-peer` ×2,
explicitly named for correction by ADR-0029); `25` (`mtu.st0.show`, `flow.tcp-mss.show`,
`ping.dnf-sized`, `ipsec.sa.state`, plus `explain:field:*`/`explain:value:*` forms that
exist in no shipped explainer class). The decided CI grep would fail today on all of these.

---

## 3. Risk-classification audit — all 91 command entries

Audited against three authorities: the card's legend (`READ-ONLY — SAFE ON PRODUCTION` /
`CHANGES CONFIG — NEEDS A COMMIT` / `DISRUPTIVE — DROPS LIVE TRAFFIC`), ADR-0011's decided
definition (*"`Disruptive` iff committing or running the statement can interrupt an
established flow, SA or adjacency on a device already carrying traffic"*), and Junos
behaviour. Distribution: 37 `ReadOnly`, 40 `ChangesConfig`, 14 `Disruptive`.

### 3.1 The 14 `Disruptive` entries — all upheld

| Entry | Verdict |
|---|---|
| `ike.proposal.dh-group.set`, `ike.proposal.encryption.set`, `ipsec.proposal.encryption.set`, `ipsec.policy.pfs.set`, `ike.gateway.version.set`, `ipsec.vpn.bind-interface.set`, `ipsec.vpn.establish-tunnels.responder-only.set`, `interface.st0.address.set`, `zone.st0.bind.set`, `interface.st0.mtu.set` | The ten §6.1 reclassifications, all present and correct per ADR-0011. Deferred-failure entries correctly carry the R46 VERIFY marker on commit-time SA behaviour. |
| `ipsec.sa.clear-vpn`, `ike.sa.clear-peer`, `ike.sa.clear-index`, `ike.sa.clear-all` | Correct — these are the card's own red band. One naming defect: **`ipsec.sa.clear-vpn`'s `cmd` is the *unscoped* `clear security ipsec security-associations`** (box-wide, "tears down every child SA on the box") while its id says `clear-vpn`. The risk is right; the id promises a scoping the command does not have, which is exactly the id/command mismatch class `13` §5.5 already tripped over. |

### 3.2 The 37 `ReadOnly` entries — all clear

All are `show`, `ping` or `monitor start|stop` forms. `ping … rapid count 50` and
`monitor start kmd` generate load but interrupt nothing; correctly green. One content
defect rides in this band: `interface.wan.errors.show` still ships
`… | match -i error` with **no VERIFY marker** — C11 (DECIDED) was not applied, and the
failure mode C11 names (filter silently matches nothing, operator reads "no errors") is
the worst one a diagnostic can have. The risk band itself is correct.

### 3.3 Contested `ChangesConfig` entries

These are the entries I would still argue, entry by entry. None was decided by the
register beyond the "at minimum" eleven, so these are audit findings, not unapplied
decisions — but ADR-0011's definition is now the standard, and it is not being applied
evenly.

| Entry | Contest and reasoning |
|---|---|
| `ipsec.vpn.gateway.set` | **Strongest contest.** Its own `blast_radius` says repointing on a live VPN "**tears down the child SAs** and rebuilds them under the new IKE SA" — an immediate interruption of established SAs, which is ADR-0011's definition verbatim. This entry is more clearly `Disruptive` than several of the ten that were reclassified. |
| `ike.gateway.dpd.set` | `blast_radius` contains "**traffic stops** while it renegotiates" — a literal match for ADR-0011's decided CI regex on a non-`Disruptive` entry. Either the band moves or the prose changes; as shipped, the decided gate fails the build on this entry. Substantively: committing an over-tight DPD against a lossy underlay tears down healthy tunnels — `Disruptive` is defensible and "round up" (`61` §4) points that way. |
| `route.static.st0.set` | `blast_radius` contains "**blackholes**" — the second literal regex match on an amber entry. Substantively: diverting a live prefix into a tunnel interrupts established flows for that prefix. Contest to `Disruptive`, or the prose must honestly say the stop is conditional. |
| `ipsec.proposal.protocol.set` | "Changing an established tunnel from ESP to AH **stops it carrying encrypted traffic** and breaks it entirely through any NAT" — same effect class as `ipsec.proposal.encryption.set`, which is `Disruptive`. The proposal-parameter family is now split amber/red with no stated principle. |
| `ike.proposal.integrity.set`, `ike.proposal.auth-method.set` | Identical failure shape to `ike.proposal.encryption.set`/`dh-group.set` (P1 proposal mismatch → tunnel stops rebuilding at SA expiry), which are red. If deferred-at-rekey interruption qualifies for the red band — and the register decided it does when it reclassified `dh-group` — these qualify equally. The current boundary inside the family is unprincipled and will not survive review. |
| `ike.policy.psk.set` | "The running SA survives until its lifetime expires and **then fails to rebuild** if the peer was not changed in the same window" — the same deferred-drop class. Same argument. |
| `ipsec.vpn.ipsec-policy.set` | "Can stop the child SA installing" at next rekey — the failure shape for which `ipsec.policy.pfs.set` was moved to `Disruptive`. Same argument. |
| `ipsec.vpn-monitor-options.set` | Global to every monitored tunnel: "a marginal underlay then **tears down several healthy tunnels together**". Committing this statement can interrupt established flows on many tunnels at once — the multi-tunnel blast radius argues red more strongly than several reclassified entries. |
| `ipsec.vpn.vpn-monitor.set` | "A probe target that does not answer ICMP from inside the selector **will flap a healthy tunnel continuously**" — committing it against a bad target drops live traffic and keeps dropping it. Contest to `Disruptive`; at minimum the blast radius phrasing puts it in the gate's class. |
| `system.commit`, `system.commit-confirmed` | Static `ChangesConfig`. ADR-0011 part 6 decided `commit` inherits the change set's aggregate risk and calls a fixed label "meaningless". `18` §6.4 computes `AGGREGATE RISK`, but the corpus entries carry no note that their label is a default overridden in generated ladders. A one-line annotation closes it; silently static, the entries contradict the ADR. |
| `ike.policy.mode.set` | Weak contest, noted for completeness: flipping v1 mode on a live v1 gateway breaks the next negotiation (deferred class); on v2 it is a no-op, which the blast radius correctly states. Tolerable amber. |
| `ipsec.statistics.clear` | Not contested — the R18 band-plus-caption-override treatment is applied exactly as decided (`CHANGES STATE — NOT REVERSIBLE BY COMMIT`, same band). But note §1 R03: the convention this override relies on has not been amended, so a legend-consistency CI check written against `conventions.md` as it stands would fail this entry. |

### 3.4 The decided CI gate, run against the shipped file

ADR-0011's regex (`/blackhole|traffic stops|drops .*(adjacency|traffic)|never comes up|stops negotiating/i`
on non-`Disruptive` entries) **fails the build today**: `ike.gateway.dpd.set` ("traffic
stops") and `route.static.st0.set` ("blackholes"). Either those two entries move to red,
their prose is revised, or the gate is knowingly waived — but the gate is a decided
resolution and it does not pass on the repaired corpus.

### 3.5 Remaining decided domain items checked (C-series and rule-pack)

| Item | State |
|---|---|
| C1–C6 (PFS timing, NAT scope + condition, identity `&&`, host-inbound edge) | **Applied and verified** (see R05–R08 above; `ike.identity.mismatch` condition is now `has(...) && has(...) && !=`, `nat.source-nat-eats-tunnel` condition carries `nat_scope_covers(parent_ruleset.to, …)` and the predicate is defined). |
| C7 / R46 (commit-time SA behaviour) | **Half-applied**: VERIFY markers present on every asserting entry; the consolidating explainer does not exist (see §2). |
| C8 (split `ike.dpd.absent` from `ike.dpd.too-slow`) | **Not applied** — one rule still folds "no DPD at all" (eight hours of blackhole on the card's 28800 s lifetime) into "waits more than 30 seconds" at `medium`. |
| C9 (node-all ladder variants) | **Not applied** (R09). |
| C10 (`State: Installed` against summary output) | **Not applied** — `ipsec.sa.show`'s `output_fields` still key on `State/Installed` with no VERIFY, and this is the field the verify ladder hangs on. |
| C11 (`match -i error`) | **Not applied** (§3.2). |
| C12 (derived MSS/MTU) | **Half-applied** — `suggested_mss` is now documented as a starting point preferring a measured DF-ping; `mtu.st0.unset`'s remediation still emits a bare hard-coded `mtu 1400` with no starting-point label. |
| C13, C14, C15 (arithmetic) | **Applied** — recounts verified correct by this audit. |
| M22 (dead `supersedes` on `.not-mirrored`) | **Applied** (deleted). |
| M23 (re-anchor `route.remote-prefix.no-next-hop-st0` to `IpsecVpn`) | **Not applied** — still `kind: TrafficSelector`, so the most valuable plumbing check still cannot bind on a selector-less route-based VPN, the commonest shape in the field. ADR-0029 names this explicitly. |
| M24 (split `policy.zone-pair.one-directional`) | **Not applied** — single rule, one direction tested, reverse-direction failure still taught but unchecked. |
| M26 (`acceptable_when` rewrites) | **Applied** for the four named fields (verified: staging-only text on host-inbound; concrete 100 Mbit/s threshold; jumbo-underlay text on mss-clamp). The `never` vs `transient_only` *vocabulary split* is not implemented as a field — two rules still say "Never as a steady state… acceptable transiently" in prose. |
| R44 (fixtures, `reviewed_by`) | **Unchanged, honestly declared** — still zero fixtures, still `<named reviewer>` placeholders. Tracked as a phase-0 gate by ADR-0028/0029; not a repair-round failure, but it is why R05-class defects have no regression net. |
| R45 (severity budget) | **Recounted honestly** (`v25_status: FAILS as written… 16%`), but the decided fork — demote one `high` or amend `63` — is explicitly left to "the reviewer" and `63` carries no amendment. `ipsec.pfs.group-mismatch` is still `high`. The pack still fails V25 and now says so; a build against `63` as written still rejects it. |

---

## 4. Fit to ship?

**No — not as reference material, and the remaining gap is narrow and legible.** The
repair round genuinely closed the customer-facing falsehoods (R02, R27-class), the
container schism (R01), the design blockers (R10, R11), and the worst of the rule-pack
domain errors (R05, R06-core, R07, R08-core, C1–C6). The corpus YAML now largely says
true things, and where it does not know, it says so.

What still blocks, in order:

1. **R09 is untouched.** The verify ladder still produces a silent false "tunnel down" on
   the corpus's own worked topology. The register called this ship-blocking on its own; it
   is the only Blocker with zero file evidence of repair.
2. **The risk framework is applied to the data and absent from the spec.** `61` §4, `13`
   §5.5 and `conventions.md` still teach the old world; the next 400 entries will be
   authored against documents that never received ADR-0011. Two shipped entries fail the
   ADR's own CI gate, and the boundary inside the proposal-parameter family (§3.3) is
   indefensible in review.
3. **Known-dangling content:** the missing v1 error explainer (R06), the missing
   `commit-and-sa-lifecycle` explainer that eleven VERIFY markers cite (R46), the missing
   `ipsec.pfs.group-weak` (R08), the DPD/zone-pair splits and the `no-next-hop-st0`
   re-anchor (ADR-0029, all named "not optional").
4. **Governance artifacts:** `01-ownership.md` and the conventions amendments (R12, R17)
   exist only as Accepted ADRs. Until the register file exists, the mechanism that caused
   R01/R13/R14 has been decided away but not built away.
5. **Invariant 10 remains breached by declaration** (no reviewer, no fixtures) — accepted
   as a phase-0 gate, but it means nothing in `corpus/` may be called shippable yet by the
   corpus's own rules.

None of item 1–4 is more than days of work, and nothing found in this pass contradicts an
Accepted ADR — the failures are all under-application, not mis-application. One more
repair pass scoped to exactly the STILL-OPEN/PARTIALLY rows above, plus the R44 fixture
gate, and the corpus is fit to hand to the expert reviewer ADR-0028 requires.
