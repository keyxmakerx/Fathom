# 65 — The engine boundary: what plugs in, and what must never

> **Status:** Answer, 2026-08-10. It closes `70` §13's *"platforms are independently addable"*
> assumption, opened 2026-08-07 and recorded there as *"not yet confirmed, and the sort of
> assumption that is cheap to hold and expensive to discover is false."* It was false in one
> important direction and true in another, and both are below.
>
> **Method.** Four independent investigations — the extension surface, the schema's fit for a host's
> internals, what a Linux box can actually hand a human, and what a plug-in would have to mean —
> each adversarially verified by a second agent that opened every citation and re-ran every
> experiment. Where a verifier refuted an investigator the verifier is carried, and the three places
> that changed the answer are marked in the text.
>
> **Two findings were load-bearing enough to act on the same day.** Adding a node kind needs **zero
> hand-written Rust** — measured twice by actually doing it — which makes the model far more
> extensible than anyone here had claimed. And the redaction gate was leaking credentials on
> `key=value` text, which is most of the world outside Junos; six shapes were demonstrated leaking
> verbatim with `drops = 0` and are fixed in the same commit as this document
> (`crates/fathom-ingest/tests/noise_gate.rs`).
>
> **The owner asked it in his own words** and they are the right frame, so they lead: *"if someone
> created a Linux engine it would just be plug and play and add all the features of that right?"*

## 0. Contents

| § | | margin tab |
|---|---|---|
| 1 | The one-paragraph answer | *read this first* |
| 2 | What is genuinely plug and play | *the design earned this* |
| 3 | What is not, and why | *ordered by surprise* |
| 4 | The Linux-specific answer | *not one format* |
| 5 | The security answer | *the sharp one* |
| 6 | What we should actually do | |
| 7 | The slice the owner meant — L2, L3, Docker, Kubernetes | *scope, decided* |
| | Failure modes | |
| | Open decisions | |

---

## 1. The one-paragraph answer

**Partly — and the line runs straight through the middle of the word "engine."** Everything from the moment Fathom says *"I understood this line"* onward is genuinely platform-blind and would come free: the graph, the weld, the inventory, the search, the six views, the containment rules, the field pages. Adding a new *thing to the model* — a Docker network, a firewall chain — is about forty lines of YAML and a regeneration command with **zero hand-written Rust**, which two independent experiments confirmed by actually doing it. But everything *before* that moment — turning pasted text into statements — is hand-written Rust, written once for one Junos format, and it does not share a single assumption with anything Linux prints. Today the product accepts exactly one text shape (`set …`, one complete statement per line) from exactly one platform, and there is no way to install a second dictionary at all, let alone a second parser. And "plug and play" in the sense of dropping a file next to the app is not a gap that will close: it is permanently refused, in writing, in four places, for security reasons that are the strongest sentences this product owns. **The honest shape is: someone adding a Linux engine is a contributor whose code we read and compile, not a user dropping in a plug-in — and Linux is the hardest plausible next platform, not the easiest, because it is not one config format but six-to-twelve separate pastes in seven unrelated shapes, most of them reporting what the kernel is *doing* rather than what you *configured*.**

---

## 2. What is genuinely plug and play today

This half is real, and the design earned it.

**Registering a platform is one line of YAML.** `schema/platforms.yaml:50-67` already registers ten platforms — junos-srx/mx/ex, panos, ios-xe, nx-os, eos, fortios, opnsense, omada-sw — across twelve vendors. Nine of those ten have zero dictionary and zero engine behind them. That is the perfect illustration of the split: *registration is free data; the engine is code.*

**The vocabulary of a platform is data.** The whole junos-srx dictionary is 42 entries, 416 lines of YAML across six files (`corpus/dict/junos-srx/`), naming node kinds, fields and edges by string. The loader resolves them through the compiled schema and refuses anything it does not recognise. Nobody writes Rust to add a statement.

**Adding a new kind of object to the model needs no Rust at all.** This was measured twice, independently, by two investigators who each added a container-network kind to a scratch copy and ran the real toolchain. Both got the same result: ~22 lines of schema YAML for the kind, ~11 for its containment edge, 4 field keys; `fathom-schemagen` accepted it first try and generated the enum (including the unknown-token arm), the typed accessors and the canonicalisation dispatch; `cargo check --workspace --all-targets` came back **clean with zero hand-written Rust**; and `cargo test` failed in exactly four places, all of them deliberate pinned-count tripwires (48→49 kinds, 299→303 field keys, and so on). Four one-line edits. ADR-0008 is doing exactly what it promised.

**Everything downstream of the parser is platform-blind, and I checked rather than trusted.** `fathom-graph` contains zero platform strings. `fathom-weld` takes the platform as a *parameter* (`Manifest.platform`, stamped at `apply.rs:138-148`) rather than knowing one. Inventory row sets are keyed on node kind, never on platform. Containment edges are computed from the schema over all 48×48 kind pairs, never from a hand table (`fathom-weld/src/lib.rs:85-110`). The element detail page reads `id.kind.fields()` straight off the schema (`fathom-inventory/src/element.rs:42-54`), so a new kind's detail page works the day the schema lands. Doc `14` §2.2's central claim — *"everything downstream of stage 3 sees one type"* — is **true in the built code**, and that is not a small thing.

**Nothing is ever silently lost.** Every Linux paste that either investigator ran produced `bound = 0` and a complete residue ledger: every line named, with its position, with the reason it was not read. Invariant L held on all of them. A tool that could not do that would be dangerous to point at Linux.

