# 49 — The server product

> **Status:** Proposed · **Opened 2026-08-21.** Nothing here is built. This is the plan for the
> product the owner decided on 2026-08-18: a server-hosted, multi-tenant, live-collaborative
> Fathom, with the single offline HTML file dropped.
>
> **`48` (the server fork) is the parent and predates this by three days.** `48` asked what a
> fork would look like; this answers it with research. Where the two disagree, this one is
> newer and says so in §19. Neither is ratified.
>
> Written from six research threads run 2026-08-21. Two of them — the secrets thread and the
> firmware thread — were independently reviewed by a second session, and the reviewer's
> corrections are carried in the text rather than hidden in a footnote. **Every claim about a
> vendor, a protocol, a library version or a security practice in this document was looked up
> on 2026-08-21 and is cited with its date, per ADR-0034. Everything that could not be
> established is named in §21, and that list is part of the answer.**
>
> **ADDENDUM 2026-08-28:** §19's phase 0 is no longer unbuilt — its four CODED items
> landed 2026-08-21 (secret-length leak closed; author + sequence on every op; the paste
> product record with drift detection; the additive paste behind `ERR_PASTE_CHOICE`), and
> the 900,000-byte ceiling §1 retires was actually removed the same day. The two DECISION
> items in phase 0 — open decisions 1 and 2 — remain the owner's and remain open. Nothing
> server-side exists yet.

## Contents

| § | |
|---|---|
| 1 | The pivot, in four decisions — and what it retires |
| 2 | **The secrets answer: no, it is not an unreasonable ask** |
| 3 | The recommended security design, in five decisions |
| 4 | What it protects against, and what it does not |
| 5 | Architecture: what lives where |
| 6 | Technology choices, and the dependency gate |
| 7 | Storing a typed graph in a database |
| 8 | Drawing thousands of devices — the layout crate is cubic and I measured it |
| 9 | Live editing: build Figma's model, not Lucid's |
| 10 | The journal is an accidental advantage with three defects |
| 11 | Multi-tenancy: making isolation structural, not remembered |
| 12 | Accounts, sessions, and sign-in |
| 13 | Logging and auditing — three different logs |
| 14 | The look: Termix and Zerobyte, reconciled with `51` |
| 15 | The gestures: the Lucidchart study, reconciled with `56` and ADR-0035 |
| 16 | Firmware distribution — **and the login model, decided** |
| 17 | Firmware in the inventory |
| 18 | What carries over, what is retired |
| 19 | The phases, and what each of his named features lands in |
| 20 | What this plan cuts, and why |
| 21 | What could not be established |
| 22 | Open decisions — the owner's |
| — | Failure modes · Sources consulted · Disagreements |

---

## 1. The pivot, in four decisions — and what it retires

The owner, 2026-08-18, taking four decisions explicitly. **None of them is reopened here.**

1. **The data lives on the server.** The browser becomes a window onto server-held data,
   Lucidchart-style. Not a sync model — the server is the source of truth.
2. **Live multi-user editing.** Two people open the same design and see each other work.
3. **Multi-tenant.** Separate organisations that must never see each other's data.
4. **Thousands of devices per design.** Not tens, not hundreds.

And the fifth thing, which is a consequence rather than a decision: **the single offline HTML
file is dropped entirely.** There is no local-only mode to preserve.

**What that retires, immediately and for good:**

| retired | why it mattered |
|---|---|
| the 900,000-byte WebAssembly ceiling (`44` §5.2) | it has decided what ships for months; it was a browser-module constraint and a native binary has none |
| `47`'s three unproven byte levers as the project's top priority | they were the only route out of a ceiling that no longer exists |
| `47` §11's refusal of the config view | linking `fathom-emit` cost 93,838 bytes minimum; that objection is void |
| `57` §14.1's whole "pile C" — every feature blocked on bytes | `OP_CABLE`, unmount, move, `DhcpRelay`, the `Surface` kind, and every future schema kind |
| `33` §9, "Compaction, which the server cannot do" | the server can now do it, at 3 a.m. |
| `fathom-artifact` (the HTML assembler) | there is no single file to assemble |

**One thing the pivot does *not* retire, and the plan very nearly lost it.** The pivot's own
framing says it retires `fathom-wasm` as well, on the grounds that it is "an opcode shell".
`fathom-wasm` is the only thing that puts the redaction gate — the code that destroys
passwords — inside the browser. Retire it and the gate has no vehicle, and the default
outcome is a *second* implementation of the gate written in JavaScript, maintained by one
person, guaranteed to drift, with the browser copy being the one that actually decides whether
a password crosses the wire. **That is the worst outcome available anywhere in this plan.**

> **DECISION: `fathom-wasm` is not retired. It is re-scoped, from "the whole product" to "the
> ingest gate and nothing else".** It becomes a small, bounded WebAssembly module whose only
> job is to take pasted text and hand back redacted text. Everything else in it moves to the
> server. See §3 decision 1 and §18.

## 2. The secrets answer: no, it is not an unreasonable ask

He asked:

> *"i would say best practice, i would like it to be overtly secure but from the sound of it
> this is an unreasonable ask? But i would still like something if at all possible."*

**No. It is not unreasonable, and you are already most of the way there — from a direction
almost nobody else in your industry can take.**

Here is the honest shape of it, and it turns on one distinction that must not be blurred.
**There are two different things in a network config that can hurt you, and they need two
different answers.**

| the thing at risk | what protects it | cost | status today |
|---|---|---|---|
| **a working password** — a pre-shared key, a RADIUS secret, an SNMP community | **destroy it before it is stored.** The ingest gate. | nearly free; already built | `crates/fathom-ingest/src/redact.rs`, shipping |
| **the map** — the addressing, the zones, the tunnel endpoints, the half the parser did not understand | **encrypt it so the server has no key.** | very expensive, permanent, deletes features you have asked for | designed in `32`/`33`, not built, and designed for a different architecture |

**The passwords you can protect perfectly, because Fathom never needs them.** Almost every
"we hold your device credentials safely" problem in this industry exists because the tool has
to log into the box. Fathom never logs into anything and never will (invariant 2). So the
strongest position available to it is not clever cryptography — it is **not having the thing**.

That position is cheap, permanent, unbreakable by a bug, and 80% built. And it is not an
eccentric choice. **NetBox — the closest thing to a competitor you have — built a secrets
store and then deleted it.** Its v3.0 release notes (released 2021-08-30, read 2026-08-21) say:
*"The secrets functionality present in prior releases of NetBox has been removed. The NetBox
maintainers strongly recommend the adoption of Hashicorp Vault in place of this feature."*
Nautobot, the fork, never built one — its Secret model *"does not store the secret value
itself, but instead defines how Nautobot can retrieve the secret value as and when it is
needed."* Vault itself, the thing they both point at, describes its transit engine as
*"encryption as a service"* that *"does not store the data."* **Every product in this space
that could stop holding secrets, did. Fathom made that choice before it was asked.**

**The rest of the config is where the honest limit is.** The addressing plan, the zone pairs,
the VPN peers, and the roughly half of a pasted config the parser does not yet understand —
that is the actual map of a customer's network, and to an attacker it is worth more than the
passwords. `38` §14.4 already measured it and put it in one line: *"the secrets are 2% of the
file. The other 98% is the network."*

You can protect that too, by encrypting it in the browser so the server holds nothing it can
read. **That works — it is shipping software, not theory.** CryptPad is a full collaborative
office suite where *"the server has no access to your data"* (docs.cryptpad.org, docs build
2026.5.0, read 2026-08-21). But it costs four things, permanently:

1. **No server-side search.** Proton state it plainly for their own mail: *"we cannot decrypt
   your emails, which means we cannot search their content"* (proton.me engineering blog,
   2022-08-31). Search moves into the browser, with a size limit the user can see.
2. **No server-side drawing, exporting or thumbnails.** The server cannot draw a picture of a
   thing it cannot read.
3. **No account recovery by you.** Bitwarden cannot recover a lost master password, for the
   same reason.
4. **Every "just add it on the server" request for the next ten years has to be refused**, and
   adding it later means re-encrypting everything you already hold.

**And one more that is specific to Fathom and easy to miss: a blind server cannot validate.**
The crown jewel of this project is a typed, schema-checked graph. A server holding only
ciphertext cannot run the schema check, cannot enforce cardinality, cannot compute layout,
cannot run the findings engine, cannot answer *"which /24 holds 10.4.7.19"*. All of that moves
into the browser — the same browser that would also hold the search index.

**What I would do:** take the free win now, and set up so the expensive one stays available.
That is §3.

**And the one line that should never be softened, because it is the thing you can say that
almost nobody in your field can:**

> **Fathom never touches your devices, and it destroys every password before it stores
> anything. There is no credential to steal.**

With one honesty caveat attached, in §3 decision 2b: **that sentence is fully earned on
Juniper and materially weaker on the other platforms today.**

## 3. The recommended security design, in five decisions

**Decision 1 — the redaction gate runs in the browser, and stays there forever. Do this
first; it is nearly free.**

The paste box lives in the client. `fathom-ingest` already compiles to WebAssembly and is
already linked into `fathom-wasm` today, so the gate already runs in a tab. The user pastes,
the gate runs in the tab, and **only post-gate material is ever uploaded.** The password never
reaches the wire, so it never lands in a reverse-proxy buffer, a temporary file, a core dump,
a crash message or a backup on a machine the customer does not own. `38` §14.3's whole
eleven-mechanism checklist stops applying to passwords, because there is no moment at which a
password exists on the server.

**Then run the gate again on the server on everything that arrives** — as well, never instead.
`38` §14 proposed a durable rule and it is still unratified; ratify it as part of this work:

> **Nothing arriving after the build may reduce what the ingest gate destroys, only increase
> it. Union, never replace.**

On a shared server that rule is what stops a stale or hostile client writing a password into
storage everybody else's data sits next to.

**Decision 2 — the gate records *properties* of a secret, never the value; and its coverage
becomes a gate on which platforms you may offer.**

*(a)* At the moment of destruction, record coarse, one-way facts: *matches a known vendor
default*, *plain-text authentication in use*, *these two gateways share a pre-shared key
within this paste*, *the key is in the short bucket*. Never the value. **Never an exact
length** — `38` §14.9 records a live open defect where the redaction stage publishes the exact
byte length of every secret it destroys, and fifty lines away in the same file the sibling
field carries the comment *"for the in-session report only; the persistence layer must not
store it."* On one operator's laptop that is a bad day. In a multi-tenant database it is the
exact length of every pre-shared key in every customer's estate, readable by anyone with
database access. **Fix it before the first config reaches a server**, and on the server make
that comment a type the persistence layer cannot misuse.

This turns the gate from a pure loss into a source of findings — and gives the empty findings
view something true to say on day one.

*(b)* **The coverage caveat, which the review found and which matters.** `corpus/dict/` has
dictionaries for **junos-srx (ten files) and opnsense (one, firewall rules only)**.
`schema/platforms.yaml` registers ten platforms. **On seven of them there is no dictionary at
all**, which means no declared secret paths, which means the strong detector does not exist and
only the thirty-word secret-word list and a base64 heuristic remain. Concretely: FortiOS's
pre-shared key keyword is `set psksecret` (Fortinet Document Library, FortiOS 6.2.0 and 8.0.0,
read 2026-08-21). `fortios` is a registered platform. `psksecret` is one lowercase run-together
word, and the word-list matcher splits on `-` `.` `_` and camelCase boundaries — **so nothing
reaches it.** That is the same single-detector condition `38` §14.9 already condemned for one
Junos statement, standing as the normal case for seven vendors.

> **RULE: a platform does not become selectable in a hosted, multi-tenant Fathom until its
> declared secrets have been enumerated from vendor documentation and its run-together
> keywords added. That check belongs in CI, not in a reviewer's head.**

And CLAUDE.md rule 0 binds every test written for it: **a safety gate is tested against what a
device accepts, never against what the detector needs.**

**Decision 3 — every tenant gets its own key, and every design its own data key, from the
first line of server code — whoever holds the keys.**

Do this even if you start with the server holding them, because retrofitting a key boundary
means re-encrypting everything you already have. Three things fall straight out of it:

- A bug in a `WHERE tenant_id = ?` clause cannot become a cross-tenant breach, because the
  wrong rows will not decrypt.
- **Deleting a tenant becomes destroying a key**, which is the only honest answer to *"deleted
  server side securely"* — backups, ZFS snapshots and SSD wear-levelling all keep copies that
  no `DELETE` reaches. NIST recognises this as **Cryptographic Erase**, a valid *Purge* method
  (**SP 800-88 Rev. 2, final 2025-09-26** — note Rev. 1 of December 2014 is superseded and
  should not be cited).
- Moving later to browser-held keys becomes a change of key custody rather than a data
  migration.

One caution the review added: **do not let "crypto-shredding" cover two different deletions.**
Destroying a tenant is one key and is genuinely cheap. Removing one *person* from a design is
not shredding at all — it is a full re-encryption of everything they could read. `33` §3.6
prices that at 500 devices as an 80 MB rewrite of 2,100 records; at the pivot's stated
thousands of devices it is closer to 800 MB per removal per design.

**Decision 4 — decide invariant 4 deliberately, as a written ADR, before the server holds its
first byte.**

Invariant 4 today reads: *"The server never holds secret key material. Zero-knowledge.
Ciphertext, public keys and metadata only."* Live editing, server-side prefix search, and
permission checks all require the server to read. **Invariant 4 and the four pivot decisions
are in direct collision right now**, and the whole of §5 through §13 of this document assumes
it is amended for the hosted product.

Two legitimate answers:

