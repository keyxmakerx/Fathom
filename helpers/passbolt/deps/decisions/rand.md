# `rand` — recorded 2026-10-26, for the Passbolt helper only

| | |
|---|---|
| **Job** | The random source rpgp's key generation and encryption take (`thread_rng`, from the operating system through `getrandom`) |
| **Version** | `=0.8.8`, the 0.8 line rpgp 0.21.0 itself depends on, so no second copy |
| **Publisher** | rust-random, by repository URL (`https://github.com/rust-random/rand`); the publisher caveat applies |
| **Licence** | `MIT OR Apache-2.0` |
| **Ships or tooling** | **Ships, in the helper's image only** |
| **`build.rs`** | None |
| **Proc macros** | None |

Named directly only because rpgp's API takes an `Rng`; it was already in rpgp's closure.
Approved with it (r34-passbolt-crates A, 2026-10-26).