**The refusal is already honest.** Paste something foreign today and the page says so and leaves your estate alone — `crates/fathom-wasm/src/shell.rs:139-153`, added 2026-08-10 precisely because before it, a Cisco config *"validates, welds, and replaces the operator's real estate with an empty device. Silently."*

**Platform detection and re-identification are specified in detail.** `14` §8.4 (`docs/10-core/14-parsers-and-ingest.md:1141-1165`) is a complete detection algorithm with scoring, a confidence threshold, and an explicit refusal to guess. `11` §10.4 is a complete five-step re-identification algorithm whose numeric thresholds are already data in `schema/schema.yaml:2195-2202`. **Specified, zero code** — which is a different and better position than "nobody thought about it." *(This corrects one investigation, which reported platform detection as simply unwritten.)*

---

## 3. What is not, and why — ordered by how much it will surprise you

**(a) The dictionary is data, but there is no way to have two of them.** This is the one that would break a plan. `Dictionary::load` joins the literal path `corpus/dict/junos-srx` (`dict.rs:132`). `Dictionary::embedded()` — the only path the browser can use — is six literal `include_str!` lines (`dict.rs:80-105`). The general constructor that would take arbitrary sources is private (`dict.rs:583`). One `Dictionary` holds exactly one platform and hard-errors if two files disagree (`dict.rs:598-609`). The browser holds a single dictionary slot with no selector, and `OP_PASTE`'s wire frame carries the clock and entropy and nothing else. So **even Junos MX — identical syntax, already registered — is a code change today.** *Gap that will close. Days of work, and it gates everything else.*

**(b) The front end accepts one text shape and, in fact, one verb.** Not the twelve Junos verbs — only `set` actually shapes; the other eleven are recognised so continuations can be decided, then discarded as residue (`shape.rs:48-61`, `:202-212`). Anything not starting with `set` never reaches the dictionary, so **no dictionary entry can rescue it, ever.** The shaper builds one complete root-to-leaf path from one line's tokens; there is no block state, no mode stack, and the word "indent" does not appear anywhere in the crate — leading whitespace is destroyed by the framer before any stage could read it. *Inherent, per format.* A new shape means a new shaper: `14` §5.5 prices one at 3–10 days and ~200–600 lines, and the one built shaper is 430 production lines, so that estimate is well calibrated.

**(c) Every new value type costs four to six places in Rust.** A value shape the table lacks needs a `ValueTy` variant, a name arm, a `BoundValue` variant, a parse arm, and a weld store arm — five if it needs a token map, six if the underlying scalar type doesn't yet exist as hand-written Rust. Confirmed empirically against commit `81d12b4`, whose own message reads *"Twenty lines of code, not one."* *Gap that will close, but it recurs per type.*

**(d) Every new node kind needs its inventory row hand-written or it shows up as a raw ULID.** Six match arms in `fathom-inventory` plus a list in the page's JavaScript. There is no fallback for the row set — omit it and the code won't compile; omit the display name and you get `ikegateway:01KZ…` on screen, which is the exact defect recorded as having shipped once already (`element.rs:89-94`). *Gap that will close; cheap per kind, but Rust every single time.*

**(e) A second paste replaces your estate.** `OP_PASTE` builds a fresh graph and assigns it (`shell.rs:179,186`), and underneath, `fathom-weld` states plainly that *"a declared identity tuple is not an implementation of one. Nothing in the tree evaluates a tuple against a node's values"* (`lib.rs:20-29`). Two pastes of the same box produce two Device nodes. On Junos this is defensible — one paste is the whole device. **On Linux it is fatal by construction**, and I come back to it in §4. *Specified in full, zero code.*

**(f) "All the features of that" presumes there are features to inherit.** One of six views is live; the other five render an "unposted" placeholder. There are zero lines of rule engine — `corpus/rules/*.yaml` is loaded as searchable text and never evaluated against a graph, and the inventory's opinions column renders a fixed em dash. There are zero lines of diagram. The emitter is Junos-only Rust *by decision* and is currently a dependency of nothing.

**(g) Bytes — real, but more tractable than the raw number suggests.** The module is 825,802 bytes against a 900,000 hard ceiling (74,198 free), and the 700 KB *target* is already exceeded by 126 KB. The dictionary compiles in as raw YAML at a measured 457 bytes per entry, and `14` §2.2 sizes a real platform dictionary at 400–2,500 entries — 183 KB to 1.1 MB. A second real dictionary busts the module on its own. **But** the assembled artifact is 1,163,558 bytes against a 4.5 MB ceiling, with 3.34 MB free, and — the good news nobody had spotted — **the module already has a working, tested channel for the page to hand it corpus text at runtime** (`OP_INIT` / `protocol::pack_corpus`, used today for rules and explainers). The dictionary simply isn't wired to it. Moving it there is a section byte and a loader call, not a new architecture. *Gap that will close, and cheaper than it looks.*

**(h) A runtime plug-in is not a gap. It is permanently refused, in writing, in four places.** `71` §13.1's permanent-boundaries table: *"A plugin system that executes third-party code in the application… It would defeat the CSP, the supply-chain story and the reproducibility claim in one move. Rule packs and corpus entries are **data**, signed and versioned; that is the extension mechanism."* `73` §9 lists it in the closed section. ADR-0031 explicitly says that row *"constrains ADR-0032 and is not loosened by it."* `62` §13.1 makes it normative for the file format: *"Node kinds, edge kinds, semantic scalars, and fields on shipped kinds are not extensible by a user, permanently."* *(This corrects one investigation that classified "declare a new node kind" as third-party-data-today: it is data for **us**, and refused for **them**.)*

