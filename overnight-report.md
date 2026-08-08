# Weld and round trip — what landed and what is blocked

> **Status:** Audit record, written 2026-08-08 after the run on branch
> `claude/weld-and-first-browser-run`, at commit `fa72d80`. Everything below was re-established by
> running the checks and reading the tree and git history directly. No session's report of itself
> was taken on trust. The one claim that matters most — §2 — was tested by writing a throwaway
> program and running it, not by reading anyone's account of it.

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
| 6 | The escalation inbox — seven questions, three still open |
| 7 | Look at these first |
| 8 | What needs a decision, and from whom |
| 9 | How this was checked |

---

## 1. The short version

Two commits landed since the last report. They are small in size and large in consequence.

**The missing join now exists.** The last report's central finding was that Fathom could read a
Juniper config and could write one, but had no code connecting the two — the reader produced a
result nothing could load into the model. That code is now written. It is called `fathom-weld`, it
compiles, and part of it is proved.

**And it refuses the only real Juniper config in the tree.** Not because of a bug in the new code.
Because the Juniper vocabulary and the data model have disagreed for weeks about what type an
interface name is, and nothing in the project ever compared the two. The join is simply the first
code that puts both halves in one call, so it is the first thing that could notice.

So the honest position is: **the round trip still does not work, but the distance to it changed
shape.** It used to be "three decisions and a missing component." It is now "three decisions" — and
the first of the three is one sentence choosing between four spelled-out options.

Everything automated is green: 337 tests, none failing, none skipped. Nothing was weakened to get
there — a test that went red was deleted rather than softened, and that deletion is recorded in the
open. That is the behaviour the project's rules ask for, and it happened.

## 2. The headline: can Fathom read a Juniper config and write it back?

**No. Not yet.** This audit tested it rather than reading a claim about it.

### What is now true

**Reading works.** Fathom takes pasted Juniper SRX `set`-form text, frames it line by line,
tokenises it, strips credentials at a gate that cannot be switched off, and records every line it
did not understand. Tested against a 42-line config file.

**Writing works.** Fathom takes its internal model of an estate and writes Juniper `set` commands
back out, each line carrying a record of where it came from. Thirty-five tests cover it, including
a 21-line golden block reproduced exactly. But read that test carefully: it builds the model **by
hand in Rust code** and emits from it. It has never emitted from a model that came from a parsed
config.

**The join now exists.** `crates/fathom-weld` is new this run. Its entry point,
`apply_new_device`, takes a parsed fragment and writes it into the store: every parsed item becomes
a stored item with a freshly minted identifier, every "this lives inside that" relationship becomes
the containment link the data model declares for that pair of types, every field carries a record
saying *parsed from this capture, at these bytes*, and the whole thing lands as one undoable batch.
One of its gates is green and was re-run here: over all 48 × 48 combinations of record types, no
pair of types is claimed by two different containment links. Forty-six pairs resolve, and the test
pins that number.

### What is not true

**The join refuses the shipped Juniper config.** This audit wrote a small throwaway program that
loads the real Juniper vocabulary, parses the checked-in config file
`crates/fathom-ingest/tests/fixtures/junos-srx-s0-synthetic.txt`, and calls `apply_new_device` on
the result. It returns an error: `SlotType { key: FieldKey(55) }`. Field 55 is
`TunnelInterface.name` — the name of a tunnel interface, `st0` in that config.

The cause, checked in three files independently:

- `schema/schema.yaml` — the data model — declares an interface's `name` as type `InterfaceName`,
  on all four kinds of interface (lines 234, 256, 274, 289).
- `corpus/dict/junos-srx/interfaces.yaml` line 13 — the Juniper vocabulary file that says what
  `set interfaces ... unit ... family inet address ...` means — binds that same field as type
  `Identifier`.
- `crates/fathom-ingest/src/bind.rs` — the parser's list of value types — has **no `InterfaceName`
  entry at all**. So this is not a mis-typed line in a vocabulary file that the vocabulary alone
  can fix. The parser is currently incapable of carrying the type the store demands.

Two things about this are worth sitting with. First, **the two halves of the round trip have
disagreed since before either the join or its work order existed** — the writer already emits
`InterfaceName` on those same fields. The join did not create the disagreement; it is the first
code to put the reader and the store in one call, so it is the first thing that could trip over it.
Second, **nothing in the project compares a vocabulary entry's declared type against the data
model's declared type.** That is why this survived every gate the ingest work carried and all 337
tests. Only `st0` fires today because the test config declares only a tunnel interface; the same
disagreement sits unexercised on ordinary, aggregate and redundant-ethernet interfaces.

