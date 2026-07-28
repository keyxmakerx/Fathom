# 17 — The workspace format

> **Status:** Proposed

This document specifies the thing the owner decided on in §6.4 of the brief:

> **DECISION — inventory as a document, not a database.** Given everything is client-side and
> encrypted, it is an encrypted file you own: git-versionable, diffable, portable. No Postgres,
> no migrations, no ORM.

That decision is right and it is also under-specified in exactly the places it is hard. An
encrypted file is not diffable. A ciphertext blob is not git-friendly. Two people editing one
encrypted document produce a conflict git cannot resolve, in bytes no human can read. A filename
is plaintext, so a directory listing can undo the whole design before anybody has touched the
cryptography. This document is the format that survives all four.

**The governing rule of this document, stated once, in caps, at the top:**

> **A FILENAME IS PLAINTEXT. A FILE SIZE IS PLAINTEXT. A WRITE TIME IS PLAINTEXT. EVERYTHING YOU
> NAME, COUNT OR TOUCH, YOU DISCLOSE.**

One terminology note before anything else. In this document a **record** is a unit of storage —
one file, one sealed container. It is never a graph element; graph elements are **nodes** and
**edges** (conventions, *Terminology*). The corpus already uses `record` this way in
`ProvenanceRecord`, `AiValueRecord` and `EgressRecord`, and the owner's own brief for this
document says "record files".

---

## 0. Contents

| § | |
|---|---|
| 1 | The two things this format has to be at once |
| 2 | The container — directory form and packed form |
| 3 | The directory layout, in full |
| 4 | Records — the granularity decision |
| 5 | Frames — append-only sealed segments, and why appends are the whole trick |
| 6 | Filenames — the disclosure nobody budgets for |
| 7 | The manifest, and why it is not committed to git |
| 8 | Version pins — schema, corpus, packs |
| 9 | Suppressions |
| 10 | Settings, and what deliberately is not in them |
| 11 | The AI audit log |
| 12 | Git — what works, what does not, and the merge driver |
| 13 | Size budgets — 50, 500, 5 000 devices, and where this stops working |
| 14 | Import |
| 15 | Export, and the plaintext path |
| 16 | Corruption, truncation, recovery, `fsck` |
| 17 | What this format costs |
| 18 | Open decisions |
| 19 | Sources |
| 20 | Proposed amendments to other documents |
| 21 | Disagreements |

---

## 1. The two things this format has to be at once

The format has two consumers with directly opposed requirements, and every decision below is a
consequence of serving both.

| Consumer | Wants | Consequence |
|---|---|---|
| **The crypto** | One sealed thing. Confidentiality of contents, integrity of the whole, no structure visible to an observer, no partial trust | Argues for a single opaque blob |
| **Git** | Many small stable files, byte-identical across clones for identical content, changed only where the change was, mergeable | Argues for a directory of many files with a deterministic layout |

A single blob is unusable in git: every save rewrites megabytes, every concurrent edit conflicts
irreconcilably, and every version of the whole workspace is retained forever in the object store.
A directory of many files leaks structure through filenames, counts and sizes.

The resolution taken here has three parts and each is a section below:

1. **Records** (§4) — the workspace is a set of independently sealed files, chosen so that a
   typical edit dirties exactly one, and so that the file count is `O(devices)` and not
   `O(nodes)`.
2. **Frames** (§5) — a record file is an append-only sequence of independently sealed segments.
   An edit appends bytes; it does not rewrite them. This is what makes git's delta compression
   able to do anything at all with ciphertext, and it is what makes the merge driver **keyless**.
3. **Keyed pseudonymous filenames** (§6) — filenames are deterministic under the workspace key
   and meaningless without it, which is the only way to get both git-stable names and no
   disclosure.

The third-order consequence, and the most important result in this document:

> **Git merges frames. Fathom merges values.** The git merge driver never needs the workspace
> key, because merging two append-only frame sets is a set union over immutable, digest-named
> segments. Semantic conflict — two people setting `dh-group` to different values — is not a git
> problem and is not resolved at git time. It is resolved at open time, under an explicit unlock,
> by the CRDT in `docs/30-security/33-sync-protocol.md` §6.

Everything else here follows from that split.

---

## 2. The container

### 2.1 DECISION — a workspace is a directory; the single file is a packed form of the same bytes

Both forms exist and both are named `.fathom`. The loader `stat`s the path and branches. The
existing corpus already writes `--workspace site-b.fathom` and `fixtures/…​.fathom`, and this
keeps every one of those references valid.

| Form | Shape | For |
|---|---|---|
| **Directory** `site-b.fathom/` | The layout in §3 | Working state. Git. The CLI. Any deployment with a filesystem |
| **Packed** `site-b.fathom` | One file: a deterministic archive of the same tree | Mailing a workspace. The offline single-file build, which has no filesystem to spread over. Fixtures. Air-gapped transfer on a USB stick |

Packing and unpacking are byte-deterministic in both directions: `pack(unpack(x)) == x` and
`unpack(pack(d)) == d`. The archive is not zip and not tar — both carry mtimes, permissions and
ordering that would break determinism and leak local paths. It is a trivial length-prefixed
concatenation with entries sorted by filename:

```text
packed := magic(8)  "FTHMPK\x01\x00"
        | entry_count(u32 LE)
        | entry*                          sorted by name, byte-lexicographic
        | trailer_digest(32)              BLAKE3 over everything above

entry   := name_len(u16 LE) | name(name_len UTF-8) | body_len(u64 LE) | body(body_len)
```

No timestamps, no permissions, no compression at this layer (bodies are already sealed and
already padded). The trailer digest is an integrity check against truncation and bit-rot, not a
security control — the security control is that every body is individually AEAD-sealed.

**The cost of two forms, stated:** two code paths, two sets of tests, and one class of bug where
a workspace behaves differently packed and unpacked. The mitigation is that the packed form is a
pure function of the directory form with a round-trip property test in CI, and that no code above
the loader knows which one it opened.

### 2.2 What is inside the trust boundary

Everything in the tree is ciphertext except:

| Plaintext | Where | Why it is not confidential |
|---|---|---|
| Filenames | the tree | Keyed pseudonyms; meaningless without the key (§6). The *count* and *change pattern* are real disclosure |
| `format_version`, `schema_version` | every record's file header | An old build must know it cannot read a file *before* spending Argon2id on it (`11-ir-schema.md` §11.2) |
| KDF parameters and salt | the `keys` record header | A reader must know how to derive the key. Authenticated as AD, so they cannot be downgraded silently |
| Frame headers: index, length, nonce, HLC, actor pseudonym | every frame | This is the enabling disclosure for the keyless merge driver (§5.4). It is a decision, not an oversight, and §5.5 prices it |
| File sizes and mtimes | the filesystem | Nothing can be done about these in a directory. The packed form drops mtimes |

---

## 3. The directory layout, in full

```text
site-b.fathom/
├── FATHOM                       plaintext, 5 lines, human-readable. §3.1
├── .gitattributes               committed. §12.2
├── .gitignore                   committed. §12.2
├── manifest.fm                  NOT committed (§7.4). Local index cache
├── keys.fk                      sealed. Wrap of WK under the KEK, and under each
│                                member public key. KDF params in the header
├── records/
│   ├── 2a/
│   │   ├── 2afk9x3m7q1w8e5r2t6y4u0i9o.frec
│   │   └── 2ah3c8v1b6n2m9q4w7e0r5t3y8.frec
│   ├── 7d/
│   │   └── 7dq2w9e4r7t1y5u8i3o6p0a2s7.frec
│   …  1 024 buckets, two base32 characters, created lazily
├── captures/
│   ├── 4f/
│   │   └── 4fz8x2c5v9b1n4m7q0w3e6r9t2.fcap    write-once, content-addressed
│   …
└── ai/
    ├── sessions/  proposals/  values/  egress/     one record each, sharded
    └── cache/     corpus/  graph/  index  ledger
```

Nothing in that tree names a device, a site, a customer, a peer, a VPN or a zone. That is the
point of §6.

### 3.1 `FATHOM` — the plaintext note

Five lines, deliberately, so that a person who finds this directory in five years knows what it
is and is told the one thing they need to know.

```text
Fathom workspace
format 1  schema 3.2
This directory is encrypted. Every .frec and .fcap file is ciphertext.
There is no recovery. If the passphrase is lost, the contents are gone.
https://<canonical published location>
```

No workspace name, no owner, no date, no device count. Four of those five lines are constants;
the fifth is `format` and `schema`, which are already in every file header. **A README is a
disclosure surface and people write into them.** This one is generated, is overwritten on every
save, and the tool refuses to preserve edits to it.

---

## 4. Records — the granularity decision

### 4.1 The question

A record is the unit of sealing and the unit of a file. Granularity trades three things against
each other:

| Granularity | Files at 500 devices | Bytes rewritten per edit | Concurrent-edit collisions |
|---|---|---|---|
| Whole workspace, one blob | 1 | 80 MB | every edit collides with every edit |
| One record per device subtree | ~500 | ~200 KB, or ~200 B with frames (§5) | only same-device edits collide |
| One record per node | ~415 000 | ~250 B | almost never |

Per-node is wrong for a reason that has nothing to do with cryptography: 415 000 files defeats
git (`git status` walks them all), defeats most filesystems' directory performance, and turns
every workspace open into hundreds of thousands of `open`/`read`/`close` syscalls. Whole-workspace
is wrong for every reason in §1.

### 4.2 DECISION — the record is the device subtree, split by access temperature

