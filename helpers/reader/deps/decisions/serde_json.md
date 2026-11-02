# `serde_json` — recorded 2026-11-02, for the device reader only

| | |
|---|---|
| **Job** | Reading and writing the reader's socket messages, one JSON object each way |
| **Version** | `=1.0.154`, the version the Passbolt helper already records |
| **Publisher** | serde-rs, by repository URL (`https://github.com/serde-rs/json`); the publisher caveat applies |
| **Licence** | `MIT OR Apache-2.0` |
| **Ships or tooling** | **Ships, in the reader's image only** |
| **`build.rs`** | Yes: it probes the compiler version only |
| **Proc macros** | None used (no `derive`) |

Fathom's own server keeps its own JSON parser (`fathom_canon`, `foreign_json`) and never takes this
crate. Approved with the reader's packages on sign-off card r87-reader-packages (2026-11-02).
