# ADR-0037 — A server is a `Device` with a role, and the role enum grows by two

> **Status:** **Proposed** — the schema half is executed and gated; the platform gap in §5 is named
> and deliberately not closed. Binding under `CLAUDE.md` rule 3 once Accepted; reopenable on merit
> under `75` §2, never on sunk cost.
> **Date:** 2026-08-16
> **Owner request:** *"as long as I could design my network and servers for my home lab as a example
> that's all that matters"* — the word **servers** is the whole of this record's occasion.
> **Answers:** `schema/schema.yaml`'s `Device.role`, which declared
> `enum { firewall, router, switch, load_balancer, other }` and therefore had no word for a server,
> a NAS, a hypervisor, an access point, a PDU or a camera.
> **Reversal cost:** R1 — two enum variants and no field key. Field keys are untouched (no field was
> added), the registry stays at 307, and the canonical form of a schema enum is its token, so a
> reversal costs two tokens that would fall into the generated `Unknown` arm rather than any stored
> byte moving.
> **Supersedes:** — (amends nothing; `11` §6.3 named the field and never enumerated it in prose)

## 0. Contents

1. What was decided
2. Why `Device` is the right kind for a server, and a `Server` kind is refused
3. The two variants, and why each one earns a variant
4. What was left out, and why `other` staying load-bearing is the point
5. **The gap this does not close** — `Device.platform` has no row a server can honestly hold
6. What this costs, measured
7. Where it is reachable, and how that is enforced
8. Failure modes
9. Open decisions
10. Sources consulted
11. Disagreements
12. How this was verified

---

## 1. What was decided

**`Device.role` gains `server` and `access_point`.** They are declared before `other`, which stays
last as the taxonomy's escape hatch rather than as a peer of the six.

```
enum { firewall, router, switch, load_balancer, server, access_point, other }
```

`schema/schema.yaml` moves 0.2 → 0.3, priced item by item against `62` §16.2 in the file's own
version comment: *"New enum variant | minor | `Variant::Unknown(token)` — the generated arm"*, twice,
and nothing else in the change. No kind, no edge, no field, no key.

**A server is a `Device`.** No new kind. §2 is the argument.

**The role is now on the diagram.** It was already an inventory column and an inspector row; the
picture drew `Device` over every box, so a home lab of a firewall, a switch, an access point and two
servers looked like five identical boxes — which is the state the owner would be drawing *into*.

## 2. Why `Device` is the right kind for a server, and a `Server` kind is refused

The question is not rhetorical. `19` §3.6 refused to widen `Device` for a splitter and minted
`PassiveNode` instead, and the reasoning there is exactly the reasoning to test here.

`11` §6.3 defines a `Device` as **"the unit that a configuration file is a configuration file of"**,
and `19` §3.6 says why that definition is not relaxed: it is what makes `emit(graph, platform, unit =
Device)` meaningful (`11` §9.2), and widening it produces an emit unit with no config.

Three candidate homes, tested against `19` §3.6's own three-limb test — distinct required fields,
distinct edge signature, distinct lifecycle:

| Candidate | Verdict |
|---|---|
| `PassiveNode` | **No.** Its definition is *"hardware with ports and no configuration"*, and its forms are `Splitter, PatchPanel, Odf, Wdm, MediaConverter, Enclosure, Other`. A server has a hostname, an address, interfaces and a configuration; it is the opposite of passive. It is also contained by `Premises` rather than `Site`, which is right for a splitter in a street handhole and wrong for a box that belongs to an operational unit. |
| A new `Server` kind | **No**, and this is the close one. Test it on the three limbs. **Distinct required fields:** none — hostname, platform, os_version, management_address, domain_name are the same five, and the fields a server would add (CPU, RAM, disks) are inventory facts the schema does not model for any kind, including `Chassis`, which already carries `model` and `serial`. **Distinct edge signature:** none — a server has `HasInterface`, `HasPort` through a `Chassis`, `MountedIn` a `Rack`, and is contained by a `Site`, which is `Device`'s signature exactly. **Distinct lifecycle:** none in the direction that matters — a server is *parseable in principle* (it has config text) even though no dictionary reads one yet, where a `PassiveNode` is *never* parsed, never emitted, never has a capture. **Zero limbs of three.** A kind that shares its fields, its edges and its lifecycle with an existing kind is that kind wearing a label, and the label is what an enum is for. |
| `Device` + `role` | **Yes.** The field already exists, is already `0..1`, is already rendered in three places, and is already refused-on-typo at the form. |

