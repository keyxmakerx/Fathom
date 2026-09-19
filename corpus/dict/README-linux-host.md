# README-linux-host.md — why `corpus/dict/linux-host/` binds nothing today, data not code

**Status:** Recorded 2026-09-19, in the manner of `corpus/dict/README-ubiquiti.md` beside it
(conventions §*Precedence* — this is the one place this finding is recorded; the file header in
`corpus/dict/linux-host/interfaces.yaml` points here rather than restating it).

## What was asked and what was checked

The brief: a `linux-host` dictionary reading what a Linux host prints about its own network,
pasted as text — the output of `ip -d link show`, `ip -4 -6 addr show`, `ip route show`, and
`bridge vlan show`. Before writing a single dictionary entry, `crates/fathom-ingest/src/frame.rs`
and `crates/fathom-ingest/src/shape.rs` were read, per the instruction that shaped this file.

**Finding: none of the four commands' output can be shaped by the ingest core as it exists
today, and therefore no dictionary entry — however it is written — can ever bind against it.**
This is a core limitation, not a missing dictionary file, and the reasoning is exact enough to
act on rather than merely observe.

## The two shapes the core reads, and why `ip`/`bridge` output is neither

`crates/fathom-ingest`'s six-stage pipeline (`14`) has exactly two front ends into the shared
frame → lex → shape → redact → bind → resolve machinery:

