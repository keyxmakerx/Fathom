# `getrandom` — recorded 2026-11-02, for the device reader only

| | |
|---|---|
| **Job** | The operating system's random source, for the first AES salt and message id. RFC 3826 §3.1.2.1 asks only that a salt be unique; a random start keeps two reader restarts from repeating one |
| **Version** | `=0.4.3`. r87 measured `=0.3.4`; on 3 November 2026 the reader moved to 0.4.3, the version russh's RustCrypto keys already pull in, so one copy is built instead of two (ring keeps its own 0.2, skipped in `deny.toml`). The job and the publisher are unchanged |
| **Publisher** | rust-random, by repository URL (`https://github.com/rust-random/getrandom`); the publisher caveat applies |
| **Licence** | `MIT OR Apache-2.0` |
| **Ships or tooling** | **Ships, in the reader's image only** |
| **`build.rs`** | Yes: it detects the target platform only |
| **Proc macros** | None |

If the source fails the reader falls back to the clock. Approved with the reader's packages on sign-off card r87-reader-packages (2026-11-02),
question 1 A: Fathom's own SNMPv3 reader on the standard RustCrypto pieces, with no MD5, no DES
and no "set".