**Two further things block the round trip even after that is fixed**, both re-confirmed here:

1. **Nothing tells Fathom whether a VPN is route-based or policy-based when it re-reads a config.**
   The data model declares `mode` on an IPsec VPN as required. Searching every Juniper vocabulary
   file for an entry that sets it finds exactly one `mode` binding — and it is on the IKE *policy*,
   a different thing. So after parsing, a VPN's mode is unknown, and the writer refuses to emit a
   config with a required field unknown. That refusal is correct: a tool that guessed here would be
   inventing a value the engineer never chose.
2. **The test config references two interfaces it never declares.** The 21-line golden block
   mentions `reth0.0` and `st0.0` but contains no `set interfaces` line for `reth0`. An unresolved
   reference is recorded but not built, so that line cannot be reproduced on the way out.

### The bottom line

The round-trip test file does not exist. `crates/fathom-emit/tests/` contains six test files and
none of them is `round_trip.rs`. The gate that would prove the round trip — called G8 in the
emitter work order — has never been run, was not weakened, and was not forced. That is recorded
honestly in the tree.

**What that test would catch if the writer were wrong:** it parses the golden config, applies it
into a fresh store, emits it again, and demands the rendered output be **byte-for-byte identical**
to the input — not "equivalent", not "same set of lines", identical bytes. It additionally demands
the emit report show zero blockers, zero conflicts, exactly one credential substitution agreeing
with the original on token, line number and label, and an empty set of gaps. A writer that dropped
a line, reordered two statements, changed spacing, or silently substituted a value would fail it.
That is why it is the project's most consequential test and why nobody should be comfortable until
it runs.

**One practical consequence:** there is still no command-line tool to try any of this by hand. The
only three executables in the tree are the command finder, the data-model checker and the code
generator. Reading, writing and the join all exist as library code, callable only from tests.

## 3. The verification floor — the exact numbers

All four required checks re-run against `fa72d80` from a clean tree. Measured here, not quoted.

| # | Check | Result |
|---|---|---|
| 1 | `cargo fmt --all --check` — code formatting | No output, exit 0. Clean |
| 2 | `cargo clippy --all-targets -- -D warnings` — the linter, warnings treated as errors | Exit 0. Clean |
| 3 | `cargo test --workspace --locked` — the whole test suite | **337 passed, 0 failed, 0 ignored, 0 filtered out** |
| 4 | `cargo run -p fathom-schema --bin fathom-schema-check` — the data-model gate | Exit 0. `48 kinds · 89 edges · 61 scalars · 10 enums · 14 files parsed`. **0 failures, 2 warnings** |

The two warnings are the long-standing pair about `Site` — the record type meaning a physical
location. They are deliberate, they wait on one sentence from the owner (§8), and they are
unchanged. Nothing new appeared.

**Tests went from 329 to 337.** Nothing was deleted, weakened or skipped to get there: zero ignored,
zero filtered, checked directly. One test file *was* removed during the run — `tests/apply.rs`,
which went red because of §2's type disagreement. Removing a red test is the kind of thing that
should set off alarms, so: it was removed rather than softened, the removal is stated in the commit
message and in the work order, and the work order's own gate list still names the four test files
that remain unwritten. That is disclosure, not laundering. It is still a debt.

**A fifth check, which is not part of the required floor and is not in CI.**
`python3 scripts/check-citations.py` verifies that every internal cross-reference in the project's
own documents points at a section that exists:

```
8559 cross-references checked, 58 unresolved   (exit code 1)
```

Unchanged in substance from the last report: all 58 are pre-existing references between old review
documents, and the code — the surface the tool was written to protect — is clean. See §7.4.

**Three other measured numbers.** The assembled single-file browser page is 796,376 bytes and
rebuilds on demand (`cargo run -p fathom-artifact`). It grew by 1,784 bytes this run, which is the
one line added so the inventory screen can display "parsed" as an origin. The page's security
policy still contains `connect-src 'none'` — the mechanically checked statement that the page
cannot make a network request. The project still has **zero external dependencies**: fifteen
packages in the lock file, all of them Fathom's own.

## 4. What actually ran, in order

Two commits since the previous report, oldest first:

