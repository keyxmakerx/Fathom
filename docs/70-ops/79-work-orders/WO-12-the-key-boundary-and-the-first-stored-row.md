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
| `32` §5.2, §5.3, §5.4, §5.6 | the AEAD, the derivation, the nonce argument and the key-commitment tag. **`32` owns this construction; this order implements it and specifies nothing new** |
| `deps/decisions/chacha20poly1305.md`, `argon2.md` | two crates already owner-approved on 2026-08-15, neither vendored — §5 step 0 |
| `deps/decisions/00-CLOSURE.md`, `00-CLOSURE-SERVER.md` | the closure pattern: a crate Fathom **names in a manifest** always needs its own record |
| `OPEN-FOR-THE-OWNER.md` §A, §B | what is genuinely undecided. **This order decides none of it** — §7 carries a trigger per question |
| `.context/conventions.md` | the invariants; invariant 4 is scoped by ADR-0040, invariant 3 is untouched and stays true |
| `78` | the execution protocol governing this order |

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
  was written. **Correct the CLAUDE.md line in this order's PR** as a factual correction (`78` §8),
  and do not treat the discrepancy as a finding.
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

/// What a wrapped key is bound to. Deliberately NOT the provider name and NOT
/// the master key id: binding to either would make a custody switch a
/// re-encryption, which is the retrofit ADR-0040 D2 exists to prevent.
pub struct WrapAad {
    pub purpose: Purpose,          // TenantKey | DesignKey | DesignBlob
    pub tenant_id: TenantId,
    pub design_id: Option<DesignId>,
    pub key_epoch: KeyEpoch,
    pub aad_version: AadVersion,   // 1
}
impl WrapAad {
    /// Canonical, fixed field order, fixed width. NEVER STORED: recomputed from
    /// the row's own primary key on every open, which is what makes a row swap
    /// fail instead of succeed.
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
    /// Which master key NEW wraps use. An ARN, a Vault transit key name, or a
    /// key file's declared id. Opaque to Fathom, and not a secret.
    fn wrap_key_id(&self) -> &str;
    async fn wrap(&self, aad: &WrapAad, key: &DataKey) -> Result<WrappedKey, WrapError>;
    async fn unwrap(&self, aad: &WrapAad, wrapped: &WrappedKey) -> Result<DataKey, WrapError>;
}

