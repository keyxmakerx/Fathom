# Round-trip run — what landed and what is blocked

> **Status:** Audit record, written 2026-08-08 after the run on branch
> `claude/weld-and-first-browser-run`, at commit `9c58255`. Everything below was re-established by
> running the checks and reading the tree and git history directly. No session's own report of
> itself was taken on trust; where this audit disagrees with one, the disagreement is recorded.

Written for someone who runs networks, not someone who writes Rust. Where a document or a file is
named, what it is comes with it.

## 0. Contents

| § | |
|---|---|
| 1 | The short version |
| 2 | **The headline: can Fathom read a Juniper config and write it back?** |
| 3 | The verification floor — the exact numbers |
| 4 | What actually ran, in order |
| 5 | The queue: every row, claimed against real |
| 6 | The escalation inbox — six questions, three still open |
| 7 | Look at these first |
| 8 | What needs the owner |
| 9 | How this was checked |

---

## 1. The short version

Nine commits landed since the last report. Two new components exist: a canonical-writing layer and
the workspace file itself — the thing that saves your estate to disk and reads it back with the
bytes identical. That order (WO-05) is genuinely DONE and its headline proof reproduces.

The product was opened in a browser for the first time. All sixteen manual checks pass, with two
screenshots checked into the tree as evidence. That is a real first.

**The round trip — paste a Juniper config in, get the same config back out — still does not
work, and cannot be made to work by writing code.** It is blocked on three planning decisions, not
on programming effort. §2 is the whole story and it is the most consequential section in this
report.

Everything automated is green: 329 tests, no failures, nothing skipped. Two work orders are
blocked, both on questions a human has to answer.

## 2. The headline: can Fathom read a Juniper config and write it back?

**No. Not yet.** This audit checked it directly rather than reading anyone's claim about it.

Here is where things actually stand, in three parts.

**What works — the reading half.** Fathom takes pasted Juniper SRX `set`-form text and turns it
into a typed fragment: it frames the lines, tokenises them, strips credentials at a gate that
cannot be switched off, and records what it did not understand. This is real and tested against a
42-line fixture.

**What works — the writing half.** Fathom takes a graph — its internal model of an estate — and
writes Juniper `set` commands back out, each line carrying a record of where it came from. This is
real and tested. But read the test carefully: it builds the graph *by hand in code* and then emits
from it. It has never emitted from a graph that came from a parsed config.

**What is missing — the join.** There is no code that carries a parsed fragment into the store.
Verified directly: there is no `fathom-weld` crate, and the words `fathom-weld` and
`apply_new_device` appear nowhere in any source file in the tree. The workspace has fourteen
components and none of them is the join.

That join now has a written job description — WO-09, authored during this run — but the order ran
and stopped at its own first step, so nothing was built.

**And the join alone would not be enough.** WO-04, the emitter order, was re-taken during this run
specifically to test whether the join's arrival would arm the round-trip gate. It would not, and
this audit confirmed both remaining reasons independently rather than accepting the order's word:

1. **Nothing tells Fathom whether a VPN is route-based or policy-based when it re-reads a config.**
   The data model declares `mode` on an IPsec VPN as *required* (`schema/schema.yaml`, the
   `IpsecVpn` kind). The Juniper vocabulary files under `corpus/dict/junos-srx/` contain no entry
   that sets it — the `bind-interface` entry records only the interface binding. So after parsing,
   `mode` is unknown, and the emitter refuses to write a config with a required field unknown.
   That refusal is correct behaviour: a tool that guessed here would be inventing a value the
   engineer never chose. But it means the round-trip gate fails on principle, not on a bug.
2. **The test config references two interfaces it never declares.** The 21-line golden block in
   WO-04 mentions `reth0.0` and `st0.0` but contains no `set interfaces` line at all. Under the
   parsing rules an unresolved reference is recorded but not built, so those two lines cannot be
   reproduced on the way out.

**So: WO-04's gate G8 — the round trip — is not armed and is not green. It is outstanding on three
planning decisions.** Its other eight gates (G1–G7, G9) were all re-run and are green. The emitter
code is real, tested, and shipped; the proof that matters most about it does not exist yet.

One practical consequence worth knowing: **there is no command-line tool to try this by hand
either.** The only executables in the tree are the command finder, the schema checker, the code
generator and the artifact builder. Ingest and emit exist as library code called from tests only.

## 3. The verification floor — the exact numbers

All four required checks re-run against `9c58255` from a clean tree. Measured, not quoted.