| Commit | What it did |
|---|---|
| `eaf4221` | **A decision, no code.** Answered the question that had stopped the join at its first step: how "parsed from here" is written to disk. The answer turned out not to be a new rule at all — the workspace file already applied an unwritten convention in three places (a value with no payload is written as a bare word; a value carrying a payload is written as a small labelled object). The join's case obeys that convention rather than breaking it. The rule was written down where the file format lives. Also fixed a citation that was off by one line in three places, and a queue row that still said the join order was open after the same commit had blocked it |
| `fa72d80` | **Built the join.** Eight of nine planned steps landed: the store learned a second kind of origin (`parsed`, carrying which capture and which bytes), the workspace file learned to read and write it without moving a single byte of the previously pinned save format, the inventory screen learned to display it, and the whole `fathom-weld` component was written — identifier minting, provenance records, the value dispatch, containment links computed from the generated tables rather than hand-written, and the entry point. Its containment gate is green. Step nine stopped on §2's type disagreement and filed it |

The second commit also corrected a factual error in the join's own work order: it had said 51
containment pairs; five of those are owned by the workspace root, which is not a record, so the
real number over pairs of record types is 46. The test pins 46.

## 5. The queue: every row, claimed against real

The protocol says that when the summary table and a work order's own status line disagree, the
status line wins. **This audit compared all nine, one at a time. They do not disagree.** Nine for
nine.

| # | Order | What it is | Status |
|---|---|---|---|
| 1 | WO-06 | Finishing the command finder | DONE |
| 2 | WO-01 | Typed values — IP addresses, algorithms, and so on | DONE |
| 3 | WO-02 | The graph store — the in-memory model of an estate | DONE |
| 4 | WO-07 | The browser module | DONE |
| 5 | WO-03 | Juniper SRX config ingest | DONE |
| 6 | **WO-04** | The emitters — model back out to Juniper commands | **BLOCKED** on the join. Eight of nine gates green; the round trip cannot arm (§2) |
| 7 | WO-05 | The workspace file | DONE |
| 8 | WO-08 | The inventory screen | DONE |
| 9 | **WO-09** | The join between parser and store | **BLOCKED** at step 9 of 11, on §2's type disagreement |

Seven of nine done. The two that are not are the two standing between the project and its central
promise, and they are now blocked on the *same* question rather than on three separate ones.

Against the run report handed to this audit — the join BLOCKED, the emitter order not re-attempted
— **the tree agrees.** Nothing was claimed finished that was not.

**The queue currently has no runnable row.** Every remaining order is either done or waiting on a
decision. That is not a stall in the engineering; it is the engineering having caught up with the
decisions.

## 6. The escalation inbox — seven questions, three still open

When a session hits something its instructions do not settle, it must stop and file rather than
guess. The inbox is at the end of `docs/70-ops/73-open-decisions.md`, section 14. It now holds
seven rows.

**Four are answered.** The three from before (the inbox's own form; the workspace file's on-disk
table, which would have silently written the placeholder `<PSK>` into a TACACS field after a save
and reload; and a worked example rendering identifiers in a form the code refuses), plus one new
this run: how "parsed from here" is written to disk, answered by finding the convention that
already existed.

**Three are open, and all three are for a planning session rather than for the owner:**

| Question | Raised |
|---|---|
| The search-ranking formula has no term for query-side weighting, so a hyphenated search term scores as three separate words | 2026-08-02 |
| A worked trace in the search specification expects a result order the implemented arithmetic does not produce | 2026-08-02 |
| **The type disagreement (§2):** the Juniper vocabulary calls an interface name one type, the data model calls it another, and the parser cannot represent the data model's type at all | 2026-08-08 |

That third row is now the single highest-leverage unblock in the project. It is written up with
four options and deliberately no preference:

- **(a) Move the data model to match the vocabulary** — declare interface names as the looser type.
  This retires a constraint that exists precisely to constrain interface names, and it regenerates
  code that two other components already use.
- **(b) Move the vocabulary and the parser to match the data model** — teach the parser the stricter
  type and change the one vocabulary line. This reopens the ingest order and re-pins its test
  counts.
- **(c) Convert at the join** — translate one type to the other as it crosses. This contradicts an
  explicit promise that the store can hold every parsed assertion *without conversion*, and it
  requires a hand-written table duplicating a fact the data model already states.
- **(d) Whichever of the above is chosen, add the check that would have caught it.** Nothing
  anywhere compares a vocabulary entry's type against the data model's. This is the control, not
  the fix, and it is the item most likely to prevent the next one of these.

