# Survey — Nokia 7210 SAS configuration capture

> **Status:** Proposed — a survey, not a decision. It proposes **no** `platforms.yaml` row, no
> dictionary, and no corpus entry. Read 2026-09-12 unless a line says otherwise.

**Scope and what this document is licensed to do.** `schema/platforms.yaml` records the precedent:
*a vendor is registered when the owner names it; a platform is declared only when a real config has
been seen.* **No 7210 SAS configuration body was seen during this survey.** Nothing below may be
used to write a platform row, a parser dictionary, or a redaction rule that claims to cover the
7210 SAS. Its job is to tell whoever next has a real capture in front of them exactly what to
check, and to be honest about the difference between what was observed and what was inferred.

The Ciena and Sodola comments in `schema/platforms.yaml` are the register this is written in. This
document lands nearer Sodola than OPNsense: the capture path is well understood *for the family*,
and unverified *for the hardware*.

---

## 0. What was reached and what was not

Every outbound host in this session goes through a policy-enforcing egress proxy. Nokia's
documentation estate is **denied at the proxy**, not merely slow or unavailable.

| Host | Result | Evidence |
|---|---|---|
| `documentation.nokia.com` | **Blocked.** `HTTP/1.1 403 Forbidden` to `CONNECT` | proxy log `connect_rejected`, 2026-09-12T20:52:04Z |
| `infocenter.nokia.com` | **Blocked.** 403 to `CONNECT` | proxy log, 2026-09-12T20:52:04Z |
| `www.nokia.com` | **Blocked.** 403 to `CONNECT` | proxy log, 2026-09-12T20:52:05Z |
| `infodoc.alcatel-lucent.com` | **Blocked.** 403 to `CONNECT` | verified verbosely, 2026-09-12 |
| `web.archive.org`, `archive.org` | **Blocked.** 403 to `CONNECT` | proxy log, 2026-09-12T20:52:34Z |
| `manualslib.com`, `manuals.plus`, `device.report` | **Blocked** (403 / `EGRESS_BLOCKED`) | 2026-09-12 |
| `stackoverflow.com`, `community.cisco.com`, `networklessons.com` | **Blocked.** 403 | proxy log, 2026-09-12 |
| `github.com`, `raw.githubusercontent.com` | **Reached.** Full file reads | 2026-09-12 |
| GitHub code search API | **Reached.** Returns verbatim match fragments | 2026-09-12 |
| Search engine (`WebSearch` tool) | **Reached**, and it can summarise Nokia pages this session cannot open | 2026-09-12 |

Per `/root/.ccr/README.md`, a 403 from the proxy is an organisation egress-policy denial and is to
be reported rather than routed around. It was not routed around. **No Nokia-authored page was read
directly by this session.**

### Confidence tiers used below

Every claim in this document carries a tier. Do not promote a claim between tiers without a new
lookup.

| Tier | Means | Weight |
|---|---|---|
| **A** | Primary Nokia documentation, read directly | **None available.** Zero tier-A claims in this survey |
| **B** | Real device output committed to a public repository, file read directly | Strong for *shape*. The device is whatever the repo says it is |
| **C** | Third-party tooling source that encodes observed device behaviour (RANCID, Oxidized, LibreNMS, Observium, Spirent) | Strong for *what a tool had to handle*, which is a proxy for real output |
| **D** | Nokia documentation reached **only** through a search engine's summary — the page itself 403s here | **Weak.** Treat as a lead to verify, never as the basis of a gate |

Tier D is the register's "forum post" case, and worse in one way: a search summary can paraphrase,
and a paraphrase of a vendor's syntax is not the vendor's syntax. Every tier-D claim below is
marked `<!-- VERIFY -->`.

---

## 1. Which 7210 SAS variants share one configuration format

**Established (tier B/C): the 7210 SAS runs TiMOS / SR OS and its config is SR OS classic CLI.**
This is not an inference from the product family name; it is visible in banners emitted by real
7210 hardware.