- **Keep it (the strong product).** The browser encrypts before upload; the server holds
  ciphertext. This is the only version that can honestly say *"we cannot read your network"* —
  a sentence worth more to a network engineer selling this at work than any feature on the
  roadmap. It costs the four things in §2 plus the validation loss, and it makes the sync
  protocol a hand-built problem (see §9's caveat).
- **Amend it (the fast product).** Server-held per-tenant keys, ordinary access checks,
  envelope encryption. Much cheaper to build, much more expensive to *say*, and it buys no
  confidentiality against a bug, an operator, a hosting provider or a subpoena.

**Recommended: stage it.** Ship with server-held keys **only if you say so plainly** — and
never use the words "zero-knowledge", "end-to-end" or "we cannot read your data" until they
are true. Build the key boundary so the switch is a custody change. And set the trigger for
the switch in advance: **the first customer who is not you.**

Note the precedent cost, because ADR-0002 already priced it: *"Editing an invariant sets a
precedent that invariants are editable. They were load-bearing precisely because they read as
fixed."* The one thing that must not happen is choosing by accident.

**ADDENDUM 2026-08-28 — the owner delegated this to evidence, and the evidence is in.** His
words (`70` §18.1): *"what is the most secure but optimised way of handling this? surely we
aren't coming up with anything unique, others should have made similar secure products. This
is enterprise level though keep in mind."* An ADR-0034 survey ran the same day — every claim
below carries its source and check date in `70` §18.1's commissioned research. Four findings:

1. **Envelope encryption — a data key per tenant, wrapped by a master key in a key-management
   service — is the documented standard at all three major clouds**, stated in those words by
   the AWS KMS developer guide, Google Cloud KMS's envelope-encryption page, and Microsoft's
   Azure encryption-at-rest page (all checked 2026-08-28). AWS documents the per-tenant
   pattern specifically, including the access-condition mechanics that prevent cross-tenant
   key use (AWS Security Blog, 2026-08-06).
2. **No mainstream collaborative SaaS offers server-unreadable encryption together with
   server-side search and unconditional recovery — and the products on each side say why.**
   Slack's engineering blog rejects end-to-end explicitly because it would break search,
   unfurling and notifications; Tresorit (genuinely zero-knowledge) documents that lost
   passwords may be unrecoverable and offers no server-side content search; Proton's search
   is client-side. Negative established across three products, per ADR-0034 rule 2. What
   §2 priced as the "keep invariant 4" cost is what the whole market priced the same way.
3. **The enterprise-tier norm is CUSTOMER-MANAGED keys, not end-to-end**: Slack EKM,
   Salesforce Shield BYOK, Atlassian CMK, Miro BYOK — and **Lucid itself sells "Lucid KMS"
   as an Enterprise Shield add-on**, on AWS-held keys by default. The comparable the owner
   named as the model monetises exactly the staged custody switch this decision recommends.
   Revocation and the customer's own audit trail (wrap/unwrap events logged to the
   customer's CloudTrail, in Slack's case) are what the customer buys.
4. **SOC 2 and ISO 27001 do not require application-layer encryption** — CC6.1 and control
   8.24 are risk-based; disk/database encryption plus access control is the accepted
   baseline (compliance-vendor summaries, not the standards' text; two independent sources).

**RECOMMENDATION, firmed accordingly — the staged plan above, with the switch destination
now named.** Server-held keys; application-layer envelope encryption with a data key per
tenant from the first byte (not just disk encryption, which finding 4 would permit — one
tier above the compliance floor, and cheap when built in from the start); the wrap point
built so a **customer-supplied master key** can replace the house key later as the
enterprise feature, which is the "custody change" the staged plan already required — the
evidence says its destination is customer-managed keys, not end-to-end. Never say
"zero-knowledge" or "we cannot read your data"; say what Fathom can say that no comparable
can: **device credentials are protected by never arriving** — the ingest gate destroys them
in the browser before upload, which is a stronger sentence about the most dangerous 2% of a
config than any custody arrangement is about the rest.

> **RATIFIED 2026-09-03 as ADR-0040**, when the owner said *"start working on the server
> version."* Invariant 4 is scoped rather than deleted in `.context/conventions.md`; `38`
> §14's union rule is ratified alongside it; the custody switch has a named destination
> (customer-managed keys) and a named trigger (**the first customer who is not the owner**);
> and the sentences that may never be said until it is true are listed in ADR-0040 §6.
> **This closes `49` §22 open decision 1 and with it the last DECISION item in §19's phase 0
> — phase 0 is complete.**

**Decision 5 — do not write the cryptography.**

`32` §15 already forbids hand-rolling, and `deps/decisions/chacha20poly1305.md` says why better
than I can: *"a from-scratch AEAD in a zero-dependency crate, authored by a model, protecting a
network engineer's firewall topology, would be the single weakest component in a project whose
entire claim is that you can trust what it does."* Two records already exist and are
owner-approved (2026-08-15): `chacha20poly1305` (RFC 8439; one NCC Group review commissioned by
MobileCoin, engagement December 2019, report published 2020-02-26) and `argon2` (RFC 9106,
September 2021, approved on condition that the RFC's own test vectors sit in the verification
floor). **Neither is vendored yet** — `Cargo.lock` still holds 16 packages, all first-party.

Three currency corrections for whoever writes the crypto record:

- **OPAQUE is now RFC 9807 (July 2025).** `33` §3.2 cited it as a draft. But see §12: I
  recommend dropping OPAQUE entirely.
- **Argon2's server-side parameters are a separate decision** from `32` D1's file-key floor.
  OWASP's Password Storage Cheat Sheet gives the server family: minimum m=19 MiB, t=2, p=1.
- **The one genuinely unsolved dependency is HPKE**, the scheme `32` §10.2 specifies for
  wrapping a key to a member. The honest position, after looking: rozbb/rust-hpke's own README
  says *"nobody has performed a paid audit of this crate"* but that Cloudflare reviewed
  **version 0.8** with no security issues — the crate's current line is 0.14.x. And the
  formally-verified alternative has a documented record of failure: *Verification Theatre:
  False Assurance in Formally Verified Cryptographic Libraries* (Kobeissi, Symbolic Software,
  IACR eprint 2026/192) reports **thirteen vulnerabilities** in libcrux and hpke-rs that
  escaped formal verification, including a missing X25519 validation and **nonce reuse via a
  `u32` counter that silently wrapped in release builds**. Both fixed; no advisories issued.
  **So: pin the version, put the RFC's own test vectors in the verification floor, and never
  treat an "audited" or "formally verified" badge as a substitute for either.**

## 4. What it protects against, and what it does not

Written plainly, because this is the table to show a customer's security team.

| threat | protected? | by what |
|---|---|---|
| someone steals a device password out of Fathom | **yes, completely** | there is none to steal — decision 1 |
| someone steals the server's disks | yes | disk encryption — but see below |
| a bug in Fathom returns another tenant's rows | **yes, structurally** | per-tenant keys + database row-level security (§11) |
| a customer offboards and wants their data gone from backups too | **yes** | destroy the key (§3 decision 3) |
| the operator (you) reads a customer's network map | **only under decision 4's "keep it" branch** | otherwise: no |
| a subpoena to the hosting provider | same as above | same |
| someone with the URL of a signed firmware link uses it | **no** | it is a bearer credential; see §16 |
| a compromised or stale client uploads a password | yes | the server re-runs the gate — union, never replace |
| a browser-delivered-code attack (the server serves you altered JavaScript) | **no, and it cannot be** | CryptPad list this as a trust assumption of their own product. State it; do not manage it |

**And be careful what "encryption at rest" is sold as**, because the usual answer is weaker
than it sounds. PostgreSQL's own documentation (PostgreSQL 18, *Encryption Options*, read
2026-08-21) says disk encryption protects against *"drives or entire computer is stolen"* and
explicitly *"does not protect against attacks while the file system is mounted, because when
mounted, the operating system provides an unencrypted view of the data."* Encrypting the
Proxmox VM's disk protects you against someone walking out of the building with it. Against
nothing else.

**One myth to retire while we are here.** *"But the password is already hashed in the config."*
For Juniper's `$9$` that is false: Juniper's own CLI reference for `request system decrypt
password` says the command exists to *"display plain text versions of obfuscated ($9) or
encrypted ($8) passwords"* (introduced Junos 16.2R1). A stored `$9$` value **is a plaintext
password wearing a costume.**

## 5. Architecture: what lives where

```
BROWSER                          |  SERVER                        |  DATABASE
---------------------------------|--------------------------------|------------------
paste box                        |  HTTP + WebSocket (axum)       |  PostgreSQL
  -> fathom-wasm (gate only) ----|-> re-run gate (union)          |
                                 |   ingest / weld / schema check |  generic fact tables:
pan, zoom, hit-test, selection   |   layout for ONE SCOPE         |    node, edge, field,
hover, drag gesture              |   inventory rows               |    provenance, history,
optimistic echo of my own edit   |   findings                     |    batch, op
remote cursors (canvas overlay)  |   prefix / containment queries |
                                 |   ordering of concurrent edits |  generated projections:
receives: boxes + polylines,     |   permissions, audit log       |    proj_device, proj_address
rows, findings                   |                                |    proj_prefix (inet/cidr)
```

**The server does the thinking. The browser does the looking.** Three consequences worth
stating on their own:

**(a) The server computes layout and sends geometry.** This is now forced rather than
preferred. If two browsers compute their own layout and one is a build behind, two people
editing the same design see two different pictures while pointing at each other's cursors.
`fathom-layout`'s own header already requires determinism *"which is what makes a diagram
shareable in a change ticket"*; live editing turns that from a nice property into a
correctness requirement, and the cheap way to guarantee it is that there is only one
computation. It also caches perfectly: layout is a pure function of (subgraph, view), so one
computation serves every viewer of that scope.

**(b) Never lay out an estate — only ever lay out a *scope*.** A scope is (rung, anchor node,
layer mask, view). The server fetches that subgraph and hands the layout crate a few hundred
nodes, never eighty thousand. This is the single highest-leverage item in this whole document
and it is a query change, not a layout change. See §8 for why.

**(c) Presence goes on a canvas overlay, not in the SVG.** Remote cursors and selections update
at pointer speed for every connected editor. Put them in the document tree at thousands of
nodes and they will dominate every frame, with no obvious culprit. Decide this before the first
presence feature lands, not after.

## 6. Technology choices, and the dependency gate

All versions read directly from the crates.io API on 2026-08-21.

| job | choice | version | why |
|---|---|---|---|
| HTTP + WebSocket | **axum** | 0.8.9 | `41` §5.2 already chose it. Use its own `ws` feature — do **not** add `tokio-tungstenite` separately, that is two copies of the same protocol code |
| async runtime | **tokio** | 1.53.1 | unavoidable and universal |
| middleware | **tower-http** | 0.7.0 | |
| database | **PostgreSQL** | 18 | see below |
| driver | **tokio-postgres** (+ `deadpool-postgres`) | 0.7.18 | **58 crates in the build graph against sqlx's 124** — measured 2026-08-21 |
| TLS | **rustls** | 0.23.43 | 0.24.0-dev.1 is pre-release; do not use |
| sessions | **tower-sessions** | 0.15.0 | stateful and revocable |
| password hashing | **argon2** | 0.5.3 | 0.6.0-rc.8 is a release candidate; not here |
| second factor | **webauthn-rs** / **totp-rs** | 0.5.5 / 6.0.0 | passkeys, with codes as the fallback |
| organisation sign-in | **openidconnect** | 4.0.1 | 12.0M downloads against SAML's `samael` at 636k and still version 0.0.22 |
| mail | **lettre** | 0.11.23 | speak SMTP to a provider; **use the rustls backend** — RUSTSEC-2026-0141 (2026-05-14, critical) is *"TLS hostname verification disabled when using Boring TLS backend"* |
| rate limiting | **governor** | 0.10.4 | |
| logging | **tracing** / **tracing-subscriber** | 0.1.44 / 0.3.23 | |
| hashing for the audit chain | **blake3** | 1.8.7 | already in the corpus's vocabulary |

**Storage: this reverses `41` §5.3.** That section chose `redb` for single-node and Postgres
for clusters — but read what it was deciding *about*: requirement S1 was *"store opaque blobs,
~1 KB – 20 MB"*, and the trait it specified says *"fifteen methods, none of which understand a
record's contents."* That is a zero-knowledge blob sync service, not a database of a network.
`redb` is a healthy crate (4.2.0, updated 2026-08-17) and it is the wrong tool for the new job:
single-writer, no secondary indexes, no row-level security, no cluster. **And do not carry two
backends** — `41` §5.3 priced that honestly at a ~60-test conformance suite, and for a solo
maintainer that is a tax with no payer.

**Four reasons Postgres wins, in order:** (1) SQLite's own documentation says *"since there is
only one WAL file, there can only be one writer at a time"* — live multi-user editing on a
single-writer engine serialises every keystroke in the product behind one lock; (2) it has
native IP address types and prefix containment (§7); (3) NetBox is PostgreSQL-only, so your
audience already runs it; (4) tenant isolation can be enforced *below* the application (§11).

**On C7 — "no C or C++ in the shipped closure".** `tokio-postgres` speaks the wire protocol in
pure Rust, and the Postgres *server* is not in Fathom's link closure, so C7 survives — `41`
already says so. It survives **only if TLS is terminated in front of the binary**, because
`rustls`'s crypto provider brings C and assembly back in. `43` §5.4 already decided TLS in
front by default; keep that, and put Postgres on a Unix socket or loopback.

### 6.1 The dependency gate is now the most important script in the repository

Fathom has **zero external dependencies today** — `Cargo.lock` holds 16 packages, all
first-party. A working server is roughly **109 crates** before Fathom's own cryptography.
`35` §5.1's caps are ≤30 direct and **≤160 in the closure**; choosing `sqlx` instead of
`tokio-postgres` would spend 36 of the remaining 51 on one convenience.

**And the risk is measured, not theoretical, as of the day before this was written.** On
**2026-08-20** the Rust Security Response Team published *"Supply chain attack on arrayref"*:
malicious versions of `arrayref` 0.3.10, `internment` 0.8.7 and `append-only-vec` 0.1.9 were
published, each pulling in `proc-macro1` — a typosquat of the near-universal `proc-macro2` —
whose **build script downloaded and executed a payload during compilation**. RUSTSEC-2026-0260
records `arrayref` 0.3.10 being downloaded 2,285 times in the window before removal.
`42` §6.2 predicted this exact row: *"Arbitrary code at build time — Cargo: yes, `build.rs`,
with the build host's full privileges, no sandbox."*

