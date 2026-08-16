# 64 — Can you copy a config out of it? A capture survey of ten platforms

> **Status:** Survey, 2026-08-10. Evidence, not a decision — it establishes what each platform can
> hand a human, and decides nothing about what Fathom builds. `79-work-orders/00-ROUTE-TO-WORKABLE.md`
> owns the order; `schema/platforms.yaml` owns the registry; `70` §7 owns the owner's platform list.
>
> **Method.** Six independent researchers, each restricted to primary vendor documentation and real
> captures, each adversarially verified by a second agent whose brief was to refute them and to open
> every cited URL. Where a verifier refuted a researcher, the verifier's finding is carried. Every
> claim below carries a URL and the date it was checked, per ADR-0034 — *"a security claim is never
> answered from memory"*, and a claim about what text a device will hand you is exactly that.
>
> **The one question this survey asks**, because invariant 2 makes it the only one that matters:
> *can a human select text and copy a complete-enough configuration out of this equipment?* A
> platform that cannot is a platform Fathom cannot support, and saying so plainly is the correct
> answer rather than a failure to find one.

## 0. Contents

| § | | margin tab |
|---|---|---|
| 1 | The answer table | *read this first* |
| 2 | Meraki, answered directly | *the owner asked* |
| 3 | Parser families | *the expensive part* |
| 4 | The secret list, merged | *the gate's specification* |
| 5 | What could not be established | *stated, not smoothed* |
| 6 | Recommended order | *proposed, not decided* |
| | Failure modes | |
| | Open decisions | |
| | Disagreements | |

---

## 1. The answer table

The question is only ever: *can a human select text and copy a complete-enough configuration out of this thing?*

| Platform | Copyable? | In plain words | The one piece of evidence that decides it |
|---|---|---|---|
| **Junos SRX** *(baseline — already working)* | **Yes, fully** | `show \| display set` prints the whole config as one complete statement per line. Already ingested; 42 statements in the dictionary. | Juniper's own CLI reference for `display set`: "Display the configuration as a series of configuration mode commands required to re-create the configuration from the top level of the hierarchy." `juniper.net/documentation/us/en/software/junos/cli-reference/topics/ref/command/show-pipe-display-set.html` (checked 2026-08-10) |
| **Arista EOS** | **Yes, fully** | `show running-config` prints everything as plain indented text. Best of the six. It even has a built-in `sanitized` variant that blanks passwords — but you cannot tell from the text whether someone used it, so it changes nothing about our redaction. | A real captured config off a DCS-7150S-64-CL running EOS-4.22.4M, read byte-for-byte: `raw.githubusercontent.com/ksator/arista_eos_audit/master/output/10.83.28.122/eos_commands/text/show%20running-config.txt` (checked 2026-08-10) |
| **Cisco Nexus (NX-OS)** | **Yes, fully** | `show running-config` after `terminal length 0`. Standard, stable, works the same on 3000/5000/7000/9000. One real gate: a read-only NOC account **cannot** run it. | Cisco's own N9K security guide: "The network-operator role does not have access to the show running-config or show startup-config commands." (checked 2026-08-10) |
| **Palo Alto PAN-OS** | **Yes, fully** | Four selectable text formats. `set cli config-output-format set`, then `configure`, then `show` — and out comes something that looks almost exactly like Junos set-form. | Palo Alto's CLI Quick Start shows the same node in all four formats side by side, including `set deviceconfig system dns-setting servers primary 1.2.3.4`: `docs.paloaltonetworks.com/pan-os/11-1/pan-os-cli-quick-start/get-started-with-the-cli/customize-the-cli` (checked 2026-08-10) |
| **OPNsense** | **Yes, fully — three ways** | The whole configuration is one file, `/conf/config.xml`. Better for us: from the console shell, `pluginctl -g` prints the entire config (or any subtree) to the screen as JSON — real screen text you can select, and you can paste just the interfaces without the certificate blobs. **And, since 26.1, the firewall rules alone come out as a CSV from the GUI — see §1.1, which this survey missed.** | The web download button is literally `file_get_contents('/conf/config.xml')` with no filtering (diag_backup.php ~line 215); `pluginctl` help reads "-g get config property (raw…)" and with no argument returns the whole config as pretty-printed JSON. Both read at commit `ae0088be`, 2026-08-09 (checked 2026-08-10). The CSV path's evidence is in §1.1 (checked 2026-08-15) |
| **TP-Link Omada — managed switches** | **Yes** | `show running-config` over console/SSH, or the web "Backup Config" export, which is a plain-text file starting `!SG3428XMP` and ending `end`. Two real ones were read. | `raw.githubusercontent.com/MateusAlo/MOVER_pf/master/src/sensing/switch/sysConfigBackup.cfg` — a real 398-line export from a TL-SG3428XMP (checked 2026-08-10) |
| **TP-Link Omada — ER gateways** | **No** | There is a CLI, but there is no command that prints the whole config. You would run ~20 separate `show` commands and stitch them by hand, and none of them emits config-syntax lines. | The 109-page ER605/ER7206 CLI guide grepped end-to-end for `running-config`, `startup-config`, `show configuration`: **zero hits**. All three ER guide revision pages serve the same PDF, so there is no older or newer guide hiding one. |
| **TP-Link Omada — EAP access points** | **No** | The CLI is read-only diagnostics, on six models only. No SSID dump, no wireless config, nothing. | TP-Link, verbatim: "all the CLI commands supported on Omada APs can only display certain information; users are not able to make any configuration on Omada APs through the CLI commands." |
| **TP-Link Omada — Controller backup** | **No** | Encrypted binary. Same `.cfg` extension as the switch's plain-text export — a trap worth naming in our own UI. | TP-Link: "you can only use the original file to restore … rather than read, understand, or modify the file. That's because the Software Controller (or OC200) has encrypted and compressed the file…" |
| **Sodola — L2+/L3 rack models** (e.g. SL-SWTG3C12F) | **Probably, unverified** | It has a console port, a console cable in the box, and a "Cisco-like CLI". But **nobody has ever published a Sodola `show running-config`**, and Sodola publishes no CLI manual at all. The format we'd write against comes from a sibling brand on different silicon. | ServeTheHome, 22 Jan 2025: "The switch comes with a console cable and has a CLI" — and, on the next page, "We are not going to go into the Cisco-like CLI interface on this switch." The reviewer had it in front of him and chose not to document it. |
| **Sodola — web-only models** (SL-SG008W, SL510S-4T2XS, SL-SWTGW218AS) | **No** | No CLI a human can reach. The only export is a file download whose format is nowhere stated in any Sodola document. | ServeTheHome teardown of the SL510S: "there is not an out-of-band management port nor a serial console port on this switch"; the SL510S manual's own Management Service screenshot offers only HTTP and SNMP. |
| **Cisco Meraki — MX / MS / MR** | **No** | See section 2. | Cisco's own FAQ: "The dashboard configuration cannot be backed up or exported to a local copy. All configurations are stored as a container in the Meraki back end." (page last modified 2026-04-09, checked 2026-08-10) |
| **Cisco Meraki-managed Catalyst** (C9300-M / C9K on cloud management) | **Yes — but it is not really Meraki** | The Dashboard shows a full IOS-XE running-config as selectable text, and in device-configuration mode the switch keeps full CLI/SSH. This is an IOS-XE ingest problem wearing a Meraki badge. | `documentation.meraki.com/Switching/Cloud_Monitoring_for_Catalyst/Getting_Started/Configuration_History`: "view the current and previous versions of the IOS-XE running configuration of each monitored switch… available for Catalyst switches using configuration source cloud or device" (dateModified 2026-07-20) |

