# 66 — How much of a real SRX config does Fathom read? The measured answer

> **Status:** Measured, 2026-08-15. Not a plan, not an estimate: every number below is the
> output of `cargo test -p fathom-ingest --test branch_coverage -- --nocapture`, which anyone
> can re-run, and of `ls -l` on the release module.
>
> **Why it exists.** The corpus counted the dictionary's *entries* — "42 Junos statements"
> (`docs/70-ops/79-work-orders/00-ROUTE-TO-WORKABLE.md`) — and an entry count says nothing
> about coverage. One entry can carry a tenth of a real configuration; forty can carry none of
> it. Nobody had the number that matters: paste a branch firewall's config in, what fraction of
> it does the product understand? The answer on the morning of 2026-08-15 was **23.8%**. By the
> evening it was **47.5%**, and this document says exactly what moved, what did not, and why the
> rest is not a dictionary problem at all.
>
> **Owner:** this document owns the Junos coverage figure. Anything else quoting a coverage
> percentage references it rather than restating it (conventions § *Precedence*).

## 0. Contents

| § | | margin tab |
|---|---|---|
| 1 | The number, before and after | *read this first* |
| 2 | The configuration it is measured against | *and where every line came from* |
| 3 | The by-section table | *where the misses are* |
| 4 | What was widened, and why those sections | *the measurement chose them* |
| 5 | What is still missed, in three kinds | *the important half* |
| 6 | The bytes | *the tightest constraint in the project* |
| 7 | Three defects the widening exposed | *all fixed, all now tested* |
| 8 | Failure modes of this measurement | |
| 9 | Open decisions | *escalated, not decided here* |
| 10 | Sources consulted | |
| 11 | Disagreements | |

---

## 1. The number, before and after

| | statements | bound | bind rate |
|---|---|---|---|
| **Before** — 42 dictionary entries | 122 | 29 | **23.8%** |
| **After** — 69 dictionary entries | 122 | 58 | **47.5%** |

Both figures are over the same file, `crates/fathom-ingest/tests/fixtures/junos-srx-branch-documented.txt`,
and both are pinned by an assertion in `crates/fathom-ingest/tests/branch_coverage.rs` so that
the next person to move them has to say so in a diff.

The real page agrees. Driven in Chromium against
`target/artifact/fathom-dev.html`, the paste sheet's own footer reads:

```
read branch-srx — 39 understood, 64 lines not read, 6 secrets removed
```

122 − 58 = 64. The page and the test are counting the same thing, from opposite ends.

That run is reproducible rather than reported: `scripts/drive-branch-coverage.mjs` pastes the
fixture into the real artifact and asserts **31 facts about the DOM** — one network request and
only one (the file itself), no console errors, the tally above, no trace of any of the four
credentials anywhere in the rendered HTML, the five zones present with their interfaces, the new
`L3Interface` edge in the unresolved table, eleven named lines that must no longer be residue,
and four that must still be. Screenshot:
`docs/80-review/evidence/2026-08-15-branch-coverage-paste.png`.

**The after-number is two lower than the widening alone produced**, and the two are worth more
than they cost. See §7.1.

## 2. The configuration it is measured against

A measurement is only as honest as its denominator, so the denominator is stated in full.

The fixture is **122 `set` lines** of a branch SRX: a firewall with three LAN VLANs behind an
IRB, a DHCP-client WAN port, source NAT to the internet, a site-to-site IPsec tunnel to head
office, four zone pairs of security policy, an address book, applications, DHCP pools, MSS
clamping, SNMP, NTP, syslog and local logins. That is what a branch box looks like.

**It is not a capture of any real device, and must never be described as one.** It is assembled
from Juniper's own documented examples. Every statement *form* in it was read off a Juniper page
on **2026-08-15** — the URLs are in §10 — because ADR-0034 and invariant 10 forbid inventing
one, and a measurement taken against invented syntax would measure nothing. Values (addresses,
object names, password hashes) are the documents' own where a document gives one and obviously
fake placeholders where it does not.

**What counts.** The denominator is the lines the framer classified as statements —
`Bound | Unmapped | Unshaped | Quarantined`. The prompt echo and blank lines are excluded because
they are not configuration. A line counts as bound only on `LineOutcome::Bound`. A quarantined
line — one whose credential the gate destroyed — is deliberately counted as a **miss**: destroying
the secret is correct behaviour and the operator's statement is still unmodelled, so calling it a
hit would flatter the number.

