# Overnight queue run — what landed and what is blocked

> **Status:** Audit record, written 2026-08-08 after the unattended run on branch
> `claude/docs-recommendations-review-l7mlhh`. Everything below was re-established from the working
> tree and from git history, not from any session's own account of itself.

Written for someone who runs networks, not someone who writes Rust. Where a document is named, what
it is comes with it.

## 0. Contents

| § | |
|---|---|
| 1 | The short version |
| 2 | The verification floor — the exact numbers |
| 3 | What actually ran, in order |
| 4 | The queue: claimed status versus real status |
| 5 | What is blocked, and on what |
| 6 | Escalations filed tonight |
| 7 | Look at these first |
| 8 | What needs the owner |
| 9 | Sources consulted |

---

## 1. The short version

Ten commits landed. Roughly 22,000 lines of new code across six new components. The build is green
on every automated check. Two of the seven work orders attempted did not finish, and one of those
two was reported as finished when it was not.

The single most important thing in this report is in §7.1, and it is one line long: a decision
record written last night to make *"never state a security fact from memory"* binding project law
contains a security claim that points at a document section which does not exist. It is a
three-minute fix and it should be the first thing anyone looks at.

The second most important thing is in §7.2: the first part of Fathom a human being would actually
look at — the inventory screen — was built last night and **has never been opened in a browser**.
The session had no browser. Sixteen checks are written down and waiting for someone with a screen.

## 2. The verification floor — the exact numbers

All four required checks were re-run tonight against the branch head (`e3ef147`), from a clean
tree. These are measured numbers, not quoted ones.

| # | Check | Result |
|---|---|---|
| 1 | `cargo fmt --all --check` — code formatting | No output, exit 0. Clean |
| 2 | `cargo clippy --all-targets -- -D warnings` — the compiler's linter, warnings treated as errors | Exit 0. Clean |
| 3 | `cargo test --workspace --locked` — the whole test suite | **282 passed, 0 failed, 0 ignored, 0 skipped** |
| 4 | `cargo run -p fathom-schema --bin fathom-schema-check` — the data-model gate | Exit 0. `48 kinds · 89 edges · 61 scalars · 10 enums · 14 files parsed`. **0 failures, 2 warnings** |

The two warnings are the long-standing pair about `Site` — the record type that means a physical
location. They are deliberate, they are waiting on an owner decision (§8), and they are unchanged
from before the run. Nothing new appeared.

**Test count went from 80 to 282.** No existing test was deleted, weakened, or marked "skip" to get
there — checked directly: zero tests are ignored or filtered anywhere in the tree.

**A fifth check, not part of the required floor.** `python3 scripts/check-citations.py`, which
verifies that every internal cross-reference in the documentation points at something real:

```
7631 cross-references checked, 59 unresolved
```

Before the run it was `7624 checked, 58 unresolved`. So the night added 7 cross-references and
**one new broken one**. That one broken reference is §7.1.

**Two other numbers worth having.** The compiled browser module is 557,641 bytes against a 900,000
ceiling, and its list of external things it can call is *empty* — which is the mechanically checked
proof that the code shipped to a browser cannot reach the network. The assembled HTML page is
792,692 bytes as a single file with no separate downloads at all.

## 3. What actually ran, in order

Ten commits, oldest first:

| Commit | What it did |
|---|---|
| `c07d1bc` | Built the typed-value layer — 35 real implementations of things like "an IP address", "an encryption algorithm", replacing stubs |
| `2f08324` | Generated the lookup tables the graph store checks writes against |
| `bb519c7` | Built the graph store itself: the in-memory model of an estate that refuses to accept a structurally invalid write |
| `bc10397` | Ratified three pending decisions, added the licence files, and wrote the new security-currency rule (see §7.1 and §7.6) |
| `205bca3` | Compiled the command finder to WebAssembly — the form that runs in a browser — and proved its import list is empty |
| `303b13c` | Set the licence field in the build manifest to Apache-2.0 |
| `a864cfe` | Built configuration ingest for Juniper SRX `set`-form: the line framer, the tokeniser, the shaper, the credential-stripping gate |
| `da19129` | Built the emitters — turning graph state back into copy-pasteable Juniper commands, each line carrying where it came from |
| `388c716` | Stopped the workspace-file order and filed two escalations (see §6) |
| `e3ef147` | Built the inventory screen: the single-file browser artifact, the estate as a table, the per-equipment page |

