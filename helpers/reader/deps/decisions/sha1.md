# `sha1` — recorded 2026-11-02, for the device reader only

| | |
|---|---|
| **Job** | SHA-1 for HMAC-SHA-96 and its key localisation (RFC 3414 A.2.2), the oldest protocol the reader accepts, marked *older* on the login (ADR-0082 §4.5) |
| **Version** | `=0.11.0`, the version measured for the owner on r87 |
| **Publisher** | RustCrypto or its maintainers, by repository URL (`https://github.com/RustCrypto/hashes`); the publisher caveat applies |
| **Licence** | `MIT OR Apache-2.0` |
| **Ships or tooling** | **Ships, in the reader's image only** |
| **`build.rs`** | No |
| **Proc macros** | None |

Fathom's server carries the same version for RFC 6238 app codes (`deps/decisions/sha1.md`). Approved with the reader's packages on sign-off card r87-reader-packages (2026-11-02),
question 1 A: Fathom's own SNMPv3 reader on the standard RustCrypto pieces, with no MD5, no DES
and no "set".