## 3. The by-section table

Sections are the operator's mental hierarchy, not the trie's: `security policies` and
`security nat` are different jobs even though both hang off `security`.

| section | before | after | miss after | why the miss (see §5) |
|---|---|---|---|---|
| security policies | 0 / 21 | 0 / 21 | **21** | B — `PolicyScope` is a reference-bearing stub |
| access (DHCP pools) | 0 / 12 | 0 / 12 | **12** | C — no kind models an address pool |
| security address-book | 0 / 6 | 0 / 6 | **6** | B — `AddressValue` stub; and the book has no home |
| security nat | 0 / 4 | 0 / 4 | **4** | B — `NatScope` and `NatAction` are stubs |
| routing-options | 0 / 3 | 0 / 3 | **3** | A + D — see §5.4, escalated |
| applications | 0 / 3 | 0 / 3 | **3** | B — `L4Spec` stub |
| system services | 0 / 3 | 0 / 3 | **3** | C — no kind |
| interfaces | 9 / 17 | **14 / 17** | 3 | A — `mtu`/`speed` and the `@interface_like` gate, §5.3 |
| snmp | 0 / 2 | 0 / 2 | 2 | C — no kind (both lines correctly quarantined) |
| system login | 0 / 2 | 0 / 2 | 2 | C — no kind (one line correctly quarantined) |
| system | 2 / 5 | **3 / 5** | 2 | A — `name-servers` is `0..n`, §5.3 |
| security ike | 7 / 9 | 7 / 9 | 2 | B — `IkeId` stub, for `local-identity` / `remote-identity` |
| system syslog | 0 / 1 | 0 / 1 | 1 | B — `SyslogHost`, and severity/facility are one line |
| **security zones** | 6 / 18 | **18 / 18** | 0 | widened |
| **vlans** | 0 / 7 | **7 / 7** | 0 | widened |
| **security ipsec** | 5 / 6 | **6 / 6** | 0 | widened |
| **security flow** | 0 / 2 | **2 / 2** | 0 | widened |
| **system ntp** | 0 / 1 | **1 / 1** | 0 | widened |
| **TOTAL** | **29 / 122** | **58 / 122** | **64** | |

## 4. What was widened, and why those sections

The measurement chose them, on one rule: **take the sections with the most misses that need no
stub value type shaped.** Twenty-seven entries, from 42 to 69.

| entries | what | lines bought |
|---|---|---|
| 8 | `security zones` — the bare stanza, `description`, `screen`, `tcp-rst`, `application-tracking`, and `host-inbound-traffic` `system-services` / `protocols` at both the zone level and the per-interface level | 12 |
| 3 | `vlans` — `vlan-id`, `l3-interface`, `description` | 7 |
| 4 | `interfaces` — `disable` at port and unit level, unit `vlan-id`, `family ethernet-switching vlan members` | 5 |
| 4 | `security flow tcp-mss` — `all-tcp`, `ipsec-vpn`, `gre-in`, `gre-out` | 2 |
| 2 | `system` — `time-zone`, `ntp server` | 2 |
| 6 | bare stanzas under `security ike` and `security ipsec` — `proposal`, `policy`, `gateway`/`vpn` | 1 |

Six of those are worth a sentence each.

**`security zones` was the largest reachable miss and it went to 100%.** A branch config says
more about a zone than which interfaces are in it: `tcp-rst`, `screen`, `application-tracking`,
a description, and — the important one — `host-inbound-traffic` at the **zone** level as well as
the per-interface level. The dictionary had only the per-interface `system-services` form. That
is why `set security zones security-zone trust host-inbound-traffic system-services all` was
residue while the line beside it bound.

**`security flow tcp-mss` had never been bound at all**, though the schema's own comment on
`SecurityFlowSettings` says the kind exists *"because `mtu.mss-clamp.absent` needs somewhere to
look."* On a branch box with a tunnel, `set security flow tcp-mss ipsec-vpn mss 1350` is the fix
for the single most common site-to-site complaint. A tool that cannot see the statement cannot
report on its absence.

**`family ethernet-switching vlan members` is how a branch LAN is built**, and without it the
LAN was invisible: the ports existed, the VLANs did not, and nothing joined them.

