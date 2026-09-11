# ADR-0015 — The claims register: what the project stops claiming

> **Status:** Accepted
> **Date:** 2026-07-28
> **Register entry:** new — raised by `81` F2, §2.2.1, §3.6, §4.1–§4.4, §9 (O1–O16)
> **Reversal cost:** R5 in reputation — these claims are in the two documents a customer reads
> **Supersedes:** `36` Q9; `37` §7.4; the post-quantum row of `31` §10.1

## Context

The project's positioning is "security-first", which makes the overclaim register the list that
matters most. `81` §9 enumerates sixteen. Two are in the documents a customer actually reads, and
one of them is materially false.

**O1 — crypto-erasure. False, and load-bearing for a GDPR Article 17 argument.**
`37` §7.4: *"Rotating the root key renders every prior ciphertext undecryptable by anyone, including
the customer… the key material that could recover it no longer exists."* `36` Q9 repeats it. It is
untrue under `32`'s own design: `RK_e` is recoverable from any surviving epoch-`e` `Keyholders`
record by anyone holding the passphrase, the printed recovery code, `k` Shamir shares, a member
X25519 secret or the WebAuthn PRF. **Every backup you are claiming to erase contains that keyholder
record.** `32` §9.2 says so in terms — *"the git-history problem is not solvable by rotation"* — and
`36`/`37` say the opposite. You cannot crypto-erase a backup that contains the wrapping of the key
you are destroying.

**O2 — post-quantum, in the "what we do NOT claim" table.** `31` §10.1: *"workspace encryption is
symmetric and not broken by a quantum adversary."* True of the single-user passphrase path and
**false of every shared workspace**, where `RK_e` is wrapped to each member under HPKE
`DHKEM(X25519, …)`. `32` §10.7 states this correctly and calls it *"the exposure"*. An unqualified
overclaim inside the table whose entire purpose is *"to be quoted back"* is disproportionately
damaging.

**O3 — "nothing withheld".** `36` Q14 renders `31` §7.2's ten metadata channels to a customer as
*"nothing withheld"*. Two further channels exist in sibling documents: `IndexEntry.kind_opaque`
(`33` §2.5) puts the record *kind* in the clear to the sync server, making the suppressions record —
ranked **V3** — individually identifiable and trackable; and under ADR-0013 the second channel is
removed, but the first is not.

**The sharpest unreconciled inconsistency (`81` §2.2.1).** `31` §2.1 ranks *"which tunnels lack PFS"*
as asset **V6** and argues it tells a traffic collector which captures to archive. `32` §7.6 calls it
*"one boolean and one of the most valuable things in the file"*. `21` §8.2 then puts
`perfect_forward_secrecy` in the class that is **sent by default at tier 1, un-pseudonymised**, and
`36` Q31 reproduces that table to a customer without noticing. Pseudonymising a gateway's address
while sending, in the clear, the boolean that says its traffic is worth harvesting is exactly
backwards relative to the corpus's own asset ranking.

Four more are internal-consistency defects in the threat model itself: `31` §6.7 files a channel the
product *does* mitigate under "out of scope"; `31` §5.1 and §11 disagree on two residual tags; and
§3.2's matrix omits three of its thirteen actors and miscounts its own table.

## Decision

**Delete or qualify every claim below, in the documents that make them, before `36` is shown to
anyone.**

| # | Claim | Replacement |
|---|---|---|
| **O1** | Crypto-erasure | *"Crypto-erasure is not available against a backup that contains the keyholder record, which every backup of a workspace does. What is available is deletion of the replica (`33` §2.8), plus the honest statement that the original is on your endpoints and in your repository."* `37` §7.4 is **rewritten, not re-hedged** |
| **O2** | Post-quantum | *"Single-user workspace encryption is symmetric throughout. A **shared** workspace wraps the root key under X25519 and is harvest-now-decrypt-later exposed until suite `0x02` ships"* |
| **O3** | *"Nothing withheld"* | `kind_opaque` becomes **M11** in `31` §7.2, propagated to `36` Q14, `37` and the sync setup screen |
| **V6** | Crypto parameters sent by default at tier 1 | **Crypto parameters move to `withheld` by default; sending them becomes the opt-in.** Of the two available fixes, this is the one that does not require demoting an asset the corpus ranks correctly |
| **O6** | *"CSP `connect-src`/`form-action` closes the link-exfiltration channel"* (`23` §6.1 C3) | Delete the CSP attribution. A navigation is not a fetch. The only control is *"the application renders no clickable external link, in any surface, ever"* (`34` §9.4) and nothing else. Listing `connect-src` beside it teaches an implementer that loosening the anchor rule is safe |
| **O10** | *"Nothing above is in this workspace"* (`14` §9.8) | Add one muted line: `we catch what we know and what looks like a secret. we do not catch everything.` `14` §9.10 already concedes recall < 1.0; the UI does not |
| **§4.1** | `31` §6.7 filed as out of scope | Move to §5.1 as row 20, residual `material`, verification *"watch your own server's logs"*. **§6 contains only things with `total` residual** |
| **§4.3** | Residual tags disagreeing between `31` §5.1 and §11 (rows 16, 18) | Reconcile to `material`. R12's *"if the expiring version manifest ships, this drops to `bounded`"* is a no-op against a row already tagged `bounded` |
| **§4.4** | *"Four actors have a full row of ◆"* | Five do (A8 also). And A4, A7 and A12 are missing from the matrix entirely, including the one §3.1 itself calls *"A8's leverage with A1's legitimacy"* |
| **`21` §8.6** | The egress log retains literal request bodies to 25 MB | Default to `Evicted { digest }` after a short window. The log is `31` §2.1's asset list, concentrated: an attacker who obtains the workspace gets a pre-assembled, machine-readable, already-projected description of the estate without walking the graph |

