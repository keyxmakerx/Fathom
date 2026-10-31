# `md-5` — proposed 2026-10-31 for sign-off r62. **Awaiting the owner's approval of this record.**

The owner approved "SHA-512 and MD5 at upload" on sign-off card r62 (30 October). That approves the
feature. ADR-0032 §5 makes approving a crate a separate owner act, so this record waits for it, and
**the crate is not in `Cargo.toml` or `Cargo.lock` yet.** SHA-512 is built without it (`sha2`
already has it).

| | |
|---|---|
| **Job** | One MD5 of each firmware image's bytes at upload, shown beside the SHA-256 and SHA-512, for vendors whose download page gives only an MD5. Nothing else |
| **Version** | `0.11.0`, published 2026-03-27, read off crates.io's API on 2026-10-31. Not yanked. `default-features = false` |
| **Publisher** | RustCrypto (`RustCrypto/hashes`), the same family and repository as the approved `sha2` and `sha1` |
| **Licence** | `MIT OR Apache-2.0`, read off crates.io on 2026-10-31. Compatible with ADR-0004 |
| **Ships or tooling** | **Ships.** Would be linked into `fathom-server` only, named by `src/firmware.rs` only |
| **`build.rs`** | To be read off the fetched source before it is added, as the closure report does |
| **Proc macros** | None among its dependencies |
| **Net new packages in `Cargo.lock`** | **One**: `md-5` itself. Its normal dependencies are `cfg-if ^1` and `digest ^0.11` (crates.io, 2026-10-31), both already here through `sha2` |

## MD5 IS BROKEN, AND THIS RECORD SAYS SO

The crate's own README (`RustCrypto/hashes`, `md5/README.md`, read 2026-10-31) opens with a
security warning: it is *"provided for the purposes of legacy interoperability with protocols and
systems which mandate the use of MD5"*, MD5 is *"cryptographically broken and unsuitable for
further use"*, and *"collision attacks against MD5 are both practical and trivial."*

**So the MD5 is never what protects an image.** The SHA-256 is still the hash Fathom checks the
upload against, re-checks weekly and before every download, and puts in the device's steps. The MD5
is shown so a person can compare it with a vendor page that gives nothing else, and the page says,
next to it, that a match only rules out a damaged download, not a deliberate swap. A collision lets
someone make two files with the same MD5; it does not let them match the SHA-256 as well.

## Audit status

None found, the same gap `sha1.md` names for `RustCrypto/hashes`. Proposed condition, as there: the
implementation is pinned against RFC 1321 §A.5's test suite in a unit test before it ships.
