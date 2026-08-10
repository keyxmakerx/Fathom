# The on-ramp — you can now paste a config into Fathom and look at it

> **Status:** Build record, written 2026-08-09 on branch
> `claude/docs-recommendations-review-l7mlhh`. Everything below was run, not recalled: the
> numbers come from executing the checks, and the browser results come from opening the file in
> a real browser and reading what was on the screen. Screenshots are checked in alongside this
> report so you can see it without building anything.

Written for someone who runs networks, not someone who writes Rust.

## 0. Contents

| § | |
|---|---|
| 1 | The short version |
| 2 | What you can do now that you could not do yesterday |
| 3 | What it did with a real config, line by line |
| 4 | What is deliberately still missing |
| 5 | The checks — the exact numbers |
| 6 | Three things worth knowing |
| 7 | The two questions you were asked — both now answered |
| 8 | How to see it yourself |

---

## 1. The short version

**Fathom now has an input.** Until today the engine could read a Juniper config and the browser
page could draw an estate, but they were not connected to each other: the page only ever showed a
hard-coded demo, and the parser only ever ran in tests. There was no box to paste anything into.

There is now. Open the file, click **paste a config** at the top right, paste in the output of
`show configuration | display set`, click **read this config**, and the page fills with what Fathom
understood — and, just as important, with a list of every line it did not.

**Nothing else about the product changed.** No new outside software, no network access of any kind,
same four checks, all green. The whole thing is still one file you open from your disk.

## 2. What you can do now that you could not do yesterday

Three things, all of them in the browser rather than in a test:

1. **Paste a real config and get an estate.** The device, its interfaces, its units, its zones, its
   IKE and IPsec objects — all read out of the text and drawn as a graph you can click through.
2. **See exactly what was not read.** Every line Fathom could not turn into a fact is listed back
   to you with the line number, the line itself, and why. Nothing is silently dropped.
3. **Watch a secret disappear.** The pre-shared key in the pasted text is destroyed before anything
   is stored. It is not in the page, not in the graph, and not in anything the page can reach
   afterwards — there is now a test that checks all three.

## 3. What it did with a real config, line by line

A 26-line branch-office SRX config: WAN interface, a route-based IPsec tunnel to head office, two
security zones, a static route, one security policy, and one pre-shared key.

**What came back:**

| | |
|---|---|
| Things understood | **15** |
| Connections between them | **23** |
| Lines not read | **5** |
| Secrets removed | **1** |
| Names used but not defined | **0** |

**The five lines it did not read, exactly as the page shows them:**

| Line | The statement | Why |
|---|---|---|
| 2 | `set system domain-name branch.example.net` | not in the dictionary past the first word |
| 4 | `set interfaces ge-0/0/0 description "WAN to ISP"` | not in the dictionary past the first 2 words |
| 24 | `set routing-options static route 10.10.0.0/16 next-hop st0.0` | not in the dictionary |
| 25 | `set security policies … match source-address any` | not in the dictionary past the first word |
| 26 | `set security policies … then permit` | not in the dictionary past the first word |

None of those five is a bug. They are the honest shape of the vocabulary Fathom has today.

**Two of the five are now fixed — and I was wrong about how cheap they were.** I said `description`
and `domain-name` were one-line additions to the vocabulary file. They were not: the parser's table
of value types had no entry for free text or for a domain name, so each needed a value type, a
parse arm and a store arm as well as the vocabulary line. That is still small — about twenty lines
of code and three vocabulary entries — but it is not one line, and the difference matters because it
is the true cost of *every* statement that binds a kind of value Fathom has not met before.

They are in as of 2026-08-10, verified against Juniper's own CLI reference on that date rather than
from memory. `description` turned out to be valid at **two** hierarchy levels — on the port and on
the unit — which are facts about different objects, so it is two entries, not one, and there is a
test that fails if a unit's description ever gets recorded against its port. **The same config now
reads 3 unread lines instead of 5.** The routing and policy statements that remain are real bodies
of work.

