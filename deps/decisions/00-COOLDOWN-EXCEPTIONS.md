# Cooldown exceptions — crate versions admitted before the window

`scripts/crate-cooldown.sh` refuses any crate version published less than seven days ago. That
window exists because the August 2026 crates.io attack's poisoned releases were **deleted 86 to
107 minutes after publication rather than yanked**, so no advisory database has anything to match
and every advisory-keyed scanner is defeated by construction (RUSTSEC-2026-0260, 2026-08-20).

**There is a real tension in that rule and pretending otherwise is how a gate gets switched off.**
Sometimes the young release is the *safer* one, because it carries a parser fix, and holding it
back trades a known hazard for an unproven one. A row here is how that trade gets made in the
open.

## The rules that keep this file from becoming an exemption list

WO-11 §5 step 0 declined to adopt `cargo vet` on a measurement: the median adopting project still
carries **131 manual exemptions**. An exemption list with no expiry becomes 131 exemptions. So:

1. **A row names a crate AND a version.** It cannot silently cover the next release.
2. **A row expires.** An expired row **fails the build** rather than lapsing quietly.
3. **A row dies when its reason does.** Once the version is old enough on its own, the script
   reports the row as no longer needed and fails until it is removed.
4. **Lowering `COOLDOWN_DAYS` globally to admit one crate is not an option.** This file exists so
   nobody has to.

Set the expiry to the day the version clears the window on its own, plus a small margin — never
months.

<!-- cooldown:exceptions -->

| crate | version | expires | why the young release is the safer one |
|---|---|---|---|
| `ctutils` | `0.4.5` | 2026-11-01 | RUSTSEC-2026-0385 (2026-10-23): before 0.4.4, `Choice`'s mask generation could compile to a branch on secret data, and `u128` constant-time comparisons branched on 32-bit targets. `ctutils::CtEq` is the tag comparison under `hmac` (the chain MAC, `digest` → `ctutils` → `cmov`) and sits under `crypto-bigint`, so under `p256`/`ecdsa` signing. Waiting a week means a week of a known timing leak on the MAC and signing path. **0.4.5, not 0.4.4**, because `crypto-bigint 0.7.6` (row below) requires `ctutils ^0.4.5`. 0.4.5 adds only a `primitives` module and a Thumb-1 comparison hardening on top of 0.4.4 (its CHANGELOG, read from the fetched crate). Published 2026-10-23 04:02 GMT; clears the window on its own 2026-10-30. |
| `crypto-bigint` | `0.7.9` | 2026-11-03 | RUSTSEC-2026-0387 (2026-10-23) is fixed from 0.7.6: subtraction, zero counting, division and Montgomery multiplication could branch on secret values under `p256` scalar and field arithmetic, so under every ES256 signature. **On 2026-10-25 crates.io yanked every 0.7 release from 0.7.0 to 0.7.8**, and `cargo-deny` refuses a yanked pin, so 0.7.6 cannot stay. 0.7.9 is the only live 0.7 release and the only one that is both patched and unyanked. Going back below 0.7.6 would restore the leak, and the older releases are yanked too. The yank is about API compatibility, not a new flaw: the 0.7.9 CHANGELOG says 0.7.6 to 0.7.8 were yanked for a breaking change to the blanket `Mul` impl for `NonZero<T>` (#1373). 0.7.9 reverts that and adds a `shr_vartime` change in `PrimeParams::new_vartime`. It also carries 0.7.7's and 0.7.8's changes (`BoxedUint` inversion, `mul_mod_special` boundaries, const-eval speed), read from the fetched crates and diffed against 0.7.8 on 2026-10-25. `ctutils ^0.4.5` is unchanged and no other lockfile line moves. Published 2026-10-25 19:09 GMT; clears the window on its own 2026-11-01. |
| `rustls-webpki` | `0.103.16` | 2026-10-29 | RUSTSEC-2026-0382 (2026-10-20, CVE-2026-111943, read from the advisory database 2026-10-26): before 0.103.16, certificate verification may accept paths through the distrusted emSign intermediates, whose private keys are now well known. This is the checker under the outside-vault client (`src/vault_outside/https.rs`), so an older release would accept a forged certificate for a person's vault. 0.103.16 is the only patched 0.103 release. Published 2026-10-20 08:58 GMT; clears the window on its own 2026-10-27. |

<!-- cooldown:end -->

**Retired rows** (the table is empty on purpose; this is the record the prose below refers to):
`hyper` 1.11.1, admitted 2026-09-03 for four HTTP/1 parser fixes, cleared the seven-day window on
its own on 2026-09-04 and the gate reported the row stale that day. Removed the same day, as rule
3 requires. The row's full reasoning is in this file's history at `3ca19b9`.
`webpki-roots` 1.0.10, admitted for RUSTSEC-2026-0381 (the emSign ECC Root CA - G3 removal),
cleared the window on its own on 2026-10-26 and the gate reported the row stale that day. Removed
the same day. The row's full reasoning is in this file's history at `9a55417`.

## What was NOT excepted, on the same day, and why

Two other young versions arrived in the same resolution and both were **pinned back instead**,
which is the preferred route:

| crate | young version | pinned to | why no exception |
|---|---|---|---|
| `mio` | 1.2.3, one day old | **1.2.2** (2026-07-13) | 1.2.3 is Wine support, a Unix-domain-socket re-registration fix under `poll(2)`, and a BSD waker change. Nothing security-relevant, and nothing touching the Linux `epoll` path this server runs on. Revisit once 1.2.3 is a week old. |
| `smallvec` | 1.16.0, two days old | **1.15.2** (2026-06-28) | No security content identified, and a `SmallVec` is not on any parsing path here. Nothing is lost by waiting. |

The difference between these two and `hyper` is the whole content of this file: an exception is
for when *waiting* is the riskier choice, not for when waiting is inconvenient.