**`disable` is stored inverted, on the read path.** The IR stores `admin_up`; Junos writes the
negative. The schema's field doc already predicted the inversion — *"Junos emits the negative
(disable); the emitter owns that inversion"* — and this carries it on the way in too, because a
parser must not hand the store a value spelled the vendor's way. It is expressed in the corpus
(`const_bool: false`), not in Rust, so the next platform that spells it the other way needs no
code.

**The bare stanzas implement a rule `14` §7.1 already stated and nothing had implemented** —
*"`set security ike gateway GW-B` (a bare stanza creation) … creates the node with no fields."*
Juniper's own guided setup writes `set security ipsec proposal standard` on a line of its own,
and until now the object the next four lines referred to did not exist.

**Value types added to the binder:** `VlanId`, `TzName`, `IpAddr`, `u16`, the `HostProtocol`
set, and a `const_bool` field spec. All six are scalars or closed enums the schema already
declares. **No stub value type was shaped and no schema field was added.** This was dictionary
work, deliberately; §5.2 and §9 say what it would have taken to do otherwise.

## 5. What is still missed, in three kinds

The 64 remaining misses are not one problem. They are three, and only one of them is a
dictionary problem.

### 5.1 The shape of the remaining misses

| kind | lines | what it actually is |
|---|---|---|
| **B — a stub value type stands in the way** | 37 | the field exists in the schema and its type is an empty struct |
| **C — no kind models the thing at all** | 20 | DHCP pools, system services, SNMP, local users |
| **A — reachable dictionary work** | 7 | small, specific, listed in §5.3 |

### 5.2 Kind B, and the sentence that reframes it

The corpus has been describing this as *"five empty stub structs"* — `NatAction`, `NatScope`,
`L4Spec`, `PolicyScope`, `AddressValue` (`65` §4 and §7, `00-ROUTE-TO-WORKABLE.md` §7). That is true
and it is not the whole truth, and the difference decides how much work the fix is.

Three of those five — `PolicyScope`, `NatScope` and `NextHop` — are declared
`contains_reference: true` in `schema/schema.yaml`. **They hold `NodeId`s.** And `fathom-ingest`
cannot mint a `NodeId`: `fathom-id` deliberately has no constructor that reads a clock or an RNG
(invariant 9), so a fragment addresses its nodes by dense index and identity is the store weld's
work. Filling in `PolicyScope`'s four variants would therefore **not** be enough to bind a
security policy. A reference-bearing field value needs a resolution path from ingest through the
weld that does not exist for field values today — only for *edges*, via `PendingEdge`.

So the honest statement of the largest gap in Junos coverage is not "the struct is empty". It is:

> **Every field whose value contains a reference is out of reach of ingest, whatever its struct
> looks like, until the fragment can express a pending reference in a field value the way it
> already can in an edge.**

That is why `security policies` — 21 lines, the single biggest section of a real firewall
config — is at zero and stays there in this change. Binding a `PolicySet` while dropping
`from-zone trust to-zone vpn` on the floor would have raised the number and broken `14`'s one
governing rule, `NOTHING PARSED IS SILENTLY LOST`. The number is not worth that.

`AddressValue` and `L4Spec` hold no references and are genuinely just unshaped; `11` §6.6 states
both shapes (`Prefix / Range / Dns / Wildcard`, and `{ protocol, source_ports,
destination_ports }`). Shaping them is real work — a canonical serialisation and a total order
each, plus the wire format — but it is *ordinary* work, unlike the reference problem. See §9.

`security address-book` has a second, independent blocker worth recording on its own: **the
address book's name has no home in the IR.** `AddressObject` and `AddressSet` have `name`,
`value` and `description` and nothing else; the only link to a book is the `InAddressBook` edge
to a `Zone`, which models `attach zone`, not `address-book <book-name>`. So even with
`AddressValue` shaped, `set security address-book BOOK address A 10.0.0.0/8` cannot be bound
without losing `BOOK`.

### 5.3 Kind A — the reachable dictionary work not done here

Seven lines, and each is left out for a stated reason rather than for want of time.