---

## 4. The Linux-specific answer

### Linux is not one format, and that changes what "a Linux engine" means

There is no `show configuration | display set` for a Linux box, and no near miss. The closest whole-box dump is `sos report`, which produces an *archive*, not screen text — so under invariant 2 it is not a paste at all. A realistic capture sheet for a Linux router/firewall/Docker host, **configuration only**, is six to twelve pastes:

| What | Command | Shape |
|---|---|---|
| Interfaces / addresses / routes | one of `nmstatectl show -r` · `netplan get all` · NetworkManager keyfiles · systemd `.network` | YAML **or** INI |
| Firewall | one of `nft -s list ruleset` · `iptables-save` (+`ip6tables-save`, `ebtables-save`, `arptables-save`) · `ufw show added` · `firewall-cmd --permanent --list-all-zones` | braced **or** block-header lines **or** command form **or** XML |
| WireGuard | `/etc/wireguard/*.conf` or `wg showconf` | INI |
| IPsec | `swanctl.conf` | braced |
| Docker | `docker compose config` **per project** + `/etc/docker/daemon.json` | YAML + JSON |
| SELinux | `semanage export` (+ `sestatus`) | command form |
| Forwarding | `/etc/sysctl.d/*` | `key = value` |
| Routing daemons | `/etc/frr/frr.conf` | IOS-shaped |

**Seven distinct text shapes. Fathom parses one of them, and it is not the most common.** Add the runtime picture and it is 15–25 pastes. Two Linux subsystems genuinely are in Fathom's family — `ufw show added` and `semanage export` both emit one complete re-executable statement per line — but even those are *command-line invocation* syntax (`port -a -t http_port_t -p tcp 8080` is flags in arbitrary order, not a path from a root), so they still need a new front end, just a cheaper one.

### The one-paste-versus-many finding

**This is the single biggest structural consequence, and it is not a parsing problem.** Because a paste replaces the estate, pasting your firewall would erase the interfaces you pasted a minute earlier. So for Linux, reconciliation is not a later nicety — **it is a precondition on day one.**

The good news, which one investigator got wrong and the verifier corrected: this is *not* `70` §6's undesigned cross-device correlation. Six Linux pastes are six captures of **the same box**, which is exactly what `11` §10.4's re-identification is for, and `70` §6.1 marks that as *Specified* while marking cross-device correlation *"Declared in scope, never designed."* The algorithm is written, the thresholds are already data. So it is "implement a specified algorithm," not "invent a missing requirement." It is still months, for one specific reason: step 1 scopes re-identification by *covered paths* — which assumes all captures are subtrees of one path tree. Linux's seven grammars share no root, so that input is not merely unbuilt for Linux, it is undefined.

### The configuration-versus-runtime-state finding

**`iptables-save` and `nft list ruleset` are the kernel's live state wearing configuration's clothes, and they are the two outputs a network engineer is most likely to paste first.** They read the kernel, not a file. Everything that installed a rule at runtime is in there, textually indistinguishable from what you wrote — Docker, Podman, libvirt, fail2ban, kube-proxy, Tailscale. A first-hand capture taken during this investigation already contained `-A POSTROUTING -s 172.17.0.0/16 ! -o docker0 -j MASQUERADE` and a `:DOCKER-USER` chain sitting in the same dump, in the same syntax, as the hand-written SSH rule. Three further traps, all first-hand: `iptables-save` stamps a literal read-timestamp into its own header; `nft list ruleset` interleaves live packet counters into the text unless you pass `-s`; `nft -t` silently drops the contents of every named set.

Doc `03` §4.5 already permits ingesting runtime text as *input*. What is forbidden is storing it with the same authority as a declaration (`03` §4.2: *"no field in the workspace format asserts currency or authority"*). **Junos never forced this distinction because `display set` is unambiguously declaration. Linux forces it on line one** — and both firewalld and nmstate ship an explicit permanent-versus-running flag, which is evidence the distinction is real and unavoidable rather than a Fathom nicety.

The machinery is half there. Nothing in `schema/` carries the distinction — but the axis lives at the provenance layer, exactly where doc `03` points: `Origin { Hand, Parsed }` and `Confidence { Asserted, Derived, Heuristic }` are recorded on every write (`fathom-graph/src/prov.rs`), `11` §8.2 specifies six Origin variants with a precedence order, and every kind already declares a closed `layer: config | physical | service`. Extending either is additive and cheap. *Nobody has decided to.*

### What the model has room for, and what it does not

