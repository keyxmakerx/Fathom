# README-omada-sw.md — how a TP-Link switch's config text is read

**Status:** Written 2026-10-16 with `crates/fathom-ingest/src/blockcfg.rs`. The dictionary is
`corpus/dict/omada-sw/config.yaml`; the platform row is `omada-sw` (vendor `tp-link`) in
`schema/platforms.yaml`. Every source below was read on 2026-10-16.

## What is read

The config text of a TP-Link JetStream (T-series) or Omada (SG-series) managed switch, pasted from
`show running-config` or from the file the web UI's Export Config saves. TP-Link pairs that GUI step
with `copy startup-config tftp`, so the export is the startup config
(tp-link.com/us/configuration-guides/managing_system, configurationId 18918).

Two real configs, posted by their owners, set the shape and are the test fixtures in
`crates/fathom-ingest/tests/omada_sw.rs`:

- a T2600G-28TS V3, 2020-01-09 (community.tp-link.com/en/business/forum/topic/184910, page 2);
- a T1700G-28TQ Rev2, firmware 2.0.1 Build 20180206, 2018-12-10, introduced as "Actual Config.cfg"
  (community.tp-link.com/en/home/forum/topic/150823).

What they show: the first line is `!` and the model in one word; bare `#` lines separate sections, many
empty; strings are double-quoted (`name "ISPLAN"`, `hostname "SW_ALIANCA00"`); blocks open with
`vlan N` or `interface gigabitEthernet 1/0/N`, `interface ten-gigabitEthernet 1/0/N`, `interface vlan N`;
the first ends with `end` and the export does not.

### Indentation

**Unestablished.** Both posts lost their leading whitespace on the way to the page, so whether lines
under an opener are indented is not known. The reader never reads indentation: a block ends at a
separator (`#`, `!…`, `end`, `exit`) or the next opener.

## The sniff

After blank lines, a switch prompt (`T2600G-28TS#`, matched the way oxidized's TP-Link model matches
it, `lib/oxidized/model/tplink.rb` on master) and an echoed `show running-config`, the first line must
be `!` plus one word, and a later line must be a bare `#`. Cisco's bare `!` and Ubiquiti's
`!Current Configuration:` fail it.

The Omada controller's backup shares the `.cfg` extension but is "encrypted and compressed"
(support.omadanetworks.com/sa/document/13008, page dated 07-22-2026). No sample of it was found; that
compressed, encrypted bytes open with `!<model>` and carry a bare `#` line is reasoned to be unlikely,
and a paste that binds nothing is refused as not understood.

## What binds

| Paste | Binds |
|---|---|
| `hostname "x"` | the device's `hostname` |
| `vlan N` | a `Vlan` with that id |
| `name "x"` under it | the VLAN's `name` |
| `interface <type> <number>` | an `Interface`, named as one word: `gigabitEthernet1/0/1`, `vlan30` |
| `description "x"` under it | its `description` |
| `shutdown` under it | `admin_up: false` (a port without it is not read as up) |

## Secrets

TP-Link's own guides (Managing System §3.2, Configuring AAA, Configuring SNMP & RMON on
tp-link.com/configuration-guides; the TL-SG3428 CLI Reference Guide pp. 46-54 via manualowl.com) give
these credential lines:

- `user name N [privilege …] password {[0] P | 7 E}` and `… secret {[0] P | 5 E}`
- `enable [admin] password …` and `enable [admin] secret …`
- `snmp-server community NAME read-only|read-write` (the community, printed in clear)
- `snmp-server user … cpwd X … epwd Y`
- `snmp-server host IP PORT NAME …` (the community, for v1 and v2c)
- `radius-server host … key {[0] S | 7 E}` and `tacacs-server host … key …`

Type `7` is "symmetric encrypted", so reversible, and no public description of it was found. One real
export printed `secret` followed by a value with no type digit, and the values the fetch reported held
characters outside md5-crypt's alphabet. So the rule assumes nothing about what follows:

- **After the first credential keyword on a line, the rest of the line is one segment, destroyed
  whatever any detector says.** For `snmp-server host`, the rest after the address. A keyword inside
  quotes is a value, not a keyword.
- **A command typed at a prompt** (`T2600G-28TS(config)#snmp-server host … pr1vate …`) is never read as
  config, but the same rule applies to it: the typed value is in clear.
- **Any line of 79 characters or more** may have been hard-wrapped by the terminal. The line after it is
  destroyed whole, whatever it looks like, when the long line holds a credential keyword or the two read
  together would (a keyword split at the break, `passw` / `ord`). A destroyed line that long carries the
  rule to the next. Found by an adversarial check on 2026-10-25: a value wrapped onto a third line, a
  keyword ending at column 80, a keyword split by the break, and a tail starting with `!` or an opener's
  word all kept part of a credential before.
- **Words are split on any whitespace and any control character**, and ANSI escape codes are skipped, so
  a no-break space from a web page or a pager's backspaces in a session log do not hide a keyword.
- **Every line is swept**, shaped or not, before anything is stored.

The tests hold values at TP-Link's limits: a user password of 6 to 31 characters (TP-Link's own example,
`password 0 admin`, included), an SNMP community of 1 to 16, `cpwd`/`epwd` of 1 to 16, a RADIUS or
TACACS+ key of at most 31.

**oxidized is not a reference here.** Its TP-Link `:secret` block, run against these lines, leaves
`password 0 admin`, `password 7 …`, `cpwd`/`epwd`, the `snmp-server host` community and both server keys
in place, and turns `enable password 0 abc123` into `enable password <secret hidden> abc123`.

## Not bound yet

They are residue, not lost:

- Addresses. `ip address A M` gives a dotted mask, and an `Address` needs the address and prefix as one
  value (the same gap `README-pfsense.md` records).
- VLAN membership (`switchport general allowed vlan …`, `switchport pvid N`). The schema's `VlanMember`
  edge resolves a VLAN by name, and these lines give its number.
- The model in the first line, routes, DHCP pools, SNMP, NTP and logging lines.

## Open

- Whether lines under an opener are indented.
- Whether the CLI hard-wraps long lines, and at what width. The real `radius-server … key` and
  `snmp-server user … epwd` lines run past 90 characters.
- The real alphabet and length of type 5 and type 7 values.
- The syntax of `user name … algorithm-type` in the May 2026 CLI guide (document 4943 on
  support.omadanetworks.com, model list not readable through the fetch tool).
- Whether `ip ssh` or `ip http secure-server` key material is ever printed in the config.
