# 37 — Privacy, data protection and compliance

> **Status:** Proposed

This document answers the questions a data protection officer asks after the security architect
has finished. It is the companion to `36-enterprise-review-qa.md`: that document is about whether
the thing is secure, this one is about whether it is lawful to use, who is responsible for what,
and what we can honestly put our name to in a contract.

**This is not legal advice and does not pretend to be.** It is an engineering document about what
the architecture makes possible and impossible, written so that a lawyer has something concrete
to work from instead of a marketing page. Every place where the answer needs counsel says so.

**The governing rule of this document, stated once, in caps, at the top:**

> **MOST OF A WORKSPACE IS NOT PERSONAL DATA. THE PARTS THAT ARE GOT THERE BY ACCIDENT, AND THE
> ARCHITECTURE IS WORSE AT REMOVING THEM THAN AT PROTECTING THEM.**

That sentence is the whole document. §2 finds the personal data. §7 is the part the architecture
is genuinely bad at, stated without softening. §13 is the part where the frameworks themselves do
not fit, which is a different problem from failing them.

---

## 0. Contents

| § | |
|---|---|
| 1 | Scope, and the two questions that decide everything |
| 2 | Is there personal data here at all — the inventory |
| 3 | Ciphertext, and the relative approach after *EDPS v SRB* |
| 4 | Controller, processor, and the self-hosted case |
| 5 | The DPA we can honestly sign |
| 6 | Data residency and international transfers |
| 7 | Retention and erasure — the architecture's worst compliance fit |
| 8 | Data subject rights against ciphertext |
| 9 | Personal data breach |
| 10 | Cookies, ePrivacy, PECR |
| 11 | Export control and cryptography |
| 12 | Sectoral frameworks |
| 13 | Where compliance frameworks assume a model this architecture does not fit |
| 14 | What CI and the product enforce |
| 15 | Residual risk register |
| 16 | Sources |
| 17 | Disagreements |

---

## 1. Scope, and the two questions that decide everything

### 1.1 What this document covers

Data protection law as it applies to a client-side, zero-knowledge network engineering tool, with
GDPR and UK GDPR as the reference frameworks because they are the strictest ones most customers
must satisfy, plus the sectoral regimes that come up (§12) and export control (§11), which is a
compliance question specific to shipping cryptography internationally.

Out of scope, and specified elsewhere: the threat model (`31-threat-model.md`), the cryptographic
design (`32-cryptography.md`), the security review answers (`36-enterprise-review-qa.md`).

### 1.2 The two questions

Everything below reduces to two questions, asked in this order:

| # | Question | Where answered | Why the order matters |
|---|---|---|---|
| 1 | **Is any of this personal data?** | §2 | If none of it is, most of the framework does not engage and the conversation is much shorter. The honest answer is "mostly no, and the exceptions are specific and nameable" |
| 2 | **Who is the controller, and is anyone a processor?** | §4 | In four of the five deployment shapes there is no processor at all, because nobody but the customer receives anything |

Reviews go wrong when these are asked in the wrong order — a customer's template starts by
demanding a DPA, which presumes a processor, which presumes processing that in most shapes does
not happen.

### 1.3 The shape decides the roles

`34-browser-hardening.md` §2.1's five modes, mapped to data protection roles:

| Mode | What it is | Controller | Processor | Our role |
|---|---|---|---|---|
| **A** reference artifact | one `.html`, no workspace, read-only corpus | the customer, for whatever they do with it | none | supplier of a document |
| **B** offline workspace | bundle + `fathom serve` on loopback | the customer | none | software supplier |
| **C/D** self-hosted with sync | the customer's own server | the customer | the customer's own hosting provider, if any | software supplier |
| **E** CLI | one native binary | the customer | none | software supplier |
| Hosted sync operated by us | if we ever run one | the customer | **us**, over ciphertext and metadata | processor |
| AI tier 1 | inference at a third party | the customer | **the provider**, under the customer's own contract | **not in the chain** |

**We lead with B, C, D and E.** A review that begins by assessing a hosted SaaS is assessing a
shape we do not lead with, and correcting that in the first ten minutes removes most of the work.

---

## 2. Is there personal data here at all?

### 2.1 The test

GDPR Article 4(1): personal data is any information relating to an identified or identifiable
natural person. Recital 26: to determine identifiability, account should be taken of all the means
reasonably likely to be used, by the controller or by another person, taking into account cost,
time and available technology.

For a network configuration, that produces a boring answer and one interesting one. Boring: an
IKE proposal, a DH group, a lifetime, a traffic selector and an MTU are not about people. There
is no more personal data in `set security ipsec proposal IPSEC-P2 encryption-algorithm
aes-256-gcm` than in a plumbing diagram.

Interesting: **network configurations written by humans are full of humans.** Not in the protocol
fields — in the descriptions, the contacts, the login stanzas and the comments. That is where the
personal data is, and it is there because engineers put it there, not because the schema asked for
it.

### 2.2 The inventory

Every place in the product where personal data can appear, with a verdict. This is the table to
hand a DPO.

| # | Where | Example | Verdict | Notes |
|---|---|---|---|---|
| 1 | `Device.platform`, version fields | `junos-srx`, `21.4R3` | **not personal** | |
| 2 | Crypto parameters | `dh-group group14`, `lifetime-seconds 28800`, `perfect-forward-secrecy keys group14` | **not personal** | The bulk of the graph by node count |
| 3 | Interface names, unit numbers | `reth0.0`, `st0.0`, `ge-0/0/0.0` | **not personal** | Vendor grammar. `21` §8.2.1 does not even pseudonymise these, correctly |
| 4 | Internal addressing | `10.1.0.0/16`, `10.255.0.1/30` | **usually not personal** | Becomes personal where a /32 is assigned to a named person's device, or where the estate is one person's |
| 5 | Peer public addresses | `IkeGateway.address 203.0.113.10` | **sometimes** | §2.4 |
| 6 | `dynamic hostname` peer identity | `site-b.example.net` | **sometimes** | A sole trader's domain is their name |
| 7 | **Device hostnames** | `srx-edge-lhr-01` (no) versus `laptop-j-okonkwo` (yes) | **sometimes, and it is the second most common accidental channel** | |
| 8 | **`description` and other free text on any node** | `"Circuit to Ward 4, ordered by Jane Okonkwo, BT ref …, contact 07700 900123"` | **routinely yes, and this is the number one channel** | Real interface descriptions carry names, phone numbers, ticket references and supplier contacts. This is not hypothetical; it is how descriptions are used |
| 9 | **`system login user` stanzas, if parsed** | `set system login user jokonkwo class super-user` | **yes** | A username is not a credential, so invariant 3 does not catch it, and the parser will happily ingest it. §2.5 |
| 10 | **SNMP contact and location** | `set snmp contact "Jane Okonkwo, +44 …"`, `set snmp location "Rack 4, Dr Rahman's clinic"` | **yes** | These fields exist to hold a person's name and number. That is their documented purpose |
| 11 | Syslog, TACACS and RADIUS server host entries | hostnames, addresses | **not usually** | The credentials are never ingested (invariant 3); the host references are |
| 12 | **Suppression `reason` text** | `"Waiting on Dave in the network team; peer is a customer-managed ASA"` | **yes** | And it is high-value: `31` §2.3 shows what a suppression discloses even without a name |
| 13 | **Provenance records** | who entered a value, when; `FormerName` on a renamed node | **yes** | Renaming a device to remove a person's name does **not** remove it from provenance. §7.2 |
| 14 | **Git commit author name and email** | in the customer's repository | **yes** | Standard, and not our doing, but it is in the same artifact |
| 15 | **Plaintext export header** | `exported 2026-07-28T09:14:02Z  by  j.okonkwo` (`17-workspace-format.md` §15.5) | **yes, and we put it there** | §2.5 proposes a default change |
| 16 | Sync account identifier | an email, if the customer's deployment uses one | **yes** | `33-sync-protocol.md` §3.2: accounts carry no name requirement, but customers will use emails |
| 17 | Member log entries and device public keys | Ed25519 keys, hash-chained | **yes, as pseudonymous identifiers** | They identify a person indirectly and durably. `32` D10 |
| 18 | Source IP at the sync service | in the access log | **yes**, and it is the metadata channel M7 | `31` §7.2 |
| 19 | Timestamps of every change (M4/M5) | upload times, therefore working hours | **yes, as data about identifiable employees** | An individual's working pattern relates to that individual. §9.4 |
| 20 | **Captures — raw pasted configuration** | the text as pasted | **inherits every row above** | `17` §4.5 treats captures as a different animal for good reasons; this is one more |
| 21 | **The AI egress log** | full literal request bodies at tier 1 (`21` §8.6) | **inherits rows 4–10, pseudonymised** | And it persists after the node is deleted. §7.5 |
| 22 | `reviewed_by` in the corpus | a named human reviewer on every entry (invariant 10) | **yes — ours, not the customer's** | We publish personal data about our own contributors, by design, in a public repository. §2.6 |

