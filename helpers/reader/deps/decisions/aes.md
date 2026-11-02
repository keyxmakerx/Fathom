# `aes` — recorded 2026-11-02, for the device reader only

| | |
|---|---|
| **Job** | AES-128, the block cipher under SNMPv3's privacy (RFC 3826) |
| **Version** | `=0.9.3`, the version measured for the owner on r87 |
| **Publisher** | RustCrypto or its maintainers, by repository URL (`https://github.com/RustCrypto/block-ciphers`); the publisher caveat applies |
| **Licence** | `MIT OR Apache-2.0` |
| **Ships or tooling** | **Ships, in the reader's image only** |
| **`build.rs`** | No |
| **Proc macros** | None |

The reader never uses AES on its own: only through `cfb-mode`. Approved with the reader's packages on sign-off card r87-reader-packages (2026-11-02),
question 1 A: Fathom's own SNMPv3 reader on the standard RustCrypto pieces, with no MD5, no DES
and no "set".