| You said | Verdict |
|---|---|
| routes and subnets | **Fits well.** `StaticRoute` has destination, next-hop (address / interface / discard / reject), preference, metric — all fully built. `Interface` → `LogicalUnit` → `Address` is exactly `ip addr`. Interface names are free text, so `docker0`, `veth…`, `wg0` all store fine. |
| VRF via network namespace | **Fits half.** `RoutingInstance.isolation` already has a `routing_table_only` and an `l2_bridge` variant. But a netns also isolates the *firewall*, and zones and policy sets hang off the Device with no namespace scoping. |
| iptables / ufw | **Fits about 60% in shape, and 0% in substance today.** `PolicySet` with `evaluation: first_match` is structurally a chain; `SecurityPolicy` has ordinal, action, log-on-init, count, enabled — a genuinely good match for `-j ACCEPT`, `-j LOG` and a disabled rule. But **five of the value types the firewall depends on are literally empty stub structs** — `NatAction`, `NatScope`, `L4Spec`, `PolicyScope`, `AddressValue` (`fathom-ir/src/value.rs:189-206`, whose own header says *"These are stubs"*). So today a rule cannot record its ports, an address object cannot hold its prefix, and a NAT rule cannot record what it does. **That is true for Junos too.** And no dictionary entry has ever bound `SecurityPolicy`, `PolicySet`, `AddressObject`, `NatRule`, `StaticRoute` or `RoutingInstance` — the entire security and routing half of the model is declared and has never once been driven by a parser. |
| `-j <user-chain>` (chain jumps) | **An edge to add, not an unprecedented idea.** *(One investigator reported this as structurally absent; the verifier found the precedent, and it changes the estimate.)* `InPolicySet` already runs SecurityPolicy→PolicySet, and `TunnelsVia` (SecurityPolicy→IpsecVpn, *"then permit tunnel ipsec-vpn NAME"*) is exactly the pattern "a rule's action names another node." It is a new edge kind — a minor schema bump — not a new relationship. |
| docker networks | **Nothing fits.** A bridge network is not a VLAN (which requires a mandatory VLAN id) and not a routing instance. Published ports (`-p 8080:80`) are structurally DNAT, and NAT rules have no L4 port fields at all. |
| containers / namespaces | **Nothing.** There is no kind for a workload, process or VM. |
| SELinux | **Nothing, and it is not a network object.** ~300 booleans, port labels and file contexts are all key-value or triple-shaped, and there is no key-value bag on any node: `62` §4.2 specifies that every kind implicitly carries `ext` / `aka` / `unknown`, and the built `Node` struct has none of the three. `VendorExt` — the corpus's own designed answer to "carry platform-specific facts without adding kinds" — is specified in four documents and appears in **zero lines of Rust or YAML** in the tree. |

**The cost of adding room** is the good news from §2: roughly 41 lines of YAML and a regeneration per kind, zero hand-written Rust, plus ~29 lines of Rust for its inventory row. Mechanically, hours. The *modelling* decision — does Fathom's picture of the world include a host's internals at all — is the real cost, and it is yours, not an engineer's.

**One more thing specific to Linux:** the median Linux line carries a shell command as its payload — `ExecStart=`, `--log-prefix "…"`, `docker run …` inside a unit file. The only defensible handling is not to parse it and to quarantine the whole line. That is the right answer, and it means a Linux engine will legitimately produce a lot of residue. On screen that looks like *"Fathom didn't understand my box."* It is honest behaviour, but you should expect it.

---

## 5. The security answer

You are right about the premise, and it is worse than the premise.

**Yes — a third-party engine sees the text before redaction, by necessity.** The gate is stage 4 of 6 and its *path* detector is a pure function of the parser's output: it fires only when the argument sits at the position the matched dictionary entry declares secret. An engine that decides what the path is decides what that detector sees. Mislabel `pre-shared-key ascii-text <key>` as a description and it never fires.

**But the more urgent finding is that the gate is already Junos-shaped and leaks Linux credentials today.** Three investigators ran the shipped code against real Linux capture text, independently, on 2026-08-10. Their results agree.

The four content detectors — crypt-prefix, long-hex, base64, PEM — are **whole-token** tests, over a tokenizer whose only separators are space, tab, quote and square brackets (`lex.rs:24-30`; the character list contains no `=` and no `:`). Linux writes `key=value` and `key:value`. So on Linux the secret is never a token of its own and **nothing fires**. It works on Junos precisely because Junos writes `… ascii-text $9$abc` with a space.

Demonstrated against the shipped `ingest()`, `drops = 0`, secret verbatim in the stored capture:

- NetworkManager keyfile `psk=correcthorsebattery`
- NetworkManager 802.1X `password=Sup3rSecret!`
- WireGuard `PrivateKey=<44-char base64>` written without spaces
- `docker compose config` output, which interpolates `.env` — `DB_PASSWORD: hunter2-secret` (this makes `docker compose config` a credential-disclosure command; the safe form is `--no-interpolate`)
- an `/etc/shadow` line — colon-delimited, so the `$6$` hash is not its own token and the crypt-prefix detector never sees it
- `key-string MySharedKeyValue` — a live secret form for Arista, Omada and Sodola — because the leaf-name walk is guarded by `at >= 2` and skips index 1
- a credential inside a URL

*(This is the correction that most changes the answer. The first read of this area concluded the safety net was "genuinely platform-independent" and would catch a Linux `/etc/shadow` line unchanged. The verifier refuted it by running the code. It is exactly backwards, and had it stood it would have told you your estate was protected on a platform Fathom cannot even parse.)*

**A separate leak, found independently and confirmed by reading:** three paths in the shaper write "Unshaped" into the residue ledger but never hand the line to the gate at all — frame errors, lexer errors, and over-long lines (`shape.rs:155-158`, `:179-182`, `:227-232`; compare `:192-199` and `:210-217`, which do). So a PSK line with an unterminated quote — i.e. a clipped or wrapped terminal paste, one of the likeliest pastes there is — survives verbatim with `drops = 0`. This is the same class as the two leaks fixed two days ago in `f00a1bf`.

**And the "engine may only add redaction, never subtract" rule is already violated in first-party code.** A dictionary *match* disables the base64 detector (`redact.rs:382`), and `secret_exempt` — a plain dictionary field requiring only a free-text reason, and dictionary entries are an **open contribution channel** under ADR-0028 — disables the leaf-name detector.

### What that means, and the options

