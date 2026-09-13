# ADR-0040 — The server holds the keys, and says so

> **Status:** Accepted — **the owner's decision, delegated to evidence on 2026-08-28 and
> ratified here on 2026-09-03** when he said *"start working on the server version."* `49` §3
> decision 4 requires exactly this record: *"decide invariant 4 deliberately, as a written ADR,
> before the server holds its first byte."* This is that ADR. Binding once built (CLAUDE.md
> rule 3); reopenable on merit (`75` §2).
> **Date:** 2026-09-03.
> **Amends:** `.context/conventions.md` **invariant 4**, which is scoped rather than deleted
> (§4). **Ratifies** `38` §14's proposed union rule, unratified since 2026-08-17 (§5).
> **Closes:** `49` §22 open decision 1, and with it the last DECISION item in `49` §19's
> phase 0. **Phase 0 is now complete.**
> **Reversal cost:** R3 and rising with every stored row — which is the whole reason §3's
> per-tenant key boundary exists from the first line of server code rather than later.

## Contents

| § | |
|---|---|
| 1 | The question, and who answered it |
| 2 | **The decision** |
| 3 | Eight decisions, each with what it rejected |
| 4 | Invariant 4, amended — and the precedent cost, paid openly |
| 5 | The union rule, ratified |
| 6 | The sentences that may never be said, and the one that must |
| 7 | What must stay true |
| 8 | Failure modes |
| 9 | Open decisions |
| 10 | Sources consulted |
| 11 | Disagreements |

## 1. The question, and who answered it

Invariant 4 has read, since ADR-0002: *"The server never holds secret key material.
Zero-knowledge. Ciphertext, public keys and metadata only."*

The four pivot decisions of 2026-08-18 — data on the server, live multi-user editing,
multi-tenant, thousands of devices — each require the server to **read**. `49` §3 decision 4
named the collision plainly and refused to resolve it by drift: *"The one thing that must not
happen is choosing by accident."*

The owner delegated it to evidence on 2026-08-28 (`70` §18.1): *"what is the most secure but
optimised way of handling this? surely we aren't coming up with anything unique, others should
have made similar secure products. This is enterprise level though keep in mind."* An ADR-0034
survey ran the same day, with a source and a check date on every claim. Four findings, recorded
in full in `49` §3's addendum and summarised here because they are what this decision rests on:

1. **Envelope encryption — a data key per tenant wrapped by a master key in a key-management
   service — is the documented standard** at AWS, Google Cloud and Azure, in those words, all
   checked 2026-08-28.
2. **No mainstream collaborative product pairs a server that cannot read with server-side
   search and unconditional recovery**, and the products on each side of that line say why:
   Slack rejected end-to-end in writing because it breaks search; Tresorit and Proton pay
   exactly the price `49` §2 priced. Established across three products, two independent
   sources for the negative, per ADR-0034 rule 2.
3. **The enterprise tier the market actually sells is CUSTOMER-MANAGED keys, not
   end-to-end** — Slack EKM, Salesforce Shield BYOK, Atlassian CMK, Miro BYOK, and **Lucid's
   own "Lucid KMS"** on the Enterprise Shield add-on. The product the owner named as his model
   monetises precisely the custody switch this record stages.
4. **SOC 2 and ISO 27001 do not require application-layer encryption.** CC6.1 and control 8.24
   are risk-based; disk and database encryption plus access control is the accepted baseline.

## 2. The decision

> **The server holds the keys. Every tenant gets its own data key and every design its own,
> wrapped by a master key, from the first line of server code — and the wrap point is built so
> that a customer-supplied master key can replace the house key later without re-encrypting
> anything. Until that is true for a given customer, Fathom never says it cannot read their
> data. What it says instead is the thing no comparable product can: device credentials are
> protected by never arriving.**

## 3. Eight decisions, each with what it rejected