```rust
pub enum RecordKind {
    /// The device node and every node and edge contained under it:
    /// interfaces, units, addresses, zones, policies, routes, crypto objects.
    /// Hot. Read on open, written on almost every edit.
    DeviceGraph { device: NodeId },

    /// The ProvenanceStore for exactly those elements. Cold on read,
    /// hot on write (every edit mints a record). ~40 % of the bytes.
    DeviceProv { device: NodeId },

    /// FieldHistory side table (11 §8.6). Cold both ways. Loaded on demand
    /// when a human asks "what was this before".
    DeviceHistory { device: NodeId },

    /// Site, Link, Tunnel, and every edge whose endpoints are in two different
    /// devices. Sharded to bound size — see §4.4.
    Fabric { shard: u16 },

    /// Suppressions, sharded by rule-id domain (§9).
    Suppressions { domain: RuleDomain },

    /// The three version pins (§8).
    Pins,

    /// Workspace settings (§10).
    Settings,

    /// The AI layer's five stores, per 24 §5.3 (§11).
    Ai { part: AiPart },

    /// Export events. Append-only, never compacted (§15.4).
    ExportLog,
}
```

Captures are not in this enum. They are a separate, simpler thing: **write-once,
content-addressed, never edited, never merged** (§4.5).

### 4.3 Why the split by temperature is worth four files per device instead of one

`11-ir-schema.md` §14.2 measures provenance at roughly 40 % of a fully-parsed device and captures
at another 20 %, and §14.1 already separates them into sections for exactly this reason. Making
them separate *records* rather than sections inside one record buys three things:

| Buys | Detail |
|---|---|
| **Opening a workspace touches ~55 % of the bytes** | `DeviceGraph` only. Provenance loads when a value is hovered, history when it is questioned, captures when a parse span is shown. At 500 devices that is 44 MB read instead of 80 MB |
| **A hand edit dirties two records, not four** | `DeviceGraph` + `DeviceProv`. History appends only when a value is superseded; captures never change |
| **A capture-heavy device does not make its graph record slow** | A device with a 40 000-line config has a 400 KB capture record and a normal-sized graph record |

The cost is four files per device instead of one — 2 000 files at 500 devices instead of 500 —
and a loader that has to hold four open handles per device it touches. Both are cheap. The real
cost is conceptual: **a device's data is in four places, so anything that reasons about "a
device" has to know that.** `fsck` (§16) exists partly to enforce that they stay consistent.

### 4.4 `Fabric` — the record kind that has to be sharded

Everything that is not owned by exactly one device lives in `Fabric`: `Site`, `Link`, `Tunnel`,
and the reference edges that cross devices. In the field card's worked example, the `Tunnel`
between the local SRX and the peer at `203.0.113.10`, and the `Link` from `reth0.0` to the
upstream, are fabric.

Fabric is the one record kind that every device edit can touch, so an unsharded fabric record
would be a global write lock in git-conflict form. Sharding:

```text
shard(element) = blake3_keyed(K_name, "fathom/v1/shard" || element_id)[0..2] as u16 % SHARDS
SHARDS = 64
```

64 shards, keyed so the assignment is not guessable, deterministic so two clones agree. At 500
devices a fabric shard holds roughly 30 links and tunnels — small files, low collision
probability. At 50 devices most shards are empty and are not written at all.

**Honest limit:** two people adding tunnels that hash to the same shard still collide. The
collision is resolved by the frame union (§12.4) with no user involvement, so it costs nothing;
sharding is here to keep files small, not to prevent conflict.

### 4.5 Captures are a different animal

`11-ir-schema.md` §8.4 stores raw configuration text once per capture and points at byte spans
from provenance. That makes captures **immutable and content-addressed**, which makes them the
easiest thing in the format:

```text
captures/<bucket>/<blake3-of-plaintext-keyed>.fcap
```

| Property | Consequence |
|---|---|
| Written once, never modified | Never conflicts. Never merges. Never compacts |
| Named by a keyed digest of its own plaintext | Two people pasting the same `show configuration \| display set` produce the *same file*, and git deduplicates it for free |
| Sealed with a key derived from its own content digest and WK | Deterministic ciphertext for deterministic plaintext, which is what makes the dedup work |
| Largest single class of bytes per device | And the largest single disclosure per byte on export (§15.5) |

**The deterministic-ciphertext decision has a cost and it is a real one.** Because identical
plaintext produces identical ciphertext, an adversary who *guesses* a capture's exact bytes can
confirm the guess. For a device configuration that is not a plausible attack — nobody guesses
4 000 lines exactly — but the property must be stated, because "deterministic encryption" is a
phrase that should always come with this sentence attached. It is used **only** for capture
bodies, never for graph, provenance, settings or suppressions.

---

## 5. Frames — append-only sealed segments

### 5.1 The shape

A record file is a small plaintext file header followed by a sequence of independently sealed
frames. Frames are immutable once written. An edit appends a frame; it never rewrites one.

```text
record  := file_header | frame*

file_header (32 bytes, plaintext, in every frame's AD)
    magic(8)              "FTHM-REC"
    format_version(u16)
    record_kind(u16)
    record_id(16)         the RecordId — an opaque ULID, not a name
    reserved(4)           zero

frame (69 bytes of overhead + body)
    magic(4)              "FFR1"
    flags(u8)             0x01 Baseline · 0x02 OpBatch · 0x04 body deflated
    hlc(u10 → 10 bytes)   wall_ms(u64) | counter(u16)     ← ordering, in the clear
    actor(8)              actor pseudonym                  ← who, pseudonymously
    nonce(24)             random, XChaCha20-Poly1305
    commit(16)            key-commitment tag (§5.6)
    body_len(u32)
    body(body_len)        ciphertext
    tag(16)               Poly1305
```

Total fixed overhead per frame: **69 bytes**, plus Padmé padding inside the body (§5.7).

### 5.2 The AEAD and its associated data

```text
AD = format_version ‖ schema_version ‖ workspace_id ‖ record_id ‖ record_kind
     ‖ flags ‖ hlc ‖ actor ‖ body_len
```

Every plaintext field in the two headers is in the AD. A frame therefore cannot be moved to
another record, relabelled as a baseline, given a different logical timestamp, attributed to
another actor, or truncated, without the tag failing. What the AD deliberately does **not**
contain is a frame index or a hash chain to the previous frame — see §5.3.

<!-- VERIFY: the concrete AEAD is XChaCha20-Poly1305 as implemented by libsodium and the
     `chacha20poly1305` Rust crate. XChaCha20-Poly1305 is specified in an expired CFRG draft
     (draft-irtf-cfrg-xchacha), not an RFC; ChaCha20-Poly1305 proper is RFC 8439. The final
     choice belongs to the key-management document in 30-security/. What this document needs
     from it is fixed and stated in §5.3: a 24-byte random nonce, so that concurrent writers
     need no counter coordination. -->

**Why a 192-bit random nonce and not a counter.** Two clients editing the same record while
offline will both choose the same counter value. Under any stream cipher, nonce reuse under the
same key is catastrophic — the keystream repeats and the plaintexts XOR. There is no coordination
point to allocate counters from, because the whole design has no coordinator. A 192-bit random
nonce makes collision probability negligible at any frame count this format will ever see. The
cost is 24 bytes per frame instead of 12, which at ~30 ops per frame is 0.4 bytes per op.

### 5.3 DECISION — frames are a set, not a sequence

The obvious design is a hash chain: each frame's AD includes the previous frame's digest, so
truncation is detectable. That design is wrong here, and the reason is the whole architecture:

> Two clients edit the same record concurrently. Both chain from frame *k*. Neither chain is
> wrong. There is no merge of two chains that preserves both without rewriting one — and
> rewriting requires the key, which the merge driver does not have.

So: **frames form an unordered set, keyed by their own digest.** The record's canonical on-disk
order is a sort, applied by whoever writes the file, not a structure the frames themselves carry.

```text
canonical order = sort by (hlc.wall_ms, hlc.counter, actor, frame_digest)
```

All four components, in that order, so the sort is total and stable. Two clones holding the same
frame set produce byte-identical files, which invariant 9 requires and which git requires far
more urgently — a file that differs between clones for identical content is a file that is
permanently "modified".

**Truncation detection moves** from the chain to two other places: the manifest's per-record frame
count and set digest (§7), and — in a git workspace — git's own object integrity. Neither is
weaker; both are somewhere else, and that relocation must be stated because "we removed the hash
chain" reads as a weakening if the replacement is not named.

### 5.4 Why the ordering key is in the clear, and what that buys

`hlc` and `actor` sit in the frame header, outside the ciphertext, authenticated as AD. This is
the single decision that makes the git merge driver keyless:

| Without plaintext ordering | With plaintext ordering |
|---|---|
| The merge driver must decrypt to sort, so it needs the workspace key | The merge driver reads headers, unions by digest, sorts, writes. No key |
| A key must reach a non-interactive subprocess that any process on the box can invoke — a prompt (phishable), an agent (a standing decryption oracle), or an environment variable (worst) | Nothing to steal. The driver has no secret and can be run by anything |
| `git pull` fails or hangs for anyone without an unlocked session, including CI | `git pull` works for everyone, always, and conflicts surface later, in the tool, once |

### 5.5 What the plaintext ordering key discloses, priced

| Disclosed to someone holding the repo but not the key | Value to them |
|---|---|
| The number of distinct writers per record | Team size, per device. This is `31-threat-model.md` §7.2's M6, at finer granularity |
| The relative order and wall-clock timing of every write | Working hours per person per device. M4/M5 at record granularity |
| Which records each pseudonymous writer touches | An activity map: "actor `9f2a…` writes to 40 records, actor `c1b8…` to 3" |
| **Not** disclosed | Who the actors are, what the records are about, what any value is |