**The one control that genuinely contains an engine is build-time, and it is strong.** The shipped module's WebAssembly *import section is asserted empty* at build time (`fathom-wasm/tests/artifact_gates.rs:56`). Code with no imports cannot reach the network, the DOM or the filesystem — ever, regardless of intent. That is what makes `connect-src 'none'` architectural rather than a header.

**Nothing else survives a runtime-loaded engine.** ADR-0032's four layers — lockfile, `cargo-deny`, `cargo-vet` (a named human read the code), vendored source — are **all build-time**. A module that arrives at runtime gets none of them: no lockfile row, no vendored source, no audit, no SBOM diff, and no empty-imports check. And the reproducibility claim — *"you can verify this yourself"* — becomes "verify everything except the part that does the parsing." It is worth saying that the CSP would technically permit a second module (`wasm-unsafe-eval` is present, and the page already instantiates from bytes); anyone telling you "the CSP stops it" is wrong. What stops it is the decision and the gates.

**So the answer is: a third-party engine is admissible; a runtime-loaded one is not.** Not as a policy preference — because invariant 3's strength was never "we redact well," it is the structural claim that *the unredacted text never reaches the encryptor*, provable by reading first-party code. A runtime-loaded engine converts that into "we redact well against an adversary we never compiled," which is weaker, unverifiable, and not the sentence this product sells.

**The architecture that makes a contributed engine safe** is four conditions, and three of them are broken today even with one first-party engine:

1. **The engine must not be the tokenizer.** If it defines what a token is, it can hide a key by splitting a 64-character blob into twelve short ones. First-party code must run its own aggressive split over the raw bytes. Today the gate uses the *platform's* tokenizer.
2. **An engine's output may only ever cause more redaction, never less.** Broken twice, above.
3. **"I understood this line" must never suppress residue.** Residue is the one surface that tells you what Fathom did not read.
4. **Confidentiality against the engine is unavailable in-origin.** `34` §7.3 says so itself: the parse worker *"is not a security boundary against JavaScript in the origin"* and *"does not protect the graph from the parser, because the parser's output is graph input."* The only real containment is empty imports, checked at build time.

**One more, which is about contributed data rather than contributed code.** `71` §13.1 specifies that *"the build fails on the literal string `<named human>`"* — that is the gate that is supposed to make contributed corpus safe. No such check exists in `crates/`, `scripts/` or `.github/`, and all 43 `reviewed_by` values in the shipped dictionary are that literal placeholder. Today invariant 10 is a habit, not a control.

---

## 6. What we should actually do

### Fix these now. They do not need you, and two are live security defects.

1. **Repair the ingest gate.** Give the content detectors their own raw tokenizer that also splits on `=`, `:` and `,`; sweep the three shaper paths that currently bypass the gate; drop or fix the `at >= 2` guard; write the monotonicity rule down and enforce it. **This is not a Linux prerequisite — it is a defect on text the product accepts today**, and it is the same class as the three leaks fixed on 2026-08-09. Days. *Do this first.* — Engineering.
2. **Build the invariant-10 `<named human>` build gate** that `71` already specifies. Hours. — Engineering.
3. **Un-hardcode the dictionary path, add a platform parameter, and prove it with junos-mx** — the cheapest possible second platform, same syntax, already registered. That converts "the design supports this" into "we did it once." Days. — Engineering.
4. **Wire the dictionary to the existing `OP_INIT` corpus channel** instead of `include_str!`. It moves the dictionary from a budget with 74 KB free into one with 3.34 MB free, using transport that already exists and is tested. This is the byte-ceiling answer, and it is engineering, not an architecture question. — Engineering.
5. **Record this answer in `70`**, closing the item you opened on 2026-08-07. — Engineering.

### These genuinely need you. Nobody else can decide them.

1. **What does "a Linux engine" mean?** A fixed capture sheet of specific commands we name and document, or arbitrary Linux config text? The two differ by an order of magnitude in cost, and nothing in the corpus decides it — Linux is not among the ten platforms surveyed in `64`. *This blocks any estimate.*
2. **Does Fathom's model of the world include a host's internals?** Containers, network namespaces, Docker networks, LSM policy — or does the model stop at the network and treat a Linux box as a router with interfaces, routes and a firewall? This is an ADR, it is the largest cost hiding inside the word "engine," and the mechanical part is cheap once you have decided.
3. **Does the estate record distinguish what you declared from what the kernel was doing when you looked?** Linux forces this; Junos never did. The machinery half-exists (six Origin variants specified, two built; a closed `layer` enum on every kind). Somebody has to say whether an observed value is a first-class thing in the record.
4. **Any third-party crate needs your per-crate approval** under ADR-0032 §5, which explicitly *"may not be delegated to a planning session."* Worth knowing that a contributed engine lands on your desk by design.

### The sentence I would put on it

> The design carries most of the way, but the thing that plugs in is a **dictionary**, not an engine, and it plugs in at build time. Somebody can add Junos MX, EX or PAN-OS set-form largely by writing data — after a few days' work we have not done yet. Nobody adds Linux that way, because Linux is not a config format: it is eight commands in five different shapes, most of them reporting what the kernel is *doing* rather than what the box is *configured to do*, and the model has no container, no chain and no namespace to put any of it in. A Linux engine is two or three new parsers, a schema extension, a redaction gate that survives `key=value`, and a dictionary — reviewed by us and compiled in, exactly like every other line in the artifact. That is a contribution, and we should make it easy. It is not a plug-in, and it must never become one: a plug-in is code we did not compile, running on your paste *before* the redaction gate, inside the one product whose whole claim is that it never keeps your credentials.

---

