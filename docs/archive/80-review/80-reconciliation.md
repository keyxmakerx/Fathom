# 80 — Reconciliation: the corpus's defect register

> **Status:** Accepted
>
> This document is the register of record. Individual items carry their own state
> (`DECIDED` / `DISPUTED` / `DEFERRED`) in the entry.

This consolidates `81`–`86` — six adversarial reviews written from six lenses against the same
corpus — into one prioritised, deduplicated list of everything that must change. Where two
reviewers found the same defect it appears once, under the ID of the finding rather than the ID
of the reviewer. Where two reviewers disagreed, this document adjudicates and says why. Where a
reviewer was wrong, §5 says so with the arithmetic.

**The governing rule of this document, stated once, at the top:**

> **A DEFECT THAT SIX REVIEWERS FOUND AND NOBODY OWNS IS STILL A DEFECT. THIS FILE EXISTS TO GIVE
> EVERY ONE OF THEM AN OWNER, A RESOLUTION AND A STATE.**

**The one-sentence summary of all six reviews:** the corpus is not soft — its self-criticism is
better than most projects' external review — but thirty documents were each asked to be
authoritative and none was told which questions it owned, so the failures cluster at seams rather
than inside documents, and the two places where a *seam* became a *fact* (the workspace format,
and the risk enum applied to `set` lines) are the two that make the product unbuildable and
unsafe respectively.

---

## 0. How to read this

### 0.1 Severity

| Severity | Means |
|---|---|
| **Blocker** | The product cannot be built, or would ship incorrect technical content that an engineer will act on, or would make a false claim to a customer or regulator, or removes a safety control. Nothing downstream is safe until it is closed. |
| **Major** | A real contradiction or overclaim that produces the wrong product, but one that build, CI or test would surface before a user is harmed. |
| **Minor** | Arithmetic, naming, dead references, presentation. Cheap, and cheap is not a reason to leave them. |

### 0.2 Status

| Status | Means |
|---|---|
| **DECIDED** | The resolution below is the resolution. Edit the files. |
| **DISPUTED** | Two reviewers, or a reviewer and this register, reach different answers. The entry states the lean and the axis that decides it. Do not implement either side yet. |
| **DEFERRED** | The resolution depends on a measurement or a decision that has not been made. The entry names the measurement. |

### 0.3 Reviewer codes

`81` security · `82` network domain · `83` coherence · `84` product · `85` AI layer · `86` design.
`R` = this register, where the adjudication is not any reviewer's.

### 0.4 The register at a glance

| ID | Sev | Finding | Raised by | Status |
|---|---|---|---|---|
| R01 | Blocker | Two incompatible workspace container formats | 81, 83 | DECIDED (ownership) / DISPUTED (granularity) |
| R02 | Blocker | The crypto-erasure claim is false, and it is customer-facing | 81 | DECIDED |
| R03 | Blocker | No `set` line in the corpus can ever be `Disruptive` | 82 | DECIDED |
| R04 | Blocker | The AI layer's worked examples cite corpus that does not exist | 85 | DECIDED |
| R05 | Blocker | `zone.host-inbound.ike-missing` false-fires; its auto-fix widens exposure | 82 | DECIDED |
| R06 | Blocker | `INVALID_KE_PAYLOAD` taught as a hard failure; RFC 7296 §1.2 makes it a retry | 82 | DECIDED |
| R07 | Blocker | PFS-mismatch timing contradicts the corpus's own IKEv2 section | 82 | DECIDED |
| R08 | Blocker | `ike.dh-group.weak` cannot match, and misses the two MUST NOT groups | 82 | DECIDED |
| R09 | Blocker | The verify ladder is wrong on a chassis cluster — a false "tunnel down" | 82 | DECIDED |
| R10 | Blocker | `prefers-contrast: more` cascade drops light-theme users to 2.13:1 | 86 | DECIDED |
| R11 | Blocker | Four keymaps; bare `a` accepts an AI change to a firewall | 86 | DECIDED |
| R12 | Blocker | No ownership register, no precedence rule — the cause of R01, R13, R14 | 81, 83, R | DECIDED |
| R13 | Major | The offline single file is specified four ways at five sizes | 81, 83 | DECIDED (shape) / DEFERRED (size) |
| R14 | Major | `21` and `22` are two AI architectures under one section number | 83, 85 | DECIDED |
| R15 | Major | `17`'s keyless merge driver breaches `32` §5.4's invariant | 81, 83 | DEFERRED onto R01 |
| R16 | Major | Two unregistered metadata channels reach `36` Q14's "nothing withheld" | 81 | DECIDED |
| R17 | Major | Four proposed repairs to invariant 3; none adopted. Same for 1, 4, 7, 9 | 81, 83, 85 | DECIDED |
| R18 | Major | `ChangesConfig` renders "NEEDS A COMMIT" on operational `clear` | 82 | DECIDED |
| R19 | Major | `ike.identity.mismatch` fires `high`/`definite` on a working design | 82 | DECIDED |
| R20 | Major | `nat.source-nat-eats-tunnel` states a mechanism the SRX does not have | 82 | DECIDED |
| R21 | Major | The commitment check inverts the error taxonomy it exists to fix | 81 | DECIDED |
| R22 | Major | Rollback protection does not exist in the git shape | 81 | DISPUTED |
| R23 | Major | `publickey-credentials-get=()` makes the WebAuthn keyholder impossible | 83 | DECIDED |
| R24 | Major | `cachetextconv = true` in `17` §12.7's copy-pasteable ini block | 83 | DECIDED |
| R25 | Major | Two re-identification algorithms; one persists what the other forbids | 83 | DECIDED |
| R26 | Major | `72` §4.4 instructs a re-cut of `71`; `71` was not re-cut | 84 | DECIDED |
| R27 | Major | The post-quantum row inside the "what we do NOT claim" table overclaims | 81 | DECIDED |
| R28 | Major | The offline-cracking table is computed at a configuration that will not ship | 81 | DECIDED |
| R29 | Major | `img-src 'self'` in modes C/D is egress to the untrusted-by-design origin | 81 | DECIDED |
| R30 | Major | `ask_human` is exempt from every control the design puts on model prose | 85 | DECIDED |
| R31 | Major | `gate.check` turns every deterministic gate into a hill-climbable objective | 85 | DECIDED |
| R32 | Major | The pre-flight's "NOTHING ELSE WILL BE SENT" is false | 85 | DECIDED |
| R33 | Major | Six safety metrics, two build-blocking, are uncollectable by invariant 1 | 85 | DECIDED |
| R34 | Major | `schema.yaml` — six documents depend on a file no document specifies | 83 | DECIDED |
| R35 | Major | The card's two-column grid cannot render at the width derived for it | 86 | DECIDED |
| R36 | Major | Furniture is ≈279px, not the claimed ~150px | 86 | DECIDED |
| R37 | Major | WCAG "AA in full" claimed against a documented SC 2.4.7 failure | 86 | DECIDED |
| R38 | Major | Default density is 20% looser than the card; `51` §8's own rule unimplemented | 86 | DECIDED |
| R39 | Major | Continuation backslashes — a named card device — off by default | 86 | DECIDED |
| R40 | Major | The workspace creation flow does not exist, and four documents need it | 83 | DECIDED |
| R41 | Major | The migration runner has no owner | 83 | DEFERRED |
| R42 | Major | Deferred AEAD verification contradicts the manifest contract | 81 | DECIDED |
| R43 | Major | Redaction recall is < 1.0 and the ingest report reads as a completeness claim | 81 | DECIDED |
| R44 | Major | The corpus breaches invariant 10 today: no reviewer, no fixtures | 83 | DECIDED |
| R45 | Major | The severity budget escape does not work; the arithmetic is wrong | 82, 83 | DECIDED |
| R46 | Major | Unsourced commit-time SA behaviour, stated as fact | 82 | DECIDED |
| R47 | Major | The IR cannot express a committable chassis cluster | 82 | DECIDED |
| R48 | Major | The margin tab has been industrialised into a badge system | 86 | DECIDED |
| R49 | Major | The 4px accent bar carries six meanings; the R3 audit finds two | 86 | DECIDED |
| R50 | Minor | (See §4 — twenty-one further items) | various | mixed |

---

## 1. Blockers

### R01 — Two incompatible workspace container formats

**Severity** Blocker · **Raised by** `81` F1, `83` F1 (independently, in full)
**Documents** `17` §§2–7, `32` §§5–7 §13 · consumed by `33`, `35`, `36`, `43`, `44`, `73` D15

**Finding.** `32-cryptography.md` and `17-workspace-format.md` both specify the complete on-disk
container, in full, with code, neither citing the other. They disagree on the AEAD (ChaCha20-Poly1305
with a zero nonce, which `32` D4 argues for by name, versus XChaCha20-Poly1305 with a 24-byte random
nonce, which `32` D4 explicitly *rejects*), on the record granularity (64 fixed hash shards versus
four records per device, which `32` D6 explicitly rejects), on the filenames (`.fenv` shard indices
in the clear versus `.frec` keyed pseudonyms in 1 024 buckets), on the header (112 bytes fixed versus
32-byte file header plus 69-byte frame header), on the update model (whole-record rewrite versus
append-only frames), on the manifest (a sealed committed record versus a gitignored local cache),
and on merge (`32` §5.4 declares ciphertext is never merged; `17` §12.4 unions ciphertext frames
keylessly). `33`, `43` and `44` build on `17`; `31`, `34`, `35` and `36` build on `32`. `73` D15
registers the question as open and cites only `32`.

**Resolution.**

1. **Ownership, DECIDED.** `32-cryptography.md` owns primitives, the key hierarchy, key management,
   key commitment, padding and the cryptographic content of a sealed envelope. `17-workspace-format.md`
   owns the on-disk tree, the record taxonomy, the container shapes and git behaviour. Neither may
   specify the other's half. Concretely: delete `32` §6's record model and §13.2–13.3 and replace
   with a deferral; delete `17` §5.6's key-commitment construction and `17` §5.2's AEAD choice and
   replace with a deferral; recompute `17`'s frame-overhead arithmetic against whichever header wins.
   Both reviewers proposed this split independently and they agree; adopt it.
2. **Record granularity, DISPUTED.** `83` §3.4 hands granularity to `17` as part of the container.
   This register does not follow it that far, because the two reviewers did not adjudicate the trade
   and it is not a layout question — it is a metadata-disclosure question that `32` §6.1 spent two
   pages on. `17`'s per-device records publish the exact device count in the file count, permanently,
   in every historical git commit; `17` §6.3 concedes this. `32`'s fixed 64 shards hide it and pay
   for it by making per-device lazy loading impossible (`44` §4.8.6).

   > **The register's lean: hash-sharding.** A permanent metadata leak in immutable history is
   > unrecoverable; an open-time regression is re-engineerable. The performance case for per-device
   > records is currently *unmeasured* — `44` §4.8.5's "records at unlock: 4 / 12" is wrong under
   > both formats (`83` P5, confirmed: `32`'s class floor is ≥85 records; `17`'s is ~70 at 20
   > devices), so nothing in the corpus prices what sharding costs.
   >
   > **The deciding measurement:** open-path time at 20, 100 and 500 devices under both models, at
   > the `FLOOR` KDF config, on the slowest device in `44` §2's matrix. Until that exists this stays
   > DISPUTED.
3. **Update model — append-only frames versus whole-record rewrite — DEFERRED onto (2).** It cannot
   be decided independently: frames imply `33`'s CRDT wire and `17`'s merge driver; whole-record
   rewrite implies `32` §5.4's invariant holds trivially. See R15.
4. Re-open `73` D15 restating the fork as the granularity question with the device-count leak as the
   deciding axis, and re-cite both documents.

**Blocks.** All of `33`; `35`'s A9 BOM; `44` §4.8; `43` §9's runbooks; `36` Q11/Q12/Q52's
verification procedures. Six documents currently specify a product that cannot be built.

---

### R02 — The crypto-erasure claim is false, and it is in the two customer-facing documents

**Severity** Blocker · **Raised by** `81` F2 / O1 (sole reviewer; nobody else read `37`)
**Documents** `36` Q9, `37` §7.4 — contradicted by `32` §9.2, §9.5

**Finding.** `37` §7.4 states that rotating the root key *"renders every prior ciphertext
undecryptable by anyone, including the customer… the key material that could recover it no longer
exists"*, and `36` Q9 repeats it. Under `32`'s own design this is untrue: `RK_e` is recoverable from
any surviving epoch-`e` keyholder record by anyone holding the passphrase, the printed recovery
code, `k` Shamir shares, a member X25519 secret, or the WebAuthn PRF — and every backup of the
workspace contains that keyholder record. `32` §9.2 says exactly this: *"the git-history problem is
not solvable by rotation."*

**Why this ranks above every other overclaim.** It is a technical falsehood, offered to a
data-protection officer, load-bearing for a GDPR Article 17 argument, in a document whose own §1.1
rule is *"nothing here is softer than `31`"*. It is also a one-paragraph edit.

**Resolution — DECIDED.** Replace both. `36` Q9's second answer becomes: *"Crypto-erasure is not
available against a backup that contains the keyholder record, which every backup of a workspace
does. What is available is deletion of the replica (`33` §2.8), plus the honest statement that the
original is on your endpoints and in your repository."* `37` §7.4 is rewritten, not re-hedged — the
legal hedging in the current text is careful and irrelevant, because the technical premise beneath
it is false. Do this before `36` or `37` is shown to anyone outside the project.

---

### R03 — No `set` line anywhere in the corpus can ever be `Disruptive`

**Severity** Blocker · **Raised by** `82` §1 (sole reviewer — the only one with the domain lens)
**Documents** `corpus/commands/junos-srx-ipsec.yaml` (all 40 `mode: configuration` entries),
`corpus/rules/ipsec-junos-srx.yaml` (`remediation.lines[].risk`), `13` §5.5, `61` §4

**Finding, verified against the files.** The 91 command entries follow an undocumented mapping —
`mode: configuration` ⇒ `ChangesConfig`, `clear` ⇒ `Disruptive`, everything else ⇒ `ReadOnly`. The
register counted them: **37 `ReadOnly`, 50 `ChangesConfig`, 4 `Disruptive`, and all four
`Disruptive` entries are `clear …` operational commands.** There is not one `Disruptive` `set` line
in the corpus. Meanwhile the `blast_radius` prose on those same `ChangesConfig` entries reads
*"traffic stops until new ones exist"*, *"everything routed at it blackholes"*, *"drops any
adjacency running over it"*, *"stops negotiating entirely"*, *"the tunnel never comes up again"*.

**Consequence.** The three-colour legend is the only safety affordance in the product and on the
printed card. Under this mapping the red band is reserved for `clear`, so the colour that says
*DROPS LIVE TRAFFIC* never appears on the changes that drop live traffic. An engineer scanning a
generated change set for red before a Tuesday-afternoon window sees amber throughout and proceeds.
`61` §313 states the authoring rule — *"when an author is torn, round up"* — and the corpus rounds
down, systematically, forty times.

**Resolution — DECIDED.** Four parts, all of them mandatory.

1. State the mapping in `61` §4 as a property of **effect**, not of **mode**: `Disruptive` iff
   committing or running the statement can interrupt an established flow, SA or adjacency on a
   device already carrying traffic. `13` §8.1 already asserts this and the corpus does not implement
   it.
2. Add the CI gate `82` specifies: any entry whose `blast_radius` matches
   `/blackhole|traffic stops|drops .*(adjacency|traffic)|never comes up|stops negotiating/i` and is
   not `Disruptive` fails the build.
3. Reclassify, at minimum, the eleven entries listed in §6.1 of this document.
4. Resolve `13` §5.5 against `18` §7.4 **in favour of `18`** — `clear security ipsec
   security-associations index <n>` is `Disruptive`. `18` §7.4 step 5 argues it; `13` §5.5 asserts
   the opposite in a table with no argument. Where an argued position meets an asserted one, the
   argument wins.
5. `commit` and `commit confirmed` must derive their risk from the change set, not carry a static
   label. `18` §6.4 already computes `AGGREGATE RISK`; the `commit` line in a generated ladder
   inherits it. This is a design gap, not a data error, and it is the row that makes the other ten
   safe.

---

### R04 — The AI layer's evidence base is fabricated

**Severity** Blocker · **Raised by** `85` F1 (sole reviewer; it was the only lens that grepped the
worked examples against `corpus/`)
**Documents** `21` §§12.3–12.5, §13.1; `22` §8.1; `23` §5.2; `24` §7.3; `25` §6.3, §6.5

**Finding.** Eleven of eleven rule IDs and four of four corpus/command IDs cited inside worked
examples in `20-ai/` do not resolve in the shipped corpus. Five are misspellings of real entries.
**Two carry the argument:** `ipsec.traffic-selector.multiple-under-v1`, which `21` §12.4 labels
*"DETERMINISTIC WIN #4, and the most important one in this scenario"*, does not exist and the
nearest real rule (`ipsec.traffic-selector.not-mirrored`) cannot substitute — it `requires:
[peer_config]`, which Scenario A's graph does not have, so it yields `Unprovable`. And
`ike.dpd.default-timing` is reported firing at `low` on a graph where the real rule
(`ike.dpd.too-slow`, `severity: medium`) is structurally unfirable because `vpn` is null.

**Why this is blocking rather than editorial.** `22` §2.7 gate G1 rejects any payload citing an
unresolvable ID. Every worked example in `21`, `23` and `25` is a payload G1 rejects. The documents
demonstrate their design by showing outputs their own gates would refuse — and the single strongest
claim in the AI corpus (*"the model contributes attention, the corpus contributes judgement"*) rests
on a rule nobody wrote. Strip the invented rule and Scenario A's objection becomes uncited model
prose about vendor behaviour, which is the thing the whole design exists to prevent.

**Resolution — DECIDED.** In `85` §2.4's order, unchanged:

1. Rewrite every worked example against the shipped corpus by ID, and add the CI check that greps
   `docs/20-ai/**` for `RuleId`/`CorpusId`-shaped literals and fails on any that does not resolve.
   Same class of check as `23` §9.4's DI-2 grep; an afternoon.
2. File the three genuinely missing rules as corpus tickets — `ike.version.v1-in-use`,
   `ike.proposal.sha1`, `ipsec.traffic-selector.multiple-under-v1`. They are useful at tier 0 with
   no model, which is the point.
3. Do not re-run the scenarios until (2) lands. The rewritten scenarios will show the model
   contributing less than the current text implies. That is the honest picture and the corpus should
   publish it.

---

### R05 — The flagship rule false-fires on the field card's own syntax, and its auto-fix widens the exposure

**Severity** Blocker · **Raised by** `82` §3
**Documents** `corpus/rules/ipsec-junos-srx.yaml` → `zone.host-inbound.ike-missing`; `11` §7.5;
`36` (row 1 of "what this tool tells you to do")

