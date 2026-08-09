# Round trip, third attempt — what landed and what is blocked

> **Status:** Audit record, written 2026-08-08 after the third run on branch
> `claude/weld-and-first-browser-run`, at commit `63a9c8a`. Everything below was re-established by
> running the checks and reading the tree and the git history directly. No session's report of
> itself was taken on trust. The claim that matters most — §2 — was tested by writing a throwaway
> program, running it, printing what came out, and then deleting it. It was not read out of
> anyone's account.

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
| 6 | The escalation inbox — eight questions, two still open |
| 7 | Look at these first |
| 8 | What needs a decision, and from whom |
| 9 | How this was checked |

---

## 1. The short version

Three commits landed since the last report. One is engineering; two are a decision and its
follow-up check.

**The estate is now joined up.** Yesterday Fathom could read a Juniper config into its model, but
the device it created sat on its own with nothing attached to it — thirteen objects in the box and
no lines between the device and the twelve others. Every screen Fathom is meant to have starts by
clicking a device and walking outwards, so a device with nothing attached is a device no screen can
show. That is fixed. The parsed config is now **one connected estate rooted at the device it came
from**: thirteen objects, nineteen connections, and a test that walks outward from the device
across every one of the 81 connection types Fathom knows about and proves nothing at all is left
outside the walk.

**How it was fixed is the interesting part.** The Juniper vocabulary files never say which thing
contains which. The last session read that as missing information and asked how to invent it. The
answer was that it was never missing: Fathom's data model already fixes, for each type of object,
what kind of thing may contain it. So the code now *looks it up* instead of guessing — and if the
model ever stops giving exactly one answer, the code stops and says so rather than picking one.
There is a caveat to that, in §7.

**The writing half is unchanged and still correctly refuses.** Fathom reads the config, rebuilds
19 of the 21 Juniper commands for the VPN word for word, and then declines to hand them over
because two things are genuinely unknown. §2 sets this out in full, tested rather than asserted.

**Everything automated is green: 354 tests, none failing, none skipped, none filtered out** — up
from 353. Formatter, linter and schema checker all clean.

**Nothing new was escalated.** For the first time in this branch's history, a run finished without
finding a new question it could not answer.

## 2. The headline: can Fathom read a Juniper config and write it back?

**Almost — and the "almost" is precise. It reads the config, builds a correct model, rebuilds the
Juniper commands correctly, and then refuses to release them, for two reasons that are both correct
refusals rather than bugs.**

This audit tested it rather than reading a claim about it.

### The test that was run

A throwaway program was written that does the whole loop end to end, with nothing hand-fed in the
middle:

1. Read the checked-in Juniper SRX config file
   `crates/fathom-ingest/tests/fixtures/junos-srx-s0-synthetic.txt` — 42 lines of `set`-form
   configuration, marked in its own first line as synthetic and not a capture of any real device.
2. Parse it with Fathom's real Juniper vocabulary (the files under `corpus/dict/junos-srx/`).
3. Load the result into Fathom's model with the joining code (`crates/fathom-weld`).
4. Ask Fathom's writer (`crates/fathom-emit`) to write the VPN back out as Juniper commands.
5. Save the whole model to a workspace file, load it back, and save it again.
6. Print everything that came out, including every refusal.

**No crate in the tree does steps 1–4 together.** The reading half and the writing half have never
been in the same program in the repository — verified by checking every source and test file for
one that mentions both, and there is none. That gap is what this section exists to measure. The
probe was deleted afterwards; the tree is exactly as the run left it.

### What came out

```
welded: 13 nodes, 19 edges
emitted lines: 19
blockers: 2
conflicts: 0
gaps: 1
WORKSPACE ROUND TRIP BYTE-IDENTICAL: true (33823 bytes)
RENDER REFUSED: Blockers { count: 2 }
```

