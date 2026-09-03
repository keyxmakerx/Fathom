# The measured closure — 2026-08-15

`cargo tree --edges normal` over `argon2 0.5` and `chacha20poly1305 0.10`, both with
**`default-features = false`**, which is load-bearing rather than tidy — see below.

<!-- gate-zero:closure approved-by="the owner" date="2026-08-15" -->

| crate | how it arrives |
|---|---|
| `argon2` | chosen — `deps/decisions/argon2.md` |
| `chacha20poly1305` | chosen — `deps/decisions/chacha20poly1305.md` |
| `aead` | transitive |
| `base64ct` | transitive |
| `blake2` | transitive |
| `block-buffer` | transitive |
| `cfg-if` | transitive |
| `chacha20` | transitive |
| `cipher` | transitive |
| `cpufeatures` | transitive |
| `crypto-common` | transitive |
| `digest` | transitive |
| `generic-array` | transitive |
| `inout` | transitive |
| `opaque-debug` | transitive |
| `password-hash` | transitive |
| `poly1305` | transitive |
| `rand_core` | transitive |
| `subtle` | transitive |
| `typenum` | transitive |
| `universal-hash` | transitive |
| `zeroize` | transitive |

<!-- gate-zero:end -->

**Twenty-two crates.**

> **The markers above are new (2026-09-03, WO-11 §5 step 1) and the list is not.** The names,
> the measurement and the approval date are unchanged; what changed is that
> `scripts/gate-zero.sh` can now READ them, so this document is a gate entry rather than a
> record of one. The two crates marked *chosen* keep their individual records regardless —
> the gate requires a record for every direct dependency and a closure never covers one.
> Neither crate is vendored, so nothing here is currently admitting anything: this document
> was made machine-readable while it was still inert, which is the only safe time to do it. Against `35` §5.1's caps: C2 is ≤ 160 total (22 ✓).

## Why `default-features = false` is a security control, not a preference

With default features ON the closure is **24** crates and the two extra are `getrandom` and `libc`.
`getrandom` on `wasm32-unknown-unknown` resolves to a **host import** — which would put an entry in
the module's import section, and `crates/fathom-wasm/src/wasmbin.rs` pins
`IMPORT_ALLOWLIST: &[&str] = &[]` with a test that fails on any import at all.

So the feature flag is what keeps invariant 1 mechanically true. ADR-0032 item 4 names this exact
path — *"the concrete path from 'we need randomness' to 'the module can make a network request'"* —
as **"the single most likely way an automated session breaks invariant 1 while following the
documents."** It does not apply here because the module takes its salt and nonce from the host in
the frame, exactly as `OP_PASTE` already takes its clock and entropy. **Nothing in the crypto path
may ever call an RNG itself.**

## Advisories

Checked against a fresh clone of `RustSec/advisory-db` on 2026-08-15. **Zero open advisories across
all twenty-two.** Three historic ones exist and all are patched far below the versions in use:

| | Advisory | Patched | In use |
|---|---|---|---|
| `chacha20` | RUSTSEC-2019-0029 | ≥ 0.2.3 | 0.9.1 |
| `blake2` | RUSTSEC-2019-0019 | ≥ 0.8.1 | 0.10.6 |
| `generic-array` | RUSTSEC-2020-0146 | ≥ 0.13.3 | 0.14.7 |

## The honest weaknesses

1. **Publisher concentration.** Effectively all twenty-two are RustCrypto. That is good — real
   cryptographers, consistent review, constant-time discipline — and it is also a single point of
   compromise. `35` §5.1's C3 caps *publishers*, and one is not a violation of a cap but it is a
   concentration worth naming.
2. **`argon2` has no security audit.** See its record.
3. **Gate zero checks that a record exists, not that it is true.** ADR-0034 §4's mechanical
   vulnerability scan is still not in CI. The advisory check above was done by hand, once.