| # | decided | rejected, and why |
|---|---|---|
| D1 | **Application-layer envelope encryption from the first stored byte** — a data key per tenant and per design, wrapped by a master key held in a key-management service. | Disk- or database-level encryption alone. Finding 4 says the compliance floor would permit it; this sits one tier above the floor, and it is cheap only if built in from the start. Also rejected: browser-held keys now, which costs the four things `49` §2 priced plus every schema check the server could otherwise run |
| D2 | **The custody switch is a first-class feature with a named destination: customer-managed keys.** The wrap point is designed so replacing the house master key with a customer's own is a re-wrap of data keys, never a re-encryption of data. | Treating "maybe end-to-end later" as the destination. Finding 3 says the market's enterprise tier is customer-managed keys, and the evidence for end-to-end at this document size does not exist (`49` §21 item 5) |
| D3 | **The trigger for offering it is set in advance: the first customer who is not the owner.** Named now so it is not discovered under sales pressure. | Leaving the trigger to judgement, which means the switch happens late and under duress or not at all |
| D4 | **Deleting a tenant is destroying a key.** Cryptographic erase is the only honest answer to "deleted securely" when backups, snapshots and wear-levelling all keep copies no `DELETE` reaches — NIST SP 800-88 Rev. 2 (final 2025-09-26) recognises it as a valid Purge method. | A `DELETE` and a promise. **And explicitly rejected: letting "crypto-shredding" cover two different deletions** — removing one *person* from a design is a full re-encryption, priced by `33` §3.6 at roughly 800 MB per removal at this plan's stated scale, and calling it shredding would hide that cost |
| D5 | **The gate runs in the BROWSER first and on the server as well, never instead** (`49` §3 decision 1). A password never reaches the wire, so it never lands in a proxy buffer, a temp file, a core dump, a crash log or a backup on a machine the customer does not own. | Server-side redaction alone, which reintroduces every one of `38` §14.3's eleven mechanisms for the 2% of a config that can actually be used to log in |
| D6 | **`fathom-wasm` is not retired.** It is re-scoped to the ingest gate and nothing else, because it is the only vehicle that puts the gate in a tab. | The pivot's own framing, which retired it. Retiring it means a second gate in JavaScript that drifts from the Rust one — and the drifting copy is the one that decides whether a password crosses the wire. `49` §1 calls this the worst outcome available anywhere in the plan, and this record agrees |
| D7 | **The gate records properties of a secret, never the value, and never an exact length.** The length leak was fixed in the client on 2026-08-21; on the server the in-session-only marker becomes a **type the persistence layer cannot misuse**, not a comment asking it not to. | A comment. On one laptop a length oracle is a bad day; in a multi-tenant database it is the exact length of every pre-shared key in every customer's estate, readable by anyone with database access |
| D8 | **A platform is not selectable in a hosted Fathom until its declared secrets are enumerated from vendor documentation and its run-together keywords are covered — checked in CI, not in a reviewer's head.** | Offering ten platforms on one dictionary. Seven registered platforms have no dictionary at all, so only a thirty-word list and a base64 heuristic stand behind them; FortiOS's `psksecret` is one run-together word the matcher's split rules never reach. That is the single-detector condition `38` §14.9 already condemned, as the normal case for seven vendors |

## 4. Invariant 4, amended — and the precedent cost, paid openly

**Invariant 4 is scoped, not deleted.** Its new text is in `.context/conventions.md`, amended
by this record: it continues to bind the **client artifact and any future zero-knowledge
deployment**, and it does not bind the hosted multi-tenant server, which holds keys under
§3's design and says so.

**ADR-0002 priced this and the price is paid rather than hidden:** *"Editing an invariant sets
a precedent that invariants are editable. They were load-bearing precisely because they read
as fixed."* Two things limit the precedent:

1. **This is the second invariant to be scoped, and both were scoped by the owner, in writing,
   with the reasoning recorded** — invariant 1 on 2026-08-18 (`48` §1, still awaiting its own
   formal amendment as `48`'s open decision 1) and invariant 4 here. Neither was scoped by a
   session finding an invariant inconvenient.
2. **Scoping is not deletion.** An invariant that names the mode it governs is stronger than
   one that reads as universal and is quietly contradicted by the code — which is exactly the
   state invariant 1 was found in on 2026-08-28, and why `.context/conventions.md` now carries
   a standing note about it.

## 5. The union rule, ratified

`38` §14 proposed this on 2026-08-17 and it has been cited as unratified ever since. `49` §3
decision 1 says to ratify it as part of this work. Ratified:

> **Nothing arriving after the build may reduce what the ingest gate destroys, only increase
> it. Union, never replace.**

It applies to any dictionary, rule pack, corpus update, platform definition or client build
that reaches a running Fathom. On a shared server it is what stops a stale or hostile client
writing a credential into storage that everybody else's data sits next to.

**And it is not satisfied by intent — it needs a test.** The check belongs beside D8's in CI:
load the shipped detector set, load the arriving one, and fail if the arriving set destroys
less on any probe the shipped set destroys.

## 6. The sentences that may never be said, and the one that must

**Never, until customer-managed keys are live for that customer:** *zero-knowledge*,
*end-to-end encrypted*, *we cannot read your data*, *only you hold the key*. These are not
marketing preferences; they are false under D1, and a false security sentence is worse than no
sentence because it teaches the reader to discount the next one.

**Always available, and true today:**

> **Fathom never touches your devices, and it destroys every password before it stores
> anything. There is no credential to steal.**

With the honesty caveat D8 enforces: that sentence is **fully earned on Juniper and materially
weaker on the platforms with no dictionary**. Say it about the platforms it is true of.

## 7. What must stay true

- **A data key per tenant and per design exists from the first stored byte.** Retrofitting a
  key boundary means re-encrypting everything already held.
- **No `WHERE tenant_id = ?` bug can become a cross-tenant breach**, because the wrong rows do
  not decrypt. This is the belt behind `49` §11's row-level-security braces.
- **The browser gate runs before upload, always, and the server gate runs again on arrival.**
- **No exact secret length is ever persisted**, by type and not by convention.
- **No platform ships selectable without enumerated secrets** (D8).
- **Every claim in this record carries a source and a date**, and a session that needs a new
  security fact looks it up rather than recalling it (ADR-0034).

## 8. Failure modes

| failure | what stops it |
|---|---|
| the key boundary is "added later" and never is | D1: it is in the first migration, or the record is being violated |
| marketing says zero-knowledge because it sounds better | §6, and it is a documented falsehood, not a preference |
| a tenant is "deleted" but lives in a backup | D4's cryptographic erase |
| removing a person is called shredding and its real cost is hidden | D4's second half |
| a stale client uploads a credential a newer gate would have destroyed | §5's union rule plus its CI check |
| a customer selects FortiOS and the gate silently does almost nothing | D8's CI check |
| the length oracle returns on the server | D7's type |
| a second gate appears in JavaScript | D6 |

## 9. Open decisions

1. **Which key-management service.** D1 requires one; naming it is a technology decision under
   `49` §6's dependency gate, and it interacts with self-hosted deployments that have no cloud
   KMS. *For planning, before the first migration.*
2. **The self-hosted key story.** A customer running Fathom on their own hardware has no cloud
   KMS; the options are a local key file with documented custody, an HSM, or a Vault instance.
   *For planning.*
3. **Invariant 1's formal amendment** — `48`'s open decision 1, still open, still the owner's.
   This record deliberately does not touch it.
4. **Whether the audit log an employer's security review asks for is in phase 1 or phase 2.**
   `49` §13 designs it; `49` §19 places it in phase 2; `49` §20 lists it among the obligations
   nobody had listed. *For planning.*

## 10. Sources consulted

| source | for |
|---|---|
| `docs/40-stack/49-the-server-product.md` §2, §3, §11, §21, §22 | the design this ratifies, and its own honest gap list |
| `docs/70-ops/70-owner-answers-and-standing-priorities.md` §18.1 | the owner's delegation, verbatim, and the commissioned survey |
| `docs/30-security/38-the-egress-question.md` §14 (esp. §14.3, §14.4, §14.9) | the eleven mechanisms, the 2%/98% split, the length oracle, the union rule |
| `docs/90-decisions/adr-0002-*.md` | the precedent cost of editing an invariant |
| `docs/40-stack/48-the-server-fork.md` §1, §5 | invariant 1's scoping precedent; permissions and revocation |
| NIST SP 800-88 Rev. 2 (final 2025-09-26) | cryptographic erase as a Purge method |
| the 2026-08-28 survey's sources — AWS KMS, Google Cloud KMS and Azure encryption-at-rest docs; Slack EKM and its engineering blog; Salesforce Shield BYOK; Atlassian CMK; Miro BYOK; Lucid KMS; Tresorit; Proton; SOC 2 / ISO 27001 vendor summaries | findings 1–4, each with its check date in `70` §18.1 |

## 11. Disagreements

1. **With invariant 4 as written.** It reads as a universal property of Fathom and has been
   cited that way across the corpus. It was authored for a product where the server held
   ciphertext it could not read; that product is not the one being built. Scoped, not deleted.
2. **With the instinct to keep it and build the strong product now.** It is the better sentence
   and the worse product at this moment: finding 2 establishes that nobody ships it with search
   and recovery, and `49` §21 item 5 records that nobody has established it works at thousands
   of devices with concurrent editors. Building it first would bet the project on an
   unmeasured claim. D2 and D3 keep the door open and name the trigger.
3. **With calling this a security downgrade.** The thing an attacker most wants from a network
   documentation tool is a working credential, and Fathom has none to give — by construction,
   permanently, and before this decision or after it. What moves here is custody of the map,
   which was never protected in the shipping product either.