1. **The `set`-verb-initial line grammar** (`shape.rs`'s `shape()`), which every platform this
   project reads today uses — junos-srx, opnsense's own token grammar (see below), edgeos. A
   *statement* is the words on one line, and the very first word must be one of exactly twelve
   verbs (`shape::VERBS`: `set`, `deactivate`, `delete`, `activate`, `annotate`, `insert`,
   `rename`, `copy`, `protect`, `unprotect`, `wildcard`, `replace:`), of which only `set` binds.
   Any line whose first token is not one of these twelve fails at
   `ShapeError::NotVerbInitial` before a single dictionary entry is even consulted — the check
   happens in `shape()` itself, ahead of the trie walk in `dict.rs`.
2. **The OPNsense firewall-rules CSV front end** (`crates/fathom-ingest/src/csv.rs`), which is
   not a general table reader: `looks_like_rules_csv` sniffs for a first line beginning
   `@uuid` followed by `;` or `,`, and the module's own header states plainly what it is —
   *"It does not read … any other CSV"*. It is a purpose-built reader for one OPNsense export,
   not a generic tabular front end a new platform can opt into.

`ip -d link show`, `ip -4 -6 addr show`, `ip route show` and `bridge vlan show` all produce a
third shape neither front end reads: **numbered, indented multi-line records**, where a header
line names an object and one or more indented continuation lines (or, for `bridge vlan show`, a
whitespace-column table with no `@uuid`-shaped header) carry its attributes. Concretely, citing
the manual pages read 2026-09-19 (`man7.org/linux/man-pages/man8/ip-link.8.html`,
`man7.org/linux/man-pages/man8/bridge.8.html`, both corroborated by a second independent listing
— `baturin.org/docs/iproute2/` and the Debian manpages mirror of `bridge(8)` — per CLAUDE.md
rule 1):

```
2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc mq state UP mode DEFAULT group default qlen 1000
    link/ether 52:54:00:12:34:56 brd ff:ff:ff:ff:ff:ff
    inet 192.0.2.10/24 brd 192.0.2.255 scope global eth0
```

The first token of the header line is `2:` (an interface index, not a verb); the first token of
every continuation line is a vendor-neutral attribute word (`link/ether`, `inet`, `brd`) that is
likewise never one of the twelve verbs. `ip route show`'s lines open with a prefix or the literal
word `default`; `bridge vlan show`'s table opens with a port name, not `@uuid`. **Every line
from all four commands fails `NotVerbInitial` and is not sniffed by `looks_like_rules_csv`
either** — there is no path from either existing front end to a bound fact.

This was checked, not assumed: `shape()`'s verb check runs unconditionally, before the dictionary
is consulted, so no amount of cleverness in `corpus/dict/linux-host/*.yaml` can route around it —
per ADR-0044 rule 1, an engine is data, and data cannot teach the shaper a third grammar.

## What the core would need

A third front end, built the same way `csv.rs` is: a *synthesiser*, not a new grammar bolted onto
`shape.rs`. `csv.rs`'s own header names the reusable insight — *"a cell's meaning is `(the row's
identity, the column's name, the cell's value)`, and all three of those are real bytes of the
operator's file"* — and the same move works here: an interface record's meaning is `(the
interface name, the attribute word, the attribute's value)`, all three real bytes of the paste.
Concretely, the core would need:

- A record-boundary reader that groups a header line (`N: name: <flags> ...`) with the indented
  lines under it into one record, the way `csv.rs` groups a header row with the data rows under
  it — indentation depth as the grouping signal instead of a blank line or a repeated `@uuid`
  column.
- A second, narrower reader for `bridge vlan show`'s column-aligned table (port, vlan-id, flags),
  which is tabular but not CSV-delimited and has no `@uuid` to sniff — closer to `csv.rs`'s shape
  than to `shape.rs`'s, but with whitespace runs as the delimiter and a header row Fathom would
  have to recognise by its literal column names (`port`, `vlan-id`) rather than by a fixed prefix.
- Both would synthesise statements the same way `csv.rs` does — one per `(record, attribute)`
  pair, spans slicing back into the real paste — so that everything downstream of the synthesis
  point (the dictionary trie, the redaction gate, the binder, the ledger) is unmodified, exactly
  as `csv.rs`'s own module doc argues for its one format.

This is new Rust in `fathom-ingest`, not a data pack: per ADR-0044 rule 1 an engine "contains no
executable content… If a vendor needs logic the data format cannot express, that logic is a
contribution to the core, argued through the dependency gate like everything else." It is
therefore out of an engine contribution's reach, and out of this task's scope (no new crates, no
core Rust changes assigned to this builder). **Not attempted here.**

## What was built instead — "the half that can be read"

There is no subset of these four commands' output that the current core binds — the verb check
is unconditional and every line from every one of the four commands fails it. So
`corpus/dict/linux-host/interfaces.yaml` declares the platform and carries **zero entries**: an
honest scaffold for the day the record-shaped front end above exists, not a dictionary that
pretends to bind. Writing entries with paths that could never be reached by `shape()` would be
scaffolding that looks tested and is not — the UniFi precedent this file is modelled on
(`README-ubiquiti.md`) made the same call for the same reason: *"nothing here should be read as
scaffolding for that; it is the reason the scaffolding does not exist yet."*

**The redaction gate still runs, and this matters.** `crates/fathom-ingest/src/lib.rs`'s
`ingest()` hands `redact::gate` both `shaped.unshaped` and `shaped.noise` — every line that
failed to shape is still swept by the shape-based detectors (`long_hex`, `base64ish`,
`crypt_prefix`, `key=value` against `SECRET_WORD_LIST`) regardless of whether any dictionary
entry ever names it. A WireGuard private key — 44 base64 characters, 32 raw bytes padded to a
multiple of 4 (confirmed 2026-09-19 via `man7.org`'s WireGuard references and corroborated
independently by the `WireGuard/wireguard-vyatta-ubnt` project's own key-validation issue #138,
both stating the same 44-character/32-byte shape) — trips `base64ish`
(`crates/fathom-ingest/src/redact.rs`'s `base64ish`, which requires 24+ characters of base64
alphabet) on any pasted line, bound or not. `crates/fathom-ingest/tests/linux_host.rs` is the
proof: the synthetic capture's interface/route/VLAN lines all land `Unshaped` with reason
`NotVerbInitial` and zero nodes bind, while a `wg showconf`-style `PrivateKey = <44 chars>` line
pasted alongside them is destroyed all the same.

## Where this leaves `schema/platforms.yaml`

`linux` is registered in the `vendors:` block, vendor-only — named because
`corpus/dict/linux-host/` and `corpus/explainers/linux-*-basics.yaml` both exist and need the
namespace, on the same precedent Ciena and Sodola already set: **a vendor is registered when
someone names it; a platform is declared only when a real config has been seen AND the core can
read it.** No `linux-host` row exists in the `platforms:` block, because the second half of that
test fails today, for the reasons above.