Rows 8, 9, 10, 12, 13 and 15 are the working list. Everything else is either not personal data or
is the customer's ordinary infrastructure metadata.

### 2.3 The shape of the problem

Personal data enters this product through **six channels, all of them free text or identity
fields, and none of them protocol fields**:

```
  free text on a node          →  descriptions, comments, notes
  identity stanzas in config   →  system login user, snmp contact, snmp location
  reasons written by humans    →  suppression reasons, export reasons
  provenance                   →  who did what, when; former names
  the surrounding tooling      →  git authors, account emails, export headers
  the operator's own logs      →  source IPs, timestamps, device counts
```

That is a useful finding, because it means the mitigation is narrow and specific rather than
architectural. We do not need to redesign the graph to keep people out of it. We need to be
careful about six things.

### 2.4 IP addresses, honestly

The reflex answer is "IP addresses are personal data", which is a misreading of *Breyer*
(C-582/14). The court held that a dynamic IP address is personal data **for a controller who has
the legal means reasonably likely to be used to identify the subscriber, for example by
approaching the ISP**. It is a relative test, not a blanket classification.

Applied here:

| Address | Personal data? |
|---|---|
| `10.1.0.0/16` — an internal prefix in a 40,000-user enterprise | Practically never. It relates to a network segment, not a person |
| `10.4.7.221/32` — a static assignment to a named engineer's workstation | Yes, in the hands of anyone who holds the assignment record, which is the customer |
| `203.0.113.10` — a peer's fixed public address at a partner company | Relates to an organisation. Personal only where the organisation is a person |
| A home worker's dynamic address in a `dynamic hostname` gateway | Personal for a controller who can reach the ISP |
| Source IPs in the sync service access log | **Yes, treat as personal.** They relate to identifiable employees at identifiable times and we hold them alongside an account |

The row that matters for us is the last one. **The operator's access log is more reliably personal
data than the workspace contents.** That inversion is worth stating in the review, because it
points the compliance effort at the metadata rather than at the ciphertext, which is where it
belongs anyway (§9.4).

### 2.5 What the design does about it

Four proposals, all cheap, three of which are corpus or configuration rather than code.

**RECOMMENDATION 1 — a `privacy.*` rule domain in the standard rule pack.** Findings are data,
not code (invariant 5), so this is a pack, not an engine change. Sketch, following the rule
schema in `63-rulepack-spec.md`:

```yaml
id: privacy.pii.free-text
severity: medium
applies_to: { kind: "*", field_class: FreeText }
platforms: ["*"]
versions: "*"
condition: "matches_personal_pattern(value)"
title: "A description field appears to contain a person's name or contact details"
why: >
  Descriptions are the main route by which personal data enters a network model.
  They travel with the workspace into git, into exports, into change tickets, and —
  at tier 1 — into a pre-flight payload where the free-text class is withheld only
  because a default says so.
symptom_if_mismatched: >
  A subject access request arrives and the only way to answer it is to read every
  description in the estate by hand.
remediation:
  junos-srx: 'set interfaces ge-0/0/0 unit 0 description "CKT-44812 — see CMDB"'
acceptable_when: >
  The name is a supplier's business contact recorded deliberately, your retention
  policy covers it, and it is inside your Article 30 record. Suppress with that
  reason and it stays visible to the next reviewer.
sources: ["docs/30-security/37-privacy-and-compliance.md §2.2"]
```

The detector is a pattern match, it will produce false positives, and `acceptable_when` is what
makes that survivable — a rule that flags every description as a privacy problem is muted within
a week (brief §5.2).

**RECOMMENDATION 2 — the parser must not silently ingest `system login user`.** A username is not
a credential, so invariant 3 does not stop it, and an implementer reading the invariants will find
no guidance. The parser should model login stanzas as an `Identity`-class field that is
`Withheld` by default at parse time, with the original never entering the graph unless the user
opts in per capture. The emitter then produces a placeholder in the same style as
`pre-shared-key ascii-text "<PSK>"`. §17.1 proposes this as an invariant rather than a
recommendation, because it is exactly the kind of thing that gets implemented the easy way once
and is expensive to unpick.

**RECOMMENDATION 3 — the export header's `by` field defaults to a workspace-local pseudonym.**
`17` §15.5 currently shows `exported 2026-07-28T09:14:02Z  by  j.okonkwo`. That is the right
field to have and the wrong default: it embeds a real identity in a plaintext artifact that
exists to be pasted into tickets. Default it to a stable per-workspace pseudonym, with the real
name a per-export opt-in and a one-line note saying which is being used.

**RECOMMENDATION 4 — `reviewed_by` accepts a stable handle.** Invariant 10 requires a named human
reviewer recorded in every corpus entry, and it is right to. It should not require a legal name in
a public repository. A stable handle plus an internal mapping satisfies the accountability purpose
without publishing a contributor's identity forever.

### 2.6 Special categories, and the one case where they appear

Article 9 special categories — health, biometrics, political opinion and the rest — do not appear
in a network configuration in the ordinary case. They can appear by accident in exactly one way:
**a description or a hostname that identifies a person by a sensitive attribute.** A device named
`srx-oncology-ward-4` is not special-category data. A description reading `"link to Dr Rahman's
clinic — patient records VLAN"` is closer to it than anybody intended.

The honest position: we do not build special-category handling, because a product that claims to
detect special-category data in free text and does not is worse than one that does not claim it.
The `privacy.pii.free-text` rule fires on the free text; classifying what is in it is the
customer's job and their DPO's.

---

## 3. Ciphertext, and the relative approach after *EDPS v SRB*

### 3.1 The question

If a server holds a sealed workspace and possesses no key and no means of obtaining one, is that
ciphertext personal data **in the hands of that server's operator**?

The question matters because if the answer is no, an operator holding only ciphertext is outside
much of the framework for that data, and if the answer is yes, they are a processor of personal
data with every obligation that follows.

### 3.2 What the court actually said

In Case C-413/23 P, *EDPS v SRB*, judgment of 4 September 2025, the Court of Justice addressed
pseudonymised comments transferred to a recipient. The Court confirmed that data that is
sufficiently strongly pseudonymised may constitute personal data for the original controller and
**not** for a recipient who cannot reverse the pseudonymisation and cannot identify the data
subjects by other means. Identifiability is assessed relative to the entity holding the data and
the means reasonably likely to be available to it — the relative approach, applied.

The judgment also held that the controller's obligation to inform about transfers is assessed
from the controller's perspective at the time of collection, which does not change here.

### 3.3 What we take from it, and what we do not

| Take | Do not take |
|---|---|
| The relative approach is confirmed at the highest level. The operator's own means are what count, and the operator's means are structurally nil (`32` §3: no key, no key-derivation material beyond a public salt) | That encrypted data is categorically not personal data. The case is about pseudonymisation, the analysis is fact-specific, and a court asked about a different construction may reason differently |
| It supports the transfer argument in §6.3, where the importer's inability to read is the whole point | That we can tell a customer their obligations disappear. The customer holds the key; for them it is unambiguously personal data |
| It supports a narrow DPA (§5) that describes what we actually do | That we should build the product's compliance story on a single judgment |

**The position we take, and it is deliberately conservative: we act as though the ciphertext is
personal data in our hands, and we say why the argument that it is not is available to the
customer's lawyer rather than making it ourselves.** The cost of being wrong in that direction is
a DPA we did not strictly need. The cost of being wrong in the other direction is a customer's
enforcement action.

<!-- VERIFY: track whether the EDPB issues guidance responding to C-413/23 P, and whether the
Digital Omnibus's proposed amendments to the definition of personal data change this analysis.
Both were live at the time of writing and either could move the answer. -->

---

## 4. Controller, processor, and the self-hosted case

### 4.1 The role matrix

| Shape | Controller | Processor | Sub-processor | What we sign |
|---|---|---|---|---|
| A — reference artifact | the customer, for their own use of it | none | none | nothing; a statement that we receive nothing |
| B — offline workspace | the customer | none | none | same |
| E — CLI | the customer | none | none | same |
| C/D — self-hosted | the customer | the customer's own hosting provider, if they use one — **their** sub-processor, not ours | n/a to us | a software licence and support terms |
| Hosted sync operated by us | the customer | **us** | our hosting provider, named | an Article 28 DPA (§5) |
| Tier 1 AI | the customer | **the inference provider**, engaged by the customer | theirs | nothing. We are not a party |

### 4.2 Self-hosting is not a way to make us a processor

Customers' procurement systems frequently ask for a DPA regardless of the shape, on the theory
that a DPA is free and covers the case where they are wrong. It is not free and it is not
harmless:

**We will not sign a DPA that describes processing that does not occur.** A DPA is a description
of an actual processing arrangement, it feeds the customer's Article 30 record, it names
sub-processors, it commits both parties to obligations, and one describing fictional processing
creates obligations neither party can perform and puts a false entry in the customer's own
records.