> **Before the first external crate lands:** `./scripts/gate-zero.sh` treated as a real
> control (ADR-0032 §6 already requires a `deps/decisions/<crate>.md` beside every external
> package), `cargo audit` against the RustSec database in CI, and `--locked` everywhere so a
> lockfile is never silently updated. ADR-0034 §4 already asked for the vulnerability scan to
> land *before* the first dependency. It is now overdue rather than early.

## 7. Storing a typed graph in a database

**Not one table per kind. Not naive key-value-per-field either.** Both are wrong for a
specific reason: **in Fathom a field is not a value, it is an asserted fact** — a presence
(Set / Absent / Unknown), a provenance id, and a bounded history of prior states. A column can
hold the value and nothing else, so 48 kinds would mean 137 value tables *plus* a parallel
provenance table *plus* a history table each — and every schema bump becomes a migration across
all of them. The schema moved 0.2 → 0.3 this month (ADR-0037). That shape punishes exactly
what Fathom does most.

**The shape that is right, and it is not a compromise — it is what the domain already is:**

- **Truth is generic, and mirrors `Snapshot` one-for-one.** Seven tables: `node`, `edge`,
  `field`, `provenance`, `field_history`, `batch`, `op`, each with `tenant_id` and
  `design_id`. `crates/fathom-graph/src/snap.rs` **already defines this exact shape** as
  ordered plain data with no dynamic typing in it, and `from_snapshot` already re-runs the
  validation ladder on load — *"loading is not trusting"*. Persisting it is a transcription,
  not a design.
- **Queryable projections are generated from `schema/schema.yaml` and are derived, not
  authoritative.** One narrow table per kind anything actually filters on, holding only the
  fields that need an index: `proj_device(tenant_id, design_id, node_id, name, role,
  platform)`, `proj_prefix(… prefix cidr)`, and so on.
- **Because projections are derived, a schema bump rebuilds them instead of migrating them.**
  That is the whole point, and it is what keeps `48` §2's *"fork the app, not the vocabulary"*
  true in the database as well as in the code. `fathom-schemagen` already generates Rust types
  from the schema; generating the table definitions is the same machinery pointed at a second
  target.

This is, as it happens, Figma's document model with an index on the side — theirs is described
in their own engineering blog as *"(ObjectID, Property, Value)"* tuples with a
server-authoritative last-writer-wins register per property. Fathom's in-memory store is
already the same shape, with provenance added.

### 7.1 "Which /24 holds 10.4.7.19" falls out for almost nothing

PostgreSQL has native `inet` and `cidr` types. The documented difference is that *"`inet`
accepts values with nonzero bits to the right of the netmask, whereas `cidr` does not"*
(PostgreSQL 18 docs, read 2026-08-21). **That is a one-for-one match with the schema Fathom
already has**: `InterfaceAddress` (`10.255.0.1/30` — host bits preserved) → `inet`, and
`IpPrefix` (`10.2.0.0/16` — host bits zeroed) → `cidr`, including the host-bits rule.

```sql
SELECT prefix FROM proj_prefix
 WHERE tenant_id = current_setting('app.tenant')::uuid
   AND prefix >>= inet '10.4.7.19'
 ORDER BY masklen(prefix) DESC LIMIT 1;
```

Drop the last line and you get the whole containment chain, which is what a hierarchy view
wants. Overlap detection and free-space come from the same operators — so `48` §6's three
sub-features are one index. **One trap:** these operators cannot use an ordinary index; you must
name the GiST class explicitly (`USING gist (col inet_ops)`), because *"for historical reasons,
the `inet_ops` operator class is not the default class for types `inet` and `cidr`"*.

SQLite cannot do any of this natively — its five storage classes contain no network type — and
NetBox, the closest real product, maintains its prefix hierarchy with exactly these PostgreSQL
operators. **Do not add a graph database.** Fathom's queries are one to three hops; the one
genuinely deep walk, `19` §6.5's `trace_step`, is capped at 16 hops with domain rules at each
step, which is a Rust loop, not a query language.

## 8. Drawing thousands of devices — the layout crate is cubic and I measured it

This was measured on 2026-08-21, not estimated. Synthetic estates in the shape of
`fathom-layout`'s own fixture; release build; **the repository was not modified** (an
instrumented copy was made in a scratch directory).

| devices | nodes | `lay_out` |
|---|---|---|
| 80 | 2,281 | **112.8 ms** |
| 160 | 4,561 | 635 ms |
| 320 | 9,121 | 4.26 s |
| 640 | 18,241 | 31.5 s |
| 1,280 | 36,481 | **244 s** |

Doubling the estate multiplies the time by about 7.5 — **cubic**. At the owner's thousands of
devices, the current code would take hours.

**Three things follow, and only one of them is a code fix.**

**(a) Note where 2,281 nodes lands: 112.8 ms, against `44`'s 160 ms first-render budget.**
`44` §4.7.4's decision to cap the drawn picture at 2,000 live elements is almost exactly the
point where this implementation stops being interactive. That cap has been holding the roof up.

**(b) Aggregation shrinks the picture and does *not* shrink the work.** Folding a 72,961-node
estate produces **8 boxes** — and takes **17.3 seconds**, because the layering still expands
every member of every folded group. **Bounding the output is not bounding the input.** This is
why §5(b)'s "lay out a scope, never an estate" is the headline recommendation and not a
detail.

**(c) The two hot spots are textbook, and both were deliberately not built for byte reasons
that no longer apply.** At 18,241 nodes, `route::allocate` (the channel colouring) is 30.0 s of
the 31.5 s and grows cubically; `order::crossings` is quadratic. The crate's own comment on the
second one says: *"The alternative is inversion counting with a Fenwick tree at `O(k log k)`.
It was not built, because the measurement said not to … `k` is bounded above by a product
decision, since `44` §4.7.4 caps the picture at 2,000 live elements. Revisit when a
measurement, not this comment, says to."* **This is that measurement**, and the premise it
rested on — a cap that existed because of the browser — is what the pivot removes. The fix for
`allocate` is bucketing per channel instead of one flat list; the fix for `crossings` is the
Fenwick tree the comment names, with Barth, Jünger and Mutzel (Graph Drawing 2002) as the
reference. Both are days, not weeks.

**Do them even though (b) makes them less urgent**, because an unbounded scope *will* be
reached — by a search result, by a trace, by a very large site — and a cubic function reached
by accident on a shared server is a denial of service, not a slow page.

**And keep the 2,000-element ceiling.** It was argued as a rendering limit and it is also a
readability limit, and the readability argument survives the pivot untouched: *"a 5,000-node
picture of a network is not a diagram, it is a texture, and nobody has ever found anything in
one."* yWorks — who sell diagramming toolkits — independently recommend filtering to *"a low
three figure number at most"* on screen. **Thousands of devices in the estate is not thousands
of shapes on screen.** `57`'s zoom ladder is the answer to the scale requirement, not a
casualty of it.

**One gap in the ladder, and it is the rung that is live.** Premises, Rack and Chassis are
bounded by construction — tens each. **`Site → Device` is not**, and a campus site with 3,000
devices draws 3,000 boxes with no zoom left to do. Rung 1 needs a grouping level inside it:
devices folded by role, by zone, or by subnet, using `59`'s existing machinery — and `59`
§3.6's rule applies at that ratio with full force, because *"a collapse that does not name what
it hid and how many there were is a lie with fewer elements."* A box reading "36,480" is honest
and useless; the grouping key has to mean something.

**Memory, for the record:** 175.7 MB of resident memory for 72,961 nodes and 94,720 edges
**with no field values set at all**. That is a floor. One large estate is a few hundred
megabytes and the current store is single-estate, in-memory, with no eviction. That lifecycle
is the real scope of the fork, exactly as `48` §2 said.

## 9. Live editing: build Figma's model, not Lucid's

Three terms, once:

- **Operational transformation (OT):** when two edits collide, mathematically rewrite one so it
  still means the right thing. Old, proven, notoriously hard.
- **CRDT:** design the data so any order of arrival lands in the same place, so no rewriting is
  needed. The complexity moves into the data structure.
- **Server-authoritative last-writer-wins:** one server decides the order; per field, whoever's
  change arrives last wins. Simplest by far — and only possible when there *is* one server,
  which as of the owner's decision 1 there now is.

**Figma rejected both of the first two, in their own words** (figma.com engineering blog, read
2026-08-21): OT was *"unnecessarily complex for our problem space … they result in a
combinatorial explosion of possible states which is very difficult to reason about"*; and
CRDTs, because *"since Figma is centralized (our server is the central authority), we can
simplify our system by removing this extra overhead."* They track the latest value any client
sent for a property on an object, last one in wins, and *"we don't need a timestamp because the
server can define the order of events."*

**Lucid — the one the owner named — took the harder road and wrote down how much it hurt.**
Their tech blog (2021-04-07): *"Lucid uses a form of Operational Transformation"*, a proxy
service in front of storage sharing model code with the editor, merge bugs that *"only appeared
when there was enough entropy in the system"*, and a *"huge cross-functional effort"* to ship.
**The owner wants the Lucidchart experience. He does not need Lucid's algorithm.**

> **DECISION: one server decides the order; per field, the last change to reach the server
> wins. No CRDT library. No operational transformation.**

`33` §4.1 already found the killer observation and it survives the pivot: *"The hardest and
largest part of every CRDT library — correct sequence interleaving — is the part we do not
use."* Fathom has no long ordered text. It has device names, addresses, box positions and
links. Keep Loro as the named fallback exactly as `33` §4.5 says, if the property tests fail.

**One honest caveat**, and it applies only under decision 4's "keep invariant 4" branch:
`33` §4.1 already found that *"every published CRDT sync protocol assumes the peer can inspect
what it is syncing."* So if the server may not read the document, you may not hand-roll the
cipher (decision 5) and you have no choice but to hand-roll the *sync protocol*. That is a
large, security-relevant, one-person build, and it is a cost that belongs in decision 4's
column.

**What I could not find:** a mature Rust library that gives server-authoritative rooms,
presence and ordering out of the box — the Rust equivalent of Liveblocks or PartyKit.
Searching turned up hobby projects only. **This part is yours to write.** It is not enormous
(an actor per open design, a broadcast channel, a monotonic sequence number) but it is not free.

**Be honest about the size of the full thing.** The ordering is easy once there is one server.
What is not easy is *optimistic local echo and rollback* — showing my change instantly and
taking it back correctly when the server disagrees — plus reconnection and catch-up, plus the
property tests that prove two browsers cannot end up permanently disagreeing. `33` §14 already
names the risk: *"a convergence bug is a data-loss bug … and it is silent."* **For one person
this is months, and it is the largest single piece of work in the pivot.** §19 phases it
accordingly, and §20 argues for taking the cheap half first.

## 10. The journal is an accidental advantage with three defects

Nobody had looked at whether Fathom's existing operation journal is a head start for
multiplayer. It is — and it is about half of what it looks like.

**Four things are already right, and they are the expensive half:**

1. **Identifiers need no server.** Every node id is a ULID built from the browser's
   cryptographic random-number generator, so a browser can invent the identity of a new device
   without asking anyone, and two browsers doing it in the same millisecond will not collide.
   Invariant 7 already forbids referring to anything by name or path. This is the precondition
   every collaborative system needs and the part teams usually spend months retrofitting.
2. **Writes carry whole values, not differences.** `33` §5.1 already says it: *"It carries the
   WHOLE value, never a delta."* A whole-value write is what makes "last one wins" a *safe*
   rule.
3. **Deletion is already a tombstone**, so "one person deletes while another edits" is
   representable at all.
4. **The envelope was reserved on purpose.** `crates/fathom-graph/src/op.rs` says in its own
   header that the author/clock/identity envelope is *"deliberately absent … the shapes here
   take all of them additively."* Someone left the door open and wrote down that they did.

**Three defects, and one of them is serious:**

**(a) It is a command log, not an event log — and that is a named trap.** The `paste` entry
stores the redacted config *text*, and replay re-runs the parser over it. The standard warning
(Chassaing, *Event Sourcing vs Command Sourcing*, 2013-07-28) is that *"you can't simply replay
a stream of logged commands at some arbitrary time and hope to get the same outputs as you
would if they were handled immediately."* The page's own comment treats re-derivation as a
feature — and both readings are true, which is the problem. **Improve the Junos dictionary —
which this project does roughly monthly, 23.8% to 47.5% line coverage in two days this month —
and reopening last month's design silently produces a different estate, with different node
ids, and every hand-drawn link pointing at nodes that no longer exist.** For a tool whose
stated job is "estate of record", and for anything later called an audit trail, that is not
small. The fix is cheap today: record what the parse *produced* alongside the text, and replay
the product. It stops being cheap once customers hold journal files.

**(b) `OP_PASTE` replaces the whole estate.** An operation that destroys everything cannot be
merged with a concurrent operation by any algorithm. In a shared design it is not an edit, it
is a bomb. It must become *"add to this design"* — which is also `70` §6's unbuilt correlation
requirement wearing a different hat.

**(c) There is no author.** Every operation today fabricates a user id from the clock, so every
change is by the same anonymous nobody. Multi-user editing, permissions and audit logging all
need this to be a real, transmitted, durable identity. **It is one field. It is free now and it
touches the schema, the store, the provenance model, the export format and every existing
journal file later.**

## 11. Multi-tenancy: making isolation structural, not remembered

**One Postgres database, a `tenant_id` column on every table, and Row-Level Security under it.**
Row-Level Security is a PostgreSQL feature where the database itself filters every query by a
rule you attach to the table — so isolation stops being a property of every query you remember
to write and becomes a property of the database. A forgotten filter returns zero rows instead
of another customer's network.

Four rules make it real, and PostgreSQL's own documentation states the traps plainly
(postgresql.org, read 2026-08-21):

