# WO-10 — DHCP relay and BOOTP: the first statements the estate cannot hold

> **Status:** READY, BLOCKED ON BYTES — authored 2026-08-17 at the owner's request
> (*"that's fine if we can't build it currently then can you prepare it to be added later"*).
> Nothing in this order is waiting on a decision about **what** to build or **how**; the modelling,
> the field keys, the dictionary entries and the gates are all written below and can be executed as
> they stand. It is waiting on **room in the module**, and the block is measured rather than
> asserted: see §2. Flip to OPEN the moment `47`'s finder lever (or an equivalent) has landed and
> `cargo build --locked --release --target wasm32-unknown-unknown -p fathom-wasm` reports at least
> 1,200 bytes of headroom.
>
> **This order is also the first proof that the ceiling costs the product a feature the owner asked
> for by name**, which is why §2 is written as a measurement report rather than a caveat.

Depends on: **the byte decision** (owner; `47` §11, `00-ROUTE-TO-WORKABLE.md` §2 stage 1). No code
dependency — `fathom-ingest`, `fathom-weld` and `fathom-graph` are all DONE and all sufficient.

The owner's words, 2026-08-17: *"we need to make sure dhcp relay but also bootp is there. Since we
use bootp apparently, just discovered that."* And, on where it should live: *"make sure it's to the
engine though, we want these engines (however they are parsed, brand, equipment type, etc) to be
independent and dynamic, so people can add their own."*

The second half of that requirement is **already satisfied and needs nothing from this order** —
§3 says why, and it is worth reading before assuming otherwise. The first half is what this order
builds.

Execution protocol: `docs/70-ops/78-execution-protocol.md` governs. Read `CLAUDE.md`, then
`.context/conventions.md`, then `78`, then this document. **ADR-0034 binds every vendor claim in
§5**, and §5.4 records exactly which claims are established and which are not; an executing session
closes that gap before it writes the dictionary, and does not close it from memory.

---

## 0. Contents

| § | |
| --- | --- |
| 1 | Why DHCP is the right first rule-engine subject |
| 2 | **The block, measured** |
| 3 | The engine is already data — what "add your own" already means |
| 4 | The modelling: `DhcpRelay` is a kind, not a field |
| 5 | The statements, and what is established about them |
| 6 | Field keys |
| 7 | Deliverables |
| 8 | Acceptance gates |
| 9 | What this order deliberately does not do |
| 10 | Stop and escalate |

---

## 1. Why DHCP is the right first rule-engine subject

The owner asked a product question on 2026-08-17: *"could this product be eventually setup to like
if it had an entire layout of a network, you could troubleshoot why dhcp traffic isn't routing or
something?"*

The answer is yes, and DHCP relay is the cheapest honest demonstration of it, because a relay
failure is almost always a **statable** failure — a fact missing from a config, or two facts that
disagree across two configs — rather than a physical one. The estate already declares every kind
the reasoning needs: `Zone`, `SecurityPolicy`, `StaticRoute`, `LearnedRoute`, `RoutingProtocol`,
`Address`, `Vlan`, `LogicalUnit`, `NatRule`. What it cannot declare is the relay itself.

The findings a rule engine could then state, none of which needs a packet:

* a `LogicalUnit` with clients on it and no relay, where its sibling units have one;
* a relay whose server address matches no `Address` anywhere in the estate;
* a relay pointing across a `Zone` boundary that no `SecurityPolicy` permits;
* no return route to the relay target's subnet from the relaying device;
* two devices relaying to different servers for the same subnet.

**And the limit, which is a property of invariant 2 rather than a shortfall.** Fathom never touches
a device, so it answers *"why can this configuration not work"* and never *"why is it not working
right now"*. A dead port, a wrong cable, an exhausted pool and a silently dropping firewall are all
outside what a config states, and the findings view must never imply otherwise (`51` §9's rule
about marking rather than claiming applies here in full).

## 2. The block, measured

Three builds on 2026-08-17, on a clean tree at `1f6c644`, reverted immediately afterwards:

| what was added to `schema/` | module bytes | against the 900,000 ceiling |
| --- | --- | --- |
| nothing — the shipped tree | 899,781 | **219 free** |
| 2 fields on an existing kind, no new kind, no new edge | 900,027 | **27 OVER** |
| `DhcpRelay` kind + `HasDhcpRelay` + `RelaysFor` + 2 fields | 900,383 | **602 OVER** |

So **two fields cost 246 bytes and there are 219**, and the compromised modelling this order
rejects on merit in §4 does not fit either. That is the whole of the block: not the parser, not the
weld, not the page — the generated types.

Reproduce it: add the stanza from §4 and the keys from §6, run
`cargo run --locked -p fathom-schemagen --bin fathom-schemagen -- schema`, add the one
`NodeKind::DhcpRelay` arm `crates/fathom-layout/src/layers.rs`'s `projection_of` will demand
(a compile error by design — see that function's own doc), build, measure, then
`git checkout -- schema/ crates/fathom-ir/src/generated/ crates/fathom-layout/`.

### 2.1 Would a server backend unblock it? Yes — and that is the wrong reason to build one

The owner asked this directly on 2026-08-17: *"the engines will be on the server side once we do
the server side config in the future? Would that not resolve any of these issues?"* An earlier
answer in that conversation said flatly that it would not. **That answer was too absolute and is
corrected here**, because the measurement says otherwise.

`47` §4.2's by-instantiation-site table, which is the honest attribution:

| crate | bytes | share of module |
| --- | ---: | ---: |
| `fathom_ingest` — the parser and the dictionaries | **116,771** | 13.69 % |
| `fathom_corpus` + `fathom_find` — the finder | 187,788 | 22.01 % |
| `fathom_ir` — the generated types | 88,605 | 10.39 % |
| `fathom_graph` — the store | 107,128 | 12.56 % |

So moving the **engines** server-side would free on the order of **116,771 bytes**, which is about
190× the 602 this order needs. The owner's intuition is arithmetically right.

**Two things temper it, and neither is a reason to say "no" — they are the price to put beside the
gain.**

1. **It does not make the kind free; it makes room for it.** The +602 is generated types in
   `fathom_ir`, and the browser needs those types whether or not it did the parsing: `fathom_graph`
   must *store* a relay, `fathom_inventory` must *render* it, `fathom_layout` must *draw* it. Only
   `fathom_ingest` leaves. So server-side engines buy headroom, they do not delete this order's
   cost — and a session must still meet G1 with the kind in the build.
2. **It sends the config off the machine, and that is invariant 1.** A server that parses is a
   server that reads, and `70` §8's whole answer to the owner's load-balancing requirement is that
   *the server stores ciphertext it cannot read*. Server-side engines contradict that directly, not
   incidentally. That is not this order's decision to take: every future exception to invariant 1 is
   priced in `docs/30-security/38-the-egress-question.md`, none is approved, and this would be the
   first. It is the owner's call, made there, with the price written down.

**Which is why the recommended lever is still `47`'s finder move: 220,289 bytes — nearly twice what
server-side engines would free — and it breaks no promise at all.** The float lever (44,829) is the
owner's and is ring-fenced for encryption. An executing session does not need to care which lever
was pulled, only that G1 passes.

## 3. The engine is already data — what "add your own" already means

The owner's requirement is that engines be *"independent and dynamic, so people can add their
own"*. **Nothing in this order has to build that; it is how ingest already works**, and an
executing session that starts by designing a plugin system has misread the tree.

* `corpus/dict/<platform>/*.yaml` is one directory per engine. Two exist: `junos-srx` and
  `opnsense`.
* `Dictionary::load_platform(root, platform)` takes the platform by name; `dict.platform()` is read
  from the files, never written in Rust (`crates/fathom-ingest/src/dict.rs`). The one time it was a
  literal, it became a lie the moment a second dictionary landed, and that comment is still in the
  file as the reason it is not one now.
* The page hands each engine to the module at boot as a packed `OP_DICT` frame
  (`FATHOM_DICT_B64`, `FATHOM_DICT_CSV_B64`), so a dictionary costs **artifact** bytes, not module
  bytes. Adding statements to an existing engine is free at the ceiling.

**Where the boundary actually is, and it is ADR-0008:** a dictionary may only bind fields and kinds
that `schema/` declares. So a third party can add a vendor, a platform, a statement or an equipment
type freely — right up to the point where their vendor says something Fathom has no kind for, and
then they need a schema change, and a schema change is generated Rust and costs module bytes. **That
is the wall this order is behind, and it is the same wall a third party would hit.** Anyone
planning the plugin story should read §2 first: the extensibility is real, and it is bounded by the
type system, not by the loader.

## 4. The modelling: `DhcpRelay` is a kind, not a field

Run `19` §3.6's three-limb test, as ADR-0037 §2 did for `Server` and scored it zero of three:

1. **Does it have fields of its own that no existing kind carries?** Yes — a server address, a
   group name, and (see §5) hop-count and wait-time limits that belong to the relay and to nothing
   else.
2. **Does it have edges of its own?** Yes, two: it is contained by the device that relays, and it
   points at the logical units it relays *for*. That second edge is the whole reason the reasoning
   in §1 is possible; a field cannot carry it.
3. **Does it have a lifecycle of its own?** Yes — a `server-group` is named, is referenced from
   several interface groups, and outlives any one of them.

Three of three. It is a kind. The two-field compromise measured in §2 is recorded there **only** to
establish that even the wrong answer does not fit; it is not a fallback, and an executing session
must not ship it to save 356 bytes.

```yaml
  # Appended at the tail of `kinds:`, because order is wire identity (62 §13).
  - kind: DhcpRelay
    layer: config
    emits: true
    doc: |
      A DHCP/BOOTP relay agent's server target, as a device states it. One node per
      configured server address; a server-group of several addresses is several nodes
      sharing a group_name, because the reasoning in WO-10 §1 asks "is there a route to
      THIS address" one address at a time.
      Fathom never observes a lease. This is what the config SAYS, and the findings
      view must never imply it watched a packet (WO-10 §1).
    fields:
      - { name: server, type: IpAddr, card: "1", emit: O }
      - { name: group_name, type: Identifier, card: "0..1", emit: O }
      - { name: maximum_hop_count, type: u32, card: "0..1", emit: O }
      - { name: minimum_wait_time, type: u32, card: "0..1", emit: O }
    identity: []   # VERIFY: nothing in `11` states an identity tuple for a relay.

  - edge: HasDhcpRelay
    class: containment
    from: [Device]
    to: [DhcpRelay]
    out: "0..n"
    in: "1"
    reverse_index: true
    symmetric: false
    fields: []
    emit_dict: null
    doc: The device that relays. `11` §7.2's containment shape.

  - edge: RelaysFor
    class: reference
    from: [DhcpRelay]
    to: [LogicalUnit]
    out: "0..n"
    in: "0..n"
    reverse_index: true
    symmetric: false
    fields: []
    emit_dict: null
    doc: |
      The units whose clients this relay serves. `0..n` at BOTH ends and deliberately:
      a global relay serves every unit, and a unit can be named by more than one relay
      when a group and the global stanza both cover it — which is itself a finding worth
      stating rather than a shape to forbid.
```

**`RelaysFor` is a reference edge, so `hand_link_candidates` will offer it** the moment it exists
and a person will be able to draw a relay by hand between a relay node and a unit. That is correct
and wanted; check it is not in `HAND_LINK_EXCLUDED` (`crates/fathom-weld/src/lib.rs`), which today
excludes only `MountedIn`.

## 5. The statements, and what is established about them

### 5.1 The finding that matters to the owner

**`forwarding-options helpers bootp` is deprecated for SRX Series Firewalls.** Juniper's own CLI
reference page for `bootp` says so in terms, recommending JDHCP / extended DHCP
(`forwarding-options dhcp-relay`) instead. Source: Juniper Networks, *"bootp"*, Junos OS CLI
reference, `sampling-forwarding-monitoring` topic tree, **fetched 2026-08-17**.

The owner said *"we use bootp apparently, just discovered that"*. His config is not wrong and it
works; but this is exactly the kind of thing the teaching half of the product exists to say, and
**this order should carry it into the estate rather than leave it in a work order nobody reads**:
the dictionary entry for the bootp form should mark it deprecated-on-this-platform, and the findings
view should be able to state it. That is a `corpus/` claim and invariant 10 applies — it needs a
`reviewed_by: <named human>` like every other.

### 5.2 Established, with source and date

All from Juniper Networks' Junos OS CLI reference, **fetched 2026-08-17**:

* `bootp` — *"Configures a router, switch, or interface to act as a Dynamic Host Configuration
  Protocol (DHCP) or bootstrap protocol (BOOTP) relay agent."* Hierarchy `[edit forwarding-options
  helpers]`. *"Statement introduced before Junos OS Release 7.4."* Deprecated for SRX per §5.1.
* `server` (DHCP and BOOTP Relay Agent) — *"configures the router or switch to act as a DHCP and
  BOOTP relay agent. The device forwards all broadcast requests within the configured subnet to all
  configured servers in parallel."* Takes *"address — One or more addresses of the server."*
  *"Statement introduced before Junos OS Release 7.4."*
* `server-group` (DHCP relay) — a named group of DHCP server addresses, appliable globally or per
  interface group. *"Statement introduced in Junos OS Release 8.3"*; dhcpv6 hierarchy support in
  11.4. Up to **32** addresses per group for DHCPv4 from Release 18.4R1, **5** in earlier releases.
* `active-server-group` applies a server-group, at `[edit forwarding-options dhcp-relay]` or per
  `group <name>`.

### 5.3 The statement set to bind

Written as `set` form, which is what a person pastes. Each needs its own `id`, `versions` predicate
and `reviewed_by` per the grammar in `corpus/dict/junos-srx/system.yaml`.

```
set forwarding-options helpers bootp server <address>
set forwarding-options helpers bootp interface <ifl> server <address>
set forwarding-options helpers bootp maximum-hop-count <n>
set forwarding-options helpers bootp minimum-wait-time <n>
set forwarding-options dhcp-relay server-group <name> <address>
set forwarding-options dhcp-relay active-server-group <name>
set forwarding-options dhcp-relay group <name> active-server-group <name>
set forwarding-options dhcp-relay group <name> interface <ifl>
```

New file: `corpus/dict/junos-srx/forwarding-options.yaml`, `platform: junos-srx`. It is a **new
file in an existing engine**, which is the cheapest shape there is: artifact bytes only.

### 5.4 NOT established — close this before writing the dictionary

**The verbatim syntax blocks could not be retrieved.** Juniper's CLI-reference pages render their
`Syntax` and `Hierarchy Level` sections client-side, and four fetches on 2026-08-17 returned the
section headings with empty bodies. ADR-0034 is explicit that *"I could not establish this"*
outranks a confident guess, so the §5.3 list is **the shape a paste takes**, drawn from the
descriptions and from Juniper's own example topics — it is **not** a quoted grammar, and the
executing session must not treat it as one.

Before writing the entries, establish, from **two independent sources** and recording both with
their dates:

1. the verbatim syntax block for `bootp` and for `dhcp-relay`, including which sub-statements are
   per-interface and which are global;
2. whether `server` under `helpers bootp` accepts a hostname as well as an address (the description
   says *"address"*, which is not the same as the grammar saying so) — this decides `IpAddr` versus
   a host union in §4;
3. the units and bounds of `maximum-hop-count` and `minimum-wait-time`, which decide the scalar
   types and whether either needs a validity rule;
4. whether `routing-instance` may qualify a server, which decides whether `RelaysFor` is enough or a
   second edge to `RoutingInstance` is needed. **If it is needed, re-measure §2**: the byte figures
   there are for two edges, not three.

Juniper's CLI Explorer, the SRX administration guide PDF, and a second vendor-independent source are
the routes; the KB article on relaying across an IPsec tunnel is a worked example rather than a
grammar and does not count as one of the two.

## 6. Field keys

Appended at the tail of `schema/field-keys.yaml`, never inserted, because the integer is the wire
identity of the field. The next free key at the time of writing is **308**; re-read the tail before
assigning, because `47`'s lever or another order may have taken them.

```yaml
  # DhcpRelay (WO-10)
  DhcpRelay.server: 308
  DhcpRelay.group_name: 309
  DhcpRelay.maximum_hop_count: 310
  DhcpRelay.minimum_wait_time: 311