**Finding, verified against the file.** The rule is `severity: high`, `confidence: definite`,
`category: correctness`, and its condition is
`zone == null || !zone.host_inbound_system_services.exists(s, enum_is(s, "ike"))`. `11` §7.5 states
that `host-inbound-traffic` exists in **two** places — zone-wide on `Zone`, and **per interface on
the `ZoneMember` edge** — and writes the correct disjunction itself. The rule implements only the
zone-wide half. The card's own plumbing piece #3, the statement this rule exists to enforce, is the
per-interface form. A configuration written exactly as the card teaches fires this finding. The rule
also does not test for `all`, so `system-services all` false-fires too.

**And the remediation is a security regression.** It emits `op: add_to_set, target: zone`, i.e. the
zone-wide form — opening IKE inbound on every interface in the WAN zone rather than the one the
gateway uses. `36` says the opposite is required. This is a linter widening an attack surface to
silence itself, which `policy.zone-pair.missing`'s own `remediation_absent_reason` says must never
happen.

**Resolution — DECIDED.** Re-anchor to the `ZoneMember` edge per `11` §7.5 and implement the full
disjunction including `all`; change the remediation to `add_to_set` on the **edge**, emitting
`set security zones security-zone {{zone}} interfaces {{unit}} host-inbound-traffic system-services
ike`; add a `must_pass` fixture that is literally side 1 piece #3. The absence of fixtures (R44) is
why this was not caught.

---

### R06 — `INVALID_KE_PAYLOAD` is taught as a hard failure; RFC 7296 §1.2 makes it a retry

**Severity** Blocker · **Raised by** `82` §4
**Documents** `corpus/explainers/ipsec-concepts.yaml` → `explain:error:junos-srx/INVALID_KE_PAYLOAD`;
`corpus/rules/…` → `ipsec.pfs.group-mismatch`, `ike.dh-group.weak`

**Finding.** The explainer says *"it is looking at bytes it cannot interpret. There is nothing to
negotiate at that point"* and *"On Phase 1 the tunnel never establishes."* RFC 7296 §1.2 specifies
the opposite: the responder parses the SA payload, selects a transform, notices the KE payload used
a different group, and returns `INVALID_KE_PAYLOAD` **naming the group it wants**; the initiator
MUST retry `IKE_SA_INIT` with that group. It is a negotiation mechanism, not a parse failure, and it
appears exactly once in a healthy bring-up whenever the initiator's proposal list contains the named
group. It is terminal only when the two group sets are disjoint, and that case usually surfaces as
`NO_PROPOSAL_CHOSEN`.

**Two further errors in the same entries.** The citation is to RFC 7296 **§1.3** ("KE payload in
CREATE_CHILD_SA"), which says nothing about `INVALID_KE_PAYLOAD`; the Phase 1 behaviour is §1.2. And
the version scope is wrong: `INVALID_KE_PAYLOAD` is IKEv2 notify type 17 and cannot appear on an
IKEv1 gateway — the IKEv1 analogue is `INVALID-KEY-INFORMATION`, and an IKEv1 Quick Mode PFS group
mismatch surfaces as `NO_PROPOSAL_CHOSEN` because the group is a Quick Mode SA attribute. The entry
nonetheless carries `versions: "*"` with no qualifier, unlike its sibling `TS_UNACCEPTABLE`, which
correctly carries `qualifier: v2`.

**Resolution — DECIDED.** Rewrite the explainer body around retry semantics; add
`subject.qualifier: v2`; split `explain:error:junos-srx/INVALID-KEY-INFORMATION` for v1; re-cite to
RFC 7296 §1.2; add a version predicate to `ipsec.pfs.group-mismatch` with two
`symptom_if_mismatched` branches. **The card is not at fault** — its ERROR DECODER row is a terse
two-column lookup and is fine as a heuristic. The corpus turned a lookup row into an absolute. That
distortion pattern is R50-D in §6.4 and it recurs three more times.

---

### R07 — The corpus contradicts itself on when a PFS mismatch actually breaks

**Severity** Blocker · **Raised by** `82` §5
**Documents** `corpus/rules/…` → `ipsec.pfs.absent` versus `ipsec.pfs.group-mismatch`; `18` §7.3

**Finding.** `ipsec.pfs.absent.explain.teaching` says, correctly and in the card's own words, *"Under
IKEv2 the first child SA is always keyed from the IKE SA regardless; PFS applies to later child
rekeys."* Three rules earlier, `ipsec.pfs.group-mismatch.why` says *"the child SA never installs"*.
Both cannot be true on a `v2-only` gateway, and `18` §7.3 — which every reviewer independently named
the best section in the corpus — proves which: the first Child SA is created in `IKE_AUTH`, which
carries no KE payload, so it installs, and the mismatch surfaces at the first `CREATE_CHILD_SA`
rekey, up to `lifetime-seconds` later.

**Consequence.** The rule tells an engineer the tunnel is down now. On IKEv2 the tunnel is up now and
fails an hour after the change window closes — which is precisely the failure mode `18` §7.3 was
written to prevent, arriving through the rule that fires in the UI.

**Resolution — DECIDED.** Version-predicate both PFS rules. Each `symptom_if_mismatched` gets a v1
branch (immediate Quick Mode failure) and a v2 branch (installs; fails at first child rekey; force
it inside the window with `clear security ipsec security-associations index <id>`). Link both to
`18` §7.4 step 5 so the rule and the ladder agree. This also removes the `high` that R45's
arithmetic depends on.

---

### R08 — `ike.dh-group.weak` compares an enum to integers and misses the two groups RFC 8247 prohibits

**Severity** Blocker · **Raised by** `82` §7
**Documents** `corpus/rules/…` → `ike.dh-group.weak`

**Finding, verified.** The condition is `has(dh_group) && dh_group in [1, 2, 5]` while `11` §6.7
types `IkeProposal.dh_group` as the `DhGroup` enum and every other predicate in the bundle uses
`enum_is(field, "value")`. Its own remediation writes `{ enum: group14 }`. Under `12`'s typed
evaluation this either fails to compile or silently never matches — and "silently never matches" is
the outcome that ships. Separately, the rule's `why` says RFC 8247 §2.4 marks groups 2 and 5
`SHOULD NOT` while the condition also catches group 1, which the RFC marks **MUST NOT** — a strictly
stronger statement the rule never makes — and it misses groups **22** (MUST NOT), **23** and **24**
(SHOULD NOT) entirely. Junos supports `group24`; group 22 passes this rule clean.

**Resolution — DECIDED.** Set membership over the `DhGroup` enum covering
`group1, group2, group5, group22, group23, group24`; split severity, with groups 1 and 22 at `high`
(MUST NOT) and the rest at `medium`; correct the `why`. Write the sibling check for
`IpsecPolicy.perfect_forward_secrecy`, which the file already flags as `ipsec.pfs.group-weak` under
§ UNRESOLVED REFERENCES — it is the right call to write it and it is not optional.

---

### R09 — The verify ladder is wrong on a chassis cluster, and every worked example is a cluster

**Severity** Blocker · **Raised by** `82` §21.1
**Documents** `corpus/commands/junos-srx-ipsec.yaml`; the ladder in `18` §7; `.context/field-card`

**Finding.** `show security ike security-associations` and `show security ipsec
security-associations` accept a `node (0|1|all|local|primary)` qualifier. Run without it on the wrong
node of a cluster they return nothing. An engineer following the card's ladder on the secondary node
concludes the tunnel is down. **That is a false "tunnel down" produced by the tool's own recommended
procedure, on the tool's own worked topology** — every example in the corpus is `reth0.0`, i.e. a
cluster. Compounding it: 91 command entries and not one of `show chassis cluster status`,
`show chassis cluster interfaces`, `show chassis cluster statistics`, or
`request chassis cluster failover …`.

**Resolution — DECIDED.** Add `node all` variants of both SA commands as canonical, with the
anchoring behaviour as an explainer (`explain:concept:junos.cluster-sa-anchoring`) that both rules
and the ladder reference. Add the five cluster operational commands. This blocks ship because the
failure is silent and the false conclusion is the most expensive one an operator can reach.

---

### R10 — `prefers-contrast: more` makes contrast worse for the users who asked for more of it

**Severity** Blocker · **Raised by** `86` D-15
**Documents** `55` §2.6 (the closing CSS block), §2.7, §7.4

**Finding.** The second rule in the `@media (prefers-contrast: more)` block has the selector list
`:root[data-theme="dark"], :root:not([data-theme="light"])`, and it is **not** nested inside
`@media (prefers-color-scheme: dark)`. So a user on a light screen with no explicit theme — the
default state of every fresh workspace — who has enabled "Increase contrast" at OS level matches
both rules; the dark block is later and wins; and the dark AAA tokens land on `--page: #FFFFFF`.
Recomputed: `--muted` 2.40:1, `--safe` 2.40:1, `--caution` 2.41:1, `--danger` 2.40:1, and `--danger`
on its own light wash **2.13:1**. The user moves from a worst pair of 4.71:1 to a worst pair of
2.13:1 — a Level AA failure on every semantic token and every margin tab, including
`DISRUPTIVE — DROPS LIVE TRAFFIC`, delivered only to low-vision users, by the feature written for
them.

**And the specified CI check cannot catch it.** `55` §2.7 tests four token sets in isolation. The
defect is in the cascade. `contrast_more_clears_aaa` passes.

**Resolution — DECIDED.** Take `86`'s three-block rewrite verbatim (light AAA under
`:root, :root[data-theme="light"]`; dark AAA under `(prefers-contrast: more) and
(prefers-color-scheme: dark)` for the unset case, and separately under
`:root[data-theme="dark"]`). Then move the CI check from token sets to **resolved cascade**: compute
each token's resolved value under all eight (theme × contrast × forced-colors) states in a headless
browser and assert there. That is what `55` §2.7 meant and not what it says.

---

### R11 — Four incompatible keyboard maps, one of which removes the safety modifier from accepting an AI change to a firewall

**Severity** Blocker · **Raised by** `86` D-33
**Documents** `53` §3 (owns the keymap), `54` §23 / §15 / §19, `52` §3.8 §4.3 §6.5, `55` §4.5.6