### 1.1 Correction — OPNsense exports firewall rules as CSV, and this survey did not say so

> **Added 2026-08-15.** The row above was written on 2026-08-10 from `/conf/config.xml` and
> `pluginctl -g` and named no third path. A **fourth** capture path existed at the time and the
> survey missed it: since 26.1, **Firewall → Rules → Migration assistant exports the firewall rules
> alone as a CSV file**. That is the shape the owner asked for by name, and a survey that is silent
> about a capture path is worse than one that is wrong about it, because nobody re-checks silence.

**What is true, and how it was established.** Every line below was checked on **2026-08-15** by
opening the URL, per ADR-0034.

| Claim | Source | Checked |
|---|---|---|
| Firewall → Rules → Migration assistant exports the legacy rules as CSV, which you download, may edit, and re-import into Firewall → Rules [new] | `thomas-krenn.com/en/wiki/OPNsense_26.1_Firewall_Rule_Migration` (page last modified 16 Feb 2026) | 2026-08-15 |
| The feature was requested as *"dump all rules in a simple csv file"* keyed on the `uuid` that is stable across the legacy and MVC formats; closed via PR #9606 | `github.com/opnsense/core/issues/9579`, opened 4 Jan 2026 | 2026-08-15 |
| Shipped in the 26.1 series: *"firewall: added a rule migration page (use with care)"* (26.1, 28 Jan 2026); *"firewall: add import/export function and missing lock on set action"* (26.1.3, 4 Mar 2026) | `docs.opnsense.org/releases/CE_26.1.html` | 2026-08-15 |
| The manual mentions it once and documents nothing about it: *"you can already migrate your existing rules with a helper in Firewall ‣ Rules ‣ Migration assistant."* | `docs.opnsense.org/manual/firewall.html` | 2026-08-15 |

**The header row, verbatim.** One OPNsense user pasted their real export's header into a bug report
asking for header validation on import, after accidentally importing a backup file and creating
~80,000 rules:

```
@uuid;enabled;statetype;state-policy;sequence;action;quick;interfacenot;interface;direction;ipprotocol;protocol;icmptype;icmp6type;gateway;replyto;disablereplyto;log;allowopts;nosync;nopfsync;statetimeout;max-src-nodes;max-src-states;max-src-conn;max;max-src-conn-rate;max-src-conn-rates;overload;adaptivestart;adaptiveend;prio;set-prio;set-prio-low;tag;tagged;tcpflags1;tcpflags2;categories;sched;tos;shaper1;shaper2;description;source_not;source_net;source_port;destination_not;destination_net;destination_port
```

— `github.com/opnsense/core/issues/9861` (opened 25 Feb 2026, still open; checked 2026-08-15).

That is **one** source, so it was checked against a second and independent one: the exporter itself.
`src/opnsense/scripts/filter/list_legacy_rules.php` on `opnsense/core` master emits exactly those
keys, in exactly that order, with the six `source_*`/`destination_*` keys appended last and
conditionally (read at `raw.githubusercontent.com/opnsense/core/master/...`, 2026-08-15). The two
agree on the columns and their order. **They do not both establish the delimiter** — the script
emits JSON and the CSV is assembled above it — so the `;` is attested by the pasted header alone.
Fathom therefore **sniffs** the delimiter from the header rather than assuming one; that is a
one-line concession to a fact this survey could not close, and it is written down rather than
guessed at.

**The action vocabulary**, needed to map a rule into `schema/enums/policy_action.yaml`, is
`pass | block | reject`, established twice: the model, `OptionValues` = Pass / Block / Reject with
default `pass` (`.../models/OPNsense/Firewall/Filter.xml`, master, 2026-08-15), and the manual's own
prose — *"Pass: allow traffic"*, *"Block: deny traffic and don't let the client know it has been
dropped"*, *"Reject: deny traffic and let the client know about it"* (`docs.opnsense.org/manual/firewall.html`,
2026-08-15).

**A caution the operator must hear, stated at the strength the evidence supports.** OPNsense issue
**#10595**, *"26.7.1: Migration Assistant exports 0-byte firewall rules CSV and omits legacy disabled
rules"*, opened **22 July 2026**, was **still open with no maintainer response** when checked on
2026-08-15. The reporter states the assistant detected 47 legacy rules and produced a file of **0
bytes, no header and no content**, and that at least one disabled legacy rule (`2c772765-…`) present
in `/conf/config.xml` did not appear in the new Rules page; they confirmed 47 rules and 9 disabled
ones from the shell.

I could not establish this independently. A web search returned the issue itself and a forum
post-index, not a second report reproducing it, and no release note or commit was found closing it.
So it is recorded here as **reported and unresolved, not confirmed** — which is the honest rank, and
it is not smoothed upward.

**Re-checked 2026-08-16, by a different session, and the state is unchanged.** The issue page itself
reports it **open, opened 22 July 2026, with zero comments**; a second, independent search against
the 26.7 release notes and changelog returned no fix, no closing commit and still no second
reproduction. Two lookups, one negative result, recorded as one (ADR-0034 §2). The rank does not
move: still reported-and-unresolved. What did change is the *reason for re-checking* — a dated
lookup is a record and cannot notice it has gone stale, and this one is quoted at an operator inside
the shipped product, so it is re-established rather than carried forward on trust.

**It is operationally load-bearing**, because the failure mode is silent in the direction that
hurts: an operator exports, gets a file, hands it to Fathom, and an empty export is
indistinguishable from a firewall with no rules unless somebody says so. Fathom's answer is in the
product, in two places, because there are two shapes of the same event:

- **A header with no records** is refused by `IngestRefusal::EmptyTable`, and the refusal the
  operator reads names the issue, states in capitals that it **does not mean their firewall has no
  rules**, and tells them the rules are still in `/conf/config.xml` and still being enforced.
- **A genuinely 0-byte file** — which is what the issue actually reports — reaches the page as an
  empty textarea and never reaches the module at all. The page used to answer *"nothing pasted"*,
  which is true and reads as the operator's mistake. It now names the bug in the same terms.

Neither refuses quietly and neither guesses. The reason both matter is the second half of #10595's
title, which is easy to skip: the assistant **also omitted a disabled legacy rule** that was present
in `/conf/config.xml`. A tool that treated an empty or short export as an estate of record would
document a firewall as permitting less than it does.

**INVARIANT 3 ON THIS PATH, CONFIRMED AGAINST THE COLUMN SET RATHER THAN ASSUMED.** §7 below lists
what an OPNsense configuration carries — `otp_seed`, API keys, LDAP bind passwords, RADIUS secrets,
X.509 private keys as **bare base64 with no PEM banner**, WireGuard keys, credentials inside a
`mmonitUrl`, and a `//system/backup/*` subtree holding the passphrase for every off-box backup. A
firewall-rules export should carry none of it, and *"should"* is not a security argument, so the
fifty columns were checked one at a time against `14` §9.4's secret-word test on 2026-08-16:

- **None of the fifty names a credential**, by whole string or by any `-`/`_`/`.`-separated part.
  The near misses are worth naming so the next reader does not have to re-derive them: `tag` and
  `tagged` are pf *packet* tags and neither is `token`; `max-src-conn-rate` splits to `max`, `src`,
  `conn`, `rate`; `state-policy` to `state`, `policy`. Every column is rule metadata built from
  rule fields by `list_legacy_rules.php`.