`actor` is `blake3_keyed(K_name, actor_id)[0..8]` — stable within one workspace, unlinkable
across workspaces, meaningless without the key.

**The trade, stated plainly:** we disclose a pseudonymous edit-activity graph in order to make
`git merge` work without a key. For a workspace kept in a private repo alongside the people who
hold the key anyway, that costs nothing. For a workspace committed to a repo that outlives the
engagement, or forked, or made public by accident, it hands an observer a staffing and
change-window signal without any decryption. `31-threat-model.md` §8.1 branch A1.1.4 already
names the forgotten git repo as a cheap route to the ciphertext; this adds a second, smaller
prize on the same branch.

**If that is unacceptable for a given workspace,** the alternative is `settings.git.opaque_frames
= true`, which moves `hlc` and `actor` inside the ciphertext and makes the merge driver require a
key. The cost of that setting is §12.6's degraded flow, and the setting exists so the choice is
the user's rather than ours.

### 5.6 Key commitment

The frame header carries a 16-byte commitment tag:

```text
commit = blake3_keyed(K_rec, "fathom/v1/commit" ‖ nonce)[0..16]
```

AEADs built on Carter–Wegman MACs — AES-GCM and ChaCha20-Poly1305 both — are not committing:
a ciphertext can be constructed that decrypts without error under more than one key (Len, Grubbs
and Ristenpart, *Partitioning Oracle Attacks*, USENIX Security 2021). Fathom is a
password-derived-key system where an attacker holding the ciphertext grinds offline
(`31-threat-model.md` row 19), which is precisely the setting in which a partitioning oracle turns
`n` guesses per trial into many. Checking `commit` before attempting the AEAD open costs one
BLAKE3 invocation per frame and removes the class.

The cost is 16 bytes per frame — 23 % of the frame overhead — and it is worth it because the
alternative is arguing about it in a security review.

### 5.7 Padding

Per `31-threat-model.md` §7.6, Padmé padding is on by default. It applies to the **frame body**,
before sealing, after compression. Padmé bounds length leakage to `O(log log M)` bits with at most
12 % overhead, falling to about 6 % at 1 MB (Nikitin et al., PoPETs 2019(4)).

Interaction worth naming: padding a 200-byte op batch to its Padmé bucket is proportionally
expensive — small values sit in the regime where the overhead bound is loosest. Frames below
512 bytes are padded to 512 flat, which costs more absolutely and less proportionally than
Padmé's own answer at that size, and which removes the "this frame was one field" signal
entirely. Above 512 bytes, Padmé.

### 5.8 Compression, and where it is not allowed

| Record kind | Compressed before sealing? | Why |
|---|---|---|
| `DeviceGraph`, `Fabric` | yes | CBOR with `FieldKey(u16)` keys still has structural redundancy; ULIDs do not compress and are ~25 % of the bytes |
| `DeviceProv`, `DeviceHistory` | yes | Same |
| Captures | yes, and it is the biggest win | Configuration text compresses roughly 5–10× (`11-ir-schema.md` §14.1) |
| `Settings`, `Pins`, `Suppressions` | **no** | Small, and containing short attacker-influenceable strings next to secrets-adjacent values. Compression-before-encryption leaks plaintext similarity through length; on a record small enough that one field dominates the length, that is a usable oracle |
| `ai/cache/*` | yes | Model output, highly redundant |

`11-ir-schema.md` §14.1 leaves this open with a `VERIFY`. This is the answer for the format:
**compress the large, structural, low-entropy records; do not compress the small ones.** The rule
of thumb is that compression is safe where an attacker cannot vary one input and observe the
length of the result, and suppressions and settings are exactly where they can.

---

## 6. Filenames

### 6.1 The failure this section exists to prevent

```text
records/device-dc-edge-fw01.frec
records/device-lhr-core-sw02.frec
records/tunnel-VPN-DC-EAST.frec
records/site-frankfurt.frec
```

That directory listing gives an attacker the estate inventory, the naming convention, the site
list and the VPN topology, and it does so through `ls`, against a workspace whose contents are
perfectly encrypted. Every byte of the cryptography above is defeated by the ergonomics of
choosing a filename. It is worth saying at this length because it is the sort of thing that gets
added later "for debuggability".

### 6.2 The three candidate schemes

| Scheme | Stable across writes? | Same on two clones? | Leaks? |
|---|---|---|---|
| Human-readable | yes | yes | **everything** |
| Content-addressed — `blake3(ciphertext)` | **no**, changes on every write | yes | Every write creates a new file and deletes an old one. Git sees a rename-plus-add on every save, the working tree churns, and the *rate* of change per record is on display |
| Random at creation | yes | **no** — two clients creating the same record pick different names, git sees two files, and the merge driver never runs | nothing |
| **Keyed pseudonym** | yes | yes | count and change pattern only |

Only the fourth satisfies all three requirements at once, and the requirement that kills the other
two is the least obvious: **the name must be a deterministic function of identity and the key, so
that two clients that independently create the same logical record create the same file.**
Otherwise git cannot see them as the same file, and there is nothing for a merge driver to merge.

### 6.3 DECISION — keyed pseudonymous filenames

```text
pseudonym(record_id) = base32_lower_nopad(
                          blake3_keyed(K_name, "fathom/v1/name" ‖ record_id)[0..16] )
                       → 26 characters

path = records/<pseudonym[0..2]>/<pseudonym>.frec
```

`K_name = HKDF-Expand(WK, "fathom/v1/name-key", 32)`.

| Property | Detail |
|---|---|
| Deterministic | Two clones agree. A record created independently on two clients lands on one file |
| Stable | A rename of the device does not rename the file. A rewrite does not rename the file |
| Opaque | 128 bits of keyed output. Nothing recoverable without WK |
| Bucketed | Two characters → 1 024 directories, created lazily. At 5 000 devices that is ~20 records per directory |
| Sortable | Lexicographic order is pseudorandom, which is deliberate: directory order carries no creation order |

**What it still leaks, and there is no fixing it inside a directory:** the number of records, the
size of each, and which ones changed between two observations. That is `31-threat-model.md` §7.2's
M2, M3 and M8 applied locally instead of at a sync server. For a workspace in git, every historical
commit preserves that signal permanently.

**What it does not protect against:** anyone with the key. `K_name` is derived from WK, so a
colleague, an ex-colleague with an old clone, or anyone who cracks the passphrase can compute the
whole mapping. Filenames are not a second layer of defence and must never be described as one.

---

## 7. The manifest

### 7.1 What it is

`manifest.fm` is the index: the list of records, their sizes, their frame counts, the Merkle
structure the sync protocol descends (`33-sync-protocol.md` §8.3), and the workspace's identity.

```rust
pub struct Manifest {
    pub workspace_id: WorkspaceId,        // random 128-bit at creation. NEVER derived
                                          // from a name — see §6.1's failure mode
    pub generation: u64,                  // monotonic. Replay defence, 31 §5.2 row 5
    pub created: Timestamp,
    pub format_version: u16,
    pub schema_version: SchemaVersion,

    pub records: BTreeMap<RecordId, RecordEntry>,
    /// 1 024 bucket digests over `records`, keyed by pseudonym prefix.
    /// The sync index descends these; §33 §8.3.
    pub buckets: [Blake3; 1024],
    pub root: Blake3,

    /// Public keys only. Also held in the clear by the sync server, which is
    /// why it is a member *list* and not a member *secret*. 33 §3.5.
    pub members: Vec<MemberEntry>,
    pub compactions: Vec<CompactionRecord>,
}

pub struct RecordEntry {
    pub kind: RecordKind,
    pub frames: u32,
    /// BLAKE3 over the sorted list of frame digests. Order-independent,
    /// recomputed only when the record changes. O(f log f) per change.
    pub set_digest: Blake3,
    pub bytes: u64,
    /// Index of the newest Baseline frame in canonical order. Compaction target.
    pub baseline_at: u32,
    pub last_write: Timestamp,
}
```

### 7.2 The plaintext header

`format_version`, `schema_version`, KDF parameters, salt and `generation` sit in the manifest
file's header, outside the ciphertext, authenticated as AD — per `11-ir-schema.md` §11.2 and for
the same reason: a client must be able to discover it cannot read a workspace *before* spending
Argon2id on it, and a client must be able to detect a rollback without decrypting.

### 7.3 The manifest is derivable

Every field above except `generation` can be recomputed by walking `records/` and reading frame
headers. Frame headers are plaintext (§5.1), and `record_kind` is in the file header, so the
recomputation needs **no key at all** except to read `members` and the record kinds' semantic
detail.

That is not an accident; it is the property that makes §7.4 possible.

### 7.4 DECISION — the manifest is not committed to git

`manifest.fm` is in `.gitignore`.

**Why.** The manifest changes on every write. Committed, it would be the one file that conflicts
in every single merge — and it is the one file the keyless merge driver cannot union, because its
body is a sealed map, not a set of frames. Merging it would require the key, which would drag the
key back into `git merge`, which would undo §5.4.

Excluding it costs a full rescan of `records/` on open after a merge: `O(records)` `stat` plus one
32-byte header read each. At 500 devices that is 2 000 stats and 2 000 short reads — single-digit
milliseconds on any modern filesystem, hundreds on a cold network share. `VERIFY` that on a
Windows share before claiming it is free.

**Where the two transports get their ordering authority from, since they now differ:**

