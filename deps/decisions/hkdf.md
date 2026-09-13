# `hkdf` — recorded 2026-09-12

| | |
|---|---|
| **Job** | Key derivation for the tamper-evident history: the per-design chain key from the chain master, and `K_seal` / `K_content` from that (`docs/PHASE-2-STORAGE-DESIGN.md` §12.2) |
| **Version** | `0.13.0`, `default-features = false` |
| **Publisher** | RustCrypto — by repository URL (`https://github.com/RustCrypto/KDFs/`); the publisher caveat in `deps/decisions/00-CLOSURE-SERVER.md` applies |
| **Licence** | MIT OR Apache-2.0 — compatible with ADR-0004 |
| **Ships or tooling** | **Ships.** Linked into `fathom-server` |
| **`build.rs`** | None (`build = false` in its own manifest) |
| **Proc macros** | None |
| **Determinism** | Deterministic: same PRK, same `info`, same output. No clock, no RNG |
| **`unsafe`** | `unsafe_code = "forbid"` in the crate's own lint table |

## The one genuinely new crate of Phase 2's four roles

§12.4's table: the AEAD brings six (seven with `zeroize`), the MAC and the hash bring none because
the PostgreSQL driver already carries them, the CSPRNG brings none, and this brings **one**. Its
only dependency is `hmac`, which is already here.

## Expand only, and why that is not a shortcut

`src/crypto.rs` calls `Hkdf::from_prk`, never `Hkdf::new` — §12.1: *"the chain key is already
uniform, so extract is skipped."* Extract exists to condition a non-uniform secret; running it on
32 uniformly random bytes with no salt would be a second HMAC and no more. **RFC 5869 §3.3, which
is the text that says so, was not read** — the proxy blocked the IETF on 2026-09-12 and §12.7
lists it as unestablished.

## Why not first-party

`32` §15, and one specific trap: the reason this crate is here rather than a hand-written
`HMAC(key, info || counter)` is that the counter, the `0x01` suffix and the chaining of `T(n)` are
easy to get subtly wrong and impossible to notice, because a wrong KDF still produces
32 pseudorandom-looking bytes that work perfectly until the day something else has to derive the
same key.

## Advisories

**Checked 2026-09-12 against a working control**: `cargo audit` (RustSec, 1,243 advisories) over
the whole lockfile — 0 vulnerabilities, 0 warnings, 140 crates — and `cargo deny --locked check`
reported `advisories ok, bans ok, licenses ok, sources ok`. A result, not a clean bill of health,
and it goes stale immediately.
