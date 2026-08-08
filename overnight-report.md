# Round trip, second attempt — what landed and what is blocked

> **Status:** Audit record, written 2026-08-08 after the second run on branch
> `claude/weld-and-first-browser-run`, at commit `2e4716a`. Everything below was re-established by
> running the checks and reading the tree and the git history directly. No session's report of
> itself was taken on trust. The one claim that matters most — §2 — was tested by writing a
> throwaway program, running it, printing what came out, and then deleting it. It was not read out
> of anyone's account.

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
| 6 | The escalation inbox — eight questions, three still open |
| 7 | Look at these first |
| 8 | What needs a decision, and from whom |
| 9 | How this was checked |

---

## 1. The short version

Four commits landed since the last report. One of them is engineering; three are decisions and
research written down.

**The join between the reader and the model now works on the real config.** The last report ended
with Fathom's new joining code refusing the only Juniper config in the tree, because the Juniper
vocabulary file and the data model had disagreed for weeks about what type an interface name is.
That disagreement was settled and the fix was made — a single word in one vocabulary file, plus the
two small code changes that word needed. The shipped config now goes all the way from pasted text
into the model without complaint. Sixteen new tests were written to prove it, and none of them was
softened to make it pass.

**The pipeline then produced 19 of the 21 lines it is supposed to produce, and correctly refused to
hand them over.** This is the real result of the run, and §2 sets it out in full. It is much closer
to working than "blocked" makes it sound, and the two things missing are both known, both named,
and both waiting on a decision rather than on code.

**What is now blocked is smaller and sharper than what was blocked yesterday.** Yesterday it was
"three decisions and a missing component." Today the component exists and works; what remains is
three decisions, each with the options spelled out and none of them requiring anyone to invent
anything.

Everything automated is green: **353 tests, none failing, none skipped, none filtered out** — up
from 337. The code formatter, the code linter and the schema checker are all clean.

## 2. The headline: can Fathom read a Juniper config and write it back?

**Almost. It reads the config, rebuilds the commands correctly, and then refuses to release them —
for two reasons that are both correct refusals, not bugs.**

This audit tested it rather than reading a claim about it. Here is exactly what was done and
exactly what came out.

### The test that was run

A throwaway program was written that does the whole loop, end to end, with nothing hand-fed in the
middle:

1. Read the checked-in Juniper SRX config file
   `crates/fathom-ingest/tests/fixtures/junos-srx-s0-synthetic.txt` — 42 lines of `set`-form
   configuration, marked in its own first line as synthetic and not a capture of any real device.
2. Parse it with Fathom's real Juniper vocabulary (the files under `corpus/dict/junos-srx/`).
3. Load the result into Fathom's model with the new joining code (`crates/fathom-weld`).
4. Ask Fathom's writer (`crates/fathom-emit`) to write the VPN back out as Juniper commands.
5. Print everything that came out, including every refusal.

**No crate in the tree does steps 1–4 and step 5 together.** The reading half and the writing half
have never been in the same program before this probe. That is the gap this report exists to
measure, and the probe was removed again afterwards — the tree is exactly as the run left it.

### What came out

The parse produced **13 objects** from the config. The writer walked the VPN and produced
**19 configuration lines**. Those 19 lines are, word for word and in the same order, 19 of the 21
lines that Fathom's own reference answer says a correct emit of that VPN should produce. Not
similar — identical, checked line by line by a script, with zero unexpected lines and zero
reordering.

The two missing lines are exactly these:

```
set security ike gateway GW-B external-interface reth0.0
set security ipsec vpn VPN-B bind-interface st0.0
```

Both are interface references. Both are missing for the same reason: **the config file mentions
`reth0.0` and `st0.0` but never configures them**, so Fathom has nothing to point those references
at and honestly leaves them dangling rather than inventing an interface.

Then the writer **refused to hand over the finished config**, and reported two blockers:

| Blocker | What it means in plain terms |
|---|---|
| The IKE gateway `GW-B` has no external interface | The same dangling `reth0.0` reference above. Fathom will not emit a gateway it knows is incomplete. |
| The VPN `VPN-B` has no `mode` | Nobody has yet decided where the VPN's mode comes from when a config is *re-read* rather than built by hand. The field is genuinely unknown, and Fathom will not guess. |