1. **`ALTER TABLE … FORCE ROW LEVEL SECURITY` on every tenant table.** Without it: *"Table
   owners normally bypass row security as well"* — and the owner is usually the role your
   migrations run as.
2. **The application connects as a role that is not a superuser, does not own the tables, and
   does not have `BYPASSRLS`.**
3. **Set the tenant on the connection at pool checkout and reset it on return** — and use
   `SET LOCAL`, never plain `SET`, if there is a transaction-mode connection pooler in front,
   or the next request served by that connection inherits the previous tenant's context. That
   is a cross-tenant leak that looks like a security-policy bug and is a pooling bug.
4. **Scope every uniqueness constraint to `(tenant_id, …)`, never globally**, because
   *"referential integrity checks, such as unique or primary key constraints and foreign key
   references, always bypass row security … Care must be taken … to avoid 'covert channel'
   leaks."* In plain terms: a "that name is taken" error can tell you a name exists that you
   are not allowed to see.

**And test it, because a policy is code.** One test that drives the entire API surface as
tenant B using tenant A's identifiers, asserting zero rows and no successful responses, on
every endpoint. This project already has the habit —
`crates/fathom-schema/tests/shipped_tree.rs` pins the empty warning set so the next warning of
any kind fails a test. Same idea, applied to tenants.

**If a large customer ever demands a separate database**, that is a deployment change and not a
code change, provided `tenant_id` is already on every row. Row-level security now does not
foreclose database-per-tenant later. The reverse is not true.

**What this does *not* solve.** It handles the coarse half — organisation A cannot see
organisation B. It does not handle the fine half — *"this group cannot see secrets"*, which
`48` §5 correctly calls the largest new design surface in the fork. Under §3 decision 1 there
are **no stored secrets at all**, which deletes the hardest case of that problem outright.
**Keeping the redaction gate is not only a security decision; it removes the hardest permission
problem in the product.**

## 12. Accounts, sessions, and sign-in

Nothing here is novel; it is well-trodden code with named traps. All parameters from OWASP's
cheat sheets, read 2026-08-21.

- **Passwords: Argon2id**, minimum 19 MiB of memory, 2 iterations, parallelism 1. Fallbacks in
  order: scrypt, bcrypt (work factor ≥10, and note the 72-byte input limit), PBKDF2 only where
  FIPS-140 compels it.
- **Sessions:** at least 64 bits of entropy from a cryptographic generator; cookie flags
  `Secure; HttpOnly; SameSite=Strict` with the `__Host-` name prefix; **two** timeouts enforced
  server-side (idle 15–30 minutes for ordinary use, absolute 4–8 hours); **regenerate the
  session identifier at login**, which is what stops session fixation; logout invalidates
  server-side, not just in the browser.
- **Policy: NIST SP 800-63B-4**, finalised 2025-07-31. It is the document that says stop forcing
  periodic password changes and stop demanding character classes, and check candidates against
  known-breached lists instead.
- **Second factor: passkeys.** The reason a passkey beats a one-time code is not strength, it
  is **origin binding** — the credential will not sign a challenge from a look-alike site, so
  it cannot be phished. Keep one-time codes as the fallback for people whose hardware cannot.
- **Organisations: OpenID Connect, not SAML.** 12.0M downloads against 636k, and the SAML crate
  is still on version 0.0.22.
- **The customer's directory is the source of truth — the owner said so before being asked**
  (2026-08-28, `70` §18.2: *"they may use ldap or Active directory for their users"*). The
  ADR-0034 survey commissioned that day found the split the industry runs: **for the hosted
  product, the SaaS never speaks LDAP itself** — the customer's identity provider (Entra ID,
  Okta) fronts their directory and the product speaks OIDC/SAML to the provider, with SCIM
  for provisioning and deprovisioning; **for the self-hosted build, a direct LDAP/AD bind is
  still the documented norm** — GitLab, Grafana and NetBox all ship it, NetBox via
  `django-auth-ldap` with Active Directory examples (all checked 2026-08-28). Same two-shape
  answer as the reverse proxy in phase 1: hosted and self-hosted differ at the boundary, one
  binary behind it. Design the user table so an externally-provisioned user is the normal
  case and a Fathom-local password is the special one, not the reverse.
- **Passkeys are mainstream, not exotic** — FIDO Alliance's 2026 state-of-passkeys report
  (published 2026-05-07): ~5 billion passkeys in use, 68% of organisations deployed or
  deploying for employee sign-in. The bullet above stays as written; this is the currency
  evidence behind it.
- **Drop OPAQUE** (`33` §3.2). OPAQUE's whole prize was: if the server is breached, the attacker
  cannot even guess at your password offline. That was worth a great deal when the server held
  nothing but ciphertext it could not read, so the password was the only thing worth stealing.
  **Under the pivot the server holds the network diagrams.** An attacker with the database
  already has what they came for. Revisit only if decision 4 lands on "keep invariant 4".

**Two things nobody has priced, and they land on the customer segment the pivot exists for:**

- **Single sign-on and end-to-end encryption are in tension.** With SSO the browser no longer
  holds a password, so a password-derived key has nothing to derive from; vendors solve it with
  an additional device-key subsystem. That is another whole component, and it arrives exactly
  when an employer asks for SAML/OIDC.
- **The moment password reset by email exists, whoever controls the mailbox controls the
  account.** Every control above is capped by the weakest reset path. And under a
  "server cannot read" design, an email reset **cannot** restore the data, and the message must
  say so at the moment the user asks.

## 13. Logging and auditing — three different logs

**Conflating them is the defect.** They have different retention, different readers and
different threat models. Build three things.

| | what it is | retention | notes |
|---|---|---|---|
| **operational log** | why did this request fail | short — `43` already sets 7 days | *"no request bodies, ever"* |
| **audit log** | who did what, to which design, when, from where | long, tamper-evident | it is **evidence** |
| **the estate's own history** | what this device's hostname used to be, and who changed it | in the graph | already half-built — `fathom-graph` keeps a bounded value history per field |

