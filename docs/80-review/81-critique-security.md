# 81 — Adversarial critique: the security architecture

> **Status:** Contested

This is a hostile read of `30-security/*`, `20-ai/21`, `20-ai/23`, `10-core/14`, `10-core/17`,
`40-stack/43` and `40-stack/44`, against the owner brief and `conventions.md`. It assumes every
document overstates its own soundness and looks for the specific place where that is true.

**The honest headline first, because this document is otherwise unkind:** the security corpus is
better than most shipped products' security documentation. `31` §6, `32` §4.7, `34` §1.1, `14` §9.9
and `21` §8.7 are genuinely disciplined — they name their own failure modes in the register the
conventions ask for, and several of them refuse the comfortable answer on purpose. The problems
below are not that the documents are soft. They are that **the documents were written in parallel
and do not compose**, and that in three places the corpus states as settled fact something a
sibling document contradicts — including in the two artifacts a customer actually reads.

**The governing rule of this document, stated once, in caps, at the top:**

> **A SECURITY CORPUS IS ONLY AS TRUE AS ITS LEAST CAREFUL DOCUMENT, AND THE ONE A CUSTOMER READS
> IS NOT THE ONE THE CRYPTOGRAPHER WROTE.**

---

## 0. Contents

| § | |
|---|---|
| 1 | The three findings that matter |
| 2 | The zero-knowledge claim, traced end to end |
| 3 | Cryptography — where the design is actually wrong |
| 4 | Is the threat model honest? |
| 5 | The AI layer against the security posture |
| 6 | Redaction on ingest — theatre or not |
| 7 | Browser hardening — what CSP cannot deliver |
| 8 | The enterprise Q&A, read as a hostile reviewer |
| 9 | The overclaim register — every one found |
| 10 | Internal inconsistencies, small and concrete |
| 11 | What I could not check |
| 12 | What should happen before anything else |

---

## 1. The three findings that matter

| # | Finding | Where | Consequence |
|---|---|---|---|
| **F1** | **The corpus specifies two mutually incompatible workspace encryption formats.** `32-cryptography.md` specifies RFC 8439 ChaCha20-Poly1305, zero nonce, derived per-record subkey, 112-byte envelope header, hash-sharded into a fixed set of 64 node records. `17-workspace-format.md` specifies **XChaCha20-Poly1305 with a 24-byte random nonce**, a 32-byte file header plus 69-byte per-frame header, and **one record per device subtree**. `32` D4 explicitly *rejects* XChaCha; `32` D6 explicitly *rejects* per-node/per-device granularity. Both are Status-labelled and neither cites the other's decision as overruled. | `32` §1 D3/D4/D6, §5.3, §6.2, §7.1, §13.2 vs `17` §4.2, §5.1, §5.2, §5.3 | There is no implementable format. Worse: `33`, `36` and `37` all follow `17` (frames), and `31`, `34`, `43` and `44` all follow `32` (envelopes). The enterprise Q&A (`36` Q11, Q12) tells a customer to verify a format that the crypto document says will not be built. |
| **F2** | **The crypto-erasure claim is false**, and it appears in the two customer-facing documents. `37` §7.4: *"Rotating the root key renders every prior ciphertext undecryptable by anyone, including the customer… the key material that could recover it no longer exists."* `36` Q9 repeats it. It is not true under `32`'s own design: `RK_e` is recoverable from any surviving epoch-`e` `Keyholders` record by anyone holding the passphrase, the printed recovery code, `k` Shamir shares, a member X25519 secret or the WebAuthn PRF. **Every backup you are claiming to erase contains that keyholder record.** `32` §9.2 says this in terms — *"every historical commit still holds records sealed under `RK_e`… The git-history problem is not solvable by rotation"* — and `36`/`37` say the opposite. | `36` Q9; `37` §7.4; contradicted by `32` §9.2, §9.5 | A materially false statement made to a data-protection officer, load-bearing for a GDPR Art. 17 argument, in a document whose own §1.1 rule is *"nothing here is softer than `31`."* This is the single fastest way to lose the review. |
| **F3** | **`17`'s keyless git merge driver violates an explicit INVARIANT in `32`, and ships the exact leak `32` rejected.** `32` §5.4: *"**INVARIANT — ciphertext is never merged.** The sync layer transports whole records. It never combines two envelopes… Merging happens on opened plaintext, in the core, or it does not happen."* `17` §12.4's merge driver is a **set union over ciphertext frames, performed without the key, by a subprocess**. Separately, `17` §5.1 puts a per-frame wall-clock timestamp (`hlc.wall_ms`) and an actor pseudonym **in the clear**, permanently, in git history — which is precisely the per-operation model `32` §6.1 evaluated and rejected: *"an operation log records that somebody edited `IpsecPolicy.perfect_forward_secrecy` at 22:40 on a Tuesday… the shape is the reconnaissance in `31` §7.3, at higher resolution and with no server required."* | `32` §5.4, §6.1 vs `17` §5.1, §5.4, §5.5, §12.4 | The metadata channel `32` refused to accept is shipped by default in the shape the brief §6.4 says is the primary one (git-versionable document). `17` §5.5 prices it honestly and offers `opaque_frames`, but it is **off by default** and neither `31` §7.2's M1–M10 nor `36` Q14's "nothing withheld" mentions it. |

Everything else below is smaller than these three.

---

## 2. The zero-knowledge claim, traced end to end

The assignment: take one field of one device and find every place it exists in plaintext.

**The field:** `IpsecPolicy.perfect_forward_secrecy = Absent` on `VPN-B`. This is not an arbitrary
choice — `31` §2.1 ranks it **V6**, and `32` §7.6 calls it *"one boolean and one of the most
valuable things in the file"*, because it tells a traffic collector which captures to archive.

### 2.1 The trace