Six new components exist that did not exist yesterday: the graph store, the WebAssembly shell, the
Juniper ingest, the emitters, the inventory projections, and the artifact assembler. All twelve
components in the tree forbid unsafe code. The project still has **zero external dependencies** —
every line that ships is first-party.

## 4. The queue: claimed status versus real status

The queue index and each order's own status line agree on all eight rows. There is **no divergence
between the index and the status lines** — the thing the protocol warns about did not happen.

There is a divergence between the tree and the **run report handed to this audit**, on one row:

| Order | Run report claimed | The tree says |
|---|---|---|
| WO-01 (typed values) | DONE | DONE ✓ |
| WO-02 (graph store) | DONE | DONE ✓ |
| WO-07 (browser module) | DONE | DONE ✓ |
| WO-03 (Juniper ingest) | DONE | DONE ✓ |
| **WO-04 (emitters)** | **DONE** | **BLOCKED** — 7 of 8 gates green; the round-trip gate cannot arm |
| WO-05 (workspace file) | BLOCKED | BLOCKED ✓ |
| WO-08 (inventory screen) | DONE | DONE ✓ |

The emitter code is real, tested and shipped. What is not done is the proof that matters most about
it — see §5.1. The order was honest in its own file; the summary that reached this audit was not.

One wording snag worth fixing when someone is next in that file: the emitter order's status reads
*"blocked on the ingest order plus the weld order"*, and the ingest order finished last night. Only
the second half is still true.

## 5. What is blocked, and on what

### 5.1 The emitters — the round trip cannot be proved yet

Fathom can now read a Juniper SRX configuration into its graph. Fathom can now write graph state
back out as Juniper commands. **Nothing joins the two.** The piece that takes what the parser
produced and loads it into the store — minting the permanent identifiers, attaching the "who said
so and when" records, and reconciling against what is already there — has never been written. It
is not even a queued job; it is named in the queue's own header as *the one thing in the critical
path that does not exist yet*.

Until it exists, the gate that proves *"paste a config in, get the same config back out"* cannot
run. For a tool whose entire promise is that it will not silently mangle your device
configuration, that is the most consequential open item in the tree. Everything else about the
emitters passed.

**This needs someone to write that job description.** It is planning work, not building work, and
no overnight session is permitted to do it.

### 5.2 The workspace file — stopped on two format questions

This is the order that defines how a saved Fathom workspace is written to disk. It stopped before
its first step, correctly, because the document it was told to implement had drifted from the code
that landed earlier the same night. Both questions are format decisions for a planning session, not
for the owner. Both are recorded (§6).

Nothing was half-built. The order stopped clean.

## 6. Escalations filed tonight

The project keeps an inbox at the end of the open-decisions document
(`docs/70-ops/73-open-decisions.md`, §14) where a session that hits something its instructions do
not settle stops and files rather than guessing. Tonight added **two rows, both from the
workspace-file order, both dated 2026-08-08, and both still open**:

| Question | Who answers | State |
|---|---|---|
| The typed-value work reshaped seven value types — encryption algorithm, integrity algorithm, authentication method, IKE version, route distinguisher, route target, and the placeholder that stands in for a stored secret — into shapes the workspace format's on-disk table does not describe. Worse, the current rule would silently drop the secret placeholder's label. Re-cut the table against the code that now exists, and decide the secret placeholder's on-disk form explicitly | Planning | **OPEN** |
| The worked example pinned in the format document renders identifiers as `fathom:device:<id>`. The code, the conventions file and the identifier decision record all refuse that prefix. Either re-issue the example against what the code actually emits, or reopen the identifier decision | Planning | **OPEN** |

The inbox now holds five rows in total. Of the three that were already there, one is answered and
two are open — both of those concern the search-ranking formula and are also planning work, not
owner work.

**Note what is absent.** The ingest order, the emitter order and the inventory order filed nothing.
For the ingest and inventory orders that is plausible — they finished. For the emitter order it is
worth a second look: it stopped on a missing prerequisite and recorded that in its own file rather
than in the shared inbox, so the one genuinely critical-path gap in the tree (§5.1) is not visible
from the inbox anyone would check first.

