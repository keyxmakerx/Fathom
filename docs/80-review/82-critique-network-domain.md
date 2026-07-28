# 82 — Critique: the network domain content

> **Status:** Contested
>
> Adversarial review of the Fathom corpus and core documents from a multi-vendor network
> engineering lens. Scope: `corpus/commands/junos-srx-ipsec.yaml`,
> `corpus/rules/ipsec-junos-srx.yaml`, `corpus/explainers/ipsec-concepts.yaml`,
> `docs/10-core/11-ir-schema.md`, `13-emitters-and-provenance.md`,
> `18-diff-verify-rollback.md`, `docs/60-content/61-`, `63-`, and the SRX field card in
> `.context/`.
>
> Every finding below names a file, a claim, a consequence and a fix. Where I could verify
> against a primary source I cite it. Where I could not, the finding says so rather than
> asserting.

---

## 0. Calibration — what is right, so the criticism means something

This is a strong corpus. Before the objections, the things I checked and found correct,
because a review that only lists faults is not usable:

| Checked | Verdict |
|---|---|
| RFC 8221 §5 — `ENCR_3DES` SHOULD NOT, `ENCR_AES_CBC` MUST, `ENCR_AES_GCM_16` MUST | **Correct**, cited correctly in `ike.proposal.3des` and `ipsec.proposal.3des` |
| RFC 8221 §4 — ESP+AH NOT RECOMMENDED | **Correct**, and §4 is genuinely the right section |
| Junos DPD defaults `interval 10` / `threshold 5` = 50 s | **Correct** per Juniper's `dead-peer-detection` statement reference |
| IKEv1 main mode 6 messages / aggressive 3; IKEv2 four-message initial exchange | **Correct** |
| First Child SA is keyed from the IKE SA with no KE payload (RFC 7296 §1.2) | **Correct**, and `18-diff-verify-rollback.md` §7.3 builds a genuinely excellent verify ladder on it |
| ESP header 8 bytes (SPI 4 + seq 4); NAT-T UDP +8 (RFC 3948) | **Correct** |
| `MSS = tunnel MTU − 40`; ICMP `size` + 28 = wire size | **Correct** |
| AH is integrity-only and cannot survive NAT | **Correct** |
| PMTUD ICMP is Type 3 Code 4 (RFC 1191) | **Correct** |
| `commit confirmed`'s blast radius includes another engineer's candidate changes | **Correct, and rarely said.** Credit |
| The `blast_radius` prose across all 40 configuration entries | Uniformly high quality. The *text* is right; §1 is about the *label* attached to it |

The corpus's self-criticism (`F1`–`F9`, `G1`–`G7`) is also genuine and mostly correct. It
does not, however, catch any of §1, §2, §3 or §4 below.

---

## 1. CRITICAL — no `set` line anywhere in the corpus can ever be `Disruptive`

**Files:** `corpus/commands/junos-srx-ipsec.yaml` (all 40 `mode: configuration` entries);
`corpus/rules/ipsec-junos-srx.yaml` (every `remediation.lines[].risk`);
`docs/10-core/13-emitters-and-provenance.md` §5.5.

**The claim, as implemented.** Every one of the 91 command entries follows an undocumented
mapping: `mode: configuration` ⇒ `ChangesConfig`; `clear` ⇒ `Disruptive`; everything else
⇒ `ReadOnly`. There is not a single `Disruptive` `set` line in the corpus. In the rule
pack, `Disruptive` appears only on three `delete` rollback lines.

**Why it is wrong.** The corpus's own `blast_radius` text repeatedly describes the
`Disruptive` legend — *"DROPS LIVE TRAFFIC"* — while the label says `ChangesConfig`:

| Entry | `blast_radius`, verbatim | Label |
|---|---|---|
| `zone.st0.bind.set` | "Moving a live unit between zones invalidates every policy written for the old zone pair and **traffic stops until new ones exist**" | `ChangesConfig` |
| `ipsec.vpn.bind-interface.set` | "detaches routing from the old unit and **everything routed at it blackholes**" | `ChangesConfig` |
| `interface.st0.address.set` | "Renumbering a live unit **drops any adjacency running over it**" | `ChangesConfig` |
| `ike.gateway.version.set` | "A peer that only speaks the other version **stops negotiating entirely**" | `ChangesConfig` |
| `ipsec.vpn.establish-tunnels.responder-only.set` | "**the tunnel never comes up again** — with no error anywhere" | `ChangesConfig` |

**And the corpus contradicts a sibling document on the identical statement.**
`18-diff-verify-rollback.md` §7.2 emits `set security ipsec policy IPSEC-POL
perfect-forward-secrecy keys group14` and argues at length, correctly, that it is
**`Disruptive`. Not `ChangesConfig`** — quoting the field card to justify it. The command
corpus entry `junos-srx/ipsec.policy.pfs.set` for that exact line is `ChangesConfig`.
Two documents, one statement, two colours.

The same document also labels `clear security ipsec security-associations index <id>` as
`DISRUPTIVE` (§7.4 step 5, with a good argument). `13-emitters-and-provenance.md` §5.5
labels the identical command `ChangesConfig`. Three risk values now exist for two commands
across three files.

**Consequence.** This is the single most dangerous defect the product can ship, and the
owner's brief says so. The three-colour legend is the only safety affordance in the tool
and on the printed card. Under this mapping the red band is reserved for `clear`, which
means the colour that says *drops live traffic* never appears on the changes that actually
drop live traffic. An engineer scanning a generated change set for red before a Tuesday
afternoon window sees amber throughout and proceeds. `61-command-corpus-spec.md` §313 even
states the authoring rule — *"when an author is torn, round up"* — and the corpus rounds
down, systematically, forty times.

**Fix.**
1. State the mapping explicitly in `61` §4 and make it a property of *effect*, not of
   *mode*: `Disruptive` iff committing/running the statement can interrupt an established
   flow, SA or adjacency on a device already carrying traffic. `13` §8.1 already asserts
   this ("the risk of a statement is a property of what it *does*") — the corpus does not
   implement it.
2. Add a CI gate: any entry whose `blast_radius` matches `/blackhole|traffic stops|drops
   .*(adjacency|traffic)|never comes up|stops negotiating/i` and is not `Disruptive` fails
   the build. That gate alone catches all five rows above.
3. Reclassify, at minimum: `zone.st0.bind.set`, `ipsec.vpn.bind-interface.set`,
   `interface.st0.address.set`, `ike.gateway.version.set`,
   `ipsec.vpn.establish-tunnels.responder-only.set`, `ipsec.policy.pfs.set`,
   `ike.proposal.dh-group.set`, `ipsec.proposal.encryption.set`,
   `ike.proposal.encryption.set`, `interface.st0.mtu.set` (an MTU change on a live st0
   re-establishes the interface), and the `ike.mode.aggressive-with-psk` remediation line
   `set security ike gateway {{…}} version v2-only`.
