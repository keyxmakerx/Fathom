# Why `corpus/dict/junos-ex/` has no `virtual-chassis.yaml`

`[edit virtual-chassis]` (`set virtual-chassis member 0 role routing-engine`,
`set virtual-chassis member 1 mastership-priority 200`, and similar) is real,
common Junos EX configuration — EX switches are the platform this feature is
most associated with — and it is deliberately not bound by any entry in this
directory, for a structural reason rather than an oversight.

**There is no schema representation for a Virtual Chassis stack.** Searched
`schema/schema.yaml` for `chassis`, `VirtualChassis`, `member_id` and
`mastership` on 2026-09-19: every `chassis`-adjacent hit is the existing
single-device `Chassis` kind (`Device` -owns-> `Chassis`, one config per
`Device`, `ADR`-referenced as *"An SRX chassis cluster is one Device with two
Chassis, because it has one config"*), plus rack-mounting edges (`MountedIn`,
`SitsOn`, `FixedTo`). None of it models several PHYSICAL switches acting as
one LOGICAL Junos instance with member numbers and a mastership election —
what `[edit virtual-chassis]` configures.

CLAUDE.md rule 3 — *"a field that is not in `schema/` does not exist"* — is
exactly the rule this observation invokes. Binding `virtual-chassis` lines to
the existing `Chassis`/`Device` kinds would either silently misuse a field
meant for something else, or require inventing new schema surface, which is
out of scope for a data-pack session (`schema/` changes are reviewed
separately, not decided inside a corpus/dict addition).

**The lines stay visible, unbound, in the estate of record.** A `set
virtual-chassis …` statement in a paste is residue: not modelled, not
destroyed (it carries no credential — `mastership-priority` and `role` are
not secrets), not silently dropped, just left for a human to read directly
until a `VirtualChassis`-shaped kind exists in `schema/` for a future session
to bind against.