So the answer to the headline question is: **the reading works, the model-building works, the
writing works, and the release gate correctly says no.** What is missing is not machinery. It is
two facts the config file does not contain and one decision nobody has made.

### The security result, which is the good news buried in the above

One of the 19 lines is:

```
set security ike policy IKE-POL pre-shared-key ascii-text "<PSK>"
```

The source file at that point contains a pre-shared key. It went in as a secret and came out as the
placeholder `<PSK>`. **No credential from the source file appeared anywhere in the output.** The
config file is deliberately seeded with marker strings that look like secrets so this can be
checked; none of them survived. The redaction gate is not a promise in a document — it was watched
working, in the same run, on the whole loop.

### What the tests would catch if the writer were wrong

The writer's own test (`crates/fathom-emit/tests/worked_example.rs`) holds the correct 21-line
output as literal text in the test file and compares the emitted bytes against it character for
character. If any command's spelling, argument order, quoting or line order changed, that test goes
red immediately — there is no fuzzy matching and no regeneration-on-failure. What that test does
**not** cover is the path this audit probed: its model is built by hand inside the test, not read
from a config file. The test that would close that gap is
`crates/fathom-emit/tests/round_trip.rs`, and **it does not exist yet** — it is specified in detail
and is waiting on the decisions in §8.

### The honest limitation

Nothing above says Fathom can round-trip an arbitrary Juniper config. It says Fathom round-tripped
**one synthetic 42-line SRX VPN config, minus two lines it could not resolve, and refused to
publish the result.** One config, one platform, one feature area. That is a real milestone and it
is a narrow one.

## 3. The verification floor — the exact numbers

All four required checks were re-run from a clean state on 2026-08-08 at commit `2e4716a`.

| Check | Result |
|---|---|
| Code formatting (`cargo fmt --all --check`) | Clean — no output, exit 0 |
| Code linter, warnings treated as errors (`cargo clippy --all-targets -- -D warnings`) | Clean |
| Test suite (`cargo test --workspace --locked`) | **353 passed, 0 failed, 0 ignored, 0 filtered out** |
| Schema checker (`fathom-schema-check`) | Exit 0. 48 object kinds, 89 relationship kinds, 61 value types, 10 enumerations, 14 files. 0 failures, 2 warnings — both the long-standing `Site` warnings that are deliberate and waiting on an owner decision |

"0 ignored, 0 filtered out" is the number that matters as much as 353: it means no test was
switched off, marked as skipped, or excluded to reach a green result.

**A fifth check exists and is not in CI: `scripts/check-citations.py`.** It verifies that every
cross-reference between the project's documents points at a section that really exists. It reports
**8,635 references checked, 58 unresolved, exit code 1.** That looks alarming and is not new: the
identical script run against the branch point reports **58 unresolved out of 8,376**. This run added
259 cross-references and **zero new broken ones**. The 58 are a pre-existing backlog, concentrated in
the review and decision documents, and no one has ever set out to clear them. It is worth clearing;
it is not a result of this run.

## 4. What actually ran, in order

Four commits, all on 2026-08-08, all on `claude/weld-and-first-browser-run`, none yet merged to the
main branch.

| Time | Commit | What it did |
|---|---|---|
| 20:19 | `403b80b` | **Settled the type disagreement.** Decided that the Juniper vocabulary was wrong and the data model was right about interface names, authorised the exact one-line fix, and filed the missing safety check that would have caught the disagreement years earlier. Documents only. |
| 20:47 | `a34b05e` | **Answered the owner's question about grouping and tagging.** Recommends a deliberate "Group" object over free-text tags, and records the finding that shrinks the question: most of what people want tags for, the model already does — every device already belongs to exactly one site and cannot not. The free-text case was checked against how two mature systems actually behave rather than assumed. Documents only. |
| 22:05 | `f8ee388` | **Recorded the owner's decisions about the diagram view.** Documents only. |
| 22:26 | `2e4716a` | **The engineering commit.** Executed the authorised one-word fix in `corpus/dict/junos-srx/interfaces.yaml`, plus the two small code changes it needed, and the shipped config then loaded cleanly. Wrote three new test files — 16 tests covering the join itself, the record of where every value came from, and the guarantee that the same input always produces the same output. Then stopped, and filed the reason. |