4. Resolve the `13` §5.5 vs `18` §7.4 conflict in favour of `18`. Clearing one child SA
   pauses live traffic; that is the definition of the red band, and calling it
   `ChangesConfig` also asserts something false — it needs no commit.

---

## 2. CRITICAL — `ChangesConfig` is rendered as "NEEDS A COMMIT" on operational commands

**Files:** `.context/conventions.md` § *The risk enum*; `13-emitters-and-provenance.md`
§5.5; `corpus/commands/junos-srx-ipsec.yaml` → `junos-srx/ipsec.statistics.clear`.

**The claim.** `clear security ipsec statistics` is `ChangesConfig`. `13` §5.5 defends
this: *"That is not disruption, but it is not read-only either, and the three-value enum
forces the honest call."*

**Why it is wrong.** The enum's rendered string is fixed by conventions and by the card:
`CHANGES CONFIG — NEEDS A COMMIT`. `clear security ipsec statistics` changes no
configuration and needs no commit, and `rollback 1` will not undo it. The three-value enum
did not force an honest call; it forced a false label, and the document rationalises the
falsehood rather than recording it as a defect. The same applies to `13` §5.5's
`clear …index <n>` classification.

**Consequence.** An operator is told to commit something that has already happened and
cannot be committed. Worse, `reversible: commit-confirmed` is *not* set on this entry but
the label implies the Junos safety net applies. A counter baseline destroyed mid-incident
is not recoverable by any Junos mechanism.

**Fix.** Do not add a fourth colour — the design language is right that three is the
discipline. Instead separate the *band* from the *caption*: keep three colours, but let a
`ChangesConfig` entry with `mode: operational` render the caption
`CHANGES STATE — NOT REVERSIBLE BY COMMIT`. Same ink, same wash, different words. That is
one field (`risk_caption_override`) in `61` §3.2 and it removes the only place in the
product where the legend lies. Record it as a **proposed change** to conventions, since
conventions currently pin the caption text.

---

## 3. HIGH — the flagship rule fires falsely on the field card's own syntax, and its
auto-fix widens the exposure

**Files:** `corpus/rules/ipsec-junos-srx.yaml` → `zone.host-inbound.ike-missing`;
`docs/10-core/11-ir-schema.md` §7.5; `docs/30-security/36-enterprise-review-qa.md` (row 1
of the "what this tool tells you to do" table).

**The claim.** The rule anchors on `IkeGateway`, walks
`with: zone: { via: [external_interface, zone_binding] }`, and tests:

```
zone == null || !zone.host_inbound_system_services.exists(s, enum_is(s, "ike"))
```

**Why it is wrong.** The IR is explicit (§7.5) that `host-inbound-traffic` exists in **two
places**: zone-wide on `Zone.host_inbound_system_services`, and **per interface on the
`ZoneMember` edge**. §7.5 writes the correct condition itself:

> the edge's `to` unit is the `ExternalInterface` of some `IkeGateway`, **and** neither the
> edge's `host_inbound_system_services` nor the zone's zone-wide set contains `ike` or `all`

The rule pack implements only the second half. The card's own plumbing piece #3 — the
statement this rule exists to enforce — is the **per-interface** form:

```
set security zones security-zone WAN interfaces reth0.0 \
  host-inbound-traffic system-services ike
```

A configuration written exactly as the card teaches leaves the zone-wide set empty and
fires this `high` / `confidence: definite` / `category: correctness` finding. The rule also
does not test for `all`, so `system-services all` — common on lab and inherited WAN zones —
false-fires too.

**Then the remediation makes it worse.** It emits
`op: add_to_set, target: zone, field: host_inbound_system_services`, i.e. the **zone-wide**
form. `36-enterprise-review-qa.md` says the opposite is required: *"an emitter that prefers
the per-interface form over the per-zone form."* So Fathom raises a false finding about an
internet-facing daemon and its one-click fix opens IKE inbound on **every interface in the
WAN zone**, not the one the gateway uses. That is a linter widening an attack surface to
silence itself — the exact failure `policy.zone-pair.missing`'s own
`remediation_absent_reason` says must never happen.

**Consequence.** The most-missed, highest-value rule in the pack is a guaranteed false
positive against correct configurations, and its remediation is a security regression. The
brief's own thesis — *"tools that flag everything are muted within a week"* — kills this
rule in week one, and the rule it kills is the one that matters most.

**Fix.**
1. Re-anchor to the `ZoneMember` edge per IR §7.5 and implement the full disjunction,
   including `all`.
2. Change the remediation to `add_to_set` on the **edge**, emitting
   `set security zones security-zone {{zone}} interfaces {{unit}} host-inbound-traffic
   system-services ike`.
3. Add a `must_pass` fixture that is literally side 1 piece #3. The absence of fixtures
   (`63` §15) is why this was not caught; the bundle admits it has none.

---

## 4. HIGH — `INVALID_KE_PAYLOAD` is described as a hard failure; RFC 7296 makes it a retry

**Files:** `corpus/explainers/ipsec-concepts.yaml` →
`explain:error:junos-srx/INVALID_KE_PAYLOAD`; `corpus/rules/ipsec-junos-srx.yaml` →
`ipsec.pfs.group-mismatch`, `ike.dh-group.weak`.

**The claims.**

> *"it is looking at bytes it cannot interpret. **There is nothing to negotiate at that
> point.**"* — explainer, `teaching.body`
>
> *"On Phase 1 the tunnel never establishes."* — explainer, `breaks_if_wrong`
>
> *"The reason group14 against group19 fails rather than degrading is that the key exchange
> payload is sized and structured by the group. There is nothing to negotiate at that
> point."* — `ipsec.pfs.group-mismatch.explain.teaching`

**Why it is wrong.** RFC 7296 §1.2 specifies the opposite. INVALID_KE_PAYLOAD is a
*negotiation* mechanism, not a parse failure:

> "the responder will respond with a Notify payload of type INVALID_KE_PAYLOAD indicating
> the selected group" … carrying "the accepted Diffie-Hellman group number in big endian
> order" … and "the initiator MUST retry the IKE_SA_INIT with the corrected Diffie-Hellman
> group."

The responder parses the SA payload perfectly well, selects a transform, notices the KE
payload used a different group, and *names the group it wants*. If the initiator's proposal
list contains that group — which it does whenever a proposal set or a multi-transform
proposal is configured — Phase 1 comes up on the second round trip, and
`INVALID_KE_PAYLOAD` appears exactly once in a healthy bring-up log. It is only terminal
when the two groups are disjoint, and in that case the failure is usually reported as
NO_PROPOSAL_CHOSEN.

**Two further errors in the same entries.**