| Transport | Rollback / replay defence |
|---|---|
| **Git** | Git. Commits are ordered, a force-push is visible in the reflog, and every historical state is retained. The manifest adds nothing git does not already do better |
| **Sync server** | The signed manifest's `generation`, plus the client's record of the highest generation it has seen for that `workspace_id` (`31-threat-model.md` §5.2 row 5). The server holds the manifest; it is not in git |

Two transports, two mechanisms, neither pretending to be the other. The packed form (§2.1)
contains the manifest, because a packed workspace has no git and no server and needs its own
index.

---

## 8. Version pins

### 8.1 What is pinned and why it is in the workspace

Invariant 9: *same workspace + same corpus version + same build ⇒ byte-identical emitted config,
byte-identical findings, identical finder ranking.* "Same corpus version" is a precondition that
nothing records unless the workspace records it.

```rust
/// RecordKind::Pins. One record, small, uncompressed (§5.8).
pub struct Pins {
    pub schema_version: SchemaVersion,
    pub corpus: CorpusPin,
    pub packs: Vec<PackPin>,
    pub engine_min: Option<EngineVersion>,
    pub pinned_by: UserId,
    pub pinned_at: Timestamp,
}

pub struct CorpusPin { pub version: CorpusVersion, pub content_hash: Blake3 }

pub struct PackPin {
    pub id: PackId,
    pub version: PackVersion,
    pub content_hash: Blake3,
    /// Fingerprint of the publisher key that signed it. Recorded so a pack
    /// that appears under the same id from a different key is visible as a
    /// different thing — 12-rule-engine §13's scoped trust store, remembered.
    pub publisher_fpr: KeyFingerprint,
}
```

Content hashes as well as versions, because a version is a claim and a hash is a fact. The
conventions require corpus and rule-pack versions to be published with their content hash; this is
where the workspace remembers which one it saw.

### 8.2 What happens when the pin does not match what is installed

| Situation | Behaviour |
|---|---|
| Exact match, version and hash | Normal. Nothing is said |
| Same version, different hash | **Loud.** A pack or corpus was modified in place under an unchanged version number. The workspace opens; findings compute; every findings view and every emit carries `corpus 4.2.1 content differs from the pin` and the affected rule ids are listed. This is `31-threat-model.md` §8.2 branch B1.2 detected as a side effect of a version pin, and it is the cheapest such detection in the product |
| Newer corpus installed | Opens. Findings recompute against the newer corpus. A one-line note: `findings computed at corpus 4.4.0, workspace pinned at 4.2.1 — 3 rules changed`. The pin advances only when the user saves |
| Older corpus installed | Opens. Same note, inverted. Rules that the pin's corpus had and this one does not are listed by id, because a finding that silently stops firing is worse than one that fires wrongly |
| Pinned pack absent entirely | Opens. Its rules do not run. Listed by pack id in the findings header, permanently, not as a dismissible notice |

**The trade:** the workspace never refuses to open because of a corpus mismatch. A tool that
refuses to open a document because a content pack is the wrong version is a tool people stop
carrying to a customer site. The compensating control is that every artifact leaving the tool
under a mismatch says so, in the same place the AI layer's partial-emit banner goes
(`11-ir-schema.md` §11.4).

---

## 9. Suppressions

Suppressions are `Suppression` (`12-rule-engine.md` §11.1) verbatim. This document specifies only
where they live and how they merge.

### 9.1 Sharded by rule domain

```text
RecordKind::Suppressions { domain }   where domain = the first dotted segment
                                      of the rule id: ipsec, zone, mtu, policy, …
```

One record per domain. Two engineers suppressing an `ipsec.*` finding and a `mtu.*` finding touch
different files and never meet. Two suppressing `ipsec.pfs.absent` and `ipsec.dh.legacy` touch the
same file and union cleanly (§12.4), because suppressions are an add-wins set keyed by
`SuppressionId` (`33-sync-protocol.md` §6.4, class E).

Domains are small — a handful of rule domains ship — so this is roughly 6–10 records regardless of
estate size.

### 9.2 What is deliberately not sharded by node

A suppression's *scope* can be `Finding`, `Node` or `Workspace` (`12-rule-engine.md` §11.1).
Storing suppressions with the device they anchor to would be the obvious move and it is wrong:
`Workspace`-scoped suppressions have no device, orphaned suppressions have lost theirs
(`12-rule-engine.md` §11.4), and — the deciding reason — **the suppression list is the artifact a
security reviewer reads**, and it must be readable as one list without walking 500 device records
to assemble it.

---

## 10. Settings

### 10.1 What is inside the ciphertext

```rust
/// RecordKind::Settings. Small. Uncompressed (§5.8).
pub struct Settings {
    // ── rendering ────────────────────────────────────────────────────
    pub depth: Depth,                          // Terse | Explained | Teaching
    pub depth_overrides: BTreeMap<BlockId, Depth>,

    // ── defaults that describe the estate ────────────────────────────
    pub default_platform: Option<PlatformId>,
    pub emit_style: EmitStyle,                 // wrap width, backslash continuation

    // ── sync, which describes intent ─────────────────────────────────
    pub sync: Option<SyncSettings>,            // origin, cadence, padding, batching

    // ── the AI layer ─────────────────────────────────────────────────
    pub ai_tier: AiTier,
    pub ai_origin: Option<Origin>,
    pub ai_grants: Vec<ConsentGrant>,          // 21 §8.4

    // ── the one setting that changes the format ──────────────────────
    /// Moves `hlc` and `actor` inside the ciphertext. Costs the keyless
    /// merge driver (§5.5, §12.6). Requires a full record rewrite to change.
    pub opaque_frames: bool,
}
```

All of it is inside the ciphertext, and the reason is not obvious for the first two: **a depth
setting of `Teaching` across the workspace tells an observer the team is ramping in, and a
`default_platform` of `junos-srx` tells them what the estate runs.** Neither is severe. Both are
free to protect.

### 10.2 What is deliberately not here

| Not in the workspace | Where instead | Why |
|---|---|---|
| Window size, pane layout, theme, last-opened path, scroll position | Local application config, per machine | Per-machine state in a shared document means two people fight over it on every sync, forever. This is the single most common way collaborative document formats become annoying |
| The tier-1 provider API key | Browser credential store, or the workspace under an explicit setting (`21` §7.2, and the invariant-3 disagreement at `31` §14.1) | Not this document's decision. Named so that it is visibly not an omission |
| The workspace passphrase, in any form | Nowhere. The user's head | Invariant 3 |
| Anything derived that can be recomputed | Nowhere | Derived elements are not part of the document (`11-ir-schema.md` §3.5) |

---

## 11. The AI audit log

`24-ai-determinism-and-offline.md` §5.3 already specifies this tree and this document does not
redefine it. What it adds is the record mapping, because "inside the workspace" has to mean
something concrete about files:

| `24` §5.3 path | `RecordKind` | Merge behaviour | Compaction |
|---|---|---|---|
| `ai/sessions/` | `Ai { Sessions }`, sharded 16 ways by session id | Grow-only set | Bodies evictable per `21` §8.6's ledger; ids never |
| `ai/proposals/` | `Ai { Proposals }`, sharded 16 | Grow-only set | Same |
| `ai/values/` | `Ai { Values }`, sharded 16 | Grow-only set. **Never evicted while the field exists** (`24` §4.3) | Never |
| `ai/egress/` | `Ai { Egress }` | Grow-only set | Bodies evictable, records not |
| `ai/cache/` | `Ai { Cache(Corpus) }`, `Ai { Cache(Graph) }`, `Ai { CacheIndex }`, `Ai { CacheLedger }` | Segmented-LRU state, last-writer-wins per entry — a cache is the one thing in this format where losing a write costs only latency (`24` §5.5 rule C5) | Bounded by `24` §5.4's budgets, which are enforced here as record byte caps |

Two format-level consequences the AI documents assume and do not state:

1. **`--no-cache` export must produce a clean diff.** `24` §5.3 promises this. It works because
   the cache is separate records, so excluding it is excluding files, not filtering bytes out of
   a shared container.
2. **`fathom workspace purge --ai` is a compaction, not a delete.** It rewrites the affected
   records with a baseline containing digests instead of bodies. In git, the old bodies remain in
   history forever. That must be in the user-facing text for that command, because "purge" implies
   otherwise and git will not cooperate.

---

## 12. Git

### 12.1 What actually works, and what does not

| Claim in brief §6.4 | Reality with this format |
|---|---|
| "git-versionable" | **Yes, fully.** Commits, branches, tags, history, blame at record granularity, `git bisect` over workspace states |
| "diffable" | **Not in git.** `git diff` on a `.frec` shows nothing useful, and must not pretend to. `fathom diff` (§12.7) is the diff tool, and a `textconv` makes `git diff` call it when a key is available |
| "portable" | **Yes.** A directory or one packed file, no runtime, no server, no database |
| Concurrent editing | **Yes, at frame granularity, keylessly** (§12.4). Semantic conflict resolution is elsewhere (`33` §6) |
| Repository size | **This is the cost.** §13.4 |

### 12.2 `.gitattributes` and `.gitignore`, committed

```gitattributes
# Records and captures: never text, never textually diffed, always merged by us.
# NOTE: do NOT use the `binary` macro here. `binary` expands to `-diff -merge -text`,
# and `-merge` would disable the custom driver, which is the entire mechanism.
*.frec   -diff -text merge=fathom
*.fcap   -diff -text merge=fathom-capture
*.fm     -diff -text merge=binary

# The generated note. Regenerated on every save; never worth a conflict.
FATHOM   -diff -text merge=ours
```

```gitignore
manifest.fm
*.frec.tmp
*.lock
```

### 12.3 The driver configuration, and why it cannot be committed

