# `russh` — recorded 2026-11-03, for the device reader only

| | |
|---|---|
| **Job** | The SSH client for reads (ADR-0082 §4.1): key exchange, the host key check, one password or Ed25519/ECDSA key login, and one `exec` per command from the fixed list. No PTY, shell, agent or forwarding is ever asked for |
| **Version** | `=0.65.1` (12 Nov 2026), the security release after the `0.65.0` measured for the owner on r87: it fixes GHSA-9264-jvgf-6w2f (`kex_done` ran before the host key check; affected 0.55.0 to 0.65.0) and GHSA-736f-c93q-9fwx (agent), read in the 0.65.1 release notes and the first advisory's own page on 12 Nov 2026. The reader leaves `kex_done` at its default and uses no agent. The May 2026 advisories (RUSTSEC-2026-0153, RUSTSEC-2026-0154) were fixed in 0.60.3 |
| **Features** | `ring` and `rsa` only, no defaults: no `aws-lc-rs` (a C library built at compile time, r87 option C), no `flate2` compression |
| **Publisher** | The warp-tech maintainers, by repository URL (`https://github.com/warp-tech/russh`); the publisher caveat applies |
| **Licence** | `Apache-2.0` |
| **Ships or tooling** | **Ships, in the reader's image only** |
| **`build.rs`** | No |
| **Proc macros** | None of its own; `delegate` and `enum_dispatch` arrive with it (00-CLOSURE.md) |

Why not first-party: SSH's transport, key exchange and ciphers are not something to write by hand
for a security tool. russh is the only pure-Rust SSH client in wide use (r87). Approved with the
reader's packages on sign-off card r87-reader-packages (2026-11-02), question 2 A and its three
ticks: the rsa advisory RUSTSEC-2023-0071 (the reader checks RSA host keys and never signs with an
RSA private key: `Login::key` refuses one), the release candidates `rsa 0.10.0-rc.18` and
`ssh-key 0.7.0-rc.11`, and the measured size.

Tested against a real OpenSSH server (`tests/ssh.rs`, `scripts/ci/reader-sshd.sh`).