## 7. The use case the owner actually meant, and why it changes the answer

Added 2026-08-10, after the owner read §4 and corrected the framing. His words:

> *"if a linux engine happened it would let someone essentially do this map that we are doing but
> for linux and internals therein. Which would help alot if you had virtual nics and such and needed
> to map vlan access via that."*

**This is a different slice of Linux from the one §4 costed, and it is by some distance the
best-fitting one.** §4 answered *"can Fathom model a Linux host"* and correctly found that the
expensive parts — containers, namespaces, Docker networks, LSM policy — have nothing to sit in.
The owner is not asking for those. He is asking for **the L2 path from the physical port to the
workload**, and that is the part the model was already built for.

### Why the question is a good one

A hypervisor or container host is **the one hop in an estate that nothing on the network can see.**
The switch sees a trunk port. The VM sees an access port on VLAN 30. Everything that connects those
two facts — the bond, the VLAN sub-interface, the bridge, the veth, the bridge's VLAN filter —
lives inside the host, is configured by a different team more often than not, and appears in no
device config anywhere. *"The VLAN is trunked to the host, so why can't the VM reach its gateway?"*
is answered entirely by facts that exist only in there.

`52` §1 already says the views are renderings of one graph. **A map with a blind spot in the
middle is not a map of a smaller estate — it is a map that is wrong about reachability**, and
reachability is what the diagram exists to show.

It is also not a new requirement. `70` §10.4 records the owner's own specification of the physical
view: *"physical is per single piece of equipment and how its setup internally."* **A Linux host's
internals is that view, for a server instead of a switch.** Same view, different box.

### What already fits, checked against `schema/schema.yaml` on 2026-08-10

| The thing on a Linux host | Where it goes today | |
|---|---|---|
| `eth0`, `enp1s0f0` — a physical NIC | `Interface` | ✅ |
| `bond0` / `team0` | **`AggregateInterface`**, which already carries `lacp_mode`, `lacp_periodic`, `minimum_links` | ✅ a Linux bond, field for field |
| `eth0.30` — a VLAN sub-interface | **`LogicalUnit`**, which already carries `vlan_id` | ✅ this is exactly Junos's `unit` |
| the VLAN itself | `Vlan`, with `vlan_id` | ✅ |
| addresses on any of it | `Address` under `LogicalUnit` | ✅ |
| a **veth pair** | **`Cable`**, whose `media` enum already contains **`virtual`** | ✅ and nobody put it there for this |
| the switch port the NIC plugs into | `PhysicalPort` + `Cable` | ✅ already the modelled hop |
| `br0` — a Linux/OVS bridge | **nothing clean.** The nearest is `RoutingInstance` with `isolation: l2_bridge`, which exists as a variant and is a stretch — a bridge is an L2 forwarding domain, not a routing instance | ⚠️ one new kind, or a decision to reuse |
| the VM or container at the end | **nothing.** `19` §3 has no workload, and `ExternalPeer` means something else | ❌ one new kind, or an explicit modelling horizon |

**Five of eight fit as-is, one is arguable, two are missing.** Set against §4's *"docker networks:
nothing fits; containers: nothing"*, that is a different project. And per §2, a missing kind is
~41 lines of YAML and a regeneration, with **zero hand-written Rust**.

### And the capture is three commands, not twelve

§4's six-to-twelve pastes covered the whole host. This slice needs the link topology and the VLAN
membership, which is `ip -d link show`, `bridge vlan show` and — where OVS is in play —
`ovs-vsctl show`. Two further points that matter more than the count:

1. **This is the part of Linux that is least runtime state.** §4's central warning is that
   `iptables-save` and `nft list ruleset` are the kernel's live state wearing configuration's
   clothes. Link topology and VLAN membership are not that: a veth is where somebody put it, a
   bridge member is a declared relationship. The configuration-versus-observed distinction still has
   to be recorded — `ip link` reads the kernel — but it is a far weaker hazard here than in the
   firewall, and it is the same hazard `19` §3.9 already accepts for hand-entered physical plant.
2. **`ip -d link show` is one command that covers the whole topology**, which is the closest thing
   Linux has to `display set` for this purpose. §4 was right that no such command exists for the
   *whole host*; for *this slice* something close does.

### L3 is in scope too — owner, 2026-08-10 — and it fits better than L2 did

Asked whether the smallest slice should be the L2 path, the owner answered: *"Well no we'd want L3
in the linux engine as well please."* Scope decision, taken, and it is a better one than the
recommendation it replaces — a map that shows how a VM is *cabled* but not how it is *routed*
answers half of any real question.

Checked against `schema/schema.yaml` on 2026-08-10 rather than assumed. **The L3 half fits better
than the L2 half**, which was not the expectation:

| The thing on a Linux host | Where it goes today | |
|---|---|---|
| `ip addr` — addresses on an interface | `Address` under `LogicalUnit` | ✅ |
| a declared static route | **`StaticRoute`** — destination, preference, metric, and a `next_hop` that is already `Address` / `Interface` / `Discard` / `Reject` / **`NextTable`** | ✅ `Discard` and `Reject` are `blackhole` and `unreachable`; `NextTable` is `ip route … table N` |
| multiple routing tables, a VRF, a netns | **`RoutingInstance`**, whose `isolation` enum already carries `routing_table_only`, `forwarding` and `non_forwarding` | ✅ built for exactly this shape |
| FRR / BIRD running BGP or OSPF | **`RoutingProtocol`** — `{ ospf, ospf_v3, bgp, isis, rip, ldp }`, with `router_id`, `local_as`, `areas`, `reference_bandwidth` | ✅ FRR's `frr.conf` maps straight on |
| a BGP neighbour, an OSPF adjacency | **`ProtocolAdjacency`** — `peer_address`, `peer_as`, `local_address`, `area`, `cost`, `network_type`, `import_policy`, `export_policy`, `route_reflector_client` | ✅ unusually complete |
| a route the kernel holds that nobody declared | **`LearnedRoute`** — `destination`, `via` (a `LogicalUnit` **or** a `RoutingProtocol`), `basis`. Every field is `emit: "—"`: it is never written back out | ⚠️ see below |
| `ip rule` — the *selector* half of policy routing | **nothing.** `NextTable` carries the target; nothing carries *from / to / fwmark / iif → table N* | ❌ one new kind |
| `net.ipv4.ip_forward` | `RoutingInstance.isolation: forwarding` exists as a variant; whether a host-wide sysctl belongs there or on `SystemSettings` is undecided | ⚠️ a decision, not a gap |
| masquerade / DNAT | `NatRule` and `NatRuleSet` exist — but `NatAction`, `NatScope`, `L4Spec`, `PolicyScope` and `AddressValue` are **empty stub structs** (`fathom-ir/src/value.rs:185-206`, each doc-commented *"Shape stated nowhere read"*) | ❌ blocked, **and blocked for Junos too** |

**Two things worth pulling out of that table.**

**`LearnedRoute` already draws §4's configuration-versus-runtime line at the kind level**, which is
better than this document previously implied: a declared route and an undeclared one are *different
kinds*, and the undeclared one is never emitted. But its `basis` field is an `InferenceRuleId` —
*"which heuristic produced it"* — so the kind as written means **inferred**, not **observed**. A
route read off `ip route` was not inferred by Fathom; the kernel stated it. That is one enum's worth
of work, not a redesign, and naming it is the point: without it, every observed route would have to
claim an inference rule produced it, which would be a lie in the provenance record.

**The stub value types are the real blocker, and they are not a Linux problem.** Five types that
`SecurityPolicy`, `AddressObject`, `NatRule` and `NatRuleSet` all depend on are empty structs whose
own doc comments say the shape is stated nowhere. **So today a policy cannot record its ports, an
address object cannot hold its prefix, and a NAT rule cannot record what it does — on any
platform.** Nothing has ever bound them, because no dictionary entry has ever driven
`SecurityPolicy`, `AddressObject`, `NatRule`, `StaticRoute` or `RoutingInstance` for junos-srx
either. Filling them in is shared work that unblocks the firewall and NAT half of *every* platform,
Junos first. It is the largest single piece of modelling debt in the tree.

**Revised scope, then:** the Linux engine is **L2 and L3** — NICs, bonds, VLAN sub-interfaces,
bridges, veths, addresses, routes, routing tables and the routing daemons. That is one parser shape
for link/route text, one for FRR's IOS-shaped config, three or four new kinds, and the stub types.
Firewall and NAT ride on the stub-type work whenever it happens; Docker, containers and SELinux
stay out until §6's second owner question is answered.

### Docker, Kubernetes and routing — owner, 2026-08-10

*"make sure docker, kubernetes, routing is accounted for."* All three in scope. Routing was already
in with L3; Docker and Kubernetes are the addition, and Kubernetes is new to this document entirely.
Accounted for here means: what it is, where it goes, and what is honestly missing — not an estimate,
which needs the scoping decision in §6 first.

**Kubernetes turns out to be the *easiest* of the three, for one reason nobody expected.**

#### What fits

| The thing | Where it goes | |
|---|---|---|
| a Kubernetes **node** | `Device` | ✅ a node is a Linux host; everything in the L2/L3 tables above applies to it unchanged |
| a **VXLAN / IPIP / WireGuard overlay** — Docker overlay networks, and Calico/Flannel/Cilium tunnels | **`Tunnel`**, which already *"spans sites and is contained by the workspace root"* and carries `overlay_prefix` | ✅ a real fit, and the only kind in the schema that is deliberately not owned by a device |
| **Calico BGP peering, MetalLB, BGP-to-the-host** | `RoutingProtocol` + `ProtocolAdjacency` | ✅ the same fit as FRR; this is the routing tie-in |
| pod CIDR, service CIDR, node CIDR | `Address` / `IpPrefix` on the right owner | ✅ |
| per-node routes to other nodes' pod CIDRs | `StaticRoute`, or `LearnedRoute` where BGP put them there | ✅ |
| a **NetworkPolicy** | `SecurityPolicy` + `PolicySet` in shape | ⚠️ blocked on the stub value types, same as every firewall |
| a container's veth | `Cable { media: virtual }` | ✅ |
| a published port `-p 8080:80`, a NodePort | `NatRule` — it is DNAT | ⚠️ blocked on the stub value types |

#### What does not fit, and one trap

- **A container or a pod.** No workload kind exists. **One new kind serves both** — a pod is a
  container group with an address, and Docker's container and Kubernetes' pod differ in ways the
  network map does not care about.
- **A Docker network / a Kubernetes pod network.** Not a `Vlan` — that kind requires a `vlan_id`,
  card 1, and a bridge network has none. Not a `RoutingInstance`. **New kind**, and it is the same
  kind for both.
- **A cluster.** And this is the structural one: **a Kubernetes cluster is not a device.** Fathom's
  containment is `Site → Device → everything`, and a pod network spans nodes by definition. Either a
  cluster becomes a grouping alongside `Site`, or it becomes a kind whose members are referenced
  rather than contained. That is an ADR, it is the largest modelling question Kubernetes raises, and
  it should not be settled by whoever writes the parser.
