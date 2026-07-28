# 32 — The cryptographic design

> **Status:** Proposed

This document specifies the whole cryptographic scheme for a Fathom workspace: how a passphrase
becomes a key, how a key becomes a sealed record, how records become a file, how that file gets
shared with a colleague, how a colleague gets removed, and what every one of those steps costs.

It is written to be implemented from and to be argued with. Where a choice is a fork, it is marked
**DECISION** and the rejected option is stated with the reason it lost, not just the reason the
winner won. Where a number is modelled rather than measured, the model is shown so a reviewer can
redo the arithmetic with their own assumptions. Where I could not check something, it carries a
`VERIFY` marker rather than a confident sentence.

**The governing rule of this document, stated once, in caps, at the top:**

> **THE PASSPHRASE IS THE WHOLE SYSTEM. EVERYTHING BELOW IT IS A CONSTANT FACTOR ON A SEARCH THAT
> IS OTHERWISE FREE, UNMETERED AND UNLOGGED.**

`31-threat-model.md` §8.1 makes the same point from the other direction: the cheap leaves in the
attack tree are an extension, a colleague and a paste into a ticket, none of which is a
cryptographic attack. This document exists to make the cryptographic leaf the expensive one and
then to stop, rather than to keep building crypto that defends a branch nobody attacks.

---

## 0. Contents

| § | |
|---|---|
| 1 | The decisions, in one table |
| 2 | Scope, notation, and what lives in other documents |
| 3 | The key hierarchy |
| 4 | The KDF — Argon2id, its parameters, and the WASM reality |
| 5 | The AEAD — the choice, the nonce, and where the nonce argument actually breaks |
| 6 | The record model — deferred to `17` (ADR-0012); padding and what still leaks |
| 7 | The envelope, byte by byte |
| 8 | The manifest, replay and rollback |
| 9 | Rotation and revocation |
| 10 | Sharing and multi-user |
| 11 | Recovery |
| 12 | Hardware-backed keys — WebAuthn PRF |
| 13 | The offline single-file case, and git |
| 14 | Memory hygiene |
| 15 | What is deliberately not rolled by hand |
| 16 | Test vectors and cross-implementation compatibility |
| 17 | Things that bite |
| 18 | What CI enforces |
| 19 | Residual risk |
| 20 | Sources |
| 21 | Disagreements |

---

## 1. The decisions, in one table

Everything below is argued in place. This table exists so a reviewer can disagree with a decision
before reading forty pages of the reasoning for it.

| # | Decision | Chosen | Rejected, and why it lost |
|---|---|---|---|
| D1 | **KDF** | Argon2id v1.3, RFC 9106, `p=1`, memory calibrated, floor `m=64 MiB, t=3` | scrypt (weaker side-channel story, no `id` mode); PBKDF2 (memory-free, GPU-friendly); balloon (no maintained Rust impl I could verify) |
| D2 | **Parallelism** | `p = 1` | `p = 4` per RFC 9106 §4's second option. WASM threads need `SharedArrayBuffer`, which needs cross-origin isolation, which needs HTTP headers, which a `file://` single-file build cannot set. `p>1` on a single-threaded defender is pure ceremony (§4.3) |
| D3 | **Cipher family** | ChaCha20-Poly1305 (RFC 8439) | AES-256-GCM. WASM has no AES instructions; the acceleration argument only pays if you go through WebCrypto, which means moving plaintext into the JS heap (§5.3) |
| D4 | **Extended nonce** | **Not** XChaCha20. Per-record 256-bit random salt → HKDF → fresh subkey → **nonce is a constant zero** | XChaCha20-Poly1305 with a 192-bit random nonce. XChaCha is a CFRG draft, not an RFC; the derivation was needed anyway for key commitment, so the extended-nonce construction was buying nothing (§5.4) |
| D5 | **Key commitment** | 128-bit commitment tag derived alongside the record key, checked in constant time before decryption | Nothing. ChaCha20-Poly1305 is not key-committing, and a password-wrapped multi-recipient container is the textbook partitioning-oracle target (§5.6) |
| D6 | **Record granularity** | **Sharded per-record**: fixed shard count per class, node shard = `blake3(node_id) mod S`, `S` default 64 | Whole-workspace (one blob; defeats git and forces a full rewrite per keystroke) and per-node (leaks the node count exactly, and in an exploded directory leaks it as a *filename set*) (§6) |
| D7 | **Storage layout ≠ sync granularity** | Whole-container sync by default; per-record sync is opt-in with the metadata cost named | Per-record sync by default. It hands the server channel M8 (`31` §7.2) for free, which `31` §7.6 explicitly deferred |
| D8 | **On-disk shapes** | Two, from one logical format: `workspace.fathom` (single file) and `workspace.fathom.d/` (exploded, one file per record, fixed file set) | One shape. A single file does not diff in git; an exploded directory is a nuisance to mail (§13.2) |
| D9 | **Key wrapping to members** | HPKE (RFC 9180) `mode_base`, `DHKEM(X25519, HKDF-SHA256)` / `HKDF-SHA256` / `ChaCha20Poly1305` = `0x0020 / 0x0001 / 0x0003` | Hand-rolled ECIES. Specified, test-vectored, implemented; there is no reason to write this one (§10.2) |
| D10 | **Member-list integrity** | Hash-chained append-only log, Ed25519 quorum signatures, replayed from genesis on every open; the genesis digest is the printed workspace fingerprint | A member list the server stores as data. That is exactly the "server silently adds a member" attack (§10.4) |
| D11 | **Revocation** | Eager and blocking: epoch bump, every record re-sealed before the flow reports success | Lazy re-seal on write. "Revoked, but 400 records are still readable by them" is a lie told by a progress bar (§9.3) |
| D12 | **Recovery** | Optional. 240-bit printed code (Crockford Base32 + 40-bit checksum) as a second keyholder; Shamir `k`-of-`n` escrow as a third; both off by default | Mandatory recovery (an escrow backdoor by default) and no recovery at all (the correct default, and a terrible one to have *only*) (§11) |
| D13 | **Hardware keys** | WebAuthn PRF as an additional keyholder (OR) by default; AND-mode available and labelled with its consequence | PRF as the only keyholder. Support is still uneven and a lost passkey is a lost workspace (§12) |
| D14 | **Primary store, offline** | The file, alone. No browser storage of any kind in D1 (ADR-0017; OPFS-cache branch deleted per ADR-0012) | IndexedDB (blocked under `file://`), OPFS-as-truth (evictable without warning), and OPFS-as-cache (§13.1) |
| D15 | **PQ posture** | Symmetric path is already fine; the shared-workspace HPKE wrap is the harvest-now-decrypt-later exposure. Suite `0x02` reserved for X-Wing | Shipping a hybrid KEM now against a draft that is not yet an RFC (§10.7) |

---

## 2. Scope, notation, and what lives elsewhere

### 2.1 In scope

The confidentiality and integrity of a **workspace** — one encrypted document holding one user's or
team's graph, suppressions and settings — at rest on disk, at rest on a sync service, in a git
repository, and in transit between them.

### 2.2 Explicitly out of scope, and specified elsewhere

| Thing | Where |
|---|---|
| Everything that happens after the workspace is open in a compromised browser | `31-threat-model.md` §6.2 — and the honest answer is "nothing" |
| Metadata leakage at the sync service, Padmé, batching, the M1–M10 channel list | `31-threat-model.md` §7 |
| Rule-pack and corpus signing (Ed25519 / minisign, scoped trust store, no TOFU) | `docs/10-core/12-rule-engine.md` §13 |
| Release signing, reproducible builds, the version manifest | `docs/70-ops/`, and `31` §8.3 |
| TLS to the sync service | Not our problem beyond "use it, and do not depend on it" |
| Schema and format version semantics | `docs/10-core/11-ir-schema.md` §11 |
| What a graph *is* — nodes, edges, kinds, provenance | `docs/10-core/11-ir-schema.md` |
| The container: on-disk tree, record taxonomy, filenames, update model, git behaviour, `fsck`, import, export | `docs/10-core/17-workspace-format.md` (ADR-0012) |

This document uses the residual scale defined in `31-threat-model.md` §1.4 — `none`, `bounded`,
`material`, `total` — and does not invent a second one. It uses the three-value `Risk` enum
**nowhere**: `Risk` classifies what an emitted command does to a live box, and nothing in a
cryptographic container is an emitted command.

### 2.3 A terminology note, because the conventions are strict

`conventions.md` says never call a graph element a "record". This document uses **record** for
exactly one thing: *a unit of encryption inside the workspace container.* A record holds many nodes
and many edges. No node is ever a record and no record is ever a node. §21.1 proposes adding this
to the conventions so the next author does not have to re-derive it.

### 2.4 Notation

```
H(x)                 BLAKE3-256 of x                                (content digests)
HKDF-Extract(s, ikm) RFC 5869 §2.2, SHA-256                         (key path only)
HKDF-Expand(prk,i,L) RFC 5869 §2.3, SHA-256, L bytes
A2id(pw,s,m,t,p,L)   Argon2id v=0x13, RFC 9106, L output bytes
AEAD-Seal(k,n,a,p)   AEAD_CHACHA20_POLY1305, RFC 8439 §2.8
CSPRNG(n)            n bytes from the platform CSPRNG               (§5.5)
||                   concatenation
u32le / u64le        little-endian fixed-width integers
```

Two hash functions appear on purpose. **HKDF-SHA-256 is the only KDF in the key path**, because
HPKE's chosen suite mandates SHA-256 anyway (§10.2) and one hash family in the key path is worth
more than saving a few kilobytes of WASM. **BLAKE3 is the only hash in the content path**, because
the rest of the project already uses it (`12-rule-engine.md`, `24-ai-determinism-and-offline.md`)
and re-deciding that here would fork the codebase for no reason.

All info strings in this document are **ASCII byte strings with no trailing NUL**, written between
double quotes. They are part of the format. Changing one is a `format_version` bump.

---

## 3. The key hierarchy

### 3.1 The picture

```text
             ┌───────────────────────────────────────────────────────────────┐
             │  IN THE USER'S HEAD / ON PAPER / IN A SECURE ELEMENT          │
             └───────────────────────────────────────────────────────────────┘
                    │                    │                     │
        passphrase  │      recovery code │        passkey PRF  │      member's
        (UTF-8 NFC) │      (240 bits)    │        (32 bytes)   │      X25519 secret
                    │                    │                     │           │
          A2id      │        HKDF        │         HKDF        │        HPKE
      m,t,p=1,32B   │                    │                     │       Decap
                    ▼                    ▼                     ▼           │
                  ┌────────────────────────────────────────────┐           │
                  │  KEYHOLDER PARENT KEYS  (32 B each)        │           │
                  │  one per keyholder entry, never stored     │           │
                  └────────────────────────────────────────────┘           │
                    │                    │                     │           │
                    └────────────┬───────┴─────────────────────┘           │
                                 │ each opens ONE keyholder envelope       │
                                 ▼                                         ▼
                  ┌──────────────────────────────────────────────────────────┐
                  │  ROOT KEY   RK_e   — 32 random bytes, one per key epoch  │
                  │  the only thing any keyholder ever unwraps               │
                  └──────────────────────────────────────────────────────────┘
                                 │
                                 │  WK_e = HKDF-Expand(
                                 │            HKDF-Extract("fathom/v1/ws", RK_e),
                                 │            "workspace|" || ws_id || "|" || u64le(e),
                                 │            32)
                                 ▼
                  ┌──────────────────────────────────────────────────────────┐
                  │  WORKSPACE KEY   WK_e                                    │
                  │  key_id_e = H("fathom/v1/keyid" || WK_e)[0..16]          │
                  └──────────────────────────────────────────────────────────┘
                                 │
       ┌─────────────────────────┼─────────────────────────┬────────────────────┐
       │ per seal, per record    │                         │                    │
       ▼                         ▼                         ▼                    ▼
 ┌───────────┐            ┌───────────┐            ┌───────────┐         ┌───────────┐
 │ manifest  │            │ nodes/2a  │            │ captures/ │         │ suppress  │
 │ record    │            │ shard     │            │ 01J8…     │         │ record    │
 └───────────┘            └───────────┘            └───────────┘         └───────────┘
   K_enc, K_cmt             K_enc, K_cmt             K_enc, K_cmt          K_enc, K_cmt
   derived from WK_e + this envelope's 32-byte random salt + this envelope's header
```

### 3.2 The per-record derivation, exactly

This is the only derivation in the record path. It runs once per seal and once per open.

```rust
/// § 7.1 defines the header layout. `header[0..64]` is every fixed field before the
/// salt; `header[64..96]` is the salt; `header[96..112]` is the commitment tag, which
/// is an *output* of this function and therefore cannot be an input to it.
fn derive_record_keys(
    parent: &[u8; 32],        // WK_e for ordinary records; a keyholder parent key for keyholders
    header: &[u8; 112],
    aad_ext: &[u8],           // empty for ordinary records; the keyholder descriptor otherwise
) -> (Zeroizing<[u8; 32]>, [u8; 16]) {
    let salt: &[u8; 32] = header[64..96].try_into().unwrap();
    let prk  = hkdf_sha256::extract(salt, parent);              // RFC 5869 §2.2
    let mut okm = Zeroizing::new([0u8; 48]);
    // info = a domain tag, then every header field that is not the salt and not the
    // commitment tag, then the AAD extension.
    hkdf_sha256::expand_multi(
        &prk,
        &[b"fathom/v1/rec", &header[0..64], aad_ext],
        &mut okm[..],                                            // RFC 5869 §2.3
    );
    let k_enc: [u8; 32] = okm[0..32].try_into().unwrap();
    let k_cmt: [u8; 16] = okm[32..48].try_into().unwrap();
    (Zeroizing::new(k_enc), k_cmt)
}
```

Seal:

```
salt        = CSPRNG(32)                            # written into header[64..96]
(K,C)       = derive_record_keys(parent, header, aad_ext)
header[96..112] = C
ct          = AEAD-Seal(K, nonce = 0u96, aad = header || aad_ext, plaintext)
envelope    = header || ct                          # ct includes the 16-byte Poly1305 tag
```

Open (corrected per ADR-0014):

```
(K,C')      = derive_record_keys(parent, header, aad_ext)
commit_ok   = constant_time_eq(C', header[96..112])
pt          = AEAD-Open(K, nonce = 0u96, aad = header || aad_ext, ct)   # runs regardless
match (commit_ok, pt) {
    (true,  Ok(pt))  => Ok(pt),
    (true,  Err(_))  => Err(Tampered),            # commitment right, MAC wrong
    (false, Err(_))  => Err(WrongKey),            # both wrong: a wrong passphrase
    (false, Ok(_))   => Err(CommitmentMismatch),  # MAC right, commitment mutated —
                                                  # a distinct, nameable state
}
```

**Why the AEAD runs even on a commitment mismatch (ADR-0014).** `commit_tag` is correctly not in
the HKDF `info`, so flipping one byte of it does not change `K` — under the earlier
return-early ordering that produced `WrongKey` for a hostile sync operator, a hostile git
committer, or one bit of rot, and the user's response to "wrong passphrase" is to try harder
rather than to restore from backup. Running the open anyway and branching on its result
distinguishes tampering from a typo in the one code path where that distinction decides what
the user does next. Constant time is irrelevant here — the attacker already has the
ciphertext — and the cost is one wasted AEAD open on a genuinely wrong passphrase,
microseconds against a one-second KDF. The commitment property itself (§5.6) is unchanged.
Both `Tampered` and `CommitmentMismatch` are negative vectors in §16.2.

### 3.3 Why there is no intermediate per-class key

