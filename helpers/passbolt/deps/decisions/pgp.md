# `pgp` (rpgp) — recorded 2026-10-26, for the Passbolt helper only

| | |
|---|---|
| **Job** | OpenPGP for Passbolt: make Fathom's Curve25519 key, sign and encrypt the sign-in challenge to the Passbolt server's key, open what Passbolt seals to Fathom's key and to its shared metadata key, check the server's signatures |
| **Version** | `=0.21.0`, `default-features = false` (no `bzip2`), the newest release on 2026-10-26 |
| **Publisher** | the rpgp project, by repository URL (`https://github.com/rpgp/rpgp`); the publisher caveat applies |
| **Licence** | `MIT OR Apache-2.0` |
| **Ships or tooling** | **Ships, in the helper's image only** (`deploy/passbolt-helper.Dockerfile`). Not in Fathom's lockfile, its server or its browser module |
| **`build.rs`** | None in `pgp` itself; 17 in its closure (`00-CLOSURE.md`) |
| **Proc macros** | None in `pgp` itself; 12 in its closure |
| **`unsafe`** | One occurrence of the word in `src` (counted 2026-10-26) |

## Why not first-party

OpenPGP's packet formats, its S2K, its legacy ECDH key wrap and its signature hashing are a lot
of careful code. The owner was offered a hand-written Curve25519-only reader (r34-passbolt v1 and
v2, option D) and chose rpgp in a locked-down helper (v2 B).

## Approval

The owner, 2026-10-26: r34-passbolt v2, answer B (Curve25519 only, rpgp in a locked-down helper),
and r34-passbolt-crates, answer A (the 124 packages, as an optional thing). Then, on 2026-10-26
after PR #202 stated it, "Approved" for the closure as measured in the helper's own lockfile: 152
packages, 17 with a `build.rs`, past C4.

## The rule it runs under

Every private-key step is refused unless the key is Curve25519 throughout
(`helpers/passbolt/src/lib.rs`, `curve25519_only`), so the two advisories against its closure,
RUSTSEC-2023-0071 (rsa) and RUSTSEC-2026-0387 (crypto-bigint 0.5.5), are never on a private key's
path. Their reasoned ignores are in `helpers/passbolt/deny.toml` and the gate script.

## Advisories

**Checked 2026-10-26**: `cargo audit` over the helper's lockfile reports exactly those two;
`cargo deny --locked check` with the helper's `deny.toml` reports `advisories ok, bans ok,
licenses ok, sources ok`. A result, not a clean bill of health.
