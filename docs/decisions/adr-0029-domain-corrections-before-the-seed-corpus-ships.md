# ADR-0029 — Domain corrections before the seed corpus ships

> **Status:** Accepted
> **Date:** 2026-07-28
> **Register entry:** new — raised by `82` §§3–15, §18, §21; `85` F1, F15; `83` P11, P12, P13
> **Reversal cost:** R1 per entry now; **R5 in reputation** once published as reference
> **Supersedes:** the shipped conditions of six seed rules; `21` §§12–13's worked scenarios

## Context

`82` §0 calibrates first: this is a strong corpus. RFC 8221 §5 and §4, Junos DPD defaults, IKEv1/v2
message counts, the first Child SA keyed from the IKE SA with no KE payload, ESP and NAT-T header
sizes, `MSS = tunnel MTU − 40`, AH and NAT, PMTUD as Type 3 Code 4, and the `commit confirmed` blast
radius are all correct and correctly cited. The `blast_radius` prose across all 40 configuration
entries is uniformly high quality.

Six things in it are wrong in ways a working network engineer will find in the first hour, and three
of them fire `high` false positives on a **correctly built** branch firewall.

| # | Defect | Consequence |
|---|---|---|
| **1** | **`zone.host-inbound.ike-missing` false-fires on the card's own syntax, and its auto-fix widens exposure.** The IR (§7.5) says `host-inbound-traffic` exists zone-wide *and* per-interface on the `ZoneMember` edge, and writes the correct condition. The rule implements only the zone-wide half and does not test for `all`. Its remediation then emits the **zone-wide** form — opening IKE inbound on every interface in the WAN zone | The most-missed, highest-value rule in the pack is a guaranteed false positive against configurations written exactly as the card teaches, **and its one-click fix is a security regression**. `36` says the opposite is required: *"an emitter that prefers the per-interface form"* |
| **2** | **`INVALID_KE_PAYLOAD` is described as a hard failure; RFC 7296 §1.2 makes it a retry.** The responder names the group it wants and *"the initiator MUST retry"*. It appears exactly once in a healthy IKEv2 bring-up. The citation given is §1.3, which says nothing about it, and it is IKEv2 notify type 17 carried under `versions: "*"` — it cannot appear on an IKEv1 gateway at all | An engineer on IKEv2 is told a benign, self-correcting notify is fatal and sent to edit crypto on a working tunnel. An engineer on IKEv1 is told to expect a string that cannot appear |
| **3** | **The corpus contradicts itself on when a PFS mismatch breaks.** `ipsec.pfs.absent` says correctly *"under IKEv2 the first child SA is always keyed from the IKE SA regardless"*; `ipsec.pfs.group-mismatch`, three rules earlier, says *"the child SA never installs"* | On IKEv2 the tunnel is up now and fails an hour after the change window closes — precisely the failure `18` §7.3 was written to prevent |
| **4** | **`ike.identity.mismatch` false-fires `high`/`definite` on a common working design.** `(has(local_identity) \|\| has(peer.remote_identity)) && local_identity != peer.remote_identity` treats an *absent* peer field as a disagreeing value rather than as "no constraint" | A `definite` finding asserting authentication *cannot* succeed, on a design that succeeds every day. This is the rule that gets the pack disabled |
| **5** | **`ike.dh-group.weak` compares an enum against integers and misses the groups RFC 8247 marks hardest.** `dh_group in [1, 2, 5]` against a `DhGroup` enum either fails to compile or **silently never matches**; and groups 22 (MUST NOT), 23 and 24 pass clean | A rule advertised as catching legacy DH gives a clean bill of health to `group22` and `group24` |
| **6** | **`nat.source-nat-eats-tunnel` states a mechanism the SRX does not have** and its condition ignores rule-set scope entirely, so every device with an internet source-NAT rule matching `0.0.0.0/0` and any tunnel fires it | A `high` finding on essentially every SRX in the world that has both internet access and a VPN |

Beyond the rules, three structural problems:

- **The AI documents' evidence base is fabricated** (`85` F1). Eleven of eleven cited rule IDs do not
  exist in `corpus/`, plus three corpus IDs quoted verbatim. Five are spelling; five are not; and two
  carry the argument — including the one `21` §12.4 labels *"DETERMINISTIC WIN #4, and the most
  important one in this scenario"*. Every worked example is a payload `22`'s own gate G1 would reject.
- **The severity arithmetic does not close** (`82` §10, `83` P11/P13). The header says 13 of 36 rules
  are `high`; the file has 37. The proposed exemption computes 2 high out of 23 non-correctness
  rules; the real figures are 4 out of 25 = **16%**, outside the 15% gate it was written to pass.
  `F6` says ten entries carry `weight: 3`; there are eleven, and gate 7 permits one per
  (concept, platform).