**What must be in the audit log** (OWASP Logging Cheat Sheet's categories, translated into
Fathom's nouns): sign-in successes and failures; membership and role changes; a design created,
shared, exported or deleted; **a secret-bearing field viewed**; a config pasted; an export
downloaded. **The export and the secret-view are the two an incident responder asks for first
and the two most often missing.**

**What must never be in any log:** session identifiers, tokens, passwords, *"encryption keys and
other primary secrets"*, connection strings, source code. Plus OWASP's note that internal
network names and addresses may need special handling — which for **this** product is not a
footnote, it is the entire subject matter.

**Append-only is not tamper-evident.** A table you only insert into can still be back-dated by a
database administrator, and nobody can prove otherwise. Tamper-evident means each entry's hash
includes the previous entry's hash, so altering or deleting any past entry breaks the chain from
that point on, detectably. It is cheap: `blake3` is already in the vocabulary.

**And note the honest tension:** under decision 4's "keep invariant 4" branch, an audit log of
*what was read* cannot be built server-side either, because the server cannot see what was read.

## 14. The look: Termix and Zerobyte, reconciled with `51`

**Both names are real products and the owner is not misremembering them.**

- **Termix** (github.com/Termix-SSH/Termix, read 2026-08-21) — self-hosted server management:
  SSH, RDP/VNC, SFTP, Docker, automations. 14.8k stars. Audience: sysadmins and homelabbers.
- **Zerobyte** (github.com/nicotsx/zerobyte, read 2026-08-21) — **not a theme**; a self-hosted
  backup tool, a web interface over restic.

Both were reviewed on the same homelab blog, which is a plausible way one person met them as a
pair. I read both projects' actual stylesheets rather than describing screenshots, and they
converge:

| trait | Termix | Zerobyte | Fathom today |
|---|---|---|---|
| monospace for the **entire** interface | `html { font-mono }`, JetBrains Mono, headings too | `--font-sans: "Google Sans Code"` — which is a *monospace* face | mono-forward, sans for prose |
| corner radius | **0.625rem (10px)** in all nine themes | **0.625rem** — identical | **`--radius: 0`** |
| shadows | none | none — cards are the *same colour* as the page, marked with **L-shaped corner brackets** over a faint grid | `--shadow: none` |
| accent | one orange `#f59145` | one orange-red `#ff543a` | none |
| uppercase tracked micro-labels | VERSION / UPTIME / HOSTS ONLINE | SCHEDULE / REPOSITORY / STATUS | already has the token |
| left 4px bar marks the active item | yes | yes | already `51` §4.1's C1 channel |
| default theme | dark | dark | **light** |

**Fathom is already much closer to the reference than `51`'s prose suggests.** Two things
genuinely differ: radius and default theme. Recommended deltas:

1. **`--radius: 0` → `2px`.** Meet him rather than the reference: 10px is a SaaS card, 0px is a
   photocopied fax, 2px is a machined edge. Bind it with a rule `51` can enforce: **radius
   applies to controls, chips and inputs only — never to a rule, a bar or a panel edge.** Keep
   `--shadow: none`. Zerobyte proves radius does not force the card-and-shadow cascade `51` §10
   fears: **that cascade is caused by elevation, not by corners.**
2. **Make dark the default; keep light first-class.** Both references are dark-first and `51`
   §5.1's own 02:00-in-the-NOC argument supports it. **Flag this to the owner as a decision, not
   a fait accompli** — it reverses `51` §5 and ADR-0026, which gated dark behind three
   conditions, two of which were byte- and diagram-scoped and are now moot.
3. **Go monospace throughout.** It is the source of "blocky". It retires `51` §7.4's
   x-height-matching problem, which exists only to set mono inside sans prose. **Cost to
   measure, not assume:** `51` §7.8 derives `--sheet: 1180px` and `--measure: 68ch` from a grid
   holding mono beside *sans*; mono runs about 8% wider per character, so that arithmetic must
   be re-solved. Half a day, and it invalidates a derivation `51` is proud of.
4. **Choose a blue-cyan accent, not orange.** This is the non-obvious call and it matters most.
   `51` R1 reserves green, amber and oxblood **forever** for the risk enum, enforced by a
   build-failing lint. Termix's `#f59145` sits close enough to Fathom's dark-theme
   `--caution: #D97328` to be mistaken for it. Blue is free, shares the hue family of `--ink`,
   and reads as blueprint — which is what a network diagram is. **One token, one job: `--accent`
   means "the thing you are on, or the thing you just did".** It must never encode risk,
   severity or status.
5. **Adopt the corner-bracket panel and the faint grid.** Zerobyte's best idea, and a near
   perfect fit: it delimits a region without a border, a fill or elevation, so it does not turn
   notes into cards — which is exactly what `51` §10 was protecting against. The grid also gives
   the diagram a ground that *means* something.
6. **Keep status out of the risk colours.** Both references reach for green for "healthy".
   Fathom cannot. A dot plus the word, in the neutral channels.
7. **Put a one-sentence explanation under every form field**, in Zerobyte's voice (*"Unique
   identifier for the volume."*). **Cheapest high-value change in this entire document, and the
   owner is not a programmer.**
8. **Correct `51` §12 rather than argue with it.** It says *"the product has no animation"*;
   `design/tokens.css` already declares `--m-pane: 150ms`, `--m-mark: 110ms` and an easing
   curve, used in 14 places, and ADR-0033 (motion must carry meaning) is ratified. The owner's
   request for animation is already half-satisfied.

**Two things to refuse.** Termix's base layer applies `outline-none` to everything — do not copy
that line; `51` §4.7 makes a 2px outline the sole focus indicator and `55` governs. And Termix's
eight terminal colour themes (gruvbox, nord, dracula…) would **delight this owner** and as
specified would let a cosmetic setting redefine `--destructive` and `--primary` — i.e. rewrite
the risk semantics. Recoverable only in the form: **pin the three risk colours outside the theme
system and let a theme move only the chrome.**

**The navigation model, given thousands of devices and multi-tenancy:**

- **A thin icon rail** for organisation and top-level view switching. Termix's shell has four
  regions and gets away with it because region one is a ~22px rail. **The rule that makes four
  regions survivable is: a region is either a thin rail or the main event, never a 38%
  competitor.** Fathom's inventory is currently the 38% competitor — which is exactly `57`
  §16's complaint, in the owner's own words: *"when you are looking at equipment and click on
  it, you have like 3 pages opened, it was too much and you couldn't see anything."*
- **A search-first, virtualised primary list.** Termix's browser-tab-per-host model is superb
  for six sessions and meaningless for 2,000 devices. **Ctrl+K is already the right instinct and
  is ahead of both references here.**
- **Breadcrumb over tabs for the zoom ladder.** `57`'s Premises → Site → Rack → Chassis is a
  hierarchy; Zerobyte's breadcrumb expresses one and Termix's flat tab bar cannot. Tabs only for
  genuinely parallel things — two designs side by side.
- **Two submenu mechanisms, adopted verbatim**, because together they are what he meant by
  *"submenus that all make sense"*: **nested segmented strips** for "which face of this thing am
  I looking at", and **inline icons → a `⋮` kebab → a nested group** for row actions. Frequent
  inline, rare one click down, related one level deeper. **This is depth instead of breadth, and
  it is the direct answer to `57` §16.**

**Where the references fail us, and it is the hardest screen:** neither has a canvas. There is
no diagram, no pan/zoom, no marquee, no spatial selection anywhere in either product. On
Fathom's single hardest surface there is nothing to copy.

## 15. The gestures: the Lucidchart study, reconciled with `56` and ADR-0035

"Ease of use" in these tools is one specific thing: **the fastest path creates the node *and*
its connection in a single gesture, and never makes you visit a palette first.**

Nine things to steal, in priority order. Every one terminates in an operation against the graph
— there is no `shape.label`, no `edge.style`, no `node.color`, and there must never be one.

1. **Hover the perimeter to connect.** In Lucidchart, hovering a shape's *edge* turns the cursor
   into a plus; dragging from there draws a line. *Selecting* the shape instead shows four fixed
   anchor points — two different affordances on purpose. **In Fathom the anchors are ports, not
   compass points, which is strictly more useful.** This one gesture is most of what "feels like
   Lucidchart".
2. **Three drop targets, separated by a dwell.** Drop on another box = "connect these two",
   opening the port-resolving disclosure. Drop on a port = that port, no question. Drop on empty
   canvas = the **shape autoprompt**. Lucid separates "attach to this box" from "place here"
   with about a one-second highlight dwell.
3. **One gesture creates node *and* edge.** Fathom's autoprompt is better than Lucid's by
   construction, because it can offer only the kinds the schema admits at the far end of a legal
   edge, rather than the whole library. One batch, therefore one `Ctrl+Z`.
4. **The keyboard path is the reference implementation, and Excalidraw proves it works.** With a
   device selected, `Ctrl/Cmd + Arrow` creates a neighbour in that direction and links it; hold
   and repeat to chain a row of access points. Also adopt Lucid's `Ctrl`+arrow to *select* in a
   direction — the spatial navigation the Outline's tree keys cannot express. `55` §5.5 and `56`
   §6.3 already state the doctrine: the drag is sugar for the keyboard, not the reverse.
5. **Alignment guides and measured distances while dragging.** Steal Figma's modifier-hover
   measurement: select one rack, hold Alt over another, see the gap. **But guides appear only
   during a gesture that will write a `LayoutPin` — never during a computed re-layout**, or the
   user will believe the layout is theirs to nudge and be surprised when it moves.
6. **Reattach a connector by dragging its endpoint** — makes a wrong link fixable without
   deleting it.
7. **Insert on a link** (Miro's). *"There is a switch between these two that I forgot"* is a real
   network-engineering gesture.
8. **Alt-drag to duplicate**, for the twelve-identical-access-points case — and again Fathom is
   better by construction, because a duplicate is a new node with its own identity and its own
   hand-made provenance, not a copied shape.
9. **`?` shows every shortcut.** `53` already has this. **A state only a mouse can reach is not
   a state.**

**What to refuse to steal, explicitly:**

- **Auto-arrange on every edit.** This is the finding that most surprised me: Lucidchart's own
  community produces a steady stream of requests titled, literally, *"Option to Disable
  Auto-Arrange for Flow Charts and Site Maps"* and *"How to disable assisted layout in Lucid"*.
  **That is market evidence for ADR-0035** — layout is computed, a hand-placed position is an
  override, and the picture marks it — and it confirms `56` §3.1's *"nobody re-lays out a
  diagram they have already fixed"* from the loudest complaints about the tool the owner wants
  Fathom to feel like.
- **Free-floating text, arrows that are not edges, clip art, background images, per-shape
  colour.** `56` §1.3 and `59` already refuse these and the pivot changes nothing. The governing
  rule stands: **if a fact exists only in the picture, the picture has become the data
  structure.**
- **Lucid's access model.** The University of North Carolina at Greensboro disabled the Lucid
  for Education integration in Canvas **effective 2025-08-08**, stating that Lucidchart and
  Lucidspark *"do not currently meet key accessibility standards — specifically keyboard
  navigation and screen reader compatibility"*, against a WCAG 2.1 AA target of April 2026.
  **"Feel like Lucidchart" is scoped to gesture economy and never to its access model.**
  Fathom's Outline — a real document tree that holds focus, mirrors into the picture, and is the
  interface for everybody rather than a parallel structure for screen readers — is a genuine
  competitive advantage and the pivot changes nothing about it.

**One decision to take before code:** the Outline must be defined over the **view graph**, not
the drawn set. `55` §4.5.8 asserts one Outline row per drawn element and CI enforces it;
viewport culling removes elements from the document. Unless the Outline is explicitly the view
graph's rows — with culled rows present and marked off-screen — culling either fails CI or, much
worse, someone weakens the test to make it pass. **It is one sentence in `55` now and a
migration later.**

## 16. Firmware distribution — and the login model, decided

He asked for a decision, so here is one. But **read §16.0 first, because it changes what is
being built.**

### 16.0 Fathom should configure a firmware server, not be one

Nothing in the original research mentioned software licensing, and the pivot makes it decisive,
because decision 3 is multi-tenant. Juniper's generic End User Licence Agreement (November 2020
release, juniper.net, read 2026-08-21) says at §3(c) that *"You may not make any copies of the
licensed Software except as reasonably necessary for archival and 'cold' back-up purposes, but
not for failover or 'warm' back-up purposes"*, and at §4(e) *"you may not allow any other third
party to Use the Software."*

A hosted, multi-tenant Fathom that stores Junos images and serves them to a customer's devices
is a third party holding and distributing that software. A shared image store across tenants is
both a licensing problem and an isolation problem. **I am not a lawyer and the operative
agreement is whichever one his employer signed, so this is not a legal conclusion.** The design
conclusion is clear and it is cheap:

> **RECOMMENDED: Fathom is the *configuration generator* for a customer-operated firmware
> server, not the server. Fathom generates the account file, the SSH server block, the reverse
> proxy site, the exact per-device commands and the checksum manifest. It never holds the
> bytes.**

That removes the licensing question, removes the multi-tenant image-isolation question, removes
hundreds of gigabytes of storage with its own lifecycle problems, and **does not reduce the
value of §17 at all** — which is where most of what he actually asked for lives.

Everything below is the design of the server Fathom configures.

### 16.1 What the devices can actually do — it is not uniform

**Juniper (his primary — SRX/MX/EX run classic Junos, not Junos Evolved; they differ here).**
The single most important sentence found, and it contradicts the obvious design: Juniper's own
documentation says ***"Do not use the scp protocol in the request system software add command to
download and install a software package or bundle from a remote location"***, and tells you to
*"use the file copy command to copy the software package … to the /var/tmp directory"* and
install from the local path. Found on two independent Juniper pages, so not a stale one-off.
**Fathom should generate Juniper's own two-step flow**, never the one-liner.

`file copy` is the richer command and takes FTP, HTTP, HTTPS and SCP.

**Cisco NX-OS** supports FTP, SCP, SFTP and TFTP for image download, and documents passwordless
SCP/SFTP as a first-class feature: the switch generates its own key pair, you append the public
key to the server. Two traps: RSA key sizes are 768–2048 with a **default of 1024**, below
NIST SP 800-131A Rev. 2's floor (*"RSA: len(n) < 2048 — Disallowed"*), so force 2048; and
OpenSSH has refused RSA/SHA-1 signatures by default since **8.8 (2021-09-26)**. The *key* is
fine — OpenSSH's own notes say existing keys automatically use the stronger algorithm where
possible — what matters is whether the device's client can produce SHA-2 signatures, which is a
per-platform, per-version fact.

**Palo Alto PAN-OS** pulls with `scp import software from <user@host:path>`. The worked example
in Palo Alto's knowledge base shows an interactive password prompt and says nothing about keys.

**OPNsense does not fit the model at all** — it updates through a signed package mirror, not by
fetching an image. **Meraki is out of scope entirely** — devices pull firmware from the Meraki
cloud and there is no way to point one at a customer image server. **Say so in the row.** An
interface that offers an "assign firmware" control on a Meraki row is lying to him.

### 16.2 The login model — decided

> **PER-DEVICE KEY, ONE SHARED READ-ONLY ACCOUNT FOR MACHINES, PLUS A SEPARATE HUMAN ACCOUNT
> FOR WRITING.** Not per-user. Not one shared key. Two accounts, no third.

**`fw-pull` — the machines' account.** One Unix account, no shell, chrooted to the firmware
tree, restricted to read-only file transfer at the protocol level. **Every device gets its own
key pair, generated on the device; the private key never leaves it.** Fathom only ever receives
a public key, and **generates the whole authorised-keys file from the inventory**, one line per
device, each carrying `restrict` (which disables forwarding, terminals and startup scripts) and
`from="<management address>"`.

So: **the identity is per-device, the account is shared.** That split is the whole answer, and it
is what makes this survivable at scale — revoking one device is deleting one line and
regenerating one file. Nothing else on the estate changes.

**`fw-admin` — the humans' account**, per person, the only one that can write into the tree. A
device never touches it. **This is the honest version of his "per maintenance login": the
maintenance login is for the person doing the maintenance, not for the equipment.**

**Why not the other two he named.**
*Per-user for devices* is a category error — no human is present when a router pulls at 02:00,
and NIST IR 7966 (October 2015) says *"password authentication is generally not recommended for
automated processes"* and rejects host-based and Kerberos authentication for automation
specifically because neither can carry a command restriction.
*One shared key for everything* fails the day he replaces a switch. NIST again: *"Any private
keys held by a group of individuals should be rotated whenever an individual is removed from the
group."* One decommissioned box means re-keying the entire estate — which at thousands of
devices means it is never done, which means the key is permanent. **Per-device keys make
revocation something that actually happens.**

**Why not an SSH certificate authority** — a considered no, not an oversight. The famous case
(Facebook, Netflix, Uber) is about *many servers* and many humans: the certificate authority
removes the need to push keys to every server. Our shape is inverted — one server, thousands of
clients — so the problem it solves does not exist, and the one file it would save us maintaining
is a file Fathom generates from the inventory anyway. Its genuinely good properties (bounded
validity, revocation by serial) are reproducible on one server with an expiry option in the same
file. **And the blocker: I could not establish that any of his platforms can *present* a
certificate as an outbound client.** Reopen if that is established, or if there is ever more than
one image server.

**Reject rssh and scponly** — the classic tools for this. rssh was removed from Debian testing on
2019-03-06 and CVE-2019-3463/3464 are exactly restriction-bypass-to-arbitrary-command;
scponly's last release is 4.8, January 2008. The current answer is stock OpenSSH and nothing
needs installing.

**Reject TFTP** despite PAN-OS and NX-OS both supporting it: no authentication, no encryption.
If a box can only do TFTP, that is a *finding Fathom records about the box*, not a service it
runs.

### 16.1a WHAT A 2026-09-04 RE-CHECK FOUND, INCLUDING ABOUT §16.1 ITSELF

> **Read this before quoting anything in §16.1.** A session was asked to write the missing Arista
> row and to re-verify the Juniper sentences above, under ADR-0034. It could open neither vendor's
> documentation: **`arista.com`, `docs.arista.com`, `juniper.net` and `supportportal.juniper.net`
> are all refused by that environment's egress policy**, and so is `web.archive.org`. Everything
> below therefore comes from **vendor-authored code and models** — Arista's own GitHub
> organisations, Juniper's published YANG — a DISA benchmark, or named third-party automation.
> Search-engine snippets of the blocked pages were deliberately NOT recorded as established, which
> is the rule working.

**(i) §16.1's headline Juniper quotation is UNCORROBORATED, and that is not the same as wrong.**
The sentence *"Do not use the scp protocol in the request system software add command…"* could not
be confirmed: juniper.net is unreachable, and **a GitHub-wide code search for the exact phrase
returns exactly one hit in the entire index — this file.** §16.1 says it was found on two
independent Juniper pages; nothing outside this corpus corroborates that today. It is neither
confirmed nor refuted. **Do not repeat it to a customer as a vendor quotation until someone opens
the page**, and treat any future session that reports it verified without naming a reachable host
as the ADR-0034 failure it would be.

**(ii) `file copy` has nowhere to put a key — CONFIRMED, and it is NOT the only door. See (vi).**
Established from Juniper's own YANG, and on 2026-09-04 re-read against the named module rather
than a search: `junos-es-rpc-file-mgd@2025-01-01.yang` at 25.2R1 (repository `Juniper/yang`,
commit `96ad7bad`) gives `rpc file-copy` exactly four input leaves — **source, destination,
source-address, routing-instance**. No identity file, no username, no passphrase. So a runbook
step of the form *"configure the device to use key K for `file copy`"* is unbuildable as written.
**An earlier version of this paragraph then concluded that the device half of §16.2 was
unestablished on the primary platform. That conclusion was drawn from one command and it was
wrong by omission — (vi) below is the correction.**

**(vi) CORRECTION, 2026-09-04, LATER THE SAME DAY: THE SRX HAS A DOWNLOAD COMMAND WITH A KEY SLOT,
AND A COMMAND TO MINT THE KEY.** Found by a skeptic checking (ii), and then verified directly
against the vendor's own model — `Juniper/yang` at commit `96ad7bad`, read 2026-09-04, blob
fetched and grepped rather than searched:

- `rpc request-system-download-start` — `junos-es-rpc-request@2025-01-01.yang`, 25.2R1, line 2787;
  present again at 25.4R1, line 2875. Its input leaves, verbatim: `url` *"URL of file"*;
  `max-rate`; `save-as`; **`login` — *"Login credentials (username:password)"*; `identity-file` —
  *"Identity file for sftp pubic key authentication"*** [sic, Juniper's own spelling];
  `passphrase` — *"Passphrase used to protect identity key pair"*; `delay`.
- `rpc generate-ssh-key-pair` — same module, line 4630 — *"Generate SSH key pair identity"*, with a
  mandatory `identity-name` and an optional `passphrase`.
- **The CLI spellings, verified later the same day** from the `rpc-with-extensions` variant of the
  same module (`.../junos-es/rpc-with-extensions/models/junos-es-rpc-request@2025-01-01.yang`,
  25.2R1): `junos:command "request system download start"` and
  `junos:command "request security ssh key-pair-identity generate"`. **The bench test is written:
  `docs/80-review/evidence/2026-09-04-firmware-bench-test.md`**, precise for the SRX, exploratory
  and labelled so for EOS; the owner confirmed he has both boxes (`70` §20.3).

**So on the SRX, Juniper models both halves of §16.2's device side**: a command that mints a named
SSH identity on the box, and an SFTP download command that accepts one. What is NOT established —
and is exactly the bench test — is whether the `identity-name` the first command mints is what the
second command's `identity-file` expects, and whether that path exists on MX and EX (their
`junos-rpc-request` modules were not read). **Two consequences.** First, §16.2's device half is
*documented but unproven* on the primary platform, which is a much better position than
*unestablished*, and the test is thirty minutes on one real SRX or a vSRX. Second, **the `login`
leaf is the shared-password path**, vendor-documented on the same command, and it is the one line
a generated runbook must never emit — the rejection §16.2 made is now tied to a leaf by name.

**Arista is unchanged by this: (iii) stands.** Nothing found establishes key authentication for an
EOS image fetch.

**(iii) The same question is open on Arista, and the only evidence points the wrong way.** No
Arista source establishes passwordless key-based SCP as an outbound client, nor that a switch can
generate its own client key pair. The one real-world example found — third-party, and flagged as
such — answers an interactive `Password:` prompt with a stored password. **If EOS can only
authenticate with a password, `fw-pull` on an Arista estate is a shared password in the
automation, which is exactly what §16.2 rejected.** Write the Arista row as OPEN on this point and
make it the first question asked of a real switch.

**(iv) The Arista row, marked with its provenance rather than pretending to §16.1's confidence.**
Established from Arista-authored files: `copy` takes `scp:` and `http://` sources and `flash:`,
`extension:` and `certificate:` destinations; the boot pointer is `/mnt/flash/boot-config`
containing `SWI=flash:/<image>`; and `management ssh` → `hostkey client strict-checking` exists.
**Four things are UNESTABLISHED and belong on the face of the row: client keys, any RSA size
floor, RSA/SHA-2 capability, and whether HTTPS with a private CA works at all.**

Three traps in it are worth more than the established facts:

- **The obvious two-step flow is the OLD one.** Every current Arista tool opened uses one verb,
  `install source <url>`, and never issues `boot system`; the `copy` + `boot system` example is
  from an EOS 4.15-era repository. §16.1 tells us to generate Juniper's own two-step flow because
  Juniper says so — **for Arista the finding is the mirror image: generate Arista's one-step flow**,
  falling back only where `install source` is absent. Which releases have it is unestablished.
- **Three incompatible command spellings, all from Arista's own material** — `copy scp:user@server/path`
  (no double slash), `copy scp://user@host/path`, and a bare `scp user@host:/path`. A generator must
  emit one, and the vendor's own documents disagree. **And real automation puts a VRF token BETWEEN
  source and destination** (`copy scp://…/img vrf mgmt flash:/img`), so a generator that omits it
  fails on any estate with management in a VRF, which is most of them.
- **CloudVision already does this job.** Its change-control actions download by URL and set the
  image, skipping by SHA-512. **An Arista estate running CloudVision has image distribution solved
  and centrally recorded**, so the row should ask whether CVP is present before offering anything —
  the same honesty the Meraki row already applies by saying the feature does not apply.

**(v) One more, which decides how an operator checks an image.** From EOS 4.27.2 a single SWI can
CONTAIN MULTIPLE IMAGES, and Arista's signing tool prints a SHA-256 per contained optimisation as
well as a whole-file one, while CloudVision compares SHA-512. *"Publish a SHA-256 beside every
image"* is therefore ambiguous on modern EOS: **name the algorithm and say which number it is.**
And on EOS as on Junos, the tamper defence is the **signature**, not the checksum — the checksum
catches a truncated download, which is the common failure and not the attack.

### 16.3 Three corrections the review found, and they are not cosmetic

**(a) The elegant read-only mechanism probably does not work for Juniper, and it is not a
version problem.** Juniper's own release notes (Junos Evolved 24.2R1, open issue PR1787659, read
2026-08-21) state that even on OpenSSH 9.0 and above, `scp` invoked **from the Juniper CLI**
uses the *legacy* SCP protocol, while `scp` from the shell uses SFTP. `file copy scp://…` is a
CLI command. Legacy SCP requires executing the remote user's shell, and an SFTP-only account
refuses it with *"This service allows sftp connections only."* **This must be tested against a
real SRX before anything is committed to.** It is a large part of why the design has two doors
rather than one.

