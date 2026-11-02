# Accepted one-edit crate-name pairs, in the device reader's lockfile

The same gate as Fathom's own (`deps/decisions/00-LOOKALIKES.md` has the reasoning), run over
`helpers/reader/Cargo.lock`. The SNMP and SSH parts add their pairs here, each with the repository it was read from.

<!-- lookalikes:accepted -->

| a | b | why the pair is real |
|---|---|---|
| `sha1` | `sha2` | Both RustCrypto's, both in `RustCrypto/hashes` (each crate's `repository`, read from its manifest 2026-11-02), both named directly in this reader's `Cargo.toml` with their own records here: SHA-1 for HMAC-SHA-96, SHA-2 for RFC 7860's protocols. The same pair, with the same reasoning, is accepted in Fathom's own `deps/decisions/00-LOOKALIKES.md`. |

<!-- lookalikes:end -->