- **Wrong citation.** Both the explainer and `ipsec.pfs.group-mismatch` cite
  `RFC 7296 §1.3, "KE payload in CREATE_CHILD_SA"`. §1.3 says nothing about
  INVALID_KE_PAYLOAD. The Phase 1 behaviour is §1.2. Conventions forbid a citation the
  author has not checked; this one does not support the sentence attached to it.
- **Wrong protocol version scope.** `INVALID_KE_PAYLOAD` is IKEv2 notify type 17. It cannot
  appear on an IKEv1 gateway; the IKEv1 analogue is `INVALID-KEY-INFORMATION`, and an IKEv1
  Quick Mode PFS group mismatch surfaces as NO_PROPOSAL_CHOSEN because the group is a Quick
  Mode SA attribute. Yet the explainer carries `versions: "*"` with no version qualifier —
  unlike its sibling `TS_UNACCEPTABLE`, which correctly carries `qualifier: v2` — and
  `ipsec.pfs.group-mismatch` asserts *"INVALID_KE_PAYLOAD in the log, **not**
  NO_PROPOSAL_CHOSEN"* with `versions: "*"`.

**Consequence.** An engineer on an IKEv1 tunnel is told to expect a string that cannot
appear, and told that the string they *do* see is the wrong diagnosis. An engineer on IKEv2
is told a benign, self-correcting notify is a hard failure and sent to edit crypto on a
working tunnel. The explainer's `misdiagnosed_as` field compounds it: *"comparing all four
values is wasted effort"* — which is advice to stop looking at the one thing that is
actually wrong when the groups really are disjoint.

**Fix.** Rewrite the explainer body around the retry semantics; add
`subject.qualifier: v2` and split an `explain:error:junos-srx/INVALID-KEY-INFORMATION` for
v1; re-cite to RFC 7296 §1.2; add a version predicate to `ipsec.pfs.group-mismatch` and
give it two `symptom_if_mismatched` branches. The card's ERROR DECODER row is a terse
lookup and is fine as a heuristic — the corpus turned a lookup row into an absolute, and
that is the distortion.

---

## 5. HIGH — the corpus contradicts itself on when a PFS mismatch actually breaks

**Files:** `corpus/rules/ipsec-junos-srx.yaml` → `ipsec.pfs.absent` vs
`ipsec.pfs.group-mismatch`; `docs/10-core/18-diff-verify-rollback.md` §7.3.

`ipsec.pfs.absent.explain.teaching` says, correctly and in the card's own words:

> "Under IKEv2 the first child SA is always keyed from the IKE SA regardless; PFS applies to
> later child rekeys."

`ipsec.pfs.group-mismatch.why`, three rules earlier in the same file, says:

> "Two ends offering different groups fail the Phase 2 key exchange outright, and **the
> child SA never installs** however correct the rest of the crypto is."

Both cannot be true on a `v2-only` gateway, and `18-diff-verify-rollback.md` §7.3 —
the best single section in this corpus — proves which one is: the first Child SA is created
in IKE_AUTH, which carries no KE payload, so it installs, and the mismatch surfaces at the
first CREATE_CHILD_SA rekey, *"up to `lifetime-seconds` later — 3600 s here."*

**Consequence.** The rule's `symptom_if_mismatched` tells an engineer the tunnel is down
now. On IKEv2 the tunnel is up now and fails an hour after the change window closes. That
is precisely the failure mode `18` §7.3 was written to prevent, and the rule that fires
in the UI carries the wrong version of the story.

**Fix.** Make both PFS rules version-predicated. `ipsec.pfs.absent.symptom_if_mismatched`
and `ipsec.pfs.group-mismatch.symptom_if_mismatched` each need a v1 branch (immediate
Quick Mode failure) and a v2 branch (installs, fails at first child rekey — force one with
`clear security ipsec security-associations index <id>` inside the window). Link both to
`18` §7.4 step 5 so the rule and the ladder agree.

---

## 6. HIGH — `ike.identity.mismatch` false-fires on a very common working configuration

**File:** `corpus/rules/ipsec-junos-srx.yaml` → `ike.identity.mismatch`.

```
condition: >
  (has(local_identity) || has(peer.remote_identity))
  && local_identity != peer.remote_identity
```

`severity: high`, `confidence: definite`, `category: correctness`, `acceptable_when:
"Never as a steady state — authentication cannot succeed."`

**Why it is wrong.** Consider the ordinary case: this end sets `local-identity inet
198.51.100.5` because it sits behind NAT; the peer sets no `remote-identity` at all and
accepts the ID presented. First disjunct true, `local_identity != null` true, rule fires
`high`/`definite` and asserts authentication *cannot* succeed. It succeeds every day. The
condition treats an absent peer field as a disagreeing value rather than as "no constraint",
which is exactly the distinction `Presence` (IR §5) exists to make and which `on_unset:
skip` does not cover — the peer's field is `Absent`, a positive fact, not unset on *this*
node.

The mirror case is equally wrong: peer sets `remote-identity` and this end sets no
`local-identity`. Fathom fires `high`, but whether that fails depends on what address the
peer observes — which is the subject of the *adjacent* rule,
`ike.identity.required-behind-nat`, at `medium`/`probable`. The pack has the honest version
and the dishonest version of the same check, and the dishonest one outranks it.

**Consequence.** A `definite` `high` correctness finding that is wrong on a common,
working design. `confidence: definite` means the UI will not hedge it. This is the rule that
gets the pack disabled.

**Fix.**
```
condition: >
  has(local_identity) && has(peer.remote_identity)
  && local_identity != peer.remote_identity
```
and move the "one side constrains, the other does not" case into
`ike.identity.required-behind-nat` at `probable`, where it already belongs.

---

## 7. MEDIUM–HIGH — `ike.dh-group.weak` compares an enum against integers and misses the
two groups RFC 8247 marks hardest

**File:** `corpus/rules/ipsec-junos-srx.yaml` → `ike.dh-group.weak`.

```
condition: "has(dh_group) && dh_group in [1, 2, 5]"
remediation.patch: value: { enum: group14 }
```

**Two defects.**

1. **Type error against the schema it runs on.** IR §6.7 types `IkeProposal.dh_group` as
   `DhGroup`, and every other predicate in this bundle uses `enum_is(field, "value")`. This
   one compares a `DhGroup` to integer literals while its own remediation writes
   `{ enum: group14 }`. Under `12-rule-engine.md`'s typed evaluation this either fails to
   compile or silently never matches — and "silently never matches" is the outcome that
   ships.