## 7. Look at these first

Ordered by what costs most if left alone.

### 7.1 A security rule that breaks its own rule

Last night's run created a new decision record, ADR-0034, at
`docs/90-decisions/adr-0034-security-knowledge-is-never-answered-from-memory.md`. It makes binding
law of an instruction the owner gave in his own words: never state a security fact — a known
vulnerability, whether a cipher is still sound, whether a library is still maintained — from
memory. Look it up, name the source, date it, and use two independent databases before declaring
anything clean.

It is a good rule. Line 63 of that same record then says the cryptographic libraries under
consideration *"were queried against both OSV.dev and RustSec, both clean — recorded at `70` §7.6."*

**There is no section 7.6.** The owner-answers document
(`docs/70-ops/70-owner-answers-and-standing-priorities.md`) has sections 7.1 through 7.5 and stops.
The citation checker flagged it, and it is the only new broken cross-reference the whole night
produced.

So the record that forbids unsourced security claims contains one. Either the vulnerability check
was run and never written down, or it was not run. Both readings need the same fix and the answer
is known to whoever wrote it. Nothing is *shipping* on that claim — the tree still has zero external
dependencies, so no library has actually landed — which is why this is a three-minute correction
rather than an incident. It should still be corrected before the first dependency arrives, because
that is exactly the moment it becomes load-bearing.

### 7.2 The product has never been looked at

The inventory screen is the first thing in this project a user would see. It was built last night.
The order that specifies it carries a sixteen-step checklist to be walked in a real browser: open
the file from disk with the network off, confirm zero requests are made, check the two device rows
render, click through to a port, follow a cable to the far end, drive the whole thing from the
keyboard, toggle the theme.

**All sixteen are recorded NOT RUN — "no browser available to this session."** That is an honest
record and the right thing to write, but it means nobody has ever seen this working.

To do it: run `cargo run -p fathom-artifact`, then open
`target/artifact/fathom-dev.html?fixture=demo-estate` from disk. The checklist is section 6 of
`docs/70-ops/79-work-orders/WO-08-the-inventory-face.md`, rows M1 to M16. The machine-checkable
parts around it were re-verified by this audit and do pass: the page contains
`connect-src 'none'`, and the hand-written source contains zero network calls and zero HTML-string
injection points.

This gap is not the session's fault. The automated browser test harness the project specifies
requires external libraries the project has deliberately never taken, so *every* screen-building
job will land in this state until someone decides how to test a browser without adding
dependencies. That decision has no owner yet.

### 7.3 The browser page currently allows inline scripts

The generated page carries this content-security policy:

```
script-src 'unsafe-inline' 'wasm-unsafe-eval';
style-src  'unsafe-inline';
connect-src 'none';
```

The specification wants those first two to be exact cryptographic hashes of the intended script and
stylesheet — meaning the browser refuses to run anything else at all. `'unsafe-inline'` is the
weaker stand-in. The session recorded it as scaffolding with a named follow-up item, and the file is
called `fathom-dev.html`, not a release name.

It is still worth knowing that it is in the tree. The half that carries the project's core promise
— `connect-src 'none'`, meaning the page cannot make a network request — is real, and is checked by
both a test and a grep against the final assembled bytes rather than against the template.

### 7.4 The session-pickup file is out of date on four counts

`CLAUDE.md` — the file a fresh session reads first — was not touched all night, and four of its
statements are now wrong:

- It lists ratifying three decision records as owner-blocking work. All three were ratified last
  night and now read Accepted.
- It says the licence files the project decided on do not exist in the tree. They do:
  `LICENSE`, `NOTICE`, `CONTRIBUTING.md` and `corpus/LICENSE` all landed.
- It says the test suite is 80 tests. It is 282.
- It does not mention the new security-currency rule at all, even though that rule now amends the
  conventions file every session is required to read.

A stale pickup file is how the next session wastes an hour or repeats finished work.

### 7.5 The citation checker does not check the code

`scripts/check-citations.py` opens with an explanation of why it exists: nine places in the tree
once cited a document section that did not exist, *"including two code comments a work order would
have written into shipped source."*

It then scans only `docs/**/*.md`, plus `CLAUDE.md` and `README.md`. It never opens a `.rs` file.

