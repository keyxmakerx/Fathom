# 48 — The server fork

> **Status:** Proposed · **Opened 2026-08-18.** Nothing here is built and no fork exists yet.
> This records the owner's decision to fork, the shape the server version would take, and the
> four design surfaces it opens — one of which is larger than the other three together.
>
> **`43` (deployment modes) is the companion and predates this.** Where the two disagree, `43`
> is the older document and this one is the newer conversation; neither is ratified.

## Contents

| § | |
|---|---|
| 1 | The decision, and what changes about the invariants |
| 2 | What transfers, what is new — the fork is smaller than it looks |
| 3 | **The ceiling does not exist on the server** |
| 4 | Storage: the question is key custody, not RAM versus disk |
| 5 | **Permissions, and why they are the largest new surface** |
| 6 | Search: an IP is not a string |
| 7 | Order of work |
| 8 | What must be researched, not recalled |
| 9 | Open decisions |

---

## 1. The decision

The owner, 2026-08-18:

> *"I'm about ready to fork it and start work on the server version of this, where it is
> hosted on the server."*

And, correcting a standing assumption of this corpus:

> *"this would be after we were full server solution, so it wouldn't be that main rule
> anymore, that main rule is only for demo mode like it is currently."*

**That is a material change and it should not be buried.** Invariant 1 — *the product never
connects to anything* — has been read throughout the corpus as a permanent property of
Fathom. The owner's position is that it is a property of **the client-only mode**, which he
calls the demo, and that the server version is the destination.

This document does not amend `.context/conventions.md`; that is `03`'s and the owner's to do
(open decision 1). It records that the reading has changed, because several documents —
`38` in particular — argue from the invariant as though it were permanent, and their
conclusions were correct **for the artifact they were written about** and should not be
carried across the fork unexamined.

**What does not change:** `38` §14's finding stands on its own merits for the client. The
reason a server should not parse a config in the *demo* is not that a rule forbids it; it is
that the credential travels to be redacted, and the largest zero-egress byte lever was 1.9×
the entire prize. On the server fork the trade is different and must be re-argued, not assumed
either way.

## 2. What transfers

The fork is much smaller than "start again", and this is the single most useful fact in this
document.

**The core is already platform-neutral Rust with zero external dependencies, and its 656 tests
run natively rather than in a browser.** `fathom-graph`, `fathom-ingest`, `fathom-ir`,
`fathom-schema`, `fathom-weld`, `fathom-layout`, `fathom-inventory`, `fathom-emit`,
`fathom-find`, `fathom-corpus`, `fathom-id`, `fathom-canon`, `fathom-workspace` — none of
them know what a browser is.

| crate | on the server |
|---|---|
| the thirteen core crates above | **transfer unchanged** |
| `fathom-wasm` | replaced — it is an opcode shell; the server wants HTTP handlers over the same core |
| `fathom-artifact` | replaced — it assembles a single HTML file |
| `fathom-schemagen` + `schema/` | **shared, not forked** — see below |

> **FORK THE APP, NOT THE VOCABULARY.** A fork's real failure mode is silent divergence, and
> the schema is where it happens: if each side grows its own kinds and fields, workspace files
> stop being interchangeable and neither can read the other's export — and nobody notices
> until they try. `schema/` and the generated types stay one source of truth.

**The one real gap in the core:** the store is single-estate and in-memory. `OP_PASTE`
*replaces* the held estate. A server needs many estates, concurrent access and durable
persistence. The type machinery transfers untouched; that lifecycle does not exist and is the
actual scope of the fork, alongside HTTP, auth and storage.

## 3. The ceiling does not exist on the server

`44` §5.2's 900,000-byte budget is a **WebAssembly** constraint. A native binary has no such
limit.

So every item in `57` §14.1's pile C — `OP_CABLE`, unmount, move, `DhcpRelay`, the `Surface`
kind, and any future kind at all — is **unblocked the moment the same crates are compiled
natively.** That is not a workaround; the byte pressure is an artifact of shipping a typed
graph inside a browser module.