```

## 7. Deliverables

1. `schema/schema.yaml` — §4's stanza; `schema/field-keys.yaml` — §6's keys; regenerate with
   `fathom-schemagen` and commit the generated files (they are checked in by design).
2. `crates/fathom-layout/src/layers.rs` — one `NodeKind::DhcpRelay` arm in `projection_of`. It is a
   config-layer object with no geometry of its own; the `NtpServer`/`SyslogTarget` group is the
   precedent.
3. `crates/fathom-inventory/src/element.rs` — a `display_name` arm. **This is not optional and the
   file's own comment says why**: it has been fixed twice, and a kind whose name is bound and not
   shown looks identical to one nobody has named. A relay's name is its server address.
4. `corpus/dict/junos-srx/forwarding-options.yaml` — §5.3's entries, after §5.4 is closed.
5. An inventory row set for `DhcpRelay` (`InvKind::ALL`, appended — the wire byte is the array
   index, so never inserted).
6. A driver under `docs/80-review/evidence/` that pastes a real relay stanza and asserts the nodes,
   the edges and the export round trip. `2026-08-16-hand-link-drive.mjs` is the pattern.
7. `docs/60-content/66-junos-coverage-measurement.md` — re-measure. Coverage is 47.5% of a branch
   config today and this moves it.

## 8. Acceptance gates

* G1 — the floor (`78` §6) green, including the byte gate. **The build must come in under 900,000
  with the kind in it.** If it does not, the lever this order was unblocked on was not enough:
  stop, and escalate rather than trimming the modelling.
* G2 — `fathom-schema-check` 0 failures **and 0 warnings**. A new kind with `identity: []` has
  raised `schema.identity.unexercised` before; `crates/fathom-schema/tests/shipped_tree.rs` pins
  the empty warning set, so this fails a test rather than printing.
* G3 — a pasted `helpers bootp server` line builds a `DhcpRelay` node contained by the device, with
  the address bound, and the line does **not** appear on the residue list.
* G4 — a `server-group` of three addresses builds three nodes sharing one `group_name`.
* G5 — the relay survives an export and an import, by kind name and not by ordinal.
* G6 — the redaction gate is unmoved: a relay stanza carries no credential, so
  `crates/fathom-ingest/tests/redaction_canary.rs` must be **unchanged** and still green. **Rule 0
  applies if any of this order tempts you to touch it**: a gate is tested against what a device
  accepts, never against what the detector needs.
* G7 — the deprecation in §5.1 is stated somewhere a person reads, with its source and date.

## 9. What this order deliberately does not do

* **No rule engine.** This order makes DHCP *statable*. Every finding in §1 needs the findings view,
  which is zero lines today and is its own order. Do not write half of one here.
* **No DHCPv6.** `dhcpv6` is a parallel hierarchy and doubles the statement set for a home lab that
  is not asking for it. Residue, named on the list, not dropped silently.
* **No DHCP *server*.** `system services dhcp-local-server` is a different feature; a relay and a
  server are not the same node and must not share a kind.
* **No cross-config correlation.** "The relay points at an address nothing in the estate owns" needs
  both configs in one graph, which is `70` §6's unbuilt requirement, not this.

## 10. Stop and escalate

1. §5.4 cannot be closed from two independent sources. Do not guess a grammar; `78` §4.
2. The build exceeds 900,000 with §4 in it (G1).
3. §5.4 item 4 turns out to need a `RoutingInstance` edge — re-measure and re-escalate before
   writing it.
4. A second platform's relay form (PAN-OS, Nexus, Meraki) turns out not to fit `DhcpRelay`'s
   fields. The kind is meant to be cross-vendor; if it is not, that is a modelling decision and
   planning work, not an execution session's.
