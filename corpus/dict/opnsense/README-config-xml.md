# `config.xml` — what it carries, what would bind it, and what the core needs to read it

> **Status:** written 2026-09-19, data not code (ADR-0044 §2 rule 1). This file exists so the
> next session can build an XML framer without repeating this survey. Nothing here is a
> dictionary entry — there is no XML reader yet (§4), so nothing here can be tested against a
> real capture, and every field-to-kind mapping below is a **proposal**, marked as such.

## 0. What this is, restated from `README.md` §6

OPNsense's full configuration is one plain-text XML file, `/conf/config.xml` on the box,
retrievable whole through System → Configuration → Backups (`raw.githubusercontent.com/
opnsense/docs/master/source/manual/backups.rst`, read 2026-09-19: a download button, an
optional password, optional RRD statistics folded into the same file). `schema/platforms.yaml`
already declares the OPNsense platform on exactly this basis — *"whole config is one plain XML
file, /conf/config.xml … Read at opnsense/core commit ae0088be, 2026-08-09"* — so this is not a
new finding; it is the first time anyone has gone through the file section by section.

**`crates/fathom-ingest` cannot read it today.** `frame.rs` and `csv.rs`, read this session:
the pipeline reads line-shaped `set`-form text and delimiter-separated tables. There is no XML
front end. §4 states what one would need.

## 1. Confirmed sections, read directly this session

`raw.githubusercontent.com/opnsense/core/master/src/etc/config.xml.sample` (2026-09-19) is the
shipped **default-install** template — an unconfigured box, so it does not exercise every
plugin-carried section, but it fixes the base ones beyond doubt:

```
<opnsense>
  <system>          -- hostname, domain, timezone, webgui, <group>, <user>, ssh, ...
  <interfaces>       -- physical/vlan/etc interface assignments
  <dnsmasq> / <unbound>
  <nat>
  <filter>           -- the same rule data the CSV export flattens (README.md §5)
  <rrd>
  <ntpd>
  <OPNsense>          -- namespace root for plugin-carried model data, e.g. netsnmp (below)
```

`<system><user>` carries `name`, `descr`, `scope`, `groupname`, `password`, `uid` — `password`
holds a **hash**, not plaintext (`config.xml.sample`, same read; a second source, a GitHub
issue thread on password import behaviour, corroborates the field name `password` rather than
pfSense's `bcrypt-hash`, read via search synthesis 2026-09-19 — noted as synthesis because the
issue thread itself was not fetched directly, only summarised by search).

