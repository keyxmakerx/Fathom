# ADR-0014 — Envelope and KDF corrections: commitment ordering, Padmé arithmetic, sealed labels, device floor

> **Status:** Accepted
> **Date:** 2026-07-28
> **Register entry:** new — raised by `81` §2.2.2, §3.1, §3.2, §3.3, §3.5, §3.7
> **Reversal cost:** R3 for the envelope changes (they change bytes); R0 for the KDF default
> **Supersedes:** `32` §3.2's error ordering, §6.4's padding arithmetic, §7.4's cleartext label

## Context

`81` §3 assesses `32-cryptography.md` as the strongest document in the corpus — the primitive choices
are defensible and every citation the reviewer could check is correct. Four specific things in it are
wrong, and each is small, CI-visible and consequential.

**1. The commitment check inverts the error taxonomy it exists to fix.** `32` §3.2 opens a record by
comparing the derived commitment tag against the header **before** the AEAD runs and returning
`WrongKey` on mismatch. `commit_tag` is correctly not in the HKDF `info`, so flipping one byte of it
does not change `K` — it fails the compare and returns `WrongKey`, and the AEAD is never reached.
`32` §7.2 claims the opposite: that altering `commit_tag` *"fails at the MAC as well as at the
constant-time compare"*. It never fails at the MAC.

The concrete failure: a hostile sync operator, a hostile git committer, or one bit of rot in a
`commit_tag` byte produces *"wrong passphrase"* for a user whose passphrase is correct. §3.2's own
justification for the ordering is *"telling a user 'the file is corrupt' when they mistyped their
passphrase is how support tickets are made"* — and the design produces the exact inverse, which is
worse, because the user's response to "wrong passphrase" is to try harder rather than to restore from
backup. §16.2's negative-vector table has no row for a mutated `commit_tag`, so CI would not catch it.

**2. `pad_plaintext` ignores `aad_ext_len`.** `32` §6.4 computes
`padme(112 + 4 + body.len() + 16)`, but the envelope is `header(112) ‖ aad_ext ‖ ciphertext` (§7.1),
and every keyholder envelope has `aad_ext_len > 0`. Total envelope length is therefore
`padme(...) + aad_ext_len`, which is not a Padmé bucket — so `32` §18's *"fails when any envelope's
total length is not `padme(length)`"* and `31` §12's uploaded-blob check both fail on the keyholder
record on day one, and an implementer will "fix" it by weakening the assertion.

**3. The keyholder `label` is cleartext personal data.** `32` §7.4's `KeyholderDescriptor` carries
`pub label: String` — *"Kate's laptop"*, *"printed code in the safe"* — as the `aad_ext`, readable
before any key exists. It is therefore in every copy of the workspace: on the sync server, in every
git commit, in every backup, in the packed file you mail to a colleague. `32` §6.5's "what still
leaks" table lists *"the keyholder count"* and stops. `31` §7.2's M1–M10 has no channel for it. `17`
§3 claims *"nothing in that tree names a device, a site, a customer, a peer, a VPN or a zone"* —
true, and it does not say *nothing names a person*. Second-order: because `aad_ext_len` is the
unpadded length of a descriptor containing free text, **the envelope length leaks the label length**.

**4. The headline offline-cracking table is computed at a configuration that will not ship.**
`32` §4.6's table — the one an enterprise reviewer reads and `36` Q5 leans on — is at `CAP`
(256 MiB, t=4). `44` §4.8.4 proposes, with an argument this ADR accepts, that the default becomes
`DeviceFloor::AnyDevice`, pinning `m` at `FLOOR` (64 MiB, t=3). §4.6 handles it in one sentence after
the table and never restates it. The numbers a reviewer quotes back are ~5.3× (≈2.4 bits) too
favourable for the shipping default.

## Decision

**Four corrections, plus two smaller ones, all landing in `32` with matching CI vectors.**

1. **On a commitment mismatch, run the AEAD anyway and branch on its result.** MAC fails ⇒
   `Tampered`; MAC succeeds ⇒ `CommitmentMismatch`, a distinct nameable state. Constant time is
   irrelevant here — the attacker already has the ciphertext. Both states join `32` §16.2's negative
   vectors, alongside a new vector for a mutated `commit_tag`. Cost: one wasted AEAD open on a
   genuinely wrong passphrase, which is microseconds against a one-second KDF.

2. **`padme(112 + aad_ext_len + 4 + body.len() + 16)`**, and the CBOR descriptor is padded to a
   fixed width per `KeyholderKind` before it becomes `aad_ext`.

3. **`label` moves inside the sealed `KeyholderSecret`.** The descriptor keeps only the opaque `id`
   and `kind`. The UI renders labels after the first successful unlock and renders `id` before it.
   This costs one round of trial decryption in the multi-passphrase case, which `32` §7.4 already
   accepts. `17` §3's sentence is amended to say what it now truthfully can.