2. **Wrong and incomplete against the RFC it cites.** RFC 8247 §2.4, verified:

   | Group | Status |
   |---|---|
   | 14 (2048 MODP) | MUST |
   | 19 (256-bit ECP) | SHOULD |
   | 5 (1536 MODP) | SHOULD NOT |
   | 2 (1024 MODP) | SHOULD NOT |
   | **1 (768 MODP)** | **MUST NOT** |
   | **22 (1024 MODP / 160-bit subgroup)** | **MUST NOT** |
   | 23 (2048 MODP / 224-bit subgroup) | SHOULD NOT |
   | 24 (2048 MODP / 256-bit subgroup) | SHOULD NOT |

   The rule's `why` states *"RFC 8247 §2.4 marks groups 2 and 5 SHOULD NOT and group 14
   MUST"* while its condition also catches group 1 — which the RFC marks **MUST NOT**, a
   strictly stronger statement the rule never makes. And it misses **groups 22, 23 and 24
   entirely**. Junos supports `group24`; group 22 is MUST NOT and passes this rule clean.

**Consequence.** A rule advertised as "catches legacy DH" gives a clean bill of health to a
`group24` or `group22` proposal, and mis-states the requirement level for the one group the
RFC prohibits outright.

**Fix.** `condition: "has(dh_group) && dh_group in [group1, group2, group5, group22,
group23, group24]"` using `enum_is`/set membership over the `DhGroup` enum; split severity —
groups 1 and 22 are MUST NOT and warrant `high`, the rest `medium`; correct the `why` text.
Add the same check for `IpsecPolicy.perfect_forward_secrecy`, which is the gap the file
already flags as `ipsec.pfs.group-weak` under § UNRESOLVED REFERENCES. It is the right call
to write it; it is not optional.

---

## 8. MEDIUM–HIGH — `nat.source-nat-eats-tunnel` states a mechanism the SRX does not have

**File:** `corpus/rules/ipsec-junos-srx.yaml` → `nat.source-nat-eats-tunnel`.

> *"Source NAT is evaluated on the way out **regardless of which interface the route
> chose**."* — `explain.explained`

**Why it is wrong.** On SRX, source NAT rule sets are scoped by `from` and `to` context —
zone, interface or routing-instance — and the `to` context is resolved *after* the
forwarding lookup picks the egress interface. The IR models this correctly:
`NatRuleSet.from/to: NatScope { Zone | Interface | RoutingInstance }` (§6.6). A rule set
declared `from zone TRUST to zone UNTRUST` therefore does **not** match traffic routed at
`st0.0` when `st0.0` is in zone `VPN` — which is exactly the topology the card's plumbing
piece #2 tells you to build.

The real failure the card is describing is narrower and more interesting: it bites when
`st0` is left in the same zone as the WAN, or when the rule set is written
`from zone TRUST to interface <wan>` and someone later adds a second egress, or when the
rule set is `from routing-instance`. The card's own phrasing — *"The interface NAT rule for
internet-bound traffic also grabs packets routed at st0"* — is compatible with all of these
and does not assert the general mechanism. The corpus generalised it into something false.

**And the condition ignores scope entirely:**

```
selectors.exists(t, overlaps(destination_match, t.remote_ip))
&& !earlier.exists(r, is_no_nat(r) && overlaps(r.destination_match, destination_match))
```

No term touches `NatRuleSet.from` or `.to`. Every device with an internet source-NAT rule
matching `0.0.0.0/0` and any IPsec tunnel will fire this `high` finding, correctly
configured or not — because `0.0.0.0/0` overlaps every `remote_ip`.

**Consequence.** A `high` finding on essentially every SRX in the world that has both
internet access and a VPN. Combined with §3 and §6 this pack fires three `high` false
positives on a correctly built branch firewall.

**Fix.** Add the scope test to the condition — the finding requires that the rule set's
egress scope actually contains the VPN's `bind_interface` unit or its zone:

```
selectors.exists(t, overlaps(destination_match, t.remote_ip))
&& nat_scope_covers(parent_ruleset.to, vpn.bind_interface)
&& !earlier.exists(r, is_no_nat(r) && overlaps(r.destination_match, destination_match))
```

Add `nat_scope_covers(scope, unit)` to § DERIVED PREDICATES. Rewrite `explain.explained` to
state the zone-scoped mechanism. Keep `confidence: probable` — it is honest here.

---

## 9. MEDIUM — the `blast_radius` timing claims are unsourced vendor behaviour

**Files:** `corpus/commands/junos-srx-ipsec.yaml`, several entries;
`corpus/rules/ipsec-junos-srx.yaml` → `ike.dh-group.weak`, `ike.proposal.3des`.

Repeated, load-bearing, and cited to nothing:

> "the tunnel drops at the current SA's lifetime **rather than immediately**"
> — `ike.proposal.auth-method.set`, `ike.dh-group.weak.explain.teaching`
>
> "the tunnel drops when the current SA expires **rather than at commit**"
> — `ike.proposal.3des.explain.teaching`

Every `sources:` list on these entries cites only the card, and the card says nothing about
commit-time SA behaviour. This is a specific assertion about what a Junos commit does to a
running SA, invented by the corpus. Conventions: *"Never fabricate … a vendor behaviour. If
a vendor detail is uncertain, mark it `<!-- VERIFY -->` inline."*

`18-diff-verify-rollback.md` §7.3 handles the identical question correctly — it puts a
`VERIFY` comment in the table and says the ladder is right either way. The corpus asserts.

**Consequence.** This is the single sentence that decides whether an engineer schedules a
change window. If Junos in fact re-keys the affected VPN at commit — which is the widely
reported behaviour for changes under `security ike` and `security ipsec` — then the corpus
is telling people a crypto change is deferred when it drops the tunnel on the spot. I could
not verify the current behaviour from primary vendor documentation in this pass, which is
itself the point: neither could the author, and they wrote it as fact.

**Fix.** Replace every instance with the `VERIFY` form until a reviewer with an SRX records
the answer per train, and make the two claims a single explainer
(`explain:concept:junos.commit-and-sa-lifecycle`) that all of them reference, so it is
corrected once.

---

## 10. MEDIUM — the rule pack's own escape from the severity budget does not work

**File:** `corpus/rules/ipsec-junos-srx.yaml` → `G1` and `§ SEVERITY`.

The file proposes exempting `category: correctness` from `63` §19's 15 % `high` budget and
states the result:

> "Under that rule this bundle is **2 `high` out of 23 non-correctness rules — 9 %**,
> comfortably inside."

and

> `high: 13   # 12 correctness + ike.mode.aggressive-with-psk (security)`

**Counted from the file:** 37 rules; 12 `correctness`, of which **9** are `high`, not 12.
Non-correctness rules: **25**, not 23. `high` non-correctness rules: **4** —
`ipsec.pfs.absent`, `ipsec.pfs.group-mismatch`, `ipsec.traffic-selector.not-mirrored`,
`ike.mode.aggressive-with-psk` — not 2.

4 / 25 = **16 %**. The proposed exemption does **not** bring the bundle inside a 15 %
budget. The argument in G1 is sound; the arithmetic offered to close it is wrong by roughly
a factor of two and lands on the wrong side of the gate it is trying to pass.

