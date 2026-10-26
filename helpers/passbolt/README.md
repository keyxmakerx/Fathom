# Fathom's Passbolt helper

OpenPGP for Fathom's Passbolt connections, kept out of the server (ADR-0071 25–30, the owner's
r34-passbolt v2 B and r34-passbolt-crates A). It is optional: it runs only when an operator starts
compose with `--profile passbolt`.

- **Its own workspace.** `Cargo.lock`, `deny.toml` and `deps/` here are separate from Fathom's.
  Nothing in this folder is in the server's lockfile. `scripts/gate-passbolt-helper.sh` runs the
  dependency gates against this lockfile; the CI job `passbolt-helper` runs that, fmt, clippy, the
  tests (against GnuPG) and a ping through the built image.
- **Curve25519 only for private keys.** `curve25519_only` in `src/lib.rs` refuses any secret key
  that is not Ed25519/X25519 throughout. Public keys of any algorithm are accepted for encrypting
  and checking signatures.
- **No keys held.** Every request carries what it needs; nothing is written to disk.
- **The protocol.** One Unix socket (`FATHOM_PASSBOLT_SOCKET`, default
  `/run/fathom-passbolt/helper.sock`, mode 0600). Each frame is a 4-byte big-endian length then
  JSON, at most 1 MiB. Requests: `ping`, `make_key {uid}`, `seal_for {secret, to, plain}`,
  `open {secret, password?, data, signer?}`, `key_info {key}`. Answers are `{ok: true, ...}` or
  `{ok: false, error}`. Unknown fields are refused.

```
cargo test --locked --manifest-path helpers/passbolt/Cargo.toml
./scripts/gate-passbolt-helper.sh
```
