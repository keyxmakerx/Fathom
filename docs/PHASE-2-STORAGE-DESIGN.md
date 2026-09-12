# Phase 2 — Storage, keys and the vault

**Status:** REVISED AFTER ATTACK, 2026-09-11. Majors 1, 4 and 7 resolved 2026-09-12 (§11);
major 5 and the primitives settled 2026-09-12 (§12).
**Not accepted. Not built.** Two majors remain open in §10: 2 and 3. Major 6 is presentation, not schema.
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

> **SUPERSEDED 2026-09-12 — do not build this line. See §11.2.** Bare concatenation of three
> variable-length values admits a splice: a different field split producing the same byte string is
> a different history with the same seal. Every field is length-prefixed in the replacement.

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

1. **Argon2id parameters are unspecified.** **RESOLVED 2026-09-12 — see §11.1.** Memory, time, parallelism, salt custody and a passphrase
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
4. **`content_hash` is undefined, and both readings break something.** **RESOLVED 2026-09-12 — see §11.2.** Over ciphertext, a routine
   upgrade invalidates every seal at once and looks exactly like an attack. Over plaintext, a swapped
   blob survives a cheap check. Define it, and make verification report three outcomes: verified,
   broken at entry N, or cannot verify under key epoch K. Retired chain keys are kept forever with an
   epoch id on every entry.
5. **Re-wrap changes custody, not exposure.** **RESOLVED 2026-09-12 — see §12.6.** Anyone holding the old master key and a pre-switch
   snapshot keeps reading data written after the switch. Distinguish re-wrap from rotation in §4, put
   the re-encryption runbook in §8, and make the custody-switch interface say which happened.
6. **Mode is invisible** at the token, the export and the point of use. Show it beside every
   `cred_<id>` and give a per-scope count. Putting the mode in exports is a deliberate trade — it
   tells an export holder what is recoverable — so record it as a decision.
7. **Plaintext metadata discloses the named hierarchy.** **RESOLVED 2026-09-12 — see §11.3.** A database dump reveals the full named
   organisation → network → building → rack tree plus authorship and activity volumes, with no key.
   Replace §1's bare "Low" with a one-line threat model the backup documentation repeats, and decide
   explicitly whether design names are encrypted.

Also open, unresolved rather than decided: per-version `size` is a device-count oracle — bucket it
and pad, or accept and document it. Compression is unspecified, which is the actual gap.

---

## 11. Majors 1, 4 and 7 — resolved 2026-09-12

Resolved by the security role. **Every lookup below was made on 2026-09-12** and every figure is
attributed, per rule 1.

> **Read this caveat before using any number here.** The session's egress proxy blocked
> `rfc-editor.org`, `datatracker.ietf.org`, `ietf.org`, `csrc.nist.gov`, `nvlpubs.nist.gov`,
> `pages.nist.gov`, `cheatsheetseries.owasp.org` and `eprint.iacr.org`. **RFC 9106's own text was
> not read.** Its parameter values here are second-hand, from `argon2-cffi`'s named profile
> constants, corroborated by two independent search summaries that agree. OWASP and NIST figures
> come from their source repositories rather than their published sites. §11.5 lists every lookup
> that must be redone with unrestricted network access before the vault ships.

### 11.1 Argon2id — major 1

**Parallelism is 1, and this is forced, not chosen.** Fathom derives this key in the browser, in the
WASM module whose import allowlist is deliberately empty. Multi-lane Argon2 needs threads, threads
need `SharedArrayBuffer`, and that needs COOP/COEP cross-origin isolation on every page — a
deployment constraint, a self-hosted support burden, and new imports through a gate this project
keeps closed. `argon2-cffi` states it outright: *"In WebAssembly environments `parallelism` must be
1."* libsodium hard-codes it to 1 unconditionally. **RFC 9106's published profiles use p=4 and are
therefore not directly usable.** Record the reason here so nobody later "fixes" it.

Dropping p at fixed m and t does not reduce the attacker's cost — it makes the defender slower for
the same cost. That is a knowing trade.