| # | Location | Plaintext? | Admitted where | Verdict |
|---|---|---|---|---|
| 1 | Keystroke → `<input>`/DOM value | yes | `31` §2.4, `32` §14.3 | admitted, unfixable |
| 2 | JS string → WASM linear memory (readable as `Uint8Array` by any origin script) | yes | `31` §4.3, `32` §14.3 | admitted |
| 3 | Engine worker's plaintext graph, whole session | yes | `34` §7.2 | admitted |
| 4 | Rendered DOM, findings panel, diagram | yes | `31` §2.5 | admitted |
| 5 | Emitted line + clipboard + terminal/ticket/wiki | yes | `31` §6.5 | admitted, out of scope |
| 6 | Workspace at rest, sync blob, git objects | **no** — sealed | `32` §3 | the claim holds *here and only here* |
| 7 | `git log -p` via `fathom show --plain` → `less` temp file → terminal scrollback → session recorder | yes | `32` §17.13 | admitted |
| 8 | `git config diff.fathom.cachetextconv = true` → decrypted content written into `.git/` | yes | `32` §17.12 | admitted |
| 9 | **Tier 1 AI egress.** `perfect_forward_secrecy` is in the **"Crypto parameters"** class, whose tier-1 default is **`sent`** — not pseudonymised, not withheld | **yes, off the machine, in the clear at a third party, by default when tier 1 is on** | `21` §8.2 | **partially admitted — see below** |
| 10 | **AI egress log**, retained literal request bodies, inside the workspace ciphertext | sealed, but a second durable copy that survives node deletion | `21` §8.6, `37` §7.5 | admitted |
| 11 | **`17` frame header**: the *fact and wall-clock time* of the edit to this field, plus the pseudonymous author, in the clear in every git object forever | metadata, not the value | `17` §5.5 | **not in M1–M10, not in `36` Q14** |
| 12 | **`32` §7.4 keyholder descriptor `label`** — cleartext in every copy of the workspace | e.g. `"Kate's laptop"`, `"printed code in the safe"` | **nowhere** | **unadmitted** |

### 2.2 What the trace shows

**The claim survives, narrowly, and only for row 6.** `31` §10.1 and `21` §8.7 do state this. But
three things fall out that no document currently reconciles:

**2.2.1 — The V6/tier-1 collision is unreconciled and is the sharpest inconsistency in the corpus.**
`31` §2.1 ranks *"which tunnels lack PFS"* as V6 and argues it is *"which recorded traffic is worth
keeping"*. `32` §7.6 calls it one of the most valuable things in the file. `21` §8.2 then puts
`perfect_forward_secrecy` in the class that is **sent by default** at tier 1, un-pseudonymised, and
`36` Q31 reproduces that table to a customer without noticing. Pseudonymising the *address* of a
gateway while sending, in the clear, the boolean that says its traffic is worth harvesting is
exactly backwards relative to the corpus's own asset ranking.

> **Fix:** either demote V6 in `31` §2.1 with an argument, or move crypto parameters to `withheld`
> by default at tier 1 and make sending them the opt-in. One of those two edits must happen; the
> current state is that two documents rank the same field at opposite ends of the scale.

**2.2.2 — Keyholder labels are an unlisted plaintext personal-name disclosure.**
`32` §7.4's `KeyholderDescriptor` carries `pub label: String` — *"Kate's laptop", "printed code in
the safe"* — as **cleartext**, because it is the `aad_ext` and must be readable before any key
exists. It is therefore in every copy of the workspace: on the sync server, in every git commit, in
every backup, in the packed file you mail to a colleague. `32` §6.5's "what still leaks" table lists
*"the keyholder count"* and stops. `31` §7.2's M1–M10 does not have a channel for it. `17` §3 claims
*"Nothing in that tree names a device, a site, a customer, a peer, a VPN or a zone"* — true, and it
does not say *nothing names a person*, which the keyholder table does. `37` should care: it is
personal data, in the clear, at the processor.

> **Fix:** move `label` inside the sealed `KeyholderSecret` and keep only the opaque `id` and
> `kind` in the descriptor. The UI can render labels after the first successful unlock; before that
> it renders `id`. This costs one round of trial decryption in the multi-passphrase case, which
> `32` §7.4 already accepts, and it removes a leak nobody priced.

**2.2.3 — Row 11 is a channel the metadata section does not have.** Covered in F3 and §4.2 below.

---

## 3. Cryptography — where the design is actually wrong

`32` is the strongest document in the corpus. The primitive choices are defensible, the citations I
can check are correct (RFC 9106 §4's two options, RFC 8439 §2.8, RFC 5869, RFC 9180's `0x0020 /
0x0001 / 0x0003` codepoints, Len–Grubbs–Ristenpart, Padmé's O(log log M) / ≤12 % bounds, the
WebAuthn PRF salt construction, the Crockford alphabet, the RIPA s.49/s.53 penalties), and D4's
*"we needed the HKDF anyway"* argument for the age-style zero-nonce construction is correct on its
own terms. The following are the places it is wrong, in descending order of severity.

### 3.1 The commitment check inverts the error taxonomy it exists to fix

`32` §3.2 opens a record as:

```
(K,C')  = derive_record_keys(parent, header, aad_ext)
if !constant_time_eq(C', header[96..112]) { return Err(WrongKey) }   # ← before Poly1305
pt      = AEAD-Open(K, 0u96, header || aad_ext, ct)?                 # ← MAC check
```

`commit_tag` is **not** in the HKDF `info` (correctly — it is an output). So flipping one byte of
`commit_tag` does not change `K`; it fails the constant-time compare and returns **`WrongKey`**. The
AEAD is never reached.

`32` §7.2 claims the opposite, in the AAD table: *"`commit_tag` — an output, not an input, but
authenticated so that stripping or altering it fails **at the MAC as well as** at the constant-time
compare."* Under §3.2's own ordering, it never fails at the MAC, because the function returns first.

**Concrete failure:** a hostile sync operator, a hostile git committer, or one flipped bit of
bit-rot in a `commit_tag` byte produces the message *"wrong passphrase"* for a user whose passphrase
is correct. `32` §3.2's stated justification for the whole ordering is *"telling a user 'the file is
corrupt' when they mistyped their passphrase is how support tickets are made"* — the design produces
the exact inverse, which is worse, because the user's response to "wrong passphrase" is to try
harder rather than to restore from backup. `32` §16.2's negative-vector table has no row for a
mutated `commit_tag`, so CI would not catch it.

> **Fix:** on a commitment mismatch, run the AEAD open anyway (constant time is irrelevant here —
> the attacker already has the ciphertext) and branch on its result: MAC fails ⇒ `Tampered`; MAC
> succeeds ⇒ `CommitmentMismatch`, which is a distinct, nameable state. Add both to §16.2. The cost
> is one wasted AEAD open on a genuinely wrong passphrase, which is microseconds against a
> one-second KDF.

### 3.2 `pad_plaintext` ignores `aad_ext_len`, so keyholder envelopes fail the corpus's own CI check

`32` §6.4:

```rust
let target = padme((112 + 4 + body.len() + 16) as u64) as usize;
```