**The pre-shared key.** The config contains
`set security ike policy ike-pol pre-shared-key ascii-text "SuperSecret123"`. After the paste, the
literal string `SuperSecret123` appears nowhere in the page's text, nowhere in its HTML, and
nowhere in any table you can navigate to. The page reports *"1 secret removed"* and keeps only what
kind of secret it was.

## 4. What is deliberately still missing

So the picture is not rosier than the tree.

- **One box at a time.** Pasting a second config replaces the first rather than adding to it.
  Joining separate pastes into one estate is the biggest unbuilt requirement in the project. Half
  of what it needed — knowing when two pastes are the same box — landed today (§7); what it still
  needs is a decision about what you see when Fathom thinks it recognises a box.
- **Juniper SRX only.** The other five platforms are registered and empty.
- **No diagram yet.** This is the inventory table and the inspector. The map views we discussed —
  inside a box, rack, floor, building, VLAN, VPN — are designed and unbuilt.
- **No findings.** The rightmost column of every table still reads `—`, because the rule engine is
  not built. The column stays visible on purpose so its absence is never invisible.
- **It cannot write anything back yet.** Reading works. Emitting now has its answer in principle
  (§7) and still needs the work order that turns it into text.

## 5. The checks — the exact numbers

All run at the end of this session on a clean tree:

| Check | Result |
|---|---|
| Formatter | clean |
| Linter (warnings treated as errors) | clean |
| Tests | **372 passed, 0 failed, 0 skipped, 0 filtered** (up from 354) |
| Schema checker | exit 0 — **0 failures, 0 warnings**; the two standing `Site` warnings are gone (see below) |
| Cross-reference checker | 8,648 checked, 58 unresolved — the same 58 as before this branch |
| Browser module audit | imports **still empty**, module ~820 KB against a 900,000-byte ceiling |
| Egress and safety greps on the page source | all seven patterns still zero |
| Network requests during the browser run | **one — the file itself. Nothing else.** |

The eighteen new tests are: three that prove the compiled-in Juniper vocabulary is byte-for-byte the
one on disk; nine that drive the paste path through the same code the browser calls — including the
secret-never-comes-back test, the every-line-is-accounted-for test, and a determinism test that
proves the same paste with the same clock produces the same bytes twice; and six on the new
vocabulary entries, each of which pins one way they could have been quietly wrong.

## 6. Three things worth knowing

**1. The module still cannot read a clock or draw a random number, and that is on purpose.** Both
of those are things a browser can do and the sealed core deliberately cannot; the page hands them
in with each paste. It matters because it is what keeps the core's behaviour reproducible — the
same config with the same inputs always produces exactly the same result — and it is why the audit
that checks the module asks for nothing from outside is still passing with an empty list.

**2. The module is getting close to its size limit.** It grew from 560 KB to 812 KB against a
900 KB ceiling that the project set for itself. That is 88 KB of headroom, and the next platform's
vocabulary will eat into it. Nothing is wrong today; it is the kind of thing that becomes a problem
without warning if nobody is watching the number. Somebody should decide, before it bites, whether
the ceiling is right or whether the vocabulary should be handed in by the page rather than baked
into the module.

**3. This work was not a queued work order.** The queue's remaining order (WO-04, the writer) is
blocked on your answers in §7, so rather than sit still this session built the thing that gets the
product into your hands. It is recorded here as what it is: useful, verified, and outside the
queue.

## 7. The two questions you were asked — both now answered

Both of the questions in the previous version of this section were badly asked, and you said so.
Recorded here because the corrections are worth more than the answers.

**1. "Is the emitted tunnel for a box that already has its WAN interface, or a blank box?"**

You rejected both options:

> *"What? i mean if you have a P2P ELINE or tunnel, vpn, etc, it should stil route as it should. If
> not all the info is available how it routes then there needs to be like a dotted line or something
> indicating that or something. I know we had the warp idea for physical?"*

