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
| `hyper` | 1.11.1 | 2026-09-10 | **Four HTTP/1 parser fixes, in the area where a differential is a request-smuggling bug.** 1.11.1 (published 2026-08-28, six days before this row) fixes: `TE: trailers` detected caselessly and alongside other values; `\n\r\n` recognised as a head terminator in the partial-read fast path (#4145); bytes buffered by the write re-check flushed before yielding; a pooled connection evicted on a request-side `Connection: close`. Read from hyper's own CHANGELOG on 2026-09-03. None is a filed advisory — that is exactly why holding the version back is not the safe default: pinning to 1.11.0 keeps a server on a *known* set of head-terminator and transfer-encoding parsing behaviours in order to avoid an unproven supply-chain risk in one of the most-watched crates in the ecosystem. The exception is six days long, not open-ended: 1.11.1 clears the window on its own on 2026-09-04. |

<!-- cooldown:end -->

## What was NOT excepted, on the same day, and why

Two other young versions arrived in the same resolution and both were **pinned back instead**,
which is the preferred route:

| crate | young version | pinned to | why no exception |
|---|---|---|---|
| `mio` | 1.2.3, one day old | **1.2.2** (2026-07-13) | 1.2.3 is Wine support, a Unix-domain-socket re-registration fix under `poll(2)`, and a BSD waker change. Nothing security-relevant, and nothing touching the Linux `epoll` path this server runs on. Revisit once 1.2.3 is a week old. |
| `smallvec` | 1.16.0, two days old | **1.15.2** (2026-06-28) | No security content identified, and a `SmallVec` is not on any parsing path here. Nothing is lost by waiting. |

The difference between these two and `hyper` is the whole content of this file: an exception is
for when *waiting* is the riskier choice, not for when waiting is inconvenient.