The envelope is `header(112) || aad_ext(aad_ext_len) || ciphertext` (§7.1). For every keyholder
envelope `aad_ext_len > 0` (§7.4 — the descriptor is the AAD extension). So the total envelope
length is `padme(...) + aad_ext_len`, which is not a Padmé bucket.

`32` §18's CI table: *"Padmé bucket assertion — fails when **any envelope's** total length is not
`padme(length)`."* `31` §12: *"Padding invariant — fails when an uploaded blob's length is not a
Padmé bucket boundary."* Both would fail on the keyholder record on day one, and an implementer will
"fix" it by weakening the assertion rather than the arithmetic.

Second-order: because `aad_ext_len` is the *unpadded* CBOR length of a descriptor containing a
free-text `label`, **the envelope length leaks the label length**, which combines badly with §2.2.2.

> **Fix:** `padme(112 + aad_ext_len + 4 + body.len() + 16)`, and pad the CBOR descriptor to a fixed
> width per `KeyholderKind` before it becomes `aad_ext`.

### 3.3 The headline offline-cracking table is computed at a configuration that will not ship

`32` §4.6's table — the one an enterprise reviewer reads, and the one `36` Q5 leans on — is
computed **at `CAP` (256 MiB, t=4)**. `44` §4.8.4 then proposes, with a reasoned argument I agree
with, that the default becomes `DeviceFloor::AnyDevice`, which **pins `m` at `FLOOR` (64 MiB, t=3)**
for every workspace that does not opt out. `32` §4.6 handles this in one sentence after the table —
*"At the floor config, multiply every time by about 0.19"* — and never restates the table.

So the numbers a reviewer will quote back are 5.3× (≈2.4 bits) too favourable for the shipping
default. Restated at the floor:

| Passphrase | `32` §4.6 as printed (CAP) | At the proposed default (FLOOR) |
|---|---|---|
| memorable sentence, ~30 bits, 10⁴ GPUs | 15 hours | **≈2.9 hours** |
| memorable sentence, ~30 bits, 10⁶ GPUs | 9 minutes | **≈1.7 minutes** |
| strong human-chosen, ~40 bits, 10⁶ GPUs | 6 days | **≈27 hours** |

This is not a design error — `44`'s trade is the right one and its second argument ("a four-second
unlock is not a neutral security property") is correct and under-appreciated. It is a **presentation
overclaim** in the document a reviewer reads, and it is the kind that ends a meeting when found.

> **Fix:** `32` §4.6's table gets a second set of columns at the floor, and the floor columns are
> the ones printed first, because that is the default. `31` §5.1 row 19's residual is `material`
> either way, so nothing else changes.

### 3.4 Rollback protection does not exist in the git shape, because the manifest is not committed

`32` §8 makes the manifest carry the version vector and the per-record digests, and §8.1 requires
that on every open *"every record named in `records` must be present, and its bytes must digest to
`digest`. A missing record is an error, not a warning — a hostile store that drops the
`Suppressions` record makes the workspace look clean."*

`17` §3: `manifest.fm` — **`NOT committed (§7.4). Local index cache`**.

So in the git shape — which brief §6.4 makes the primary collaboration story, and which `32` §13.2
and `17` §12 both build on — there is no manifest travelling with the workspace, therefore no
version vector, therefore **none of `32` §8.2's rollback rule runs**, therefore `32` §18's
"Rollback refusal" CI check and `31` §12's "Rollback rejection test" are testing a path that does
not exist where it matters. A colleague who clones the repository is `32` §8.3's *"fresh client…
has no `S` and cannot detect anything"*, permanently, by design.

`32` §19 C11 tags this `bounded` on the grounds that it is only a fresh-client problem. Under `17`
it is an every-client problem in the shape the product leads with.

> **Fix:** decide whether the manifest is committed. If it is not, `32` §8 must say that rollback
> detection is a sync-shape-only control and re-tag C11 `material`, and `36` must stop implying
> otherwise. If it is, `17` §7.4 changes.

### 3.5 Deferred AEAD verification contradicts the manifest contract

`44` §4.8.3 move 5: *"Defer per-record AEAD above 30 records. Verify the manifest digest eagerly
(one BLAKE3 over the digest list); defer Poly1305 to first read."*

Verifying "one BLAKE3 over the digest list" proves the *list* is intact. It does not prove the
*records* match their digests. `32` §8.1 requires exactly that, at open, and gives the reason: a
store that drops or substitutes a record must fail closed. Under move 5, a substituted `Nodes` shard
is discovered when someone happens to look at a device — mid-session, possibly never.

`44` defends move 5 with *"`open_record()` is the only function that can hand out plaintext and it
verifies unconditionally"*, which is true and does not address the missing/extra-record checks
(`MissingRecord`, `ExtraRecord` in `32` §16.2) that are the point of §8.1.

> **Fix:** eagerly verify the *record digests* (a BLAKE3 over each envelope's bytes — cheap, no key
> needed, parallelisable) and defer only Poly1305. That preserves §8.1's guarantee at ~1 GB/s.

### 3.6 The post-quantum row in the "what we do NOT claim" register is itself an overclaim

`31` §10.1: *"We claim: workspace encryption is symmetric and not broken by a quantum adversary in
the way public-key transport is."*

That is true of the single-user passphrase path and **false of every shared workspace**, where `RK_e`
is wrapped to each member under HPKE `DHKEM(X25519, …)`. `32` §10.7 states this correctly and calls
it *"the exposure"* — harvest-now-decrypt-later against a keyholder table that yields `RK_e` and
therefore the whole workspace at that epoch.

Having an unqualified overclaim inside §10.1 — the table whose entire purpose is *"written to be
quoted back"* — is disproportionately damaging.

> **Fix:** the row becomes *"Single-user workspace encryption is symmetric throughout. A **shared**
> workspace wraps the root key under X25519 and is harvest-now-decrypt-later exposed until suite
> `0x02` ships."*

### 3.7 Smaller crypto notes