```ini
[merge "fathom"]
    name      = Fathom record merge — frame set union
    driver    = fathom git merge-record --base %O --ours %A --theirs %B --path %P
    recursive = fathom

[merge "fathom-capture"]
    name      = Fathom capture merge — content-addressed, identical or nothing
    driver    = fathom git merge-capture --ours %A --theirs %B --path %P
    recursive = fathom-capture
```

Git's placeholders are `%O` common ancestor, `%A` current version, `%B` other branch, `%L`
conflict-marker size, `%P` pathname, and `%S`/`%X`/`%Y` conflict labels (gitattributes,
*Defining a custom merge driver*). The driver must leave its result in the file named by `%A`.
Exit status: **0 = merged cleanly, 1–127 = conflicted, above 128 = the driver crashed and the
merge fails.** `recursive` names the driver used for the internal merges of multiple merge bases;
when unspecified git uses the same driver, so naming it here is documentation rather than
behaviour — but it is worth naming, because for this driver a merge of two ancestors is exactly
the same set union and is provably safe, and a reader should not have to work that out.

**`merge.<driver>.driver` lives in `.git/config`, not in the repository.** Git deliberately does
not let a cloned repository configure a command to execute — that would be remote code execution
by `git clone`. Consequence:

> **Every clone must run `fathom git install` once.** Without it, git falls back to its default
> binary merge, which for a `-text` file means: take ours, mark conflicted, do nothing. Nothing is
> lost, nothing is corrupted, and the user gets a conflict they cannot resolve by hand.

The install command writes the two `[merge …]` blocks into `.git/config` and nothing else. It
prints exactly what it wrote. It refuses to run against a repository it did not detect as
containing a Fathom workspace.

**The failure mode when someone forgets** is the one to design for, because someone always
forgets. `fathom` detects an unmerged path on open, recognises the stage-2/stage-3 shape, and
resolves it itself (§12.6). So the recovery path exists even for a user who never ran the install.

### 12.4 The merge algorithm, in full

```text
merge-record(base, ours, theirs) -> ours', exit code

 1. Read the 32-byte file headers of all three.
    If format_version differs between ours and theirs  -> exit 1  (a major format
      change is not something a merge driver may paper over).
    If record_id or record_kind differ                 -> exit 1  (two different
      records at one path is a bug or an attack; refuse).

 2. Scan frames. Each frame is self-delimiting: 4+1+10+8+24+16+4 header, then
    body_len bytes, then 16 bytes of tag. Compute BLAKE3 over each whole frame.
    Reading is O(bytes) with no allocation beyond the digest state.

 3. F = frames(ours) ∪ frames(theirs)         keyed by frame digest
    Frames are immutable, so identical content means identical bytes means one
    entry. `base` is not needed for correctness — a set union has no need of an
    ancestor — but it is read anyway, for step 5.

 4. Sort F by (hlc.wall_ms, hlc.counter, actor, digest).           §5.3

 5. Sanity, using `base`:
    - every frame in base must be in F. If one is missing, one side truncated
      history without a compaction claim -> exit 1, loudly.
    - if either side's frame set is a strict superset of F, we made an error.

 6. Write header + F to `ours` (%A). Atomic: temp file, fsync, rename.

 7. exit 0
```

**Complexity.** `O(n)` in the bytes of the two inputs, `O(f log f)` in the frame count for the
sort, `O(f)` memory holding digests and offsets — 48 bytes per frame, so a record with 10 000
frames costs 480 KB of driver memory. No decryption, no key, no network, no allocation
proportional to plaintext.

**Correctness.** The merge is a set union of immutable elements, so it is commutative,
associative and idempotent — a join semilattice. Therefore:

- `merge(a, b) == merge(b, a)` — order of parents does not matter;
- `merge(merge(a,b), c) == merge(a, merge(b,c))` — octopus and recursive merges are safe;
- `merge(a, a) == a` — re-merging is free;
- and the merged file's *bytes* are identical regardless of which side git called "ours",
  because the sort is total. **Two people merging the same two branches produce the same commit
  content.** That property is worth more than it sounds: without it, a shared branch accumulates
  differing-but-equivalent blobs and git's history becomes noise.

**What it does not do.** It does not detect that A set `dh-group group14` and B set `group19`. It
does not need to. Both frames are in the union; both ops are in the state; the field resolves to
`Field::Conflicted` at open, per `33-sync-protocol.md` §6.3, and the user is shown both values
with both authors. The merge driver's job is to lose nothing, and it loses nothing.

### 12.5 The capture driver

```text
merge-capture(ours, theirs):
  if bytes(ours) == bytes(theirs) -> exit 0            the common case, by §4.5
  else                            -> exit 1            two different plaintexts
                                                        hashed to one filename
```

The `else` branch is a BLAKE3 collision or a bug, and either way a merge driver is the wrong place
to decide. It fails loudly.

### 12.6 When the driver is not installed, or frames are opaque

Two cases produce a conflicted path in the index rather than a merged file:

1. The user never ran `fathom git install`.
2. `settings.opaque_frames = true` (§10.1), so `hlc` and `actor` are inside the ciphertext and the
   union cannot be sorted without the key.

Both are handled by the same recovery, which runs inside the tool where a key already exists:

```text
$ fathom merge --resolve

  reads the index stages for every unmerged path:
    git show :1:<path>   base
    git show :2:<path>   ours
    git show :3:<path>   theirs
  performs the same union (decrypting only in case 2, and only to sort),
  writes the merged file, and stages it:
    git add <path>

  7 records merged · 0 refused
  2 fields are now conflicted and need a human — open the workspace
```

That the three versions remain recoverable from the index after a failed merge is the reason case
1 is an inconvenience rather than a data-loss event. It is worth testing explicitly, because it is
the path most users will hit first.

### 12.7 Diff

`git diff` on ciphertext is worthless and must not be dressed up. Two mechanisms:

**A `textconv` for `git diff`**, opt-in via the same `fathom git install`:

```ini
[diff "fathom"]
    textconv  = fathom git show-record
    cachetextconv = true
    binary    = true
```

`fathom git show-record` decrypts one record and prints a stable, sorted, human-readable
projection: one line per field assertion, `NodeId` short form, field name, value, provenance
origin. Git then diffs *that*, and `git log -p` becomes readable. It needs a key, so it prompts,
or fails cleanly when there is no TTY.

**`fathom diff` for anything that matters**, which is the real tool: it diffs two workspace states
semantically, produces the change set that `18-diff-verify-rollback.md` consumes, and knows the
difference between a rename (`11-ir-schema.md` §10.6: rules, suppressions, diagram positions and
provenance all survive it) and a change. `git diff` cannot know that; `fathom diff` is built on the
graph and does.

**Do not use `cachetextconv` on a shared machine** without understanding it: git caches the
textconv output in `.git/`, in plaintext, keyed by blob. That is a plaintext cache of workspace
contents inside the repository directory. `fathom git install` sets `cachetextconv = false` by
default and says why in its output. This is exactly the sort of convenience feature that quietly
undoes an encryption story.

### 12.8 Hooks, LFS, and things not to do

| Thing | Position |
|---|---|
| `pre-commit` hook that compacts | **No.** Compaction rewrites whole records and turns every commit into a large one (§13.4). Compaction is explicit |
| `post-merge` hook that rebuilds the manifest | Unnecessary. The manifest rebuilds on open (§7.3), and a hook that runs a decryption on `git pull` is a hook that will surprise someone |
| Git LFS | **No.** Records are hundreds of kilobytes, not hundreds of megabytes, and LFS moves the ciphertext to a second server with a second access model, which is a new trust boundary for no benefit. Captures are the largest objects and they are immutable, which is the case git handles best |
| `git-crypt` / `git-remote-gcrypt` underneath | **No.** Encrypting an already-encrypted store adds a second key to lose and defeats the append-frame delta property (§13.4), because a whole-file encryption layer rewrites every byte on every change. `git-crypt`'s own documentation states this: encrypted files do not delta-compress and the whole file is re-stored on every change |
| Committing `manifest.fm` | No. §7.4 |

---

## 13. Size budgets

### 13.1 The basis, and its honesty

Everything here is **arithmetic over the assumptions declared in `11-ir-schema.md` §14.2**, not
measurement. §14.2 itself carries a `VERIFY` requiring measurement against a real
`show configuration | display set` from an SRX345, and that requirement propagates here. No number
below may appear in user-facing material until it has been measured.

<!-- VERIFY: every figure in §13 is derived arithmetic. Measure against (a) a real SRX345
     whole-device capture, (b) a real 50-device workspace built by parsing, (c) a git repository
     after 90 days of a four-person team's edits, before any of these numbers is quoted. -->