Worth noticing: **four of the seven escalations ever raised are against the workspace file's
on-disk format.** It is by a distance the most-escalated surface in the project. That is either a
sign the format is under-specified or a sign it is the only thing being exercised hard. Either way
it deserves a deliberate look rather than another one-off answer.

## 7. Look at these first

Ordered by what costs most if left alone.

### 7.1 The file every new session reads first is now wrong in four places, for the second report running

`CLAUDE.md` is the pickup document — the first thing anyone or anything reads when starting work.
It currently says:

> **Nothing has ever been opened in a browser**: WO-08's sixteen manual rows are honestly recorded
> NOT RUN.

That has been false since 13:19 on 8 August. All sixteen checks were run, all sixteen pass, and two
screenshots are checked into `docs/80-review/evidence/`. It is also wrong that there are 282 tests
(there are 337), wrong that four of eight orders are done (seven of nine), and it lists the
components without the three built since — the canonical writer, the workspace file, and the join
that §2 is entirely about.

**This was item number one in the previous report and it is unchanged.** A pickup file that is wrong
about what has been proved is how the next session either redoes finished work or repeats a retired
claim. It is a five-minute edit and it is now the oldest untouched item on the list.

### 7.2 One sentence unblocks the two orders that matter

§2 and §6 are the same story. The type disagreement is written up with four mechanically enumerable
options and no preference stated. Choosing one unblocks the join; the join plus two further
decisions unblocks the round trip. Nothing else in the tree is close to this in leverage.

The person best placed to choose is someone who knows both Juniper and the data model, because
option (a) quietly relaxes a validity constraint on interface names and option (b) makes the parser
stricter about what it will accept from a real config. Those are different bets about how tolerant
Fathom should be of unusual interface naming in the field.

### 7.3 The bug class, not the bug

Option (d) above is the part to read twice. This disagreement sat in the tree through an entire
work order's gate set and 337 passing tests, and was only found because someone wrote the first
code that used both halves at once. **There is no check anywhere that a vocabulary entry's declared
type matches the data model's declared type.** Today one field trips it. Three sibling fields —
ordinary, aggregate and redundant-ethernet interface names — carry the identical disagreement and
simply are not exercised by the one test config in the tree. When real Juniper exports arrive
(§8), they will exercise them.

Adding that check is small and it is worth doing before the next vocabulary entry is written, not
after.

### 7.4 A check that fails is not wired into anything

`scripts/check-citations.py` exits with a failure code — 58 unresolved references — and CI does not
run it. CI runs four checks; this is a fifth that exists, fails, and gets quoted in reports as
though it were a gate. Nothing is currently wrong because of it. But an unenforced check drifts.
Either wire it in with the 58 recorded as an accepted baseline, or stop quoting its number.
Unchanged from the last report.

### 7.5 The Juniper vocabulary has still never been read by a network engineer

Every entry in `corpus/dict/junos-srx/` — the files that say what each Juniper command means — still
carries the literal text `reviewed_by: <named human>`. That is the placeholder, not a name, and the
project's tenth standing rule says this review is not optional.

It matters more each time. **Two of the three things blocking the round trip live inside these
files**: the missing VPN mode (§2) is a vocabulary gap, and the type disagreement (§2) is a
vocabulary line. A network engineer reading these files is the person most likely to find both, and
the ones not yet found.

### 7.6 The browser result is real but can never be re-checked automatically

Carried forward, unchanged. Sixteen manual checks pass with two screenshots as evidence; this audit
did not re-open a browser (none is available here) and did not re-verify the screenshots, which the
previous audit read and matched against the written results. There is still no automated regression
for any screen, because the browser test harness the project specifies needs external libraries the
project has deliberately never taken. That decision still has no owner.

To repeat the check by hand: `cargo run -p fathom-artifact`, then open
`target/artifact/fathom-dev.html?fixture=demo-estate` from disk. The checklist is section 6 of
`docs/70-ops/79-work-orders/WO-08-the-inventory-face.md`, rows M1–M16.

### 7.7 Smaller things, carried forward

- **The workspace-file order touched two files its own list does not name** — the code generator and
  a graph field type. Flagged in the last report, still unrecorded. Both changes look like
  consequences of the work, but the rule exists so that "consequence of the work" is a judgement
  someone else makes. A line in the order's record either way would close it.