What we will sign instead, and it satisfies the same procurement gate: **a written statement that
in the named deployment shape the supplier receives, stores, transmits and processes no personal
data of the customer, that the software originates no connection the customer has not configured,
and that this is verifiable by the procedure in `36` §4.** That statement is stronger than a DPA
because it is checkable in five minutes.

### 4.3 Joint controllership does not arise

Article 26 joint controllership requires jointly determining purposes and means. We determine the
means of the software in the sense that any software supplier does; we determine no purpose, we
receive no data, and we make no decision about any individual. There is no shape in which joint
controllership is a sensible reading, and if a customer's template asserts it we will push back
rather than accept it for convenience.

### 4.4 Tier 1, and who is responsible for what leaves

At tier 1 the customer is the controller of what leaves and the inference provider is their
processor under their own contract. We are not in the chain. What we contribute is machinery that
makes the customer's decision informed and recorded:

| Mechanism | What it gives the controller |
|---|---|
| The pre-flight (`21` §8.3) | sight of the literal request body before the first send — the evidence that consent was informed |
| The purpose grant (`21` §8.4) | a scoped, expiring, per-workspace, per-purpose record of who authorised what, stored in the workspace so it travels with it |
| The redaction profile | a documented, versioned statement of what class of field is sent, pseudonymised or withheld |
| The egress log (`21` §8.6) | the full literal bodies, exportable as deterministic YAML — the closest thing to an Article 30 record of that processing that a client-side tool can produce |
| The armed indicator | it appears in every export and every change ticket, so a reviewer of a downstream artifact knows |

And the statement from `21` §8.7, which belongs here unchanged:

> We pseudonymise addresses and names. We withhold free text and raw captures by default. We show
> you the exact bytes before the first send and we keep every one of them in a log you own. None
> of that changes the fact that a third party receives a structured description of part of your
> network, holds it under their terms rather than ours, and may retain it for a period we cannot
> tell you.

---

## 5. The DPA we can honestly sign

Applies only to a sync service **we** operate. In every other shape, §4.2's statement is the
document.

### 5.1 Scope of processing

| Field | Value |
|---|---|
| Subject matter | storage and retrieval of sealed workspace frames |
| Duration | for the term, plus the stated deletion windows |
| Nature and purpose | availability of ciphertext to the controller's own clients; ordering authority for replay defence; an availability ACL; metering. That is the complete list of the four jobs in `33` §1.1 |
| Types of personal data | (a) **ciphertext of unknown content**, which the controller knows and we do not; (b) account identifiers; (c) device public keys; (d) source IP addresses; (e) timestamps, sizes and counters |
| Categories of data subject | the controller's personnel; and, to the extent the controller placed them in a workspace, third parties named in free text |
| Special categories | none knowingly; we cannot know, and the contract should say so in those words |

The "types of personal data" row is the unusual one and it is the row a lawyer should read twice:
we are asking to be a processor of a payload whose contents neither party can enumerate to the
other, because one party cannot read it and the other has not been asked. That is honest and it
is odd, and pretending otherwise by writing "network configuration data" in the box would be
worse.

### 5.2 Article 28(3), clause by clause

| Art 28(3) | Obligation | What we can honestly commit |
|---|---|---|
| (a) | process only on documented instructions, including as to transfers | **Yes.** The complete instruction set is: accept these frames, return these frames, delete on request. There is no further processing available to us |
| (b) | persons authorised to process are under confidentiality | **Yes**, and it is nearly vacuous — no person of ours can reach plaintext at any level of authorisation |
| (c) | take measures required by Article 32 | **Yes**, and the annex is `32-cryptography.md` rather than a generic list. Argon2id, ChaCha20-Poly1305, per-record derivation, key commitment, AEAD-authenticated headers, TLS 1.3, no key at the server |
| (d) | respect conditions for engaging another processor | **Yes.** One sub-processor: the hosting provider, named, with prior notice of change and a right to object |
| (e) | assist the controller in responding to data subject requests | **Mostly no, and this is the clause to rewrite.** §5.3 |
| (f) | assist with Articles 32 to 36 | **Yes for 32** (the specification is the assistance), **yes for 33** (we notify the controller without undue delay), **yes for 35** (a DPIA input pack: `31`, `32`, this document). **Partially for 34** — we cannot identify affected individuals, so the controller's Article 34 assessment is theirs |
| (g) | delete or return all personal data at the end of provision | **Yes — delete.** "Return" is close to meaningless here: the controller already holds every byte. The server copy is a replica, not the original, and the contract should say so rather than promising a return of data the controller never lost |
| (h) | make available information necessary to demonstrate compliance, and allow and contribute to audits | **Yes**, and better than most suppliers. §5.5 |

### 5.3 The replacement language for 28(3)(e)

Customer templates assume a processor that can search, extract, correct and delete an individual's
records on request. We cannot do any of those things. Proposed clause, offered as a redline rather
than as a refusal:

> The Processor holds only ciphertext for which it possesses no key and no means of decryption.
> The Processor cannot search, retrieve, rectify, restrict, export, or otherwise act upon any
> individual record within that ciphertext, and no instruction from the Controller can cause it to
> do so.
>
> The Processor's assistance under Article 28(3)(e) consists of:
> (i) deleting a workspace in full, on the Controller's instruction, within [n] days for live
> storage and within [m] days for backups, [m] being the backup rotation stated in Annex [x];
> (ii) providing the Controller, on request, with the complete list of metadata the Processor
> holds in relation to that workspace, as enumerated in Annex [y];
> (iii) confirming in writing that no other data relating to that workspace is held; and
> (iv) supporting the Controller's own key rotation, following which every copy of the prior
> ciphertext held by the Processor, including in backups, is undecryptable by any party.
>
> The Controller acknowledges that the Processor's inability to act upon individual records is a
> designed property of the service and not a limitation of effort, and that responsibility for
> responding to data subject requests in respect of workspace contents rests with the Controller,
> who holds the means of decryption.

Annexes [x] and [y] are real annexes with numbers in them, not "as reasonably determined by the
Processor".

### 5.4 Sub-processors

One, named: the hosting provider. Prior notice of any change, with a right to object and to
terminate. No analytics processor, no error-reporting processor, no CDN, no support-tooling
processor, no email marketing processor. `34` §8.3 fails the build if a third-party runtime origin
appears in the bundle, which makes this commitment testable rather than promised.

### 5.5 Audit rights under 28(3)(h)

Standard audit clauses assume an on-site inspection of an operator's controls. We offer something
that is cheaper for both parties and evidences more:

| Instead of | We offer |
|---|---|
| An on-site audit of our facilities | Run the service yourself from the published image, plant a canary, dump every table and log, and grep — `36` §3, Q12. Forty minutes, no access to us required |
| An attestation that we do not read your data | A capture of the wire and a dump of the store, taken by you |
| A key management questionnaire | `32` §3's key hierarchy, and the fact that no key exists at our end to manage |
| An attestation that our code matches our claims | Rebuild from the tag and compare hashes (`31` §5.3 check 4) |
| A pen test report | We do not have one (`36` Q55). This row is a gap and the clause should say so rather than substituting something else |

We will also accept a conventional audit clause with a reasonable-notice provision, because
sometimes a customer's framework requires the clause to exist. We would rather they exercised the
procedures above.

### 5.6 Clauses we will not accept

| Clause | Why |
|---|---|
| "Processor shall scan Customer Data for prohibited content" | Unperformable. We cannot read it, and building the capability would mean removing the property the customer bought |
| "Processor shall provide access to Customer Data for support purposes" | There is no such access and we will not create one (`36` Q53) |
| "Processor shall maintain the ability to restore individual records" | We can restore a workspace generation; we cannot address a record, because record boundaries are inside the ciphertext |
| "Processor shall retain Customer Data for [n] years" | We would rather delete. A retention obligation on ciphertext creates a cracking target with a contractual lifetime |
| "Processor shall decrypt Customer Data upon lawful request" | Impossible, and a clause we could never perform is worse than no clause |
| Any clause requiring us to notify the Controller of access to their data by our personnel | Vacuous — there is none — and signing a monitoring obligation we cannot perform is a lie in a contract |

---

## 6. Data residency and international transfers

### 6.1 What is where

| Shape | Ciphertext | Metadata | Anything readable |
|---|---|---|---|
| A, B, E | the endpoint's disk, and the customer's git repository | none | none |
| C, D | the customer's infrastructure, in the customer's chosen region | same | none, at our end |
| Hosted sync | the region selected at provisioning | same | none |
| Tier 1 | not applicable | not applicable | the pseudonymised projection, at the provider, in their region, under their terms |

**The interesting residency question is not the blob.** It is the metadata: the source IPs,
timestamps, sizes and device counts. Those are readable by whoever holds them, they are personal
data (§2.4), and their region is the one that matters.