Last night added roughly 22,000 lines of Rust, and those files are dense with the same
`document §section` references — the wasm audit test alone cites four. None of them have ever been
checked. The tool does not check the thing its own reason for existing names.

### 7.6 A binding rules file was edited by an automated session

`.context/conventions.md` is the top-of-tree document every session must read and obey. It gained a
new 27-line binding section last night, *"Currency — security is never answered from memory."*

The content is sound and it quotes the owner's own words as its authority. But the file is the
project's constitution, the new decision record behind it was written and marked Accepted in the
same commit by the same session, and the standing protocol reserves that kind of change for the
owner or a planning session. Worth a deliberate read-and-confirm rather than an implicit one — not
because the rule is wrong, but because the route it took is the route a wrong rule would also take.

### 7.7 Smaller things, for completeness

- **The Juniper test configuration is synthetic.** `junos-srx-s0-synthetic.txt` is assembled from
  documented command strings, not captured from a real device, and its first line says so in
  capitals. This is correct behaviour — the real exports are owner-blocked (§8) — but every ingest
  test currently passes against a config no device ever produced.
- **The vocabulary files added 45 new entries, all unreviewed.** Six new dictionary files under
  `corpus/dict/junos-srx/` describe what each Juniper command means. Every entry carries
  `reviewed_by: <named human>` — the literal placeholder, not a name. The files say so in their own
  headers. The backlog of network-engineer review just grew by 45 items, and the project's tenth
  invariant says that review is not optional.
- **One dead check in the WebAssembly audit.** The test asserts the module's import list is empty,
  then loops over that list checking each entry against an allowlist. The loop can never execute.
  Harmless, but the allowlist is not being exercised by anything.
- **The build pipeline comment is stale.** `.github/workflows/ci.yml` says the dependency-policy
  decision is "Proposed"; it was accepted last night. The same comment notes that the check which
  refuses an unapproved third-party library is still absent — required *before the first dependency
  lands*. Zero dependencies exist today, so nothing is breached, but this is now the last guard
  standing between the project and its first unreviewed library.

## 8. What needs the owner

Closed last night, no longer needing you: the three pending decisions (all features ship / phases
retired, third-party code permitted under a gate, motion must carry meaning) are ratified, and the
licence files exist.

Still waiting on you:

1. **Real Juniper SRX configuration exports.** Every ingest test currently runs against a synthetic
   file. Real captures replace it and re-pin the tests. This is the highest-leverage item on the
   list — it turns a plausible parser into a proven one.
2. **One sentence on how a site is identified.** Two long-standing warnings in the data-model gate
   exist solely because this is unanswered. It is not blocked on anything else.
3. **Where should the IKE warning attach** — to the interface, or to the security zone?
4. **Is Meraki configurable by text you can copy?** This decides whether it can be a supported
   platform at all.
5. **Four forks in the graph extension document**, still open.
6. **Named expert review of the vocabulary corpus** — now 45 entries larger than yesterday.
7. **New tonight: where was the cryptographic library vulnerability check recorded?** See §7.1. If
   it was run, it needs writing down. If it was not, the sentence claiming it needs removing.
8. **New tonight, and it is a queue question rather than a product one:** the join between the
   parser and the graph store (§5.1) needs a job description written before the round-trip proof can
   exist. Someone needs to authorise that as the next planning task.

## 9. Sources consulted

- The working tree at `e3ef147` on `claude/docs-recommendations-review-l7mlhh`, read directly.
- `git log`, `git diff` and `git show` across `c180f90..HEAD` — ten commits.
- All four floor checks and the citation checker, re-run tonight; the citation checker additionally
  re-run against `c180f90` in a separate worktree to establish the before-and-after.
- The eight work-order files and the queue index, status lines read individually.
- `docs/70-ops/73-open-decisions.md` §14, the escalation inbox.
- `.github/workflows/ci.yml`, `rust-toolchain.toml`, `CLAUDE.md`, `.context/conventions.md`,
  `LICENSE`, `NOTICE`, and the generated `target/artifact/fathom-dev.html`.

**Disagreements.** One, recorded in §4: the run report handed to this audit lists the emitter order
as DONE. The order's own file and the queue index both say BLOCKED, and the blocking gate is real.
The tree is right and the report is wrong.