4. **`DeviceFloor::AnyDevice` is the default, and `32` §4.6's table is restated with floor columns
   printed first**, because that is what ships:

   | Passphrase | As printed (CAP) | At the shipping default (FLOOR) |
   |---|---|---|
   | memorable sentence, ~30 bits, 10⁴ GPUs | 15 hours | **≈2.9 hours** |
   | memorable sentence, ~30 bits, 10⁶ GPUs | 9 minutes | **≈1.7 minutes** |
   | strong human-chosen, ~40 bits, 10⁶ GPUs | 6 days | **≈27 hours** |

   `44`'s second argument is correct and under-appreciated: a four-second unlock is not a neutral
   security property. `31` §5.1 row 19's residual is `material` either way, so nothing else changes.
   The generated-passphrase path stays the default, per `32` §4.7's own conclusion that *"Argon2id
   multiplies the attacker's per-guess cost by a constant. It does not add bits."*

5. **Eager record-digest verification, deferred Poly1305.** `44` §4.8.3's move 5 defers per-record
   AEAD above 30 records and verifies *"one BLAKE3 over the digest list"* — which proves the *list*
   is intact and not that the *records* match their digests, so `32` §8.1's `MissingRecord` and
   `ExtraRecord` checks do not run. Instead: eagerly verify each envelope's BLAKE3 digest (cheap,
   keyless, parallelisable, ~1 GB/s) and defer only Poly1305.

6. **AND-mode keyholders require a printed recovery code as a constructor precondition**, not in
   prose (`32` §12.2), and `32` §11.1's footgun table gains the case `81` §3.7(a) found: the recovery
   code bypasses the KDF and is re-wrapped on every epoch bump, so **removing a member re-arms the
   printed paper against the new epoch**. A departed admin who photographed the safe's contents
   retains access across the revocation performed because they left.

## Consequences

### Positive

- Tampering stops being indistinguishable from a typo, in the one code path where that distinction
  decides whether a user restores from backup or keeps typing.
- Two CI checks that could never pass — `32` §18's Padmé assertion and `31` §12's blob-length check —
  start passing, so they become real controls rather than assertions somebody will weaken.
- A personal-name disclosure that appeared in no leak register is closed, and `37` stops having
  cleartext personal data at the processor.
- The number an enterprise reviewer quotes back matches the product they will run. `81` §3.3 is right
  that a 2.4-bit presentation overclaim found in the room is the kind that ends a meeting.

### Negative

- **The honest KDF table is much less impressive.** *"1.7 minutes"* against 10⁶ GPUs for a memorable
  sentence is a number that will be read aloud in a security review, and the answer — *"use the
  generated passphrase, which is why it is the default"* — is correct and sounds like a deflection.
  This decision trades a comfortable table for a true one and the cost is paid in meetings.
- **A lower KDF floor is genuinely weaker.** `DeviceFloor::AnyDevice` is a real security reduction
  chosen for reach and unlock latency. Users on capable hardware get less protection than their
  hardware could provide unless they opt out, and most will not know the setting exists.
- **Sealing the label costs usability at the worst moment.** Before unlock the keyholder list reads
  as opaque IDs, so a user staring at a recovery screen cannot tell which entry is their laptop and
  which is the paper in the safe. Recovery UX is already the hardest surface in the product and this
  makes it harder.
- **Trial decryption across keyholders scales with the keyholder count**, and each attempt is a
  one-second KDF at the floor. A workspace with eight keyholders and a passphrase user at position
  eight waits eight seconds. `32` §7.4 accepts this; it is still a real cost that grows with team
  size.
- **Changing the envelope changes bytes.** Every one of these is R3 if a workspace already exists,
  which is why they must land before phase 1's compatibility promise (ADR-0013).
- **Eager digest verification undoes part of `44`'s open-path budget.** Move 5 existed to hit a
  latency target and this ADR takes half of it back.

## Alternatives considered

| Option | Strongest argument for it | Why rejected |
|---|---|---|
| **Keep the commitment check first and rename the error** | Constant-time comparison first is the textbook ordering, and returning early is cheaper | The cost being saved is microseconds against a one-second KDF. The information being destroyed is whether the file was tampered with, which is the thing the commitment exists to establish |
| **Weaken the Padmé CI assertion to exclude keyholder envelopes** | One line, and the leak is a label length | It is the fix an implementer reaches for and it is why the arithmetic must be corrected instead. An assertion with an exception is an assertion nobody trusts, and the label-length leak compounds with the cleartext label |
| **Keep `label` cleartext and document the leak** | Recovery UX stays legible, and the leak is names the user chose to write | It is personal data, in the clear, at the processor, in every backup, in a product whose entire claim is that the server learns nothing. `37` cannot answer a DPO's question about it |
| **Keep `CAP` as the default (reject `44` §4.8.4)** | The table stays true as printed and the security is genuinely higher | A four-second unlock on a mid-range laptop is a usability failure that pushes users toward shorter passphrases, which loses more entropy than the KDF gains. `44`'s argument is right; only its presentation consequence was missed |
| **Publish only the floor table and drop the cap columns** | Simpler, no chance of the wrong number being quoted | The cap configuration ships as an option and reviewers with capable hardware will ask. Both columns, floor first, is the honest presentation |

## Revisit if

- Measured Argon2id timings on the reference device (`44` REF-1) differ materially from `32` §4.6's
  model, which is explicitly modelled rather than measured and carries its own `VERIFY`.
- Trial-decryption latency at eight or more keyholders becomes a reported complaint — the sealed
  label's cost is being paid by the wrong users and a per-keyholder salt hint becomes arguable.
- `CommitmentMismatch` fires in the field on non-hostile data, which would mean the commitment
  construction is over-tight rather than the ordering being wrong.
