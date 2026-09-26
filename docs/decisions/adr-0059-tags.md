# ADR-0059: Tags

**Status:** accepted 2026-09-26. The owner asked for tags on "pretty much everything" on 2026-09-25
(#55). On 2026-09-26 the owner asked the lead to go with the board's proposal of plain ink tags, and
left the modelling to the lead. Schema 0.11 becomes 0.12.

## The ask

"We need a tag system for pretty much everything." Board: `design/proposals/cables/cable-filter.dc.html`,
panel 3: "One tag list for the whole design: a device, a cable, a port, a rack or a network takes any
of them. A tag is a group in the Cables list, a column and a filter in Inventory." Tags also feed
the cable groups (#54) and search.

## What was looked at

- `schema/schema.yaml`: `Note` and the `Notable` class (ADR-0053 §5) put one kind on several
  owners through a class on the `from:` side. `HasTenant` and `HasServiceType` hang design-wide
  kinds off the workspace root. `OfType` and `AttachedTo` are reference edges into a kind that
  already has a containment parent.
- `client/src/document/cascade.ts`: removing a node removes every live edge that touches it, so a
  removed tag leaves no dangling reference, and a removed device takes its tag links with it.
- The layer rule (R-L2, gate `dict.layer.violation`): a parsed configuration can only create
  config-layer kinds.

## Decisions

1. **A tag is a node, not a field.** A new kind, `Tag`, with one field, `name`. It hangs off the
   workspace root through a new containment edge, `HasTag`, as `Tenant` does. It is
   `layer: physical` and `emits: false`, as `Note` is, so a parsed configuration can never create
   one. It joins `Placeable`, as every kind but `LayoutPin` does (`shipped_tree.rs` holds that);
   the client does not draw tags.
2. **Objects point at tags.** A new reference edge, `TaggedWith`, runs from a new class,
   `Taggable`, to `Tag`. Both ends are many: an object takes any number of tags, and a tag is on
   any number of objects. `Taggable` is `Device`, `PassiveNode`, `PhysicalPort`, `Cable`, `Rack`,
   `Premises`, `Vlan`, `ContainerNetwork` and `Container`. It can widen later, as `Placeable` has.
3. **Tags are plain ink.** A tag has no colour. On a cable, colour keeps meaning the real sheath.
4. **One tag list per design.** Tags that span an organisation come later.
5. **A name is a tag's identity.** A name is trimmed, runs of spaces inside it become one, and it is
   1 to 64 characters long. Two names that differ only in case are the same tag. The editor refuses
   a second tag with an existing name, and readers treat two such tags as one. Two people adding
   the same tag at once can produce two nodes, and nobody should see that as two tags.
6. **A VLAN row takes a tag through its members.** A VLAN row is derived from several `Vlan` nodes
   (ADR-0058 decision 1). Tagging the row tags every member, untagging it untags every member, and
   the row shows the tags of all its members together. A Docker network is one node and takes its
   tag directly.
7. **A tag outlives its last use.** It stays in the list and is still offered when its last object
   loses it. Removing a tag is its own action, and it takes the tag off every object.
8. **Each tag action is one undoable change** (ADR-0053): tag an object (creating the tag if it is
   new), untag it, rename a tag, remove a tag. A rename to a name already in use is refused by name.
9. **0.12 is additive, and old designs keep opening.** One new kind, one new field
   (`Tag.name`, field key 343), one new class and two new edges. The client and the server read 0.11
   payloads and write 0.12 (ADR-0058 decision 6).

## What it gives up

- Subnet rows cannot take a tag. They are masked addresses, with no node to point from, until a
  subnet is stored as a thing of its own.
- The same-name rule is enforced by the editor only. A payload with two tags of the same name still
  opens, and shows them as one.
- A rename that would merge two tags is refused rather than merged. Merging can come later, if it is
  missed.

## Order of work

1. The schema: `Tag`, `HasTag`, `Taggable`, `TaggedWith`, field key 343 and version 0.12; regenerate,
   and read 0.11 payloads.
2. Tag chips in the device, port, cable, rack and network editors, with "Add tag" suggesting existing
   tags.
3. Tags in search, as a column and filter in Inventory, and as groups in the cable filter (#54).