**(b) The per-key logging wrapper cannot run.** The original design had both a forced command in
the server block *and* a per-key command wrapper "that logs which device pulled what". These are
mutually exclusive — the server-block one always wins. **The fix is in NIST IR 7966 already:**
*"All SSH servers should be configured to log key fingerprints for access based on SSH
authorized keys."* Turn on verbose logging and the server records the key fingerprint on every
authentication; Fathom generates the file, so Fathom holds the fingerprint-to-device map.
No wrapper needed.

**(c) The HTTPS door has no documented escape hatch on his boxes.** <!-- CORRECTED 2026-09-04:
the CONCLUSION below stands and the REASON was backwards. See §16.1a. --> `file copy`'s
`no-check-certificate` option was said here to exist **only on Junos Evolved (added 23.1R1)**, with
classic Junos lacking it. **Juniper's own YANG says the reverse mapping**, read 2026-09-04: the
option is ABSENT from Junos Evolved's `file-copy` at 24.4R2 and 25.2R1, ABSENT from SRX/EX/M-MX
`file-copy` at 24.4R2 and 25.4R1, and PRESENT on classic Junos NFX's `file-mgd-copy` from 23.2
through 25.4. **The operative consequence for SRX, MX and EX is unchanged and confirmed** — no
certificate-check bypass on the primary platform — but the stated reason was wrong, and the
corrected reason must not be read as quietly reopening the door. A related trap: the same
`no-check-certificate` NAME appears inside the large rpc-request modules as a `type string` beside
`cert-file`, where it belongs to event-options archive-site uploads. **A grep that finds the string
and concludes the platform supports skipping the check on file copy will be wrong.** So if a private certificate authority cannot be trusted
*and* validation cannot be bypassed, **the HTTPS door does not open on his primary platform at
all.** Test this on a real SRX before declaring HTTPS the primary door.

### 16.4 Two doors, one tree, and the URL question

1. **HTTPS through a reverse proxy** — the door that can carry a link, needs no host-key pinning
   on the device, and is subject to §16.3(c).
2. **SSH/SFTP** — mandatory, because PAN-OS `scp import` is the only route onto a Palo Alto box
   short of the web interface, and NX-OS documents passwordless key auth.

**Publish a SHA-256 beside every image**, because `file checksum sha-256` exists on the box
(since Junos 9.5) and gives the operator a check he can run. **But do not let it imply it is the
tamper defence.** Juniper's Verified Exec already means *"only executables with a verified
fingerprint will run"* — a tampered image is caught by the device regardless. **The checksum
detects a truncated or corrupted download, which is a real and common failure.** Say that, and
he will not over-trust it.

**On his "unique URL per device" idea.** The literature calls this a *capability URL*; the W3C
Technical Architecture Group's finding (2014-10-30) defines it as one where *"an agent who
possesses the URL is given the capability to access the information"*, and recommends HTTPS,
expiry, 120+ bits of entropy and rate limiting. It is real and it is buildable. **But be honest
about what it is: a bearer credential — and our leak path is not a browser, it is the device
config and `show log`, where colleagues can read it.**

- **Stable, named URL** for the runbook — and **do not protect it with a password in the URL.**
  The original design recommended embedded HTTP Basic credentials, which is a shared, static,
  non-expiring password written into every device config; by its own critique that is worse than
  the signed link it was hedging against. **Use a source-address allowlist, or the SSH door.**
- **Ephemeral signed URL**, minted by a button, expiring in minutes to hours, single-use by
  default with expiry as the backstop, journalled with who minted it for which device. Sign it
  in Fathom's own Rust, not with nginx's `secure_link` module — that one hashes with MD5 and is
  not compiled in by default.
- **The interface must say, in the sentence that mints it: THIS LINK IS THE PASSWORD.**
- **And this creates a self-inflicted secret nobody has raised.** Fathom's own signed URLs will
  end up in device configs and come back to Fathom on the next paste. Under §3's union rule the
  gate must learn to destroy Fathom's own URL shape, with two independent detectors like every
  other declared secret, and a canary bounded by what a real signed URL looks like rather than by
  what the detector wants. **Design it in from the first line.**

### 16.5 The manual half, which nobody has priced

Fathom may never connect to a device (invariant 2). So every one of these is a hand-touch, per
device, across thousands:

- pinning the server's host key into each Junos box, or the unattended pull sits at a fingerprint
  prompt forever;
- generating the per-device key pair — and this is **worse on his primary platform** than it
  looks. NX-OS has a first-class command. Junos *Evolved* has one (22.3R1). **Classic Junos has
  neither: the documented route is dropping to the root shell on each device.**
- installing private-CA trust, if §16.3(c) requires it.

**At thousands of devices this — not cryptography — decides whether the feature is ever used.**

Two more things absent from every version of this design: **the server's own host key is a
single point of estate-wide failure** (rebuild the server and every device silently stops
pulling), and **Juniper's staging directory needs space equal to the file and the device space
equal to twice it**, which bites precisely on files this size; `no-stage` fixes it and arrives
only at 24.2R1. And **thousands of devices pulling a multi-gigabyte image at once is a
thundering herd** — Meraki solves exactly this with staggered batches, which is the shape of the
answer. The interface must not offer a button that starts two thousand simultaneous transfers.

## 17. Firmware in the inventory

**Firmware is a column, not a page.** He already has the screen; do not build a second one.

1. **Two cells on the Device row**: `running` and `target`. A third cell is a **word**:
   `matches`, `differs`, `not known`. **No colour** — `51` R1 reserves the three risk colours
   and firmware compliance is not risk. This is also what `55` requires anyway, since no
   component may encode meaning in colour alone.
2. **Assignment is a ladder, three rungs, one gesture: platform → model → device.** Because
   `Device.platform` and `Chassis.model` are *already* inventory columns, "all devices of this
   model" is filter-the-column, select-all, assign. **His group function is the inventory's
   existing selection.** No new view and nothing to learn.
3. **Precedence stated once and shown on every row**: device beats model beats platform, and
   each row says where its target came from — *"from model SRX345"*. **Fathom already has this
   idiom**: `LayoutPin` is a computed value with a visible hand-override marked in the picture
   and on the Outline row. Reuse it; do not invent a second vocabulary for the same concept.
4. **The at-a-glance answer is a count, not a colour.** The kind strip gains
   `Device 41 · 6 differ`. Clicking it filters to those six.
5. **The findings view gets its first real job.** `57` §14.1 already proposes it as *"what the
   estate does not know yet"*. Firmware writes its first two sentences: *"17 devices have no
   recorded software version"* and *"6 devices are not on their target version."*

**Build it in this order, and note the first step serves no files at all:**

**(a) Populate `os_version` from a paste.** The field already exists in the schema, already
renders as an inventory column, and is already writable by the author form — and **nothing
populates it from a config**; `grep -rn os_version crates/fathom-ingest/` returns nothing. It is
hand-entered only. **Cheapest possible win.**

**(b) Add `target`, the three-rung ladder, the precedence marking, the counts and the findings
sentences.** Now he can *see* the estate's firmware position with no image server in existence.
**This alone is most of what he asked for.**

**(c) A version comparator, and it is a bigger job than it sounds.** `OsVersion` is an opaque
string today, so `differs` is free and `older` is not. `schema/platforms.yaml` already declares
a version scheme per platform (junos, panos, iosxe, nxos, eos, fortios, opnsense), so the place
is marked out — but each needs its own vendor lookup under ADR-0034 to get the ordering right.
Junos's `21.4R3-S5` alone has release, revision and service-release components. **Until it
exists, say `differs` and do not guess.**

**(d) Then the server configuration generator** (§16.0), and **(e)** the gate detector for
Fathom's own signed URLs, before the first one is ever minted.

**One risk to design against:** `os_version` is only as fresh as the last paste. **A firmware
compliance view that quietly shows stale data is worse than an empty one, because it will be
trusted.** Every version cell carries *when* it was learned, in the same spirit as `placed by
hand`, and **`not known` must be a first-class answer that appears often**, not a rare edge case.

## 18. What carries over, what is retired

**The fork is much smaller than "start again", and this remains the most useful fact anywhere in
the corpus.** Thirteen of sixteen crates are platform-neutral Rust with zero external
dependencies, and their **656 tests already run natively on Linux rather than in a browser**.

| crate | status |
|---|---|
| `fathom-schema`, `fathom-schemagen`, **`schema/`** | **shared, never forked.** The crown jewel. 48 kinds, 89 edges, 61 scalars, and it transfers unchanged |
| `fathom-ir`, `fathom-id`, `fathom-canon`, `fathom-corpus` | transfer unchanged |
| `fathom-ingest` | transfers, **and also compiles to the browser gate** (§3 decision 1) |
| `fathom-weld` | transfers |
| `fathom-graph` | transfers as *types*; **its lifecycle does not.** Single-estate, in-memory, no eviction, `OP_PASTE` replaces what is held. This is the real work |
| `fathom-layout` | transfers, **with the two complexity fixes in §8** and every byte-driven deletion re-judged |
| `fathom-inventory` | transfers; gains the firmware columns and the editable cells `57` §14.1 already proposes |
| `fathom-emit` | **transfers and is finally linked.** `47` §11's refusal is void; the config view becomes possible |
| `fathom-find` | transfers; and the finder as *specified* (`16` §16.1) walks the user's graph, which it can now do server-side without the module-boundary worry that made moving it out unattractive |
| `fathom-workspace` | transfers in shape; its one-JSON-line persistence is replaced by §7's tables |
| **`fathom-wasm`** | **re-scoped, not retired** — the ingest gate and nothing else (§1) |
| **`fathom-artifact`** | **retired.** There is no single HTML file to assemble |

**And one thing that must not be lost in the transcription:** `48` §2's rule.

> **FORK THE APP, NOT THE VOCABULARY.** If each side grows its own kinds and fields, exports
> stop being interchangeable and neither can read the other's — and nobody notices until they
> try.

**The generated database tables in §7 are how that rule is kept in the database too.**

## 19. The phases, and what each named feature lands in

**This is one person. The phases below are ordered so that each one is usable on its own, and so
that the two decisions that are free now and brutal later are taken in phase 0.**

Durations are reasoned from the shape of the work, not measured. This project's own convention —
`79`'s route document was written from measurements *because estimates had proved unreliable* —
says to distrust them accordingly.

### Phase 0 — the decisions and the free preconditions (days)

Nothing here ships a feature; everything here is expensive later.

- **Every operation carries a real author identity and a server-assigned sequence number**, from
  the first line of server code, whether or not anything reads them yet (§10c). The op crate
  already reserved the space.