### 6.2 Does exporting ciphertext count as a transfer?

For the exporter, in almost all readings, yes: a transfer of personal data is a transfer whether
or not the importer can read it, and Chapter V engages. *EDPS v SRB* (§3) affects the **importer's**
position, not the exporter's act.

So the practical answer is: run the Chapter V analysis, do not try to argue the transfer away, and
use the architecture to make the analysis easy rather than to avoid it.

### 6.3 The transfer impact assessment that actually works here

Post-*Schrems II* (C-311/18), a transfer under standard contractual clauses requires an assessment
of the destination's law and, where necessary, supplementary measures. The EDPB's Recommendations
01/2020 on supplementary measures identify scenarios where technical measures are effective —
including storage where the importer has no access to data in the clear, and transfers of
pseudonymised data — and scenarios where the Board found no effective measures exist, notably
cloud processing that requires access in the clear.
<!-- VERIFY: cite the exact use-case numbering from EDPB Recommendations 01/2020 v2.0 before
putting it in a customer-facing TIA. The substance is stable; the numbering should be quoted
correctly. -->

Our position sits squarely in the effective column, and the argument is unusually short:

| TIA question | Our answer |
|---|---|
| Can the importer access the data in the clear? | No, at any price. No key exists at the importer and none can be derived from what it holds (`32` §3) |
| Could the importer be compelled to provide access? | It can be compelled to provide the ciphertext. Compulsion cannot produce a key that does not exist |
| Is the measure contractual or technical? | Technical, and independently verifiable by the exporter in forty minutes (`36` Q12) |
| What remains exposed? | **The metadata.** M1–M10, in the clear, at the importer. This is the part of the transfer that a TIA should actually be about |
| Simpler alternative? | **Self-host in your own region.** There is then no transfer to assess and the whole section is moot |

**The honest framing to give a customer:** the supplementary-measures argument for the ciphertext
is as strong as this argument ever gets, and it is not the part of the transfer that should worry
them. The metadata is.

### 6.4 SCCs, UK and Switzerland

Where we operate sync and a transfer occurs: Commission Implementing Decision (EU) 2021/914,
Module Two (controller to processor), with the UK International Data Transfer Addendum for UK
transfers and the Swiss adaptations where relevant. The annexes are short because the processing
is short — §5.1's table populates Annex I, `32` populates Annex II, and the sub-processor list has
one entry.

### 6.5 The answer most customers should take

Self-host. Modes C and D put the ciphertext, the metadata and the operator in the customer's own
region under the customer's own control, and the entire transfer analysis collapses to zero. We
would rather sell that answer than a well-argued TIA.

---

## 7. Retention and erasure — the architecture's worst compliance fit

This section is the one to read if you only read one. Everything else in this document is a
reasonable answer. This is where the architecture is genuinely bad, and the badness is the direct
price of properties we chose deliberately.

### 7.1 The core difficulty

Three design decisions, each correct for its own reasons, combine into a system that resists
erasure:

| Decision | Where | Why it resists erasure |
|---|---|---|
| **Inventory as a document, not a database** (brief §6.4) | the workspace is a file the customer owns, git-versionable and diffable | there is no central store to delete from. There are as many copies as somebody made, and we cannot enumerate them |
| **Frames are an append-only set, not a sequence** (`17` §5.3) | sync and offline both | an edit adds a frame; it does not overwrite one. The prior value persists until a compaction removes it |
| **CRDT merge with tombstones** (`33` §5, §6) | multi-writer | a delete is a tombstone, which is a record that something existed. Tombstones must survive long enough for offline peers to converge |

Add git, which retains every historical version forever by design and cannot forget without a
history rewrite that does not reach clones, and the honest statement is:

> **There is no per-record erasure in this architecture that reaches every copy. There are three
> coarser operations, and the customer needs to know which one they are actually performing.**

### 7.2 The three operations that do exist

| Operation | What it removes | What it does not reach | Cost |
|---|---|---|---|
| **Overwrite the field** (edit the description; rename the device) | the current value | every prior frame until compaction; every git commit; every clone; every export already made; the egress log; **the provenance record and `FormerName`, which retain the old value on purpose** | free |
| **Compact** (`33` §9, client-driven because the server cannot decrypt) | superseded frames for the compacted records, in the copies that receive the compaction | clones and exports that already exist; git history unless rewritten; any client still offline holding old frames | a full rewrite of the compacted records; opposed to git-friendliness (`17` §13.6) |
| **Rotate the root key** (`32` §9.2) | the readability of **every** prior ciphertext everywhere, including backups and any server copy | nothing, if the goal is unreadability. Everything, if the goal is "that specific person's name is gone from the current workspace" — it is not a targeted operation | expensive: a full re-seal, and it invalidates every existing copy for legitimate holders too |

**RECOMMENDATION — `fathom redact`.** A single command that performs the honest composite and,
critically, *reports what it could not reach*:

```
$ fathom redact --node fathom:interface:01JZQ8… --field description \
                --reason "SAR 2026-114, name removed on instruction of the DPO"

  redacted   1 field on 1 node
  compacted  4 superseded frames for record dev-srx-edge-lhr-01.hot
  recorded   in the export log as a redaction, with your reason

  ▌ WHAT THIS DID NOT REACH                                    read this
    git history            12 commits contain the prior value. A rewrite will
                           not reach clones. Listed in redact-report.txt
    other clients          2 device ids have not compacted since 2026-06-04
    plaintext exports      3 recorded in the export log, destinations unknown
    the AI egress log      the prior value appears in 2 retained request bodies
    provenance             FormerName retains the prior value by design;
                           clear it with --clear-provenance and lose the audit
                           trail that made this redaction attributable
```

That output is the deliverable. A redaction command that reports success is lying; one that
enumerates the copies it cannot reach turns an impossible obligation into a documented,
proportionate effort, which is what Article 17(2) actually asks for when data has been made
public — reasonable steps, taking account of available technology and cost.

### 7.3 Deletion at the operator

Straightforward and small: `DELETE /v1/w/{wid}` (`33` §2.8) removes the server's copy. Live
storage immediately, backups on the stated rotation. That deletes a **replica**. The original is
on the customer's endpoints and in their repository, and saying so plainly prevents a customer
from believing that a deletion request to us discharged their obligation.

### 7.4 Crypto-erasure, and whether it counts

Rotating the root key renders every prior ciphertext undecryptable by anyone, including the
customer. Technically that is as complete as erasure gets — the data is not merely inaccessible,
it is gone in any operational sense, because the key material that could recover it no longer
exists.

Legally, it is contested. Regulators have been cautious about treating "rendered inaccessible by
destroying the key" as erasure rather than as a form of restriction, on the reasoning that the
ciphertext still exists and the analysis depends on assumptions about future cryptanalysis.
The EDPB's guidelines on blockchain technologies engage with the same question in a context where
deletion is structurally impossible, and the direction of travel there is that inaccessibility is
not automatically erasure.
<!-- VERIFY: quote the EDPB's position on key destruction as erasure from the final adopted text
of Guidelines 02/2025 on processing of personal data through blockchain technologies before
relying on it in a customer-facing document. Do not paraphrase it from a summary. -->

**The position we take:** crypto-erasure is offered, described accurately as "no party can decrypt
this any more, including you", and never described as erasure under Article 17 without the
customer's own counsel agreeing that it is. We will not settle a live legal question in a product
tooltip.

### 7.5 The retention trap nobody looks at

**The AI egress log.** `21` §8.6 retains the full literal request and response bodies by default,
capped at 25 MB per workspace, evicting oldest-first. That decision is right — a digest lets you
verify a body you already have, and does not let a reviewer see what left — and it creates a place
where projected graph data accumulates.

Its consequence is stated in `21` §8.6 and belongs here in bold: **a user who deletes a node does
not thereby delete it from the egress log.** The log is the only place in the product where
content persists after the graph has forgotten it, and it must appear in the customer's Article 30
record and in `fathom redact`'s report.

Second trap, smaller: **provenance and `FormerName`.** Stable opaque IDs (invariant 7) mean a
rename is not a diff and nothing is invalidated by it. The old name is retained as provenance so
that a reviewer six months later can understand the history. If the old name was a person's name,
renaming the device did not remove it.

### 7.6 What we can commit to

| Data | Retention | Where set |
|---|---|---|
| Workspace ciphertext at a sync service we operate | for the term; deleted within [n] days of instruction or termination; backups within the stated rotation | the DPA |
| Sync access logs, including source IPs | a stated number of days, short, and it should be short because §2.4 makes these the most reliably personal data we hold | the DPA and the operator's configuration |
| Metering counters | aggregate only, no per-request retention beyond the log window | the DPA |
| Workspace contents on the customer's endpoints | **the customer's, entirely.** We cannot set, enforce or observe it | the customer's own policy |
| The egress log | capped at 25 MB per workspace, evicting oldest-first with the eviction recorded; and the customer can clear it | `21` §8.6 |
| The export log | for the life of the workspace, deliberately — it is the record of what left | `17` §15.4 |

