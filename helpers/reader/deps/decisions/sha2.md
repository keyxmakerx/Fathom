# `sha2` — recorded 2026-11-02, for the device reader only

| | |
|---|---|
| **Job** | SHA-256 and SHA-512 for usmHMAC192SHA256 and usmHMAC384SHA512 and their key localisation (RFC 7860), and the SHA-256 digest over each reading |
| **Version** | `=0.11.1`, the version measured for the owner on r87 |
| **Publisher** | RustCrypto or its maintainers, by repository URL (`https://github.com/RustCrypto/hashes`); the publisher caveat applies |
| **Licence** | `MIT OR Apache-2.0` |
| **Ships or tooling** | **Ships, in the reader's image only** |
| **`build.rs`** | No |
| **Proc macros** | None |

Fathom's server carries `sha2` for its seals (`deps/decisions/sha2.md`). Approved with the reader's packages on sign-off card r87-reader-packages (2026-11-02),
question 1 A: Fathom's own SNMPv3 reader on the standard RustCrypto pieces, with no MD5, no DES
and no "set".