**Floor, compiled into the client: m ≥ 65536 KiB (64 MiB), t ≥ 3, p = 1.** 64 MiB is simultaneously
libsodium's INTERACTIVE memory and RFC 9106's second-recommended memory; t=3 is that profile's
iteration count. It is ~3.4× OWASP's stated minimum, which is the right direction: **OWASP's ladder
is calibrated for a server hashing on every login, and this is a once-per-session vault unlock.**
Those are different workloads and the two-orders-of-magnitude spread between published figures is
about that, not about the algorithm.

**This is a floor. The target is calibrated, because the algorithm's own designers say so** — the
Argon2 v1.3 spec §9 gives a procedure, not numbers. Measure on the slowest supported device at p=1,
raise **m first**, then t, to roughly 0.5–1.0 s. Record the measured numbers, the device and the
date; those are what go stale.

**Salt: 16 bytes from a CSPRNG, per user, and it is not secret.** NIST SP 800-63B-4: *"Both the salt
value and the resulting hash SHALL be stored for each password."* OWASP draws the contrast
explicitly — secrecy is the *pepper's* property, not the salt's. It lives in the database beside the
wrapped master key, in the clear. Say so rather than leaving it to be inferred. Output 32 bytes.

**Structural correction — the parameters do not go on the entry.** §10 said "per entry", and that
contradicts the structure the same paragraph settles. In `passphrase → Argon2id → KEK → random vault
master key → per-entry keys`, the derivation runs **once per user per unlock**, not once per entry.
Parameters on the KEK record; only `vmk_epoch` on the entry. This is the whole reason the KEK/master
-key indirection exists — raising the parameters then rewrites **one row** and re-encrypts nothing.

**The refusal floor bites on the write path, not the read path.** Argon2's own §3.2 makes m, t, p,
version and type inputs to the derivation, so a server serving *lowered* parameters for an existing
wrap produces a different key and the unwrap simply fails its tag. The attacker gains nothing. The
real attack is at **vault creation, passphrase change, recovery-key rotation and recipient
enrolment**, where the client would derive under hostile parameters and store a permanently cheap
wrap. Same shape as the 2023 Bitwarden server-iterations issue (identified by search; the write-up
itself was blocked, so it is second-hand). **Rule: on the write path the client uses its own
compiled constants and there is no code path that accepts parameters from the server.**

**Below-floor parameters on read — three bands, because one rule cannot cover both cases.** A single
"refuse" bricks legitimately old vaults; a single "warn" lets a downgrade through.

1. **Below the hard floor** (m < 8 MiB, t < 1, p ≠ 1, unknown algorithm or version): refuse to derive
   at all. Report it as *"the server sent key-derivation parameters below this client's minimum"* —
   a tamper signal, never "wrong passphrase". Offer raw-ciphertext export so a user facing a hostile
   or broken server is not trapped.
2. **Between the hard floor and the current target:** derive, unlock, then upgrade — re-derive at
   current parameters and re-wrap the master key on the next successful unlock. One row. Show a
   persistent state on the vault meanwhile, and write the upgrade as a sealed audit event so a
   parameter *reduction* is visible as an event that should never appear.
3. **At or above target:** proceed, and display the parameters where a user can see them, so a change
   between sessions is observable at all.
4. **Above a hard ceiling** — added 2026-09-12. A floor alone is half the control: a hostile or
   broken server can serve absurdly *high* parameters and lock the browser tab solid, which is a
   denial of service and a timing surface. Bound both ends, as shipped password managers do —
   Bitwarden bounds memory, parallelism and iterations with explicit ranges, verified in their
   client source. Refuse above the ceiling with the same tamper wording as below the floor.

Pin the parameters in local browser state (trust on first use) beside the public-key fingerprints,
and bind `algo‖version‖m‖t‖p‖salt‖kek_params_id` into the AEAD associated data of the master-key
wrap, so failure resolves to `Misbound` vs `Refused` at exactly one path — the discipline the B1 fix
already set for design keys.

**None of this defends a running compromised server, which serves the JavaScript.** Keep that
sentence beside the floor so the floor is not oversold.

### 11.2 `content_hash` and the seal — major 4

**Bind both domains and keep them separable.** That is what dissolves the dilemma: the plaintext
binding is rotation-invariant, so a key upgrade does not invalidate it; the storage binding pins the
actual bytes, so a swapped blob is caught without decrypting anything.