| line | why not |
|---|---|
| `set interfaces ge-0/0/5 mtu 9192` | `@interface_like` resolves to one of four kinds and the loader requires the field to exist on **all four**. `TunnelInterface` has no `mtu` and no `speed`. Every workaround either mis-kinds `st0` as an `Interface` or weakens the `FieldUnknown` gate. It needs a narrower kind-resolver spec, which is a design decision, not a dictionary line. |
| `set interfaces ge-0/0/5 link-mode full-duplex` | `Interface.duplex` is an inline `enum { full, half, auto }` with no binder value type, and the same `@interface_like` problem. |
| `set interfaces ge-0/0/0 unit 0 family inet dhcp` | Binding it would set `families += inet` and lose `dhcp`. There is no schema field for "this unit is a DHCP client". A half-bind here is exactly the silent loss the residue list exists to prevent. |
| `set system name-server 192.0.2.53` | `SystemSettings.name_servers` is `IpAddr` at card `0..n`. The binder can accumulate a `set{enum}` but has no list-of-scalar accumulator. Small, real, and better done deliberately than as a footnote to this change. |
| `set routing-options static route …` (×3) | See §5.4. |

### 5.4 `routing-options static route` — escalated, not skipped

Three lines, and it looks like the cheapest section left. It is not, for two reasons and the
second one belongs to the owner.

1. `next-hop st0.0` is a `NextHop::Interface(NodeId)` — kind B again, the reference problem.
   `next-hop 172.16.1.1` and `discard` are bindable; the interface form is not.
2. **`HasStaticRoute` runs `RoutingInstance -> StaticRoute`, so a static route needs a routing
   instance, and `RoutingInstance.name` is required.** What is the default instance called? `11`
   §6.5 says only that *"the default instance is modelled explicitly, not as `None`"*, and its
   worked example on line 2844 writes `name: Set("inet.0")` — which is a routing **table** name,
   not an instance name. Choosing between `inet.0`, `default`, `master` and `default-switch` is a
   modelling decision that every future platform inherits. An execution session may not make it
   (`78` §5). It is in §9.

## 6. The bytes

Measured, never estimated: the release module built before and after with
`cargo build --locked --release --target wasm32-unknown-unknown -p fathom-wasm`.

| | bytes | headroom under the 900,000 ceiling |
|---|---|---|
| before (HEAD, 42 entries) | 852,918 | 47,082 |
| after (69 entries) | 888,200 | **11,800** |
| delta | **+35,282** | |

<!-- VERIFY: 852,918 is this worktree's baseline, measured 2026-08-15 at commit adbb590. The
     task brief quoted 870,977 from a sibling branch; the two trees differ and this document
     reports the one it measured. -->


**This fits, and it is tight, and the tightness needs saying out loud.** 11,800 bytes is 1.3%
of the ceiling. On this tree, a second parallel change of similar size would breach it.

The delta splits into two very different halves:

| | bytes | how it was obtained |
|---|---|---|
| dictionary YAML text | **+22,236** | `wc -c corpus/dict/junos-srx/*.yaml`, 19,183 → 41,419. `include_str!`ed into the module verbatim — **comments included** |
| compiled code | **+13,046** | the remainder: new `BoundValue` variants, the `HostProtocol` set, six new `set_field` monomorphisations, `const_bool`, the three §7 fixes |

**The first half is temporary and the integrator should know it.** On this worktree the
dictionary is still compiled into the module through
`fathom_ingest::dict::EMBEDDED_DICT_SOURCES`, so every citation comment costs ceiling bytes. On
the tree where the dictionary is handed in at boot over `OP_DICT` and `Dictionary::embedded()`
no longer exists, those 22,236 bytes move from the module to the artifact, and this change costs
about **13.0 KB of ceiling, not 35.3 KB** — leaving roughly **34,000** bytes of headroom rather
than 11,800.

The artifact went from **1,215,578 to 1,262,622 bytes**. The after-figure is measured
(`cargo run --locked -p fathom-artifact`); the before-figure is arithmetic rather than a second
build, and the arithmetic is exact because the shell source and `design/tokens.css` did not
change. The artifact is those two plus the base64 of the module; base64 of 852,918 bytes is
1,137,224 characters and of 888,200 bytes is 1,184,268, and 1,262,622 − 1,184,268 = 78,354 is
the unchanged remainder, which is also what the before-figure's subtraction gives.