- **`OP_PASTE` becomes "add to this design", never "replace it"** (§10b).
- **Record what a paste *produced*, and replay the product, not the parser** (§10a).
- **Fix the exact-secret-length leak** (§3 decision 2a).
- **`cargo audit`, `--locked`, gate-zero as a real control** (§6.1) — before the first dependency.
- **Answer open decisions 1 and 2** (§22): invariant 4, and where tenancy lives.

### Phase 1 — the platform (weeks, plural)

- **Accounts, sessions, passwords, passkeys, invitations, roles, admin** ✔ *his list: accounts,
  admin*
- **Multiple designs, and organisations** ✔ *his list: multiple designs* — this is what makes the
  store multi-estate, and it is the largest single change to `fathom-graph`
- **Multi-tenancy with row-level security, and the cross-tenant test** (§11)
- **Postgres persistence of the store, and generated projections** (§7)
- **Reverse proxy in front, terminating TLS** ✔ *his list: reverse proxy.* For the hosted
  service, **Caddy** — it obtains and renews certificates automatically in about three lines.
  This reverses `43` §5.3, whose in-process TLS decision was argued for air-gapped and
  internal-CA customers; **keep that path for the self-hosted enterprise build.** Two deployment
  shapes, one binary. `43` §5.4's compose file — pinned digest, read-only filesystem, non-root,
  all capabilities dropped, no-new-privileges, the binary as its own healthcheck — survives
  almost unchanged and is good work.
- **SMTP** ✔ *his list.* **Speak SMTP to a transactional provider; do not run a mail server.**
  Since the Gmail and Yahoo bulk-sender requirements took effect in February 2024, SPF, DKIM and
  DMARC are a condition of delivery rather than advice, and a new address from a small host
  starts with no reputation. For a solo maintainer that is a standing unpaid job with a **silent**
  failure mode: your password-reset mail vanishes and nobody tells you.
- **Operational logging** ✔ *his list: logging*
- **Bound the layout scope, and fix `allocate` and `crossings`** (§8)
- **Prefix containment search** (§7.1) — it falls out of the projections for very little extra

### Phase 2 — the product people use (weeks to a couple of months)

- **Sharing a design with named people, and roles** ✔ *his list: sharing*
- **The audit log, built as its own thing from the start** ✔ *his list: auditing* — growing it
  out of operational logs later does not work
- **The visual pass** (§14 items 1, 2, 4, 5, 7, 8) — a session's work, drags in nothing, and
  lets him *see* the direction. **Land the reserved-colour and no-raw-hex lints `51` §3.3
  specifies BEFORE the visual pass, not after**, because the team is about to copy idioms from
  two applications that both add a green for "healthy".
- **Fix the inventory's three-region defect** (`57` §16) — the diagram's ledger collapse applied
  to the inventory too. Its browser drivers will break exactly as the diagram's three did, and
  the three-line helper in the existing hand-link driver is the fix.
- **The firmware inventory columns** ✔ *his list: firmware, part one* — §17 steps (a) and (b),
  which is most of the firmware value and needs no image server
- **Presence, not editing** ✔ *his list: live editing, part one.* Show who else has the design
  open and where they are looking, plus a soft lock — *"Dana is editing this box."* **That is a
  few bytes broadcast per person, needs no merging at all, and for a two-to-five-person network
  team it removes most of the pain live editing exists to remove.**

### Phase 3 — the hard parts (months)

- **Live co-editing** ✔ *his list: live editing, part two.* Server ordering, optimistic echo and
  rollback, reconnection and catch-up, remote cursors on the canvas overlay, and `33` §4.6's six
  property tests. **The largest single piece of work in the pivot, and the one most likely to
  produce a silent data-loss bug.**
- **The navigation spine** (§14's icon rail, virtualised search-first list, breadcrumb ladder,
  nested submenus) — real design work that should wait until the routing exists, or it gets
  rebuilt
- **The Lucidchart gestures** (§15 items 1–4) — the operations they terminate in already exist
- **The zoom ladder's missing rungs and the grouping level inside Site** (§8)
- **Firmware server configuration generation** ✔ *his list: firmware, part three* — §16

### Phase 4 — later, or never

- Version comparators per platform (§17c)
- Offline and reconnection behaviour beyond catch-up
- Client-held keys, if decision 4 lands that way
- Anything that requires the server to hold vendor firmware images (§16.0 says: probably never)

## 20. What this plan cuts, and why

**Ship presence before you ship co-editing, and let the answer decide.** Phase 2's presence
feature is a few days of work and removes most of the pain. Phase 3's co-editing is months.
**Run presence for a while and measure how often two people actually touch the same box in the
same minute.** For a two-to-five-person network team the honest answer may be "almost never", in
which case a soft lock is the whole feature and the months go somewhere else. This is the single
biggest scope decision in the document and it costs nothing to defer.

**Cut Fathom-as-firmware-host entirely** (§16.0). Keep Fathom-as-firmware-configurator. This
removes the licensing exposure, the storage, the image lifecycle and the thundering-herd
problem, and keeps everything he actually described wanting.

**Do not build a rules engine, a graph database, a canvas or WebGL renderer, a CRDT, or your own
cryptography.** Each is refused above with a reason that survives the pivot.

**And say the honest thing about what the pivot costs, because nobody has:**

- **A hosted service acquires an availability promise on day one**, whether or not anyone wrote
  it down. That is a lifestyle change, not a technical risk, and it is the one most often
  discovered rather than decided.
- **A database to back up, restore, migrate and upgrade, forever.** `41` §5.3's requirement S4 —
  *"backup by copying a file, by an operator with no database skills"* — is genuinely lost.
  Mitigate with a compose file, a `fathom backup` command wrapping `pg_dump`, and a documented
  restore drill. Not with a weaker engine.
- **Zero external dependencies becomes about 109 crates** before Fathom's own cryptography, in
  the same month a build-script supply-chain attack against crates.io was published. **That is
  the project's greatest current security advantage, and it is about to be spent. Spend it
  deliberately.**
- **The ordinary multi-tenant obligations nobody has listed:** backups of customer data and
  custody of the backup key; breach notification and a data processing agreement; tenant data
  export on offboarding; and the audit log an employer's security review will ask for.

## 21. What could not be established

Per ADR-0034, this list is part of the answer. **Nothing here should be filled in from memory by
the next session.**

**Security and storage**

1. **No formal security audit of any Rust HPKE implementation.** rozbb/rust-hpke's own README
   says no paid audit exists, and cites a Cloudflare review of **version 0.8** against a current
   0.14.x line. The formally-verified alternative has thirteen documented escapes (§3 decision
   5). This is the one place the fork would ship an unaudited implementation of a
   security-critical primitive; **do not let it inherit `chacha20poly1305`'s approval.**
2. **No audit statement found for `x25519-dalek` or `curve25519-dalek`.**
3. **The NCC Group RustCrypto report's actual findings.** Engagement, scope and publication date
   confirmed from NCC Group's own page; the PDF was not opened. The "no significant findings"
   claim comes from the crate README as recorded in the existing decision file.
4. **NIST SP 800-57 Part 1 Revision 6** — an initial public draft dated 2025-12-05 exists and
   was not opened. Check whether it is final before citing key hierarchies or cryptoperiods.
5. **Whether any shipping end-to-end-encrypted collaborative product handles a document of the
   size the pivot implies.** CryptPad proves the mechanism. Nothing found proves it at thousands
   of devices with concurrent editors. **This is the largest unquantified risk in the security
   recommendation, and it should be measured with a synthetic estate before the encrypted path
   is committed to, not argued about.**
6. **Whether a Proxmox virtual TPM is trustworthy for key sealing.** `tpmstate0` with TPM v1.2
   and v2.0 is confirmed available. What a software-emulated TPM whose state file lives on
   storage the host administrator can read actually protects against was **not** established.
   **Do not assume it gives the same guarantee as discrete hardware.**
7. **`38` §14.3 rows 6, 7 and 8 remain unverified** — swap and hibernation, panic messages
   quoting config lines, and load-balancer TLS termination.

**Firmware and devices**

8. **Whether any of his platforms can *present* an SSH user certificate as a client.** Junos
   22.4R1 added certificate-based SSH, but every documented statement configures the device's
   own server side. **This is the load-bearing negative under the rejection of a certificate
   authority; it is "could not establish", not "cannot".**
9. **Which certificate trust store classic Junos uses for `file copy https://`, and how to
   install a private authority.** Combined with §16.3(c) — no bypass option on classic Junos —
   this is a potential hard blocker on the HTTPS door. **Test on a real SRX first.**
10. **Whether PAN-OS `scp import software` supports key authentication** rather than an
    interactive password. If it is password-only, PAN-OS needs a different credential story
    from everything else.
11. **The exact classic-Junos release at which the bundled OpenSSH crossed 9.0.** The 9.4
    evidence is for Junos Evolved on ACX/PTX — the wrong operating system and the wrong
    platforms. Juniper's Feature Explorer returned HTTP 503 on retry.
12. **Whether classic Junos accepts TFTP for `request system software add`.** The Evolved page
    lists it; the classic page does not. Does not change the design, which rejects TFTP anyway.
13. **Whether an outbound SSH identity key generated on a Junos box survives a software
    upgrade** — which matters enormously, because the upgrade is the exact event that would
    silently break the next pull.
14. **Whether OPNsense will accept a mirror signed by anyone but OPNsense.** Read largely through
    a third-party summary rather than the primary source, which is weaker than every other
    platform finding here.
15. **NIST SP 800-57's recommended lifetime for an authentication key pair.** NIST IR 7966 defers
    to it by name; it was not opened, which is why no number appears in §16.

**Scale, rendering and product**

16. **The pan/compositing question in `44` §4.7.1 is still open** — whether browsers composite a
    transform on an SVG group or re-rasterise the subtree. The only direct claim found is an
    anecdotal issue with no measurements, versions or element counts. **The recommendation routes
    around it (camera as a CSS transform on an HTML container, which is what tldraw ships) rather
    than answering it.** The measurement should still be run: a 1,700-element scene, a scripted
    five-second pan, frame commit timestamps from a real trace.
17. **A single SVG-versus-canvas crossover element count.** Published guidance spans two orders
    of magnitude and the spread is explained almost entirely by whether culling exists. The one
    academic measurement found (Horak et al., 2018) would not decode. **Treat every number as a
    vendor's claim about their own product.**
18. **Whether a mature Rust library exists for server-authoritative collaboration rooms.**
    Searching found hobby projects only.
19. **Where Lucidchart computes its layout** — client or server. Only marketing material was
    found. §5(a)'s recommendation is argued from Fathom's own determinism requirement and from
    Figma's documented model, not from Lucidchart.
20. **The `inet_ops` non-default note in a *current* PostgreSQL doc page.** It was read from the
    9.4 copy; the current copies returned 404 three times. Confirm on the deployed version before
    writing the index.
21. **Whether `rustls`'s C-bearing crypto provider actually appears in the chosen closure.**
    Dependency resolution differed between two scratch builds. **Resolve it on the real manifest
    before committing to in-process TLS**, because C7 depends on the answer.
22. **On-disk size of a real estate in PostgreSQL.** The 175.7 MB figure is in-memory with no
    field values set. **Do not quote a byte figure for the database until someone loads a real
    estate and measures it** — `47` §9.3 records a byte claim withdrawn after a second
    measurement, and this project has form.
23. **Whether `fathom-emit`, `fathom-find` or `fathom-weld` have their own scale defects.** Only
    the store and the layout crate were measured.
24. **The identification of "Zerobyte".** nicotsx/zerobyte is by far the best fit, but a
    SourceForge project and a separate GitHub organisation of similar name were not ruled out.
    **Worth thirty seconds of the owner's time to confirm.**
25. **Neither reference product was seen running.** Every density figure in §14 is estimated off
    a screenshot. **If his affection is really about how it *feels* to move around Termix rather
    than how it looks, §14 has characterised the wrong half** — and someone should run both
    products for an hour.
26. **Nothing in §14 or §15 has been rendered in a browser**, which is the standard this project
    holds every other claim to, and the same gap `57` §14.4 admits about its own week of design.
27. **Whether the journal's command-log problem has already bitten.** The mechanism is
    established from the source and from the literature. **It was not tested** — nobody replayed
    an old journal through the current build to see whether the estate differs. That test is
    cheap, it is exactly the kind of browser drive this project already does well, and it would
    turn §10a from a reasoned claim into a measured one.

## 22. Open decisions — the owner's

Each with the consequence, in plain language.

1. **Does the server hold the keys, or does the browser?** (§3 decision 4.) *If the browser:*
   you can honestly say "we cannot read your network", and you give up server-side search,
   server-side drawing and export, any ability to recover a customer's account, and much of the
   schema validation — and you take on hand-building the sync protocol. *If the server:* the
   product is much cheaper and faster to build, and every marketing sentence changes. **Most of
   §5 to §13 assumes the server holds them.**
   ~~**IN PROGRESS 2026-08-28**~~ **CLOSED 2026-09-03 — ADR-0040.** The owner delegated this
   to evidence on 2026-08-28 (`70` §18.1: *"what is the most secure but optimised way of
   handling this? … others should have made similar secure products. This is enterprise level
   though keep in mind"*), the ADR-0034 survey ran the same day, and he ratified it today by
   saying *"start working on the server version."* **The server holds the keys and says so:**
   a data key per tenant and per design from the first stored byte, wrapped so a
   customer-supplied master key can replace the house key later without re-encrypting data;
   the switch's destination is customer-managed keys (the market's enterprise tier, which
   Lucid itself sells) and its trigger is **the first customer who is not the owner**; the
   words *zero-knowledge*, *end-to-end* and *we cannot read your data* are forbidden until
   that is true for a given customer. Invariant 4 is **scoped, not deleted**, in
   `.context/conventions.md`. `38` §14's union rule is ratified alongside it.
   **With this, §19's phase 0 has no open item left — phase 0 is complete.**