The fourth row is the honest centre of the section. **Storage limitation under Article 5(1)(e) is
a customer obligation in every shape of this product, and there is no configuration in which we
can help them meet it beyond giving them the tools to see what they hold.**

---

## 8. Data subject rights against ciphertext

### 8.1 Article 11, and who it helps

Article 11 provides that where the purposes of processing do not require identification of a data
subject, the controller is not obliged to maintain, acquire or process additional information in
order to identify them, and Articles 15 to 20 do not apply where the controller can demonstrate it
is not in a position to identify the data subject. Article 12(2) closes the loop: the controller
shall not refuse to act on a request unless it demonstrates it is not in a position to identify.

Applied honestly: **Article 11 helps us as a processor and does not help the customer as
controller.** We cannot identify anyone in a workspace because we cannot read it. The customer can
decrypt, so they can. A customer hoping that end-to-end encryption discharges their own data
subject obligations has misread the provision, and they should hear that from us before they hear
it from a regulator.

### 8.2 Right by right

| Right | Against a workspace the customer holds | Against a sync service we operate |
|---|---|---|
| **Art 15 access** | Feasible, and this is where the product is genuinely *better* than the alternative: the graph is typed and queryable, so "every field in the estate containing this string" is a query rather than a manual read of forty configs. `fathom grep --field-class FreeText` is a small feature with real compliance value | We hold ciphertext we cannot read, plus the metadata in §5.1. We respond with the metadata list and refer the request to the controller |
| **Art 16 rectification** | Edit the node. §7.2's caveats about prior frames, git and provenance apply | Not possible; not ours |
| **Art 17 erasure** | §7. The honest, difficult one | Delete the workspace in full. There is no partial deletion available to us |
| **Art 18 restriction** | **No mechanism exists today.** There is no way to mark a node as restricted from processing. §8.4 proposes one | Not possible; not ours |
| **Art 20 portability** | Strong. `fathom export` produces a deterministic, documented format with published test vectors. Portability is a property we get for free from `17` and invariant 9 | Not applicable — we hold nothing intelligible |
| **Art 21 objection** | Between the data subject and the controller | We do no processing on a legitimate-interests basis; there is nothing to object to |
| **Art 22 automated decisions** | None. Findings are advisory, every emitted line requires a human to paste it, and the AI layer's powers stop at proposing (`21` §2.2). No decision with legal or similarly significant effect on a person is produced anywhere in this product | Same |

### 8.3 The honest answer when a SAR arrives at us

> We hold a sealed workspace for your organisation. We possess no key, no key-derivation material
> beyond a public salt, and no means of decryption; we therefore cannot determine whether the
> workspace contains data relating to your data subject, and cannot search it. In relation to that
> workspace we hold the following metadata, in full: [the enumerated list]. We are deleting nothing
> and disclosing nothing without your instruction as controller. If the request concerns workspace
> contents, it is answerable only by you.

That paragraph is short because the situation is simple. Its usefulness comes from being written
in advance rather than improvised on day 29 of a 30-day clock.

### 8.4 RECOMMENDATION — a `restricted` marker for Article 18

There is no mechanism for restriction of processing and there should be a small one. A node-level
`restricted` marker that: blocks the node from emit; excludes it from every egress projection
regardless of tier or field policy; renders it in the UI with the reason; and appears in the diff.
It costs a boolean, a check in the emitter path next to the export gate (`31` §9.4), and a filter
in the broker. It is the only data subject right in the table with no answer at all, and the fix
is a day's work.

---

## 9. Personal data breach

### 9.1 What a breach is here

`36` Q64 gives the incident classes. Mapped to Article 4(12):

| Incident | Personal data breach? |
|---|---|
| Our release signing key is compromised | Not in itself. It becomes one if the resulting artifact exfiltrates data, and the customer will not know which of their users installed it |
| A sync service's store is dumped | **Yes** — for the metadata, unambiguously. For the ciphertext, see §9.3 |
| A rule pack is maliciously altered | Not a personal data breach. An integrity incident |
| A customer loses a laptop with a workspace on it | The customer's breach, and their assessment |
| A customer pastes a config containing personal data into a public ticket | The customer's breach, and the most likely one in practice |

### 9.2 Who notifies whom

| Shape | Who notifies the supervisory authority | Our obligation |
|---|---|---|
| A, B, C, D, E | the customer, as controller | none — we hold nothing. We will assist with facts about the software |
| Hosted sync operated by us | the customer, as controller, within 72 hours of becoming aware (Art 33(1)) | notify the controller **without undue delay** on becoming aware (Art 33(2)); the DPA states a number of hours rather than "promptly" |

### 9.3 The Article 34(3)(a) argument, and its limit

Article 34(3)(a) relieves the controller of the obligation to communicate a breach to data
subjects where it has implemented protection measures that render the personal data unintelligible
to any unauthorised person, encryption being the named example.

For a dump of a sync store, that argument is as strong as it ever gets: the blobs are AEAD-sealed
under keys derived from passphrases that never reached the server. **And it is not unconditional,
and the condition is not one we control.**

The condition is passphrase entropy. `31` §2.4 states it plainly: Argon2id multiplies an
attacker's per-guess cost by a constant, it does not add bits. A six-word EFF-wordlist passphrase
is roughly 77.5 bits; a memorable sentence with substitutions may be under 40, and a constant
factor does not rescue 40 bits against an unmetered, unlogged, parallel offline search.

So the honest statement, which we would rather a customer hear from us in a review than from their
regulator after an incident:

> **The Article 34(3)(a) argument is available to a controller whose users chose generated
> passphrases, and is not available to one whose users chose memorable ones. The controller cannot
> tell which without asking, and the product cannot tell them.**

That converts "use the generated passphrase" from a nag into a compliance control with a named
consequence, which is why the generated path is the default in the UI rather than the alternative.

### 9.4 The metadata breach nobody classifies

A dump of a sync store discloses the ciphertext **and** M1–M10. Even if the Article 34(3)(a)
argument holds for the blob, the metadata is in the clear and it is personal data: source IP
addresses, per-account timestamps, device counts, and change patterns from which working hours and
individual activity are derivable (§2.4, `31` §7.3).

**A store breach is therefore a personal data breach of the metadata regardless of how strong the
encryption argument is for the contents.** Most zero-knowledge suppliers do not say this. We say it
in the DPA, in the breach clause, and in this document, because a customer who has been told "it's
all encrypted, there's nothing to report" and later discovers otherwise will be right to be angry.

---

## 10. Cookies, ePrivacy, PECR

Short, because the answer is short.

| Question | Answer |
|---|---|
| Cookies | **None** in modes A, B and E. In modes C and D the sync auth token travels in a request header, not as an ambient cookie — chosen so CSRF against the sync API cannot exist (`31` §5.1 row 16), and it also removes the cookie question |
| Local storage / OPFS / IndexedDB | Used for the ciphertext working cache and for the workspace itself. Storage strictly necessary to provide the service the user explicitly requested, which is the ePrivacy Article 5(3) / PECR regulation 6 exemption |
| Consent banner | **None, and none is needed.** There is nothing to consent to |
| Analytics, session replay, fingerprinting, A/B testing | None, anywhere, at any tier. Invariant 1 forbids the mechanism and `34` §8.3 fails the build if a third-party runtime origin appears |
| Third-party fonts | None. Bundled (`34` §8.4) |
| Email tracking pixels in any communication we send | None |

The one thing worth saying beyond the table: the absence of a consent banner is not a compliance
shortcut, it is a consequence of there being no third party to share with and nothing to measure.
An auditor who expects to find a cookie policy should be given this section instead.

---

## 11. Export control and cryptography

### 11.1 Why this is a real question

The product ships strong cryptography, is distributed internationally, is intended for defence and
regulated customers, and will be downloaded by people in jurisdictions we do not choose. That is
the profile that makes export control a live question rather than a formality, and getting it
wrong is a criminal matter in several jurisdictions rather than a fine.

**This section is a briefing for counsel, not a determination.** Nothing here is a legal opinion
and every item is marked with what must be confirmed.

### 11.2 The United States

The relevant classifications are ECCN 5A002 (information security systems and equipment) and
5D002 (software therefor) under the Export Administration Regulations.

| Item | Position | Basis |
|---|---|---|
| **Publicly available source code** | Publicly available encryption source code classified under ECCN 5D002 **is not subject to the EAR** | 15 CFR §742.15(b)(1) |
| **Notification to BIS** | Required **only** where the publicly available source code provides or performs "non-standard cryptography", by email to the addresses in the regulation | 15 CFR §742.15(b)(2). The general notification requirement that formerly applied to all publicly available encryption source code was removed by a 2021 final rule |
| **Object code compiled from publicly available source** | Treated as not subject to the EAR where the corresponding source is publicly available and any required notification has been made | BIS guidance on encryption items not subject to the EAR <!-- VERIFY: confirm the exact regulatory basis and current wording with counsel; BIS guidance pages and the regulation should be read together, not one instead of the other --> |
| **A hosted service** | A different question entirely. §11.5 | |