The engineering commit's own message is worth quoting on the point that matters most: the main test
file *"is back, with §4.6's nine names and no assertion softened — it was right and the tree was
wrong, and the tree is fixed."* That is the correct order of operations, and this audit confirmed
it: the assertions in that file are the ones the work order specified, unaltered.

## 5. The queue: every row, claimed against real

The project tracks work as numbered "work orders." There is an index table and each order also
carries its own status line; the rule is that **the order's own status line is the truth and the
index mirrors it.** Both were read.

| Order | What it builds | Index says | Its own file says | Agree? |
|---|---|---|---|---|
| WO-06 | Search/finder cleanup | DONE | DONE | Yes |
| WO-01 | The value-type system | DONE | DONE | Yes |
| WO-02 | The model store | DONE | DONE | Yes |
| WO-07 | The browser-shipping shell | DONE | DONE | Yes |
| WO-03 | Reading Juniper SRX configs | DONE | DONE | Yes |
| WO-04 | Writing Juniper SRX configs | BLOCKED on WO-09 | BLOCKED on WO-09 | Status agrees — **but its stated reasons are stale; see below** |
| WO-05 | The saved workspace file | DONE | DONE | Yes |
| WO-08 | The first product screen | DONE | DONE | Yes |
| WO-09 | The join between reader and model | BLOCKED | BLOCKED | Yes |

**One real divergence, and it is in the reasons rather than the verdict.** WO-04's own status line
still says the join order is *"BLOCKED at its first plan step"* over a question about how one piece
of data is written to disk, and that *"no `fathom-weld` crate and no `apply_new_device` exist in the
tree."* All three claims are now false against the tree: that question was answered and executed
earlier in this branch, the crate exists, and the function exists. WO-04 is still correctly
**BLOCKED** — its verdict is right — but anyone reading its status line to find out *why* will be
told something that stopped being true nine hours before this report. The index table, by contrast,
is current. Both should say the same thing, and the fix belongs in the work-order file.

**One thing the project's own front page gets wrong.** `CLAUDE.md`, the file a new session reads
first, still says the sixteen manual browser checks are *"honestly recorded NOT RUN"* and that
*"nothing has ever been opened in a browser."* That was true two days ago. Earlier on this same
branch (commit `6702307`, 13:19) the product was opened in a browser for the first time and **all
sixteen checks passed**, with two screenshots committed as evidence. The checks include the one that
matters most for the project's core promise: the page made exactly one network request — for itself
— and none beyond it.

## 6. The escalation inbox — eight questions, three still open

When a build session hits something its instructions do not decide, it is required to stop and file
the question rather than guess. The register is section 14 of
`docs/70-ops/73-open-decisions.md`. It now holds **eight rows. Five are answered. Three are open.**

**Answered:**

- How the register itself should be formatted (answered; the protocol's format won over an invented
  one).
- Two questions from the workspace-file order about how values are written to disk (both answered:
  the wire format follows the value type, and one identifier format was re-issued to match what
  three other places in the tree already did).
