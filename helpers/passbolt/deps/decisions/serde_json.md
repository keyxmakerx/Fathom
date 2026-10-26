# `serde_json` — recorded 2026-10-26, for the Passbolt helper only

| | |
|---|---|
| **Job** | Reading and writing the helper's socket messages, one small JSON object each way |
| **Version** | `=1.0.154` |
| **Publisher** | serde-rs, by repository URL (`https://github.com/serde-rs/json`); the publisher caveat applies |
| **Licence** | `MIT OR Apache-2.0` |
| **Ships or tooling** | **Ships, in the helper's image only** |
| **`build.rs`** | Yes: it probes the compiler version only |
| **Proc macros** | None (no `derive` is used) |

Already in rpgp's closure; named directly for the socket. Fathom's own server keeps its own JSON
parser (`fathom_canon`, `foreign_json`) and never takes this crate. Approved with rpgp
(r34-passbolt-crates A, 2026-10-26).
