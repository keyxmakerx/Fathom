# `hmac` — recorded 2026-11-02, for the device reader only

| | |
|---|---|
| **Job** | The MAC on every SNMPv3 message the reader sends and the check on every answer: HMAC with SHA-1, SHA-256 or SHA-512, cut to 12, 24 or 48 octets (RFC 3414 §7.3.1, RFC 7860 §4.2.1) |
| **Version** | `=0.13.0`, the version measured for the owner on r87 |
| **Publisher** | RustCrypto or its maintainers, by repository URL (`https://github.com/RustCrypto/MACs`); the publisher caveat applies |
| **Licence** | `MIT OR Apache-2.0` |
| **Ships or tooling** | **Ships, in the reader's image only** |
| **`build.rs`** | No |
| **Proc macros** | None |

Fathom's server already carries the same version for its chain MAC (`deps/decisions/hmac.md`). Approved with the reader's packages on sign-off card r87-reader-packages (2026-11-02),
question 1 A: Fathom's own SNMPv3 reader on the standard RustCrypto pieces, with no MD5, no DES
and no "set".