- **The IR cannot express a chassis cluster** (`82` §15), and every worked example in the corpus is
  one. `reth-count` and `aggregate_device_count` are referenced and undefined; `Chassis` has no
  per-node `hostname` or `management_address`; `fab0`/`fab1` have no kind, field or edge. Emitting
  `13` §8.3(a) against a fresh SRX cluster **produces a configuration that does not commit**. And the
  verify ladder is wrong on a cluster: `show security ike|ipsec security-associations` accept a
  `node (0|1|all|local|primary)` qualifier and return nothing on the wrong node — a false "tunnel
  down" produced by the tool's own recommended procedure, on the tool's own worked topology.

## Decision

**None of this ships as reference material. The corrections are a phase-0 gate.**

**Rules.** Re-anchor rule 1 to the `ZoneMember` edge per IR §7.5, implement the full disjunction
including `all`, change the remediation to `add_to_set` on the **edge**, and add a `must_pass`
fixture that is literally side 1 piece #3. Rewrite rule 2's explainer around retry semantics, add
`subject.qualifier: v2`, split an `INVALID-KEY-INFORMATION` entry for v1, and re-cite to RFC 7296
§1.2. Version-predicate both PFS rules with a v1 branch (immediate Quick Mode failure) and a v2
branch (installs; fails at first child rekey — force one with `clear … index <id>` inside the
window), linked to `18` §7.4 step 5. Change rule 4 to `has(local_identity) && has(peer.remote_identity)`
and move the one-sided case to `ike.identity.required-behind-nat` at `probable`, where it already
belongs. Fix rule 5 to use `enum_is`/set membership over `DhGroup` across groups 1, 2, 5, 22, 23, 24,
split severity (1 and 22 are MUST NOT ⇒ `high`), correct the `why`, and add the missing
`ipsec.pfs.group-weak`. Add `nat_scope_covers(scope, unit)` to the derived predicates and scope
rule 6's condition to the VPN's `bind_interface`.

Also: split `ike.dpd.too-slow` into `ike.dpd.absent` (`high`) and `ike.dpd.too-slow` (`medium`) —
folding "no DPD at all" into "waits more than 30 seconds" understates the worst case by three orders
of magnitude, because on the card's own `lifetime-seconds 28800` it is eight hours of blackhole.
Split `policy.zone-pair.missing` into "neither direction" and `policy.zone-pair.one-directional`
(`low`/`probable`), because the rule currently teaches a reverse-direction failure it does not check.
Delete the dead `supersedes` on `ipsec.traffic-selector.not-mirrored`, and re-anchor
`route.remote-prefix.no-next-hop-st0` to `IpsecVpn`, since a route-based VPN with no traffic selector
is the most common shape in the field and the rule cannot bind to it.

**Unsourced vendor behaviour.** Every claim that a crypto change *"drops the tunnel at the current
SA's lifetime rather than at commit"* becomes `<!-- VERIFY -->` until the lab (ADR-0027) records the
answer per train, consolidated into one explainer
(`explain:concept:junos.commit-and-sa-lifecycle`) that all of them reference. `18` §7.3 handles the
identical question correctly and the corpus asserts. **This is the single sentence that decides
whether an engineer schedules a change window.**

**Four `acceptable_when` fields are rewritten** (`82` §18): `zone.host-inbound.ike-missing`'s
exception describes a state nobody can configure on someone else's box; `mtu.mss-clamp.absent`'s
exception would produce the exact symptom the rule catches; `ipsec.lifetime.kilobytes-unset-on-busy`
needs a concrete threshold or it is unfalsifiable; and the vocabulary splits `never` from
`transient_only`, because two rules say "never as a steady state" and then describe a transient
window.

**Corpus IDs must resolve.** A CI check greps `docs/**` for `RuleId`/`CorpusId`-shaped literals and
fails on any that does not resolve in `corpus/` — the same class as `23` §9.4's DI-2 grep, an
afternoon's work. Three missing rules are filed as authoring tickets: `ike.version.v1-in-use`,
`ike.proposal.sha1`, `ipsec.traffic-selector.multiple-under-v1`. **`21` §§12–13's scenarios are not
re-run until those land**, and the rewritten versions will show the model contributing less than the
current text implies, which is the honest picture. `23` §5.2's `ike.sa.clear-by-peer` is corrected to
`junos-srx/ike.sa.clear-peer`.

**Arithmetic.** Recount. Then either demote one `high` — `ipsec.pfs.group-mismatch` is the natural
candidate, since its `high` rests on the claim corrected above — or argue the budget change in `63`
on its merits as a per-domain exemption with a stated cap. **The argument belongs in `63` as an
amendment, not as a comment in a data file that CI will reject.**