| Variant seen | Banner / identity string, verbatim | Source tier |
|---|---|---|
| 7210 SAS-D 6F4T ETR | `# TiMOS-B-7.0.R6 both/mpc ALCATEL SAS-D 6F4T ETR 7210 Copyright (c) 2000-2015 Alcatel-Lucent.` | C — Spirent iTest response map for `show system information` |
| 7210 SAS-M 24F 2XFP | `//TiMOS-B-6.0.R6 both/mpc ALCATEL SAS-M 24F 2XFP 7210 Copyright (c) 2000-2014 Alcatel-Lucent.` | C — Observium `timos.inc.php` sample sysDescr |
| 7210 SAS-R6 | `TiMOS-C-10.0.R4 cpm/hops Nokia SAS-R 7210 Copyright (c) 2000-2018 Nokia.` | C — LibreNMS `tests/data/timos.json`, `hardware: 7210 SAS-R6` |
| 7210 SAS-Sx 10/100GE | `Type : 7210 SAS-Sx 10/100GE`, `Part Number : 3HE10497AARA01` | C — netops-toolkit Nokia parser test fixture |

Note the banner word order differs from the 7750: the 7210 renders as
`<vendor> SAS-D 6F4T ETR 7210` / `Nokia SAS-R 7210`, where a 7750 renders as `Nokia 7750 SR`.
**A parser that anchors on `Nokia 7750 SR` will not match a 7210.** This is the single most
concrete 7210-specific finding in this survey.

**One CLI family, per two independent config-collection tools (tier C).**

- RANCID's device-type table defines one type `sros` and comments it:
  `# Nokia (Alcatel-Lucent) SR OS Classic CLI (TiMOS)` /
  `# 7210 SAS, 7250 IXR, 7450 ESS, 7705 SAR, 7750 SR, 7950 XRS, CMG and VSR routers`.
- Oxidized's `sros.rb` model header: *"Nokia SR OS (TiMOS) (formerly TiMetra, Alcatel,
  Alcatel-Lucent). Used in 7705 SAR, 7210 SAS, 7450 ESS, 7750 SR, 7950 XRS, and NSP."*

Both tools capture all of these with the same command and the same parser. That is meaningful
evidence: two independently maintained codebases concluded the text is one format.

**But the family is not uniform, and RANCID records a real 7210 exception.** In `ShowRedundancy`,
RANCID carries the comment `# not on 7210 SAS, return 0` immediately above
`return(0) if (/error: invalid parameter/i);` — i.e. `show redundancy synchronization` does not
exist on a 7210 SAS and the collector must tolerate the error rather than fail. **The 7210 is the
same grammar with a smaller command set**, which is exactly the case where a dictionary written
from 7750 captures silently over-claims.

**Documentation groupings (tier D)** `<!-- VERIFY -->`. Nokia does not publish one 7210 SAS guide.
Filenames visible in search results split the line in two, consistently, across releases:

| Grouping | Guide filename seen | Release |
|---|---|---|
| D, Dxp, K 2F1C2T, K 2F6C4T, K 3SFP+ 8C | `7210_SAS-D_Dxp_K2F1C2T_K2F6C4T_K3SFP+8C_Basic_System_Configuration_Guide_R23.9.R1.pdf` | 23.9.R1 |
| Mxp, R6, R12, S, Sx, T | `7210 SAS-Mxp R6 R12 S Sx T Basic System Configuration Guide 23.9.R1.pdf` | 23.9.R1 |
| M, T, X, R6, R12, Mxp, Sx, S | `3HE11487AAAHTQZZA_V1_...Basic System Configuration Guide.pdf` | older |
| D, E | `9304930101_V1_7210 SAS D, E OS Basic System Configuration Guide` | older (SAS-E era) |
| M, X | `9303920102_V1_...4.0r2.pdf` | 4.0.R2 |

The older infocenter URL paths carry the same split as document-plugin ids: `com.sas.basic.m`
versus `com.sas.basic.d`. **So there are at least two documentation families, D/Dxp/K and
Mxp/R6/R12/S/Sx/T**, and SAS-E and SAS-X appear only in the older guides — they look like retired
variants. Whether the two doc families differ in *config text shape* or only in supported feature
set **could not be established**; the guides are behind the block.