| # | Note |
|---|---|
| a | **`32` §11.1's recovery code bypasses the KDF entirely and is re-wrapped on every epoch bump** (§9.3 step 3). So removing a member re-arms the printed paper against the *new* epoch. §11.1's footgun table names the passphrase-change case and not this one. A departed admin who photographed the safe's contents retains access across the revocation that was performed because they left. |
| b | **`32` §12.2's AND mode has no recovery-code requirement in the type system**, only in prose (*"should require a recovery code to be printed"*). Given §17.4's own thesis that unenforced sequencing rules are where the bugs are, make it a constructor precondition. |
| c | **`17` §5.8 compresses `DeviceGraph` records**, which contain strings parsed from an attacker-supplied capture *alongside* the user's own values. `32` §6.3's RULE — *"never a record that mixes attacker-supplied text with anything else"* — is written about captures and applies verbatim here. `17` §5.8 reasons only about `Settings`/`Suppressions`. |
| d | **`32` §5.4 case 5 (CSPRNG replay) is correctly identified as the real risk** and the mitigations are correctly described as insufficient. Under `17`'s 24-byte random nonce the same case applies with the same severity, and `17` §5.2 does not mention it — it argues only against counters. |
| e | **`32` §16.1's `99-workspace/` fixture ships a real workspace with passphrase `"correct horse battery staple"` in the repository.** That is right for conformance and it means the repo contains a permanent, public example of the format sealed under a known passphrase. Fine — but CI must assert that no *other* fixture ever uses a low-entropy passphrase, or someone will reuse the pattern for a fixture derived from a real estate. |

---

## 4. Is the threat model honest?

**Mostly yes, and unusually so.** `31` §6 refuses to add a compensating-control paragraph to any
out-of-scope item; §3.2's actor×asset matrix produces the genuinely uncomfortable conclusion that
*"the cryptography is not the weak link"*; §8.1's attack tree stars the leaves that are cheap rather
than the ones the architecture defends; §9.1's refusal-relocates-the-change argument is correct and
most products get it wrong; §10.1 is the best table in the corpus.

Three places where it quietly moves something out of scope, and two arithmetic errors.

### 4.1 "Out of scope" is doing one piece of illegitimate work

Eight of the nine §6.1 rows are legitimately out of scope: they are endpoint, platform or human
problems no application can touch. One is not.

**`31` §6.7 — "Traffic analysis and metadata at the sync server: out of scope in the sense that
zero-knowledge does not address it. Partially mitigable at a cost worth stating properly, which is
§7."** That is not out of scope; that is in scope with a residual. §7 then does the work properly
and §7.6 takes a real decision. The §6.1 row is a filing error, but it is the filing error that
matters, because §6 is the table an enterprise reviewer skims for "what have they given up on", and
placing a channel there that the product *does* mitigate teaches them to discount §6's other rows.

> **Fix:** move it to §5.1 as row 20, residual `material`, verification column "watch your own
> server's logs". §6 should contain only things with `total` residual.

### 4.2 M1–M10 is presented as exhaustive and is not

`31` §7.2 enumerates ten channels. `36` Q14 renders that to a customer as *"Nothing withheld — `31`
§7.2 enumerates ten channels."* Two further channels exist in sibling documents:

| Channel | Where | Discloses |
|---|---|---|
| **`IndexEntry.kind_opaque`** — record kind in the clear to the sync server | `33` §2.5, §12.3 | device-graph vs provenance vs suppressions vs AI cache, per record. Makes the **suppressions record individually identifiable and individually trackable** — and `31` §2.1 ranks suppressions **V3** |
| **Per-frame `hlc.wall_ms` + `actor`** in the clear, permanently, in git | `17` §5.1, §5.5 | a pseudonymous per-record, per-writer, wall-clock **edit-activity map** — team size per device, working hours per person, change windows |

Both are honestly priced in their own documents. Neither is in `31` §7.2, so neither reaches `36`
Q14, `37`, or the sync setup screen. The second is materially worse than M4/M5 because it is at
record granularity, per-author, and it goes to whoever can read the repository rather than to the
operator.

> **Fix:** M11 and M12 in `31` §7.2, propagated to `36` Q14 and `37`. And `17` §5.4's
> `opaque_frames` should default **on** for any workspace with more than one member, because the
> disclosure it makes is precisely a multi-writer disclosure.

### 4.3 The residual register contradicts §5.1 in two rows

| Threat | `31` §5.1 residual | `31` §11 residual |
|---|---|---|
| Update rollback / freeze | row 18: **`material`** | R12: **`bounded`** |
| Single-file build has no `frame-ancestors` / reporting | row 16: **`material`** | R11: **`bounded`** |

R12 additionally reads *"If the expiring version manifest ships, this drops to `bounded`/low"* — it
is already tagged `bounded`, so the revisit trigger is a no-op. A register whose tags disagree with
the table they summarise is a register nobody can audit.

### 4.4 §3.2's own summary miscounts its own table

`31` §3.2's matrix omits **A4** (active network attacker), **A7** (malicious corpus contributor) and
**A12** (insider with build or release access) — three of the thirteen actors in §3.1, including the
one §3.1 itself calls *"A8's leverage with A1's legitimacy"*.

And the prose beneath reads *"**Four** actors have a full row of `◆`"*, then names A5, A9, A10 and
A11 — but A8 also has a full row of `◆` in the printed table. Five, not four. The sentence excludes
the supply-chain actor from the conclusion the table supports, which is the opposite of the
document's own §8.4 finding that *"goal C dominates both"*.

### 4.5 What the threat model gets right and should not lose in revision

For balance, because a critique that finds only faults is not calibrated:

- §1.5's *"what the invariants already removed"* is the correct first section and is rare.
- §2.2's argument that findings outrank configuration is right, non-obvious, and drives real
  decisions downstream (`17` §15.5's export header, `36` Q4's DLP advice). Keep it.
- §5.3's verification checklist, and specifically check 9 *"written to fail partially on purpose"*,
  is the most credible thing in the corpus.
- §9.5's list of things the project refuses to build — the authorisation attestation, the abuse
  telemetry, the dangerous-command blocklist, watermarking — is correct on every row and each
  refusal is argued rather than asserted.
- §6.6's refusal to ship deniable encryption, with the reason, is the right call and the reason
  given is the right reason.

---

## 5. The AI layer against the security posture

### 5.1 The egress path, followed precisely

`21` §8 is the most honest AI-security section I have read in a corpus of this kind. §8.1 refuses
the letter-of-the-invariant defence in the first paragraph. §8.7's plain statement is correct and
`36` Q30–Q38 reproduces it without softening. The pre-flight showing literal bytes, the log
retaining literal bodies rather than digests, expiring grants with no "forever" option, and the
armed-state indicator reusing the card's own devices rather than inventing a fourth colour — all of
that is right.