An obvious-looking layer — `WK → class key → record key` — was considered and dropped. The record
class byte is already in `header[0..64]` and therefore already in the HKDF `info`, so a `captures`
record cannot be opened as a `nodes` record whether or not an intermediate key exists. An
intermediate key would buy exactly one thing: the ability to hand some component a key that reads
one class and not another. Nothing in Fathom needs that — the AI layer has no cryptographic
capability at all (`23-ai-safety-and-injection.md`), and the emitter and rule engine run on an
already-open graph. A key hierarchy level that nothing uses is a level that will rot.

### 3.4 Every key in the system, and its lifetime

| Key | Size | Where it comes from | Persisted? | Zeroised at |
|---|---|---|---|---|
| Passphrase bytes | var | user input | **no** | as soon as `A2id` returns (§14.3) |
| `UK` unlock key | 32 B | `A2id(passphrase, kdf_salt, m, t, 1, 32)` | no | as soon as the keyholder opens |
| `RK_e` root key | 32 B | `CSPRNG(32)` at epoch creation | only wrapped, in keyholders | `lock()` |
| `WK_e` workspace key | 32 B | HKDF from `RK_e` | no, recomputed | `lock()` |
| Record `K_enc` | 32 B | HKDF per seal/open | no | end of the seal/open call |
| Record `K_cmt` | 16 B | same HKDF | yes, in the header | not secret |
| Recovery key | 30 B | `CSPRNG(30)` | **on paper**, and nowhere else | never enters memory except during unwrap |
| Member X25519 secret | 32 B | HKDF from the member seed | wrapped under the member's own root key | `lock()` |
| Member Ed25519 secret | 32 B | HKDF from the member seed, different `info` | same | `lock()` |
| Member seed | 32 B | `CSPRNG(32)` at identity creation | wrapped | `lock()` |
| PRF output | 32 B | the authenticator | no | as soon as the keyholder opens |

**RECOMMENDATION —** all of these live in exactly one Rust struct, `KeyRing`, which is
`ZeroizeOnDrop`, is heap-boxed, and is the only thing `lock()` has to get right. Bounding what must
be zeroised is the actual engineering win; see §14.

---

## 4. The KDF — Argon2id

### 4.1 Why Argon2id, briefly

RFC 9106 §4 recommends Argon2id as the default choice: it is the hybrid variant, data-independent
in the first half of the first pass and data-dependent thereafter, which gives useful resistance to
both side-channel and time-memory-tradeoff attacks. scrypt is memory-hard but has no equivalent of
the `id` split; PBKDF2 has no memory cost at all and is the single best thing you can do for a GPU
attacker. There is no interesting argument here and this document is not going to manufacture one.

The interesting arguments are the parameters and the browser.

### 4.2 The parameters, as a policy rather than three numbers

Three numbers baked into a build are wrong within a year and wrong on half the devices on day one.
The parameters are therefore **per-workspace, stored in the clear in the keyholder descriptor, and
authenticated** (§7.4), and they are chosen by a calibration procedure:

```rust
pub struct Argon2Params {
    pub m_kib: u32,     // memory, KiB
    pub t: u32,         // passes
    pub p: u32,         // lanes — always 1, see §4.3
    pub salt: [u8; 16], // RFC 9106 §4: 128-bit salt
}

pub const FLOOR: Argon2Params  = Argon2Params { m_kib: 65_536,  t: 3, p: 1, salt: [0;16] };
pub const CAP:   Argon2Params  = Argon2Params { m_kib: 262_144, t: 4, p: 1, salt: [0;16] };
pub const TARGET_MS: u32       = 1_000;
pub const TARGET_TOLERANCE: f32 = 0.25;
```

| | |
|---|---|
| **Floor** | `m = 64 MiB, t = 3, p = 1`. This is RFC 9106 §4's second recommended option with `p` reduced to 1 (§4.3). A workspace is never created below this, whatever the device says. |
| **Cap** | `m = 256 MiB, t = 4, p = 1`. Not because 256 MiB is enough — more would be better — but because a workspace created on a workstation gets opened on a phone (§4.4), and a cap is the only thing standing between that user and a workspace they cannot open at all. |
| **Target** | 1.0 s ± 0.25 s on the *creating* device, measured, not assumed. |
| **Procedure** | Fix `t = 3`. Binary-search `m` between floor and cap for the target time. If floor already exceeds the target, keep floor and tell the user their device is slow — do not go below it. If cap is faster than the target, raise `t` to 4, then stop. |
| **Re-calibration** | Offered, never automatic, and it rewrites 200-odd bytes (§9.1). A workspace that opens in 4 s on a new laptop is under-parameterised and the tool should say so once, as a margin tab, not as a nag. |

RFC 9106 §4's *first* recommended option — `t=1, p=4, m=2 GiB` — is not viable in a browser tab and
is not offered. Say that plainly rather than quietly picking the second option and implying it was
the only one.

**DECISION (ADR-0014, adopting `44` §4.8.4) — `DeviceFloor::AnyDevice` is the default.** The
shipping default pins `m` at `FLOOR` (64 MiB, t = 3) for every workspace that does not opt out,
so a workspace created anywhere opens on any device; the calibration procedure above applies
when the user opts into a higher device floor. Stated honestly: a lower KDF floor is genuinely
weaker — a real security reduction chosen for reach and unlock latency — and `44`'s second
argument is why it is right anyway: a four-second unlock is not a neutral security property; it
pushes users toward shorter passphrases, which loses more entropy than the KDF gains. The
generated-passphrase path stays the default per §4.7.

<!-- VERIFY: measure A2id in the release WASM build across m ∈ {64, 128, 192, 256} MiB, t ∈ {3,4},
     p=1, on: a current desktop, a 2019 dual-core ultrabook, a mid-range Android, and an iPhone.
     Record median and p95 wall time and whether memory.grow succeeded. Publish the grid. The
     TARGET_MS and CAP constants above are policy; the grid is the evidence they are achievable,
     and until it exists this section is a plan, not a measurement. -->

### 4.3 DECISION — `p = 1`, and why RFC 9106's `p = 4` is wrong here

Argon2's total work is `m × t` compression-function calls **independent of `p`**. `p` divides the
memory into lanes so that the work *may* be split across threads; it does not change how much work
there is. Three consequences, in order of weight:

1. **A single-threaded defender gains nothing from `p > 1`.** They compute four lanes serially and
   spend the same time they would have spent on one. RFC 9106 §4's procedure explicitly starts by
   figuring out how many threads are available; the answer here is one.
2. **Withdrawn (ADR-0017).** This argument rested on *"a `file://` document has no HTTP headers,
   so the offline single-file build can never be cross-origin isolated"* — which is false for
   the artifact that actually runs Argon2id in a served shape: D2 is served by `fathom serve`
   with `COOP: same-origin` / `COEP: require-corp` (`34` §2.2) and **is** cross-origin
   isolated. The decision stands on arguments 1 and 3 alone; the two shapes must still not
   disagree about a parameter baked into the file format.
3. **`p > 1` is not free for the defender's adversary either way.** An attacker cracking offline
   optimises for throughput, not latency, and will run one guess per core regardless. `p = 4`
   gives them the *option* of intra-guess parallelism and gives us nothing. A shorter dependency
   chain is not a property we want to hand over for free.

**The cost of `p = 1`, stated:** if the served build ever becomes cross-origin isolated and gains
real threads, we cannot use them without a `format_version` bump. That is a real limitation and it
is the right trade, because the alternative is a format that behaves differently depending on how
the same file was delivered.

### 4.4 The WASM reality, which is worse than the parameter table suggests

Four things, all specific to running a memory-hard function in a browser tab, all of which will be
discovered the hard way if they are not written down:

| # | The reality | Consequence |
|---|---|---|
| 1 | **`WebAssembly.Memory` grows and never shrinks.** There is no `memory.shrink`. A 256 MiB Argon2 buffer allocated in linear memory permanently raises the tab's resident footprint for the life of the instance, even after the allocator frees it. | Running the KDF in the main WASM instance means every unlock permanently costs the tab `m` bytes. §4.5 is the fix. |
| 2 | **`memory.grow` can fail, and it fails as a `null`/`-1`, not a crash.** iOS Safari and 32-bit Android are the realistic failure cases. The wasm32 address space is 4 GiB but browser caps are lower and vary. <!-- VERIFY: current per-instance linear-memory caps in Chromium, Firefox and WebKit, desktop and mobile, 2026. --> | The unlock path must handle allocation failure and report it as *"this workspace needs 256 MiB and this device would not give it"* — never as "wrong passphrase" and never as "file corrupt". This is the single most likely cause of a user believing their data is gone. |
| 3 | **No AES, no `mlock`, no `madvise`.** WASM cannot pin pages, cannot mark them undumpable, and cannot ask the OS not to swap them. The Argon2 buffer — which contains passphrase-derived material for its whole lifetime — is pageable. | `31` §5.1 row 14 already owns this. It is restated here because a memory-hard KDF is the largest single block of key-correlated memory the product ever allocates. |
| 4 | **A 1-second synchronous call freezes the tab.** No paint, no input, no `beforeunload`. | The KDF must not run on the main thread. §4.5. |

### 4.5 RECOMMENDATION — the crypto worker owns the keys

Run the KDF, and everything else in §3, in a dedicated Web Worker with its **own** WASM instance.