The comments are not padding and were not trimmed to buy headroom. They are the ADR-0034
evidence — the URL, the read date, and the verbatim syntax that came back — and trimming them to
save bytes would trade a permanent record for a temporary saving on a tree that is about to stop
paying it. Per-entry cost including comments is **824 bytes** (22,236 / 27); a prior measurement
of ~457 bytes per entry was of entries carrying less citation.

## 7. Three defects the widening exposed

### 7.1 A partial match reported `Bound` while the line's tail went nowhere

Adding the bare `security ike gateway <name>` stanza made
`set security ike gateway ike-gw local-identity hostname branch` match a four-segment entry.
The gateway bound. `local-identity hostname branch` did not, and the line came off the residue
list — which is `14`'s one governing rule broken, in the direction that flatters the coverage
number.

`bind::bind_statement` now reports a statement as residue whenever `m.consumed <
stmt.path.len()`, whatever the entry. The nodes and edges still bind, because the object's name
genuinely is on the line and binding it loses nothing; the line stays visible, because its tail
was not read. The rule is stated over depth rather than over `partial:` because the same loss
was always reachable through a non-partial entry whenever a real config carries a sub-statement
the entry's path stops short of. The gate is unaffected either way: `redact::gate_statement`
already scans `m.consumed..segs.len()` as argument tokens.

**Cost: two lines of apparent coverage.** 60 would have been the flattering number; 58 is the
true one.

### 7.2 A credential in an unmodelled tail survived the gate — invariant 3, pre-existing

The same investigation found a hole in the redaction gate, and it is the most serious thing in
this change.

When a statement matched a dictionary entry, the leaf-name secret detector walked the **entry's**
path rather than the line. For a `partial: true` entry that stops short of the line, the tail of
the line is outside that path — so a secret word appearing only in the tail was invisible to the
detector.

Demonstrated, by reverting the fix and re-running:

```
in:   set security zones security-zone Z interfaces ge-0/0/0.0 vendor-extension secret FATHOMCANARY-TAIL-99999
out:  capture: "set security zones security-zone Z interfaces ge-0/0/0.0 vendor-extension secret FATHOMCANARY-TAIL-99999"
      drops:   DropManifest { entries: [], already_redacted: [] }
```

The credential survives verbatim into the capture — the thing the workspace encryptor is handed —
and the drop manifest says nothing happened. **This is reachable on the tree as it shipped**, not
only after this change: the `security-zone <z> interfaces <unit>` entry has been `partial` since
WO-03, and any vendor sub-statement Fathom does not model under a matched partial entry lands in
the same position. Adding bare stanzas multiplies the reachable paths, which is how it was found.

Tokens past the end of the matched entry's path now walk the raw line **as well as** the entry
path — a union, so the branch is strictly stronger than what it replaced, in the direction
`14` §9.7 states for this gate. `secret_exempt` suppresses only its own half: an exemption is a
claim about the shape the entry models and cannot speak for tokens outside it.

Pinned by `a_secret_word_in_an_unmodelled_tail_is_still_caught` in
`crates/fathom-ingest/tests/redaction_canary.rs`, which was watched to fail before the fix and
pass after it.

### 7.3 `NoContainmentEdge { owner: Device, child: NtpServer }` — found in the browser

The first `system ntp server` entry owned `NtpServer` off `Device`. `HasNtpServer` runs
`SystemSettings -> NtpServer`. It compiled, the dictionary loaded, every test in the workspace
passed, and the paste failed in Chromium on the first try — the paste sheet showing
`NoContainmentEdge { owner: Device, child: NtpServer }` where the estate should have been.

The reason nothing caught it: `crates/fathom-weld/tests/containment.rs` proved every
(owner, child) pair the dictionary *was said to* produce, from a hand-maintained list of eleven
rows. A hand-maintained list is only as good as the hand.

That test file now also **derives** the pairs — it runs the shipped dictionary over this
document's fixture and asserts that every owner pair the resulting fragment actually contains
resolves to a containment edge, and pins the six-pair set. The next wrong owner fails at
`cargo test`.

This is the case for driving the real page that no amount of unit testing makes: the defect was
one line of YAML, in a crate with 41 passing tests, and only the browser said so.

## 8. Failure modes of this measurement

Stated because a number without its failure modes invites misuse.

