# README-ubiquiti.md — the UniFi/EdgeOS decision, data not code

**Status:** Accepted, 2026-09-19. This file is the one place this decision is recorded;
`schema/platforms.yaml`'s `ubiquiti`/`edgeos` comments point here rather than restating it
(conventions §*Precedence*).

## The finding: no UniFi dictionary, on the same grounds as Meraki

Ubiquiti is two worlds and only one of them has a capture path.

**UniFi devices (APs, switches, gateways) are configured by a controller and export no
text configuration a person pastes.** Checked 2026-09-19, egress to every vendor and
community domain tried blocked (`EGRESS_BLOCKED` on the CONNECT — the same constraint
this session's catalogue files record in full); the finding rests on web-search
synthesis, corroborated across independent listings, per CLAUDE.md rule 1:

- **The site backup (`.unf`)** is an AES-128-CBC-encrypted archive. Decrypted, it holds a
  compressed MongoDB (or PostgreSQL, on newer controllers) dump in BSON — a database
  export, not a text file a person reads or copies. Two independent sources, both read
  2026-09-19: the `unifi_extract` tool's own README (github.com/EvilBit-Labs/unifi_extract
  — "Decrypt and explore UniFi backup files … entirely offline") and a UI Community thread
  on the `.unf` format (`unf controller backup file format`, community.ui.com), which
  agree on the AES-encrypted-ZIP-of-a-database-dump shape.
- **No documented, human-readable export of switch port profiles or networks exists.**
  What does exist is an *undocumented* REST endpoint (`/api/s/{site}/rest/portconf`) that
  a script can call against an authenticated controller session, and `mca-ctrl -t
  dump-cfg`, a device-local diagnostic command that dumps ONE adopted device's own JSON
  state — neither is a vendor-documented CLI a person runs and copies text from. Read
  2026-09-19 via web-search synthesis of the `unifi-controller-api` Python client's own
  docs and a UniFi Community wiki API page, both independent of each other and of the
  backup-format sources above.

This is the Cisco Meraki finding again, for the same underlying reason
(`schema/platforms.yaml`'s own comment on Meraki): **there is nothing for a human to
copy**, so under invariant 2 there is nothing Fathom can ingest for UniFi. `ubiquiti` is
registered as a vendor above (the hardware-catalogue namespace needs it — three UniFi
faceplates live in `corpus/catalogue/ubiquiti/`), and no `unifi` platform row exists in
`schema/platforms.yaml`, deliberately, on the same precedent Meraki and Ciena already set.

**Therefore: a future UniFi dictionary is not a `corpus/dict/unifi/` waiting to be
written from a guess about JSON shape.** If an operator's own encrypted `.unf` backup is
ever a supported input, that is a different feature — an authenticated-decrypt-and-parse
path, not a paste-box dictionary — and needs its own design and its own security review
before any dictionary entry is written against it. Nothing here should be read as
scaffolding for that; it is the reason the scaffolding does not exist yet.

## EdgeOS is the other world, and does have a capture path

EdgeRouter / EdgeMAX devices run **EdgeOS**, a Vyatta fork (Vyatta Core 6.3 lineage — two
independent sources, read 2026-09-19: a GitHub-hosted EdgeOS configuration notes page and
a UniFi/EdgeRouter community wiki page, both naming the Vyatta ancestry). EdgeOS prints
its running configuration in **two** formats from the CLI, and only one of them is
ingestable by this project's current core:

- **`show configuration commands`** — the running config as flat, verb-initial
  statements, `set <path…> <value>`, restating the full path on every line. This is the
  same shape Junos's `display set` produces, and `corpus/dict/edgeos/` is built against
  it. Two independent sources, read 2026-09-19: NetworkJutsu's "EdgeOS CLI Introduction"
  and a `williehowe.com` walkthrough of the command, both describing the flat,
  copy-pasteable `set …` output this command produces (title/summary read via web-search
  synthesis; direct fetch blocked).
- **`show configuration`** (no `commands`) — a nested, curly-brace tree (`interfaces {
  ethernet eth0 { address … } }`), the Vyatta "human-readable" form. **This project's
  ingest core cannot read it.** `crates/fathom-ingest/src/shape.rs`'s shaper requires
  every statement line to open with one of twelve config-mode verbs (`VERBS`, `set` being
  the only one that binds) and treats the FULL line as one path; there is no bracket-
  nesting state carried between lines, so a bare `ethernet eth0 {` fails `NotVerbInitial`
  and every line inside the block is read with no idea which stanza it is nested in. What
  the core would need to read this format: a frame/shape stage that tracks `{`/`}`
  nesting depth across lines and accumulates the enclosing path the way the flat `set`
  form already states it on one line — a change to `fathom-ingest`'s Rust, not a data
  pack, and out of an engine contribution's reach under ADR-0044 rule 1. Not attempted
  here.

`corpus/dict/edgeos/` therefore reads `show configuration commands` output only. A paste
of the nested `show configuration` form will fail to shape (mostly `NotVerbInitial`),
which is the safe failure mode — Unshaped lines are still gated (`shape.rs`'s `noise`
sweep) so a credential on such a line is still destroyed, it is simply never bound into
the graph.
