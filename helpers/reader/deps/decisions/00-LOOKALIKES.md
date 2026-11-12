# Accepted one-edit crate-name pairs, in the device reader's lockfile

The same gate as Fathom's own (`deps/decisions/00-LOOKALIKES.md` has the reasoning), run over
`helpers/reader/Cargo.lock`. The SNMP and SSH parts add their pairs here, each with the repository it was read from.

<!-- lookalikes:accepted -->

| a | b | why the pair is real |
|---|---|---|
| `sha1` | `sha2` | Both RustCrypto's, both in `RustCrypto/hashes` (each crate's `repository`, read from its manifest 2026-11-02), both named directly in this reader's `Cargo.toml` with their own records here: SHA-1 for HMAC-SHA-96, SHA-2 for RFC 7860's protocols. The same pair, with the same reasoning, is accepted in Fathom's own `deps/decisions/00-LOOKALIKES.md`. |
| `aes` | `des` | Both RustCrypto's `block-ciphers` (each crate's `repository`, from 00-CLOSURE.md, 3 Nov 2026). `aes` is the reader's SNMP privacy cipher. `des` is only in the lockfile: russh names it for its optional `des` feature, which the reader does not turn on, so it is never built (`cargo tree --target all -i des` prints nothing). |
| `der` | `des` | `der` is RustCrypto `formats` (ASN.1 DER for keys, through `pkcs1`, `pkcs8` and `spki`); `des` as above. |
| `cbc` | `cc` | `cbc` is RustCrypto `block-modes` (a cipher mode ssh-cipher offers); `cc` is rust-lang's `cc-rs`, the C compiler driver ring's build script uses. Unrelated crates from two known repositories. |
| `pkcs1` | `pkcs5` | All three RustCrypto `formats`, the PKCS standards by number: PKCS #1 (RSA keys, for checking RSA host keys), #5 (password-based key encryption, through `ssh-key`), #8 (private key containers). |
| `pkcs1` | `pkcs8` | As above. Also accepted in the Passbolt helper's 00-LOOKALIKES.md. |
| `pkcs5` | `pkcs8` | As above. |
| `sha1` | `sha3` | Both RustCrypto `hashes`, the SHA family by generation; `sha3` arrives through `ml-kem`, the post-quantum key exchange russh offers. Also accepted in the Passbolt helper's 00-LOOKALIKES.md. |
| `sha2` | `sha3` | As above. |

<!-- lookalikes:end -->