| # | Check | Result |
|---|---|---|
| 1 | `cargo fmt --all --check` — code formatting | No output, exit 0. Clean |
| 2 | `cargo clippy --all-targets -- -D warnings` — the linter, warnings treated as errors | Exit 0. Clean |
| 3 | `cargo test --workspace --locked` — the whole test suite | **329 passed, 0 failed, 0 ignored, 0 filtered out** |
| 4 | `cargo run -p fathom-schema --bin fathom-schema-check` — the data-model gate | Exit 0. `48 kinds · 89 edges · 61 scalars · 10 enums · 14 files parsed`. **0 failures, 2 warnings** |

The two warnings are the long-standing pair about `Site` — the record type meaning a physical
location. They are deliberate, they wait on one sentence from the owner (§8), and they are
unchanged. Nothing new appeared.

**Test count went from 282 to 329.** Nothing was deleted, weakened, or marked skip to get there:
zero tests are ignored and zero are filtered anywhere in the tree, checked directly.

**A fifth check, which is not part of the required floor and is not in CI.**
`python3 scripts/check-citations.py` verifies that every internal cross-reference in the project's
own documents points at a section that exists:

```
8545 cross-references checked, 58 unresolved   (exit code 1)
```

Two things about that number. First, the script was widened during this run to also scan the Rust
source — which was the whole reason it was written — so it is not comparable to the previous
report's `7631 checked, 59 unresolved`. Second, **the newly scanned surface is completely clean:
zero of the 58 are in code.** All 58 are pre-existing references between review documents. See
§7.2 for why this still matters.

**Three other measured numbers.** The browser module is 559,067 bytes. The assembled single-file
page is 794,592 bytes and rebuilds reproducibly (`cargo run -p fathom-artifact`). The page's
security policy still contains `connect-src 'none'` — the mechanically checked statement that the
page cannot make a network request.

**Two gates from this run's completed order were reproduced by hand, not just re-read:** the
code-generation determinism gate (regenerate everything, then check nothing changed — nothing did)
and the workspace-file gate (all eleven tests pass, including the byte-identical save-and-reload).

## 4. What actually ran, in order

Nine commits since the previous report, oldest first:

| Commit | What it did |
|---|---|
| `c78ee3d` | Fixed the broken citation the last report flagged as item one, and widened the citation checker to scan code |
| `6702307` | **Opened the product in a browser for the first time.** All sixteen manual checks pass; two screenshots checked in as evidence |
| `1d86e80` | Wrote the job description for the missing join (WO-09) — planning work, no code |
| `aedaffd` | Planning: corrected an analysis in the diagram and owner-answers documents |
| `e4ce7de` | Answered the two questions that had stopped the workspace-file order, unblocking it |
| `b4b3179` | Fixed defects an audit found in the new job description before anyone tried to build it |
| `86486ff` | **Built the workspace file** — canonical writing, versioned header, byte-identical save and reload |
| `2053003` | The join order ran, hit a question it is not allowed to answer, and stopped |
| `9c58255` | Re-tested whether the round trip could now be proved. It cannot. Recorded why |

Two new components exist that did not before: `fathom-canon` (writes values in exactly one
agreed-upon form, so the same estate always produces the same bytes) and `fathom-workspace` (the
saved file itself). The project still has **zero external dependencies** — every line that ships is
first-party, confirmed against the lock file: fourteen packages, all Fathom's own.

## 5. The queue: every row, claimed against real

The protocol says that when the summary table and a work order's own status line disagree, the
status line wins. **They do not disagree.** All nine rows match, checked one at a time.

| # | Order | What it is | Status |
|---|---|---|---|
| 1 | WO-06 | Finishing the command finder | DONE |
| 2 | WO-01 | Typed values — IP addresses, algorithms, and so on | DONE |
| 3 | WO-02 | The graph store — the in-memory model of an estate | DONE |
| 4 | WO-07 | The browser module | DONE |
| 5 | WO-03 | Juniper SRX config ingest | DONE |
| 6 | **WO-04** | The emitters — graph back out to Juniper commands | **BLOCKED** — eight of nine gates green; the round trip cannot arm (§2) |
| 7 | WO-05 | The workspace file | **DONE** — new this run, all nine gates green |
| 8 | WO-08 | The inventory screen | DONE — and now actually looked at (§7.3) |
| 9 | **WO-09** | The join between parser and store | **BLOCKED** at its first step (§6) |

Seven of nine done. The two that are not are the two that stand between the project and its
central promise.

Against the run report handed to this audit — WO-05 DONE, WO-09 BLOCKED, WO-04 BLOCKED — **the tree
agrees on all three.** Unlike the previous run, nothing was claimed finished that was not.

## 6. The escalation inbox — six questions, three still open

When a session hits something its instructions do not settle, it must stop and file rather than
guess. The inbox is at the end of `docs/70-ops/73-open-decisions.md`, section 14. It holds six rows.

**Three are answered:**