- **So a real export must lose nothing at the gate**, and that is asserted rather than hoped:
  `no_real_column_name_is_read_as_a_credential` drives all fifty and fails if any value is
  destroyed. A gate that shredded a legitimate `description` would be as much a defect as one that
  kept a password.
- **The gate still runs on this path**, because the file an operator pastes into the rules box is
  not always a rules export. #9861 above is the proof: that operator pasted a *backup configuration*
  into the rules importer and created ~80,000 rules. When that happens the column names are the
  configuration's own — `ldap_bindpw`, `radius_secret`, `user_password` — and those are coupled to
  their values by the leaf-name walk and destroyed.

Named gaps remain and are recorded rather than papered over.

> **CORRECTED 2026-08-16.** This paragraph said `mmonitUrl` is caught by "the `:` split in the
> unshaped sweep". **It is not, and it cannot be.** Driven three ways — through the shipped artifact
> reading the exported journal, through a width-refused row, and through the `key=value` sweep — the
> value came back verbatim with `drops: 0` every time. `pieces()` runs only `crypt_prefix`,
> `long_hex` and `base64ish` on its pieces, and `base64ish` rejects any piece of a URL on the `@` and
> the `.`; `key_names_a_secret` sees `https` as the left-hand side. The vendor fact is real and
> correctly quoted, which makes the false protection claim worse rather than better. A stated hole
> gets closed; a claimed protection gets trusted.

`mmonitUrl` carries its credential in the **value**, not the name, so **no rule in the gate today
reaches it** — closing it needs a value-shaped rule (a URL carrying a userinfo component is a
credential wherever it appears), which is a different instrument from the name list and is not
built. A bare-base64 private key with no PEM banner is caught by length and alphabet alone, which is
a heuristic and is described as one.

**Six concatenated names are also open**, each named in §7 and each driven through the shipped
artifact on 2026-08-16 at values a real box holds: `privkey`, `httpdPassword`, `mmonitUrl`,
`TlsDnsApiKey`, `basicauthpass` and `preSharedKey`. `is_secret_word` splits on `-`, `_` and `.`, so a
camelCase or run-together name has no component it can see. Values a real box makes long are still
destroyed by content — a 44-character WireGuard `privkey` was — but the NAME coupling is absent and
a short value under any of these six survives.

**What this changes for Fathom.** A firewall-rules CSV is not the `set`-form line grammar
`fathom-ingest` was built around, and it is not the XML/JSON nested-document family §3 prices. It is
a third shape — a header row plus one record per line — and it is by far the cheapest of the three
to read. See the OPNsense engine's own notes for what a row can and cannot become today.

---

## 2. Meraki, answered directly

**Your instinct was right, with one wrinkle you should know about.**

### The switches and appliances (MS switches, MX security appliances)

**No.** There is no way to get a configuration out of them as text, and Cisco says so in its own words: *"The dashboard configuration cannot be backed up or exported to a local copy."*

Everything a person might hope would work, doesn't, and each of these was checked rather than assumed:

- **The Local Status Page** (`my.meraki.com`, or `1.1.1.100`) shows uplink addressing, a proxy setting, speed/duplex, and on switches a handful of per-port toggles. No firewall rules, no VLAN list, no VPN, no ACLs. It prints no configuration text and offers no export — only an opaque "support data" bundle, which turns out to be **encrypted logs** the vendor decrypts for you (`SDB_[mac]_[timestamp].dat`), not a config.
- **A device CLI.** MX, MS and MR don't have one.
- **A Dashboard export.** Doesn't exist. The CSV downloads that exist are inventory and telemetry. (The "Download rules as CSV" button that search engines will point you at is on the *Help → Firewall info* page — it lists the Meraki cloud addresses your *upstream* firewall must permit, not the MX's own rules.)
- **Configuration templates.** A binding mechanism inside the Dashboard, not a file.

### The access points (MR / CW)

**No, and more emphatically.** The AP's local page shows connection status, AP details, neighbours, and a Configure tab limited to static IP, channel/power and proxy. Your SSIDs, their authentication mode, encryption, VLAN tagging and RF profiles are simply not on any screen the AP can show you. They exist as text in exactly one place in the world: the cloud Dashboard API's JSON.

### The closest possible thing, and what it would cost

The only complete textual form of a Meraki configuration is **JSON returned by Cisco's cloud Dashboard API** — `GET /networks/{id}/wireless/ssids`, `/appliance/vlans`, `/appliance/firewall/l3FirewallRules`, `/devices/{serial}/switch/ports`, and dozens more. There is no single "give me everything" call; a human walks the endpoints and concatenates.

**The distinction that matters, drawn carefully.** Fathom making that API call would break invariant 2 outright — it would be the application reaching across a network to fetch configuration, which is exactly the thing that is permanently forbidden. **A human running `curl` on their own laptop, against their own Meraki tenant, with their own API key, and then pasting the result into Fathom is a different act.** Fathom made no network call; a person did, deliberately, with their own credentials, and then performed a copy and a paste. That is the same act as a person SSHing to an SRX and pasting the output — Fathom does not care how the text got onto the clipboard.

So the honest position is: **Fathom could accept pasted Meraki API JSON without breaking invariant 2.** But three things argue against doing it soon, and they should be weighed rather than waved:

1. **It is not a configuration language, it is a set of API responses.** Meaning lives in object nesting and key names, the "document" is a stack of per-endpoint replies the human assembled by hand, and there is no vendor grammar to write a dictionary against.
2. **It normalises a workflow that looks exactly like the thing we forbid.** Our own documentation would be teaching people to run API calls against a vendor cloud. That is a reputational and cultural cost against invariant 2 even where the letter is respected, and it deserves an explicit decision rather than drifting into it.
3. **We could not establish that walking those endpoints yields everything the Dashboard holds.** Cisco's answer to "can I export my configuration" is "no", which implies the API is not a lossless serialisation of Dashboard state — and no vendor statement on API coverage was found.

**Recommendation: say no to Meraki, plainly, in the product.** If you later want the JSON route, treat it as its own decision with its own record, not as a quiet extension of the paste feature.

### One wrinkle you should know

The **Meraki-managed Catalyst** switches (C9300-M and the current "cloud management with IOS XE" line) are a different animal. The Dashboard's **Config history** tab shows the switch's full IOS-XE running configuration as selectable text, retained for a year, refreshed roughly every 15 minutes, with a red/green diff view. And in *device configuration* mode the switch keeps full CLI and SSH — Cisco: *"This option retains full CLI access and configuration options in IOS XE."*

That is genuinely the best copy-paste target in the Meraki ecosystem. But it is a Catalyst running IOS-XE, and supporting it is an IOS-XE parser-and-dictionary job that has nothing in common with Meraki's JSON. **It should be scoped as "IOS-XE", not as "Meraki".** (Note also: Cloud Monitoring for Catalyst reached end of service 31 March 2026 — any scoping must be against the successor product.)

---

## 3. Parser families

The expensive part of a platform is the parser and the dictionary, not the vocabulary. Grouped by the *shape* of the text:

### Family A — Set-form / full-path-per-line
**Members: Junos (SRX/MX/EX) · PAN-OS `set` output**

Every line is a complete statement carrying its own path from the root of the tree. No block context to maintain, no indentation to track. This is the family we already have working.