Related: header note `F6` says *"Ten entries carry `weight: 3`"*; the file contains
**eleven**. Since gate 7 is "at most one `weight: 3` per (concept, platform)", an
uncounted eleventh is exactly the shape of a gate violation.

**Fix.** Recount, restate, and either demote one of the four (`ipsec.pfs.group-mismatch` is
the natural candidate — its `high` rests on the incorrect claim in §5) or argue the budget
change on its merits rather than on a number. A document whose credibility rests on honest
arithmetic cannot get its own arithmetic wrong.

---

## 11. MEDIUM — dead `supersedes` relations

**File:** `corpus/rules/ipsec-junos-srx.yaml`.

`ipsec.traffic-selector.not-mirrored` declares `supersedes: [ipsec.traffic-selector.absent]`.
The two are mutually exclusive by construction:

- `.absent` is `applies_to: kind: IpsecVpn`, `condition: selectors.count() == 0`
- `.not-mirrored` is `applies_to: kind: TrafficSelector`

When zero selectors exist there is no `TrafficSelector` node for `.not-mirrored` to bind to,
so it cannot fire, so it can never supersede anything. The `supersedes` is dead
configuration that will pass V23 (the reference exists) and never execute.

The file already flags the second dead reference itself (`ipsec.pfs.group-weak`). This one
it did not catch.

**Fix.** Delete the `supersedes`, or re-anchor `.not-mirrored` to `IpsecVpn` with a
`discriminator` on selector name so both can bind to the same node. The second is better and
also fixes §12.

---

## 12. MEDIUM — the highest-value plumbing rule has no coverage on selector-less tunnels

**File:** `corpus/rules/ipsec-junos-srx.yaml` → `route.remote-prefix.no-next-hop-st0`,
`applies_to: kind: TrafficSelector`.

The single most valuable plumbing check in the pack — *is anything actually routed at
`st0`?* — is anchored on `TrafficSelector`. A route-based VPN with **no** `traffic-selector`
is the most common shape in the field: every SRX-to-AWS-VGW, SRX-to-Azure and most
SRX-to-third-party tunnels are built that way, and
`ipsec.traffic-selector.absent.acceptable_when` explicitly blesses it.

Two outcomes, both bad:

- If IR §6.7's inferred any-to-any `TrafficSelector` node is **not** materialised, the rule
  never binds and the check silently does not exist for the commonest topology.
- If it **is** materialised with `Origin::Inferred`, the rule evaluates
  `has_route_to(0.0.0.0/0, st0.0)` — true only when there is a default route out the
  tunnel — and fires `high` on every correctly built selector-less VPN.

**Fix.** Anchor on `IpsecVpn` with `bind_interface`, and evaluate against the union of
(a) configured selectors' `remote_ip` and (b) where none exist, the set of static routes
whose `NextHop::Interface` is the bind unit — firing when that set is empty. The check you
want is "nothing at all routes at `st0`", which is a property of the VPN, not of a selector.

---

## 13. MEDIUM — `policy.zone-pair.missing` cannot detect the failure it spends three
paragraphs teaching

**File:** `corpus/rules/ipsec-junos-srx.yaml` → `policy.zone-pair.missing`.

```
condition: vpn_zone != null && !lan_zones.exists(z, has_policy_between(z, vpn_zone))
```

`has_policy_between(zone_a, zone_b)` is documented in § DERIVED PREDICATES as *"At least one
security policy exists for the **ordered** zone pair."* The condition tests only
`(lan → vpn)`. The rule's `explain.teaching` devotes its second paragraph to the reverse:

> "A tunnel that works for outbound sessions and drops inbound ones passes most tests… If
> the far end reports a problem you cannot reproduce, check the policy in the direction they
> are trying."

That case — `TRUST → VPN` present, `VPN → TRUST` absent — never fires. The rule teaches a
failure it does not check.

**Fix.** Split into `policy.zone-pair.missing` (neither direction) and
`policy.zone-pair.one-directional` (`low`/`probable`, `acceptable_when:` the tunnel is
deliberately outbound-only, which is a real and common design). One-directional is not a
fault; it is a fact worth surfacing, and that is a different severity.

---

## 14. MEDIUM — `ike.dpd.too-slow` reports "no DPD at all" under a title that says 30 seconds

**File:** `corpus/rules/ipsec-junos-srx.yaml` → `ike.dpd.too-slow`.

```
condition: (!has(dpd_interval) || !has(dpd_threshold) || dpd_interval * dpd_threshold > 30)
          && vpn != null && carries_adjacency(vpn)
title: "Failover on this tunnel waits more than 30 seconds for DPD"
why:   "…the Junos default of 10 times 5 is 50 seconds…"
```

The condition folds two distinct states into one finding: *DPD configured slowly* and
*`dead-peer-detection` not configured at all*. On Junos SRX, `dead-peer-detection` is a
statement you add to the gateway; absent it, the documented `interval 10` / `threshold 5`
defaults are the defaults of the statement, not of the gateway. Whether an SRX runs liveness
checks on an IKEv2 gateway with no `dead-peer-detection` statement is train-dependent and is
not established anywhere in this corpus.

**Consequence.** The engineer reads "waits more than 30 seconds" and budgets 50 s of
failover. If DPD is simply not running, the SA persists until its lifetime — on the card's
own recommended `lifetime-seconds 28800`, that is eight hours of blackhole, not fifty
seconds. The finding understates the worst case by three orders of magnitude, and it does so
under a title that sounds precise.

