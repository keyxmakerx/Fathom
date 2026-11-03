# `tokio` — recorded 2026-11-03, for the device reader only

| | |
|---|---|
| **Job** | The runtime russh needs. The reader starts one current-thread runtime per SSH job and drops it after; the socket and SNMP stay on plain threads |
| **Version** | `=1.54.1`, the version russh 0.65.0 resolves to (published 21 Oct 2026, outside the cooldown) |
| **Features** | `rt`, `net` and `time` only; no multi-threaded runtime, no `macros`, no `fs`, no `process` |
| **Publisher** | The Tokio maintainers, by repository URL (`https://github.com/tokio-rs/tokio`); the publisher caveat applies |
| **Licence** | `MIT` |
| **Ships or tooling** | **Ships, in the reader's image only** |
| **`build.rs`** | No |
| **Proc macros** | None used (`tokio-macros` is in the lockfile through russh and not built without `macros`) |

Named directly only so the reader can build the runtime russh runs on; it was already in the set
the owner approved on r87-reader-packages (2026-11-02), question 2 A.