2. ~~**Do organisations, users and designs go inside `schema/` as node kinds, or outside it as
   ordinary server tables?**~~ **ANSWERED 2026-08-28: outside, as ordinary server tables**
   (`70` §18.2 — *"what does users and orgs have anything to do with the graph? … would be
   seperated from graphs and networks?"*). The question read as strange to him because the
   answer was obvious to him. §11 is unblocked. The answer also volunteered a phase-1
   requirement nothing had captured: **enterprise customers may bring LDAP or Active
   Directory**, so §12's sign-in design must admit a customer directory as the source of
   truth for who exists.
3. **Does dark become the default theme?** (§14 item 2.) This reverses `51` §5 and ADR-0026,
   which gated dark behind three conditions — two of which were byte- and diagram-scoped and are
   now moot. Both references are dark-first. **Shipping dark-first without reopening ADR-0026
   would be exactly the kind of quiet precedent-breaking this corpus is careful about.**
4. **Does `--radius` move from 0 to 2px?** (§14 item 1.) Your stated preference against `51`
   §10's argument — which Zerobyte empirically refutes, because it runs 10px with no shadows and
   cards the same colour as the page.
5. ~~**Does `PhysicalPort.label` become optional?**~~ **ANSWERED YES 2026-08-28 and executed
   the same day** (`70` §18.3 — *"absolutely, one of the main features is to be able to create
   essentially a lucid chart with no information, then a user can go in and fill in info as
   needed"*). Schema 0.4 relaxes the card to `0..1`, priced minor by `62` §16.2. All of `57`
   §12–§13 — cabling mode, drag-then-annotate, the port prompt — is now buildable; the next
   question that work meets is `57` §14.1 B3, where `PhysicalPort`s come from.
6. **Does invariant 1 formally become mode-scoped?** `48` open decision 1, still open. The client
   mode it governed is now being dropped entirely, which arguably settles it by attrition — but
   `.context/conventions.md` still states it unconditionally and several documents argue from it.
7. **`Device.platform` and the missing general-purpose host.** ADR-0037 §5 prices three routes
   and chooses none. **Direction set 2026-08-28, narrow wart still open** (`70` §18.4): the
   owner chose engines over a catch-all — *"proxmox would probably need to be an engine"* —
   so hosts earn registry rows and dictionaries the way network vendors do (the `proxmox`
   vendor row is registered; the platform row waits on the `64`-style survey). What a
   hand-added box with NO engine declares as its platform is the remaining question, now to
   be answered inside that direction. And the Proxmox example this row used was the corpus's
   illustration, not his estate — he flagged it, and it should not be repeated as his.
8. **Do you want Termix's eight terminal themes?** They would probably delight you, and as
   specified they let a cosmetic setting redefine the risk colours. **Answerable only in the
   form: pin the three risk colours outside the theme system and let a theme move only the
   chrome.** Say if you want it and it can be designed that way.
9. **Which platforms do you intend to offer first?** (§3 decision 2b.) Seven of the ten
   registered platforms have no dictionary, so the *"there is no credential to steal"* sentence
   is fully earned on Juniper and materially weaker elsewhere. **The answer sets the work.**
10. **Do you want Fathom to host firmware images at all, given §16.0's licensing finding?** My
    recommendation is no — generate the configuration for a server your customer runs. **If you
    disagree, that needs a real answer from whoever holds the vendor agreements, not from me.**

## Failure modes

- **Nothing here is built.** Every duration is reasoned rather than measured, and the two
  measured things in this document (the layout timings in §8, the dependency counts in §6) are
  labelled as such precisely because nothing else is.
- **Decision 4 is unresolved and most of this document depends on it.** If invariant 4 survives,
  §§5–13 need re-doing against `33` rather than against Figma, and `33` becomes the plan rather
  than a source.
- **The colour collision is the live danger in §14.** If anyone ports a component-library
  palette or a Termix theme in without reading `51` R1, Fathom silently acquires a second meaning
  for green and the risk enum stops being trustworthy. **This is the failure mode most likely to
  actually happen, because both reference products do it and it looks harmless.**
- **Culling can silently break the Outline bijection** (§15's closing decision). Either the
  Outline is redefined over the view graph, or the test fails, or — much worse — someone weakens
  the test to make it pass.
- **Fixing `allocate` and `crossings` changes pictures.** Both are pinned by determinism tests. A
  faster crossing counter must count the *same* crossings and a faster colouring must produce the
  *same* slots, or every diagram in every change ticket moves. Property-test new against old on
  the same fixtures before deleting the old.
- **The benchmark shape in §8 is one shape** — one site, many identical devices. Real estates
  have deeper containment and denser zone membership, which makes the routing band worse, not
  better. **Treat those figures as a floor.** They are also measured at full optimisation, while
  the shipped profile optimises for size, so the real product is slower by an unmeasured amount.
- **The redaction gate's known holes are still open and get worse on a server.** `redact.rs`
  documents `mmonitUrl` as a gap the current instruments *"categorically cannot"* catch — a URL
  with credentials in it passes through verbatim. On one laptop that is a bad day; in shared
  multi-tenant storage it is a credential in somebody else's database. And the class the
  `simple-password` and `trap-group` fixes exposed — **secrets under names with no credential
  word** — is named and not closed.
- **This document has not been adversarially reviewed as a whole.** Two of its six input threads
  were; four were not, and the reviewed two came back with five corrections and nine omissions
  each, which is the base rate to expect from the other four.

## Sources consulted

| what | where | when |
|---|---|---|
| The pivot's four decisions, verbatim | conversation | 2026-08-18 |
| Layout scale, phase split, memory, fold cost | measured on this machine; instrumented copy in a scratch directory, **repository unmodified** | 2026-08-21 |
| Dependency closure counts (sqlx 124, tokio-postgres 58, full stack 109/145) | `cargo add` + `cargo tree` in throwaway crates | 2026-08-21 |
| All crate versions and download counts | crates.io API, queried directly | 2026-08-21 |
| Supply chain attack on `arrayref` | blog.rust-lang.org; RUSTSEC-2026-0260 | published 2026-08-20 |
| lettre BoringSSL hostname-verification advisory | RUSTSEC-2026-0141 | 2026-05-14 |
| Figma's multiplayer model, verbatim | figma.com engineering blog | read 2026-08-21 |
| Lucid's operational transformation and its costs | lucid.co/techblog | post 2021-04-07 |
| Lucidchart gesture mechanics; auto-arrange complaints | Lucid help centre (via search extracts — the pages 403 to automated fetch), Lucid community threads, an independent long-form review | read 2026-08-21 |
| Lucid accessibility removal from a university LMS | its.uncg.edu | effective 2025-08-08 |
| CryptPad's blind-server model and trust assumptions | docs.cryptpad.org, docs build 2026.5.0 | read 2026-08-21 |
| Excalidraw's client-side encryption | plus.excalidraw.com blog | 2020-03-21 |
| Proton on losing server-side search | proton.me engineering blog | 2022-08-31 |
| NetBox removing its secrets store | netboxlabs.com v3.0 release notes | released 2021-08-30 |
| Nautobot storing a pointer, not a value | docs.nautobot.com | read 2026-08-21 |
| PostgreSQL encryption options, `inet`/`cidr`, network operators, row-level security | postgresql.org docs 18 (and 9.4 for the GiST class) | read 2026-08-21 |
| SQLite's single-writer WAL; five storage classes | sqlite.org | read 2026-08-21 |
| Argon2id and session parameters | OWASP Password Storage and Session Management cheat sheets | read 2026-08-21 |
| Logging must/never lists | OWASP Logging Cheat Sheet | read 2026-08-21 |
| Authentication policy | NIST SP 800-63B-4 | final 2025-07-31 |
| Cryptographic Erase as a Purge method | NIST SP 800-88 **Rev. 2** | final 2025-09-26 |
| Automated SSH access, key rotation on group change, fingerprint logging | NIST IR 7966 | October 2015 |
| RSA minimum key size | NIST SP 800-131A Rev. 2 | read 2026-08-21 |
| Junos: "do not use scp"; `file copy`; `no-check-certificate` (Evolved 23.1R1); staging directory; known-hosts; `file checksum sha-256`; Verified Exec; `$9$` reversibility | juniper.net CLI reference and documentation, two independent pages for the scp instruction | read 2026-08-21 |
| Junos CLI still using legacy SCP on OpenSSH 9+ | Junos Evolved 24.2R1 release notes, PR1787659 | read 2026-08-21 |
| NX-OS image protocols and passwordless key setup | cisco.com Nexus 9000 guides 9.3(x) | read 2026-08-21 |
| PAN-OS `scp import software` | Palo Alto knowledge base | created 2018-09-25, modified 2023-06-15 |
| Meraki cloud-only firmware; staggered batches | documentation.meraki.com | read 2026-08-21 |
| FortiOS `set psksecret` | Fortinet Document Library, FortiOS 6.2.0 and 8.0.0 | read 2026-08-21 |
| OpenSSH `-R`, `ForceCommand`, `ChrootDirectory`, `restrict`/`from=`, legacy scp requiring a shell; 8.8 and 9.0 release notes | man.openbsd.org, openssh.org | read 2026-08-21 |
| rssh removal and CVEs; scponly's last release | Debian tracker, NVD, project pages | read 2026-08-21 |
| Capability URLs | W3C TAG finding | 2014-10-30 |
| nginx `secure_link` (MD5, not default) | nginx.org | read 2026-08-21 |
| Juniper end user licence agreement §3(c), §4(e) | juniper.net | November 2020 release, read 2026-08-21 |
| Termix and Zerobyte stylesheets, screenshots, submenu source | github.com raw files and README images | read 2026-08-21 |
| Diagram element-count guidance | yworks.com/blog; tldraw and JointJS performance docs | read 2026-08-21 |
| Formal-verification escapes in HPKE implementations | IACR eprint 2026/192 (Kobeissi, Symbolic Software) | read 2026-08-21 |
| In-repository: `redact.rs`, `op.rs`, `snap.rs`, `prov.rs`, `graph.rs`, `field.rs`, `route.rs`, `order.rs`, `shell.rs`, `Cargo.lock` (16 first-party packages), `schema/schema.yaml`, `schema/platforms.yaml`, `design/tokens.css`, `fathom-dev.src.html` | this repository, unmodified | read 2026-08-21 |

## Disagreements

**With `41` §5.3 (storage).** It decides redb for single-node and Postgres via sqlx for clusters,
behind one trait. **That decision was correct for the artifact it was written about** — a
zero-knowledge blob service whose requirement S1 was *"store opaque blobs"* and whose trait was
*"fifteen methods, none of which understand a record's contents."* It is wrong for a queryable,
multi-tenant, live-edited estate. §6 recommends one backend, Postgres, and `tokio-postgres`
rather than `sqlx` on a measured 58-versus-124 crate count. **`41` should be amended or
superseded rather than quietly ignored.**

**With `43` §5.3 (TLS).** It decides in-process TLS with no automatic certificate client, on the
grounds that such a client *"fails in the air-gapped and internal-CA cases, which are most of
this product's customers."* **That reasoning is still correct for the self-hosted enterprise
build and wrong for a public hosted service run by one person** — and `43` itself admitted the
cost: *"if they use nothing, they will let a certificate expire."* §19 keeps both.

**With `33` §15 decision S-1 (transport).** It leaned toward one-way server-sent events, because
the client only needed a small "something changed" nudge. **Live editing needs the browser to
send a stream of small edits at low latency, and one-way events cannot do that.** Reverse to
WebSocket.

**With `33` §3.2 (OPAQUE).** Dropped — see §12. Right answer to the old question; the question
changed when the server started holding the diagrams.

**With `33` §9.3 (eager re-sealing).** Its refusal of lazy re-encryption was correct for a
sync model where an ex-member can simply pull the old blobs. **On a server-authoritative
product the ex-member's only route to the ciphertext is a request the server can refuse**, which
makes an honest sentence available: *"we removed their access now, and we are re-keying over the
next hour."* **This is the real argument for `48` §5's "checks plus crypto" — better than the
vaguer one `48` gives.**

**With `51` §12 (motion).** It states *"the product has no animation."* `design/tokens.css`
already declares motion tokens and the page uses them in 14 places, and ADR-0033 is ratified.
**Correct the document rather than debate it.**

**With `42` (no Node runtime), for the browser half only.** Its own §6.3 contains the reversal
clause and it has fired: *"the no-Node position is cheap BECAUSE THE UI IS AUSTERE … If the
design language ever loosens … the decision should be re-examined rather than defended."* And its
supporting fact — *"a few thousand lines of hand-written TypeScript"* — is no longer accurate:
the page is **7,958 lines of hand-written JavaScript in one file with no types at all**, against
`41` §4.4's own recommendation to cap the render layer at 800 lines. Its strongest argument, that
*"you can rebuild this yourself and get the same bytes"*, was about a file you download; nobody
byte-verifies a page served from a server they log into. **Keep `42` §7.1's criterion for the
server binary, where it still earns its keep. Adopt a build step and TypeScript for the browser,
and if a framework is needed use the escape hatch `41` §4.7 already names — small, vendored,
pinned, reviewable — not React, and not a Rust/WebAssembly interface, since both candidate
frameworks there are still pre-1.0.** And note what is actually being given up: not
reproducibility, but the fact that a reviewer in a defence environment hears *"we do not use
npm"* and stops asking. **Give that up deliberately, in an ADR, not by drift.**

**With `48` §5's middle path as written.** It proposes *"checks for everything, plus crypto for
secrets only."* Under §3 decision 1 there are **no stored secrets**, so a separate group key for
secrets protects an empty set. The valuable half survives in a better arrangement: **crypto for
the whole document so the server is blind, plus access checks so revocation takes effect
immediately while re-keying runs behind it.**

**With `44` §4.7.4's ceiling, in one direction only.** The 2,000-element cap was argued as
product design and defended with a byte and frame budget. **Removing the byte ceiling will tempt
someone to raise the cap without re-arguing legibility.** The legibility sentence is still true.
**Re-measure the number; do not delete the reason.**