The parse produced **13 objects** and **19 connections** between them. The writer walked the VPN
and produced **19 configuration lines**. Those 19 lines are, word for word and in the same order,
19 of the 21 lines that Fathom's own reference answer says a correct emit of that VPN should
produce. Not similar — identical, and in the same order, with zero unexpected lines.

The two missing lines are exactly these:

```
set security ike gateway GW-B external-interface reth0.0
set security ipsec vpn VPN-B bind-interface st0.0
```

Then the writer **refused to hand over the finished config**, with two blockers — and the audit
read the raw blocker records rather than a summary of them:

| What the machine reported | What it means in plain terms |
|---|---|
| `IkeGateway GW-B — MissingRequiredEdge { edge: ExternalInterface }` | The config says the tunnel gateway lives on `reth0.0`, but the config never configures `reth0.0` anywhere. Fathom records the dangling reference honestly and refuses to emit a gateway it knows is incomplete. It does not invent the interface. |
| `IpsecVpn VPN-B — field 181, RequiredUnknown` | Field 181 is `IpsecVpn.mode` — route-based or policy-based. Nobody has yet decided where that fact comes from when a config is *re-read* rather than built by hand. No Juniper vocabulary entry produces it. The field is genuinely unknown and Fathom will not guess. |

The second one also explains the missing `bind-interface st0.0` line: in the writer, the VPN's mode
produces no command of its own, but the `bind-interface` line is only written when the mode is
route-based. Mode unknown, so no line. **Two unknowns, two missing lines, one refusal — and nothing
else wrong.**

So the answer to the headline question is: **the reading works, the model-building works, the
writing works, the save-and-reload works, and the release gate correctly says no.** What is missing
is not machinery. It is one fact the config file does not contain and one decision nobody has made.

### The save-and-reload result, which is new in this run

The whole 13-object estate was saved to a workspace file — 33,823 bytes — loaded back, and saved
again. **The two saves are byte-for-byte identical**, and the reloaded model has the same 13 objects
and 19 connections. Nothing was lost or reordered in the trip through the file. This had been proven
before on a model built by hand inside a test; this is the first time it has been shown on a model
that came from a real pasted config.

### The security result

One of the 19 emitted lines is:

```
set security ike policy IKE-POL pre-shared-key ascii-text "<PSK>"
```

The source config at that point contains a pre-shared key. It went in as a secret and came out as
the placeholder `<PSK>`. The config file is deliberately seeded with marker strings that look like
secrets, precisely so this can be checked. The audit searched for those markers in three places at
once — **the saved workspace file, the emitted command lines, and the emit report** — and found
none in any of them. The redaction gate is not a promise in a document; it was watched working, on
the whole loop, in the same run.

### What the tests would catch if the writer were wrong

The writer's own test, `crates/fathom-emit/tests/worked_example.rs`, holds the correct 21-line
output as literal text inside the test file and compares the emitted bytes against it character for
character. If any command's spelling, argument order, quoting or ordering changed, that test goes
red immediately — there is no fuzzy matching and no regenerate-on-failure.

What that test does **not** cover is the path this audit probed: the model it emits from is built by
hand inside the test, and the one field the whole round trip is blocked on — the VPN's mode — is one
of the values it sets by hand. So the writer is well covered against writing the wrong command; it
is not covered at all against the model being built wrong from real text. The test that closes that
gap is `crates/fathom-emit/tests/round_trip.rs`. **It does not exist.** It is specified line by line
in the emitter's work order and is waiting on the two decisions in §8, not on anyone's time.

### The honest limitation

Nothing above says Fathom can round-trip an arbitrary Juniper config. It says Fathom round-tripped
**one synthetic 42-line SRX VPN config, minus two lines it could not resolve, and refused to publish
the result.** One config, one platform, one feature area. That is a real milestone and it is a narrow
one.

## 3. The verification floor — the exact numbers

All five checks were run by this audit at commit `63a9c8a`. The first four are the ones the project
requires on every change and the ones the automated build runs; the fifth is a house-keeping tool
that no automated build runs (see §7).