### 11.3 Is our cryptography "standard"?

"Non-standard cryptography" in EAR Part 772 means an implementation involving proprietary or
unpublished cryptographic functionality, including algorithms or protocols not adopted or approved
by a recognised international standards body (the regulation names IEEE, IETF, ISO, ITU, ETSI,
3GPP, TIA and GSMA) **and** not otherwise published.

The inventory, against that definition:

| Primitive | Where it comes from | Standards body |
|---|---|---|
| Argon2id | RFC 9106 | IETF |
| ChaCha20-Poly1305 | RFC 8439 | IETF |
| HKDF | RFC 5869 | IETF |
| HPKE (`DHKEM(X25519, HKDF-SHA256)` / `HKDF-SHA256` / `ChaCha20Poly1305`) | RFC 9180 | IETF |
| X25519 | RFC 7748 | IETF |
| Ed25519 | RFC 8032 | IETF |
| BLAKE3 | published specification and reference implementation; **not** an RFC and not adopted by a named body | none — but published |
| The envelope construction: per-record salt → HKDF → subkey → zero nonce, plus a key-commitment tag | ours, and **fully specified in a public document** (`32` §5, §7) with published test vectors | none — but published |

Two rows need counsel. BLAKE3 and our own envelope construction are not standards-body outputs;
both are published, and the regulation's test appears conjunctive — *not adopted by a body* **and**
*not otherwise published*. A published-but-unstandardised construction plausibly falls outside
"non-standard cryptography" on that reading.

<!-- VERIFY: get a written view from export counsel on whether a fully published, non-proprietary
envelope construction and BLAKE3 fall inside or outside the Part 772 definition of "non-standard
cryptography", and therefore whether the §742.15(b)(2) notification is required. If in doubt,
notify — the notification is an email and costs nothing, and the downside of not notifying when
required is not symmetric. -->

**RECOMMENDATION —** notify anyway. The obligation, if it applies, is satisfied by an email
naming the repository URL. The cost of an unnecessary notification is zero; the cost of a required
one not sent is not.

### 11.4 The European Union

Regulation (EU) 2021/821 controls dual-use items, with cryptography in Annex I Category 5 Part 2.
The decontrols that matter for a project like this are the ones for software in the public domain
and the mass-market note, and their exact application to a publicly available source repository
plus published binaries needs counsel rather than a reading of a summary.

<!-- VERIFY: confirm with counsel the application of the General Software Note, the "in the public
domain" decontrol and the Cryptography Note in Annex I of Regulation (EU) 2021/821 to (a) a public
source repository, (b) published compiled binaries, and (c) a hosted service. Also confirm the
position in the UK's own post-Brexit dual-use regime and in any member state with a stricter
national rule. -->

Some jurisdictions operate additional national requirements for the supply of cryptographic means
— France has historically operated a declaration regime — and a small number operate import
licensing for cryptographic products.
<!-- VERIFY: before the first public release, get a current list of (a) countries with import
licensing for cryptographic software and (b) countries with a supplier declaration regime. Do not
publish a list from memory; users will rely on it. -->

### 11.5 Sanctions are a different regime

Export control asks *what* may be exported. Sanctions ask *to whom*. They are separate and a
clearance under one is not a clearance under the other.

| Activity | Regime |
|---|---|
| Publishing source code publicly | Export control. §11.2 |
| Publishing binaries publicly | Export control. §11.2 |
| **Operating a hosted service for a customer** | **Sanctions.** Providing a service to a sanctioned person or in an embargoed destination is prohibited regardless of the software's export status |
| Signing a contract with a customer | Sanctions and screening |

The practical consequence is narrow and we should implement it before the first hosted customer,
not after: any hosted sync service requires customer screening at onboarding. A public download
does not, and we will not geo-block a public source repository — it is ineffective, it punishes
the wrong people, and it is not what the regulation asks for.

### 11.6 What we will and will not do

| | |
|---|---|
| **Will** | Classify the software with counsel before the first public release; publish the classification in the repository; notify BIS if §11.3 resolves that way; screen customers for a hosted service; state the position in the release notes so a customer's own export officer has something to read |
| **Will not** | Geo-block the source repository; add a click-through export attestation that changes nobody's behaviour and exists only to shift liability — the same reasoning as `31` §9.2's refusal of an authorisation checkbox; weaken the cryptography to simplify a classification |

### 11.7 Before the first public release

| # | Action | Owner |
|---|---|---|
| 1 | Written classification of the source, the binaries and any hosted service under the EAR and Regulation (EU) 2021/821 | counsel |
| 2 | Resolve the "non-standard cryptography" question in §11.3 and notify if required | counsel |
| 3 | Publish the classification and the notification status in the repository | maintainer |
| 4 | Customer screening procedure for any hosted service | maintainer, before the first hosted customer |
| 5 | A short, accurate export note in the release notes | maintainer |

---

## 12. Sectoral frameworks

### 12.1 HIPAA — the uncomfortable one

A hospital's first question is whether they need a business associate agreement. The answer has
two halves and the second half surprises people.

**Half one: in modes A, B, C, D and E, no.** We receive, create, maintain and transmit nothing on
the covered entity's behalf. There is no disclosure to us, so there is no business associate
relationship and no BAA is required. Self-hosting is the clean answer and it is the one we lead
with.

**Half two: if the covered entity uses a sync service we operate, and a workspace contains ePHI,
then yes — and zero-knowledge does not save us.** HHS OCR's guidance on HIPAA and cloud computing
is explicit that a cloud service provider that maintains ePHI is a business associate **even if
the ePHI is encrypted and the provider does not hold the decryption key**, and that the conduit
exception does not apply, because that exception is limited to transmission services with only
transient storage incidental to transmission. Persistent storage of ePHI, on a no-view basis, is
still maintenance of ePHI.

So:

| Question | Answer |
|---|---|
| Does a network configuration contain ePHI? | Ordinarily no. It becomes ePHI if free text, hostnames or descriptions identify an individual in connection with their care — §2.6's `"link to Dr Rahman's clinic — patient records VLAN"` is the shape to watch |
| Would we sign a BAA for a hosted sync service? | Yes |
| What does the Security Rule allocation look like for no-view services? | It splits the way the architecture already splits it: access control and workforce management are the covered entity's, encryption of data at rest and in transit is ours. That alignment is convenient and it is not an accident — it is what a no-view service is |
| What is the better answer? | **Self-host.** Then there is no disclosure, no BAA, no allocation question, and the hospital's own controls are the whole control set |

We will not argue the conduit exception. It does not apply and pretending it might is exactly the
kind of thing that gets found in a review.

### 12.2 PCI DSS

We are not a service provider that stores, processes or transmits cardholder data. A network
configuration is not cardholder data, and invariant 3 means the product holds no credentials of
any kind.

Where the tool touches PCI is in the documentation requirements — network security control
documentation, and the requirement to maintain an accurate, current network diagram and data-flow
diagram of the cardholder data environment. **And there is an honest tension there** that a QSA
will find, so we should raise it first:

> The brief §6.5 scopes the diagram as **a design tool, not a source of truth**, precisely because
> documentation rots (brief §2.2 cites source-of-truth accuracy falling to roughly 15–30% without
> automated synchronisation). PCI's requirement is for a *current* diagram. A tool that explicitly
> declines to claim currency is not, on its own, evidence of a current diagram.

What partially bridges it, and should be said in the same breath: where the graph was populated by
parsing real configurations, those nodes are marked as parsed and **show their age**. A diagram
whose nodes were parsed from a capture taken 200 days ago is not current, and the product says
"200 days" rather than presenting it as fact. That is a better position for an assessor than an
undated diagram in a drawing tool, and it is still not a claim of currency. Say both halves.

### 12.3 DORA

Regulation (EU) 2022/2554 applies to financial entities in the EU and imposes contractual and
register requirements on ICT third-party service providers. Two questions arise and only the
second has a clean answer.

| Question | Position |
|---|---|
| Is a perpetual-licence, self-hosted, non-networked tool an "ICT service" bringing us within the third-party provisions? | **Needs counsel.** The definition is broad and drafted around ongoing service provision; a supplier of software the customer runs alone is at the edge of it <!-- VERIFY: get a view on whether supplying self-hosted software without an ongoing service constitutes an ICT service under DORA Article 3, and what that means for the Article 30 contractual requirements --> |
| If it is, can we populate a financial entity's register of information? | **Yes, and easily** — the entries are short because the arrangement is short. We will supply the fields rather than making the customer guess |

The useful thing to say to a bank: **a self-hosted, non-networked tool is the easiest possible
entry in a register of information.** There is no data flow to describe, no subcontracting chain,
no exit strategy problem — the exit strategy is "the workspace is a documented file you already
hold, and the CLI that reads it is open source" (`36` Q51) — and no concentration risk, because
nothing depends on our availability.