**The chassis cluster.** Add `Device.aggregate_device_count` and `Device.reth_count` to `11` §6.3
with `Emit: R*`; add a `Fabric` variant to `Interface.form` plus a `MemberOfFabric` edge; move
`hostname` and `management_address` to `Chassis` with `Device.hostname` becoming the cluster-wide
name; record `apply-groups` non-expansion as a stated **emit blocker** for clustered devices rather
than only a parse limitation. **Until that lands, `43` and `56` stop using a cluster as the worked
example**, because the schema cannot round-trip it. Add the cluster operational commands (`show
chassis cluster status|interfaces|statistics`, `request chassis cluster failover …`) and the
`node all` variants of the SA ladder.

## Consequences

### Positive

- The pack stops firing three `high` false positives on a correctly built branch firewall, which is
  the specific mechanism the brief says gets a linter muted within a week — and the rule it would
  have killed first is the one that matters most.
- A one-click fix stops widening an attack surface to silence itself, which is the failure
  `policy.zone-pair.missing`'s own `remediation_absent_reason` says must never happen.
- Two documents stop telling an engineer opposite things about when a PFS mismatch breaks, on the
  platform where the difference is an hour after the change window closes.
- The AI corpus stops demonstrating its design with outputs its own gates would refuse, and three
  real corpus gaps stop being disguised as solved problems.
- The verify ladder stops producing a false "tunnel down" on the topology every example uses.

### Negative

- **This is weeks of domain work on the critical path, before anything ships.** Eight rules rewritten
  with fixtures at 45–90 minutes each, an explainer split, a schema extension, cluster commands
  authored, and lab time to close the `VERIFY` markers. `84` §7 argues the minimum useful artifact is
  a fortnight; this decision puts real work in front of it.
- **`<!-- VERIFY -->` on the commit-time SA question means the corpus ships saying "we do not know"
  on the sentence that decides whether an engineer books a maintenance window.** That is honest and
  it is worse for the user than the confident wrong answer, right up until the confident wrong answer
  costs somebody an outage.
- **Recounting will probably confirm the pack fails `63`'s 15% `high` budget**, so a real amendment
  to `63` is needed — and a per-domain exemption is the beginning of every budget's erosion. The gate
  exists because severity inflation is how linters die.
- **The schema extension for clusters is not small.** Per-node hostnames and management addresses
  restructure `Device` and `Chassis`, and `14` §5.1's non-expansion of `apply-groups` becomes an emit
  blocker rather than a parse limitation — which means the emitter must refuse to produce output for
  a shape the corpus uses everywhere.
- **Rewriting `21`'s worked scenarios against real rules tells a smaller story**, and those scenarios
  are the most persuasive artifacts in the AI corpus. The persuasion was resting on rules nobody
  wrote.
- **Splitting rules increases the rule count**, which increases the fixture count, the review burden
  and the maintenance surface — against `72` §4's finding that the corpus is the constraint.

## Alternatives considered

| Option | Strongest argument for it | Why rejected |
|---|---|---|
| **Ship the seed pack and fix on feedback** | It is 37 rules of genuinely good work, most of them correct, and real users find real defects faster than review does | Three `high` `definite` false positives on a correct configuration, and a remediation that opens IKE inbound on every interface in a zone. The first pilot disables the pack in week one and does not come back |
| **Suppress the six defective rules and ship the rest** | Fastest path to a shippable pack, and suppression is a first-class mechanism | The six include the most-missed, highest-value rule in the pack. Shipping the pack without it ships the pack without its reason to exist |
| **Lower the `high` severities instead of fixing the conditions** | Removes the "gets the pack disabled" failure immediately, at no domain cost | A wrong rule at `medium` is still wrong, and `confidence: definite` is the field that makes the UI not hedge. The defect is the condition |
| **Keep `INVALID_KE_PAYLOAD` as the card states it** | The card is the owner's work and its ERROR DECODER row is a terse lookup that works as a heuristic | The card is *more* careful than the corpus in every case `82` §19 lists. The corpus turned a two-column lookup row into an absolute that RFC 7296 §1.2 contradicts |
| **Defer the cluster schema and keep the worked examples** | The examples are good and rewriting them is churn | `13` §8.3(a) emitted against a fresh SRX cluster produces a configuration that does not commit. An example that cannot be executed is worse than a different example |

## Revisit if

- The lab (ADR-0027) answers the commit-time SA question — the `VERIFY` markers close and the
  affected `blast_radius` prose becomes assertable, per train.
- A recount shows the pack inside the 15% budget after the corrections, in which case `63` needs no
  amendment and the exemption argument is dropped rather than won.
- ADR-0007's edge model turns out not to support the per-interface `host-inbound-traffic` condition
  in practice — that would be evidence against the graph shape, not against this rule, and it is the
  single most load-bearing test of ADR-0007 available.
- A second reviewer with an SRX disagrees with any correction here. Every one of them is a domain
  judgement made from a critique, not from a box, and ADR-0027 exists because that is not good enough.
