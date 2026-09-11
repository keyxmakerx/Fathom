# Phase 2 — Storage, keys and the vault

**Status:** REVISED AFTER ATTACK, 2026-09-11. Not accepted. Not built.
**Review:** `PHASE-2-ATTACK-REPORT.md` — 6 lenses, 36 findings, 20 survived verification, 16
refuted. 5 blockers, all addressed below. 7 majors, tracked in §10.
**Binding inputs:** ADR-0040 (key custody), ADR-0042 (the credential vault), the owner's answers
of 2026-09-11 (scoped live presence, Docker, security is the headline bar).

This document exists to be attacked before anything is written to a database. Every section states
what it chooses **and what it gives up**, because a design that only lists its strengths cannot be
reviewed.

---

## 1. What we are storing

Four separable things, deliberately not sharing keys or tables:

| | What | Sensitivity |
|---|---|---|
| **Identity** | Users, organisations, membership, roles | Low — must be queryable |
| **Structure** | The scope hierarchy: org → network → building → rack | Low — must be queryable |
| **Designs** | The graph itself: devices, links, positions, everything drawn | **High — this is the map** |
| **Vault** | Device credentials | **Highest — separate everything** |

The reasoning for treating designs as high: a complete picture of an enterprise's internal network
— addressing, zones, tunnel endpoints, what connects to what — is the thing worth stealing. The
credentials are a small part of the value and are handled separately anyway.

---

## 2. The scope hierarchy

`organisation → network → building → rack`, as the owner described it, with designs attached at a
scope and presence scoped to the node being viewed.

**Choice:** store it as a materialised path (`ltree` or a text path column) rather than parent
pointers alone.

**Why:** presence subscription asks *"who else is at this exact node"* and permission asks *"does
this user have rights at or above this node"*. Both are prefix questions. A path answers them in
one indexed comparison; parent pointers need a recursive walk on every presence event.

**Given up:** moving a subtree rewrites every descendant's path. Acceptable — reorganisations are
rare and bounded by an estate's size, not a customer base's.

**Open:** the hierarchy is fixed at four levels here. Real estates have campuses, floors, rooms,
and multi-site organisations. A fixed depth will be wrong for someone. A variable-depth path costs
nothing extra now and cannot be retrofitted cheaply. **Recommend variable depth.**

---

## 2a. WHO ENCRYPTS — the ambiguity the review found

The original draft never said this, and two reviewers had to infer it from ADR-0040. Stated now:

**Design data is encrypted by the SERVER.** The client sends plaintext over TLS; the server runs
the ingest gate on it, then encrypts, seals and stores. This follows ADR-0040 D1, which explicitly
rejected browser-held keys for design data.

**Consequences, stated rather than implied:**

- Plaintext designs exist in the server process on every read and write. "The server decrypts
  nothing it does not have to" is a statement about search and rendering, **not** a claim that the
  server cannot read your designs. It can. Encryption protects the database, the backups and the
  disk — not the running process.
- Because of this, live collaboration works normally: the server can broker edits it can read. The
  feared conflict between scoped presence and encryption does not exist.
- The server-side ingest gate has somewhere to run, which is what makes ADR-0040's union rule
  meaningful on the write path.

**Mode A vault entries are the sole exception** — those are encrypted in the browser and the server
genuinely cannot read them.

Nothing customer-facing may describe design data as unreadable by Fathom. ADR-0040's four
forbidden sentences apply here directly.

## 3. What is encrypted, and what that costs

**Choice:** the design payload is encrypted as a whole. The database stores an opaque blob per
design version plus queryable metadata (tenant, scope path, design id, version, timestamps,
author, size).

**Why this and not per-field encryption:** partial encryption leaks structure. If device names are
encrypted but link counts, node counts and edge types are not, an attacker with the database
learns the estate's shape without decrypting anything. The map *is* the secret; encrypting it
piecemeal protects the labels and gives away the drawing.

**What we give up, stated plainly:**

- **No server-side search.** The server cannot answer "which designs mention 10.1.1.0/24" without
  decrypting, and by design it decrypts nothing it does not have to.
