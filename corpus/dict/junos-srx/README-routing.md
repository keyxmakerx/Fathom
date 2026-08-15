# The routing slice — why the OSPF and BGP entries are shaped as they are

> **Status:** Accepted (2026-08-15). Companion to `protocols-ospf.yaml`,
> `protocols-bgp.yaml` and `routing-options.yaml`. Owner of nothing; it explains
> entries the three YAML files own.

## Why this is a `.md` and not comments in the YAML — and why that reason expired

**The reason this file was split off no longer holds, and saying so is the
point.** It was written against a tree where
`fathom_ingest::dict::EMBEDDED_DICT_SOURCES` compiled every dictionary file into
the module with `include_str!`, so a byte of comment in a dictionary file was a
byte of the 900,000-byte ceiling: measured 2026-08-15, the three files' citations
and reasoning came to 15,648 bytes, more than the slice's Rust (9,314) and its
entry data (5,240) put together.

`adbd9a2` moved the dictionary out of the module and into the page over
`OP_DICT`. **YAML comments now cost artifact bytes, not ceiling bytes**, and the
artifact's ceiling is 4.5 MB rather than 900 KB. The split this section argues
for is no longer paid for by anything.

It is kept anyway, for a reason that has nothing to do with bytes: the
**citation** belongs in the YAML beside the entry it justifies, because ADR-0034
requires the source and the date to travel with the claim, and the **reasoning**
— why this shape and not another, what was rejected, what is deliberately absent
— is document-shaped and does not read as a comment block. That is a judgement,
not a measurement, and it is now the only argument this section has.

## Contents

1. Why `$proto` is a capture and not the literal `ospf`
2. Why there is a `RoutingInstance` node nothing asked for
3. Why every entry re-binds `area`
4. Why `router-id` binds on the instance and not on the protocol
5. What is deliberately not modelled, and what it would take
6. Sources consulted

## 1. Why `$proto` is a capture and not the literal `ospf`

`RoutingProtocol.protocol` is card 1, so every `RoutingProtocol` node has to
state which protocol it is. A dictionary entry can only take a field value from
a captured path segment, so the protocol word has to *be* a capture.

Capturing it does a second job. The fragment binder keys nodes on
`(kind, owner, key)`, so if `ospf` and `bgp` produced nodes with the same key
they would be **one** node, and the second `protocol` assertion would be a
conflict diagnostic with the value dropped. `key: "$proto"` is what keeps them
apart, and it generalises for free: `ospf3` is a third node, not a fourth
assertion onto the second.

**Rejected alternative.** A literal `ospf` path plus a new `key_literal:`
construct in the dictionary grammar to make the fragment key distinct. That
costs a grammar extension *and* still needs the whole `ValueTy` /`BoundValue` /
parse-arm / weld-arm chain for the enum, so it is strictly more work for the
same result.

### 1.1 …but the capture has to be CONSTRAINED, and the first version was not

An unconstrained `$proto` claims every protocol word in that position, and Junos
reuses statement SHAPES across protocols that share nothing else.

`[protocols, $proto, group, $g, neighbor, $n]` was written for BGP. Junos RIP has
the identical shape — `neighbor neighbor-name { … }` at
`[edit protocols rip group group-name ]` — and the page's Options read
*"neighbor-name —Name of an **interface** over which a routing device
communicates to its neighbors"*
(<https://www.juniper.net/documentation/us/en/software/junos/cli-reference/topics/ref/statement/neighbor-edit-protocols-rip.html>,
read 2026-08-15). `rip` is a member of the schema's `RoutingProtocol.protocol`
enum, so it bound.

**One legal RIP line therefore put a `rip` protocol row and a completely
fieldless `ProtocolAdjacency` into the estate of record** — the interface name is
correctly refused as an `IpAddr`, so nothing landed on it. A peer that does not
exist, in the register this product asks to be trusted. Driven in Chromium and
watched. Two smaller cases, same mechanism: `set protocols ospf local-as 65001`
bound `local_as` and `set protocols bgp reference-bandwidth 100` bound
`reference_bandwidth`, and neither is legal Junos.

The fix is `where:`, a token list per capture, added to the dictionary grammar
2026-08-15:

```yaml
    path: [protocols, "$proto", group, "$g", neighbor, "$n"]
    where: { proto: [bgp] }
```

It is gated on both halves — a `where:` naming a capture the path does not hold
is `CaptureArity`, an empty token list is `Parse` — and it is applied at the trie
TERMINAL rather than during the walk, because the trie folds every capture at a
node onto one child and there is nothing per-entry to gate on until an entry is
in hand.

