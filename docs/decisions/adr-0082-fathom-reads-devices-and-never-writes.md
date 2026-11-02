# ADR-0082: Fathom reads devices and never writes to them

**Status:** accepted 2026-11-02. The owner approved sign-off card r75-work-plan with "Reading
devices" option A: *"Fathom may read a device (SSH and SNMPv3, read-only, started by a person, logins
from the vault), and never writes to it or acts on what it read by itself."* Then the owner approved
card r76-device-reading with every recommended pick (questions 1 to 5, A), adding in the thread:
*"i want it all"*. So SSH follows SNMPv3 directly rather than waiting (§4.7).

**Amends:** `.context/conventions.md` invariant 2, which read *"The application never touches a
network device. No SSH, no NETCONF, no API. All output is copy-paste. This is a permanent product
boundary, not a phase-1 limitation."* The standing note above the invariants already said the
owner's stated intent contradicts "permanent"; this record closes that gap (CLAUDE.md rule 6:
decisions reopen on merit).

**Reopens:** ADR-0066 §3's sentence *"Fathom never connects to a device and never runs Ansible"*,
for read-only fetches only. Fathom still never runs Ansible and still never pushes a change.

**Keeps, unchanged:** ADR-0045 (*"Fathom never changes a device's configuration. Not to make room for
itself, not for anything."*); ADR-0078 (Termix is the browser's path to a terminal; the server does
not talk to Termix); invariant 1 (no connection the operator did not configure); invariant 3 and
ADR-0042 (no credential in the design, none stored without being shown and chosen); CLAUDE.md rule 4
(a pasted or fetched config's credentials never arrive); ADR-0046 (a suggestion is never a fact).

## 1. What the owner said

- **r29-login** (approved 2026-10-25 15:37): SSH running read-only commands from a fixed list, and
  SNMPv3 read-only (authPriv). Refresh by hand first; a schedule (daily or weekly) later, as a
  setting per design. SNMP v1/v2c not offered. Every result is a suggestion to review.
- **r29-pull** (C, 2026-10-25): an Ansible playbook now, Fathom's own read-only fetch once the vault
  exists, *"with an ADR amending ADR-0066 §3 for read-only fetches."* This is that ADR.
- **r72** (2026-11-01): reading is fine as long as Fathom does not act on what it read.
- **r73** (2026-11-01): checks after the work may later be answered by Fathom reading the device
  over SNMP. Left unticked until this record exists.

The vault part this needs is built: ADR-0071 part two, Mode B, `vault_fathom::use_login(...)` with
the purposes `"autopopulate"` and `"check"`, refusing unless the login's owner let Fathom use it, a
second admin signed for a shared login, the login is marked "used on" that design and device, and the
caller has Draw. Each use writes a `vault_read` entry to the organisation's chain.

## 2. The invariant, as amended

> 2. **The application reads from a network device and never writes to one.** A read is started by
>    a person, or by a schedule a person set (ADR-0082 §4.5), and uses a login from the vault that
>    its owner chose to let Fathom use. Fathom never changes a device's configuration or state,
>    never sends an SNMP SetRequest, never runs a command outside its fixed read-only list, and never
>    acts on what it read: a reading becomes suggestions or check answers, and a person accepts
>    each one. Every change to a device stays copy-paste, or a file a person runs. Scoped by
>    ADR-0082; it formerly read "never touches a network device".

## 3. Facts this rests on

Read on 2026-11-02 from the sources named, not from memory (CLAUDE.md rule 1).

| Fact | Source |
|---|---|
| SNMPv1 and SNMPv2c *"support only trivial authentication based on plain-text community strings"* and are *"fundamentally insecure"*; using SNMPv3 instead is *"strongly recommended"*. | RFC 3410 (December 2002, Informational), Abstract and §8.2 |
| SNMP's operations that read are GetRequest, GetNextRequest and GetBulkRequest; SetRequest is the one that assigns values on the device. | RFC 3416 (STD 62, December 2002), §4.2.1 to §4.2.5 |
| SNMPv3's security levels are noAuthNoPriv, authNoPriv and authPriv; privacy requires authentication. The original protocols are HMAC-MD5-96 (required), HMAC-SHA-96 (recommended) and CBC-DES. | RFC 3414 (STD 62, December 2002) |
| AES for SNMPv3 privacy is CFB128-AES-128 (`usmAesCfb128Protocol`). | RFC 3826 (June 2004, Proposed Standard) |
| SHA-2 authentication for SNMPv3: HMAC-SHA-224/256/384/512; implementations *"MUST support usmHMAC192SHA256AuthProtocol and SHOULD support usmHMAC384SHA512AuthProtocol."* It does not deprecate HMAC-MD5-96 or HMAC-SHA-96. | RFC 7860 (April 2016, Proposed Standard) |
| NIST withdrew DES (FIPS 46-3) because *"it no longer provides the security that is needed."* | nist.gov news release, 2 June 2005 |
| An SSH client's first contact is trust-on-first-use unless a person confirms the host key; Junos's SSH `connection-limit` and `rate-limit` are global to the service, and a retrying client can lock out the account a person needs. | ADR-0045 §2.3 and §2.4 (search summaries, 2026-09-14, marked there) |

**Could not establish here:** whether HMAC-MD5-96 inside HMAC is practically breakable today. MD5 is
refused below as policy (a newer protocol exists on the same devices), not on a cited break. Each
platform's read-only role (Junos `read-only` class, Arista `network-operator`, and so on) is looked up
with a read date by the build thread, per platform, before that platform is selectable.

## 4. Decided

### 4.1 What "read-only" means, and where it is enforced

Two layers, because a check inside Fathom can only prove what Fathom sends, not what the device
allows (CLAUDE.md rule 2: test against what a real device accepts).

1. **On the device: a read-only account.** The login Fathom uses must be a read-only monitoring
   account (ADR-0042 already names this as Mode B's intended occupant). For SNMPv3, a USM user whose
   VACM access has a read view and no write view. For SSH, the platform's read-only role. Fathom
   cannot see the device's configuration of that account, so the vault asks the person to tick
   *"This is a read-only account"* before Fathom may use it, and the device panel shows which logins
   carry that tick. This is the real boundary.
2. **In Fathom: nothing that could write is reachable.**
   - SNMP: the reader's encoder builds only GetRequest, GetNextRequest and GetBulkRequest. There is
     no SetRequest code path to turn on. A test asserts the reader's PDU type is never `0xA3`
     (the `[3]` tag RFC 3416's ASN.1 gives SetRequest-PDU).
   - SNMP reads only object identifiers from a fixed list per purpose (system, interfaces, entity
     inventory, LLDP, bridge and ARP tables). No full walk: some tables, such as
     `usmUserTable` and community tables, describe credentials.
   - SSH: one `exec` request per command, no PTY, no interactive shell, no agent or port forwarding.
     Each command is an exact string from a per-platform list, cited with a read date; nothing a
     person types is ever sent. Learn mode shows the command that ran.

### 4.2 What happens to a reading

- **Through the gate first.** Text from SSH passes the same Rust redaction gate as a paste, in the
  reader, before it reaches the server's storage or a browser (rule 4). SNMP values pass the gate's
  detector too, since `sysDescr` and `ifAlias` are free text a person typed on the device.
- **Suggestions, never facts** (ADR-0046). Differences from the drawing show as "differs from
  drawing"; nothing is written into the design until a person presses Add or Accept, one undo step.
- **Check answers.** A check after the work (r73) can be answered by a reading. The answer shows
  what was read, when, and whose press started it. Recording the plan still waits for a person.
- **Never acts.** No reading starts a plan step, opens or closes an It's down, sends an alert,
  changes another device, or starts another read. An AI connection (ADR-0077) may *see* a reading if
  its key allows that detail, and may *propose* from it like anything else; it cannot start a read.

### 4.3 Where the read runs (card r76-device-reading, question 1, A)

In a **separate reader helper**, the way the Passbolt helper is separated (ADR-0071 part four). The
server passes it one job at a time over a Unix socket: the address, the protocol, the fixed command
or OID list, and the login `use_login` returned, wiped after the job. The helper holds the only
network-capable SNMP and SSH crates; the server gains none. Its dependency record, licence check and
the network-crate denylist (ADR-0032 item 5, T-P1-a) are written before it is built, and its new
packages go to the owner on a card first, as Passbolt's did.

Rejected: reading inside the server. Fewer moving parts, but the server's dependency graph would
carry an SSH client and the denylist could no longer say "nothing in the server opens a socket to a
device".

### 4.4 Who may read what (card r76-device-reading, questions 2 and 3, A)

- **Off by default, twice.** The server operator turns device reading on with a setting
  (`FATHOM_DEVICE_READ`), and then a Steward turns it on for their organisation. That keeps
  invariant 1: no connection the operator did not configure.
- **Only to management ranges a Steward lists.** A read goes only to a device's management address,
  and only when that address is inside a range the Steward listed (for example `10.20.0.0/24`).
  Loopback, link-local and the server's own addresses are refused whatever is listed. Ports are 161
  for SNMP and 22 for SSH unless a Steward changes them per range. Without this, anyone with Draw
  could type any address on a device and have the server connect to it.
- **Draw starts a read.** Anyone with Draw on the folder can press Read on a device whose login is
  marked "used on" it. The vault's own rules (§1) still apply on top.
- **No retry on a refused login.** One attempt; a refusal is shown, not retried, so Fathom never
  burns the lockout budget an engineer needs (ADR-0045 §2.3). One connection per device at a time.
- **Host keys confirmed by a person.** The first SSH read shows the host key fingerprint and waits for
  a person to confirm it; a changed key stops every read of that device until someone confirms again.

### 4.5 SNMPv3 settings (card r76-device-reading, question 4, A)

authPriv only. Offered, best first: HMAC-SHA-512 or -256 (RFC 7860) with AES-128 (RFC 3826);
HMAC-SHA-96 is accepted and marked *older* on the login. HMAC-MD5-96 and CBC-DES are refused. DES on
NIST's withdrawal (§3); MD5 as policy (§3, "could not establish"). noAuthNoPriv and authNoPriv are
refused. SNMP v1 and v2c are not offered (RFC 3410 §8.2).

### 4.6 When reads happen

By hand first (r29-login). A schedule per design (daily or weekly) is allowed by this record but is
not built in the first part; it gets its own card when it is, because a schedule is the one case
where no person presses anything at the time.

### 4.7 What is built first (card r76-device-reading, question 5, A)

SNMPv3 first: model, serial and firmware (ENTITY-MIB, `sysDescr`), interfaces and their up/down
state, LLDP neighbours, and the MAC and ARP tables, feeding the readers that exist and the checks
after the work. SSH from the fixed list second, straight after (the owner wants both), reusing every paste reader. Waits on #274 for the
checks after the work.

## 5. What changes elsewhere

- `.context/conventions.md` invariant 2: replaced with §2's text; the standing note says invariant 2
  is amended by this record.
- ADR-0066 §3: its sentence stands for Ansible and for changes; read-only fetches are governed here.
- ADR-0078 "Why invariant 2 still holds" stays true: Termix is unchanged by this record.
- Wording: do not say Fathom "never connects to your devices" anywhere new. Say *"Fathom can read a
  device with a read-only login you chose; it never changes one."* The four forbidden sentences
  (CLAUDE.md rule 5) stay forbidden.

## Not decided here

- The SNMP and SSH crates, chosen by the build thread with a dependency record and the owner's tick.
- Each platform's read-only role and command list, looked up per platform with a read date.
- Scheduled reads (§4.6), NETCONF and controller APIs (UniFi, Omada; r29-login left these unticked).