- **No server-side rendering**, ever. The client renders.
- **Cross-design queries are impossible** without a separate, deliberately built index.

**Why this is acceptable at Fathom's stated scale:** thousands of devices per design is a payload
measured in megabytes. The client already holds a whole estate in memory and searches it there —
that is what the finder does today. Search stays a client capability.

**Where it breaks:** an organisation with hundreds of designs wanting to search across all of them.
That is a real future requirement and this design does not serve it. The honest options later are
an encrypted search index or a per-tenant searchable subset, and both are their own project.

**This is the section most likely to be wrong. Attack it first.**

---

## 4. Keys for design data

Follows ADR-0040 unchanged.

```
master key (from a provider chosen by deployment config)
  └─ wraps → tenant key (one per organisation)
       └─ wraps → design key (one per design)
            └─ encrypts → design payload
```

**Master key providers**, chosen at deployment, all behind one interface:

1. A file the database role cannot read (default for self-hosted Docker)
2. An operator-supplied secret at container start
3. An external key service

**Why the two-level wrap:** custody changes by re-wrapping keys, never by re-encrypting data.
A customer moving to their own master key re-wraps tenant keys — seconds — rather than
re-encrypting every design.

**Requirement carried from WO-12:** re-wrapping under a differently-shaped provider must leave the
stored ciphertext **byte-identical**. If it does not, the wrap point is in the wrong place.

**B1 FIX — "wraps" and "derives" are not the same verb, and the draft used both.** As originally
written nothing bound a ciphertext to a tenant: rewrite `tenant_id` on a blob and its key row and it
decrypts cleanly for the wrong tenant, every tag verifying. Real derivation would fix that and
destroy the byte-identical re-wrap requirement, so the two readings were mutually exclusive.

Settled:

- Data keys are **random**, and **wrapped**. No identity in their derivation.
- Identity binds by sealing `aad_bytes || key` as the wrapped plaintext, with the AEAD's own
  associated-data channel **empty** for key seals. Unwrap returns the recovered AAD and compares it
  at exactly one code path. Unequal is `Misbound`; a failed tag is `Refused`. Two distinct errors,
  because WO-12 §4.1 already rejected putting identity in the associated-data channel — do not
  reintroduce it.
- Design-payload seals keep identity in `info` plus the AEAD.
- **The tenant key is pinned from the authenticated request context for the request's lifetime, and
  never taken from the row being read.** This is what actually preserves cross-tenant separation.
  The AAD binding buys distinguishable errors and catches design-id substitution within a tenant.
- §7's claim that layer 2 "has no such failure mode" is true only because of that pinning. It is
  now stated rather than assumed.
- Required test: delete a tenant filter from a real query and assert a loud failure, not silence.

**AEAD:** ChaCha20-Poly1305, already owner-approved. Fresh random 96-bit nonce per operation.

---

## 5. The vault — separate everything

Per ADR-0042. Three modes. The vault shares **no key, no table and no schema** with design data.

### Mode A — user-held (default)

```
user unlock passphrase
  └─ Argon2id → vault key (never sent to the server)
       └─ encrypts → secret, in the browser
```

The server stores ciphertext and cannot read it.

**Deliberate separation:** the vault key is derived from an unlock passphrase that is **not** the
login password, and never from the same derivation as the authentication hash. Sharing one secret
between "prove who you are" and "unlock the data" means the server sees the material it must not
have.

**B3 FIX — the draft claimed more than it earned, twice.**

1. Nothing stopped the vault passphrase simply *being* the login password, which the server receives
   in cleartext at every sign-in. Fix: compare the two **in the browser** at passphrase-set time and
   refuse a match. Never ship a verifier for the login password to the browser. **Preferred
   alternative: drop the second passphrase entirely and issue a Fathom-generated recovery key**,
   which removes the failure mode instead of policing it.
2. The same server serves the client. A compromised instance can ship JavaScript that captures the
   passphrase, and modes A and B collapse together on the next page load. Subresource integrity is
   not a control here, because the same server serves the page that declares it. The real controls
   are out-of-band signed releases with a published digest, and showing the running client's version
   and hash so a substitution is visible.

