# Accepted one-edit crate-name pairs, in the Passbolt helper's lockfile

The same gate as Fathom's own (`deps/decisions/00-LOOKALIKES.md` has the reasoning), run over
`helpers/passbolt/Cargo.lock`. Each pair below was named on sign-off card r34-passbolt-crates,
which the owner answered A on 2026-10-26, and each crate's repository was read from `cargo
metadata` that day (`00-CLOSURE.md`). Every one is reached through rpgp's declared tree, not by
a name nobody chose.

<!-- lookalikes:accepted -->

| a | b | why the pair is real |
|---|---|---|
| `aes` | `des` | Both RustCrypto `block-ciphers`, MIT OR Apache-2.0: AES and DES, the ciphers' own names. rpgp compiles in every cipher OpenPGP defines; Fathom chooses AES-256. |
| `der` | `des` | `der` is RustCrypto `formats` (ASN.1 DER), `des` RustCrypto `block-ciphers`. Different jobs, one publisher. |
| `dsa` | `rsa` | RustCrypto `signatures/dsa` and RustCrypto `RSA`: the two algorithms' own names. Both are compiled in; the helper refuses either for a private key. |
| `cmac` | `hmac` | Both RustCrypto `MACs`: CMAC and HMAC by name. |
| `k256` | `p256` | Both RustCrypto `elliptic-curves`: secp256k1 and NIST P-256 by their usual short names. |
| `pkcs1` | `pkcs8` | Both RustCrypto `formats`: PKCS #1 and PKCS #8 by number. |
| `sha1` | `sha2` | Both RustCrypto `hashes`; the same pair Fathom's own lock accepts. |
| `sha1` | `sha3` | Both RustCrypto `hashes`: the SHA family by generation. |
| `sha2` | `sha3` | Both RustCrypto `hashes`: the SHA family by generation. |
| `libc` | `libm` | `libc` is rust-lang `libc`; `libm` is rust-lang's port of musl's maths library, in `compiler-builtins`. Both rust-lang's own. |

<!-- lookalikes:end -->