- **The test config is synthetic.** `junos-srx-s0-synthetic.txt` is assembled from documented
  command strings, not captured from a device, and its first line says so in capitals. Every ingest
  test — and the join test that cannot yet be written — passes or fails against a config no device
  ever produced.
- **The browser page still allows inline scripts.** `script-src 'unsafe-inline'` remains, where the
  specification wants exact cryptographic fingerprints. Recorded as scaffolding; the file is named
  `fathom-dev.html`, not a release name. The half carrying the core promise — `connect-src 'none'` —
  is real and checked against the final assembled bytes.
- **The check that would refuse an unapproved third-party library still does not exist.** Zero
  dependencies today, so nothing is breached, but this is the last guard between the project and its
  first unreviewed library.

## 8. What needs a decision, and from whom

Nothing on this list is programming work. Every item is a decision, and the build has now run out of
rows that do not need one.

**For a planning session — these are what the round trip waits on:**

1. **Where the interface-name type disagreement is fixed** (§2, §6, §7.2). Four options written up,
   no preference. Unblocks the join, which is stopped dead.
2. **Whether a check is added comparing vocabulary types against the data model** (§7.3). Small,
   and it is the control for a whole class of defect rather than one instance.
3. **Where a re-read config gets its VPN mode from.** When Fathom reads a config back, nothing tells
   it whether a VPN is route-based or policy-based. The *fact* is not in doubt — a VPN bound to a
   tunnel interface is route-based, and the model allows only two values. What is undecided is
   *which part of the system deduces it*. It must not be the writer, which would be inventing a
   value the engineer never chose.
4. **The two interfaces the golden config references but never declares.** Either the config gets
   those lines, or unresolved references get a home in the store.

**For the owner — unchanged, and now more expensive than last week:**

5. **Real Juniper SRX configuration exports.** Every ingest test runs against a synthetic file. Real
   captures turn a plausible parser into a proven one — and, given §7.3, would exercise the three
   interface types the synthetic file never touches. Highest-leverage item on this list.
6. **One sentence on how a site is identified.** The two standing warnings in the data-model gate
   exist solely because this is unanswered. Not blocked on anything else.
7. **One sentence on how a device is identified.** The sibling of the above, and it is now on the
   critical path: without it, re-reading a config for a box Fathom already knows creates a second
   copy of that box rather than updating the first. The join's documentation says so in its own
   header. Reconciliation cannot be written until this is answered.
8. **Where the IKE warning attaches** — to the interface, or to the security zone?
9. **Is Meraki configurable by text you can copy?** Decides whether it can be supported at all.
10. **Four forks in the graph-extension document.**
11. **Named expert review of the Juniper vocabulary** (§7.5) — now on the critical path, not backlog.

## 9. How this was checked

- The working tree at `fa72d80` on `claude/weld-and-first-browser-run`, read directly. Nothing
  uncommitted; local and remote at the same commit before this file was written.
- All four floor checks re-run from a clean tree, plus the citation checker. Test totals summed
  across every test binary rather than quoted from a summary line.
- `git log` and `git show --stat` across both commits of this run, each one's file list read.
- The nine work-order files and the queue index, status lines read one at a time and compared.
- `docs/70-ops/73-open-decisions.md` §14, every row.
- **For §2, tested rather than read.** A throwaway integration test was written into the join
  component, run, and deleted: it loads the shipped Juniper vocabulary, parses the checked-in
  config file, and calls `apply_new_device` into a fresh store. It returned
  `Err(SlotType { key: FieldKey(55) })`. Field 55 was resolved to `TunnelInterface.name` in the
  generated field table. The cause was then confirmed in three separate files — the data model's
  four interface declarations, the vocabulary line binding the looser type, and the parser's value
  list, which has no entry for the stricter type at all. The tree was left clean afterwards.
- Also for §2: `crates/fathom-emit/tests/` listed in full to confirm no round-trip test file exists;
  every Juniper vocabulary file searched for an entry setting a VPN's mode (one `mode` binding
  exists and it is on the IKE policy, not the VPN).
- The join's own containment gate re-run: 46 pairs, green.
- `Cargo.lock` (fifteen packages, all first-party), `.github/workflows/ci.yml`, `CLAUDE.md`, and the
  rebuilt `target/artifact/fathom-dev.html` including its security policy.

**Disagreements.** None with the tree's own records — the run's account of itself matched what the
tree shows, including the part that reflects badly on it. The disagreements recorded above (§7.1,
§7.7) are between the tree and itself.
