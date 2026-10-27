# Fathom

A security-first network documentation and diagramming tool. One typed graph, several views over
it. Teaching and estate-of-record are co-equal goals.

**Server product.** Data lives on the server; the browser is a window onto it. Multi-tenant, live
multi-user editing, thousands of devices per design.

**Status: built and green, not yet usable** (2026-10-10). Engine, server and client are in and every
gate passes. Since the owner's walkthroughs (2026-09-22, 2026-09-27; ADR-0060, one canvas with detail
added by degrees) the rounds on the sign-off page through 15 have been built and merged; ADR-0068
records rounds 16 to 27, of which one sign-in, the Back tree, Equipment opening by itself and missing links
are built.
**"Usable" is the owner's word and means beta: polished, the app basically done, a few features allowed to be missing.** Green gates do not
grant it; a walkthrough by the owner does. The backlog is in GitHub issues; `docs/NEXT.md` says how
to work, and `docs/REBUILD-PLAN.md` holds the rebuild's reasoning.

---

## Read this before you read anything else

This file is a pointer page. It is loaded before every instruction, so it stays short.

| You need | Read |
|---|---|
| The plan | `docs/REBUILD-PLAN.md` |
| **What to do next, session by session** | `docs/NEXT.md` — written 2026-09-13 for the sessions after it |
| **How to actually run it** | `docs/RUNNING-IT.md` — `docker compose up` from the root, proven by CI |
| **The key file, backups, restore, rekey** | `docs/OPERATING.md` — the operator's register ADR-0043 §9 requires |
| What is actually built right now | `docs/STATE.md` |
| Short worked tasks on what main does | `docs/EXAMPLES.md` |
| **What the interface looks like** | `docs/UI-SPEC.md` — approved. Pictures linked from it; open those only when building a surface. |
| Rules you must not break | `.context/conventions.md` |
| Decisions already made | `docs/decisions/` |
| Questions waiting on the owner | The sign-off page (ADR-0060, decision 9). `docs/OPEN-QUESTIONS.md` is closed: it records answers the code cites by letter |

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
4. **A pasted config's credentials never arrive.** The redaction gate runs in the browser before
   anything from a paste is stored or sent, and the server refuses any that still arrive. This
   survives every architectural change. It does not mean Fathom never stores a credential: ADR-0042
   (accepted) keeps credentials a person chooses to store in a vault, never in the design, never
   without being shown and chosen. Part one of the vault is built (ADR-0071).
5. **Four sentences are forbidden in writing** until customer-held keys are real: *zero-knowledge*,
   *end-to-end*, *we cannot read your data*, *only you hold the key*.
6. Decisions in `docs/decisions/` bind once accepted, but reopen on merit. Sunk cost is not an
   argument.

---

## The stack

Decided 2026-09-11. See `docs/REBUILD-PLAN.md` for reasoning.

- **Engine and server:** Rust. Unchanged.
- **Client:** React + Vite, plain CSS. No Tailwind.
- **Diagram:** React Flow. One canvas, detail added by degrees (ADR-0060) — see `docs/UI-SPEC.md`.
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

Before claiming anything works, run every command in `CONTRIBUTING.md` §4 (the one list: Rust,
schema, the dependency gates, and the client's typecheck, lint and tests).

Plus the dependency gates in `scripts/` and whatever the current task names. Green is the gate,
not any particular number — do not quote a count from a document, read it off the run.