1. **One configuration is one configuration.** 122 lines of documented branch SRX is not the
   4,000-line datacentre config in `14` §8.1's damage taxonomy. A config with a hundred security
   policies would measure *worse* than 47.5%; one that is mostly interfaces would measure better.
   The right next measurement is a second fixture of a different shape.
2. **The fixture is assembled, not captured.** Juniper's documentation is authoritative for
   syntax and is not a sample of what operators write. Real configs contain `apply-groups`,
   `deactivate`, and forms nobody documents.
3. **"Bound" is a line-level verdict, not a field-level one.** A line can bind while one of its
   fields fails to parse — that is a `Diag::ValueUnparsed`, and it does not reduce the bind rate.
   A field-level coverage figure would be lower and would be a different, also-useful number.
4. **The section attribution is by text prefix**, not by the shaped path. It is exact for this
   fixture and would need care on a config using `apply-groups`.
5. **Quarantined lines count as misses**, which understates coverage by 3 on this fixture and is
   the conservative direction on purpose (§2).

## 9. Open decisions

Escalated, not decided here (`78` §5).

1. **What is the default `RoutingInstance` called?** Blocks `routing-options static route` and
   every future platform's default instance. §5.4.
2. **How does a fragment express a pending reference in a *field value*?** This, not the empty
   structs, is what blocks `security policies`, `security nat` and `next-hop <interface>` — 27 of
   the 64 remaining misses. §5.2.
3. **Shall `AddressValue` and `L4Spec` be shaped from `11` §6.6?** Both shapes are stated; both
   are reference-free; together they unblock `address-book` (partly — see 4) and `applications`.
4. **Where does an address book's *name* live?** `AddressObject`/`AddressSet` have no field for
   it and `InAddressBook` models `attach zone`, not the book. §5.2.
5. **Does `@interface_like` need a narrower form** so `mtu`, `speed` and `duplex` can bind
   without either mis-kinding `st0` or weakening the `FieldUnknown` gate? §5.3.
6. **The byte ceiling.** 11,800 bytes of headroom on this tree, ≈34,000 once the dictionary
   moves out of the module. `00-ROUTE-TO-WORKABLE.md` §2 stage 1 already says the ceiling is an
   architecture question rather than a number to raise; this is the first change that makes it
   an *immediate* one.

## 10. Sources consulted

All read **2026-08-15**. Where a page is cited for a statement form, the form is transcribed
verbatim into the dictionary file beside the entry that uses it, so the record survives link rot.