**A statement that fails a `where:` matches no entry, which means strictly MORE
redaction, never less**: the gate then treats every token from the divergence
point on as an argument, arms the base64 detector and runs the raw secret-word
walk over the physical line. That property is not free, and getting it wrong is
how narrowing a capture could have opened a credential path — see the second
clamp on `known_prefix` in `dict.rs::lookup`, which exists because the first
version of this fix left `known_prefix` at full trie depth and
`set protocols rip group G neighbor ge-0/0/9.0 authentication-key <key>` was
stored verbatim as a result. Its own regression test caught it.

**Why not a path literal after all?** Because `where:` keeps `key: "$proto"` and
`from: "$proto"` working, and those are what keep `ospf` and `ospf3` on separate
nodes and what carry the protocol word through the `ospf3 → ospf_v3` token map.
A literal path recovers both only with one entry per protocol word plus a
`const_enum` on each: ten OSPF entries where there are five, and a second place
for the token map to be forgotten.

## 2. Why there is a `RoutingInstance` node nothing asked for

`schema/schema.yaml` puts `HasRoutingProtocol` from `RoutingInstance` and **not**
from `Device`. `fathom-weld` derives a node's containment parent from the schema
and refuses with `NoContainmentEdge` when the schema does not determine one, so
without an instance hop a paste containing any routing statement would be
refused whole.

The node carries no `name`. This is the default instance, the statement does not
name it, and the dictionary has no way to assert a constant string — which is
the right outcome: Junos's name for the default instance is not in the pasted
text, so inventing one would be putting a value in the estate that no line
supports. It declares no `owner` either, so the weld derives `Device` as the
only kind that may contain it.

Every routing entry in the slice upserts the same unkeyed instance, so a paste
with OSPF, BGP and a `router-id` has exactly one.

## 3. Why every entry re-binds `area`

Junos `display set` collapses a container that has children into the children's
full paths. A config whose only statement about an OSPF interface is
`metric 100` emits **one** line:

```
set protocols ospf area 0.0.0.0 interface ge-0/0/0.0 metric 100
```

and no bare `interface` line at all. Only the deepest matching entry binds, so
if the metric entry did not carry `area` itself, the area column would be empty
on exactly the configs that are most common. Every OSPF entry therefore binds
`area` from its own `$area` capture rather than leaning on a sibling line having
been pasted. `routing_slice.rs`'s
`the_area_binds_from_a_deeper_statement_with_no_bare_interface_line` is the
guard.

The bare `interface` entry carries `partial: true` for the same reason the two
zone entries do — `14` §6.5's shadowing gate — and it still binds when it is the
deepest match.

## 4. Why `router-id` binds on the instance and not on the protocol

`schema/schema.yaml` declares `router_id` on both `RoutingInstance` and
`RoutingProtocol`. On Junos only one of them is reachable: there is no
`set protocols ospf router-id` and no `set protocols bgp router-id` — the
statement is `set routing-options router-id`, which is the routing instance, and
Juniper's own description says it is used by both protocols. Binding it to a
`RoutingProtocol` would also mean minting one without knowing its card-1
`protocol`.

The consequence is that `RoutingProtocol.router_id` has no Junos source and
would render as an empty cell forever. That is handled in `fathom-inventory` by
reading the owning `RoutingInstance` — a *stated walk*, which is this inventory
module's own convention and **not** something `52` §3.7 licenses (an earlier
draft quoted §3.7 for a sentence it does not contain; re-read 2026-08-15, and
what it does say is that columns are "chosen from the schema") — so the value is
stored where the vendor puts it and read where an
engineer looks for it.

## 5. What is deliberately not modelled, and what it would take

Each of these is a real, documented, common statement that this slice leaves as
residue. They are listed so a later reader knows they were considered and
refused, not missed.

