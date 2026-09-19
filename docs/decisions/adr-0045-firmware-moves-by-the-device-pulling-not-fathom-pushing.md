# ADR-0045 — Firmware moves by the device pulling it, not by Fathom pushing it

**Status:** Accepted, 2026-09-14
**Owner direction, 2026-09-14:** *"i need to be able to spin this up, and also get SCP firmware
uploading up and going the focus. I have a Juniper that needs updating. But i want it done
correctly, and securely as much as possible please."*
**Amends:** `docs/REBUILD-PLAN.md`'s owner decision of 2026-09-11, which placed *"monitoring and
integration with live systems"* **beyond alpha and beta, noted, not scheduled**. The owner has
reopened that on merit, which `CLAUDE.md` rule 6 allows. This record is the reopening.
**Rests on:** the research round of 2026-09-14, whose access record matters as much as its findings
— `juniper.net` was unreachable from this environment, so roughly four fifths of the Juniper facts
below are search summaries describing vendor documentation rather than verbatim reads of it. Every
one is marked. ADR-0034 is the rule that forced the marking.

---

## 1. What was asked, and what this decides

Asked: SCP a firmware image from Fathom to a Juniper device.

Decided: **Fathom stages the image and the device fetches it.** Fathom does not open an authenticated
connection to the device, does not hold a device credential, and does not run the upgrade. The
operator issues one command on the device, and Fathom gives them that command, the expected hash, and
somewhere to fetch from.

This is a different mechanism from the one asked for, so the reasoning is set out in full below
rather than assumed. The outcome is the same — the image gets onto the device, verified — and it is
reached without Fathom ever holding a working credential for network equipment.

## 2. Why not push over SSH, yet

Four findings, in the order they matter.

**2.1 The least-privilege question has no answer, and it decides everything else.** Juniper's login
classes documentation states that *"SFTP and SCP server functionality is disabled when using the
operator or read-only predefined login classes"* (search summary, 2026-09-14). So the two obvious
least-privilege classes cannot receive a file at all. What the **minimal** permission set is that
can receive a file and nothing else could not be established; the `maintenance` bit is documented as
letting a user *become super-user*, which is the opposite of the goal.

Worse, it could not be established whether Junos honours OpenSSH `authorized_keys` options —
`restrict`, `command="…"`, `no-pty` — when a key is configured through the Junos configuration
hierarchy rather than a raw `authorized_keys` file. On an ordinary Unix host, `restrict` plus a
forced command is exactly how a general key becomes a file-drop-only key. If Junos ignores those
options, that mitigation does not exist, and **any key Fathom holds for a device is a general,
shell-capable administrative credential scoped only by a login class whose minimum is unknown.**

We are not building a feature whose security story depends on a property nobody has confirmed. This
question needs real hardware, and it is written down in §7 as the thing to answer.

**2.2 Modern `scp` does not speak SCP.** The OpenSSH `scp(1)` manual, read directly on 2026-09-14,
says: *"Since OpenSSH 9.0, scp has used the SFTP protocol for transfers by default."* Junos disabled
incoming SFTP globally by default from Release 19.1R1 and gates it behind
`set system services ssh sftp-server` (search summary, 2026-09-14). A current client and a device
from any of the last seven years therefore fail by default, and the failure is obscure — a subsystem
request refused, not a permission error. `scp -O` forces the legacy protocol, and is documented as
the escape for *"servers that do not implement SFTP"*.

A push design has to know which of two protocols it is speaking to a device whose configuration it
cannot see. That is a bad place to stand, and it is a trap a hand-written runbook falls into just as
easily — which is why §6 names it.

**2.3 A push consumes the budget an operator needs to get in.** `connection-limit` and `rate-limit`
under `[edit system services ssh]` are per protocol and **global to the service, not per user**
(search summary, 2026-09-14). `lockout-period` under `retry-options` ranges to 43,200 minutes, which
is thirty days. An automated client that retries a bad password can lock out the account a human
needs. Juniper's own `splitcopy` tool handles this by **deactivating those limits on the device and
restoring them afterwards** (primary read of its README, 2026-09-14). That is a defensible thing for
an operator-run CLI to do and an unacceptable thing for an always-on multi-tenant server to do: it
is a configuration change to production equipment and a window in which a protection is absent.
**Fathom never changes a device's configuration. Not to make room for itself, not for anything.**

**2.4 There is no vendor channel for a device's host key.** No way was found for Juniper to publish
or retrieve a device's own SSH host key fingerprint out of band, and no Junos command was found that
prints it (both unestablished, leaning strongly negative, 2026-09-14). Juniper's own management
platform solves first contact with a human acknowledging a fingerprint. So a push design's first
connection is trust-on-first-use no matter how it is dressed, and every device added is one more
fingerprint someone has to have actually checked.

## 3. What the pull design gives up, and what it does not

It gives up unattended operation. Someone types a command on the device. For a firmware upgrade,
which already requires a maintenance window, a reboot and a human watching, that is close to free.

It does **not** give up integrity, and this is the part worth being precise about.

**Transport is not a control here, and the design does not pretend it is.** The image is a public
vendor artefact; it is not secret. What matters is that the bytes that land are the bytes intended,
and that is established twice, after the fact:

1. **A SHA-256 comparison on the device.** `file checksum sha-256 <path>` has existed since Junos
   9.5 (search summary, 2026-09-14), and Juniper's own `splitcopy` does a hash comparison of source
   and destination **by default**, requiring `--noverify` to skip it (primary read, 2026-09-14).
   Their own tool treats "did the whole file arrive intact" as something to prove.