**Finding.** Four documents each publish a complete or product-wide keymap and they conflict on view
switching (`⌥1–6` versus `Ctrl+1–6`), explainer depth (where `54` contradicts *itself* between §15
and §23, and §15's binding collides with its own §23 view-switch), and on `n`, `p`, `u`, `g`, `i`,
`/` and `Esc`. **The one that matters:** `53` §3.8 states a safety principle — *"every action that
removes data or commits a security decision requires `Shift` plus its letter"* — and binds `⇧A` to
accept checked proposal ops, with `53` §3.5 refusing `Enter` for the same reason. `54` §19 and §23
bind bare **`a`**. In a product whose output is pasted into production firewalls, one document makes
"apply an unvalidated model-generated change" a single unmodified letter. `54` §23's own header reads
*"so conflicts are visible"*.

**Resolution — DECIDED.** `53` owns the keymap; say so in the companion-document line of `52`, `54`,
`55` and `56`, and delete the maps in `54` §23, `54` §15, `54` §19 and `55` §4.5.6, replacing them
with pointers. Keep `⇧A` / `⇧R` — `53` §3.8's principle is right and it is the only place in the
design set where a binding is treated as a security control. Resolve the four genuine collisions
inside `53` by scoping (`n`/`p`/`u` diff-scoped) and by moving the Outline's graph traversal to
`⌥→`/`⌥←` so `g` can be a sequence prefix. Add the fifty-line CI test that parses every `<kbd>` table
in `docs/50-design/` and fails on any key bound twice in overlapping scopes.

---

### R12 — There is no ownership register and no precedence rule

**Severity** Blocker (process) · **Raised by** `81` §13.1, `83` §15.1, and this register
**Documents** `.context/conventions.md`; a new `docs/00-vision/01-ownership.md`

**Finding.** `83` §2.1 built the cross-document dependency graph — 312 references across 43
documents — and found the shape of the failure: deferral edges (~180) are almost always sound;
extension edges (~30) are sound and usually flagged; and there are exactly **nine silent
re-decisions**, of which **all nine are contradictions**. They cluster in one place: wherever two
documents were both plausibly the owner of a question and neither was told which. `conventions.md`
pins vocabulary, invariants, colours and identifiers. It says nothing about *decisions*. The
instruction *"do not redefine any of these"* was obeyed — nobody redefined the conventions — and the
corpus still failed to compose. R01, R13, R14, R25 and most of `86` §9 are instances of the same
missing rule.

**Resolution — DECIDED.** Both reviewers' proposals, merged, because they are complementary rather
than competing:

1. **`conventions.md` gains an `## Ownership` section** (`83` §15.1's text): every settled question
   has exactly one owning document, listed in `docs/00-vision/01-ownership.md`. A non-owner defers in
   one sentence and does not restate the answer except to lift a number verbatim with a citation. A
   document that believes the owner is wrong files a `## Disagreements` entry and **may not ship a
   second specification in the meantime** (`81` §13.1's clause, which is the enforcement `83`'s
   version lacks).
2. **Write `docs/00-vision/01-ownership.md`** — one table, one row per settled question, naming the
   owning document. Seed it with the assignments in this register: `32` crypto, `17` container,
   `33` wire, `34` browser platform, `43` deployment lettering, `44` size and performance budgets,
   `11` re-identification, `12` suppressions, `22` the subagent catalogue, `53` the keymap.
3. **Add `83` §15.2's pre-write rule**: before writing, list every sibling document that touches your
   subject and record in your own §1 which sibling decisions you are building on, by name and
   section. The `## Disagreements` mechanism works — every disagreement raised through it is
   well-argued — but it only fires when an author *notices*, and a document that re-decides a
   question in good faith has by definition not noticed. This is the missing half.
4. **Adopt `83` §15.3's status change**: add `Superseded by NN §M`, and require a document whose core
   decision is contradicted by a sibling to carry `Contested` naming the sibling. Under that rule
   `17`, `21`, `22`, `32`, `34`, `43` and `44` all currently read `Contested`, which is the honest
   state and the fastest way to stop someone implementing from the wrong one.

---

## 2. Majors

### R13 — The offline single file is specified four ways, at five sizes, at two capability levels

**Severity** Major · **Raised by** `81` §7.3 (three-way fork), `83` F2 (four-way, plus the CI gate)
**Documents** `34` §3.3, `43` §3.5, `44` §5.2–§5.3, `35` §13.2, `41` §3.10, `16` §9.4, `36` §1.3 Q39
Q40, `73` D07

**Adjudication between reviewers.** `81` and `83` found the same fork and `83` found more of it —
the fourth fork is `44`'s CI check P6 (`A1 ≤ 4.5 MB; WASM ≤ 900 KB`, blocks the merge), which would
**reject every build of the artifact `43` §3.5 specifies** (5.4–6.7 MB, WASM 2.0–3.0 MB). `83` also
found what `81` did not: `73` §3.7 D07 has **already decided** "A and B, both, from one build" and
records `43`'s extension as accepted — so this is not an open fork at all, it is an unapplied
decision. `83`'s framing supersedes `81`'s. Both reviewers prefer `43` §3.5 on the merits and this
register agrees: it satisfies `34`'s own rule (*"we do not put a secret behind a policy we cannot
deliver"*) exactly, because with no browser storage there is no secret at rest behind the
undeliverable policy.

**Two consequences neither reviewer's fix covers on its own.**

- `44` §13 declares *"no disagreements"* while its entire §4.8 presumes `43` §3.5 has been accepted.
  Under `34` as written, B14, B15 and B16 do not exist because mode A never unlocks anything.
- `32` §4.3's `p = 1` decision loses its stated justification. Argument 2 — *"a `file://` document
  has no HTTP headers, so the offline build can never be cross-origin isolated"* — is false for the
  artifact that actually runs Argon2id, because mode B is served by `fathom serve` with
  `COOP: same-origin` / `COEP: require-corp` per `34` §2.2. `p = 1` may still be right on arguments
  1 and 3; argument 2 must be withdrawn or the decision re-argued.

**Resolution.**
**Shape — DECIDED.** Edit `34` §3.3 to reflect D07 (or reverse D07 explicitly; do not leave both).
Keep `34` §3.3's masthead phishing control in `43`'s reworded form. Record the two extra post-XSS
channels as a `material` residual specific to mode A. `36` §1.3, Q39 and Q40 are rewritten *before*
`36` is shown to anyone — it currently states one side of a live fork to a customer as fact, and
answers an air-gapped defence customer with a capability loss that the project has already decided
not to take.
**Size — DEFERRED.** `44` owns the size table; delete `43` §3.2's and `41` §3.10's independent
budgets and `35` §13.2's 28 MB worked output. But the numbers cannot be reconciled yet: the WASM core
is estimated at 700 KB by `41`/`44` and 2–3 MB by `43`, from the same component enumeration.
**The deciding measurement is a two-day spike to build and measure `fathom_core.wasm`.** It decides
B17, B18, the artifact shape, and whether mode A is viable at all. It is the single most consequential
unmeasured number in the corpus.
**Also DECIDED:** adopt `44` §5.4's two font faces (the only argued figure) over `41`'s four and
`43`'s five; set `21` §7.0's single-file tier-2a row to `no` and regenerate §7.6's degradation table;
adopt `43` §1.1's `D1`–`D4` lettering corpus-wide or reject it explicitly — two live namings is the
worst outcome.

---

### R14 — `21` and `22` are two AI architectures wearing one section number

**Severity** Major · **Raised by** `83` F3, `85` F8
**Documents** `21` §5, §6, §7.6, §13; `22` §§2.1–2.7; `25` §1.2

**Finding.** The two documents name disjoint subagent rosters with zero cross-references — `22`
contains not one occurrence of any of `21`'s eight identifiers — and they differ on the proposal type,
the confidence enum, the capability enum (9 flags versus 23), the tool surface (11 versus 19), the
gate set, the supervisor's role (planner versus router), the deployment shapes and the consent model
(per-(workspace, purpose) versus per-invocation). `22` argues two of `21`'s eight out of existence,
and `21`'s per-tier degradation table and both worked scenarios are driven by those two. `25` §1.2
documents the collision, calls it *"DECISION NEEDED"*, keys itself to `22`, and states that its
mapping table is not authoritative — which is correct behaviour and leaves the decision unmade.

**Adjudication.** `83` says `22` owns the roster. `85` goes further and specifies the split. `85`'s
version is more actionable and this register adopts it: **`22`'s catalogue, gates, `SubagentSpec`,
`ToolGrant` and eval contract; `21`'s boundary, verbs, tiers, egress machinery and `PredictedEffect`.**
`22` carries the types an implementer needs; `21` carries the argument and the security design.

**Resolution — DECIDED.** Delete `21` §5 and §6 and replace with two paragraphs and a pointer.
`22` §2.2's `Proposal<T>` absorbs `21` §2.3's `PredictedEffect`, `Basis` and `caveats` — `Basis` and
`ProposalConfidence` are the same three-value idea and must not both exist. `22` §1.3's per-invocation
consent is replaced by `21` §8.4's expiring grants. `21`'s tier table stays; `22` §1.4's shapes are
re-expressed against it. Rename the file `22-subagent-catalogue.md`, which also closes `21` §5's
dangling pointer and the terminology violation. Delete `25` §1.2's mapping table. Add the
runtime/build-time split to `21` §2.1's boundary statement (*"reach the filesystem, the network or a
shell **at runtime**"*), because `22`'s build-time agents legitimately do both and `21`'s unqualified
sentence currently forbids them.

**Related, and this register endorses it:** `85` §3's F2. The supervisor makes **zero model calls in
every documented interaction** — `intent.router` is not shipped at tier 1 and `22` §15.1 removes
planning — so it is a host-side Rust dispatcher. That is the right design and the strongest
engineering in the AI corpus. What is wrong is that no document says it. Add `85`'s one sentence to
`21` §4.1 and let the owner decide whether a Rust dispatcher satisfies *"there needs to be a
supervisor AI"*. One sentence, no code, and it is the difference between a design an enterprise
reviewer trusts and one they suspect.

---

### R15 — `17`'s keyless git merge driver breaches `32` §5.4's invariant

**Severity** Major · **Raised by** `81` F3, `83` §3.2 point 2
**Documents** `32` §5.4 versus `17` §5.4, §12.4

**Finding.** `32` §5.4 declares `> INVARIANT — ciphertext is never merged. The sync layer transports
whole records. It never combines two envelopes.` `17` §12.4's merge driver is a set union over
ciphertext frames, performed without the key, by a subprocess, and `17` §1 calls it *"the most
important result in this document"*.

**Adjudication.** `81` treats the driver as a breach to be removed. `83` §14 calls it *"a genuinely
elegant result"* and asks that it be carried over if `32` wins. Both are right and they are not in
conflict: the invariant is not negotiable, and the elegance is real but is a *property of the frame
model*, not a separable idea. There is no version of the driver that survives whole-record rewrite,
because under `32`'s model a record is one envelope and combining two envelopes is exactly what the
invariant forbids.

**Resolution — DEFERRED onto R01.** The merge driver ships iff the frame model wins. It is not an
independent decision and must not be implemented before R01 closes. If hash-sharding wins, `32` §5.4
Case 2 is the behaviour (merge on opened plaintext, in the core) and `17` §12.4 is deleted rather
than weakened.

---

### R16 — Two metadata channels reach `36` Q14's "nothing withheld" and are not in it

**Severity** Major · **Raised by** `81` §4.2, F3
**Documents** `31` §7.2 (M1–M10), `36` Q14, `37`; sources `33` §2.5 §12.3 and `17` §5.1 §5.5

**Finding.** `31` §7.2 enumerates ten channels and `36` Q14 renders that to a customer as *"Nothing
withheld — `31` §7.2 enumerates ten channels."* Two more exist, both honestly priced in their own
documents and neither propagated:

- **`IndexEntry.kind_opaque`** — the record kind in the clear to the sync server, making the
  suppressions record individually identifiable and trackable. `31` §2.1 ranks suppressions **V3**.
- **Per-frame `hlc.wall_ms` + `actor`**, in the clear, permanently, in every git object — a
  pseudonymous per-record, per-writer, wall-clock edit-activity map: team size per device, working
  hours per person, change windows. This is materially worse than M4/M5 because it is at record
  granularity, per-author, and it goes to whoever can read the repository rather than to the
  operator. It is precisely the per-operation model `32` §6.1 evaluated and rejected.

An answer that opens with *"nothing withheld"* and is then shown to have withheld two channels costs
more than the channels do.

**Resolution — DECIDED.** Add M11 and M12 to `31` §7.2 and propagate to `36` Q14, `37` and the sync
setup screen. **`17` §5.4's `opaque_frames` defaults on for any workspace with more than one
member**, because the disclosure it makes is precisely a multi-writer disclosure. This holds whichever
way R01 resolves. Also: `36` Q12 step 10 tells a reviewer to expect high-entropy bytes on the wire;
under `17`'s frame header they will see a plaintext ASCII magic, a plaintext millisecond timestamp
and a plaintext actor pseudonym. The honest reason (keyless `git merge`) is a good answer and step 10
of a verification procedure is the worst place to deliver it. Fix the procedure text.

---

### R17 — Four proposed repairs to invariant 3, none adopted; and four other invariants have filed amendments

**Severity** Major · **Raised by** `81` O11 / §10, `83` §8, `85` §15.2
**Documents** `.context/conventions.md`; `31` §14.1, `32` §21.1–§21.3, `33` §18.3, `14` §9.9,
`17` §21.1–§21.2, `24` §11.1, `25` §15.1, `21` §18.1

**Finding.** Invariant 3 (*"the application never accepts a credential"*) is the most-quoted
invariant and the one in the worst shape. Four documents propose four incompatible repairs: `31`
§14.1 says exactly two secrets exist; `32` §21.3 supersedes it with six workspace secrets plus one
transmitted; `33` §18.3 adds a third category (the sync account credential) that `32` §21.3 does not
know about and whose wording therefore forbids it; `14` §9.9 establishes that the application *does*
accept a real credential, transiently, on every paste. `32` §21.3's text is the best of the four and
is **already stale**.

**This is the register's cheapest item and its clearest governance failure.** The convention's
procedure worked exactly as designed — every author raised the objection instead of deviating
silently — and nobody closed it. `85` §15.2 makes the general point: an invariant that three of its
dependents have to work around is not an invariant, it is a comment.

**Resolution — DECIDED.** One editing pass over `conventions.md`, adopting all of the following in a
single commit:

| Invariant | Adopt | From |
|---|---|---|
| 1 (no egress) | the tier-1 carve-out as an *explicit* exception, not an implicit one | `21` §18.1 |
| 3 (no credential) | `32` §21.3's enumeration, **extended** with `33`'s account credential and `14` §9.9's transient-paste clause | `32` §21.3 + `33` §18.3 + `14` §9.9 |
| 4 (server holds no key) | `32` §21.2's replacement (the member log holds public keys and the server holds them) | `32` §21.2 |
| 7 (opaque IDs) | the clarification in R25 — never persisted as a *graph reference*; the tier-1 tuple's hash may be persisted as a **recovery** key | `83` §6.4 |
| 9 (determinism) | `17` §21.1's *"same converged workspace state"*, `24` §11.1's four-tuple naming the rule-pack version set, `25` §15.1's build-time clause, and `81` §13.2's quarantine of the AI session and egress logs | four documents |
| — | pin the `none \| bounded \| material \| total` residual scale, unchanged, as `31` §14.3 asks. It has been adopted verbatim by `32`, `34`, `36` and `37`; only the convention is missing | `31` §14.3 |
| — | adopt `32` §21.1's `record` row, and delete `17`'s opening note paying the same tax | `32` §21.1 |
| — | exempt *"the model"* as an abbreviation of "threat model" inside `30-security/` only; fix `55` §541 and `61` §430 to "the pattern" and `33` §1352 to "the document model" | `83` §9.1 |
| — | terminology binds filenames, directories, type names, identifier prefixes and CLI flags, not only prose | `85` §15.1 |

---

### R18 — `ChangesConfig` renders "NEEDS A COMMIT" on operational commands

**Severity** Major · **Raised by** `82` §2 (and raised as a formal `## Disagreements` entry against
`conventions.md`)
**Documents** `.context/conventions.md` § *The risk enum*; `13` §5.5;
`corpus/commands/…` → `junos-srx/ipsec.statistics.clear`

**Finding, verified.** `clear security ipsec statistics` is `risk: ChangesConfig`, `mode: operational`,
`reversible: none`. The enum's rendered string is pinned by conventions and by the card:
`CHANGES CONFIG — NEEDS A COMMIT`. The command changes no configuration, needs no commit, and
`rollback 1` will not undo it. `13` §5.5 defends the label — *"the three-value enum forces the honest
call"* — but the enum did not force an honest call, it forced a false caption, and the document
rationalises it rather than recording it as a defect. A counter baseline destroyed mid-incident is
not recoverable by any Junos mechanism, and the label implies the Junos safety net applies.

**Adjudication.** `82` proposes separating the **caption** from the **band**: three colours, but a
`ChangesConfig` entry with `mode: operational` renders `CHANGES STATE — NOT REVERSIBLE BY COMMIT`.
Same ink, same wash, same ordering, different words. This register accepts it, against the mild
objection that it adds a field to `61` §3.2 and amends a pinned constant. The reason: the alternative
is to leave one place in the product where the legend lies, in a corpus whose stated discipline is
that it does not. A false caption is worse than an amended convention. **This does not open the door
to a fourth colour** and the amendment text must say so.

**Resolution — DECIDED.** Amend the conventions' risk-enum section to: *"Exactly three bands. The
caption is the default rendering of the band and may be overridden per corpus entry where the default
is untrue; the ink, wash and ordering may not."* Add `risk_caption_override` to `61` §3.2. Apply it
to the operational `clear` entries that survive R03's reclassification.

---

### R19 — `ike.identity.mismatch` fires `high`/`definite` on a very common working configuration

**Severity** Major · **Raised by** `82` §6
**Documents** `corpus/rules/…` → `ike.identity.mismatch`

**Finding, verified.** The condition is
`(has(local_identity) || has(peer.remote_identity)) && local_identity != peer.remote_identity`, at
`severity: high`, `confidence: definite`, `category: correctness`, `acceptable_when: "Never as a
steady state — authentication cannot succeed."` Consider the ordinary case: this end sets
`local-identity inet 198.51.100.5` because it sits behind NAT; the peer sets no `remote-identity` and
accepts the ID presented. First disjunct true, inequality true, rule fires and asserts authentication
*cannot* succeed. It succeeds every day. The condition treats an absent peer field as a disagreeing
value rather than as "no constraint" — exactly the distinction `Presence` (`11` §5) exists to make,
and one `on_unset: skip` does not cover because the peer's field is `Absent`, a positive fact, not
unset on *this* node.

The pack already contains the honest version of the same check —
`ike.identity.required-behind-nat` at `medium`/`probable` — and the dishonest one outranks it.

**Resolution — DECIDED.** Require both sides:
`has(local_identity) && has(peer.remote_identity) && local_identity != peer.remote_identity`, and
move the "one side constrains, the other does not" case into `ike.identity.required-behind-nat` at
`probable`, where it already belongs.

---

### R20 — `nat.source-nat-eats-tunnel` states a mechanism the SRX does not have, and its condition ignores scope

**Severity** Major · **Raised by** `82` §8
**Documents** `corpus/rules/…` → `nat.source-nat-eats-tunnel`; `11` §6.6

**Finding.** `explain.explained` says *"Source NAT is evaluated on the way out regardless of which
interface the route chose."* On SRX, source NAT rule sets are scoped by `from` and `to` context —
zone, interface or routing-instance — and the `to` context is resolved *after* the forwarding lookup
picks the egress interface. The IR models this correctly (`NatRuleSet.from/to: NatScope`). A rule set
declared `from zone TRUST to zone UNTRUST` does not match traffic routed at `st0.0` when `st0.0` is
in zone `VPN` — which is the topology the card's plumbing piece #2 tells you to build. The card's own
phrasing is narrower and compatible with the real failure modes; the corpus generalised it into
something false.

And the condition touches neither `NatRuleSet.from` nor `.to`, so every device with an internet
source-NAT rule matching `0.0.0.0/0` and any tunnel fires this `high` finding, correctly configured
or not.

**Resolution — DECIDED.** Add the scope test —
`nat_scope_covers(parent_ruleset.to, vpn.bind_interface)` — and add `nat_scope_covers(scope, unit)`
to § DERIVED PREDICATES. Rewrite `explain.explained` to state the zone-scoped mechanism. Keep
`confidence: probable`; it is honest here.

**Note on the false-positive cluster.** R05, R19 and R20 together mean the seed pack fires **three
`high` false positives on a correctly built branch firewall**. The brief's own thesis is that *"tools
that flag everything are muted within a week"*. This cluster is the mechanism by which that happens,
and it is why R05, R19 and R20 must land together rather than as three tickets.

---

### R21 — The commitment check inverts the error taxonomy it exists to fix

**Severity** Major · **Raised by** `81` §3.1 / O5
**Documents** `32` §3.2, §7.2, §16.2

**Finding, verified.** `32` §3.2's open sequence returns `Err(WrongKey)` on a constant-time compare
failure **before** the AEAD is reached. `commit_tag` is correctly not in the HKDF `info`, so flipping
one byte of it does not change `K` — it fails the compare and returns `WrongKey`. But `32` §7.2's AAD
table claims *"`commit_tag` — an output, not an input, but authenticated so that stripping or
altering it fails **at the MAC as well as** at the constant-time compare."* Under §3.2's own ordering
it never fails at the MAC, because the function returns first.

**Concrete failure.** A hostile sync operator, a hostile git committer, or one bit of bit-rot in a
`commit_tag` byte produces *"wrong passphrase"* for a user whose passphrase is correct. §3.2's stated
justification for the ordering is that telling a user the file is corrupt when they mistyped is how
support tickets are made; the design produces the exact inverse, which is worse, because the user's
response to "wrong passphrase" is to try harder rather than to restore from backup. `32` §16.2 has no
negative vector for a mutated `commit_tag`, so CI would not catch it.

**Resolution — DECIDED.** On a commitment mismatch, run the AEAD open anyway — constant time is
irrelevant, the attacker already has the ciphertext — and branch on the result: MAC fails ⇒
`Tampered`; MAC succeeds ⇒ `CommitmentMismatch`, a distinct nameable state. Add both to §16.2's
negative-vector table. Cost: one wasted AEAD open on a genuinely wrong passphrase, microseconds
against a one-second KDF.

---

### R22 — Rollback protection does not exist in the git shape

**Severity** Major · **Raised by** `81` §3.4 / O13
**Documents** `32` §8, §8.1–§8.3, §18, §19 C11; `17` §3, §7.4; `31` §12; `36`

**Finding.** `32` §8 makes the manifest carry the version vector and per-record digests, and §8.1
requires that every record named in `records` be present and digest correctly at open — *"a hostile
store that drops the `Suppressions` record makes the workspace look clean."* `17` §3 marks
`manifest.fm` **not committed — local index cache**. So in the git shape — which brief §6.4 makes the
primary collaboration story — there is no manifest travelling with the workspace, therefore no
version vector, therefore none of §8.2's rollback rule runs, and `32` §18's "Rollback refusal" CI
check and `31` §12's "Rollback rejection test" exercise a path that does not exist where it matters.
A colleague who clones the repository is `32` §8.3's *"fresh client… cannot detect anything"*,
permanently, by design. `32` §19 C11 tags this `bounded` on fresh-client grounds; under `17` it is an
every-client problem in the shape the product leads with.

**Status — DISPUTED, because it is downstream of R01 and the two formats give different answers.**
Under hash-sharding the manifest is a sealed record class `0x00` and travels; the finding largely
evaporates. Under frames it does not travel and the finding is severe. The register's instruction:
**do not tag C11 until R01 closes**, and when it does, either `32` §8 states plainly that rollback
detection is a sync-shape-only control and re-tags C11 `material` and `36` stops implying otherwise,
or `17` §7.4 changes. Both reviewers agree it must be one or the other; neither can be written today.

---

### R23 — `Permissions-Policy: publickey-credentials-get=()` makes the WebAuthn keyholder structurally impossible

**Severity** Major · **Raised by** `83` P1
**Documents** `34` §2.2, §2.4, CI check H11; `32` D13, §12.3

**Finding.** `34` denies `publickey-credentials-get` in modes B, C and D, and H11 asserts every listed
feature is denied. An empty allowlist denies WebAuthn assertions to the **top-level document**, not
just to frames. `32` D13 ships WebAuthn PRF as an additional keyholder, on by default, and §12.3
requires a `get()` immediately after registration to obtain the PRF output. As written, enrolment
works and unlock does not — the worst of the three possible states — and CI enforces the
impossibility. A user who enrols a passkey gets a workspace they cannot open with it.

**Resolution — DECIDED.** Remove `publickey-credentials-get` from the deny list in modes B–D, leaving
it at its `self` default, and state in `34` §2.4 why this one feature is not denied. If instead the
project wants the deny, delete `32` D13 and §12 — but it must be one of the two, explicitly, and
`34` must say which of `publickey-credentials-create` / `-get` it intends in either case.

---

### R24 — `cachetextconv = true` in `17` §12.7's copy-pasteable ini block

**Severity** Major · **Raised by** `83` P2
**Documents** `17` §12.7 versus `17`'s own prose four lines below, `32` §13.3, `32` §17.12

**Finding, verified.** Line 964 of `17` sets `cachetextconv = true`. Line 981 of the same document
says `fathom git install` sets it to `false` by default and explains why. `32` §13.3 ships `false`
and `32` §17.12 classifies `true` as *"one line in a config file, total confidentiality loss for the
repository"* — git writes decrypted content into `.git/`.

**Resolution — DECIDED.** Change `true` to `false`. This is the highest severity-to-effort ratio item
in the entire register: one word, and anyone implementing from the code block rather than the prose
ships a total confidentiality loss. Do it before anything else on this page.

---

### R25 — Two re-identification algorithms; one persists exactly what the other forbids

**Severity** Major · **Raised by** `83` F4
**Documents** `11` §10.3–§10.6 versus `12` §11.1, §11.4; propagated into `17` §16.2

**Finding.** `11` §10.3–10.4 specifies an ordered list of identity tuples per kind, up to three tiers,
matched by hash join, and states explicitly: *"Identity tuples are… never used for lookup, never used
by rules, never persisted as a key."* `12` §11.4 re-derives a single-tuple scheme with
`NaturalKeyHash = blake3_128(…)` and `12` §11.1 **persists it** on every suppression as `anchor_nk`.
`17` §16.2's `fsck --repair` then makes the persisted key load-bearing in a third document. `14`
defers correctly (*"identity tuples — already in the IR schema — 0 lines of code"*); `12` re-derived.

There is also a **behavioural** contradiction that ships silently: on a rename with a matching tier-2
tuple, `11` §10.4 auto-matches and preserves the ULID; `12` §11.4 refuses to bind without confirmation
(*"never a silent re-bind"*). `11` §10.6 then claims suppressions survive a rename, which is only true
under `11`'s behaviour.

**Resolution — DECIDED.** `11` owns re-identification. Delete `12` §11.4's parallel scheme and its
per-kind table; replace with `NaturalKeyHash` computed over `11` §10.3's tier-1 tuple plus a deferral.
Amend `11` §10.3 to *"never persisted as a graph reference; the tier-1 tuple's hash may be persisted
as a **recovery** key by `12` §11.4, and by nothing else"*. On the behaviour: **`12`'s "never a silent
re-bind" wins**, because `11` §10.4's own justification agrees with it (*"a wrong match silently
rewrites the history of an object that is not the one you are looking at"*) — so `11` §10.4 step 3's
`if t > 1` branch produces a *candidate*, not a binding, and `11` §10.6's suppression row reads "yes,
after confirmation". Register the invariant-7 clarification in `12` §18 (see R17).

---

### R26 — `72` instructs a re-cut of `71`; `71` was not re-cut

**Severity** Major · **Raised by** `84` §8, and corroborated by `83` §12
**Documents** `71` §2, §8.6, §9.6, §13.2, §16; `72` §4.4

**Finding.** `72` §4.4 concludes that the v2 target of three platforms × three domains *"is not a
plan, it is an aspiration, and it should be re-cut before phase 1 rather than discovered in phase 7."*
`71` still sequences seven phases past rung 3 with the same targets, and neither document's
`Disagreements` section mentions the other. **The plan of record is one the project has already
disproved, in the same directory.**

`83` §12 arrives independently from the estimate side and reaches the same place: phase 5 as specified
(envelope, keyholder table, hash-chained member log with Ed25519 quorum, epoch rotation, conformance
runner, container, merge driver, hand-rolled CRDT, offline-first, compaction, OPAQUE, D2/D3) is
**48–69 weeks against `71`'s 16–24**, and phase 6 is 30–45 against 14–22. Corpus-track totals add
20–30 person-weeks of expert domain time on the critical path. Honest totals: **170–240 weeks solo**,
**85–120 for a team of three**.

**Adjudication.** `83` and `84` agree on the direction and differ on the instrument. `84` proposes
named cuts (§9: AI tiers 6b–6e, the diagram, multi-writer sync — ~40–60 weeks, none of it corpus);
`83` §12.6 proposes an exit (ship phases 0–3, defer 5 and 6). They are the same programme viewed from
two ends and both land on the same product: **the finder, the graph, one platform, the walkthrough,
paste, inventory, findings, diff, verify and rollback, with a single-keyholder passphrase-sealed file
— 58–84 weeks solo, which is `71` §2's own third coherent exit.** This register adopts that as the
recommended plan of record.

**Resolution — DECIDED as a documentation defect; the scope decision itself is the owner's.**
`71` gains a corpus column in §2's headline table (currently the number everybody quotes omits the
largest line item), re-estimates phases 5 and 6 against `83` §12's enumeration, and **names the
phases 0–3 exit as a product** rather than as a kill point. `72` gains §4.10 *"who pays for the
corpus"* with `84` §2.3's three named candidates, and a §2 register row for *"the project has no
funding shape"* at Near-certain / Fatal. Whether to take the cuts is a decision for the owner and
this register does not take it; what is not optional is that `71` stop contradicting `72`.

---

### R27 — The post-quantum row inside the "what we do NOT claim" table is itself an overclaim

**Severity** Major · **Raised by** `81` §3.6 / O2 · **Documents** `31` §10.1, contradicted by `32` §10.7

**Finding.** `31` §10.1 claims *"workspace encryption is symmetric and not broken by a quantum
adversary in the way public-key transport is."* True of the single-user passphrase path; **false of
every shared workspace**, where `RK_e` is wrapped to each member under HPKE `DHKEM(X25519, …)`. `32`
§10.7 states this correctly and calls it *"the exposure"*. The location is what makes it serious: it
is inside the table whose entire stated purpose is *"written to be quoted back"*.

**Resolution — DECIDED.** The row becomes: *"Single-user workspace encryption is symmetric throughout.
A **shared** workspace wraps the root key under X25519 and is harvest-now-decrypt-later exposed until
suite `0x02` ships."*

---

### R28 — The headline offline-cracking table is computed at a configuration that will not ship

**Severity** Major · **Raised by** `81` §3.3 / O4 · **Documents** `32` §4.6, `36` Q5; `44` §4.8.4

**Finding.** `32` §4.6's table — the one an enterprise reviewer reads and `36` Q5 leans on — is
computed at `CAP` (256 MiB, t=4). `44` §4.8.4 proposes, with an argument this register agrees with,
that the default becomes `DeviceFloor::AnyDevice`, pinning `m` at `FLOOR` (64 MiB, t=3) for every
workspace that does not opt out. `32` §4.6 handles this in one sentence after the table (*"multiply
every time by about 0.19"*) and never restates it. The numbers a reviewer will quote back are 5.3×
(≈2.4 bits) too favourable for the shipping default: a ~30-bit memorable sentence against 10⁶ GPUs
is **≈1.7 minutes**, not 9; a ~40-bit human-chosen passphrase is **≈27 hours**, not 6 days.

This is not a design error — `44`'s trade is right, and its second argument (*"a four-second unlock is
not a neutral security property"*) is correct and under-appreciated. It is a presentation overclaim in
the document a reviewer reads, and it is the kind that ends a meeting when found.

**Resolution — DECIDED.** `32` §4.6 prints both configurations, **floor first**, because that is the
default. `31` §5.1 row 19's residual is `material` either way, so nothing else changes. Land `44`'s
`DeviceFloor` proposal in `32` §4.2 at the same time (R17's ownership rule).

---

### R29 — `img-src 'self'` in modes C/D is an egress channel to the origin the threat model calls untrusted

**Severity** Major · **Raised by** `81` §7.1 / O7 · **Documents** `34` §2.4, §2.7, §11

**Finding.** Modes C and D set `img-src 'self' data:` and `connect-src 'self'`. In those modes `'self'`
**is the sync service** — the component `31` §4.1's diagram labels `SYNC SERVICE — UNTRUSTED BY
DESIGN`. After an XSS in mode C (in scope: `31` §5.1 row 16, `31` §8.1 A2.5) the payload needs no
`sandbox`, no navigation and no third-party origin: `new Image().src = '/' + btoa(plaintextGraph)`
is permitted by `img-src 'self'`, and the plaintext lands in the sync service's HTTP access log in
the clear. `34` §2.7 makes exactly this argument about `img-src` and then reasons only about *foreign*
hosts; `34` §2.4's *"the step from `'none'` to `'self'` is not a weakening of the confidentiality
claim"* is false in this case, because the origin on the other end is adversarial in this threat model
in a way `'self'` normally is not.

**Resolution — DECIDED.** `fathom serve` and the mode C/D server return `404` for any path not in the
built asset manifest (`34` §3.6 already specifies this for mode B — extend it) and **must not log
request paths for non-manifest paths**. Then state the residual: it is `material` and it is currently
absent from `34` §11.

**Related, DECIDED:** run `34` §2.11's four-part `sandbox` VERIFY. It is one afternoon, three
documents' residual tags depend on it, `34` §3.3's artifact split and `36` Q40's answer to an
air-gapped customer both rest on it, and nobody has named the sub-risk that `sandbox` without
`allow-popups` plausibly blocks `showSaveFilePicker` — which is `32` §13.1's only good save path.

---

### R30 — `ask_human` is the boundary leak

**Severity** Major · **Raised by** `85` F3, §5.1, §6.1
**Documents** `21` §2.2, §6.3; `23` §§3.4, 4, 5.3

**Finding.** `AskHumanIn` carries up to **760 characters** of model-authored prose rendered to the
user (200 question + 160 `because` + 5×80 choices), against an `emit_answer.note` channel the design
bounds at 400 and surrounds with three controls. `ask_human` is exempt from all of them: no citation
obligation, no paraphrase detector, no command-shape detector, no IL-1 warning, no `Basis` marking.
And the round trip is worse than the outbound leg: the human's answer enters as a **trusted** turn,
grounds the proposal, and `21` §2.5.1 records `asserted_by: Actor::User(uid), confidence: Asserted`.
A model-framed question has been laundered into a human-asserted graph value and the provenance chain
records only that a human decided.

**The payload this enables** (`85` §6.1, and it is not in `23` §2.3's vector×goal matrix): a
`description` field in an attacker-supplied config that asserts a peer capability limit, read by
`constraint.negotiator` (which holds both `GRAPH_READ` and `ASK_HUMAN`), re-emitted as a leading
closed-choice question. The user clicks "Yes, proceed" and the click becomes
`Basis::SanctionedException { rule: ipsec.pfs.absent }` — a human-authored, human-signed, permanently
recorded waiver of a `high` security finding, with a citation that verifies. Every gate passes. The
prize is better for the attacker than a wrong config line, because the human did read it and agreed.

**Resolution — DECIDED.** All four of `85` §5.1's changes: `because` becomes a `CorpusRef`, not prose
(this alone kills the payload, because no authored entry asserts what a given peer's appliance can
do); `question` and `choices` go through the command-shape and paraphrase detectors, both of which
exist and are deterministic; `21` §2.2 gains an **Ask** row stating that the question is logged with
the session and rendered in the audit view next to the value it produced; `allow_free_text` defaults
to `false`, and a free-text answer marks every dependent op `Basis::Judgement`, pre-unchecked. Add
the missing V1×G5 row to `23` §2.3.

---

### R31 — `gate.check` turns every deterministic gate into a hill-climbable objective

**Severity** Major · **Raised by** `85` F6, §4.2, §5.2 · **Documents** `22` §2.3, §4.4, §4.5, §7.8

**Finding.** S2-A holds `GATE_CHECK` *"so it can run G5 on its own candidate before proposing it, and
iterate"*, and `22` §2.3 celebrates the convergence. But G5's stated residual is **semantic** — *"a
semantically wrong capture that renders identically… is not caught"*. A search whose objective
function is G5 produces `{bindings G5 accepts}` = `{correct bindings} ∪ {G5's blind spot}`. Under
guessing the blind spot is a rare tail; under search it is the **attractor**. `22` §7.8 sees this
exact dynamic for the build-time rule author (*"the loop optimises the tests"*) and installs a
mechanical backstop; no equivalent exists for G5, G6 or G10 at runtime, and all three are held by
subagents that also hold `GATE_CHECK`. `23` §3.4's defence 3 (*"none of them can be argued with,
because none of them is a model"*) is correct and beside the point: you do not argue with a gate you
can query, you hill-climb it.

**Resolution — DECIDED.** Do not grant `GATE_CHECK` on a gate whose stated residual is semantic — let
the broker run G5 once on the emitted proposal and return `hard`/`soft`, which `21` §6.3's
`ProposeMutationOut` already does. Iteration against a semantic gate must cost a proposal, not a free
probe. Add `gate_probes: u8` to `AiBudget` (default 6) and report probes-per-accepted-claim in the
eval and in `SubagentVerdict` — a subagent whose claims each cost four probes is searching for the
blind spot, and that is a number a reviewer can read. Add the eval item family *"candidates that
required ≥3 `gate.check` calls before passing"*, reported separately.

---

### R32 — The pre-flight's own copy is false

**Severity** Major · **Raised by** `85` F7 · **Documents** `21` §8.2, §8.3, §4.5; `22` §1.3

**Finding.** `THIS IS THE EXACT REQUEST BODY. NOTHING ELSE WILL BE SENT.` is shown above a 4,812-byte
first turn, with `[ Send once ]` beneath it. `EgressEnvelope` carries `turns: Vec<Turn>` and the
session budget is 12 model calls / 262,144 bytes, each request a superset of the last. The session's
actual egress is bounded at **54× what the user was shown**, and every byte of the growth is content
the user did not see at consent time. This is the one place where the corpus's otherwise excellent
honesty discipline fails, and it fails in the copy that goes in front of users.

**Resolution — DECIDED.** Replace with `85` §7.1's four lines: this request / this session (up to 12
requests, up to 262,144 bytes, each an extension of this one) / field classes. Make the running
session byte counter in the armed indicator the control that closes the loop. **Reconcile consent
toward `21`:** per-(workspace, purpose), 90-day cap, re-firing on payload-shape change. `22` §1.3's
per-invocation disclosure — up to eighty raw-JSON dumps per engineer per day — is not consent, it is
a rubber stamp with a keyboard shortcut, and it trains users to dismiss the *first* pre-flight, which
is the only one `21` §8.3 says has value. The per-invocation surface becomes a **diff against the last
consented payload shape**, bytes one keystroke away.

---

### R33 — Six safety metrics, two of them build-blocking, cannot be collected

**Severity** Major · **Raised by** `85` F5, §8.1 · **Documents** `21` §3.4, §14, §15; `25` §8.1, §10.3

**Finding.** `21` §3.4 opens *"every metric here is computed without instrumenting the model, because
all of them are properties of the host's own logs."* The host is the **user's client**, and invariant
1 forbids telemetry at any tier. So `deterministic_answer_rate`, `paraphrase_rate` (gated **E**,
build fails above 0.15), `uncited_op_rate`, `accept/amend/reject_rate`, `shadow_rule_rate` (gated
**E**, build fails above 0) and `blind_accept_rate` (**K4, immediate kill** above 0.30) are all
uncollectable. `25` §8.1 row 20 half-notices for one of the six.

**`blind_accept_rate` is the load-bearing safety argument of the entire layer** — `21` §14 says it
*"predicts whether this product harms anyone"* — and it can never fire.

**Resolution — DECIDED.** `21` §3.4 gains a `Collectable where?` column with three honest values
(`eval harness (fixtures)`, `local only — user-visible, never transmitted`, `not collectable`).
`paraphrase_rate` and `shadow_rule_rate` are measurable in the eval harness over fixtures and gate
there — they measure the *contract*, not the field, and that is fine as long as nobody claims
otherwise. **`blind_accept_rate` becomes a client-side control rather than a release gate:** the
client already computes it, so render it in the workspace's AI panel and have the *client* disarm the
layer above 0.30 with a one-line explanation and a re-arm button. That converts an uncollectable
release gate into an enforceable per-user one, needs no telemetry, and acts on the user actually at
risk. Rewrite `25` §10.3 K4 against the local disarm.

**Also DECIDED, same document:** the two `Unsafe` suites (S2-A, S6) carry 0.5% harm ceilings on sets
of 400 and 120 where `25` §3.2's own statistics require n ≥ 600. `25` §13.2's worked report ships S6
as **PASS** with a printed note that the gate was under-powered. A gate reported as under-powered is a
gate that did not fire, and a green report is worse than no gate. Either grow the sets (TS-3a can,
cheaply) or restate the ceilings at what the set can demonstrate and print `PASS AT REDUCED POWER`.
And `85` §8.3/§8.4 are adopted: delete `21` §14's *agreement*-threshold kill test for
`symptom.correlator` (it cuts the correlator for being redundant and keeps it for being *different*)
and point at `25` §6.3's correctness test; bound A1 (*"expressible as at most three rules over the
existing `fex` grammar within gate 7's 2,000-VM-step budget, without new builtins"*) and define
`wide()` in A4, without which neither criterion can be applied.

---

### R34 — `schema.yaml` — six documents make load-bearing demands on a file no document owns

**Severity** Major · **Raised by** `83` M1 · **Documents** `11` §11.6, `12`, `14`, `63` §5.3, `43` §1.3

**Finding.** `11` §11.6 states the position (*"the schema is data"*) and does not specify the file.
`12` depends on the schema declaring edge roles, reverse-indexing, enum neutral variant names,
per-field case-insensitivity, per-kind similarity weights and identity tuples. `63` depends on the
platform enum map; `14` on the statement dictionary's binding to it; `43` makes it a build-time input.
Without it, `12`'s `fex` type checker, `14`'s reconciler and `63`'s pack lint cannot be built. `11`
§17's open decisions do not list it.

**Resolution — DECIDED.** Write it, as `docs/10-core/19-schema-format.md`, owned by `11`'s author, and
add it to the ownership register. Two adjacent holes go with it: **M3**, the statement dictionary's
content spec — 1 750 entries budgeted in `71` §5.7 with no format, no ids and no review discipline,
which is the same failure on the largest content asset after the explainers; and **M2**, the missing
`62-*.md` in `60-content/` — either move `15`'s format sections there or renumber, because a gap
that looks like a lost document will get a duplicate written into it.

---

### R35 — The card's two-column grid cannot render at the width derived for it

**Severity** Major · **Raised by** `86` D-29 · **Documents** `51` §7.8, §8; `54` §18; `52` §2.3, §2.4

**Finding.** `51` §7.8 derives `--sheet: 1180px` from the requirement that a two-column grid hold 73
mono columns. `54` §18 gives the inspector a fixed 420px column at a 32px gutter inside the same
sheet, with 48px of sheet padding: `1180 − 48 − 420 − 32 = 680px`, which is below `--bp-cols: 860px`.
**At the canonical sheet width with the inspector open, the two-column grid never renders.** Worse in
combination: `52` §2.3 adds a *pinned second pane* as a separate mechanism and argues against three
panes because 400px *"is below the card's own column width and the type stops working"* — with the
inspector present a pinned split gives 340px per pane, and `52` never mentions the inspector in 1,639
lines.

**Resolution — DECIDED.** The inspector and the pinned pane are **the same surface**; there is one
second column. `52` §2.3's 62/38 applied to 1132px of content gives 702/430, which is `54` §18's 420px
to within a rounding step — the two documents already agree and nobody noticed. The card's two-column
grid is a property of a single view's **body**, not of the sheet, and requires the second surface
closed; say so. Re-derive `--sheet` honestly: `1050px` for the working layout, `1180px` for the
reading layout, or keep 1180 and state the constraint. The current derivation is a coincidence
presented as a consequence.

---

### R36 — The furniture above the body is roughly twice what both documents claim

**Severity** Major · **Raised by** `86` D-30 · **Documents** `52` §2.2; `54` §3

**Finding.** `52` §2.2 says everything above the body is *"about 150px"*; `54` §3 says the masthead
alone is *"~110px"*. Summed from `54`'s own CSS: masthead **140**, legend 50, rail 60, ribbon 29 =
**≈279px**, rising to ≈311 below 1100px and ≈343 with the egress strip armed. On the 1280×800 laptop
`52` §2.1 uses to argue against a left rail, that is **35% of the viewport, permanently, before any
content** — and the left-rail rejection rests on the comparison the sheet loses once the real number
is used. `52` §11 failure 4 predicts *"header creeps to 300px"* as a future risk; it is the shipping
specification.

**Resolution — DECIDED.** Take `86`'s three cuts: merge the ribbon into the masthead subtitle (they
are the same fact at two heights, −29px); delete the eyebrow, because `VIEW 3 OF 6 · FINDINGS` and a
view band whose current tab is `▸findings · 3 high` are redundant (−20px); tighten the legend to the
card's own leading (−20px). That is 210px — still large, honest and defensible — **and it must be
stated as 210, not 150.**

---

### R37 — WCAG "AA in full" is claimed against a documented Level AA failure

**Severity** Major · **Raised by** `86` D-37 · **Documents** `55` §1.1, §5.3; `54` §12, §22, §26

**Finding.** `55` §1.1 claims the product targets WCAG 2.2 Level AA *"in full"* plus five AAA
criteria including 2.4.13 Focus Appearance. `54` §12 removes the focus indicator from the finder input
(`#q:focus-visible { outline: none }`) on the grounds that *"the shell IS the focus indicator here"* —
but the shell's border is present whenever the dialog is open regardless of focus, and `54` §12's own
keyboard table has `Tab` cycling out of the input and back. Nothing on screen changes when the input
gains or loses focus except the caret, and a caret is not a component focus indicator. **That is a
failure of SC 2.4.7 Focus Visible (Level AA)**, not merely of 2.4.13. Second, `54` §12's footer
contains two `<span class="tab">` elements and `54` §4 states categorically that *"a tab is never
focusable and never a link"* — so the footer links the Tab cycle depends on do not exist.

**Consequence.** The AA-in-full sentence is what a procurement questionnaire or a VPAT will quote, and
it is false in the product's most-used surface, by the design set's own record.

**Resolution — DECIDED.** Give the input a real indicator by inverting the input row
(`#q:focus-visible { background: var(--surface) }` plus a 2px `--ink` bottom rule on the input row) —
the card's own vocabulary, and it avoids the double-draw `54` §26 worries about. Make the footer spans
real `<button>`s or stop claiming the cycle. Change `55` §1.1 to *"targets AA in full; one known
exception is tracked at `54` §26 and blocks the claim until closed."* An accessibility document whose
value is honesty cannot carry one optimistic sentence at the top.

---

### R38 · R39 · R48 · R49 — The design set kept the card's vocabulary and lost its grammar

**Severity** Major (four entries, one cause) · **Raised by** `86` D-6, D-5, D-1, D-2/D-2a

| ID | Finding | Resolution |
|---|---|---|
| **R38** | **Density.** `--row-min: 24px` against a 20px line grid inflates a 40-line config block by 160px — the default ships at **83% of the card's density**, with a settings toggle to get it back, and both `51` §8 and `55` §6.1 present it as a small trade. It is the largest single deviation from the owner's stated requirement in the whole design set. | **DECIDED — take `86`'s option 2.** `51` §8 already states the rule (*"padding goes on the interactive element, never on the row"*) and `54` §8.4 contradicts it by putting `min-height` on `.cfg-line`. Implement `51` §8's own sentence: 20px visual row, 24px target via negative-margin padding. Two lines of CSS, full SC 2.5.8 conformance, and the density is recovered for every user who never opens settings. |
| **R39** | **Continuation backslashes**, design-language device 5, are **off by default**: `54` §8.2 makes `Display` (soft wrap, hanging indent, no backslash) the default and `Terminal` an opt-in, while `53` §6.3.1 says the display preserves them and cites `54` for authority. `51` §2 spent a page measuring the card's wrap behaviour and deriving the entire 1180px sheet from it, then shipped the wrap it measured as an option. | **DECIDED — `Terminal` is the default**; `Display` becomes the narrow-viewport accessibility affordance `55` §6.3 already specifies. The screen-reader concern is solved identically either way by `54` §8.2 rule 3 (`aria-hidden` span, unwrapped accessible name), so the default is a free choice and the card decides it. |
| **R48** | **The margin tab has been industrialised.** The card has ten across four sides; a single Fathom inspector view carries more than that alone — confidence, four suppression states, provenance class and age, per-field provenance (5–30 of them), `DeltaClass` per diff row, `unsupported`, six view-band tabs, `overridden`, `blocked · needs #5`, `wrapped to fit`, three diagram tabs. `54` §4's own authoring rules ("one to four words", "says how to weight, not what it is") are violated by `54` §18's and §14's own worked examples. | **DECIDED — budget it.** At most three margin tabs per screen region, and a tab may only weight a **section**, never annotate a **row**. Row-level metadata moves into the two-column hairline table, which is the card's actual device for per-row facts and which `54` §9 already specifies correctly. |
| **R49** | **Channel overload.** The 4px left bar means note, severity, config block edge, selection, AI-proposed and diagram zone stub — **six meanings**, where `51` §1 R3 says one channel one owner and `51` §4.2 forbids the selection use *by name*. `54` §22's audit records **two** exceptions and misses at least four. Inside a config block, `▸` means hover, expanded and selected, and `--surface` is both the default ground and the selected ground, so selection degrades to glyph-only — the exact failure `51` §4.6 rules out, on a 200-line block where `53` §6.3 makes copy the product's primary output. | **DECIDED.** Selection is `▸` plus ground, as `51` §4.2 already decided; `52` §5.2 and `54` §12 change. Move the block's default ground to `--page` so selected rows can take `--surface`. Re-run `54` §22's audit honestly and delete the "two audited exceptions" framing — it will find more. Add the CI check `51` §3.3 already has the pattern for. |

---

### R40 — The workspace creation flow does not exist, and four documents need it

**Severity** Major · **Raised by** `83` M4 · **Documents** `52` (absent); `32` §6.2, `17` §10.1,
`44` §4.8.4, `43` §1.3

**Finding.** Four documents each make an **irreversible creation-time** decision and each says, in its
own words, that it is a creation-time question with the trade stated rather than a setting buried in
preferences: `S` (the shard count), `opaque_frames`, `DeviceFloor`, the AI tier ceiling. Nobody
specifies the screen. Four irreversible questions, argued in four documents, presented to a user who
has just decided to try the tool. `52-information-architecture.md` does not have a creation flow.

**Resolution — DECIDED.** Write it into `52`, after R01 and R13 close (two of the four questions
change shape depending on their outcome). Note that R16's decision — `opaque_frames` on by default for
multi-member workspaces — removes one of the four from the screen, which is the right direction: a
creation flow with four irreversible questions is a creation flow nobody completes honestly.

---

### R41 — The migration runner has no owner

**Severity** Major · **Raised by** `83` M5 · **Documents** `11` §11.3, §10.5; `32` §7.3; `17` §13.5

**Finding.** `11` §11.3 defines what each version bump means; `32` §7.3 defines suite migration and
re-sealing on write; `17` §13.5 mentions a schema migration rewriting every record. No document
specifies who executes a migration, whether it is online or offline, what happens if it fails halfway
through an encrypted document with no undo (`11` §10.5: *"there is no undo across an encrypted-document
save"*), or how it is tested. **The riskiest operation in the product — rewriting the user's only
copy — has no owner.**

**Status — DEFERRED**, and named as deferred rather than left silent. It cannot be specified before
R01 closes, because the two formats give different migration shapes (rewrite-all versus append-a-frame).
Add it to the ownership register now, with the owner named and the document unwritten, so it is a
scheduled gap rather than an assumption.

---

### R42 · R43 · R44 · R45 · R46 · R47 — Remaining majors, in brief

| ID | Finding | Raised by | Resolution | Status |
|---|---|---|---|---|
| **R42** | **Deferred AEAD verification contradicts the manifest contract.** `44` §4.8.3 move 5 verifies "one BLAKE3 over the digest list", which proves the *list* is intact and not that the *records* match their digests. `32` §8.1 requires the latter at open, so a store that drops or substitutes a record fails closed; under move 5 a substituted `Nodes` shard is discovered mid-session, possibly never. `44`'s defence (*"`open_record()` verifies unconditionally"*) is true and does not address `MissingRecord`/`ExtraRecord`, which are the point of §8.1. | `81` §3.5 / O14 | Eagerly verify the **record digests** — a BLAKE3 over each envelope's bytes, cheap, keyless, parallelisable, ~1 GB/s — and defer only Poly1305. Preserves §8.1's guarantee at essentially move 5's cost. | DECIDED |
| **R43** | **Redaction recall is < 1.0; the ingest report reads as a completeness claim.** `14` §9.9 is the correct answer to the question and gets there by refusing the marketing answer first (*"redaction is not a confidentiality control… it is a retention control"*), and the enforcement is structural rather than procedural — the `secret:` dictionary flag *is* the redaction catalogue, one list not two. But `14` §9.10 tags *"redaction bypassed by an uncatalogued statement"* as **partly** mitigated while `14` §9.8's report says *"Nothing above is in this workspace"*, which is true of what it lists and reads as a claim about what it did not. Separately, four of five PAN-OS catalogue rows are written from familiarity and carry `VERIFY`. | `81` §6 | Add one muted line to the report: `we catch what we know and what looks like a secret. we do not catch everything.` The PAN-OS rows are correctly marked and **must not ship marked** — close them on hardware or remove the platform from the claim. | DECIDED |
| **R44** | **The corpus breaches invariant 10 today.** Every entry carries `reviewed_by: <named reviewer>` as a placeholder — 37 rules, 91 commands, 41 explainers — and there are **no fixtures**, which `63` §15 requires (at least one `must_fire` and one `must_pass` per rule). The rule pack's own header declares both honestly. | `83` P12 | Honest as declared, and it must be tracked as a **release blocker in `71`**, not only as a comment in a YAML header. It is the gate that `35` §9.3 and `12` §15.3 both enforce, and R05 is the concrete cost of having no fixtures. | DECIDED |
| **R45** | **The severity-budget escape does not work.** The rule pack proposes exempting `category: correctness` from `63` §19 V25's 15% `high` budget and states the result as *"2 high out of 23 non-correctness rules — 9%"*. Counted from the file by this register: **37 rules; 12 correctness of which 9 are high; 25 non-correctness; 4 high non-correctness = 16%.** The exemption does not bring the bundle inside the budget. The argument in G1 is sound; the arithmetic offered to close it is wrong by roughly a factor of two and lands on the wrong side of the gate. | `82` §10, `83` P11/P13 | Recount and restate. Then either demote one of the four — `ipsec.pfs.group-mismatch` is the natural candidate, because its `high` rests on the incorrect claim R07 corrects — or argue the budget change on its merits rather than on a number. Raise the exemption as a **proposed amendment in `63`**, not as a comment in a data file that CI will reject. | DECIDED |
| **R46** | **Unsourced commit-time SA behaviour, asserted as fact.** *"The tunnel drops at the current SA's lifetime rather than immediately"* and *"rather than at commit"* appear on several entries, cited to nothing — every `sources:` list cites only the card, and the card says nothing about commit-time SA behaviour. Conventions: *"never fabricate a vendor behaviour."* `18` §7.3 handles the identical question correctly with a `VERIFY` and a ladder that is right either way. This is the single sentence that decides whether an engineer schedules a change window. | `82` §9 | Replace every instance with the `VERIFY` form until a reviewer with an SRX records the answer **per train**, and consolidate the claim into one explainer (`explain:concept:junos.commit-and-sa-lifecycle`) that all of them reference, so it is corrected once. | DECIDED |
| **R47** | **The IR cannot express a committable chassis cluster**, and every worked example in the corpus is one. `set chassis cluster reth-count N` must exist before any `reth` interface commits, and neither `Device.reth_count` nor `Device.aggregate_device_count` is in `11` §6.3's field table — the latter is *referenced* by §6.4 and never defined. `Device.hostname` is cardinality 1 where a cluster carries two under `groups nodeN`; `Chassis` has no hostname and no management address, so a parsed cluster loses both node names and both fxp0 addresses. `fab0`/`fab1` have no kind, no field and no edge. `13` §8.3(a)'s canonical emit — reproduced in `32`, `34` and `54` — therefore does not commit on the platform it targets, and separately contains none of the five plumbing pieces. | `82` §15, §16 | Add `Device.aggregate_device_count` and `Device.reth_count` with `Emit: R*`; add a `Fabric` variant to `Interface.form` plus a `MemberOfFabric` edge; move `hostname`/`management_address` to `Chassis` with `Device.hostname` as the cluster-wide name; record `apply-groups` non-expansion as a stated **emit blocker** for clustered devices, not only a parse limitation. Until then `43` and `56` stop using a cluster as the worked example. Give `13` §8.3(a) the plumbing block or the block table's rank 40–44 entries are decorative. | DECIDED |

---

## 3. Minors

Each is a single checkable defect. All DECIDED unless noted.

| ID | Finding | Raised by | Fix |
|---|---|---|---|
| M01 | `34` §1.4 cites `23`'s exfiltration catalogue as **C1–C9**; `23` §6.1 defines **C1–C6**. Verified. A reviewer who follows the reference finds three missing channels and reasonably assumes they were removed for being awkward. | `81` §5.1.3 | Correct to C1–C6 |
| M02 | `23` §6.1's C3 mitigation cell reads *"CSP `connect-src`/`form-action` + link discipline"*. A link click is a top-level navigation, which `34` §2.11 and §9.4 both state is not covered by any CSP fetch directive. Listing `connect-src` teaches an implementer that loosening the anchor rule is safe. | `81` §5.1.2 / O6 | Delete `connect-src` and `form-action` from C3. The control is *"the application renders no clickable external link, in any surface, ever"*, and nothing else |
| M03 | `31` §3.2's actor×asset matrix omits **A4**, **A7** and **A12** — three of thirteen actors, including the one §3.1 calls *"A8's leverage with A1's legitimacy"* — and the prose beneath reads *"Four actors have a full row of `◆`"* while the printed table has **five** (A5, A8, A9, A10, A11). Both verified. The sentence excludes the supply-chain actor from the conclusion the table supports, which is the opposite of §8.4's own finding. | `81` §4.4 / O15 | Add the three rows; correct the count to five |
| M04 | `31` §6.7 files traffic analysis at the sync server under **out of scope** and then mitigates it properly in §7. It is in scope with a residual. §6 is the table a reviewer skims for "what have they given up on"; a mitigated channel filed there teaches them to discount §6's other rows. | `81` §4.1 | Move to §5.1 as row 20, residual `material`, verification *"watch your own server's logs"*. §6 contains only `total` residuals |
| M05 | `31` §5.1 and `31` §11 disagree on two residual tags: update rollback/freeze (`material` vs R12 `bounded`) and the single-file build's missing `frame-ancestors` (`material` vs R11 `bounded`). R12 additionally says *"if the expiring version manifest ships this drops to `bounded`"* while already tagged `bounded`, so the revisit trigger is a no-op. | `81` §4.3 / O16 | Reconcile to §5.1's values |
| M06 | `32` §7.4's `KeyholderDescriptor.label` is cleartext in every copy of the workspace — *"Kate's laptop"*, *"printed code in the safe"* — because it is the `aad_ext` and must be readable before any key exists. `32` §6.5's leak table lists *"the keyholder count"* and stops; `31` §7.2 has no channel for it; `17` §3's *"nothing in that tree names a device, a site, a customer, a peer, a VPN or a zone"* is true as written and does not say *nothing names a person*. It is personal data, in the clear, at the processor. | `81` §2.2.2 / O9 | Move `label` inside the sealed `KeyholderSecret`; keep only the opaque `id` and `kind` in the descriptor. The UI renders labels after the first unlock and `id` before it. Costs one round of trial decryption in the multi-passphrase case, which §7.4 already accepts |
| M07 | `32` §6.4's `padme(112 + 4 + body.len() + 16)` omits `aad_ext_len`, and §7.1's envelope is `header(112) ‖ aad_ext(aad_ext_len) ‖ ciphertext`. Verified. For every keyholder envelope `aad_ext_len > 0`, so the total length is not a Padmé bucket — and `32` §18 and `31` §12 both assert it is. Both CI checks fail on day one and an implementer will "fix" it by weakening the assertion. Second-order: the envelope length leaks the label length, which combines badly with M06. | `81` §3.2 / O12 | `padme(112 + aad_ext_len + 4 + body.len() + 16)`, and pad the CBOR descriptor to a fixed width per `KeyholderKind` |
| M08 | `32` §11.1's recovery code bypasses the KDF and is **re-wrapped at every epoch bump** (§9.3 step 3), so removing a member re-arms the printed paper against the *new* epoch. A departed admin who photographed the safe's contents retains access across the revocation performed because they left. §11.1's footgun table names the passphrase-change case and not this one. | `81` §3.7a | Add the row, and require an explicit re-print-or-revoke step in the removal flow |
| M09 | `32` §12.2's AND mode requires a printed recovery code only in prose. `32` §17.4's own thesis is that unenforced sequencing rules are where the bugs are. | `81` §3.7b | Make it a constructor precondition |
| M10 | `17` §5.8 compresses `DeviceGraph` records, which contain strings parsed from an attacker-supplied capture alongside the user's own values. `32` §6.3's RULE — *"never a record that mixes attacker-supplied text with anything else"* — is written about captures and applies verbatim. `17` §5.8 reasons only about `Settings`/`Suppressions`. | `81` §3.7c | Apply the rule, or state the compression-oracle residual |
| M11 | `32` §5.4 case 5 (CSPRNG replay) is correctly identified as the real nonce risk with correctly-described insufficient mitigations. Under `17`'s 24-byte random nonce the same case applies with the same severity and `17` §5.2 does not mention it — it argues only against counters. | `81` §3.7d | Add the case to `17` §5.2, or it disappears with R01 |
| M12 | `44` §5.2 hedges a size row against CEL being adopted as an embedded interpreter. `12` §3.3 **decided** against CEL by name and `63` builds its whole spec on `fex`. A hedge against a closed decision reads to an implementer as the decision being open. | `83` P3 | Delete the hedge |
| M13 | `32` D14 specifies OPFS as a working cache; `43` §3.5 decides D1 uses **no browser storage of any kind** and `73` D07 records *"Browser storage: None, by decision"*. `43` §3.12 prices the resulting total loss of crash recovery — a cost `32` never sees. | `83` P7 | Delete the OPFS branch from `32` D14, or re-open D07 |
| M14 | `33` §3.4 states that full key management *"belongs to a document in `30-security/` that has not been written"*. `32-cryptography.md` is that document, in that directory, and it is 2 129 lines. `33` then specifies its own key hierarchy (`K_name`, `K_capture`, `K_admin`, no epochs), which `17` §6.3 inherits. | `83` P10 | Replace with a deferral to `32` §3 once R01 closes |
| M15 | `22` §19 D1 proposes a schema change to `11` §8.2 that `11` **already ships** — `Actor::Supervisor { session, subagent }` at line 1376 and `ProvenanceRecord::supersedes` at line 1326, with §8's open decision 8 asking and answering the same question. `21` §2.5.1 gets this right and says so. | `85` F11 | Delete `22` D1; point `22` §4.9 row 6 at `11` §8.2 and `21` §2.5.1's two-record write. Two lines, and it removes a blocking open decision |
| M16 | `24` §3.7 **rejects** the deployment shape `21` §7.3/§7.5 specifies — a browser build reaching a loopback sidecar — on the correct ground that the Local Network Access prompt is one *"a security-conscious network engineer is correctly trained to deny"*, and picks a native shell instead. `24` §11 files two disagreements against `conventions.md` and none against `21`. Three documents now describe three different CSP surfaces for local inference (`21` §7.5, `24` §3.2, `34` §2.2, which has no loopback row at all). | `85` F12 | `24` is right and `21` is stale. Rewrite `21` §7.3 from `24` §§2–3; regenerate `21` §7.6; `24` §11 gains a third disagreement naming `21` §7.3. Carry `24` §3.8's sentence — *"the shape we chose for security reasons is the one the most security-constrained users cannot run"* — into `21` §7 and into `36` |
| M17 | `23` §4.2 specifies a 64-bit fence nonce and shows a 32-bit one (`nonce=7f3a9c2e`). A spec that contradicts its own example in a security control will be implemented from the example. Separately, the datamark `∎` (U+220E) is not in §4.4's normalisation ledger, so nothing strips a literal `∎` an attacker types into a `description` — which makes §4.2's *"unambiguously marks injected-region text"* false. | `85` §6.4 | Fix the example to 16 hex characters; add U+220E to the ledger, strip and count as for the others |
| M18 | `23`'s fence class tag marks a third-party rule pack's `remediation` prose `cls=corpus` — **explicitly elevated trust** — from a key the user chose to trust for *rule content*, not for *model instructions*. `23` §10 L6 concedes the pack-prose vector; the class tag compounds it. | `85` §6.3 | Split into `cls=corpus-first-party` (shipped in the build, content-hashed) and `cls=corpus-third-party` (handled at `cls=residue` trust). One enum variant |
| M19 | `report_gap.evidence` is `BoundedText<512>` of free text, *redacted* at the broker but not *grounded*. Gap tickets are exported, clustered at build time, and read by the human deciding what to author next — and `21` §14 makes that the AI layer's *"largest long-run value"*. An attacker who gets 200 configs in front of users can shape which explainers get written for two release cycles with content that is entirely truthful and merely mis-prioritised. | `85` §6.2 | `evidence: Vec<ByteSpan>` into the capture, plus a `GapKind`; cap gaps per capture at the number of residue clusters the parser already computed. Rank the authoring queue by the deterministic demand signal (miss log, `Unprovable` counts, coverage join) and let AI-derived signals break ties only, recording which signal ordered each ticket |
| M20 | `21` §4.5 justifies a 24-call tool budget from *"the observed shape of §13's scenario"*; §10.1 says the scenario uses 14; §13 as written makes **seven**. And `21` §14's summary says *"of eight runtime subagents…"* while §5.1 marks `gap.reporter` build-time-only, so there are seven, and the four counts sum to eight. | `85` F17, §9.5 | Recount both. The headline arithmetic of the document's most important section does not close |
| M21 | `24` §2.3 says the WASM runtime hosts *"exactly one class of job at ≤ 1 B parameters"* and §2.6's table says *"≤ ~3 B at Q4"*, four paragraphs apart. `21` §7.3/§7.6 and `24` §6.2 disagree on what ships enabled at tier 2a — *"poor"* versus **off**, and `24`'s argument (a gate that rejects most output produces a spinner, not a feature) is the better one. `22` §5.3 and `25` §6.3 use two different diagnostic-identifier schemes and `conventions.md` §Identifiers has an entry for neither. | `85` F16 | Reconcile to `24`; add a diagnostic-id row to `conventions.md` §Identifiers |
| M22 | Dead `supersedes`: `ipsec.traffic-selector.not-mirrored` declares `supersedes: [ipsec.traffic-selector.absent]`, and the two are mutually exclusive by construction — when zero selectors exist there is no `TrafficSelector` node to bind to, so `.not-mirrored` cannot fire and can never supersede anything. Passes V23 (the reference resolves) and never executes. The file caught its other dead reference and not this one. | `82` §11 | Re-anchor `.not-mirrored` to `IpsecVpn` with a discriminator on selector name — which also fixes M23 |
| M23 | `route.remote-prefix.no-next-hop-st0` — *is anything actually routed at `st0`?*, the most valuable plumbing check in the pack — is anchored on `TrafficSelector`. A route-based VPN with **no** traffic-selector is the commonest shape in the field (every SRX-to-VGW, SRX-to-Azure, most third-party tunnels), and `ipsec.traffic-selector.absent.acceptable_when` explicitly blesses it. Either the rule never binds, or it binds to an inferred any-to-any node and fires `high` on every correctly built selector-less VPN. | `82` §12 | Anchor on `IpsecVpn` with `bind_interface`; evaluate against the union of configured selectors' `remote_ip` and, where none exist, the static routes whose `NextHop::Interface` is the bind unit. The check is a property of the VPN, not of a selector |
| M24 | `policy.zone-pair.missing` tests only `(lan → vpn)` while its `explain.teaching` devotes a paragraph to the reverse (*"a tunnel that works for outbound sessions and drops inbound ones passes most tests"*). The rule teaches a failure it does not check. | `82` §13 | Split into `policy.zone-pair.missing` (neither direction) and `policy.zone-pair.one-directional` (`low`/`probable`, with the deliberately-outbound-only `acceptable_when`) |
| M25 | `ike.dpd.too-slow` folds two distinct states into one finding — DPD configured slowly, and `dead-peer-detection` **not configured at all** — under a title that says "more than 30 seconds". The Junos `interval 10` / `threshold 5` defaults are the defaults *of the statement*, not of the gateway. If DPD is simply not running, the SA persists until its lifetime: on the card's own recommended `lifetime-seconds 28800` that is eight hours of blackhole, not fifty seconds. The finding understates the worst case by three orders of magnitude under a title that sounds precise. | `82` §14 | Split into `ike.dpd.absent` (`high`) and `ike.dpd.too-slow` (`medium`). Mark *"is liveness implicitly on for IKEv2 on this train"* `<!-- VERIFY -->` and version-predicate both once it is answered |
| M26 | Four `acceptable_when` fields are not realistic: `zone.host-inbound.ike-missing`'s exception describes a peer behaviour you cannot configure on someone else's box (under IKEv2 either party may initiate a rekey, RFC 7296 §2.8, and liveness probes arrive inbound regardless); `ipsec.pfs.group-mismatch` and `ike.identity.mismatch` say *"never as a steady state"* and then describe a transient window, which a suppression UI will collect "coordinated change window" against; `ipsec.lifetime.kilobytes-unset-on-busy`'s exception covers *"most of them"* and is therefore unfalsifiable; `mtu.mss-clamp.absent`'s exception (raise the tunnel MTU to 1500) produces exactly the symptom the rule exists to catch, because the encapsulated packet is then ~1550 on the wire. | `82` §18 | Replace the first with *"acceptable only on a gateway being staged and not yet expected to negotiate"*; split the vocabulary `never` vs `transient_only`; give the third a concrete threshold; copy `mtu.st0.unset.acceptable_when`'s jumbo-underlay text into the fourth |
| M27 | Deployment shapes are lettered **A–E** by `34` and adopted by `44`, `35` and `21`, while `43` §1.1 pins **D1–D4** and recommends retiring the letters, noting a reader cannot tell "mode B" from "D2". Two live namings, and `44`'s "modes B–D" means something different from `43`'s "D2–D4". | `83` P8 | Adopt `D1`–`D4` corpus-wide or reject `43` §1.1 explicitly. Do not leave both |
| M28 | `51`'s dark theme redefines the three pinned risk colours (`--safe: #35A06E`, `--caution: #D97328`, `--danger: #EA6260`). The work is done properly — the substitutions are hue-matched and the contrast is solved — but it is a silent redefinition of a constant `conventions.md` pins by hex and `design-language.md` calls *"ground truth, machine-extracted"*. | `83` P14 | Register it under `51`'s `## Disagreements` with the proposed amendment: *"the three pairs are pinned for the light theme; a dark theme substitutes hue-matched pairs at equal or better contrast, listed here"* |
| M29 | `.pill` is the badge `51` §4.5 rejected by name (*"every time this system is tempted toward a badge, the answer is a margin tab"*), reintroduced in `54` §12 on every finder result, and `.pill.caution` computes at **4.73:1** — 0.02 from the value `54` §6 declares impermissible at that size and 0.23 from the AA floor. | `86` D-8 | Delete `.pill`. The risk word goes at the end of the command line in semantic ink at `--t-tab` on `--page` — 5.19:1 for caution — with no fill and no box, which is what the card does |
| M30 | `dashed` is claimed exclusive to AI (`51` §9: *"nothing produced by the deterministic pipeline is ever drawn with a dashed rule"*) and `51` §4.8, five sections earlier, assigns dashed to `unanswered, required`. `54` §2.4 then implements it a third way, dotted. Three statements, three answers, on the signal that tells a user which parts of a firewall configuration a model wrote. | `86` D-13 | `51` §4.8's row becomes dotted, matching `--rule-style-pending` and `54` §2.4. Add the CI check: `dashed` may appear only in selectors matching `.prop*`, `.dg-proposed` |
| M31 | Four "no icons" claims (`55` §1.4, `52` §9.5, `56` §5.1) against a 12px `✓` checkbox (which also fails SC 2.5.8 and is unlisted in `55` §6.5's target walk-through), `▲`, `▴`/`▾` and `↳`. The claim is load-bearing in three documents' accessibility arguments, which means those arguments are unaudited. | `86` D-11 | Delete the checkbox — the card's device for "done" is the ordinal, struck, with the row as the 24px target and `aria-pressed`. Restate as *"no pictorial icons; a small closed set of typographic glyphs, enumerated in `54` §22"* and **enumerate them**, because an un-enumerated glyph set grows |
| M32 | A fourth stacking layer arrives via the native `popover` attribute in `54` §17, above the three-value `z-index` enum `51` §11 declared *"so nobody invents a fourth"*; and `56` §5.7 puts a `<title>` on every diagram node — a hover tooltip, on up to 500 elements, relied on by `56` §2.4 as the label-truncation mitigation — inside a subtree `55` §4.8 marks `aria-hidden="true"`, so it is not in the accessibility tree. The mitigation is mouse-hover-only, which is the precise failure `55` §1.4 lists as impossible. | `86` D-12 | Delete `<title>` from the SVG nodes; `56` §2.4's real mitigations (Outline row, inspector, digest) are already sufficient. Node provenance goes in the inspector, and `54` §17's "one exception" disappears |
| M33 | The diagram is theme-blind: `56` §5.7 emits literal light-theme hex (`#FFFFFF`, `#5C6772`, `#14171A`) as SVG presentation attributes, exempt from `51` §3.3's `tokens/no-raw-hex` by a loophole rather than an argument. In dark mode the product draws white boxes with near-black text on a `#0F1215` page — 20% of the surface area fighting the theme. And it cannot simply switch to `var()`, because `56` §9.3's export must freeze concrete values and `34` §5.6 forbids `<style>`. | `86` D-25 | Draw the live tree with `class` only, resolving colour from tokens in the stylesheet; serialise the export by resolving each class against the **light** token set explicitly and state in the export header that exports are light-only. One function, and it also satisfies `55` §7.3's forced-colours rules, which currently assume class-based styling the diagram does not use |
| M34 | Three documents each name a different *"only motion in the product"* — a 90ms opacity fade (`51` §12, `55` §7.1) and smooth scrolling (`53` §12.5, `52` §5.6.4). There are two. And the fade **cannot run as written**: `opacity` does not transition out of `display: none` without `transition-behavior: allow-discrete` on `display` plus a `@starting-style` rule, neither of which is present, and the elements start at `opacity: 1` in both states. | `86` D-35, D-36 | Delete the transition declarations and `--motion-disclosure`, and state in `51` §12 that the product has **no** animation. That is more in the card's spirit, removes a token, a media query and two failure modes, and stops the first person who notices from "fixing" it with a height transition `51` §12 forbids by name. Then `51` §12 gains a scroll-behaviour row citing `52` §5.6.4 |
| M35 | `53` §12.3 forbids `aria-live="assertive"` *"ever"*; `55` §4.6 and `54` §20 require exactly one — the egress-armed transition — via `role="alert"`, which has implicit `assertive`. | `86` D-34 | `55` is right: egress arming is the one thing worth interrupting for, because it is the one thing that changes what leaves the machine. `53` §12.3's last row becomes *"exactly one: the egress-armed transition (`55` §4.6). Nothing else, ever."* |
| M36 | The view band is specified two incompatible ways — `52` §9.3's lowercase muted italic margin tabs, *"not boxed and not underlined"*, versus `54` §11's bold tracked uppercase with a 3px `--ink` underline — and `54`'s reconciliation section enumerates three divergences and does not mention the most-looked-at control in the product. Separately, `54` claims the two egress-indicator specifications *"agree"*; they agree on position only, and differ on form, stickiness, height, glyph and focus order. | `86` D-31, D-32 | Take `52`'s band (`54` §11's own Provenance admits it is inventing, and it spends `51` §9's scarcest weight on navigation chrome). Take `54` §20's egress band, whose reasoning is sound, and amend `52` §2.2/§8.5 including deleting `▲`. Then re-run `54`'s reconciliation against all of `52`, because it is now known to be incomplete |
| M37 | `52` §3.5.1 was never amended after `54`'s reconciliation proposed the right answer for finding severity, and `52` §14 says *"None with the conventions"* without mentioning the proposal. A reconciliation offered and never accepted is two specifications with a note. | `86` D-38 | Amend `52` §3.5.1, or record the proposal in `52` §14 as received |
| M38 | Ten geometric forms in the diagram — vertical bracket, horizontal bracket, closed box, site band, device box, half-height open-right box, 4px stub, conduit, two-rail, one-rail — with no legend, in a product whose central discipline is that the one legend it has appears on every screen unchanged. The card's answer to "what is this thing" is never geometry; it is a word. | `86` D-27 | Not a legend of shapes. Every band, bracket and box already has a label: make the label carry the kind. `WAN` becomes `zone WAN`; a VLAN band reads `vlan 10`. Three characters, lowercase, in the margin-tab register |
| M39 | `56` §5.2's channel budget lists G1 (staleness) unconditionally, but `--ink` vs `--muted` is 2.381:1 in dark, so `56` §8.1 forces the age label on at every zoom. The dark diagram has nine channels, not ten. | `86` D-28 | Add a theme column to `56` §5.2's table. G1: light only. Two cells |
| M40 | The legend is rendered as coloured text on `--page` plus a 14×10px filled swatch. Both halves are inventions: the extraction states each semantic as an `{ink, wash}` pair and gives the card's own device for "here is what this colour means" as the **4px accent bar**, which `design-language.md` describes as *"never a box"*. | `86` D-9 | `.legend-item { background: var(--*-wash); border-left: 4px solid var(--*); padding-left: var(--s2); color: var(--*) }`; delete `.swatch`. It also removes an `aria-hidden` element `54` §6 is currently apologising for |
| M41 | The 6px risk dot is the one component chosen for familiarity rather than derived from the card — and `54` §19's entire AI strategy rests on *the absence of this dot* being legible, which requires it to be an unmissable fixture of every config line. A 6px grey square in a 34px gutter is not unmissable. It also sits at `margin-top: 7px`, a value in no token file, on a 4px grid. | `86` D-10 | Make it a 4px `--rule-accent` bar in the semantic ink on the line's left edge inside the block gutter, which is exactly `51` §4.3's stated collision rule, and snap the offset to `--s1`. Then promote the **absent** dot to device 0 in `54` §19's table: it is the only device that survives forced colours, print, monochrome and colour-vision deficiency, because the difference is presence, not hue |
| M42 | The one-line imperative — *"a disclaimer that is also the most useful sentence on the page"* — is overwritten by `52` §7.2 with `UNSAVED · IN MEMORY ONLY · NOT YET ENCRYPTED` for the duration of the most common session shape in the product. The footer and `beforeunload` already say it. The user's first and longest exposure to the imperative slot teaches them it holds chrome. | `86` D-4 | The imperative stays domain-governing, always; `54` §5's per-view table is the only source for that line. Unsaved state goes where `52` §7.2's own table already puts three of its four controls |
| M43 | `54` §1's eight-part component template has no **Copy** part. Every button label, empty state, confirmation, error and accessible name is written ad hoc in worked examples, and the examples are inconsistent with the voice they cite (`54` §12's no-results copy is excellent; `[ Acknowledge ]` / `[ Revoke ]` are generic). The voice is the thing the owner will notice first and the only item in the design register that cannot be recovered by a CSS change. | `86` D-7 | Add a ninth part: **Copy** — every user-visible string, authored, under the same discipline invariant 10 applies to explainers, linted against design-language's five voice characteristics |
| M44 | Dangling cross-reference: one document cites `docs/10-core/61-command-corpus-spec.md`; the file is `docs/60-content/61-command-corpus-spec.md`. | `83` P15 | Correct the path |
| M45 | Terminology: `03-non-goals-and-scope.md` uses *"the agent"* for a subagent, which `conventions.md` bans. | `83` §9.3 | Change to "subagent" |

---

## 4. Findings that do not survive scrutiny

The critics were briefed to be hostile, and hostility produces some findings that are wrong. Named
here with the reasoning, because a register that accepts everything is not a register.

### 4.1 `85`'s own count of the corpus is wrong, twice

`85` §2.1 states that *"`corpus/rules/` carries 36 complete rules with `condition`, `acceptable_when`,
three explainer depths, `reviewed_by` **and fixtures**"*, and repeats "36 rules" in its sources table.
Counted by this register: the file contains **37** rules (13 `high`, 13 `medium`, 8 `low`, 3 `info`),
and it contains **no fixtures at all** — its own header at lines 18–21 says so in terms: *"no fixtures
are included in this file… Until those exist these are specifications of rules, not rules."*

**Ruling: the finding (F1) stands in full; the characterisation of the corpus does not.** The eleven
non-existent rule IDs are real and verified, and R04 is a Blocker on that basis. But a critique whose
thesis is *"the citations to the outside world are careful and the citations to its own corpus were
never checked"* mis-stated the corpus's size and credited it with a property it explicitly denies.
Correct `85` §2.1 and §14 before the document is cited. The irony is instructive rather than
disqualifying, and it is exactly why R04's CI grep should also run over `docs/80-review/`.

### 4.2 `82` files the `weight: 3` miscount against the wrong file

`82` §10 lists *"header note `F6` says 'Ten entries carry `weight: 3`'; the file contains eleven"*
under **File: `corpus/rules/ipsec-junos-srx.yaml`**. F6 and the `weight` field are in
`corpus/commands/junos-srx-ipsec.yaml`. **The count is right** — this register verified eleven
non-comment `weight: 3` entries against a header and a § CANONICALITY section that both say ten, and
since gate 7 is "at most one `weight: 3` per (concept, platform)", an uncounted eleventh is exactly
the shape of a gate violation. Only the filing is wrong. Fix the file reference; keep the finding
(it is M-class and folded into R45's recount).

### 4.3 `84`'s §9 cuts and P3 are proposals, not defects

`84` §9 (cut the model tiers, cut the diagram to an export, cut multi-writer sync) and P3 (a local,
read-only MCP server over the corpus, in D4) are the sharpest strategic thinking in the six reviews
and they do not belong in a defect register as *"must change"*. Nothing in the corpus is *wrong*
because tier 2b exists or because there is no MCP server. **Ruling: recorded as owner decisions, not
defects.** They are carried in §8 as open questions with the argument attached, and R26 records the
one part that *is* a defect — that `71` contradicts `72` and neither says so.

Two notes on P3 specifically, because it deserves a straight answer rather than silence. It is
checked against the invariants correctly by `84`: loopback origin the user configured (1), no device
contact (2), no credential (3), no server (4), deterministic retrieval with the prose outside the
artifact path (9). `03` §4.8's refusal is of a chatbot **as the primary interface**, which this is
not. But `24` §3.4's LNA argument (M16) applies to any loopback surface reached from a browser
artifact, and `84` does not price it. The honest form of P3 is a **native binary exposing MCP over
stdio**, not a loopback HTTP server, and at that point it is a D4 feature costing days rather than a
reshaping of the AI layer.

### 4.4 `82` §19's "the corpus distorted the card" is right, and the card is not blameless

`82` §19 is correct that in every listed case the card is more careful than the corpus built from it,
and R06, R07 and R20 adopt three of its four rows. The fourth — the MTU row — is not a distortion of
the card, it is a **defect in both**: the card prints `OVERHEAD FIGURES APPROXIMATE —
CIPHER-DEPENDENT` as the side's governing rule, and the corpus then emits a hard-coded `mtu 1400` and
a `suggested_mss` defaulting to 1360. **Ruling: the corpus must derive at least one of the two from a
measured DF-ping and label the other a starting point** — but `82` §20's framing of the card as the
careful party understates that the card gives a number and a disclaimer on the same side and never
resolves them either. This is recorded so the card is not treated as an unimpeachable source in the
next revision; it is the corpus's best asset and it is a source, not a specification.

### 4.5 `86` §13.1's self-correction is accepted, and generalised

`86` itself rules that `55` §2.5 F3's WCAG framing is overclaimed — 1.4.11 measures a graphical object
against its **adjacent** colours, and two 4px severity bars separated by a row hairline and the page
ground are not adjacent — while the recommendation (one severity encoding, width in both themes,
delete the tone ramp) is right on usability grounds alone. **This register adopts both halves:** take
the recommendation, drop the criterion number. Attaching a conformance failure that will not survive
an auditor's reading weakens a good call, and after R37 the design set cannot afford another
optimistic conformance claim.

### 4.6 The reviewers' effort estimates are not independent evidence

`83` §12 computes 170–240 solo weeks against `71`'s 106–158; `84` §8 says the scope is survivable at
about 40%. Both are careful and both are built on the same line-rate assumption `71` §14 already
flags with a `VERIFY` demanding it be replaced with a measurement in phase 0's first four weeks.
**Ruling: R26 records the documentation defect (the plan of record contradicts its own risk register)
and does not adopt either number.** The instrument already exists — `71` X0.11, the measured authoring
median, which `72` §4.2 calls *"R-CORPUS's only instrument"* — and the register's position is that no
re-estimate should be written down until it has run for a quarter.

---

## 5. Adjudications, collected

Where two reviewers reached different answers on the same question, the ruling and its reason, in one
place.

| # | Question | `81` / `82` / `83` / `84` / `85` / `86` | Ruling | Why |
|---|---|---|---|---|
| A1 | Who owns the workspace container? | `81` §13.1: split, `32` crypto / `17` layout. `83` §3.4: same split, with granularity to `17` | Split adopted; **granularity withheld from the split** (R01) | Granularity is a metadata-disclosure question `32` argued at length, not a layout question. Neither reviewer adjudicated the trade, and this register will not do it without the open-path measurement |
| A2 | Is `17`'s keyless merge driver a breach or an asset? | `81` F3: breach of an explicit INVARIANT. `83` §14: *"a genuinely elegant result"* to be carried over | Both, and it is not separable (R15) | The elegance is a property of the frame model. There is no version of it that survives whole-record rewrite, so it is downstream of A1 and must not be built first |
| A3 | How many ways is the single file forked? | `81` §7.3: three. `83` F2: four, including a CI gate that would fail every build, and `73` D07 has already decided | `83` supersedes (R13) | More complete, and it reclassifies the item from "unresolved fork" to "unapplied decision", which is a different and cheaper fix |
| A4 | Who owns the subagent roster? | `83` §5.4: `22`. `85` §9.1: `22`'s types + `21`'s boundary, with a named per-section split | `85` (R14) | Same direction, more actionable. `83` says which document wins; `85` says which sections move |
| A5 | `clear …` risk labelling | `13` §5.5: `ChangesConfig`. `18` §7.4: `Disruptive`, with an argument | `18` (R03) | An argued position beats an asserted one. `13` §5.5 also asserts something false — the command needs no commit |
| A6 | Rename behaviour on re-parse | `11` §10.4: auto-match on a tier-2 tuple. `12` §11.4: never a silent re-bind | `12` (R25) | `11` §10.4's own justification argues for `12`'s rule: *"a wrong match silently rewrites the history of an object that is not the one you are looking at"* |
| A7 | Egress consent granularity | `21` §8.4: per-(workspace, purpose), expiring. `22` §1.3: per-invocation, bytes every time | `21` (R32) | Eighty raw-JSON disclosures a day trains users to dismiss the first pre-flight, which is the only one `21` §8.3 says has value. The repeat surface becomes a shape-diff |
| A8 | Does a fourth risk caption break the three-colour rule? | `conventions.md`: the caption is pinned. `82` §2: separate caption from band | `82`, as a conventions amendment (R18) | A false caption in the product's only safety legend is worse than an amended convention. The band, ink, wash and ordering are untouched, and the amendment text must say no fourth colour |
| A9 | Should the dark theme ship? | `51` §5.1: yes. `86` §5.3: only if three conditions land | `86`, conditionally (R10, M33) | The conditions are R10 (cascade tested as a cascade), M33 (the diagram themes) and one severity encoding in both themes. A themed product with an unthemed primary view is worse than an unthemed product |
| A10 | Is the AI layer's net effect on the corpus positive? | `21`/`22`: shipped catalogue of 8–10. `85` §4: one runtime worker, one conditional, three build-time | `85` (recorded, not decided) | `22` §18 point 5 already says the subagents do not reduce the authoring burden and that two of ten *add* capacity. That is the corpus's own accounting and it supports `85`'s distribution. **The scope decision is the owner's**; what this register decides is that the accounting must appear in `21` §1 rather than only in `22` §18 |

---

## 6. Corrections applied to the corpus

Precise enough to edit from. **The network-domain corrections come first, because wrong technical
content is the most damaging kind: it is the only class of defect in this register that reaches an
engineer's hands at 03:00 and is acted on.**

### 6.1 Risk reclassifications (R03)

In `corpus/commands/junos-srx-ipsec.yaml`, change `risk: ChangesConfig` to `risk: Disruptive` on:

| Entry | Statement | Reason |
|---|---|---|
| `junos-srx/zone.st0.bind.set` | `set security zones security-zone VPN interfaces st0.0` | Moving a live unit between zones invalidates every policy written for the old zone pair; traffic stops until new ones exist |
| `junos-srx/ipsec.vpn.bind-interface.set` | `set security ipsec vpn X bind-interface st0.N` | Repointing blackholes everything routed at the old unit |
| `junos-srx/interface.st0.address.set` | `set interfaces st0 unit N family inet address …` | Renumbering drops adjacencies and invalidates static next hops |
| `junos-srx/ike.gateway.version.set` | `set security ike gateway X version v2-only` | A peer that speaks only the other version stops negotiating entirely |
| `junos-srx/ipsec.vpn.establish-tunnels.responder-only.set` | `set security ipsec vpn X establish-tunnels responder-only` | Can make the tunnel permanently unrecoverable with no error anywhere |
| `junos-srx/ipsec.policy.pfs.set` | `set security ipsec policy X perfect-forward-secrecy keys …` | `18` §7.2 already argues `Disruptive`, at length, for this exact statement |
| `junos-srx/interface.st0.mtu.set` | `set interfaces st0 unit N family inet mtu …` | An MTU change re-establishes the logical interface |
| `junos-srx/ike.proposal.dh-group.set` | `set security ike proposal X dh-group …` | Crypto change on a live SA; see R46 before writing the `blast_radius` |
| `junos-srx/ike.proposal.encryption.set` | `set security ike proposal X encryption-algorithm …` | Same |
| `junos-srx/ipsec.proposal.encryption.set` | `set security ipsec proposal X encryption-algorithm …` | Same |

And in `corpus/rules/ipsec-junos-srx.yaml`, on the `ike.mode.aggressive-with-psk` remediation line
`set security ike gateway {{…}} version v2-only`.

In `13-emitters-and-provenance.md` §5.5, change the row for
`clear security ipsec security-associations index <n>` from `ChangesConfig` to `Disruptive`, matching
`18` §7.4 step 5. **Note while editing:** the corpus has no `ipsec.sa.clear-index` entry at all — it
has `ipsec.sa.clear-vpn` (the unscoped form, already `Disruptive`) and `ike.sa.clear-index`. Either
add the entry or change the `13` §5.5 row to name a command that exists.

Keep `clear security ipsec statistics` at `ChangesConfig` **band** with the caption override from R18:
`CHANGES STATE — NOT REVERSIBLE BY COMMIT`. Its `reversible: none` is already correct.

### 6.2 `INVALID_KE_PAYLOAD` (R06)

| Element | Current | Corrected |
|---|---|---|
| Explainer `teaching.body`, `explain:error:junos-srx/INVALID_KE_PAYLOAD` | *"it is looking at bytes it cannot interpret. There is nothing to negotiate at that point."* | The responder parsed the SA payload, selected a transform, and found the KE payload built for a different group. It returns `INVALID_KE_PAYLOAD` **carrying the group number it wants**, and the initiator retries `IKE_SA_INIT` with that group. In a healthy bring-up where the initiator's proposal list contains the named group, it appears exactly once and Phase 1 completes on the second round trip |
| Explainer `breaks_if_wrong` | *"On Phase 1 the tunnel never establishes."* | Terminal only when the two group sets are disjoint, and that case usually reports `NO_PROPOSAL_CHOSEN` rather than `INVALID_KE_PAYLOAD` |
| Citation, explainer and `ipsec.pfs.group-mismatch` | RFC 7296 **§1.3**, *"KE payload in CREATE_CHILD_SA"* | RFC 7296 **§1.2**. §1.3 does not discuss `INVALID_KE_PAYLOAD` |
| Version scope | `versions: "*"`, no qualifier | `subject.qualifier: v2`. `INVALID_KE_PAYLOAD` is IKEv2 notify type 17 and cannot appear on an IKEv1 gateway |
| Missing entry | — | New: `explain:error:junos-srx/INVALID-KEY-INFORMATION`, `qualifier: v1`, noting that an IKEv1 Quick Mode PFS group mismatch surfaces as `NO_PROPOSAL_CHOSEN` because the group is a Quick Mode SA attribute |
| `ipsec.pfs.group-mismatch` assertion | *"INVALID_KE_PAYLOAD in the log, **not** NO_PROPOSAL_CHOSEN"* with `versions: "*"` | Version-predicated, with the v1 branch saying the opposite |
| Explainer `misdiagnosed_as` | *"comparing all four values is wasted effort"* | Delete. When the groups really are disjoint, comparing the four values is exactly the right move |

### 6.3 `ike.dh-group.weak` (R08)

| Element | Current | Corrected |
|---|---|---|
| `condition` | `has(dh_group) && dh_group in [1, 2, 5]` — integers against a `DhGroup` enum | Set membership over the enum: `group1, group2, group5, group22, group23, group24` |
| `severity` | `medium`, flat | `high` for groups **1** and **22** (RFC 8247 §2.4: **MUST NOT**); `medium` for 2, 5, 23, 24 (**SHOULD NOT**) |
| `why` | *"RFC 8247 §2.4 marks groups 2 and 5 SHOULD NOT and group 14 MUST"* | State all four levels actually used: group 14 **MUST**; group 19 **SHOULD**; groups 2, 5, 23, 24 **SHOULD NOT**; groups **1 and 22 MUST NOT** |
| Coverage | Groups 22, 23, 24 not tested; Junos supports `group24` and group 22 passes clean | Add them |
| Missing sibling | `ipsec.pfs.group-weak` flagged under § UNRESOLVED REFERENCES | Write it. Same predicate over `IpsecPolicy.perfect_forward_secrecy` |

### 6.4 The remaining domain corrections

| # | File / entry | Current claim | Corrected claim |
|---|---|---|---|
| C1 | `ipsec.pfs.group-mismatch.why` | *"Two ends offering different groups fail the Phase 2 key exchange outright, and the child SA never installs"* | Version-split. **IKEv1:** immediate Quick Mode failure. **IKEv2:** the first Child SA is created in `IKE_AUTH`, which carries no KE payload, so it **installs**; the mismatch surfaces at the first `CREATE_CHILD_SA` rekey, up to `lifetime-seconds` later (3600 s on the card's own values). Force it inside the change window with `clear security ipsec security-associations index <id>`. This is `18` §7.3, and the card already gets it right |
| C2 | `nat.source-nat-eats-tunnel.explain.explained` | *"Source NAT is evaluated on the way out regardless of which interface the route chose"* | Source NAT rule sets are scoped by `from` and `to` context — zone, interface or routing-instance — and the `to` context resolves **after** the forwarding lookup picks the egress interface. A set declared `from zone TRUST to zone UNTRUST` does not match traffic routed at `st0.0` when `st0.0` is in zone `VPN`. The real failure is narrower: `st0` left in the WAN zone, or a set written `to interface <wan>` when a second egress is added later, or a `from routing-instance` set |
| C3 | `nat.source-nat-eats-tunnel.condition` | No term touches `NatRuleSet.from` or `.to`, so every device with a `0.0.0.0/0` internet source-NAT rule and any tunnel fires `high` | Add `nat_scope_covers(parent_ruleset.to, vpn.bind_interface)` and define `nat_scope_covers(scope, unit)` in § DERIVED PREDICATES |
| C4 | `ike.identity.mismatch.condition` | `(has(local_identity) \|\| has(peer.remote_identity)) && local_identity != peer.remote_identity` | `has(local_identity) && has(peer.remote_identity) && local_identity != peer.remote_identity`. An `Absent` peer field is "no constraint", not a disagreeing value |
| C5 | `zone.host-inbound.ike-missing.condition` | `zone == null \|\| !zone.host_inbound_system_services.exists(s, enum_is(s, "ike"))` | Re-anchor to the `ZoneMember` edge per `11` §7.5 and implement the full disjunction: fire only when **neither** the edge's `host_inbound_system_services` **nor** the zone-wide set contains `ike` **or** `all` |
| C6 | `zone.host-inbound.ike-missing.remediation` | `op: add_to_set, target: zone, field: host_inbound_system_services` — the zone-wide form | `add_to_set` on the **edge**, emitting `set security zones security-zone {{zone}} interfaces {{unit}} host-inbound-traffic system-services ike`. The current remediation opens IKE inbound on every interface in the zone |
| C7 | Several entries' `blast_radius`, and `ike.dh-group.weak` / `ike.proposal.3des` teaching text | *"the tunnel drops at the current SA's lifetime rather than immediately"*, *"rather than at commit"* — cited to nothing, and the card says nothing about commit-time SA behaviour | `<!-- VERIFY -->` until a reviewer with an SRX records the answer per train. Consolidate into `explain:concept:junos.commit-and-sa-lifecycle` so it is corrected once. If Junos in fact re-keys the affected VPN at commit, the corpus is currently telling engineers a crypto change is deferred when it drops the tunnel on the spot |
| C8 | `ike.dpd.too-slow` | One finding covering both "DPD configured slowly" and "`dead-peer-detection` not configured at all", titled *"waits more than 30 seconds"* | Split. `ike.dpd.absent` (`high`): no liveness configured on a tunnel carrying an adjacency — worst case is the SA lifetime, eight hours on the card's `28800`, not fifty seconds. `ike.dpd.too-slow` (`medium`): the `interval × threshold > 30` case. Mark *"is liveness implicitly on for IKEv2 on this train"* `<!-- VERIFY -->` |
| C9 | Verify-ladder command entries and the card's ladder | `show security ike security-associations` / `show security ipsec security-associations` with no node qualifier | Add `node (0\|1\|all\|local\|primary)` variants and make `node all` canonical for cluster topologies. Without it, running the ladder on the secondary node returns nothing and reads as "tunnel down" |
| C10 | `junos-srx/ipsec.sa.show.output_fields` | `field: State, want: Installed` against the **summary** output | On current Junos the summary columns are ID, Algorithm, SPI, Life:sec/kb, Mon, lsys, Port, Gateway, with `<`/`>` direction markers; `State: Installed` is a **detail**-only field. Either target the `detail` form or change the field. `<!-- VERIFY -->` on a box — this is the field the whole verify ladder hangs on |
| C11 | Card side 4, BOX-LEVEL CONTEXT | `show interfaces reth0.0 extensive \| match -i error` | `<!-- VERIFY -->`. Junos `match` is a POSIX regex filter and there is no documented `-i` flag; the idiom is `\| match "[Ee]rror"`. If `-i` is rejected the command errors harmlessly; if it is accepted as a literal pattern the filter matches nothing and the operator reads that as "no errors", which is the worst possible failure for a diagnostic filter |
| C12 | `mtu.st0.unset.remediation` and `suggested_mss` | Hard-coded `mtu 1400`; `suggested_mss` defaulting to 1360 | The card's governing rule for that side is `OVERHEAD FIGURES APPROXIMATE — CIPHER-DEPENDENT`. Derive at least one from a measured DF-ping and label the other a starting point in the emitted comment. See §4.4 |
| C13 | Rule pack § SEVERITY and header G1 | *"13 of 36 rules"*; *"2 high out of 23 non-correctness rules — 9%"* | **37 rules.** 12 correctness, of which 9 are `high`. 25 non-correctness, of which **4** are `high` (`ipsec.pfs.absent`, `ipsec.pfs.group-mismatch`, `ipsec.traffic-selector.not-mirrored`, `ike.mode.aggressive-with-psk`) = **16%**, outside the 15% budget the exemption was written to satisfy |
| C14 | Command corpus header F6 and § CANONICALITY | *"Ten entries carry `weight: 3`"* | **Eleven**: `zone.host-inbound.ike.set`, `ike.sa.show-detail`, `ipsec.sa.show-vpn-detail`, `interface.st0.terse`, `ipsec.statistics.index`, `ipsec.sa.clear-vpn`, `log.kmd.match-peer`, `ike.traceoptions.delete`, `mtu.ping.df-sized`, `flow.tcp-mss.set-ipsec`, `system.commit.show`. Gate 7 is one per (concept, platform); confirm the eleventh's concept set is disjoint |
| C15 | `71` §3.3, `72` §4.2 | *"84 seed entries"* | **91**. Every downstream hour figure inherits the error |

### 6.5 Security and crypto corrections

| # | File / § | Current | Corrected |
|---|---|---|---|
| S1 | `37` §7.4, `36` Q9 | *"Rotating the root key renders every prior ciphertext undecryptable by anyone, including the customer… the key material that could recover it no longer exists"* | See R02. Crypto-erasure is not available against a backup containing the keyholder record, which every backup does. What is available is replica deletion plus the honest statement about endpoints and repositories |
| S2 | `31` §10.1 | *"Workspace encryption is symmetric and not broken by a quantum adversary"* | *"Single-user workspace encryption is symmetric throughout. A **shared** workspace wraps the root key under X25519 and is harvest-now-decrypt-later exposed until suite `0x02` ships"* |
| S3 | `32` §7.2 AAD table | *"`commit_tag` … authenticated so that stripping or altering it fails at the MAC as well as at the constant-time compare"* | Under §3.2's ordering it never reaches the MAC. Fix the **code**, not the sentence: on commitment mismatch, run the AEAD open and branch — MAC fails ⇒ `Tampered`, MAC succeeds ⇒ `CommitmentMismatch`. Add both to §16.2 |
| S4 | `32` §6.4 | `padme((112 + 4 + body.len() + 16) as u64)` | `padme(112 + aad_ext_len + 4 + body.len() + 16)`, and pad the CBOR keyholder descriptor to a fixed width per `KeyholderKind` |
| S5 | `32` §4.6 | Table computed at `CAP` (256 MiB, t=4) only | Print both configurations, **floor first**. At `FLOOR` (64 MiB, t=3): ~30-bit passphrase against 10⁴ GPUs ≈ **2.9 hours** (not 15); against 10⁶ GPUs ≈ **1.7 minutes** (not 9); ~40-bit against 10⁶ GPUs ≈ **27 hours** (not 6 days) |
| S6 | `31` §3.2 | Matrix omits A4, A7, A12; prose says *"Four actors have a full row of `◆`"* | Add the three rows. **Five** actors have a full row: A5, A8, A9, A10, A11 |
| S7 | `17` §12.7 ini block | `cachetextconv = true` | `cachetextconv = false`, matching the prose four lines below and `32` §13.3 |
| S8 | `34` §1.4 | *"the exfiltration-channel catalogue **C1–C9**"* | **C1–C6** |
| S9 | `23` §6.1 C3 mitigation, §6.3 heading | *"CSP `connect-src`/`form-action` + link discipline"* | *"The application renders no clickable external link, in any surface, ever."* A navigation is not a fetch |
| S10 | `31` §7.2 | Ten channels, M1–M10, presented as exhaustive | Add **M11** (`IndexEntry.kind_opaque` — record kind in the clear to the sync server, making the V3 suppressions record individually trackable) and **M12** (per-frame `hlc.wall_ms` + `actor` in the clear in git — a pseudonymous per-record, per-writer edit-activity map). Propagate to `36` Q14 and `37` |
| S11 | `17` §3 | *"Nothing in that tree names a device, a site, a customer, a peer, a VPN or a zone"* | True as written and incomplete: the keyholder descriptor's `label` names **people**, in the clear, in every copy. Seal `label` (M06) and amend the sentence to say so until it is sealed |
| S12 | `34` §2.4 | *"the step from `'none'` to `'self'` is not a weakening of the confidentiality claim"* | In modes C and D, `'self'` is the sync origin the threat model labels untrusted by design, and `img-src 'self'` is a post-XSS exfiltration channel into its access log. State the residual as `material` in `34` §11 |
| S13 | `44` §4.8.3 move 5 | *"Verify the manifest digest eagerly (one BLAKE3 over the digest list); defer Poly1305"* | Verify the **record digests** eagerly — one BLAKE3 per envelope, keyless, parallelisable — and defer only Poly1305. The digest list alone does not give `32` §8.1's `MissingRecord`/`ExtraRecord` |
| S14 | `44` §4.8.5 | *"Records at unlock: 4"* (1 device), *"12"* (20 devices) | Wrong under both candidate formats: `32`'s class floor is ≥85 records before any provenance or capture; `17` gives ~70 at 20 devices and ~2 100 at 500. Recompute after R01, and express the deferral threshold in **bytes**, not records |

### 6.6 Design corrections

| # | File / § | Current | Corrected |
|---|---|---|---|
| G1 | `55` §2.6 | `:root[data-theme="dark"], :root:not([data-theme="light"])` inside `@media (prefers-contrast: more)`, not nested in a colour-scheme query | Three blocks per R10. As written, a light-theme user who asks the OS for more contrast gets `--danger` on its own wash at **2.13:1** |
| G2 | `55` §2.3 | Dark own-wash: `--caution` **5.15**, `--danger` **5.14** | **5.22** for both. `51` §5.5 is right; the two documents do not agree to the second decimal, which makes `55` §2.1's independence claim false as printed. Generate the tables from `55` §2.7's test rather than typing them |
| G3 | `51` §5.4, repeated in `51` §18 and `54` §28 note 2 | Prototype `--danger: #D07A78` is *"at 7.4:1 and is the pink failure mode described in §5.2"* | **5.98:1** against the prototype's own dark page `#101316` (6.03 against `#0F1215`). The conclusion (adopt `#EA6260`) is still right for a different reason: the two have the same OKLCh lightness (0.672 vs 0.667) and differ in chroma (0.108 vs 0.170), so the correct criticism is `51` §5.3 M4 — under-chromatic at that lightness, reads grey-red — not §5.2's pink |
| G4 | `55` §3.2 | Tritanopia row: `#5353BC`, `#878700`, `#6A6A00`; ratios 1.64 / 1.09 / 1.49 | Does not reproduce under the Viénot 1999 single-plane projection the section names — which computes `#2E6B6B`, `#AA5151`, `#8C2F2F` at 1.18 / 1.33 / 1.57 — and a green does not become blue-violet under any standard simulation. Either delete both tritan rows and say the method does not support them (which the section's own VERIFY already argues), or re-run with Brettel's two-plane method or Machado 2009, **for both themes**, and print what comes out. The dark table currently drops the row silently |
| G5 | `51` §5.1 | *"the actual deployment environment named in §6.7 of the owner's brief (change-window work)"* | Owner brief §6.7 is *Verification and rollback generation*. It names no deployment environment, no NOC, no lighting and no time of day; the brief nowhere describes where the product is used. Delete the citation and make the argument on its merits, which are adequate. Also delete *"there is no server to remember a preference"* — `51` §5.6 stores the theme in `Settings` |
| G6 | `55` §2.6 | Worst-CR column printed as 7.01 / 7.01 / 7.00 / 7.25 / 3.00 and 7.00 ×4 / 3.00 | Actual: light `--muted` 7.04, `--safe` 7.12, `--caution` 7.13, `--hairline` 3.08; dark `--muted` 7.02, `--caution` 7.08, `--danger` 7.11, `--hairline` 3.04. Everything clears; print the computed values or print `≥ 7.0`. Precision that was not measured is a claim |
| G7 | `51` §7.4 | All-caps mono at `0.96em` runs *"3.4% taller"* | **1.7%** (`0.96 × 0.7290 / 0.6880 = 1.0172`). The exception is still worth having; the justification is twice its real size |
| G8 | `51` §7.8 | `--measure: 68ch` *"≈ 460px at 13px"* | **491.6px** (`68 × 0.55615 × 13`). The prose measure is 76ch-equivalent |
| G9 | `51` §5.3 M4 | *"Boost chroma 20–45% over paper"* | **20–34%**, which is what its own next clause (`1.20–1.34×`) says |
| G10 | `51` §5.3 M2, §5.4 | dark `--hairline` OKL 0.295, `--surface` 0.220, `--ink` 0.913; `--ink` described as *"the ink hue"* | 0.310 / 0.225 / 0.916; and dark `--ink` `#DFE4E8` is hue **241.7°** against the ink's 248.2°, a 6.5° miss against `51` §3.1's own 5° tolerance. The derivation record must be re-derivable |
| G11 | `52` §9.6 | *"at most 14 discrete facts … Currently: [enumeration]. That is at the ceiling"* | The enumeration sums to **18** — 29% over a ceiling the same sentence says it is at |
| G12 | `52` §2.2, `54` §3 | Furniture *"about 150px"* / masthead *"~110px"* | **≈279px** total (masthead 140, legend 50, rail 60, ribbon 29), ≈311 below 1100px, ≈343 with egress armed. After R36's three cuts, **210px** — and it should be stated as 210 |

---

## 7. What the corpus still does not answer

Honest, and ordered by how expensive the silence is.

1. **What are the bytes on disk?** R01 is unresolved on the axis that matters. The ownership split is
   settled; record granularity and the update model are not, and they cannot be settled without an
   open-path measurement nobody has taken. Six documents are derived from a choice that has not been
   made.

2. **How big is the WASM core?** 700 KB or 2–3 MB, from the same component enumeration, a factor of
   four apart. It decides the single-file artifact's viability, `44`'s B17 and B18, `43`'s size table
   and `35`'s published hash. `41` §3.10's own `VERIFY` concedes it is *"a budget, not a measurement"*.
   Two days of work, and nothing in `40-stack/` is safe until it is done.

3. **Does the `sandbox` directive on a top-level document actually close egress channels 1 and 2?**
   `34` §2.11's four-part VERIFY is unresolved, three documents' residual tags depend on it, `36` Q40's
   answer to an air-gapped customer rests on it, and nobody has checked whether `sandbox` without
   `allow-popups` blocks `showSaveFilePicker` — which is `32` §13.1's only good save path. One
   afternoon, and it is the highest-value open measurement in the corpus.

4. **What does Junos actually do to a running SA at commit?** R46 / C7. This is the single sentence
   that decides whether an engineer schedules a change window, it is asserted in several entries, and
   no primary source in the corpus supports it. It needs a box and a per-train answer, not another
   round of reasoning.

5. **Whose budget does this come out of?** `03` §8 states it (*"Fathom has no obvious business
   model"*), `72` §10.4 argues it, `84` §2.3 answers it three ways, and no document owns it. Every
   persona in the corpus is an individual engineer with no purchasing authority. `72` §2's register has
   no row for it. The register can record that the gap exists; it cannot close it.

6. **Is the corpus authorable at the rate the plan assumes?** No entry has been authored and timed.
   `15` §12.6's 6–7 person-weeks doubles to 11–12 if the median entry costs 60 minutes rather than 35,
   and the whole of `72` §4's arithmetic — the most credible number in the repository — rests on an
   estimate. `71` X0.11 is the instrument and it has not run.

7. **Does the wedge convert, and to what?** `72` §7.2 reframes the strategy as *presence at a rare
   occasion*, which is coherent and well-suited to the architecture. `71` is not built on it. `84` §3's
   five comparables all stopped at the wedge or were absorbed into an assistant. `72` §7.4's instrument
   (*"has anybody opened a workspace twice"*) exists and cannot run before phase 1.

8. **Does the schema survive the second platform?** R-SCHEMA is rated *"fatal, and the most expensive
   to discover late"* and is retired in phase 7. `72` §3.6 puts roughly even odds on it breaking, whose
   bad outcome costs 60–70% of phase 1 repeated. `72` §3.5 describes the narrowing that would make the
   outcome survivable and nothing in `71` takes it.

9. **Can an artifact reach the market it was designed for?** `84` §6.2's persona 2 — air-gapped,
   accredited, the segment brief §2.4 calls structurally unservable by SaaS — is blocked by
   procurement, by ingress control, and by `72` §8.1 item 10 (an air-gapped user on an old build cannot
   be told their build has a vulnerability), which is unmitigable and is the first question his
   security officer asks. There is no document in the repository about how an artifact gets into that
   estate. **Technical fit is not procurement fit**, and the corpus has only ever demonstrated the
   first.

10. **Is a Rust dispatcher a supervisor AI?** R14 settles the architecture and not the requirement.
    The owner asked for a supervisor AI and sub agents; what the design produces is a host-side
    capability-scoped tool broker that makes zero model calls in every documented interaction. That is
    the right engineering and it is not what was asked for. Only the owner can rule on it, and until
    `21` §4.1 says the sentence out loud they cannot.

11. **What is the AI layer's net effect on the corpus, and is that trade acceptable?** `22` §18 point
    5 says the subagents do not reduce the authoring burden and that eight of ten consume it; `25`
    §11.3 says evaluating the layer properly costs more than seventeen engineers running it, plus 0.12
    FTE of senior attention forever. `85` §4's honest A1 test leaves one runtime worker, one
    conditional transcriber and three build-time tools of which two *add* capacity. Whether to take
    that shape is an owner decision the register does not make.

12. **What happens when a migration fails halfway through an encrypted document?** R41. The riskiest
    operation in the product — rewriting the user's only copy, with `11` §10.5's *"there is no undo
    across an encrypted-document save"* — has no owner, no failure semantics and no test story.

13. **Is a suppression's provenance defensible when it was produced by a model-framed question?**
    R30's fix closes the payload. It does not answer the general question: `21` §2.5.1 records
    `Actor::User` with `Confidence::Asserted` for a value the human agreed to rather than authored, and
    nothing in the provenance chain distinguishes the two. The audit view can show the question; the
    data model cannot yet say the answer was elicited.

14. **Which of the six views survive contact with a user?** `84` §4.3's negative case — four of the six
    exist because the slogan has six — is an assertion the corpus cannot falsify from inside, and the
    corpus's own defence (`02` §13: the combination is worth more than any incumbent's depth) is an
    assertion too. `84` C1 names the instrument and it needs a pilot engineer who does not work on the
    project.

15. **Does the voice transmit to a second author?** `72` §10.3's second-author test is new,
    unimplemented, and the cheapest existential test in the corpus. If the voice does not transmit, the
    teaching pillar is one person's output and R44's `reviewed_by` problem becomes permanent rather
    than temporary.

---

## 8. What must not be lost in revision

Every reviewer wrote a calibration section, and they converge on a short list. Recording it here so
that a revision driven by §§1–3 does not delete the reasons this corpus is worth revising.

- **`12` §3's `fex` decision.** Deriving a purpose-built expression language from the requirement that
  read-set extraction be total, then pricing it at 2 000–2 500 lines. Named by `83` and `85` as the
  best engineering in the corpus.
- **`18` §7.3's verify ladder.** Named independently by `82` and `83`. It is the section that proves
  R07, and it is the model for how a domain claim should be built.
- **`31` §10.1's structure, §5.3's check 9 (*"written to fail partially on purpose"*), §9.5's list of
  refusals, and §6.6's refusal to ship deniable encryption with the reason.** `81` calls §5.3 the most
  credible thing in the corpus. R27 corrects one row of §10.1; the table itself is the right instrument.
- **`14` §9.9's redaction argument** — refusing the marketing answer first, and making the `secret:`
  dictionary flag *be* the redaction catalogue so parser and redactor cannot diverge.
- **`32` §4.7 refusing to oversell its own subject** (*"Argon2id multiplies the attacker's per-guess
  cost by a constant. It does not add bits"*) and then making the generated passphrase the default.
- **`44` §1.1's work-counter insight** — because the product is deterministic, its work is a checked-in
  artefact, so a gate can fail in forty seconds on a free runner with a message naming the query.
- **`23` §9.3's adversarial mock model as a hard build gate** (*"if the defence needs the model to be
  honest, it is not a defence, it is a hope"*), and `25` §2.2's P4 (the baseline is not tuned against
  the suite while the candidate is), and `25` §9.6's refusal of LLM-as-judge for anything that gates.
- **`21` §2.3.1's `PredictedEffect`, computed by the core and never asserted by the model**, and the
  suppression carve-out (*"the AI layer may propose that a finding be suppressed. It may not propose
  why"*).
- **`51` §10 on why a rounded 4px bar is a lozenge**, the reserved-colour rule, the neutral severity
  ramp, and the fact that the design set added no colour, radius, shadow, gradient or logo. `86`'s
  arithmetic section credits `51` and `55` with 100+ correct figures before finding the wrong ones.
- **The `acceptable_when` fields.** `82` §18 rates them *"better than anything shipping in commercial
  linters"*, and it is the corpus's strongest single feature. R26's four corrections are corrections,
  not a verdict on the field.
- **The shared field-card fixture.** `11` §15, `12` §4.4, `13`, `14`, `44` §4.3, `63`, `32` §16.1 and
  `82`'s entire method all reach for the same worked SRX example. `83` §14 is right that this is the
  strongest structural force for coherence in the corpus, and it is why the *domain* layer holds
  together far better than the *format* layer.
- **The `## Disagreements` mechanism itself.** Every disagreement raised through it is well-argued and
  easy to act on. R12 does not replace it; it adds the half that catches the conflicts an author never
  noticed.

---

## 9. Disagreements

Raised under the conventions' own procedure, against `.context/conventions.md`.

**9.1 — The conventions need an `## Ownership` section.** R12. Full text and rationale there; it is
the only structural change this register asks for and it is the one that prevents the recurrence of
R01, R13, R14 and half of `86`.

**9.2 — The risk enum's caption must be separable from its band.** R18. Proposed replacement wording:
*"Exactly three bands. The caption is the default rendering of the band and may be overridden per
corpus entry where the default is untrue; the ink, wash and ordering may not."* Raised because the
current pinned caption `CHANGES CONFIG — NEEDS A COMMIT` is factually false on an operational `clear`,
and a false safety legend is a worse outcome than an amended convention. **No fourth colour is
proposed and none may be added under this amendment.**

**9.3 — Invariant 9's determinism must exclude the AI session and egress logs.** `81` §13.2's proposed
second sentence, adopted into R17: *"Determinism is a property of emitted artifacts — config,
findings, finder ranking, exports. The AI session log and the egress log are quarantined records: they
are inside the workspace, they are never inputs to an emitter, and they are excluded from every
determinism assertion."* Without it, a CI check written literally against invariant 9 over a workspace
that has used tier 1 compares log bytes and fails.

**9.4 — The `none | bounded | material | total` residual scale should be pinned unchanged.** `31` §14.3
asked; `32`, `34`, `36` and `37` adopted it verbatim without anyone changing it. It is a convention in
practice and only the convention is missing. Write it down before a sixth document invents a fifth
value.

**9.5 — Terminology binds filenames.** `85` §15.1. The file is `docs/20-ai/22-agent-catalog.md`;
`conventions.md` bans *"agent"* unqualified; and `21` §5's only pointer to its companion document does
not resolve because it uses the correct name. Proposed addition: *"These terms bind filenames,
directory names, type names, identifier prefixes and CLI flags, not only prose."* Cost: one rename.