**Fix.** Split into `ike.dpd.absent` (`high`, "no dead-peer detection is configured on a
tunnel carrying an adjacency") and `ike.dpd.too-slow` (`medium`, the product > 30 case).
Mark the "is DPD implicitly on for IKEv2 on this train" question `<!-- VERIFY -->` and give
both rules a `versions` predicate once it is answered — `G6` already says every `"*"` in
this bundle is unverified, and this is the one where `"*"` changes the severity.

---

## 15. Can the IR represent a real SRX cluster? The first thing it cannot express

The IR is the best document in the set and the `Device`-is-one-config decision for a
chassis cluster (§6.3) is correct — both nodes share one configuration. But the worked
example everywhere in this corpus is `reth0.0`, i.e. a cluster, and the schema cannot emit
a committable cluster configuration. In order of how soon you hit it:

**1. `reth-count` — the first hard stop.** `set chassis cluster reth-count N` must exist
before any `reth` interface can be configured; without it the commit fails. §6.4 models the
exact analogue for LAG — *"Requires `Device.aggregate_device_count` to be set for a Junos
emit (`set chassis aggregated-devices ethernet device-count N`)"* — and then the `Device`
field table in §6.3 **does not contain `aggregate_device_count` either**. So the schema
references a `Device` field that it does not define, and has no equivalent at all for the
reth case that the whole corpus uses. Emitting §8.3(a) of `13-emitters-and-provenance.md`
against a fresh SRX cluster produces a configuration that does not commit.

**2. Per-node values.** `Device.hostname` is cardinality **1**. A real cluster carries two,
via `set groups node0 system host-name srx-a-node0` / `node1 …`, plus per-node `fxp0`
addressing under the same groups. `Chassis` (§6.3) has `member_index`, `model`, `serial`,
`slots` — no `hostname`, no `management_address`, no per-node anything.
`14-parsers-and-ingest.md` §1720 reads those `groups nodeN system host-name` statements to
*detect* a cluster and then has nowhere to put the values; §5.1 says `apply-groups` is not
expanded at all. So a parsed cluster loses both node names and both management addresses,
and the inventory pillar cannot answer "what is node1's fxp0 address" — a question every
engineer asks before a maintenance.

**3. The fabric link.** `fab0` / `fab1` and `set interfaces fab0 fabric-options
member-interfaces ge-0/0/1` have no kind, no field and no edge. `Interface.form` is
`{Ethernet, Serial, Loopback, Management, Irb}` — no fabric. The fabric link is mandatory in
every chassis cluster and is the first thing you check when a cluster splits.

**4. Cluster-level knobs.** `Device.cluster_id` exists; `node-count`,
`heartbeat-interval`, `heartbeat-threshold`, `control-link-recovery` and RG
`interface-monitor`'s companion `ip-monitoring` do not. §6.3 already carries a `VERIFY` on
`hold-down-interval` and `gratuitous-arp-count`, which is honest, but the missing statements
are not flagged at all.

**Fix.** Add `Device.aggregate_device_count` and `Device.reth_count` to the §6.3 table with
`Emit: R*`; add a `Fabric` variant to `Interface.form` plus a `MemberOfFabric` edge; move
`hostname` and `management_address` to `Chassis` with `Device.hostname` becoming the
cluster-wide name; and record `apply-groups` non-expansion as a stated **emit blocker** for
clustered devices rather than only a parse limitation. Until then, `43-deployment-modes.md`
and `56-diagram-view.md` should stop using a cluster as the worked example, because the
schema cannot round-trip it.

---

## 16. Would the emitted Junos commit?

`13-emitters-and-provenance.md` §8.3(a). Statement-by-statement the 22 lines are valid Junos
`set` syntax and, per §5.2, order does not matter on a candidate-config platform — that
analysis is correct and the honesty in §5.3 about *not* claiming a false ordering reason is
the right instinct.

Three problems.

1. **It will not commit on the platform it targets.** `external-interface reth0.0` requires
   `reth0` to exist, which requires `set chassis cluster reth-count N` and
   `set interfaces ge-x/y/z gigether-options redundant-parent reth0`. See §15. The emitter
   has no way to produce either. The report should raise a blocker naming `Device.reth_count`
   the way §9.4 raises one for `aggregate_device_count`.

2. **It will commit and not pass traffic.** The fragment contains Phase 1 and Phase 2 and
   **none of the five plumbing pieces** — no `st0` unit, no zone binding, no
   `host-inbound-traffic system-services ike`, no route, no policy. The document calls it "one
   graph fragment, four renderings", which is fair framing, but it is also the example
   reproduced in `32-cryptography.md`, `34-browser-hardening.md` and `54-component-catalog.md`,
   and the card's most-quoted sentence is that missing #3 means Phase 1 times out with nothing
   in the log. If this fragment is the canonical emit example it must carry the plumbing
   block, or the block table's rank 40–44 entries are decorative.

3. **PAN-OS rendering, §8.3(c).** `set network ike crypto-profiles ipsec-crypto-profiles
   IPSEC-P2 dh-group group14` is emitted with no comment, but on PAN-OS `dh-group` on an
   IPsec crypto profile **is** the PFS setting — there is no separate PFS statement. The
   structural note below the block says exactly that ("PFS is `dh-group` on the
   `ipsec-crypto-profile`"), so the mapping is understood; what is missing is that the Junos
   graph has *two* DH values (`IkeProposal.dh_group` and `IpsecPolicy.perfect_forward_secrecy`)
   and PAN-OS has two objects to carry them, so the emitter must be explicit about which one
   lands where. As written a reader cannot tell whether `group14` on line 11 came from the
   IKE proposal or from PFS. Add the provenance annotation the document promises everywhere
   else.

---

## 17. Risk audit — the full table

Read-only classification is sound: I found no command labelled `ReadOnly` that mutates
device state. `show security flow session` and `show system processes extensive` are heavy
on a loaded box but not state-changing, and `monitor start kmd` is correctly read-only.

Everything else is in §1 and §2. Summary of required reclassifications:

| Command / line | Now | Should be | Why |
|---|---|---|---|
| `set security zones security-zone VPN interfaces st0.0` | `ChangesConfig` | `Disruptive` | moving a live unit between zones invalidates the old zone pair's policies |
| `set security ipsec vpn X bind-interface st0.N` | `ChangesConfig` | `Disruptive` | repointing blackholes everything routed at the old unit |
| `set interfaces st0 unit N family inet address …` | `ChangesConfig` | `Disruptive` | renumbering drops adjacencies and invalidates static next hops |
| `set security ike gateway X version v2-only` | `ChangesConfig` | `Disruptive` | a v1-only peer stops negotiating |
| `set security ipsec vpn X establish-tunnels responder-only` | `ChangesConfig` | `Disruptive` | can make the tunnel permanently unrecoverable |
| `set security ipsec policy X perfect-forward-secrecy keys …` | `ChangesConfig` | `Disruptive` | `18` §7.2 already argues this; corpus disagrees with it |
| `set interfaces st0 unit N family inet mtu …` | `ChangesConfig` | `Disruptive` | MTU change re-establishes the logical interface |
| `clear security ipsec security-associations index <n>` (`13` §5.5) | `ChangesConfig` | `Disruptive` | `18` §7.4 already says so |
| `clear security ipsec statistics` | `ChangesConfig` | `ChangesConfig` + caption override | the caption "NEEDS A COMMIT" is false |
| `commit` / `commit confirmed 5` | `ChangesConfig` | `ChangesConfig`, but risk must be **derived from the change set** | committing a `Disruptive` change set is a `Disruptive` act; a fixed label on `commit` is meaningless |

The last row is a design gap, not a data error: `18` §6.4 already computes an
`AGGREGATE RISK` for a change set, so the `commit` line inside a generated ladder should
inherit it rather than carrying the corpus's static `ChangesConfig`.

---

## 18. Are the `acceptable_when` fields realistic?

Mostly **yes**, and this is the corpus's strongest single feature. They name platforms,
compensating controls and what to record. `ipsec.pfs.absent`'s *"Compensate with a shorter
Phase 2 lifetime … record the peer and the date in the change ticket"* and
`ike.traceoptions.left-enabled`'s *"A suppression with no date on this rule is the failure
mode wearing a different hat"* are both better than anything shipping in commercial
linters.

Four are not realistic:

1. **`zone.host-inbound.ike-missing`** — *"acceptable only when this gateway is configured
   `establish-tunnels immediately` towards a peer that always responds and never initiates."*
   Under IKEv2 either party may initiate a rekey (RFC 7296 §2.8), and DPD/liveness probes
   arrive inbound from the peer regardless of who initiated. "A peer that never initiates" is
   not a state you can configure on someone else's box. The exception describes a
   configuration nobody can guarantee. Replace with the honest one: *"acceptable only on a
   gateway that is being staged and is not yet expected to negotiate."*

2. **`ipsec.establish-tunnels.both-responder-only`** — `acceptable_when: "Never."` is
   correct, and conventions require the field to *say so explicitly*, which it does. Good.
   But `ipsec.pfs.group-mismatch` and `ike.identity.mismatch` both say "never as a steady
   state" and then describe a transient window — that is a different thing from "never", and
   a suppression UI that offers a reason box will collect "coordinated change window" against
   a rule whose text says never. Split the vocabulary: `never` vs `transient_only`.

3. **`ipsec.lifetime.kilobytes-unset-on-busy`** — *"Acceptable on any low-throughput tunnel,
   and on any AES tunnel where the block size is not the binding constraint — which is most
   of them."* If the exception covers "most of them", the rule fires on a population it
   admits is mostly fine. That is what `info`/`heuristic` is for and the rule is correctly
   graded, but the `acceptable_when` should say what makes a tunnel *not* qualify — a
   concrete threshold, e.g. "3DES or any 64-bit-block cipher, or sustained throughput above
   roughly 100 Mbit/s on a 3600 s lifetime" — otherwise it is unfalsifiable.

4. **`mtu.mss-clamp.absent`** — *"Acceptable when the path MTU is known to be a full 1500 end
   to end and the tunnel MTU has been raised to match."* Raising the tunnel MTU to 1500 does
   not remove the need for a clamp; it moves the problem, because the *encapsulated* packet
   is then ~1550 on the wire and fragments at the first 1500-MTU hop. The exception as
   written would produce exactly the symptom the rule exists to catch. The real exception is
   an underlay with jumbo frames end to end, which is what `mtu.st0.unset.acceptable_when`
   correctly says. Copy that text.

---

## 19. Where the corpus distorted the card

The card is good, and in every case below the card is *more* careful than the corpus built
from it.

| Card says | Corpus says | Verdict |
|---|---|---|
| `INVALID_KE_PAYLOAD → DH group mismatch — P1 dh-group or PFS keys` (a two-column lookup row) | *"That can only come from a Diffie-Hellman group disagreement … and nothing else"*, *"There is nothing to negotiate at that point"* | A terse lookup turned into an absolute that RFC 7296 §1.2 contradicts. §4 |
| *"Under IKEv2 the first child SA is always keyed from the IKE SA regardless; PFS applies to later child rekeys"* — the card gets this exactly right | `ipsec.pfs.group-mismatch`: *"the child SA never installs"* | The corpus dropped the card's own qualification. §5 |
| *"The interface NAT rule for internet-bound traffic also grabs packets routed at st0"* — true of the specific shape the card means | *"Source NAT is evaluated on the way out regardless of which interface the route chose"* | Generalised into something the SRX's zone-scoped NAT model contradicts. §8 |
| *"OVERHEAD FIGURES APPROXIMATE — CIPHER-DEPENDENT"*, printed as the side's governing rule | `mtu.st0.unset.remediation` emits a hard-coded `mtu 1400`; `suggested_mss` is "tunnel MTU minus 40, **defaulting to 1360** when the tunnel MTU is unset" | The card's disclaimer survives in prose and is discarded in the emitted value. At least one of the two should be derived from a measured DF-ping, and the emitter should say the number is a starting point |
| Junos defaults DPD to `10 × 5 = 50 s` — a statement about the *statement's* defaults | `ike.dpd.too-slow` treats "no statement" as "50 s" | §14 |

## 20. Where the card itself is arguable

Carefully, because it is the owner's work and it is better than most vendor documentation.

1. **`show interfaces reth0.0 extensive | match -i error`** (side 4, BOX-LEVEL CONTEXT).
   Junos `match` is a POSIX regex filter and I am not aware of a `-i` flag on any train; the
   idiom is `| match "[Ee]rror"` or `| match "(?i)error"`. If `-i` is rejected the command
   errors harmlessly; if it is accepted as a literal pattern the filter matches nothing and
   the operator reads that as "no errors on this interface", which is the worst possible
   failure for a diagnostic filter. `<!-- VERIFY -->` on a box, and if it is wrong, this is
   the single line on the card most worth correcting, because it fails silently.

2. **`lifetime-seconds — P1 28800, P2 3600. Both default to 3600.`** True and worth pairing
   with the consequence: at `28800` with `optimized` DPD, a peer that dies without an
   RST-equivalent is not detected for up to 50 s and the SA is not rebuilt for up to eight
   hours. The card teaches both facts on the same side and never joins them; the corpus
   inherits the gap (§14).

3. **`Selected by: routing table | the policy`** in ROUTE-BASED VS POLICY-BASED. Correct, but
   the table omits the reason most estates still meet policy-based: `st0` on branch SRX
   defaults to point-to-point, and a hub sharing one `st0` unit across many spokes needs
   `multipoint` plus NHTB. The card *does* list `show security ipsec next-hop-tunnels # NHTB`
   in the verify ladder. So the card gives you the command to read a table it never tells you
   how to create. See §21.

4. **`DPD rides the outer IKE session on UDP 500/4500, never st0.`** Correct and one of the
   best sentences on the card. Worth one more clause: under IKEv2 the equivalent is the
   protocol's own liveness check (RFC 7296 §2.4), an empty INFORMATIONAL exchange, not the
   RFC 3706 DPD payload — same wire behaviour, different mechanism, and it matters when you
   are reading a capture.

---

## 21. What a working engineer needs that this whole corpus has missed

Ranked by how soon it costs someone a day.

**1. Chassis-cluster operational commands — zero of them, in a corpus whose every example is
a cluster.** 91 entries, and none of `show chassis cluster status`,
`show chassis cluster interfaces`, `show chassis cluster statistics`,
`request chassis cluster failover redundancy-group 1 node 1`, or
`request chassis cluster failover reset redundancy-group 1`. Worse, the verify ladder is
**wrong on a cluster as written**: `show security ike security-associations` and
`show security ipsec security-associations` accept a `node (0|1|all|local|primary)`
qualifier, and run without it on the wrong node they return nothing. An engineer following
the card's ladder on the secondary node concludes the tunnel is down. That is a false
"tunnel down" produced by the tool's own recommended procedure, on the tool's own worked
topology. Add `node all` variants and a rule/explainer for the anchoring behaviour.

**2. Hub-and-spoke.** No `set interfaces st0 unit 0 multipoint`, no
`set security ike gateway … general-ikeid`, no NHTB configuration, no static NHTB
(`set interfaces st0 unit 0 family inet next-hop-tunnel <ip> ipsec-vpn <name>`), no
`dynamic` gateway beyond the single `hostname` entry. `show security ipsec
next-hop-tunnels` is present with `aka: ["multipoint st0", "hub and spoke tunnel mapping"]`
and nothing in the corpus can produce the configuration it reads. Every spoke count above
one lands here.

**3. IPv6.** Not one command, rule or explainer. `LogicalUnit.families` and
`Address.family` carry `Inet6` in the IR and nothing downstream uses it. No
`show security ipsec security-associations family inet6`, no `traffic-selector` with v6
prefixes, no `mtu` arithmetic for a 40-byte outer IPv6 header — which changes the overhead
budget by 20 bytes and therefore the 1400 recommendation. A 2026 corpus with no IPv6 is a
gap a reviewer will name in the first meeting.

**4. `configure exclusive` and `rollback`.** The corpus's step 1 is `commit confirmed 5`,
its `blast_radius` correctly warns that the shared candidate may contain someone else's
work — and it never gives the command that prevents that (`configure exclusive` /
`configure private`). There is also no `rollback 1`, no `rollback <n>`, no `show | compare
rollback 1`, despite `18-diff-verify-rollback.md` §7.5 calling `rollback 1` the
*"authoritative alternative on this platform"*. The safety story is half-built.

**5. `request security ike debug-enable`.** Modern SRX has a targeted, bounded IKE debug
(`request security ike debug-enable local <ip> remote <ip> level 5`) that is strictly better
than the traceoptions dance the corpus spends three rules on, because it does not persist in
the configuration and therefore cannot be the thing that fills `/var`. Three of the pack's
rules (`ike.traceoptions.left-enabled`, `.no-file`, `.flag-all`) exist to manage a hazard
that this command avoids entirely.

**6. Anti-replay.** There is a full explainer on replay counters and a correct explanation
of ECMP-induced benign reordering — and no mention of `no-anti-replay`, which is what an
engineer actually configures when an ECMP or per-packet-load-balanced underlay produces
persistent replay drops. The corpus explains the symptom and withholds the knob.

**7. Route preference and floating static.** `route.remote-prefix.no-next-hop-st0` teaches
that a default route silently swallowing the remote prefix is the common failure, and there
is no coverage of `preference` / floating statics / `qualified-next-hop` — which is how you
build the backup tunnel the DPD and `vpn-monitor` rules keep referring to.
`StaticRoute.qualified` exists in the IR; nothing uses it.

**8. `show security ipsec security-associations detail` vs the summary.** The
`output_fields` on `junos-srx/ipsec.sa.show` declare `field: State, want: Installed`. On
current Junos the *summary* output has no `State` column — the columns are ID, Algorithm,
SPI, Life:sec/kb, Mon, lsys, Port, Gateway, with `<`/`>` direction markers on the ID;
`State: Installed` is a `detail`-only field. The corpus's own header says `output_fields` is
the highest-priority review item and it is right, but this one should be fixed before the
review, because it is the field the whole verify ladder hangs on. `<!-- VERIFY -->` on a box.

**9. MACsec / `ha-link-encryption`, `lsys`/tenant scoping, and `show security ipsec
security-associations` under logical systems.** Anything at service-provider scale hits
these on day one. Not urgent for the seed; worth a stated non-goal in `03-non-goals` so a
reviewer knows it was considered rather than forgotten.

---

## 22. Priority

| # | Finding | Severity | Blocks ship? |
|---|---|---|---|
| 1 | No `set` line can be `Disruptive` | Critical | **Yes** |
| 2 | `ChangesConfig` caption is false on operational `clear` | Critical | **Yes** |
| 3 | `zone.host-inbound.ike-missing` false-fires and its fix widens exposure | High | **Yes** |
| 4 | `INVALID_KE_PAYLOAD` semantics and citation | High | Yes |
| 5 | PFS-mismatch timing contradicts the corpus's own IKEv2 section | High | Yes |
| 6 | `ike.identity.mismatch` false-fires `definite`/`high` | High | Yes |
| 7 | `ike.dh-group.weak` type error + missing groups 1/22/23/24 | High | Yes |
| 8 | `nat.source-nat-eats-tunnel` mechanism and unscoped condition | High | Yes |
| 21.1 | Verify ladder is wrong on a chassis cluster (`node all`) | High | Yes |
| 9 | Unsourced commit-time SA behaviour | Medium | No, but must become `VERIFY` |
| 15 | IR cannot express `reth-count` / per-node values / `fab0` | Medium | No — but stop using a cluster as the worked example until fixed |
| 10–14, 16–18 | Arithmetic, dead relations, coverage holes, four `acceptable_when` | Medium | No |
| 20–21 | Card corrections and content gaps | Low–Medium | No |

---

## Disagreements

**Convention: "The risk enum — exactly three values, everywhere. Do not add a fourth."**

I agree with three values and I am not proposing a fourth. I am proposing that the
**caption** be separable from the **band**, because conventions currently pins both, and the
pinned caption `CHANGES CONFIG — NEEDS A COMMIT` is factually false when applied to an
operational `clear`. Proposed replacement wording for that section: *"Exactly three bands.
The caption is the default rendering of the band and may be overridden per corpus entry
where the default is untrue; the ink, wash and ordering may not."* See §2.

---

*Reviewed against: RFC 7296 §1.2, §1.3, §2.8, §2.9; RFC 8247 §2.4; RFC 8221 §4, §5;
RFC 3948; RFC 1191; Juniper `dead-peer-detection` statement reference. Claims I could not
verify from a primary source in this pass are marked as such in the text and are not
asserted.*

Sources:
- [RFC 7296 — Internet Key Exchange Protocol Version 2 (IKEv2)](https://www.rfc-editor.org/rfc/rfc7296.txt)
- [RFC 8247 — Algorithm Implementation Requirements and Usage Guidance for IKEv2](https://www.rfc-editor.org/rfc/rfc8247.txt)
- [RFC 8221 — Cryptographic Algorithm Implementation Requirements and Usage Guidance for ESP and AH](https://www.rfc-editor.org/rfc/rfc8221.txt)
- [Juniper — `dead-peer-detection` statement reference](https://www.juniper.net/documentation/us/en/software/junos/vpn-ipsec/topics/ref/statement/security-edit-dead-peer-detection.html)