**Sections named in the work order but not present in an unconfigured install's template — real,
but not directly observed this session, and said as such rather than guessed:** `vlans`,
`gateways`, `staticroutes`, `dhcpd`, `openvpn`, `ipsec`. OPNsense is pfSense-lineage software
(both descend from m0n0wall's config format) and every community migration guide describes
these as real top-level `config.xml` sections that appear once the corresponding feature is
configured — but no guide fetched this session is a primary vendor source for the tag names, so
they are **could not establish directly**, carried here only as the names the work order itself
used, pending a real capture.

**Plugin-carried sections, confirmed by reading the plugin's own model, not the base file** —
this is the mechanism, not a guess about naming:

| Section (proposed root path) | Confirmed by | Read |
|---|---|---|
| `ipsec` — pre-shared keys, key pairs | `raw.githubusercontent.com/opnsense/core/master/src/opnsense/mvc/app/models/OPNsense/IPsec/IPsec.xml` — fields `Key` (a `PreSharedKey`'s secret), `keyType`, `ident`, `remote_ident`, `privateKey` (a `KeyPair`'s private key material) | 2026-09-19 |
| `openvpn` — TLS/static keys | `raw.githubusercontent.com/opnsense/core/master/src/opnsense/mvc/app/models/OPNsense/OpenVPN/OpenVPN.xml` — `tls_key` (relation to a `StaticKeys` list), `StaticKey.key` (the key material itself, `TextField`), `mode` (auth/crypt), `auth-gen-token-secret` | 2026-09-19 |
| `OPNsense.netsnmp.general.community` — the SNMP community string (**not** a base `snmpd` section; the work order's guess at the tag name was corrected by reading the real one**) | `raw.githubusercontent.com/opnsense/plugins/master/net-mgmt/net-snmp/src/opnsense/service/templates/OPNsense/Netsnmp/snmpd.conf` (`rocommunity {{ OPNsense.netsnmp.general.community }}`) and `.../models/OPNsense/Netsnmp/General.xml` (`<community type="StrictTextField"/>`, no length constraint declared) | 2026-09-19 |

**WireGuard — could not establish the exact field name this session.** The model file the
naming convention above predicts (`.../models/OPNsense/Wireguard/General/General.xml`, note
the vendor's own lower-case `Wireguard`, confirmed from a real 404 against the upper-case guess
and a second search hit naming a sibling `Wireguard/Menu/Menu.xml`) returned 404 through the
proxy. Every setup guide corroborates that a private key field exists per server and per peer
and is either operator-entered or auto-generated — at least three independent guides agree on
this, none a primary vendor source for the raw tag — so **a WireGuard private key field is
real; its exact XML tag is not established here** and needs one more direct read.

## 2. Which kinds each proposed section would bind — a proposal, not an entry

None of this is buildable without §4's framer, so nothing below is a dictionary path; it is
the mapping the next session would write once one exists, following `README.md` §4's own
finding that `AddressValue`, `L4Spec`, `PolicyScope`, `NatScope` and `NatAction` are still
empty structs — so `interfaces`, `filter`/NAT matches, and IPsec/OpenVPN *tunnel* topology
hit the same wall the rules CSV already hit, for the same reason, and would land on the
residue list the same way.

| Section | Proposed kind | Blocked by |
|---|---|---|
| `system.hostname`/`domain` | `Device.name` / a DNS suffix fact | nothing — buildable now |
| `interfaces.<if>` (name, IP, subnet) | `Interface` fields | the address types, same as the CSV path |
| `filter` (the same rules the CSV export flattens) | `SecurityPolicy` | README.md §4's empty-struct finding, identically |
| `ipsec` | `SecurityAssociation`/tunnel kinds, if the schema has one — **not checked this session** | needs a schema read the work order did not ask for |
| `openvpn` | a VPN-server/client kind — **not checked this session** | same |
| `OPNsense.netsnmp.general` | an SNMP-config fact on `Device`, if one exists — **not checked** | same |

## 3. Credential fields to destroy — the redaction gate's table for this platform, stated once

Every field below must never reach a stored fact, a log, or a reply, the moment an XML framer
exists. This is the list the dictionary's `secret:`/`secret_pos` machinery
(`crates/fathom-ingest/src/dict.rs`, read this session for the CSV entries) would need per path:

| Field (proposed XML path) | What it is | Source, read |
|---|---|---|
| `system.user.password` | a **hash** of the local admin/user password, not plaintext, but a hash is still a credential the gate must destroy — cracking is an offline attack against exactly this string | `config.xml.sample` |
| `OPNsense.IPsec.preSharedKeys.*.Key` | an IPsec pre-shared key, plaintext | `IPsec.xml` model |
| `OPNsense.IPsec.keyPairs.*.privateKey` | an X.509 private key, plaintext | `IPsec.xml` model |
| `OPNsense.OpenVPN.StaticKeys.*.key` | an OpenVPN TLS static/auth key, plaintext | `OpenVPN.xml` model |
| `OPNsense.OpenVPN.Instances.*.auth-gen-token-secret` | a generated-token signing secret | `OpenVPN.xml` model |
| `OPNsense.netsnmp.general.community` | the SNMP community string — read access to every OID on the box | `snmpd.conf` template + `General.xml` model |
| WireGuard private key (exact path **could not establish**, §1) | a WireGuard interface's private key, plaintext | corroborated, not confirmed |

**Two the work order named that this session did not confirm a field for:** `system.user`
carries no separate "password hashes, plural" list beyond the one `password` field per user —
restated correctly above rather than left as the work order's looser phrasing. `snmpd` as a
section name is **wrong**; corrected to `OPNsense.netsnmp.general` above, with the citation
that corrects it.

## 4. What the core needs to read XML — argued through the gate, ADR-0044 §2 rule 1

An XML framer is new code in `fathom-ingest`, not new data, so it is not something this dict
builder's session may add — it is a contribution to the core, same standing as `csv.rs` itself,
and ADR-0044 §2 rule 1 is explicit that an engine (this pack) may declare no code. This section
is the argument the next session that *does* own `fathom-ingest` core would need to make, so
that it does not have to re-derive it:

1. **A fourth front end beside `set`-line and CSV, same shape as `csv.rs`'s own argument
   (README.md §2, restated here):** a cell's meaning there was `(row identity, column name,
   value)`, all three real bytes of the file. An XML element's meaning is analogous —
   `(element path from the document root, the element or attribute name, the text or attribute
   value)` — and the same three things are real bytes of the operator's file. One statement
   synthesised per leaf value, exactly as `csv.rs` synthesises one per cell, keeps every
   downstream stage — dictionary trie, redaction gate, binder, deferred-edge resolver, ledger,
   residue list — unmodified, which is the whole reason the CSV front end could be a front end
   rather than a second parser, and the same reasoning applies unchanged.
2. **What existing `ByteSpan`/ledger machinery this reuses, and what is new:** reuse — the
   `LineLedger`/`LedgerEntry`/`ResidueEntry` types and the redaction `Edit`/gate pass, all of
   which operate on byte spans into the capture and know nothing about CSV or Junos syntax
   specifically. New — an XML tokeniser/path-walker to replace `frame.rs`'s physical-line
   splitter and `csv.rs`'s cell splitter, and a decision about what "one logical line" means
   for XML (candidate: one per leaf element/attribute, mirroring the CSV cell choice) so that
   `LineOrdinal` and the ledger's one-entry-per-line contract keep meaning what they mean.
   `14`'s six stages are frame → lex → shape → redact → bind → resolve; an XML framer would
   need its own frame+lex+shape (structurally different from both existing front ends, since
   XML nests arbitrarily where CSV does not) but could hand off to the *same* redact/bind/
   resolve stages `csv.rs` already hands off to, which is most of the pipeline.
3. **No new crate.** `14`'s dependency ceiling (ADR-0044 §2 rule 1, "the dependency ceiling is
   therefore untouched by any number of engines") means this needs a hand-rolled XML tokeniser
   at the same trust level as the hand-rolled `lex.rs`/`csv.rs` already in the crate, not a
   third-party XML library — the same posture that kept `csv.rs` dependency-free.
4. **The password-hash question needs an owner decision before it needs code.** `system.user.
   password` is a hash, not the plaintext a person typed. Whether the gate destroys a hash the
   same as a plaintext secret (this session's view: yes — a hash is still crackable and the
   product's stated posture is "credentials never arrive," not "credentials arrive hashed") is
   worth one explicit ADR line rather than an implementer's silent choice, because it is the
   first credential-shaped value this project would read that is not, itself, the live secret.

## Sources consulted

Listed once, in `README.md` §6/§7's combined source list, so this file does not carry a second
copy that could drift from the first.
