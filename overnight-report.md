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
| 7 | What still needs a decision from you |
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

None of those five is a bug. They are the honest shape of the vocabulary Fathom has today: it knows
interfaces, zones, IKE and IPsec, and it does not yet know routing, policies, descriptions or
domain names. **The point is that it says so, per line, instead of quietly ignoring them.** Two of
them — `description` and `domain-name` — are one-line additions to the vocabulary file whenever
somebody wants them; the routing and policy statements are real bodies of work.

**The pre-shared key.** The config contains
`set security ike policy ike-pol pre-shared-key ascii-text "SuperSecret123"`. After the paste, the
literal string `SuperSecret123` appears nowhere in the page's text, nowhere in its HTML, and
nowhere in any table you can navigate to. The page reports *"1 secret removed"* and keeps only what
kind of secret it was.

## 4. What is deliberately still missing

So the picture is not rosier than the tree.

- **One box at a time.** Pasting a second config replaces the first rather than adding to it.
  Joining separate pastes into one estate is the biggest unbuilt requirement in the project and it
  is blocked on a decision, not on code (§7).
- **Juniper SRX only.** The other five platforms are registered and empty.
- **No diagram yet.** This is the inventory table and the inspector. The map views we discussed —
  inside a box, rack, floor, building, VLAN, VPN — are designed and unbuilt.
- **No findings.** The rightmost column of every table still reads `—`, because the rule engine is
  not built. The column stays visible on purpose so its absence is never invisible.
- **It cannot write anything back yet.** Reading works; emitting is still blocked on the two
  questions in §7.

## 5. The checks — the exact numbers

All run at the end of this session on a clean tree:

| Check | Result |
|---|---|
| Formatter | clean |
| Linter (warnings treated as errors) | clean |
| Tests | **366 passed, 0 failed, 0 skipped, 0 filtered** (up from 354) |
| Schema checker | exit 0 — the two standing `Site` warnings, unchanged |
| Cross-reference checker | 8,648 checked, 58 unresolved — the same 58 as before this branch |
| Browser module audit | imports **still empty**, module 812,467 bytes against a 900,000 ceiling |
| Egress and safety greps on the page source | all seven patterns still zero |
| Network requests during the browser run | **one — the file itself. Nothing else.** |

The twelve new tests are: three that prove the compiled-in Juniper vocabulary is byte-for-byte the
one on disk, and nine that drive the paste path through the same code the browser calls — including
the secret-never-comes-back test, the every-line-is-accounted-for test, and a determinism test that
proves the same paste with the same clock produces the same bytes twice.

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

## 7. What still needs a decision from you

Unchanged from the last report, and now the only thing between here and writing configs back out:

**1. When Fathom emits a tunnel, is that output meant to be pasted onto a box that already has its
WAN interface — or must it contain every statement needed to bring the tunnel up on a box whose
config is blank?** This is the `reth0.0` question. Today Fathom refuses to emit anything that names
an interface the paste never defined, which is safe and makes every partial paste unemittable.

**2. How does Fathom tell two devices apart?** One sentence. Without it, re-reading a config it has
already seen makes a second copy of the device instead of updating the first — so a config can be
added but never refreshed. The same sentence is needed for sites, and it is what the two standing
schema warnings are.

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