Following the path: `graph → broker projection → EgressEnvelope → connect-src <one origin> → TLS →
provider plaintext`. The gates are: build-time origin set (`21` §7.5), per-`(workspace, purpose)`
grant with an expiry, per-field policy, pre-flight, log. **The path is correctly closed at tiers 0,
2a and 2b, and correctly declared open at tier 1.** Nothing is hidden.

Three problems.

**5.1.1 — The V6 default (see §2.2.1).** `perfect_forward_secrecy` is in the class sent by default.

**5.1.2 — `23` §6.3 attributes to `connect-src` a power it does not have.** The section is titled
*"CSP `connect-src` + link discipline — closing C3"*, and the C1–C6 table's mitigation cell for C3
reads *"CSP `connect-src`/`form-action` + link discipline"*. A link click is a **top-level
navigation**, which `34` §2.11 channel 1 and `34` §9.4 reason 2 both state explicitly is not covered
by any CSP fetch directive — *"a link is the exfiltration path that survives `connect-src`, because
a navigation is not a fetch"*. The only control closing C3 is `34` §9.4's decision to render no
anchors at all, which `23` also names. Listing `connect-src` alongside it teaches an implementer
that loosening the anchor rule is safe because the CSP will catch it. It will not.

> **Fix:** delete `connect-src` and `form-action` from C3's mitigation cell; the control is
> *"the application renders no clickable external link, in any surface, ever"* and nothing else.

**5.1.3 — `34` §1.4 cites a channel catalogue that does not exist.** *"Prompt injection and the
exfiltration-channel catalogue **C1–C9** | `20-ai/23`"*. `23` §6.1 defines **C1–C6**. Either three
channels were dropped without updating the cross-reference, or `34` is remembering a longer list. A
reviewer who follows the reference finds three missing channels and reasonably assumes they were
removed because they were awkward.

### 5.2 The AI layer's boundary is genuinely sound, and one thing about it is not

The propose/select/order/ask/abstain verb set, the resolver-runs-first rule, the absence of any emit
or clipboard capability, and `31` §9.4's export gate living in the WASM core rather than the UI —
these compose into a real bound, and `36` Q35's "the no is structural" is defensible.

The one soft spot: **`21` §8.6's egress log is `31` §2.1's asset list, concentrated.** It retains
full literal request bodies — which are projections of V4–V8 — for 25 MB, inside the workspace,
surviving deletion of the underlying nodes. `37` §7.5 catches the retention consequence. Nobody
catches the *concentration* consequence: an attacker who obtains the workspace gets, in one record,
a pre-assembled, machine-readable, already-projected description of the estate, without having to
walk the graph. That is a small argument for making the log's default `Evicted { digest }` after
some short window rather than at 25 MB — and it cuts directly against `21` §8.6's DECISION, which
is why it needs stating rather than assuming.

---

## 6. Redaction on ingest — theatre or not?

**Not theatre.** `14` §9.9 is the correct answer to the question and it gets there by refusing the
marketing answer first: *"redaction is **not** a confidentiality control… What it is: a retention
control. It changes the secret's lifetime from indefinite to the duration of one ingest."* The
seven-row table of where credentials actually leak (workspace, git history, sync ciphertext, field
history, exports, backups, support bundles) is the right argument, and it is the one that is true.

The structural enforcement is real, not procedural:

- `SecretPlaceholder` has no constructor from arbitrary text (`11` §4.5)
- `CaptureStore::insert` takes a `RedactedCapture` newtype only the gate can construct
- **the `secret:` dictionary flag *is* the redaction catalogue** — one list, not two, so parser and
  redactor cannot diverge

That last one is the thing that makes the claim auditable in an afternoon, which is `14` §9.9's
second argument and it is correct.

Three criticisms.

**6.1 — Recall is not 1.0 and the document says so, but the UI does not.** `14` §9.10 tags
*"redaction bypassed by an uncatalogued statement"* as **partly** mitigated. The ingest report
(`14` §9.8) says *"Nothing above is in this workspace"* — which is true of what it lists, and reads
to a user as a completeness claim about what it did not list. Add one muted line: `we catch what we
know and what looks like a secret. we do not catch everything.`

**6.2 — The PAN-OS catalogue is unverified and the document knows it.** `14` §9.3's `VERIFY`:
*"An unverified path in this table is a credential that reaches the store."* Four of five PAN-OS
rows are written from familiarity. This is correctly marked and must not ship marked.

