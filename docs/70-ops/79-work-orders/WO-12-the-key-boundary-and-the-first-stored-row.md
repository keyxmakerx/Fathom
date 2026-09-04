# WO-12 — The key boundary, and the first stored row

> **Status: OPEN. Depends on WO-11 (DONE, 2026-09-03).** The second server-side work order and
> the first row of customer data this project has ever stored.
> **Authored 2026-09-04.**
>
> **WHY THIS ORDER MAY PROCEED WITHOUT THE OWNER, when WO-11 §7 trigger 2 forbade exactly this.**
> That trigger said: *"Anything in this order turns out to require storing customer data … ADR-0040
> §9 items 1 and 2 leave the key-management service undecided … Storing a row before that is
> decided is the retrofit ADR-0040 exists to prevent. Stop."* It was right, and it is still right
> about the thing it was protecting. What has changed is that the undecided part has been read
> carefully and it is **not** a storage format:
>
> - ADR-0040 **D1–D4 already decided the architecture of custody** — a data key per tenant and per
>   design, wrapped by a master key, with the switch to a customer-supplied master key done by
>   **re-wrapping keys, never re-encrypting data**.
> - The open part is `OPEN-FOR-THE-OWNER.md` §A1, *which service holds the master key*. AWS KMS
>   wraps by RPC and returns an opaque `CiphertextBlob`; Vault Transit returns a versioned ASCII
>   string; a protected local file wraps locally. **All three are opaque bytes in one
>   provider-neutral column**, chosen by deployment configuration.
> - So the wrap point can be built, exercised and **proved movable** with every owner option still
>   open — which is precisely what WO-11's G8 stored nothing in order to protect.
>
> **AND ADR-0040 §9 ITEM 1'S OWN WORDS, QUOTED WHOLE RATHER THAN HALF**, because the argument above
> quotes only the *"undecided"* part of it. Item 1 reads, in full: *"Which key-management service.
> D1 requires one; naming it is a technology decision under `49` §6's dependency gate, and it
> interacts with self-hosted deployments that have no cloud KMS. **For planning, before the first
> migration.**"* This order writes that first migration. Three clauses, answered one at a time:
>
> - *naming it is a technology decision under `49` §6's dependency gate* — **honoured.** This order
>   names no service, adds no cloud SDK, and §7 triggers 1 and 9 stop the session if a gate needs one.
> - *it interacts with self-hosted deployments that have no cloud KMS* — **honoured, and narrowed.**
>   §4.4's file provider is scoped to development and test (§7 trigger 13); the shipped self-hosted
>   story is ADR-0040 §9 item 2's and this order does not pick it.
> - *before the first migration* — **NOT honoured, and this order does not pretend otherwise.** It
>   is a sequencing instruction to planning, it is the one thing here that genuinely needs a planning
>   ruling, and it is recorded as **Disagreements 5** and escalated in the PR body at §5 step 0
>   rather than argued away. If planning rules that item 1 must be answered before `0002` is written,
>   this order **stops after step 4** — the key module, the envelope, the file provider and the
>   registry, all built, nothing stored. That is a real stopping point, and it is why the migration
>   is step 5 and not step 1.
>
> **THE ORDER IS SHAPED BACKWARDS FROM ONE TEST**, and everything not needed to make that test
> honest is a named non-goal in §8:
>
> > Re-wrap a tenant's data key under a **second, differently-shaped provider**, and assert that
> > `design.wrapped_key` and `design_blob.sealed` are **byte-identical** before and after.
>
> **THIS ORDER SUPERSEDES WO-11 G8** (*"nothing is stored"*). That gate was a fence around an
> undecided question, not a permanent property. The test behind it is **repurposed, not deleted**:
> `tests/stores_nothing.rs` becomes `tests/stores_only_ciphertext.rs`, keeps its migration-reading
> machinery, and becomes a column census that fails on any column that is not an id, a timestamp,
> a version number, opaque ciphertext or opaque provider metadata. A gate that stops being useful
> is upgraded in the same commit that makes it obsolete, or it is quietly deleted six weeks later
> by somebody who does not know what it was for.

## 0. Contents

| § | |
|---|---|
| 1 | Objective |
| 2 | Binding sources |
| 3 | Prior state, verified against the tree on 2026-09-04 |
| 4 | Deliverables |
| 5 | The plan |
| 6 | Acceptance gates |
| 7 | Stop-and-escalate triggers |
| 8 | Non-goals |
| — | Failure modes · Open decisions · Sources consulted · Disagreements |

## 1. Objective

**Build the wrap point, store one design behind it, and prove the wrap point can be moved to a
different key holder later without touching a byte of customer ciphertext.**

The second half is the objective. The first half is ordinary work.

ADR-0040 D1 requires *"a data key per tenant and per design … from the first stored byte"* and
its §7 states the reason in one line: *"Retrofitting a key boundary means re-encrypting everything
already held."* D2 requires that the destination — a customer-supplied master key — be reachable
by *"a re-wrap of data keys, never a re-encryption of data."*

Those two sentences are cheap to write and are proved by exactly one thing: a test that moves
custody and then compares bytes. This order exists to make that test real, run it, and record what
it printed.

**The hierarchy that makes the switch cheap**, and it is the whole design in four lines:

```
master key (held by a PROVIDER chosen by deployment config)
  └─ wraps ─▶ tenant data key        ← one row per tenant per wrapping. THE ONLY THING A PROVIDER TOUCHES.
       └─ seals ─▶ design data key   ← one row per design
            └─ seals ─▶ design blob  ← the customer's data, one opaque blob the server never parses
```

A provider call happens **once per tenant**. So a custody change rewrites one row per tenant and
the design data is never re-encrypted. Every key that is reused — master, tenant, design —
encrypts nothing but 32 uniformly random bytes inside a fixed-shape header; the only thing that
ever seals customer plaintext is a **per-seal derived subkey** that exists for one seal and is
never reused. That property is stated as a design invariant in §4.3 and gated in G15, because it
is what bounds the worst failure this design cannot otherwise prevent.

## 2. Binding sources

| source | what it binds here |
|---|---|
| **ADR-0040** D1 | envelope encryption from the first stored byte; a data key per tenant **and** per design |
| **ADR-0040** D2, D3 | the custody switch is a re-wrap, never a re-encrypt; its destination is customer-managed keys and its trigger is the first customer who is not the owner |
| **ADR-0040** D4 | deleting a tenant is destroying a key — and its second half, that this word may not be stretched to cover removing a *person* |
| **ADR-0040** D7 | no exact secret length is ever persisted, **by type and not by convention** |
| **ADR-0040** §7, §9 items 1 and 2 | what must stay true; and that the key-management service is **undecided**, including for self-hosted deployments with no cloud KMS |
| **ADR-0040** §6 | the four sentences that may never be written, enforced by `scripts/forbidden-claims.sh` |
| **WO-11** §6, §8, §9 | the house style, the gate set, the as-built discipline, and G8 which this order supersedes |
| **WO-11** §9.7 | the crate-cap escalation, already raised and still the owner's |
| `49` §7 | the typed-graph storage design this order deliberately does **not** build, and does not foreclose |
| `49` §11 | multi-tenancy and row-level security — the four PostgreSQL rules, and why `tenant_id` goes on every table **now** even though RLS is a non-goal |
| `49` §19 | phase 1's ordering, which this order disagrees with — see Disagreements 1 |
| `49` §22 decisions 1 and 2 | closed: the server holds the keys; tenancy lives outside the graph |
| `70` §18.2 | the owner's words: organisations, users and designs are ordinary server tables, not schema kinds |
| `32` §5.2, §5.3, §5.4, §5.6 | the AEAD, the derivation, the nonce argument and the key-commitment tag. **`32` owns the scheme and this order changes none of it** |
| `32` §5.4's rule table | all three rules, not two: the platform CSPRNG per seal, **the startup sanity check** (§4.1, G15) and the 10⁶-salt CI test |
| `32` §6.4 and `31` §7.6 | **Padmé padding on the total envelope length, and the flat 512-byte floor below it.** Both are DECISIONS already taken, not options, and §4.1 applies them to `FSL1` |
| `32` §7.1, §7.2 | the workspace envelope's fixed 112-byte header, its `header_len` field, and its field-by-field AAD argument. **`FSL1` in §4.1 is a SECOND envelope, narrower and server-side, and this order specifies it** — see Disagreements 6, which is where that admission belongs rather than in a claim that nothing new is specified |
| **ADR-0041** (2026-09-03) | a hand-typed value that looks like a credential is **marked, never refused**, and is stored and exported exactly as typed. The first `design_blob` this order stores may therefore hold a device password the ingest gate never saw — §8's last row, and it is a scope statement, not a defect |
| `deps/decisions/chacha20poly1305.md`, `argon2.md` | two crates already owner-approved on 2026-08-15, neither vendored — §5 step 0 |
| `deps/decisions/00-CLOSURE.md`, `00-CLOSURE-SERVER.md` | the closure pattern: a crate Fathom **names in a manifest** always needs its own record |
| `35` §5.1 C1–C5 and **§5.2** | the caps, and §5.2's DECISION that **C3 — distinct publishing identities, ≤ 25 — is the primary metric**. G2 measures C3, C4 and C5, not only C1 and C2 |
| `OPEN-FOR-THE-OWNER.md` §A, §B | what is genuinely undecided. **This order decides none of it** — §7 carries a trigger per question |
| `.context/conventions.md` | the invariants; invariant 4 is **scoped** by ADR-0040 and invariant 3 is **scoped** by ADR-0041 — see the note below |
| `78` §5 items 2 and 7, §7, §8 | the execution protocol governing this order, including the two clauses this order is in tension with and says so: §5 item 2 (no dependency, ever) against §5 item 7's verbatim-manifest exception, and §7's judgment-shaped column against §4.1's envelope |

**Invariant 3, stated correctly, because §8's shape depends on it.** An earlier draft of this row
read *"invariant 3 is untouched and stays true"*. That was false on the day it was written.
ADR-0041 (2026-09-03) annotated invariant 3 in `.context/conventions.md` **scope-only**: the
redaction it promises is the **ingest gate's**, and the gate has exactly one caller, `OP_PASTE`. A
credential typed by hand into any of the schema's nineteen free-text `notes`/`description` fields
never goes near it, is **marked** with a `!` and is **stored and exported exactly as typed** — that
is ADR-0041's decision, not a bug it left open. So the honest sentence for this order is:

> **The first `design_blob` this order stores may contain a device credential, and the server holds
> the key that opens it.** What stays true — and it is the sentence ADR-0040 §6 leaves standing — is
> that **a device credential is protected by never arriving**, which covers everything the gate saw
> and nothing a person typed.

Nothing in this order widens that gap and nothing here closes it. It is restated in §8 as a named
non-goal so that no later reader takes the blob's opacity for a claim about its contents.

## 3. Prior state, verified against the tree on 2026-09-04

- **`crates/fathom-server` exists and stores nothing.** Six modules — `config.rs`, `secret.rs`,
  `db.rs`, `health.rs`, `healthcheck.rs`, `migrate.rs` — plus `main.rs`, `lib.rs` and two test
  files. One migration, `0001_migrations_table.sql`, creating `_fathom_migrations` and nothing
  else.
- **`Cargo.lock` holds 132 packages: 17 first-party and 115 external.** Six direct dependencies,
  all in `crates/fathom-server/Cargo.toml`: `tokio` 1.53.1, `axum` 0.8.9, `tracing` 0.1.44,
  `tracing-subscriber` 0.3.23, `tokio-postgres` 0.7.18, `deadpool-postgres` 0.14.2. The workspace
  dependency table is empty, so nothing can arrive by `workspace = true`.
- **Eight crates this order needs are already in the lockfile as transitive dependencies**, and
  their exact versions decide §5 step 1's whole shape: `chacha20` 0.10.2, `crypto-common` 0.2.2,
  `digest` 0.11.3, `block-buffer` 0.12.1, `hybrid-array` 0.4.14, `hmac` 0.13.0, `sha2` 0.11.0,
  `cpufeatures` 0.3.1. Also present: `getrandom` 0.4.3, `ctutils` 0.4.2, `cmov` 0.5.4,
  `async-trait` 0.1.92, `rand` 0.10.2. **`subtle` is not present** — see §5 step 1's finding.
- **`deps/decisions/` holds thirteen files.** `chacha20poly1305.md` and `argon2.md` are
  **owner-approved 2026-08-15 and neither crate is vendored**; both records name a version from an
  older RustCrypto generation (`0.10` and `0.5` respectively).
- **`deny.toml`**: `yanked = "deny"`, `multiple-versions = "deny"`, four `[[bans.skip]]` entries
  each naming an exact version with a reason, a source allowlist and the four C-carrier bans.
- **`tests/stores_nothing.rs`** reads every file in `migrations/` and fails if any creates a table
  other than `_fathom_migrations`. It is WO-11 G8 as a test, and this order rewrites it.
- **`scripts/forbidden-claims.sh`** exists and is in the floor — ADR-0040 §6 made mechanical.
- **The verification floor in `78` §6 is sixteen rows**, not the thirteen CLAUDE.md's *Verify
  before you trust* section states; `forbidden-claims.sh` and its test were added after that line
  was written. **DO NOT EDIT CLAUDE.md.** An earlier draft of this bullet instructed exactly that,
  as a factual correction under `78` §8, and it was wrong twice over: `78` §5 item 7 lists CLAUDE.md
  among the paths that *"admit no work-order exception — a work order instructing such an edit is
  **malformed** under §8: escalate it, do not execute it"*, and §8's Correction clause governs *"a
  factual defect in **the work order it is executing**"*, not another document. **What to do
  instead:** record the thirteen-versus-sixteen discrepancy in the PR body as a one-line escalation
  to planning, naming both numbers and the two rows that moved, and leave the edit to planning. Do
  not treat the discrepancy as a finding against this order's own gates.
- **`OPEN-FOR-THE-OWNER.md` §A1 states a constraint this order breaks, and that page IS correctable
  here.** Its preamble reads *"Nothing can be saved on the server until A1 is answered"* and its
  *Why it cannot wait* line reads *"changing this after data is stored means unlocking and
  re-locking everything already held"*. The first is falsified by this order and the second is
  falsified by ADR-0040 D2, which is the whole reason this order may proceed: a custody change is a
  **re-wrap of keys, never a re-encryption of data**, proved by G7 and G8(b). `OPEN-FOR-THE-OWNER.md`
  is an ordinary document in `docs/70-ops/` — **not** one of `78` §5 item 7's protected paths — so
  **correct those two sentences in this order's PR**, narrowly: change no option, no trade and no
  question in §A1's table, say instead that rows are now stored behind a movable wrap point and that
  what A1 still decides is who holds the master key and what a stolen server costs. Record old → new
  in this order's Disagreements section. A page built to be the owner's single source of truth must
  not keep stating a constraint the code has stopped honouring.