| Check | What it is | Result |
|---|---|---|
| `cargo fmt --all --check` | Code layout is uniform | Clean — no output, exit 0 |
| `cargo clippy --all-targets -- -D warnings` | Code smells are errors, not warnings | Clean, exit 0 |
| `cargo test --workspace --locked` | Every test in the project | **354 passed, 0 failed, 0 ignored, 0 filtered out** |
| `cargo run -p fathom-schema --bin fathom-schema-check` | The data model checks itself | Exit 0. 48 object types, 89 connection types, 61 value types, 10 enumerations, 14 files. 0 failures, **2 warnings** |
| `scripts/check-citations.py` | Every cross-reference between documents points at a section that exists | **8,640 references checked, 58 unresolved, exit 1** |

Two things to say about the numbers.

**The 2 schema warnings are the standing, expected ones.** Both are the same thing: the model
declares no rule for telling two `Site` records apart, and something else in the model assumes there
is one. That is a one-sentence answer the owner owes and it is deliberately left showing rather than
suppressed. Nothing moved.

**The 58 unresolved cross-references are not new.** The audit checked this rather than assuming it:
the same script was run against the branch's starting point and against the shared `main` branch,
and both report **8,376 references checked, 58 unresolved** — the identical 58. This branch added
264 new cross-references and broke none of them. Zero regression. But the number is not zero and
nothing forces it down; see §7.

## 4. What actually ran, in order

Three commits since the last report, all on 2026-08-08.

| Commit | Time | What it did |
|---|---|---|
| `b3e1bcb` | 22:47 | **Answered the question the last run stopped on.** The Juniper vocabulary never says which object contains which, so the previous session escalated it with four options and no preference. The answer: the data model already fixes it, so look it up rather than default to anything. Documents only — no code. |
| `7b5c8bc` | 23:00 | **The engineering.** Applied that answer. An object that declares no container now takes the container the model determines for its type, and the code refuses outright if the model ever names other than exactly one. The device stopped being isolated; a new test walks the whole estate outward from it and proves nothing is left over. Tests went 353 → 354. |
| `63a9c8a` | 23:13 | **Re-tested the emitter's work order** to see whether finishing the join had unblocked it. It had not, for reasons that are not about code. Documents only. |

The pattern is worth noting because it is the protocol working: the session that hit the problem
stopped and wrote down the question instead of guessing; a later step answered it in writing; a
later step still executed the answer. Three separate acts, each auditable on its own.

**One thing to be uneasy about.** The commit message for `7b5c8bc` records that a previous session
deleted a failing test inside its own working area without ever committing it, so there is no earlier
version to compare against and no way to prove that test was not softened to make it pass. The
session that noticed this said so plainly rather than glossing it. What could be checked was checked
— the test names match the specification in order, the tests drive the real config through the real
vocabulary, and every assertion has a guard that makes it fail if it is being fed nothing. There is
no evidence of weakening and no proof of identity. Recorded here because it is the sort of thing that
should not be discovered later.

## 5. The queue: every row, claimed against real

Nine units of work exist. The audit compared the master list against each unit's own status line,
because the rule is that the unit's own line wins if they ever disagree.

**They do not disagree. All nine agree, including the wording of the two blocking reasons.** That is
the first clean result on this branch.

| Unit | What it builds | Status |
|---|---|---|
| WO-06 | Finishing the search engine | DONE |
| WO-01 | The value types (IP addresses, interface names and so on) | DONE |
| WO-02 | The model store itself | DONE |
| WO-07 | The search engine compiled to run in a browser | DONE |
| WO-03 | Reading Juniper SRX configs, including the redaction gate | DONE |
| **WO-04** | **Writing Juniper SRX configs back out** | **BLOCKED** — on two decisions, not on code |
| WO-05 | The workspace file: saving and loading | DONE |
| WO-08 | The first screen: the inventory table | DONE |
| WO-09 | Joining a parsed config into the model | DONE |

