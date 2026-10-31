# `md-5` — approved by the owner on sign-off card r70, 2026-10-31.

The owner approved "SHA-512 and MD5 at upload" on sign-off card r62 (30 October), which approves
the feature. ADR-0032 §5 makes approving a crate a separate owner act; the owner gave it on card
r70's "OK to add the md-5 library" tick (31 October, 12:38 UTC).

| | |
|---|---|
| **Job** | One MD5 of each firmware image's bytes at upload, shown beside the SHA-256 and SHA-512, for vendors whose download page gives only an MD5. Nothing else |
| **Version** | `0.11.0`, published 2026-03-27, read off crates.io's API on 2026-10-31. Not yanked. `default-features = false` |
| **Publisher** | RustCrypto (`RustCrypto/hashes`), the same family and repository as the approved `sha2` and `sha1` |
| **Licence** | `MIT OR Apache-2.0`, read off crates.io on 2026-10-31. Compatible with ADR-0004 |
| **Ships or tooling** | **Ships.** Linked into `fathom-server` only, named by `src/firmware.rs` (and its integration test) only |
| **`build.rs`** | None. Read off the fetched source on 2026-10-31: its `Cargo.toml` says `build = false` and there is no `build.rs` |
| **Proc macros** | None among its dependencies |
| **Net new packages in `Cargo.lock`** | **None.** Corrected from "one" on 2026-10-31: `md-5 0.11.0` was already in `Cargo.lock` through the PostgreSQL driver (`postgres-protocol`, for PostgreSQL's MD5 password exchange), the same way `hmac` and `sha2` were. Adding it moved it from transitive to DIRECT; the lock file gained one line, the dependency edge |

## MD5 IS BROKEN, AND THIS RECORD SAYS SO

The crate's own README (`RustCrypto/hashes`, `md5/README.md`, read 2026-10-31) opens with a
security warning: it is *"provided for the purposes of legacy interoperability with protocols and
systems which mandate the use of MD5"*, MD5 is *"cryptographically broken and unsuitable for
further use"*, and *"collision attacks against MD5 are both practical and trivial."*

**So the MD5 is never what protects an image.** The SHA-256 is still the hash Fathom checks the
upload against, re-checks weekly and before every download, and puts in the device's steps. The MD5
is shown so a person can compare it with a vendor page that gives nothing else, and the page says,
next to it, that a match only rules out a damaged download, not a deliberate swap. Nothing in the
server compares an MD5.

## Audit status

None found, the same gap `sha1.md` names for `RustCrypto/hashes`. The condition set here is met:
`firmware::tests::the_md5_matches_rfc_1321s_test_suite` pins the implementation against all seven
strings of RFC 1321 §A.5 (rfc-editor.org/rfc/rfc1321, read 2026-10-31), fed in two pieces.