| Property | Effect |
|---|---|
| Terminate the worker after unlock | The 256 MiB linear memory is genuinely reclaimed, which is the only way to reclaim it (§4.4 #1). In the long-lived variant, terminate and re-spawn on `lock()`. |
| Main thread never receives key material | Keys never enter the main thread's JS heap, so a heap snapshot of the main thread does not contain them. The main thread receives *opened plaintext*, which it needs in order to render, and which is a separate and unavoidable exposure. |
| KDF off the main thread | The tab stays responsive and can show honest progress. |

**This is hygiene, not a boundary.** `31` §4.3 is explicit: the TypeScript ↔ WASM line is not a
security boundary, and neither is the main-thread ↔ worker line. Any JavaScript in the origin can
`postMessage` the worker and ask it to do anything the worker will do. What this buys is that
*after* `lock()`, and in any snapshot of the main thread, the keys are not there. That is worth
having and it is not worth overselling.

**The cost, and a real one:** it is not certain a `file://` document can spawn a Worker at all.
Workers are typically created from a same-origin script URL or a `blob:` URL, and a `file://`
document has an opaque origin. If this does not work, the single-file build runs the KDF inline on
the main thread, freezes for a second, and never reclaims the Argon2 memory — and its `CAP` should
then be lowered to 128 MiB. Two behaviours, one build, decided at runtime by feature detection, and
the UI must state which one it is on.

<!-- VERIFY: whether a document loaded from file:// can construct a Worker from a blob: URL in
     current Chromium, Firefox and WebKit. This determines whether §4.5 applies to the single-file
     build or only to the served builds, and it changes the CAP constant. -->

### 4.6 The offline-guess cost, with the model shown

**These are modelled numbers, not measurements.** The model is stated so it can be attacked.

**Work per guess.** Argon2's block is 1 KiB, so `m` KiB of memory is `m` blocks. A run performs
`m × t` compression-function calls, each reading two blocks and writing one — about 3 KiB of memory
traffic per call. Argon2id's access pattern is data-dependent after the first half-pass, so the
attacker's cache hit rate is poor and bandwidth, not arithmetic, is the binding constraint.

| Config | blocks | calls (`m×t`) | traffic/guess |
|---|---|---|---|
| Floor: 64 MiB, t=3 | 65 536 | 196 608 | ≈ 0.56 GiB |
| Cap: 256 MiB, t=4 | 262 144 | 1 048 576 | ≈ 3.0 GiB |

**Guess rate.** A current high-end GPU with ~1 TB/s of achievable bandwidth would do the cap config
at ~310 guesses/s at 100 % bandwidth efficiency. Argon2's random access defeats coalescing; assume
20–35 % efficiency, giving **order 10² guesses/s per GPU** at the cap and about 5× that at the
floor. VRAM is not the constraint: 24 GiB ÷ 256 MiB is 96 concurrent instances.

<!-- VERIFY: run hashcat or an equivalent Argon2id kernel at m=256 MiB, t=4, p=1 on a current GPU
     and replace the modelled 10²/s with a measured figure. Until then every number below is an
     order-of-magnitude argument, and the document says so. -->

**Time to exhaust half the keyspace — floor first, because the floor is the shipping default
(ADR-0014):**

At `FLOOR` (64 MiB, t=3), the default every workspace ships with unless the user opts out:

| Passphrase | Entropy | 1 GPU (5×10²/s) | 100 GPUs (5×10⁴/s) | 10 000 GPUs (5×10⁶/s) |
|---|---|---|---|---|
| A memorable sentence with substitutions | ~30 bits | ≈12 days | **≈2.9 hours** | **≈1.7 minutes** |
| A strong human-chosen passphrase | ~40 bits | ≈33 years | ≈4 months | **≈27 hours** |
| A very strong human-chosen passphrase | ~50 bits | 3.4 × 10⁴ yr | ≈330 yr | ≈3.3 yr |
| 5 EFF-wordlist words | 64.6 bits | — | — | 7.4 × 10⁴ yr |
| 6 EFF-wordlist words | 77.5 bits | — | — | 6.3 × 10⁸ yr |

At `CAP` (256 MiB, t=4), the opt-in configuration:

| Passphrase | Entropy | 1 GPU (10²/s) | 100 GPUs (10⁴/s) | 10 000 GPUs (10⁶/s) |
|---|---|---|---|---|
| A memorable sentence with substitutions | ~30 bits | 61 days | 15 hours | **9 minutes** |
| A strong human-chosen passphrase | ~40 bits | 172 years | 1.7 years | **6 days** |
| A very strong human-chosen passphrase | ~50 bits | 1.8 × 10⁵ yr | 1 760 yr | 17.6 yr |
| 5 EFF-wordlist words | 64.6 bits | — | — | 3.9 × 10⁵ yr |
| 6 EFF-wordlist words | 77.5 bits | — | — | 3.3 × 10⁹ yr |

The number a reviewer quotes back must match the product they will run, which is the floor
table.

**In money, with the assumption labelled.** At an assumed $0.50 per GPU-hour — re-derive this at
current spot prices, it is not a constant — a guess costs about $1.4 × 10⁻⁶. So 2³⁰ guesses is on
the order of $10³, 2⁴⁰ is on the order of $10⁶, and 2⁵⁰ is on the order of $10⁹.

### 4.7 What the KDF does not do, and the only thing that actually helps

Read the table again. The gap between "9 minutes" and "3.3 × 10⁹ years" is entirely the user's
passphrase. Moving `m` from 64 MiB to 256 MiB moved every row by a factor of five. Moving the user
from a memorable sentence to six generated words moved them by a factor of 10¹⁴.

`31` §2.4 states this and it is worth restating in the document that specifies the KDF, because
this is the document where it is most tempting to imply otherwise:

> **Argon2id multiplies the attacker's per-guess cost by a constant. It does not add bits.**

Three product consequences, none of them cryptographic:

1. **The generated passphrase is the default path, not the alternative.** Six EFF-wordlist words,
   generated in the client, shown once, with a copy affordance. Typing your own is the second
   option on the screen, not the first.
2. **The entropy estimate shown at entry is a floor, not a score out of five.** Estimating the
   entropy of a human-chosen passphrase is guesswork biased optimistic; the only honest display for
   a user-chosen passphrase is a stated lower bound and the sentence *"we cannot measure how
   guessable this is."*
3. **Every historical copy is separately attackable.** `31` §8.1 A1.1.4: a workspace committed to
   git has every past version sealed under whatever key was current then. Rotating the passphrase
   does not protect the old commits. §9.2.

---

## 5. The AEAD

### 5.1 The candidates

| | AES-256-GCM via WebCrypto | AES-256-GCM in WASM | ChaCha20-Poly1305 in WASM | XChaCha20-Poly1305 in WASM |
|---|---|---|---|---|
| Specification | NIST SP 800-38D | same | **RFC 8439 §2.8** | CFRG draft, not an RFC |
| Hardware acceleration | yes, AES-NI/ARMv8-CE via the browser | **no — WASM has no AES instructions** | n/a; ChaCha is a software-first design and vectorises on WASM SIMD `v128` | same |
| Nonce | 96 bit | 96 bit | 96 bit | **192 bit** |
| Random-nonce safety | birthday at 2⁴⁸; NIST caps random 96-bit nonces at 2³² messages per key | same | same | comfortable — collision probability ≈ q²/2¹⁹³ |
| Plaintext crosses into the JS heap | **yes** | no | no | no |
| API | async, `ArrayBuffer` in and out | sync, in linear memory | sync | sync |
| Added WASM size | ~0 | constant-time AES is the larger of the two software implementations | smaller | smaller |
| Key-committing | no | no | no | no |

### 5.2 DECISION — ChaCha20-Poly1305, RFC 8439, in WASM

The cipher family choice is settled by three facts and one of them is not about cryptography:

1. **WASM has no AES instructions.** The "AES is hardware-accelerated" argument is true of the CPU
   and false of the sandbox. A constant-time software AES in WASM is the slow option; ChaCha20 was
   designed to be fast in software without table lookups and is the fast option. The only way to
   reach the CPU's AES units from a browser is WebCrypto.
2. **WebCrypto means the plaintext lives in the JS heap.** `crypto.subtle.encrypt` takes and returns
   `ArrayBuffer`s. Every record's plaintext would have to be copied out of WASM linear memory into
   a JS-visible buffer and back. `31` §5.1 row 14 and §5.2 already say we cannot erase JS heap
   objects; this would multiply the number of them that contain workspace plaintext by the number
   of records. That is a regression we would be choosing on purpose in exchange for throughput on
   a workload that is a few megabytes.
3. **WebCrypto is async, and the core is not.** The seal/open path is called from the middle of
   synchronous Rust. Making it `async` all the way up so that a cipher can be borrowed from JS
   inverts the architecture for a performance gain we have not measured and do not need.

**The cost, stated:** on a machine with AES-NI we are leaving hardware acceleration on the table.
For a workspace measured in megabytes this is milliseconds. If a workspace ever reaches a size
where symmetric throughput is the bottleneck, the answer is suite `0x02`, not a redesign.

<!-- VERIFY: measure ChaCha20-Poly1305 throughput in the release WASM build with and without SIMD,
     on desktop and mobile, before quoting any figure. This document quotes none. -->

### 5.3 DECISION — no extended nonce; a derived subkey and a zero nonce

Having chosen the ChaCha family, the remaining question is how to get a safe nonce for every record
in a container that is written concurrently on several devices.

| Option | Construction | Verdict |
|---|---|---|
| **A** | XChaCha20-Poly1305, 192-bit random nonce per record | Rejected |
| **B** | RFC 8439 ChaCha20-Poly1305; per-record 256-bit random salt in the header; HKDF that salt into a fresh subkey; **nonce is 12 zero bytes** | **Chosen** |
| C | RFC 8439 with a counter nonce: `device_id(4) || counter(8)` | Rejected — §5.5 |

A is a perfectly good construction and it is the obvious one. It lost on three counts:

1. **B needed the HKDF anyway.** The key-commitment tag (§5.6) is derived from the record key. Once
   there is an HKDF-Expand in the seal path, deriving 32 bytes of key alongside the 16 bytes of
   commitment costs nothing. A would have both an HChaCha20 subkey derivation *and* an HKDF.
2. **Every primitive in B has an RFC.** RFC 8439, RFC 5869, RFC 9106, RFC 9180. XChaCha20 is a CFRG
   Internet-Draft and the de-facto libsodium construction; it is well analysed and widely deployed,
   and it is still a thing a reviewer cannot look up by RFC number. In a document whose entire
   purpose is to be checkable by someone who does not trust us, that matters more than it usually
   does.
3. **B's random field is 256 bits, not 192.** Strictly better collision behaviour for free.

**The cost of B, stated, and it is a real one:** the header contains a nonce field that is twelve
zero bytes, and *"nonce = 0"* is a red flag to every reviewer who skims a format. It will be
raised in every review this design ever gets. The format therefore carries a fixed comment at that
offset in the spec, in the test vectors, and in the code, and §5.4 exists to answer it once and
properly. A construction that requires a paragraph of explanation is a worse construction than one
that does not, all else equal — and here all else is not equal.

### 5.4 The nonce-uniqueness argument, in full

The requirement for ChaCha20-Poly1305 is that **`(key, nonce)` is never reused across two distinct
plaintexts.** With the nonce fixed at zero, this reduces to: *the record key `K_enc` is never reused
across two distinct plaintexts.*

`K_enc = HKDF-Expand(HKDF-Extract(salt, WK_e), "fathom/v1/rec" || header[0..64] || aad_ext, 32)`.

Two seals produce the same `K_enc` only if they agree on all of: `WK_e`, `salt`, and the 64
fixed header bytes (which include the record class, the record ID, the key epoch, the key ID, both
version numbers, the envelope version and the suite ID). So a key repeat requires a **32-byte salt
collision within one epoch of one workspace.**

**Case 1 — birthday.** Salts are 256 bits from the platform CSPRNG. After `q` seals the collision
probability is at most `q² / 2²⁵⁷`. At `q = 2⁴⁸` seals — 280 trillion writes, which is more writes
than a workspace will ever see by many orders of magnitude — that is about `2⁻¹⁶¹`. This case is
not the risk and treating it as the risk is how the real one gets missed.

**Case 2 — concurrent edits, two devices, same record.** Alice and Bob both edit a device in node
shard `2a`. Both seal shard `2a` under the same `WK_e`, with the same `record_id`, with the same
header fields. Their salts differ because they are independently random. Two different keys, two
different ciphertexts, no reuse. The *merge* is then a plaintext problem, handled by
`11-ir-schema.md` §8.6, and it happens after both envelopes are opened.

> **INVARIANT — ciphertext is never merged.** The sync layer transports whole records. It never
> combines two envelopes, never patches a ciphertext, never re-uses a header from one write with a
> ciphertext from another. Merging happens on opened plaintext, in the core, or it does not happen.

**Case 3 — the same device sealing the same record twice.** Two salts, two keys. Fine.

**Case 4 — the counter design we did not choose, and why.** Option C above assigns each device a
nonce prefix and increments a counter. It is smaller and it looks tidier. It breaks in exactly one
place, and that place is guaranteed to occur: **a counter that can be rolled back is worse than no
counter.** Restore a workspace from a backup, clone a VM, copy a browser profile, or lose the tab
before the counter is persisted, and the device replays counters it has already used, under the
same key, on different plaintexts. That is a full loss of confidentiality for the affected records
and a forgery capability, from an operation — restoring a backup — that every user believes is safe.
There is no way to make the counter survive that reliably in a browser, and a durability mechanism
that is only *usually* durable produces false confidence, which is worse than the plain design.

**Case 5 — the one that actually kills it: a broken or replayed CSPRNG.** Both A and B rest entirely
on the platform CSPRNG. If `crypto.getRandomValues` returns repeated output — a restored VM
snapshot, a cloned container image, a fresh-boot entropy failure on an embedded browser — then two
seals of the same record under the same epoch can collide, and the scheme fails completely. Rules:

| Rule | Reason |
|---|---|
| **Every salt comes directly from the platform CSPRNG, per seal. No userspace PRNG, ever.** In Rust: `getrandom` with the `wasm_js` backend, which is `crypto.getRandomValues`. Never `rand::thread_rng`, never a seeded `ChaCha20Rng`, never an OS RNG cached at instantiation. | A userspace PRNG seeded once at WASM instantiation is precisely what a page restored from bfcache or a snapshotted VM will replay. The platform RNG is the only thing that gets reseeded by events we cannot see. |
| A startup sanity check: draw 64 bytes, reject all-zero, reject a repeat of the previous draw, reject a draw equal to a value persisted from the previous session. | Catches gross failure — a stubbed RNG, a `Math.random` polyfill someone added. **Does not catch subtle failure**, and no in-application check can. |
| CI: seal 10⁶ records and assert 10⁶ distinct salts. | Catches a code path that forgot to re-randomise. It is the cheapest test in this document and it catches the highest-severity bug. |

**Residual: `material`.** If the platform CSPRNG is compromised or replayed, this scheme provides
no confidentiality for the affected records and there is no in-application detection. This is true
of essentially every randomised encryption scheme and it is stated here rather than assumed.

### 5.5 Random-nonce budget, for the record

Had we used AES-256-GCM or plain RFC 8439 with a random 96-bit nonce and a long-lived key, the
budget would be roughly 2³² messages per key before the birthday bound becomes uncomfortable. A
workspace with 90 records saved every minute for ten years is about 4.7 × 10⁸ seals — within 2³²,
but not by a margin worth relying on, and the number of *keys* is one per epoch, not one per
record. B's derivation removes the budget entirely: there is no per-key message count because there
is no per-key message reuse.

### 5.6 Key commitment, and why a container like this needs it

ChaCha20-Poly1305 and AES-GCM are not **key-committing**: given a ciphertext, an adversary can
construct a *second* key that also decrypts it successfully, to different plaintext. Len, Grubbs and
Ristenpart ("Partitioning Oracle Attacks", USENIX Security 2021) showed how to build key
multi-collisions for AES-GCM, ChaCha20-Poly1305 and XSalsa20-Poly1305, and how to turn a system
that reveals *whether* a decryption succeeded into a password-recovery oracle that eliminates many
candidate passwords per query rather than one.

Fathom's shape is close to the shape that attack likes: a password-derived key, a container with
several keyholder entries, and — in the sync deployment — an untrusted server that could feed a
client chosen ciphertexts and observe from timing or behaviour whether the client accepted them.

The fix is small:

```
K_enc || K_cmt = HKDF-Expand(prk, info, 48)     # 32 + 16
```

`K_cmt` is published in the header. Because HKDF-Expand is a PRF and its output is collision-
resistant, finding a second `(parent, salt, header)` that produces the same `K_cmt` is a
second-preimage problem at the width of the tag. The client checks `K_cmt` in constant time and —
per ADR-0014 — runs the AEAD open regardless, branching on the pair of results (§3.2), so
"wrong key", "tampered ciphertext" and "mutated commitment tag" are all distinguishable and
none is a partitioning oracle: a candidate key either produces the published `K_cmt` or it does
not, and each query rules out exactly one candidate.

| | |
|---|---|
| Tag width | 128 bits. Commitment security ≈ 2¹²⁸ for second preimage; ≈ 2⁶⁴ for a collision an adversary generates both sides of, which is not a relevant attack here because the header binds a `record_id` the adversary does not choose |
| Cost | 16 bytes per record, and 16 extra bytes of HKDF output. At 90 records, 1.4 KiB per workspace |
| What it does not do | It does not make the AEAD committing to the *associated data* (CMT-3/CMT-4). Binding the header into the HKDF `info` gets most of the way there, since a changed header changes the key and therefore the tag. Full CMT-4 was not pursued and this is the honest boundary of the claim |

---

## 6. The record model — owned by `17` (ADR-0012)

### 6.1–6.3 Deferral

> **Superseded by ADR-0012:** the on-disk record model — the granularity trade, the shard
> scheme and the record taxonomy — is owned by `17-workspace-format.md` §4 and is no longer
> specified here. ADR-0013 decided the substance in favour of the fixed-shard model this
> section originally argued: `S_nodes`/`S_edges` fixed at workspace creation (64/16 by
> default; 8 small, 256 large), whole-record rewrite, `Suppressions` deliberately one record,
> and a committed sealed manifest (§8). The class byte in the envelope header (§7.1) is
> assigned by `17` §4.2's taxonomy.

One rule from the deleted text is cryptographic and stays here:

> **RULE — one compression context per record, and never a record that mixes attacker-supplied
> text with anything else.** Compression is applied per record, before sealing, or not at all.
> Captures are one blob each, isolated from workspace data, because compressing
> attacker-supplied text in the same context as a secret is a length side channel of the
> CRIME/BREACH family.

### 6.4 Padding

Padmé, per the decision already taken in `31` §7.6, applied so that the **total envelope length** is
a Padmé bucket — which makes the CI check in `31` §12 literally true of every record and not just of
uploaded blobs.

```rust
/// Nikitin et al., PoPETs 2019(4). Leakage bounded to O(log log M) bits of the length;
/// at most 12 % overhead, ≈6 % at 1 MB, ≈3 % at 1 GB.
fn padme(l: u64) -> u64 {
    if l < 2 { return l; }
    let e = 63 - l.leading_zeros() as u64;          // floor(log2 l)
    let s = 64 - e.leading_zeros() as u64;          // floor(log2 e) + 1
    let z = e - s;
    let mask = (1u64 << z) - 1;
    (l + mask) & !mask
}

/// Plaintext framing. HEADER_LEN = 112, TAG_LEN = 16, LEN_PREFIX = 4.
/// Corrected per ADR-0014: the envelope is header ‖ aad_ext ‖ ciphertext (§7.1), and every
/// keyholder envelope has aad_ext_len > 0, so aad_ext_len is part of the padded total.
/// Without it, no keyholder envelope's total length is a Padmé bucket and §18's CI check
/// fails on day one.
fn pad_plaintext(body: &[u8], aad_ext_len: usize) -> Vec<u8> {
    let target = padme((112 + aad_ext_len + 4 + body.len() + 16) as u64) as usize;
    let pad = target - 112 - aad_ext_len - 4 - body.len() - 16;
    let mut out = Vec::with_capacity(4 + body.len() + pad);
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend_from_slice(body);
    out.resize(4 + body.len() + pad, 0u8);
    out
}
```

The length prefix, rather than a padding marker, because stripping it is constant-time and
unambiguous. `padme` is monotone and idempotent, so the target is always ≥ the input and the
computation terminates without a loop.

Two additions per ADR-0014 and ADR-0012:

- **The CBOR keyholder descriptor is padded to a fixed width per `KeyholderKind`** before it
  becomes `aad_ext`, so the envelope length does not leak the descriptor's content length.
- **Plaintexts below 512 bytes are padded to 512 flat** (moved here from `17` §5.7 per
  ADR-0012): small values sit in the regime where Padmé's overhead bound is loosest, and the
  flat floor removes the "this record was nearly empty" signal entirely. Above 512 bytes,
  Padmé.

### 6.5 What still leaks, after all of that

Honest accounting. `Mn` references are the channels in `31` §7.2.

| Leak | Who sees it | Notes |
|---|---|---|
| **Total ciphertext size**, to a Padmé bucket | M2. Anyone with the file or the blob | Estate scale, coarsely. Unchanged by sharding |
| **Which shard changed**, in the exploded/git shape | Anyone with repository read access, **with full history** | This is M8 at 1/64 granularity, permanently, to a potentially wider audience than the sync server. It is the direct cost of D8, and it is the reason D7 keeps whole-container sync as the default |
| **Which shard changed**, in the sync shape | Nobody, by default | Whole-container upload. Per-record sync is opt-in and the setting states this cost |
| **The number of `Capture` records, and each one's padded size** | Anyone with the file | Roughly: how many configs have been pasted, and how big each was. Mitigation is Padmé and nothing else. A user who considers this sensitive should not paste captures they do not need |
| **The number of `Provenance` segments** | Same | Roughly: how much history exists. Grows monotonically |
| **The keyholder count** | Same | How many people, plus whether a recovery code and a passkey exist. §10.4 argues this is not worth hiding, because the member log has to be verifiable anyway |
| **Every header field** | Same | By design — they are the AAD. `format_version`, `schema_version`, `key_epoch`, `key_id`, the record class and the record ID. `11-ir-schema.md` §11.2 already accepted this trade: the alternative is running a deliberately expensive KDF before you can discover you cannot read the file |
| **Key epoch** | Same | Reveals how many times the workspace has been re-keyed, which correlates with membership churn |

The record ID being in the clear deserves a sentence. It is a shard index (`0x00`–`0x3f`) or a
capture ULID. It is not a node ID, it is not derived from any node ID in a way that can be reversed
(`blake3` of the node ID, truncated to a shard index, is one of 64 values), and it names a bucket,
not a thing.

---

## 7. The envelope, byte by byte

### 7.1 Header layout — 112 bytes, fixed

All integers little-endian. Offsets are from the start of the envelope.

```
off  len  field             value / notes                                    KDF info?  AAD?
───  ───  ───────────────   ────────────────────────────────────────────────  ─────────  ────
  0    8  magic             46 54 48 4D 1F 52 45 43   "FTHM\x1fREC"              yes      yes
  8    1  envelope_version  0x01                                                 yes      yes
  9    1  suite_id          0x01 = ChaCha20-Poly1305 / HKDF-SHA-256 / Argon2id   yes      yes
 10    1  record_class      `17` §4.2's taxonomy (ADR-0012)                      yes      yes
 11    1  flags             bit0 zstd, bit1 padded, bit2 written_at present,     yes      yes
                            bits3-7 reserved, MUST be 0
 12    2  header_len        u16 = 112. Present so a future suite may extend      yes      yes
                            the header without breaking the length arithmetic
 14    2  aad_ext_len       u16. 0 for ordinary records; the keyholder           yes      yes
                            descriptor length for keyholder envelopes
 16    4  format_version    u32 — 11-ir-schema §11.2                             yes      yes
 20    2  schema_major      u16                                                  yes      yes
 22    2  schema_minor      u16                                                  yes      yes
 24   16  record_id         shard index (zero-padded) or a ULID                  yes      yes
 40    8  key_epoch         u64                                                  yes      yes
 48   16  key_id            H("fathom/v1/keyid" || WK_e)[0..16]                  yes      yes
 64   32  salt              CSPRNG(32). This is the HKDF-Extract salt          (is the    yes
                                                                                salt)
 96   16  commit_tag        K_cmt, §5.6. An output; cannot be an input          **no**    yes
───  ───
112       ciphertext        AEAD-Seal output: padded plaintext + 16-byte tag
```

Then, immediately following the header and before the ciphertext, `aad_ext_len` bytes of AAD
extension, if any. The full envelope is therefore:

```
header(112) || aad_ext(aad_ext_len) || ciphertext(padded_len + 16)
```

The nonce is **not a field**. It is the constant `00 00 00 00 00 00 00 00 00 00 00 00`. See §5.3 and
§5.4, and expect to explain it in every review.

### 7.2 The AAD, field by field, and the attack each field stops

`AAD = header[0..112] || aad_ext`. Everything in the header is authenticated. The interesting
question is not "what is in the AAD" but "what would happen if each field were not".

| Field | Attack it prevents | Concretely, in Fathom |
|---|---|---|
| **`record_id`** | **Record substitution.** Without it, every record in a class shares a derivation domain, and a hostile server or a repository committer could move shard 7's ciphertext into shard 12's slot. Both would open. The graph would silently contain shard 7's nodes twice and shard 12's nodes not at all | The `IkeGateway GW-B` with `address 203.0.113.10` disappears and a duplicate of something else takes its place, with no error. The user sees a graph that does not match their network and no indication why |
| **`key_id`** | **Key confusion across epochs.** An attacker cannot relabel a record as belonging to a different key, and a client cannot be tricked into trying the wrong key and treating the failure as corruption | After a member is removed (§9.3), a record still sealed under the old epoch cannot be passed off as a current one |
| **`key_epoch`** | Same class, at the semantic level. It is redundant with `key_id` cryptographically and it is not redundant operationally — it is what the manifest checks against | A stale client that kept syncing at epoch 4 after a revocation to epoch 5 is detectable |
| **`schema_major` / `schema_minor`** | **Interpretation downgrade.** A record written under schema 4.0 cannot be replayed to a client that would parse it as 3.2 and reach different conclusions about the same bytes | `11-ir-schema.md` §11.4 puts a client into preserve mode based on this number. If it were unauthenticated, an attacker could force a client into full-edit mode on a graph it does not fully understand, and suppressions written in that state would be waivers of things the build never read |
| **`format_version`** | Container downgrade. Prevents rolling a client back to an earlier envelope layout with weaker properties | The migration path in §7.5 depends on this being authenticated |
| **`suite_id`** | **Cross-suite confusion.** When suite `0x02` exists, a `0x02` record cannot be re-labelled `0x01` | Prevents the classic algorithm-substitution attack before there is a second algorithm to substitute |
| **`envelope_version`** | Same, at the framing level | |
| **`record_class`** | Class confusion. A `Capture` record cannot be presented as a `Suppressions` record | A capture full of attacker-controlled text cannot be parsed as the suppression list |
| **`flags`** | Compression and padding confusion; forces `flags` to be exactly what the writer intended | Clearing the `zstd` bit would make a decompressor read compressed bytes as plaintext |
| **`header_len` / `aad_ext_len`** | Framing confusion, and it is the one that produces memory-safety bugs in a less careful implementation | Safe Rust does not have buffer overflows; a length that lies still produces a wrong parse, and a wrong parse of a keyholder descriptor is a downgrade |
| **`salt`** | It *is* the HKDF salt, so changing it changes the key. Authenticated anyway so that a modification produces "tampered", not "wrong key" | |
| **`commit_tag`** | An output, not an input, but authenticated so that stripping or altering it fails at the MAC. Per ADR-0014's ordering (§3.2) the AEAD runs even when the compare fails, so a mutated `commit_tag` surfaces as `CommitmentMismatch`, never as "wrong passphrase" | |
| **`aad_ext`** (keyholder descriptor) | **KDF parameter tampering.** Without it, an attacker could rewrite `m` from 262 144 KiB to 8 KiB. That does not recover the key — the derived `UK` changes, so decryption fails — but it does turn unlock into a denial of service, or into a several-hour hang if they raise it instead | The user reads a hang as "the file is broken" |

**What the AAD does not prevent, and this is the important sentence:** it does not prevent **replay
of an older version of the same record**. Shard 7 at epoch 5 from last Tuesday is a valid,
correctly-authenticated shard 7 at epoch 5. Nothing inside the envelope can distinguish it. That is
the manifest's job, §8.

### 7.3 The versioning bytes, and the migration path

Two bytes carry the scheme's future: `envelope_version` at offset 8 and `suite_id` at offset 9.
They are separate on purpose.

| | `envelope_version` | `suite_id` |
|---|---|---|
| Governs | Header layout and framing | Which primitives, and how keys are derived |
| Bumped when | A field moves, is added, or changes width | A primitive changes |
| Old client reading it | **Refuse, cleanly**, naming the version — the layout is unknown, so nothing can be parsed safely | **Refuse, cleanly** — the layout is known, so the client can read `record_class`, `record_id` and both version numbers and say something useful |
| Reserved values | `0x01` in use | `0x01` in use; `0x02` reserved for a post-quantum-wrapped variant (§10.7); `0x03` reserved for an AES-256-GCM variant if a customer's compliance regime ever requires it — see the note below |

A client encountering an unknown `envelope_version` must not guess. It must read the first ten bytes
— magic, envelope version, suite — and stop. The magic exists so that "this is not a Fathom
envelope" and "this is a Fathom envelope from the future" are different messages.

**On a hypothetical AES suite:** it is reserved and it is not planned. `31` §10.1 is explicit that
Fathom claims no FIPS 140, no Common Criteria, no certification of any kind. Adding an AES suite in
order to imply one would be a marketing change dressed as a cryptographic one.

**Migration.** Records carry their own suite, so a workspace may contain records at mixed suites
during a migration. The manifest records the minimum suite present. A client re-seals records at the
old suite opportunistically on write — never in a background sweep, because a background sweep
rewrites every record and produces exactly the git churn §17.1 warns about. When every record has
been re-sealed, the manifest's minimum rises and the old suite's code becomes eligible for removal
one major later.

### 7.4 The keyholder table — the one record with a cleartext prologue

The keyholder record is different from every other record because its parent key cannot be derived
until the reader knows *how* to derive it, and that requires reading parameters that are not yet
decryptable. So it is a table of `(descriptor, envelope)` pairs, where the descriptor is cleartext
and is bound into the envelope's AAD extension.

```rust
#[repr(u8)]
pub enum KeyholderKind {
    Passphrase   = 0x01,   // descriptor: Argon2Params
    Recovery     = 0x02,   // descriptor: nothing beyond the id
    WebAuthnPrf  = 0x03,   // descriptor: credential_id, prf_salt, rp_id_hash
    Member       = 0x04,   // NOT a Fathom envelope — an HPKE ciphertext, §10.2
    PassAndPrf   = 0x05,   // descriptor: Argon2Params + credential_id + prf_salt
}

/// Canonical CBOR (RFC 8949 §4.2.1, deterministic encoding), padded to a fixed width
/// per KeyholderKind (ADR-0014) so the envelope length leaks nothing. This is the
/// `aad_ext` for the corresponding envelope, byte for byte, and the envelope will not
/// open if a single byte of it has changed.
pub struct KeyholderDescriptor {
    pub kind: KeyholderKind,
    pub id: [u8; 16],                     // stable, opaque — rendered in the UI before unlock
    // `label` is NOT here (ADR-0014). "Kate's laptop" is personal data; cleartext, it
    // sat in every copy of the workspace, at the sync server, in every git commit and
    // every backup. It moved inside the sealed KeyholderSecret.
    pub created_at: u64,                  // ms since epoch
    pub params: KeyholderParams,          // kind-specific
}

/// The sealed side, padded and sealed like any record.
pub struct KeyholderSecret {
    pub root_key: [u8; 32],               // RK_e
    pub key_epoch: u64,
    pub memberlog_head: [u8; 32],         // §10.5 — binds this root key to a member-list state
    pub label: String,                    // "Kate's laptop" — sealed per ADR-0014. The UI
                                          // renders labels after the first successful unlock
                                          // and renders `id` before it
    pub reserved: [u8; 8],                // zero
}
```

**The cost of sealing `label` (ADR-0014, stated):** before unlock the keyholder list reads as
opaque IDs, so a user staring at a recovery screen cannot tell which entry is their laptop and
which is the paper in the safe. Recovery UX is already the hardest surface in the product and
this makes it harder. It is paid because the alternative is cleartext personal data at the
processor, which `37` cannot defend to a DPO.

**Why `memberlog_head` is in the keyholder plaintext.** It binds *this root key at this epoch* to
*the member list the writer believed was current*. A member who unwraps `RK_5` and then finds the
member log at a state whose head does not match has been served an inconsistent view and must
refuse. §10.5.

**Trial decryption.** With `n` keyholders, unlocking with a passphrase means trying each
`Passphrase` and `PassAndPrf` descriptor in order. Each trial costs a full Argon2 run, so a
workspace with three passphrase keyholders costs three seconds to reject a wrong passphrase. Fix:
the descriptor carries the `id`, the UI names the keyholders, and the user picks. Do not iterate
silently. The `id` is not secret and pretending otherwise costs seconds per unlock.

### 7.5 Plaintext canonicalisation

The bytes inside an envelope are **canonical CBOR**, RFC 8949 §4.2.1 deterministic encoding:
definite-length everything, shortest-form integers, map keys sorted by their encoded bytes.

This is not aesthetics. It is what makes §16's cross-implementation claim testable: two
implementations that agree on the schema must produce the same plaintext bytes for the same graph,
or the conformance vectors cannot exist. It is also what makes §17.1's "do not re-seal an unchanged
record" rule implementable — the comparison is `H(canonical_plaintext)`, and a non-canonical encoder
would produce a different digest for an unchanged graph on every save.

### 7.6 A worked header

Illustrative. The authoritative bytes are in `vectors/envelope/`; the random fields below are
placeholders and are marked as such.

```
node shard 0x2a of a workspace at format 3, schema 3.2, key epoch 5

0000  46 54 48 4D 1F 52 45 43   "FTHM\x1fREC"
0008  01                        envelope_version = 1
0009  01                        suite_id = 1
000a  10                        record_class = Nodes
000b  03                        flags = zstd | padded
000c  70 00                     header_len = 112
000e  00 00                     aad_ext_len = 0
0010  03 00 00 00               format_version = 3
0014  03 00                     schema_major = 3
0016  02 00                     schema_minor = 2
0018  2a 00 00 00 00 00 00 00   record_id = shard 0x2a, zero-padded to 16 bytes
      00 00 00 00 00 00 00 00
0028  05 00 00 00 00 00 00 00   key_epoch = 5
0030  <16 bytes>                key_id  = H("fathom/v1/keyid" || WK_5)[0..16]
0040  <32 random bytes>         salt    = CSPRNG(32)              ← different on every save
0060  <16 bytes>                commit_tag = K_cmt
0070  <ciphertext + 16>         zstd(canonical CBOR of the shard), padded, sealed
```

The plaintext of that record, at the level a reviewer would want to see, is the shard's nodes —
which for a workspace built from the SRX field card includes the `IkeGateway` carrying
`address 203.0.113.10`, `external-interface reth0.0`, `version v2-only` and
`dead-peer-detection always-send interval 10 threshold 3`, and the `IpsecPolicy` carrying
`perfect_forward_secrecy: Absent`. `31` §2.1 ranks that last field V6: knowing which tunnels lack
PFS tells a collector which captures are worth archiving. It is one boolean and it is one of the
most valuable things in the file.

---

## 8. The manifest, replay and rollback

### 8.1 What the manifest is for

The AAD stops substitution. It does not stop replay (§7.2). The manifest is the record that makes a
set of envelopes into a *version* of a workspace, so that serving an old version is detectable.

```rust
/// Canonical CBOR, sealed as record class 0x00, record_id = 16 zero bytes.
pub struct Manifest {
    pub v: u8,                                // 1
    pub ws_id: [u8; 16],                      // opaque, high-entropy — 31 §5.1 row 17
    pub key_epoch: u64,
    pub format_version: u32,
    pub schema: (u16, u16),
    pub corpus_version: String,               // semver + content hash, 11-ir-schema §11.2
    pub memberlog_head: [u8; 32],
    pub version_vector: BTreeMap<DeviceId, u64>,
    pub shards: Shards,                       // S_nodes, S_edges — fixed for life
    pub min_suite: u8,                        // §7.3
    pub padding: PaddingScheme,               // Padme | None
    pub records: Vec<RecordEntry>,
    pub written_by: DeviceId,
    pub written_at: Option<u64>,              // §8.4
}

pub struct RecordEntry {
    pub class: u8,
    pub id: [u8; 16],
    pub len: u32,                             // full envelope length, a Padmé bucket
    pub digest: [u8; 32],                     // BLAKE3-256 over the whole envelope, header included
}
```

On open, after the manifest itself opens:

1. Every record named in `records` must be present, and its bytes must digest to `digest`. A missing
   record is an error, not a warning — a hostile store that drops the `Suppressions` record makes
   the workspace look clean.
2. No record may be present that the manifest does not name. An extra record is an error. This is
   what stops a store from injecting a record that some future code path might pick up.
3. Every record's `key_epoch` must equal the manifest's.

### 8.2 Rollback detection under multiple writers

There is no single monotonic version, because there is no coordinator. The `version_vector` maps
each device that has ever written to its own counter.

```
Let V be the incoming manifest's version vector.
Let S be the join (componentwise max) of every version vector this client has
    previously accepted for this ws_id, stored locally.

if V ≥ S componentwise           → accept. Normal forward progress.
if V and S are incomparable      → accept, and merge. This is concurrent editing.
if V < S componentwise, strictly → REFUSE. This is a rollback.
```

The refusal is `31` §5.2 row 5's control, and it comes with that section's honest cost: **a user
restoring their own older backup trips exactly the same check.** The override is therefore a typed
confirmation naming both version vectors and both dates, not a button — because the flow to override
it is the flow an attacker wants the user to become comfortable with.

**Cost of the version vector, stated:** it names every device that has ever written, so it leaks the
device count and its growth over time. That is `31` §7.2's M6, which is already leaked to the sync
server by connection identity. In the *git* shape it is leaked to everyone with repository access,
which is a wider audience than M6 assumed. Named here rather than discovered later.

### 8.3 What rollback protection cannot do

It is client-side state. A client that has never seen this workspace before has no `S` and cannot
detect anything — a fresh install, a new laptop, a colleague opening it for the first time all
accept whatever they are given. The protection is against *serving you an old version of something
you already have*, and nothing else. Residual: `bounded`.

### 8.4 `written_at`, and why it is optional

A timestamp on every save is useful and it is an edit-time log. The sync server already has upload
times (`31` §7.2 M4), so in the sync shape `written_at` costs nothing new. A **git repository is a
different audience**: it may be more widely readable, its history is permanent, and its commit
metadata is not necessarily under the workspace owner's control.

**DECISION —** `written_at` is present in the single-file and sync shapes and **omitted in the
exploded/git shape by default**, with `flags` bit 2 recording which. The git commit already carries
an author timestamp; adding a second one inside the ciphertext is redundant exposure. A user who
wants it can turn it on.

---

## 9. Key rotation and revocation

### 9.1 Changing a passphrase — 200 bytes, not a re-upload

This is the payoff for the two-level hierarchy in §3, and it is the reason `RK` exists at all rather
than deriving the workspace key straight from the passphrase.

```
1. Derive UK_new = A2id(new_passphrase, CSPRNG(16), m', t', 1, 32)
2. Unwrap RK_e using the old keyholder
3. Seal a new Passphrase keyholder over the same RK_e, with the new descriptor
4. Replace the entry in the keyholder table
5. Rewrite the Keyholders record and the Manifest. Nothing else.
```

**Cost: two records.** No graph record is touched, no capture is re-encrypted, no upload beyond a
few kilobytes, and in git it is a two-file commit. The same mechanism handles re-calibrating the
Argon2 parameters (§4.2) — new parameters are a new descriptor, and the root key does not move.

**What it does not do, and this is the sentence users need:**

> Changing your passphrase protects copies of this workspace made *from now on*. It does nothing to
> the copy on the sync server from last month, the copy in your git history, the copy on the USB
> stick, or the copy in your backups. All of those are still sealed under the same root key, and
> the old passphrase still opens all of them.

That is `31` §11 R9. A passphrase change after a suspected compromise is necessary and it is not
sufficient. What is sufficient is §9.2.

### 9.2 Rotating the root key — the expensive one

A new epoch: `RK_{e+1} = CSPRNG(32)`, new `WK_{e+1}`, and **every record re-sealed**.

| | |
|---|---|
| Cost | The entire workspace is rewritten and re-uploaded. In git it is one commit touching every file. A 2 MiB workspace at 90 records is 90 changed blobs |
| When it is required | A member leaves (§9.3). A keyholder is believed compromised. A recovery code is believed exposed |
| When it is *not* required | An ordinary passphrase change. Do not conflate the two — offering "rotate everything" as the default passphrase-change flow trains users to produce a giant commit for a routine action, and they will stop doing the routine action |
| What it protects | Records sealed **after** the rotation, only |
| What it does not protect | Everything already copied. Git history in particular: every historical commit still holds records sealed under `RK_e`, and anyone who cloned that repository has them forever |

**The git-history problem is not solvable by rotation** and the product must say so at the moment it
matters. If the workspace lives in a repository, a root-key rotation after a compromise requires
rewriting history (`git filter-repo`) and re-pushing, and any existing clone still has the old
objects. That is a git problem with a git answer, and pretending the crypto solves it would be a lie
told at exactly the wrong moment.

### 9.3 Removing a member

```
1. Admin appends a `remove` entry to the member log, signed to quorum (§10.3),
   naming the departing member and establishing epoch e+1.
2. Generate RK_{e+1}.
3. Re-wrap RK_{e+1} to every REMAINING member (HPKE, §10.2) and to every
   non-member keyholder (passphrase, recovery, PRF).
4. Re-seal EVERY record under WK_{e+1}.
5. Only then write the manifest at epoch e+1, and only then report success.
```

**DECISION — eager and blocking.** Lazy re-sealing — re-key on next write, leave the rest — is the
obvious optimisation and it is rejected. A workspace where 400 of 450 records are still readable by
the person you just removed, while the interface says "removed", is a lie with a progress bar. The
flow either completes or it fails, and a failure leaves the workspace at epoch `e` with the removal
entry uncommitted.

**Cost:** removing one member from a 5 MiB workspace rewrites and re-uploads 5 MiB, and produces a
whole-tree commit in git. On a slow link this is minutes, and the flow must be resumable across a
tab close without ever publishing a partial epoch.

### 9.4 Revocation cannot un-see data

Stated without softening, because it is the part every access-control feature is tempted to imply
away:

> **A removed member has already read the workspace. Rotation does not change that. They know your
> peer addresses, your zone structure, which tunnels lack PFS, and what your team decided not to
> fix. If they kept a copy of the file — and there is no mechanism in this or any other design that
> stops them — they keep it, in plaintext, forever.**

What rotation achieves is precisely one thing: **records sealed after the rotation are unreadable to
them.** That is worth doing and it is a small thing next to what they already have.

The correct response to a departure, per `31` §6.3's reasoning about endpoint compromise, is the
same as the correct response to a compromise: **a network change, not a key change.** If the
workspace held `IkeGateway address 203.0.113.10` for a tunnel without PFS, the appropriate action is
to fix the tunnel, not to rotate a file. That is an unpleasant sentence and it is the correct one,
and the revocation flow should say it — once, in the field card's register, in muted prose next to
the confirm button:

> `removing someone does not un-read what they read. rotate the network, not just the file.`

### 9.5 The three rotations, side by side

| Rotation | Records rewritten | Protects | Does not protect |
|---|---|---|---|
| Passphrase / KDF params | 2 | New copies made under the new passphrase | Every copy that already exists |
| Root key (epoch bump) | All | Records sealed after the bump | Everything already copied; git history |
| Member identity key | Keyholders + manifest, then an epoch bump | Future wraps to that member | Anything they already unwrapped |

---

## 10. Sharing and multi-user

### 10.1 Member identity

Each member has one **member seed**, 32 random bytes, from which two keypairs are derived with
distinct info strings. They are never the same key, because using one keypair for both signatures
and key agreement is a mistake with a long literature behind it.

```rust
let seed: [u8; 32] = CSPRNG(32);
let prk = hkdf_sha256::extract(b"fathom/v1/identity", &seed);

let x_sk = hkdf_sha256::expand(&prk, b"x25519", 32);    // HPKE decapsulation
let e_sk = hkdf_sha256::expand(&prk, b"ed25519", 32);   // member-log signatures

/// 96 bits. Second-preimage bound 2^96 — an attacker must find a keypair whose
/// fingerprint matches a *specific* target, not any collision.
fn fingerprint(x_pk: &[u8; 32], e_pk: &[u8; 32]) -> [u8; 12] {
    blake3::hash(&[b"fathom/v1/memberfp", &e_pk[..], &x_pk[..]].concat())
        .as_bytes()[0..12].try_into().unwrap()
}
```

The seed is stored wrapped under the member's own root key, so one passphrase covers a member's
identity across every workspace they belong to. A member who loses their seed loses membership of
every shared workspace and must be re-added by an admin — which is a membership operation, so it is
visible in the log, which is correct.

**Fingerprint rendering.** 96 bits, Crockford Base32 (uppercase, no `I`, `L`, `O`, `U`), 20 symbols
in five groups: `A1B2-C3D4-E5F6-G7H8-J9K0`. Same encoding as the recovery code (§11.1) so users
learn one alphabet.

### 10.2 Wrapping the root key to a member — HPKE

**DECISION — HPKE, RFC 9180, `mode_base` (§5.1), single-shot `Seal` (§6.1).**

| Parameter | Value | Codepoint |
|---|---|---|
| KEM | `DHKEM(X25519, HKDF-SHA256)` | `0x0020` (RFC 9180 Table 2) |
| KDF | `HKDF-SHA256` | `0x0001` (Table 3) |
| AEAD | `ChaCha20Poly1305` | `0x0003` (Table 5) |

```
info = "fathom/v1/keywrap" || ws_id(16) || u64le(epoch)
aad  = memberlog_head(32) || member_fingerprint(12)
pt   = RK_e(32) || u64le(epoch) || memberlog_head(32) || zeros(8)      # 80 bytes

(enc, ct) = HPKE.Seal(pk_member, info, aad, pt)
```

`enc` is 32 bytes (an X25519 encapsulated key), `ct` is 96 bytes (80 + 16 tag). **128 bytes per
member per epoch.** A ten-person workspace carries 1.25 KiB of keyholder entries.

**Why HPKE rather than X25519 + HKDF + AEAD by hand.** Because that is exactly the thing §15 says we
do not do. HPKE is specified, has test vectors, has the `info` and `aad` plumbing already designed,
has multiple independent implementations, and removes a class of subtle mistakes — context binding,
label collision, encapsulation format — that hand-rolled ECIES gets wrong reliably. `mode_base`
rather than `mode_auth` because sender authentication is provided by the member log's Ed25519
signatures (§10.3), where it is a durable, replayable, auditable record rather than a property of a
single ciphertext.

**Why the member fingerprint is in the AAD.** It binds the wrap to *this* member. Without it, a
hostile admin could take Alice's wrapped entry and file it under Bob's name in the table; Bob's
decapsulation would fail, but the failure would be indistinguishable from a corrupt entry. With it,
the mismatch is explicit.

### 10.3 The member log

**DECISION — a hash-chained, append-only log, signed by a quorum of admins, replayed from genesis on
every open.** Not a list the server stores. The distinction is the whole of §10.4.

```rust
/// Canonical CBOR. `digest(entry)` = BLAKE3-256 over the canonical bytes with `sigs`
/// removed. The chain is a list of these, in `seq` order, inside the MemberLog record.
pub struct MemberLogEntry {
    pub seq: u64,
    pub prev: [u8; 32],              // digest of entry seq-1; 32 zero bytes at genesis
    pub ws_id: [u8; 16],
    pub epoch: u64,                  // the key epoch this entry establishes
    pub op: MemberOp,
    pub subject: MemberIdentity,     // fingerprint, x25519_pk, ed25519_pk, label, role
    pub at: u64,
    pub quorum_next: u8,             // admins required to sign the NEXT entry
    pub sigs: Vec<AdminSig>,         // Ed25519 over
                                     //   BLAKE3("fathom/v1/mlog" || canonical_without_sigs)
}

pub enum MemberOp { Genesis, Add, Remove, Promote, Demote, RotateIdentity }
```

**Verification, on every open, from `seq = 0`:**

| # | Check |
|---|---|
| 1 | `prev` equals the digest of the previous entry. Genesis has `prev = 0…0` and is self-signed by its subject |
| 2 | `seq` increments by exactly one, with no gaps |
| 3 | `ws_id` is constant across the chain |
| 4 | `epoch` is non-decreasing, and increases on `Remove` and `Demote` |
| 5 | Every entry carries at least `quorum_next` of entry `seq-1` valid signatures, from Ed25519 keys that were **admins in the state after entry `seq-1`** |
| 6 | The keyholder table contains exactly one `Member` entry per member in the final state, and no others |
| 7 | The manifest's `memberlog_head` equals `digest(last entry)` |
| 8 | The `memberlog_head` inside the keyholder plaintext this member just unwrapped equals the same value |

Any failure is fatal. Not a warning, not a banner — the workspace does not open, and the message
names which check failed and at which `seq`.

The **workspace fingerprint** is `digest(genesis)[0..12]`, rendered in the same 20-symbol Crockford
form as a member fingerprint. It is printed on the workspace card, it never changes for the life of
the workspace, and it is what two members compare when they want to know they are looking at the
same thing.

### 10.4 The server cannot add a member — and what it can do instead

**What it cannot do.** Adding a member requires an entry signed by `quorum` current admins over a
chain-committed digest. The server has no admin Ed25519 secret. It cannot forge one. It cannot
splice an entry into the middle because `prev` chains forward. It cannot append one at the end
because the signature covers `prev` and `seq`. This is the part that works and it works
unconditionally.

**What it can do — and this is the real attack.** It can **withhold** and **equivocate**:

| Attack | Mechanism | Effect |
|---|---|---|
| **Withhold a removal** | Serve Alice a chain ending at `seq 8`; the removal of Mallory is at `seq 9` | Alice keeps writing at epoch `e`, keeps wrapping `RK_e` to Mallory, and Mallory keeps reading. This is worse than adding a member, because it needs no forgery at all |
| **Withhold an addition** | The mirror | Alice cannot decrypt what Bob wrote, and reads it as corruption |
| **Fork / equivocate** | Serve Alice a chain ending at `H_A` and Bob one ending at `H_B`, both valid, diverging at `seq 7` | Two workspaces that both look correct, permanently diverged, each unaware of the other |

None of these is prevented by signatures. This is the key-transparency problem, and the honest
framing is that a signature chain converts "the server can lie about who is a member" into "the
server can lie about *when*", which is a real reduction and not a solution.

### 10.5 Fork detection, and its limit

Three mechanisms, in decreasing order of how much they actually help.

**1 — Every write commits to the head the writer saw.** The manifest carries `memberlog_head`, and
so does every keyholder plaintext. So when Bob opens the workspace after Alice's write, he learns
which chain head Alice was on. If it is not an ancestor of his head, and his is not an ancestor of
hers, that is a fork and the client refuses to open, naming both heads and both `seq` numbers.

This detects equivocation **as soon as two forked members both write and both read.** It is cheap,
it needs no extra channel, and it is the 80 % answer.

**2 — Every client keeps a local log of every head it has ever seen** for each `ws_id`, with
timestamps. Two members comparing those logs out of band — over any channel, by reading twenty
characters aloud — detect any equivocation that ever occurred, including one the server later
repaired. This is manual, it is a thing nobody will do unprompted, and it is the only mechanism that
catches a fork the data plane never healed.

**3 — Out-of-band fingerprint confirmation when adding a member.** §10.6.

**The limit, stated plainly:** a server that fully partitions two members — Alice never sees a byte
Bob wrote, ever — is undetectable in band, because there is no in-band channel between them by
definition. Detection requires an out-of-band comparison and out-of-band comparisons do not happen
unless somebody makes them happen. Residual: `material`.

We are not building a transparency log with independent witnesses. That is the mechanism that would
actually close this, it requires a party neither the user nor we control, it is a large amount of
infrastructure, and it is out of scope for a product whose primary deployment has no server at all.
Saying so is better than shipping a weaker version of it and implying it is the same thing.

### 10.6 Fingerprints, and the usability cost nobody wants to state

When an admin adds a member, the flow requires confirming the new member's 20-symbol fingerprint
over a channel that is not the sync service — a phone call, a face-to-face, a message on a system
the attacker does not also control.

**Nobody does this.** The literature on Signal safety numbers, PGP key signing and SSH host-key
verification is consistent and unkind: verification rates are low, and users click through. Any
design that depends on the check is depending on something that does not occur.

So the design does not depend on it. It **records** it:

| | |
|---|---|
| Default | Trust on first use, with the addition permanently recorded in the chain and displayed |
| The record | Every member sees, on their next open, a non-dismissible acknowledgement: `Alice added Bob (A1B2-C3D4-E5F6-G7H8-J9K0) at epoch 5, 2026-07-14`. It must be acknowledged, and the acknowledgement is itself a chain entry |
| The check | Offered, one screen, with the fingerprint large and the instruction to compare it by voice. Skippable, and skipping is recorded as skipped |
| The escalation | A workspace can be set to `verified-adds-only`, where an unverified `Add` will not be signed. A team that needs this can have it; a team that does not will not be nagged into pretending |

**The honest position:** the acknowledgement is not a security control, it is an *attribution*
control. It does not stop a hostile admin from adding someone; it makes it impossible for them to
have done it quietly. Given that a hostile admin can also just export the plaintext (`31` §5.1 row
13 — there is no in-workspace compartmentation), attribution is close to the whole of what is
achievable, and the design should not pretend to more.

### 10.7 Post-quantum

Two distinct exposures, and only one of them is real today.

| Path | Exposure | Status |
|---|---|---|
| **Single-user, passphrase only** | Argon2id + ChaCha20-Poly1305. Symmetric throughout. Grover halves the effective symmetric security, which at 256-bit keys is not a concern | Fine. No action |
| **Shared workspace, HPKE-wrapped `RK`** | X25519 encapsulation. **Harvest now, decrypt later**: a copy of the keyholder table taken today is decryptable by a future adversary with a cryptographically relevant quantum computer, and decrypting it yields `RK_e`, which yields the whole workspace at that epoch | **This is the exposure.** Its severity depends entirely on how long the workspace's contents stay sensitive, and network topology stays sensitive for a long time |

**DECISION — reserve `suite_id = 0x02` for a hybrid KEM and do not ship it yet.** The candidate is
X-Wing (`draft-connolly-cfrg-xwing-kem`), which combines X25519 and ML-KEM-768 and is designed to be
usable with HPKE. It is an Internet-Draft, not an RFC. Shipping a key-wrapping format against a
moving draft means either tracking its changes in a file format — which cannot be done, because
files already written do not update — or pinning a draft version and living with it.

**What to do in the meantime, honestly:** tell users who have this threat model that the shared,
synced workspace is the exposed shape and the offline single-file shape is not, because the offline
shape has no public-key wrapping in it at all. That is the same advice `31` §7.7 gives for metadata,
and it is not a coincidence: **the sync feature is where nearly all of this product's residual
cryptographic risk lives.**

---

## 11. Recovery

The default is correct and brutal: **forget the passphrase and the workspace is gone.** There is no
reset, because there is nobody holding anything to reset it with. That is the direct consequence of
invariant 4 and it is not negotiable.

It is also, per `31` §2.4, *"the most common way users will actually be harmed by this product"* —
more common than any attack in the threat model. So three optional mechanisms exist. Each one is off
by default, each one is a deliberate weakening, and each one's section states what it hands an
attacker.

### 11.1 Printed recovery code

```
recovery_key = CSPRNG(30)                              # 240 bits
parent = HKDF-Expand(HKDF-Extract(b"fathom/v1/rc", recovery_key), b"recovery", 32)
→ a Recovery keyholder over RK_e, exactly like any other keyholder
```

**No KDF.** 240 bits is not guessable and running Argon2 over it would be theatre.

**Encoding.** Crockford Base32, uppercase, alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ` — no `I`,
`L`, `O` or `U`, and the decoder maps `I`/`l` → `1` and `O` → `0` so the common misreadings are
handled rather than rejected.

```
240 bits of key                    = 48 symbols
40-bit checksum, blake3("fathom/v1/rc-check" || key)[0..5]
                                   = 8 symbols
                                     ────────
total                                56 symbols, in 14 groups of 4
```

```
FATHOM RECOVERY CODE — workspace A1B2-C3D4-E5F6-G7H8-J9K0

  8H4K-2M9P-XR7T-0V3W-QN6B-5YZ1-C8DF-G2JK
  4RM7-9TWX-0B5H-N3QY-KP81-Z6VC

  This code opens the workspace without the passphrase.
  Anyone holding this paper holds the workspace.
```

The checksum is 40 bits, so a typo is caught with probability `1 − 2⁻⁴⁰`. It is a **checksum, not an
error-correcting code**: it tells the user they mistyped, it does not tell them where. That is a
deliberate choice — error correction on a secret means the code tolerates partial knowledge, which
is not a property you want a recovery code to have.

**What it gives an attacker.**

| | |
|---|---|
| A path that bypasses Argon2id entirely | The workspace's security becomes `min(passphrase strength × KDF, physical security of one sheet of paper)`. Paper in a drawer is often the weaker term |
| Retroactive value | The `Recovery` keyholder is in every copy of the file. An attacker who took the ciphertext in March and finds the paper in November opens the March copy |
| **Survival of a passphrase change** | This is the footgun. §9.1 rewrites the `Passphrase` keyholder and leaves the `Recovery` keyholder alone, because it wraps the same `RK_e`. **The old printed code still works.** The passphrase-change flow must offer to reissue the recovery code in the same step, and must state in one line that not doing so leaves the old paper valid |
| **Survival of a member removal** (ADR-0014) | The recovery code bypasses the KDF and is **re-wrapped at every epoch bump** (§9.3 step 3), so removing a member re-arms the printed paper against the *new* epoch. A departed admin who photographed the safe's contents retains access across the revocation performed because they left. The removal flow must require an explicit re-print-or-revoke step for the recovery code |

### 11.2 Shamir escrow for a team

Split the *recovery key*, not `RK`, so the escrow path and the paper path are the same mechanism.
`k`-of-`n` over GF(2⁸), default 2-of-3, using `vsss-rs` (§15) rather than a hand-rolled polynomial.

```
Share i (printed):
  workspace fingerprint       12 bytes    — so shares can be matched to a workspace
  genesis admin ed25519_pk    32 bytes    — so the signature below is checkable offline
  index i                      1 byte
  share bytes                 31 bytes
  ed25519 signature           64 bytes    — over ("fathom/v1/share" || fp || i || H(share))
                              ─────────
                             140 bytes → 224 Crockford symbols, 56 groups of 4
```

That is a long thing to type. It is long because plain Shamir has a specific failure the
distribution ceremony does not: **it is not verifiable.** A shareholder who submits a corrupt share
produces a reconstruction that silently yields the wrong key, and you learn only that recovery
failed — not who lied. The signature makes a bad share attributable before reconstruction is
attempted. A full verifiable secret-sharing scheme (Feldman, Pedersen) would do this more elegantly
and pulls in commitments and a group; the signature is the cheap version and it is honest about
being the cheap version.

**What it gives an attacker:** `k` colluding shareholders read everything, forever, without touching
the user's device and without the user ever knowing. This is not a recovery feature with a security
caveat. **It is a threshold backdoor**, and the setup flow should use that word.

Also: `k`-of-`n` where all `n` shares are in the same safe is `1`-of-`1` with extra steps (§17.7).

### 11.3 The comparison, so a user can choose

| Mechanism | Recovers from | Costs the attacker | Off by default |
|---|---|---|---|
| Nothing | — | — | this is the default |
| Printed code | Forgotten passphrase | One sheet of paper, if they can reach it | yes |
| `k`-of-`n` shares | Forgotten passphrase; a departed sole keyholder | `k` colluding people | yes |
| WebAuthn PRF (§12) | Forgotten passphrase, if configured as an OR keyholder | Physical possession of the authenticator, plus whatever unlocks it | yes |

---

## 12. Hardware-backed keys — WebAuthn PRF

### 12.1 What PRF gives us

The WebAuthn `prf` extension exposes the CTAP2 `hmac-secret` capability: the authenticator computes
an HMAC over a caller-supplied salt, keyed by a secret bound to the credential, and returns
**32 bytes**. The browser does not pass the salt through raw — per the WebAuthn specification it
first computes

```
actualSalt = SHA-256( UTF8("WebAuthn PRF") || 0x00 || callerSalt )
```

which partitions the PRF's input space so a website cannot make an authenticator produce HMACs
intended for non-web uses. Two salts (`first`, `second`) can be evaluated in one ceremony, which is
what makes a clean rotation possible: derive under the old and the new salt in a single user
gesture.

### 12.2 How it composes with the KDF

**The PRF output is already 32 uniform bytes. It does not go through Argon2id.** Running a
memory-hard KDF over a uniformly random 256-bit value is a second of wasted time that protects
against nothing — there is no low-entropy guess to slow down.

Two compositions, both offered:

**OR (default) — an additional keyholder.**

```
salt   = "fathom/v1/prf/" || ws_id                          # fixed per workspace, so it
                                                            # survives across devices for a
                                                            # synced passkey
prf    = navigator.credentials.get({ extensions: { prf: { eval: { first: salt }}}})
parent = HKDF-Expand(HKDF-Extract("fathom/v1/prf", prf),
                     "webauthn-prf|" || credential_id, 32)
→ a WebAuthnPrf keyholder over RK_e
```

Security of the workspace becomes `max(passphrase, token)` — the passphrase keyholder is still
there, so **the floor is unchanged.** This is what most users want and the UI must not imply it
raises security. It raises *convenience*, which is a real and honest benefit: it is the difference
between typing six words every morning and touching a key.

**AND — a second factor.**

```
UK     = A2id(passphrase, kdf_salt, m, t, 1, 32)
parent = HKDF-Expand(HKDF-Extract(kdf_salt, UK || prf), "pass+prf", 32)
→ a PassAndPrf keyholder; there is NO separate passphrase-only keyholder
```

Security becomes `passphrase AND token`. **Lose the token and the workspace is gone**, unless a
recovery code exists. The flow must say that in those words — and per ADR-0014 a printed
recovery code is a **constructor precondition** of the `PassAndPrf` keyholder, not a prose
recommendation: the constructor refuses to build AND mode until a recovery keyholder exists.
§17.4's own thesis applies — unenforced sequencing rules are where the bugs are.

### 12.3 Support, as of the sources checked

<!-- VERIFY: browser and platform support for the WebAuthn PRF extension moves quickly. Re-check
     before any release and before quoting this table in an enterprise review pack. The rows below
     are from the sources in §20 and are dated, not measured by us. -->

| Platform | Status |
|---|---|
| **Windows 11** | Windows Hello `hmac-secret` requires the February 2026 update (KB5077181). Chrome/Edge 147+ support PRF at credential creation; 146 supports it only at authentication. Firefox 148+ supports both |
| **macOS 15+ / iOS 18.4+** | Works via iCloud Keychain in Safari 18+, Chrome 132+, Firefox 139+. Earlier iOS had cross-device data-loss bugs |
| **Android** | Chrome, Edge and Samsung Internet with Google Password Manager. **Firefox on Android: no PRF** |
| **Security keys** | Model-dependent, and `hmac-secret` may need to have been requested at credential creation. WebKit bugs affecting CTAP2 security keys were still open at macOS/iPadOS 26.4. **iOS/iPadOS does not pass extension data to roaming authenticators at all** |

**The consequence for the flow:** PRF at credential *creation* is not reliable across the matrix.
Register the credential, then immediately perform a `get()` to obtain the PRF output and build the
keyholder. **Two ceremonies, two user gestures, for one setup.** That is a usability cost and there
is no way around it while the creation-time path is inconsistent.

**Fallback when unsupported:** the keyholder type is simply not offered. Capability detection at
setup time, not at unlock time — discovering at unlock that the token cannot be used is the worst
possible moment. And because support varies *per platform*, a workspace with only a PRF keyholder
may be openable on the user's laptop and not on their phone. The UI must state which keyholders a
workspace has and which of them this device can use, before the user relies on it.

### 12.4 The word "hardware-backed" is doing too much work

This is the honest observation in this section and it is not in the browser-support tables.

| Credential type | Where the `hmac-secret` root actually lives | Real threat model |
|---|---|---|
| **Security key** (YubiKey and similar) | A secure element on a physical token. It never leaves | Physical possession plus whatever unlocks the token |
| **Synced passkey** (iCloud Keychain, Google Password Manager) | **The provider's escrow**, synced across the user's devices | The security of the user's Apple or Google account — password, second factor, account recovery, and that provider's insider and legal-process posture |

Both present the same API and produce the same 32 bytes. They are not the same security property,
and a product that says "hardware-backed" over both is misdescribing the second one. Fathom's UI
must name which it is: `security key` or `synced passkey (Apple)`. For a user whose threat model
includes legal process against a cloud provider — which is a substantial part of the audience `31`
§2.4 identifies — a synced passkey moves their workspace key into exactly the kind of third-party
escrow the rest of this design exists to avoid.

---

## 13. The offline single-file case

### 13.1 Where the ciphertext lives

| Store | Under `file://` | Evictable | Verdict |
|---|---|---|---|
| **IndexedDB** | **Blocked** under the opaque origin a `file://` document gets (already recorded in `24-ai-determinism-and-offline.md` §2.2) | yes | Not usable |
| **OPFS** | — | — | **Not used (ADR-0012, ADR-0017)** |
| **`localStorage`** | Small, synchronous, string-only | yes | No |
| **A file the user saved** | Works everywhere | **no** | **Primary — and only** |

**DECISION — the file is the store, and there is no browser-storage cache.** The OPFS
working-cache branch previously specified here is deleted per ADR-0012: ADR-0017 decides that
mode D1 uses **no browser storage of any kind** — no OPFS, no IndexedDB, no Cache API, no
`localStorage`, no cookies, no service worker. `43` §3.12 prices the resulting total loss of
crash recovery, a cost this document never saw when it argued for the cache.

Two mechanisms for saving:

| Mechanism | Where | Behaviour |
|---|---|---|
| **File System Access API** (`showSaveFilePicker`, a retained `FileSystemFileHandle`) | Chromium | A real handle. Save writes back to the same file, like a desktop application |
| **Download fallback** | Firefox, Safari | Every save produces a new file in the Downloads folder. `workspace (14).fathom` is a real outcome and the product should name the file with the workspace fingerprint and a version counter so the newest one is identifiable |

The download fallback is genuinely poor and there is no fixing it from inside a browser. It is one
of the stronger arguments for shipping the CLI, alongside the extension argument in `31` §6.2.

### 13.2 Two shapes, one format — owned by `17` (ADR-0012)

> **Superseded by ADR-0012:** the container shapes — directory versus packed file, the
> on-disk tree, `pack`/`unpack` — are owned by `17-workspace-format.md` §2–§3 and are no
> longer specified here.

### 13.3 Git — owned by `17` (ADR-0012)

> **Superseded by ADR-0012:** git behaviour — attributes, the diff `textconv`, conflict
> handling — is owned by `17-workspace-format.md` §12 and is no longer specified here. Two
> facts from the deleted text remain load-bearing and are stated in one line each:
> ciphertext does not diff, and **`cachetextconv` must be off** — git caches textconv output
> in `.git/` in the clear, a one-line configuration mistake with a total confidentiality
> consequence (§17.12; `17` §12.7 ships `false`).

### 13.4 The rule that makes git usable at all

> **Never re-seal a record whose canonical plaintext is unchanged.**

Because every seal draws a fresh 32-byte salt, re-sealing an unchanged record produces completely
different ciphertext. Save the workspace without touching anything and all 90 records change; git
stores 90 new blobs; a month of saves is a repository measured in gigabytes for a workspace measured
in megabytes.

The check is `H(canonical_plaintext)`, computed before compression, held in memory alongside the
open workspace and recorded in the manifest. Comparing compressed bytes or ciphertext bytes does not
work — the first is sensitive to the zstd version and the second is random by construction.

This is four lines of code and it is the difference between a design that works in git and one that
does not. It has its own CI check (§18).

---

## 14. Memory hygiene

### 14.1 What Rust gives us

| Tool | Version | Use |
|---|---|---|
| `zeroize` | 1.9.0 | `Zeroizing<T>` wrappers and `#[derive(ZeroizeOnDrop)]` on `KeyRing`. Volatile writes plus compiler fences, so the write cannot be optimised away |
| `secrecy` | 0.10.3 | `SecretBox<[u8; 32]>` for anything crossing a module boundary — makes accidental `Debug` printing and accidental `Clone` into compile errors |
| `subtle` | 2.6.1 | `ConstantTimeEq` for the commitment tag compare (§3.2) and for every other secret comparison |

### 14.2 What Rust does not give us, and it is more than people expect

| Problem | Detail |
|---|---|
| **Moves leave copies** | `let k = keyring.wk;` moves 32 bytes and leaves the source bytes on the stack. `zeroize` runs on the *destination's* drop. Mitigation: keys live behind `Box`, are never moved out, and are accessed by reference. This is a discipline, and a code-review item, not a guarantee |
| **Spills and registers** | The compiler may copy key bytes into registers and spill them to stack slots that no destructor knows about. `zeroize` prevents *elision* of the write you asked for; it cannot erase copies the optimiser made |
| **Reallocating containers** | A `Vec` that grows copies its buffer and frees the old one without zeroing. Use fixed-size arrays for keys, and `Zeroizing<Vec<u8>>` with capacity reserved up front for plaintext buffers |
| **Panics** | A panic unwinds and runs destructors, so `Zeroizing` works. `panic = "abort"` does not run them. The core builds with unwinding for this reason, and it costs binary size |

### 14.3 What the browser makes impossible

Four items, in descending order of how much they matter:

**1 — `WebAssembly.Memory` is a `Uint8Array` to JavaScript.** Any script in the origin can read the
entire WASM linear memory, including every key, at any time. Zeroing on `lock()` removes them from
*later* reads. It removes nothing from a script that is already running. `31` §4.3 is the reference
and this document does not soften it.

**2 — JavaScript strings cannot be erased.** The passphrase enters as an `<input>` value, which is a
JS string, which is immutable. Setting `input.value = ''` creates a new string and leaves the old
one on the heap until garbage collection, and possibly after. Best practice reduces the window:

```js
// The whole exposure, in the order it must happen.
const bytes = new Uint8Array(wasmMemory.buffer, ptr, 512);
const { written } = new TextEncoder().encodeInto(input.value, bytes);   // straight into WASM
input.value = '';                                                       // new string; old survives
form.reset();
// The original string, the input's internal value, any undo-buffer entry, and any
// event object that referenced it are all still reachable to the GC's discretion.
```

There is no secure string primitive in the platform. There is no way to ask the engine to overwrite
one. This is `31` §11 R10 and it is unfixable from inside the application.

**3 — No `mlock`, no `MADV_DONTDUMP`, no control over swap.** The OS may page the renderer, and its
memory may appear in a crash dump, a session-restore snapshot, a tab-discard snapshot or the
back/forward cache. None of these events is observable to the page. The Argon2 buffer (§4.4) is the
largest single block of key-correlated memory the product allocates and it is as pageable as
anything else.

**4 — Garbage collection and JIT.** Even for JS objects the application does control, the engine
decides when memory is reclaimed and may copy objects during compaction. Guaranteed erasure is not
a property the platform offers.

### 14.4 The honest statement

> **Guaranteed key erasure in a browser is unachievable.** Zeroing WASM linear memory on lock is
> worth doing, is easy, and is tested in CI. It reduces the window in which a heap snapshot,
> a crash dump or a later script read finds key material. It does not close it, it does nothing
> about the passphrase's JavaScript string, and it does nothing about anything the operating
> system or the browser copied elsewhere without telling us.
>
> The only controls that actually work are closing the tab, and full-disk encryption on a
> powered-down machine.

`31` §5.3's verification checklist item 9 is written to *fail partially* for exactly this reason,
and CI asserts the partial failure rather than papering over it (§18).

### 14.5 What `lock()` does, concretely

```rust
pub fn lock(&mut self) {
    self.graph.clear_and_zeroize();      // opened plaintext, largest by far
    self.captures.clear_and_zeroize();
    self.keyring.zeroize();              // ZeroizeOnDrop; RK, WK, member secrets
    self.scratch.zeroize();              // any decompression buffer
    // The Argon2 arena is not here: it lives in the crypto worker, which was
    // terminated after unlock (§4.5) — which is the only way its memory is
    // actually returned to the browser.
}
```

`lock()` must also clear the *rendered* content, not overlay it — `31` §6.4. An overlay is a
screenshot away from nothing.

---

## 15. What is deliberately not rolled by hand

### 15.1 The primitives, pinned

Versions are the latest published on crates.io as of 2026-07-28. Pinned in `Cargo.lock`, which is
committed, and checked by `cargo-deny` and `cargo-vet` in CI (`31` §5.1 row 8).

| Crate | Version | Used for | Independent review status |
|---|---|---|---|
| `argon2` | `0.5.3` | Argon2id, RFC 9106 | <!-- VERIFY: check for a published audit of the RustCrypto password-hashes crates before claiming one. A `0.6.0-rc.8` exists; do not ship an rc in a file format. --> |
| `chacha20poly1305` | `0.11.0` | AEAD, RFC 8439 | <!-- VERIFY --> |
| `hkdf` | `0.13.0` | RFC 5869 | <!-- VERIFY --> |
| `sha2` | `0.11.0` | SHA-256 under HKDF and HPKE | <!-- VERIFY --> |
| `hpke` | `0.14.0` | RFC 9180, `mode_base` | <!-- VERIFY. Alternative considered: `hpke-rs` 0.7.0. One must be chosen and the other removed; two HPKE implementations in one binary is a supply-chain surface for no benefit. --> |
| `x25519-dalek` | `3.0.0` | HPKE's DHKEM | <!-- VERIFY --> |
| `ed25519-dalek` | `3.0.0` | Member-log signatures | <!-- VERIFY --> |
| `curve25519-dalek` | `5.0.0` | Transitive to both | <!-- VERIFY --> |
| `blake3` | `1.8.5` | Content digests, fingerprints, shard assignment | <!-- VERIFY --> |
| `getrandom` | `0.4.3` | CSPRNG, `wasm_js` backend → `crypto.getRandomValues` | n/a |
| `zeroize` | `1.9.0` | §14.1 | n/a |
| `secrecy` | `0.10.3` | §14.1 | n/a |
| `subtle` | `2.6.1` | Constant-time comparison | n/a |
| `vsss-rs` | `5.4.0` | Shamir, §11.2. Optional feature, not in the default build | <!-- VERIFY. A `6.0.0-rc9` exists; stay on stable. --> |
| `ml-kem` | `0.3.2` | Reserved for suite `0x02`. **Not in the build** | <!-- VERIFY --> |

**On the audit column.** `31` §10.1's last row says Fathom makes *"no security audit claim of any
kind"*. That applies to our dependencies too. Several of these crates are widely used and widely
read; that is not the same as audited, and this table will say "audited" only next to a report with
a name and a date on it. Until then the honest word is "widely used".

**`ring` was considered and not chosen.** It is a good library. Its `wasm32-unknown-unknown` story
requires more work than the pure-Rust stack, it mixes C and assembly into a build we want to be
reproducible (`31` §5.1 rows 7 and 9), and mixing it with the RustCrypto traits the rest of the core
already uses would mean two idioms in one crypto layer.

### 15.2 What we do write, and why that is where the bugs will be

| We write | Why it cannot be borrowed |
|---|---|
| The envelope framing (§7) | It is our format |
| The keyholder table and the trial-decryption flow (§7.4) | Ours |
| The member log and its verification (§10.3) | Ours |
| Sharding, padding, pack/unpack (§6, §13.2) | Ours |
| The manifest and rollback rule (§8) | Ours |

**This list is where the vulnerabilities will be.** Primitive breaks are rare and get CVEs; framing
and state-machine bugs are common and get quiet patches. A length field that is trusted before it is
checked, an AAD that omits a field, a verification loop that returns early on the first valid
signature, a keyholder table parsed before its descriptor is authenticated — these are the realistic
failures of this design, and they are exactly what §16's negative test vectors exist to catch.

---

## 16. Test vectors and cross-implementation compatibility

The requirement: **a future native client, written by someone who has never spoken to us, must open
the same workspace and produce the same graph.** That is only checkable with vectors, so vectors are
part of the format, not part of the test suite.

### 16.1 The vector tree

```
vectors/
  01-argon2id.json          passphrase, salt, m, t, p → UK           (32 B)
  02-hkdf-record.json       parent, header(112), aad_ext → K_enc, K_cmt
  03-envelope-seal.json     parent, header, aad_ext, plaintext → full envelope bytes
  04-envelope-open.json     envelope, parent → plaintext, and the expected error for each
                            negative case
  05-padme.json             ~200 (input, output) length pairs, including boundaries
  06-cbor-canonical.json    graph fragment → canonical CBOR bytes
  07-keyholder.json         each KeyholderKind: descriptor + parent → wrapped RK
  08-hpke-wrap.json         our info/aad construction on top of RFC 9180's own vectors
  09-memberlog.json         a 6-entry chain with two admins, quorum 2, digests and signatures
  10-manifest.json          record set → canonical manifest bytes → digest
  11-recovery-code.json     key bytes → the 56-symbol string, and back; plus 20 typo cases
  12-shard.json             1000 node IDs → shard index, at S = 8, 64, 256
  99-workspace/             a complete 40-node workspace, passphrase "correct horse battery
                            staple", committed to the repo, plus the expected canonical
                            graph digest after opening it
```

`99-workspace/` is the acceptance test for any implementation: open it, canonicalise the graph,
compare one BLAKE3 digest. It contains a small SRX estate drawn from the field card — a `Device`, an
`IkeGateway` at `203.0.113.10` with `external-interface reth0.0`, an `IpsecPolicy` with
`perfect_forward_secrecy: Absent` so the `ipsec.pfs.absent` rule fires, an `st0.0` `LogicalUnit`
bound to the VPN, and a `Zone` missing `host-inbound-traffic system-services ike`. If a second
implementation opens that workspace and its rule engine produces the same findings, the whole stack
is compatible, not just the crypto.

### 16.2 Negative vectors — the ones that matter

Every one of these must fail, and must fail with **the specified error**, not merely fail:

| Vector | Expected |
|---|---|
| Wrong passphrase | `WrongKey` — commitment compare fails **and** the AEAD open fails (ADR-0014: the open runs regardless) |
| One byte of ciphertext flipped | `Tampered` — commitment compare passes, Poly1305 fails |
| One byte of `commit_tag` flipped (ADR-0014) | `CommitmentMismatch` — the AEAD open succeeds, the compare fails. **Never `WrongKey`**: the user's passphrase is correct and telling them otherwise makes them try harder instead of restoring from backup |
| `record_id` changed from shard `0x2a` to `0x2b` | `WrongKey` (the key derivation changed) |
| `schema_minor` bumped by one | `WrongKey` |
| `flags` `zstd` bit cleared | `WrongKey` |
| Keyholder descriptor's `m_kib` altered | `WrongKey` |
| Ciphertext truncated by 1 byte | `Tampered` |
| Envelope truncated inside the header | `Malformed` |
| `header_len` says 96 | `Malformed` |
| `envelope_version` = 2 | `UnsupportedVersion { envelope: 2 }` — **and nothing else parsed** |
| `suite_id` = 0x7f | `UnsupportedSuite { suite: 0x7f }` |
| Manifest names a record that is absent | `MissingRecord` |
| A record present that the manifest does not name | `ExtraRecord` |
| Manifest with a strictly-dominated version vector | `Rollback { seen, offered }` |
| Member log with a broken `prev` at seq 3 | `ChainBroken { seq: 3 }` |
| Member log entry with one signature where quorum is 2 | `QuorumNotMet { seq, have: 1, need: 2 }` |
| Member log entry signed by a demoted admin | `NotAnAdmin { seq, fp }` |
| Keyholder table with a `Member` entry for a non-member | `KeyholderMismatch` |
| `memberlog_head` in the keyholder ≠ the manifest's | `MemberLogDivergence` |
| Recovery code with one transposed symbol | `ChecksumFailed` — never `WrongKey` |

### 16.3 The deterministic-seal hook, and the risk it creates

Vector `03` requires a fixed salt, so the seal path needs an injection point:

```rust
#[cfg(feature = "test-vectors")]
pub fn seal_with_salt(parent: &[u8;32], salt: [u8;32], /* … */) -> Vec<u8>;
```

**A fixed-salt hook that reaches a release build is a nonce-reuse vulnerability shipped as a
feature.** Three controls, because one is not enough for a bug of this severity:

1. Behind a non-default cargo feature that is never enabled in any release profile.
2. CI runs `nm` / `wasm-objdump -x` over the release artifact and fails the build if the symbol is
   present.
3. The function name is deliberately ugly and greppable, and a repository check rejects any call
   site outside `tests/`.

### 16.4 Cross-implementation obligations

Anything claiming to read a Fathom workspace must:

| # | Obligation |
|---|---|
| 1 | Pass every vector in `vectors/`, positive and negative, including the exact error taxonomy |
| 2 | Produce canonical CBOR per RFC 8949 §4.2.1, verified by vector `06` |
| 3 | Verify the member log from genesis on every open — not cache the result across sessions |
| 4 | Refuse unknown `envelope_version` and `suite_id` rather than best-effort parsing |
| 5 | Implement the rollback rule of §8.2, including refusing rather than warning |
| 6 | Never re-seal an unchanged record (§13.4) — checked by vector `99` plus a save-twice test |
| 7 | Preserve unknown fields byte-for-byte per `11-ir-schema.md` §11.4 |

A conformance runner, `fathom-crypto-conformance`, reads the vector tree and reports per-vector
pass/fail. It ships in the repository so a third-party implementer can run it without asking us for
anything, which is the same principle as `31` §5.3.

---

## 17. Things that bite

The field card's device, applied to this document. Each of these is a real failure mode of *this
design*, each has a symptom that points somewhere else, and each will cost somebody a day.

**17.1 Re-sealing unchanged records.** Symptom: every save touches all 90 files; the repository
grows by the size of the workspace per commit; `git gc` does not help because ciphertext does not
delta-compress. Cause: comparing ciphertext or compressed bytes instead of `H(canonical_plaintext)`.
§13.4. This is the most likely serious mistake in the implementation and it is four lines.

**17.2 The fixed-salt test hook in a release build.** Symptom: none, ever, until someone diffs two
envelopes of the same record and finds identical salts. Cause: a cargo feature enabled by a
convenience alias in a CI file. §16.3.

**17.3 KDF parameters calibrated on the wrong device.** Symptom: the workspace will not open on a
phone; the error surfaces as "could not read file"; the user believes their data is gone. Cause:
calibration on a workstation without the §4.2 cap, plus an unlock path that does not distinguish
allocation failure from a bad passphrase. Always report `memory.grow` failure as itself.

**17.4 The recovery code that survived a passphrase change.** Symptom: none — that is the problem.
The old printed code is still a valid keyholder for the same `RK_e`. §11.1. The passphrase-change
flow must offer to reissue it in the same step.

**17.5 WASM memory that never comes back.** Symptom: the tab sits at 300 MB after unlock and never
drops, and a second unlock does not double it but a larger `m` does. Cause: `WebAssembly.Memory`
cannot shrink (§4.4). The fix is the throwaway worker (§4.5), and if a `file://` document cannot
spawn a worker the fix does not exist and the cap must come down.

**17.6 A stale client writing at an old epoch.** Symptom: a member who was removed last Tuesday can
still read records written on Wednesday. Cause: a client that never re-read the manifest continued
sealing under `WK_e`. The manifest's epoch is authoritative; a client must refuse to write at an
epoch below the one in the manifest it last read, and must re-read the manifest before every write.

**17.7 `k`-of-`n` shares in one safe.** Symptom: none until an audit. That is `1`-of-`1` with extra
typing, and it is what will actually happen unless the distribution flow names each holder and
records where each share went. §11.2.

**17.8 "Hardware-backed" that is a cloud account.** Symptom: a user in a jurisdiction with legal
process against cloud providers believes their key is in a secure element, and it is in iCloud
Keychain. §12.4. Name the credential type in the UI, every time.

**17.9 `crypto.getRandomValues` in a cloned or restored VM.** Symptom: two envelopes of the same
record with the same salt — which nothing in the application will notice, because nothing checks.
Cause: a duplicated VM image, a container built with a snapshot, an embedded browser with a
fresh-boot entropy failure. §5.4 case 5. Residual `material`, no in-application detection.

**17.10 Zeroing the wrong copy.** Symptom: a heap scan after `lock()` finds a 32-byte key that
`ZeroizeOnDrop` was supposed to have erased. Cause: `let k = keyring.wk;` moved it and the
destructor ran on the destination. §14.2. Keys live behind `Box` and are accessed by reference,
always.

**17.11 Attacker-supplied text sharing a compression context with workspace data.** Symptom: none,
directly — a length-based side channel. Cause: batching a pasted capture into the same record as
graph data to save space. §6.1–6.3's rule: one compression context per record, and captures never share.

**17.12 `git config diff.fathom.cachetextconv = true`.** Symptom: none. Consequence: git writes
decrypted workspace content into `.git/`, in the clear, permanently, where nobody will ever look for
it. One line in a config file, total confidentiality loss for the repository. §13.3.

**17.13 The diff driver's plaintext in a pager.** `git log -p` pipes decrypted workspace content
through `less`, which writes a temporary file, and into a terminal, whose scrollback may be logged
by the terminal emulator, the multiplexer, or the session recorder the organisation installed. The
crypto ends at the diff driver's stdout. `31` §6.5 is the general form of this and it applies here
specifically.

**17.14 Nothing in this scheme depends on the clock.** Worth stating because the field card's side 4
warns that *"clock skew kills certificates"*, and a reader may reasonably expect a similar trap
here. There is none: no certificate, no expiry, no validity window, no timestamp in any verification
path. `written_at` and `at` are display metadata. A workspace opened on a machine whose clock is
wrong by ten years opens correctly. That is a deliberate property and it should not be given away
casually in a future version.

---

## 18. What CI enforces

A cryptographic design that is not tested is a diagram. These fail a build.

| Check | Enforces | Fails when |
|---|---|---|
| Salt uniqueness over 10⁶ seals | §5.4 | Any duplicate salt, or any salt not sourced from `getrandom` (checked by symbol, not by inspection) |
| Test-hook absence in release artifacts | §16.3 | `seal_with_salt` appears in any release `.wasm` or native binary |
| Full vector suite, positive and negative | §16 | Any vector fails, or produces the wrong error variant |
| Commitment-before-MAC ordering | §3.2, §5.6 | A wrong-key open returns `Tampered` instead of `WrongKey`, or reaches the AEAD at all |
| Idempotent save | §13.4 | Saving an unchanged workspace twice changes any record's bytes |
| Padmé bucket assertion | §6.4, and `31` §12 | Any envelope's total length is not `padme(length)` |
| AAD completeness | §7.2 | Any header field can be altered without changing the derived key or failing the MAC — property-tested by mutating each byte of the header in turn |
| Argon2 floor | §4.2 | A workspace is written with `m < 64 MiB` or `t < 3` or `p ≠ 1` |
| Allocation-failure path | §4.4 | A simulated `memory.grow` failure surfaces as anything other than a distinct, named error |
| Member-log verification from genesis | §10.3 | A cached verification result is used, or any of checks 1–8 is skippable |
| Rollback refusal | §8.2, `31` §12 | A strictly-dominated version vector is accepted without a typed confirmation |
| Fork refusal | §10.5 | Divergent `memberlog_head` values open successfully |
| Eager revocation | §9.3 | A workspace can reach a state where the manifest is at epoch `e+1` and any record is at `e` |
| Zeroise-after-lock heap scan | §14, `31` §12 | The canary appears in WASM linear memory after `lock()`. **The same canary is asserted to still appear in a JS string** — the test fails if it does *not*, because a passing result there would mean the test is wrong, not that the problem is fixed |
| Cross-implementation vector round-trip | §16.4 | The conformance runner reports any failure against `vectors/` |
| Dependency pinning | §15.1 | `Cargo.lock` is not committed, or `cargo-deny` reports an advisory, or two HPKE implementations are present |

---

## 19. Residual risk

Using the scale from `31` §1.4. Ranked by what should get attention, not by severity.

| # | Residual | Tag | Accepted because | Revisit when |
|---|---|---|---|---|
| C1 | Passphrase entropy is the binding constraint; the KDF is a constant factor | `material` | Structural. §4.7 | If generated-passphrase adoption measures low — the answer is product, not crypto |
| C2 | A compromised or replayed platform CSPRNG breaks the scheme, undetectably | `material` | True of every randomised scheme. §5.4 case 5 | If a platform ships an attestable RNG a page can check |
| C3 | Shared-workspace HPKE wrap is harvest-now-decrypt-later exposed | `material` | X-Wing is a draft, not an RFC. §10.7 | When X-Wing or an equivalent hybrid is an RFC with a maintained Rust implementation |
| C4 | A hostile sync service can withhold or fork the member log; in-band detection needs two members to write and read | `material` | Closing it needs an independent witness we do not control. §10.5 | If a customer's deployment can host a witness they trust |
| C5 | Git history holds every historical record under its epoch key; rotation does not reach it | `material` | Git's model, not ours. §9.2 | Never — surface it at export time instead |
| C6 | The exploded/git shape publishes the per-shard change pattern with full history | `material` | The direct price of diffability. §6.5 | If a user asks for both; the answer is single-file commits, not a better cipher |
| C7 | No key erasure guarantee in a browser; the passphrase's JS string cannot be erased at all | `material` | Platform limitation. §14.4, `31` R10 | If a browser ships a usable secure-input primitive |
| C8 | Recovery code and Shamir escrow are deliberate weakenings, off by default | `material` | The user's explicit choice, with the cost named. §11 | If either becomes a default. It must not |
| C9 | A synced passkey's PRF root lives in a cloud provider's escrow | `material` | The platform's design. §12.4 | Never — name the credential type instead |
| C10 | Record count, capture count and total size leak; the manifest's version vector leaks device count | `bounded` | §6.5, §8.2. Padmé bounds the size channel | If a customer's requirement makes any of these disqualifying — the answer is the offline single file |
| C11 | Rollback protection is client-side state; a fresh client cannot detect anything | `bounded` | §8.3 | If a trusted-first-contact mechanism ever exists |
| C12 | Every header field is in the clear | `bounded` | Deliberate, and inherited from `11-ir-schema.md` §11.2 | Never — the alternative is running the KDF before you can learn you cannot read the file |
| C13 | Trial decryption across multiple passphrase keyholders costs one Argon2 run each | `none` (usability, not security) | §7.4. Solved by naming keyholders rather than iterating | — |
| C14 | Anyone with the passphrase reads the whole workspace; there is no in-workspace compartmentation | `material` | `31` §5.1 row 13. A product decision (brief §6.4), and the right one at team scale | When multi-writer CRDT sync becomes load-bearing |

---

## 20. Sources

| Claim | Source |
|---|---|
| Argon2id, the `id` variant's rationale, parameter recommendations, 128-bit salt, 256-bit tag; second recommended option `t=3, p=4, m=64 MiB`; first option `t=1, p=4, m=2 GiB`; the procedure begins by determining available threads | RFC 9106, §4 |
| AEAD_CHACHA20_POLY1305 construction, 96-bit nonce, 128-bit tag | RFC 8439 §2.8 |
| HKDF Extract and Expand | RFC 5869 §2.2, §2.3 |
| HPKE: `mode_base`, Encap/Decap, key schedule, single-shot Seal/Open; `DHKEM(X25519, HKDF-SHA256)` = `0x0020`, `HKDF-SHA256` = `0x0001`, `ChaCha20Poly1305` = `0x0003`; ChaCha20Poly1305 `Nk` = 32, `Nn` = 12 | RFC 9180 §4.1, §5.1, §5.1.1, §6.1, Tables 2, 3, 5 |
| Deterministic/canonical CBOR encoding | RFC 8949 §4.2.1 |
| Non-committing AEADs enable partitioning oracles; key multi-collisions demonstrated against AES-GCM, ChaCha20-Poly1305 and XSalsa20/Poly1305; practical password recovery against Shadowsocks; the recommendation to standardise key-committing AEAD | Len, Grubbs, Ristenpart, *Partitioning Oracle Attacks*, USENIX Security 2021 |
| Padmé bounds length leakage to O(log log M) bits with at most 12 % overhead, ≈6 % at 1 MB, ≈3 % at 1 GB | Nikitin, Barman, Lueks, Underwood, Hubaux, Ford, *Reducing Metadata Leakage from Encrypted Files and Communication with PURBs*, PoPETs 2019(4) |
| OWASP's Argon2id guidance (`m=47104, t=1, p=1` or `m=19456, t=2, p=1`) is tuned for interactive server-side authentication and is a floor for that setting, not for a local vault | OWASP Password Storage Cheat Sheet |
| `SharedArrayBuffer` requires cross-origin isolation, which requires `COOP: same-origin` and `COEP: require-corp` **HTTP headers**; WASM threads require `SharedArrayBuffer` | web.dev, *Making your website cross-origin isolated using COOP and COEP*; MDN, `SharedArrayBuffer` |
| WebAuthn PRF: the browser computes `SHA-256(UTF8("WebAuthn PRF") ‖ 0x00 ‖ callerSalt)` before passing the salt to the authenticator; output is 32 bytes; `first` and `second` salts may be evaluated in one ceremony; `prf` is the WebAuthn surface of CTAP2 `hmac-secret` | W3C WebAuthn Level 3, PRF extension; Yubico, *Developers Guide to PRF* |
| PRF platform support as summarised in §12.3, including Windows KB5077181, Chrome/Edge 147 PRF-on-create, Firefox 148, macOS 15 / iOS 18.4 via iCloud Keychain, no Firefox-on-Android PRF, and iOS not passing extension data to roaming authenticators | Corbado, *Passkeys & WebAuthn PRF for End-to-End Encryption (2026)*; Yubico PRF developer documentation. <!-- VERIFY before any release --> |
| X-Wing combines X25519 and ML-KEM-768 with SHA3-256 and is intended to be usable with HPKE; it is an Internet-Draft, not an RFC | `draft-connolly-cfrg-xwing-kem` |
| ChaCha20-Poly1305 is not yet universally available through the Web Cryptography API; AES-GCM is | W3C WebCrypto; the WebCrypto ChaCha20-Poly1305 request is open. <!-- VERIFY current per-browser status before relying on either statement. --> |
| age uses ChaCha20-Poly1305 with a zero nonce under a per-file derived key, and HKDF-SHA-256 — prior art for the D4 construction | age specification, `age-encryption.org/v1` |
| Crate versions in §15.1 | crates.io, retrieved 2026-07-28 |
| PFS: without it, Phase 2 keys derive from Phase 1 material and one compromised IKE SA secret unlocks every data key derived under it, including traffic recorded months ago | Owner's SRX IPsec field card, side 2 |
| `IkeGateway` example values (`address 203.0.113.10`, `external-interface reth0.0`, `version v2-only`, DPD `10 × 3`), `st0.0`, `host-inbound-traffic system-services ike` | Owner's SRX IPsec field card, sides 1 and 2 |
| Clock skew kills certificates — the trap this design deliberately does not have | Owner's SRX IPsec field card, side 4 |
| Metadata channels M1–M10, Padmé decision, batching cost, the residual scale, the extension threat, the RIPA note, the no-audit position | `docs/30-security/31-threat-model.md` |
| Envelope header carries `format_version` and `schema_version` outside the ciphertext, authenticated as AEAD associated data; preserve mode; capture blobs as separately-addressable chunks; merge resolution | `docs/10-core/11-ir-schema.md` §8.4, §8.6, §11.2, §11.4 |
| Rule-pack signing (Ed25519 / minisign, scoped trust store, no TOFU) | `docs/10-core/12-rule-engine.md` §13 |
| OPFS/IndexedDB availability under `file://` is unresolved | `docs/20-ai/24-ai-determinism-and-offline.md` §2.2 |

Claims not sourced above are design positions of this project and are argued in place.

---

## 21. Disagreements

Three, raised under the conventions' own procedure rather than acted on unilaterally.

### 21.1 "record" needs a definition in the conventions, not a workaround in every document

**The convention.** The terminology table says a graph element is a **node** or an **edge**, and
lists "record" among the words never to use for one.

**The objection.** The convention is right about graph elements and silent about everything else.
This document needs a word for *a unit of encryption in the workspace container*, which holds many
nodes and many edges and is not a graph element at all. "Chunk" collides with `11-ir-schema.md`
§8.4's capture chunking; "blob" collides with the sync store's blobs; "block" collides with Argon2's
1 KiB blocks, which appear in §4.6. "Record" is the natural word, it is what every comparable format
calls this, and forbidding it without providing a replacement means the next author will invent a
fourth term.

**Proposed addition** to the terminology table:

> | **record** | a unit of encryption in the workspace container; holds many nodes and edges | never a graph element — that is a node or an edge |

### 21.2 Invariant 4's "key" should say "secret key material"

**The convention.** *"The server never holds a key. Zero-knowledge. Ciphertext and metadata only."*

**The objection.** The sync service necessarily stores the member log, which contains members'
**public** X25519 and Ed25519 keys, and the keyholder table, which contains HPKE encapsulated keys.
Those are keys. They are also public by construction and their disclosure is exactly the M6-class
metadata `31` §7.2 already accounts for. As written, a careful reviewer can claim the invariant is
violated by a design that is doing precisely what zero-knowledge requires, and we would have to
argue our way out of a sentence we wrote.

**Proposed replacement:**

> **4. The server never holds secret key material.** Zero-knowledge. Ciphertext, public keys and
> metadata only. No passphrase, no derived key, no root key, no unwrapped workspace key, and no
> key-derivation input beyond the public salts carried in the clear inside authenticated headers.

### 21.3 Invariant 3, and `31` §14.1's proposed amendment, are both too narrow now

**The convention.** *"The application never accepts a credential. […] The one exception is the
workspace passphrase."* `31` §14.1 proposes widening it to exactly two secrets: the workspace
passphrase and, at tier 1, a provider API key.

**The objection.** This document adds four more secrets the application accepts or generates: a
printed recovery key, Shamir shares, member identity secret keys, and a WebAuthn PRF output. All
four are *workspace* key material, none of them is a device credential, and all of them are within
the spirit of the invariant. But under `31` §14.1's wording — "exactly two secrets exist in the
product […] No third secret may be added without amending this invariant" — this document would
require amending the invariant four more times, which turns a hard invariant into a changelog.

The invariant is really making two separate claims that have been welded together: *the application
never touches a network device's credential*, and *there is exactly one secret*. The first is a
permanent product boundary and is what makes the invariant valuable. The second was true when the
product had one keyholder and is not true of any design that supports sharing or recovery.

**Proposed replacement**, superseding both the current text and `31` §14.1:

> **3. The application never accepts a credential to a network device.** No PSKs, no certificates
> with private keys, no SNMP communities, no TACACS keys, no device passwords, no enable secrets,
> no RADIUS shared secrets. Emitted config uses placeholders and the engineer pastes the real value
> into their terminal. Parsed captures are redacted before storage, and the unredacted text never
> reaches the encryptor.
>
> The application does hold **workspace key material**: the passphrase, and optionally a recovery
> key, secret shares, a member identity key and a hardware-token-derived key. Every one of these is
> enumerated in `docs/30-security/32-cryptography.md` §3.4, none leaves the client, and none is ever
> transmitted in any form. Adding a category of workspace key material requires updating that table.
>
> Exactly one secret in the product is transmitted to a third party: at tier 1 only, a user-supplied
> inference provider API key, sent only to the enumerated provider origin the user configured.
> Adding a second transmitted secret requires amending this invariant.

The force of the invariant is preserved where it belongs — on device credentials and on egress —
and the part that was really a bookkeeping claim is moved to a table that can be maintained without
amending an invariant every time someone adds a keyholder.