**Worked configurations** (the fixture's lines come from these):

- Juniper Networks, *How to Configure and Operate Juniper SRX300 Line Firewalls: A Guided Setup* —
  Step 1, *Configure Secure Local Branch Connectivity*.
  <https://www.juniper.net/documentation/us/en/software/guided-setup/branch-srx-gs/topics/topic-map/step-1-p2-secure_local.html>
  — VLANs, IRB units, `family ethernet-switching vlan members`, zones, `security policies`,
  `security nat source`, `system services dhcp-local-server`, `access address-assignment pool`.
- Same guide, Step 2, *Configure an IPsec VPN* (branch-office half).
  <https://www.juniper.net/documentation/us/en/software/guided-setup/branch-srx-gs/topics/topic-map/step-2-p1-add-ipsec-vpn.html>
  — `st0`, `routing-options static route`, `security ike`, `security ipsec`, the `trust`→`vpn`
  policy, the `untrust` zone's `system-services ike`.
- Juniper Networks, *Day One+ SRX300 — Step 2: Up and Running*.
  <https://www.juniper.net/documentation/us/en/day-one-plus/srx300/id-step-2-up-and-running.html>
  — `system host-name`, `system root-authentication`, `system services ssh root-login`.
- Juniper Networks, *Understanding Address Books* (address-book worked examples).
  <https://www.juniper.net/documentation/us/en/software/junos/security-policies/topics/topic-map/security-address-books-sets.html>

**CLI Reference statement pages** (syntax and hierarchy level), all under
`https://www.juniper.net/documentation/us/en/software/junos/cli-reference/topics/ref/statement/`:

| statement | slug | used for |
|---|---|---|
| `security-zone` | `security-edit-security-zone.html` | every zone-level entry in §4 |
| `host-inbound-traffic` | `security-edit-host-inbound-traffic.html` | the four hierarchy levels it may appear at |
| `tcp-mss (Security Flow)` | `security-edit-tcp-mss.html` | the four MSS clamp entries |
| `screen` | `security-edit-screen-zones.html` | `Zone.screen` |
| `tcp-rst` | `security-edit-tcp-rst.html` | `Zone.tcp_rst` |
| `application-tracking` | `security-edit-application-tracking.html` | `Zone.application_tracking` |
| `address-book` | `security-edit-address-book.html` | §5.2's book-name finding |
| `policies (Security)` | `security-edit-policies.html` | the fixture's policy lines |
| `vlan-id (VLANs)` | `vlan-id-edit-vlans-qfx-series.html` | `vlans <name> vlan-id` |
| `l3-interface (VLAN)` | `l3-interface-edit-vlans-qfx-series.html` | `vlans <name> l3-interface` |
| `vlan-id (logical interface)` | `vlan-id-edit-interfaces.html` | `interfaces … unit N vlan-id` |
| `disable (Interfaces)` | `disable-edit-interfaces.html` | `admin_up = false`, both levels |
| `mtu (Interfaces)` | `mtu-edit-interfaces.html` | §5.3's `@interface_like` finding |
| `link-mode` | `link-mode-edit-interfaces.html` | §5.3 |
| `time-zone` | `time-zone-edit-system.html` | `SystemSettings.time_zone` |
| `name-server (System Services)` | `name-server-edit-system.html` | §5.3's `0..n` finding |
| `server (NTP)` | `server-edit-system-ntp.html` | `NtpServer.address` |
| `user (Access)` | `user-edit-system-login.html` | the fixture's `system login user … class` line |
| `application (Applications)` | `application-edit-applications.html` | the fixture's `applications` lines |
| `static (Routing Options)` | `static-edit-routing-options.html` | §5.4 |
| `syslog` | `syslog-edit-system.html` | the fixture's syslog line |
| `community (SNMP)` | `community-edit-snmp.html` | the fixture's SNMP lines |
| `trap-group (SNMP)` | `trap-group-edit-snmp.html` | the fixture's SNMP lines |

**In-repo, opened rather than recalled:** `schema/schema.yaml` (kinds, edges, scalars),
`schema/field-keys.yaml`, `crates/fathom-ir/src/value.rs`,
`crates/fathom-ir/src/generated/accessors.rs` (slot types),
`docs/10-core/11-ir-schema.md` §6.5–6.6, `docs/10-core/14-parsers-and-ingest.md` §6–9,
`docs/60-content/65-the-engine-boundary.md`.

## 11. Disagreements

**1. "Five empty stub structs" is the wrong diagnosis, and it has been repeated in three
places.** `65` §4, `65` §7 and `00-ROUTE-TO-WORKABLE.md` §7 all name `NatAction`, `NatScope`,
`L4Spec`, `PolicyScope` and `AddressValue` as *"empty stub structs"* blocking firewall and NAT.
Filling those five in would unblock two of them. Three carry `contains_reference: true`, and the
blocker there is architectural: a fragment cannot mint a `NodeId`, and there is no
`PendingEdge` equivalent for a field value. Proposed replacement wording, for whoever owns those
documents: *"two unshaped value types, and a missing pending-reference path for field values."*

**2. `00-ROUTE-TO-WORKABLE.md`'s "42 Junos statements" reads as a coverage figure and is not
one.** It is an entry count. The entry count rose 64% (42 → 69) and the coverage figure rose 100%
(23.8% → 47.5%); the two are not proportional and will diverge further as the cheap sections are
used up. Wherever a coverage claim is meant, this document is the owner of the number.

**3. The byte ceiling is now a scheduling constraint, not just an architecture question.** With
11,800 bytes of headroom on this tree, two independent contributors cannot both land a
medium-sized change. That is a fact about the next week, not about the next release.

**4. "The gate is proved by canaries" was true of the fixture, not of the class.** §7.2 is a
credential leak that reached the capture verbatim with an empty drop manifest, on the tree as it
shipped, and every canary test passed throughout — because the canaries live on statement forms
the dictionary models, and the hole was in the forms it does not. The pattern to take from it:
**a gate whose behaviour depends on whether the parser recognised the line must be tested on
lines the parser does not recognise.**