Per fully-parsed mid-size firewall — 830 nodes, 1 900 edges, ~5 000 field assertions, 4 000 config
lines (`11-ir-schema.md` §14.2's device):

| Record | On disk, sealed, compacted | Derivation |
|---|---|---|
| `DeviceGraph` | ~200 KB | 830 nodes + 1 900 edges in canonical CBOR with `u16` field keys; ~104 KB of that is ULIDs, which do not compress |
| `DeviceProv` | ~190 KB | ~5 000 records × ~48 B on the wire, dominated by three ULIDs each |
| `DeviceHistory` | ~20 KB | Bounded at 16 entries plus one per origin (`11-ir-schema.md` §8.6). Near zero when new |
| Captures | ~38 KB | 220 KB of text at ~6× |
| Frame + padding overhead | ~50 KB | 69 B per frame plus Padmé, over a few hundred frames |
| **Total** | **≈ 500 KB** | |

Per hand-modelled device — a walkthrough-created SRX with the field card's six objects and five
plumbing pieces, no capture: **≈ 12 KB**, in ~40 nodes.

### 13.2 The three workspaces

| | **50 devices** | **500 devices** | **5 000 devices** |
|---|---|---|---|
| All hand-modelled, on disk | 0.6 MB | 6 MB | 60 MB |
| All parsed, on disk | 25 MB | 250 MB | 2.5 GB |
| **Realistic mix — 30 % parsed** | **8 MB** | **80 MB** | **800 MB** |
| Record files (mix) | ~210 | ~2 100 | ~21 000 |
| Nodes in the graph (mix) | ~15 000 | ~150 000 | ~1 500 000 |
| Resident memory, everything loaded | ~55 MB | ~550 MB | ~5.5 GB |
| Resident memory, graph + provenance only | ~40 MB | ~400 MB | ~4.0 GB |
| Resident, lazy provenance (graph only) | ~14 MB | ~140 MB | ~1.4 GB |
| Open: read + AEAD + CBOR decode | **~0.3 s** | **~3 s** | **~30 s** |
| Full rule sweep (`12-rule-engine.md` §: 1.5 s / 20 000 nodes) | **~1.1 s** | **~11 s** | **~112 s** |
| One field edit: bytes written | ~350 B | ~350 B | ~350 B |
| One device re-parse: frames appended | ~840 KB | ~840 KB | ~840 KB |

Open time assumes ~250 MB/s for XChaCha20-Poly1305 and ~80 MB/s for canonical CBOR decode in
WASM. Both are soft; WASM AEAD without SIMD can be several times slower.

<!-- VERIFY: AEAD and CBOR throughput in the actual WASM build, with and without the
     `simd128` target feature, on a mid-range laptop and on a five-year-old one. The open-time
     row is the number users will feel first. -->

### 13.3 Where it stops working, and why it is not the crypto

Brief §6.4 says it honestly already: *"At several thousand devices it stops being one."*
`11-ir-schema.md` §14.2 confirms it from the other end. Here is which thing breaks first:

| Devices | Browser | CLI | Git | What is actually the constraint |
|---|---|---|---|---|
| **≤ 100** | comfortable | trivial | trivial | Nothing. This is the design target and it covers a very large fraction of real estates |
| **100–500** | needs lazy provenance and lazy captures; a tab at 400 MB is a tab that gets discarded by the browser under memory pressure | comfortable | 2 000 files, fine | **Browser memory.** `11-ir-schema.md` §14.2 already puts full residency's ceiling at 50–80 devices |
| **500–2 000** | no | comfortable | 8 000 files, `git status` noticeably slower | **The rule sweep.** 11 s at 500 devices is a background job with a progress indication; at 2 000 it is 45 s and continuous lint (brief §6.6) has stopped being continuous |
| **> 2 000** | no | resident memory in gigabytes; possible, unpleasant | 21 000+ files, `git gc` measured in minutes | **The premise.** You now want to *query* — "every tunnel in the estate without PFS" — over data you cannot hold resident, and that is a database question that a document answers by loading everything |

**The honest statement.** The document model does not fail because encryption is slow or git is
slow. It fails because a document is something you load, and above a few thousand devices you stop
wanting to load it and start wanting to ask it questions. That is the boundary, and it is exactly
where brief §6.4 predicted it.

### 13.4 The escape hatch, which is not "add Postgres"

There is one partial answer that stays inside the design, and it is worth specifying because
otherwise somebody will reach for a database:

```rust
/// RecordKind::Index — one per workspace, or sharded at very large sizes.
/// A small projection of the queryable fields of every node in the estate,
/// maintained incrementally on write. ~64 bytes per node.
pub struct IndexEntry {
    pub node: NodeId,
    pub kind: NodeKind,
    pub device: NodeId,
    pub name_nk: NaturalKeyHash,          // 12 §11.4's key, already computed
    pub flags: NodeFlags,                 // has_pfs, is_v2_only, is_tombstoned, …
    pub last_finding_sweep: Timestamp,
}
```

At 1.5 million nodes that is a 96 MB index record — loadable when the full graph is not.
"Every tunnel without PFS" becomes a scan of the index rather than a load of the estate. It is
inside the ciphertext, it is a record like any other, it merges like any other, and it is
maintained by the same write path.

What it does not give you: joins, ad-hoc predicates over unindexed fields, or anything the rule
engine needs the full graph for. It is a capability floor for the largest workspaces, not a
database. **If a deployment needs more than this, the honest answer is that Fathom is the wrong
tool for that deployment, and NetBox or Nautobot is the right one** — with the loss of the
opinions that brief §6.4 says are the point.

### 13.5 Git repository growth, which is the number nobody budgets for

This is where the append-frame design earns its complexity, and where it does not.

| Scenario | Working tree | New git objects | Note |
|---|---|---|---|
| One field edit | +350 B in one record | A **new blob of the whole record** — 200 KB — until `git gc` | Git stores blobs whole; delta compression happens at pack time |
| Same, after `git gc` | | ~400 B, if the packer finds the old blob as a delta base | The append preserves the prefix, so the delta is a copy instruction plus the new tail |
| One device re-parse | +840 KB across two records | ~840 KB packed | New frames genuinely are new bytes |
| One record compaction (§`33` §9) | record shrinks | **A full new blob, and the old one is retained forever** | §13.6 |
| Whole-record rewrite (`opaque_frames` toggled, or a schema migration saved) | every record | every record, whole | A format-level event; announce it |

**The critical caveat.** Git's delta compression is a heuristic. Objects are considered as delta
bases within a window (10 by default) after sorting by type, then by path name, then by size, and
the packer will not delta across arbitrary distance. Prefix-preserving appends make a good delta
*possible*; they do not make it certain. `git-crypt`'s documentation states the general case
plainly — encrypted files are not compressible and the smallest change forces git to store the
entire changed file rather than a delta — and this format's whole answer to that is "do not change
the earlier bytes". Whether the packer then finds it is empirical.

<!-- VERIFY: measure. Build a 50-device workspace, make 500 single-field edits across 90
     commits, run `git gc`, and compare `git count-objects -vH` against the same experiment with
     whole-record rewrites instead of frame appends. If the delta is not found in practice, the
     append design still buys the keyless merge driver and loses only the size argument, and this
     section must be rewritten to say so. -->

Order-of-magnitude arithmetic for a four-person team, 500-device workspace, 90 days:

```text
  edits          200 field assertions per person per working day
  working days   ~64
  total edits    ~51 200 assertions  →  ~1 700 frames  →  ~6 MB of frames
  re-parses      120 devices re-parsed once  →  ~100 MB of frames
  compactions    ~60 records compacted once   →  ~12 MB of full rewrites, old
                                                  blobs retained
  packed repo    ~120 MB of history on top of an ~80 MB working tree
```

That is a fine size for a repository. It is not fine if a team runs `fathom compact` on a schedule
— see below.

### 13.6 Compaction and git are in direct opposition

Compaction (`33-sync-protocol.md` §9) replaces a record's frames with one baseline. It shrinks the
working tree and the sync server's storage. In git it does the opposite:

> **In a git-versioned workspace, compaction is not a saving. It is a purchase.** The compacted
> record is a whole new blob with no delta base; the pre-compaction blobs stay in history forever;
> and the size of the repository goes up by roughly the size of the compacted state, permanently.

The rule that follows:

| Where the workspace lives | Compaction policy |
|---|---|
| Git only | Compact rarely and deliberately — before publishing a clean branch, before archiving, or when a record's frames exceed the automatic trigger by a wide margin. Never on a schedule |
| Sync server only | Automatic, per `33` §9.5's trigger. This is where compaction pays |
| Both | Compact on the sync path; let the git working tree carry frames. The two transports have different economics and pretending otherwise costs repository size |

---

## 14. Import

### 14.1 The formats

| `--format` | Source | Provenance written |
|---|---|---|
| `display-set` | `show configuration \| display set` paste or file | `Origin::Parsed` with capture, span, stanza, parser, parser version |
| `fathom-json` | The major-stable export (§15.2) | `Origin::Imported { format: FathomExport, document_digest, locator }`, with the original provenance preserved where the export carried it |
| `netbox`, `nautobot` | API dump or CSV export | `Origin::Imported`, `locator` = the API path or row number |
| `csv` | A spreadsheet, per kind | `Origin::Imported`, `locator` = `row 412` |
| `batfish` | A Batfish vendor-independent model dump | `Origin::Imported`. Marked `Confidence::Derived`, because Batfish's model is itself derived |

### 14.2 Import is a reconciliation, never a replace

Imports reuse `12-rule-engine.md` §11.4's machinery unchanged: match by natural key, pair,
present a plan, apply on confirmation. Three rules, none of them negotiable:

1. **An import never silently overwrites an `Origin::Hand` value.** A conflict between an imported
   value and a hand-entered one is presented, per field, with both values and both provenances.
   This is the same shape as a merge conflict (`33` §6.3) and uses the same screen.
2. **An import may not assert `Absent`.** `11-ir-schema.md` §8.5 permits exactly two things to
   assert absence, and an import from NetBox is neither. An imported record that lacks a field
   yields `Unknown`, never `Absent`. Getting this wrong would make `ipsec.pfs.absent` fire on
   every device imported from a source-of-truth that does not model PFS — which is every one of
   them.
3. **Import writes to a scratch workspace first, by default.** `fathom import --into new` produces
   a separate workspace so a bad import is discarded rather than merged out. `--into current`
   exists and requires the reconciliation confirmation.

### 14.3 What import cannot fix

Brief §2.2 is the governing fact: source-of-truth accuracy falls to roughly 15–30 % without
automated synchronisation. Importing a NetBox estate produces a workspace that is 15–30 % accurate
and *looks* complete, which is worse than an empty one, because an empty one prompts a paste.

Therefore every imported node carries its age and its origin, and `11-ir-schema.md` §8.7's
staleness bands apply from the import timestamp — an imported device is `Ageing` at 30 days like
any other. And the import summary says, in the card's register:

```text
IMPORTED FACTS ARE CLAIMS, NOT OBSERVATIONS — PARSE A CONFIG TO PROMOTE THEM
```

---

## 15. Export

### 15.1 The two kinds, and why one of them is dangerous

| Kind | What it is | Gate |
|---|---|---|
| **Sealed export** | A packed `.fathom`, optionally `--no-cache`, `--no-captures`, `--no-ai`. Still ciphertext, still needs the passphrase | None beyond the normal save. It is a copy of a thing that is already encrypted |
| **Plaintext export** | Readable output: JSON, CSV, a review pack, a config bundle | §15.3. Every control in this document |

`31-threat-model.md` §2.2 establishes the ranking that drives §15.3: **a findings export is a more
dangerous artifact than a config export.** A configuration is a description; a findings list is a
ranked assessment with remediation syntax attached, which is the work that separates a competent
attacker from an incompetent one. The gating must reflect that ordering and not the intuitive one.

### 15.2 Plaintext formats

| `--format` | Contents | Sensitivity, per `31` §2.1 |
|---|---|---|
| `fathom-json` | Flat, self-describing, schema-tagged dump of nodes, edges, provenance. **Major-stable** — readable by any build regardless of `schema_version` major (`11-ir-schema.md` §11.4 mitigation 2) | V4–V9. The disaster-recovery format |
| `csv` | One file per kind, flattened | V4–V8 |
| `config` | Emitted configuration for a chosen emit unit and platform | V4–V8, and it is what the user came for |
| `review` | Findings, in full, with `why`, `remediation`, sources — **plus every suppression with its reason, author and date** | **V2 and V3. The most dangerous artifact the product can produce** |
| `runbook` | The verify ladder and rollback for one change (`18-diff-verify-rollback.md`) | Low. It is mostly `show` commands |

### 15.3 The plaintext gate

Deliberately friction-full. Each step is there for a stated reason, and each reason is a
limitation of the step before it.

| # | Step | Why |
|---|---|---|
| 1 | **Re-enter the passphrase**, even in an unlocked session | An unlocked tab left on a desk is not consent. This is the only action in the product that re-prompts |
| 2 | **The export gate runs** — `ExportGate::Blocked` if any `Weakening` in scope has neither a rendered finding nor a suppression with a reason (`31-threat-model.md` §9.4) | The interlock. This is the one place the product refuses, and the refusal is resolvable in one step |
| 3 | **A typed reason, minimum 20 characters**, empty by default, no suggestions, same blocklist as suppressions (`12-rule-engine.md` §11.2) | Consistency of discipline. And because the reason is the only part of the record a reviewer can actually evaluate |
| 4 | **A typed confirmation of the scope**, literally: `EXPORT 47 DEVICES AND 212 FINDINGS IN PLAINTEXT` | A button is muscle memory. Typing a sentence that states the number is not. The number is computed, not chosen |
| 5 | **Captures require a second confirmation** if included | Raw configuration text is the largest disclosure per byte in the workspace, and it is off by default |
| 6 | **An `ExportRecord` is appended to the workspace before the file is written** | §15.4 |
| 7 | **The output carries a header** | §15.5 |

There is **no `--yes`, no `--force`, no "remember this choice", and no setting that disables any of
it.** `--reason` is a required argument of the CLI form, and the CLI form performs steps 1, 2, 3,
5, 6 and 7 exactly as the UI does.

### 15.4 The export log

```rust
/// RecordKind::ExportLog. Append-only. Never compacted, never evicted,
/// never pruned by any command including `workspace purge`.
pub struct ExportRecord {
    pub id: ExportId,                        // fathom:export:<ulid>
    pub at: Timestamp,
    pub actor: UserId,
    pub format: ExportFormat,
    pub scope: ExportScope,                  // devices, emit units, finding ids
    pub counts: ExportCounts,                // devices, nodes, findings, suppressions
    pub included_captures: bool,
    pub included_suppressions: bool,
    pub reason: BoundedText<2000>,
    /// BLAKE3 of the bytes written. Lets a reviewer confirm that a file found
    /// elsewhere is or is not this export.
    pub output_digest: Blake3,
    pub output_bytes: u64,
    /// The gate's verdict, and every Weakening it saw.
    pub gate: ExportGateOutcome,
    pub corpus: CorpusVersion,
    pub packs: Vec<(PackId, PackVersion)>,
}
```

Written **before** the output file, so that a crash mid-write leaves a record of an export that may
have partially happened, rather than an export with no record.

**Three honest limits, stated because a control whose limits are not stated is a claim:**

1. **It stops nobody.** The exporter holds the key. Every step above is friction on a person who
   is authorised and has decided.
2. **The record is inside a document the exporter can also edit.** They can delete the
   `ExportLog` record, or export the workspace without it, or simply copy the whole `.fathom` file
   and never use the export path at all. The record is evidence for a *reviewer*, on the honest
   assumption that the person exporting is not covering their tracks.
3. **Friction is routed around by scripting.** `--reason "automated nightly"` is one string in a
   cron job. We accept that, for the same reason `12-rule-engine.md` §11.2 accepts that a
   suppression reason validator cannot make someone write a good reason: **the control is
   legibility in review, not prevention.** A nightly plaintext export with a bad reason is a thing
   a reviewer can see and ask about, which is more than exists today.

### 15.5 The header on the output

Every plaintext export begins with the same block, in the field card's register — a disclaimer
that is also the most useful sentence on the page:

```text
# Fathom plaintext export
# THIS FILE IS PLAINTEXT. EVERY PROTECTION THE WORKSPACE HAS ENDS HERE.
#
# workspace   site-b            export  fathom:export:01JZQ8…
# exported    2026-07-28T09:14:02Z   by  j.okonkwo
# scope       47 devices · 212 findings · 18 suppressions · captures excluded
# reason      "Handover pack for the DC-EAST migration review, CHG-2026-0211"
# corpus      4.2.1  packs  ipsec-core 2.9.0
# build       fathom 3.1.4  schema 3.2
#
# VERIFY AGAINST YOUR OWN BOX BEFORE ACTING
```

The last line is the field card's own imperative, unchanged, because an exported configuration is
exactly the situation it was written for.

For `--format review` — the findings and suppressions pack, the most dangerous artifact — one
additional line, and it is not softened:

```text
# THIS FILE IS A RANKED LIST OF THIS ESTATE'S WEAKNESSES, WITH THE SYNTAX TO FIX
# EACH ONE ATTACHED. IT IS MORE SENSITIVE THAN THE CONFIGURATION IT DESCRIBES.
```

---

## 16. Corruption, truncation and recovery

### 16.1 The failure modes, and what each looks like

| Failure | Detected by | Recovery |
|---|---|---|
| One frame's tag fails | AEAD open | **That frame only** is skipped, logged, and reported. The rest of the record applies. This is the strongest argument for per-frame sealing: bit-rot costs one op batch, not one workspace |
| A record file is truncated mid-frame | Frame self-delimiting scan hits a short read | Truncated tail dropped, reported by count. Preceding frames apply |
| A record file is missing entirely | Manifest rebuild finds a record referenced by an edge in another record | The elements it held are gone. `fsck` reports which `NodeId`s are referenced but absent, per kind |
| The whole `records/` is intact but the manifest is stale | Rebuild on open (§7.3) | Automatic, silent, always |
| `keys.fk` is lost or corrupt | Header parse or KDF | **Total loss.** There is no recovery and there is no backup key. The `FATHOM` note says so in line 4 |
| Wrong passphrase | Key-commitment tag (§5.6), before the AEAD | Fast, unambiguous rejection. Without the commitment tag this is a failed AEAD open, which is indistinguishable from corruption |
| A frame claims a `record_id` that does not match its file | AD binding | The AEAD fails. A frame cannot be relocated |

### 16.2 `fathom fsck`

```text
$ fathom fsck site-b.fathom --verbose

  W O R K S P A C E   I N T E G R I T Y                          site-b.fathom

  container      2 104 records · 8 412 frames · 81.2 MB · format 1 · schema 3.2
  frames         8 412 opened · 0 tag failures · 0 truncated
  manifest       rebuilt from records (not committed, §7.4)

  graph L0       every edge endpoint present            ok
                 containment forms a forest             ok
                 no AddressSet cycles                   ok
  graph L1       14 referential holes                   listed below
  provenance     every Field.prov resolves              ok
                 3 capture spans point past end of blob WARN
  suppressions   6 orphaned · 2 expiring within 14 days
  pins           corpus 4.2.1 content hash MATCHES
                 pack ipsec-core 2.9.0 NOT INSTALLED    41 rules did not run
  ai             values 7 · egress 3 · cache 6.1 MB / 24 MB

  3 warnings · 0 errors
```

`fsck` is read-only. `fsck --repair` exists and does exactly three things, each of which is
information-preserving: rebuild the manifest, drop frames that fail their tag (after listing
them), and re-bind orphaned suppressions whose `anchor_nk` matches exactly one node
(`12-rule-engine.md` §11.4). **It never deletes a node, never resolves a conflict, and never
guesses.** Anything else is a job for a human with the workspace open.

### 16.3 Atomic writes

Every record write is: write `<pseudonym>.frec.tmp`, `fsync`, `rename` over the target, `fsync` the
directory. The manifest is written last, after every record it references. A crash therefore leaves
either the old state or the new state of each record, with a manifest that may be stale — and a
stale manifest is the one failure this format is designed to shrug off (§7.3).

`.frec.tmp` is in `.gitignore` because a crash mid-save inside a git working tree would otherwise
offer the temp file for commit.

---

## 17. What this format costs

Stated as a list rather than buried, in the register of `11-ir-schema.md` §16.

| Cost | Detail |
|---|---|
| **Two container forms** | Directory and packed. Two code paths, one round-trip property test, and one class of bug where they diverge |
| **Four records per device** | A device's data is in four files. Everything reasoning about "a device" must know that, and `fsck` exists partly to enforce it |
| **69 bytes of overhead per frame, plus padding** | At ~30 ops per frame, about 2.3 bytes of header per op, plus Padmé's up-to-12 % and a 512-byte floor on small frames. A single-field save costs ~350 bytes on disk to record ~40 bytes of change |
| **Plaintext ordering keys** | A pseudonymous edit-activity graph is visible to anyone holding the repository without the key (§5.5). Bought the keyless merge driver; priced, and revocable per workspace at the cost of that driver |
| **Filenames are only as good as the key** | Anyone with WK computes the whole mapping. Filenames are not defence in depth and must never be described as such |
| **Compaction fights git** | §13.6. In git, compacting makes the repository permanently larger. There is no arrangement in which both transports want the same policy |
| **Every clone needs `fathom git install`** | Git will not let a repository configure a command, correctly. The recovery path for a user who forgets is good but it is a second mechanism to maintain |
| **`git diff` is useless without a textconv, and the textconv caches plaintext if you let it** | §12.7. The convenient default is the wrong default and we ship the inconvenient one |
| **No in-workspace compartmentation** | One key, one document, everything. `31-threat-model.md` §5.1 row 13 and R8. Sharding by device is a *storage* boundary, not an access boundary, and calling it one would be a lie: `K_rec` is derived from WK, so holding WK holds every record |
| **The size ceiling is real and is not the crypto's fault** | §13.3. Above ~2 000 devices the premise stops fitting, exactly as brief §6.4 predicted |

---

## 18. Open decisions

| # | Decision | Options | Leaning |
|---|---|---|---|
| W-1 | Should `DeviceProv` be sharded when a single device's provenance exceeds a threshold (a 40 000-line config) | (a) No — accept a 2 MB record. (b) Shard by capture id | (a) until measured. Provenance is written together and read rarely |
| W-2 | Frame body compression algorithm | (a) deflate (ubiquitous, small in WASM). (b) zstd (better ratio, larger dependency). (c) none | (a). §8.4 of the brief's minimal-dependency posture outranks the ratio |
| W-3 | Should the packed form support streaming open, or must it be fully read | (a) Streaming with an offset table. (b) Read whole | (b) at these sizes; revisit if the packed form is used above 500 devices |
| W-4 | Do we ship an `Index` record (§13.4) in v1, or only when someone hits the ceiling | (a) v1. (b) When needed | (b). It is a real subsystem and speculative at 100 devices |
| W-5 | `opaque_frames` default | (a) false — keyless merge. (b) true — no activity graph | (a), with the setting presented at workspace creation for anyone whose threat model is `31` §7.3's |
| W-6 | Should `fathom git install` also install a `pre-push` hook that refuses to push a workspace containing an `ExportLog` entry newer than the last commit | (a) Yes. (b) No | (b). A hook that blocks a push based on document contents will be removed by the first person it inconveniences, and it protects nothing |

---

## 19. Sources

| Claim | Source |
|---|---|
| Custom merge driver placeholders `%O %A %B %L %P %S %X %Y`; result left in `%A`; exit 0 = clean, 1–127 = conflict, >128 = driver failure; `merge.<driver>.recursive` names the driver for internal merges and defaults to the driver itself | `gitattributes(5)`, *Defining a custom merge driver*; `git-config(1)`, `merge.<driver>.*` |
| The `binary` attribute macro expands to `-diff -merge -text` | `gitattributes(5)` |
| `merge.<driver>.driver` is read from repository/user config, not from the tree | `gitattributes(5)`; the same property that makes `git clone` not execute repository-supplied commands |
| Encrypted files do not delta-compress; the smallest change forces git to store the entire changed file | `git-crypt` project documentation, *Limitations* |
| Padmé bounds length leakage to `O(log log M)` bits at ≤12 % overhead, ≈6 % at 1 MB | Nikitin, Barman, Lueks, Underwood, Hubaux, Ford, *Reducing Metadata Leakage from Encrypted Files and Communication with PURBs*, PoPETs 2019(4) |
| AES-GCM and ChaCha20-Poly1305 are not key-committing; a ciphertext can decrypt without error under multiple keys, enabling partitioning-oracle attacks against password-derived keys | Len, Grubbs, Ristenpart, *Partitioning Oracle Attacks*, USENIX Security 2021 |
| ChaCha20-Poly1305 AEAD | RFC 8439 |
| HKDF, used for all subkey derivation | RFC 5869 |
| Argon2id, and the parameter sets | RFC 9106 §4 |
| Canonical/deterministic CBOR encoding | RFC 8949 |
| Node/edge/field structure, `Presence`, provenance, capture spans, history retention, schema versioning and migration, per-device size arithmetic | `docs/10-core/11-ir-schema.md` §§3, 5, 8, 10.5, 11, 14 |
| `Suppression`, `Scope`, reason validation, expiry, natural-key rebinding, the review surfaces | `docs/10-core/12-rule-engine.md` §11 |
| The export interlock, `Weakening`, `ExportGate` | `docs/30-security/31-threat-model.md` §9.4 |
| Findings outrank configuration as an artifact; git repositories as an attack path; metadata channels M1–M10; Padmé default | `docs/30-security/31-threat-model.md` §2.2, §7, §8.1 |
| The AI store layout, cache segments and budgets, `--no-cache` export, `purge --ai` | `docs/20-ai/24-ai-determinism-and-offline.md` §4.3, §5.3, §5.4 |
| Field-card material: the six-object chain, commit-time reference enforcement, `VERIFY AGAINST YOUR OWN BOX BEFORE ACTING` | Owner's SRX IPsec field card, sides 1 and 3 |

---

## 20. Proposed amendments to other documents

Neither is acted on unilaterally.

**A1 — `11-ir-schema.md` §14.1's compression `VERIFY` should be closed with §5.8's rule.** The
open question there is whether compression-before-encryption is acceptable. The answer this
document proposes is *per record kind*: compress the large structural records and the captures,
do not compress `Settings`, `Pins` or `Suppressions`. The distinction is whether an attacker can
vary one input and observe the length of the result, and on a small record holding
attacker-influenceable text next to security-relevant values, they can.

**A2 — `11-ir-schema.md` §11.4's preserve-mode row "Sync / merge: unknown data merges as opaque
last-writer-wins per field" should be amended.** With frames, unknown data does not merge
last-writer-wins; it merges as a frame union like everything else, and the resolution of unknown
*fields* is deferred to whichever build understands them. The current wording describes a
mechanism this format does not have and would, if implemented literally, silently discard a
concurrent write from a newer client.

---

## 21. Disagreements

**21.1 — Invariant 9's "same workspace" is ambiguous once a workspace is synced.**

*The convention:* *"Determinism where it is observable. Same workspace + same corpus version +
same build ⇒ byte-identical emitted config, byte-identical findings, identical finder ranking."*

*The objection:* with frames and a CRDT, two clients can hold *causally equivalent* workspaces
whose files differ — one has received a frame the other has not yet, or one has compacted and the
other has not. Both are "the same workspace" in every sense a user means. Byte-identical emission
holds only for the *converged* state, and the invariant as written can be read to demand it of any
two copies at any moment, which is impossible and which would make the invariant false the first
time two people used the product together.

*Proposed replacement:* add one clause —

> **9. Determinism where it is observable.** Same *converged* workspace state + same corpus
> version + same build ⇒ byte-identical emitted config, byte-identical findings, identical finder
> ranking. Two copies of a workspace are the same converged state when they hold the same set of
> operations, regardless of file layout, compaction state or receipt order.

The addition matters because it turns the invariant into something CI can test: apply the same op
set in a thousand random orders, emit, and `cmp`.

**21.2 — the conventions pin four identifier schemes and this format needs four more.**

*The convention:* the *Identifiers* section pins node IDs, rule IDs, command corpus IDs, explainer
IDs, and corpus/pack versions. It does not pin identifiers for workspaces, records, storage
frames, or the syncing installations that write them.

*The objection:* two documents now need all four, and if `33-sync-protocol.md` and this document
had been written by different people we would have two incompatible schemes. That is precisely
what the conventions exist to prevent.

*Proposed addition to `conventions.md`, under Identifiers:*

```text
- Workspace id: `fathom:workspace:<128-bit random>`, generated at creation, never derived
  from a name, never reused. Opaque to users and to the sync server.
- Record id: `fathom:record:<ulid>` — the storage unit, not a graph element.
- Frame id: the BLAKE3 digest of the frame's bytes. Frames are content-addressed and
  immutable; they have no separate identifier.
- Client id: `fathom:client:<ulid>` — one syncing installation. NOT called a device.
  `Device` is a node kind (Terminology), and `31-threat-model.md` §7.2's "device count"
  metadata channel means client count.
```

The last one is the one that matters. "Device" already means a network device in this product, and
a sync protocol that calls a laptop a device will produce a document nobody can read.