**The honest weakness, stated rather than buried:** `Device`'s definition says *"a configuration file
is a configuration file of"*, and Fathom cannot read a server's configuration file today. So a
hand-added server is a `Device` whose defining property is currently unexercised. That is a statement
about coverage, not about kind — the same is true of a `junos-mx` box, which is a registered platform
with no dictionary behind it. The definition survives; what does not survive is `Device.platform`,
and §5 is about that.

**Priced, not built.** If a later decision does want a `Server` kind, `19` §7.5's arithmetic applies:
one kind, some edges, and the fields it would carry. Against `62` §16.2 that is a minor bump and
against `44` §5.2's ceiling it is a kind's worth of generated tables — `Rack` cost measurably more
than these two variants did (§6). Nothing here forecloses it, and `Origin::Hand` provenance means a
migration could retype the nodes it applies to.

## 3. The two variants, and why each one earns a variant

The test applied: **would a person put this in a rack (or on a wall) and would calling it one of the
existing five be wrong?** Both limbs, or it does not earn a variant.

**`server`** — a hypervisor host, a NAS, a container host, a bare-metal application server. It is the
owner's own word and the largest single population in a home lab; calling it `other` is the defect
this record exists for. There is no existing variant it could borrow: it neither routes, switches,
filters nor balances.