**The rule that follows, and it is the point of this ADR:** a claim about the product may not be
made in `36` or `37` unless the owning document (per ADR-0001) makes it in the same terms. `36` §1.1
already sets this rule for itself — *"nothing here is softer than `31`"* — and the failure was that
nothing checked it. A CI grep over `36` and `37` for claim-shaped sentences whose cited section does
not contain them is a crude control and it is better than none.

## Consequences

### Positive

- The single fastest way to lose an enterprise review is closed. A materially false statement made to
  a data-protection officer, load-bearing for an Article 17 argument, in a document whose own rule is
  that it is never softer than the threat model, is not survivable when found in the room.
- The corpus's asset ranking and its egress defaults stop pointing in opposite directions.
- `31` §10.1 — the best table in the corpus, and the one written to be quoted back — becomes
  quotable.
- `36`'s remaining answers get stronger by contrast. `81` §8.5 lists twenty that should not be
  softened, including Q10's warrant-canary refusal and Q42's *"you do not, and this is a genuine
  gap"*. A document that says four difficult things honestly is trusted on the twentieth.

### Negative

- **The product loses its answer to "how do we delete customer data".** Crypto-erasure was the clean
  answer and the honest replacement is *"you cannot, from a backup, and neither can we"* — which is
  true of every end-to-end encrypted product and is heard as an evasion the first time. `37`'s legal
  analysis has to be rewritten around deletion of the replica, which is a weaker position.
- **Withholding crypto parameters at tier 1 by default degrades the AI layer's most useful case.**
  `constraint.negotiator`'s whole job is reasoning about proposals and PFS; withholding those fields
  leaves it reasoning about structure. Under ADR-0022 that subagent is cut anyway, which makes this
  cheap now and expensive if the roster is ever restored.
- **The shared-workspace PQ qualification is an admission with no remedy.** Suite `0x02` is reserved
  and not shipped (`32` D—), so the honest sentence names an exposure the product will carry for
  years, in the table reviewers quote.
- **A grep-based claim check will produce false positives and will be disabled.** The real control is
  a human comparing two documents, which is the control that already failed once.
- **Sixteen corrections across four documents is a substantial editing pass** on the corpus's most
  carefully written material, and every edit to a security document risks introducing a new claim
  while removing an old one.

## Alternatives considered

| Option | Strongest argument for it | Why rejected |
|---|---|---|
| **Hedge O1 legally rather than technically** | `37` §7.4's hedging is careful and a lawyer wrote it | The hedge sits on top of an untrue technical premise. Careful legal language wrapped around a false fact fails worse than a plain admission, because it reads as knowing |
| **Demote V6 in `31` §2.1 instead of changing the tier-1 default** | `81` §2.2.1 offers both; demoting is one edit and preserves the AI layer's capability | It requires arguing that "which tunnels lack PFS" is not valuable to a traffic collector, which `32` §7.6 already argued the other way and better. Change the default, not the truth |
| **Make the egress log's retention a setting** | Users who want the audit trail keep it | The concentration risk lands on users who never open settings, and the log's value is in the recent past. `Evicted { digest }` after a window keeps the audit property and drops the payload |
| **Leave `31` §3.2's matrix miscount alone** | It is arithmetic in an internal document, not a customer claim | The sentence excludes the supply-chain actor from a conclusion the table supports, which is the opposite of §8.4's own finding that *"goal C dominates both"*. A threat model that miscounts its own actors is not auditable |
| **Publish nothing until every claim is verified** | The strongest possible position | `81` §11 is explicit that several external citations could not be checked without web access and carry `VERIFY` markers, which is the correct state. Waiting for certainty on all of them ships nothing |

## Revisit if

- Suite `0x02` ships, at which point O2's qualification narrows to historical workspaces.
- A regulator or DPO accepts replica deletion as sufficient for an Article 17 request in a documented
  case — that is evidence `37`'s rewritten position is adequate rather than merely honest.
- A twelfth metadata channel is found. Two were found by one reviewer in one pass, which is evidence
  that `31` §7.2's enumeration should be presented as *"the channels we have found"* rather than as
  a list, and this ADR does not go that far.
