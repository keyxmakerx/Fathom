<!--
The lockfile rule below is the only mandatory section, and only when it applies.
Everything else is a prompt, not a form. Delete what does not apply.
-->

## What changed, and why

## How it was verified

<!-- The floor (78 §6), plus the executing work order's own acceptance gates.
     Paste the numbers, not the adjective: "751 tests" beats "tests pass". -->

---

## Does this pull request change `Cargo.lock`?

**If no, delete this whole section.**

**If yes, this section is mandatory and a reviewer must read it before approving.**
This is layer 4 of the five in WO-11 §5 step 0, and it is the only one of the five
that is a human habit rather than a program — and **it is the one that would have
caught the August 2026 crates.io attack.**

That attack worked like this: poisoned versions of `arrayref`, `internment` and
`append-only-vec` each depended on **`proc-macro1`, a typosquat of the near-universal
`proc-macro2`**, whose build script downloaded and executed a payload — so merely
compiling was enough. The releases were **deleted 86 to 107 minutes after publication
rather than yanked with an advisory**, so no advisory database has anything to match
and `cargo audit` returns clean for anyone who built in that window. Every
advisory-keyed tool is defeated by construction by *publish, wait, delete*.
RUSTSEC-2026-0260, published 2026-08-20.

A new entry named `proc-macro1` beside `proc-macro2` is invisible to a scanner and
impossible to miss on sight. So:

**Every crate added to `Cargo.lock`, by name and version:**

<!-- List them. All of them, transitive included. `git diff <base> -- Cargo.lock` is
     the source; do not summarise it as "the usual tokio tree". -->

- [ ] Every added crate is either individually recorded in `deps/decisions/` or named
      inside the markers of an approved closure document there (`scripts/gate-zero.sh`
      enforces this, and a **direct** dependency always needs its own record).
- [ ] I have read the added names **as names** and none is one character from a name
      I already know. (`scripts/lockfile-lookalikes.sh` checks the pairs that are both
      in the lockfile; a squat whose target is not also in the graph is yours to catch.)
- [ ] The closure size is recorded against `35` §5.1's caps: **≤ 30 direct, ≤ 160 in
      the closure.**
- [ ] No `cargo-deny` `ignore` or licence exception was added. If one was, it is
      justified in this description with a name and a date — and WO-11 §7 trigger 5
      says an advisory with no patched version is an **escalation**, not an ignore line.
- [ ] `COOLDOWN_DAYS` was not lowered. If it was, the reason is written here.

## Does this pull request touch the ingest gate, the redaction path, or a security claim?

**If no, delete this section.**

- [ ] **CLAUDE.md rule 0**: any new redaction test is written against **what a device
      accepts**, not against what the detector needs — the statement's real bounds were
      looked up, with the source and the date named.
- [ ] **ADR-0034**: no security claim in this description or in the code comments is
      answered from memory. Sources and dates are named.
- [ ] **`38` §14's union rule**: nothing here reduces what the ingest gate destroys.
