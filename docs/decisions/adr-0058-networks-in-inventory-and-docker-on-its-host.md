# ADR-0058: Networks in Inventory; Docker networks and containers on their host

**Status:** accepted 2026-09-25. The owner chose board A
(`design/proposals/networks/A-inventory-list.dc.html`) on 2026-09-25 and left the modelling to the
lead. Schema 0.10 becomes 0.11.

## The ask

Map a real network by hand: an OPNsense box, an Arista switch, Ubiquiti gear and Docker hosts. Board
A: "A network is a VLAN, a subnet or a Docker network. Its members are interfaces; a container is a
member through its host."

## What was looked at

- `schema/schema.yaml`: `Vlan` per device with `VlanMember` (:697, :2454); `Address` on a
  `LogicalUnit` (:684); `Occupies` Interface→PhysicalPort, "created by the user" (:2551); no subnet
  kind, no container kinds. `RoutingInstance` is a separate route table (:709).
- ADR-0037 §2 (proposed): a new kind needs its own required fields, edges and lifecycle. A container
  has no platform, chassis or config of its own and lives and dies with its host, so it is not a
  Device. The approved Hypervisor board: "A guest is a node in the same graph as a switch."
- `client/src/document/plain.ts:122` and `crates/fathom-workspace/src/lib.rs:182`: the payload
  version must match exactly, and there is no migration chain.

## Decisions

1. **A network row is derived, not stored.** A VLAN row is the per-device `Vlan` entities with one
   id that a layer-2 path joins in the open design (unit, interface, `Occupies`, cable, far side).
   The same id with no joining path gives separate rows, marked "same id, not joined". A subnet row
   comes from `Address` values masked to their prefix, one per prefix and layer-2 group.
2. **A drawn port joins the config layer through `Occupies`.** Attaching a VLAN or an address to a
   drawn port writes an `Interface`, its `Occupies` and a `LogicalUnit` where none exists. The
   editor asks for the interface name, prefilled from the port's label.
3. **Docker lives on its host as three config kinds.** `ContainerNetwork` (name, driver, subnets,
   gateways), `Container` (name) and `PublishedPort` (protocol, container port, host port, host
   address). Edges: `HasContainerNetwork` and `HasContainer` from the Device, `HasPublishedPort` from
   the Container, `AttachedTo` Container→ContainerNetwork with the container's address, and
   `ParentUnit` ContainerNetwork→LogicalUnit for macvlan and ipvlan. All are `emits: false`.
4. **A published port is destination NAT on the host,** held as `docker run -p` states it, so a
   later flow tracer can follow it. It becomes a `NatRule` once `NatAction` has a shape.
5. **A container holds no environment, command or labels.** Compose files keep passwords there, and
   credentials are protected by never arriving (CLAUDE.md rule 4).
6. **0.11 is additive, and old designs keep opening.** The client and the server read 0.10 payloads
   and write 0.11. A design drawn before the upgrade opens after it.
7. **Each editor action is one undoable change** (ADR-0053): add a VLAN, add a subnet, add a Docker
   network, attach or detach an interface, remove a network (refused while containers are on it),
   add a container. Each refuses what the schema forbids, by name, and writes nothing.
8. **IPv4 first.** An IPv6 address is accepted once its spelling is proven identical to the
   server's.

## What it gives up

- Published ports and NAT rules are two things until `NatAction` has a shape.
- The same-device rules for these edges are declarations; only the editor enforces them, and the
  list must cope with a payload that breaks them.
- Docker's own documentation was not reachable on 2026-09-25; facts about drivers, default bind
  addresses and name rules stay marked VERIFY until read from `docker/docs`.

## Order of work

A1: schema 0.11 with decision 6, the typed encoders, VLAN and subnet commands, the derivation, and
the Networks list with its Add network editor for VLANs and subnets. A2: Docker networks,
containers and published ports. A checker attacks each before it is merged.