**Length-prefix every variable-length field.** `LP(x) = u32_le(len(x)) ‖ x`. The superseded line in
§6 concatenates three variable-length values bare, which admits a splice. This rule costs nothing now
and cannot be retrofitted without invalidating every seal ever written.

Subkeys, domain-separated from the per-design chain key of B5:

```
K_seal    = HKDF(key_chain_epoch_e, info = "fathom/chain/seal/v1")
K_content = HKDF(key_chain_epoch_e, info = "fathom/chain/content/v1")

plaintext_binding = MAC(K_content, LP("fathom/chain/plaintext/v1")
    ‖ LP(tenant_id) ‖ LP(design_id) ‖ u64(design_version)
    ‖ u32(payload_schema_version) ‖ LP(plaintext_payload_bytes))

storage_binding   = MAC(K_content, LP("fathom/chain/storage/v1")
    ‖ LP(key_id) ‖ u32(key_epoch) ‖ u32(wrap_version) ‖ u16(aead_alg_id)
    ‖ LP(nonce) ‖ LP(ciphertext_including_tag))

content_hash      = MAC(K_content, LP("fathom/chain/content/v1")
    ‖ LP(plaintext_binding) ‖ LP(storage_binding))

seal_n            = MAC(K_seal, LP("fathom/chain/seal/v1")
    ‖ u32(chain_key_epoch) ‖ u64(seq_n) ‖ LP(tenant_id) ‖ LP(design_id)
    ‖ LP(seal_{n-1}) ‖ LP(content_hash_n) ‖ LP(entry_type) ‖ LP(canon(metadata_n)))
```

Genesis is `LP(H("fathom/chain/genesis/v1" ‖ tenant_id ‖ design_id))`. `canon` is `fathom-canon`'s
canonical bytes. `chain_key_epoch` is stored on **every** entry and retired chain keys are kept
forever.

**`content_hash` is keyed, and that is not decoration.** An unkeyed hash of plaintext is a
confirmation oracle for anyone holding a dump: they can test whether two versions are identical,
whether two tenants hold the same design, or whether a guessed payload is the real one — with no
key, against the highest-value thing in the system after credentials. Keying costs nothing because
every verifier already holds the chain key.

**Poly1305 must not be the chain MAC.** RustCrypto's own source: *"Poly1305 is not a traditional MAC
and is single-use only (a.k.a. 'one-time authenticator')."* It is fine inside ChaCha20-Poly1305,
where it gets a fresh one-time key per message; lifting it out and keying it repeatedly breaks it.
HMAC-SHA-256 or keyed BLAKE2b/KMAC — **and that choice needs its own dated lookup before building.**

**Re-encryption becomes a recorded fact rather than an alarm.** A `reencrypt` entry type carries
`plaintext_binding` across unchanged — which is itself the proof that the content did not change
when the bytes did — and records old and new epochs, wrap versions and storage bindings. A verifier
meeting a storage-binding mismatch looks for a `reencrypt` entry accounting for it: found, routine;
absent, broken. This is what stops a `docker compose pull` looking exactly like an attack and
teaching operators to dismiss the alarm.

**The three outcomes, made precise:**

- **verified** — every seal recomputes, `seq` is contiguous, and the stored blob's storage binding
  matches directly or via a `reencrypt` chain. No decryption. This is the routine check.
- **broken at entry N** — N is the **first** index where any of four things fail: the seal does not
  recompute, the sequence skips or repeats, the storage binding mismatches unexplained, or
  `prev_seal` does not match N−1. Report N, its metadata, and which of the four. Everything before N
  is still verified and is reported as such.
- **cannot verify under key epoch K** — a coverage gap, not a failure. Report the contiguous ranges
  affected and the epochs missing.

A fourth sub-state belongs to the third: **links verified, content not re-bound**, when the design
key was unavailable or deep verification was not requested. *"Content not checked" must never render
the same as "content verified."*

Routine verification is links plus storage bindings, no decryption, runnable by an operator holding
only the chain key. Deep verification additionally decrypts and recomputes the plaintext binding.
**Both must name which they ran.**

