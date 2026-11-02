# `cfb-mode` — recorded 2026-11-02, for the device reader only

| | |
|---|---|
| **Job** | CFB mode with full-block feedback, which RFC 3826 §3.1.3 names for usmAesCfb128Protocol |
| **Version** | `=0.9.1`, the version measured for the owner on r87 |
| **Publisher** | RustCrypto or its maintainers, by repository URL (`https://github.com/RustCrypto/block-modes`); the publisher caveat applies |
| **Licence** | `MIT OR Apache-2.0` |
| **Ships or tooling** | **Ships, in the reader's image only** |
| **`build.rs`** | No |
| **Proc macros** | None |

Its own documentation warns that CFB does not authenticate; SNMPv3 signs every encrypted message with the HMAC above, and the reader checks that signature before it decrypts. Approved with the reader's packages on sign-off card r87-reader-packages (2026-11-02),
question 1 A: Fathom's own SNMPv3 reader on the standard RustCrypto pieces, with no MD5, no DES
and no "set".
