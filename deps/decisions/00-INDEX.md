# Dependency approval records

`scripts/gate-zero.sh` fails the build if `Cargo.lock` holds an external package with no
`deps/decisions/<crate>.md` beside it. ADR-0032 §5 says what a record must contain and that the
approval is **an owner act**.

| Crate | Job | Approved | Audited |
|---|---|---|---|
| `chacha20poly1305` | Workspace file encryption (`32` D3) | 2026-08-15 | NCC Group, no significant findings |
| `argon2` | Passphrase → key (`32` D1) | 2026-08-15 | **No audit.** Mitigated by RFC 9106 test vectors |

**The other twenty are transitive** and are covered by the two records above rather than by twenty
of their own: they are the RustCrypto trait and primitive crates the two named crates are built out
of, and they arrive and leave with them. `00-CLOSURE.md` lists all twenty-two with the measurement
that produced them. If one ever needs admitting on its own account, it gets its own record.