### 12.4 NIS2

Directive (EU) 2022/2555. Two angles:

| Angle | Position |
|---|---|
| Are we in scope as an entity? | In modes A–E we provide software and operate nothing, so ordinarily no. If we operate a hosted sync service, the managed-service categories in the directive's annexes need checking <!-- VERIFY: whether a hosted sync service of the shape in `33` falls within the ICT service management categories in NIS2 Annex I, and in which member states' transpositions --> |
| Does it affect our customers regarding us? | **Yes, and this is the practical angle.** Supply chain security obligations require in-scope entities to take account of the security of their suppliers and service providers. That means a covered customer must risk-manage us whether or not we are in scope, and what they need is evidence |

What to give them for that: the threat model, the cryptographic design, this document, the SBOM,
the signed releases, the vulnerability disclosure policy, the incident classes and — the one they
will not expect — the executable verification procedures in `36` §3 and §4, which let their own
team produce first-hand evidence rather than relying on our assertions.

### 12.5 SOC 2, ISO 27001

Covered in `36` §9. The short version: we hold none, the ask is usually a category error because
in four of five shapes we operate nothing, it is a fair ask for a hosted service, and if a customer
funds one we will do it and say exactly what it tested.

### 12.6 The EU AI Act

Regulation (EU) 2024/1689, as amended by the 2026 digital omnibus. Positioning, with the caveats
marked:

| Question | Position |
|---|---|
| Is the AI layer a high-risk system? | It does not map to an Annex III use case — network configuration assistance is not among them — and it is not a safety component of a regulated product |
| Do transparency obligations apply? | Article 50's transparency obligations concern systems intended to interact directly with natural persons. The supervisor does. **The product already exceeds the obligation**: invariant 9 requires anything non-deterministic to be quarantined behind the AI layer's boundary and labelled as such in the UI, and `21` §9.2 specifies that labelling. Complying here costs nothing because it was already the design |
| Are we the provider or the deployer? | **Needs counsel**, and it turns on tiers: at tier 1 the customer supplies the key and engages the model provider; at tier 2 the model runs on the user's machine; at tier 3 the operator provisions it. We ship a system that calls a model somebody else supplies |
| GPAI obligations | Fall on the provider of the general-purpose model, not on us. We ship no model |
| Timeline | High-risk obligations for stand-alone Annex III systems were deferred to 2 December 2027 by the digital omnibus agreed in 2026, with Article 50 transparency obligations applying from 2 August 2026 <!-- VERIFY: confirm the final Official Journal text and dates; the omnibus was adopted by Parliament and Council in June 2026 and OJ publication was expected shortly after --> |

The general point worth making to a customer: **the AI layer's compliance posture is dominated by
the fact that it is off by default and cannot emit configuration.** A system whose entire power is
propose / select / order / ask / abstain, whose output is always shown to a human before it becomes
anything, and which produces no decision with legal or similarly significant effect on a person, is
about as far from the regulated centre of the AI Act as a product with an AI feature gets.

### 12.7 The United Kingdom

UK GDPR and the Data Protection Act 2018 track the analysis above; the ICO is the supervisory
authority; the International Data Transfer Addendum applies to transfers (§6.4). One UK-specific
item belongs in a privacy document rather than only in a threat model: under Part III of the
Regulation of Investigatory Powers Act 2000, a notice under s.49 can require disclosure of a key or
a passphrase, and s.53 makes knowing failure to comply an offence. `31` §6.6 covers this as the
coercion case and states, correctly, that we will not ship deniable encryption in response to it.

---

## 13. Where compliance frameworks assume a model this architecture does not fit

This section exists because the honest failure mode of a review is not "we failed a control". It
is "the control assumed a shape we are not, and both sides spent three weeks discovering it".

Eight assumptions, each named, each with what we do instead.

| # | The assumption | Why it does not hold here | What we do instead |
|---|---|---|---|
| 1 | **There is a vendor who can see the data**, so controls are about restraining them: access approval, privileged access management, joiner-mover-leaver for staff with data access | There is no such vendor. Every question of the form "who at your company can access customer data, under what approval, with what logging" has the answer "nobody, structurally", which questionnaires read as a non-answer | We answer it as a structural property with a procedure the reviewer executes themselves (`36` §3), and we say in the comment column why the row is not applicable rather than leaving it blank |
| 2 | **The service is the system of record**, so retention, deletion and backup policy are the operator's to implement | The customer holds the original; the server holds a replica. Deleting our copy deletes nothing of consequence | §7.3 states which copy is which, and the retention table puts the obligation where it actually sits |
| 3 | **Access can be logged**, so "who read what" is an available control | No component can observe a read. A client decrypts locally, and in the common case reads a file without contacting anything | `36` §12: we say plainly that no read audit exists and cannot, and we substitute access-to-artifact control — who holds the file, who holds the passphrase, who is in the member log |
| 4 | **Data can be located**, so residency is a question about a region | Most copies are on endpoints, in git repositories and in tickets. The region of the server copy is the least interesting answer available | We enumerate every copy (`36` Q1) so the customer can see that residency is a smaller question than they thought and endpoint control is a bigger one |
| 5 | **Encryption is a control the operator applies**, so a key management questionnaire follows: rotation policy, HSM, split knowledge, key custodians | The operator applies no encryption and holds no key. "Describe your key rotation policy" has no operator-side answer at all | We answer with the key hierarchy (`32` §3) and the fact that rotation is a **customer** action (`32` §9), and we point out that the questionnaire's own control objective is met more completely than it asks |
| 6 | **A processor can assist with data subject rights**, so Article 28(3)(e) is boilerplate | We cannot search ciphertext. The clause as normally drafted is unperformable | §5.3's replacement language, offered as a redline with the four things we actually can do |
| 7 | **A certification attests to a product**, so SOC 2 is a proxy for product security | SOC 2 attests to a service organisation's controls over a system it operates. In four of five shapes we operate nothing | `36` §9, and the offer to spend the same money on a funded independent rebuild and a published pen test instead |
| 8 | **Compliance evidence is documentary** — policies, attestations, questionnaires | Our strongest evidence is executable: rebuild the artifact, dump the database, capture the traffic, read the WASM import section | We ship the procedures rather than only the assertions, and we would rather a reviewer ran one than read three |

**The meta-point, and the one to make early in a review:** none of the eight is a failure of the
framework and none is a failure of the architecture. They are a mismatch between a framework built
for services that hold customer data and a product built so that nobody holds it. The mismatch is
resolvable in every case, and it is resolvable much faster if it is named on day one rather than
discovered on day twenty.

---

## 14. What CI and the product enforce

A compliance document that is not tested is a document. These are the checks that make specific
sections above fail a build rather than age quietly. They extend `31` §12 rather than replacing it.

| Check | Enforces | Fails when |
|---|---|---|
| No cookie is ever set in any built artifact | §10 | any `Set-Cookie` appears in a served response, or `document.cookie` is written |
| No third-party runtime origin in the bundle | §10, `34` §8.3 | any external host appears in the bundle or in a policy |
| The `privacy.*` rule domain exists and every rule in it has a non-empty `acceptable_when` | §2.5, invariant 8 | a `privacy.*` rule omits it |
| The parser does not emit an `Identity`-class value into the graph unless the capture opted in | §2.5 RECOMMENDATION 2 | a fixture config containing `set system login user …` produces a graph node carrying the username |
| Export header default is a pseudonym | §2.5 RECOMMENDATION 3 | the default export path writes a real identity into the header |
| Redaction reports its own gaps | §7.2 | `fathom redact` exits successfully without listing git commits, un-compacted peers, prior exports and egress-log occurrences |
| Deleted-node canary after compaction | §7.2 | a value deleted and compacted still appears in the compacted record set |
| Egress-log persistence is documented | §7.5 | the product documentation does not state that deleting a node does not delete it from the egress log |
| DPA annexes match the code | §5.1 | the metadata list in the DPA annex differs from the fields the sync service actually stores. This is a real check: generate the annex from the schema |
| Export-control note present in the release | §11.7 | a release is tagged without the classification note |

The DPA-annex check is the one that looks like bureaucracy and is not. A processor's Annex I that
drifts from what the service actually stores is the single most common way a supplier's contract
becomes untrue without anyone noticing.

---

## 15. Residual risk register

Ranked by what deserves attention next, using `31` §1.4's four-value scale.

