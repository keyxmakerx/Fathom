# Recommendations, 2026-09-04 — the technical record

> **Status:** Record, compiled 2026-09-04. Fourteen researched recommendations on open owner
> decisions — six security, eight data-model — each researched to ADR-0034's standard, then attacked
> by an independent skeptic, then direction-checked by the lead reviewer. **Every one of the fourteen
> came back `holds: false`** with a list of required changes; **the direction of every one was
> validated by the lead and stands.** This document applies every required change to the text it
> records and keeps, per decision, a list titled *Corrections applied* so the skeptic's work is
> visible. **It decides nothing.** Every question that is the owner's is under *Open decisions*,
> verbatim; every fact that could not be established is under the decision that needed it, verbatim.
> The plain-English page the owner reads is a separate document; this is the companion for planning
> sessions and reviewers.
> **Date:** 2026-09-04 throughout — every source read date below is 2026-09-04 unless the row says
> otherwise. **Inputs:** two workflow outputs, `w3aotk1sm` (security, 12 agents) and `w1eyfkptq`
> (schema, 16 agents). **What this is not:** an ADR, a work order, or an answer (`78` §7). Nothing
> here is executable until a planning session turns it into an order and the owner answers what is
> his.

## Contents

| § | |
|---|---|
| 0 | Status, and how to read a section |
| 1 | How this record was produced |
| 2 | A1 — Where the master key lives |
| 3 | A2 — Whether the first release keeps an audit log |
| 4 | C1 — What the server may dial out to |
| 5 | C2 — Whether people may sign in with a device password |
| 6 | `49` §16.2's device half — how a device proves itself to the firmware server |
| 7 | B2 — Whether an operator may read a customer's network map |
| 8 | D2 / D10 — Groups and tags |
| 9 | D3 — A box with more than one role |
| 10 | D4 — Racks: the move, the height, the premises, the furniture |
| 11 | D5 — A presentation layer for facts about the drawing |
| 12 | D6 — Draft and planned work |
| 13 | D7 — A DHCP relay pointing into a named routing instance |
| 14 | E4 — Reading and writing a vendor's language from one file |
| 15 | D1 — Hosts, NAS boxes and hypervisors |
| — | Failure modes · Open decisions · Sources consulted · Disagreements |

---

## 0. Status, and how to read a section

Each of §2–§15 has the same parts, in this order:

- **Answers** — which item of `docs/70-ops/OPEN-FOR-THE-OWNER.md` (or which section of `49`) the
  decision is about.
- **Direction (validated)** — one sentence: the recommendation's direction, which the lead reviewer
  checked and which stands.
- **Recommendation, as corrected** — the full technical recommendation with every required change
  applied. Where a fix offered two acceptable rewrites ("either … or …"), the one taken is named in
  *Corrections applied* so a reader can reverse it.
- **Plain English, as corrected** — the sentence the owner's page carries, rewritten where a fix
  named it. It is reproduced here so the two documents cannot drift apart silently.
- For the schema decisions: **Schema change** (the YAML, fenced), **What it forecloses**, and
  **Migration** (corrected — several fixes correct false forward-compatibility claims).
- **Corrections applied** — one line per required change, numbered as the skeptic numbered them.
- For the security decisions: **Could not establish** — carried verbatim. These are results, not
  gaps; a claim that rests on one of them is marked as resting on it.
- **Needs the owner** — the `still_needs_owner` question verbatim, plus anything a fix moved to the
  owner. All of these are collected again under *Open decisions*.

**Two limits of the inputs, stated once here and not papered over anywhere below.** The workflow
outputs truncated two fields: every security decision's `reasoning` is cut at 3,000 characters and
every schema decision's `schema_change` at 2,500, each ending mid-sentence. Consequences: (a) the
`sources` field of each security decision is a **count** (29, 28, 29, 29, 27, 24) and the URLs sit
inside `reasoning`, so the *Sources consulted* table can enumerate only the sources named in the
recoverable text and in the skeptics' fixes — fewer than the count, and it says so per decision;
(b) the YAML under *Schema change* is what survived the cut, with the corrections applied to the
part that is visible and the rest recorded as an instruction to the executor. Nothing beyond a cut
has been reconstructed.

**One override from the lead reviewer, applied in §6.** For the firmware decision the lead verified,
against `Juniper/yang` commit `96ad7bad` (read 2026-09-04), facts that differ in detail from the
skeptic's — recorded in `docs/40-stack/49-the-server-product.md` §16.1a(vi). §6 cites that section
and those facts; where the skeptic's version differs it is not restated in the body and is noted
under *Disagreements*.

> **Marker count, corrected 2026-09-04.** This record carries **6 `<!-- VERIFY: … -->` markers** (the seventh occurrence of the string is §0's own description of the convention), plus 2 bare `VERIFY:` notes in prose. The commit that added this file said *"twenty remain"*; that figure was a count of every occurrence of the word *verify*, including *verified*, and was wrong. Counted with `grep -c '<!-- *VERIFY'`, minus one.

## 1. How this record was produced

1. **Two workflows, run 2026-09-04.** The security workflow (`w3aotk1sm`, 12 agents) researched
   six decisions in parallel; the schema workflow (`w1eyfkptq`, 16 agents) designed eight in
   parallel against `62`'s grammar and ADR-0008.
2. **Each decision was researched under ADR-0034's discipline:** opened sources named with the date
   opened; blocked hosts named (the session's egress proxy refused most vendor and standards hosts
   — `juniper.net`, `arista.com`, `csrc.nist.gov`, `nvlpubs.nist.gov`, `rfc-editor.org`,
   `docs.docker.com`, `kubernetes.io`, `learn.microsoft.com`, `slack.com`, `atlassian.com` and
   others, each listed under the decision it affected); GitHub-hosted source files of the same
   documentation used instead and said to be; search-engine snippets **not** recorded as
   established; *"could not establish"* recorded as a result.
3. **Each was then attacked by a skeptic** who returned `holds` (all fourteen: `false`), a numbered
   `required_changes` list, and — for security — an `invented` list of unsupported claims, or — for
   schema — a `decides_owner_business` finding naming anything the design presumed on the owner's
   behalf.
4. **The lead reviewer validated the direction of every recommendation.** No skeptic's finding
   reversed a direction; every finding was a correction of a claim, a citation, a number, a
   sequencing, or a boundary between the recommendation's business and the owner's.
5. **This record applies every required change.** Applied means: the sentence a fix names is
   rewritten; what a fix says to delete is deleted; what a fix says to add is added; what a fix
   says is the owner's is moved to *Needs the owner*; a citation a fix calls unsupported or
   invented is dropped or carried as `<!-- VERIFY: … -->`, never kept as a fact. A fix that would
   have reversed a direction would have been stopped and filed under *Disagreements* instead of
   applied; none was.
6. **Three of the skeptics' findings apply beyond the decision they were found in**, and are
   applied across the record: no duration or effort estimate is stated without a measurement
   (B2 fix 4, citing `49` §19's own rule and house rule 5); no forward-compatibility claim is made
   without naming the code path that honours it (groups-and-tags fix 1 — the shipped import stops
   at the first record it does not know); and no claim of the form *"the owner asked / answered"*
   is made where the owner's record (`70`) does not carry it (D3 fix 1).

---

## 2. A1 — Where the master key lives

**Answers:** `OPEN-FOR-THE-OWNER.md` §A1, both halves — the hosted product, and a customer who
installs on their own hardware with no cloud. ADR-0040 §9 items 1 and 2. WO-12 stored nothing on
purpose to keep this door open.

**Direction (validated):** the master key is held by a **key service behind the provider interface
WO-12 already designs**, not by a file on the Fathom server; the employer's cloud KMS roots the chain
where one exists; a direct cloud-KMS provider is the phase-2 customer-managed-key destination; the
key file is a floor with conditions, not a default.

### 2.1 Recommendation, as corrected

**What is being decided.** ADR-0040 D1–D4 fixed the architecture: a data key per tenant and per
design, wrapped by a master key, custody switched by re-wrapping keys and never by re-encrypting
data. WO-12 (read 2026-09-04) makes the master-key holder a `MasterKeyProvider` behind a registry
keyed on `(wrap_provider, wrap_key_id)`, stores whatever the provider returns as opaque bytes, and
scopes its `file` provider to development and test (WO-12 §4.4). So A1 is not a storage-format
question; it is *which provider is built second*, and *what is told to an employer* in each of the
two situations §A1 names. The owner's constraint is *"enterprise level"* (`70` §18.1, verbatim); the
audience is his employer's security review (`70` §19.5).

**The recommendation.** Make a HashiCorp Vault or OpenBao **Transit** key service the first shipped
master-key provider after the `file` provider, reached through **Vault Proxy on the loopback**, so
that Fathom adds a small number of crates and no C code (the figure resolved in a scratch project was
+3; it is **unmeasured on the real manifest** — *Could not establish* item 7). Put the employer's
cloud KMS at the root of that chain when they have one: Vault **auto-unseal** is available in every
Vault edition for AWS KMS, Azure Key Vault and GCP Cloud KMS — the AWS and Transit pages were opened
by the research, and the Azure and Google pages by the skeptic on 2026-09-04
(`content/vault/v1.21.x/content/docs/configuration/seal/azurekeyvault.mdx` lines 16–17: *"All Vault
versions support auto-unseal for Azure Key Vault, but seal wrapping requires Vault Enterprise"*;
`…/seal/gcpckms.mdx` lines 16–17, the same sentence for GCP Cloud). Keep a **direct cloud-KMS
provider** as the phase-2 customer-managed-key destination, which is ADR-0040 D2's destination and
is unchanged by this research. **Demote the key file to a floor** for an employer who refuses to run
any key service at all, under the two conditions stated next.

**The floor's two conditions, both of which the first draft omitted.** (1) *The TPM condition.*
systemd seals a credential under TPM2 plus the host key only *"If a TPM2 device is available and
/var/ resides on a persistent storage"* (systemd `CREDENTIALS.md`). Without a TPM the key is
`/var/lib/systemd/credential.secret` on the same disk as the data, and the improvement *"a stolen
disk image no longer carries a usable key"* **does not exist**. (2) *The container condition.* The
shipped deployment, `deploy/compose.yaml`, runs a distroless container with no systemd, and
`CREDENTIALS.md`'s container passing covers systemd-nspawn only — no docker/OCI mention. **The floor
is therefore undesigned for the compose deployment as shipped**: either the executing order designs
how a host systemd unit's decrypted credential reaches the container, or the floor is stated to
require a host systemd unit and is not offered for compose. This record takes the second: the floor
is offered only where a host unit runs Fathom, until an order designs the other.

**Secret zero — what a key service changes and what it does not.** Vault Proxy's auto-auth needs a
credential on the Fathom host: the docs' examples use AppRole `role_id_file_path` /
`secret_id_file_path`; Grafana's practice is a periodic token file. **The file problem does not
disappear; it changes shape.** Versus a key file, that credential is revocable, TTL-bound, audited
per use, and useless once Vault is unreachable. That is the honest sentence, and the plain English
carries it.

**TLS is not avoided by the loopback proxy.** `49` §6's own phase-1 table (rustls 0.23.43; lettre
*"use the rustls backend"*; openidconnect) already requires an in-process TLS client, so C7/A3
(the TLS-stack and borrowed-code-ceiling questions) must be resolved in phase 1 regardless of A1.
Restated cost: a Transit provider is still **~+84 crates above a bare rustls client (114 − 30)** —
the skeptic's arithmetic on the scratch-project figures, unmeasured on the real manifest.

**Gate paperwork, corrected.** `hyper`, `hyper-util` and `http-body-util` become **direct**
dependencies, and `scripts/gate-zero.sh` (lines 26–28, 192–194) requires a
`deps/decisions/<crate>.md` for each — **three new records, none of which exists today** — plus
closure entries for the two new transitive crates measured, `want` and `try-lock`.

**What comparable products do** (from the recoverable reasoning). SaaS enterprise tier: the
customer's own cloud-KMS key wrapping the vendor's data keys — GitLab Dedicated: *"Optionally, you
can use your own AWS Key Management Service (KMS) encryption key for data at rest"* (GitLab docs
source, official GitHub mirror). Slack EKM, Atlassian BYOK/CMK, Miro EKM, Lucid KMS and Salesforce
Shield BYOK rest on the 2026-08-28 survey recorded in ADR-0040 finding 3 and `49` §3's addendum —
every vendor host was blocked today and only snippets were seen (*Could not establish* item 1).
Self-hosted enterprise products: a key-file KEK by default, a KMS/Vault provider behind an interface
in the paid tier. Grafana (docs source on GitHub): data encryption keys *"are themselves encrypted
with a single key encryption key (KEK), configured through the `secret_key` attribute … or by
Encrypting your database with a key from a key management service (KMS)"*; providers *"AWS KMS,
Azure Key Vault, Google Cloud KMS, Hashicorp Key Vault"*, available *"If you are using Grafana
Enterprise"*; the Vault integration is *"Enable the transit secrets engine"*, *"Create a named
encryption key"*, *"Create a periodic service token"*. GitLab self-managed keeps its database
encryption key in `/etc/gitlab/gitlab-secrets.json` — the backup page says *"the secrets file
contains your database encryption key"* and names that file; it does **not** name a variable —
excludes it from the backup on purpose (*"Storing encrypted information in the same location as its
key defeats the purpose of using encryption in the first place"*), and warns that losing it means
the application cannot decrypt any encrypted values. The rest of that paragraph, and the reasoning's
sections after it, are beyond the 3,000-character cut.

**NIST SP 800-57 Part 1 Rev. 5 §6.1, read correctly.** Outside a validated module, confidentiality
*"shall be provided by encryption at an appropriate security strength (see SP 800-152) or by
controlling access to the secret key information via physical means"* (Rev. 5, extracted text
lines 3275–3277, read from an unofficial GitHub mirror of the PDF — *Could not establish* item 3).
A chmod-0400 plaintext file is neither encryption nor physical access control under that sentence,
so the first draft's *"a protected key file is therefore not non-compliant per se"* is dropped. The
TPM-sealed floor (AES256-GCM under a TPM-derived key) does satisfy the encryption limb and may be
said to.

**OpenBao, to the extent the pages show.** Its README carries chat hosted at
`linuxfoundation.zulipchat.com`, mailing lists at `lists.openssf.org`, and an *"open-governance"*
statement; its LICENSE is MPL 2.0. No sentence on the pages opened asserts a Linux Foundation
association, and neither its fork lineage nor whether its Transit API is wire-compatible with
Vault's is stated (*Could not establish* item 5). **Compatibility must be tested before it is
claimed.**

**The licence question is not this recommendation's to settle.** Vault Proxy is the BSL-licensed
Vault binary (*"Vault Version 1.15.0 or later"*). Whether shipping a compose file with a Vault
sidecar to third parties is *"offering the Licensed Work to third parties on a hosted or embedded
basis"* depends on §B1 (are you running this, or shipping it?) and is legal's and the owner's.
OpenBao's MPL 2.0 avoids the question.

### 2.2 Plain English, as corrected

Put the master key in a key-vault service that your employer's IT already trusts rather than in a
plain file on the Fathom server — and be clear about what that buys: Fathom still needs one small
credential on its own machine to reach the vault, but that credential can be revoked, expires on its
own, is logged every time it is used, and is useless the moment the vault is unreachable, none of
which is true of a key file. The best first choice is HashiCorp Vault (or OpenBao, an open-source
fork that must still be tested against — nobody has yet proved the two speak the same protocol): it
works whether or not the company uses a cloud, tools like NetBox recommend it, and it costs Fathom
little extra code. If the company has an AWS, Azure or Google account, that account's key service
can lock Vault itself, so the company's own cloud key sits at the top of the chain. Only if IT
refuses to run any key service should the key live in a file on the server, and then it must be
tied to that machine's security chip — if the server has one; without one the file sits on the same
disk as the data it protects — and backed up separately from the database. That fallback also does
not yet work with the container setup Fathom ships today; somebody has to design how it would.
Whichever way this goes, nothing already stored has to be re-encrypted; that is designed in on
purpose, though the work order that builds it has not yet been executed. One thing is not Fathom's
to settle: whether shipping Vault alongside Fathom to other companies is allowed under Vault's
licence — OpenBao's licence avoids that question.

### 2.3 Corrections applied

1. NIST SP 800-57 §6.1 rewritten to the standard's text (*"via physical means"*); *"a protected key
   file is therefore not non-compliant per se"* dropped; the TPM-sealed floor stated to satisfy the
   encryption limb.
2. `db_key_base` removed; the GitLab backup page's own words (*"the secrets file contains your
   database encryption key"*, `/etc/gitlab/gitlab-secrets.json`) used instead.
3. OpenBao's *"Linux Foundation association"* reduced to what the README shows (Zulip chat host,
   OpenSSF lists, an open-governance statement).
4. `azurekeyvault.mdx` and `gcpckms.mdx` (lines 16–17 each, opened 2026-09-04) added as the sources
   behind the Azure/Google auto-unseal claim; recorded that the research itself opened only AWS and
   Transit.
5. Secret zero stated in both the recommendation and the plain English: Vault Proxy's auto-auth
   credential on the host, and what changes versus a key file (revocable, TTL-bound, audited,
   useless once Vault is unreachable); *"not in a file on the Fathom server"* replaced.
6. The TPM condition on the floor stated from systemd's own sentence; plain English now says *"if
   the server has one"*.
7. The floor reconciled with the shipped deployment: **choice taken** — the floor requires a host
   systemd unit and is undesigned for compose until an order designs the hand-off.
8. Acknowledged that `49` §6's phase-1 table already requires an in-process TLS client; cost
   restated as ~+84 above a bare rustls client (114 − 30).
9. Gate paperwork corrected: `hyper`, `hyper-util`, `http-body-util` become direct and need three
   new `deps/decisions/` records; closure entries for `want` and `try-lock`.
10. The licence reading moved to *Needs the owner* (legal's / §B1's); OpenBao noted as avoiding it.
11. *Needs the owner* extended with the *"are you willing to run OpenBao or Vault as one more
    container in your own demo stack?"* question.
12. Plain English: *"built in"* → *"designed in on purpose"*; *"open-source twin"* → *"an
    open-source fork that must still be tested against"*; *"the tools your colleagues already run
    (NetBox, Grafana) point at"* → *"tools like NetBox recommend"*.

Also dropped from the recoverable text on the skeptic's `invented` list, without a numbered fix:
*"the only pure-Rust rustls provider"* (the README calls itself a RustCrypto-based provider; *only*
was the recommendation's word).

### 2.4 Could not establish

1. Slack EKM, Atlassian BYOK/CMK, Miro Encryption Key Management, Lucid KMS and Salesforce Shield
   pages: every vendor host (slack.com, slack.engineering, slackhq.com, support.atlassian.com,
   www.atlassian.com, help.miro.com, lucid.co, help.lucid.co, the Lucid CDN, help.salesforce.com,
   developer.salesforce.com, a.sfdcstatic.com) was blocked at the proxy on 2026-09-04. Only search
   snippets were seen today; the claims about them rest on ADR-0040 finding 3 / 49 §3's addendum,
   which opened them on 2026-08-28.
2. The SOC 2 CC6.1 criterion and its 'Protects Encryption Keys' point of focus: the AICPA download
   and every secondary tried (hicomply, soc2auditors, strac, secureframe) were blocked; snippet-only,
   not an opened page.
3. NIST SP 800-57 Part 1: csrc.nist.gov, nvlpubs.nist.gov, www.nist.gov, csrc.nist.rip and
   web.archive.org were all blocked. Rev. 5 was read from an unofficial GitHub mirror of the PDF
   (cover, author, DOI and 'May 2020' verified in the extracted text), not from NIST. Rev. 6's status
   (initial public draft, 2025-12-05, comments through 2026-02-05) is from snippets only.
4. Google Cloud KMS and Azure Key Vault documentation: docs.cloud.google.com and learn.microsoft.com
   blocked; the MicrosoftDocs GitHub mirror path returned 404. The 'all three clouds document
   envelope encryption' finding stands on ADR-0040 finding 1 (2026-08-28) and AWS's page opened
   today.
5. Whether OpenBao's Transit API is wire-compatible with HashiCorp Vault's, and OpenBao's fork
   lineage: neither is stated on the OpenBao pages opened (README, LICENSE, what-is-openbao). Must
   be tested before compatibility is claimed.
6. Whether the owner's employer already runs Vault/OpenBao, an HSM, or has a usable cloud account —
   a fact only he can obtain (see still_needs_owner).
7. The exact net crate count of a Transit provider inside Fathom's real manifest: the +3 figure was
   resolved in a scratch project with hyper's client features; feature unification in the real
   workspace could move it by a few packages. Measure on the real manifest in the executing order.
8. Vault Proxy's own footprint and whether it fits the distroless, read-only compose posture; and
   whether the employer's Vault policy allows a per-application periodic token (Grafana's practice)
   — both deployment facts for the executing order.
9. FIPS 140 validation levels of any specific HSM or cloud KMS beyond AWS's own sentence; the CMVP
   site (csrc.nist.gov) was blocked.

### 2.5 Needs the owner

- *"Does your employer's IT already run HashiCorp Vault (or OpenBao) — and if not, do they have an
  AWS, Azure or Google account that the security team would let Fathom's key chain use?"*
- Added by fix 11: *"If your employer runs neither Vault nor a usable cloud key service, are you
  willing to run OpenBao or Vault as one more container in your own demo stack?"*
- Moved by fix 10: whether shipping a compose file with a Vault sidecar to third parties falls under
  the BSL's *"hosted or embedded basis"* clause — legal's, and dependent on §B1.

---

## 3. A2 — Whether the first release keeps an audit log

**Answers:** `OPEN-FOR-THE-OWNER.md` §A2 — *who opened, changed or exported which network drawing,
and when.* Cross-references `49` §13 and §7's B2 (which depends on this record existing).

**Direction (validated):** **yes** — a minimal, append-only, hash-chained audit record from the
first stored row, with the viewer, SIEM export, alerting, signing and retention tooling deferred.

### 3.1 Recommendation, as corrected

**The recommendation.** Release one writes a minimal, append-only, SHA-256 hash-chained audit record
into its own tenant-scoped PostgreSQL table from the first stored row. The event list is **closed and
has twenty-four entries** — the enum the research drafted, counted by the skeptic; the enum itself
lies beyond the 3,000-character cut and is not reproduced here, so the executing order takes it from
the workflow output, or shrinks it and says which were cut — each record carrying NIST AU-3's six
fields. **Plus one event the draft omitted and this record adds:** *a secret-bearing field viewed*
(see the divergence paragraph below), which makes the list twenty-five if the executing order keeps
all of the draft's twenty-four. The viewer, SIEM export, alerting, signing and retention tooling are
later releases.