The emitter's own status line names its two blocking reasons as the VPN mode question and the
undeclared-interface question. **Those are exactly the two blockers the running program reported in
§2** — verified against the machine, not against the prose. The documents and the code agree about
what is wrong, which is not something to take for granted.

## 6. The escalation inbox — eight questions, two still open

When a build session hits something its instructions do not decide, it stops and files the question
in one table rather than deciding it. That table lives at the end of
`docs/70-ops/73-open-decisions.md`, the project's open-questions document.

It holds **eight** questions. **Six are answered. Two are open.**

| # | From | Question | State |
|---|---|---|---|
| 1 | Search engine | How to file two pre-written questions into a table whose format had changed | Answered |
| 2 | Search engine | The ranking formula has no term for query-side weighting, so a hyphenated search term scores as three whole words | **OPEN** |
| 3 | Search engine | A worked example in the specification expects a ranking the implemented arithmetic does not produce | **OPEN** |
| 4 | Workspace file | Seven value types were reshaped and the save-format table no longer covers them — and one of them would have silently dropped a secret's label | Answered |
| 5 | Workspace file | A pinned test value writes identifiers in a form three other places in the project refuse | Answered |
| 6 | The join | Parse provenance could not be written to the workspace file at all — the format had no room for it | Answered |
| 7 | The join | The Juniper vocabulary and the data model disagreed about what type an interface name is | Answered |
| 8 | The join | Ten of thirteen parsed objects declared no container, leaving the device isolated | Answered, and executed this run |

**The two open ones are both about search ranking maths**, both filed on 2026-08-02, both for the
project's planners rather than for the owner, and neither blocks anything currently in the queue.

**One divergence to fix.** The summary paragraph at the top of that table still says *"Seven rows …
four of seven answered, three open"*, and question 8's row carries no "answered" marker even though
its answer is written up in the join's own work order and was executed in commit `7b5c8bc`. The
table itself is right; the summary above it and one row's marker are stale. Small, mechanical, and
worth doing before someone reads the summary and believes it.

## 7. Look at these first

Six things, in the order a human should look at them.

**1. Two decisions are the whole of what stands between here and a working round trip.** They are
in §8. Everything else in this report is bookkeeping by comparison. Both are single answers; neither
requires anyone to invent a mechanism.

**2. The project's own session-pickup page is out of date on its most quotable line.** `CLAUDE.md`
still says *"Nothing has ever been opened in a browser: WO-08's sixteen manual rows are honestly
recorded NOT RUN."* That has been false since commit `6702307`. The inventory screen's work order
records **RUN 2026-08-08 — ALL SIXTEEN PASS**, with each of the sixteen checks written out with its
observed result: zero network requests beyond the file itself, zero console errors, the table
rendering, keyboard navigation, the theme toggle. This is the first sentence a new session reads,
and it currently understates the project.

**3. The rule that was just built in is narrower than the sentence that justified it.** The answer
in commit `b3e1bcb` said no object type in the model has more than one possible container — *"not
one."* That is wrong, and the very next commit says so: `LogicalUnit` has four possible containers,
`ExternalPeer` and `PhysicalPort` have two each, and seven types have none at all. The decision
still stands, because the code refuses rather than guesses in exactly those cases, and none of them
can be reached from today's Juniper vocabulary — the one `LogicalUnit` the config produces has its
container spelled out explicitly. **But the forward risk is real:** the day a vocabulary entry
produces a `LogicalUnit` without saying what contains it, the paste stops with a refusal. That is
better than a wrong answer, and it is still a stop. Worth knowing before it happens rather than
after.

**4. The cross-reference checker is permanently red and nothing enforces it.** `scripts/check-citations.py`
exits with a failure — 58 unresolved references — and it is not one of the checks the automated build
runs. The build runs four checks; this is a fifth that only runs when someone remembers. A tool that
always fails and blocks nothing teaches people to ignore it. Either the 58 get fixed and the tool
joins the build, or it should be honestly labelled advisory. It is currently neither.