- How the parse-origin record is written to disk (answered, then executed).
- **The interface-name type disagreement** (answered, then executed — this is the one that unblocked
  §2's result).

**Still open:**

1. **(Search) The ranking formula has no term for query-side word weights**, so a hyphenated search
   term scores as three whole words. Either the formula gains the factor or the factor is removed
   and the reference results are regenerated.
2. **(Search) A worked example in the specification expects a tie to break one way** and the
   implemented arithmetic breaks it the other. Either the example is rewritten to the real
   arithmetic, or a tie-break rule is specified.
3. **(The join) Ten of the thirteen objects a parsed config produces have no stated parent** — see
   §7, this is the one that stopped the run.

The first two are search-quality questions that block nothing. The third blocks the queue.

## 7. Look at these first

In the order a human should look at them.

### 7.1 The parsed config produces an unreachable device

This is the single thing that stopped the run, and it is worth understanding because it affects more
than one part of the product.

When Fathom parses that Juniper config it produces 13 objects. **Only 3 of them say what they belong
to**, and none of those 3 says it belongs to the device. So the device object ends up with nothing
attached to it — checked directly: zero connections of any of the 81 possible kinds. The VPN, the
IKE proposals, the policies, the zones all exist, but nothing links them back to the box they came
from.

The model store is right to accept this — the "everything has exactly one parent" rule is checked
later, at export and validation time, not at write time. Which is exactly why every automated check
stayed green while this was true. That is the useful lesson: **the floor was green and the result
was wrong, and the floor was not lying.** It was measuring something else.

The consequence is concrete. Any screen that starts at a device and walks outward — the inventory
screen, the config writer, any future diagram — would find nothing after the first paste. The build
session correctly refused to paper over it, and wrote out four options with no preference expressed:
the join could default the parent to the device; the parser could set it; the vocabulary files could
declare it; or the requirement could be withdrawn as premature. Each has a named cost. The full
argument is in section 10, item 10 of
`docs/70-ops/79-work-orders/WO-09-the-fragment-to-store-weld.md`.

**One sentence closes this.** It is the highest-value sentence available to write today.

### 7.2 The Juniper vocabulary file still has a placeholder where a reviewer's name goes

`corpus/dict/junos-srx/interfaces.yaml` — the file that was edited this run — carries
`reviewed_by: <named human>`. That is a placeholder, and the file itself says so in a comment. The
project's tenth invariant requires a named human to have reviewed every vocabulary entry, and no
entry in this file has one. That was true before this run; this run edited the file and did not
change it. It is not a new problem, but it now sits on the file that just decided the shape of §2's
result.

### 7.3 The stale status line on the config-writing order

Covered in §5. Small, mechanical, and it will mislead the next person who reads it.

### 7.4 The 58 broken cross-references, and that nothing enforces them

Covered in §3. The count did not grow, but the check is not part of the automated gate set, so
nothing stops it growing. The project already has a story about why this matters: it was written
after nine places in the tree pointed at a document section that did not exist.

## 8. What needs a decision, and from whom

**Blocking the queue right now — nobody can build the next thing until these are answered:**

1. **Where does a top-level object's parent come from?** (§7.1.) Four options written out, no
   preference expressed. One sentence.
2. **Where does a VPN's `mode` come from when a config is read back?** This is the second of the two
   blockers in §2, and it is the last thing standing between the current state and a genuine
   config-in, config-out proof. Also one sentence.
3. **What should happen when a config references an interface it never configures?** — the
   `reth0.0` / `st0.0` case. Today Fathom leaves the reference dangling and refuses to emit the line,
   which is defensible; it needs to be a decision rather than a default.

**Owner-only, still outstanding from before this run:**

- The rule for when two site records are the same site, and the same rule for devices. Without the
  device rule, pasting the same box's config twice creates two devices rather than updating one. One
  sentence each.
- The real sample configs from the field (Calix, Nokia, a DIA circuit), one service record traced
  end to end, and the site list. Everything about non-Juniper platforms waits on these.
- A named expert to review the Juniper vocabulary files (§7.2).
- Whether the IKE warning belongs on the interface or the zone; whether Meraki is configurable by
  text you can copy.

## 9. How this was checked

- Every number in §3 comes from running the command and reading its output in this session. None was
  copied from a commit message, a work order, or the previous report.
- §2's result comes from a program written in this session that ran the whole loop and printed what
  came out. Its output was compared line by line against the writer's reference answer by a script,
  not by eye. The program was deleted and the working tree confirmed clean afterwards.
- §3's citation baseline comes from checking out the branch point into a separate working copy and
  running the identical script there, so "58 was already 58" is a measurement rather than an
  assumption.
- §5 comes from reading each work order's own status line and comparing it against the index table
  and against what is actually on disk — including checking whether the crate and function WO-04
  says do not exist, exist. They do.
- §4's commit list comes from `git log` against the main branch, not from any session's account of
  itself.
