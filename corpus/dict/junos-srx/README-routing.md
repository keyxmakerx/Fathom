# The routing slice — why the OSPF and BGP entries are shaped as they are

> **Status:** Accepted (2026-08-15). Companion to `protocols-ospf.yaml`,
> `protocols-bgp.yaml` and `routing-options.yaml`. Owner of nothing; it explains
> entries the three YAML files own.

## Why this is a `.md` and not comments in the YAML

`fathom_ingest::dict::EMBEDDED_DICT_SOURCES` compiles every dictionary file into
the WebAssembly module with `include_str!`, verbatim and uncompressed. **A byte
of comment in a dictionary file is a byte in the shipped module.** Measured on
2026-08-15 while writing this slice: the three files' citations and reasoning
came to 15,648 bytes of the module against a 900,000-byte ceiling — more than
the slice's Rust code (9,314) and its actual entry data (5,240) put together.

So the record splits. The **citation** stays in the YAML beside the entry it
justifies, because ADR-0034 requires the source and the date to travel with the
claim and because an entry whose provenance is one file away is an entry whose
provenance gets lost. The **reasoning** — why this shape and not another, what
was rejected, what is deliberately absent — lives here, where it costs the
module nothing.

If the dictionary ever stops being compiled in and is handed to the module at
boot instead (`CLAUDE.md`'s open question (a) from 2026-08-09), this split stops
being necessary and the two halves can be rejoined.

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
reading the owning `RoutingInstance` — `52` §3.7's "a cell is a field or a
stated walk" — so the value is stored where the vendor puts it and read where an
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