- **792 tests. The wasm module is 988,490 bytes**, and this order must leave it byte-identical.

## 4. Deliverables

### 4.1 The key module — `crates/fathom-server/src/keys/`

**`keys/mod.rs`** — the types and the one unwrap path.

```rust
/// 32 bytes of data key. No Clone, no Copy, no PartialEq, no Display, no
/// serialisation — a key cannot be copied into a log-friendly structure by
/// accident, which is `secret.rs`'s reasoning applied to key material.
pub struct DataKey([u8; DATA_KEY_LEN]);          // DATA_KEY_LEN = 32
impl DataKey {
    /// Straight from the platform CSPRNG, per key. `32` §5.4's rule, verbatim:
    /// "no userspace PRNG, ever." Hence `getrandom::fill`, never `rand::rng()`.
    pub fn generate() -> Result<Self, EntropyError>;
    pub(crate) fn expose(&self) -> &[u8; DATA_KEY_LEN];   // crate-private on purpose
}
impl Drop for DataKey { /* zeroize */ }
impl core::fmt::Debug for DataKey { /* writes secret::REDACTED and nothing else */ }

/// `32` §5.4's rule table has THREE rules and an earlier draft of this order
/// carried two. This is the third: draw 64 bytes at startup and refuse to start
/// on all-zero, on a repeat of the previous draw, and on a value equal to the
/// one persisted by the previous session at `FATHOM_ENTROPY_PROBE_FILE` (mode
/// 0600 beside the key file; it is a witness, not a secret). It is built here
/// because this order is adding a boot check anyway (§5 step 8), so the marginal
/// cost is a file read. `32` states its limit in the same table and this order
/// repeats it rather than overselling: it catches GROSS failure — a stubbed RNG,
/// a `Math.random` polyfill, a cloned container image — and **no in-application
/// check catches subtle failure**. G15 drives all three refusals.
pub fn csprng_startup_check(previous: Option<&[u8; 64]>) -> Result<[u8; 64], EntropyError>;

/// What a wrapped key is bound to. Deliberately NOT the provider name and NOT
/// the master key id: binding to either would make a custody switch a
/// re-encryption, which is the retrofit ADR-0040 D2 exists to prevent.
pub struct WrapAad {
    pub purpose: Purpose,          // TenantKey | DesignKey | DesignBlob | MasterKeyProbe
    /// `None` FOR `Purpose::MasterKeyProbe` AND ONLY FOR IT. The probe (§4.2)
    /// belongs to the deployment and not to a tenant — the same reason it is the
    /// one table with no `tenant_id`. Without this, the probe row stores an
    /// `aad_version` for which no `WrapAad` can be constructed, and §5 step 8's
    /// boot check and G12's sixth refusal can only be built by calling
    /// `provider.unwrap()` directly, which breaks the single-unwrap-path
    /// invariant this section's last paragraph claims. Encoded with a one-byte
    /// present/absent discriminant, so an absent tenant is never confusable with
    /// a tenant whose id encodes to zero bytes.
    pub tenant_id: Option<TenantId>,
    pub design_id: Option<DesignId>,
    pub key_epoch: KeyEpoch,
    pub aad_version: AadVersion,   // 1
}
impl WrapAad {
    /// Canonical, fixed field order, fixed width. NEVER STORED AS A COLUMN:
    /// recomputed on every open from the row's own identifying fields —
    /// `tenant_id`, `design_id`, `key_epoch`, `purpose` — and compared against
    /// the copy recovered from INSIDE the wrapped plaintext, which is what makes
    /// a row swap fail instead of succeed. It is deliberately NOT recomputed from
    /// `wrapping_id`: a wrapping id is which wrapping, not which key, and two
    /// wrappings of one key must produce the identical AAD or a custody switch
    /// becomes a re-encryption.
    pub fn encode(&self) -> Vec<u8>;
    /// The same fields as key/value pairs, for a provider that HAS an
    /// associated-data channel (AWS KMS encryption context, Vault associated
    /// data). Belt to `encode()`'s braces; never the only binding.
    pub fn as_context(&self) -> Vec<(&'static str, String)>;
}

/// Provider-neutral opaque bytes, as stored in `tenant_key.wrapped`. Fathom
/// NEVER parses these.
pub struct WrappedKey(Vec<u8>);

/// The master-key holder. WHICH one is undecided (ADR-0040 §9 items 1 and 2;
/// OPEN-FOR-THE-OWNER §A1) and this order does not decide it. This trait is the
/// shape every answer fits; deployment configuration picks the impl.
///
/// ASYNC FROM THE FIRST LINE, ON PURPOSE. The file provider does not need it. A
/// cloud KMS wrap is a network round trip, and making the trait sync now means
/// rewriting every call site — and the store's transaction boundaries — the day
/// one is chosen. It is the cheapest insurance in this order.
#[async_trait::async_trait]
pub trait MasterKeyProvider: Send + Sync + 'static {
    /// The name written into `tenant_key.wrap_provider`. Data, never dispatch.
    fn name(&self) -> &'static str;
    /// Which master key NEW wraps use, and — with `name()` — HALF OF THE LOOKUP
    /// KEY. A registry is keyed on the PAIR `(wrap_provider, wrap_key_id)`, never
    /// on the provider name alone: G7's midpoint deliberately holds two live
    /// `file` rows differing only in `wrap_key_id`, so a registry that dispatched
    /// on the name would open one of them with the other's key and report a
    /// generic refusal. An ARN, a Vault transit key name, or a key file's
    /// declared id. Opaque to Fathom, and not a secret.
    fn wrap_key_id(&self) -> &str;

    /// CONTRACT, AND IT IS THE ONE CLAUSE A PROVIDER MAY NOT SATISFY LOOSELY:
    /// **the wrapped plaintext is `aad.encode() || key.expose()`, in that order,
    /// with the 32 key bytes last.** The binding lives INSIDE the sealed bytes.
    /// A provider that also has an associated-data channel (KMS encryption
    /// context, Vault associated data) passes `aad.as_context()` through it **as
    /// well and never instead** — belt to the braces, per `WrapAad::as_context`.
    async fn wrap(&self, aad: &WrapAad, key: &DataKey) -> Result<WrappedKey, WrapError>;

    /// RETURNS THE RECOVERED AAD BYTES ALONGSIDE THE KEY, never a bare key.
    /// `expected` is passed in because a context-channel provider needs it at
    /// decrypt time (KMS `Decrypt` takes the encryption context); the returned
    /// bytes are what was actually found INSIDE the plaintext, and comparing the
    /// two is `unwrap_and_check`'s job, not a provider's — a provider does not
    /// know which row it was handed. **Before this signature existed,
    /// `unwrap_and_check` was handed nothing to compare**, so a swapped row
    /// failed the Poly1305 tag, was indistinguishable from a wrong master key,
    /// and `WrapError::Misbound` — which G10(b) requires by name — was
    /// unreachable.
    async fn unwrap(&self, expected: &WrapAad, wrapped: &WrappedKey)
        -> Result<(WrapAadBytes, DataKey), WrapError>;
}

/// NO VARIANT CARRIES A STRING FROM A PROVIDER. `config.rs`'s ConfigError set the
/// precedent — "no variant carries a value read from the environment" — and a KMS
/// error body is worse: it can echo an ARN, a request id, and in the wrong SDK a
/// plaintext length. `&'static str` only.
pub enum WrapError {
    Unavailable(&'static str),  // file missing, KMS unreachable, token expired
    Refused(&'static str),      // wrong key, corrupt ciphertext, denied by policy
    Misbound,                   // opened, and the AAD RECOVERED FROM INSIDE the plaintext
                                // is not this row's — reachable only because `unwrap`
                                // returns it. G10(b)
    Malformed,                  // opened, and the plaintext is not `aad_bytes || 32 bytes`
    UnknownProvider,            // no provider configured for this row's (provider, key_id)
    KeyDestroyed,               // D4 happened. Distinct from every error above, on purpose
}

/// One stored wrapping, whatever table it came from. `impl From<&TenantKeyRow>`
/// and `impl From<&MasterKeyProbeRow>`.
pub struct Wrapping<'a> {
    pub wrap_provider: &'a str,
    pub wrap_key_id:   &'a str,
    pub wrapped:       &'a WrappedKey,
    pub aad_version:   AadVersion,
}

/// THE ONLY UNWRAP PATH. No caller outside this function holds a
/// `&dyn MasterKeyProvider`, so a provider cannot skip the binding check.
///
/// TAKES A `Wrapping`, NOT A `&TenantKeyRow`. The probe row is not a tenant key
/// and must go through this path too, or the sentence above is false the day
/// §5 step 8's boot check is written.
///
/// It does exactly three things and the middle one is the point:
///   1. `registry.get(w.wrap_provider, w.wrap_key_id)` — THE PAIR, never the
///      name alone — or `UnknownProvider`;
///   2. `provider.unwrap(expected, w.wrapped)`, then compare the RETURNED aad
///      bytes against `expected.encode()` in constant time (`ctutils::CtEq`).
///      Unequal is `Misbound`, and it is a different error from the provider's
///      own `Refused`;
///   3. refuse with `KeyDestroyed` if `tenant.key_destroyed_at` is set.
pub async fn unwrap_and_check(
    registry: &ProviderRegistry,
    wrapping: &Wrapping<'_>,
    expected: &WrapAad,
) -> Result<DataKey, WrapError>;
```

**`keys/seal.rs`** — the `FSL1` envelope. `32` §5.3 owns the *scheme* and this changes none of it;
the *framing* is narrower than `32` §7.1's 112-byte workspace header and is specified here, which is
Disagreements 6 and not a claim that nothing new is written. One construction, three uses: the file
provider's own output, the design key sealed under the tenant key, and the blob sealed under the
design key.

```
FSL1 seal envelope — 56-byte header, then ciphertext and tag
  0    4   magic        b"FSL1"
  4    1   suite        0x01 = HKDF-SHA-256 / ChaCha20-Poly1305 / zero nonce / 128-bit commitment
  5    1   aad_version  0x01
  6    2   header_len   u16 little-endian = 56, and it MUST equal the header width the
                        suite byte names. Present for the reason `32` §7.1's is present:
                        "so a future suite may extend the header without breaking the
                        length arithmetic". It REPLACES the `reserved` field an earlier
                        draft of this order carried, which could not do that job — a
                        reader that does not know suite 0x02 cannot skip a header of
                        unknown width, so without this field the suite byte does NOT make
                        a second construction additive.
  8   32   salt         CSPRNG, per seal
 40   16   commit       K_cmt
 56    n   ciphertext || Poly1305 tag

plaintext framing — `32` §6.4's, unchanged:
  pt      = u32_le(body_len) || body || zero padding
  total   = header_len + 4 + body_len + pad + 16
          = max(512, padme(header_len + 4 + body_len + 16))       32 §6.4, 31 §7.6

body — and THIS is the clause that makes WrapError::Misbound reachable:
  a KEY seal    body = aad.encode() || key            32 key bytes last
  a BLOB seal   body = the design blob

PRK            = HKDF-Extract(salt, ikm = key)                        RFC 5869 §2.2, SHA-256
K_enc || K_cmt = HKDF-Expand(PRK, info, 48)                           RFC 5869 §2.3
info           = b"fathom/server/seal/v1" || header[0..8] || aad_bytes
nonce          = twelve zero bytes                                    32 §5.3 option B
ct             = AEAD_CHACHA20_POLY1305(K_enc, nonce, aad_bytes, pt)  RFC 8439 §2.8
```

**The AAD is sealed inside the plaintext as well as authenticated as associated data, and the
distinction is the whole of G10(b).** An earlier draft put `aad_bytes` only in the KDF `info` and
the AEAD associated data and sealed the bare 32-byte key. Under that construction a swapped row
does not *open misbound* — it fails the Poly1305 tag, identically to a wrong master key — so
`Misbound` was unreachable and `unwrap_and_check` had nothing to compare. Sealing
`aad.encode() || key` and returning the recovered AAD from `unwrap` (§4.1's trait) is what lets the
single unwrap path perform the check the Failure-modes table stakes the no-row-swap property on.

The suite byte at offset 4, **together with `header_len` at offset 6**, is what makes a second
construction additive rather than a migration. `K_cmt` is compared in constant time
(`ctutils::CtEq`) and, per ADR-0014 as cited by `32` §5.6, the AEAD open runs regardless and the
code branches on the **pair** of results — so *wrong key*, *tampered ciphertext* and *mutated
commitment tag* stay distinguishable and none is a partitioning oracle.

**PADDING IS NOT OPTIONAL AND AN EARLIER DRAFT OF THIS ORDER DROPPED IT.** ChaCha20 is a stream
cipher, so with no padding `len(ciphertext) == len(plaintext)` exactly, and
`SELECT design_id, octet_length(sealed) FROM design_blob` is the **exact byte length of every
customer design, stored, indexed and rewritten on every save** — a length oracle *"readable by
anyone with database access"*, which is the wording of ADR-0040 D7's own rationale. Neither G5's
`INTEGER_COLUMNS` rule nor G11's source-reading properties can see it, because the leaking value is
a `bytea`'s own length and no integer column or `usize` parameter exists anywhere. `32` §6.4 and
`31` §7.6 had already decided the fix and this order applies it verbatim rather than re-deciding it:

- **Padmé** (Nikitin et al., PoPETs 2019(4)) on the **total envelope length**, `32` §6.4's `padme()`
  reproduced byte for byte and pinned by a unit test against the values in `32` §6.4's own listing.
- **A flat 512-byte floor below 512 bytes**, `32` §6.4's second addition. Every key seal is
  therefore exactly **512 bytes** — `header_len 56 + 4 + 32 + pad + 16` floors to 512 — which is
  what replaces the `104` an earlier draft wrote into §4.2's CHECK constraints.
- The residual is stated where `32` §6.5 states it and is not upgraded here: **total ciphertext
  size, to a Padmé bucket**, and nothing finer.

```rust
pub const MAX_PLAINTEXT_LEN: usize = 32 * 1024 * 1024;   // the DoS bound, §7 trigger 10
/// The STORED length of a seal of `MAX_PLAINTEXT_LEN`, and the literal the
/// migration's CHECK carries. NOT the same number as MAX_PLAINTEXT_LEN: they
/// differ by the header, the length prefix, the tag and the padding, which is
/// exactly the off-by-72 an earlier draft shipped. Computed by the same `const
/// fn` the sealer uses, never typed:
///     seal_len(n) = max(512, padme(56 + 4 + n + 16))
/// so seal_len(32 MiB) = padme(33_554_508) = 34_603_008. G15 asserts the SQL
/// literal in `0002_the_key_boundary.sql` equals this constant, so the two can
/// never drift and a plaintext at the accepted maximum can never be refused by
/// the database instead of by the type.
pub const MAX_SEALED_LEN: usize = seal_len(MAX_PLAINTEXT_LEN);
pub const KEY_SEAL_LEN: usize = 512;                     // seal_len of any key body
```

**`keys/file_provider.rs`**, **`keys/registry.rs`**, **`keys/custody.rs`** — §4.4, §4.5, §4.6.

### 4.2 Migration `0002_the_key_boundary.sql` — five tables, 27 columns, no free text

Every column is an id, a timestamp, a version number, opaque ciphertext, or opaque provider
metadata. **There is no name, label, slug, domain, contact or plan anywhere.**

**Given as exact SQL and not as prose.** An earlier draft wrote constraints as `CHECK (~ ULID
shape)` and `CHECK (…)`, which two executors would write two ways — and G5's census reads the
migration *text*, so a prose placeholder is a gate reading a guess. This is the migration:

```sql
-- 49 §11's four rules, quoted in this file because they bind what may be added
-- to it later: (1) ALTER TABLE … FORCE ROW LEVEL SECURITY on every tenant table;
-- (2) the application role is not a superuser, does not own these tables and does
-- not have BYPASSRLS; (3) set the tenant at pool checkout with SET LOCAL, never
-- plain SET, if a transaction-mode pooler is in front; (4) scope every uniqueness
-- constraint to (tenant_id, …), NEVER globally — which is why every primary key
-- below leads with tenant_id. RLS itself is a non-goal of WO-12 (§8).
-- 78 §7 / B2: the `file` master-key provider puts the key on this machine, so an
-- operator with this database and this filesystem CAN read a customer's design.
-- That is OPEN-FOR-THE-OWNER §B2 and it is stated here rather than implied.

CREATE TABLE tenant (
  tenant_id        text        NOT NULL,
  key_epoch        integer     NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  key_destroyed_at timestamptz NULL,
  PRIMARY KEY (tenant_id),
  CONSTRAINT tenant_id_is_ulid       CHECK (tenant_id ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  CONSTRAINT tenant_epoch_positive   CHECK (key_epoch > 0)
);

CREATE TABLE tenant_key (
  wrapping_id   text        NOT NULL,
  tenant_id     text        NOT NULL,
  key_epoch     integer     NOT NULL,
  wrap_provider text        NOT NULL,
  wrap_key_id   text        NOT NULL,
  wrapped       bytea       NOT NULL,
  aad_version   smallint    NOT NULL,
  wrapped_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, wrapping_id),
  FOREIGN KEY (tenant_id) REFERENCES tenant (tenant_id),
  CONSTRAINT tk_wrapping_id_is_ulid  CHECK (wrapping_id ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  CONSTRAINT tk_provider_shape       CHECK (wrap_provider ~ '^[a-z][a-z0-9-]{1,31}$'),
  CONSTRAINT tk_key_id_len           CHECK (char_length(wrap_key_id) BETWEEN 1 AND 512),
  CONSTRAINT tk_wrapped_len          CHECK (octet_length(wrapped) BETWEEN 32 AND 6144),
  CONSTRAINT tk_epoch_positive       CHECK (key_epoch > 0),
  CONSTRAINT tk_aad_version_positive CHECK (aad_version > 0)
);
-- NOT UNIQUE, and §4.2's note below says why in six lines.
CREATE INDEX tenant_key_by_wrapping
  ON tenant_key (tenant_id, key_epoch, wrap_provider, wrap_key_id);

CREATE TABLE design (
  tenant_id   text        NOT NULL,
  design_id   text        NOT NULL,
  key_epoch   integer     NOT NULL,
  wrapped_key bytea       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, design_id),
  FOREIGN KEY (tenant_id) REFERENCES tenant (tenant_id),
  CONSTRAINT d_id_is_ulid       CHECK (design_id ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  CONSTRAINT d_epoch_positive   CHECK (key_epoch > 0),
  CONSTRAINT d_wrapped_key_len  CHECK (octet_length(wrapped_key) BETWEEN 512 AND 2048)
);

CREATE TABLE design_blob (
  tenant_id  text        NOT NULL,
  design_id  text        NOT NULL,
  sealed     bytea       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, design_id),
  FOREIGN KEY (tenant_id, design_id) REFERENCES design (tenant_id, design_id),
  -- 34603008 = keys::seal::MAX_SEALED_LEN = seal_len(32 MiB). G15 asserts this
  -- literal equals that constant. It is NOT 33554432: a plaintext at the accepted
  -- maximum seals larger by the header, the length prefix, the tag and the padding,
  -- and an earlier draft's 33554432 refused that plaintext in the database rather
  -- than through the named error.
  CONSTRAINT db_sealed_len CHECK (octet_length(sealed) BETWEEN 512 AND 34603008)
);

CREATE TABLE master_key_probe (
  wrapping_id   text        NOT NULL,
  wrap_provider text        NOT NULL,
  wrap_key_id   text        NOT NULL,
  wrapped       bytea       NOT NULL,
  aad_version   smallint    NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (wrapping_id),
  CONSTRAINT mp_wrapping_id_is_ulid  CHECK (wrapping_id ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  CONSTRAINT mp_provider_shape       CHECK (wrap_provider ~ '^[a-z][a-z0-9-]{1,31}$'),
  CONSTRAINT mp_key_id_len           CHECK (char_length(wrap_key_id) BETWEEN 1 AND 512),
  CONSTRAINT mp_wrapped_len          CHECK (octet_length(wrapped) BETWEEN 32 AND 6144),
  CONSTRAINT mp_aad_version_positive CHECK (aad_version > 0)
);
CREATE INDEX master_key_probe_by_wrapping ON master_key_probe (wrap_provider, wrap_key_id);
```

| table | why it is shaped this way |
|---|---|
| **`tenant`** | The tenant's existence, which data key epoch is current, and its D4 tombstone. **A display name is customer data and would be the first plaintext column**; it is not stored here, and when it is, it is sealed or excepted in writing. No natural key at all, which also sidesteps `49` §11 rule 4's covert channel — a *"that name is taken"* error naming a tenant you may not see |
| **`tenant_key`** | **The opaque `wrapping_id` is the most important line in this migration**, and it replaces the four-part `(tenant_id, key_epoch, wrap_provider, wrap_key_id)` primary key an earlier draft called by that name. What it buys is the same thing: ONE data key carrying SEVERAL wrappings at once, so rotation, escrow and D2's custody switch collapse into one additive operation — INSERT the new wrapping, verify it by unwrapping, DELETE the old. What the four-part key could not survive is in the note below. It is the only table a provider ever touches and the only one a custody switch rewrites |
| **`design`** | The design key, sealed under the **tenant** key, so a provider is called once per tenant and not once per design. `key_epoch` names which tenant epoch sealed it, so a later tenant-key rotation is detectable rather than a silent failure. **Deliberately absent**: the design's name, owner, share list, schema version, device count. **512** is `KEY_SEAL_LEN` — the padded FSL1 length of any key body, per §4.1's flat floor — and it replaces the `104` an unpadded draft carried; the range rather than an equality is what keeps a second suite additive |
| **`design_blob`** | The whole of what this order stores as customer data: one opaque blob per design, which **the server never parses**. `49` §7's node/edge/field/provenance tables and the generated projections are a later order's, and nothing here depends on the blob's contents, so nothing here forecloses them. 32 MiB of plaintext is a denial-of-service bound with a stop-and-escalate behind it (§7 trigger 10), not a format assumption. Its floor is 512 and not 72 because every seal is padded (§4.1) |
| **`master_key_probe`** | 32 wrapped random bytes whose plaintext is stored nowhere, so there is no known-plaintext pair. It lets the server answer *"is this the right key file?"* **at boot** and refuse to start, rather than starting and failing every request — the honest reading of *"a process that starts is a process a load balancer calls healthy"*. It carries the **same opaque `wrapping_id`** as `tenant_key` and for the same reason, plus one of its own: §4.6's fourth custody operation re-wraps it, and two probe wrappings must be able to coexist for the same provider and key id while that happens. **This is the one table with no `tenant_id`**, because it belongs to the deployment and not to a tenant; the census (G5) carries it as a named exception with that reason, not a silent one |

**Why the four-part primary key had to go, and it is a provider fact rather than a preference.**
Both of `OPEN-FOR-THE-OWNER.md` §A1's non-file options rotate **in place**, keeping the identifier
`wrap_key_id` stores:

- **Vault Transit** — the ciphertext prefix `vault:v1:` is the *key version*. Rotation creates `v2`
  under the **same key name**, and `transit/rewrap` re-encrypts to the latest version;
  `min_decryption_version` is the documented rotation policy and it makes old-version ciphertext
  undecryptable, so re-wrapping is not optional.
- **AWS KMS** — rotation *"changes only the current key material"* and the key id/ARN is unchanged;
  `ReEncrypt` re-encrypts under the new backing key for the same KMS key. For imported material
  (`EXTERNAL` origin — which is the customer-managed-key destination ADR-0040 D2 names), on-demand
  rotation is documented as rotating material *"without changing the key identifier (key ID or
  ARN)"*, and expired or deleted material makes ciphertext unusable, so a proactive re-wrap under
  the same ARN is mandatory.

Either way the second wrapping has the same `tenant_id`, the same `key_epoch`, the same
`wrap_provider` and the same `wrap_key_id` — and collides on a four-part primary key. Every escape
is closed by this order's own text: `key_epoch` is a `WrapAad` field, so bumping it is a different
binding and would invalidate every `design.wrapped_key` sealed under the old epoch; and parsing
`vault:v2:` out of the ciphertext to synthesise a distinct id contradicts §4.1's *"Fathom NEVER
parses these"*. So the four-part key would have been `ALTER`ed on stored rows the day either option
was chosen, and the verify-before-drop window it exists to create would have degraded to the
destructive `UPDATE` it exists to prevent. **That is precisely a stored-format migration forced by
a later provider choice, which is the thing this order exists to avoid.** The opaque id costs 26
bytes a row and the old tuple survives as a **non-unique index**, which is all it was ever used for.

**Why `6144` and not `4096`.** AWS KMS's `Decrypt` API constrains `CiphertextBlob` to **1–6144
bytes** (`API_Decrypt`, read 2026-09-04). A CHECK constraint is stored DDL, so a bound below a
provider's own documented maximum is an `ALTER TABLE` on a live table the day that provider is
chosen. `4096` in an earlier draft carried no derivation at all; this one does.

**Why every primary key leads with `tenant_id`.** `49` §11 rule 4, quoted in the migration and
binding here: *"scope every uniqueness constraint to `(tenant_id, …)`, never globally"*, because
*"referential integrity checks, such as unique or primary key constraints and foreign key
references, always bypass row security"*. An earlier draft gave `design` and `design_blob` a global
`design_id PRIMARY KEY` and gave `design_blob` no composite foreign key, so a `(tenant, design)`
pair could be stored mismatched and §8's claim that row-level security *"stays free later"* was
false. Composite now costs nothing; composite later is an `ALTER` of stored primary and foreign
keys. `tenant_id` is on every tenant-scoped table even where a join would reach it, for the same
reason.

### 4.3 The design invariant that bounds the worst case

> **Every key that is reused encrypts nothing but 32 uniformly random bytes. The only key that
> ever seals customer plaintext is a per-seal derived subkey, used once.**

The master key wraps a tenant key; the tenant key seals a design key; the design key seals the
blob — but every seal derives `K_enc` from a fresh 32-byte CSPRNG salt, so the key that actually
touches customer bytes is unique to that seal. What this buys, stated plainly because it is the
one failure this design cannot otherwise prevent: **if the CSPRNG is replayed** (`32` §5.4 case 5
— a restored VM snapshot, a cloned container image, a fresh-boot entropy failure), the collision
that results reveals the XOR of two unknown random keys and a forgery capability over key wraps,
rather than a customer's map. Residual: `material` for the wraps, and the scheme provides no
in-application detection — `32` §5.4 says so and this order does not claim better.

### 4.4 The first provider — `file`, FOR DEVELOPMENT AND TEST, and not the shipped answer

**Scope first, because an earlier draft of this heading read *"and it is the shipped product for one
kind of customer"* and that sentence picks one of the three options ADR-0040 §9 item 2 explicitly
reserves for planning** — *"a local key file with documented custody, an HSM, or a Vault
instance"* — which is also the second half of `OPEN-FOR-THE-OWNER.md` §A1. §7 trigger 1 does not
catch it, because trigger 1 only fires on **naming AWS, Google, Azure or Vault**; choosing the file
slips underneath it. So:

> **The `file` provider built here is a development and test provider.** It exists to make the wrap
> point real, exercised and provably movable. Whether a key file is what a self-hosted customer
> actually gets — against an HSM or a Vault instance — is ADR-0040 §9 item 2 and it stays open.
> **`deploy/README.md` says exactly that, in a paragraph headed *not yet the self-hosted answer*,
> above the custody procedure**, and no document in this PR describes it as shipped, supported or
> recommended. §7 trigger 13 fires the moment a step needs it to be more than that.

Selected by `FATHOM_MASTER_KEY_PROVIDER=file`, reading `FATHOM_MASTER_KEY_FILE`. It is the one
built first because it is the only one that survives **whichever way `OPEN-FOR-THE-OWNER.md` §B1
lands** — a machine with no cloud connection can still run it — and because a hosted deployment
needs something to run against before a KMS account exists. That is an argument for building it
first, and it is not an argument for shipping it.

The file — three lines, ASCII, no parser worth the name:

```
fathom-master-key v1
id  01K9Z8QW4E5R6T7Y8U9I0P1A2B
key 3f7c…                       (64 lowercase hex characters = 32 bytes)
```

The id is a ULID and becomes `tenant_key.wrap_key_id`, so a row says which key file opens it after
a switch. Hex rather than base64 on purpose: a hex decoder is twenty lines of first-party code and
no dependency, and the `base64` already in the lockfile is `postgres-protocol`'s, not ours.

**The named files, so no executor has to invent one** (`78` §4's first trigger is a session needing
a file name the Deliverables section does not list):

| what | path |
|---|---|
| fixture key file K1 | `crates/fathom-server/tests/fixtures/master-key-K1.txt` |
| fixture key file K2, for G7's switch | `crates/fathom-server/tests/fixtures/master-key-K2.txt` |
| fixture plaintext, G4's and G6's design | `crates/fathom-server/tests/fixtures/one-design.blob` |
| the constant that refuses a fixture key **by value** (G12) | `keys::file_provider::FIXTURE_KEY_DIGESTS` — a compiled-in array of the SHA-256 digests of the fixture keys' 32 bytes, compared in constant time. **A digest and not the keys themselves**, so refusing a copy-pasted example does not put the example's key material in the release binary |

**What the operator must do, and it is the whole custody story for this provider** — it goes in
`deploy/README.md` in these words, under the *not yet the self-hosted answer* heading above:

1. **Generate the file yourself.** `fathom-server` does not generate one and does not create one
   if it is missing: a server that invents a master key on startup is a server that silently
   encrypts a customer's data under a key nobody backed up. The order ships the exact command,
   using the operating system's own CSPRNG.
2. **`chmod 0400`, owned by the user the server runs as.** The server **refuses to start** if
   `st_mode & 0o077 != 0`, naming the path and the octal mode it found. `std::os::unix::fs::PermissionsExt`,
   no crate.
3. **Mount it read-only into `43` §5.4's container as a file, never an environment variable** — an
   env var is visible in `/proc/<pid>/environ`, in a `docker inspect`, and in every crash dump
   that captures the environment.
4. **Back it up somewhere that is not the database backup, and know that losing it loses every
   tenant.**

**What it is not.** The key sits on the same machine as the database credentials and the process
that reads them. A stolen server or a stolen disk image is a full compromise of every tenant on
it — which is exactly the trade the third row of `OPEN-FOR-THE-OWNER.md` §A1's table already puts
to the owner, unchanged and undecided by this order. What the file provider buys today is not
defence against that attacker; it is that the wrap point exists, is exercised, and is provably
movable.

### 4.5 The registry, and the second provider that lives only in tests

**`keys/registry.rs`** is a map keyed on the **pair** `(wrap_provider, wrap_key_id)` — never on the
provider name alone. `ProviderRegistry::get(name, key_id)` returns the provider that can open *that
wrapping*, or `UnknownProvider`. This is not tidiness: **G7's midpoint deliberately holds two live
`file` rows differing only in `wrap_key_id`**, and a registry that dispatched on `"file"` would hand
K2's row to K1's provider and report a generic refusal, which is the failure G7's negative control
is written to catch and would instead have caused. `unwrap_and_check` (§4.1) and G8(c) both name the
pair. It has two constructors and the split is the point:

- `ProviderRegistry::from_deployment_config(&Config)` — an **exhaustive match over built-in
  provider names**, which in this build contains exactly one arm, `"file"`. This is the only
  constructor `main.rs` calls. An unset `FATHOM_MASTER_KEY_PROVIDER` is a refusal (no default —
  the same reasoning `config.rs` already applies to `DATABASE_URL`), and an unknown name is a
  refusal whose message **names what is built**, so an operator who typed `aws-kms` learns it is
  not implemented rather than reading a stack trace.
- `ProviderRegistry::from_providers(Vec<Box<dyn MasterKeyProvider>>)` — composes an arbitrary set.
  Tests use it; a future deployment running two providers during a rolling switch uses it too.

**`tests/support/mock_provider.rs`** is the second provider, and it is **deliberately trivial and
deliberately different in shape**:

- its output is an ASCII string, `mock:v1:<hex>`, not a binary envelope — the shape Vault Transit
  returns, and nothing like the file provider's `FSL1` bytes;
- its `wrap_key_id` is a URN-like string with colons and slashes, not a ULID — the shape an AWS key
  ARN has;
- it sleeps a few milliseconds inside `wrap` and `unwrap`, so the trait's async-ness is actually
  exercised rather than merely declared.

It lives in `tests/`, which **cannot see `#[cfg(test)]` items in the library**, so there is no
route by which a release binary reaches it — and G8 proves that by asserting
`from_deployment_config` with `FATHOM_MASTER_KEY_PROVIDER=mock` returns `UnknownProvider`.

### 4.6 Custody — `keys/custody.rs`, four operations and no more

| operation | what it does | what it proves |
|---|---|---|
| `add_wrapping(tenant, from: WrappingId, to_provider)` | unwraps the tenant key under the named wrapping and INSERTs a second row, with a **fresh `wrapping_id`**, wrapping the **same** key under the new provider | the switch has a verify-before-drop window: both wrappings are live at once |
| `drop_wrapping(tenant, wrapping_id)` | DELETEs **one wrapping, addressed by its opaque id**, refusing if it is the last one for a tenant that is not being destroyed | the switch completes without a moment in which the tenant has no readable key |
| `rewrap_probe(provider, key_id)` | INSERTs a second `master_key_probe` wrapping of the **same** 32 probe bytes under the provider's current key material, verifies it opens, then DELETEs the old one | that a routine provider-side rotation does not brick the server |
| `destroy_tenant_key(tenant)` | DELETEs **every** `tenant_key` row for the tenant and sets `tenant.key_destroyed_at`, in one transaction | D4. The ciphertext is deliberately left in place, which is what makes G9 a proof rather than a demonstration |

**`drop_wrapping` addresses a wrapping by its opaque id and not by `(provider, key_id)`**, because
after §4.2's primary-key change two rows can share a provider and a key id — which is the exact
situation a Vault version advance or a KMS imported-material rotation produces.

**`rewrap_probe` exists because §5 step 8 verifies the probe on EVERY start and G12's sixth refusal
makes a failure fatal.** Without it, an ordinary provider-side rotation of key *material* — Vault
advancing `min_decryption_version` past the probe's version, KMS rotating imported material —
leaves the probe unopenable and the server permanently refusing to boot, with no operation in this
order to repair it. A boot check with no repair path is an outage generator, not a control. It is
the fourth operation and there is no fifth.

**`add_wrapping` + `drop_wrapping` is the rolling custody switch, escrow, and key rotation — one
mechanism, three names.** Escrow is not built here; it is the same INSERT, and saying so now is
free.

**What `add_wrapping` does NOT use, recorded rather than left to be discovered.** It unwraps to a
plaintext key **in server memory** and re-wraps. Both realistic §A1 providers offer a primitive that
avoids exactly that — `kms:ReEncrypt` and `transit/rewrap` re-encrypt ciphertext from one key to
another **without returning the plaintext** — and neither is reachable through
`MasterKeyProvider` as declared. This order does not add a `rewrap()` method, and the reasoning is
the reasoning §4.1 gives *against* itself on async: adding a method later changes the trait for
every implementation, so the foresight argument that bought async should be answered here too
rather than ignored. It is answered **no**, on three grounds, and the answer is recorded in §8 so
the next order can overturn it cheaply:

1. A `rewrap()` a file provider cannot implement without doing exactly what `add_wrapping` already
   does is a method with one honest implementation and one stub — and the stub is the default that
   a KMS provider would silently inherit.
2. Its whole benefit is *how long a plaintext key lives in process memory*, which touches
   `OPEN-FOR-THE-OWNER.md` §B2 and §B3 and is the same decision §8 defers on the key cache.
3. It is additive when it arrives: a defaulted trait method whose default is today's
   unwrap-and-re-wrap changes no stored byte and no call site. **That is not true of the primary
   key it would have collided with**, which is why §4.2's change is made now and this one is not.

### 4.6.1 What a `DELETE` does not do, and D4's real boundary

**A PostgreSQL `DELETE` does not remove the tuple.** It marks it dead; the row image stays on the
heap page until `VACUUM`, the page is not overwritten even then, the full row image is written to
the WAL, and the WAL is shipped to every streaming replica and every PITR archive and stays there
until it is recycled. So immediately after `destroy_tenant_key`, **the wrapped tenant key is still
physically present** — in `$PGDATA`, in `pg_wal/`, on every replica, and in every base backup and
archive that covers the moment before the delete.

This is not a defect in D4 and it is not a reason to weaken it; it is D4's boundary, and NIST SP
800-88's cryptographic erase is valid *"on the assumption that every copy of the key is destroyed"*
— the same sentence this order's Sources table already quotes. What is new here is that an earlier
draft's G9 proved the boundary with a **logical `pg_dump`**, which reads live tuples only and so
cannot see the survivor at all: the check passed *because* it was blind to the thing it was
supposed to bound. G9 now carries a **physical** check as well, and the honest claim this order
makes is:

> `destroy_tenant_key` makes the tenant's designs unreadable **through the application and through
> a logical dump**. It does not scrub the key from the heap, the WAL, a replica or a backup, and
> until vacuum and WAL recycling have both run, the key is recoverable by anyone with filesystem
> access to the database or to its archives. Bounding *that* is a backup and retention regime,
> which is `OPEN-FOR-THE-OWNER.md` §B3 and §7 trigger 4.

### 4.7 The rest

- **`store.rs`** — the only module in the crate permitted to name a SQL verb (G11(ii)).
- **`examples/write_one_design.rs`** and **`examples/read_one_design.rs`** — two separate
  processes for G6. Examples and not `src/bin`, so `deploy/Dockerfile`'s `--bin fathom-server`
  cannot ship them.
- **`tests/stores_only_ciphertext.rs`** — WO-11's `stores_nothing.rs`, repurposed (G5).
- **`tests/seal_vectors.rs`** — RFC known-answer tests, in `cargo test --workspace` so they are in
  CI and need no database (G14).
- **`tests/provider_boundary.rs`** — the second provider round-trip (G8).
- **`deps/decisions/`** — **six** new individual records, not seven: the seven crates that become
  direct are `zeroize`, `hkdf`, `chacha20poly1305`, `sha2`, `getrandom`, `ctutils` and
  `async-trait`, and **`chacha20poly1305.md` already exists**, so it is an **amendment** and the
  other six are new. Plus `00-CLOSURE-SERVER.md` regenerated. **The `chacha20poly1305.md` amendment
  is two edits, not one**: §5 step 1's version measurement, *and* striking its
  **`| Ships or tooling | Ships. Linked into fathom-wasm |`** row, which G1 now exists to make
  false — the crate is linked into `fathom-server` only, and a record claiming otherwise is the
  same class of stale-by-one-commit claim WO-11 §9 found in `tracing.md`.
- **Two evidence scripts** in `docs/80-review/evidence/`, named here so no executor invents a
  filename, with only the date moving:
  - `<YYYY-MM-DD>-two-processes-write-and-read-one-sealed-design.sh` (G4, G6, G12)
  - `<YYYY-MM-DD>-the-custody-switch-does-not-touch-the-ciphertext.sh` (G7, G8, G9, G10, G13)

  Each prints an **exact check count** that the script asserts on, so a skipped check fails instead
  of reporting green.

## 5. The plan

One commit per step. **The floor is re-run on every step**, and every step after step 1 also runs
the five dependency layers.

**Step 0 — RE-READ EVERY VERSION, AND NAME THE TWO APPROVED CRATES. No code.**

WO-11 §7 trigger 1's pattern, unchanged: *"Re-read every one from crates.io and from the RustSec
database before pinning it, name the source and the date."* The versions in step 1 were read on
**2026-09-04** from `index.crates.io` and `static.crates.io`, and the advisory check was made
against a local `RustSec/advisory-db` clone at commit **5a0ebedf, 2026-09-02** — which is already
stale by the time you read this. **Re-clone the advisory database and re-read every version before
pinning.** A version that has moved, been yanked, or acquired an advisory since is §7 trigger 8.

Then name the two crates whose approval this order draws on, so the executor knows exactly what is
delegated and what is not:

**And put two escalations in the PR body before writing any code**, both of them things this order
may not itself fix (`78` §5 item 7): the CLAUDE.md floor-count discrepancy from §3, and ADR-0040 §9
item 1's *"before the first migration"* sequencing from the header block and Disagreements 5.

- **`deps/decisions/chacha20poly1305.md`** — owner-approved 2026-08-15, `0.10`,
  `default-features = false`, never vendored. This order takes **0.11.0** and step 1 carries the
  measurement that decides it. The record is **amended, not silently overridden in the manifest**,
  and the amendment has **two parts**: the version measurement, and **striking the record's
  `Ships. Linked into fathom-wasm` line**. That line was true of the artifact the record was written
  for and is false of this build — the crate is linked into `fathom-server` and **G1 exists to keep
  it out of `fathom-wasm`** — so leaving it would put a claim in `deps/` that a gate in this same PR
  is designed to falsify.
- **`deps/decisions/argon2.md`** — owner-approved 2026-08-15, `0.5`, never vendored. **It is NOT
  used by this order.** Its approval stays banked for the sign-in order, where OWASP's server-side
  parameters (`49` §12) get their own decision; `argon2.md` already says the file-key floor and a
  server-side login hash must not share a number. Said here so that *"argon2 is approved"* is not
  read as *"argon2 belongs in this order."*

**Step 1 — the crates, one at a time, gate exercised on every arrival.**

**FIRST, THE AUTHORITY, BECAUSE WITHOUT IT THIS STEP IS A STOP TRIGGER AND NOT A STEP.** `78` §5
item 2 reads *"Never adds a dependency: no crate … A work order that seems to need one is an
escalation, always"*, and `78` §2's table says the same in the other direction. Taken alone, an
executor's correct first act here is to stop. Three things resolve it and all three are named rather
than assumed:

1. **`78` §5 item 7's own exception, which is the clause that actually governs a manifest edit:**
   *"a work order may give the exact `Cargo.toml` edit verbatim (a new crate's manifest lines, a new
   workspace member) together with the `Cargo.lock` change that edit produces."* An order that gives
   the lines verbatim is the case §5 item 7 contemplates. This step now gives them verbatim, which
   an earlier draft did not — it gave crates and versions in prose, so the executor would have
   invented the feature set on which the whole 115 → 123 measurement depends.
2. **The owner's lift of ADR-0032 §5, 2026-09-03** — *"Oh no you can use borrowed code"* — with the
   instruction to build the automated control instead, which is WO-11's five-layer gate.
3. **WO-11's precedent**: an execution session added six direct dependencies under that gate on
   2026-09-03, and every one of the five layers found something on a real arrival.
   
**`78` §5 item 2 and §2's table row are nonetheless still written as absolutes, and this order does
not amend them** — `78` is one of §5 item 7's protected paths and a work order instructing an edit
to it would be malformed. The tension between item 2 and item 7 is **escalated in the PR body as a
planning item**, alongside step 0's other two. If planning rules that item 2's absolute wins over
item 7's exception, this step is an escalation and the order stops here.

**The exact manifest edit, verbatim.** Append to `[dependencies]` in
`crates/fathom-server/Cargo.toml`, in this order and one commit each:

```toml
zeroize           = { version = "1.9.0",  default-features = false }
hkdf              = { version = "0.13.0", default-features = false }
chacha20poly1305  = { version = "0.11.0", default-features = false, features = ["alloc", "zeroize"] }
sha2              = { version = "0.11.0", default-features = false }
getrandom         = { version = "0.4.3",  default-features = false }
ctutils           = { version = "0.4.2",  default-features = false }
async-trait       = { version = "0.1.92" }
```

`default-features = false` on every crate that has features, because that is the condition
`deps/decisions/chacha20poly1305.md` was **approved** under (*"`0.10`, `default-features = false`"*)
and because this project's own recorded lesson is that **a feature disabled in your manifest is a
request, not a guarantee** — `tracing.md`'s "deliberately OFF" was false within one commit through
feature unification (WO-11 §9). So after **every** arrival, verify the resolved feature set with
`cargo tree -e features -p <crate>` and record it, rather than trusting the line above. `zeroize` is
requested explicitly as well as through `chacha20poly1305`'s optional feature, so the key types in
§4.1 can zeroize without depending on another crate's feature choice. `async-trait` has no default
features to turn off.

Order: `zeroize`, `hkdf`, `chacha20poly1305`, then the four already-resolved crates promoted to
direct (`sha2`, `getrandom`, `ctutils`, `async-trait`). After each: `cargo tree`, regenerate the
closure document, run gate-zero, `cargo deny`, `cargo audit`, the look-alike check and the
cooldown, and commit. **Do not add them all and reconcile afterwards** — WO-11 §5 step 3's rule,
and it is what found four young crates last time.

**The measurement that decides the version, and it is this order's one real supply-chain
finding.** Read from `index.crates.io` on 2026-09-04:

| | `chacha20poly1305` **0.11.0** | `chacha20poly1305` 0.10.1 (the record's line) |
|---|---|---|
| declared deps | `aead ^0.6`, `chacha20 ^0.10`, `cipher ^0.5`, `poly1305 ^0.9`, optional `zeroize ^1.8` | `aead ^0.5`, `chacha20 ^0.9`, `cipher ^0.4`, `poly1305 ^0.8`, `zeroize ^1.5` |
| against the tree | **the same RustCrypto generation already resolved** — `chacha20` 0.10.2, `crypto-common` 0.2.2, `hybrid-array` 0.4.14, `cpufeatures` 0.3.1 are all present and reused | a **second, older generation beside the current one**: `chacha20` 0.9 beside 0.10.2, and an older `crypto-common`/`generic-array` line |
| cost under `multiple-versions = "deny"` | none | **several permanent `[[bans.skip]]` entries**, each naming an exact version with a written reason |

Honouring the record's letter would add more packages **and** permanent duplicate-version skips
than honouring its intent. `deny.toml`'s `multiple-versions = "deny"` is not relaxed to accommodate
either choice — WO-11 §9.1's rule.

**The eight new packages, every fact read 2026-09-04**, publication dates from `static.crates.io`
`Last-Modified` (the same figure `scripts/crate-cooldown.sh` gates on) and advisories checked
against the 5a0ebedf clone:

| crate | version | published | direct? | adds | advisories |
|---|---|---|---|---|---|
| `chacha20poly1305` | 0.11.0 | 2026-06-28 | direct | itself | none |
| `zeroize` | 1.9.0 | 2026-06-28 | direct | itself | none. **1.8.0 is YANKED** — verified on the index; `deny.toml`'s `yanked = "deny"` is the mechanical check that a resolver landing there fails |
| `hkdf` | 0.13.0 | 2026-06-28 | direct | itself; needs `hmac ^0.13`, present at 0.13.0 | none |
| `aead` | 0.6.1 | 2026-06-28 | transitive | itself; needs `crypto-common ^0.2` and `inout ^0.2.2` | none |
| `cipher` | 0.5.2 | 2026-06-28 | transitive | itself. **0.5.0 is yanked**; 0.5.2 is not | none |
| `poly1305` | 0.9.1 | 2026-07-08 | transitive | itself; needs `cpufeatures ^0.3`, present at 0.3.1 | none |
| `inout` | 0.2.2 | 2026-06-28 | transitive | itself; needs `hybrid-array ^0.4`, present at 0.4.14. **0.2.0 is yanked** | none |
| `universal-hash` | 0.6.1 | 2026-06-28 | transitive | itself | none. **AND THE ONE TO WATCH: 0.6.1 depends on `ctutils ^0.4`, which is already in the tree; 0.6.0 depends on `subtle ^2.4`, which is not.** A resolver landing on 0.6.0 adds a ninth package. If it does, that is a closure-document row and a `deps/decisions/subtle.md`, not a shrug |

All eight are well past `scripts/crate-cooldown.sh`'s seven-day window as of 2026-09-04, so no
exception is needed and none may be added.

**Four crates already in the lockfile become DIRECT and therefore need their own records** (the
closure pattern: a crate Fathom **names in a manifest** always needs one), adding **zero**
packages: `sha2` 0.11.0 — the digest `Hkdf<Sha256>` is generic over; RUSTSEC-2021-0100 (AVX2
miscomputation) is patched at `>= 0.9.8`, far below. `getrandom` 0.4.3 — `getrandom::fill` for
every key and every salt, chosen over `rand` because `32` §5.4 forbids a userspace PRNG in the key
path *in those words*. `ctutils` 0.4.2 — `CtEq::ct_eq` for the commitment tag and the AAD
comparison; chosen over `subtle` because it is already compiled, and used at all because `32` §15
forbids hand-rolling and a byte fold the compiler may short-circuit is a hedge, not a guarantee.
`async-trait` 0.1.92 — already a proc macro in this build, so no **new** compile-time code
execution; the alternative is a hand-written `Pin<Box<dyn Future + Send>>` signature, which is six
lines and no record, and either is defensible.

**MEASURED TOTAL: 115 → 123 external packages** (C2, cap ≤ 160) and **6 → 13 direct** (C1, cap
≤ 30). Zero new duplicate pairs, and `deny.toml` needs no new `[[bans.skip]]`.

**AND C3, WHICH `35` §5.2 CALLS THE COUNT THAT ACTUALLY MATTERS AND AN EARLIER DRAFT DID NOT
MEASURE.** C3 is **distinct publishing identities, ≤ 25**, and §5.2's DECISION makes it the primary
dependency metric precisely for a case like this one: *"The RustCrypto organisation publishes
`sha2`, `digest`, `block-buffer`, `crypto-common`, `hybrid-array`, `cipher`, `aead`,
`universal-hash`, `poly1305`, `argon2`, `password-hash`, `hkdf`, `chacha20`, `chacha20poly1305` and
more. That is a dozen-plus crates and **one** compromise scenario."* Eight arriving crates are
therefore **not obviously neutral to C3 and not obviously bad for it** — the design session's
reading is that `chacha20poly1305`, `hkdf`, `aead`, `cipher`, `poly1305`, `inout` and
`universal-hash` are all RustCrypto, an identity already in the closure via `sha2`/`digest`, and
that `zeroize` (RustCrypto), `getrandom` (rust-lang) and `async-trait` (dtolnay) are likewise
already-present identities — so the expected C3 delta is **zero**. **That is a prediction, not a
measurement, and G2 is what settles it.** State the four numbers with their caps and their pass
conditions:

| | cap | expected | pass condition |
|---|---|---|---|
| C1 direct | ≤ 30 | 13 | at or under cap |
| C2 closure | ≤ 160 | 123 | at or under cap |
| **C3 publishing identities** | **≤ 25** | **unchanged from WO-11's number** | at or under cap **and** any increase named crate by crate in the as-built note |
| C4 crates with `build.rs` | ≤ 12 | unchanged | at or under cap; an increase is named and reasoned |
| C5 proc-macro crates | ≤ 10 | unchanged (`async-trait` is already in the build) | at or under cap; an increase is named and reasoned |

**Re-measure rather than quoting any of these**; the numbers here are what the design session
resolved and G2 is what counts. An earlier draft asked the executor to *"state the build-script
count and proc-macro count"* with no expected value and no threshold, which is a gate any number
passes.

**Step 2 — `keys/seal.rs` and the RFC vectors. No database, no provider, no SQL.**

Implement `32` §5.3's construction exactly, **change nothing about the scheme**, and apply `32`
§6.4's padding and flat 512-byte floor — the framing is `FSL1`'s and is new, which is Disagreements
6 and not a thing to discover here. Write the vector tests
first: RFC 8439 §2.8.2's `AEAD_CHACHA20_POLY1305` vector and RFC 5869 Appendix A.1–A.3's
HKDF-SHA-256 vectors. **Read the expected bytes out of the RFC text, not out of this order and not
out of memory** — ADR-0034 applies to a test vector exactly as it applies to a claim. This is
`argon2.md`'s condition of approval generalised: an unaudited or newly-bumped implementation of a
*specified* algorithm is a much smaller risk than one of an unspecified algorithm, because the
specification comes with known-answer tests.

**Step 3 — `keys/mod.rs`.** `DataKey`, `WrapAad`, `WrappedKey`, `WrapError`, the trait,
`unwrap_and_check`. No provider, no SQL. `Drop`, `Debug` and the crate-private `expose` land here
or they never land.

**Step 4 — the file provider and the registry, with every refusal driven** (G12 less the probe).

**Step 5 — migration `0002` and the census** (G5). No writes yet: the migration and the test that
polices it arrive together, and the two watched-to-fail fixtures are written and watched to fail
**before** the census implementation exists — WO-11 §9.6's G2 discipline.

**Step 6 — `store.rs` and the write/read path.** G11's source rule is enforced from the first line
rather than retrofitted: if a SQL verb appears in a second module, the test that says so is already
in the tree.

**Step 7 — the two examples and the first evidence script** (G4, G6). The script prints and asserts
an exact check count.

**Step 8 — `keys/custody.rs`, the probe row, and the boot check.** All **four** operations —
`add_wrapping`, `drop_wrapping`, `rewrap_probe`, `destroy_tenant_key`; `master_key_probe` written on
first start and verified on every start, with the refusal naming `rewrap_probe` as the repair; and
`32` §5.4's startup CSPRNG sanity check (§4.1) in the same boot path, since it is a boot check
either way. **A boot check that can refuse to start ships with the operation that repairs it, in
the same step**, or the first provider-side key rotation is an outage with no documented fix.

**Step 9 — the mock provider and the provider-boundary tests** (G8). This is the step the order
exists for; if anything earlier has made it awkward, that is a finding about the earlier step.

**Step 10 — the misbinding gates, the log gate, and the second evidence script** (G7, G9, G10,
G13). The misbinding gates edit **real rows in SQL**, not fixtures in Rust.

**Step 11 — the floor, the measured numbers, the as-built note, the index status.** Record the
closure's real size against `35` §5.1 C1–C5, re-run the WASM build **forced** and record the byte
count read off the run, and write §9 in WO-11's shape: what the gates caught on real arrivals, what
was corrected, and what was deliberately not done. **The `00-INDEX.md` row is NOT added here — it
already exists**, added by the planning session that authored this order, because `78` §3 defines
queue order by the index and an order absent from it cannot be dispatched at all; an index that
disagrees with the work-order files is itself a `78` §4 escalation trigger. What step 11 does to the
index is flip this order's status from OPEN to DONE, per `78` §8's *Status* clause, in this PR.

## 6. Acceptance gates

Every gate below is falsifiable, and every safety gate names the thing that must be **watched to
fail** before it is believed — CLAUDE.md rule 0, and WO-11 §6 G2/G3's shape.

* **G1 — THE FLOOR, AND THE CLIENT IS UNTOUCHED.** `78` §6's rows green, including the five
  dependency layers on real arrivals. The WASM module must be **byte-identical to 988,490 after a
  forced rebuild**, and the number is read off the `artifact_gates` run, never quoted from a
  document (the ceiling was removed on 2026-08-21; `artifact_gates` **reports** the size, so the
  comparison against 988,490 is this gate's own act and not the harness's).
  **Watched to fail, named exactly** — an earlier draft said *"adding `chacha20poly1305` to any
  crate other than `fathom-server`"*, and both halves of that were false: six workspace crates
  (`fathom-artifact`, `fathom-canon`, `fathom-emit`, `fathom-schema`, `fathom-schemagen`,
  `fathom-workspace`) are outside `fathom-wasm`'s dependency tree so nothing would change at all,
  and a pure-Rust crate adds **no wasm import**, so `IMPORT_ALLOWLIST` could never fire. The scratch
  commit is:
  - **the crate:** `crates/fathom-graph/Cargo.toml` — one of `fathom-wasm`'s nine path dependencies,
    so the code is genuinely linked into the module;
  - **the change:** add `chacha20poly1305 = { version = "0.11.0", default-features = false,
    features = ["alloc"] }` **and one `pub fn` in `fathom-graph` that actually calls it**, reached
    from a `fathom-wasm` opcode arm — an unused dependency is dead-stripped and proves nothing;
  - **the expected failure, precisely:** the `artifact_gates` run **reports a module size that is
    not 988,490**, and this gate fails on that comparison. **`IMPORT_ALLOWLIST` stays empty and does
    NOT fire**, because pure-Rust ChaCha20-Poly1305 imports nothing from the host — it would fire
    only if `getrandom`'s `wasm_js` backend came with it, which is a different scratch commit and
    not this one. Record both observations, then revert.

  This is the gate that proves cryptography did not leak across the fork, and it proves it by size,
  not by imports.

* **G2 — THE CLOSURE, MEASURED AND NOT TYPED.** `deps/decisions/00-CLOSURE-SERVER.md` regenerated
  by `scripts/closure-report.sh --write` from `cargo metadata`. State **five** numbers against
  `35` §5.1, each with its cap and its pass condition, per §5 step 1's table: C1 direct (≤ 30),
  C2 closure (≤ 160), **C3 distinct publishing identities (≤ 25)**, C4 crates with a `build.rs`
  (≤ 12) and C5 proc-macro crates (≤ 10). **C3 is not optional and is not last**: `35` §5.2's
  DECISION makes it *"the primary dependency metric"*, and seven of the eight arriving crates are
  RustCrypto — one publisher, one compromise scenario — so this is exactly the case §5.2 was
  written about. An earlier draft measured only C1 and C2 and asked for C4 and C5 as bare counts
  with no threshold, which any number passes. **A cap exceeded is §7 trigger 11 and never a
  judgement call**; an increase within cap is named crate by crate in the as-built note.
  `cargo deny check` green with **no new `[[bans.skip]]`**. **Watched to fail:** pin
  `chacha20poly1305` to 0.10 on a scratch
  branch, record `cargo deny` naming the duplicate pairs, revert. The refusal to take the approved
  record's literal version number has to be a **measurement in the as-built note**, not an
  assertion in this order.

* **G3 — GATE-ZERO STILL BITES ON A CRATE FATHOM CHOSE.** Each of the seven direct dependencies has
  its own `deps/decisions/<crate>.md` — **six written new and `chacha20poly1305.md` amended**, per
  §4.7 — and the five new transitive ones are carried by the closure document. The amendment
  includes striking that record's `Ships. Linked into fathom-wasm` line, which G1 in this same PR
  exists to make false. **Watched to fail:** delete `deps/decisions/hkdf.md` and require gate-zero
  to fail **naming `hkdf` specifically**, not a generic count; restore.

* **G4 — THE CANARY IS IN THE DESIGN AND NOWHERE IN THE DATABASE.** Seal
  `crates/fathom-server/tests/fixtures/one-design.blob`, whose contents include
  `FATHOM-CANARY-<32 hex from getrandom>`, store it, then `pg_dump --data-only` the
  entire database and assert **zero** occurrences of the canary and of the fixture's other
  plaintext words. **POSITIVE CONTROL IN THE SAME RUN, and the gate is worthless without it:**
  create a scratch table, insert the same canary as text, dump again, assert the grep **finds** it,
  drop the table. A grep that cannot find a canary it was pointed at proves nothing about the
  canary it did not find.

* **G5 — THE COLUMN CENSUS.** `tests/stores_only_ciphertext.rs` reads every file in `migrations/`
  and requires every column of every table to appear in an explicit
  `(table, column, sql_type, role)` allowlist, `role ∈ {id, timestamp, version, ciphertext,
  provider-metadata}`. Two further rules: every table except `_fathom_migrations` and
  `master_key_probe` must carry `tenant_id` (the exceptions named with their reasons in the test
  itself); and **any column of an integer type must additionally appear in an explicit
  `INTEGER_COLUMNS` list carrying a written reason**. **Watched to fail, twice, with both fixtures
  kept in the tree:** a migration adding `display_name text` fails as an unallowed role, and one
  adding `secret_len integer` fails **by type** before anyone has to notice its name.

* **G6 — A FRESH PROCESS READS WHAT A PREVIOUS PROCESS WROTE.** Two separate processes against a
  real PostgreSQL: `write_one_design` creates a tenant, a design, both data keys and one sealed
  blob from `tests/fixtures/one-design.blob`; `read_one_design` starts cold, takes the ids **from
  the database** (never from the writer), and opens the blob to byte-identity with the same fixture.
  **Watched to fail:** run the reader with `FATHOM_MASTER_KEY_FILE` pointing at
  `tests/fixtures/master-key-K2.txt` — a *different master key*, same row — and require
  `WrapError::Refused`: not a panic, not a partial read, and **not `Misbound`**. That distinction is
  the gate. Under §4.1's construction a wrong master key changes `K_enc`/`K_cmt`, so the envelope
  never opens and the AAD inside is never recovered — `Refused`. A **swapped row** opens under the
  right master key and yields the *wrong* AAD — `Misbound`, G10(b). The two are different events
  reached by different paths, and an implementation that collapses them into one error fails **both**
  gates. **They were the same event in an earlier draft** of this order, in which the AAD lived only
  in the associated data and `Misbound` was unreachable; §4.1's *"the wrapped plaintext is
  `aad.encode() || key`"* is what separates them. **A silently skipped database test is a
  pass wearing a disguise**, so both binaries print a RAN marker, the evidence script asserts the
  marker appears, and the script asserts an **exact check count** so a check that quietly stops
  running changes the count and fails.

* **G7 — THE CUSTODY SWITCH, PROVED BY BYTES.** Record `design.wrapped_key` and
  `design_blob.sealed` exactly. Run the switch `file:K1 → file:K2` as `add_wrapping(tenant, from:
  W1, to_provider: file@K2)` then `drop_wrapping(tenant, W1)` — **both wrappings addressed by their
  opaque `wrapping_id`**, which is what lets two live rows differ only in `wrap_key_id`. Assert, in
  this order: at the midpoint **both wrappings exist and each opens the blob independently**, proved
  by building a registry containing one `(provider, key_id)` pair at a time and requiring the other
  row to come back `UnknownProvider` rather than `Refused`;
  `tenant_key` now names K2; **`design.wrapped_key` is BYTE-IDENTICAL**; **`design_blob.sealed` is
  BYTE-IDENTICAL**; exactly one row was written and one deleted; the blob still opens with **K1
  deleted from disk**. **Then the negative control that makes it a gate rather than a demo:**
  restore the pre-switch `tenant_key` row with K1 still gone and require the read to **fail**.
  Without that last step the test cannot distinguish a real custody move from a switch that left a
  dependency on the old key behind.

* **G8 — THE PROVIDER BOUNDARY, ROUND-TRIPPED BY A SECOND PROVIDER.** This is the gate the whole
  order is shaped around and G7 alone does not reach it: G7 is the same implementation with two key
  files, which is key rotation, not a provider boundary. Four parts:
  **(a)** with a registry holding the `mock` provider, wrap a tenant key and store it — into the
  **same columns**, with **no migration and no DDL**; a `SELECT` on `migrations/` before and after
  is identical.
  **(b)** a **cross-provider custody switch**: `file:K1 → mock`, then `mock → file:K2`, asserting at
  every step that `design.wrapped_key` and `design_blob.sealed` are byte-identical and that only
  `tenant_key` rows changed. The mock's output shape (`mock:v1:<hex>` ASCII) and its `wrap_key_id`
  shape (URN-like, not a ULID) are deliberately unlike the file provider's, so a hidden assumption
  about either fails here rather than the day a real KMS is chosen.
  **(c)** dispatch on the **row's own `(wrap_provider, wrap_key_id)` PAIR**, never on the provider
  name alone (§4.5): a registry holding both providers reads a `file`-wrapped row and a
  `mock`-wrapped row in the same transaction; a registry holding only one returns `UnknownProvider`
  for the other's row and **never falls back to the configured provider**; and — the part the name
  alone cannot do — **a registry holding `file:K1` returns `UnknownProvider` for a `file:K2` row**
  rather than handing it to K1's provider and reporting a generic refusal. That third case is
  exactly G7's midpoint, where two live `file` rows differ only in `wrap_key_id`.
  **(d)** **the test-only provider is unreachable from a release binary**:
  `ProviderRegistry::from_deployment_config` with `FATHOM_MASTER_KEY_PROVIDER=mock` returns
  `UnknownProvider` naming what **is** built. The mock lives in `tests/`, which cannot see the
  library's `#[cfg(test)]` items, so this is structural rather than remembered — and the test says
  so.

* **G9 — D4: DESTROYING THE KEY DESTROYS THE DATA, AND THE BACKUP CAVEAT IS DEMONSTRATED.** Read
  the blob successfully first (the positive control). Take a byte-for-byte copy of the
  `design_blob` row into a second table — the stand-in for a backup, and the reason this gate is
  not circular. Then, in four parts:
  **(a)** with an **escrow wrapping deliberately left behind**, run `destroy_tenant_key`'s delete
  against only the primary wrapping and assert the blob **is still readable** — the failure mode,
  demonstrated rather than asserted.
  **(b)** run the real `destroy_tenant_key`, which deletes **every** wrapping, and assert the read
  now fails with `WrapError::KeyDestroyed`, distinct from every other error.
  **(c)** assert `design_blob.sealed` is byte-identical to before, because cryptographic erase is
  precisely **not** a rewrite.
  **(d)** assert the copied row cannot be read either, and — the sharpest half — that a `pg_dump`
  taken **before** the erase still decrypts with the same key file, while one taken after does not.
  **(e) THE PHYSICAL CHECK, WITHOUT WHICH (a)–(d) BOUND NOTHING.** A `pg_dump` is a *logical* dump:
  it reads live tuples only, so it is structurally blind to the survivor that §4.6.1 describes and
  (d) passes **because** of that blindness. So, in the same run and against the same cluster, with
  the destroyed row's `wrapped` bytes held in a variable:
  - `grep -c` the destroyed bytes across `$PGDATA/base/` — **expect a NON-ZERO count immediately
    after the DELETE**, and assert it, because a zero here means the check is looking in the wrong
    place and would pass vacuously;
  - `pg_waldump` the segments covering the write and the delete, and assert the bytes appear there
    too;
  - then `VACUUM (FULL, FREEZE) tenant_key`, force WAL recycling, and record what the same two
    greps return afterwards — **as a measurement, not as a pass condition**, because whether they
    return zero depends on checkpoint timing, `wal_keep_size`, replication slots and archiving,
    none of which this order configures.

  **The gate passes when the failure is DEMONSTRATED and stated, not when it is absent** — the same
  shape as G9(a), which leaves an escrow row behind on purpose. State in the evidence file what
  D4 therefore does and does not buy, in §4.6.1's words: unreadable through the application and
  through a logical dump; **still physically present in the heap, the WAL, every replica and every
  PITR archive** until vacuum and WAL recycling have both run. Where those archives live, how long
  they are kept, and who can read them is `OPEN-FOR-THE-OWNER.md` §B3 and §7 trigger 4 — and NIST
  SP 800-88's cryptographic erase is valid only *"on the assumption that every copy of the key is
  destroyed"*, which this deployment cannot yet assert.

* **G10 — MISBINDING IS REFUSED, FOUR WAYS, EACH BY EDITING A REAL ROW IN SQL.**
  **(a)** move design A's `sealed` into design B's row: the open fails, because the AAD
  reconstructed from B's own primary key does not match.
  **(b)** move tenant A's `tenant_key.wrapped` into tenant B's row: **`WrapError::Misbound`
  specifically**, not a generic decrypt failure — this is what proves the binding lives inside the
  wrapped plaintext rather than in a provider's context channel, and it is what lets a provider
  with no associated-data channel still be bindable.
  **This gate is reachable only because of §4.1's construction, and it is worth saying why it was
  not.** With the AAD used *only* as AEAD associated data — which is what an earlier draft of §4.1
  specified — a swapped row does not open at all: it fails the Poly1305 tag, indistinguishably from
  a wrong master key, so `Misbound` was unreachable and G10(b) was a gate no implementation could
  pass. Sealing `aad.encode() || key` inside the wrapped plaintext and returning the recovered AAD
  from `MasterKeyProvider::unwrap` is what makes *opened, and the binding inside is not this row's*
  a state that exists. **And this is why the context channel may never be the only binding:** AWS
  KMS raises the identical `InvalidCiphertextException` for an encryption-context mismatch and for a
  corrupt ciphertext (`API_Decrypt` and AWS's own `kms-invalidciphertextexception` guidance, read
  2026-09-04), so **a KMS provider binding through `EncryptionContext` alone could never satisfy
  G10(b)** — it has no channel through which to report *which* of the two happened. Under §4.1 it
  can: the context mismatch is `Refused`, and the plaintext-internal AAD mismatch is `Misbound`.
  G10(b) is therefore a gate every future provider can pass, rather than one only the file provider
  passes. Assert it against **both** providers — `file` and the `mock` of §4.5 — in the same run.
  **(c)** flip one bit of `sealed`: refused.
  **(d)** flip one bit of `commit`: refused, and **distinguishable from (c)** — which is what the
  commitment tag buys and what ADR-0014's branch-on-both-results shape is for.
  **Watched to fail:** the unmodified rows open in the same run, so a build that refuses everything
  cannot pass.

* **G11 — D7 AT THE TYPE LEVEL, AND ONCE WHERE THE ORACLE ACTUALLY IS.** Four properties, each
  mechanical and each about code that actually exists:
  **(i)** `Store`'s public write API takes **no integer parameter at all** — only `TenantId`,
  `DesignId`, `KeyEpoch`, `ProviderName`, `WrapKeyId`, `WrappedKey`, `Sealed` and `AadVersion` —
  asserted by an API test and by G5's census.
  **(ii)** `store.rs` is the **only** module in the crate that names a SQL verb, asserted by a
  source-reading test in G5's style. **The verb list is literal and exhaustive, so that no executor
  invents a narrow one that passes vacuously**: case-insensitive whole-word matches, inside string
  literals only, for `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `WITH`, `COPY`, `TRUNCATE`,
  `CREATE`, `ALTER`, `DROP`, `GRANT`, `REVOKE`, `VACUUM`, `ANALYZE`, `BEGIN`, `COMMIT`, `ROLLBACK`,
  `SET`, `LISTEN`, `NOTIFY`. `migrate.rs` and the migration files are named exceptions in the test
  itself, with their reason. **Watched to fail:** a fixture patch putting `"SELECT 1"` in a string
  literal in `health.rs` — a **SQL verb**, not the method name `client.execute`, which an earlier
  draft used and which does not exercise this rule at all.
  **(iii)** `WrappedKey` and `Sealed` expose no `len()`, and no type named for a plaintext length
  exists anywhere in the crate — asserted by a source-reading test over `keys/` and `store.rs`,
  with a literal rule rather than a described one: **no `pub fn len`, `pub fn is_empty`,
  `pub fn size` or `pub fn byte_len` on either type, and no item whose identifier matches
  `(?i)(len|length|size|bytes|octets)` adjacent to `(?i)(plain|secret|key|blob|design)` in either
  order** — e.g. `plaintext_len`, `KeyLength`, `SecretSize`, `blob_bytes` all fail. The regex is
  written into the test, and the test carries the two fixture identifiers it was calibrated on.
  **(iv) THE LENGTH ORACLE WHERE IT ACTUALLY EXISTS, WHICH IS NOT IN THE RUST SOURCE.** Seal two
  plaintexts of **different** lengths that fall in the **same Padmé bucket** — the test computes the
  pair from §4.1's `seal_len` rather than hard-coding two numbers — store both, and assert
  `octet_length(sealed)` is **equal** for the two rows, read back over SQL. Then a second pair
  chosen to straddle a bucket boundary, asserting the lengths **differ**, so the first assertion
  cannot pass by the sealer returning a constant. **This is the only one of the four properties that
  can see the leak D7 names.** (i)–(iii) read Rust source and G5's `INTEGER_COLUMNS` rule reads
  column *types*; none of them can see a `bytea` whose own length is the answer, and without padding
  `SELECT design_id, octet_length(sealed) FROM design_blob` returns the exact byte length of every
  customer design. **Watched to fail:** disable the padding in a scratch build and require (iv) to
  fail; restore.
  **A `LengthBucket` type is deliberately NOT shipped.** A type with no constructor from any
  `usize` is a type nothing can produce: dead code wearing a gate's clothes, and closer to the
  comment D7 explicitly rejected than to a persistence layer that cannot misuse a length. When a
  gate finding is first recorded, the order that records it chooses the buckets — from what a
  device accepts, per CLAUDE.md rule 0, never from what a detector needs — and that is §7 trigger 7.

* **G12 — THE SERVER REFUSES RATHER THAN IMPROVISES.** Six driven refusals, each with its message
  checked: no `FATHOM_MASTER_KEY_PROVIDER` set; an unknown provider name, with the message naming
  what **is** built; a key file at mode 0644, naming the path and the octal mode; a key file whose
  `key` line is not 64 hex characters, or is all zero; **`tests/fixtures/master-key-K1.txt`, the
  repository's own fixture key**, refused **by value** — its SHA-256 matched in constant time
  against `keys::file_provider::FIXTURE_KEY_DIGESTS` (§4.4), so a copy-pasted example cannot become
  production and the fixture's key bytes are still not in the release binary; and a
  `master_key_probe` row that the configured key file cannot open — **refuse to start**, rather
  than start and fail every request, and the refusal message names `custody::rewrap_probe` as the
  repair (§4.6), because a boot check with no named repair path is an outage generator.
  **Watched to fail:** with all six corrected, the server starts and G6 passes in the same script.

* **G13 — NO KEY MATERIAL IN ANY LOG, AT ANY LEVEL.** Run the whole write / read / switch / destroy
  path at `trace` with a key file whose 32 bytes are a recognisable canary; assert the canary
  appears in no log line as hex, as raw bytes or as base64, and that the key file's **path does**
  appear — an operator debugging a startup failure needs it. **Watched to fail:** a scratch build
  that logs `?data_key` must be caught, recorded, and reverted. WO-11 §9.8 found a real leak in its
  own redactor this way; the lesson is that **the control is the test, not the wrapper type**.

* **G14 — RFC KNOWN-ANSWER TESTS IN THE VERIFICATION FLOOR.** RFC 8439 §2.8.2's
  AEAD_CHACHA20_POLY1305 vector and RFC 5869 Appendix A.1–A.3's HKDF-SHA-256 vectors, run by
  `cargo test --workspace` so they are in CI and need no database. **Watched to fail:** mutate one
  byte of an expected output and see the test fail. It also catches the 0.10 → 0.11 API change
  silently doing something different.

* **G15 — THE ENVELOPE REFUSES WHAT IT SHOULD, NEVER PANICS, AND NEVER REUSES A PLAINTEXT KEY.**
  Round-trip plus a refusal set: bad magic, unknown suite byte, **a `header_len` that is not the
  width the suite byte names** (§4.1 replaced the `reserved` field with `header_len`, so the old
  *"non-zero reserved bytes"* check no longer names anything that exists), a truncated envelope, an
  envelope one byte short of the tag, **a plaintext one byte over `MAX_PLAINTEXT_LEN`**, and a
  `bytea` of length zero. Each returns a distinct named error; **none panics** — which matters more
  here than usual, because the server runs under `[profile.server]` with `panic = "unwind"`
  precisely so one bad row does not end the process for every connected user (WO-11 §9.5).

  **The two length constants are reconciled here and the boundary case is a required check.** An
  earlier draft applied `MAX_SEALED_LEN` to the **plaintext** while §4.2's CHECK applied the same
  literal to the **sealed** value, so a plaintext at the accepted maximum sealed larger and was
  refused **by PostgreSQL** rather than by the named error — the gate's own boundary case failing
  through the wrong path. Three assertions close it:
  - `MAX_PLAINTEXT_LEN` bounds the **plaintext**; `MAX_SEALED_LEN` bounds the **stored** value and
    equals `seal_len(MAX_PLAINTEXT_LEN)`;
  - a **unit test asserts the SQL literal in `0002_the_key_boundary.sql` equals
    `keys::seal::MAX_SEALED_LEN`**, read out of the migration text in G5's style, so the two can
    never drift;
  - **a plaintext of exactly `MAX_PLAINTEXT_LEN` seals, stores and reads back**, against a real
    PostgreSQL, and one byte more is refused by `SealError::TooLarge` **before any SQL is issued**.

  Plus §4.3's invariant, two tests: sealing the same plaintext twice under the same key produces
  different salts and different ciphertext; and `32` §5.4's own cheapest test — 10⁶ seals, 10⁶
  distinct salts.

  **Plus `32` §5.4's third rule, which an earlier draft dropped without saying so:** the startup
  CSPRNG sanity check of §4.1, driven three ways — an injected all-zero draw, a draw identical to
  the previous one, and a draw equal to the value persisted at `FATHOM_ENTROPY_PROBE_FILE` by a
  previous run — each refusing to start with a distinct message. `32` §5.4's table has three rules
  and this order now carries all three; dropping one silently, in an order that is adding a boot
  check anyway, would have been a `32` deviation under §7 trigger 12 with no Disagreements entry
  behind it. **Watched to fail:** with the probe file removed and the RNG unstubbed, the server
  starts.

## 7. Stop-and-escalate triggers

`78` §5: an execution session escalates rather than deciding anything the order leaves open. Each
trigger below says exactly what to do, and the answer is never *choose*.

1. **`OPEN-FOR-THE-OWNER.md` §A1 — where the master key lives.** If any gate cannot pass without
   naming AWS KMS, Google, Azure or Vault: **stop.** Building a second real provider is not this
   order's, and neither is choosing one. The mock in `tests/` exists precisely so the boundary can
   be proved without answering A1, and the point of the interface is that the question stays open
   while rows accumulate.
2. **§B1 — hosted or shipped, and the contradiction underneath it.** ADR-0003 is still *Accepted*
   and reads *"No hosted service, no accounts we run, no plan tiers"*; everything since the pivot
   assumes the opposite. **This order does not resolve it and does not depend on it** — the file
   provider is the one piece that survives either answer, which is why it is the one built. If any
   step appears to need the answer: **stop**, and record which step and why. Resolving it is an ADR
   amending or superseding 0003, which is planning work.
3. **§B2 — may the operator read a customer's map?** The file provider makes the answer concretely
   yes, on the same machine, with no additional key. The migration says so **in its own comment**
   rather than leaving it implied. This order deliberately builds **no** operator decrypt tool, no
   support view and no break-glass path, because building one would answer B2 by construction. If
   the work seems to want one: **stop.**
4. **§B3 — backups.** D4's cryptographic erase is only as strong as key-row backup hygiene. G9
   proves what it can against the live database and its own copied row, and **names the hole**. Do
   not design a backup regime, a retention period or a key-escrow location here. If a gate needs
   one: **stop.**
5. **§B4 — who sees what inside a company.** This order creates a tenant and a design **from a
   test and a fixture**, never from a request. There are no roles, no sharing and no visibility
   rules. If any gate needs to know *how a tenant gets created in production*: **stop** — that is
   sign-up, roles and invitations, which is `OPEN-FOR-THE-OWNER.md` §B4 and §B5 plus the next order.
6. **§A2 — the audit log.** **This order writes no audit record.** `tenant_key.wrapped_at` and
   `design_blob.updated_at` are timestamps on a current row, not a log, and the order says so
   explicitly so that nobody later cites them as one. Whether a wrap, an unwrap, a re-wrap or a
   destroy must leave a record that cannot be switched off is A2, and it is the owner's. If the
   work reaches it: **stop.**
7. **A gate finding, a length bucket, or anything that wants to record a property of a secret.**
   This order stores no gate finding, so it may not choose bucket boundaries — CLAUDE.md rule 0
   says they come from what a **device accepts**, never from what a detector needs. **Stop**, and
   leave it to the order that first records one.
8. **A version has moved, been yanked, or acquired an advisory since 2026-09-04.** `zeroize` 1.8.0,
   `cipher` 0.5.0 and `inout` 0.2.0 are already yanked on crates.io (read 2026-09-04), and
   `deny.toml` has `yanked = "deny"`, so a resolver landing on any of them must **fail rather than
   be worked around**. The advisory clone used for this design was 5a0ebedf, 2026-09-02, and is
   stale. Re-read everything; escalate rather than substituting a version on your own judgement —
   WO-11 §7 trigger 1, unchanged.
9. **`rustls`, `ring`, `aws-lc-sys`, `openssl-sys` or `native-tls` appears in the closure.** WO-11
   trigger 4, unchanged — and it is a second reason no KMS provider is built here, because every
   cloud SDK brings a TLS stack and C7 is a decision, not a detail.
10. **A real design blob exceeds `MAX_PLAINTEXT_LEN` (32 MiB).** Note the constant: the bound on a
    *design* is the plaintext one, and `MAX_SEALED_LEN` is what the database stores (§4.1, G15).
    Raising it is a planning decision about memory per request and about whether the blob should be
    chunked at all, which is `49` §7's territory. **Stop.**
11. **`35` §5.1's caps — all five, and C3 by name.** This order takes the lockfile from 115 to ~123
    against C2's ≤ 160, and direct from 6 to 13 against C1's ≤ 30, with sessions, passwords,
    passkeys, TOTP, SSO, mail, rate limiting and the audit chain still to come. **Restate C1, C2,
    C3, C4 and C5 with their measured values** — `35` §5.2's DECISION makes **C3, distinct
    publishing identities, ≤ 25, the primary metric**, and seven of the eight arriving crates are
    RustCrypto, which is the exact case §5.2 reasons about: a dozen crates and **one** compromise
    scenario. An earlier draft of this trigger restated only C1 and C2, which is the count that is
    easy to get rather than the one that matters. **WO-11 §9.7 already escalated the ceiling and
    named three routes; restate the new numbers and pick none of them.** Any cap exceeded is a
    **stop**, never a judgement call. Trigger 3's one prohibition still binds: the number is never
    met by removing a control.
12. **The cryptographic construction itself.** `32` owns the scheme (precedence,
    `.context/conventions.md`). If execution finds a reason to deviate from `32` §5.3's suite — a
    different nonce discipline, a different KDF, dropping key commitment — or from `32` §5.4's
    three-rule table or `32` §6.4 and `31` §7.6's padding decision, that is a **Disagreements entry
    against `32`**, and this order may **not** ship a second specification in the meantime. This
    trigger fires on a *deviation discovered in execution*; the deviation this order already makes
    knowingly — `FSL1`'s framing against `32` §7.1's — is **Disagreements 6**, declared up front
    rather than left for this trigger to catch.
13. **§A1's second half — the self-hosted key story — being answered by what gets built.** §4.4's
    `file` provider is **development and test only**, and ADR-0040 §9 item 2 reserves the shipped
    answer (*"a local key file with documented custody, an HSM, or a Vault instance"*) for planning.
    Trigger 1 does not catch this, because it only fires on naming AWS, Google, Azure or Vault —
    choosing the file slips underneath it, which is why this trigger exists separately. **Stop** if
    any step needs the file provider to be supported, recommended, production-hardened, or described
    in a customer-facing document as the self-hosted answer; if a gate needs an HSM or a key
    ceremony; or if `deploy/README.md` is asked to drop §4.4's *not yet the self-hosted answer*
    heading.
14. **ADR-0040 D5 — the server-side gate — the moment a blob arrives from anywhere but a test.**
    D5 requires *"the browser gate runs before upload, always, **and the server gate runs again on
    arrival**"*, union and never replace (ADR-0040 §5, ratified 2026-09-03). **This order builds no
    arrival path, so it builds no server-side gate, and §8 names that as an unengaged decision
    rather than letting its absence pass for compliance.** An opaque server-never-parses blob is
    exactly the shape in which D5 is easiest to lose: nothing in this order's gates would notice.
    **Stop** before any HTTP endpoint, any import, any paste path or any test fixture route accepts
    a blob that did not originate in this repository, and escalate the gate's design — where
    `fathom_ingest::redact` runs on a server that has decided never to parse what it stores is a
    real question and it is not this order's to answer.

## 8. Non-goals

This order deliberately does **not** build:

- **Any HTTP endpoint.** `/health` remains the only one. "End to end" here is two processes against
  a real database, not a request.
- **Accounts, sessions, sign-in, roles, sharing, invitations or sign-up.** The next order, and it
  needs answers this order must not invent.
- **Row-level security**, though every table carries `tenant_id` **and every primary and foreign
  key is composite on it** (`49` §11 rule 4), so it stays free later, and the migration quotes `49`
  §11's four rules. The scoping is the part that is not free to add after rows exist; the policies
  are.
- **A provider-side re-wrap primitive.** `MasterKeyProvider` has no `rewrap()`, so `add_wrapping`
  moves custody by unwrapping to a plaintext key in server memory and re-wrapping — foreclosing
  `kms:ReEncrypt` and `transit/rewrap`, which do the same job without exposing plaintext. **This is
  a decision and §4.6 gives its three reasons**, the load-bearing one being that it is additive
  later: a defaulted trait method whose default is today's behaviour changes no stored byte and no
  call site. Recorded here so the next order can overturn it in a line rather than rediscovering it.
- **Any graph table or projection.** `49` §7's `node`/`edge`/`field`/`provenance` shape and the
  generated projections are a later order's; the blob is opaque precisely so nothing here forecloses
  them.
- **A key cache.** Every read unwraps. Cheap for a file provider, a network round trip per read for
  a KMS — and the cost should be **visible** the day one is chosen rather than hidden behind a cache
  built before anyone measured it. Adding one is a decision about how long a plaintext key may live
  in process memory, which touches §B2 and §B3.
- **A second real provider.** The mock is a test double and says so in its own module comment.
- **Key rotation as a feature.** `tenant_key`'s opaque `wrapping_id` makes it the same mechanism as the
  custody switch; naming that now is free, building a rotation schedule is not this order.
- **An audit log, an operator decrypt tool, a support view or a break-glass path** — §7 triggers 6
  and 3.
- **Any tenant or design name, label or free text.** The first plaintext column is a decision, not
  a convenience.
- **Blob history, versions, or optimistic concurrency.** One row per design.
- **Anything client-side.** No schema change (ADR-0008 is not engaged: none of this is the
  network's data — `70` §18.2), no WASM change, and G1 proves it.
- **ADR-0040 D5's server-side gate — and it is named here rather than silently absent.** D5 says
  the browser gate runs before upload *"and the server gate runs again on arrival"*. **There is no
  arrival path in this order** — the only blob that reaches the database comes from
  `tests/fixtures/one-design.blob` through an example binary — so there is nothing for a server-side
  gate to run on, and none is built. That is a **decision left unengaged, not a decision taken**, and
  it is stated because an opaque blob the server never parses is the shape in which D5 is easiest to
  lose: no gate in §6 would notice its absence. **§7 trigger 14 requires it before any endpoint,
  import or non-repository fixture route accepts a blob.**
- **Closing ADR-0041's gap, and it is the one non-goal that is about the *contents* of what is
  stored.** ADR-0041 (2026-09-03) decided that a hand-typed value that looks like a credential is
  **marked, never refused**, and is stored and exported exactly as typed; the ingest gate that
  invariant 3 promises has exactly one caller, `OP_PASTE`, and never sees it. So **the first
  `design_blob` this order stores may contain a device password, and the server holds the key that
  opens it.** Nothing here widens that and nothing here closes it. What stays true, and is the
  sentence ADR-0040 §6 leaves standing, is narrower than the one people reach for: **a device
  credential is protected by never arriving** — which covers everything the gate saw and nothing a
  person typed. Do not read the blob's opacity as a claim about its contents.

## Failure modes

| failure | what stops it |
|---|---|
| the key boundary is "added later" and never is | this order, and ADR-0040 §8's first row |
| a custody switch turns out to need re-encrypting the data | G7 and G8(b), asserting byte-identity of `design.wrapped_key` and `design_blob.sealed` across both a same-provider and a **cross-provider** switch |
| the provider boundary is argued and never demonstrated | **G8** — a second, differently-shaped provider round-tripping the same rows with no DDL. This is the failure the winning design of this order's authoring workflow actually had, and it is why G8 exists as a separate gate from G7 |
| the switch is described as incremental but the shipped shape cannot do it | `tenant_key`'s opaque `wrapping_id` — which survives a Vault version advance and a KMS imported-material rotation, and the four-part key it replaced did not — and G7's midpoint assertion that both wrappings open the blob independently |
| a routine provider-side key rotation leaves the server unable to boot | §4.6's fourth operation, `rewrap_probe`, and G12's sixth refusal naming it as the repair |
| a row swap succeeds because the binding lived in the provider's context channel | G10(b), which requires `Misbound` specifically — reachable only because §4.1 seals `aad.encode() \|\| key` INSIDE the wrapped plaintext and `unwrap` returns the recovered AAD. With AAD-only binding this row was unenforceable and AWS KMS could never have satisfied it |
| customer plaintext lands in a column | G4's canary and its positive control; G5's census |
| a length oracle returns on the server | **G11(iv)** — two plaintexts of different length in one Padmé bucket storing to equal `octet_length(sealed)`, watched to fail with the padding disabled. G5's `INTEGER_COLUMNS` rule and G11(i)–(iii) cannot see this one at all: the leaking value is a `bytea`'s own length, and there is no integer column and no `usize` parameter anywhere for them to catch |
| D4 is claimed and a leftover escrow row defeats it | G9(a), which leaves one behind on purpose and demonstrates the failure before proving the fix |
| D4 is claimed and the deleted key is still on the disk | **G9(e)**, which greps `$PGDATA` and `pg_waldump` for the destroyed bytes and **requires them to be found**, so the boundary is measured rather than assumed. A logical `pg_dump` cannot see this and G9(d) passed *because* of that blindness |
| a global `design_id` makes row-level security unfree and lets a mismatched pair be stored | `49` §11 rule 4 applied now: composite `(tenant_id, design_id)` primary keys and a composite foreign key from `design_blob` to `design` |
| ADR-0040 D5's server-side gate is lost because the blob is opaque | §7 trigger 14 and §8's named non-goal — no arrival path exists, so the absence is recorded rather than mistaken for compliance |
| a key reaches a log | G13, canary key file at `trace`, watched to fail |
| the crypto crates leak into the client | G1's forced rebuild and byte comparison, plus `fathom-wasm`'s empty `IMPORT_ALLOWLIST` |
| the approved crate record's version number is quietly overridden in a manifest | step 0 amends the record with the measurement; G2 watches the alternative fail |
| a database-backed gate silently skips and the run reports green | the RAN marker plus the **exact check count** every evidence script asserts on |
| a test vector is typed from memory | step 2 requires the bytes read out of the RFC text |

## Open decisions

None blocking this order. Recorded because the next one needs them, and every one is the owner's:

1. **Which key-management service** — `OPEN-FOR-THE-OWNER.md` §A1, ADR-0040 §9 items 1 and 2. This
   order builds the interface and one implementation and decides nothing.
2. **Whether the first release keeps an audit log** — §A2, ADR-0040 §9 item 4. This order writes no
   audit record and says so where it could be mistaken for one.
3. **The borrowed-code ceiling** — §A3, WO-11 §9.7. Restated with a new number, unchosen.
4. **Hosted or shipped, and ADR-0003's contradiction** — §B1.
5. **May the operator read a customer's map** — §B2. The file provider makes the answer concretely
   yes; the order refuses to make it *convenient*, which is not a control.
6. **Backups** — §B3, and it is the named hole in G9(e): a `DELETE` leaves the wrapped key in the
   heap, the WAL, every replica and every PITR archive until vacuum and WAL recycling have run.
7. **Who sees what, and whether a stranger may sign up** — §B4, §B5.
8. **The sequencing of ADR-0040 §9 item 1 against the first migration** — item 1 says *"for
   planning, **before the first migration**"* and this order writes that migration. Planning's, not
   the owner's, and Disagreements 5 states the case either way.
9. **Whether `MasterKeyProvider` gains a `rewrap()`** — §4.6 answers *not now* with three reasons
   and §8 records it, because the day a real KMS is chosen is the day `kms:ReEncrypt` stops being
   theoretical.

## Sources consulted

| source | for | read |
|---|---|---|
| `docs/90-decisions/adr-0040-*.md` | D1–D8, §6's forbidden sentences, §7's must-stay-true list, §9's open items | 2026-09-04 |
| `docs/70-ops/79-work-orders/WO-11-*.md` §6, §8, §9 | the house style, the gate discipline, G8 which this supersedes, §9.7's escalation | 2026-09-04 |
| `docs/40-stack/49-the-server-product.md` §7, §11, §19, §22 | the storage shape not built here, RLS's four rules, phase ordering, the closed decisions | 2026-09-04 |
| `docs/70-ops/70-owner-answers-and-standing-priorities.md` §18.1, §18.2 | the delegation of key custody, verbatim; tenancy outside the graph, verbatim | 2026-09-04 |
| `docs/30-security/32-cryptography.md` §5.2–§5.6 | the AEAD decision, the salt/zero-nonce construction, the nonce-uniqueness argument **and all three rules of §5.4's table**, the commitment tag. **`32` owns the scheme** | 2026-09-04 |
| `docs/30-security/32-cryptography.md` §6.4, §6.5, §7.1, §7.2 and `31` §7.6 | Padmé on the total envelope length, the flat 512-byte floor, the honest-accounting table's *"total ciphertext size, to a Padmé bucket"* residual, and the 112-byte header whose `header_len` field §4.1 copies the reasoning for | 2026-09-04 |
| `docs/90-decisions/adr-0041-*.md` and `.context/conventions.md` invariant 3's annotation | that a hand-typed credential is marked, not refused, and is stored and exported as typed — §2's note and §8's last non-goal | 2026-09-04 |
| PostgreSQL documentation on MVCC, `VACUUM`, WAL and PITR | that a `DELETE` marks a tuple dead and leaves the row image on the heap page until vacuum, in the WAL until recycling, and on every replica and archive — §4.6.1 and G9(e). Raised by the adversarial review of this order's draft | 2026-09-04 |
| AWS KMS: `API_Decrypt` (`CiphertextBlob` 1–6144 bytes; `InvalidCiphertextException`), *Rotate AWS KMS keys*, *How to use on-demand rotation for AWS KMS imported keys*, and AWS re:Post *Resolve the AWS KMS decrypt error InvalidCiphertextException* | §4.2's 6144 ceiling, the in-place rotation that breaks a four-part primary key, and G10(b)'s point that a context mismatch and a corrupt ciphertext raise the **same** exception. Read by the adversarial review of this order's draft | 2026-09-04 |
| HashiCorp Vault: Transit HTTP API, and *Re-wrapping data after encryption key rotation* | `vault:vN:` as a key **version** under an unchanged key name, `transit/rewrap`, and `min_decryption_version` — the second half of §4.2's primary-key argument. Read by the adversarial review of this order's draft | 2026-09-04 |
| `docs/70-ops/OPEN-FOR-THE-OWNER.md` §A, §B | the twenty-seven open questions; §7's triggers are keyed to them | 2026-09-04 |
| `.context/conventions.md` | invariants 3 (untouched) and 4 (scoped by ADR-0040); the union rule; precedence | 2026-09-04 |
| `deps/decisions/chacha20poly1305.md`, `argon2.md`, `00-CLOSURE.md`, `00-CLOSURE-SERVER.md` | two owner approvals from 2026-08-15, and the closure pattern | 2026-09-04 |
| `crates/fathom-server/` — `Cargo.toml`, `src/*.rs`, `migrations/0001_*.sql`, `tests/stores_nothing.rs` | prior state, read in full | 2026-09-04 |
| `Cargo.lock`, `deny.toml`, `docs/70-ops/78-execution-protocol.md` §6 | 132 packages / 115 external; `yanked = "deny"`, `multiple-versions = "deny"`; the sixteen-row floor | 2026-09-04 |
| `index.crates.io` — the sparse index for `chacha20poly1305`, `zeroize`, `hkdf`, `aead`, `cipher`, `poly1305`, `inout`, `universal-hash` | declared dependencies, feature tables and yank status for every version in §5 step 1 | 2026-09-04 |
| `static.crates.io` — `Last-Modified` on each `.crate` file | the publication dates in §5 step 1's table, the same figure `scripts/crate-cooldown.sh` gates on | 2026-09-04 |
| `RustSec/advisory-db` local clone, commit 5a0ebedf | zero advisories against the eight arriving crates; RUSTSEC-2021-0100 (`sha2`, patched ≥ 0.9.8); RUSTSEC-2026-0097 (`rand`, informational/unsound, `rand::rng` ≥ 0.9.0, patched ≥ 0.10.1 — **the tree is on 0.10.2 and is already patched**) | 2026-09-04, clone dated 2026-09-02 |
| RFC 8439 §2.8 (AEAD_CHACHA20_POLY1305) and RFC 5869 §2.2/§2.3 and Appendix A (HKDF-SHA-256) | the construction and its known-answer tests, **as cited by `32` §5.2/§5.3**. §5 step 2 requires the vector bytes read out of the RFC text itself, not from here | via `32`, 2026-09-04 |
| NIST SP 800-88 Rev. 2 (final 2025-09-26) | cryptographic erase as a Purge method, **on the assumption that every copy of the key is destroyed** — which is why G9 names the backup hole | via ADR-0040 D4, 2026-09-04 |

## Disagreements

1. **With `49` §19's phase ordering, and it is the substantive one: this order stores a customer
   row before accounts exist.** §19 puts *"Accounts, sessions, passwords, passkeys, invitations,
   roles, admin"* first in phase 1 and *"Postgres persistence of the store"* fourth. This order
   inverts that, deliberately, on one argument: **the key boundary is the only item on that list
   whose cost rises with every row already stored.** ADR-0040 §7 states it — *"Retrofitting a key
   boundary means re-encrypting everything already held"* — and D1 requires the boundary from the
   *first stored byte*, which is a constraint on ordering and not merely on design. Accounts can be
   built on top of a correct key boundary at any time; a key boundary retrofitted under a year of
   accounts is the exact failure ADR-0040 exists to prevent. What this order gives up is that its
   tenant and design are created **by a test and a fixture rather than by a person**, so nothing
   here is usable by a user — which is `49` §19's own stated criterion for a phase, and this order
   fails it and says so rather than pretending otherwise. The mitigation is that the shape is small
   enough to be read in one sitting: five tables, 27 columns, no endpoint, no roles.

2. **With the literal version number in `deps/decisions/chacha20poly1305.md`.** The record is
   owner-approved and names `0.10`; this order takes `0.11.0`. Under ADR-0032 §5 as originally
   written that would be an owner act; the owner lifted that constraint on 2026-09-03 (*"Oh no you
   can use borrowed code"*) and asked for automated checking instead, so this is execution work
   under the gate. **It is nonetheless the first time this project has moved a version the owner
   personally signed**, and it should arrive as an **amendment to the record carrying the
   measurement** — the duplicate-version cost in §5 step 1 — rather than as a manifest line somebody
   notices later. If that reasoning does not survive review, the fallback is not 0.10: it is to
   escalate, because taking 0.10 means several permanent `[[bans.skip]]` entries and a second
   RustCrypto generation in the tree, which is a worse outcome bought with a literal reading.

3. **With the instinct to build a real second provider now, so the boundary is proved against
   something that matters.** It is the better test and the wrong order. Every cloud SDK brings a TLS
   stack, which is §7 trigger 9; and choosing which provider to build is §A1, which is the owner's.
   The mock is a weaker proof than AWS KMS would be and it is honest about that: what it
   demonstrates is that **dispatch, storage, binding and the custody switch survive a provider with
   a different output shape, a different key-id shape and real async latency** — which is the part
   that would otherwise be argued rather than shown.

4. **With `35` §5.1's single closure cap, restated rather than re-argued.** WO-11 §9.7 named three
   routes and picked none; this order adds eight packages and picks none either. Recording it twice
   is not redundancy — it is the second data point that turns *"the cap will not survive phase 1"*
   from a projection into a measurement. G2 now also measures **C3**, which `35` §5.2 calls the
   metric that actually matters and which WO-11 did not report — so the second data point is on the
   right axis as well as the convenient one.

5. **With ADR-0040 §9 item 1's sequencing clause, and it is the one thing here that genuinely needs
   a planning ruling.** Item 1 reads *"for planning, **before the first migration**"*. This order
   writes that migration with item 1 open. The header block quotes the clause whole and answers its
   other two limbs; this entry states the disagreement plainly rather than letting the quotation do
   it. **The case for proceeding:** item 1's own subject is *which service*, and D1–D4 already
   decided the architecture — a data key per tenant and per design, wrapped by a master key,
   custody switched by re-wrapping and never re-encrypting. All three §A1 candidates are opaque
   bytes in one provider-neutral column, so the migration this order writes is the same migration
   under every answer, and G7/G8(b) prove it by bytes. **The case against, which is not weak:** the
   clause says what it says, it was written by the record that also wrote D1, and *"the format is
   provider-neutral"* is exactly the confidence that produces a retrofit when it turns out to be
   wrong about one provider. **This order does not resolve it** — it escalates it in the PR body at
   §5 step 0, and if planning rules for the clause, execution stops after step 4 with the key module
   built and nothing stored.

6. **With this order's own earlier claim to specify nothing new, withdrawn.** §2 and §5 step 2 said
   *"`32` owns this construction; this order implements it and specifies nothing new"*, citing only
   `32` §5.2–§5.6. That was false about the framing. `32` §7.1 already specifies an envelope — a
   fixed **112-byte** header, magic `FTHM\x1fREC`, `header_len`, `aad_ext_len`, and §7.2's
   field-by-field argument for each AAD field against a named attack. `FSL1` is a **second,
   narrower, server-side envelope**: 56 bytes, different magic, its own `info` string, no
   `aad_ext_len`. Writing a second format is specification, and `78` §7 puts specification with
   planning. **Three things are true and all three are stated rather than one of them:** (a) the
   *scheme* is unchanged — same AEAD, same KDF, same zero nonce, same commitment tag, same padding,
   all of it `32`'s; (b) the *framing* is new and this order wrote it; (c) `35` §5.1 C8 — one
   implementation per job — argues for one envelope, not two, and the counter-argument is that `32`
   §7.1's header carries five fields (`record_class`, `record_id`, `aad_ext`, `schema_major`,
   `schema_minor`) that name workspace-file concepts with no server meaning. **The narrower
   deviation, which is not a judgement call, has been removed**: an earlier draft dropped `32`
   §6.4's padding and `32` §5.4's startup check outright, and both are now in — §4.1 and G15.
   What remains is the framing, and if planning rules that `32` §7.1's envelope must be reused
   whole, that is a rewrite of `keys/seal.rs` and of two CHECK constraints and of nothing else.

7. **Corrections made in this PR to documents other than this one, recorded here per `78` §8.**
   - `docs/70-ops/OPEN-FOR-THE-OWNER.md` §A1 — old: *"Nothing can be saved on the server until A1 is
     answered"* and *"changing this after data is stored means unlocking and re-locking everything
     already held"*. New: rows are stored behind a wrap point that is provably movable, and what A1
     still decides is who holds the master key and what a stolen server costs. Proving path: ADR-0040
     D2, and G7/G8(b)'s byte-identity assertions across a same-provider and a cross-provider switch.
     No option, trade or question in §A1's table is changed.
   - **`CLAUDE.md` is NOT corrected**, though its *Verify before you trust* section says thirteen
     floor rows where `78` §6 has sixteen. `78` §5 item 7 makes a work order instructing a CLAUDE.md
     edit **malformed**, and §8's Correction clause covers only the work order being executed. The
     discrepancy goes in the PR body as an escalation to planning. An earlier draft of §3 instructed
     the edit and cited §8 for it; both halves of that were wrong.