**5. The dependency gate that the project's own rules require still does not exist.** The build
configuration says so in its own comments: a rule was ratified on 2026-08-08 requiring the build to
fail if an outside software package is added without an approval record, and *"it must land before
the first one does."* Fathom has **zero** outside dependencies today, so nothing is breached — but
the guard is the thing that has to be there before, not after.

**6. The end-to-end test still does not exist, and that is the gap this report keeps measuring by
hand.** Every run of this branch has answered the headline question with a throwaway program that
gets deleted. That is honest but it is not a gate — it proves nothing about tomorrow. The test that
would make it permanent is `crates/fathom-emit/tests/round_trip.rs`, and it is blocked on item 1.

## 8. What needs a decision, and from whom

Two questions. Both are the owner's or the planners'; neither is a build session's to decide.

**Decision 1 — where does a VPN's mode come from when a config is re-read?**
Fathom's writer will not emit a VPN without knowing whether it is route-based or policy-based, and
it is right not to. When someone builds a VPN inside Fathom they state the mode. When Fathom reads
an existing config, nothing states it — no Juniper vocabulary entry produces that field, and no
planning document says how it should be worked out. The plausible answer is that a VPN with a
`bind-interface` is route-based and one without is policy-based, which is how a network engineer
would read it — but that is a rule someone has to *decide*, not one a build session may assume.
Until it is decided, no config Fathom reads can ever be written back out.

**Decision 2 — what should Fathom do with a config that references an interface it never
configures?**
The test config names `reth0.0` twice — the tunnel gateway's external interface, and a security zone
membership — and never configures `reth0` anywhere. This is completely normal: people paste one
section of a config, not the whole thing. Today Fathom records both references as unresolved, refuses
to invent the interface, and consequently refuses to emit the gateway. That is the safe behaviour and
it may well be the right one. But it means **any partial config paste is unemittable**, and the
project's largest unbuilt requirement — automatically correlating separately-pasted configs — exists
precisely to handle references that live in another paste. Someone should say whether "refuse" is the
final answer or the placeholder.

There is also a **third, quieter one** that is not blocking today and will be soon: the model declares
no rule for telling two devices apart, and none for telling two sites apart. That is the same
one-sentence answer twice. Without it, re-reading a config Fathom has already seen creates a second
copy of the device rather than updating the first — so no config can ever be refreshed, only added.
The re-reading feature is unwritten and unstarted because of it, and the two `Site` warnings in §3 are
the same gap showing through the schema checker.

## 9. How this was checked

So that any of it can be re-run.

- **The floor:** all five checks in §3 executed at commit `63a9c8a` on a clean working tree
  (`git status` empty). The test total was counted by summing every reported result line, not by
  reading a number out of a commit message.
- **The cross-reference baseline:** the same script was run against the branch's starting point
  (`c78ee3d`) and against the shared `main` branch, each in a separate temporary checkout, to
  establish that the 58 unresolved references pre-date this branch. Both report 58. The temporary
  checkouts were removed.
- **The queue:** the master list's status column was compared against the status line at the top of
  each of the nine work-order files individually.
- **The escalation inbox:** every row of the table in `docs/70-ops/73-open-decisions.md` §14 was read,
  and each "answered" claim was checked against the document the row points at.
- **The headline (§2):** a throwaway program outside the repository, depending on the real crates by
  path, doing config file → parse → model → emit → save → reload → save, printing raw results. Its
  full output is reproduced in §2 unedited. The blocker records were read as raw machine output, and
  the field number in the second blocker (`181`) was resolved back to `IpsecVpn.mode` by looking it up
  in the generated field registry rather than inferring it. The program was deleted; the tree is
  unchanged.
- **The security check (§2):** the secret markers were searched for in the serialised workspace file,
  the emitted command lines and the emit report, in the same program run, after the full loop.

Nothing in this report was taken from a previous report, a commit message or a work order's account
of itself, except where it is explicitly labelled as such.