**This does not fix the client.** `57` §14.2's levers are still the only thing that helps the
demo, and they are still worth proving: they make every future schema kind cheaper on both
sides of the fork.

## 4. Storage: key custody, not RAM versus disk

The owner reasoned toward this and then away from it in the same breath, correctly:

> *"change our system to be 'store in RAM' to store like passwords and such in ram i suppose,
> though no that doesn't make sense because we'll have entire configs stored anyways."*

**He is right to abandon it, and the reason is worth stating because it is the whole design:**

> **WHERE A SECRET LIVES MATTERS FAR LESS THAN WHO HOLDS THE KEY.**

RAM is not a security boundary — `38` §14.3 lists eleven mechanisms that defeat *"it only
lives in memory"*, from swap to core dumps to reverse-proxy body buffering. A secret encrypted
with a key the server does not hold is safe **on disk**, and a secret in plaintext is exposed
**in RAM**. The axis is custody.

This is also the design the corpus already specifies for the workspace: `70` §8 answers the
owner's load-balancing requirement with *the server stores ciphertext it cannot read*. The
same shape extends to configs and to secrets within them.

**But note the fork it creates, because it is the one that changes what Fathom is.** The
ingest gate exists to destroy credentials so they never reach storage. A server that keeps a
config good enough to *restore a device* is keeping working credentials for the estate. Those
are different products:

| | what is stored | what it can do |
|---|---|---|
| today | redacted config | documents; cannot restore |
| restore-capable | full config, encrypted | rebuilds a box; **is a credential store** |

Neither is wrong. Choosing by accident is.

## 5. Permissions, and why they are the largest new surface

> *"if a usergroup doesn't have permission to view secrets and passwords, and such..."*

**This is the biggest new design surface in the server fork — larger than storage, search and
file serving together — because it touches every read path in the product.**

There are two ways to enforce it and they are not equivalent:

| | mechanism | strength | cost |
|---|---|---|---|
| **check** | the server decides whether to return the field | ordinary, familiar | the server can read everything; a bug, a subpoena or an operator sees all of it |
| **crypto** | secrets encrypted to a group key the server never holds | the server *cannot* leak what it cannot read | key distribution, and **revocation is hard** |

The second is the natural extension of §4 and of `70` §8, and it is much stronger: a
permission implemented as an `if` fails open when the `if` is wrong, and a permission
implemented as *"we do not have the key"* has no such failure mode.

**Its hard problem is revocation, and it should be understood before it is designed.** If a
person had the group key and is removed from the group, they *had the key*. Removing them from
a list changes nothing about what they already hold. Real revocation means re-keying and
re-encrypting everything that key protected, for everyone still in the group. That is a
background job, a versioning scheme and an audit trail — not a checkbox.

A likely middle path, recorded as a candidate rather than a decision: **checks for
everything, plus crypto for secrets only.** Ordinary fields get ordinary access control;
`SecretPlaceholder`-backed values get a separate group key. The re-keying burden then applies
only to the small set of things that genuinely need it.

## 6. Search: an IP is not a string

> *"searching for an IP when we know we have a /24 with that ip in that range type thing"*

This is a concrete requirement and it is **a different kind of search from the one the product
has**. The finder does fuzzy text matching over 98 corpus entries. *"Which subnet contains
10.4.7.19?"* is **prefix containment over a network address**, and text matching cannot answer
it: `10.4.7.0/24` and `10.4.7.19` share no useful substring relationship that a matcher could
exploit, and `10.4.70.0/24` looks more similar than the answer does.

What it needs is an index over `Address` sorted by prefix, and a longest-prefix lookup. That is
standard and small, and it is worth naming as its own feature rather than as "search":

- **containment** — which declared prefix holds this address
- **overlap** — which two declared prefixes collide, which is a findings-view lint
- **free space** — what is unallocated inside a prefix, which is what people actually want next

