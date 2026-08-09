# Contributing to Fathom

> Per ADR-0004, which chose a **Developer Certificate of Origin** over a Contributor Licence
> Agreement. A CLA preserves the option to relicense and costs drive-by contributions; under
> ADR-0003 that option has no buyer, so the option is worth less than the contributors.

## 1. Sign your commits off

Every commit needs a `Signed-off-by` trailer. `git commit -s` adds it:

```
Signed-off-by: Your Name <your.email@example.com>
```

Use your real name and a real address. By adding it you certify the Developer Certificate of
Origin, version 1.1, reproduced in full in §6.

**The existing history predates this.** ADR-0004 was accepted and never executed, so the commits
already in this repository carry no sign-off. They are not retroactively signed, and nobody should
pretend otherwise. The requirement starts here and applies to what comes next.

## 2. Before you write anything

Read `.context/conventions.md` — all of it. It is short, it is binding, and it is where the ten
hard invariants live. Four of them are refusals the product exists to make, and a change that
breaks one is not a contribution however good the code is:

| | |
|---|---|
| **1** | No egress by default |
| **2** | The application never touches a network device — copy-paste is the only input, permanently |
| **3** | It stores no device credential; pasted captures are redacted at the ingest gate |
| **4** | The server never holds secret key material |

`docs/70-ops/71-roadmap.md` §13.1 lists thirteen things this product will permanently not do. They
are refusals, not deferrals, and *"but it would be useful"* is not an argument against any of them.

Then read `.context/conventions.md` § *Currency*: **security is never answered from memory.** If you
assert that something has no known vulnerability, name the databases you checked and the date. Two
independent sources, or it is not a result. ADR-0034 carries the reasoning.

## 3. How work is organised

Building happens through **work orders** in `docs/70-ops/79-work-orders/`, governed by
`docs/70-ops/78-execution-protocol.md`. If you intend to build rather than to fix a typo, read `78`
first — particularly §3 (the loop), §5 (the ten things a session never does) and §4 (escalation).

The single most important rule in it: **escalating is success, deciding is the defect.** A session
that stops with a well-formed question has done its job. One that ships a guess has failed even if
the guess was right, because a guess in the tree is a decision made by whoever typed first.

## 4. The verification floor

Green before you open a pull request. CI runs the same four, in this order:

```
cargo fmt --all --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo run --locked -p fathom-schema --bin fathom-schema-check
```

The schema check exits 0 with **zero failures and zero warnings**. That is the standing baseline
since 2026-08-09, and a test pins it: any new warning, of any code, fails
`crates/fathom-schema/tests/shipped_tree.rs`. If you add one, say why in the PR — do not re-pin it
quietly.

Two more, not yet gates but run them: `python3 scripts/check-citations.py` (58 unresolved on a clean
tree — do not increase it), and, once external crates exist, the dependency-vulnerability scan
ADR-0034 §4 puts on the floor.

## 5. Two things about content

**`corpus/` is licensed differently.** CC BY-SA 4.0, not Apache-2.0. See `corpus/LICENSE`.

**Invariant 10: no model output ships in the corpus without a named human reviewer** recorded in
the entry's `reviewed_by`. Not a style preference — the build fails on the literal string
`<named human>`. If you contribute a command or a rule, you are asserting you ran it on real
equipment and it behaved as written. If you did not, do not put your name on it.

## 6. Developer Certificate of Origin 1.1

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```