You were right and you were right about the mechanism too. The question assumed only two outcomes —
emit everything, or emit nothing — and the answer is neither: **represent the path, and mark what
you don't know about it.**

Two things checked, not remembered:

- **The warp is already real.** `19` §6 is titled *"The path and the warp"*. The schema has
  `SegmentKind = { Physical, Warp, Boundary }` and `warp_technology = { L2Ptp, Pseudowire, Evpn,
  Vlan, Other }` — a P2P E-Line, by name, in the data model. `19` §6.3 already separates *"here is
  what it crosses today"* from *"I looked and there's nothing there"* from *"I haven't looked"*.
- **Dotted is already the right pen.** The design tokens reserve `dotted` for *"an unanswered
  question, not a defect"* and `dashed` exclusively for AI-generated content. Your instinct landed
  on the exact token, and the distinction matters — dotted, never dashed.

**What that settles and what it doesn't.** The picture is settled: unknown interior gets drawn,
dotted. The *emitter* is a different surface — a block of config text pasted into a live router
can't carry a dotted line. Your principle translates there as **hand over what's known and name the
assumption**, rather than refusing the whole tunnel because one interface wasn't in the paste. That
reading is written down in `70` §16.2 and flagged as a reading, so the work order that builds the
emitter has to state it rather than inherit it quietly.

**A gap your question found.** The diagram specification (`56`) doesn't mention warps, path segments
or segment kinds anywhere — the model has them and the document that says how to draw things doesn't
know they exist. Nothing in the build would ever have caught that. Filed.

**2. "How does Fathom tell two devices apart?"**

> *"I mean that's a very important thing, idk how this is a question?"*

Correct, and the question is withdrawn. It's important, and it was never yours to answer — it's
derivable from what a config file actually contains, and asking you to specify a schema tuple is the
same mistake the project already has written down as a defect. **Answered and built the same day:**

| | Tier 1 | Tier 2 |
|---|---|---|
| **Device** | hostname + platform | platform + management address (survives a rename) |
| **Site** | site code | site name |

Hostname is always present in a config and platform comes from whichever vocabulary read it, so
tier 1 always works. It's the *pair* rather than the hostname alone because a `core-01` SRX and a
`core-01` Nexus are two boxes. Tier 2 is honestly rare — nothing populates a management address from
a Junos paste yet — and when neither tier matches, the answer is to **ask you**, never to match on
something weaker.

**Side effect: the schema checker is now completely clean.** It had two standing warnings for the
whole life of this project, both caused by exactly this missing rule. 0 failures, 0 warnings, and a
test that fails if a new one ever appears.

**One thing that's genuinely yours, and it is a UX question:** when you paste a config for a box
Fathom thinks it already has, what should it show you? A match is a *proposal*, not an automatic
merge — two branches can both run a `core-01`. Until that's designed, a paste replaces what's held
and says so.

Two smaller ones, whenever you get to them: whether the IKE warning belongs on the interface or the
zone, and who the named human reviewer of the vocabulary files is.

## 8. How to see it yourself

```
cargo run -p fathom-artifact
```

That writes `target/artifact/fathom-dev.html`. Open it from disk — double-click it, or drag it into
a browser window. Disconnect the network first if you want to prove the point. Then **paste a
config** at the top right.

Three screenshots of exactly that, taken during this session, are checked in at
`docs/80-review/evidence/`:

- `2026-08-09-paste-sheet.png` — the paste box with a config in it
- `2026-08-09-paste-result.png` — what came back, including the five unread lines
- `2026-08-09-paste-inspector.png` — clicking the device and reading its fields

The browser used was Chromium, driven from outside the repository. **That driver is not part of
Fathom and no check runs it** — the browser results in this report are a human-equivalent run, not
an automated gate. Whether an automated one may exist is still an open question in the project's
own records.
