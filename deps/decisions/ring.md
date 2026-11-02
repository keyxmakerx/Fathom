# `ring` — recorded 2026-10-26. **C7's one exception**

| | |
|---|---|
| **Job** | The cryptography under `rustls` for the outside-vault client, and nothing else |
| **Version** | `0.17.14`, transitive, through `rustls`'s `ring` feature |
| **Publisher** | Brian Smith, by repository URL (`https://github.com/briansmith/ring`); the publisher caveat in `00-CLOSURE-SERVER.md` applies |
| **Licence** | `Apache-2.0 AND ISC` — both on `deny.toml`'s allow list |
| **Ships or tooling** | **Ships.** Linked into `fathom-server` only |
| **`build.rs`** | **Yes, 1,044 lines**: it compiles ring's C and assembly with `cc` at build time. This is what C7 bans |
| **Proc macros** | None |
| **`unsafe`** | Yes, about 230 uses in `src` (counted 2026-10-26), the boundary to its C and assembly |

## The exception, in the owner's words

ADR-0032's C7 says no C or C++ in the shipped closure. On 2026-10-26 the owner answered sign-off
card r34-vault-ring with A: *"ring is allowed only underneath rustls, and only for the server's
outbound HTTPS to outside vaults. Please record that exception and keep the ban everywhere
else."* This file is that record. `deny.toml` keeps `[[bans.deny]] name = "ring"` and adds
`wrappers = ["rustls", "rustls-webpki"]`, so ring under any other parent still fails the build,
and only `src/vault_outside/https.rs` names rustls.

### Widened 2026-11-02: SMTP to the operator's relay

On 2026-11-02 the owner approved sign-off card r85-email with A on the mail library: *"lettre,
with only its SMTP parts, over the rustls and ring already in Fathom … ring's one exception grows
from 'HTTPS to outside vaults' to 'and SMTP to your mail server'"* (ADR-0085 decision 9). So ring
is allowed under rustls for two uses: outbound HTTPS to outside vaults, and outbound SMTP to the
relay set in the console's `smtp` setting. `wrappers` does not change, because `lettre` reaches
ring only through rustls. A third use still needs its own decision. `lettre` and what it brings
get their own records when the client is built.


## Why not the alternatives

- **`aws-lc-rs`**, rustls's default provider: more C than ring, and a CMake build. Still banned.
- **A pure-Rust provider** (`rustls-rustcrypto`): its README says "DO NOT USE THIS IN PRODUCTION"
  (github.com/rustcrypto/rustls-rustcrypto, read 2026-10-26).
- **No server-side request at all**: Vaultwarden's API does not answer a cross-origin browser, so
  the browser cannot read the vault from Fathom's page.

## What else it brings

`untrusted` (its input parser, pure Rust), `getrandom 0.2` (beside the server's own 0.4; a
`[[bans.skip]]` names it), and at build time `cc`, `find-msvc-tools` and `shlex`. On Windows only,
`windows-sys 0.52` and its target crates, absent from the Linux build. `cc` and `find-msvc-tools`
are pinned below their newest releases for the seven-day cooldown.

**It also pushes two of ADR-0032's caps past their numbers**, measured 2026-10-26 and said here
rather than smoothed over: the closure is 171 packages against C2's 160 (161 counting only what
compiles for Linux), and 22 crates carry a `build.rs` against C4's 12 (14 on Linux, ring and
rustls the new two). No script enforces either cap today.

## Advisories

RustSec lists RUSTSEC-2025-0009 (patched from 0.17.12, below this pin) and two informational
"unmaintained" notices, RUSTSEC-2025-0007 (since updated to "back to normal") and 2025-0010 (only
versions before 0.17). `cargo audit` over the lockfile, 2026-10-26: no vulnerability.

## Approval

Sign-off cards r34-vault-ring (A) and r34-vault-crates24 (A), 2026-10-26.