**Mode A's threat-model sentence goes in the interface beside mode B's:** protects a stolen database
or backup; does not protect against a running, compromised server. ADR-0042 §3 needs revising to say
what a *running* compromised instance yields, which it currently does not.

**Given up:** forgotten passphrase means unrecoverable entries. Must be stated at the moment of
storing, not in a help page.

**B2 FIX — sharing, which the draft had no answer for.** Without one, every credential more than one
person needs falls to mode B, and the vault Fathom cannot read ends up holding only what nobody uses.

- Each credential gets its own random content key.
- Each user holds an asymmetric keypair generated in the browser. The private key is stored on the
  server encrypted under that user's vault key.
- The content key is wrapped once per recipient. The server holds public keys and wrapped content
  keys, and no plaintext.

**Revocation is not cryptographic and must never be presented as though it were.** Someone removed
from a credential still holds what they already decrypted. The honest remedy is rotating the
password on the device, and the interface must say exactly that at the moment of removal.

**Design now for the gap:** a new colleague with no keypair yet cannot be a recipient. Silent
fallback to mode B is forbidden — the interface says the credential cannot be shared until they
have signed in once.

### Mode B — server-usable (opt-in, per credential)

Server holds the wrapping key; decryption is logged. Intended occupant: a read-only monitoring
account. Protects a stolen database or backup, **not** a compromised server. That sentence must
appear in the interface.

### Mode C — external vault

Fathom stores a reference; the secret lives in the customer's own store.

### Tokenisation, binding all three

The design graph holds `cred_<id>` and never a secret, in every mode. Exports, diagrams and
inventory rows carry the reference. A leaked design database yields reference numbers.

---

## 6. The tamper-evident history

Every change appends a record. Each record is sealed against its predecessor, so altering any past
entry breaks the chain from that point forward.

```
entry_n.seal = MAC( key_chain , entry_{n-1}.seal || entry_n.content_hash || entry_n.metadata )
```

**Choice: keyed, not a plain hash.** A plain hash chain is rewritable by anyone who can write the
table — recompute every seal forward and it verifies perfectly. A keyed seal cannot be forged
without the key, and the chain key is **not** the design key and is not held by the database.

**Choice: per design, not global.** Verification is then scoped to what you are looking at, and one
design's history can be exported and checked independently.

**B4 FIX — the draft's chain could be truncated or rolled back and still verify perfectly.** Each
seal binds backwards only, so deleting the last three entries leaves the survivors verifying end to
end, and restoring last month's tables produces a rollback the chain cryptographically endorses.
The draft admitted whole-design deletion and missed this.

Nothing inside the database detects it. What is required:

- **An anchor outside the deployment.** A periodic tip digest exported somewhere the database admin
  does not control — an emailed digest, a write-once path, or an external witness. This is the
  baseline, not an optional extra. A client-remembered tip covers nothing for a design nobody has
  reopened.
- **A monotonic sequence number in the MAC input.** Cheap, worth having — and it does **not** detect
  tail truncation. Recorded so nobody mistakes it for the fix.
- **Named responsibility:** who runs verification, how often, and what happens when it fails. An
  unverified chain is a log, not a control.

**B5 FIX — where the chain key lives, which the draft never said.** It must be live in the server
process on every write, so in a self-hosted Docker deployment the customer's own administrator can
reach it — and that administrator is exactly who the log exists to hold accountable.

- The chain key is **distinct from the master hierarchy**, sits behind the same provider interface,
  and never lives in PostgreSQL.
- **Scope it per design, derived from tenant and design identity.** This also closes the open
  question about grafting a genuine run of entries from one design into another: with a per-design
  chain key, grafting fails. §4's binding rule is scoped in writing to design-payload keys so it is
  not misread as covering this.
- Stated plainly: **this detects a database-only attacker. It does not constrain anyone who can run
  code on the server.** A hardware key module makes forgery online and observable, not impossible.
  Only an external witness genuinely constrains the operator.