| Question | Answered |
|---|---|
| How a pre-written escalation row should be filed, given the inbox had the wrong shape | Yes — the invented form was replaced with the one the protocol specifies |
| The workspace file's on-disk table had drifted from the code, and would have silently dropped the label on a stored-secret placeholder | Yes — re-cut against the code. The placeholder now keeps both its label and the operator's note of where the real secret lives. Without this, loading a saved file would have written `<PSK>` into a TACACS field |
| The worked example rendered identifiers in a form the code refuses | Yes — the example was re-issued to match the code. Three places in the tree already agreed; only that one document disagreed with itself |

**Three are open, and all three are for a planning session rather than for the owner:**

| Question | Raised |
|---|---|
| The search-ranking formula has no term for query-side weighting, so a hyphenated search term scores as three separate words | 2026-08-02, WO-06 |
| A worked trace in the search specification expects a result order the implemented arithmetic does not produce | 2026-08-02, WO-06 |
| **The join order's blocker:** the workspace file writes "where this came from" as a plain text tag. The join needs to write a richer form — *parsed from this text, at these bytes* — and that form does not exist. Inventing one is a file-format decision sitting behind a byte-identical save-and-reload guarantee, so the session stopped | 2026-08-08, WO-09 |

That third one is the single unblock with the most leverage in the tree right now: **one sentence
deciding the on-disk form, plus one row added to the join order's file list.** The order enumerates
three options without picking one. Answering it unblocks WO-09, which is one of three things
standing between the project and the round trip.

Worth noticing: all three questions ever raised against the workspace file's on-disk format have
been raised against that same file. It is the most-escalated surface in the project, which is
itself a signal.

## 7. Look at these first

Ordered by what costs most if left alone.

### 7.1 The file every new session reads first now says the opposite of the truth

`CLAUDE.md` is the pickup document. It was last updated early in this run, before the two things
that most changed the project's state. It now reads:

> **Nothing has ever been opened in a browser**: WO-08's sixteen manual rows are honestly recorded
> NOT RUN.

That is false. They were run the same day, all sixteen pass, and there are screenshots in the tree.
It is also wrong on three smaller counts: it says 282 tests (329), it lists the component set
without the two built this run, and it says four of eight orders are done (seven of nine).

The browser line is the one that matters, because it is a flat contradiction of a checked-in
result. A pickup file that is wrong about what has been proved is how the next session either
repeats finished work or repeats a claim that has since been retired.

### 7.2 A check that fails is not wired into anything

`scripts/check-citations.py` exits with a failure code — 58 unresolved references — and **CI does
not run it.** CI runs four checks; this is a fifth that exists, fails, and is quoted in reports as
though it were a gate.

Nothing is currently wrong because of it: all 58 are old references between review documents, and
the code — the surface the tool was written to protect, after nine places in the tree once cited a
section that did not exist — is clean. But an unenforced check drifts, and this one is already
being cited as evidence. Either wire it in with the 58 recorded as an accepted baseline, or stop
quoting its number.

### 7.3 The browser result is real, but it can never be re-checked automatically

This audit read both screenshots. They match the written results exactly — two device rows `srx-a`
and `hub-a`, the opinions column present with both cells showing a dash, the footer reading
`VIEW 6 OF 6 — INVENTORY`. The claim is made in good faith and the evidence supports it.

Two caveats a human should hold:

- **This audit could not reproduce it.** No browser was available here. The verification is a human
  reading a screenshot, which is the strongest evidence the project's own rules currently allow.
- **There is no automated regression.** Those sixteen rows must be walked by hand again every time
  the screen changes. The automated browser harness the project specifies needs external libraries
  the project has deliberately never taken, so this will be true of every screen built until
  someone decides how to test a browser without adding dependencies. That decision still has no
  owner.

To repeat it: `cargo run -p fathom-artifact`, then open
`target/artifact/fathom-dev.html?fixture=demo-estate` from disk. Checklist at section 6 of
`docs/70-ops/79-work-orders/WO-08-the-inventory-face.md`, rows M1–M16.

### 7.4 The workspace-file order touched two files its own list does not name

Every order carries a table of exactly which files it may create or change. The commit that built
the workspace file (`86486ff`) also changed two that the table does not list:
`crates/fathom-schemagen/src/rust_gen.rs` (125 lines added) and
`crates/fathom-graph/src/field.rs` (17 lines added).

Both changes look like consequences of the work rather than scope creep — the code generator had to
emit the new machinery, and the graph field type had to expose it. Nothing about them is alarming
on its face. But the rule exists so that "consequence of the work" is a judgement someone else
makes, and there is a sharp irony here: **the very next order stopped dead because it was not
authorised to edit a file in that same crate.** One session extended its own list quietly; the next
stopped and asked. The second behaviour is the one the protocol wants. Worth a deliberate look at
those two diffs and, if they are fine, a line in the order's record saying so.