### 11.3 Plaintext metadata — major 7

§1's bare "Low" is replaced by this, and the backup and restore documentation repeats it verbatim:

> **Structure and identity are stored in the clear.** Anyone holding a database dump or a backup
> file — with no key — learns who the customer is, the full named organisation → network → building
> → rack tree, the names of designs, who edits what, and how often. The designs themselves stay
> encrypted. Treat a backup as disclosing the estate's map legend, not its map.

**Recommendation: encrypt design names, and make the scope path out of opaque ids with display names
encrypted per node.** The path is the expensive half and must land before the first migration — §2
already notes a subtree move rewrites every descendant. Prefix queries for presence and permission
work identically on opaque tokens, so the materialised-path design is unaffected.

**What it costs, which is the half that decides it:**

1. No server-side ordering, filtering or search by name — fetch, decrypt, sort client-side. At
   hundreds of designs this is genuinely cheap, and §3 already gave up server-side search. **Low.**
2. No database-level uniqueness on names. Check it client-side at create time; the client holds the
   list anyway. **Do not** add a blind index, deterministic column or order-preserving encryption to
   get sorting back — equality leakage is the surface inference attacks on property-preserving
   encryption target.
3. **The real cost, and it is not the queries: every server-side surface that names a design loses
   the name** — audit rows, notifications, export filenames, error messages, support diagnostics,
   admin tooling, presence, job logs. Each must carry an id and render client-side, or keep a
   plaintext copy — **and a plaintext copy in the audit log is the leak returning through a side
   door.** This is where the decision is actually paid for and why it cannot wait.
4. Operational pain on restore: an operator cannot tell which design is which without the key.
5. **What it does not buy:** names encrypted under the tenant hierarchy are readable by the server at
   runtime, exactly like the payload in §2a. This protects a stolen dump. The four forbidden
   sentences apply here as everywhere.
6. **What stays disclosed regardless:** tenant identity, the shape and size of the tree, node ids,
   authorship, timestamps, activity volumes, per-version size. Encrypting names narrows the
   disclosure from the estate's map legend to its silhouette — say that, so the change is not read
   as making the metadata safe.

### 11.4 Sent to the owner, not decided here

Three of these are the owner's call and are listed in `docs/OPEN-QUESTIONS.md`:

- **A generated 128-bit recovery key instead of a chosen passphrase.** NIST's floor is 15 characters
  for single-factor, with a blocklist and no composition rules — but NIST's own Appendix A says
  offline attacks need passwords "orders of magnitude more complex" than that. A machine-generated
  key removes the KDF parameters from the critical path entirely and makes "forget it and the
  entries are gone" an honest printable artefact rather than a memory test. It is also a real UX
  change.
- **Whether design names are encrypted**, given cost 3 and cost 4 above.
- **Whether to add a server-held pepper.** Argon2 supports a secret input directly; it would make a
  stolen dump uncrackable at any passphrase strength — which is exactly Mode A's threat. But it does
  nothing against a running compromised server, it cannot be rotated without every user re-deriving,
  and losing the pepper file destroys every Mode A entry. Recommended as a recorded option, not for
  Phase 2.

### 11.5 Lookups that must be redone with network access

Blocked this session and therefore **unestablished**:

- **RFC 9106 itself.** Every figure attributed to it here is second-hand.
- Whether Argon2id is a NIST-approved password hashing scheme. SP 800-63B-4 points at SP 800-132,
  whose own reference entry is dated **2010** — predating the Password Hashing Competition — so it
  is likely outside the approved set, but only blog posts said so outright. **If FIPS matters to a
  customer this is its own dated lookup.**
- IACR ePrint **2026/058**, *"Zero Knowledge (About) Encryption"* — analyses a fully malicious
  password-manager server against Bitwarden, LastPass and Dashlane. The single most relevant outside
  work to Mode A. **Read it in full before the vault ships.**
- The Bitwarden server-iterations write-up, and the Naveed–Kamara–Wright inference-attack paper
  (venue and authorship verified, text not read).
- The safe message limit for ChaCha20-Poly1305 under random 96-bit nonces, before the key hierarchy
  is finalised.