**How close is PAN-OS set-form to Junos set-form? Very — and this is the highest-value finding in the whole exercise.**

What is genuinely shared, and these are the load-bearing parts:
- literal leading `set`, then a whitespace-delimited path from the root, then the value(s);
- exactly one statement per line, no continuations;
- inline bracketed lists with inner spaces: `[ aes-128-cbc 3des ]` — same convention both sides;
- double-quoted tokens for names containing spaces;
- the same generative idea ("the commands needed to recreate this from the top"), so path-prefix folding and tree-building transfer directly.

What genuinely differs, and each is a named, bounded fix rather than a rewrite:

| # | Difference | Fix |
|---|---|---|
| (a) | PAN-OS interleaves bare `[edit]` prompt-echo lines into `show` output. Junos does not. | Accept only lines beginning `set `; everything else to residue. |
| (b) | Names containing spaces are **sometimes unquoted** — a Palo Alto KB writes `set network ike gateway NewYork VPN authentication pre-shared-key key paloalto` (object name "NewYork VPN") three lines from a properly quoted `"Virtual Router 1"`. **This hazard is fully open**: the verifier established that the one file cited as counter-evidence (`api-lab.paloaltonetworks.com/lab-config-set.html`) is a hand-authored *lab input* file, not `show` output, so its quoting reflects a lab author's typing, not device behaviour. | Dictionary must know each node's arity. Where it cannot split unambiguously, emit residue — never guess. |
| (c) | A **third quoting form Junos has no equivalent for**: single quotes wrapping a value that itself contains double quotes — `set dynamic-user-group dug1 filter '"tag01" or "tag02"'`. A tokenizer that knows only `"` will shatter this into bogus tokens and silently corrupt group membership. | Tokenizer fix: single-quote-outside / double-quote-inside values. |
| (d) | **Value-less `set` statements**: `set shared application`, `set schedule`, `set service-group` — a path with no value at all. A fold that assumes "last token is the value" builds the wrong tree. | Fold fix. |
| (e) | Scoping prefixes differ: PAN-OS `set vsys vsysN …`, `set device-group …`, `set template …` where Junos has `set groups …` / `set logical-systems …`. | Dictionary/modelling, not lexing. |
| (f) | Junos set-form can carry `deactivate` / `activate` / `delete` / `annotate`; PAN-OS `show` emits only `set`. | Fewer verbs, not more. No work. |
| (g) | PAN-OS set-form carries **no version marker**. The XML form does (`<config … version="9.1.0">`). | Accept; record which format the paste came from. |
| (h) | **Panorama-pushed configuration is not in the firewall's local `show`.** It needs `show config pushed-shared-policy` / `pushed-template` / `merged`, which are XML-only. Any Palo Alto estate managed by Panorama — which most large ones are — cannot be captured completely from the set path alone. | A real completeness caveat, not a parser problem. Must be surfaced to the user. |

**Engineering budget for PAN-OS: a new dictionary, three parser fixes (a)(b)(c), and one fold fix (d). Not a new parser.**

### Family B — Indented blocks ("IOS-like")
**Members: Arista EOS · Cisco NX-OS · TP-Link Omada switches · Sodola upper tier / the OEM "nos" CLI · Meraki-managed Catalyst (IOS-XE)**

A child line means nothing without its parent — `ip address 10.10.10.0/31` is meaningless without the `interface Ethernet1` above it. Every member needs a **block-context stack** driven by indentation. None of them has anything resembling `| display set`; that was searched for on Arista specifically and found not to exist, and the family split in the widely-used `hier_config` library corroborates it.

**They can share one front end, but only if it is parameterised.** The differences are small, mechanical, and each one silently destroys config if you get it wrong:

| | Indent unit | Separator | Terminator | Header |
|---|---|---|---|---|
| **Arista EOS** | **3 spaces per level, arbitrary depth** | `!` appears **indented, as a sibling inside a block**, not only at column 0 | `end` | `! Command: show running-config` |
| **Cisco NX-OS** | 2 spaces | `!` **not** observed as a block separator; boundaries are indentation alone | not confirmed | `!Command:` / `!Running configuration last done at:` / `!Time:` |
| **TP-Link Omada switch** | 1 space under `vlan`, 2 under `interface`, 0 under DHCP pools | **`#`** is the separator (`!` appears once, on line 1, carrying the model name) | `end` | `!SG3428XMP` |
| **Sodola / OEM nos** | **1 space** (verifier measured every line; the researcher's "two spaces" was wrong) | `!` | — | `!` then `no service password-encryption` |

Two hard rules fall out of the verifications:

- **On Arista, depth — not `!` — is the structural signal.** A parser that terminates a block at the first `!` will, on a real EVPN config, hoist `vlan 10`, `address-family evpn` and `vrf evpn-vrf` to top level and lose the entire EVPN and VRF configuration. Verified against a real vEOS 4.23.5M capture.
- **On NX-OS, tolerate `!` as residue; never depend on it and never treat it as an error.** No complete vendor-published NX-OS running-config could be found by either the researcher or the verifier, so the absence of `!` separators is *unproven*, and NX-OS demonstrably emits bare `!` lines in config-shaped output elsewhere.

Family-B ingest hazards that are not about grammar at all, and which our residue path must survive:

- **Arista**: `banner login … EOF` heredocs (arbitrary text, may contain `!`); `!!` mode comments inside a stanza; and **any statement whose payload is a shell command line** — `daemon TerminAttr / exec /usr/bin/TerminAttr … -ingestauth=key,IngestKey`, and `event-handler … action bash sudo sed -i 's:^username vagrant …'`. Quotes, colons and whole sed programs live inside a config statement.
- **TP-Link Omada**: the real export file ends `e n d \r \n \0` — **a trailing NUL byte**, which makes `file` report "data" and GNU grep refuse it as binary. And **line endings are mixed and syntactically load-bearing**: in *both* real files, from different repos and different models, every `vlan <N>` header line terminates with a bare LF while every other line is CRLF. Split on `\r\n` and you lose every VLAN header; split on `\n` and every other line carries a stray `\r`. Also documented: these switches **drop characters mid-token** from terminal output — "spanning-tree" arriving as "spnning-tree", "vlan" as "van", "1/0/6" as "10/6" — across four models, reported to `oxidized` twice years apart, closed as stale rather than fixed. **Prefer the file export over terminal scrape, and treat unparseable tokens as possible corruption rather than merely unknown syntax.**
- **Sodola/OEM**: `vlan 1;100` — semicolon-separated VLAN list on one line; capitalised `Interface` keyword. A Cisco IOS parser gets most of the way and then quietly mis-handles both.

### Family C — Nested documents (XML / JSON)
**Members: OPNsense (XML, and JSON via `pluginctl -g`) · PAN-OS (`xml` and `json` formats) · Meraki API responses (JSON only)**

Structurally cheap — a generic fold from a nested document into a path tree serves all of them. **The cost is entirely in the semantic model, not the reader.** Nothing here is line-oriented; no line means anything on its own.

OPNsense specifics that a reader must know before it meets a real file: the shipped `config.xml.sample` is the factory *seed* and is misleading. Real in-service files carry **attributes** the sample never shows — `version`, `persisted_at`, `description` on every model mount root, and a `uuid` on every array item, with cross-references made **by uuid attribute**. Model subtrees also mount **outside** `<OPNsense>` (`/cert+`, `//hasync`, `//system/backup/*`), and one plugin creates its own top-level `<Pischem>` element at the document root — so any scan must be **whole-document**, never scoped to `<OPNsense>`.

### Bottom line on families

- **Two front ends buy five of the six platforms:** the set-form reader we already have (Junos + PAN-OS) and one parameterised indented-block reader (Arista + NX-OS + Omada switches + Sodola upper tier + Catalyst).
- **A third, nested-document reader** buys OPNsense and gives PAN-OS a second route.
- **Meraki proper fits none of them** and should not be forced into one.

---

## 4. The secret list, merged

Every credential form found across all six platforms. The ingest gate must destroy all of them; a missed one is a security defect.

### 4.1 Shapes that defeat keyword-anchored redaction — read this first

These are the classes that a rule list keyed on `password` / `secret` / `key` will **not** catch. They are the reason the gate cannot be an allowlist of known field names.

1. **Secrets inside a free-form shell command line.** Arista `daemon TerminAttr / exec /usr/bin/TerminAttr … -ingestauth=key,IngestKey` — the key is a comma-separated field inside a shell argument. Same hazard in Arista `event-handler … action bash …`. Generalise: **any statement whose payload is a command line.**
2. **Secrets embedded in a URL.** OPNsense `mmonitUrl`, documented by the vendor as `https://user:pass@192.168.1.10:8443/collector`. The element name contains no credential word at all.
3. **Secrets under names with no credential word.** OPNsense `otp_seed` (a plaintext TOTP seed — whoever holds it mints valid second factors forever) and `apikeys`; Arista and the Sodola/OEM NOS `key-string`; Meraki `communityString` / `v2CommunityString`.
4. **Secrets with no type marker at all.** Sodola/OEM `ip ospf authentication-key <plaintext>` — the manual states "If no option, specify plaintext key by default", so the key can appear bare, defeating any rule anchored on a `0|7` digit.
5. **SNMP community strings on every platform that has SNMP.** Never hashed, never has an encoding variant — the community name *is* the password.
6. **Reversible obfuscation dressed as encryption.** Type-7 on Arista (vendor-documented as reversible) and on Cisco; TP-Link Omada types 6 and 7 are **symmetric**, and the master key that protects them (`key config-key general key`) can sit in the same file — a **self-decrypting configuration**. Cisco NX-OS BGP `password 3` (3DES) and `password 7` are likewise reversible. **Treat every one of these as cleartext.**
7. **The paste's own envelope.** OPNsense encrypted backups begin `---- BEGIN config.xml ----`; Meraki pastes routinely arrive with `Authorization: Bearer <key>` or `X-Cisco-Meraki-API-Key:` attached. Reject the first, destroy the second.

### 4.2 Per-platform enumeration

**Arista EOS** — local user password hash (`secret sha512 $6$…`, `secret 5 $1$…`, and `nopassword`); `aaa root secret`; `enable password`; `boot secret`; TACACS+ key (global and per-host); RADIUS key (global, per-host, proxy client, server-probe); **SNMPv1/v2c community** (cleartext, and Arista's own tooling classes the community *name* as a secret); SNMPv3 auth and privacy keys (two secrets on one line, plus a sensitive `localized <engineID>`); NTP authentication key; IPsec `shared-key`; MACsec CAK; BGP `neighbor … password 7`; OSPF `authentication-key` and `message-digest-key`; IS-IS key; MPLS RSVP password; 802.1X passphrase; LDAP bind password; certificate-enrolment token/secret (**six forms** — `credentials enroll|re-enroll token|username…secret|secret`); CloudVision/TerminAttr ingest key; InfluxDB password; CVX Redis password; **VRRP peer authentication key** (`vrrp <id> peer authentication ietf-md5 key-string …` — added by the verifier; Arista's own templates hide it and the researcher missed it); **`session shared-secret profile` secrets** under `management security` (the key-rotation mechanism for TACACS/RADIUS/routing keys — also added by the verifier).

> **Critical:** EOS's own `show running-config sanitized` is **not self-identifying**. Genuine captures still read `! Command: show running-config`; the word "sanitized" never appears. **You cannot tell a sanitized paste from an unsanitized one by inspection**, so no badge may claim otherwise and the gate must run unconditionally at full strength. Nor is `sanitized` sufficient: nobody could find a document enumerating what it actually redacts, and it is highly unlikely to catch the TerminAttr ingest key.

**Cisco NX-OS** — `username … password [0|5|8|9]`; `snmp-server community` (cleartext); `snmp-server user … auth <alg> <pass> priv <pass>` (two secrets per line); TACACS+ key global and per-host; RADIUS key global and per-host (**may be quoted** — the gate must handle a quoted token); BGP `password [0|3|7]` on a bare `password` line **inside a block**, so the gate needs block context or a bare-`password` rule; keychain `key-string [0|6|7]` (default is **unencrypted**); `key config-key ascii` (destroy defensively); **`ntp authentication-key 42 md5 aNiceKey` / `ntp authentication-key 12 aes128cmac password 0|6|7`** — added by the verifier, absent from the original list, with a trailing encryption-type digit that must not be mistaken for the secret.

**PAN-OS** — `phash` (salted MD5-crypt admin password; the single clearest gate keyword, present in both set and XML forms); IKE/IPsec pre-shared keys in **three** shapes — the current `-AQ==…` master-key envelope, the legacy pre-9.0 blob, and **cleartext in set form** (`… pre-shared-key key paloalto`); **any token containing `-AQ==`** (the general master-key ciphertext container — blanket destroy rule); **`snmp-community-string public` in cleartext**, which appears in Palo Alto's own documented `show` output and is the likeliest secret to slip past a gate built around `phash` and `-AQ==`; LDAP bind / RADIUS / TACACS+ / Kerberos secrets (vendor class statement: "stored as a salted hash or in encrypted form (AES-256)"); **certificate private keys — these need their own gate rule**, named explicitly by the vendor as living in configuration files, and the original write-up gave them no textual shape and no keyword; API keys pasted alongside from troubleshooting sessions.

> **Useful, and worth telling users:** PAN-OS **sanitises password data out of a configuration exported by a non-superuser or as part of a tech-support export** — the vendor documents the resulting error verbatim. That is a first-class, vendor-supported way for an operator to produce a secret-free config at source. It applies to *file export*; assume the CLI `show` path does **not** sanitise.

**OPNsense** — local user bcrypt hash; **`otp_seed` (plaintext TOTP seed)**; API key + `$6$` secret, two shapes on one line; LDAP bind password; RADIUS secret; **X.509 certificate private keys and CA private keys** (base64 of the PEM, so *no* `-----BEGIN PRIVATE KEY-----` banner to match on — base64-decoding is required to recognise them); IPsec PSKs in **both** the current camelCase path and the legacy hyphenated `pre-shared-key` path (both can coexist on a partially-migrated box); IPsec keypair private keys; WireGuard server private key and peer PSK; OpenVPN legacy `shared_key`/`tls`; OpenVPN MVC `password` and `auth-gen-token-secret`; **OpenVPN `StaticKeys/StaticKey/key`** (the modern home of tls-crypt/tls-auth — added by the verifier; on a current box the researcher's gate would have missed it); WPA passphrase; PPPoE password; CARP password; **HA sync password (the *peer* firewall's admin password)**; alias fetch credentials; Kea DDNS TSIG secret; Monit `password` / `httpdPassword` / **`mmonitUrl`** (credentials in a URL) / `username`; **`opendns/password`** (a legacy root node with no model — added by the verifier); **`//system/backup/*` — Nextcloud password *and* the passphrase that encrypts every off-box backup, sftp and git `privkey` (plaintext SSH private keys), mailer credentials** (added by the verifier; note the irony that the credential protecting every off-box copy of the config lives inside the config); plugin secrets generally, including caddy's `TlsDnsApiKey` and `basicauthpass` under a **top-level `<Pischem>`** element. *(Correction carried: `mmonitRegisterCredentials` is a boolean, not a credential — a false positive in a security-critical list.)*

**TP-Link Omada switches** — `user name <n> privilege <p> secret <4|5|8|9> <blob>` (observed live in a real file; the blob contains `$ : < > [ ] { } | * / ( ) , - .` and will look like garbage to a naive lexer); `user name … password 0 <plaintext>` (**default encryption type is 0**); `password 6|7 <blob>` — **symmetric and reversible**, and the vendor guide even says the blob is one "which you can copy from another switch's configuration file"; `enable password` / `enable secret`; `snmp-server community` (cleartext, no encoding option); **`snmp-server user … cmode MD5 cpwd <auth-pw> emode DES epwd <priv-pw>` — two cleartext secrets, no encoding variant** (added by the verifier; the original listed SNMPv3 only for the *gateway*, the one device class that emits no config text, and missed it on the only class that does); RADIUS `key` (always the **last** token — easy to over-match with a greedy regex); TACACS+ `key`; **MACsec `macsec mka psk ckn <name> cak <string>` — cleartext, per-interface, the link-layer encryption master key, entirely absent from the original list**; key-chain `key <id> key-string <string>`; OSPF MD5 and RIP keys; **`key config-key general key`** (the master key protecting the type-6/7 blobs in the same file).

> **Good news, positively established:** HTTPS certificate and private key are fetched from TFTP by reference (`ip http secure-server download key …`) and are **never embedded** in the config text. That is a clean documented "no" to the first question a gate asks of any switch.
>
> **Do not use `oxidized` as a completeness oracle.** It redacts four things; the vendor documents at least ten, and oxidized leaks RADIUS and TACACS+ shared secrets. Its overlap is evidence those four exist, not evidence the set is complete.

**Sodola / the OEM "nos" firmware** *(all from the sibling-brand XikeStor manual — no Sodola CLI document exists)* — `username admin privilege 15 password 0 admin` (**in the default running-config, so in every capture**); `enable password [0|7]`; `snmp-server community {ro|rw} {0|7} <string>`; `ip ftp username … password`; TACACS+ key **global *and* inline on the host statement**; RADIUS key **global *and* inline on the host statement** (both inline forms added by the verifier — a rule anchored on `radius-server key` alone misses the mid-line one); **SNMPv3 `snmp-server user … auth {md5|sha} <word>` and privacy `<word>`** — confirmed relevant on Sodola's *own* hardware, whose manual documents Authentication Method and Privacy Method fields; **NTP `ntp authentication-key <id> md5 <value>`**; **OSPF `ip ospf authentication-key` (can be bare plaintext, no type digit) and `ip ospf message-digest-key <id> MD5 …`**; **RIP key-chain `key-string <text>`**; default web credentials `admin/admin` visible in plaintext on the User Management page. *(Correction carried: on this firmware `password 7` is documented as **MD5**, not Cisco-style reversible type 7. Treat as a live credential regardless.)*

> **Trap:** `service password-encryption` on this firmware covers **only** `enable password`, `ip ftp` and `username`. SNMP, RADIUS, TACACS+, NTP, OSPF and RIP key material stays cleartext regardless — so enabling it gives a false sense that a capture is clean.

**Meraki (JSON, if ever accepted)** — `psk` (wireless PSK, unmasked for full-access admins); third-party VPN `secret`; BGP MD5 `password`; OSPF `passphrase`; SNMPv3 `passphrase`; **`communityString` and `v2CommunityString`** (added by the verifier — an SNMP community string is a first-order miss in a tool whose premise is destroying credentials); per-client iPSK passphrases (potentially hundreds in one paste); MV camera PSK and 802.1X password; cellular APN password; **Apple VPP tokens** (`vppServiceToken`, `contentToken`, `parsedToken.hashedToken`); RADIUS `secret`, LDAP/AD bind passwords, local-status-page password and PPPoE password (request-body only, but a human pasting a provisioning script brings them); embedded PEM certificates as single JSON strings with literal `\n` escapes; and the Dashboard API key in the pasted `Authorization: Bearer` header. *(Correction carried: the `sharedSecret` in `/webhooks/alertTypes` is a documentation sample, not a live credential — while the real webhook secret's GET-safety was never examined.)*

> **If Meraki-managed Catalyst is ever in scope, this JSON-shaped list is the wrong model entirely.** An IOS-XE running-config carries `enable secret`, `username … secret`, `snmp-server community`, `crypto isakmp key`, `key-string`, and radius/tacacs `key` lines — none of which a JSON-key-based rule set would catch.

---

## 5. What could not be established

Stated plainly, per platform. These are gaps, not oversights.

**Arista EOS**
- What `show running-config detail` does. The keyword provably exists; no Arista document describes its effect.
- **There is no vendor command-reference entry for `show running-config` anywhere in Arista's public manual.** Everything we know about its keyword set comes from a DISA STIG, Arista's Ansible documentation, and NAPALM's driver — not a vendor syntax entry. **This is the weakest link in the Arista answer** and should be re-verified against a live switch's `show running-config ?`.
- **The exact set of statements `sanitized` redacts.** Proven for `aaa root secret` and `username … secret`; unproven for SNMP communities, SNMPv3 keys, `key 7` on TACACS/RADIUS hosts, BGP passwords, IPsec `shared-key`, MACsec keys, and — most worryingly — the TerminAttr ingest key. **The gate must not treat `sanitized` as sufficient.** The verifier independently tried and failed to settle this, and documented the trap: AVD-generated files and real device captures emit the *identical* `<removed>` token, so only the `! Command:` header distinguishes them.
- Whether `sanitized` exists on every EOS release; no floor version found.
- Which 7130-series models run EOS and which run something else.
- The 7000-series model enumeration (7010/7050/7060/…) is asserted; only the 7150S and vEOS were actually verified.

**Cisco NX-OS**
- **Whether `show running-config` output contains lone `!` separators, and whether it ends with `end`.** No complete vendor-published running-config exists — both the researcher and the verifier searched and failed. **A parser must not assume either way.**
- Whether the type-6 primary key has any textual representation in running-config. Cisco's own procedure implies one exists; no page shows it.
- Whether a custom RBAC role can be granted `show running-config` (docs state only that built-in `network-operator` cannot). If it can, that is the right least-privilege advice for users, and we cannot give it yet.
- **The Nexus 7000 per-VDC claim and `switchto vdc` are unsourced** — asserted from memory, with the cited page saying only that the N9K supports a single VDC. **Do not put this in user-facing instructions until it is looked up.**
- Practical maximum config size; any documented terminal truncation.

**PAN-OS**
- **Whether real `show` output ever emits an object name containing spaces unquoted.** The vendor's own KB does so once and quotes correctly three lines away. The file believed to settle this in our favour turned out to be a lab input file. **This hazard is open.**
- Whether the CLI `show` path sanitises `phash` for a non-superuser the way file export does. **Assume it does not.**
- Whether LDAP/RADIUS/TACACS+ secrets literally carry the `-AQ==` prefix. The class statement is established; the specific prefix is not.
- The default output format of operational-mode `show config running` when the format has never been set.
- Whether `[edit]` lines appear only at the end of `show` output or throughout a large dump.
- Whether PAN-OS admin roles gate configure-mode `show` at all. *(The original said "no gate found"; that is absence of evidence and should be recorded as unknown.)*

**OPNsense**
- Whether OPNsense offers **any** sanitised export. Extensive source reading found none — the download is an unfiltered `file_get_contents` — but proving a negative from source is weaker than reading a positive.
- A complete enumeration of plugin secrets. Two of roughly a hundred plugin models were opened. **The list is a floor, not a ceiling; an allowlist gate will miss plugin secrets by construction.**
- Whether pasting a real production `config.xml` through a browser textarea is practical in size terms. No file was measured; several certificates plus RRD data could make it multi-megabyte.
- Whether Business Edition / OPNcentral changes the export mechanism. Only the community repo was read — and the claim "the export mechanism is the same code" is unsourced and should be struck.
- Note also: `/conf/config.xml` is the whole *configuration* but **not the whole machine state** — SSH host keys, captive-portal vouchers and hand-dropped include files live outside it.
- *(Added 2026-08-15, with §1.1.)* **The rules-CSV delimiter.** Attested as `;` by one pasted header
  (issue #9861) and by nothing else; the exporter script emits JSON and the CSV is assembled above
  it, so the second source confirms the columns and not the separator. Fathom sniffs it.
- *(Added 2026-08-15; re-checked 2026-08-16.)* **Whether the 0-byte export of issue #10595 is
  real.** Reported 22 July 2026 against 26.7.1. Open, unanswered and with zero comments on
  2026-08-16, re-established independently rather than carried forward; no second report and no
  closing commit found on either date. Recorded as reported-and-unresolved, deliberately not
  upgraded to established.
- *(Added 2026-08-15.)* **Whether the export quotes fields containing the delimiter, and how.** No
  document, no example, and the exporter script does not do the writing. Fathom implements RFC 4180
  double-quote doubling *and* accepts unquoted fields, because that is the union of the plausible
  behaviours rather than a guess at which one ships.

**TP-Link Omada**
- **Whether the ER gateway's own backup file is text, binary or encrypted.** No vendor statement; the only claim found is an unsourced blog post with no file excerpt. **This is the largest open gap on the platform, because the gateway is where the IPsec/VPN and firewall state lives.**
- Whether `show running-config` still answers over direct SSH to a controller-adopted switch. The controller-side route ("Import CLI from Device… import its running config") is established; direct SSH is not. **And the load-bearing detail of the recommended workflow — that the imported text lands in a selectable, copyable field — is an inference, not something the cited document says.**
- **The default on/off state of `service password-encryption`.** The default *encryption type* for an entered password is 0 (cleartext), but TP-Link never states whether the global function ships on or off. **The gate must assume cleartext is possible.**
- Whether the exported `.cfg` is byte-identical to `show running-config`, or a serialisation of `startup-config` or the third config object, `backup-config`. The extra `!MODEL` header line suggests it is not running-config.
- Whether the plain-text export holds across the whole switch range. Two models verified; Campus/L3-stackable, Aggregation and industrial lines not.
- Whether the character-dropping corruption affects the file export as well as terminal scrape. Every report is terminal-based — suggestive, not conclusive.
- Whether the ER gateway CLI is reachable at all once adopted by a controller.

**Sodola** — the largest set of unknowns of any platform here.
- **Whether `show running-config` exists on a Sodola switch at all.** No Sodola document contains a single CLI command. The command is documented only for a sibling brand on different silicon (RTL9303 vs RTL9313). Nobody has published a first-hand Sodola capture.
- **The format of the web UI's Configuration Backup file, on any model.** Every manual says "download the configuration file"; none names an extension, a MIME type, or whether it is text.
- Whether the 48-port L3 has a CLI, console, telnet or SSH. Its manual documents none, its Tools menu is Ping and Traceroute — yet its filesystem holds `startup-config.conf` at 1.5 K.
- Serial console line settings for any Sodola model that has a console port.
- Which models have a console port beyond the SL-SWTG3C12F (present) and SL510S-4T2XS (absent).
- Whether the L2+/L3 CLI and the 48-port NOS are the same firmware (differing config filenames say probably not).
- Any Sodola-published CLI manual, version numbering, release history, breaking changes, or known-bad firmware. **Sodola's own website is behind a Cloudflare challenge and returned 403 to every attempt** — the manual index, every product page, and the firmware page. Everything known comes from the CDN hosting the PDFs, from ServeTheHome, from the OpenWrt forum, and from a third-party mirror of a sibling brand's manuals.

**Meraki**
- Whether `show running-config` runs in Cloud CLI read-only mode. Read-only gives User-Exec; `show running-config` is privileged-EXEC. Combining those is inference. *(Largely moot: the vendor states "Administrators cannot download session logs from configuration mode sessions" — so the capture path and the privileged path are mutually exclusive by design.)*
- Whether **any** Dashboard CSV export contains configuration rather than inventory or telemetry. Everything confirmed is inventory/telemetry.
- Whether the Dashboard switch-ports page has a working CSV download. Community posts assert it; two independent grep passes over the vendor's own pages found nothing but site chrome.
- The exact set of fields masked for read-only vs full-access admins. Documented only for the wireless `psk`. **Assume a read-only admin's paste is no safer.**
- Whether MX/MS/MR expose any undocumented serial console or debug shell. No positive evidence found; absence of documentation is not proof of absence.
- **How complete the API-JSON route actually is** — whether walking the endpoints yields 100% of what the Dashboard holds. Cisco's "you cannot export the configuration" implies it does not.
- Nothing from `community.meraki.com` — it returned HTTP 503 and an expired certificate on every attempt. No forum claim underpins anything above.

**Across all platforms — the one that matters most for us**

> **No platform except Junos currently has a golden fixture produced by a named human from a real device.** For Nexus and PAN-OS this was called out explicitly: no complete, unabridged running configuration with framing and whitespace intact exists on either vendor's site — every published excerpt is a fragment. Building a dictionary from those excerpts would encode a documentation author's hand-typed quoting as if it were device behaviour.
>
> **Arista is the exception**: real device captures exist publicly and were verified — the `suzieq` integration fixtures (eight records, `"devtype": "eos"`, `"cmd": "show running-config sanitized"`, real vEOS 4.23.5M leaf/spine/exit hosts) and a `codilime` vEOS 4.25.0F capture. Those should be Arista's goldens, **not** the NAPALM mock the original research cited, which the verifier proved is a hand-authored unit-test file whose `<removed>` token NAPALM writes itself.

---

## 6. Recommended order

Ordered against your stated priority — security, then usability for user and maintainer, then dynamic ability — and against the fact that Juniper SRX/MX/EX is primary and the rest are in support.

**Before any of it: two things gate the whole queue.**

**Gate A — the ingest gate must be extended first.** Every platform below brings secret shapes the current `junos-srx` gate does not know: SNMP communities, secrets inside shell command lines, secrets inside URLs, secrets with no type marker, symmetric "encryption" that a master key in the same file undoes. Section 4.1 is the specification. Security is priority one, so the gate leads and the dictionary follows — not the other way round.

**Gate B — the module-size ceiling is the real constraint, and it is architectural.** The module is 820,967 bytes against a 900,000-byte ceiling: 79,033 bytes of headroom. **Every platform below is another embedded dictionary against that headroom.** The decision named in `00-ROUTE-TO-WORKABLE.md` §2 stage 1 — does the ceiling move, or does the page hand the dictionary in rather than compiling it in — must be made *before the second dictionary lands*, not after. Deciding it once is cheap; discovering it at platform four is not.

**Then, in order:**

**0. Finish Junos — MX and EX. Do this before any new platform.**
This is not on your list of six, and that is exactly why it needs saying. MX and EX are your primary kit, they are the same set-form grammar as SRX, and they cost **dictionary only — zero new parser, zero new family, zero new secret shapes**. Forty-two Junos statements are currently understood. The highest value per byte of headroom, and per hour of work, on this whole page is not a new vendor; it is finishing the one you already run.

**1. PAN-OS.**
The cheapest genuine second platform, because it lands in the family we already have. New dictionary, three named parser fixes and one fold fix — **not a new parser**. It also comes with the best security story of the six: a vendor-supported way for the operator to export a config with the passwords already stripped, which makes invariant 3 achievable at the *source* rather than only at the gate. Two things to hold: get a golden from a real firewall via a named human before writing the dictionary (the public set-form file is a lab input, not device output), and surface the Panorama caveat prominently — a Panorama-managed estate cannot be captured completely from the set path alone.

**2. Arista EOS.**
The first indented-block platform, and the one that builds the block-context machinery that then unlocks NX-OS, Omada switches, Sodola's upper tier and Catalyst. Pick it ahead of Nexus for a practical reason: **Arista is the only platform on this page with real, public, verified device captures**, so it can be built now without waiting on anyone to produce one. Its text is also the cleanest — one statement per line, honest indentation, real terminator. Two hard rules from the verification: depth (not `!`) drives block structure, or you lose entire EVPN and VRF configurations; and never let any UI claim a paste was sanitized, because sanitized output is indistinguishable from raw.

**3. Cisco NX-OS.**
Same family, second dictionary, small incremental cost once Arista exists. **Blocked on a golden**: no complete NX-OS running-config exists in public vendor documentation, so this needs a capture from a real device by a named human before the dictionary is written. Two rules carried in: tolerate `!` as residue and never depend on it, and record which command produced the paste — `show running-config` and `show running-config all` differ, and a config-diff feature that doesn't know which it's holding will report false changes.

**4. OPNsense** — *if you actually run it; otherwise defer.*
Whole configuration in one artefact, no partial-capture problem, and `pluginctl -g` gives a genuinely good scoped copy-paste surface (paste the interfaces subtree without the certificate blobs). But it opens a **third parser family**, and it is by some distance the worst secret surface of the six: certificate and CA private keys, plaintext TOTP seeds, SSH private keys, the peer firewall's admin password, and an open-ended plugin secret set that no allowlist can close. If it is not in your estate, this is the easiest item to defer.

**5. TP-Link Omada — switches only.**
Cheap once the indented-block family exists, and honestly labelled: **switches yes, gateways no, access points no, controller backup no.** Worth building mainly as a stress test of the residue path, because it carries the nastiest real-world ingest hazards on the page — a trailing NUL byte, line endings that differ *by statement type*, and a device that drops characters mid-token and has done so for years. Prefer the file export over terminal scrape. And name the `.cfg` collision in the UI: the switch's `.cfg` is plain text, the controller's `.cfg` is encrypted, and they share an extension.

**6. Sodola — do not queue it.**
Not because it is worthless, but because **it cannot be specified from documents.** Sodola publishes no CLI manual, no first-hand `show running-config` exists anywhere, the vendor's website is behind a challenge that blocks every attempt, and "Sodola" is a brand over at least three unrelated firmware stacks — so a parser written for one tier is wrong for the other two. The format we would write against belongs to a *sibling brand on different silicon*. **This one needs a device on a desk, not more research.** If you have an SL-SWTG3C12F, ten minutes on its console — `show running-config`, and `show running-config ?` — converts almost every unknown in section 5 into a fact. Until then, no order should be written.

**7. Meraki — build nothing; answer it in the product.**
The correct deliverable is a clear, sourced "not supported, and here is why" in the paste UI, quoting Cisco's own FAQ. It costs nothing and it is the honest answer. If pasted API JSON ever becomes interesting, treat it as its own decision with its own record — the invariant survives it, but the workflow it teaches deserves an explicit choice rather than a quiet extension. And if the **Meraki-managed Catalyst** path ever matters, scope it as **IOS-XE**, in family B, alongside NX-OS — not as Meraki.

**One final note on sequencing, which cuts across all of the above.** Every platform here multiplies devices, and `70` §6 names the largest requirement in the corpus with no mechanism behind it: **automatic correlation across separately-pasted configs.** Today `OP_PASTE` replaces the held estate, because merging a second paste *is* that unbuilt requirement. A fifth platform on top of an estate that can hold exactly one device is worth less than the second device. If forced to choose between platform four and correlation, choose correlation.

---

## Failure modes

1. **This survey is read as a decision.** It is not. It establishes what is possible; the order in
   §6 is a recommendation from the researchers and `00-ROUTE-TO-WORKABLE.md` owns the actual
   sequence.
2. **A verdict is trusted after the vendor changes it.** Every row carries the date it was checked.
   A capture path can be removed by a firmware release; the dates are how a future reader knows what
   is stale.
3. **§4's secret list is treated as complete.** It is the most complete list anybody has assembled
   for these platforms and it is still an enumeration from documents, not from devices. The gate
   must be built so that an unrecognised secret-shaped token is refused rather than bound — the list
   makes the gate better, it does not make it sufficient.
4. **A platform is built from documentation excerpts.** §5 records that for every platform but
   Arista and Junos, no complete real capture was found. A dictionary written against a
   documentation excerpt encodes the documentation author's typing as if it were device behaviour.

## Open decisions

1. **Which of these platforms get registered in `schema/platforms.yaml` and when.** Registration is
   cheap and reversible; a dictionary is not. The file's own Ciena precedent is the pattern: register
   the vendor, and decline to declare a platform until a config has actually been seen.
2. **Whether Sodola is attempted at all** (§5). It cannot be specified from documents. It needs a
   device on a desk — ten minutes on the console of an SL-SWTG3C12F converts almost every unknown
   here into a fact.
3. **What the product says about Meraki** (§2). The recommendation is a sourced refusal in the paste
   UI rather than silence. Wording is `54`'s.
4. **Whether pasted API JSON is ever acceptable input.** It does not breach invariant 2 — a human
   fetching text themselves and pasting it is not Fathom touching a device — but it teaches a
   workflow, and that deserves an explicit record rather than a quiet extension.

## Disagreements

1. **Against reading "yes-partial" as "yes".** Three platforms scored partial and they are partial in
   completely different ways: Omada is yes-for-switches-no-for-everything-else; Sodola is
   probably-yes-on-one-tier-and-unverifiable; Meraki is no-except-for-a-Catalyst-that-is-not-really-
   Meraki. The single word hides three different problems and the table rows, not the word, are the
   finding.

2. **Against the survey's own §6 ordering, on one point.** §6 puts finishing Junos MX/EX at position
   zero and it is right about the economics — same grammar, dictionary only. But the owner's largest
   stated requirement (`70` §6) is correlation across pastes, and a second Junos platform on an
   estate that can hold exactly one device at a time is worth less than the second device. §6 says
   this itself, at the end, and then does not apply it to its own ordering.