**Given up:** per-design chains do not prove the *set* of designs is complete. Someone with
database write access could delete an entire design and its chain. A tenant-level chain over
design-creation events is cheap and should also exist.

**What this does not do:** it detects alteration. It does not prevent it, and it does not
authenticate the author beyond what the application recorded.

---

## 7. Tenant isolation

Two layers, deliberately redundant:

1. **Row-level security in PostgreSQL**, so a query missing a tenant filter returns nothing rather
   than someone else's rows. The database enforces it, not the application.
2. **Cryptographic separation** — a different tenant's rows are encrypted under a different key, so
   even a total failure of layer 1 yields ciphertext.

Layer 1 fails open when a policy is wrong. Layer 2 has no such failure mode. Neither alone.

---

## 8. What this design does not cover

Named so nobody assumes it was considered:

- Conflict resolution when two people in the same scope edit the same device at once. Open
  question in the plan; blocks Phase 4, not Phase 2.
- Backup and restore, including whether a backup without the master key is useful or dangerous.
- Key rotation schedule.
- What happens to a design when a tenant is deleted.
- Rate limiting, session management, authentication mechanism.
- Audit log retention and whether the audit log is itself sealed.

---

## 10. Majors to resolve during the build

From `PHASE-2-ATTACK-REPORT.md`. Each survived independent verification; none blocks starting.

1. **Argon2id parameters are unspecified.** Memory, time, parallelism, salt custody and a passphrase
   floor all need naming — and **rule 1 applies: look them up and cite a source with a date. Do not
   write a number from memory.** Structure: passphrase → Argon2id → key-encrypting key; that wraps a
   random vault master key; that wraps per-entry keys. Carry the parameters per entry in the schema
   from day one so they can be raised later. Compile a refusal floor into the client so a hostile
   server cannot serve weak ones.
2. **The server chooses the public keys** in per-recipient sharing, so it can insert itself as a
   reader invisibly. Minimum: show fingerprints at share time, pin trust-on-first-use in local
   browser state, warn loudly on change.
3. **The vault audit log is unsealed**, while the lower-ranked design history gets a keyed seal.
   ADR-0042 makes mode-B access logging the sole compensating control. Extend §6's construction to a
   per-tenant vault audit chain. Make mode changes first-class sealed events, and write the rule
   nobody has written: who may change a credential's mode, with re-consent on A→B.
4. **`content_hash` is undefined**, and both readings break something. Over ciphertext, a routine
   upgrade invalidates every seal at once and looks exactly like an attack. Over plaintext, a swapped
   blob survives a cheap check. Define it, and make verification report three outcomes: verified,
   broken at entry N, or cannot verify under key epoch K. Retired chain keys are kept forever with an
   epoch id on every entry.
5. **Re-wrap changes custody, not exposure.** Anyone holding the old master key and a pre-switch
   snapshot keeps reading data written after the switch. Distinguish re-wrap from rotation in §4, put
   the re-encryption runbook in §8, and make the custody-switch interface say which happened.
6. **Mode is invisible** at the token, the export and the point of use. Show it beside every
   `cred_<id>` and give a per-scope count. Putting the mode in exports is a deliberate trade — it
   tells an export holder what is recoverable — so record it as a decision.
7. **Plaintext metadata discloses the named hierarchy.** A database dump reveals the full named
   organisation → network → building → rack tree plus authorship and activity volumes, with no key.
   Replace §1's bare "Low" with a one-line threat model the backup documentation repeats, and decide
   explicitly whether design names are encrypted.

Also open, unresolved rather than decided: per-version `size` is a device-count oracle — bucket it
and pad, or accept and document it. Compression is unspecified, which is the actual gap.

---

## 9. Questions for the attackers

1. §3's whole-payload encryption — is giving up server-side search the right trade, and does
   piecemeal encryption really leak as much as claimed?
2. §5's shared-credential problem has no answer. Is there one that does not reintroduce a
   server-held key?
3. Does the keyed chain in §6 actually resist the attacker it claims to, and where does its key
   live?
4. §4's byte-identical re-wrap requirement — is it achievable as described, or does it constrain
   the construction in a way not stated here?
5. What is missing entirely?