- Advisory status for `argon2` and `chacha20poly1305`: **nothing found** on 2026-09-12 against a
  working control, which is a result and not a clean bill of health. It goes stale immediately.

---

## 12. Primitives — decided 2026-09-12

Settled by the security role so the foundation could be written. **Every dependency fact below was
re-verified by the lead against `Cargo.lock`, `deny.toml` and a local clone of the advisory
databases** — not taken on report. The proxy blocked the IETF, NIST and OWASP sites again this
session; §12.6 lists what that leaves unread.

### 12.1 The chain MAC — HMAC-SHA-256, and it costs nothing

`hmac 0.13.0` and `sha2 0.11.0` are **already in the lockfile**, arriving with SCRAM-SHA-256
authentication in the PostgreSQL driver (`hmac → postgres-protocol → postgres-types →
tokio-postgres → deadpool-postgres → fathom-server`, verified). The seal therefore adds **no crate,
no build script, no C, no assembly.**

Tag comparison is constant-time and this was read rather than assumed: `digest 0.11.3`'s `Mac` trait
compares through `ctutils::CtEq`, and both HMAC and keyed BLAKE2 would verify through that same
path. So on the property that matters they are identical, and the tiebreakers decide: HMAC-SHA-256
is in NIST's validated algorithm set (ACVP lists `HMAC-SHA2-256`; "blake" appears nowhere in it),
BLAKE2 would cost one crate, and **KMAC is not available at all** — RustCrypto ships no KMAC and the
`kmac` name on crates.io is an empty placeholder. Hand-rolling it is forbidden.

Poly1305 stays disqualified as a repeatedly-keyed MAC, per §11.2.

**KDF: HKDF-SHA-256, Expand-only** (`hkdf 0.13.0`, **+1 crate**). The chain key is already uniform,
so extract is skipped — `from_prk`, not `new`.

### 12.2 Two fixes to §11.2, both cheap now and impossible later

**The KDF labels are renamed**, because §11.2 used the same two literals as both the HKDF `info` and
the domain tag inside the MAC input. Not a weakness — different functions, different keys — but
someone will later tidy one occurrence and silently change the other:

```
K_seal    = HKDF-Expand(chain_key_epoch_e, info = "fathom/chain/kdf/seal/v1",    32)
K_content = HKDF-Expand(chain_key_epoch_e, info = "fathom/chain/kdf/content/v1", 32)
```

The in-MAC prefixes in §11.2 are unchanged.

**The per-design chain key gets its derivation named, with length prefixes.** §6's B5 fix said the
chain key is scoped per design; §11.2 then started from it as a given. Without length-prefixing the
identity inputs, tenant `ab` + design `c` and tenant `a` + design `bc` derive the **same chain key** —
the identical splice §11.2 closed one layer up:

```
chain_key_epoch_e = HKDF-Expand(chain_master,
    info = LP("fathom/chain/key/v1") ‖ LP(tenant_id) ‖ LP(design_id) ‖ u32(chain_key_epoch), 32)
```

### 12.3 Nonces — §4's "fresh random 96-bit nonce" survives, but only because keys are per design

**This was the sharpest finding and it changes a stated rule.** The implementer documentation that
could be reached does **not** list "random" among the safe nonce choices for ChaCha20-Poly1305-IETF,
and the CFRG's own usage-limits draft encourages counters. The AEAD itself has no per-key message
limit with distinct nonces; the whole limit under random nonces is the birthday bound on 96 bits:
**2^32 messages ≈ 2^-33**, 2^24 ≈ 2^-49. A collision is not gradual — two messages under one
(key, nonce) leak the XOR of the plaintexts *and* the Poly1305 one-time key, so it is forgery too.

Three options were on the table: switch to XChaCha20-Poly1305 (192-bit nonce, random documented-safe,
zero extra crates, but not an RFC), move to counter nonces, or keep random with a budget.

**Decision: keep RFC 8439 ChaCha20-Poly1305 with random 96-bit nonces, and make per-design data keys
mandatory rather than merely preferred.**