The owner's other half — *"maybe even to the point of like a list format for stuff, like
hostnames, ips"* — is an **export**: every hostname, every address, as a flat list to paste
elsewhere. `fathom-emit` exists and is unlinked from the module for byte reasons (`47` §11);
on the server that constraint is gone.

**None of this requires a server.** It is listed here because the owner raised it here, and
because an index over a large estate is more natural where there is memory to spare — but a
prefix index is small and the client could have it.

## 7. Order of work

The owner's priority, stated 2026-08-18 and binding:

> *"the diagram and everything is the priority, the server versioning and file hosting is
> kinda one of those i'd like to do as soon as possible when we do switch to the server
> version."*

So: **client first, and the fork does not start yet.** When it does, the ordering principle
from the same conversation is worth keeping:

> **THE FEWER CREDENTIALS A CAPABILITY NEEDS, THE EARLIER IT SHOULD SHIP.**

| | capability | server initiates? | holds device credentials? |
|---|---|---|---|
| 1 | workspace storage and sync | no | no |
| 2 | image file server — devices pull | no | no |
| 3 | config pulls | **yes** | **yes, for the whole estate** |
| 4 | monitoring | **yes** | usually |

The first two need no device access at all and are additive. Three and four are where the
product starts holding the keys to the estate, and they should not be first.

## 8. What must be researched, not recalled

Per ADR-0034. The owner asked for research into safe and secure local storage for enterprise
environments; **that has not been done and nothing in §4 should be read as it.** §4 argues
about custody, which is a design position, not a review of storage practice.

Open, and each needs sources with dates:

1. **Encryption at rest on a self-hosted server** — what enterprise practice actually is, key
   management, what a hardware-backed key store buys and what it does not.
2. **Secure deletion** — the owner's *"deleted server side securely"*. Snapshots, backups,
   copy-on-write filesystems and SSD wear-levelling all retain copies nobody asked for. This
   is the same shape of problem as `38` §14.3's memory question and deserves the same
   treatment.
3. **What image-fetch protocols the target platforms actually support** — TFTP has no
   authentication and no encryption and is the common default. Whether the owner's Junos and
   OPNsense versions support HTTPS or SCP *for image pulls specifically* is a per-version
   fact, not a general one.
4. **Group-key revocation schemes** — §5's hard problem is well-trodden and should be read
   before it is invented.

## 9. Open decisions

1. **Does invariant 1 become mode-scoped?** §1. The owner's position is that it governs the
   demo. `03` and `.context/conventions.md` still state it unconditionally, and several
   documents argue from it as permanent. Owner's and `03`'s.
2. **Does the server store restore-capable configs?** §4. It makes the product a credential
   store for the estate. Both answers are legitimate; the accident is not.
3. **Checks, crypto, or both for permissions?** §5. Recommended: both, with crypto reserved
   for secrets.
4. **Does the fork share `schema/`?** §2 recommends strongly that it does. Cheap to decide
   now, expensive after divergence.
5. **Where does the prefix index live** — client, server, or both? §6.

## Failure modes

- **Nothing here is built and no fork exists.** This is a record of a conversation, and every
  cost in it is reasoned rather than measured.
- **§8 is not research.** Four things are named as needing sources and none has them yet.
- **`38` and `43` argue from invariant 1 as permanent.** Their reasoning is sound for the
  client; a reader should not carry their conclusions across the fork without re-checking the
  premise, and §1 exists to make that impossible to miss.

## Sources consulted

| what | where | when |
|---|---|---|
| The owner's decision and constraints, verbatim | conversation | 2026-08-18 |
| Crate inventory and native test count (656) | `cargo test --workspace --locked` | 2026-08-17 |
| The 900,000-byte WASM budget | `44` §5.2 | — |
| Pile C, the byte-blocked list | `57` §14.1 | 2026-08-18 |
| The eleven mechanisms defeating "it only lives in RAM" | `38` §14.3 | 2026-08-17 |
| "The server stores ciphertext it cannot read" | `70` §8 | — |