### 7.5 The Juniper vocabulary driving ingest has never been reviewed by a network engineer

Every entry in `corpus/dict/junos-srx/` — the files that say what each Juniper command means —
still carries the literal text `reviewed_by: <named human>`. That is the placeholder, not a name.
The project's tenth standing rule says that review is not optional.

This is the same backlog the last report flagged, unchanged. It matters more now than it did then,
because §2's blocker is *inside these files*: the reason a re-read config has no VPN mode is that no
vocabulary entry sets it. A network engineer reading these files is the person most likely to spot
both that gap and others like it.

### 7.6 Smaller things, carried forward

- **The test configuration is still synthetic.** `junos-srx-s0-synthetic.txt` is assembled from
  documented command strings, not captured from a device, and its first line says so in capitals.
  Correct behaviour — the real exports are owner-blocked — but every ingest test passes against a
  config no device ever produced.
- **The browser page still allows inline scripts.** `script-src 'unsafe-inline'` remains, where the
  specification wants exact cryptographic fingerprints. Recorded as scaffolding, and the file is
  named `fathom-dev.html`, not a release name. The half carrying the core promise —
  `connect-src 'none'` — is real and checked against the final assembled bytes.
- **The check that would refuse an unapproved third-party library still does not exist.** Zero
  dependencies today, so nothing is breached, but this is the last guard between the project and
  its first unreviewed library, and the decision requiring it is now ratified.
- **Closed since the last report:** the security-currency rule that cited a section which did not
  exist. The section now exists (`70` §7.6) and names what was queried, against what, on what date.
  That was the last report's number-one item and it is done.

## 8. What needs the owner

Nothing on this list is programming work. Every item is a decision.

**The three that unblock the round trip** — these are the whole of §2:

1. **How "where this came from" is written to disk.** One sentence plus one line in a file list.
   Unblocks the join order, which is stopped dead on it. Three options are laid out; none is
   preferred. *This is arguably a planning question rather than an owner one, but it is stopping
   the highest-value work in the tree and nobody has picked it up.*
2. **Where a re-read config gets its VPN mode from.** When Fathom reads a config back, nothing tells
   it whether a VPN is route-based or policy-based. The fact is not in doubt — a VPN bound to a
   tunnel interface is route-based, and the data model allows only two values. What is undecided is
   *which part of the system does the deducing*. It must not be the emitter, which would be
   inventing a value the engineer never chose.
3. **The two interfaces the test config references but never declares.** Either the test config gets
   those lines added, or unresolved references get a home in the store.

**Still waiting, unchanged from before:**

4. **Real Juniper SRX configuration exports.** Every ingest test runs against a synthetic file.
   Real captures turn a plausible parser into a proven one. Highest-leverage item on this list.
5. **One sentence on how a site is identified.** The two standing warnings in the data-model gate
   exist solely because this is unanswered. Not blocked on anything else.
6. **Where should the IKE warning attach** — to the interface, or to the security zone?
7. **Is Meraki configurable by text you can copy?** Decides whether it can be supported at all.
8. **Four forks in the graph-extension document.**
9. **Named expert review of the Juniper vocabulary** (§7.5) — and it is now on the critical path,
   not just a backlog.

## 9. How this was checked

- The working tree at `9c58255` on `claude/weld-and-first-browser-run`, read directly. Nothing
  uncommitted; local and remote at the same commit before this file.
- `git log`, `git show --stat` and `git diff --stat` across `1ad487a..HEAD` — nine commits, each
  one's file list read.
- All four floor checks re-run, plus the citation checker, plus two of the completed order's own
  gates reproduced by hand (code-generation determinism, and the workspace-file test set).
- The nine work-order files and the queue index, status lines read one at a time and compared.
- `docs/70-ops/73-open-decisions.md` §14, every row.
- For §2, checked independently rather than read: a tree-wide search for the missing join by crate
  name and function name (no matches); the workspace member list; the absence of the round-trip
  test file; the `IpsecVpn` declaration in `schema/schema.yaml`; and every Juniper vocabulary entry
  mentioning `mode` or `bind-interface`.
- Both browser screenshots at `docs/80-review/evidence/`, opened and compared against the written
  results.
- `.github/workflows/ci.yml`, `Cargo.toml`, `Cargo.lock`, `CLAUDE.md`, and the assembled
  `target/artifact/fathom-dev.html`.

**Disagreements.** None with the tree's own records. The run report handed to this audit matched
the tree on all three orders it claimed. The disagreements recorded above (§7.1, §7.4) are between
the tree and itself.