Reasoning, and the counter option is rejected on an operational ground rather than a cryptographic
one. **A counter nonce is safe only while the key never moves backwards — and restoring a backup
moves it backwards.** A self-hosted product shipped as Docker containers to network engineers will
have its database restored from a snapshot; that is routine, not exceptional. A restore resets the
counter while the key stays the same, and the next writes reuse nonces already spent. Silent,
catastrophic, and triggered by the most normal operation an operator performs.

**Random nonces have no such failure mode** — a restored deployment simply draws fresh random values,
and the birthday bound is unchanged. The cost is the bound itself, and per-design keys make it
irrelevant: 2^24 writes is 16.7 million versions **of one design**, which is not a number this
product reaches. Per-design keys were already what §4 wanted for blast radius and the B1 binding;
this makes them load-bearing, so they may not be relaxed to per-tenant without revisiting this
section. Write that in the key table's own comment.

**A `writes_under_key` counter column is still added — as a detector, never as the nonce source.**
It alarms if any key approaches the budget; it does not feed the nonce. If per-design keys are ever
relaxed, the fallback is XChaCha20-Poly1305, which the same crate already ships at no extra
dependency.

### 12.4 Crates — and one that would have failed the build

| Role | Crate | New crates | C/asm |
|---|---|---|---|
| AEAD | `chacha20poly1305 0.11.0`, `default-features = false` | +6 (+7 with `zeroize`, which is enabled) | none |
| Chain MAC | `hmac 0.13.0` + `sha2 0.11.0` | **0 — already in the lock** | none |
| KDF | `hkdf 0.13.0` | +1 | none |
| CSPRNG | `getrandom 0.4.3` — the OS RNG directly, not `rand` | **0 — already in the lock** | none |

**`deps/decisions/chacha20poly1305.md` records version `0.10`, and that version cannot be used.**
`chacha20poly1305 0.10.1` wants `chacha20 ^0.9`; the lockfile already carries `chacha20 0.10.2`
(via `rand` ← `postgres-protocol`), and `deny.toml` sets `multiple-versions = "deny"`. Pinning 0.10
puts two `chacha20` majors in the graph and fails the gate. **0.11.0 unifies with what is there.**
The record is corrected.

**Watch `cipher 0.5.0` — it is yanked**, and `deny.toml` sets `yanked = "deny"`. The lock must
resolve to 0.5.1 or later; check the lockfile diff explicitly rather than assuming.

`getrandom` rather than `rand`: no userspace generator state and no reseeding path, which is the
surface the 2026 `rand` advisory concerns. `hmac` and `sha2` become directly named for the first
time, so each needs its own `deps/decisions/` record — a crate this workspace names in a manifest
always needs one, whatever the closure already contains.

Budget: 115 external crates today, roughly 123 after all four roles, against a recorded cap of 160.

### 12.5 A gap in the dependency gate, found by accident

**CVE-2026-50185 / GHSA-3rjw-m598-pq24** (2026-07-02): `cmov` on aarch64 can produce wrong results
when high register bits are set, because the backend assumes a zero-extension the Rust reference does
not guarantee. Fixed in 0.5.4.

Fathom locks `cmov 0.5.4`, so **it is not exposed** — verified. Two things make it worth recording
anyway:

1. **`cmov` is on the chain MAC's path** — `digest` → `ctutils::CtEq` → `cmov`. Tag comparison
   inherits whatever it does. Pin `>= 0.5.4` explicitly.
2. **RustSec does not carry this advisory.** `cargo audit` and `cargo deny advisories` read RustSec,
   so layer 3 of the five-layer gate would not have raised it. "Filed advisories" has quietly meant
   "filed at RustSec". **Add the crates.io subset of the GitHub Advisory Database as a gate input** —
   1,571 JSON files, cheap to check against `Cargo.lock`.

Both databases were queried with working controls, so "nothing found" is distinguishable from
"could not reach". Nothing was found for any proposed crate. **That is a result, not a clean bill of
health, and it goes stale immediately — re-run before merge.**

Unrelated correction: `deny.toml` attributes the `proc-macro1` typosquat to RUSTSEC-2026-0260; that
id is a different advisory from the same incident. The `proc-macro1` one is **RUSTSEC-2026-0265**.
The control is unaffected; only the citation was wrong.

