# README-routeros.md — what `corpus/dict/routeros/` reads, and the sources

**Status:** written 2026-10-10 for the round 15 sign-off ("paste reads home-lab gear", mockup
r15-f2). Every vendor fact below names its source and the date it was read. The MikroTik pages
were read through a summarising fetch (direct fetches were refused by the proxy), so a quoted
excerpt should be re-checked against the page before it is relied on for anything new.

## What is read

A RouterOS `/export` (v6 and v7), pasted as text. The reader is
`crates/fathom-ingest/src/routeros.rs`, a front end of its own in the way `csv.rs` is: the
set-form shaper never sees an export. The wasm shell picks it by an exact sniff
(`looks_like_routeros`) or when the paste names `routeros`.

| Export feature | Source (read 2026-10-10) |
|---|---|
| v6 header `# may/31/2024 22:36:40 by RouterOS 6.48.1`, then `# software id`, `# model`, `# serial number` | a 6.48.1 export attached on forum.mikrotik.com (data-discourse.cdn.mikrotik.com/original/3X/c/d/cdcc6bec79d70eeba7032eb86fbdddb11edf01eb.txt) |
| v7 header `# 2024-01-06 21:58:35 by RouterOS 7.12.1`; ISO dates since 7.10 | forum.mikrotik.com/t/mikrotik-rb750gr3-fasttrack-and-wireguard-issue/172668; 7.10 release thread forum.mikrotik.com/t/v7-10-7-10-1-and-more-stable-are-released/167423 |
| Long lines wrap with a trailing `\` and a 4-space indent, inside strings too (`…\r\` / `    \n…`) | forum.mikrotik.com/t/winbox-export-whitespace-bug/171178; oxidized's RouterOS model joins `/\\\r?\n\s+/` (github.com/ytti/oxidized, lib/oxidized/model/routeros.rb) |
| A wrap can leave the value alone on the next line (`public-key=\` / `    "…="`) | the 7.12.1 export above; `client-id=\` in the 6.48.1 export above |
| A terminal copy can cut a line mid-word with no backslash | forum.mikrotik.com/t/winbox-export-whitespace-bug/171178 |
| String escapes `\"` `\\` `\n` `\r` `\t` `\$` `\_` `\a` `\b` `\f` `\v` and hex `\xx`; `\?` removed in 7.1rc2 | help.mikrotik.com/docs/spaces/ROS/pages/47579229/Scripting |
| v7 Wi-Fi writes dotted names and a leading-dot shorthand (`security.authentication-types=… .passphrase=…`) | forum.mikrotik.com/t/default-wifi-settings-on-hap-ax2/271802 |

The indentation after a wrap is dropped. That is reasoned from the excerpts, not stated by
MikroTik: the Scripting page says only that a backslash continues string literals.

## Why secrets are destroyed by name

RouterOS's own hiding is not relied on, in either direction:

- v6 `/export` prints secrets by default (a 6.48.7 export printing `mschapv2-password`,
  forum.mikrotik.com/t/ask-upgrade-mikrotik-ac2-v6-to-mikrotik-ax2-v7/168039).
- v7 hides sensitive values by default and drops them with no placeholder
  (help.mikrotik.com/docs/spaces/ROS/pages/328155/Configuration+Management;
  forum.mikrotik.com/t/v7-8-seems-not-to-export-wpa2-pre-shared-key/164923), but `show-sensitive`
  prints them, and the hiding has had gaps: `/ip cloud back-to-home-user private-key` until
  7.21rc5 / 7.20.7 (forum.mikrotik.com/t/critical-flaw-with-hide-sensitive-config-export/267287),
  the IoT MQTT password (forum.mikrotik.com/t/iot-mqtt-shows-the-password-on-export/175639).
- The SNMP v1/v2c community's `name` is the community string
  (help.mikrotik.com/docs/spaces/ROS/pages/8978519/SNMP) and is not on MikroTik's sensitive list,
  so it is printed even with hiding on.

`secrets.yaml` lists the names from MikroTik's "List of menus with sensitive parameters"
(manual.mikrotik.com/docs/getting-started/configuration-management/list-of-menus-with-sensitive-parameters)
that a home lab is likely to carry, with their labels. Most are also caught by the gate's
secret-word floor (`password`, `secret`, `key`, `passphrase` as a component); the entries add
the label and a second detector. The ones the floor cannot see are there so they are caught at
all: `pin` (LTE, PPP client), `cak` (MACsec), `identity` (ZeroTier) and `sim-pin`.

### Scripts

A script body (`/system script source=`, `/system scheduler on-event=`, `/tool netwatch
up-script=`/`down-script=`) can hold any credential, in any spelling, and RouterOS never hides
one (forum.mikrotik.com/t/edit-disregard-was-using-on-beta-firmware/151378). **The default here
is that the whole body is destroyed.** The alternative, reading the commands inside a script,
is a sign-off question, not a default. Any other value with words, `=` or `:` in it also goes to
the gate's safety-net sweep, which quarantines its line if it trips.

## What is bound

Interfaces (ethernet by name or default name, bridge, bridge port members, VLAN, WireGuard),
their comments and `disabled=yes`, VLANs (name and id), addresses, and the hostname from
`/system identity`. The menu layout, comments and every line not bound are on the residue list.

### Units

RouterOS puts an address on the interface itself, with no unit number. `schema/schema.yaml` owns
`Address` by `LogicalUnit`, whose `index` is required, so `ip.address` binds a keyless unit with
index 0 (`const_enum: "u32.0"`). This is a stated constant, the same one for every RouterOS
interface, not a number read from the paste.

## Not bound yet

The header's version and model (no `OsVersion` value type in `dict.rs` yet), bridge membership
and VLAN filtering (no schema field), DHCP, firewall rules, routes. They are residue, not lost.
