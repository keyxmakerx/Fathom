# Phase 2 — Storage, keys and the vault

**Status:** DRAFT FOR ATTACK, 2026-09-11. Not accepted. Not built.
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

**Binding:** tenant and design identity live in the key derivation *only* — not duplicated into the
authenticated data. WO-12's third review round found that duplicating the binding made a row moved
between tenants fail authentication indistinguishably from a wrong key, so it reported as
*corrupt* rather than *misbound*. The binding must move, not be copied.

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

**Given up:** forgotten passphrase means unrecoverable entries. Must be stated at the moment of
storing, not in a help page.

**Unresolved and important:** a credential several engineers need. Mode A requires sharing a key,
and revocation then means re-keying and re-encrypting everything that person could reach. This is
the hard problem in the whole design. **No mechanism is proposed here. Attack this.**

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

**Given up:** per-design chains do not prove the *set* of designs is complete. Someone with
database write access could delete an entire design and its chain. Detecting that needs a
tenant-level chain over design creation events, which is cheap and should probably also exist.

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