/// NO VARIANT CARRIES A STRING FROM A PROVIDER. `config.rs`'s ConfigError set the
/// precedent — "no variant carries a value read from the environment" — and a KMS
/// error body is worse: it can echo an ARN, a request id, and in the wrong SDK a
/// plaintext length. `&'static str` only.
pub enum WrapError {
    Unavailable(&'static str),  // file missing, KMS unreachable, token expired
    Refused(&'static str),      // wrong key, corrupt ciphertext, denied by policy
    Misbound,                   // opened, and the binding inside is not this row's — G10(b)
    Malformed,                  // opened, and is not an FWK1 envelope
    UnknownProvider,            // a row names a provider this deployment has not configured
    KeyDestroyed,               // D4 happened. Distinct from every error above, on purpose
}

/// THE ONLY UNWRAP PATH. No caller outside this function holds a
/// `&dyn MasterKeyProvider`, so a provider cannot skip the binding check.
pub async fn unwrap_and_check(
    registry: &ProviderRegistry,
    row: &TenantKeyRow,
    expected: &WrapAad,
) -> Result<DataKey, WrapError>;
```

**`keys/seal.rs`** — the `FSL1` envelope, which is `32` §5.3's construction and nothing new. One
construction, three uses: the file provider's own output, the design key sealed under the tenant
key, and the blob sealed under the design key.

```
FSL1 seal envelope — 56-byte header, then ciphertext and tag
  0    4   magic        b"FSL1"
  4    1   suite        0x01 = HKDF-SHA-256 / ChaCha20-Poly1305 / zero nonce / 128-bit commitment
  5    1   aad_version  0x01
  6    2   reserved     0x0000, MUST be zero on read
  8   32   salt         CSPRNG, per seal
 40   16   commit       K_cmt
 56    n   ciphertext || Poly1305 tag

PRK            = HKDF-Extract(salt, ikm = key)                        RFC 5869 §2.2, SHA-256
K_enc || K_cmt = HKDF-Expand(PRK, info, 48)                           RFC 5869 §2.3
info           = b"fathom/server/seal/v1" || header[0..8] || aad_bytes
nonce          = twelve zero bytes                                    32 §5.3 option B
ct             = AEAD_CHACHA20_POLY1305(K_enc, nonce, aad_bytes, pt)  RFC 8439 §2.8
```

The suite byte at offset 4 is what makes a second construction additive rather than a migration.
`K_cmt` is compared in constant time (`ctutils::CtEq`) and, per ADR-0014 as cited by `32` §5.6, the
AEAD open runs regardless and the code branches on the **pair** of results — so *wrong key*,
*tampered ciphertext* and *mutated commitment tag* stay distinguishable and none is a partitioning
oracle.

**`keys/file_provider.rs`**, **`keys/registry.rs`**, **`keys/custody.rs`** — §4.4, §4.5, §4.6.

### 4.2 Migration `0002_the_key_boundary.sql` — five tables, 25 columns, no free text

Every column is an id, a timestamp, a version number, opaque ciphertext, or opaque provider
metadata. **There is no name, label, slug, domain, contact or plan anywhere.**

| table | columns | why it is shaped this way |
|---|---|---|
| **`tenant`** | `tenant_id text PRIMARY KEY CHECK (~ ULID shape)`; `key_epoch integer NOT NULL DEFAULT 1 CHECK (> 0)`; `created_at timestamptz NOT NULL DEFAULT now()`; `key_destroyed_at timestamptz NULL` | The tenant's existence, which data key epoch is current, and its D4 tombstone. **A display name is customer data and would be the first plaintext column**; it is not stored here, and when it is, it is sealed or excepted in writing. No natural key at all, which also sidesteps `49` §11 rule 4's covert channel — a *"that name is taken"* error naming a tenant you may not see |
| **`tenant_key`** | `tenant_id text NOT NULL REFERENCES tenant`; `key_epoch integer NOT NULL`; `wrap_provider text NOT NULL CHECK (~ '^[a-z][a-z0-9-]{1,31}$')`; `wrap_key_id text NOT NULL CHECK (char_length BETWEEN 1 AND 512)`; `wrapped bytea NOT NULL CHECK (octet_length BETWEEN 32 AND 4096)`; `aad_version smallint NOT NULL CHECK (> 0)`; `wrapped_at timestamptz NOT NULL DEFAULT now()`; **`PRIMARY KEY (tenant_id, key_epoch, wrap_provider, wrap_key_id)`** | **The four-part primary key is the most important line in this migration.** It lets ONE data key carry SEVERAL wrappings at once, which collapses rotation, escrow and D2's custody switch into one additive operation: INSERT the new wrapping, verify it by unwrapping, DELETE the old. A single-column key would make a custody switch a destructive `UPDATE` with no verify-before-drop window — and would make the rolling switch this order describes impossible to perform. It is also the only table a provider ever touches and the only one a custody switch rewrites |
| **`design`** | `design_id text PRIMARY KEY CHECK (~ ULID shape)`; `tenant_id text NOT NULL REFERENCES tenant`; `key_epoch integer NOT NULL`; `wrapped_key bytea NOT NULL CHECK (octet_length BETWEEN 104 AND 1024)`; `created_at timestamptz NOT NULL DEFAULT now()` | The design key, sealed under the **tenant** key, so a provider is called once per tenant and not once per design. `key_epoch` names which tenant epoch sealed it, so a later tenant-key rotation is detectable rather than a silent failure. **Deliberately absent**: the design's name, owner, share list, schema version, device count. 104 is the exact FSL1 length for a 32-byte plaintext; the range rather than an equality is what keeps a second suite additive |
| **`design_blob`** | `design_id text PRIMARY KEY REFERENCES design`; `tenant_id text NOT NULL REFERENCES tenant`; `sealed bytea NOT NULL CHECK (octet_length BETWEEN 72 AND 33554432)`; `updated_at timestamptz NOT NULL DEFAULT now()` | The whole of what this order stores as customer data: one opaque blob per design, which **the server never parses**. `49` §7's node/edge/field/provenance tables and the generated projections are a later order's, and nothing here depends on the blob's contents, so nothing here forecloses them. 32 MiB is a denial-of-service bound with a stop-and-escalate behind it (§7 trigger 10), not a format assumption |
| **`master_key_probe`** | `wrap_provider text NOT NULL CHECK (…)`; `wrap_key_id text NOT NULL CHECK (…)`; `wrapped bytea NOT NULL CHECK (…)`; `aad_version smallint NOT NULL`; `created_at timestamptz NOT NULL DEFAULT now()`; `PRIMARY KEY (wrap_provider, wrap_key_id)` | 32 wrapped random bytes whose plaintext is stored nowhere, so there is no known-plaintext pair. It lets the server answer *"is this the right key file?"* **at boot** and refuse to start, rather than starting and failing every request — the honest reading of *"a process that starts is a process a load balancer calls healthy"*. **This is the one table with no `tenant_id`**, because it belongs to the deployment and not to a tenant; the census (G5) carries it as a named exception with that reason, not a silent one |

`tenant_id` is on every tenant-scoped table even where it is reachable by a join, because it is
the one part of `49` §11's row-level security that is **not** free to add later. The migration
quotes `49` §11's four rules in its own comment, including that the application role must not own
the tables and must not have `BYPASSRLS`.

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

### 4.4 The first provider — `file`, and it is the shipped product for one kind of customer

Selected by `FATHOM_MASTER_KEY_PROVIDER=file`, reading `FATHOM_MASTER_KEY_FILE`. It is first
because it is the one provider needed **whichever way `OPEN-FOR-THE-OWNER.md` §B1 lands**: a
customer running Fathom on their own hardware has no cloud KMS (ADR-0040 §9 item 2 says exactly
this), and a hosted deployment still needs something to run against before a KMS account exists.

The file — three lines, ASCII, no parser worth the name:

```
fathom-master-key v1
id  01K9Z8QW4E5R6T7Y8U9I0P1A2B
key 3f7c…                       (64 lowercase hex characters = 32 bytes)
```

The id is a ULID and becomes `tenant_key.wrap_key_id`, so a row says which key file opens it after
a switch. Hex rather than base64 on purpose: a hex decoder is twenty lines of first-party code and
no dependency, and the `base64` already in the lockfile is `postgres-protocol`'s, not ours.

**What the operator must do, and it is the whole custody story for this provider** — it goes in
`deploy/README.md` in these words:

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

**`keys/registry.rs`** has two constructors and the split is the point:

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

### 4.6 Custody — `keys/custody.rs`, three operations and no more

| operation | what it does | what it proves |
|---|---|---|
| `add_wrapping(tenant, from_provider, to_provider)` | unwraps the tenant key under the current wrapping and INSERTs a second row wrapping the **same** key under the new provider | the switch has a verify-before-drop window: both wrappings are live at once |
| `drop_wrapping(tenant, provider, key_id)` | DELETEs one wrapping, refusing if it is the last one for a tenant that is not being destroyed | the switch completes without a moment in which the tenant has no readable key |
| `destroy_tenant_key(tenant)` | DELETEs **every** `tenant_key` row for the tenant and sets `tenant.key_destroyed_at`, in one transaction | D4. The ciphertext is deliberately left in place, which is what makes G9 a proof rather than a demonstration |

**`add_wrapping` + `drop_wrapping` is the rolling custody switch, escrow, and key rotation — one
mechanism, three names.** Escrow is not built here; it is the same INSERT, and saying so now is
free.

### 4.7 The rest

- **`store.rs`** — the only module in the crate permitted to name a SQL verb (G11(ii)).
- **`examples/write_one_design.rs`** and **`examples/read_one_design.rs`** — two separate
  processes for G6. Examples and not `src/bin`, so `deploy/Dockerfile`'s `--bin fathom-server`
  cannot ship them.
- **`tests/stores_only_ciphertext.rs`** — WO-11's `stores_nothing.rs`, repurposed (G5).
- **`tests/seal_vectors.rs`** — RFC known-answer tests, in `cargo test --workspace` so they are in
  CI and need no database (G14).
- **`tests/provider_boundary.rs`** — the second provider round-trip (G8).
- **`deps/decisions/`** — seven new individual records, `00-CLOSURE-SERVER.md` regenerated, and
  `chacha20poly1305.md` amended with §5 step 1's measurement.
- **Two evidence scripts** in `docs/80-review/evidence/`, dated the day they run, each printing an
  **exact check count** that the script asserts on, so a skipped check fails instead of reporting
  green.

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

- **`deps/decisions/chacha20poly1305.md`** — owner-approved 2026-08-15, `0.10`, never vendored.
  This order takes **0.11.0** and step 1 carries the measurement that decides it. The record is
  **amended with that measurement, not silently overridden in the manifest.**
- **`deps/decisions/argon2.md`** — owner-approved 2026-08-15, `0.5`, never vendored. **It is NOT
  used by this order.** Its approval stays banked for the sign-in order, where OWASP's server-side
  parameters (`49` §12) get their own decision; `argon2.md` already says the file-key floor and a
  server-side login hash must not share a number. Said here so that *"argon2 is approved"* is not
  read as *"argon2 belongs in this order."*

**Step 1 — the crates, one at a time, gate exercised on every arrival.**

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

**MEASURED TOTAL: 115 → 123 external packages** (`35` §5.1's cap is ≤ 160) and **6 → 13 direct**
(cap ≤ 30). Zero new duplicate pairs, and `deny.toml` needs no new `[[bans.skip]]`. **Re-measure
rather than quoting these**; the numbers here are what the design session resolved and G2 is what
counts.

**Step 2 — `keys/seal.rs` and the RFC vectors. No database, no provider, no SQL.**

Implement `32` §5.3's construction exactly and **specify nothing new**. Write the vector tests
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

**Step 8 — `keys/custody.rs`, the probe row, and the boot check.** `add_wrapping`, `drop_wrapping`,
`destroy_tenant_key`; `master_key_probe` written on first start and verified on every start.

**Step 9 — the mock provider and the provider-boundary tests** (G8). This is the step the order
exists for; if anything earlier has made it awkward, that is a finding about the earlier step.

**Step 10 — the misbinding gates, the log gate, and the second evidence script** (G7, G9, G10,
G13). The misbinding gates edit **real rows in SQL**, not fixtures in Rust.

**Step 11 — the floor, the measured numbers, the as-built note, the index row.** Record the
closure's real size against `35` §5.1, re-run the WASM build **forced** and record the byte count
read off the run, add the `00-INDEX.md` row, and write §9 in WO-11's shape: what the gates caught
on real arrivals, what was corrected, and what was deliberately not done.

## 6. Acceptance gates

Every gate below is falsifiable, and every safety gate names the thing that must be **watched to
fail** before it is believed — CLAUDE.md rule 0, and WO-11 §6 G2/G3's shape.

* **G1 — THE FLOOR, AND THE CLIENT IS UNTOUCHED.** `78` §6's rows green, including the five
  dependency layers on real arrivals. The WASM module must be **byte-identical to 988,490 after a
  forced rebuild**, and the number is read off the `artifact_gates` run, never quoted from a
  document. **Watched to fail:** a scratch commit adding `chacha20poly1305` to any crate other than
  `fathom-server` must break `fathom-wasm`'s empty `IMPORT_ALLOWLIST` or the byte comparison — run
  it, record the failure, revert. This is the gate that proves cryptography did not leak across the
  fork.

* **G2 — THE CLOSURE, MEASURED AND NOT TYPED.** `deps/decisions/00-CLOSURE-SERVER.md` regenerated
  by `scripts/closure-report.sh --write` from `cargo metadata`. State the new lockfile count,
  direct count, build-script count and proc-macro count against `35` §5.1. `cargo deny check` green
  with **no new `[[bans.skip]]`**. **Watched to fail:** pin `chacha20poly1305` to 0.10 on a scratch
  branch, record `cargo deny` naming the duplicate pairs, revert. The refusal to take the approved
  record's literal version number has to be a **measurement in the as-built note**, not an
  assertion in this order.

* **G3 — GATE-ZERO STILL BITES ON A CRATE FATHOM CHOSE.** Each of the seven new direct
  dependencies has its own `deps/decisions/<crate>.md`; the five new transitive ones are carried by
  the closure document. **Watched to fail:** delete `deps/decisions/hkdf.md` and require gate-zero
  to fail **naming `hkdf` specifically**, not a generic count; restore.

* **G4 — THE CANARY IS IN THE DESIGN AND NOWHERE IN THE DATABASE.** Seal a fixture plaintext
  containing `FATHOM-CANARY-<32 hex from getrandom>`, store it, then `pg_dump --data-only` the
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
  blob from a fixture file; `read_one_design` starts cold, takes the ids **from the database**
  (never from the writer), and opens the blob to byte-identity with the same fixture. **Watched to
  fail:** run the reader with `FATHOM_MASTER_KEY_FILE` pointing at a different key file and require
  `WrapError::Refused` — not a panic, not a partial read. **A silently skipped database test is a
  pass wearing a disguise**, so both binaries print a RAN marker, the evidence script asserts the
  marker appears, and the script asserts an **exact check count** so a check that quietly stops
  running changes the count and fails.

* **G7 — THE CUSTODY SWITCH, PROVED BY BYTES.** Record `design.wrapped_key` and
  `design_blob.sealed` exactly. Run the switch `file:K1 → file:K2` as `add_wrapping` then
  `drop_wrapping`. Assert, in this order: at the midpoint **both wrappings exist and each opens the
  blob independently**, proved by building a registry containing one provider at a time;
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
  **(c)** dispatch on the **row's own** `wrap_provider`: a registry holding both providers reads a
  `file`-wrapped row and a `mock`-wrapped row in the same transaction; a registry holding only one
  returns `UnknownProvider` for the other's row and **never falls back to the configured provider**.
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
  State in the evidence file what this does **not** prove: a `tenant_key` row surviving in a
  database dump defeats it, and where that dump lives is `OPEN-FOR-THE-OWNER.md` §B3.

* **G10 — MISBINDING IS REFUSED, FOUR WAYS, EACH BY EDITING A REAL ROW IN SQL.**
  **(a)** move design A's `sealed` into design B's row: the open fails, because the AAD
  reconstructed from B's own primary key does not match.
  **(b)** move tenant A's `tenant_key.wrapped` into tenant B's row: **`WrapError::Misbound`
  specifically**, not a generic decrypt failure — this is what proves the binding lives inside the
  wrapped plaintext rather than in a provider's context channel, and it is what lets a provider
  with no associated-data channel still be bindable.
  **(c)** flip one bit of `sealed`: refused.
  **(d)** flip one bit of `commit`: refused, and **distinguishable from (c)** — which is what the
  commitment tag buys and what ADR-0014's branch-on-both-results shape is for.
  **Watched to fail:** the unmodified rows open in the same run, so a build that refuses everything
  cannot pass.

* **G11 — D7 AT THE TYPE LEVEL.** Three properties, each mechanical and each about code that
  actually exists:
  **(i)** `Store`'s public write API takes **no integer parameter at all** — only `TenantId`,
  `DesignId`, `KeyEpoch`, `ProviderName`, `WrapKeyId`, `WrappedKey`, `Sealed` and `AadVersion` —
  asserted by an API test and by G5's census.
  **(ii)** `store.rs` is the **only** module in the crate that names a SQL verb, asserted by a
  source-reading test in G5's style. **Watched to fail:** a fixture patch calling `client.execute`
  from `health.rs`.
  **(iii)** `WrappedKey` and `Sealed` expose no `len()`, and no type named for a plaintext length
  exists anywhere in the crate — asserted by a source-reading test over `keys/` and `store.rs`.
  **A `LengthBucket` type is deliberately NOT shipped.** A type with no constructor from any
  `usize` is a type nothing can produce: dead code wearing a gate's clothes, and closer to the
  comment D7 explicitly rejected than to a persistence layer that cannot misuse a length. When a
  gate finding is first recorded, the order that records it chooses the buckets — from what a
  device accepts, per CLAUDE.md rule 0, never from what a detector needs — and that is §7 trigger 7.

* **G12 — THE SERVER REFUSES RATHER THAN IMPROVISES.** Six driven refusals, each with its message
  checked: no `FATHOM_MASTER_KEY_PROVIDER` set; an unknown provider name, with the message naming
  what **is** built; a key file at mode 0644, naming the path and the octal mode; a key file whose
  `key` line is not 64 hex characters, or is all zero; the repository's own fixture key, refused
  **by value** so a copy-pasted example cannot become production; and a `master_key_probe` row that
  the configured key file cannot open — **refuse to start**, rather than start and fail every
  request. **Watched to fail:** with all six corrected, the server starts and G6 passes in the same
  script.

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
  Round-trip plus a refusal set: bad magic, unknown suite byte, non-zero reserved bytes, a
  truncated envelope, an envelope one byte short of the tag, a plaintext one byte over
  `MAX_SEALED_LEN`, and a `bytea` of length zero. Each returns a distinct named error; **none
  panics** — which matters more here than usual, because the server runs under `[profile.server]`
  with `panic = "unwind"` precisely so one bad row does not end the process for every connected
  user (WO-11 §9.5). Plus §4.3's invariant, two tests: sealing the same plaintext twice under the
  same key produces different salts and different ciphertext; and `32` §5.4's own cheapest test —
  10⁶ seals, 10⁶ distinct salts.

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
10. **A real design blob exceeds `MAX_SEALED_LEN` (32 MiB).** Raising it is a planning decision
    about memory per request and about whether the blob should be chunked at all, which is `49`
    §7's territory. **Stop.**
11. **`35` §5.1's caps.** This order takes the lockfile from 115 to ~123 against ≤ 160, with
    sessions, passwords, passkeys, TOTP, SSO, mail, rate limiting and the audit chain still to come.
    **WO-11 §9.7 already escalated this and named three routes; restate the new number and pick
    none of them.** Trigger 3's one prohibition still binds: the number is never met by removing a
    control.
12. **The cryptographic construction itself.** `32` owns the scheme (precedence,
    `.context/conventions.md`). If execution finds a reason to deviate from `32` §5.3's suite — a
    different nonce discipline, a different KDF, dropping key commitment — that is a **Disagreements
    entry against `32`**, and this order may **not** ship a second specification in the meantime.

## 8. Non-goals

This order deliberately does **not** build:

- **Any HTTP endpoint.** `/health` remains the only one. "End to end" here is two processes against
  a real database, not a request.
- **Accounts, sessions, sign-in, roles, sharing, invitations or sign-up.** The next order, and it
  needs answers this order must not invent.
- **Row-level security**, though every table carries `tenant_id` so it stays free later, and the
  migration quotes `49` §11's four rules.
- **Any graph table or projection.** `49` §7's `node`/`edge`/`field`/`provenance` shape and the
  generated projections are a later order's; the blob is opaque precisely so nothing here forecloses
  them.
- **A key cache.** Every read unwraps. Cheap for a file provider, a network round trip per read for
  a KMS — and the cost should be **visible** the day one is chosen rather than hidden behind a cache
  built before anyone measured it. Adding one is a decision about how long a plaintext key may live
  in process memory, which touches §B2 and §B3.
- **A second real provider.** The mock is a test double and says so in its own module comment.
- **Key rotation as a feature.** The four-part primary key makes it the same mechanism as the
  custody switch; naming that now is free, building a rotation schedule is not this order.
- **An audit log, an operator decrypt tool, a support view or a break-glass path** — §7 triggers 6
  and 3.
- **Any tenant or design name, label or free text.** The first plaintext column is a decision, not
  a convenience.
- **Blob history, versions, or optimistic concurrency.** One row per design.
- **Anything client-side.** No schema change (ADR-0008 is not engaged: none of this is the
  network's data — `70` §18.2), no WASM change, and G1 proves it.

## Failure modes

| failure | what stops it |
|---|---|
| the key boundary is "added later" and never is | this order, and ADR-0040 §8's first row |
| a custody switch turns out to need re-encrypting the data | G7 and G8(b), asserting byte-identity of `design.wrapped_key` and `design_blob.sealed` across both a same-provider and a **cross-provider** switch |
| the provider boundary is argued and never demonstrated | **G8** — a second, differently-shaped provider round-tripping the same rows with no DDL. This is the failure the winning design of this order's authoring workflow actually had, and it is why G8 exists as a separate gate from G7 |
| the switch is described as incremental but the shipped shape cannot do it | the four-part primary key on `tenant_key`, and G7's midpoint assertion that both wrappings open the blob independently |
| a row swap succeeds because the binding lived in the provider's context channel | G10(b), which requires `Misbound` specifically, and the binding living inside the wrapped plaintext |
| customer plaintext lands in a column | G4's canary and its positive control; G5's census |
| a length oracle returns on the server | G5's `INTEGER_COLUMNS` rule and G11's three properties, with `secret_len integer` watched to fail |
| D4 is claimed and a leftover escrow row defeats it | G9(a), which leaves one behind on purpose and demonstrates the failure before proving the fix |
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
6. **Backups** — §B3, and it is the named hole in G9.
7. **Who sees what, and whether a stranger may sign up** — §B4, §B5.

## Sources consulted

| source | for | read |
|---|---|---|
| `docs/90-decisions/adr-0040-*.md` | D1–D8, §6's forbidden sentences, §7's must-stay-true list, §9's open items | 2026-09-04 |
| `docs/70-ops/79-work-orders/WO-11-*.md` §6, §8, §9 | the house style, the gate discipline, G8 which this supersedes, §9.7's escalation | 2026-09-04 |
| `docs/40-stack/49-the-server-product.md` §7, §11, §19, §22 | the storage shape not built here, RLS's four rules, phase ordering, the closed decisions | 2026-09-04 |
| `docs/70-ops/70-owner-answers-and-standing-priorities.md` §18.1, §18.2 | the delegation of key custody, verbatim; tenancy outside the graph, verbatim | 2026-09-04 |
| `docs/30-security/32-cryptography.md` §5.2–§5.6 | the AEAD decision, the salt/zero-nonce construction, the nonce-uniqueness argument, the commitment tag. **`32` owns this construction** | 2026-09-04 |
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
   enough to be read in one sitting: five tables, 25 columns, no endpoint, no roles.

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
   from a projection into a measurement.
