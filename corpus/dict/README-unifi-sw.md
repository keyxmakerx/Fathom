# README-unifi-sw.md — how a UniFi switch's config text is read

**Status:** Written 2026-10-25 with the `UNIFI` dialect of `crates/fathom-ingest/src/blockcfg.rs`, on the
owner's sign-off r27-unifi ("build on the EdgeSwitch syntax now, marked unverified, and ask for a
capture"). The dictionary is `corpus/dict/unifi-sw/config.yaml`; the platform row is `unifi-sw` (vendor
`ubiquiti`) in `schema/platforms.yaml`. Sources were read on 2026-10-16.

**Unverified.** No complete real UniFi `show running-config` was found. What is real UniFi output is
named below; everything else is the EdgeSwitch CLI's syntax, which UniFi's switch CLI is said to be
(oxidized issue 1003: "Essentially they run EdgeSwitch"). One sanitised capture from a real switch
would settle it.

## What is read

A UniFi switch's `show running-config`, pasted as text, usually with the session that produced it:

```
US.v3.8.6# telnet localhost
(UBNT) >enable
(UBNT) #show run
!Current Configuration:
!
!System Description "USW-48P-500,, Linux 3.6.5"
```

That session and header are real (a USW-48P-500, jcutrer.com, "unifi switch cli config ssh", undated).
So are an interface block (`interface 0/1-0/X`, `switchport mode trunk`, `vlan participation include …`;
a dan.langille.org reader comment, 2020-11-04) and the closing `exit` and `(UBNT) #quit` (oxidized issue
1003, 2017-08-30). The path is SSH, then `telnet localhost` and `enable` on US-series and some USW
models, `cli` on others (Ubiquiti help article 204959834; a ubiquiti-networks-forum.de
wiki page). Some newer models have no telnet at all, and whether their `cli` prints this syntax is
unestablished.

### The shape

From Broadcom EFOS's real output (ytti/oxidized spec data `efos#BES-53248_3.12.0.1`), which shares the
header: nothing is indented, every block closes with `exit`, the VLAN table sits under `vlan database`
(`vlan 10,103`, `vlan name 100 "test vlan"`), and the body is wrapped in `configure` … `exit`.

`vlan` is not a block opener in this dialect, unlike TP-Link's: inside an interface it starts lines
such as `vlan pvid 20`.

## The sniff

`!Current Configuration:` must appear, and in the `!` header after it a `!System Description "US…` line,
which is the UniFi model. EdgeSwitch prints `EdgeSwitch …` there and EFOS prints `EFOS, …`, so neither
passes. Whatever comes before the header is skipped.

## What binds

| Paste | Binds |
|---|---|
| `hostname "x"` | the device's `hostname` |
| `vlan name N "x"` under `vlan database` | a `Vlan` with that id and name |
| `interface 0/1` | an `Interface` named `0/1` |
| `description "x"` under it | its `description` |
| `shutdown` under it | `admin_up: false` |

## Secrets

The EdgeSwitch CLI Command Reference (help.uisp.com article 22591720570135; manualslib 858408) gives:

- `username "u" password V [level L] [encrypted]`. The value comes after `password`, and `encrypted` is a
  trailing flag.
- `enable password V [encrypted]`, and `password V [encrypted]` under `line console|telnet|ssh`.
- `snmp-server community "V" ro|rw|su`, printed in clear (EFOS output); `snmp-server community-group`;
  the community in `snmp-server host`.
- `snmp-server user u g auth-md5|auth-sha pw | auth-md5-key|auth-sha-key k [priv-des pw | priv-des-key k]`.
- `radius server key auth|acct <host> encrypted V`, `tacacs-server key [encrypted] V`,
  `tacacs-server keystring V`.
- `service unms key V`, the UISP enrolment key.

The `encrypted` value is 128 hexadecimal characters. Its documented purpose is to "transfer local user
passwords between devices without having to know the passwords", so it logs in as that user on another
switch and is destroyed like a password.

The rule is TP-Link's (`README-omada-sw.md`): after the first credential keyword on a line the rest of
the line is destroyed whatever any detector says, `snmp-server host` loses everything after its address,
a command typed at the prompt gets the same rule, the line after a credential line of 79 characters or
more is destroyed whole, and every line is swept. EdgeSwitch's pager (`--More-- or (q)uit`) is cut off
the front of a line before it is read.

The tests (`crates/fathom-ingest/tests/unifi_sw.rs`) hold values at the reference's limits: passwords of
8 to 64 characters, the 128-character encrypted form, a 1-character community and a 1-character SNMPv3
password, 20-character community-group and host communities, and a 48-character `auth-sha-key`.

oxidized has no secret filter for EdgeSwitch (`edgeswitch.rb`, no `:secret` block) and no UniFi-switch
model, so it is no reference here.

## Not bound yet

- `vlan 10,20,30` under `vlan database`: one value names several VLANs.
- VLAN membership (`vlan pvid`, `vlan participation include`, `vlan tagging`), for the reason
  `README-omada-sw.md` gives: `VlanMember` resolves a VLAN by name.
- `network parms` and other addresses with dotted masks.

## Open

- A real UniFi running-config. Does it print `username`, `enable password`, `snmp-server`, a controller's
  802.1X `radius server key`?
- Whether the `cli` shells on newer models print this syntax.
- The second text format, `cat /tmp/system.cfg` (`key=value`), is not read here.