2. **Junos's own signature check at install.** Packages are signed and verified against a chain
   anchored at a Juniper root CA, reporting lines of the form
   `Verified junos-install-… signed by PackageProductionEc_… method ECDSA256+SHA256`, and refusing
   with `ERROR: Package signature validation failed. Aborting install.` (search summary,
   2026-09-14). `request system software validate <package>` runs it without installing.

Those two together are stronger than any transport guarantee, because they answer different
questions: the hash answers *did all of it arrive*, and the vendor signature answers *did Juniper
make it*. Neither answers *is this the release I meant*, which is the operator's job and Fathom's to
display clearly.

**One thing genuinely unresolved:** whether Junos verifies TLS certificates on `file copy https://…`
could not be established. Until it is, the design must not lean on HTTPS for authenticity — which it
does not, per above — and the documentation must not imply that it does.

**What Juniper publishes to check against is also weaker than expected.** MD5 is documented, MD5 or
SHA-1 appear on the download site, and whether SHA-256 or any detached signature is published today
could not be established (search summary, 2026-09-14). MD5 and SHA-1 are broken for collision
resistance: fine against a truncated download, not against a substituted image. **The vendor
signature at install is the authenticity control. The published hash is not, and Fathom must not
present it as one.**

## 4. The decision, stated

1. **Fathom holds no device credential.** Not a password, not a key, not for a moment. The vault of
   ADR-0042 is not built, and this feature does not become the reason to rush it.
2. **Fathom stages an image and serves it at a one-time, short-lived, session-authorised URL**, and
   shows the operator the exact commands to run, the expected SHA-256, and the verification step.
3. **Fathom computes and displays the SHA-256 of exactly the bytes it will serve**, so the operator
   compares the device's answer against what Fathom actually has, not against what a web page said.
4. **Fathom never runs the upgrade.** Staging and verification only. `request system software add`
   and the reboot are the operator's, deliberately: an automated upgrade is a different feature with
   a different blast radius, and it needs the snapshot and rollback story in §6 to be automated too.
5. **Fathom never modifies a device's configuration**, under any circumstance, for any reason.
6. **Push over SSH is deferred, not abandoned.** It becomes buildable when §7's question is answered
   and the vault exists. When it is built, it uses public-key authentication and never a password,
   because with no password the `retry-options` lockout exposure of §2.3 largely does not arise —
   which is a concrete safety argument that does not depend on the contested guidance in §5.

## 5. On keys versus passwords, where the sources disagree

Recorded because the next person will ask, and because the honest answer is that this is unsettled.

**Against keys:** the CIS Juniper OS Benchmark carries recommendations to disable SSH key
authentication for user and root logins, reasoning that keys are per-device rather than central,
preclude multi-factor, and have no rollover automation on Junos (search summary, 2026-09-14). Two
caveats materially weaken it here: those items address **interactive human login**, not automated
file transfer; and **CIS archived all versions of the Juniper benchmarks on 2025-10-10** for lack of
subject-matter-expert support, so it is an unmaintained document.

**For keys:** NIST IR 7966 exists precisely to say that automated access happens by SSH keys and the
answer is to manage them. **Its detailed recommendations could not be read** and are unestablished
here. OpenSSH's `authorized_keys` restriction mechanism is the standard mitigation — subject to §2.1,
where it is unknown whether Junos honours it. Juniper ships tooling to make key authentication
easier, which is a signal of vendor intent rather than an argument.

**Nothing found compares "a password held in memory for one transfer" against "a stored key"
directly.** Saying so rather than inventing a consensus. The reasoning that decided §4.1 is simpler
than either: a password that is never stored still has to come from somewhere, and unless a human
types it every time, that somewhere is a stored secret one level up. It relocates the asset rather
than removing it. Holding nothing removes it.

## 6. The traps, which apply to the operator's own hands as much as to Fathom

Recorded here because they are the difference between an upgrade and an outage. `docs/UPGRADING-A-JUNIPER.md` is the operator-facing form.

- **`request system storage cleanup` can delete the image you just staged.** The documented order is
  check space, then clean up, then copy, then verify, then install. A sequence that copies first and
  cleans second deletes its own payload (search summary, 2026-09-14).
- **A partial file is accepted as complete.** Juniper's own documentation notes images sometimes do
  not transfer completely and that checksum verification exists to catch it. `truncated or corrupted
  package` at install is a real reported failure (search summary, 2026-09-14).
- **`request system snapshot` before, and again after.** Without the second one the alternate boot
  media stays out of sync with the primary. `request system configuration rescue save` gives
  `rollback rescue` something to return to. `request system software rollback` reverts the last
  install (search summary, 2026-09-14).
- **`/var` is what fills.** At 90% or more there is not enough room to install (search summary, EVO,
  2026-09-14).

## 7. The question that must be answered on real hardware

**What is the minimal Junos permission set that can receive a file and do nothing else, and does
Junos honour `authorized_keys` restrictions on a configured key?**

If the answer is that no least-privilege path exists, then any key Fathom ever holds for a device is
a general administrative credential, and §4.6's push feature has to be written differently or not at
all. This is not a detail to settle during implementation. It is the decision.

## 8. Consequences

- Fathom gains its first outward-facing artefact: a URL a network device fetches. That is a new
  surface and it is authorised by the same session layer as everything else, one time and
  short-lived.
- `CLAUDE.md` rule 4 — *device credentials are protected by never arriving* — is **not** weakened by
  this record. No credential arrives. The rule survives intact, which was the point of choosing this
  shape.
- The redaction gate is untouched and unaffected.
- `docs/REBUILD-PLAN.md`'s ordering is amended: a first, narrow piece of live-device work is now in
  scope, ahead of monitoring and integration generally, which remain where the owner put them.
