# Fathom

A security-first network documentation and diagramming tool. One typed graph, several views over
it. Teaching and estate-of-record are co-equal goals.

**Server product.** Data lives on the server; the browser is a window onto it. Multi-tenant, live
multi-user editing, thousands of devices per design.

**Status: rebuilding the client.** The engine and server are sound. The browser side still carries
an architecture retired in August 2026 and is being replaced. Read `docs/REBUILD-PLAN.md` before
planning anything.

---

## Read this before you read anything else

This file is a pointer page. It is loaded before every instruction, so it stays short.

| You need | Read |
|---|---|
| The plan | `docs/REBUILD-PLAN.md` |
| What is actually built right now | `docs/STATE.md` |
| **What the interface looks like** | `docs/UI-SPEC.md` — approved. Pictures linked from it; open those only when building a surface. |
| Rules you must not break | `.context/conventions.md` |
| Decisions already made | `docs/decisions/` |
| Questions waiting on the owner | `docs/OPEN-QUESTIONS.md` |

**`docs/archive/` is history. Do not read it unless a task names a specific file in it.** It holds
the reasoning behind everything above, written mostly about a version of the product that no
longer exists. It is kept because the thinking is good, not because it is current.

---

## Rules that bind every session

1. **Never answer a security question from memory.** Look it up, name the source and the date. "I
   could not establish this" beats a confident guess.
2. **Test a safety gate against what a real device accepts, not against what the detector needs.**
   A credential leak once survived four reviews because the test used a password longer than any
   real device would take.
3. **A field that is not in `schema/` does not exist.** Extend the schema properly; keep tests green.
4. **Device credentials are protected by never arriving.** The redaction gate runs before anything
   is stored. This survives every architectural change.
5. **Four sentences are forbidden in writing** until customer-held keys are real: *zero-knowledge*,
   *end-to-end*, *we cannot read your data*, *only you hold the key*.
6. Decisions in `docs/decisions/` bind once accepted, but reopen on merit. Sunk cost is not an
   argument.

---

## The stack

Decided 2026-09-11. See `docs/REBUILD-PLAN.md` for reasoning.

- **Engine and server:** Rust. Unchanged.
- **Client:** React + Vite, plain CSS. No Tailwind.
- **Diagram:** React Flow. The interface is rack-first — see `docs/UI-SPEC.md`.
- **Storage:** PostgreSQL, encrypted, with a tamper-evident change history.
- **Redaction gate:** stays in Rust, compiled for the browser. Never reimplemented in JavaScript.

---

## Keeping this cheap

The single largest cost in this project has been reading things nobody asked for.

1. Do not read `docs/archive/` unless a task names a file in it.
2. Cheap helpers read; expensive ones decide.
3. Ask closed questions. Open-ended exploration is what made this expensive.
4. If this file starts growing into a changelog again, cut it back. That is what went wrong before.

---

## Verifying work

Before claiming anything works:

```
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo test --workspace --locked
cargo run -p fathom-schema --bin fathom-schema-check
./scripts/gate-zero.sh
```

Plus the dependency gates in `scripts/` and whatever the current task names. Green is the gate,
not any particular number — do not quote a count from a document, read it off the run.