**MD-CLI: no evidence the 7210 SAS has it.** RANCID defines a second type `sros-md` commented
`# 7750 SR and 7950 XRS routers` — the 7210 is absent from that list while being present on the
classic list. That is suggestive, not conclusive (tier C, and it is a tool's support matrix rather
than Nokia's statement). **Treat the 7210 SAS as classic-CLI-only until a real box says otherwise.**

---

## 2. How a full configuration is captured as text

**Established (tier C, two independent tools agreeing).** The command is:

```text
admin display-config
```

- RANCID: `sros;command;sros::WriteTerm;admin display-config`, with the routine comment
  `# This routine parses "admin display-config"`.
- Oxidized: `cmd "admin display-config\n" do |cfg| cfg end` — the only command whose output it
  keeps as configuration rather than wrapping as a comment.

Supporting commands, same sources:

| Command | Purpose | Note |
|---|---|---|
| `admin display-config index` | Prints the persistent-index file | RANCID `WriteTermIndex`; Oxidized keeps it **as a comment**, not config |
| `admin show configuration` | MD-CLI equivalent | RANCID `sros-md` only — **not evidenced for 7210** |
| `admin save` | Writes running config to the configured location | tier D `<!-- VERIFY -->` |
| `show bof` | Boot option file — separate from the config | Oxidized and RANCID both collect it separately |

**Paging must be disabled first.** Oxidized sets `post_login 'environment no more'`. A capture taken
without it will contain pager artefacts. Anyone pasting into Fathom by hand from a terminal will hit
this, so the paste surface should expect and tolerate it.

**`admin save` and the on-box file (tier B for the filename, tier D for the semantics).** A real
7210 SAS-D `show system information` shows:

```text
BOF Source             : cf1:
Config Source          : primary
Last Booted Config File: cf1:\config.txt
Last Saved Config      : cf1:\config.txt
Time Last Saved        : 2017/10/06 18:18:28
Changes Since Last Save: No
Max Cfg/BOF Backup Rev : 5
```

So on that unit the config lives at `cf1:\config.txt` — **not** a fixed `config.cfg`; the name comes
from the BOF's primary-config setting. `Max Cfg/BOF Backup Rev : 5` indicates the box keeps numbered
backup revisions. Search-summarised Nokia documentation adds that on `admin save` with encryption
enabled the previous file is moved to `filename.1` and the encrypted file becomes the new
`filename.cfg`, and that a remotely-located config is cached to flash as `cf1:/default.cfg`
(tier D) `<!-- VERIFY -->`.

**Consequence for Fathom:** there are at least three different text artefacts a user might paste and
call "the config" — the running config (`admin display-config`), the saved config file, and the
**index** file (`.ndx`). The third is not a configuration and must not be parsed as one. See §3.

---

## 3. The text shape

**Tier B, read directly from real captures.** All bodies below are **7750 SR / VSR**, spanning
TiMOS 14.0.R3, 19.10.R1, 21.7.R1 and 24.10.R2. **No 7210 SAS config body was obtained.** The shape
is presented as *the SR OS classic shape*, and the 7210's conformance to it is the first thing a
real capture must confirm.

### 3.1 Whole-file skeleton

```text
# TiMOS-B-24.10.R2 both/x86_64 Nokia 7750 SR Copyright (c) 2000-2024 Nokia.
# All rights reserved. All use subject to applicable license agreements.
# Built on Wed Dec 18 23:49:33 UTC 2024 by builder in /builds/2410B/R2/panos/main/sros
# Configuration format version 24.10 revision 0

# Generated TUE JUN 10 22:11:41 2025 UTC

exit all
configure
#--------------------------------------------------
echo "System Configuration"
#--------------------------------------------------
    system
        name "bng1"
        snmp
            streaming
                no shutdown
            exit
            shutdown
            packet-size 9216
        exit
    exit
...
exit all

# Finished TUE JUN 10 22:11:42 2025 UTC
```

### 3.2 Rules a dictionary would need

| Element | Rule | Confidence |
|---|---|---|
| Comment character | `#`, at column 0 for banners and separators | B |
| Header | 3–4 `#` lines: TiMOS banner, rights, `Built on`, optionally `Configuration format version` | B |
| Generated line | `# Generated <DOW> <MON> <DD> <HH:MM:SS> <YYYY> <TZ>`, preceded by a blank line | B |
| Preamble | literal `exit all` then `configure` (the `.ndx` file uses `config`, not `configure`) | B |
| Section banner | a `#---…---` rule line, an `echo "Section Name"` line, another rule line | B |
| Indentation | 4 spaces per nesting level, contexts open by bare keyword | B |
| Block close | literal `exit` at the parent's indent; `exit all` unwinds to root | B |
| Footer | `exit all`, blank line, `# Finished <timestamp>` | B |
| Negation | `no <keyword>` is a value-carrying line (`no shutdown`), not an absence | B |
| Quoting | user-supplied strings are double-quoted (`name "bng1"`, `user "admin"`); keywords are bare | B |
| Lists | repeated sibling lines, not comma-separated (e.g. several `trap-target …` lines) | B |
| Defaults | `admin display-config` prints **non-default settings only** unless `detail` is given | D `<!-- VERIFY -->` |

The `detail` point matters and is only tier D: a capture taken without it is a *diff against
defaults*, so absence of a line means "default", never "not configured". Confirm against a real box
before any rule reasons about an absent field.

### 3.3 The index file is not a config

`admin display-config index` (file `config.ndx`) shares the header format but is a different
artefact and says so itself:

```text
# TiMOS-B-26.3.R2 both/x86_64 Nokia 7750 SR-1s Copyright (c) 2000-2026 Nokia.
...
# Generated Sat Aug  8 07:13:59 2026 UTC

# DO NOT EDIT THIS FILE
#
# This file allows managed objects to be recreated with identifiers
# that are persistent across reboots of the system.

exit all
config
    system
    exit
    chassis-mac ethtun/0 1 769
#--------------------------------------------------
echo "Port Configuration"
#--------------------------------------------------
    port A/1 1611137032
```

It opens with `config`, not `configure`, and its body is object-to-integer bindings. The real 7210
SAS-D unit above reports `Last Boot Index Header` and `Last Boot Index Version` alongside the config
ones, so the 7210 produces one too. **The paste surface must distinguish it** — the `# DO NOT EDIT
THIS FILE` line plus `exit all` / `config` is a reliable discriminator, and it is the same class of
collision as the TP-Link `.cfg` case already noted in `schema/platforms.yaml`.

### 3.4 Capture noise to expect

One real capture begins with a stray `-config ` line before the banner — the collector's echoed
command. Older captures (14.0.R3) also show a blank line between the TiMOS banner and the rights
line where newer ones have none. A parser must not require the header to be exactly four contiguous
lines.

---

## 4. Which keywords carry secrets

**This is the section that feeds the redaction gate, and it is the section with the widest gap
between what was observed and what the 7210 will actually emit.** Everything in the table was read
from a real SR OS classic config or from a collector that had to filter real SR OS output. **None of
it was read from a 7210 SAS.** Per CLAUDE.md rule 4 and the ingest-gate rule, this list may be used
to *widen* what the gate destroys; it may not be used to declare 7210 coverage.

### 4.1 Observed, with the literal text

| Keyword | Literal form observed | Stored as | Source |
|---|---|---|---|
| `password` (user) | `password "$2y$10$TQrZlpBDra86.qoexZUzQeBXDY1FcdDhGWdD9lLxMuFyPVSm0OGy6"` | crypt-style string, `$2y$10$` prefix, **no** trailing marker | B — two independent captures |
| `password` (profile) | `password "7NcYcNGWMxapfjrDQIyYNTK0svJHSTQ=" hash2` | base64-looking, **`hash2` marker after the quoted value** | B |
| `community` (SNMP) | `community "cV3ISTw2V5pbEWmVEA9jXgB/1EERXQA=" hash2 rwa version both` | base64-looking + `hash2`, then *more keywords after the secret* | B — two captures |
| `community` (SNMP) | `community "76HzdddhlPpRo1Vql+ZB5spLqccgYQ==" hash2 r version v2c` | as above | B |
| `notify-community` | `trap-target "…:main1" address 192.168.200.240 snmpv2c notify-community "privatetrap98"` | **CLEARTEXT, mid-line, no marker** | B |
| `secret` (RADIUS) | `secret "McTNkSePNJMVFysxyZa4y9LdcXRy91E=" hash2` — inside `radius-group`/`radius-profile` | base64-looking + `hash2` | B |
| `authentication-key` (OSPF) | `authentication-type password` then `authentication-key "9VpoiNEYtGTblCQkNIkinztQJH/XDd.VQN4cVWn/ZEnsG/Xhh8lIkexHAHs1ZNKO" hash2` | quoted + `hash2` | B — production capture, via GitHub code search fragment |
| `authentication-key` (OSPF, short) | `authentication-key "m1YZ1sRjHKrt9K9hjb557j8ibKjj" hash2` | quoted + `hash2` | B — same repo |

### 4.2 What the collectors independently decided was a secret

RANCID's SR OS filter is a second, independent enumeration — these are the patterns a long-lived
collector found it had to scrub. Verbatim regexes (tier C):

```perl
if (/^(\s+community) "[^"]*" /)                                    # SNMP community
if (/^(\s+trap-target\s+.*)\s+(notify-community)\s+("\S+")/)       # trap notify-community
if (/^(\s+password)\s+("\$\S+")/)                                  # user password
if (/^(\s+authentication-key)\s+("\S+"\s+hash2)/)                  # routing-protocol auth key
```

Two findings worth flagging:

1. **RANCID's `password` regex requires the value to begin with `$`** (`"\$\S+"`). It therefore
   matches the `$2y$10$…` crypt form and **does not match** the
   `password "7NcYcNGWMxapfjrDQIyYNTK0svJHSTQ=" hash2` form that appears in real configs (observed
   above). Whether that is a RANCID bug or a context RANCID never meets, a Fathom detector modelled
   on that regex would **miss a real secret**. Do not copy it.
2. **RANCID scrubs `authentication-key` only in its MD-CLI routine**, not in the classic
   `admin display-config` routine — yet the production classic captures above plainly contain
   `authentication-key … hash2`. Same conclusion: the collector's list is a lower bound, not a
   specification.

### 4.3 What `hash` / `hash2` actually mean — and why this is a redaction question, not a comfort

Tier D, from Nokia's own documentation pages reached only via search summary `<!-- VERIFY -->`:

- `hash` and `hash2` both use **AES-256**.
- `hash2` is node-specific: the value cannot be transferred to another node. `hash` produces a value
  that can be copied and pasted between locations, and the same password yields the same value.
- Maximum password length is stated as 20 characters unhashed, 32 hashed, 54 with `hash2`.

**Inference, labelled as such and not verified:** AES-256 is an encryption algorithm, not a one-way
digest, so a `hash2` value is most likely **recoverable ciphertext of the live secret**, not a
digest. If that holds, then `community "…" hash2`, `secret "…" hash2` and `authentication-key "…"
hash2` are **live credentials in transport form and must be destroyed by the gate exactly as
aggressively as cleartext**. The `$2y$10$` user-password form is a different thing — that prefix is
the bcrypt identifier (identification inferred from the prefix, tier B for the literal only) and is
plausibly a genuine one-way digest.

**Do not let the word "hash" downgrade a redaction decision.** Under CLAUDE.md rule 4 the gate runs
before storage and the cost of destroying a digest is nil, so both forms are redacted regardless of
how this inference resolves. The distinction is recorded because it changes the *severity* of a
leak, not the *action*.

### 4.4 The cleartext case

`notify-community "privatetrap98"` was observed **unmarked and in the clear**, in the middle of a
`trap-target` line whose other fields are not secret. This is the shape that defeats a line-prefix
detector: the keyword is not at the start of the line, and there is no `hash`/`hash2` marker to key
on. RANCID handles it with a dedicated mid-line regex. Any Fathom detector must too.

### 4.5 Keywords deliberately NOT listed

Per the instruction that an incomplete list stated as incomplete beats a complete-looking list with
a guess in it, the following are **absent because no source was found in this session**, not because
they are believed absent:

- TACACS+ shared secret. A `user-template "tacplus_default"` was observed, confirming TACACS+ exists
  in SR OS, but **no TACACS+ secret line was seen**. Its keyword and hashing are unestablished.
- BGP MD5 / TCP-AO keys. No BGP authentication line was observed in any capture obtained. SR OS
  almost certainly has one — its keyword is **not established here**.
- IS-IS authentication, RSVP/LDP authentication, keychain entries. One third-party test fixture
  showed a `configure system security keychains keychain … entry 1 authentication-key …` command
  form, but it is a *simulator's* test string, not device output, and it is not counted.
- `snmp usm-community`, SNMPv3 USM auth/priv keys. Not observed.
- IPsec / certificate private-key material. Not observed.
- Any `hash` (as opposed to `hash2`) marker. **Documented as existing (tier D) but never observed in
  a real capture during this survey.** A detector should match both, but the `hash` form's exact
  in-config spelling is unverified.

---

## 5. Release and version scheme, and how a config declares its release

**Established (tier B).** The first line of the config is the release declaration:

```text
# TiMOS-<variant letter>-<major>.<minor>.R<revision> <image>/<arch> <vendor> <model> Copyright (c) <years> <vendor>.
```

Worked examples, all read directly:

| Literal | Release | Notes |
|---|---|---|
| `TiMOS-B-14.0.R3 both/i386 ALCATEL SR 7750 Copyright (c) 2000-2016 Alcatel-Lucent.` | 14.0.R3 | pre-rebrand vendor string |
| `TiMOS-B-19.10.R1 both/x86_64 Nokia 7750 SR Copyright (c) 2000-2019 Nokia.` | 19.10.R1 | minor is `10`, not `1` — **the field is not single-digit** |
| `TiMOS-B-21.7.R1 both/x86_64 Nokia 7750 SR Copyright (c) 2000-2021 Nokia.` | 21.7.R1 | |
| `TiMOS-B-24.10.R2 both/x86_64 Nokia 7750 SR Copyright (c) 2000-2024 Nokia.` | 24.10.R2 | |
| `TiMOS-B-7.0.R6 both/mpc ALCATEL SAS-D 6F4T ETR 7210 Copyright (c) 2000-2015 Alcatel-Lucent.` | **7.0.R6 on a real 7210 SAS-D** | `mpc` arch |
| `TiMOS-C-10.0.R4 cpm/hops Nokia SAS-R 7210 Copyright (c) 2000-2018 Nokia.` | **10.0.R4 on a real 7210 SAS-R6** | `TiMOS-**C**`, `cpm/hops` |

Observations that a version parser must respect:

- **The letter after `TiMOS` varies**: `B` and `C` both seen, correlating with the image field
  (`both/…` vs `cpm/…`). Do not hardcode `TiMOS-B`.
- **Two numbering eras.** The 7210 units seen run `6.0`, `7.0`, `10.0` — a 7210-specific train.
  Modern 7210 documentation is numbered `20.9`, `22.9`, `23.3`, `23.9`, matching the calendar-based
  SR OS scheme (tier D, from guide filenames). Whether the 7210 migrated onto the shared SR OS train
  or merely adopted its numbering **could not be established**.
- **A second, explicit declaration exists on newer releases only**:
  `# Configuration format version 24.10 revision 0`. Present in the 21.7.R1 and 24.10.R2 captures;
  **absent** from 19.10.R1 and 14.0.R3. So it was introduced between 19.10 and 21.7 (tier B, four
  data points — the boundary is bracketed, not pinned). Given the 7210 releases observed are far
  older, **a 7210 config may well have no format-version line at all**; the TiMOS banner is the only
  declaration that can be relied on.
- The banner may wrap across lines when re-emitted inside other output (the 7210 SAS-D
  `Last Boot Config Header` field shows it wrapped). In the config file itself it is one line.

---

## 6. What could not be established

This section is the point of the document. Each item names what to check the day a real capture
exists.

1. **No 7210 SAS configuration body was obtained — at all.** Every config body read here is 7750 SR
   or VSR. The 7210 evidence is limited to banners, a `show system information` dump, SNMP sysDescr
   strings, and two collectors' family groupings. **This alone blocks a platform row.**
2. **No Nokia-authored page was read directly.** Every Nokia claim is tier D, through a search
   engine. `documentation.nokia.com`, `infocenter.nokia.com` and `infodoc.alcatel-lucent.com` are
   all 403 at the egress proxy. A session with access to any one of them should redo §2, §4.3 and
   the §5 numbering question first.
3. **Whether the D/Dxp/K guide family and the Mxp/R6/R12/S/Sx/T guide family differ in config text
   shape**, or only in feature coverage. Two doc families is a fact (filenames); two *formats* is
   not established and would change whether one dictionary suffices.
4. **Whether `admin display-config` on a 7210 defaults to non-default-only output**, and whether
   `detail` behaves as on the 7750. This decides whether an absent line means "default" or "unknown"
   — a correctness question for every rule that reads a field.
5. **The TACACS+ secret keyword, the BGP authentication keyword, IS-IS/LDP/RSVP authentication
   keywords, and SNMPv3 USM keys.** Listed in §4.5 as unestablished. These are the most likely gaps
   in the redaction list and the first thing to grep a real capture for.
6. **Whether `hash`/`hash2` values are reversible.** §4.3 records the inference and the reason;
   Nokia's own page must be read to settle it. The redaction action does not depend on the answer;
   the incident severity does.
7. **The exact in-config spelling of the `hash` (not `hash2`) marker.** Documented as existing,
   never observed.
8. **Whether the 7210 SAS supports MD-CLI**, and therefore whether `admin show configuration` is
   ever a valid 7210 capture command. RANCID's support matrix implies not.
9. **Whether a 7210 config can be encrypted on disk**, and what an encrypted file looks like when
   pasted. Search-summarised documentation describes BOF/config encryption with `filename.1`
   rotation; if a user pastes an encrypted file, Fathom must recognise and reject it rather than
   parse garbage.
10. **Maximum realistic secret lengths on a 7210.** The tier-D figures (20 / 32 / 54) are the
    7750-documented limits. CLAUDE.md rule 2 requires the gate's tests be built against what a real
    device accepts — so these numbers must be confirmed *on a 7210* before any test uses them. This
    is precisely the failure mode rule 2 was written about.

---

## Recommendation

**RECOMMENDATION —** register nothing yet. `nokia` is already in the `vendors:` block of
`schema/platforms.yaml`, which is sufficient and correct. Do **not** add a `platforms:` row: the
Ciena and Sodola precedent is directly on point, and this survey is one step weaker than the OPNsense
and TP-Link surveys that did earn rows, because those established a capture path *and* a seen
artefact, while this establishes a capture path *for a related product* and no 7210 artefact.

The cheapest thing that would unblock a row is one `admin display-config` off any 7210 SAS, pasted
by someone who has one. Second cheapest is egress access to `documentation.nokia.com`.

If any part of the SR OS material here is used before then, use it **only** to widen the redaction
gate's pattern set — `community`, `notify-community`, `password`, `secret`, `authentication-key`,
and the bare `hash2` marker — which the ingest-gate rule permits and which costs nothing if the
7210 never emits them.

---

## Sources

All read 2026-09-12 unless stated. Tier in brackets.

**Reached and read directly**

- [C] RANCID SR OS collector — <https://raw.githubusercontent.com/haussli/rancid/master/lib/sros.pm.in>
- [C] RANCID device-type table — <https://raw.githubusercontent.com/haussli/rancid/master/etc/rancid.types.base>
- [C] Oxidized SR OS model — <https://raw.githubusercontent.com/ytti/oxidized/master/lib/oxidized/model/sros.rb>
- [C] Spirent iTest TiMOS `show system information` response map (real 7210 SAS-D 6F4T ETR output) — <https://raw.githubusercontent.com/Spirent/iTest-assets/master/Libraries/DUTs/Reference/di_TiMOS/response_maps/show_system_information.ffrm>
- [C] LibreNMS TiMOS test data (real 7210 SAS-R6 sysDescr) — <https://raw.githubusercontent.com/librenms/librenms/master/tests/data/timos.json>
- [C] Observium TiMOS poller, sample sysDescr for 7210 SAS-M — <https://github.com/pgmillon/observium/blob/master/includes/polling/os/timos.inc.php>
- [C] netops-toolkit Nokia parser test fixture (7210 SAS-Sx type/part number) — <https://github.com/plures/netops-toolkit/blob/main/tests/test_parsers_nokia.py>
- [B] SR OS classic config, TiMOS-B-24.10.R2 — <https://raw.githubusercontent.com/fmiguelalberto1/evpn-till/main/clab-evpn-till/bng1/tftpboot/config.txt>
- [B] SR OS classic config, TiMOS-B-21.7.R1 — <https://raw.githubusercontent.com/AdminReboot/DHCP-Configuration-Example-in-Nokia-7750-SR-Router/main/PE1.txt>
- [B] SR OS classic config, TiMOS-B-19.10.R1 — <https://raw.githubusercontent.com/buraglio/Nokia-SR-PCE/master/vsr-nrc1>
- [B] SR OS classic config, TiMOS-B-14.0.R3 — <https://raw.githubusercontent.com/Ahmed-Kareem-Dimah/IBN/master/nodes_config/P-1>
- [B] SR OS classic config with RADIUS `secret … hash2` and `password … hash2` — <https://raw.githubusercontent.com/hatakkey/MAG-cups/master/configs/nodes/CP1_config.txt>
- [B] SR OS classic config with `trap-target … notify-community` in cleartext — <https://raw.githubusercontent.com/buraglio/Nokia-SR-PCE/master/vsr-nrc1-example>
- [B] SR OS persistent-index file (`config.ndx`), TiMOS-B-26.3.R2 — <https://raw.githubusercontent.com/caophuonghuy/srv6-usid-clab/main/lab1-single-domain/clab-uSID/srv6-rr/A/config/cf3/config.ndx.1>
- [B] Production OSPF `authentication-key "…" hash2` lines, via GitHub code search match fragments — <https://github.com/Alextadu/JM_Atividade_Manager---Backup--est-vel> (`runtime_data/Atividade_489836/LOGS_DURANTE/LOG_DURANTE_PEIPJ02-RMP01.txt`, `runtime_data/Atividade_CRQ499086/LOGS_DURANTE/LOG_DURANTE_BAFALR1-RMP01.txt`)
- [C] Infoblox NetMRI device support list, 7210 SAS-M at TiMOS-B-6.0.R6 — <https://github.com/ramees-kr/dsbcheck/blob/main/DSL/TXT/Infoblox_NetMRI_7.5.4_NIOS_9.0_Device_Support_List.txt>

**Blocked — listed so the next session knows what to retry, and what was NOT read**

- [—] <https://documentation.nokia.com/> — 403 at egress proxy
- [—] <https://infocenter.nokia.com/> — 403 at egress proxy
- [—] <https://infodoc.alcatel-lucent.com/> — 403 at egress proxy
- [—] <https://www.nokia.com/> — 403 at egress proxy
- [—] <https://web.archive.org/> — 403 at egress proxy
- [—] `manualslib.com`, `manuals.plus`, `device.report` — 403 / EGRESS_BLOCKED

**Tier D — Nokia pages reached only through a search engine's summary; the pages themselves are
blocked here. Every claim drawn from these is marked `<!-- VERIFY -->` above.**

- <https://infocenter.nokia.com/public/7750SR222R1A/topic/com.nokia.System_Mgmt_Guide/password_hashin-ai9exj5x9u.html> — password hashing
- <https://infocenter.nokia.com/public/7750SR222R1A/topic/com.nokia.System_Mgmt_Guide/hash_encryption-ai9exj5ycb.html> — hash encryption using AES-256
- <https://infocenter.nokia.com/public/7210SAS229R1A/topic/com.nokia.TSR_Basic_System_Guide/configuration_f-ai9j4okjrn.html> — 7210 SAS configuration file and TiMOS image loading
- <https://infocenter.nokia.com/public/7210SAS223R1A/topic/com.sas.basic.m/html/tsr_bof.html> — 7210 SAS boot options
- <https://infocenter.nokia.com/public/7210SAS203R1A/topic/com.sas.basic.m/html/tsr_file_config.html> — 7210 SAS file system management
- <https://documentation.nokia.com/sas/23-9/pdf/7210_SAS-D_Dxp_K2F1C2T_K2F6C4T_K3SFP+8C_Basic_System_Configuration_Guide_R23.9.R1.pdf> — guide filename evidences the D/Dxp/K grouping
- <https://infodoc.alcatel-lucent.com/cgi-bin/dbaccessfilename.cgi/3HE19276AAABTQZZA01_V1_7210%20SAS-Mxp%20R6%20R12%20S%20Sx%20T%20Basic%20System%20Configuration%20Guide%2023.9.R1.pdf> — guide filename evidences the Mxp/R6/R12/S/Sx/T grouping
- <https://documentation.nokia.com/cgi-bin/dbaccessfilename.cgi/3HE11487AAAHTQZZA_V1_7210%20SAS%20M%20T%20X%20R6%20R12%20Mxp%20Sx%20S%20OS%20Basic%20System%20Configuration%20Guide.pdf> — older combined grouping
- <https://documentation.nokia.com/cgi-bin/dbaccessfilename.cgi/9304930101_V1_7210> — 7210 SAS D, E guide (SAS-E era)