**What the frameworks require** (opened 2026-09-04; the reasoning's §1). NIST SP 800-53 Rev 5.2.0,
from NIST's own OSCAL catalogue on GitHub because csrc.nist.gov is blocked: AU-2 requires the
organisation to *"Specify the following event types for logging"* and *"Provide a rationale for why
the event types selected for logging are deemed to be adequate to support after-the-fact
investigations of incidents"*; AU-3 requires each record to establish *"What type of event
occurred; When the event occurred; Where the event occurred; Source of the event; Outcome of the
event; and Identity of any individuals, subjects, or objects/entities associated with the event"*;
AU-11 requires retention for an organisation-defined period *"to provide support for after-the-fact
investigations"*. **AU-9 in full, as the skeptic requires:** part (a) reads *"Protect audit
information and audit logging tools from unauthorized access, modification, and deletion"*; part (b)
— alert designated organisational personnel on detected modification or deletion of audit
information — **is in the LOW baseline** and is **deferred with the viewer and alerting**, which
this record states as a known departure from the baseline rather than leaving it implicit.
<!-- VERIFY: AU-9(b)'s verbatim text from the OSCAL catalogue; the wording above is the skeptic's
paraphrase, the research's quotation covered (a) only. --> Reading the three published baseline
profiles: AU-2, AU-3, AU-6, AU-9, AU-11 and AU-12 are all in the LOW baseline; AU-9(3) *"Implement
cryptographic mechanisms to protect the integrity of audit information"* and AU-10 non-repudiation
are HIGH only; AU-9(2) (a physically separate system) is HIGH only. So a record with the six AU-3
fields, protected and retained, is the floor at every impact level; cryptographic tamper-evidence
is a high-impact enhancement, **recommended here on cost and on the never-backfill property, not
asserted as a framework requirement** (*Could not establish* item 7).

SOC 2 CC7.2 (AICPA blocked; two independent GitHub-hosted copies, prowler-cloud/prowler and
wazuh/wazuh-dashboard-plugins): *"The entity monitors system components and the operation of those
components for anomalies that are indicative of malicious acts, natural disasters, and errors
affecting the entity's ability to meet its objectives; anomalies are analyzed to determine whether
they represent security events."* Prowler's copy of the points of focus lists *"logging of unusual
system activities"* and detection of *"unauthorized actions of authorized personnel"* and *"use of
compromised identification and authentication credentials"*. CC7.2 is about monitoring and analysis;
the record is its precondition. ISO/IEC 27002:2022 control 8.15 (paywalled; the control statement
from prowler and Evolveum/docs): *"Logs that record activities, exceptions, faults and other
relevant events should be produced, stored, protected and analysed."* Its implementation guidance
could not be opened and is not relied on. PCI DSS v4.0 10.5.1 (PCI SSC blocked; text from
turbot/steampipe-mod-aws-compliance and MicrosoftDocs/entra-docs): *"Retain audit log history for at
least 12 months, with at least the most recent three months immediately available for analysis."*
Not a framework an employer would apply to Fathom directly; it is the most concrete published
retention number and the one a reviewer will have in mind. The reasoning is cut mid-sentence here.

**Why it costs no new crate — the true reason.** `sha2 0.11.0` and `hmac 0.13.0` are already in
`Cargo.lock` as dependencies of `postgres-protocol 0.6.12` (tokio-postgres's SCRAM), **not** via
`argon2`/`hkdf` — neither of those is in the lockfile today; WO-12 §5 is what adds them and promotes
`sha2` to a direct dependency. The zero-new-crates conclusion stands on that.

**What the hash chain does and does not prove.** An entry-to-entry chain with no secret shows
tampering **only when checked against a copy kept somewhere the database administrator cannot
reach.** So the daily chain-head anchor is written to `43`'s **L6 administrative-action stream**
(`docs/40-stack/43-deployment-modes.md`), which has the longer retention — **not** the 7-day
operational stream L4 the draft named — and the honest limit is that **the detection window equals
the anchor's retention.** The record is unalterable by anyone using Fathom; by whoever administers
its database it is alterable, and the anchor is what makes that detectable.

**Divergence from `49` §13, stated.** `49` §13 names two events responders ask for first; one of
them, *a secret-bearing field viewed*, was not in the draft's list. ADR-0041's
`looks_like_credential` makes it observable on every read that renders a field. **This record adds
it.** The reconciliation point the skeptic names is WO-12 §7 trigger 7 (the skeptic's pointer; not
re-read for this record).

**Concurrency, specified.** Concurrent writes to one tenant's chain are serialised by a **unique
constraint on `(tenant_id, prev_hash)` with retry** — optimistic, holding no lock across the
transaction — rather than a locked per-tenant head row. Its cost against `49` §9's live multi-user
editing at thousands of devices per design is **unmeasured**: the write rate is tied to op-batch
frequency, and no server produces op batches yet (WO-11 G8). *"Row volume is small"* is withdrawn as
unmeasured.

**Fields.** The six AU-3 fields, mapped: event type; time (server clock); where (design and tenant
identifiers, never names); source (the actor identifier phase 0 gives every op, and the source
address); outcome; identity (actor identifier). **`source_addr`: default to `43` P-8's truncation,
with full precision as an operator option.** Named consequence: audit rows **outlive a tenant
destroyed under ADR-0040 D4** and carry actor identifiers and addresses for as long as the record is
kept — which, with retention tooling deferred, is indefinitely until that tooling exists.

**Tenant-less rows.** `sign_in_failed` for an unknown account, and `tenant_key_destroyed` after the
tenant is gone, cannot live in a `tenant_id`-keyed row-level-security table as ordinary rows. They
are written to **one reserved system chain** — a fixed system tenant identifier with its own hash
chain and anchor — exempt from the per-tenant RLS predicate and readable only by the operator role.

**Provenance of "who".** Every op carries an author (phase 0, `CLAUDE.md` § *State*); the draft's
*"server-assigned sequence"* is dropped — no server writes anything today (WO-11 G8), and the skeptic
found no sequence field in `crates/fathom-graph/src/prov.rs` or `op.rs`. <!-- VERIFY: where the
per-op sequence phase 0 is recorded as adding actually lives in the tree. --> Today the author slot
holds the reserved LOCAL value until accounts exist.

**Comparable products.** The evidence opened is limited to NetBox, Nautobot, GitHub, Grafana,
Vault (v1.15.0 tagged copy only), Kubernetes and CloudTrail; Lucidchart, Miro, Figma, Atlassian,
Slack and Notion could not be opened (*Could not establish* item 5). OWASP's logging guidance lists,
in its own words, *"Data import and export including screen-based reports"* among the events to
record. <!-- VERIFY: which OWASP page — the title is beyond the cut. -->

### 3.2 Plain English, as corrected

Yes — keep the record from the first day the server saves anything. An employer's security review
will ask "who opened, changed or exported this drawing, and when", and a record that starts later can
never answer that for the time before it existed. Start small: a short fixed list of events written
into a table the software can add to but never edit or delete, with each entry linked to the one
before it so tampering can be spotted when the record is checked against a copy kept elsewhere —
on its own, inside the same database, the chain proves nothing to whoever administers that database,
which is why a running checksum of it is copied off the machine every day. Most of what it needs is
already in place — every change already has a place for who made it (today that place holds a
reserved local value until accounts exist), and the checksum it uses is already in the code — so it
adds no new outside code. The screen for reading it, the alerts and the long-term archiving can come
later; the record itself cannot. Two things are yours: how long the record is kept (the most
concrete published number is twelve months, from a payment-card standard that does not apply to
Fathom but is what a reviewer will have in mind), and whether the record stores a person's full
network address or a shortened one.

### 3.3 Corrections applied

1. Dependency provenance corrected: `sha2`/`hmac` come via `postgres-protocol 0.6.12`, not
   `argon2`/`hkdf`; WO-12 §5 is what adds those.
2. Event count corrected to twenty-four (the draft's own enum); the *"~14 sites"* cost line and the
   plain English no longer state a number the list contradicts.
3. Plain-English tamper sentence rewritten: *"can be spotted when the record is checked against a
   copy kept elsewhere"*.
4. Daily chain-head anchor moved from `43` L4 (7-day operational) to `43` L6 (administrative
   action, longer retention); the detection window stated as equal to the anchor's retention.
5. AU-9 quoted with both parts; AU-9(b) stated as LOW-baseline and deferred with the viewer and
   alerting; verbatim text of (b) marked VERIFY.
6. Divergence from `49` §13 stated; **choice taken** — *a secret-bearing field viewed* is added.
7. Concurrency serialisation specified (**choice taken** — unique `(tenant_id, prev_hash)` with
   retry); *"row volume is small"* replaced by *unmeasured, tied to op-batch frequency*.
8. *"Twelve months minimum"* moved to *Needs the owner*; PCI DSS 10.5.1 kept as the benchmark.
9. `source_addr` contradiction resolved (**choice taken** — `43` P-8 truncation by default, full
   precision an operator option); the outlives-the-tenant consequence named.
10. Tenant-less rows given a home (a reserved system chain outside the per-tenant RLS predicate).
11. Citation path corrected to `docs/40-stack/43-deployment-modes.md`; OWASP quoted as *"Data import
    and export including screen-based reports"*; *"server-assigned"* dropped and the sequence's
    location marked VERIFY; plain English softened to *"already has a place for who made each
    change"*.

Applied beyond the list, under §1 item 6: the plain English's *"this is days of work"* is removed
(no measurement behind it; B2 fix 4's rule). Also from the skeptic's `invented` list without a
numbered fix: *"the corpus has not yet said so"* about a post-pivot read audit is withdrawn — `49`
§13's last paragraph already implies it; only `36` Q75 is unrevised.

### 3.4 Could not establish

1. NIST SP 800-92 (2006) and the SP 800-92 Rev 1 draft: csrc.nist.gov and nvlpubs.nist.gov are both
   blocked at the proxy. Not opened; nothing here relies on it. NIST's position is taken from SP
   800-53 Rev 5.2.0 instead, via NIST's own OSCAL repository on GitHub.
2. The AICPA's primary text of SOC 2 CC7.2: aicpa-cima.com is blocked. The criterion wording is
   confirmed from two independent GitHub-hosted copies (prowler, wazuh); the points of focus are from
   one copy only (prowler) and are recorded as secondary.
3. ISO/IEC 27002:2022 8.15's implementation guidance — the per-entry field list (user ID,
   timestamps, addresses etc.): the standard is paywalled and iso.org is blocked. Only the
   one-sentence control statement is established (two independent copies). Search-engine summaries
   of the guidance were seen and are deliberately not recorded.
4. PCI DSS v4.0 primary text: pcisecuritystandards.org is blocked; 10.5.1 is confirmed from two
   independent GitHub-hosted copies.
5. Which tier Lucidchart, Miro, Figma, Atlassian, Slack and Notion put their audit logs in, and
   their retention: help.lucid.co, help.miro.com, help.figma.com, support.atlassian.com,
   api.slack.com and notion.so are all blocked. Search snippets exist and are not recorded as
   opened. The comparable-product evidence here is limited to NetBox, Nautobot, GitHub, Grafana,
   Vault, Kubernetes and CloudTrail.
6. Mattermost's audit-log tiering: the compliance page was opened but does not state which edition
   includes it; the JSON audit-log schema page was not located.
7. Whether any of the three named frameworks REQUIRES cryptographic tamper-evidence at a first
   enterprise review: no opened source says so. NIST places AU-9(3) in the HIGH baseline only; SOC 2
   and ISO say 'protect'. Tamper-evidence is therefore recommended on cost and on the never-backfill
   property, not asserted as a framework requirement.
8. Vault's current audit-device text: only the v1.15.0 (2023) tagged copy on GitHub could be
   opened; the current documentation site is blocked.
9. A retention number for Fathom specifically: no framework opened sets one for a product of this
   kind. Twelve months is PCI DSS 10.5.1's figure used as a benchmark, not a requirement Fathom is
   under.

### 3.5 Needs the owner

- *"Do you want the first release to keep this record from the first drawing it saves — yes or no?
  (If yes, everything else above is decided for you; if no, the demo answer to "is there an audit
  log?" stays "not yet".)"*
- Moved by fix 8: the retention commitment. Twelve months is PCI DSS 10.5.1's benchmark, not a
  requirement Fathom is under; the adopting enterprise sets the figure, and the owner sets what the
  first release promises.
- Offered by fix 9: whether `source_addr` is stored truncated (`43` P-8, the default taken here) or
  at full precision — a privacy decision the owner may override.

---

## 4. C1 — What the server may dial out to

**Answers:** `OPEN-FOR-THE-OWNER.md` §C1. Related: §C3 (the rulebook says the tool never connects
to anything), ADR-0020 (the AI tiers), `43` §6.10.

**Direction (validated):** write the short allowlist down and enforce it as **default-deny at the
network layer**, with every exception a named, reviewed row.

### 4.1 Recommendation, as corrected

**The rule.** The server may connect to:

1. its own database;
2. DNS — **the platform's resolver, never an arbitrary DNS server** (the Kubernetes sentence that
   defines the row is quoted in full below);
3. the customer's directory or identity provider;
4. the mail relay;
5. the key store;
6. the certificate authority;
7. **conditionally, and not silently:** a model or inference endpoint, one configured origin, **only
   if and when ADR-0020's tier 1 (BYOK hosted) or tier 3 (enterprise self-hosted inference) ever
   ships.** `49` is silent on the AI layer entirely; that silence is flagged to the owner rather
   than resolved by omission here;

— and **nothing else**. Any other outbound connection is a fault. **Never a network device. Never a
Fathom-operated endpoint.** Enforcement is default-deny at the network layer — on compose a network
declared `internal: true` (the compose-spec sentence is the general one; docker/cli's `--internal`
paragraph is written about overlay networks and is not the authority for compose), on Kubernetes
`43` §6.10's NetworkPolicy — with the exceptions routed through **one egress door whose checked-in
allowlist file IS the written rule**, so a change to the rule is a reviewed diff.

**What is true today, and only that.** Verified against the tree on 2026-09-04, not from the notes:
`crates/fathom-server/Cargo.toml` has six direct dependencies (tokio, axum, tracing,
tracing-subscriber, tokio-postgres, deadpool-postgres); `cargo tree -p fathom-server --locked -e
features -i hyper-util` shows hyper-util with `default/http1/server/service/tokio` and **no `client`
feature**; the dependency closure — **93 unique packages on the host target** (`cargo tree -p
fathom-server --locked -e normal`), **114–115 with `--target all`**, **115 external packages in
`Cargo.lock`** — contains no reqwest, lettre, openidconnect, LDAP, DNS-client or KMS crate; the only
`TcpStream::connect` in the crate is `src/healthcheck.rs`, which probes this same binary over
loopback and says in its own header it *"must never grow into"* a general HTTP client; `src/db.rs`
connects with `NoTls` to `DATABASE_URL`, which `deploy/compose.yaml` sets to `db:5432` on the compose
network, and `db` is `expose`d, not published. **That supports one claim: the server binary makes no
outbound connection but to its database.** It does not support more: the postgres and caddy images
were read as configuration, not examined or run — `deploy/README.md`'s status is NOT RUN — and
whether Caddy makes any non-ACME outbound connection (OCSP stapling, for one) is **not established**
by the Caddy page opened; *"no outbound from Caddy today"* is withdrawn. **And the deployment file
that would ENFORCE the rule is the next server order's change**: `deploy/compose.yaml` declares no
`internal:` network today. Until that is on `main`, the owner may say that nothing in the code
reaches out; he may not say that the deployment makes it a property rather than a promise.

**Where the reverse proxy stands.** Caddy is **inside the rule** for the self-hosted `tls
internal`/files shape — `deploy/Caddyfile` runs `tls internal` with `admin off`, and Caddy's
documentation (caddyserver/website, `automatic-https.md`) states *"Local HTTPS does not use ACME nor
does it perform any DNS validation"*, so it needs no egress there. For the hosted shape its ACME
reach IS row 6, the certificate authority: Caddy docs — *"By default, Caddy enables two
ACME-compatible CAs: Let's Encrypt and ZeroSSL"*, the HTTP challenge *"requires port 80 to be
externally accessible"*, TLS-ALPN *"requires port 443"*. `43` §5.3 rejects an in-binary ACME client
because *"It is an outbound connection … fails in the air-gapped and internal-CA cases, which are
most of this product's customers"*; `49` §19 reverses that for the hosted shape only.

**What phase 1 adds, each a named row, from decided documents.** (a) The identity provider — OIDC for
hosted (`49` §6 chooses `openidconnect`; `43` §5.2: *"fetches the IdP's JWKS over TLS. That is the
only outbound connection fathom-sync ever makes"*), a direct LDAP/AD bind for self-hosted (`49` §12;
the owner's requirement, `70` §18.2). (b) A mail relay — `49` §19 phase 1: *"Speak SMTP to a
transactional provider; do not run a mail server"*, crate `lettre`. (c) The key store — ADR-0040 D1
requires a master key held by a provider; §9 items 1–2 leave which open (§2 above); WO-12 says
outright *"A cloud KMS wrap is a network round trip"*; a protected local file provider needs no
egress. (d) The certificate authority, as above. (e) DNS, to resolve the above. (f) The database,
already present. Rows (a)–(d) are per-deployment addresses; the rule is the categories and *"nothing
else"*. Whether the phase-1 crates honour a proxy setting such as `HTTPS_PROXY` — the egress-door
mechanism per destination — is the executing order's to establish (*Could not establish* item 3).

**The DNS row, defined by the full sentence.** Kubernetes documentation: *"A default deny-all egress
policy also blocks DNS traffic. If your workloads need DNS resolution, you must add a separate
NetworkPolicy that allows egress to your cluster's DNS service."* The qualifier is the row: the
platform's resolver, never an arbitrary DNS server. Two honest notes: **DNS is a covert channel that
a default-deny does not close**; and on compose, whether containers on an `internal: true` network
still resolve each other by service name — which `DATABASE_URL=…@db:5432` depends on — is
**unestablished** and must be proved by running the modified compose file (*Could not establish*
item 2; `deploy/README.md`'s own *"treat the first run as the test"*).

**The log path.** Audit and operational logs go to **stdout** and are collected by the host or the
platform (the json-file driver; a DaemonSet). **The server itself never pushes logs.** If a future
order wants the server to push to a SIEM or an OTLP collector, that is a new row reviewed like any
other, not something the rule permits silently. (§7's chain-head anchor rides this path.)

**What comparable products do.** Of the four comparable self-hosted products the research examined,
**three phone home by default; Sentry asks** — its beacon is opt-in per the page opened (*"If you
opt-in to it…"*), with a forced explicit opt-in/out choice at install since 22.10.0; where a given
Sentry install reads that setting from is not established (*Could not establish* item 5). The three
others are named in the reasoning beyond the cut; the documentation hosts consulted for them
(docs.gitlab.com, grafana.com, netboxlabs.com) were blocked and GitHub-hosted sources used.

**NIST SP 800-53 SC-7(5)** (deny by default, allow by exception) is cited from NIST's own OSCAL
catalogue and a second independent dataset (GovReady), which agree verbatim on the discussion text;
**the control statement carries an organisation-defined parameter placeholder** —
`{{ insert: param, sc-07.05_odp.01 }}` in OSCAL, `<2>` in GovReady — **which any quotation of it
elides.** Character-identity with the published PDF could not be checked (*Could not establish*
item 4).

**Object storage** is not on the list: `43` §6 specified an S3-compatible store for the cluster
shape and `49` §6 replaced the blob-store design with PostgreSQL; the D3 shape has not been
re-specified since the pivot (*Could not establish* item 6). If it returns, it is a row.

### 4.2 Plain English, as corrected

I recommend writing the short list down rather than staying silent. Today nothing in the server's
code or its container setup gives it anything to reach but its own database — I checked the actual
code and the container files, not just the notes — but the setup file that would make that a hard
rule, so the server has no way out of its private network at all, is not yet written; it is the next
server change. When sign-in, email and the key store arrive they are added as named rows: your
company's login service, your mail relay, the key store, the certificate authority, the platform's
own name lookup, and nothing else — never a switch, router or firewall, and never a "phone home" to
us. One row is conditional and nobody has put it to you: if Fathom ever gets an AI feature that
calls a model, that model endpoint is one more named row, and the current server plan says nothing
about AI at all. Logs go to the machine's own log collector; the server never sends them anywhere
itself. Once enforced, anything not on the list simply fails instead of quietly working. The cost is
a few lines in the setup file, one extra small piece later, and the discipline that every future
addition has to be written down and reviewed.

### 4.3 Corrections applied

1. The AI layer added explicitly (**choice taken** — a seventh conditional row, gated on ADR-0020
   tier 1 or 3 shipping); `49`'s silence on the AI layer flagged to the owner.
2. The "today" sentence narrowed to what exists: the code gives the server nothing to reach; the
   enforcing deployment file is the next server order's; the owner is not told he may say
   *"the deployment file makes that a property"*.
3. *"112-crate closure"* replaced by measured, labelled figures with the commands that produced
   them (93 host-target; 114–115 `--target all`; 115 in `Cargo.lock`).
4. *"ZERO outbound connections"* narrowed to the server binary; postgres and caddy images stated as
   read-not-run; Caddy placed inside the rule for the self-hosted shape (**choice taken**) and its
   ACME reach identified with row 6 for hosted; *"no outbound from Caddy today"* withdrawn.
5. *"Every one of them phones home by default"* corrected to *"three of the four; Sentry asks"*.
6. The Kubernetes DNS sentence quoted in full and made the definition of the DNS row; DNS as a
   covert channel and compose's embedded resolver on internal networks noted as unestablished.
7. The log path stated: stdout, collected by host/platform; a SIEM/OTLP push is a new row.
8. docker/cli's `--internal` paragraph noted as written about overlay networks; the compose claim
   rests on the compose-spec sentence.
9. SC-7(5)'s organisation-defined parameter placeholder stated as elided by the quotation.

### 4.4 Could not establish

1. The rendered vendor documentation pages themselves: docs.docker.com, docs.gitlab.com,
   grafana.com, develop.sentry.dev, netboxlabs.com, kubernetes.io, caddyserver.com, csrc.nist.gov
   and csf.tools all returned 403 at the egress proxy. Every quotation is from the GitHub-hosted
   source file of the same documentation on its default branch as of 2026-09-04, not from a tagged
   release; the published pages may carry version labels or edits the source does not.
2. Whether containers on a Docker network declared `internal: true` still resolve each other by
   service name (which `DATABASE_URL=...@db:5432` depends on). The docker/cli reference read says it
   "does not discuss DNS behavior in relation to the --internal flag". This must be proved by running
   the modified compose file — deploy/README.md's own "treat the first run as the test" rule — not
   asserted.
3. Whether the crates 49 §6 names for phase 1 (`openidconnect`, `lettre`) or any LDAP/KMS client
   honour a proxy setting such as HTTPS_PROXY. None of them is in the tree and none was opened; the
   egress-door mechanism for each destination is the executing order's to establish.
4. Whether NIST's OSCAL 5.2.0 catalogue text for SC-7(5) is character-identical to the published SP
   800-53 Rev 5 PDF. NIST's own OSCAL repository and a second independent dataset agree verbatim;
   the PDF on csrc.nist.gov could not be opened.
5. Sentry's `sentry/sentry.conf.example.py` in getsentry/self-hosted contains no `SENTRY_BEACON`
   line; the beacon and its off switch are documented only in the develop-docs page cited. Which
   file a given Sentry install actually reads for that setting was not established.
6. Whether an S3-compatible object store is ever a runtime destination. 43 §6 specified one for the
   cluster shape and 49 §6 replaced the blob-store design with PostgreSQL; no current document
   requires object storage, so it is not on the list, but the D3 shape has not been re-specified
   since the pivot.

### 4.5 Needs the owner

- *"Do you agree the server may only ever connect to that short list — its own database, your
  company's login service, your mail relay, the key store and the certificate authority — and never
  to any network device or back to us, with anything else treated as a fault?"*
- Flagged by fix 1: `49` says nothing about the AI layer; if ADR-0020's tier 1 or tier 3 is still
  wanted, the model endpoint is a row of this rule and the owner should know the rule reserves it.

---

## 5. C2 — Whether people may sign in with a device password

**Answers:** `OPEN-FOR-THE-OWNER.md` §C2. Related: `49` §12 (the sign-in shape already planned),
ADR-0040 §2 and §6, ADR-0041, invariant 3 (`.context/conventions.md`), `32` §21.3 / `33` §18.3 (the
enumeration of held secrets).

**Direction (validated):** Fathom **never acts as a TACACS+ or RADIUS client** and never accepts a
device password as its own login; sign-in is the customer's federation where they have it, the
customer's directory where they do not, and a Fathom-local password only as the exceptional case —
the shape `49` §12 already plans.

### 5.1 Recommendation, as corrected

**The rule, split into the two claims the sources support.**

**(a) Firm, and well sourced:** Fathom never implements TACACS+ or RADIUS, never holds an AAA shared
secret, and never lets its own login integrity depend on the AAA transport. From the protocol texts
(opened 2026-09-04 from GitHub-hosted copies; rfc-editor.org is blocked — *Could not establish* item
9): TACACS+ (RFC 8907, September 2020, Informational) carries the password in the packet body — for
ASCII login *"the server will obtain the password using a continue with
TAC_PLUS_AUTHEN_STATUS_GETPASS"*, for PAP *"the data field MUST contain the PAP ASCII password"*
(§5.4.2); its §10.1 calls its own protection *"'obfuscation' and not 'encryption', since they
provide no meaningful integrity, privacy, or replay protection"*; §10.5 says *"a network
administrator MUST NOT rely on the obfuscation of the TACACS+ protocol"* and that it *"MUST be
deployed over a network that is separated from other traffic"*; §10.5.1 says shared secrets are to
be treated *"as would be expected for other sensitive data such as identity credential
information."* RFC 9887 (December 2025, Standards Track, updates 8907): *"The security mechanisms
as described in RFC 8907 Section 4.5 are extremely weak"* and *"obfuscation is hereby obsoleted"* in
favour of TLS 1.3. RADIUS (RFC 2865, June 2000): the User-Password is hidden by XOR against
MD5(shared secret ‖ Request Authenticator) — the client must hold the plaintext to do this (§5.2);
§8: the hiding *"has not been subjected to significant amounts of cryptanalysis"*. CVE-2024-3596 /
BlastRADIUS (GHSA-3g8x-wqfp-q876, published 2024-07-09, Critical, CVSS 3.1 9.0): *"susceptible to
forgery attacks by a local attacker who can modify any valid Response … using a chosen-prefix
collision attack against MD5 Response Authenticator signature."* FreeRADIUS 3.2.5 (ChangeLog *"Tue
09 Jul 2024 … urgency=high"*) added the mitigations; its `radiusd.conf.in` says that with
`require_message_authenticator` and `limit_proxy_state` both off *"MITM attackers [can] create fake
Access-Accept packets to the NAS"*, that *"At least one of them MUST be set to 'yes'"*, and that the
flag *"is ignored for TLS"*. RFC 9765 (April 2025, Experimental) removes MD5 and the shared secret
only for RADIUS/TLS and RADIUS/DTLS — *"No changes are made to RADIUS/UDP or RADIUS/TCP."* A relay
would mean a new stored secret (the shared secret — a held secret of exactly the class invariant 3
enumerates), a plaintext password in Fathom's process on every login, and Fathom's login integrity
resting on a transport whose own standards call it weak. The reasoning is cut mid-sentence at the
start of this list; the three points are the skeptic's restatement of its §1.

**(b) A property of federation ONLY:** *"the password never reaches Fathom"* is true for OIDC/SAML
sign-in and **for nothing else.** The self-hosted **direct LDAP/AD bind sends the user's directory
password through Fathom's process once per login** (RFC 4513 §5.1.3/§6, GitHub-hosted mnot/rfc-refs
copy; django-auth-ldap `docs/authentication.rst`). And where that directory also backs the switches'
AAA server — FreeRADIUS `raddb/mods-available/ldap` (v3.2.x) *"bind as user"* against AD; Microsoft
NPS: *"The same set of credentials is used for network access control … and to sign in to an AD DS
domain"* (MicrosoftDocs/windowsserverdocs `nps-top.md`, ms.date 05/05/2025) — **that password IS the
device password.** FreeRADIUS and NPS documentation show this is a standard configuration, not an
edge case. So the recommendation is: **SSO first; the LDAP bind as the documented self-hosted
fallback with LDAPS or StartTLS mandatory**; a Fathom-local Argon2id password as the exceptional
case.

**The LDAP bind's own secret.** The LDAP path is specified as a **direct bind — no service account**
— by default. If a deployment requires a service-account bind (the NetBox pattern:
`AUTH_LDAP_BIND_DN` / `AUTH_LDAP_BIND_PASSWORD`, `docs/installation/6-ldap.md`), that credential is a
**held secret of the same class** as the AAA shared secret in (a), by the same argument, and the
`32` §21.3 / `33` §18.3 enumeration **must carry it**. The draft's *"invariant 3's exhaustive
enumeration of held secrets needs no amendment for this decision"* is retracted until the executing
order confirms direct bind is sufficient for the owner's employer.

**What the corpus permits to be said.** ADR-0040 §2 — the decision paragraph — is where *"device
credentials are protected by never arriving"* lives, and it is about the ingest gate and storage; it
is **not established for the sign-in path** and this record does not claim it there. ADR-0040 §6's
always-available sentence is a different one: *"Fathom never touches your devices, and it destroys
every password before it stores anything. There is no credential to steal."* — with its platform
caveat. ADR-0041 adds that a hand-typed credential-looking value is stored and exported as typed
(invariant 3 is annotated to say so). The honest plain-English form is therefore *"it never talks to
the login servers your switches use"*, not *"it never has your device passwords"*.

**Comparable products.** NetBox and Nautobot authenticate their own users against a directory or an
identity provider, not against network AAA (`49` §12's named pattern is NetBox's LDAP page). The
Oxidized row's finding, in the changelog's own words: oxidized-web 0.15.0 (2025-02-17) fixed an
issue where *"A non-authenticated user could gain control over the Linux user running
oxidized-web"* — the draft's *"RCE"* was not the source's word. Whether Cisco Prime, Junos Space,
Netshot or Unimus authenticate their own administrators against TACACS+/RADIUS could not be checked
(*Could not establish* items 1–2). NIST SP 800-63-4's *"Federation and Assertions"* heading and its
three benefit bullets were confirmed verbatim in the GitHub rendering; the section number the draft
gave (§2.4) was not visible there and is not asserted. `www.cisco.com` is EGRESS_BLOCKED at the
proxy.

**Corpus citations, corrected.** The parse-server discussion is `docs/30-security/38-the-egress-
question.md` §14 (*"The parse-server question"*), §14.3 the checklist; there is no
`38-parse-server-question.md`.

### 5.2 Plain English, as corrected

Fathom will never talk to the login servers your switches use (TACACS+ and RADIUS) and will never
hold their secret — that part is firm and well sourced: those protocols carry the password in a form
the relay has to see, their own standards call their protection weak, and a copy of Fathom that
relayed them would be a place to collect a working password for every device. How people sign in
instead depends on what the company has. With company single sign-on, the password never reaches
Fathom at all. Without it, Fathom checks the password against the company directory — and then the
password does pass through Fathom once per login, protected in transit; and if that same directory
is what the switches' login server checks against, which is a standard setup, it is the same
password people type into the switches. Failing both, a Fathom-only password. So the honest sentence
is not "Fathom never has your device passwords" — it is "Fathom never talks to the login servers your
switches use" — and the tools most like Fathom (NetBox, Nautobot) sign people in the same way,
against the company directory or login service. The cost is small: a company connects Fathom to the
staff directory it already has, which the plan already includes.

### 5.3 Corrections applied

1. The rule split into (a) never TACACS+/RADIUS, never an AAA secret, never AAA-dependent login
   integrity, and (b) *"the password never reaches Fathom"* as a property of federation only; the
   LDAP/AD bind's pass-through stated with its sources; SSO first, LDAP fallback with LDAPS/StartTLS
   mandatory.
2. The *Needs the owner* sentence rewritten so it is true on every offered path.
3. *"A device password remains something Fathom is protected from by never arriving … and that
   sentence stays true"* dropped; ADR-0040 §2's sentence confined to the ingest gate and storage.
4. Plain English's *"it never has your device passwords"* replaced by *"it never talks to the login
   servers your switches use"*, consistent with ADR-0040 §6's caveat and ADR-0041.
5. Corpus path corrected to `docs/30-security/38-the-egress-question.md` §14 / §14.3.
6. ADR-0040 attribution corrected: *"never arriving"* is §2; §6's sentence quoted as it reads.
7. LDAP bind secret addressed (**choice taken** — direct bind, no service account, by default; a
   service-account credential, if ever configured, enumerated as a held secret); *"needs no
   amendment"* retracted.
8. Oxidized row reworded to the changelog's own words.
9. RFC 4513, django-auth-ldap `authentication.rst`, FreeRADIUS v3.2.x `mods-available/ldap` and
   MicrosoftDocs `nps-top.md` added as sources (read 2026-09-04); `www.cisco.com` recorded as
   EGRESS_BLOCKED.
10. *Could not establish* item 8 annotated with the mirror question the design depends on (see the
    bracketed note there; the original is kept verbatim per this record's rule).

Also from the skeptic's `invented` list without a numbered fix: NIST SP 800-63-4 *"§2.4"* not
asserted.

### 5.4 Could not establish

1. Whether vendor network-management systems (Cisco Prime Infrastructure, Junos Space) authenticate
   their own administrators against TACACS+/RADIUS — cisco.com and juniper.net are blocked at the
   proxy; not asserted either way.
2. Whether Netshot or Unimus support RADIUS/TACACS+ login for their own users — docs.netshot.net and
   wiki.unimus.net blocked; Netshot's GitHub repository is not code-search indexed.
3. The exact publication date of NIST SP 800-63B-4 — no opened page carried it; the GitHub rendering
   confirms it is the finalized revision that supersedes SP 800-63B. The corpus (`49` §12) records
   2025-07-31 from a 2026-08-21 lookup by another session; not re-confirmed today.
4. The current status of draft-ietf-radext-deprecating-radius ('Deprecating Insecure Practices in
   RADIUS') — a search snippet said still an Internet-Draft at -09 (March 2026); datatracker.ietf.org
   is blocked and the snippet is not recorded as an opened page.
5. The NSA Network Infrastructure Security Guide, CISA's hardening guidance and NCSC guidance on AAA
   and credential handling — media.defense.gov, cisa.gov and ncsc.gov.uk blocked; no GitHub-hosted
   copy exists (nsacyber publications list checked). No claim in this recommendation rests on them.
6. Microsoft's privileged-access (enterprise access model / clean source principle) page itself —
   learn.microsoft.com blocked and the file is not in the public MicrosoftDocs repositories searched;
   only the Entra Connect prerequisites page's tiering sentences were opened.
7. The BlastRADIUS technical paper and the CERT vulnerability note — blastradius.fail,
   networkradius.com, kb.cert.org and nvd.nist.gov blocked; the CVE text was taken from GitHub's
   advisory record and the mitigation semantics from FreeRADIUS's own configuration comments.
8. Whether common enterprise AAA products (Cisco ISE, Aruba ClearPass) always front an AD/LDAP
   directory — which would mean no customer is left with the AAA server as their only identity store;
   vendor sites blocked, not checked. *[Corrected per fix 10: the question the design actually
   depends on is the mirror one — whether the customer's directory is the credential store for its
   AAA server — and the FreeRADIUS `mods-available/ldap` and Microsoft NPS documentation opened today
   show that this is a standard configuration.]*
9. RFC 8907 and RFC 2865 were read from GitHub-hosted copies (mnot/rfc-refs; FreeRADIUS doc/rfc), not
   from rfc-editor.org, which is blocked. Their headers (RFC number, category, date) were checked in
   the raw text; byte-identity with the RFC Editor's copy was not verified.

### 5.5 Needs the owner

- The question, rewritten by fix 2 so that it is true on every path: *"Can I record the rule as:
  Fathom will never talk to the login servers your switches use (TACACS+/RADIUS) and will never hold
  their secret; people sign in with company single sign-on where the company has it, otherwise with
  the company directory (in which case the password does pass through Fathom once per login,
  protected in transit), or with a Fathom-only password — yes or no?"*
- The original wording, for the record: *"Can I record the rule as: "People sign in to Fathom with
  their company login (or a Fathom-only password), never with the password they use on the network
  equipment"? — yes or no."* — withdrawn as false on the self-hosted path.

---

## 6. `49` §16.2's device half — how a device proves itself to the firmware server

**Answers:** `docs/40-stack/49-the-server-product.md` §16.2 — the per-device SSH key, the shared
read-only machine account `fw-pull`, and the separate per-person writing account. The **server
half** of §16.2 was decided (`CLAUDE.md` § *State*, item (e)); this decision is about the **device
half**, which §16.1a(vi) now records as *documented but unproven*. Related: `OPEN-FOR-THE-OWNER.md`
§B12 (whether Fathom ever holds firmware images — the recommendation on file is no, and this decision
does not reopen it).

**Direction (validated):** option (c), weighted to (a) — **keep the per-device SSH key as the
design and the server half exactly as decided; re-label the device half per-platform as documented
but unproven until bench-tested; do not promote the HTTPS signed-URL door to primary; keep the shared
password rejected.**

### 6.1 Recommendation, as corrected

**What could be opened.** Every fact below is from vendor-authored models and code — `Juniper/yang`
(commit `96ad7bad`); the `aristanetworks`, `arista-eosplus` and `arista-eosext` organisations —
the OpenBSD project's own RFC mirror (`openbsd/www`), OpenSSH's own man pages (openssh-portable
master, Mdocdate 2026-09-02), and a PDF copy of NIST IR 7966 hosted in a third-party GitHub
repository whose front matter was verified (title, four authors, DOI 10.6028/NIST.IR.7966, *"50
pages (October 2015)"*). The egress proxy refused (CONNECT 403) www.juniper.net,
supportportal.juniper.net, community.juniper.net, www.arista.com, docs.arista.com, eos.arista.com,
arista.my.site.com, www.rfc-editor.org, datatracker.ietf.org, www.ietf.org, csrc.nist.gov,
nvlpubs.nist.gov, doi.org, man.openbsd.org, man7.org, manpages.debian.org, www.openssh.com,
anongit.mindrot.org, netconfcentral.org, cisco.com, docs.paloaltonetworks.com, web.archive.org,
github.com (HTML) and api.github.com (unauthenticated); raw.githubusercontent.com and GitHub code
search opened. **One method note that matters for this corpus:** GitHub code search silently skips
files over ~384 KB, and Juniper's conf and request modules are 260 KB–1.9 MB, so an earlier
*"no key-generation RPC"* was a search that could not have found one; the modules were fetched raw
and grepped.

**The server half stands — every mechanism confirmed from primary text.** RFC 4252 §7: *"The only
REQUIRED authentication 'method name' is "publickey" authentication. All implementations MUST
support this method"*; *"the possession of a private key serves as authentication … The server MUST
check that the key is a valid authenticator for the user, and MUST check that the signature is
valid."* §8: the password method sends a *"plaintext password in ISO-10646 UTF-8 encoding"*, and
*"All implementations SHOULD support password authentication"* — on by default everywhere, switched
off deliberately. OpenSSH `sshd(8)`: `restrict` — *"Enable all restrictions, i.e. disable port,
agent and X11 forwarding, as well as disabling PTY allocation and execution of ~/.ssh/rc"*;
`from="pattern-list"`; `command="command"`. `sshd_config(5)`: `ForceCommand`, `ChrootDirectory`,
`PasswordAuthentication` *"The default is yes"*, `PubkeyAuthentication` *"The default is yes"*, and
`FingerprintHash` *"Specifies the hash algorithm used when logging key fingerprints"* — so the server
does log key fingerprints, which is §16.3(b)'s fix. NIST IR 7966 (October 2015) **§3.4.1** (the
document's own contents table: password §3.4.1, host-based §3.4.2, Kerberos §3.4.3, public key
§3.4.4): *"Password authentication is generally not recommended for automated processes because it
doesn't provide the level of access control available with other authentication methods, especially
public key authentication."* Its group-key rotation sentence is in the AC-2 control-mapping table,
not a "Recommendations" section. The reasoning is cut here.

**The device half on the primary platform — per `49` §16.1a(vi), the lead reviewer's verified
record, which governs this section.** `Juniper/yang` at commit `96ad7bad`, read 2026-09-04, blob
fetched and grepped rather than searched:

- `rpc request-system-download-start` — `junos-es-rpc-request@2025-01-01.yang`, 25.2R1, **line
  2787**; present again at 25.4R1, **line 2875**. Its input leaves, verbatim: `url` *"URL of
  file"*; `max-rate`; `save-as`; **`login` — *"Login credentials (username:password)"*;
  `identity-file` — *"Identity file for sftp pubic key authentication"*** [sic, Juniper's own
  spelling]; `passphrase` — *"Passphrase used to protect identity key pair"*; `delay`.
- `rpc generate-ssh-key-pair` — same module, **line 4630** — *"Generate SSH key pair identity"*,
  with a mandatory `identity-name` and an optional `passphrase`.
- And, from §16.1a(ii): `rpc file-copy` in `junos-es-rpc-file-mgd@2025-01-01.yang` at 25.2R1 has
  exactly four input leaves — source, destination, source-address, routing-instance — no identity
  file, no username, no passphrase. `file copy` has nowhere to put a key, **and it is not the only
  door.**

So on the SRX **Juniper models both halves of §16.2's device side**: a command that mints a named
SSH identity on the box, and an SFTP download command that accepts one. **What is not established —
and is exactly the bench test — is whether the `identity-name` the first command mints is what the
second command's `identity-file` expects**, and whether that path exists on MX and EX, whose
`junos-rpc-request` modules §16.1a(vi) records as not read. The corpus had one fact backwards (an
earlier note said the SRX could not mint its own identity) and §16.1a(vi) corrects it. **The `login`
leaf is the shared-password path**, vendor-documented on the same command: it is the one line a
generated runbook must never emit, and the rejection §16.2 made is now tied to a leaf by name — the
tie to **invariant 3** is explicit: a runbook that filled `login` would put a device credential in
a Fathom-generated artifact.

**Provenance table, rewritten.** SRX: a Juniper-documented download command with a public-key slot
(`identity-file`) and a Juniper-documented key-minting command — *documented, unproven that one
feeds the other*. MX and EX: not read at the lead's verification; the skeptic's differing account is
under *Disagreements* and is not asserted here. Junos Evolved: the corpus's *"has one (22.3R1)"* is
uncorroborated, not refuted (*Could not establish* item 2). EOS: nothing found establishes key
authentication for an image fetch (`49` §16.1a(iii) stands); the three examples found — GitHub
files — all answer a `Password:` prompt with a stored password; *"every real example anyone has
published"* is withdrawn as a generalisation the search does not support. The `arista-eosext/rphm`
README line is verified; its `INSTALL` is not at the repository root at commit `45067ac` (HTTP 404)
and is dropped.

**The bench test, re-specified.** Four checks, on one real SRX (or vSRX) and one real EOS box (or
cEOS/vEOS):

1. SRX — `request system download start sftp://fw-pull@<server>/<image> identity-file <…>`:
   establishes **what `identity-file` accepts** — the `identity-name` minted by
   `rpc generate-ssh-key-pair`, or a file path — and **which URL schemes `url` takes**. (The CLI
   spelling of the minting command is the recommendation's, `request security ssh key-pair-identity
   generate`; §16.1a(vi) records BOTH the RPC name and the CLI form: `junos:command "request security ssh key-pair-identity generate"`, verified 2026-09-04 against the `rpc-with-extensions` variant of the same module at 25.2R1 (`Juniper/yang` `96ad7bad`). What a real box accepts after `generate` — the `identity-name` argument by keyword or positionally — is the bench test's step 1, `docs/80-review/evidence/2026-09-04-firmware-bench-test.md`.)
2. SRX — `file copy scp://…`: the legacy-SCP question, `49` §16.3(a). **`scp://` and `sftp://` are
   distinguished throughout**; the two commands are two doors.
3. EOS — whether `copy scp:` or `install source scp:` can authenticate with a key at all.
4. EOS — how a server host key is loaded for `hostkey client strict-checking`.

**No duration is claimed in this record** — the draft carried three inconsistent ones (15 minutes,
30 minutes, one hour) and all are removed; the only sourced figure is `49` §16.1a(vi)'s *"thirty
minutes on one real SRX or a vSRX"*, which covers the Juniper half only.

**Sequencing is not this record's.** *"The first firmware task is the bench test"* is moved out of
what this decides and into *Needs the owner* as a proposal; work ordering is planning's and the
owner's under `78`.

**The HTTPS signed-URL door is not promoted.** It is exactly as unproven on the device side (which
certificate store `file copy https://` consults on SRX/MX/EX, whether EOS `copy https://` accepts a
private CA — *Could not establish* item 5; `49` §16.3(c) records no certificate-check bypass on the
primary platform), and a signed URL is a bearer credential.

**The shared password stays rejected, and the Arista fallback is priced.** If EOS can only
authenticate with a password, option (a) is a **separate account and password per switch** on the
firmware server — per-device Unix accounts, each revocable one switch at a time, each a password
stored on that switch; NIST IR 7966 §3.4.1 calls password authentication for automated processes
*"generally not recommended"*, not forbidden. Option (b) is no firmware-fetch feature for Arista
until something better is proven. Which is the owner's — it is his employer's policy on stored
passwords (*Needs the owner*).

**What goes into the `49` §16.2 update.** The re-label; the provenance above; and this pre-answer:
**the shared `fw-pull` account will be challenged by any enterprise "no shared accounts" control.**
The answer, written into the generated runbook text: identity is per device, the account is shared,
and the server attributes every login to a key — `sshd_config` `FingerprintHash` and NIST IR 7966's
*"log key fingerprints"* — so revoking a device is deleting one line and every pull is attributable.

### 6.2 Plain English, as corrected

The plan for how a firewall or switch proves who it is when it fetches new firmware from your server
was written before anyone checked whether your boxes can actually do it, and today Juniper's and
Arista's own published models and code were checked (their websites are unreachable from here).
Your Juniper SRX firewalls do have a built-in command to create their own login key (earlier notes
said they did not), and Juniper documents a download command with a slot for such a key; whether the
key the box makes is the key that command takes is exactly the test nobody has run. Your Arista
switches show no sign of key login anywhere in Arista's own material — the three examples I could
find all type a password. So: keep the key-based design, label it "documented but not yet proven on
this box" for each kind of equipment, and — if you agree with the order of work — make a test on one
real SRX and one real Arista switch the next firmware task. Do not switch to the "special web link"
method instead — it is just as unproven on the devices, and a link that acts as a password is still
a password. Using one shared password for every device stays off the table: Juniper's download
command has a username-and-password option, and the instructions Fathom generates must never fill it
in. One more thing an enterprise reviewer will ask: the shared read-only account every device logs
in to will be challenged as a "shared account" — the answer is that each device has its own key and
the server logs which key it was.

### 6.3 Corrections applied

1. Source #3's *"no ssh/scp/sftp CLI mapping carries an identity option"* corrected: the download
   RPC with `identity-file`, `login` and `passphrase` is recorded — **from `49` §16.1a(vi)**, per
   the lead's override; the provenance table rewritten (SRX documented-but-unproven; MX/EX not read;
   the skeptic's EX/QFX and 17.2R1 line references are under *Disagreements*, not restated).
2. The SRX bench test re-specified: check 1 `request system download start sftp://… identity-file`
   (what `identity-file` accepts; which schemes `url` takes); check 2 `file copy scp://` (legacy
   SCP); `scp://` and `sftp://` distinguished; both unknowns added under *Could not establish*.
3. The `login` leaf named as the vendor-documented password path a runbook must never emit, tied to
   invariant 3.
4. Plain English fixed: *"nothing shows that the firmware-download command actually uses that
   key"* replaced; *"every real example anyone has published"* → *"the three examples I could
   find"*; a single duration or none.
5. The three inconsistent durations removed; none claimed; `49` §16.1a(vi)'s thirty minutes cited
   as the only sourced figure, for the SRX half.
6. Sequencing moved out of what this decides into *Needs the owner*.
7. The conditional Arista question added to *Needs the owner*; option (a) priced.
8. NIST IR 7966 section numbers corrected (§3.4.1 password; §3.4.2 host-based; §3.4.3 Kerberos;
   §3.4.4 public key; the rotation sentence in the AC-2 mapping table).
9. The `rphm` `INSTALL` reference dropped; the README line kept.
10. Added under *Could not establish*: how the SRX stores the minted private key at rest, whether
    any `show`/backup/`save` path exposes it, and whether it survives upgrade.
11. The `fw-pull` shared-account challenge and its fingerprint-attribution pre-answer written into
    the §16.2 update text.

Also from the skeptic's `invented` list: *"That is the whole device half on the primary platform"*
withdrawn (the download RPC is a second, documented door).

### 6.4 Could not establish

1. Whether 'file copy scp://' on an SRX presents the identity minted by 'request security ssh
   key-pair-identity generate' — no config leaf and no RPC input ties the two; this is the bench
   test.
2. Whether MX, EX (classic Junos outside the SRX family) or Junos Evolved have ANY CLI to generate an
   outbound SSH identity — none is in their 25.2R1 YANG, but a CLI-only command would not appear
   there; the corpus's 'Junos Evolved has one (22.3R1)' is uncorroborated, not refuted.
3. Whether Arista EOS 'copy scp:' or 'install source scp:' can authenticate with a key at all, and
   how a server host key is loaded for 'hostkey client strict-checking' — arista.com is blocked and
   no Arista-authored file shows either.
4. Whether the Junos CLI's scp still uses the legacy SCP protocol on OpenSSH 9+ (49 §16.3(a),
   PR1787659) — Juniper release notes unreachable, not re-verified.
5. Which certificate store 'file copy https://' consults on SRX/MX/EX and whether EOS 'copy
   https://' accepts a private CA — the HTTPS door's device half is exactly as unproven as the SSH
   door's.
6. The Juniper quotation 'Do not use the scp protocol in the request system software add command' —
   still uncorroborated (juniper.net blocked); do not repeat it to a customer as a vendor quotation.
7. NX-OS passwordless SCP and PAN-OS 'scp import' key support as stated in 49 §16.1 — cisco.com and
   docs.paloaltonetworks.com blocked; not re-verified today.
8. Whether a Junos-generated SSH identity survives a software upgrade (49 §21 item 13).
9. NIST IR 7966 was read from a third-party GitHub-hosted PDF because every NIST host is blocked; its
   integrity rests on its own front matter (title, authors, DOI, October 2015, 50 pages), not on a
   NIST-served file.
10. Whether Junos 'file copy' accepts 'user:password@' inside an scp:// source URL — the source leaf
    is an unconstrained string.
11. Any comparable-product evidence beyond Arista's own ZTP tooling (Cisco Catalyst Center, Junos
    Space/Mist, PAN-OS, SolarWinds) — all vendor hosts blocked.

Added by the skeptic (fixes 2 and 10), 2026-09-04:

12. What `identity-file` on `request system download start` accepts — the minted `identity-name`,
    or a file path — and which URL schemes its `url` leaf takes.
13. How the SRX stores the minted private key at rest, whether any `show`, backup or `save` path
    exposes it, and whether it survives a software upgrade (`49` §21 item 13) — an enterprise
    reviewer will ask where the unencrypted automation key lives.

### 6.5 Needs the owner

- *"Can you get someone 30 minutes on one real Juniper SRX and one real Arista switch (or their
  virtual versions, vSRX and cEOS/vEOS) to run a four-step test of whether each box can log in to
  the firmware server with a key, or only with a password?"* — the question as asked; note the
  duration in it is the draft's, and §6.1 claims none.
- Moved by fix 6, as a proposal: that the bench test be the first firmware task.
- Added by fix 7, conditionally: *"If your Arista switches can only log in with a password, do you
  want (a) a separate account and password per switch — revocable one switch at a time, but a
  password stored on each switch — or (b) no firmware-fetch feature for Arista until something
  better is proven? This is about your employer's policy on stored passwords, so it is yours."*

---

## 7. B2 — Whether an operator may read a customer's network map

**Answers:** `OPEN-FOR-THE-OWNER.md` §B2 (*May you read a customer's network map?*), with a
boundary drawn against §B4 (who sees what inside one company) and §A2 (the audit log). Related:
ADR-0040 §9 item 4, WO-12 §7 triggers 5–6 and §8, `49` §13 and §19.

**Direction (validated):** **yes, but never quietly** — a deliberate, short-lived, reason-required
elevation, off by default, that notifies the design's people and cannot be entered unless a
tamper-evident record is written first; locked-out recovery is a membership fix, not a read; for
outside customers, approval-before-access and a customer-held key.

### 7.1 Recommendation, as corrected

**The shape.** An organisation admin is **not a superuser over designs**; reading a design they are
not a member of requires **elevation scoped to one named design** — reason plus design, the Customer
Lockbox shape — that is off by default, time-boxed, re-authenticated, and **cannot be entered unless
a tamper-evident audit record of it is written first**: if the record cannot be written, the door
does not open. **Notification fires at each design-open-under-elevation event** — an email to the
design's members and a persistent line on the design itself — so the notification is coherent with
the scope: there is no org-wide "open anything" mode whose start is announced once and whose opens
are then silent. The role list beyond that single sentence (look only / edit / invite / run the
account) is **B4's** and is not decided here.

**What this does and does not do to A2.** This is the **privileged-access subset** of the audit log
— elevated opens, exports under elevation, membership changes — shipped first because it cannot be
added to the past. It does **not** answer A2 proper, which `OPEN-FOR-THE-OWNER.md` §A2 defines as
every design open by anyone, every write batch, every export, plus `49` §13's must-list (created,
shared, config pasted). **A2 remains the owner's question** (§3). What is put to him is the
conjunction: *B2 with a record requires A2 = yes; accepting this answers both.* ADR-0040 §9 item 4
is **not** declared closed here — that is planning's and the owner's (`CLAUDE.md` rule 3; `78` §5).

**Sequencing, honestly.** An elevation flow needs sessions, re-authentication, roles, membership and
SMTP, none of which exists (WO-12 §7 trigger 5; `49` §19 phase 1). So: the audit table lands **in
the same migration as the first actor that produces an auditable event**; the **key wrap, unwrap,
re-wrap and destroy events (WO-12 §7 trigger 6) are the only ones loggable in the order after
WO-12**; and **elevation ships with sharing/membership**, not before. No effort figure is stated:
the draft's *"days, not weeks"* / *"a few days of work"* had no measurement behind it and `49` §19
says its own estimates are to be distrusted. It is small next to the rest of the server work; that
is the whole claim.

**The columns — the first plaintext column is a decision, not a convenience (WO-12 §8).** Enumerated:
a per-chain sequence; `tenant_id`; `design_id`; `actor_id`; `event` (from A2's closed list);
`at` (server clock); `source_addr` (A2's default: `43` P-8 truncation); `outcome`; `reason`
(elevation events only); `prev_hash`; `hash`. **Identifiers, never names.** The `reason` field is
**bounded in length** (the bound is the executing order's; unbounded is the defect) and is run
through `fathom_ingest::redact::looks_like_credential` (ADR-0041): a credential-shaped reason is
**marked, not refused** — ADR-0041's precedent — because refusing is beaten by rewording and the
mark protects the member who reads it. **The on-design "reason:" line shows the admin's free text to
every member**; the owner should know that before approving, because it is the mechanism's point and
its exposure at once.

**The record's two honest limits, stated for the employer deployment.** (1) The chain is unalterable
by anyone using Fathom; **by whoever administers Fathom's database it is not**, unless a copy is
kept off the machine. So by default the chain head is written on a schedule to `43`'s L6
administrative stream via the log path C1 specifies (stdout, collected off the machine by the
platform) — the same anchor A2 specifies, and no new egress row. (2) **The operator half of B2:
whoever runs the server machine and holds its key file can read every drawing without going through
Fathom and without any record**, until A1 (a separate key service with its own log) is answered. The
record here guards Fathom's door, not the machine's.

**When the notification cannot be sent.** The email is written to an **outbox in the same
transaction as the elevation record**, so it is never lost; the delivery failure is logged. *"Cannot
be switched off"* is not left silent on failure.

**What the comparable products do** (all opened 2026-09-04; blocked hosts under *Could not
establish*). GitLab Admin Mode (`doc/administration/settings/sign_in_restrictions.md`): *"With Admin
Mode, your account does not have administrator access by default"*; administrators *"get a 404 error
if they try to open a private group or project, unless they are members"*; *"for administrative
tasks, you must authenticate"*; *"It is disabled automatically after six hours"*; entering it is an
audit event, `user_enable_admin_mode` — *"Admin Mode enabled"* (`audit_event_types.md`, GitLab
15.7). Without Admin Mode the baseline is the opposite — *"Users with administrator access have all
permissions and can perform any action"* (`permissions.md`) — so GitLab ships both shapes and the
hardened one is opt-in; Fathom should ship only the hardened one. GitHub Enterprise Server
impersonation (`github/docs`, `content/admin/…/impersonating-a-user.md`): *"For each impersonation
session, you need to provide a reason for the impersonation. A session is limited to one hour"*;
*"Actions you perform during an impersonation session are recorded as events in the enterprise audit
log, as well as the impersonated user's security log. The person being impersonated is sent an
email notification when the impersonation session starts. You cannot deactivate these emails."*
GitLab, independently: *"All impersonation activities are captured with audit events"*
(`user_impersonation`). Azure Customer Lockbox (MicrosoftDocs/azure-docs,
`articles/security/fundamentals/customer-lockbox-overview.md`): *"provides an interface for your
organization to review and approve or reject customer data access requests"*; the engineer first
goes through *"a just-in-time (JIT) access service"*; the request waits in a *"Customer Notified"*
state; *"The request remains in the customer queue for four days. After this time, the access
request automatically expires and no access is granted."* The reasoning is cut mid-sentence in the
Lockbox paragraph. The AWS CloudTrail quotation was opened from an awsdocs GitHub mirror; whether
that repository is archived could not be established (github.com and api.github.com refused), and
the word is dropped.

**Locked-out recovery** is a membership fix — an admin adds a member — never a read.

**Outside customers** (ADR-0040 D2's destination, the trigger being the first customer who is not
the owner): the customer approves each request first and holds their own key.

### 7.2 Plain English, as corrected

Yes, an admin may open any drawing in the company, but never quietly. They have to switch on a
special mode for one named drawing for a short time, type the reason, and everyone on that drawing is
told it happened — by email and by a line on the drawing itself that shows the reason they typed.
Each such opening is written into a permanent record the admin cannot turn off or edit, and if the
record cannot be written the door does not open. That record is part of what question A2 asks about
— the part that covers privileged openings, exports and membership changes — but not the whole of
it; A2 itself (every opening by anyone, every change, every export) stays your question, and saying
yes to this means saying yes to that. Two honest limits: the record cannot be altered by anyone
using Fathom, but it could be by whoever administers Fathom's database unless a running checksum of
it is kept off the machine, which this does by default; and whoever runs the server machine and holds
its key file can read every drawing without going through Fathom and without any record at all,
until question A1 (a separate key service with its own log) is answered — this guards Fathom's door,
not the machine's. None of it can be built until sign-in, roles and sharing exist, and none of it can
be added to the past later. Letting a locked-out person back in should be done by fixing their
access, not by reading their drawing; and when there are outside customers, the customer approves
each request first and holds their own key.

### 7.3 Corrections applied

1. Stopped claiming A2 is answered (**choice taken** — the privileged-access subset ships first; A2
   proper remains the owner's; the conjunction is what is put to him).
2. Notification made coherent with scope (**choice taken** — elevation scoped to a named design,
   the Customer Lockbox shape; notification at each elevated open).
3. Sequencing fixed: audit table with the first auditable actor; key-lifecycle events the only ones
   loggable after WO-12; elevation ships with sharing/membership.
4. The unmeasured cost claim removed; *"small next to the rest of the server work"* and no number.
5. The operator half of B2 added to the plain English.
6. What-it-decides #5 recast as a recommendation the owner ratifies together with B2; ADR-0040 §9
   item 4 not declared closed.
7. What-it-decides #6 narrowed to *"an organisation admin is not a superuser over designs; reading a
   non-member design requires elevation"*; the role list left to B4.
8. WO-12 §8's non-goal acknowledged: columns enumerated; identifiers not names; the reason bounded;
   `looks_like_credential` applied (**choice taken** — mark, not refuse); the on-design reason line
   stated as visible to every member.
9. The off-machine copy (**choice taken** — chain head on a schedule to `43` L6 via the C1 log path,
   not a new SIEM push row); the plain English states the database-administrator limit.
10. Email failure behaviour stated: outbox in the same transaction; delivery failure logged.
11. *"archived"* dropped from the awsdocs source.

### 7.4 Could not establish

1. Google Cloud Access Transparency and Access Approval (customer-visible log of Google staff
   access, and approval-before-access): cloud.google.com, docs.cloud.google.com and
   support.google.com all refused by the egress proxy (403). Not asserted.
2. Slack Enterprise Key Management — revocation granularity and customer-side logging of key use:
   slack.com and slack.engineering refused. ADR-0040 §1 finding 3 records Slack EKM from a
   2026-08-28 survey; that record was not re-opened today and is cited only as the corpus's own
   prior lookup.
3. Atlassian organisation audit log (retention, who can view, whether it can be disabled) and
   Atlassian staff access to customer data: support.atlassian.com and www.atlassian.com refused.
4. Lucid, Figma and Miro — whether an account/organisation admin can open documents they are not a
   member of: help.lucid.co, lucid.co, help.figma.com and help.miro.com all refused. This matters
   because Lucid is the owner's named model product.
5. AWS IAM best practices and AWS break-glass / pre-provisioned-access guidance (Well-Architected
   SEC10-BP05), and the AWS Data Privacy FAQ on AWS staff access to customer content:
   docs.aws.amazon.com and aws.amazon.com refused. Only the CloudTrail boilerplate from one archived
   awsdocs GitHub mirror was opened.
6. HIPAA 45 CFR 164.312(a)(2)(ii) 'emergency access procedure' and (b) 'audit controls' verbatim
   text: ecfr.gov, law.cornell.edu, govinfo.gov and hhs.gov all refused.
7. Okta 'grant Okta Support access' (customer-granted, time-limited vendor access recorded in the
   System Log) as a further second-source for the multi-customer shape: help.okta.com refused.
8. NetBox superuser scope (whether superusers see every object) — the permissions and
   authentication pages opened do not state it; not asserted. Grafana server administrator dashboard
   visibility across organisations — the roles page opened does not state it; not asserted.
9. Whether any comparable network-documentation product (NetBox, Nautobot) ships an admin-elevation
   or read-audit feature at all: no page stating either way was found on an open host.

(Item 5 carries the word *"archived"* verbatim as the research wrote it; fix 11 establishes that
the adjective is unsupported, and the body above does not use it.)

### 7.5 Needs the owner

- *"Inside your company, when an admin switches on "open any design" to look at someone else's
  drawing, is it enough that the drawing's people are told and it is permanently recorded — or must
  a second person approve first, every time?"*
- Recast by fix 6: *B2 with a record requires A2 = yes; accepting this answers both* — put to him as
  one decision, not two.
- Surfaced by fix 8: the admin's free-text reason is shown to every member of the design.

---

## 8. D2 / D10 — Groups and tags

**Answers:** `OPEN-FOR-THE-OWNER.md` §D2 (answered 2026-09-04 as *both* — a real named set **and** a
tagging system, `70` §19.1 — with the kind's name, multi-membership, nesting and cross-site spanning
still open beneath it) and §D10 (whether a group is visible to everyone). Related: ADR-0008, `62`
§16.2, `70` §19.2 (the Meraki organisation / network / device tiers).

**Direction (validated):** **two kinds, kept apart on purpose** — `Group` (a deliberate named set)
and `Tag` (a typed word with case-folded identity) — each root-contained with one flat many-to-many
reference edge to `Placeable`; a group is a saved selection that holds no firmware version; schema
0.5 → 0.6, minor.

### 8.1 Recommendation, as corrected

Add `Group` and `Tag` as two root-contained kinds with case-folded name identity and one flat
many-to-many reference edge each to `Placeable`; keep the group as a saved selection that holds no
firmware version (a campaign lists the members and writes the version onto each device); bump
0.5 → 0.6, minor. Neither kind is drawn as a box: a group of forty members across three sites, drawn
as a root-level box with forty lines, is the default renderer's output and nobody designed it (`56`
§1.2; `70` §10.4 — how a scattered group looks *"is a design problem, not a coding one"*).

**Three things the plain English must say and the draft did not.** (1) **An older build does not
open a 0.6 file.** The shipped `importJournal` stops at the first group or tag record with *"step N
is a kind of change this build does not know"* after resetting the module; there is no
`Kind::Unknown` and no preserve mode in the code. The true half stays: nothing already saved changes,
and every 0.5 file still opens in 0.6. (2) **The "PCI and pci are one tag" reuse rule arrives with
the tagging gesture** — a later order — not with this schema change: the store does not enforce
identity tuples and nothing consumes `fold` today. (3) **A group lives inside one drawing.** Edges
are NodeId → NodeId inside one graph (`70` §10.9), so an organisation-wide *"PCI scope across all my
designs"* or an organisation-wide tag vocabulary — Meraki's organisation tier, which is how the
owner described firmware campaigns (`70` §19.2) — would be a server table, never a graph node. He
should be able to object now rather than after the first cross-design campaign.

**Member order** is `EdgeId` order — fixed at creation and replayed identically — not "creation
order" (a ULID's low 80 bits are random within one millisecond); it carries no meaning, and no face
may present it as a sequence.

### 8.2 Plain English, as corrected

You get two separate things, kept apart on purpose. A group is a named list you create deliberately
— "Q3 firewall refresh" — and drop equipment into: you can rename it without losing anything, put
one box in several groups, and mix boxes from different sites, but a group cannot sit inside another
group, and a group lives inside one drawing — a group that spans several drawings, the way a Meraki
organisation does, would be a different, server-side thing. A tag is a word you type onto a box —
"pci", "legacy". The rule that Fathom reuses the same word if it already exists, so PCI and pci are
one tag and not two, arrives with the tagging control itself, in a later change; this change only
makes room for it. To push a firmware version to a group, Fathom simply lists the group's members
and writes the version onto each device one at a time; the group itself holds no version and makes
no decisions. It costs two new kinds of record and four new links in the schema. Nothing you have
already saved changes, and every file saved today still opens afterwards — but a file saved after
this change, if it contains a group or a tag, will not open in an older copy of Fathom: the older
copy stops at the first thing it does not recognise and says so.

### 8.3 Schema change

Reproduced from the workflow output, which cut this field at 2,500 characters; corrections applied
in place and marked. The `kinds:` block for `Group` and `Tag` — with the three fields (keys
312–314) and the four edge kinds `HasGroup`, `HasTag`, `GroupMember`, `AppliedTo` — lies beyond the
cut and is the executor's to write to the shape the version comment describes.

```yaml
# schema/schema.yaml

### 1. `schema:` block — bump, and the version comment gains the pricing paragraph the file's own
###    convention requires

schema:
  version: "0.6"    # (existing 0.1–0.5 paragraphs unchanged above this line)
                    #
                    # 0.6 is groups and tags (owner, 2026-09-04, 70 §19.1: "A real named
                    # set" AND "We also needed a tagging system as well"). Two kinds (Group,
                    # Tag), four edge kinds (HasGroup, HasTag, GroupMember, AppliedTo),
                    # three fields all on the new declarers, field keys 312-314. Priced
                    # against 62 §16.2: "New node kind | minor" twice, "New edge kind |
                    # minor" four times, and fields on a new declarer are minor by the same
                    # table (WO-10's reading). Nothing existing moved: no retype, no tuple
                    # reordered, no containment restructured -- both kinds hang off root by
                    # NEW containment edges, so no existing kind's owner changes. The
                    # Placeable class is deliberately NOT widened (see its comment).
                    # CORRECTED (fix 1): an older build does NOT open a 0.6 export that
                    # carries a group or a tag -- importJournal stops at the first such
                    # record ("step N is a kind of change this build does not know") after
                    # resetting the module. Every 0.5 export opens in 0.6. Whole change = MINOR
                    # by the table; the forward direction is refused, not tolerated.

### 2. `classes:` block — `Placeable` is NOT widened; one comment is appended inside its member
###    list, after `DhcpRelay`

      # Group and Tag (0.6) are deliberately ABSENT, the first kinds besides LayoutPin to be.
      # They are not drawn as boxes: a group of forty members across three sites, drawn as
      # a root-level box with forty lines, is the default renderer's output and nobody
      # designed it (56 §1.2 [CORRECTED, fix 4: was "56 §0"]; 70 §10.4: how a scattered group
      # looks "is a design problem, not a coding one"). They join LayoutPin in
      # `fathom_layout::agg::live_nodes`'s exclusion, in `fathom_layout::layers::projection_of`
      # [ADDED, fix 2: an exhaustive match; E0004 without Group and Tag arms -- their
      # Projection is untabled / not drawn], and in shipped_tree.rs's
      # `every_kind_but_the_pin_itself_is_placeable`, whose own doc says it changes "to say
      # which, in one place, with the reasoning beside it". Admitting either later is a
      # widened from-set on HasLayoutPin: minor.

### 3. `kinds:` block — appended at the tail, after `DhcpRelay`
###    [CORRECTED, fix 4: was "62 §2.3: order is wire identity". The true reason to append:
###    62 §2.3 -- declaration order is generated-enum and diff order; wire keys come from
###    field-keys.yaml; schema.order.inserted lints mid-block insertion.]

  # ======================= groups and tags -- 70 §19.1, 2026-09-04 =======================
  - kind: Group
    layer: config
    emits: false
    # [cut at 2,500 characters in the workflow output]
```

Two instructions to the executor for the part beyond the cut: the `GroupMember` doc says member
order is **`EdgeId` order, fixed at creation and replayed identically** (fix 6), and the sentence
calling `agg.rs live_nodes` *"the one place a not-drawn kind is listed"* is deleted (fix 2).

### 8.4 What it forecloses

1. Two kinds is the one-way door: merging Tag into Group later (or splitting a single kind) is a
   MAJOR bump — a kind removed, wire keys retired, and a migration rewriting every membership edge —
   so the group/tag split is the part to be sure of.
2. A group is visible to everyone who can open the design. A group or tag private to one person is
   not expressible in this shape: a per-person field would be a user reference, which `11` §6.9 and
   invariant 3 forbid in the graph, so privacy could only ever be a server-side layer outside the
   graph (`OPEN-FOR-THE-OWNER.md` §D10).
3. A group cannot span two designs/workspaces: edges are NodeId → NodeId inside one graph (`70`
   §10.9), so an organisation-wide 'PCI scope across all my designs' or an organisation-wide tag
   vocabulary (Meraki's org tier) would be a server table, never a graph node.
4. Root containment is fixed: re-parenting a group under a Site or a Tenant later is 'containment
   restructured' — major. Site-local groups would have to be modelled as a filter, not as
   ownership.
5. Identity folds ASCII case only. 'Q3-refresh' and 'Q3 refresh' stay two things; a richer
   normalisation later is a new `fold` value in `62` §9.1's grammar plus a migration that could
   merge existing tags — not cheap.
6. Member order is `EdgeId` order and carries no meaning; if any face presents it as a sequence,
   users will rely on it, and the honest fix later is an `ordinal` field on GroupMember (minor)
   plus re-education.
7. `to: [Placeable]` couples 'can be grouped' to 'can be drawn as a box'; if they ever diverge, a
   Groupable class must be split out and every consumer that assumed the identity found.
8. Not nesting is NOT a foreclosure (widening GroupMember.to is minor), but any op/face written
   against flat groups will need a cycle check added the day nesting lands.

### 8.5 Migration, as corrected

Minor bump, 0.5 → 0.6, priced against `62` §16.2 row by row: two new node kinds (minor ×2), four new
edge kinds (minor ×4), three fields on new declarers (minor), zero removals, zero retypes, zero
reordered tuples, no containment restructured (both kinds hang off `root` via NEW containment edges,
so no existing kind's owner changes), `Placeable` deliberately not widened. **Existing records:
untouched byte for byte** — no existing field key, kind, edge or cardinality moves; every valid 0.5
export is a valid 0.6 export. **Forward direction: refused, not tolerated.** A 0.5 build opening a
0.6 export that carries a `Group` or `Tag` record stops at that record — `importJournal` resets the
module and reports *"step N is a kind of change this build does not know"* — and the import is lost
as a whole, named rather than silent. (The draft's `Kind::Unknown` / preserve-mode claim is
withdrawn: neither exists in code.) No `Migration` impl, no golden fixture, no migration note (those
are major-bump gates). `schema/released/` is still empty, so `schema.version.bump-too-small` has no
snapshot to diff against; the version comment carries the pricing as the file's own convention.
Field keys 312–314 append at the tail of `schema/field-keys.yaml`; on reversal they retire and are
never reused (R2, ADR-0035/0036's shape) and any workspace written meanwhile carries groups a later
build must ignore rather than misread.

**Executor's checklist, completed.** Edit `schema.yaml` and `field-keys.yaml`; regenerate with
`cargo run -p fathom-schemagen`; re-pin `crates/fathom-schema/tests/shipped_tree.rs` (kinds 53,
edges 99, keys 314, version "0.6") and amend its Placeable drift test to name the three exclusions
(`LayoutPin`, `Group`, `Tag`); add `Group`/`Tag` to `fathom_layout::agg::live_nodes`'s exclusion
**and** add their arms to `crates/fathom-layout/src/layers.rs` `projection_of` (the build fails
E0004 without them — decide their Projection, presumably untabled / not drawn); re-pin
`crates/fathom-ir/tests/canon_laws.rs` `SCHEMA_VERSION` to "0.6";
`crates/fathom-workspace/tests/plain_face.rs`'s PINNED header to 'schema 0.6' (its
`pinned_header_tracks_the_schema_version` test); `crates/fathom-weld/tests/containment.rs`'s
containment-kind count to 46 with the orphans vector gaining `Group` and `Tag` — `resolved` stays
98, because root is not a `NodeKind` and neither kind is `Placeable`; `cargo test --workspace
--locked` and `fathom-schema-check` green with zero warnings (no ImportScope claims either kind, so
`schema.identity.unexercised` stays silent).

### 8.6 Corrections applied

1. The forward-compatibility claim rewritten in migration and plain English: an older build does
   not open a 0.6 file; `Kind::Unknown` / preserve mode not cited.
2. `layers.rs` `projection_of` added to the consequences; the *"one place a not-drawn kind is
   listed"* sentence deleted.
3. `canon_laws.rs`, `plain_face.rs` and `containment.rs` pins added to the checklist with their new
   values (and the note that `resolved` stays 98).
4. Citations fixed: the tail-append reason restated per `62` §2.3; `56` §0 → `56` §1.2.
5. Plain English says the case-fold reuse rule arrives with the tagging gesture.
6. `GroupMember` doc: `EdgeId` order, not "creation order".

From `decides_owner_business`, applied: one plain sentence that a group lives inside one drawing.

### 8.7 Needs the owner

- *"Is it fine that every group and every tag is seen by everyone who can open that drawing, or do
  you need some that only you can see?"*
- Surfaced from the foreclosure list: a group cannot span drawings; if the Meraki organisation tier
  is how he wants firmware campaigns to read (`70` §19.2), that is a server-side table beside this,
  not this.

---

## 9. D3 — A box with more than one role

**Answers:** `OPEN-FOR-THE-OWNER.md` §D3 (*Can a box do more than one job?*) — **open, with no
recorded answer**; `70` §19 does not mention roles. Related: ADR-0037 (a server is a `Device` with a
role), `62` §7 and §16.2/§16.4, `fathom-ir` canon rule 12.

**Direction (validated):** widen `Device.role` to a **set of the existing seven words** — no new
words, no `Role` kind (0 of 3 limbs), no second `roles` field beside `role` — taken as schema 0.6
while nothing is stored, **as a major-class change taken pre-1.0**.

### 9.1 Recommendation, as corrected

Widen `Device.role` to `type: "set{device_role}"`, `card: "0..n"`, moving the seven words to
`schema/enums/device_role.yaml` — because `set{X}` is generatable only over an enum-file member:
`crates/fathom-schemagen/src/extract.rs:605` (*"set over X — only enum-file members are generatable
today"*) and `crates/fathom-schema/src/gates.rs:229`, which resolves `set{X}` only against
`schema/enums/` and the scalar list. `62` §7 rule 4's two limbs (a spelling map; a second use) do not
apply here; it is cited only to say no rule forbids the move. Refuse both alternatives: a `Role` kind
(ADR-0037 §2's three-limb test, zero of three) and a second `roles` field beside `role` (minor by the
letter, and a permanent two-spellings-of-one-fact defect — priced and rejected in the draft's
reasoning).

**The frozen-order rule, stated fully.** A `set{}` field is generated as a `BTreeSet` ordered by the
enum's derived `Ord` — declaration order, `Unknown` last — and `fathom-ir`'s canon rule 12 REFUSES a
non-ascending array on read (`CanonError::NonCanonicalOrder`, `crates/fathom-ir/src/canon.rs:240`)
rather than re-sorting it. So: never reorder, never remove; a new variant is appended **after
`other`**, **and that is necessary but not sufficient**: any words appended in the same or later
bumps must also be in **ascending token (string) order among themselves**, because a build that does
not declare them reads each as `Unknown(String)`, derived `Ord` compares Unknowns by their string,
and canon.rs:240 refuses the array otherwise. `family.yaml`, `host_service.yaml` and
`host_protocol.yaml` carry the same latent constraint; this is the first file to say so. ADR-0037
§1's *"`other` reads last"* becomes a rule for the dropdown, not for this list.

**What it is, and what it is not.** A role is a **closed list of seven, refused on a typo, drawn on
the box**; the tag the owner asked for in `70` §19.1 is **a word you type**. The two mechanisms are
not to be argued into one later — `70` §19.1 warns explicitly against that conflation — and the
field doc says so.

**The on-box rendering** — both words when two, first plus "+N" when more — is **the page's current
choice pending the owner**, not schema text: `62` §2.4 ships `doc:` verbatim into generated code,
and the owner has not confirmed it (*Needs the owner*).

**One open item, not a defect.** `parse_into_slot` refuses an empty string, so a set with no boxes
ticked cannot be written through `OP_FIELD_SET` (the in-place cell editor); the equipment form must
omit the field when nothing is ticked, exactly as it omits the blank `<option>` today; clearing an
existing role stays unbuilt, as it is for the single word now.

### 9.2 Plain English, as corrected

Today every box gets exactly one word for its job, so a home gateway has to be called a router and
the fact that it is also a firewall, a switch and an access point is thrown away. After this change a
box can carry as many of the same seven words as are true of it — router, firewall, switch and
access point on one box — and no new words are invented. A role is a word from a fixed list of
seven, refused if misspelt and drawn on the box; that is different from the tag you asked for (a
word you type), and the two are kept apart on purpose. On the picture, the page's current choice —
yours to confirm — is that a box with two jobs shows both words and a box with more shows the first
word and a small "+2", with the full list in the side panel and the equipment list, always in the
same fixed order however you typed them. Nothing you have saved is lost: an old exported file that
says "firewall" simply reads back as a one-word list, and the server holds no data yet, so there is
nothing to convert — but this is the first change to the file format that an older copy of Fathom
could not read, taken now precisely because nothing is stored. The cost is mostly on the screen —
the one-word dropdown on the equipment form becomes seven tick-boxes, the box label learns the "+2"
rule, and one browser test has to be rewritten — plus a rule that the seven words keep their order in
the file forever. One small gap stays open: un-ticking every box (no role at all) is not yet
possible, just as clearing the single word is not today.

### 9.3 Schema change

Reproduced from the workflow output (cut at 2,500 characters), corrections applied in place and
marked. The `Device.role` field's `doc:` and the version-block comment lie beyond the cut; the
instructions for them follow the block.

```yaml
# ============================================================================
# 1. NEW FILE  schema/enums/device_role.yaml
# ============================================================================
# schema/enums/device_role.yaml — Device.role's seven words, moved out of the field's inline
# `enum { ... }` (ADR-0037) because a `set{...}` type is generatable only over an enum-file
# member: crates/fathom-schemagen/src/extract.rs:605 ("set over X — only enum-file members are
# generatable today") and crates/fathom-schema/src/gates.rs:229, which resolves `set{X}` only
# against schema/enums/ and the scalar list. [CORRECTED, fix 6: was an elided quotation of
# 62 §7 rule 4; rule 4's two limbs do not apply here, and no rule forbids the move.]
#
# THE ORDER OF THESE VARIANTS IS NOW PART OF EVERY SAVED FILE AND MUST NEVER CHANGE. A `set{}`
# field is generated as a BTreeSet ordered by the enum's derived Ord — declaration order, with
# the generated Unknown arm last — and fathom-ir's canon rule 12 REFUSES a non-ascending array
# on read (CanonError::NonCanonicalOrder, crates/fathom-ir/src/canon.rs:240) rather than
# re-sorting it. So: never reorder, never remove; a NEW variant is appended at the END, after
# `other` -- AND [CORRECTED, fix 2] any words appended in the same or later bumps must also be
# in ascending token (string) order among themselves, because a build that does not declare
# them reads each as Unknown(String), derived Ord compares Unknowns by their string, and
# canon.rs:240 refuses the array otherwise. Appending after `other` is necessary, not
# sufficient. "`other` reads last" (ADR-0037 §1) is from here on a rule for the DROPDOWN,
# which sorts it last on screen, not a rule for this list. The same latent constraint already
# binds family.yaml, host_service.yaml and host_protocol.yaml; this is the first file to say so.
variants: [firewall, router, switch, load_balancer, server, access_point, other]
doc: |
  What a box is FOR, one word each, and a box may carry several: a home gateway is
  {router, firewall, switch, access_point} and no new word. This answers
  OPEN-FOR-THE-OWNER.md §D3, an open question with no recorded answer as of 2026-09-04
  [CORRECTED, fix 1: the draft cited 70 §19 as the owner having asked; 70 §19 does not
  mention roles. Owner's approval: ____________ (date)]. ADR-0037 §3 argues the seven; §4
  lists what is deliberately NOT a variant so the next person does not re-litigate it.
  `other` stays the honest word for a box the taxonomy has not decided and may sit beside
  real roles — {firewall, other} says exactly what it says. Unknown arm generated (62 §7
  rule 2). No default_by_platform and no platform_spellings: nothing under corpus/dict/
  writes Device.role (checked 2026-09-04), so a role is hand-typed only.

# ============================================================================
# 2. schema/schema.yaml — kind Device, the `role` field: REPLACE the whole entry
# ============================================================================
      - name: role
        type: "set{device_role}"
        card: "0..n"
        emit: "—"
        doc: |
          What the box
          # [cut at 2,500 characters in the workflow output]
```

Instructions for the part beyond the cut. **The `Device.role` field doc** (fix 1, 5, 7): no claim
that the owner asked or answered — cite §D3 as the open question with a dated approval slot; **no
on-box rendering rule** in the doc (it is the page's choice pending the owner; `62` §2.4 ships doc
text into generated code); **one sentence** distinguishing a role (closed list of seven, refused on
typo, drawn on the box) from a tag (`70` §19.1, a word you type). **The version-block comment**
(fix 4) addresses all three of `62` §16.4's major-bump requirements: the **migration note**
(written: a single stored token T becomes the set {T}); the **`Migration` impl** (none — the chain
is empty by design, ADR-0036 §5.2); and the **golden fixture for the outgoing 0.5 version** —
**none is produced**, and the comment says why pre-1.0 excuses it, as ADR-0037 §8.5 and ADR-0036
§5.2 do for the chain: `schema/released/` is empty, so there is no released 0.5 to fix a golden
against.

### 9.4 What it forecloses

1. The order of the seven words is frozen forever once a set is stored: reordering or removing one
   makes every saved set that pairs two moved words unreadable (canon rule 12 refuses a
   non-ascending array), and a new word must be appended AFTER `other` — in ascending token order
   with any others appended alongside it — or an older build refuses files that pair the new word
   with an old one; so ADR-0037's `other`-reads-last becomes a screen rule, not a file rule.
2. Going back to one word per box is a major change with a migration no machine can make: which of
   {router, firewall, switch, access_point} survives is a human choice per box.
3. There is no slot for a PRIMARY role. Anything later that wants to draw the 'main' job bigger,
   pick an icon by it or sort by it needs a new optional field (minor) that every existing
   multi-role box would have unset.
4. A per-role FACT — 'as a router its ASN is X', 'as an access point its SSID is Y' — cannot hang
   off a word in a set; that is the day a `Role` kind scores one of three limbs and earns itself.
   This decision stops short of it on purpose and does not prevent it, but the data typed until
   then carries no such facts.
5. Any future dictionary that stamps a role on paste (none does today) must UNION into the set,
   never overwrite it; the shape helps but the weld has to follow the rule.
6. `{firewall, other}` is legal. If someone later wants 'other means undecided and may not be
   combined', that is a constraint tightened — major by the table.
7. The set-of-enum wire shape is now shared by four fields; any later fix to canon rule 12 (for
   example sorting sets by token so the ordinal stops being load-bearing) must migrate `role`
   alongside `families`, `host_inbound_system_services` and `host_inbound_protocols`.
8. Schema 0.6 is the first version an older build could not read even in a future preserve mode;
   every 0.5 plain snapshot is refused by a 0.6 build — already true of every version mismatch
   today, but now for a reason the table calls major.

### 9.5 Migration, as corrected

Existing records, by where they live: (1) **exported journals** — the file an operator keeps (rule
0) — carry the role as the TEXT that was typed under field key 9 (`OP_FIELD_SET` and `OP_EQUIP_ADD`
frames, `jpush`'d with key, id and value); a replay under 0.6 passes `firewall` to the new author
arm, which reads a bare word as the one-word set {firewall}. No journal is rewritten and none stops
replaying. (2) **`fathom-plain` workspace snapshots** carry canonical values and are already refused
on ANY schema-version mismatch (header line 3, exact match; migration policy deliberately not that
crate's, WO-05 §10.2) — a 0.5 snapshot is refused by a 0.6 build exactly as a 0.4 one is by 0.5
today, pre-release by design (ADR-0037 §8.5). (3) **Server rows** — none exist (WO-11 G8; WO-12 is
OPEN, not executed), which is exactly the window in which a retype costs nothing stored.

**Version bump per `62` §16.2:** on the wire key 9 changes from a token to an array, and an old
build reading it gets `CanonError::Shape`, not the unknown arm — that is the *"Field type changed |
MAJOR | old client: no"* row by the letter, the first change in this file's history an older build
could not read; it is NOT the *"widened cardinality upper bound | minor"* row, because the T inside
`Field<Presence<T>>` changes (`DeviceRole` → `BTreeSet<DeviceRole>`). Recommended: 0.5 → 0.6 with
the version comment saying in words that this is a major-class change taken pre-1.0, because the
file has no way to say major short of declaring 1.0 — `schema/released/` is empty, the migration
chain is empty by design, and `fathom-schema-check` (run 2026-09-04) lists
`schema.version.bump-too-small` and `schema.migration.chain-broken` as not yet checkable. **All three
of `62` §16.4's major-bump requirements are addressed** (fix 4): the migration note is written (a
single stored token T becomes the set {T}); no `Migration` impl is registered because there is no
chain to register it in; no golden fixture for the outgoing 0.5 is produced, because there is no
released 0.5 to fix it against, and the version comment says so. Field key 9 is kept (the registry
keys on the name and the name did not move); retiring 9 and taking 312 would only change WHICH major
row applies. If the owner would rather not take a major-class change even pre-release, the fallback
that is minor by the letter is a second field `roles` beside `role` — priced and rejected above.

**Same-commit code, completed** (fix 3): the generated `ir_types.rs`, `accessors.rs`,
`schema.json`, `ir_types.ts`; the author arm that reads a bare word as a one-word set; the
equipment form (`#ef9` from `<select>` to seven checkboxes) and the inventory cell; the diagram box
label; the tests the draft listed; **and `docs/80-review/evidence/2026-08-16-server-role-drive.mjs`
— its line 72 does `page.selectOption('#ef9', role)` against the role `<select>` and goes red when
`#ef9` becomes checkboxes; it must be rewritten to tick boxes and re-run (23/23 or its new count).**

### 9.6 Corrections applied

1. Both `doc:` blocks reworded: no claim the owner asked or answered; §D3 cited as the open question;
   a dated approval slot; `70 §19` dropped from the enum doc.
2. The frozen-order rule extended: ascending token order among appended words; `canon.rs:240`
   cited; the three other enum files named as carrying the same constraint.
3. `2026-08-16-server-role-drive.mjs` (line 72) added to the same-commit list, to be rewritten and
   re-run.
4. The version-block comment addresses all three `62` §16.4 major-bump requirements, including the
   absent golden fixture and why.
5. The on-box rendering rule removed from schema doc text; marked as the page's current choice
   pending the owner.
6. The elided `62` §7 rule 4 quotation replaced by `extract.rs:605` and `gates.rs:229`.
7. The role-versus-tag sentence added.
8. The empty-set limit recorded as an open item, not a defect.

From `decides_owner_business`, applied: the doc text no longer records D3 as asked-and-answered;
the "+N" rendering and the seven-tick-box form are stated as the page's current choice pending the
owner, not as settled.

### 9.7 Needs the owner

- *"When a box does three or more jobs, is "firewall +2" on the box — with every word one click away
  in the side panel — good enough, or must every word be drawn on the box itself?"*
- The decision itself: D3 is open with no recorded answer; the schema text carries a dated slot for
  his approval and nothing lands until it is filled.
- Surfaced by the migration: whether he is willing to take a major-class change pre-1.0 (the
  recommendation) or would rather the minor-by-the-letter fallback of a second `roles` field, which
  this record recommends against.

---

## 10. D4 — Racks: the move, the height, the premises, the furniture

**Answers:** `OPEN-FOR-THE-OWNER.md` §D4 (*five small ones that travel together*). Related:
ADR-0036 (physical placement is graph data; §8 item 5 the refused move), `57` §14.1 B4 and §15.5–
§15.6, `19` §3.9–§3.10, `11` §7.1.

**Direction (validated):** a **minor 0.6 bump** — one new kind `Fixture` with a one-word `form`,
two new edge kinds `HasFixture` and `RestsOn`, `MountedIn` widened to admit a `Fixture`, an optional
`Chassis.height_u` — and the rack **move treated as an opcode decision the schema has never
blocked**, which is the owner's to reopen.

### 10.1 Recommendation, as corrected

Adopt the 0.6 minor bump below. Treat the rack move as an opcode decision (ADR-0036 §8 item 5; `57`
§14.1 B4) that the schema has never blocked — a button refused on purpose until someone decided what
undo should say — and **offer its reopening to the owner rather than announce it.** Move "this box
is 2U" from the mounting edge to the box (`Chassis.height_u`, optional, because a PC case on a
shelf has no U height); keep `MountedIn.height_u` (key 306) declared and read for records written
before 0.6. Add `Fixture` — shelf, desk, wall, floor, bracket, pdu, ups, other — owned by a
`Premises`, mountable in a rack at a height, and a surface a `Chassis` can `RestsOn` without
pretending to be bolted into a slot. A power strip does NOT know what is plugged into it: the power
topology (feeds, panels, outlets) stays refused unless the owner asks (`19` §3.10).

**The height rule, one rule** (fix 1 — **choice taken**): the elevation reads the node's own
`Chassis.height_u` **first** and the edge's `MountedIn.height_u` **second**, so a box whose height
was recorded before 0.6 draws at that height with no copy-on-read and no rewrite-on-import (a silent
copy would launder an edge fact into a node fact nobody typed). **When both are set and disagree,
the node wins**; the edge's value is the older fact, shown in the inspector as such and never on the
elevation. The draft's other sentence — *"shown as a conflict"* — is deleted.

**The containment rule's citation** (fix 2): `HasFixture`'s doc cites **`11` §7.1** for the
upper-bound-at-write-time rule — §7.1 states it verbatim; §7.2 is the containment table.
`graph.rs` line 636 already cites §7.1; ADR-0036 §8 item 3 and `shell.rs` carry the slip and can be
corrected in the same pass.

**Two doc edits and two annotations that travel with this** (fixes 3–4). `Device.role`'s doc: its
sentence that `pdu`/`ups` *"stay `other` until someone wants power in the elevation, and that is a
rack question"* becomes false the moment `Fixture.form` declares `pdu` and `ups`; it now says: a
strip or UPS with no management address is a `Fixture`; one with an address stays a `Device` with
role `other` until D1 is answered (§15). `19` §3.10's Power row annotated in place, as ADR-0036
annotated its Rack row: PDUs and UPSes are nameable as `Fixture` forms (D4, 2026-09-04), the power
topology still refused. `57` §15.5 given an as-built note (ADR-0039's precedent for `56` §6.3):
`Surface` shipped as `Fixture`, `cabinet_base` dropped, `wall`/`pdu`/`ups` added — the draft's
Fixture doc cited §15.5 without saying the token set changed.

**What goes red, verified** (fix 6): the ONLY compile break is `crates/fathom-layout/src/layers.rs`
`projection_of` (needs a `Fixture` arm); the pinned counts in
`crates/fathom-schema/tests/shipped_tree.rs` (51/95/311/"0.5"), `crates/fathom-ir/tests/canon_laws.rs`
(`SCHEMA_VERSION`; `FIELD_KEYS.len() == 311`), `crates/fathom-ir/tests/edge_tables.rs` (311) and
`crates/fathom-weld/tests/containment.rs` (98 pairs → 100, because a `Placeable` kind costs two; 44
containment kinds → 45) all move; the `Placeable` drift test in `shipped_tree.rs` is the one that goes
red first if `Fixture` is forgotten in `classes:`.

### 10.2 Plain English, as corrected

If you say yes to reopening the move, you will be able to drag a box to the right slot, or into
another rack, and it keeps its cables and its history — nothing in the data stands in the way of
that; it is a button that was refused on purpose until someone decided what "undo" should say, and
reopening that refusal is your call. "This box is 2U" becomes something you type once on the box, so
Fathom remembers it when the box is unracked; anything already typed keeps drawing exactly as it
does now. A rack already records which building it is in; what is missing is a way to add a building
at all, which is again a button, not a data change. Shelves, desks, wall brackets, power strips and
UPSes become one new kind of thing, a "fixture", told apart by one word: a fixture can sit in a rack
at a height, and boxes can rest on it without pretending they are bolted into a slot, so three mini
PCs on one shelf no longer look like three clashes. A power strip will NOT know what is plugged into
it — that is a separate power map Fathom has refused so far, and it stays refused unless you ask for
it. What it costs: a schema version step (0.5 to 0.6), a rebuild of the module, and a work order
that teaches the rack picture and the inventory about fixtures; nothing already typed is changed or
retyped.

### 10.3 Schema change

Reproduced from the workflow output (cut at 2,500 characters), corrections applied in place and
marked. The `Fixture` kind block, its three fields (keys 312–315 with `Chassis.height_u`), and the
`HasFixture`/`RestsOn` edge declarations lie beyond the cut.

```yaml
# All edits in schema/schema.yaml unless named; every new declaration is appended to the tail of
# its block (62 §2.3, `schema.order.inserted`).

# (1) Version block — schema.version "0.5" -> "0.6", with this pricing appended:
schema:
  version: "0.6"    # 0.6 is D4 (2026-09-04): one new kind (Fixture), two new edge kinds
                    # (HasFixture, RestsOn), one widened from-set (MountedIn: [Chassis] ->
                    # [Chassis, Fixture]), one new optional field on an existing kind
                    # (Chassis.height_u) and three fields on the new declarer, field keys
                    # 312-315. Priced against 62 §16.2: "New node kind | minor", "New edge
                    # kind | minor" twice, "widened from/to set | minor", "New optional
                    # field | minor". Zero removals -- MountedIn.height_u (key 306) STAYS
                    # DECLARED and is read for records written before 0.6; the form stops
                    # writing it. Zero retypes, zero tuples reordered, no owner changed:
                    # Fixture hangs off Premises by a NEW containment edge. Whole change =
                    # MINOR.
                    # [CORRECTED, cross-cutting rule (§1 item 6; groups-and-tags fix 1): the
                    # sentence "An old build reading a 0.6 export keeps Fixture as
                    # Kind::Unknown and Chassis.height_u in `unknown`" is withdrawn --
                    # neither Kind::Unknown nor a preserve mode exists in code, and the
                    # shipped importJournal stops at a record it does not know. See §10.5.]

# (2) classes: — Placeable gains one member after DhcpRelay (the shipped_tree.rs drift test
#     fails otherwise):
      # D4 (2026-09-04). A fixture is a live node and the diagram draws it as a box.
      - Fixture

# (3) kinds: — Chassis: append ONE field after `slots` (appending to the kind's own field list,
#     not inserting):
      - name: height_u
        type: u8
        card: "0..1"
        emit: "—"
        constraints:
          range: { min: 1, max: 100, platforms: [] }
        doc: |
          How many rack units THIS BOX is tall. A fact about the box, not about one
          mounting (D4 sub-question 2, 2026-09-04; 57 §15.6 named the misplacement), so it
          survives unracking and travels with a move. Optional, because a PC case on a
          shelf has no U height and recording one would be a lie. The elevation reads
          this first and MountedIn.height_u second; when both are set and disagree the
          node wins and the edge's value is the older fact, shown in the inspector and
          never on the elevation [CORRECTED, fix 1: the one rule]; when both are absent
          the box is drawn as one unit and MARKED unstated, exactly as today.

# (4) kinds: — append after DhcpRelay (tail of the block):
  # D4 (2026-09-04). Appended at the tail because order is wire identit
  # [cut at 2,500 characters in the workflow output. Executor: the tail-append reason is
  #  62 §2.3 -- declaration order is generated-enum and diff order; wire keys come from
  #  field-keys.yaml (groups-and-tags fix 4, the same slip). HasFixture's doc cites 11 §7.1,
  #  not §7.2 (fix 2).]
```

### 10.4 What it forecloses

1. The name `Fixture` and its eight `form` tokens (shelf, desk, wall, floor, bracket, pdu, ups,
   other) become wire identity forever; `57` §15.5's name `Surface` is gone, and renaming either is
   a major bump.
2. Key 306 (`MountedIn.height_u`) is retired in place: it can never be reused, and every reader
   carries the node-then-edge read order until a major bump removes it. *(The draft's clause "a
   record with BOTH set and disagreeing has to be shown as a conflict" is deleted per fix 1; the
   node wins.)*
3. A fixture can never own a `PhysicalPort` without reopening `19` §3.10: outlets, feeds and 'what
   dies if this strip is unplugged' need a second edge family later, not a widening of `PortHost`
   — and choosing that route later means a power cable still cannot terminate on a PDU modelled
   this way.
4. `RestsOn` carries no position, so 'third from the left on the shelf' is unrepresentable; adding a
   position field later is minor, but it re-imports the clash reasoning this shape exists to avoid.
5. A fixture is owned by a `Premises`, not by a `Rack`: moving a rack to another building does not
   carry its shelves (each is its own edit), and 'a rack contains its furniture' can never be a
   containment fact without a major restructure.
6. Height lives on each `Chassis` instance, not on a model catalogue: the same SRX345 typed twice is
   2U typed twice, and a per-model height waits for `19` §3.9's hardware catalogue.
7. A managed UPS or PDU with a management address stays a `Device` with role `other` and a borrowed
   platform until D1 is answered; nothing here adds `pdu`/`ups` to `Device.role`, and adding them
   later while `Fixture.form` also has them creates two spellings of one fact.
8. The move gesture, once built as tombstone-then-insert in one batch, fixes the undo unit at 'the
   whole move'; a half-move (new rack, old slot) becomes two undo steps by construction.

### 10.5 Migration, as corrected

Nothing stored changes and no record is rewritten. Every 0.5 export is a valid 0.6 export. **Forward
direction:** the draft claimed an old build *"keeps `Fixture` as `Kind::Unknown` in preserve mode,
`HasFixture`/`RestsOn` opaque, and `Chassis.height_u` in `unknown`"*; that claim is withdrawn under
the cross-cutting rule — no `Kind::Unknown` and no preserve mode exist in code, and groups-and-tags
fix 1 establishes that `importJournal` stops at the first record whose kind the build does not know.
<!-- VERIFY: the exact behaviour of a 0.5 build on a 0.6 export carrying (a) a Fixture record and
(b) only a Chassis.height_u field set — the kind case follows groups-and-tags fix 1; the
unknown-field-key case was not verified by either skeptic. --> Existing `MountedIn` edges keep
`position_u`, `height_u` and `face` untouched; the elevation reads the node's own `height_u` first
and the edge's second (the node wins on disagreement), so a box whose height was recorded before 0.6
draws at that height with no copy-on-read and no rewrite-on-import. The placement form stops writing
key 306 and writes 312 under the same visible label. Bump: 0.5 → 0.6, MINOR, priced row by row
against `62` §16.2 — new node kind (minor), two new edge kinds (minor ×2), widened `from` set
(minor), new optional field on `Chassis` (minor), three fields on a new declarer (minor); zero
removals, zero retypes, zero identity tuples reordered, no kind's containment owner changed.
`schema/migrations/manifest.toml` regenerates to `schema_version = "0.6"`, `migrations = []`;
`schema/released/` stays empty, so `schema.version.bump-too-small` cannot fire and the bump is honest
by construction rather than by gate. Field keys 312–315 appended; `fathom-schemagen` regenerates
`ir_types.rs` and `schema.json`. **`cargo test --workspace` must stay green, and these are what
move:** `layers.rs` `projection_of` (the only compile break); `shipped_tree.rs` (51/95/311/"0.5");
`canon_laws.rs` (`SCHEMA_VERSION`; `FIELD_KEYS.len() == 311`); `edge_tables.rs` (311);
`containment.rs` (98 → 100 pairs; 44 → 45 containment kinds); the `Placeable` drift test first if
`Fixture` is forgotten in `classes:`.

### 10.6 Corrections applied

1. The both-set-and-disagreeing contradiction resolved (**choice taken** — the node wins; the
   "conflict" sentence deleted from the foreclosure list).
2. `HasFixture`'s citation corrected to `11` §7.1; the same slip noted in ADR-0036 §8 item 3 and
   `shell.rs`.
3. `Device.role`'s doc amended: an unmanaged strip or UPS is a `Fixture`; a managed one stays a
   `Device` with role `other` until D1.
4. `19` §3.10's Power row annotated; `57` §15.5 given an as-built note naming the token-set change.
5. Plain English: the cost added; the first sentence made conditional on the owner reopening the
   move.
6. The execution-consequences list completed with what actually goes red.
7. The `MountedIn`-and-`RestsOn` double-edge case moved to *Failure modes* (it is an L1 hole for a
   future rule, never a store refusal).

Applied beyond the list (§1 item 6): the `Kind::Unknown` / preserve-mode forward-compatibility
sentence withdrawn from the version comment and the migration.

### 10.7 Needs the owner

- *"Is a named box with one word on it (shelf, power strip, UPS) enough for your rack furniture, or
  do you need a power strip to know what is plugged into each of its outlets — the first is this
  change, the second is a power map Fathom has refused so far and would be a separate decision?"*
- From `decides_owner_business`: reopening the refused rack move (`57` §14.1 B4; ADR-0036 §8 item
  5) is his decision, offered here and not announced.

---

## 11. D5 — A presentation layer for facts about the drawing

**Answers:** `OPEN-FOR-THE-OWNER.md` §D5 (*Where you dragged a box on the picture*); ADR-0035 §9
item 1. Related: `11` §10.4–§10.6 (re-identification and the staleness bands), `62` §4.2–§4.3 and
§16.2, `19` §9.1.

**Direction (validated):** adopt **`layer: presentation`** for facts about the drawing; file
`LayoutPin` under it now, while it is the only such kind; leave intent-shaped facts (a target OS
version, a lifecycle state) as fields on the kind they are about.

### 11.1 Recommendation, as corrected

Add a fourth value to the per-kind `layer` vocabulary, `presentation` — a fact about the DRAWING of
the network, not about the network — and move `LayoutPin` onto it. Layer stays a per-kind attribute.
No `intent` layer: intent about a network thing is a field on that thing (`Tunnel.intended_state` is
the precedent); the door to a fifth value for an intent KIND stays open at the same price.

**The mechanical reason, stated to match `11` §10.5** (fix 1). A `LayoutPin` is `Origin::Hand`. It
is contained by the element it places, so for a pin on a `Device`, or on anything under one,
`owner_device` resolves to that device; `config_path(LayoutPin)` is the empty set, and the empty set
is a subset of every capture's covered paths. **Under `layer: config`, a whole-device re-paste puts
every pin on that device into `11` §10.4's scope** (step 1, all three conjuncts pass); step 6 sends
it to §10.5; and the Hand column under `Section`/`Whole` marks it **`Divergent { since }` and raises
a finding.** It does **not** tombstone it. **The defect this closes is therefore a false "intended
but not deployed" finding on every hand-placed pin of every re-pasted device** — not a sweep. The
draft's *"That is the PhysicalPort argument of `19` §9.1 verbatim"* is dropped: `19` §9.1's
tombstone sentence is about `Origin::Imported` ports, whose column `19`'s own Amendment 2 calls
undefined.

**Two rows proposed to `62` §16.2, unambiguous** (fix 4):

| change | bump | old client can read? |
|---|---|---|
| Kind's `layer` changed, out of `config` or between non-config layers | minor | yes, byte-identical (`layer` is never serialised) |
| Kind's `layer` changed INTO `config` | **major** | yes, byte-identical — but previously-immune nodes enter the re-identification scope and the staleness bands |

The second row is priced **major** here (the alternative the skeptic allowed — minor with the
consequences priced in the version comment — is not taken, because a normative, mechanically-enforced
table cannot say "minor" and "like a tightened constraint" in one row, and entering the
re-identification scope changes what an existing record means).

**Regenerated artifacts, stated correctly** (fix 5). `crates/fathom-ir/src/generated/ir_types.rs`
(`Layer` gains `Presentation`; `LayoutPin => Layer::Presentation`) and
`schema/generated/schema.json` — which is a passthrough of every top-level block
(`schemagen/src/lib.rs:134-160`), so `schema.version`, `LayoutPin.layer` and `LayoutPin.doc` all
change; **the content hash changes; nothing is released** (`schema/released/` is empty). *"One
string changes"* is withdrawn.

**The `62` §4.2 test sentence** (fix 6) keeps the test and the pin example and **drops the
pre-classification of "a group, a tag, a target version"** — `70` §19.1 reserves the group/tag shape
for a planning session, and a normative grammar row is not the place to decide it; any contrast kept
there is marked illustrative.

**The citation** (fix 3): *"deciding in the register"* is `CLAUDE.md` rule 6, restated at `75`
§10.7; `75` §6 is C-04, ticketing hooks.

### 11.2 Plain English, as corrected

Yes — add a fourth heading, "presentation", meaning facts about the drawing itself, and file "where
you dragged this box" under it. Nothing you see changes and nothing you have saved changes: your
drawings still save, export and reload exactly as they do today. What it buys is correctness later:
today, the first time Fathom re-reads a device's config it would flag every box you dragged on that
device as "planned but not on the device" and raise a warning about it; this stops that, because a
dragged position is filed as a fact about the drawing and is never compared with what the device
said. A target software version does NOT need the new heading: it is a note on the device, like the
"intended state" note a tunnel already carries, and it stays on the device. The cost is a small edit
to the rulebook and a rebuild, with no data to convert.

### 11.3 Schema change

Reproduced from the workflow output (cut at 2,500 characters), corrections applied in place and
marked. The rest of the `LayoutPin` doc block and the two gates (R-L3's build checks) lie beyond the
cut.

```yaml
### schema/schema.yaml — three edits, none of which moves a declaration (62 §2.3: declaration
### order is generated NodeKind order, so the LayoutPin block stays exactly where it is; only its
### `layer:` value and its doc change)

schema:
  version: "0.6"    # (0.1–0.5 comments unchanged above)
                    #
                    # 0.6 adds a FOURTH value to the per-kind `layer` vocabulary,
                    # `presentation` -- a fact about the DRAWING of the network, not
                    # about the network -- and moves LayoutPin onto it, closing
                    # ADR-0035 §9 item 1 and OPEN-FOR-THE-OWNER §D5. Priced against
                    # 62 §16.2: the table has no row for a new `layer` value or for a
                    # changed kind-level attribute, so it is priced by the table's
                    # own criterion -- can an old client read the new export? YES,
                    # byte for byte. `layer` is never serialised: a node record
                    # carries its KIND, and the layer is a compiled-in constant per
                    # kind (`NodeKind::layer()` in ir_types.rs; `layer` appears in
                    # schema.json and nowhere on the wire, and in no field key). A
                    # 0.6 export and a 0.5 export of the same estate are identical
                    # bytes; an old build replays OP_PLACE exactly as before. No
                    # kind, no edge, no field, no field key, no tuple, no
                    # cardinality, no containment changed. Whole change = MINOR.
                    # The two missing rows are proposed to 62 §16.2 (see §11.1).
                    # [CORRECTED, fix 5: schema.json is a passthrough of every top-level
                    # block; schema.version, LayoutPin.layer and LayoutPin.doc all change;
                    # the content hash changes; nothing is released.]

  # ======================= presentation layer -- ADR-0035; schema 0.6 =======================
  - kind: LayoutPin
    layer: presentation
    emits: false
    doc: |
      (first three paragraphs unchanged: the pin, the override rule, "it is not drawn")

      LAYER: `presentation` -- a fact about the drawing, not about the network. The
      reason is mechanical, not taxonomic [CORRECTED, fix 1 -- rewritten to match 11 §10.5]:
      a pin is Origin::Hand and is contained by the element it places, so for a pin on a
      Device, or on anything under one, `owner_device` resolves to that device;
      `config_path(LayoutPin)` is the empty set, and the empty set is a subset of every
      capture's covered paths. Under `layer: config` a whole-device re-paste would
      therefore put every pin on that device into 11 §10.4's scope (step 1, all three
      conjuncts pass), step 6 would send it to §10.5, and the Hand column under
      Section/Whole would mark it Divergent { since } and raise a finding -- a false
      "intended but not deployed" on every hand-placed pin of a re-pasted device. It
      would not tombstone it. Under `presentation` the pin is outside that scope by
      construction, and follows a re-parsed device by CONTAINMENT (the owner's NodeId
      survives a rename, 11 §10.6), never by matching.
      # [cut at 2,500 characters in the workflow output]
```

### 11.4 What it forecloses

1. Layer stays a PER-KIND attribute. This commits to 'a field takes its kind's layer'; anyone later
   wanting one field of Device filed separately faces a `62` §4.3 grammar change across all four
   consumers rather than a one-line edit.
2. R-L3 is cheap to state with one kind in the layer and expensive after: a presentation kind can
   never be `emits: true`, never own a non-presentation node, never be parser-created, and is never
   an element of the picture. Relaxing any of these later is minor by `62` §16.2, but anything built
   on the guarantee 'removing a drawing fact never removes a network fact' would break, so treat them
   as fixed.
3. `presentation` becomes a variant of the generated `Layer` enum and a string in `schema.json`;
   renaming it later is the same class of change as renaming a kind — not on the wire, but every
   consumer and every future `schema/released/` snapshot keys on it.
4. `LayoutPin` leaves the config re-identification scope permanently. A pin follows a re-parsed
   device through a rename by CONTAINMENT (the owner's NodeId survives a rename, `11` §10.6), never
   by matching — so 'make pins config so the matcher can see them' is closed as an argument.
5. No `intent` layer: intent about a network thing is a field on that thing. The door to a fifth
   value for an intent KIND stays open at the same price; what is foreclosed is filing such a kind
   under `config`.
6. Every exhaustive `match` on `Layer` must gain an arm (Rust makes this a compile error, which is
   the point); any future consumer that reads 'not config' as 'physical or service' — an inventory
   mode list, a report grouped by layer — must be written knowing a fourth exists and is excluded
   from the network's totals.
7. A presentation kind is never drawn as an element. A future backdrop image (`70` §10.10, `56`
   §13.6) must be a ground behind the scene, not a box, and the exception must be recorded where
   `layers::projection_of` reads the layer — it cannot simply be added as a drawn kind.

### 11.5 Migration, as corrected

Nothing to convert. The server stores no rows (WO-11 G8; WO-12 is OPEN, not executed). Client
exports and journals are byte-identical before and after: `layer` is never serialised — a node
record carries its kind, and `NodeKind::layer()` is a compiled-in constant — and `LayoutPin`'s
declaration does not move in `kinds:`, so its generated ordinal, its field keys (300/301) and
`OP_PLACE`'s replay are unchanged. A 0.5 export opens in a 0.6 build and a 0.6 export opens in a 0.5
build identically (this is the one decision in this record where the forward direction genuinely
holds, and it holds because nothing on the wire changes). Regenerated artifacts:
`crates/fathom-ir/src/generated/ir_types.rs` (`Layer` gains `Presentation`; `LayoutPin =>
Layer::Presentation`) and `schema/generated/schema.json` (a passthrough of every top-level block —
`schema.version`, `LayoutPin.layer` and `LayoutPin.doc` all change; **the content hash changes;
nothing is released**); `ir_types.ts` and `field-keys.yaml` are untouched. Bump: `62` §16.2 has no
row for a new layer value or a changed kind attribute, so it is priced by the table's own criterion
(old client can read? — yes, byte for byte) and by elimination of every major row (no field
removed, renamed or retyped; no lower bound raised; no `constraints:` entry tightened — the two new
checks are build gates on the tree, and no declared edge has ever had a `LayoutPin` as owner, so no
existing or possible data violates them; no tuple reordered; no containment restructured): **MINOR,
0.5 → 0.6**, with the pricing written in the version comment as 0.2–0.5 were, and the two rows in
§11.1 proposed to §16.2 so the next such change is priced by the table rather than by argument.
Tests: `shipped_tree.rs` counts stay 51 kinds / 95 edges; the `Placeable` drift test switches its
exclusion from the name to the layer (**see Failure modes: this interacts with §8, whose `Group` and
`Tag` are `layer: config` and not `Placeable`**); `fathom-schemagen`'s determinism tests regenerate.

### 11.6 Corrections applied

1. The LAYER paragraph rewritten to match `11` §10.5 (Divergent finding, not tombstone); the `19`
   §9.1 "verbatim" claim dropped; the defect named as a false "intended but not deployed" finding.
2. Plain English corrected to what the corpus predicts.
3. `75 §6` citation corrected to `CLAUDE.md` rule 6 / `75` §10.7.
4. The proposed `62` §16.2 row split into two unambiguous rows (**choice taken** — INTO `config` is
   major).
5. *"One string changes"* corrected: passthrough of every top-level block; content hash changes;
   the count dropped.
6. The `62` §4.2 test sentence keeps the pin example and drops the pre-classification of group, tag
   and target version.

From `decides_owner_business`, applied: the group/tag/target-version classification is left to the
planning session `70` §19.1 reserves it for.

### 11.7 Needs the owner

- *"Do you agree that "where you put a box on the drawing" gets its own fourth heading, kept apart
  from how the device is configured, so nothing that later re-reads a config can touch it — yes or
  no?"*

---

## 12. D6 — Draft and planned work

**Answers:** `OPEN-FOR-THE-OWNER.md` §D6 (*Draft and planned work*) — three options the owner was
offered; this is the middle one. Related: `75` C-01 and §3.2–§3.4 (the lifecycle fork), `03`
§4.2–§4.4 (the product boundary), `11` §10.5, `62` §5, §7, §20.6, ADR-0041.

**Direction (validated):** a status that **sticks to the equipment** — one optional, never-emitted,
hand-only enum field `lifecycle` (file enum `lifecycle_stage`, sole variant `planned`, absence
claiming nothing), rendered as the word `planned` and evaluated by nothing.

### 12.1 Recommendation, as corrected

Add one optional, never-emitted, hand-only enum field `lifecycle` (file enum `lifecycle_stage`, sole
variant `planned`) to every kind except `LayoutPin` — fifty fields, keys 312–361, declared per kind
because `62` §5's class-carried field is grammar the loader does not read (`ClassDecl` is `{name,
members, line}`; a `fields:` on a class is silently dropped). Render it as the word `planned` on the
box, on the Outline row, in the **inventory cell for the seventeen tabled `InvKind`s the inventory
shows today** (seventeen hand column tables, not one edit — fix 7), and in the kind-strip count
(*"Device 41 · 3 planned"*). **Nothing in the product evaluates it.** Absence asserts nothing (`03`
§4.2's test): an unmarked element is not thereby claimed to be deployed. There is deliberately no
`live` variant: absence is the normal state, and a default state that is also a value is a state
every existing record would have to migrate into (`75` §3.3).

**Option 1 is not foreclosed** (fix 3). The draft claimed the owner's first option — a switch or
filter on his own screen — was refused by `53` §2.2, `52` §6.7 and `57` §2; none of those is a
decision about a planning mode, and the claim is withdrawn. The house's consistent preference is
for the status to travel with the box (it is exported, shared, and survives a reload; a screen
switch is none of those), and **the option is left to the owner.**

**Anything arriving by paste is evidence, and what follows is the owner's** (fix 4). Under the
recommendation as drafted, an element a capture has shown cannot be ticked `planned` — including a
draft config the owner writes for an unbuilt box and pastes in — because a pasted line is a
`Parsed` existence and `planned` means *"no capture has ever contained it"* (`11` §10.5's *"intended
but not deployed"*, asserted by a person). **Whether that is a refusal or a mark is put to the owner
explicitly**: ADR-0041's precedent, decided the day before, is *mark, never refuse*, and the plain
English says so.

**`retired` and `maintenance` are not promised as variants** (fix 2). `75` §3.3 Question A — one
axis or two — is open; `maintenance` may need its own field; `retired` must reconcile with
`absent_since` (`75` §3.2: today decommission IS tombstone) before it is appended anywhere. The
decision text, the enum file's comment and the plain English all say this and none says *"can be
added the same way"*.

**Why a schema field and not the owner's same-day tag** (fix 8). `70` §19.1 gives the owner a tag —
a word you type — the same day, and a word Fathom evaluates by nothing could live there: `planned`
as a tag would need no schema change, no fifty keys, and no new enum. It is not preferred because a
tag is an open vocabulary (`Planned`, `planned`, `PLANNED`, `plan`, `todo` — the case-fold rule
arrives later, §8), a tag cannot be refused or marked on an element a capture has shown (it carries
no rule about evidence), the kind-strip count and the box word would have to special-case one tag
by name, and a fixed-vocabulary field is what `75` C-01's later states need a home in. The trade is
real — fifty spent keys against a typed word — and it is stated rather than assumed.

**Cable's doc and identity comment** (fix 5) are reworded in the same edit — *"if you record a
planned cable, label it"* and the tier-2 identity comment's *"one-ended and planned cables"* — so
`planned` has one meaning on that kind: the field.

**Gates, correctly cited** (fix 6): the field-key check is `proposed:schema.fieldkey.nonmonotonic`
(global order, not per-kind group); `schema.order.inserted` is declared in `62` but not implemented.

### 12.2 Plain English, as corrected

This is the middle option on your list: a status that sticks to the equipment. (Your first option —
a switch or filter on your own screen — is not ruled out by anything decided so far; the house
preference is for the status to travel with the box, because then it is saved, shared and exported
rather than living on one person's screen, and the choice is yours.) When you draw something you
have not built yet, you tick it as planned; that word is saved with the box, so it goes into every
export and everyone who opens the design sees it. On screen it is just the word planned — on the
box, in the equipment list for the kinds that list shows today, and as a count like "Device 41 · 3
planned" — and Fathom never judges a planned box or hides it, it only shows the word. You take the
word off yourself when the thing is built; nothing removes it for you, and nothing you have already
saved has to change. One thing to decide: anything that arrives by pasting a config counts as
evidence that it exists — including a draft config you write for a box you have not built — so as
drafted it cannot be ticked planned; whether Fathom refuses the tick or lets it through with a mark,
as it does for a typed password, is your call. And whether "retired" or "in maintenance" later join
this same list, or need a list of their own, is a separate open question, not something this change
settles. It could also have been a tag — a word you type — and the reason it is not is that a typed
word cannot be counted, refused or kept to one spelling; that trade is yours to reverse.

### 12.3 Schema change

Reproduced from the workflow output (cut at 2,500 characters), corrections applied in place and
marked. The per-kind field block (appended to every kind but `LayoutPin`) lies beyond the cut.

```yaml
# Three files change, all in 62's grammar. Nothing is removed, retyped, reordered or restructured.

# === 1. NEW FILE schema/enums/lifecycle_stage.yaml (62 §7; one file per named enum) ===

# schema/enums/lifecycle_stage.yaml — D6 (2026-09-04). The carrier 62 §20.6 demonstrated,
# shipped with ONE variant. The enumeration is OPEN and this file must not be read as
# closing it: 75 C-01 owns the rest. [CORRECTED, fix 2: the draft said the owner's own
# "decommission, maintenance, etc" would be later variants of THIS enum; 75 §3.3 Question A
# (one axis or two) is open, `maintenance` may need its own field, and `retired` must
# reconcile with absent_since (75 §3.2) before it is appended anywhere.] Any later variant
# of this enum is a minor bump. No platform_spellings and no default_by_platform: the field
# is never emitted, so no vendor text ever spells it (62 §7 rules 1 and 3 have nothing to
# bind).
variants: [planned]
doc: |
  Where an element stands between intent and evidence. `planned` = drawn, not built:
  no capture has ever contained it — 11 §10.5's "intended but not deployed", asserted
  by a person before any re-parse could derive it. There is deliberately NO `live`
  variant: absence is the normal state of every element, and a default state that is
  also a value is a state every existing record would have to migrate into (75 §3.3).
  Absence asserts nothing (03 §4.2's test): an unmarked element is not thereby claimed
  to be deployed.

# === 2. schema/schema.yaml ===

# (a) The version block — bump and price it, in the same comment style as 0.2–0.5:

schema:
  version: "0.6"    # 0.6 is D6 (2026-09-04): one new named enum (lifecycle_stage, one
                    # variant) and one new optional field, `lifecycle`, appended to every
                    # kind but LayoutPin — fifty fields, fifty keys 312-361. Priced against
                    # 62 §16.2 exactly as 62 §20.6 priced itself: "new optional field |
                    # minor" fifty times and a new enum (11 §11.3 rows 3-4). No kind, no
                    # edge, no retype, no tuple, no containment moved; no constraint,
                    # identity, similarity or emission entry references the field. An old
                    # build reading a 0.6 export keeps `lifecycle` in `unknown` and draws
                    # the box without the mark — the tolerated direction.
                    # [VERIFY, cross-cutting rule: neither skeptic checked what the shipped
                    # importJournal does with an OP_FIELD_SET whose field key it does not
                    # declare; the kind case (groups-and-tags fix 1) is a stop, not a
                    # tolerance. Establish before this sentence ships.]
                    # Whole change = MINOR. Declared per kind and not on a class because
                    # 62 §5's class-carried field is grammar the loader does not read
                    # (ClassDecl is {name, members, line}; a `fields:` on a class is
                    # silently dropped).

# (b) Append this block, VERBATIM and
# [cut at 2,500 characters in the workflow output]
```

### 12.4 What it forecloses

1. The node-attribute branch of `75` §3.4's fork (lifecycle as a bare marker beside `absent_since`,
   outside `schema.yaml`) is closed: lifecycle is a schema field with provenance, history, a
   generated column and diff behaviour, and C-01's later states inherit that home.
2. A `live` variant can never be added: absence is the normal state from the first record, and
   turning it into a value would mean migrating every stored element (`75` §3.3).
3. The field name `lifecycle`, the enum name `lifecycle_stage` and the token `planned` are
   wire-stable forever; renaming or retyping is a major bump, and the fifty keys 312–361 are spent
   whether or not the field is ever used on that kind.
4. `planned` lives on nodes only. A planned link or cable is planned because a node it touches is; a
   planned edge between two LIVE boxes has no home until an edge-level field is added (minor, later
   — `Terminates.end` is the precedent), and until then the picture will draw such a link as live.
5. The reading of `03` §4.2–4.4 that admits `planned` — a one-directional disclaimer cleared only by
   a person, refused (or marked — the owner's) on anything a capture has shown — becomes the reading
   every later C-01 state must satisfy; `retired` in particular must reconcile with `absent_since`
   (`75` §3.2, 'today decommission IS tombstone') before it is appended, and `Tunnel.intended_state`'s
   `decommissioned` overlap is left for that record.
6. Clearing the mark is manual by design. When cross-paste correlation (`70` §6) is built, the
   person's 'yes, same box' answer on `ERR_PASTE_CHOICE` must clear or explicitly ask about a
   `planned` mark, or marks go stale on boxes a config has since confirmed — a UI/weld obligation
   this record creates.
7. Fifty identical per-kind declarations must stay identical until `62` §5's class-field expansion
   is built in the loader and codegen; the drift test is what stops them diverging, and collapsing
   them later is a wire-neutral edit that still costs an executor's pass.

### 12.5 Migration, as corrected

Schema 0.5 → 0.6, MINOR per `62` §16.2: *"new optional field | minor"* fifty times, plus a new enum
priced exactly as `62` §20.6 priced itself (`11` §11.3 rows 3–4); a class is not a row in the table
and none is added. Existing records: untouched, byte for byte — no stored element gains a slot
(Unknown is "no slot", so nothing is written), every 0.5 export is a valid 0.6 export, every
existing box draws exactly as today, and layout is byte-identical because the field is not a layout
input. **Forward direction, marked rather than claimed:** the draft says a 0.5 build opening a 0.6
export *"keeps `lifecycle: planned` in `unknown` and draws that box WITHOUT the mark — the same
tolerated direction the `DhcpRelay` bump accepted"*; the cross-cutting rule (§1 item 6) requires the
code path, and neither skeptic verified what `importJournal` does with an `OP_FIELD_SET` carrying a
field key the build does not declare. <!-- VERIFY: before this migration text ships, drive a 0.6
export with one `planned` box into a 0.5 build and record what happens. --> `schema/field-keys.yaml`
gains keys 312–361 at the tail, one block, never reused. `schema/released/` is still empty, so `62`
§16.4's bump checker is not yet checkable and `schema/migrations/manifest.toml` stays
`migrations = []` (no major bump, no `Migration` impl, no golden fixture). The journal needs no new
opcode: `OP_FIELD_SET` (17) already writes any field the author table admits, and an exported
journal replays the write by field key.

**Test pins that move** (fix 1): `crates/fathom-schema/tests/shipped_tree.rs` lines 70, 74 and 95;
`crates/fathom-ir/tests/canon_laws.rs` lines 82 and 575; `crates/fathom-ir/tests/edge_tables.rs`
line 95 — to eleven enum files, 361 keys, "0.6". **Regenerated artifacts committed with the tree:**
`ir_types.rs`, `accessors.rs`, `schema.json`, `ir_types.ts` **and `schema/migrations/manifest.toml`**
— or `schema.codegen.stale` fails `cargo test`.

### 12.6 Corrections applied

1. The six test pins listed with their new values; `schema/migrations/manifest.toml` added to the
   regenerated artifacts.
2. The `retired`/`maintenance` promise removed from the decision text, the enum comment and the
   plain English; `75` §3.3 Question A stated as open.
3. The claim that option 1 is refused by `53` §2.2, `52` §6.7 and `57` §2 withdrawn; the house
   preference stated; the option left to the owner.
4. The Parsed-existence write refusal put to the owner explicitly (**choice taken** — put to him,
   with ADR-0041's mark-never-refuse precedent named); the plain English says paste counts as
   evidence, including a pasted draft config.
5. `Cable`'s doc and identity comment reworded in the same edit.
6. Gate citation corrected to `proposed:schema.fieldkey.nonmonotonic`; `schema.order.inserted`
   noted as declared but not implemented.
7. The inventory-cell surface stated as the seventeen tabled `InvKind`s; *"on its row in the list"*
   softened.
8. A paragraph added weighing the owner's tag as the alternative home, and why the field is
   preferred.

From `decides_owner_business`, applied: (a) option 1 not foreclosed; (b) the paste-refusal put to
the owner; (c) `maintenance`/`retired` not promised as variants; (d) the `03` §4.3 reading — that
*"no field represents a process state"* (Reopens: Never; amendment via `03` §10.1) admits `planned`
as a disclaimer — is **a reading of his product boundary recorded here as such**, under
*Disagreements*, not a decision.

Applied beyond the list (§1 item 6): the forward-compatibility sentence marked VERIFY rather than
asserted.

### 12.7 Needs the owner

- *"Is it right that a box you mark as planned stays marked for everyone who opens the design —
  saved and exported with the box — rather than being a switch or a filter on your own screen?"*
- Moved by fix 4: on an element a config has already shown (including a pasted draft config for an
  unbuilt box), is the `planned` tick **refused**, or **allowed and marked** as contradicting
  evidence (ADR-0041's precedent)?
- Surfaced by fix 3: option 1 (a per-screen switch or filter) remains available to him.
- Surfaced by fix 8: `planned` could be a tag instead; the trade is stated and is his to reverse.

---

## 13. D7 — A DHCP relay pointing into a named routing instance

**Answers:** `OPEN-FOR-THE-OWNER.md` §D7; WO-10 §10 item 5 (the escalation executing WO-10 fired:
`RelayServerIn` is always a PENDING reference because nothing builds a `RoutingInstance`, and
pending references are carried out of the weld and never stored — `14` §7.3). Related: `70` §18.5,
`11` §10.3–§10.4, `62` §19.

**Direction (validated):** **route 1** — teach the Junos dictionary the `routing-instances` block,
starting with the `instance-type` line, plus one minor schema bump (an identity tuple on
`RoutingInstance`), because it is the only route that creates the thing the relay's arrow points at.

### 13.1 Recommendation, as corrected

Ship `corpus/dict/junos-srx/routing-instances.yaml` with **only the `instance-type` entry** (fix 1).
The draft's second entry, `routing-instances.interface`, is moved out of the file body into a
comment block and a stop-and-escalate item gated on the `EdgeSpec.from` resolver extension: as
written it fails `dict.rs`'s edge-`from` parse (`.as_str()` on a map → `DictGate::Parse`), and
because `Dictionary::load` reads every `.yaml` via `read_dir`, **one bad entry disables the whole
junos-srx dictionary for every paste.** Append one identity tuple to `RoutingInstance`,
`[owner(Device), name]` (tier 1), 0.5 → 0.6 minor. Nothing else moves: `RelayServerIn` (declared by
WO-10) and `InRoutingInstance` are correct as they are.

**Why the tuple, honestly** (fix 6). `62` §19.4's `dict.key.not-identity` — the gate that would
require a dictionary key to cover a declared tuple — is **specified but not implemented**: no code
in `crates/` checks it, and `DhcpRelay` is already keyed against `identity: []`. So the tuple is
justified by `11` §10.4 re-identification and `70` §6 correlation (it is what they will match `c3`
on), with the gate a future check rather than a present requirement. The nameless default instance
the routing slice upserts carries no name (`corpus/dict/junos-srx/README-routing.md` §2), so no
tuple is usable on it — exactly its state under `identity: []`; nothing about it changes.

**The redaction catalogue travels with the prefix** (fix 4). A new known prefix moves `known_prefix`
for every line under it, and **no union-rule CI check exists in the tree** to catch a regression
(the union rule is ratified — `CLAUDE.md` § *State* — but this record does not assert a check that
the skeptic could not find). So the file carries `secret:` catalogue entries for the
`[edit routing-instances NAME protocols bgp …]` `authentication-key` levels and the OSPF
`authentication simple-password` / `md5` forms under the same prefix — the shape `protocols-bgp.yaml`
and `system.yaml` already use — plus **rule-0 canaries read through the exported journal**: a 1–8
character OSPF simple-password and a BGP authentication-key under `routing-instances NAME protocols
…`. Rule 0 (`CLAUDE.md`): tested against what a device accepts, never against what the detector
needs.

**The Rust hook list, correctly named** (fix 5): `ValueTy::RoutingInstanceIsolation` in
`ValueTy::from_name`; `ValueTy::token_map()` (not `token_map_name`); the `bind::value_of` arm using
the generated `Unknown`-arm refusal; `BoundValue::RoutingInstanceIsolation`; and the weld arm —
`README-routing.md` §1's chain. The isolation token map leaves EVPN/mac-vrf to the `Unknown` arm
deliberately; resolving `11` §12.3's VERIFY may need a sixth enum variant.

**The routes not taken, told plainly.** The owner is offered one route because routes 2 and 3 were
found, on reading the code, not to be routes at all: route 3 is what the page already does on every
open (it re-runs the parser over the recorded redacted text), and route 2 inside the graph is the
invariant-7 breach he already refused in `70` §18.5 — not because three priced options were weighed
and two lost.

### 13.2 Plain English, as corrected

Today Fathom reads "this relay's server is reached through routing table c3", shows it once, and
loses it when you save — because nobody has taught it what a routing-table block in your config
looks like, so there is nothing for that arrow to point at. The fix is to teach it that block: when
your config says `set routing-instances c3 instance-type virtual-router`, Fathom makes a `c3` box,
the relay's arrow lands on it, and it is still there after you save and reopen. Be clear about what
happens to saved designs: Fathom re-reads your pasted text every time you open a design, so a saved
design whose paste contained that block will open with the new box and a note that the reading
improved — but if you drew links, moved boxes or placed racks by hand AFTER that paste, that design
opens without them; your saved file still has them, and you redraw them once and save again. That is
how every such improvement has behaved since late August, not something new here. It costs one small
file of Juniper lines (one line, to begin with), one line in the schema and a modest code change —
no new screen, no new equipment. What it does not fix: if the relay lines and the routing-table
lines were pasted separately, the arrow still has nothing to land on until both are in one paste —
that is the bigger "match things across pastes" job already on your list. And you are being offered
one route rather than three because, on reading the code, the other two turned out not to be routes
at all: one is what the page already does on every open, the other is the inside-the-graph shortcut
you already refused.

### 13.3 Schema change

Reproduced from the workflow output (cut at 2,500 characters). The dictionary file itself and the
`NOT changed, deliberately` list lie beyond the cut.

```yaml
# ============================================================================
# 1. schema/schema.yaml — ONE identity tuple appended; nothing else moves.
#    (fathom-schema-check today: 51 kinds · 95 edges · 61 scalars · 10 enums,
#    0 failures / 0 warnings — read off the run, 2026-09-04.)
# ============================================================================
schema:
  version: "0.6"    # (append to the existing comment block, after the 0.5 paragraph)
                    # 0.6 is D7 (2026-09-04): ONE identity tuple appended on
                    # RoutingInstance, [owner(Device), name]. Priced against 62 §16.2:
                    # "New identity tuple appended | minor | old client: yes". Nothing
                    # else moved: no kind, no edge, no field, no retype, no cardinality,
                    # no tuple removed or reordered, no containment restructured.
                    # Identity tuples are never on the wire (11 §10.3: "never persisted
                    # as a key"), so every 0.5 export is a valid 0.6 export byte for
                    # byte. Whole change = MINOR.

  - kind: RoutingInstance
    layer: config
    emits: true
    doc: |            # unchanged
      The neutral core of Junos instance-type / Cisco vrf / PAN virtual router (11 §6.5,
      §12.3). The default instance is modelled explicitly, not as None.
    fields:           # ALL UNCHANGED — name, isolation, router_id, route_distinguisher,
                      # vrf_import, vrf_export, vrf_target exactly as at 0.5
    identity:
      # D7 (2026-09-04), replacing `identity: []  # VERIFY: no identity tuple stated
      # in 11 §10.3 for RoutingInstance.` The routing-instances dictionary keys a
      # NAMED instance on `$ri`. [CORRECTED, fix 6: 62 §19.4's `dict.key.not-identity`
      # is specified but NOT implemented -- no code in crates/ checks it, and DhcpRelay
      # is already keyed against `identity: []` -- so the tuple is justified by 11 §10.4
      # re-identification and 70 §6 correlation, with the gate a future check.]
      # IkeGateway's tier-1 shape (11 §10.3). The DEFAULT instance the routing
      # slice upserts carries no name (corpus/dict/junos-srx/README-routing.md §2),
      # so no tuple is usable on it -- exactly its state under `identity: []`;
      # nothing about it changes. Never used for lookup (11 §10.3); it is what
      # 11 §10.4 re-identification and 70 §6 correlation will match `c3` on.
      - [ owner(Device), name ]    # tier 1

# NOT changed, deliberately:
#   RelayServerIn   (DhcpRelay → RoutingInstance, 0..1 out)   — declared by WO-10, correct as is
#   InRoutingInstance (LogicalUnit|IkeGateway → Routin
# [cut at 2,500 characters in the workflow output]
```

The dictionary file, per fix 1: **one entry, `instance-type`**; the `interface` entry as a comment
block plus a stop-and-escalate item.

### 13.4 What it forecloses

1. `[owner(Device), name]` becomes RoutingInstance's tier-1 identity tuple; removing or reordering
   it later is a MAJOR bump (`62` §16.2), so any later way of identifying an instance (a
   route-distinguisher tier, say) is appended after it, never put in front.
2. Two shapes of RoutingInstance will coexist in an estate — the nameless default the routing slice
   upserts and the named ones this builds. Giving the default a name later (`inet.0`, `master`)
   means asserting a value no pasted line carries and re-identifying existing nodes; route 1 leaves
   that decision untaken, and it gets dearer with every saved design.
3. The isolation mapping is fixed in one token map with EVPN/mac-vrf deliberately left to the
   Unknown arm; resolving `11` §12.3's VERIFY may need a sixth enum variant, and from then on the
   enum and the token map move together.
4. The routing view will need the routing slice's `[protocols, $proto, …]` and `[routing-options,
   …]` entries duplicated under a `[routing-instances, $ri, …]` prefix — a two-copy dictionary shape
   that any later hierarchy-relative entry grammar must absorb; route 1 commits to that being
   dictionary work, not schema work.
5. Pending references stay 'carried out, not written' (`14` §7.3): a relay and its instance pasted in
   two separate pastes still cannot join until `70` §6's correlation or a pending-retry exists.
   Route 1 neither builds that nor makes it harder, but choosing it means D7 is closed without it.

### 13.5 Migration, as corrected

Schema 0.5 → 0.6, MINOR per `62` §16.2 (*"New identity tuple appended | minor | old client:
yes"*); the four version pins move together as WO-10 §11 item 2 did for 0.5 — `schema.yaml`'s
version comment, `canon_laws.rs`, `shipped_tree.rs`, and `plain_face.rs`'s PINNED line — plus
`shipped_tree`'s declaration counts if they pin tuples. **And the steps that four-pin list omits**
(fix 3): re-run `fathom-schemagen` so `schema/generated/schema.json` (which carries `identity` per
kind), `schema/generated/ir_types.ts` and `crates/fathom-ir/src/generated/ir_types.rs`
(`SCHEMA_VERSION`, `identity_tiers()`) are regenerated — `schema.codegen.stale` fails otherwise —
and re-pin `crates/fathom-ingest/tests/dict_gates.rs::entry_count_is_90` (90 becomes 91 with the
single `instance-type` entry — arithmetic on the fix's own facts, to be read off the run). Existing
exports: unchanged and readable in both directions, because identity tuples are never on the wire
(`11` §10.3: *"never persisted as a key"*). Existing saved designs: nothing is rewritten; a reopen
re-runs the parser over the recorded redacted text (`shape.rs`; `importJournal`), so a design whose
paste contained the `routing-instances` block now builds one more node, one more edge and one fewer
unread line, `checkDrift` reports it in its own words (*"Fathom has learned more of this vendor
since you saved"*), and — standing behaviour for every dictionary change since 2026-08-28, not new
here — **`importJournal` stops at the drifted paste and slices later ops off the loaded journal**:
hand-made steps recorded after that paste are not replayed but named, with the file left untouched.
A design whose paste never contained the block is unchanged and its relay's qualifier stays a
pending reference exactly as today. No server-side migration exists to run: WO-11 G8 stores nothing
yet. Dictionary entries are corpus, released on corpus version and content hash, not schema version
(`62` §19.2).

### 13.6 Corrections applied

1. The dictionary file ships with only the `instance-type` entry; the `interface` entry moved to a
   comment block and a stop-and-escalate item (the parse failure and the whole-dictionary
   consequence named).
2. The plain English no longer opens with *"Nothing you have saved needs redoing"*; it says what
   happens to hand-made steps after a drifted paste.
3. The migration adds `fathom-schemagen` regeneration and the `entry_count_is_90` re-pin.
4. The redaction catalogue and rule-0 canaries carried with the prefix; the absence of a union-rule
   CI check stated.
5. The Rust hook list corrected.
6. `dict.key.not-identity` stated as specified-not-implemented; the tuple justified by `11` §10.4 and
   `70` §6.

From `decides_owner_business`, applied: the owner is told plainly why one route is offered.

### 13.7 Needs the owner

- *"Do you want Fathom taught to read the `routing-instances` block now (route 1), accepting the
  one-line schema bump that comes with it?"*

---

## 14. E4 — Reading and writing a vendor's language from one file

**Answers:** `OPEN-FOR-THE-OWNER.md` §E4 (*Reading and writing a vendor's language*). Related: `62`
§19 (the dictionary content spec, owned under ADR-0008 property 3), `13` (emission), `14` §6.2 and
§6.4, WO-04 (the emitters — the only open engineering order), `78` §5.5 and §7.

**Direction (validated):** **teach each vendor line once** — an optional `emit: { block, order }` on
the existing dictionary entry, the parser's `path` read backwards as the written line, the round-trip
test kept as the proof — because the two-copy alternative has already drifted on Juniper alone.

### 14.1 Recommendation, as corrected

Add an optional `emit:` key to the existing dictionary entry grammar (`62` §19.3) with **exactly two
sub-keys**, `block` (u16; an id from the platform's `blocks:` **sequence** — fix 10) and `order`
(u16; the row within the source node's stanza; the shipped crate's 10/20/30/40/50 become these
numbers verbatim). No `template`, no `risk`, no `explain`, no `idempotency` keys; `dict.*` refuses
them if present. Absent `emit:` = a parse-only entry (`14` §6.4's *"tolerance for statements the
emitter would never produce"*): every `partial: true` entry, every `secret:`-only entry, the `.hex`
PSK twin and all 6 OPNsense entries. The line is the `path` read backwards; the loader semantics
`62` §19.3 must state per existing `binds` construct are tabled in the schema-change block. The
two-copy alternative has already drifted on Juniper alone: 90 entries readable, 21 writable, and
token tables that disagree.

**Ten corrections, each a load-bearing rule the draft got wrong or left contradictory.**

1. **`dict.emit.capture-unfilled`** (fix 1) is rewritten so a capture may be filled by a `key:`
   **and** the key field's `from:` together — or by any non-empty set of fillers. As drafted it
   rejected every keyed entry, including the design's own worked example.
2. **The ordinal base for entries whose source node is a child** (`owner: n<j>`) (fix 2): rows ride
   the **owner-chain root's ordinal plus a per-sibling offset** — today's `vpn_base + 500 + i` in
   `junos.rs`, kept so the traffic-selector line does not reorder and the 21-line golden plus
   `report_matches_the_golden_contract`'s line positions hold. (**Choice taken**: the rule, not a
   new `emit.order_on:` key, because `emit:` stays closed at two.)
3. **Idempotency derivation** (fix 3): a multi-field child-node entry (the traffic-selector) derives
   **`Replacing`**, matching `junos.rs` and `13` §2.5's own example; *"`Replacing` is unneeded on
   Junos"* is withdrawn. The derivation is `Accumulating` iff the entry has
   `ordinal_from_position: true` or an `append_enum` field; `Replacing` for a multi-field child-node
   entry; else `Idempotent`; `NonIdempotent` reserved with a citation.
4. **The three-way contradiction** between the bare-stanza rule, `dict.emit.on-partial` and
   `dict.roundtrip`'s second half (fix 4) — **choice taken, provisional**: `partial` entries are
   **exempt from `dict.roundtrip`'s never-produces assertion**, and `emit:` stays closed at two keys
   (the alternative — a `partial` entry carrying `emit:` with a declared `bare: true` — adds a third
   key). **The bare-stanza emission is NEW behaviour, not something Rust keeps**; the order that
   builds this decides between the two, and this record says which it leans to and why.
5. **Coverage made honest on the first cut** (fix 5): a `DeclaredGap` (or a sourced read entry) for
   `IpsecProposal.authentication_algorithm`, and a rule or row for `IkeGateway.peer`'s `Dynamic`
   shape; otherwise `coverage.rs` goes red and a CBC IPsec hash is dropped silently.
6. **A per-entry token override** (or `token_maps` scoped per entry) (fix 6), with
   `dict.token.not-invertible` narrowed accordingly, so a scalar Junos spells differently by
   statement position — `junos.rs`'s P1/P2 integrity split, VERIFY unresolved — is expressible. **The
   P2 spelling is unestablished**, not settled.
7. **Part (A) described truthfully** (fix 7): it **amends `14` §6.2's normative table** — removes the
   required `explain` and the `emit.template`/`risk` sub-keys, makes `emit` optional — and needs a
   Disagreements entry against `14` §6.2 under the conventions' Precedence rule. Filed under
   *Disagreements* below.
8. **The `emit_dict: null` edit to the 8 `derived_edges:` is dropped** (fix 8): they are a different
   grammar (`62` §11.4); `dict.edge.unhooked` ranges over `edges:` only.
9. **Regenerate `schema/generated/schema.json` in the same commit** (pinned by
   `checked_in_artifacts_are_current`) (fix 9); and **where the inverting loader lives** is a
   decision the order must take: `fathom-ingest`'s dictionary model is `pub(crate)`, and
   `fathom-emit` depends on neither `fathom-ingest` nor `fathom-schema` at runtime — so either the
   model becomes a `pub` API that `fathom-emit` takes as a new dependency edge, or a small shared
   crate holds it. Named, not decided here.
10. **Small claims corrected** (fix 10): the explain derivation covers the `explain:kind:<Kind>` form
    the traffic-selector line uses; `unit_name` is cited to `LogicalUnit`'s schema doc / WO-04 §4.5,
    not `11` §4.6; `blocks:` is a sequence; `dict.roundtrip`'s secret-entry normalisation is stated
    (real key → placeholder, the fixture value chosen per `CLAUDE.md` rule 0 — within the bounds a
    device accepts).

### 14.2 Plain English, as corrected

Keep one file per vendor statement. The entry that teaches Fathom to read `set security ike gateway
GW-B external-interface reth0.0` is the same entry, read backwards, that writes it out — so there is
one place to fix, one person to sign it, and no second copy to fall behind. The second copy has
already fallen behind on Juniper alone: Fathom can read about 90 kinds of line and write 21, and the
two sides even disagree about which Diffie-Hellman groups they know. The only new thing an entry
gets is two small numbers saying which block and which row the written line lands in; entries
without them stay read-only, which is honest for a CSV like OPNsense's. A test still checks every
writable entry by writing a line, reading it back and writing it again — the test stays; only the
second file goes away. Two things about this are for the planning session rather than you, and they
are listed as disagreements rather than settled: whether "does writing this line twice change
anything" is worked out by the software from the entry's shape or declared by the person who signs
it, and whether an entry with no explanation text fails the build or is merely listed.

### 14.3 Schema change

Reproduced from the workflow output (cut at 2,500 characters, inside the backwards-reading table);
corrections applied in place and marked. Parts (B)–(D) — the `blocks:` sequence, the `62` §19.4 gate
table, and the `emit_dict:` hook population in `schema/` — lie beyond the cut and are governed by
the ten corrections above.

```yaml
# Four parts. (A) and (B) are the dictionary content spec 62 §19 owns under ADR-0008 property 3;
# (C) is 62 §19.4's gate table; (D) is the only edit to schema/ and it is data, not grammar.
# [CORRECTED, fix 7: (A) AMENDS 14 §6.2's normative table -- removes the required `explain` and
#  the `emit.template`/`risk` sub-keys and makes `emit` optional -- and is filed as a
#  Disagreement against 14 §6.2 under the conventions' Precedence rule.]

# (A) 62 §19.3 — the entry grammar gains ONE optional key. Worked on a shipped entry (the schema's
#     one live hook):

  - id: junos-srx/security.ike.gateway.external-interface
    path: [security, ike, gateway, "$gw", external-interface, "$unit"]
    binds:
      nodes:
        - { as: n0, kind: IkeGateway, key: "$gw", fields: [ { field: name, from: "$gw", scalar: Identifier } ] }
      edges:
        - { kind: ExternalInterface, from: n0, to: { interface_unit: "$unit" } }
    emit: { block: 20, order: 30 }   # NEW. Optional. No template: `path` read backwards is the line.
    versions: "*"
    reviewed_by: <named human>

# `emit:` keys — closed, exactly two:
# - `block` (u16, required): an id from this platform's `blocks:` SEQUENCE [CORRECTED, fix 10:
#   was "table"] (13 §4.1).
# - `order` (u16, required): the row within the source node's stanza; the shipped crate's
#   10/20/30/40/50 become these numbers verbatim (`base = ordinal × 1000 + order`,
#   output.rs/junos.rs unchanged in spirit). [ADDED, fix 2: for an entry whose source node is a
#   child (`owner: n<j>`), rows ride the owner-chain root's ordinal plus a per-sibling offset --
#   today `vpn_base + 500 + i` -- so the traffic-selector line keeps its position in the
#   21-line golden.]
# - Deliberately NOT keys, and `dict.*` refuses them if present: `template` (the path inverted is
#   the line); `risk` (every config statement is `ChangesConfig`, ADR-0011, as line.rs:104 already
#   hard-codes; 13 §16 OD-2 stays open and is not decided by a corpus field); `explain` (derived:
#   `explain:field:<Kind>.<field>` for the entry's value-bearing field,
#   `explain:field:<Kind>.<snake(EdgeKind)>` for an edge entry, and `explain:kind:<Kind>` for a
#   kind-level line such as the traffic-selector [ADDED, fix 10] -- the exact strings junos.rs
#   carries today); `idempotency` (derived: `Accumulating` iff the entry has
#   `ordinal_from_position: true` or an `append_enum` field; `Replacing` for a multi-field
#   child-node entry such as the traffic-selector [CORRECTED, fix 3]; else `Idempotent` -- a
#   disagreement with 13 §2.5's "declared, not inferred", recorded under Disagreements;
#   `NonIdempotent` is reserved for a platform that needs it, with a citation).
# - Absent `emit:` = parse-only entry (14 §6.4's "tolerance for statements the emitter would never
#   produce"). Every `partial: true` entry, every `secret:`-only entry, the `.hex` PSK twin and all
#   6 OPNsense entries are parse-only. [CORRECTED, fix 4: `partial` entries are exempt from
#   dict.roundtrip's never-produces half (provisional choice); the bare-stanza emission is NEW
#   behaviour.]

# Reading the entry backwards — the loader semantics 62 §19.3 must state, per existing `binds`
# construct (no new construct is introduced):
# | construct        | forwards | backwards                              |
# |------------------|----------|----------------------------------------|
# | literal segment  | matched  | `PathToken::Kw`, rendered verbatim     |
# | `key: "$c"`      | ident
# [cut at 2,500 characters in the workflow output]
```

### 14.4 What it forecloses

1. A per-platform Rust emitter that is smarter than its dictionary. Once the written line is the
   read path inverted, any statement whose write form is not a reordering of its read form (PAN-OS
   `dh-group no-pfs` for Absent, IOS `no …` negation, Junos `delete` forms) must be a ROW
   (`binds.presence: absent`, reserved) or a Rust branch keyed on presence — never a second spelling
   in a template. That is deliberate and it makes such statements the expensive path by design.
2. Separate review bars for reading and writing. One `reviewed_by` signs both directions, and a
   read-side widening (a new `token_maps` row) is a write-side widening in the same commit. The
   live example is `token-maps.yaml`'s `sha-384 -> hmac-sha-384-192` VERIFY row: today it can only
   mis-name a cell; after this it can be written into a firewall — though only for a value the
   operator pasted or typed, since the write re-emits the vendor spelling the read accepted.
3. Renaming or re-typing `emit.block` / `emit.order` later. They become corpus content under `62`
   §19.2's stable-forever discipline, carried by every entry on every platform; a change is a corpus
   migration across N vendor directories.
4. Expressing an ordering DEPENDENCY in the dictionary. `order` is a per-entry row number; `13`
   §5.2's cross-statement regimes (IOS: transform-set before the profile that names it) stay in Rust
   `requires`, so a PAN-OS or IOS dictionary author cannot fix an ordering bug without a Rust change.
   Deliberate — a dependency in data is a conditional in data.
5. Templates, permanently. `{{…}}` never enters the format and `dict.emit.placeholder` is retired;
   text a vendor needs only on write (quoting, `ascii-text "…"`) is a path literal or
   `Platform::quote` in Rust, never an entry field.
6. Non-line platforms stay read-only until a write-shape emitter exists. OPNsense's CSV-cell path
   (`[$uuid, column, $v]`) has no honest inversion to a line; `emit:` is simply absent and the
   coverage ledger says so, rather than a second format pretending otherwise.
7. Deciding `13` §16 OD-2 (risk per field vs per platform-field) in the corpus. By keeping `risk`
   out of the entry, the format neither settles nor blocks that decision; if OD-2 lands per-
   (platform, field), the key is added then, with a source, not now.

### 14.5 Migration, as corrected

Existing GRAPH records: untouched. No kind, edge, field, enum variant, cardinality, identity tuple,
containment or field key changes; nothing on the wire, in an export or in a journal moves. Schema
version: **NO bump** — `schema/schema.yaml` stays 0.5. The only `schema/` edit is populating the
existing `emit_dict:` hooks (five edges in the first cut); the draft's `emit_dict: null` on the 8
`derived_edges:` is **dropped** (they are `62` §11.4's grammar, and `dict.edge.unhooked` ranges over
`edges:` only). This is not a row in `62` §16.2's table, no generated type or frame carries the
value, and the proposed table row records it as "no bump, hash moves". `schema.json`'s content hash
does move (it carries the value: 1 live + 86 null today) — **it is regenerated in the same commit**,
pinned by `checked_in_artifacts_are_current`; `schema/released/` is empty so no snapshot is
affected. Corpus side: the dictionary releases under `corpus_version` (`62` §19.2), so this is a
corpus bump, not a schema bump. Existing DICTIONARY entries: all 90 junos-srx and 6 OPNsense entries
keep loading unchanged — the loader reads keys by `.get` and ignores unknowns (verified in
`dict.rs`), so an old page fed a new dictionary keeps parsing, and a new loader fed an old dictionary
finds no `emit:` and writes nothing, which is honest rather than wrong. First cut: exactly 21
junos-srx entries gain `emit:` (the seven-kind chain matching the 21-line golden: 5 IkeProposal, 2
IkePolicy incl. the `.ascii` PSK entry rendering `<PSK>`, 4 IkeGateway, 3 IpsecProposal, 2
IpsecPolicy, 5 IpsecVpn incl. traffic-selector) — **plus a `DeclaredGap` or sourced read entry for
`IpsecProposal.authentication_algorithm` and a rule or row for `IkeGateway.peer`'s `Dynamic` shape,
or `coverage.rs` goes red and a CBC IPsec hash is dropped silently**; the 19 `partial` entries, the
other 13 `secret` entries, the `.hex` PSK twin and OPNsense stay parse-only and the two-sided
`dict.roundtrip` asserts it (with `partial` entries exempt from its never-produces half — §14.1 item
4). Code: `crates/fathom-emit/src/junos.rs`'s 22 `EmittedLine::new` sites and its closed `token_*`
functions retire; `block.rs`'s `BLOCKS` const moves to `blocks.yaml`; `tests/worked_example.rs`'s
GOLDEN bytes stay verbatim as the gate (`78` §5.5 — a golden regenerated from a failing run is
laundering); the crate-side `schema.emit.unread` coverage in `tests/coverage.rs` becomes computable
from data (reads = fields bound by `emit:` entries) and `62` §10.3's gate moves from "not yet
checkable" to checkable. `fathom-schema` must learn `emit_dict` before `dict.edge.unhooked` can run.
**Where the inverting loader lives** — a `pub` API out of `fathom-ingest` taken as a new dependency
by `fathom-emit`, or a small shared crate — is the order's decision (§14.1 item 9). Where this lands:
an amendment to WO-04 (its §4.6/§4.7 tables become dictionary rows) or a successor order written by
a planning session — not an execution session's call (`78` §7).

### 14.6 Corrections applied

1. `dict.emit.capture-unfilled` rewritten (key and key-field `from:` together fill a capture).
2. The ordinal-base rule for child-node entries stated (**choice taken** — the rule; no
   `emit.order_on:` key).
3. Idempotency derivation yields `Replacing` for a multi-field child-node entry.
4. The three-way contradiction resolved provisionally (**choice taken** — `partial` exempt from the
   never-produces half; `emit:` closed at two keys); bare-stanza emission stated as new behaviour.
5. `DeclaredGap` / sourced entry for `IpsecProposal.authentication_algorithm`; a rule or row for
   `IkeGateway.peer`'s `Dynamic` shape.
6. A per-entry token override; `dict.token.not-invertible` narrowed; the P2 spelling stated as
   unestablished.
7. Part (A) described as amending `14` §6.2; a Disagreements entry filed.
8. The `emit_dict: null` edit to `derived_edges:` dropped; `dict.edge.unhooked` over `edges:` only.
9. `schema.json` regenerated in the same commit; the inverting loader's home named as the order's
   decision.
10. The small claims corrected (`explain:kind:<Kind>`; `unit_name`'s citation; `blocks:` a sequence;
    the secret-entry normalisation).

From `decides_owner_business`, applied: the two planning calls (derived idempotency versus `13` §2.5;
`dict.explain.unknown` downgraded from gate to ledger) are filed under *Disagreements*, not presented
as settled.

### 14.7 Needs the owner

- *"Are you happy that whatever Fathom learns to READ from a vendor's config it may also WRITE back
  — one entry, one reviewer, no separate sign-off for the writing half?"*

---

## 15. D1 — Hosts, NAS boxes and hypervisors

**Answers:** `OPEN-FOR-THE-OWNER.md` §D1 (*asked four separate ways in the corpus*); `49` §22 item
7; ADR-0037 §5 and §9 item 1 (the blocker one field to the left of `role`); `70` §18.4 (*"proxmox
would probably need to be an engine"*). Related: `64` §7 (the Proxmox survey), `65`, `11` §9.1,
`62` §4.3 and §14, ADR-0040 D8.

**Direction (validated):** keep `Device.platform` required; record a host with no engine as
**"platform not known"** — a gap the findings view already reports — rather than as a borrowed or
catch-all platform; register `proxmox-ve` as an ordinary three-key platform row the day a real
capture off a box is seen.

### 15.1 Recommendation, as corrected

Keep `Device.platform` at `card: 1`. The authority for card-1-as-gap is **`11` §9.1**: lower bounds
are L1, *"Never enforced. Holes are the normal state and the UI lists them"*; *"a graph with one
Device holding only a hostname is a correct graph"*; and *"a hole, never a refusal"* is `62` §4.3's
`required_when` row (fix 5). No field, no rule and no version number changes: one explanatory note
is added to the field's doc and the generated files are refreshed. **The only thing stopping it today
is a door check in the add-equipment form**, which would be removed if the owner approves. A
hypervisor stays a `Device` with role `server` — a consequence he accepts by approving, reopenable on
merit (`CLAUDE.md` rule 3), not "permanently"; and no `generic`, `linux` or `unknown` platform row is
added — the same status (from `decides_owner_business`, applied).

**The `proxmox-ve` row, decided now and written later.** An engine row is the SAME three keys as a
switch: `proxmox-ve: { vendor: proxmox, family: pve, version_scheme: pve }`, appended to
`schema/platforms.yaml` when a real capture off a box lands — **`platforms.yaml`'s own rule** (*"a
platform is declared only when a real config has been seen"*), not `64` §7's closing sentence, which
says timing is `00-INDEX`'s and the owner's (fix 5). `64` §7 read manuals and pve-manager's source,
not a config off a box. `family: pve` is its own token because `64` §7 (`qm.conf(5)`, `qm(1)`,
`pct(1)`, `pvesh(1)`, checked 2026-08-28) establishes colon-separated `option: value` lines plus
sectioned key/value files under `/etc/pve`; the node's own networking is Debian's
`/etc/network/interfaces`, a second text shape — **`64` §7's finding, not `65` §4's** (fix 5).
Registered is not selectable: under ADR-0040 D8 the row is not offered for a paste in hosted Fathom
until `/etc/pve/priv/` (`storage/<ID>.pw`, `token.cfg`, `shadow.cfg`) and `pvereport`'s unredacted
concatenation are in the gate's declared-secret list.

**The duplicate-box cost, honestly** (fix 1). With platform Unknown, `identity_clash`
(`crates/fathom-wasm/src/shell.rs:3293`) gets no hit — `field_text` returns None — so a later paste of
that box's config **welds a second box SILENTLY**, and `paste_reply` (`shell.rs:2864-2940`) says
nothing about it. The owner will see two inventory rows with the same hostname, the hand-drawn one
still under "platform not known". *"And tell you it did"* is deleted. Consequently (fix 2) **the
page's paste-hint sentence** (`crates/fathom-artifact/html/fathom-dev.src.html` ~9388: *"a config
naming a device you already have will ask before it adds a second one"*) **becomes false for
platform-less boxes and is reworded in the same order** — **choice taken**: reworded, because this
decision does not build the hostname-only "is this that box?" prompt and says so.

**Clearing a platform is a deliverable, not a verification** (fix 3). `Graph::clear_field` exists
(`crates/fathom-graph/src/graph.rs:859`) with no caller outside tests; `OP_FIELD_SET`
(`shell.rs:653`) refuses an empty value via `parse_into_slot`; no opcode clears. So the order
specifies the clear path — a zero-length `OP_FIELD_SET` value mapped to `clear_field`, or a new
opcode — journalled and replayed in `importJournal`, and the owner is told that **boxes already
added as Juniper stay Juniper until that control exists**. (§9's empty-set item is the same limit
seen from the other side.)

**The page's platform list** (fix 4) is **inlined at build time** by `fathom_artifact::assemble`
(`crates/fathom-artifact/src/lib.rs:97`) from `schema/generated/schema.json` at key path
`platforms.platforms`, in declaration order, with a test that the inlined list equals the registry —
**never a runtime fetch** (invariant 1). That is why the `proxmox-ve` row, when appended, reaches the
form in the same order that opens the door.

**Tests, correctly named** (fix 5): `equip.rs:497`'s two-role test plus the driver's five-row LAB
(`2026-08-16-server-role-drive.mjs`), not "the five-role test"; ADR-0037 §5 priced its three routes
against the form's behaviour, not on an assumption that card 1 meant refusal.

**On approval** (fix 8): mark `OPEN-FOR-THE-OWNER.md` §D1 answered and cross-reference `49` §22
item 7 and ADR-0037 §9 item 1, per that page's own rule (*"add to it and mark items answered"*).

### 15.2 Plain English, as corrected

When you draw a box Fathom cannot read yet — a Proxmox host, a NAS, a plain Linux server — you would
be able to leave "platform" empty instead of picking a Juniper firewall you know is wrong. The box
goes on the picture as a server, and Fathom lists "platform not known" in its to-do list until you
fill it in. No field, no rule and no version number changes for this — one explanatory note is
added to the schema file and the generated files are refreshed; the only thing stopping it today is
a door check in the add-equipment form, which would be removed if you approve this. A Proxmox entry
goes into the platform list the day someone shows Fathom a real config copied off a Proxmox box,
and it looks like every other entry in that list. Two cautions. First, until you fill the platform
in, Fathom will not recognise that box if you later paste its config: it will add a second box,
silently — you will see two rows with the same hostname, and the hand-drawn one still under
"platform not known" — and the page's promise that it asks before adding a duplicate will have to be
reworded until an "is this that box?" prompt is built. Second, boxes you have already added as
Juniper stay Juniper until a control to clear a platform exists; there is none today, and building
one is part of this.

### 15.3 Schema change

Reproduced from the workflow output (cut at 2,500 characters), corrections applied in place and
marked. Part 2 — the `Device.platform` field-doc note — and the NOT-schema list lie beyond the cut
and are governed by §15.1.

```yaml
# TWO EDITS, NEITHER A VERSION BUMP. Plus a list of what is NOT schema and must change in code.

# ===== 1. schema/platforms.yaml — the engine row (append to `platforms:`, 62 §2.3 tail rule) =====
# NOT on disk until the trigger: this file's own rule ("a platform is declared only when a real
# config has been seen") stands, and 64 §7 read manuals and pve-manager's source, not a config off a
# box. The row is decided now so that nobody designs a fourth key or a special row shape meanwhile.

platforms:
  # ...the ten existing rows, unchanged...
  # proxmox-ve — the first general-purpose host platform (owner, 70 §18.4: "proxmox would
  # probably need to be an engine"). An engine row is the SAME three keys as a switch: the id
  # is the one name that corpus/dict/proxmox-ve/, the gate's declared-secret list (ADR-0040
  # D8), rule `platforms:` predicates and Device.platform all share — 65 §2: registration is
  # data, the engine is code. Nothing in this row says "host"; what makes a host different
  # (its VM interior, 70 §18.4 / 65 §7) is a kinds question and does not live here.
  # `family: pve` is its own token, deliberately not `junos`: 64 §7 (qm.conf(5), qm(1),
  # pct(1), pvesh(1), checked 2026-08-28) establishes colon-separated `option: value` lines
  # plus sectioned key/value files under /etc/pve — nearer 64 §3's family A than anything
  # else and sharing no grammar with it. The node's own networking is Debian's
  # /etc/network/interfaces, a SECOND text shape (64 §7 [CORRECTED, fix 5: was 65 §4]): the
  # engine's scope, not this row's.
  # `version_scheme: pve` names a comparator no code implements — every version_scheme token
  # in this file is in that state (`OsVersion` is a bare String in fathom-ir/src/scalar.rs).
  # VERIFY: PVE release numbering against Proxmox's own release notes before any
  # version-predicated rule ships (11 §4.7's own marker, applied here).
  # Registered is not selectable: under ADR-0040 D8 this row is not offered for a paste in
  # hosted Fathom until /etc/pve/priv/ (storage/<ID>.pw, token.cfg, shadow.cfg) and
  # pvereport's unredacted concatenation (64 §7) are in the gate's declared-secret list.
  proxmox-ve: { vendor: proxmox, family: pve, version_scheme: pve }

# And one comment line appended to the existing `proxmox:` vendor entry, so the two halves point at
# each other:
  #                        Row shape decided 2026-09-04 (D1): `proxmox-ve: { vendor: proxmox,
  #                        family: pve, version_scheme: pve }`, appended when that capture lands.
# [cut at 2,500 characters in the workflow output]
```

### 15.4 What it forecloses

1. Relaxing `Device.platform` to 0..1 later is technically a minor bump but semantically a
   reversal: every host recorded under this decision stops appearing in the findings view's gap list
   and silently becomes 'legitimately platform-less'. Anyone proposing it must re-argue the
   gap-versus-permanent distinction written into the field's doc.
2. No `generic`, `linux` or `unknown` platform row is added by this decision. Any future 'it's just
   a host' shortcut has to be a real engine — a `64`-style survey, its own family token, a
   declared-secret list that passes ADR-0040 D8 — which is the owner's `70` §18.4 direction, written
   into the schema's own text and reopenable on merit like any accepted decision. *(Reworded from
   the draft's "There will never be…", per `decides_owner_business`.)*
3. A hypervisor is a `Device` with role `server`. When a Proxmox (or any host) engine lands, its VMs
   become a new kind INSIDE the Device (`65` §7's missing workload kind, `57`'s rung 4), never a
   retype of the host and never a `Host` kind beside `Device`. *(Reworded from "permanently" — a
   consequence the owner accepts by approving, per ADR-0037 and `70` §18.4; rule 3 keeps it
   reopenable.)*
4. Hosts recorded before their platform is filled in are not auto-re-identified by a later paste:
   the paste welds a second box, silently. Estates built 'paste first, fill later' will collect
   duplicates until either the operator fills the platform in or the page grows a hostname-only 'is
   this that box?' prompt, which this decision does not build. *(Corrected per fix 1: "and says so"
   deleted.)*
5. The registry row carries no 'this platform is a host' fact. If a reader ever needs to know that
   (offering the VM interior only for hosts, say), it must derive it from something else or add a
   key to `62` §14's grammar with a reader behind it — deliberately deferred, not accidentally
   omitted.
6. A host Fathom will never read stays a one-line gap in the findings view forever (grouped per
   field, so fifty such boxes are one line, not fifty). If that nags, the fix is a per-field 'not
   applicable' assertion — today that would be an explicit `Absent` on a card-1 field, which
   `gaps.rs` calls a contradiction it declines to resolve. That is a later, separate decision.

### 15.5 Migration, as corrected

Existing records: untouched. Field key 7 keeps its number, type (`PlatformId`), card (`1`) and emit
(`R`); no stored byte changes; every 0.5 export stays a valid export; `schema/migrations/manifest.toml`
stays empty. Hand-added boxes that borrowed `junos-srx` (the equip tests, the 2026-08-16 driver, any
real design) are NOT rewritten — a `Set` value is a stored assertion with provenance and nothing can
tell a borrowed one from a true one; the operator clears them by hand **once the clear control
exists (§15.1; it does not today)**. Journals: every existing journal carries a platform on every
`OP_EQUIP_ADD` frame (the door demanded one), so all replay unchanged on any build; **a journal
written after the door opens replays only on a build with the door open — an older build refuses it
at the door with `ERR_EQUIP_FRAME`, and `importJournal` then stops at that first refusal and resets
(`fathom-dev.src.html` ~10382–10396), losing the whole import rather than one frame** — named, not
silent, but the whole file (fix 7). Schema version: NO BUMP — `schema.version` stays "0.5". `62`
§16.2's table has no row for a `doc:` edit and no row for a platform-registry addition; nothing is
removed, retyped, tightened, reordered or re-owned, so a major is impossible, and if a reviewer
insists the doc edit is a bump it is minor at most. Operationally `fathom-schemagen` must be re-run
and both generated outputs committed, because `schema.json` carries `doc:` verbatim and
`schema.codegen.stale` fails otherwise; the content hash moves, the version does not. When
`proxmox-ve` is appended later: also no bump; `schema.json`'s **`platforms.platforms`** gains one
entry (fix 4); an older build reading a `proxmox-ve` device renders the token (no FK check exists in
Rust today), and the page's platform list — inlined at build time from that same key path — offers
it only on a build assembled after the row lands, which is exactly why the list must be generated,
not hand-typed.

### 15.6 Corrections applied

1. The duplicate-box cost rewritten: silent weld, no paste reply; *"and tell you it did"* / *"and
   says so"* deleted.
2. The paste-hint sentence added to the NOT-schema list (**choice taken** — reworded; the prompt is
   not built).
3. The clear path promoted from "verify" to a deliverable; the owner told existing Juniper-tagged
   boxes stay so until it exists.
4. The platform list inlined at build time from `platforms.platforms` in declaration order, with a
   test; never a runtime fetch; the migration's key path corrected.
5. Citations fixed: `11` §9.1 for card-1-as-gap; `62` §4.3's `required_when` row for "a hole, never
   a refusal"; `/etc/network/interfaces` to `64` §7; `platforms.yaml`'s own rule for the trigger;
   `equip.rs:497`'s two-role test plus the driver's five-row LAB; ADR-0037 §5 restated.
6. Plain English: *"The schema does not change for this"* → the precise sentence; *"which gets
   removed"* → *"which would be removed if you approve this"*.
7. Migration: an older build replaying a post-door journal loses the whole import, named.
8. On approval, §D1 marked answered with the two cross-references.

From `decides_owner_business`, applied: *"permanently"* and *"there will never be"* reworded as
consequences the owner accepts by approving; the door removal presented as pending his approval.

### 15.7 Needs the owner

- *"Which kind of host will actually be in your demo — Proxmox, VMware, plain Linux, Windows Server,
  a NAS — so the first host engine is one you can paste a real config from, since you said you have
  no Proxmox box?"*
- The decision itself: approving the door removal, with the two cautions (silent duplicate on a
  later paste; existing Juniper-tagged boxes stay so until the clear control exists).

---

## Failure modes

Cross-cutting, and each one a way this record misleads if read in pieces.

1. **Six of the eight schema decisions each name their bump "0.6", and three of them each start
   their field keys at 312.** Groups-and-tags (0.6, keys 312–314), D3 (0.6, key 9 kept), D4 (0.6,
   keys 312–315), D5 (0.6, no keys), D6 (0.6, keys 312–361) and D7 (0.6, no keys) were designed in
   parallel and each priced itself alone. They cannot all be 0.6. Whichever lands first is 0.6; the
   rest renumber; field keys are assigned **in landing order at the tail of `field-keys.yaml`**, and
   every pinned count in this record (53 kinds, 99 edges, 314 keys; 361 keys; 100 containment pairs)
   is correct only for the decision landing alone on 0.5. **D3 is major-class**: if it lands in the
   same bump as any of the others, the whole bump is major-class and `62` §16.4's three requirements
   apply to all of it. Sequencing is a planning session's (`78` §7), and this record does not do it.

   **RESOLVED 2026-09-04:** `docs/70-ops/79-work-orders/00-SCHEMA-SEQUENCE-2026-09-04.md` assigns
   versions and field keys in landing order from the registry's real tail (311): D1 (no bump) →
   groups-and-tags 0.6, keys 312–314 → D4 0.7, keys 315–318 → D7 0.8 → D5 0.9 → D6 0.10, keys
   319–371 → D3 0.11, alone, major-class, key 9 kept → E4 (no bump). Items 2 and 3 below are
   resolved there too (its §6), item 4 fixes D1 before D3, and its §8 lists the substitutions every
   number in §8–§14 other than §8's needs; the YAML blocks here are left as the skeptics reviewed
   them.
2. **D5 and groups-and-tags disagree about the `Placeable` drift test.** D5 switches its exclusion
   from the kind's name to its layer; §8 declares `Group` and `Tag` as `layer: config` and not
   `Placeable`, and names three exclusions by name. If both land, one of them changes: either
   `Group`/`Tag` take a non-config layer (which D5 fix 6 says a grammar row must not pre-decide, and
   `70` §19.1 reserves for planning), or the drift test keeps a name list beside the layer rule.
3. **D4 and D6 change each other's counts.** D6 appends `lifecycle` to every kind but `LayoutPin`
   (fifty). If D4 lands first, `Fixture` is a fifty-first and D6's keys are 313–363 or similar; if
   D6 lands first, D4's `Fixture` block must carry `lifecycle` and its keys shift. D4 also amends
   `Device.role`'s doc while D3 replaces the whole `role` entry: whichever lands second carries the
   other's text.
4. **D1 and D3 meet at the same missing control.** D1's clear-a-platform deliverable and D3's
   empty-set open item are one limit — `parse_into_slot` refuses an empty value and no opcode
   clears — seen from two fields. Build it once.
5. **B2 stands on A2.** *"Cannot be entered unless a tamper-evident record is written first"* has
   nowhere to write if the owner answers A2 with no. §7 puts the conjunction to him for that reason;
   read apart, B2 looks self-contained and is not.
6. **C2's honest sentence is conditional on the employer's sign-in.** With SSO the password never
   reaches Fathom; without it the LDAP fallback *is* the pass-through path, and in an AD-backed AAA
   estate that is the device password. A demo answer of "never" to *"does Fathom see device
   passwords?"* is true on one path only.
7. **A1's floor does not exist for the shipped deployment.** `deploy/compose.yaml` is distroless with
   no systemd; the TPM-sealed file floor is undesigned for it. An employer who refuses a key service
   AND runs compose has, today, no offered option.
8. **The truncated inputs.** A2's twenty-four-event enum, the `Group`/`Tag`/`Fixture`/`lifecycle`
   kind and field blocks, E4's backwards-reading table and its parts (B)–(D), and every security
   decision's reasoning beyond 3,000 characters are in the workflow outputs and not here. An
   executor who takes this record as the whole specification will build from a summary. The
   `sources` counts (29, 28, 29, 29, 27, 24) exceed the rows the *Sources consulted* tables can name.
9. **Choices this record took where a fix offered two.** Each is marked *choice taken* in its
   section so a reviewer can reverse it: A1 fix 7 (floor requires a host unit); A2 fix 6 (add the
   secret-field-viewed event), fix 7 (unique constraint with retry), fix 9 (P-8 truncation by
   default); C1 fix 1 (a conditional seventh row), fix 4 (Caddy inside the rule for self-hosted);
   C2 fix 7 (direct bind, no service account); B2 fix 1 (privileged subset first), fix 2 (per-design
   scope), fix 8 (mark, not refuse), fix 9 (chain head to L6 via the log path); D4 fix 1 (node
   wins); D5 fix 4 (INTO `config` is major); D6 fix 4 (put to the owner); E4 fix 2 (the rule, no
   new key), fix 4 (`partial` exempt, provisional); D1 fix 2 (reword the hint, no prompt).
10. **Most security evidence is from GitHub-hosted copies of documentation, not the published
    pages.** Vendor and standards hosts were blocked at the proxy; the source files may differ from
    a tagged release; NIST texts came from mirrors and OSCAL; RFCs from mirrors whose byte-identity
    with the RFC Editor was not verified. Each decision names its blocked hosts.
11. **Rule 0 has three live instances in this record.** D7's redaction canaries must be 1–8
    characters for OSPF simple-password because that is what Junos accepts, not what the detector
    needs; A2's chain detects tampering only within the anchor's retention window; C1's default-deny
    does not close DNS as a covert channel. Each is stated where it applies; a reader who takes the
    control name for the control's reach will be wrong.
12. **A `Chassis` may be both `MountedIn` a rack and `RestsOn` a fixture** (D4 fix 7). Nothing
    forbids it, `62` §12.3's predicate grammar cannot express an edge-presence implication, and it
    is an L1 hole for a future rule, never a store refusal. The elevation will draw what it is
    given.
13. **The S16-2 bench test can fail on spelling alone.** The CLI form of the key-minting command is
    the recommendation's, not verified in `49` §16.1a(vi), which records the RPC name. A failed
    check 1 must distinguish "the command does not exist as typed" from "the identity is not
    accepted".
14. **Forward compatibility is asserted nowhere in this record except D5, and marked VERIFY in D4
    and D6.** Groups-and-tags fix 1 established that the shipped `importJournal` stops at a record
    of a kind it does not know; what it does with an unknown field key was verified by no one. A
    planning session that needs the tolerated direction must drive it.

## Open decisions

Every `still_needs_owner` question, verbatim, plus what the skeptics' fixes moved to the owner.
Nothing here is answered by this record.

### Security

**A1 — the master key**
- *"Does your employer's IT already run HashiCorp Vault (or OpenBao) — and if not, do they have an
  AWS, Azure or Google account that the security team would let Fathom's key chain use?"*
- *"If your employer runs neither Vault nor a usable cloud key service, are you willing to run
  OpenBao or Vault as one more container in your own demo stack?"* (added by fix 11)
- Whether shipping a compose file with a Vault sidecar to third parties falls under the BSL's
  *"hosted or embedded basis"* clause — legal's, and dependent on §B1 (moved by fix 10).

**A2 — the audit log**
- *"Do you want the first release to keep this record from the first drawing it saves — yes or no?
  (If yes, everything else above is decided for you; if no, the demo answer to "is there an audit
  log?" stays "not yet".)"*
- The retention commitment the first release promises; twelve months is PCI DSS 10.5.1's benchmark,
  not a requirement (moved by fix 8).
- Whether `source_addr` is stored truncated (`43` P-8, the default taken) or at full precision
  (offered by fix 9).

**C1 — server egress**
- *"Do you agree the server may only ever connect to that short list — its own database, your
  company's login service, your mail relay, the key store and the certificate authority — and never
  to any network device or back to us, with anything else treated as a fault?"*
- Whether ADR-0020's tier 1 or tier 3 is still wanted, given that `49` says nothing about an AI
  layer and this rule reserves a conditional row for it (flagged by fix 1).

**C2 — device-password login**
- Rewritten by fix 2: *"Fathom will never talk to the login servers your switches use
  (TACACS+/RADIUS) and will never hold their secret; people sign in with company single sign-on
  where the company has it, otherwise with the company directory (in which case the password does
  pass through Fathom once per login, protected in transit), or with a Fathom-only password — may I
  record that as the rule, yes or no?"*
- Original, for the record and withdrawn as false on the self-hosted path: *"Can I record the rule
  as: "People sign in to Fathom with their company login (or a Fathom-only password), never with the
  password they use on the network equipment"? — yes or no."*

**`49` §16.2's device half — firmware fetch**
- *"Can you get someone 30 minutes on one real Juniper SRX and one real Arista switch (or their
  virtual versions, vSRX and cEOS/vEOS) to run a four-step test of whether each box can log in to
  the firmware server with a key, or only with a password?"* (the duration is the draft's; §6 claims
  none)
- That the bench test be the first firmware task — a proposal about ordering, which is yours and
  planning's (moved by fix 6).
- *"If your Arista switches can only log in with a password, do you want (a) a separate account and
  password per switch — revocable one switch at a time, but a password stored on each switch — or
  (b) no firmware-fetch feature for Arista until something better is proven? This is about your
  employer's policy on stored passwords, so it is yours."* (added by fix 7)

**B2 — operator reads a map**
- *"Inside your company, when an admin switches on "open any design" to look at someone else's
  drawing, is it enough that the drawing's people are told and it is permanently recorded — or must
  a second person approve first, every time?"*
- Put as one decision (fix 6): *B2 with a record requires A2 = yes; accepting this answers both.*
- Surfaced by fix 8: the admin's free-text reason is shown to every member of the design.

### Data model

**D2 / D10 — groups and tags**
- *"Is it fine that every group and every tag is seen by everyone who can open that drawing, or do
  you need some that only you can see?"*
- A group lives inside one drawing; a Meraki-organisation-tier group across drawings would be a
  server-side table (surfaced from the foreclosure list).

**D3 — more than one role**
- *"When a box does three or more jobs, is "firewall +2" on the box — with every word one click away
  in the side panel — good enough, or must every word be drawn on the box itself?"*
- The decision itself: D3 has no recorded answer; the schema text carries a dated approval slot.
- Whether to take a major-class change pre-1.0 (recommended) or the minor-by-the-letter second
  `roles` field (recommended against).

**D4 — racks**
- *"Is a named box with one word on it (shelf, power strip, UPS) enough for your rack furniture, or
  do you need a power strip to know what is plugged into each of its outlets — the first is this
  change, the second is a power map Fathom has refused so far and would be a separate decision?"*
- Reopening the refused rack move (`57` §14.1 B4; ADR-0036 §8 item 5) — offered, not announced.

**D5 — presentation layer**
- *"Do you agree that "where you put a box on the drawing" gets its own fourth heading, kept apart
  from how the device is configured, so nothing that later re-reads a config can touch it — yes or
  no?"*

**D6 — draft and planned**
- *"Is it right that a box you mark as planned stays marked for everyone who opens the design —
  saved and exported with the box — rather than being a switch or a filter on your own screen?"*
- On an element a config has already shown (including a pasted draft config for an unbuilt box), is
  the `planned` tick refused, or allowed and marked (ADR-0041's precedent)? (moved by fix 4)
- Option 1 — a per-screen switch or filter — remains available (surfaced by fix 3).
- `planned` could be a tag instead; the trade is his to reverse (surfaced by fix 8).

**D7 — relay into a routing instance**
- *"Do you want Fathom taught to read the `routing-instances` block now (route 1), accepting the
  one-line schema bump that comes with it?"*

**E4 — one file to read and write**
- *"Are you happy that whatever Fathom learns to READ from a vendor's config it may also WRITE back
  — one entry, one reviewer, no separate sign-off for the writing half?"*

**D1 — hosts**
- *"Which kind of host will actually be in your demo — Proxmox, VMware, plain Linux, Windows Server,
  a NAS — so the first host engine is one you can paste a real config from, since you said you have
  no Proxmox box?"*
- Approving the door removal, with the two cautions (silent duplicate on a later paste; existing
  Juniper-tagged boxes stay so until the clear control exists).

### Planning's, not the owner's — recorded here so they are not lost

- Sequencing the six "0.6" bumps and their key ranges (*Failure modes* item 1).
- Reconciling D5's layer-based drift test with §8's name-based exclusions (item 2).
- E4's home: an amendment to WO-04 or a successor order; where the inverting loader lives.
- Whether A2's event list is kept at twenty-four plus one or shrunk (and which were cut).
- The group/tag/target-version layer classification D5 fix 6 removed from the `62` §4.2 test
  sentence (`70` §19.1 reserves it for planning).

## Sources consulted

Read date is 2026-09-04 unless the row says otherwise. Every row is a source the recoverable
reasoning or a skeptic's fix names; the `sources` field of each security decision is a count that
exceeds what can be enumerated from the truncated text, and the shortfall is stated per table.
Hosts recorded as blocked were not opened; nothing is cited from them.

### A1 (count: 29; rows recoverable: 20, plus one row naming the blocked hosts)

| what | where | when |
|---|---|---|
| `MasterKeyProvider`, the `(wrap_provider, wrap_key_id)` registry, the `file` provider scoped to dev/test | WO-12 §4.4 | 2026-09-04 |
| The two situations §A1 names | `docs/70-ops/OPEN-FOR-THE-OWNER.md` §A1 | 2026-09-04 |
| *"enterprise level"*; the employer's security review as audience | `70` §18.1, §19.5 | 2026-09-04 |
| D1–D4; finding 1 (envelope encryption in all three clouds); finding 3 (Slack, Atlassian, Miro, Lucid, Salesforce) | ADR-0040; `49` §3 addendum — repo documents whose own vendor lookups are dated 2026-08-28 | 2026-09-04 |
| *"Optionally, you can use your own AWS Key Management Service (KMS) encryption key for data at rest"* | GitLab Dedicated docs source, official GitHub mirror | 2026-09-04 |
| *"the secrets file contains your database encryption key"*; `/etc/gitlab/gitlab-secrets.json`; backup exclusion and the loss warning | GitLab backup docs source on GitHub | 2026-09-04 |
| KEK via `secret_key` or a KMS; the four Enterprise providers; the Transit integration steps | Grafana docs source on GitHub | 2026-09-04 |
| Vault AWS KMS auto-unseal; Vault Transit | Vault documentation (opened by the research; paths beyond the cut) | 2026-09-04 |
| *"All Vault versions support auto-unseal for Azure Key Vault, but seal wrapping requires Vault Enterprise"* (lines 16–17); the same for GCP Cloud | `content/vault/v1.21.x/content/docs/configuration/seal/azurekeyvault.mdx`; `…/seal/gcpckms.mdx` — opened by the skeptic | 2026-09-04 |
| Vault Proxy auto-auth: AppRole `role_id_file_path` / `secret_id_file_path` | Vault Proxy documentation | 2026-09-04 |
| BSL licence; *"Vault Version 1.15.0 or later"*; the *"hosted or embedded basis"* clause | Vault LICENSE | 2026-09-04 |
| README (Zulip chat, OpenSSF lists, open-governance statement); LICENSE (MPL 2.0); what-is-openbao | OpenBao repository | 2026-09-04 |
| §6.1, extracted text lines 3275–3277; cover, author, DOI, *"May 2020"* | NIST SP 800-57 Part 1 Rev. 5 — unofficial GitHub mirror of the PDF (NIST hosts blocked) | 2026-09-04 |
| *"If a TPM2 device is available and /var/ resides on a persistent storage"*; `/var/lib/systemd/credential.secret`; container passing (systemd-nspawn only) | systemd `CREDENTIALS.md` | 2026-09-04 |
| Distroless container, no systemd | `deploy/compose.yaml` | 2026-09-04 |
| Phase-1 table: rustls 0.23.43; lettre *"use the rustls backend"*; openidconnect | `49` §6 | 2026-09-04 |
| Direct dependencies need `deps/decisions/<crate>.md` | `scripts/gate-zero.sh` lines 26–28, 192–194 | 2026-09-04 |
| Envelope encryption; the FIPS 140 sentence | AWS KMS documentation (page opened; path beyond the cut) | 2026-09-04 |
| *"RustCrypto-based provider"* | rustls provider README | 2026-09-04 |
| NetBox v3.0 notes recommend Vault | via `49` §2 | 2026-09-04 |
| Slack EKM, Atlassian BYOK/CMK, Miro EKM, Lucid KMS, Salesforce Shield — vendor pages | **blocked**; search snippets only, not cited | — |

### A2 (count: 28; rows recoverable: 15, plus one row naming the blocked hosts)

| what | where | when |
|---|---|---|
| AU-2, AU-3, AU-9, AU-11, AU-12 text; the LOW / MODERATE / HIGH baseline profiles | NIST SP 800-53 Rev 5.2.0 — NIST's own OSCAL catalogue and baseline profiles on GitHub (csrc.nist.gov blocked) | 2026-09-04 |
| CC7.2 criterion; points of focus (prowler copy only) | prowler-cloud/prowler; wazuh/wazuh-dashboard-plugins | 2026-09-04 |
| 8.15 control statement | prowler-cloud/prowler; Evolveum/docs | 2026-09-04 |
| 10.5.1 *"Retain audit log history for at least 12 months…"* | turbot/steampipe-mod-aws-compliance; MicrosoftDocs/entra-docs | 2026-09-04 |
| `sha2 0.11.0`, `hmac 0.13.0` via `postgres-protocol 0.6.12`; no `argon2`, no `hkdf` | `Cargo.lock` | 2026-09-04 |
| §5 adds argon2/hkdf and promotes sha2; §7 trigger 7 | WO-12 | 2026-09-04 |
| L4 (7-day operational), L6 (administrative action), P-8 (address truncation) | `docs/40-stack/43-deployment-modes.md` | 2026-09-04 |
| §9 (live multi-user editing); §13 (the two events responders ask for first) | `49` | 2026-09-04 |
| `looks_like_credential` | ADR-0041 | 2026-09-04 |
| No sequence field found | `crates/fathom-graph/src/prov.rs`, `op.rs` (skeptic) | 2026-09-04 |
| *"Data import and export including screen-based reports"* | OWASP logging guidance — page title beyond the cut; the VERIFY marker is in §3.1 | 2026-09-04 |
| Compliance page (edition not stated) | Mattermost documentation | 2026-09-04 |
| Audit devices — v1.15.0 tagged copy | hashicorp/vault on GitHub | 2026-09-04 |
| Audit-log documentation | NetBox, Nautobot, GitHub, Grafana, Kubernetes, CloudTrail — GitHub-hosted sources (files beyond the cut) | 2026-09-04 |
| Q75 | `36` | 2026-09-04 |
| Lucidchart, Miro, Figma, Atlassian, Slack, Notion audit-log tiers; NIST SP 800-92; AICPA; ISO; PCI SSC | **blocked**; not cited | — |

### C1 (count: 29; rows recoverable: 14; blocked hosts are named per row)

| what | where | when |
|---|---|---|
| Six direct dependencies; the healthcheck's *"must never grow into"*; `NoTls` to `DATABASE_URL` | `crates/fathom-server/Cargo.toml`, `src/healthcheck.rs`, `src/db.rs` | 2026-09-04 |
| hyper-util features (no `client`); 93 host-target packages; 114–115 with `--target all` | `cargo tree -p fathom-server --locked -e features -i hyper-util`; `… -e normal`; `… --target all` | 2026-09-04 |
| 115 external packages | `Cargo.lock` | 2026-09-04 |
| `db:5432`, `expose` not publish; `tls internal`, `admin off`; builder-stage-only reaches; status NOT RUN | `deploy/compose.yaml`, `deploy/Caddyfile`, `deploy/Dockerfile`, `deploy/ca/README.md`, `deploy/README.md` | 2026-09-04 |
| *"Local HTTPS does not use ACME nor does it perform any DNS validation"*; the two default CAs; port 80 / 443 | caddyserver/website `automatic-https.md` (caddyserver.com blocked) | 2026-09-04 |
| *"…you must add a separate NetworkPolicy that allows egress to your cluster's DNS service"* | Kubernetes documentation — GitHub-hosted source, default branch (kubernetes.io blocked) | 2026-09-04 |
| `--internal` (written about overlay networks); *"does not discuss DNS behavior in relation to the --internal flag"* | docker/cli reference — GitHub-hosted source (docs.docker.com blocked) | 2026-09-04 |
| `internal: true` (the general sentence) | compose-spec — GitHub-hosted source | 2026-09-04 |
| SC-7(5) control text with `{{ insert: param, sc-07.05_odp.01 }}` / `<2>` | NIST OSCAL catalogue; GovReady dataset (csrc.nist.gov, csf.tools blocked) | 2026-09-04 |
| Beacon opt-in; forced choice since 22.10.0; no `SENTRY_BEACON` in `sentry.conf.example.py` | Sentry develop-docs source; getsentry/self-hosted (develop.sentry.dev blocked) | 2026-09-04 |
| Phone-home defaults of the three other comparable products | GitHub-hosted documentation sources (files beyond the cut; docs.gitlab.com, grafana.com, netboxlabs.com blocked) | 2026-09-04 |
| §6 (`openidconnect`, `lettre`, PostgreSQL replaces the blob store), §12, §19 | `49` | 2026-09-04 |
| §5.2 (*"the only outbound connection fathom-sync ever makes"*), §5.3, §6, §6.10 | `43` | 2026-09-04 |
| `70` §18.2; ADR-0040 D1 and §9; ADR-0020 tiers; WO-12 (*"A cloud KMS wrap is a network round trip"*) | repo | 2026-09-04 |

### C2 (count: 29; rows recoverable: 20, plus one row naming the blocked host)

| what | where | when |
|---|---|---|
| RFC 8907 §5.4.2, §10.1, §10.5, §10.5.1 (September 2020, Informational) | GitHub-hosted copy — mnot/rfc-refs (rfc-editor.org blocked) | 2026-09-04 |
| RFC 9887 (December 2025, Standards Track, updates 8907) | GitHub-hosted copy | 2026-09-04 |
| RFC 2865 §5.2, §8 (June 2000) | FreeRADIUS `doc/rfc` on GitHub | 2026-09-04 |
| RFC 9765 (April 2025, Experimental) | GitHub-hosted copy | 2026-09-04 |
| CVE-2024-3596 / BlastRADIUS, GHSA-3g8x-wqfp-q876, 2024-07-09, CVSS 3.1 9.0 | GitHub advisory record (nvd.nist.gov, kb.cert.org, blastradius.fail blocked) | 2026-09-04 |
| 3.2.5 ChangeLog (*"Tue 09 Jul 2024 … urgency=high"*); `radiusd.conf.in` mitigation comments | FreeRADIUS on GitHub | 2026-09-04 |
| `mods-available/ldap` *"bind as user"* against AD | FreeRADIUS v3.2.x `raddb/mods-available/ldap` | 2026-09-04 |
| §5.1.3, §6 (the bind carries the password) | RFC 4513 — mnot/rfc-refs copy | 2026-09-04 |
| The bind flow | django-auth-ldap `docs/authentication.rst` | 2026-09-04 |
| *"The same set of credentials is used for network access control … and to sign in to an AD DS domain"* (ms.date 05/05/2025) | MicrosoftDocs/windowsserverdocs `nps-top.md` | 2026-09-04 |
| `AUTH_LDAP_BIND_DN` / `AUTH_LDAP_BIND_PASSWORD` | NetBox `docs/installation/6-ldap.md` | 2026-09-04 |
| oxidized-web 0.15.0 (2025-02-17): *"A non-authenticated user could gain control over the Linux user running oxidized-web"* | Oxidized CHANGELOG | 2026-09-04 |
| *"Federation and Assertions"* heading and three benefit bullets (section number not visible) | NIST SP 800-63-4 — GitHub rendering | 2026-09-04 |
| Finalized revision superseding SP 800-63B (date not carried) | NIST SP 800-63B-4 — GitHub rendering | 2026-09-04 |
| Tiering sentences | Entra Connect prerequisites page (MicrosoftDocs) | 2026-09-04 |
| §14 *"The parse-server question"*; §14.3 the checklist | `docs/30-security/38-the-egress-question.md` | 2026-09-04 |
| §2 (*"protected by never arriving"*); §6 (*"Fathom never touches your devices…"*) | ADR-0040 | 2026-09-04 |
| Hand-typed values stored as typed; invariant 3 annotation | ADR-0041; `.context/conventions.md` | 2026-09-04 |
| The planned sign-in shape | `49` §12 | 2026-09-04 |
| The held-secrets enumeration | `32` §21.3; `33` §18.3 | 2026-09-04 |
| `www.cisco.com` | **EGRESS_BLOCKED**; not cited | — |

### `49` §16.2's device half (count: 27; rows recoverable: 8, plus one row naming the blocked hosts)

| what | where | when |
|---|---|---|
| `rpc request-system-download-start` (25.2R1 line 2787; 25.4R1 line 2875) and its leaves; `rpc generate-ssh-key-pair` (line 4630) | `Juniper/yang` commit `96ad7bad`, `junos-es-rpc-request@2025-01-01.yang` and the 25.4R1 module — raw blob, grepped; **verified by the lead, `49` §16.1a(vi)** | 2026-09-04 |
| `rpc file-copy`: four input leaves | `Juniper/yang` `96ad7bad`, `junos-es-rpc-file-mgd@2025-01-01.yang` 25.2R1 — `49` §16.1a(ii) | 2026-09-04 |
| §7 (publickey REQUIRED); §8 (password SHOULD) | RFC 4252 — openbsd/www RFC mirror | 2026-09-04 |
| `restrict`, `from=`, `command=`; `ForceCommand`, `ChrootDirectory`, `PasswordAuthentication`, `PubkeyAuthentication`, `FingerprintHash` | `sshd(8)`, `sshd_config(5)` — openssh-portable master, Mdocdate 2026-09-02 | 2026-09-04 |
| §3.4.1 (password *"generally not recommended"*), §3.4.2–§3.4.4; the AC-2 mapping table; *"log key fingerprints"* | NIST IR 7966 (October 2015, DOI 10.6028/NIST.IR.7966, 50 pages) — third-party GitHub-hosted PDF, front matter verified | 2026-09-04 |
| `copy` sources and destinations; `boot-config`; `install source`; `hostkey client strict-checking`; three password-prompt examples | aristanetworks, arista-eosplus, arista-eosext GitHub organisations (files beyond the cut) | 2026-09-04 |
| README line (verified); `INSTALL` absent at the root (HTTP 404) | arista-eosext/rphm at commit `45067ac` | 2026-09-04 |
| §16.1, §16.1a (i)–(vi), §16.2, §16.3 (a)–(c), §21 item 13 | `49` | 2026-09-04 |
| juniper.net, arista.com, rfc-editor.org, ietf.org, NIST hosts, OpenSSH hosts, cisco.com, paloaltonetworks.com, web.archive.org, github.com (HTML), api.github.com | **blocked (CONNECT 403)**; not cited | — |

### B2 (count: 24; rows recoverable: 9, plus one row naming the blocked hosts)

| what | where | when |
|---|---|---|
| Admin Mode: default-off, 404 on non-member private groups/projects, re-authentication, six-hour expiry | GitLab documentation source on GitHub, `doc/administration/settings/sign_in_restrictions.md` | 2026-09-04 |
| `user_enable_admin_mode` (GitLab 15.7); `user_impersonation` | GitLab `audit_event_types.md` | 2026-09-04 |
| *"Users with administrator access have all permissions and can perform any action"* | GitLab `permissions.md` | 2026-09-04 |
| Reason required; one-hour limit; audit log and security log; email that cannot be deactivated | github/docs `content/admin/…/impersonating-a-user.md` | 2026-09-04 |
| Review/approve/reject; JIT service; Customer Notified state; four-day expiry | MicrosoftDocs/azure-docs `articles/security/fundamentals/customer-lockbox-overview.md` | 2026-09-04 |
| CloudTrail boilerplate | awsdocs GitHub mirror (archived status not established) | 2026-09-04 |
| Permissions and authentication pages (superuser scope not stated); roles page (cross-org visibility not stated) | NetBox; Grafana — GitHub-hosted documentation | 2026-09-04 |
| §A2 definition; §B2; §B4 | `docs/70-ops/OPEN-FOR-THE-OWNER.md` | 2026-09-04 |
| `49` §13, §19; WO-12 §7 triggers 5–6, §8; ADR-0040 §1 finding 3, §9 item 4; ADR-0041; `43` L6 | repo | 2026-09-04 |
| Google Access Transparency / Access Approval; Slack EKM; Atlassian audit log; Lucid, Figma, Miro admin scope; AWS IAM / break-glass / Data Privacy FAQ; HIPAA 45 CFR 164.312; Okta support access | **blocked**; not cited | — |

### The eight schema decisions

All designed against the tree on 2026-09-04; every file below was opened by the design or by its
skeptic, and the line numbers are theirs.

| what | where | when |
|---|---|---|
| 51 kinds · 95 edges · 61 scalars · 10 enums; 0 failures / 0 warnings | `cargo run -p fathom-schema --bin fathom-schema-check` | 2026-09-04 |
| The grammar, the bump table, the gates | `62` §2.3–§2.4, §4.2–§4.3, §5, §7, §9.1, §10.3, §11.4, §12.3, §14, §16.2, §16.4, §19.2–§19.4, §20.6 | 2026-09-04 |
| `schema.yaml`, `field-keys.yaml`, `platforms.yaml`, `enums/family.yaml`, `host_service.yaml`, `host_protocol.yaml`; `migrations/manifest.toml`; `released/` (empty); `generated/schema.json`, `ir_types.ts` | `schema/` | 2026-09-04 |
| `set{X}` resolves only against enum files (`gates.rs:229`); *"only enum-file members are generatable today"* (`extract.rs:605`); `schema.json` passthrough (`lib.rs:134-160`) | `crates/fathom-schema/src/gates.rs`; `crates/fathom-schemagen/src/extract.rs`, `src/lib.rs` | 2026-09-04 |
| Canon rule 12 refuses a non-ascending array | `crates/fathom-ir/src/canon.rs:240` | 2026-09-04 |
| `projection_of` (exhaustive match); `live_nodes` exclusion | `crates/fathom-layout/src/layers.rs`, `src/agg.rs` | 2026-09-04 |
| Pinned counts and versions | `crates/fathom-schema/tests/shipped_tree.rs` (70/74/95); `crates/fathom-ir/tests/canon_laws.rs` (82/575); `edge_tables.rs` (95); `crates/fathom-weld/tests/containment.rs`; `crates/fathom-workspace/tests/plain_face.rs`; `crates/fathom-ingest/tests/dict_gates.rs::entry_count_is_90` | 2026-09-04 |
| `OP_FIELD_SET` refuses an empty value (`shell.rs:653`); `paste_reply` (2864–2940); `identity_clash` (3293) | `crates/fathom-wasm/src/shell.rs` | 2026-09-04 |
| `11` §7.1 cited at line 636; `clear_field` with no non-test caller (859) | `crates/fathom-graph/src/graph.rs` | 2026-09-04 |
| `assemble` (line 97) | `crates/fathom-artifact/src/lib.rs` | 2026-09-04 |
| The paste hint (~9388); import stop-and-reset (~10382–10396); `importJournal` slicing later ops | `crates/fathom-artifact/html/fathom-dev.src.html` | 2026-09-04 |
| `Dictionary::load` via `read_dir`; `.get`-based key reading; edge-`from` parse | `crates/fathom-ingest` `dict.rs`; `corpus/dict/junos-srx/README-routing.md` §1–§2; `token-maps.yaml` | 2026-09-04 |
| 22 `EmittedLine::new` sites; `BLOCKS`; GOLDEN bytes; `schema.emit.unread`; `line.rs:104` | `crates/fathom-emit/src/junos.rs`, `block.rs`, `line.rs`, `tests/worked_example.rs`, `tests/coverage.rs` | 2026-09-04 |
| `page.selectOption('#ef9', role)` at line 72 | `docs/80-review/evidence/2026-08-16-server-role-drive.mjs` | 2026-09-04 |
| `equip.rs:497` two-role test | `crates/fathom-wasm` (equip tests) | 2026-09-04 |
| The IR: §4.6–§4.7, §6.5, §6.9, §7.1–§7.2, §9.1, §10.3–§10.6, §11.3, §12.3 | `11` | 2026-09-04 |
| Emission: §2.5, §4.1, §5.2, §16 OD-2 | `13` | 2026-09-04 |
| §6.2 (normative entry table), §6.4, §7.3 | `14` | 2026-09-04 |
| §3.6, §3.9, §3.10, §6.5, §9.1 and Amendment 2 | `19` | 2026-09-04 |
| §4.2–§4.4, §10.1 | `03` | 2026-09-04 |
| §1.2, §6.3, §13.6 | `56` | 2026-09-04 |
| §2, §14.1 B4, §15.5–§15.6, §16 | `57` | 2026-09-04 |
| `52` §6.7; `53` §2.2 | repo | 2026-09-04 |
| §7 (qm.conf(5), qm(1), pct(1), pvesh(1) — its own lookups 2026-08-28) | `64` | 2026-09-04 |
| §2, §4, §7 | `65` | 2026-09-04 |
| §6, §10.4, §10.9, §10.10, §18.4, §18.5, §19, §19.1–§19.2 | `70` | 2026-09-04 |
| C-01, C-04, §3.2–§3.4, §10.7 | `75` | 2026-09-04 |
| ADR-0008, ADR-0011, ADR-0035, ADR-0036 (§5.2, §8 items 3 and 5), ADR-0037 (§1–§5, §8.5, §9), ADR-0038, ADR-0039, ADR-0040 (D8), ADR-0041 | `docs/90-decisions/` | 2026-09-04 |
| WO-04 §4.5–§4.7, §10.2; WO-05 §10.2; WO-10 §10 item 5, §11 item 2; WO-11 G8; WO-12 §7, §8 | `docs/70-ops/79-work-orders/` | 2026-09-04 |
| §D1 (line 234), §D2, §D3 (line 288), §D4–§D7, §D10, §E4 | `docs/70-ops/OPEN-FOR-THE-OWNER.md` | 2026-09-04 |

## Disagreements

1. **No required change reversed a recommendation's direction.** Three came closest and were
   judged corrections, not reversals, and were applied: C2 fix 1 splits the rule and confines
   *"the password never reaches Fathom"* to federation — the direction (no TACACS+/RADIUS ever;
   SSO first) stands; B2 fix 1 withdraws *"A2 is answered"* — the direction (yes, never quietly)
   stands; D6 fixes 3–4 return option 1 and the paste-refusal to the owner — the direction (the
   middle option, a status that sticks to the equipment) stands.
2. **The S16-2 skeptic and the lead reviewer differ on line numbers and platform coverage.** The
   skeptic's fix 1 cited the download RPC at lines 2951–2999 of the 25.2R1 module, at line 1649 of a
   17.2R1 SRX module, and at lines 2566 and 3166 of EX and QFX 25.2R1 request modules, with MX and
   Evolved absent. The lead's verified record (`49` §16.1a(vi), read 2026-09-04 against
   `Juniper/yang` `96ad7bad`) cites line 2787 (25.2R1) and 2875 (25.4R1) for the download RPC and
   line 4630 for `generate-ssh-key-pair`, and records the MX and EX modules as **not read**. Per the
   lead's instruction, §6 carries the lead's facts; the skeptic's EX/QFX presence, the 17.2R1
   reference and the MX/Evolved absence are **not asserted** here. <!-- VERIFY: the EX and QFX
   25.2R1 junos-rpc-request modules for `request-system-download-start`, and the 17.2R1 SRX module;
   the skeptic's line numbers may be a different file or a different revision of the same module.
   --> The skeptic's direction — that the SRX has a documented download door with a key slot the
   draft missed — is confirmed by the lead and applied.
3. **C2 fix 10 versus this record's verbatim-carry rule.** The fix says to *replace* a
   `could_not_establish` item; the record's rule is to carry the list verbatim. Both are honoured:
   the original item stands and a bracketed correction follows it (§5.4 item 8).
4. **Two skeptic rules were applied beyond the decisions they were found in** (§1 item 6): A2's
   *"days of work"* removed under B2 fix 4; D4's and D6's `Kind::Unknown` / preserve-mode
   forward-compatibility sentences withdrawn or marked VERIFY under groups-and-tags fix 1. Each is
   labelled *applied beyond the list* in its section.
5. **E4 against `14` §6.2.** E4 part (A) amends `14` §6.2's normative entry table — removes the
   required `explain` and the `emit.template`/`risk` sub-keys and makes `emit` optional. Under
   `.context/conventions.md`'s Precedence rule this is a disagreement with a specification document,
   filed here, and it is planning's to ratify by amending `14`, not an execution session's to build
   past.
6. **E4 against `13` §2.5.** Deriving idempotency from the entry's binding shape (`Accumulating` iff
   positional or append-enum; `Replacing` for a multi-field child-node entry; else `Idempotent`) is a
   disagreement with `13` §2.5's *"declared, not inferred"*. The design's position: the binding shape
   IS the leaf-list fact, and a declared key would be a second spelling of it. Planning's call.
7. **E4 downgrades `62` §19.4's `dict.explain.unknown` from a build gate to a ledger.** Also
   planning's; presented here as the design's proposal, not as settled.
8. **D6 against `03` §4.3.** `03` §4.3 says *"no field represents a process state"* (Reopens: Never;
   amendment via `03` §10.1). The design reads `planned` as a one-directional disclaimer rather than
   a process state — cleared only by a person, evaluated by nothing. That is a reading of the owner's
   product boundary, recorded here as a reading; if he or planning disagrees, D6 needs `03` §10.1's
   amendment path before it lands.
9. **D5's second proposed row is priced major.** The skeptic allowed *"major (or: minor, with the
   re-identification and staleness consequences priced in the version comment — pick one)"*. Major
   is picked because a kind moving INTO `config` changes what an existing record means on the next
   re-paste; a reviewer who prefers minor-with-pricing reverses one cell of the table in §11.1.
10. **Six schema decisions each claim 0.6.** Not a disagreement between two documents but between
    eight designs that never saw each other; recorded under *Failure modes* item 1 and left to
    planning.
11. **The `sources` counts and the enumerable rows.** The security decisions count 29, 28, 29, 29,
    27 and 24 sources; the tables above enumerate 20, 15, 14, 20, 8 and 9 opened sources. The difference is the
    3,000-character cut on `reasoning`, not sources this record declined to name. The full lists
    exist only in the workflow outputs.
12. **A2's event count.** The skeptic offered *"make the summary agree with the list, or shrink the
    list and say which were cut"*. This record keeps the twenty-four and adds one; the executing
    order may shrink it, and if it does, it says which.
13. **D7's `entry_count_is_90` re-pin is stated as 91.** That is arithmetic on the fix's own facts
    (90 entries plus the single `instance-type` entry), not a measurement; read the number off the
    run.
14. **This record's own choices among either/or fixes** are consolidated under *Failure modes* item
    9 so that a reviewer who disagrees with any of them can find and reverse it without re-reading
    the whole record.