**6.3 — The claim that survives is narrower than invariant 3's wording.** Invariant 3 says the
application *"never accepts a credential"*. It does accept one — for the duration of a paste — and
`14` §9.9's own imperative says so: `FATHOM DOES NOT KEEP YOUR KEYS. IT STILL SEES THEM FOR AS LONG
AS THE PASTE TAKES.` `32` §21.3's proposed replacement gets this right (*"Parsed captures are
redacted before storage, and the unredacted text never reaches the encryptor"*). `31` §14.1's
proposed replacement does not. See §10.1 below.

---

## 7. Browser hardening — what CSP cannot deliver

`34` is the second-strongest document. §1.1's concession, §2.11's list of what CSP does not stop,
§4.6's *"anyone who describes this as a defence against XSS is wrong"*, §7.3's precise separation of
what a worker bounds from what it does not, and §9.4's decision to render no external links at all
— all correct, all stated with the gap next to the control as §1.5 promises.

It does not promise things CSP cannot deliver. It has one hole and one unpriced channel.

### 7.1 `img-src 'self'` in modes C/D is an egress channel to the server the model calls untrusted

Modes C and D set `img-src 'self' data:` and `connect-src 'self'`. `'self'` is the application
origin, which in modes C and D **is the sync service** — the component `31` §4.1's diagram labels
`SYNC SERVICE — UNTRUSTED BY DESIGN`.

So after an XSS in mode C (a real, in-scope threat: `31` §5.1 row 16, `31` §8.1 A2.5), the payload
does not need `sandbox`, does not need a navigation, and does not need a third-party origin:

```js
new Image().src = '/' + btoa(plaintextGraph);   // permitted by img-src 'self'
```

and the plaintext lands in the sync service's HTTP access log, in the clear, at a party the
architecture explicitly does not trust. `34` §2.7 makes exactly this argument about `img-src` and
then reasons only about *foreign* hosts. `34` §2.4 says the step from `'none'` to `'self'` *"is not
a weakening of the confidentiality claim"* — it is, in the XSS case, because the origin on the other
end is adversarial in this threat model in a way `'self'` normally is not.

> **Fix:** `fathom serve` and the mode C/D server must return `404` for any path not in the built
> asset manifest (`34` §3.6 already specifies exactly this for mode B — extend it) **and must not
> log request paths for non-manifest paths**. Better: state the residual. It is `material` and it is
> currently absent from `34` §11.

### 7.2 The `sandbox`-on-a-top-level-document argument is load-bearing and unverified

`34` §2.11 closes egress channels 1 and 2 (top-level navigation, `window.open`) with the `sandbox`
directive, and rebuts the standard objection correctly: the *attribute*-on-an-iframe removal trick
does not apply to a header-delivered policy with no attribute to rewrite.

But the four-part `VERIFY` at §2.11 is unresolved, and B3's own text says that if it fails, channels
1 and 2 are `material` **everywhere**, including modes B–D. `34` §3.3's entire artifact split, `43`
§3.4's re-evaluation, and `36` Q40's answer to an air-gapped customer all rest on that verification.
It is the highest-value open measurement in the corpus and it is one afternoon of work.

Sub-risk nobody names: `sandbox` without `allow-popups` plausibly blocks `showSaveFilePicker`'s
picker, and `showSaveFilePicker` is `32` §13.1's *only* good save path. If (c) in the VERIFY fails,
mode B loses the File System Access save and falls back to `workspace (14).fathom` in Downloads —
which `32` §13.1 already calls *"genuinely poor"*.

### 7.3 The single-file decision is forked three ways and one fork is already a customer promise

| Document | Position |
|---|---|
| **Owner brief §1** | *"Deployable as a single offline file, a Docker single-node, or a load-balanced enterprise cluster."* The single file is a deployment of the product. |
| **`34` §3.3** | **DECISION** — the single file holds *"no workspace, no passphrase entry, no envelope code, no ciphertext"*. Reference content only. |
| **`43` §3.5** | **PROPOSED CHANGE to `34` §3.3** — the single file is *"a complete product for one session"*, holds a workspace in memory, uses no browser storage at all. |
| **`36` §1.3, Q39, Q40** | States `34`'s position **as settled fact** to a customer: *"Mode A — Holds a workspace? **no**"*, and answers the air-gap question with the capability loss. |

`43` §3.5's argument is the better one — it satisfies `34`'s own rule (*"we do not put a secret
behind a policy we cannot deliver"*) exactly, because with no browser storage there is no secret at
rest behind the undeliverable policy, and it answers the cost `34` §3.4 concedes is unanswered. But
that is not the finding. The finding is:

1. **`36`, the document a customer reads, has committed to one side of a live fork**, and answers
   Q40 by telling an air-gapped defence customer they must get a binary through change control —
   in the segment brief §2.4 identifies as the differentiated market.
2. **`34` §13.2 raises the change against `21`, `24` and `32` but not against the owner brief**, and
   `conventions.md` requires a contradiction of the brief to be *"called out explicitly as a
   proposed change with reasoning"*. Removing the workspace from "a single offline file"
   contradicts brief §1 directly.

> **Fix:** resolve the fork before `36` is shown to anyone. My read: take `43` §3.5, keep `34`
> §3.3's masthead phishing control in `43`'s reworded form, and record the two extra post-XSS
> channels as a `material` residual specific to mode A rather than removing the capability.

---

## 8. The enterprise Q&A, read as a hostile reviewer

Would a competent enterprise security reviewer accept `36`? **Most of it, yes, and they would be
impressed by §1.4, Q24, Q26, Q40 and Q54.** Saying *"if your threat model excludes browsers and also
excludes running a signed binary, we have nothing for you"* in the first meeting is the right move
and almost nobody makes it. Q12's forty-minute procedure and Q17's five-minute procedure are exactly
what a reviewer wants and cannot usually get.

Four answers would not survive.

### 8.1 Q9 — crypto-erasure. Evasive *and* wrong. (F2)

Covered in §1. The claim is false, it contradicts `32` §9.2, and it is offered as the *better* of the
two answers to a deletion question. `37` §7.4's legal hedging is careful and irrelevant, because the
technical premise beneath the hedge is untrue: you cannot crypto-erase a backup that contains the
wrapping of the key you are destroying.

> **Fix:** Q9's second answer becomes: *"Crypto-erasure is not available against a backup that
> contains the keyholder record, which every backup of a workspace does. What is available is
> deletion of the replica (`33` §2.8) plus the honest statement that the original is on your
> endpoints and in your repository."* And `37` §7.4 is rewritten, not re-hedged.

### 8.2 Q14 — "What does the server learn that you are not telling us about? Nothing withheld." Incomplete. (§4.2)

Two channels exist that are not in the list, one of them at record granularity with per-author
timing. An answer that opens with *"nothing withheld"* and is then shown to have withheld two
channels costs more than the channels do.

### 8.3 Q12 step 10 — the published verification procedure fails against `17`'s format

*"Inspect the wire… `POST /v1/w/{wid}/frames` body | **high-entropy bytes**; the header fields are
exactly the ones `33` §2.6 lists and no others."*

Under `17` §5.1 a frame body is preceded by a 69-byte header containing a plaintext ASCII magic, a
plaintext wall-clock millisecond timestamp and a plaintext actor pseudonym. A reviewer running
step 10 will see structured, low-entropy, obviously-non-random bytes and will ask why. The honest
answer (`17` §5.4: to make `git merge` keyless) is a good answer. Discovering it at step 10 of a
procedure that predicted high entropy is the worst way to deliver it.

### 8.4 Q11 — the "four statements" are true of a design that is not decided

Q11's second row cites `17` §5.2 (frames) for the AEAD claim while `36` Q52 cites `32` for the
encryption description. One document, two formats, in answers eight sections apart. See F1.

### 8.5 Answers that are fine and should not be softened in review

Q2, Q4, Q5, Q6, Q10 (including the warrant-canary refusal, which is correct and correctly argued),
Q13's flat **No**, Q15, Q16, Q18, Q20, Q24, Q25, Q26, Q34's *"we do not know and we will not answer
on a provider's behalf"*, Q42's *"You do not, and this is a genuine gap"*, Q44, Q48's two
unacceptable NDA clauses, Q51, Q53, Q54, Q55's distinction between a category error and a real gap.
That is a strong document. It needs four fixes, not a rewrite.

---

## 9. The overclaim register — every one found

The project's positioning is "security-first", so this is the list that matters. Ranked by damage.

| # | Overclaim | Where | Why it is one | Fix |
|---|---|---|---|---|
| **O1** | *"Rotating the root key renders every prior ciphertext undecryptable by anyone, including the customer… the key material no longer exists"* | `37` §7.4; `36` Q9 | False. The epoch-`e` keyholder record in every backup still wraps `RK_e` under the unchanged passphrase. Contradicts `32` §9.2 | Rewrite; see §8.1 |
| **O2** | *"Workspace encryption is symmetric and not broken by a quantum adversary"* | `31` §10.1 | True single-user, false for every shared workspace (X25519 HPKE wrap). Contradicts `32` §10.7. Worst possible location — the "what we do not claim" table | Qualify per §3.6 |
| **O3** | *"Nothing withheld — `31` §7.2 enumerates ten channels"* | `36` Q14 | Two channels missing (`kind_opaque`, per-frame HLC+actor) | Add M11/M12 |
| **O4** | The offline-guess table presented at `CAP` when the proposed default is `FLOOR` | `32` §4.6 | 5.3× (2.4 bits) too favourable for the shipping default | Print both; floor first |
| **O5** | *"`commit_tag` … authenticated so that altering it fails at the MAC as well as at the constant-time compare"* | `32` §7.2 | The compare returns first; the MAC never runs | Fix ordering per §3.1 |
| **O6** | *"CSP `connect-src`/`form-action` + link discipline"* closes the link-exfil channel | `23` §6.1 C3, §6.3 heading | A navigation is not a fetch. `34` §2.11 and §9.4 say so | Remove the CSP attribution |
| **O7** | *"the step from `'none'` to `'self'` is not a weakening of the confidentiality claim"* | `34` §2.4 | In modes C/D, `'self'` is the untrusted-by-design sync origin, and `img-src 'self'` is a post-XSS exfiltration channel into its access log | State the residual; harden the server |
| **O8** | *"Mode A — Holds a workspace? no"* stated to a customer as fact | `36` §1.3, Q39, Q40 | A live fork (`43` §3.5) and a contradiction of brief §1 | Resolve the fork first |
| **O9** | *"Nothing in that tree names a device, a site, a customer, a peer, a VPN or a zone"* | `17` §3 | Correct as written and misleading by omission: the keyholder descriptor names *people*, in the clear | Seal `label`; amend the sentence |
| **O10** | *"only redacted text ever arrives here"* + *"Nothing above is in this workspace"* | `14` §9.1, §9.8 | True of the catalogued set. `14` §9.10 concedes recall < 1.0; the UI does not | One muted line in the report |
| **O11** | *"The application never accepts a credential"* | `conventions.md` invariant 3 | Contradicted at tier 1 (provider API key), by the account credential (`33` §3), by four workspace secrets (`32` §21.3), and for the duration of a paste (`14` §9.9). Four documents propose four different repairs | Adopt one text; see §10.1 |
| **O12** | *"Padmé bucket assertion — fails when any envelope's total length is not `padme(length)`"* | `32` §18 | Cannot pass, because §6.4's arithmetic omits `aad_ext_len` | Fix the arithmetic |
| **O13** | *"the manifest's per-record frame count and set digest"* replaces the hash chain for truncation detection | `17` §5.3 | The manifest is not committed (`17` §3, §7.4), so in the git shape there is no replacement | Decide; see §3.4 |
| **O14** | *"Verify the manifest digest eagerly"* presented as preserving integrity | `44` §4.8.3 move 5 | Verifies the digest *list*, not the records. `32` §8.1's missing/extra-record checks do not run | Verify record digests eagerly |
| **O15** | *"Four actors have a full row of `◆`"* | `31` §3.2 | Five do. And three actors are missing from the matrix entirely | Fix the table and the count |
| **O16** | Residual tags that disagree between `31` §5.1 and `31` §11 (rows 16, 18) | `31` | A register that contradicts its own source table | Reconcile |

**O11 deserves its own paragraph**, because it is the invariant most quoted and the one in the worst
shape. Four documents now propose four incompatible repairs:

| Document | Proposal |
|---|---|
| `31` §14.1 | *"Exactly two secrets exist in the product… No third secret may be added without amending this invariant."* |
| `32` §21.3 | Supersedes `31` §14.1; enumerates six workspace secrets plus one transmitted secret |
| `33` §18.3 | Adds a **third** category — the sync account credential — which `32` §21.3 does not know about and which its own wording therefore forbids |
| `14` §9.9 | Establishes that the application *does* accept a real credential, transiently, on every paste |

`32` §21.3's text is the best of the four and is **already stale**, because it was written without
`33`'s account credential. The convention's own procedure has worked exactly as designed — every
author raised the objection instead of deviating silently — and now nobody has closed it. That is
the governance failure, not a documentation failure, and it is the cheapest thing on this list to
fix.

---

## 10. Internal inconsistencies, small and concrete

| # | Inconsistency |
|---|---|
| 1 | **Four proposed rewrites of invariant 3** (§9, O11). One must be adopted. |
| 2 | **Two proposed rewrites of invariant 1** — `34` §13.1 (add `sandbox` and the per-directive allowlist) and none elsewhere; adopt it, because §7.1 above shows the current wording is actively misleading. |
| 3 | **`31` §14.3 invents the `none/bounded/material/total` scale and asks for it to be pinned.** Three later documents use it (`32`, `34`, `36`). Pin it in `conventions.md` — it has already been adopted by consensus and only the convention is missing. |
| 4 | **`32` §21.1, `34` §13.3 and `17` all need a word for the unit of encryption and the on-disk bytes.** Three proposals, no adoption. |
| 5 | **File extensions and layout**: `32` §13.2 says `.fenv`, `nodes/00.fenv…3f.fenv`, `00-manifest.fenv`. `17` §3 says `.frec`, `.fcap`, `records/2a/<ulid>.frec`, `manifest.fm`. Same product, two trees. |
| 6 | **Shard counts**: `32` D6 `S_nodes = 64`, `S_edges = 16`. `17` §3 has 1 024 lazily-created buckets over per-device records. `44` §4.8.6 proposes device-sharding as a *change* to `32` — which is what `17` already specifies. |
| 7 | **Single-file size**: `43` §3.2 lands at 5.4–10 MB; `35` §13.2's worked output prints `SIZE 28,114,552`; `16` §9.4 assumes "tens of megabytes". `43` names the discrepancy and does not resolve it; the number appears in published material. |
| 8 | **`21` §7.5's mode A policy has `img-src 'self' data:` / `font-src 'self' data:`** under an opaque origin where `'self'` matches nothing. `34` §2.2 proposes the fix; `23` §6.2 then cites the *unfixed* policy as the control closing C2. |
| 9 | **`34` §1.4 cites `23`'s catalogue as C1–C9; `23` defines C1–C6.** |
| 10 | **`31` §5.2 row 5's replay control is "a monotonic version counter"; `32` §8.2's is a version *vector* with an incomparability case.** The first is a special case of the second and reads as a different design. |
| 11 | **`32` §4.5 puts the Argon2 arena in a terminable crypto worker; `44` §4.8.3 move 2 pre-grows and first-touches the arena "before submit"**, on a worker that by `32`'s design is spawned at unlock. Reconcilable, but not reconciled. |
| 12 | **`32` §11.1's recovery keyholder is re-wrapped at every epoch bump** (`32` §9.3 step 3), so the printed paper survives the revocation performed because someone left. §11.1's footgun table does not list this. |

---

## 11. What I could not check

Stated so this critique is held to its own standard.

- **No web access was available in this session**, so every external citation was checked against
  recall rather than against the source. The ones I am confident are correct: RFC 9106 §4's two
  parameter options, RFC 8439 §2.8, RFC 5869 §2.2/§2.3, RFC 9180's three codepoints, RFC 6598's
  `100.64.0.0/10`, RFC 8247 §2.4 on group 14 MUST / groups 2 and 5 SHOULD NOT, the Crockford
  alphabet, Padmé's bounds, Len–Grubbs–Ristenpart, the WebAuthn PRF salt construction, CSP3's
  four `<meta>`-discarded directives, and the RIPA s.49/s.53 penalties. **The ones I could not
  confirm and which should be checked before any external use:** that OPAQUE is RFC 9807 and was
  published in July 2025 (`33` §17); the WebAuthn PRF platform-support matrix in `32` §12.3,
  including KB5077181 and the Chrome/Edge 147 and Firefox 148 version numbers; the Trusted Types
  Baseline date in `34` §12; `Integrity-Policy` support; and every crate version in `32` §15.1.
  All of these already carry `VERIFY` markers, which is the correct state.
- **The Argon2 timing model in `32` §4.6 is modelled, not measured**, and says so. Its own `VERIFY`
  is the right instruction. I have not attempted to re-derive the GPU bandwidth figures.
- **`35` and `37` were read in outline, not in full.** `35`'s reproducible-build and signing story
  and `37`'s Article 28/30 analysis deserve their own lens; the only finding I carry from them is
  O1, which is a crypto claim inside a privacy document.
- **`22` (agent catalog), `25` (AI evaluation), `12` (rule engine §13's signing chain)** were not
  read. The rule-pack signing gap — *"a signature bounds who, never what"* — is asserted
  consistently across `31`, `34`, `35` and `36` and I have taken it on trust.

---

## 12. What should happen before anything else

In order, because the order matters.

| # | Action | Why first |
|---|---|---|
| **1** | **Pick one workspace format.** `32`'s envelope or `17`'s frames. Everything downstream — `33`'s wire format, `36`'s verification procedures, `44`'s open-path budget, `43`'s size budget — is derived from a choice nobody has made. | F1. Until this is resolved, six documents specify a product that cannot be built. |
| **2** | **Delete the crypto-erasure claim from `36` Q9 and `37` §7.4.** | F2. It is false, it is customer-facing, and it is a one-paragraph edit. |
| **3** | **Adopt one text for invariant 3, and pin the residual scale.** | O11 and §10.3. The convention's procedure produced four correct objections and no decision; that is the failure. |
| **4** | **Resolve the single-file fork before `36` is shown to anyone.** | §7.3. `36` has already promised a customer one side of it. |
| **5** | **Run `34` §2.11's four-part `sandbox` VERIFY.** | One afternoon. Three documents' residual tags depend on it. |
| **6** | **Restate `32` §4.6's table at the floor configuration.** | §3.3. One table edit removes a 2.4-bit presentation overclaim. |
| **7** | **Fix `32` §3.2's commitment ordering and §6.4's Padmé arithmetic**, and add both to `§16.2`'s negative vectors. | §3.1, §3.2. Both are small, both are CI-visible, and one of them currently makes tampering indistinguishable from a typo. |

Nothing on that list is a redesign. The cryptography is sound where it is decided; the threat model
is honest where it is complete; the AI boundary holds. **The corpus's failure mode is not
softness — it is that seven careful authors each solved their own problem correctly and no one
owns the seams.** Item 1 is the seam that matters.

---

## 13. Disagreements

Raised under the conventions' own procedure.

### 13.1 `conventions.md` needs a rule about which document wins

The conventions pin terminology, invariants, scales and identifiers, and say nothing about
precedence between two documents that both obey them and still disagree. F1, F3, §7.3 and §3.4 are
all instances of the same missing rule.

**Proposed addition**, under a new heading:

> **Precedence.** Where two documents specify the same artifact, exactly one is the **owner** of
> that artifact and every other document references it rather than restating it. The owner is
> named in the artifact's own document header. A document that needs to change something it does
> not own raises a `## Disagreements` entry and **may not ship a second specification in the
> meantime**. Ownership, as of now: the workspace container format and all key material —
> `30-security/32`. The on-disk tree, the record taxonomy and git behaviour — `10-core/17`. The
> wire — `30-security/33`. The browser platform — `30-security/34`. Where `17` and `32` currently
> disagree, `32` wins on cryptography and `17` wins on layout, and neither may specify the other's
> half.

### 13.2 `conventions.md` invariant 9's determinism should exclude the AI egress log

Invariant 9 requires byte-identical output for the same workspace + corpus + build. `21` §8.6's
egress log is *in the workspace* and is not reproducible (`21` §9.1: `Session::reproducible` is
always `false`). A CI check written literally against invariant 9 over a workspace that has used
tier 1 will compare log bytes and fail.

**Proposed second sentence to invariant 9:**

> Determinism is a property of *emitted* artifacts — config, findings, finder ranking, exports.
> The AI session log and the egress log are quarantined records: they are inside the workspace, they
> are never inputs to an emitter, and they are excluded from every determinism assertion.

### 13.3 The residual scale should be pinned, unchanged, as `31` §14.3 asks

`none | bounded | material | total` has been adopted verbatim by `32`, `34`, `36` and `37` without
anyone changing it. It is a convention in practice. Write it down before a sixth document invents a
fifth value.