| # | Residual | Tag | Accepted because | Revisit when |
|---|---|---|---|---|
| P1 | **No per-record erasure reaches every copy.** Git history, clones, prior exports and un-compacted peers persist | `material` | The document-not-database decision (brief §6.4) is right at team scale, and the alternative is a central store that can read your estate | If a customer's erasure obligation becomes a purchase blocker, or when `fathom redact` ships and the gap report shows what customers actually face |
| P2 | **Free text is the main personal-data channel and the detector is a pattern match** | `material` | A rule with `acceptable_when` is the correct shape; the alternative is either nothing or a model at runtime, and the second breaks invariant 9 | If false positives cause the `privacy.*` domain to be suppressed wholesale — that is the signal the rule is wrong, not that users are careless |
| P3 | **Provenance and `FormerName` retain values a user believes they removed** | `material` | Provenance is load-bearing for review and for the parsed-versus-drawn distinction (brief §6.5) | Now, in the sense that `fathom redact` must report it and the UI must say it at rename time |
| P4 | **The AI egress log outlives the graph** | `material` | `21` §8.6's decision to retain literal bodies is right; a digest is not an audit | If the 25 MB cap proves to be the wrong shape — a time-based cap may serve retention better than a size-based one |
| P5 | **Metadata is personal data and survives every mitigation but "do not sync"** | `material` | `31` §7.7. Only the offline shapes remove M1 | If a customer's requirement makes M1 disqualifying — the answer is mode B or E, not a feature |
| P6 | **Crypto-erasure's legal status is unsettled** | `bounded` | We describe it accurately and do not call it erasure | When the EDPB position on key destruction is settled |
| P7 | **Export classification is not yet done** | `material` | The project has not shipped | **Before the first public release.** §11.7 |
| P8 | **No Article 18 restriction mechanism exists** | `bounded` | Nobody has asked yet, and the fix is a day | §8.4. Build it before a customer asks, not after |
| P9 | **We cannot enumerate special-category data and do not claim to** | `bounded` | A claim we cannot meet is worse than no claim | Never — this is the model |

---

## 16. Sources

| Claim | Source |
|---|---|
| Personal data definition; identifiability by all means reasonably likely to be used | GDPR Article 4(1); Recital 26 |
| Pseudonymisation definition | GDPR Article 4(5) |
| Controller and processor definitions; joint controllers | GDPR Articles 4(7), 4(8), 26 |
| Processor obligations, clause by clause | GDPR Article 28(3)(a)–(h) |
| Processor and sub-processor obligations, controller's continuing responsibility | EDPB Opinion 22/2024 |
| Security of processing; encryption and pseudonymisation as measures | GDPR Article 32(1)(a) |
| Breach notification: 72 hours to the supervisory authority; processor to controller without undue delay; the unintelligibility exemption from communication to data subjects | GDPR Articles 33(1), 33(2), 34(3)(a) |
| Processing not requiring identification; refusal to act only where identification is impossible | GDPR Articles 11, 12(2) |
| Data subject rights | GDPR Articles 15–22 |
| Storage limitation | GDPR Article 5(1)(e) |
| International transfers; standard contractual clauses | GDPR Chapter V; Commission Implementing Decision (EU) 2021/914 |
| Supplementary measures for transfers; scenarios where technical measures are effective | EDPB Recommendations 01/2020 <!-- VERIFY exact use-case numbering --> |
| Invalidation of the Privacy Shield and the requirement to assess destination law | CJEU C-311/18 (*Schrems II*) |
| A dynamic IP address is personal data for a controller with legal means reasonably likely to be used to identify the subscriber | CJEU C-582/14 (*Breyer*) |
| Strongly pseudonymised data may be personal data for the controller and not for a recipient who cannot re-identify; identifiability assessed relative to the holder | CJEU C-413/23 P (*EDPS v SRB*), judgment of 4 September 2025 |
| A cloud service provider that maintains ePHI is a business associate even where the ePHI is encrypted and it holds no key; the conduit exception does not apply to persistent storage | HHS OCR, *Guidance on HIPAA and Cloud Computing* (2016) |
| Publicly available encryption source code under ECCN 5D002 is not subject to the EAR; notification is required only for non-standard cryptography | 15 CFR §742.15(b)(1), §742.15(b)(2) |
| Definition of "non-standard cryptography" | 15 CFR Part 772 |
| EU dual-use controls, Category 5 Part 2 | Regulation (EU) 2021/821 <!-- VERIFY application of the decontrol notes --> |
| Digital operational resilience; ICT third-party risk; register of information | Regulation (EU) 2022/2554 (DORA) |
| Cybersecurity measures including supply chain security | Directive (EU) 2022/2555 (NIS2) |
| AI Act obligations and the 2026 deferral of high-risk timelines; Article 50 transparency from 2 August 2026 | Regulation (EU) 2024/1689 as amended by the 2026 digital omnibus <!-- VERIFY final OJ text --> |
| UK compelled disclosure of a key or passphrase | Regulation of Investigatory Powers Act 2000, Part III, ss.49 and 53 |
| Argon2id parameters and the entropy argument; Padmé padding; metadata channels M1–M10 | `31-threat-model.md` §2.4, §7; RFC 9106; Nikitin et al., PoPETs 2019(4) |
| Key hierarchy, rotation, revocation, recovery, the envelope construction and its test vectors | `32-cryptography.md` §3, §7, §9, §16 |
| The server's four jobs, six prohibitions and nine endpoints; compaction being client-driven | `33-sync-protocol.md` §1, §2, §9 |
| CSP per mode; no third-party runtime code; the clipboard header | `34-browser-hardening.md` §2, §6, §8 |
| AI tiers; the egress envelope and field classification; pseudonymisation into `100.64.0.0/10`; the pre-flight; purpose grants; the egress log retaining literal bodies | `21-ai-layer-architecture.md` §7, §8 |
| Frames as an append-only set; export log and export headers; version pins; the AI audit log | `17-workspace-format.md` §5, §8, §11, §15 |
| Source-of-truth accuracy falling to roughly 15–30% without automated synchronisation | Owner brief §2.2 |
| The diagram is a design tool, not a source of truth; parsed nodes are marked and show their age | Owner brief §6.5 |
| SNMP contact and location, interface descriptions, and login stanzas as the personal-data channels in real configurations | Junos configuration practice; the field card's own examples use `203.0.113.10`, `10.1.0.0/16` and `GW-B` precisely so that documentation never needs a real one |

Claims not sourced above are design positions of this project and are argued in place.

---

## 17. Disagreements

Two, raised under the conventions' own procedure rather than acted on unilaterally.

### 17.1 Invariant 3 covers credentials and says nothing about identities

**The convention.** *"The application never accepts a credential. No PSKs, no certificates with
private keys, no SNMP communities, no TACACS keys, no device passwords. Emitted config uses
placeholders."*

**The objection.** Invariant 3 is the best security decision in the design and it stops at exactly
the wrong place for this document. A **username** is not a credential. `set system login user
jokonkwo class super-user` contains no secret, so nothing in the invariants prevents the parser
from ingesting it, modelling it, syncing it, exporting it and — with the field policy set
permissively — projecting it at tier 1. The same applies to `set snmp contact "Jane Okonkwo, +44
…"` and to every interface description in a real estate.

An implementer reading the invariants will look for guidance in exactly this neighbourhood and
find none, will implement the easy thing once, and it will be expensive to unpick — which is the
same argument the brief makes for emitters returning `(line, provenance)` pairs on day one.

**Proposed addition**, as a new invariant rather than an amendment to 3, because they are different
properties:

> **11. Identities are ingested deliberately, never incidentally.** Values that identify a natural
> person — login usernames, SNMP contact and location, and any field the schema classes as free
> text — are `Withheld` at parse time by default and enter the graph only on an explicit per-capture
> opt-in. Emitted configuration uses a placeholder in the same style as `<PSK>`. This is a privacy
> invariant, not a security one: the value is not a secret, and that is precisely why nothing else
> in this list catches it.

### 17.2 The conventions need a field-class enum, or two documents will invent different ones

**The convention.** The conventions pin terminology, the three-value `Risk` enum, identifier
formats and the hard invariants. They pin no classification for **graph fields**.

**The objection.** Two documents already need one and they need the same one.
`21-ai-layer-architecture.md` §8.2 classifies fields as Structural, Crypto parameters, Topology
addresses, Names, Free text, Secret placeholders, Capture text and Provenance detail, and drives
the redaction profile from it. This document's §2.2 needs exactly that classification to say which
fields can carry personal data, §2.5's proposed rule matches on `field_class: FreeText`, and
§17.1's proposed invariant is written in terms of it. `31` §1.4 already had to invent a residual
scale for the same reason and flagged the same risk.

If the redaction profile's classes and the privacy inventory's classes drift apart, then a field
that the privacy document calls free text and the AI document calls structural will be sent when
the customer believed it was withheld. That is not a documentation inconsistency; it is a
disclosure.

**Proposed addition to `conventions.md`,** under a new heading, pinning the eight classes above as
the single field classification used by the schema, the redaction profile, the rule engine's
`applies_to` predicate and the privacy inventory, with the note that a field's class is part of the
schema and changing it is a schema change requiring a version bump. If a different set of classes
is preferred, that is fine; what matters is that one set is pinned before a third document needs
it.