| Statement | Why not | What would fix it |
|---|---|---|
| `set protocols bgp group <g> peer-as <as>` | A Junos BGP *group* is not a kind in the schema. The value is a fact about every neighbour in the group; attaching it to one neighbour needs a pass that reads the group's neighbour list, and the binder is per-statement by construction (`14` §7). Attaching it to a `ProtocolAdjacency` keyed by the group name would put a row in the inventory that is not a neighbour. | Either a `BgpGroup`-shaped kind in `schema/`, or a post-bind propagation pass. Both are owner/planning decisions. **This is the largest hole in the slice.** |
| `set protocols bgp group <g> local-as <as>` | As above. The `[edit protocols bgp]` level *is* bound, to `RoutingProtocol.local_as`. | As above. |
| `set routing-options autonomous-system <as>` | `RoutingInstance` has no AS field, and routing it to `RoutingProtocol.local_as` would mean asserting `protocol: bgp` from a statement that never says BGP. | An AS field on `RoutingInstance`, which is a schema change. |
| `set protocols bgp group <g> type (internal \| external)` | No schema field. | — |
| `set protocols bgp group <g> cluster <id>` | `ProtocolAdjacency.route_reflector_client` exists, but Junos expresses "this peer is an RR client" by configuring `cluster` on the *group* that holds it. Same group problem, plus an inference on top. | As the first row. |
| `interface-type p2mp-over-lan` | A real Junos value with no counterpart in the schema's `enum { broadcast, point_to_point, non_broadcast, p2mp }`. It falls to the generated `Unknown` arm and is refused, so the field stays empty and the line is diagnosed. | A schema enum change, if the owner wants it. |
| `interface-type broadcast` | Junos has no such token — broadcast is the default, expressed by the statement's *absence*, which a dictionary cannot see. | Nothing at this layer; it is a defaults question. |
| `reference-bandwidth 10g` | Juniper documents the option in bits per second and `Bandwidth::parse` takes digits only, so a suffixed argument is diagnosed rather than mis-scaled. That is the safe direction of error. | A suffix grammar in `Bandwidth::parse`, if real captures turn out to carry one. |

## 6. Sources consulted

Every page below was read on **2026-08-15**. Each entry in the YAML carries the
one it depends on.

| Statement | URL |
|---|---|
| area (Protocols OSPF) | https://www.juniper.net/documentation/us/en/software/junos/ospf/topics/ref/statement/area-edit-protocols-ospf.html |
| interface (Protocols OSPF) | https://www.juniper.net/documentation/us/en/software/junos/ospf/topics/ref/statement/interface-edit-protocols-ospf.html |
| interface-type (Protocols OSPF) | https://www.juniper.net/documentation/us/en/software/junos/ospf/topics/ref/statement/interface-type-edit-protocols-ospf.html |
| passive (Protocols OSPF) | https://www.juniper.net/documentation/us/en/software/junos/ospf/topics/ref/statement/passive-edit-protocols-ospf.html |
| reference-bandwidth (Protocols OSPF) | https://www.juniper.net/documentation/us/en/software/junos/ospf/topics/ref/statement/reference-bandwidth-edit-protocols-ospf.html |
| group (Protocols BGP) | https://www.juniper.net/documentation/us/en/software/junos/bgp/topics/ref/statement/group-edit-protocols-bgp.html |
| neighbor (Protocols BGP) | https://www.juniper.net/documentation/us/en/software/junos/bgp/topics/ref/statement/neighbor-edit-protocols-bgp.html |
| peer-as (Protocols BGP) | https://www.juniper.net/documentation/us/en/software/junos/bgp/topics/ref/statement/peer-as-edit-protocols-bgp.html |
| local-as (Protocols BGP) | https://www.juniper.net/documentation/us/en/software/junos/bgp/topics/ref/statement/local-as-edit-protocols-bgp.html |
| type (Protocols BGP) | https://www.juniper.net/documentation/us/en/software/junos/bgp/topics/ref/statement/type-edit-protocols-bgp.html |
| router-id (Routing Options) | https://www.juniper.net/documentation/us/en/software/junos/cli-reference/topics/ref/statement/router-id-edit-routing-options.html |

Two pages were sought and not obtained, and neither is load-bearing:
`metric (Protocols OSPF)` 404s at the current-documentation URL — the form is
taken instead from the `interface (Protocols OSPF)` syntax block, which is
Juniper's own documentation of the same statement; and no page was found stating
a per-protocol `router-id` on Junos, which is the negative recorded in §4.

## Failure modes

- **The citation and the reasoning drift apart.** Mitigated by every YAML entry
  naming its URL, so this file can go stale without the entries losing their
  source. If an entry changes, its URL changes with it.
- **A reader takes §5 as a to-do list.** It is not; every row there is a
  decision that needs the owner or a schema change, and `78` §5 puts both
  outside an execution session.

## Open decisions

- The BGP group problem (§5, first row) needs the owner. It is the difference
  between a peer row that shows its AS on the most common branch config and one
  that does not.

## Disagreements

None.