**`access_point`** — an 802.11 AP. Every home lab and every branch office has at least one, usually
several. Both variants it might borrow are wrong: it is not a `switch` (it bridges a radio, and `56`
§4's layer model would file it wrongly), and it is not `other` (nothing is undecided about an AP).
The name is the standards term, not a vendor's, per `62` §7 rule 1 — no vendor spelling is ever a
variant name, and the spellings map is where vendor text lives.

**`server` is one variant and not four.** A NAS, a hypervisor, a container host and an application
server differ in *what is installed on them*, not in what they are, and the schema does not model
installed software on any kind. Splitting them would be a variant per product category, which is
precisely how an enum stops meaning anything.

## 4. What was left out, and why `other` staying load-bearing is the point

Written down so the next person does not re-litigate each one from scratch:

| Rejected | Why |
|---|---|
| `storage` / `nas` | A NAS is a `server` whose job is disks. §3's fold. |
| `hypervisor` | Software on a `server`. Same fold. |
| `wireless_controller`, `nms` | Software on a `server`. An Omada or UniFi controller is a program, and `64` §1 records that the controller's backup has no capture path at all. |
| `pdu`, `ups` | Rack furniture with a management address that carries no traffic. Genuinely arguable now that ADR-0036 shipped an elevation — a rack drawing without a PDU is not a rack drawing. Left out because that is a **rack** question (what may occupy a U) and not a **role** question (what a box is for on the network), and answering it here would settle the wrong one. They stay `other`. |
| `camera`, `printer`, `phone`, `workstation` | Leaves, not infrastructure. One of them opens the door to all of them, and the owner's sentence is *network and servers*. |
| `modem`, `ont` | A media converter is a `PassiveNode` with ports and no config (`19` §3.6); a carrier CPE that routes is a `router`. Both already have homes. |
| `endpoint` as one general bucket | The closest call after `pdu`. Rejected because it is not distinguishable from `other` in practice: both mean *"a thing on the network that is not infrastructure"*, and two words for one idea is worse than one. |

**`other` is not a failure state.** It is the honest answer for a box the taxonomy has not decided,
and keeping it honest is better than one variant per product category. Seven declared variants is
already at the edge of what a single-word dropdown can carry.

**Card `0..1` and single-valued is unchanged, and it is a real limit.** A home gateway that is
router + firewall + AP + switch in one box gets one word. Widening the cardinality is a separate
change with a separate cost — every reader that prints *the* role becomes a reader that prints a set
— and nothing has asked for it.

## 5. The gap this does not close, and it is bigger than the one that is closed

**`Device.platform` is card `1` and a foreign key into `schema/platforms.yaml`, and that file
registers no general-purpose host.** The rows are `junos-srx`, `junos-mx`, `junos-ex`, `panos`,
`ios-xe`, `nx-os`, `eos`, `fortios`, `opnsense`, `omada-sw`. There is no `linux`, no `proxmox`, no
`generic`.

So the actual sentence *"add my Proxmox box"* is blocked one field to the left of the one this record
fixes. Today the equipment form makes you pick a platform your server does not speak. That is what
`crates/fathom-wasm/tests/equip.rs` does, in a comment that says so, and what
`docs/80-review/evidence/2026-08-16-server-role-drive.mjs` does, in a comment that says so. **Naming
it is the point; a hidden workaround would be worse than the gap.**

Why it is not closed here:

1. **`schema/platforms.yaml` forbids it in terms.** Its own rule, written when the owner named six
   vendors on 2026-08-10: *"a vendor is registered when the owner names it; a platform is declared
   only when a real config has been seen."* Ciena is the precedent — a vendor row and no platform
   row, because no Ciena config has been seen. Inventing a `linux` platform for a config format
   nobody has surveyed would fabricate vendor behaviour, which `.context/conventions.md` forbids
   outright.
2. **`65` already surveyed exactly this and the answer is not one row.** *"Linux is not one config
   format: it is eight commands in five different shapes"*, seven distinct text shapes, six to twelve
   pastes for one box, and `65` §4 records that a paste replacing the estate makes reconciliation a
   **precondition** for Linux rather than a later nicety. A platform row implies a dictionary; a
   dictionary for Linux is the largest unbuilt thing in the corpus.
3. **It is an owner decision, not an execution one.** `70` §7 settles the platform question by
   listing the owner's platforms, and none of them is a host OS. Adding one is `78` §5's escalation,
   not this session's.

**Three routes exist and each is priced:**

| Route | Cost | Consequence |
|---|---|---|
| A `linux` platform row with no dictionary | Two lines in `platforms.yaml`, one vendor row, zero Rust | The form offers a platform that parses nothing. Honest for hand entry, misleading at the paste sheet — a user picks `linux`, pastes `ip addr`, and gets 100% residue with no explanation. Needs the paste surface to say *"this platform has no dictionary"*, which is a page change, not a schema one. |
| Relax `Device.platform` to `0..1` | One character in `schema/`, **but** a **major** bump under `62` §16.2 (*"cardinality lower bound raised"* is major; lowering it is the widening direction and reads as minor — the table's row is ambiguous and would need `62` to rule) and it breaks both identity tuples, which are `[hostname, platform]` and `[platform, management_address]`. A device with no platform is not re-identifiable at all. | Re-identification loses its root for exactly the boxes a home lab is made of. |
| A `Host` kind with no platform | A kind, its edges, its fields, its generated tables | Re-opens §2's refused question, and §2's answer would change: a kind that drops a *required* field of `Device` does have a distinct required-field signature. **This is the route worth reconsidering if the platform gap is judged unacceptable**, and it is the one thing in this record that a later decision might genuinely overturn. |

Nothing here chooses. `75` records intent without deciding, and this is intent.

## 6. What this costs, measured

Measured on this machine, `cargo build --locked --release --target wasm32-unknown-unknown -p
fathom-wasm`, at the tip and after each step:

| Step | Module bytes | Δ |
|---|---|---|
| Tip (`1524347`) | 894,883 | — |
| The two variants alone (schema + regeneration) | 895,016 | **+133** |
| Plus the role on the diagram (`fathom-inventory::role_word`, `Cell::role`, `Node::role`, the wire pack) | 895,380 | **+364** |
| **Total** | **895,380** | **+497** |

Against `44` §5.2's 900,000-byte ceiling: **4,620 bytes of headroom**, down from 5,117.

The page cost is artifact bytes, not ceiling bytes: two strings in `ROLES`, one `<text>` per box with
a role, one span per Outline row, three CSS rules. The artifact is 2,353,253 bytes against `44`'s
4.5 MB budget.

**For comparison:** ADR-0035's whole hand-placement feature — a kind, an edge, an op, a gesture and a
journal arm — cost +985. Two enum variants at +133 is the cheapest end-to-end change this project has
measured, and `00-ROUTE-TO-WORKABLE.md` §4b predicted it: *"two lines in `schema/`, one generator
run, three one-line test-constant edits, ZERO production Rust."* That held exactly. The +364 is not
the taxonomy; it is the decision to put the answer in the picture.

**No new external crate**; `./scripts/gate-zero.sh` passes.

## 7. Where it is reachable, and how that is enforced

A role nobody can pick is not a feature, so each surface has a guard rather than a promise:

| Surface | State | Guard |
|---|---|---|
| The equipment form's dropdown | Offers all seven, in declaration order | `crates/fathom-artifact/tests/artifact.rs::the_equipment_form_offers_every_declared_role` asserts the page's `ROLES` array **equals** `DeviceRole::DECLARED` — both directions and the order. The pre-existing platform pin checked only one direction; for `role` the other direction is the one that bites, because a variant the schema declares and the dropdown omits is silently unreachable. |
| The inventory's role column | Already existed (WO-08) | `crates/fathom-wasm/tests/equip.rs::a_server_and_an_access_point_can_be_added_and_are_named_as_such` |
| The inspector's field row | Already existed | as above |
| The diagram box | **New** — right-aligned on the kind's line | `crates/fathom-layout/tests/agg.rs::only_a_box_standing_for_one_device_carries_a_role` |
| The Outline row | **New** — a `.dorole` span after `.dokind` | The Chromium drive reads the **accessible tree**, not the DOM: the `<svg>` is `aria-hidden`, so a label drawn only on the shape announces to nobody. |
| The refusal message | Names all seven | `crates/fathom-wasm/tests/equip.rs::a_role_that_is_not_declared_is_refused_and_the_message_names_the_ones_that_are` loops `DECLARED`, because the message is hand-written next to a generated array and can drift silently. |

**A collapsed diagram box never carries a role.** The aggregation signature does not include `role`,
so a run of like-kind siblings can hold a firewall and a server; printing one member's role on a box
standing for eight would be `59` §3.6's silent-count rule in a different coat. The same rule already
governs `Cell::key` and the hand-placed pin: a fact about one node is printable only on a box that
stands for one node.

## 8. Failure modes

1. **The dropdown and the schema drift.** Closed by the equality pin in §7. It was open before this
   record — `ROLES` was a hand-typed list with no guard at all.
2. **The refusal message stops naming a valid role.** Closed by the `DECLARED` loop in §7.
3. **The wire packing loses the group key.** The role rides in slot 7 of a `FACE_BOX` as
   `<count> <interior> <placed> <role> <group>`, inserted *before* the group because the group is the
   only token that may be empty. `-` is the sentinel for "no role" — an empty token would make the
   positions depend on whether a role is set. `crates/fathom-wasm/tests/diagram_agg.rs::the_role_sentinel_keeps_the_group_key_last`
   is the guard, and it runs on a fixture where **no** role is set, which is the state that exercises
   the sentinel on every box.
4. **An old build meets a 0.3 export.** It reads `DeviceRole::Unknown("server")` and renders the
   token — the forward compatibility `62` §7 rule 2's generated arm exists for, and the reason `62`
   §16.2 prices this minor. Driven in `crates/fathom-ir/tests/canon_laws.rs::device_role_declares_the_home_lab_variants`
   rather than asserted.
5. **A 0.2 workspace meets a 0.3 build.** Refused by name at header line 3, before the body is read,
   because the migration chain is empty. Deliberate pre-release — nothing has shipped and
   `schema/released/` holds no snapshot — and identical to ADR-0036 §5.2's position.
6. **The enum grows by accretion.** The real long-run risk. §4 is the mitigation: every rejected
   variant is written down with its reason, so the next request is answered from a record rather than
   from taste.
7. **A person types `nas` and is refused rather than folded.** Intended. `author.rs` refuses the
   generated unknown arm for the *form* direction, so the fold is a decision the user is told about
   instead of a token nothing downstream understands. The refusal message names the seven.

## 9. Open decisions

1. **The platform gap (§5).** Owner and planning. Three routes priced; none chosen.
2. **Whether power belongs in the elevation** (§4's `pdu`/`ups` row). A rack question for whoever
   owns ADR-0036's upper rungs, not a role question.
3. **Whether `role` should ever be multi-valued** (§4's last paragraph). Nothing has asked.
4. **`62` §16.2's cardinality rows are ambiguous in the widening direction** (§5's table, route 2).
   Raised here because §5 needed to price it; `62` owns the answer.

## 10. Sources consulted

Everything below is a file in this repository, read on 2026-08-16. No external claim is made in this
record — a product taxonomy is a decision, not a vendor fact, so ADR-0034's citation duty does not
bind it. Where a vendor or standards term is used (`access_point` from 802.11) it is used as a name,
not as a claim about behaviour.

- `schema/schema.yaml` — `Device`, `PassiveNode`, `Chassis`, the `Placeable` class, the version block
- `schema/platforms.yaml` — the registry and its own declaration rule
- `docs/10-core/11-ir-schema.md` §6.3 — `Device`'s definition
- `docs/10-core/19-service-and-physical-model.md` §3.6, §3.9, §3.10, §7.5 — `PassiveNode`, the
  three-limb test, and the bump arithmetic this record's §2 copies
- `docs/60-content/62-schema-spec.md` §7 (enum rules), §16.2 (the bump table), §17 (generated
  artifacts)
- `docs/60-content/65-the-engine-boundary.md` §4 — why a Linux platform row is not two lines
- `docs/70-ops/79-work-orders/00-ROUTE-TO-WORKABLE.md` §4b — the field-cost measurement this change
  reproduced
- `docs/90-decisions/adr-0035-*.md`, `adr-0036-*.md` — the two records this one is a sibling of, and
  the source of §6's comparison

## 11. Disagreements

**With `00-ROUTE-TO-WORKABLE.md` §4b, mildly and in its favour.** It measured *"adding a field end to
end"* at two lines of schema plus three one-line test edits and zero production Rust. That held for
the taxonomy (+133 bytes, zero production Rust). It does **not** describe the surfacing: making the
answer visible in the picture cost 364 bytes and touched three crates. The measurement was right
about the schema and is quoted, in this project, as though it were about the feature. Adding a field
is cheap; **showing it is where the cost is**, and the ratio here is 1:2.7.

## 12. How this was verified

The floor (`78` §6), all green, at the commit this record lands with:

- `cargo fmt --all --check` — no output
- `cargo clippy --all-targets --locked -- -D warnings` — clean
- `cargo test --workspace --locked` — **638 passed**, 0 failed, 0 ignored, 0 filtered (632 at the
  tip; +6, one per row of §7's table plus the wire sentinel)
- `cargo run --locked -p fathom-schema --bin fathom-schema-check` — `50 kinds · 92 edges · 61 scalars
  · 10 enums`, **0 failures and 0 warnings**
- `./scripts/gate-zero.sh` — OK
- `cargo run --locked -p fathom-artifact` — 2,353,253 bytes
- `cargo build --locked --release --target wasm32-unknown-unknown -p fathom-wasm` — **895,380 bytes**
  against the 900,000 ceiling

And in Chromium, through the shipped artifact, from an **empty page**:
`docs/80-review/evidence/2026-08-16-server-role-drive.mjs` — **23/23**. It builds a five-box home lab
by hand (firewall, switch, access point, two servers), asserts the dropdown offers exactly
`DECLARED`, reads the roles out of the inventory table and off the drawn boxes, asks **Chromium for
the accessible tree** and finds `ap-loft Device access_point` there, exports the journal, throws the
page away with a real reload, imports the file, and reads every role back. Two network requests, both
the file itself; zero page errors.