- **Ingress.** Nothing fits, and it is L7. Probably out of scope; say so rather than model it badly.
- **The trap: do NOT reuse `Service` / `ServiceEndpoint` for a Kubernetes Service.** They are
  carrier-Ethernet kinds — `cid` is *"the carrier identifier"*, `reach` is `external | internal`,
  and `ServiceEndpoint.role` is `uni | nni | enni | demarc`. The name matches and nothing else does.
  A ClusterIP is a virtual address with backend endpoints; a `Service` here is a thing you sell to a
  customer. Reusing it would look clever in review and be wrong in every field.

#### The reason Kubernetes is the easiest one

**Every Kubernetes object carries `spec` and `status` — what was declared, and what is observed —
as separate, named halves of the same document.** §4 named the configuration-versus-runtime problem
as the thing Linux forces on line one and Junos never forced at all; `LearnedRoute` (above) shows
the model already half-draws that line. **Kubernetes draws it for us, in the source text, for every
object.** No other platform on the list does. It means a Kubernetes engine can populate the declared
side from `spec` and the observed side from `status` without a single judgement call, which is
exactly the part that would otherwise be guesswork.

Two more properties in the same direction: **the capture is genuinely declarative** —
`kubectl get <kind> -o yaml` is the config, not a rendering of it — and it is **family C**, the
nested-document family OPNsense already needs, so the parser work is shared rather than additional.
Docker is the same: `docker compose config` is YAML and `docker network inspect` is JSON.

**And the honest counterweight:** `kube-proxy`'s iptables or IPVS rules, and every rule Docker
installs, are *derived* — the kernel's rendering of a Service or a published port. They must land on
the observed side or not at all. A NetworkPolicy read as though somebody typed those iptables rules
would be a fabrication, and it is the single most likely way to get this wrong.

#### The secret surface, which is worse than Linux's

Named now because §5's rule is that the gate leads. Kubernetes and Docker text carries: **kubeconfig
client certificates and tokens**; **ServiceAccount tokens**; `kubectl get secret -o yaml`, whose
values are **base64, which is an encoding and not encryption** — and base64 with no `-----BEGIN`
banner is precisely the shape `65`/`64` already flag as invisible to a banner-anchored detector;
**image-pull secrets** (`.dockerconfigjson`, a base64 JSON blob containing a registry password);
Helm values; and `docker compose config`, which **interpolates `.env` and therefore prints
credentials that are not in any file you pasted** — already demonstrated leaking through the gate
and fixed on 2026-08-10. The `--no-interpolate` form is the safe one and the UI should say so.

#### Where that leaves the engine

The Linux engine is **L2, L3, Docker and Kubernetes**. Concretely that is: the link/route text shape,
FRR's IOS-shaped config, and family C for YAML and JSON; five or six new kinds — a workload, a
container network, a bridge, an `ip rule` selector, and a cluster-or-not decision; the stub value
types, which gate firewall and NAT on every platform; and an observed-versus-declared basis on
`LearnedRoute`. **The scoping decision in §6 is now answered in breadth and not in depth** — the
owner has said what is in; how much of each is in is still the question that produces an estimate.

### What this changes

**Not the security answer.** §5 stands unaltered: an engine is a contribution compiled in, never a
runtime plug-in, for reasons that have nothing to do with which slice of Linux it parses.

**The scoping question in §6 is answered by the owner, above: L2 and L3.** Not the smallest slice
this document first proposed — he rejected that, correctly, because a map that shows how a VM is
cabled but not how it is routed answers half of any real question. Docker, containers and SELinux
remain out until §6's second owner question is settled; firewall and NAT are gated on the stub value
types, which are Junos's problem first.

**One consequence to state plainly**, because it is the strongest argument here and it is not
obvious: this slice is worth more than a fifth vendor. A fifth switch platform adds boxes to a map
that already draws boxes. **This one makes the existing map correct** where today it silently stops
at the server's edge.

---

## Failure modes

1. **§2 is quoted without §3.** "Zero hand-written Rust to add a kind" is true and is the best news
   in this document; it says nothing about parsing that kind's text, which is where the cost is.
2. **"Contribution, not plug-in" is heard as "no".** It is not. It is *reviewed and compiled in*,
   which is how every line already in the artifact got there.
3. **The gate is assumed fixed.** The six shapes in `noise_gate.rs` are fixed. The *class* — a
   detector that assumes Junos tokenisation — is not closed, and every new platform will find more.
   `64` §4 is the standing list of what to test against.
4. **Linux is scoped as "a platform" and estimated like one.** §4 is the argument that it is seven,
   and that most of what a Linux box prints is runtime state rather than configuration.

## Open decisions

Carried from §6, unchanged, with owners:

1. **What "a Linux engine" means** — a named capture sheet of specific commands, or arbitrary Linux
   config text. Owner. Blocks any estimate.
2. **Does the model include a host's internals** — containers, namespaces, Docker networks, LSM
   policy — or does it stop at the network? Owner; it is an ADR.
3. **Does the record distinguish what was declared from what the kernel was doing** when it was
   read? Owner. Junos never forced it; Linux forces it on line one.
4. **Whether a runtime-loaded engine is permanently refused**, and where that refusal is written.
   §5 argues it must be, from invariant 3's own wording. Planning proposes; the ADR set decides.
5. **The `<named human>` build gate** that `71` §13.1 specifies and no code implements. Engineering.