**Environment note:** `static.crates.io` and the crates.io API return 403 through this session's
proxy, and `scripts/closure-report.sh` and `scripts/crate-cooldown.sh` read publish dates from
exactly those hosts. Check where CI actually runs before relying on the cooldown gate for these
arrivals.

### 12.6 Major 5 — re-wrap is not rotation, and only one of them revokes anything

**Re-wrap** changes custody, not exposure. The data key is unchanged; only its wrapping changes.
Ciphertext, nonce, tag, `content_hash` and `storage_binding` are all byte-identical. Seconds.
**Anyone holding the old master key and a copy of the key rows from before the switch still decrypts
everything, including data written afterwards** — because the data keys never changed.

**Rotation** re-encrypts. New data key, fresh nonce, new ciphertext, new `storage_binding` —
but `plaintext_binding` carries across unchanged, which is the proof the content did not change when
the bytes did. Hours, I/O-bound. **This is the only operation that revokes anything.** Retired data
keys are kept forever, exactly as retired chain keys are, or old versions become unreadable.

**Columns.** Re-wrap touches only the key tables (`wrapped_key`, `wrap_nonce`, `master_key_id`,
`master_key_epoch`, `wrap_version`, the B1 `aad` inputs, `rewrapped_at`, `rewrapped_by`) and **must
not** touch `key_epoch` or the payload table at all. If a re-wrap moves `key_epoch`, the two
operations are conflated in the schema and no interface can separate them afterwards. Rotation adds
`key_epoch` (monotonic, never overwritten), `retired_at`, `retired_reason`, `status ∈ {active,
retired, compromised}` — `compromised` is what tells an operator a re-wrap was not enough — plus
`key_epoch` **stored** on the payload row, not merely fed into the MAC, so a verifier need not
trial-decrypt to find the key. Rotation is long, so it needs a resumable job record: **a
half-finished rotation with no record is indistinguishable from tampering at verification time.**

**The asymmetry is the trap.** Rotation writes a `reencrypt` chain entry per version. Re-wrap writes
nothing, because nothing it does is visible to the chain. So the operation that changes *custody*
leaves no trace, while the one that changes *bytes* leaves one everywhere. **Re-wrap therefore gets
its own sealed `rewrap` entry on the tenant-level chain**, recording old and new master identity,
which key rows moved, who ran it, and explicitly that no payload was re-encrypted. Otherwise the one
security-relevant key operation has no audit trail in a system whose integrity story is an
append-only sealed log.

**What the interface must report**, in these words and not interchangeable ones: the operation named
`rewrap` or `rotate`, never a shared verb; counts rather than a boolean; old and new master identity;
what verification will say afterwards; whether old key material was retained or destroyed. And for a
re-wrap, this, as a statement of fact requiring explicit acknowledgement:

> *Anyone who holds the previous master key and a copy of the key rows taken before this switch can
> still decrypt all data, including data written after it. This changed custody, not exposure. To
> revoke that access, run a rotation.*

**One refusal:** no config field, flag or parameter may accept "rotate" as a synonym for "re-wrap".
A deployment with a single `master_key` setting that silently re-wraps when changed leaves the
operator believing they revoked something.

### 12.7 Still unread, and therefore unestablished

The proxy blocked the IETF, NIST, OWASP, IACR and docs.rs. Reached instead: the sparse registry
index directly, and both advisory databases by clone.

**Not read, and any figure attributed to them is second-hand:** RFC 8439 (including `P_MAX` and the
nonce construction), RFC 5869 §3.3, RFC 9106, FIPS 198-1, FIPS 180-4, SP 800-38D §8.3 — the closest
NIST analogue to the nonce question — SP 800-185, SP 800-57, and the NCC Group audit of the
RustCrypto AEADs. The approved-set conclusion in §12.1 rests on NIST's ACVP algorithm list, which is
strong evidence of what NIST validates but is not the standards text. The CFRG usage-limits draft was
read from the research group's own source repository, which is authoritative for content but not for
its current status.

Also unestablished: whether XChaCha20-Poly1305 has been standardised since its draft — relevant only
if per-design keys are ever relaxed and §12.3's fallback is taken.

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
