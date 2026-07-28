# 31 — The threat model

> **Status:** Reconstructed

This document is the full form of §7.1 of the owner brief. The supplied text terminates
mid-sentence inside the out-of-scope table:

> | **Compromised browser** | Defensive code runs i—  *[TRANSMISSION ENDS HERE]*

The completion is not in doubt. **Defensive code runs in the same context as the attacker.**
JavaScript in the Fathom origin cannot defend against other code with the same origin, and it
cannot defend against a browser that has decided to lie to it. There is no arrangement of the
application's own code that changes this, because every mechanism the application could use to
detect tampering is a mechanism the tamperer can rewrite first. Everything after that dash in
the source is reconstructed here, and §6 states it at the length it deserves rather than in one
table cell.

Sections 1–12 below are reconstruction. Where I extend the owner's seven in-scope rows to
nineteen, or add columns he did not have, that is extension and marked as such in §5.0.

**The governing rule of this document, stated once, in caps, at the top:**

> **ENCRYPTION PROTECTS THE FILE. IT DOES NOT PROTECT THE MACHINE THE FILE IS OPEN ON, AND IT
> DOES NOT PROTECT THE FACT THAT THE FILE EXISTS.**

That sentence is the whole model. §5 is the part we can do something about, §6 is the part we
cannot, §7 is the part everyone forgets, and §10 is the part an enterprise reviewer will quote
back at us.

---

## 0. Contents

| § | |
|---|---|
| 1 | Method, scope, and the scales this document uses |
| 2 | Assets — what Fathom holds, ranked by value to an attacker |
| 3 | Actors |
| 4 | Trust boundaries |
| 5 | In scope — attack, mitigation, residual, third-party verification |
| 6 | Out of scope — stated without softening |
| 7 | The metadata problem |
| 8 | Attack trees for the three highest-value goals |
| 9 | Abuse cases — misuse of the tool itself |
| 10 | What Fathom explicitly does NOT claim |
| 11 | Residual risk register |
| 12 | What CI enforces |
| 13 | Sources |
| 14 | Disagreements |

---

## 1. Method, scope, and the scales this document uses

### 1.1 What is being modelled

The system under consideration is **the whole product as delivered**, in every deployment shape
the brief names, plus the artifacts that flow into and out of it:

| Shape | What runs where | Egress surface |
|---|---|---|
| **Offline single file** | one `.html` opened from disk or a share; WASM core; no server | `connect-src 'none'` — none |
| **Docker single-node** | static assets + Axum sync service on one host, usually on-prem | one origin, TLS |
| **Enterprise cluster** | same code, load-balanced, blob store behind it | one origin, TLS |
| **CLI** | the same Rust core compiled native, no browser | whatever the operator runs it under |

The AI layer's deployment tiers (0/1/2/3) are defined in `docs/20-ai/21-ai-layer-architecture.md`
§7 and are not redefined here. This document treats **tier 1 as a distinct deployment with a
materially different threat model**, and says so wherever it changes an answer. Everything
stated without a tier qualification is true at tiers 0, 2 and 3.

Out of the system boundary but inside the model as *actors*: the sync service operator, the
hosting provider, the rule-pack publisher, the corpus contributor, the build infrastructure.

### 1.2 Method

Three passes, because no single method covers this product:

| Pass | Method | What it is good at | What it misses here |
|---|---|---|---|
| 1 | **Asset-first** (§2) | Ranking. Forces the argument that the findings list outranks the config, which a control-first pass never surfaces. | Says nothing about *how* an asset is reached. |
| 2 | **Boundary + STRIDE** (§4, §5) | Mechanics. Spoofing/tampering/repudiation/disclosure/DoS/elevation per crossing. | Almost blind to metadata — STRIDE's "information disclosure" treats a size as a non-event. |
| 3 | **Attack trees** (§8) | Cheapest-path reasoning. Tells you where the money should go, which the tables do not. | Combinatorially incomplete by construction. A tree is an argument, not an enumeration. |

Pass 2 is supplemented for the metadata channel by a LINDDUN-shaped question — *what is
linkable, identifiable, detectable, and does the ciphertext hide the fact of the thing as well as
the thing* — because that is precisely the class STRIDE under-weights and precisely the class
§7 is about.

### 1.3 The three questions every row must answer

A row that cannot answer all three is not finished:

1. **What exactly does the attacker do?** Not "compromises the server" — *reads the blob table
   as the database user the API runs as*.
2. **What is left after the mitigation?** Every mitigation leaves something. If a row's residual
   column is empty, the row is wrong.
3. **How does somebody who does not trust us check it?** This is the column that makes the
   security posture a property of the artifact rather than a property of our reputation. Where
   the honest answer is "you cannot check this without reading the source", the row says that.

### 1.4 The scales — and the one enum this document may not touch

`Risk` — `ReadOnly | ChangesConfig | Disruptive` — is the emitted-line risk enum from the brief
§5.3 and the field card's three-colour legend. It classifies **what a command does to a live
box.** It is used in exactly one place in this document, §9.4, where a weakening change is
labelled at emit time. **It is not a threat severity scale, it is not a finding severity scale,
and its three colours are never used for either.**

Threat rows in §5 and §6 carry a *residual* tag from a separate four-value neutral scale.
Rendered in neutrals with weight and rule treatment, never in `#1F6F4A` / `#A8571B` / `#8C2F2F`:

| Residual | Means |
|---|---|
| `none` | The attack does not work after the mitigation. Rare, and claimed only where it is structurally true. |
| `bounded` | It works, but the attacker gets a named, small thing, and we say what. |
| `material` | It works and the loss is real. Accepted with a reason and an owner. |
| `total` | Nothing in this architecture stops it. §6 is the list of these. |

Asset value in §2 uses a separate ordinal `V1…V9`, highest first. It is a ranking, not a score;
do not do arithmetic on it.

### 1.5 What the invariants already removed

Before any control, four product decisions delete whole branches of the tree. This is worth
stating first because it is the largest single security effect in the product and it cost
nothing:

| Invariant | Branch it deletes |
|---|---|
| **3 — never accepts a credential** | Every attack whose prize is a PSK, a certificate private key, an SNMP community, a TACACS key or a device password. The application has none to lose. Config is emitted as `pre-shared-key ascii-text "<PSK>"` and the engineer pastes the real value into their terminal. |
| **2 — never touches a device** | Every attack whose prize is a live session to a network element. There is no SSH client, no NETCONF stack, no credential store, no jump path. A total compromise of Fathom yields no reachability. |
| **1 — no egress by default** | Every "the app quietly phones home" branch, and every third-party JS/font/telemetry supply-chain branch with it. |
| **4 — the server never holds a key** | Every attack whose prize is "compromise the service and read everyone's data". |

The brief calls invariant 3 out explicitly and it is right to: *"This removes the highest-value
secret from the application entirely and shrinks the threat model more than any cryptographic
control."* That is the single best security decision in the design and it is a product decision,
not a security one.

There is one crack in invariant 3 and §14 names it: at tier 1 the application does accept and
store a provider API key.

---

## 2. Assets — what Fathom holds, ranked

### 2.1 The ranking

Ranked by **value to an attacker**, not by how much the user would mind losing them — those two
orders differ, and the difference is the interesting part.

| # | Asset | Where it lives | What it buys an attacker | Lifetime |
|---|---|---|---|---|
| **V1** | **The workspace passphrase** | user's head; transiently in a DOM input and WASM memory; never on disk, never transmitted | Everything below, on every copy of the workspace that exists anywhere, retroactively and going forward. The only single item that unlocks the whole set. | Until rotated, which most users never do |
| **V2** | **The findings list** | derived, held in memory; the suppression half is persisted in the workspace | A ranked, deduplicated, remediation-annotated list of the estate's exploitable weaknesses — *sorted by severity, with the vendor syntax to exploit each one already attached*. See §2.2. | Regenerated per run; as current as the graph |
| **V3** | **Suppressions with reasons** | in the workspace, first-class (brief §6.6) | The subset of V2 that the defender has looked at and decided to live with. A list of known-unfixed weaknesses, each with a written explanation of why nobody is going to fix it soon. | Persistent, and it accumulates |
| **V4** | **Trust-boundary design** — zones, policies, zone pairs, `host-inbound-traffic`, what is permitted from where | graph, `Zone` / `Policy` / `AddressObject` kinds | The map of what talks to what and where the enforcement points are — which is the map of where enforcement is *absent*. `from-zone TRUST to-zone VPN policy TO-B match source-address any destination-address any application any` tells you the lateral path is unrestricted. | Persistent |
| **V5** | **Peer identities and peer IPs** | `IkeGateway.address`, `local-identity` / `remote-identity`, `dynamic hostname` | The external attack surface, by name and address, with the partner organisations implied by it. `address 203.0.113.10` plus `remote-identity inet 203.0.113.10` plus `dynamic hostname site-b.example.net` is a target list and an org chart. | Persistent, changes slowly |
| **V6** | **Cipher choices, and specifically which tunnels lack PFS** | `IkeProposal`, `IpsecProposal`, `IpsecPolicy.perfect_forward_secrecy` | Which recorded traffic is worth keeping. Field card side 2: *"Without PFS, the Phase 2 keys are derived from the Phase 1 key material. One compromised IKE SA secret unlocks every data key derived under it — including traffic somebody recorded off the wire months ago."* Knowing which tunnels lack PFS tells a collector exactly which captures to archive and which to discard. | Persistent |
| **V7** | **Addressing and topology** | `Address`, `Route`, `Link`, `TrafficSelector` | Where to go once inside, and what the selectors will and will not carry. | Persistent |
| **V8** | **Device inventory, versions, platforms** | `Device.platform`, version fields | CVE matching. A `junos-srx` at a named release is a lookup away from a known exploit chain. | Persistent |
| **V9** | **Provenance and workspace history** | provenance records, `FormerName`, commit history if git-versioned | Who changed what and when; which nodes were parsed from real configs and are therefore true, versus which were drawn and may be aspirational. Also a staffing signal. | Persistent, grows |

Deliberately **not** in the list, because the application does not hold them: pre-shared keys,
certificate private keys, SNMP communities, TACACS keys, device passwords, enable secrets, RADIUS
shared secrets. Invariant 3. If any of these ever appears in this table, the invariant has been
broken and the ranking above is obsolete.

### 2.2 Why the findings list outranks the configuration

This is the least obvious claim in the document and it drives several later decisions, so it is
argued rather than asserted.

A configuration is a *description*. A findings list is an *assessment*. The gap between them is
skill, time, and vendor knowledge, and the whole point of Fathom is to remove that gap.

Consider an attacker who has stolen a raw SRX configuration. To get from that text to "this
estate's DC-EAST tunnel has no PFS, uses `group2`, and its WAN zone permits `ike` from anywhere",
they need to know that `perfect-forward-secrecy` lives on the `ipsec policy` and not on the
`ipsec vpn` (field card side 1, the object chain), that its absence is not a syntax error and
will not show up in any commit check, that `group2` is legacy, and that the absence of an
`ipsec policy` statement means the default rather than nothing. That is exactly the vocabulary
gap the brief §2.1 exists to close. It is hours of work per device for someone competent and
impossible for someone who is not.

The findings list is that work, already done, ranked, with `remediation` attached — which is to
say, with the precise syntax of the thing that is missing, which is also the precise description
of the hole.

Three consequences:

1. **A findings export is a more dangerous artifact than a config export**, and the product must
   not treat "export findings" as the lighter-weight action of the two. It is the heavier one.
2. **The tier-1 redaction gate must classify findings at least as strictly as raw config.** A
   redaction policy that withholds `description` free text but forwards a findings list has
   inverted the risk.
3. **§9.2's abuse-case argument has a real cost.** The usual defence of a config explainer —
   "an attacker who has the config already has everything" — is true for explanation and false
   for assessment. Fathom genuinely adds capability to whoever holds a stolen config. §9.2 states
   that plainly instead of hiding behind the usual argument.

### 2.3 Suppressions are a list of accepted risks, in writing

Suppressions carry a reason and live in the workspace so a reviewer can see what was waived and
why (brief §6.6). That is correct for review and it creates V3.

An attacker reading suppressions learns three things a config never tells them:

| From the suppression | The attacker learns |
|---|---|
| The rule id, e.g. `ipsec.pfs.absent` on a named node | The weakness exists **and has been confirmed by the defender**, not merely inferred |
| The reason text | Why it will not be fixed — *"peer is a customer-managed ASA that cannot do group14, waiting on their 2027 refresh"* — i.e. an expiry date on the window of opportunity |
| The set of suppressions as a whole | The defender's risk appetite, and which classes of finding this team routinely waives |

The `acceptable_when` field (invariant 8) makes suppressions honest, which makes them detailed,
which makes them valuable. **That is a cost of the design, not a flaw in it**, and the answer is
not to make suppressions vaguer. The answer is that the suppression set is inside the workspace
ciphertext and inherits every protection the graph has, and that findings/suppression export is
the most tightly gated export in the product (§9.4).

### 2.4 The workspace passphrase — the only credential, and its honest weaknesses

One secret to rule the whole set, held only in the user's head. The good news is invariant 4:
there is no server-side copy to steal, no reset flow to social-engineer, no recovery email to
compromise. The bad news is four things, all real:

| Weakness | Detail |
|---|---|
| **Entropy is the binding constraint, and a KDF does not add any** | Argon2id multiplies the attacker's per-guess cost by a constant. It does not add bits. A six-word EFF-wordlist passphrase is log₂(7776⁶) ≈ 77.5 bits; a memorable sentence with substitutions may be under 40. A constant factor does not rescue 40 bits. The product's job is to push the user to a generated passphrase, not to make the KDF fashionable. |
| **The attacker cracks offline** | Once the ciphertext is obtained (§8, goal A, branch A1.2), guessing is unmetered, unlogged, and parallel. There is no lockout because there is nobody to do the locking out. |
| **It cannot be reliably erased from a browser** | JavaScript strings are immutable. The value read from a password input persists as a heap object until garbage collection, and nothing in the language can overwrite it. Best practice — encode to bytes into WASM linear memory immediately and clear the input's `value` — reduces the window but does not close it. §10 claims nothing better. |
| **No recovery** | Losing it loses the workspace. This is correct and it is also the most common way users will actually be harmed by this product. It belongs in the product's copy, not only here. |

<!-- VERIFY: measure Argon2id in the WASM build across the parameter grid before fixing defaults. RFC 9106 §4 second recommended option is t=3, m=2^16 (64 MiB), p=4, 128-bit salt, 256-bit tag. The first option (m=2 GiB) is not viable in a browser tab. p=4 assumes real parallelism, which single-threaded WASM without cross-origin isolation does not have — check whether p>1 buys anything in our build or is pure cost. -->

### 2.5 Asset state — where each asset is exposed

Ranked by exposure rather than by value, because the mitigations differ per state:

| State | Which assets | Who can reach it | Controlled by |
|---|---|---|---|
| **At rest, local** | all of V2–V9, as ciphertext | anyone with the file + the passphrase | workspace crypto |
| **At rest, server** | same ciphertext, plus the metadata of §7 | the operator, the hosting provider, anyone who compromises either | zero-knowledge + §7 |
| **In memory, decrypted** | all of V2–V9 in the clear, for the whole session | anything with code execution in the origin, the browser, the OS | **nothing — §6** |
| **In the DOM** | whatever is on screen | any extension with host permissions; anyone looking at the screen | **nothing — §6.2, §6.4** |
| **In transit to sync** | ciphertext | a network observer sees size and timing only | TLS + §7 |
| **In transit to a provider** | a redacted projection, in the clear at the provider | the provider, at tier 1 only | consent + redaction; see `21` §8.7 |
| **On the clipboard** | emitted config, findings, commands | any application that reads the clipboard | **nothing — §6.5** |
| **In a ticket / a chat / a screenshot** | whatever the user pasted | whoever can read that system | **nothing — §6.5** |

The three rows whose control column reads "nothing" are the honest shape of this product's
security. Everything we can control is at rest and in transit. Everything in use is the
endpoint's problem, and §6 says so.

---

## 3. Actors

### 3.1 The register

`Position` is where they already are before they do anything. `Cost` is the rough effort to get
into that position, and it is the column that decides where defensive effort should go — a threat
that is expensive to become is worth less mitigation than one that is free.

| # | Actor | Position | Motivation | What they can reach unaided | Cost to become |
|---|---|---|---|---|---|
| A1 | **Sync service operator** | runs the Axum service and its store | curiosity, commercial, coerced by process | ciphertext, all metadata in §7.2, all account/device/IP data | zero, if they are the operator |
| A2 | **Cloud / hosting provider** | hypervisor, block store, snapshots, backups, network fabric | legal process, insider, breach of their own | everything A1 has, plus service memory — which at zero-knowledge still contains no key | zero for them; high for an outsider |
| A3 | **Passive network observer** | a tap, a transit AS, a corporate proxy, a Wi-Fi AP | collection | TLS-protected flows: endpoints, sizes, timings, SNI | low |
| A4 | **Active network attacker** | in-path, can drop/inject/redirect | downgrade, MITM, denial | the same, plus TLS-termination attempts and update-channel interference (§8, goal C) | moderate |
| A5 | **Colleague with workspace access** | legitimately holds the passphrase or the shared workspace | curiosity, exfiltration on exit, compromised account | **everything, in the clear**. There is no in-workspace compartmentation | zero if they are on the team |
| A6 | **Malicious rule pack author** | publishes a `.fpack` the user installs | suppress a finding, mislead a remediation, inject text into the AI layer | rule prose, `acceptable_when`, remediation strings, severity — see §8 goal B, branch B2.1 | low; the pack format is open by design |
| A7 | **Malicious corpus contributor** | contributes explainers/commands upstream | teach the wrong verification step, make a bad state look healthy | corpus prose everywhere it renders | low to contribute, moderate to get merged |
| A8 | **Supply-chain attacker in the build** | a dependency, a build host, a signing key, a release pipeline | ship code that does anything, to everyone | **everything, on every user, silently.** The highest-leverage position in the model | high, and demonstrated repeatedly in the wild |
| A9 | **Compromised endpoint** (OS-level malware, RAT) | the user's machine | targeted collection | keystrokes, screen, memory, files, clipboard — every asset in every state | moderate |
| A10 | **Malicious browser extension** | installed in the user's browser, host permissions granted | mass or targeted collection | the DOM, page storage, and with `chrome.debugger` the whole page context — §6.2 | **low**, and this is the finding of §3.3 |
| A11 | **Coerced user** | is the user, under legal or physical compulsion | not theirs | everything they can reach, which is everything | not an attack, a jurisdiction |
| A12 | **Insider with build or release access** | ours, not the user's | anything | A8's leverage with A1's legitimacy | zero, if we hired them |
| A13 | **Opportunistic thief** | has the laptop | resale, occasionally more | disk contents; the workspace as ciphertext | low |

### 3.2 Actor × asset reachability

`◆` = reaches it in the clear, unaided. `◇` = reaches it as ciphertext or metadata only.
`·` = does not reach it. `†` = reaches it only if they also obtain the passphrase.

| | V1 pass | V2 findings | V3 suppress | V4 boundaries | V5 peers | V6 ciphers | V7 topology | V8 inventory | V9 provenance |
|---|---|---|---|---|---|---|---|---|---|
| A1 operator | · | ◇† | ◇† | ◇† | ◇† | ◇† | ◇† | ◇† | ◇† |
| A2 provider | · | ◇† | ◇† | ◇† | ◇† | ◇† | ◇† | ◇† | ◇† |
| A3 observer | · | ◇† | ◇† | ◇† | ◇† | ◇† | ◇† | ◇† | ◇† |
| A4 active attacker | · | ◇† | ◇† | ◇† | ◇† | ◇† | ◇† | ◇† | ◇† |
| A5 colleague | ◆ | ◆ | ◆ | ◆ | ◆ | ◆ | ◆ | ◆ | ◆ |
| A6 pack author | · | ◆* | ◆* | · | · | · | · | · | · |
| A7 corpus contributor | · | ◆* | ◆* | · | · | · | · | · | · |
| A8 supply chain | ◆ | ◆ | ◆ | ◆ | ◆ | ◆ | ◆ | ◆ | ◆ |
| A9 endpoint | ◆ | ◆ | ◆ | ◆ | ◆ | ◆ | ◆ | ◆ | ◆ |
| A10 extension | ◆ | ◆ | ◆ | ◆ | ◆ | ◆ | ◆ | ◆ | ◆ |
| A11 coerced | ◆ | ◆ | ◆ | ◆ | ◆ | ◆ | ◆ | ◆ | ◆ |
| A12 insider | ◆ | ◆ | ◆ | ◆ | ◆ | ◆ | ◆ | ◆ | ◆ |
| A13 thief | · | ◇† | ◇† | ◇† | ◇† | ◇† | ◇† | ◇† | ◇† |

`*` A6 and A7 do not *read* findings; they *shape* them (A6 through pack content, A7 through
corpus prose), which for the "cause a bad config to be deployed" goal is worth more. See §8
goal B.

Read the table by rows. **Five actors have a full row of `◆` — A5, A8, A9, A10 and A11 — and
A12, whom §3.1 calls "A8's leverage with A1's legitimacy", shares A8's full row** (count and
missing rows corrected per ADR-0015; the earlier "four" excluded the supply-chain actor from
the conclusion this table supports, which is the opposite of §8.4's own finding). A5, A9, A10
and A11 are the actual threat to this product. A1, A2, A3 and
A13 — the actors the zero-knowledge architecture is built for — are the cheap ones to defend
against, and we have defended against them well. That asymmetry is uncomfortable and it is the
correct read of the model: **the cryptography is not the weak link, and building more of it is
not where the next unit of security comes from.**

### 3.3 Three actors that are routinely underrated

**A10, the malicious extension, is the most underrated actor in this entire model.** It costs an
attacker one plausible utility in a store and a user who clicked "Add". It requires no exploit,
no malware, no privilege escalation and no persistence trick. The platform grants it, by design,
access to the page. §6.2 does the mechanics. The reason it is underrated is that it *feels* like
malware and is priced like a browser feature.

**A6/A7, the pack and corpus authors, are underrated because they attack the wrong asset.** They
cannot read a workspace. They do not want to. Their target is the *findings* — a pack that
lowers `ipsec.pfs.absent` to informational, or writes an `acceptable_when` reading *"acceptable
for any peer that has not been upgraded"*, changes what the defender believes about their own
network. It is an integrity attack on judgement, not a confidentiality attack on data, and the
signing chain in `docs/10-core/12-rule-engine.md` §13 bounds *who* can do it without bounding
*what* a trusted publisher may say.

**A11, the coerced user, is underrated because engineers try to solve it technically.** It is not
a technical problem. §6.6.

---

## 4. Trust boundaries

### 4.1 The diagram

```text
                    everything inside this box is ONE trust domain
                    ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐
 ENDPOINT  ─────────────────────────────────────────────────────────────────────────
 ┌─────────────────────────────────────────────────────────────────────────────────┐
 │  OS user session          │                                       │             │
 │   ┌───────────────────────┼───────────────────────────────────────┼──────────┐  │
 │   │ BROWSER               │                                       │          │  │
 │   │                       │                                       │          │  │
 │   │  extensions ══════════╪══(B0)══════════════════════════════▶  │          │  │
 │   │   (host perms)        │   NOT A BOUNDARY — see §4.3           │          │  │
 │   │                       │                                       │          │  │
 │   │   ┌───────────────────┼───────────────────────────────────────┼───────┐  │  │
 │   │   │ ORIGIN / RENDERER │                                       │       │  │  │
 │   │   │                   ▼                                       ▼       │  │  │
 │   │   │  ┌──────────────────────┐   (B1)   ┌───────────────────────────┐  │  │  │
 │   │   │  │ TypeScript UI        │◀────────▶│ WASM core (Rust)          │  │  │  │
 │   │   │  │ DOM · events · paste │  typed   │ graph · rules · emitters  │  │  │  │
 │   │   │  │ clipboard · render   │  calls   │ parsers · envelope · KDF  │  │  │  │
 │   │   │  └──────────────────────┘          └───────────────────────────┘  │  │  │
 │   │   │           │                                     │                 │  │  │
 │   │   │           │ (B2)                                │ plaintext graph │  │  │
 │   │   │           ▼                                     │ lives here      │  │  │
 │   │   │   ┌───────────────────────┐                     │                 │  │  │
 │   │   │   │ OPFS / IndexedDB      │◀────────────────────┘                 │  │  │
 │   │   │   │ CIPHERTEXT ONLY       │  envelope bytes                       │  │  │
 │   │   │   └───────────────────────┘                                       │  │  │
 │   │   └───────┬──────────────┬──────────────┬───────────────┬─────────────┘  │  │
 │   │           │(B3)          │(B4)          │(B5)           │(B6)            │  │
 │   └───────────┼──────────────┼──────────────┼───────────────┼────────────────┘  │
 │               │              │              │               │                   │
 └───────────────┼──────────────┼──────────────┼───────────────┼───────────────────┘
                 │              │              │               │
                 ▼              ▼              ▼               ▼
          ┌────────────┐  ┌───────────┐  ┌──────────┐   ┌──────────────────┐
          │ CLIPBOARD  │  │ FILESYSTEM│  │ SCREEN   │   │ AI TRANSPORT     │
          │ config,    │  │ .fathom   │  │ pixels   │   │ tier 1: provider │
          │ commands,  │  │ .fpack    │  │ (nothing │   │ tier 2b: 127.0.0.1
          │ findings   │  │ exports   │  │ stops a  │   │ tier 3: operator │
          │ PLAINTEXT  │  │ CIPHERTEXT│  │ camera)  │   │ REDACTED PLAIN   │
          └─────┬──────┘  │ or plain  │  └──────────┘   └──────────────────┘
                │         │ on export │
                ▼         └───────────┘
        terminal · ticket · chat · wiki
        ── OUTSIDE THE MODEL ENTIRELY, §6.5 ──

                                    │ (B7)  TLS 1.3, one origin
                                    ▼
 ┌────────────────────────────────────────────────────────────────────────────────┐
 │ SYNC SERVICE — UNTRUSTED BY DESIGN                                             │
 │  ┌──────────┐   ┌──────────────────┐   ┌────────────────────────────────────┐  │
 │  │ auth     │   │ blob / delta     │   │ metadata: ids, sizes, timestamps,  │  │
 │  │ (B8)     │   │ store CIPHERTEXT │   │ device count, source IPs — §7      │  │
 │  └──────────┘   └──────────────────┘   └────────────────────────────────────┘  │
 └───────────────────────────────┬────────────────────────────────────────────────┘
                                 │ (B9)
                                 ▼
 ┌────────────────────────────────────────────────────────────────────────────────┐
 │ HOSTING PROVIDER — hypervisor · block store · snapshots · backups              │
 └────────────────────────────────────────────────────────────────────────────────┘

 ─────────────────────────────────────────────────────────────────────────────────
 OFF-PATH, BUT IN THE MODEL:

  ┌──────────────┐  (B10) signed release   ┌────────────────┐
  │ BUILD & SIGN │────────────────────────▶│ THE ARTIFACT   │──▶ endpoint
  └──────────────┘  Ed25519 + repro build  └────────────────┘
  ┌──────────────┐  (B11) signed .fpack    ┌────────────────┐
  │ PACK AUTHOR  │────────────────────────▶│ rule pack      │──▶ WASM core
  └──────────────┘  minisign, scoped key   └────────────────┘
  ┌──────────────┐  (B12) untrusted text   ┌────────────────┐
  │ WHOEVER WROTE│────────────────────────▶│ pasted config  │──▶ parsers
  │ THAT CONFIG  │  no signature, no trust └────────────────┘
  └──────────────┘
```

### 4.2 The boundary register

| ID | Boundary | Crosses it | Direction | Confidentiality | Integrity | Real boundary? |
|---|---|---|---|---|---|---|
| **B0** | Extension ↔ page | DOM, page storage, page JS context | ext → page, unrestricted | none | none | **No.** §4.3 |
| **B1** | TypeScript UI ↔ WASM core | typed calls: graph ops, emit requests, parse requests, envelope open/seal, passphrase bytes | both | none | none against the UI; **memory safety against pasted config** | **No** against JS. **Yes** against untrusted input. §4.3 |
| **B2** | Origin ↔ browser storage | envelope bytes, never plaintext graph | both | origin isolation only | none | Weak. Same-origin JS reads it; so does B0 |
| **B3** | Origin → clipboard | emitted config lines, commands, findings — **plaintext** | out | none | n/a | **No.** Any app can read the clipboard |
| **B4** | Origin ↔ filesystem | `.fathom` (ciphertext), `.fpack`, exports (may be plaintext) | both | file permissions | pack signature on the way in | Yes, weakly |
| **B5** | Origin → screen | rendered pixels | out | none | n/a | **No.** §6.4 |
| **B6** | Origin → AI transport | tier 1: redacted projection in plaintext. tier 2b: same, to loopback. tier 3: same, to one operator origin. tier 0/2a: **nothing** | out | TLS to the endpoint; **plaintext at the endpoint** | provider's | **Yes, and the most consequential one at tier 1** |
| **B7** | Client ↔ sync service | envelope ciphertext, workspace id, auth token, version counters | both | TLS + payload already encrypted | AEAD tag; server cannot forge content | **Yes.** The main designed boundary |
| **B8** | Sync auth | account identity, device identity | in | TLS | server-side | Yes — and it is an *availability and metadata* boundary, not a confidentiality one |
| **B9** | Service ↔ hosting provider | disk blocks, snapshots, memory of the service process | out of our control | none | none | **Yes, and we do not control it — which is exactly why the server holds no key** |
| **B10** | Build → artifact | the shipped code | out | n/a | Ed25519 signature + reproducible build + published hash | **Yes. The highest-leverage one in the model** |
| **B11** | Pack author → core | rules, prose, remediation, severity | in | n/a | minisign/Ed25519, scoped trust store, no TOFU | Yes for *who*; **not for *what*** |
| **B12** | Whoever wrote that config → parsers | arbitrary bytes claiming to be device configuration | in | n/a | **none, by construction** | **Yes, and it is the only boundary that is fully attacker-controlled by design** |

### 4.3 The two boundaries that are not boundaries

Both of these look like boundaries in a diagram and both will be misread as protective by anyone
skimming, so they are stated explicitly.

**B0 — extension ↔ page.** The browser draws a line here and calls it an isolated world. It is a
*namespacing* line, not a security line. §6.2 does this in detail.

**B1 — TypeScript ↔ WASM.** The WASM core is not a sandbox against the UI. They share an origin,
a process, and — through the linear memory buffer — an address space that JS can read as a
`Uint8Array`. Any JS in the origin can call any exported function, in any order, with any
arguments, and can read the whole heap. Placing the crypto in Rust does not hide the key from
JavaScript; it hides it from *memory-corruption bugs in the parsers*, which is a different and
still worthwhile guarantee.

What B1 genuinely buys, and it is worth having:

| Guarantee | Against what |
|---|---|
| Memory safety in the parsers | B12 — a malformed `display set` capture cannot produce a buffer overflow or a use-after-free, because safe Rust does not have those |
| Bounded, non-Turing-complete rule evaluation | B11 — a rule condition cannot loop forever or reach outside its inputs (see `12-rule-engine.md` §3.3) |
| A single audited egress site | Nothing in the core imports a network host function. A reviewer can check this with `wasm-objdump -x` and read the import section. §5.3 |

What B1 does not buy, and must never be described as buying: protection of key material or
plaintext from anything with code execution in the origin.

**RECOMMENDATION —** the architecture diagrams in `50-design/` should draw B0 and B1 as dashed
lines with the label `not a security boundary`, in the field card's margin-tab register:
lowercase, unpunctuated, in the muted `#5C6772`. A boundary drawn solid is a claim.

---

## 5. In scope

### 5.0 What is extension

The owner's table has seven rows and two columns. This has nineteen rows and five. The seven
original rows are marked `[brief]`; the rest are extension. Two columns are new: **residual**,
because §1.3 demands it, and **third-party verification**, because a security claim nobody
outside the project can check is a marketing claim.

### 5.1 The table

| # | Threat | The attack, concretely | Mitigation | Residual | Verified by a third party how |
|---|---|---|---|---|---|
| 1 | **Server compromise** `[brief]` | RCE in the Axum service, or SQL access as the API's database user; dump the blob table and the account table | Zero-knowledge. The store holds envelope bytes and metadata; no key, no key-derivation material beyond the public salt, no plaintext | `bounded` — all §7 metadata, plus the ciphertext for offline cracking against V1 | Run the server locally, exercise sync, dump every table and every log, grep for anything not ciphertext or metadata. The reviewer does not need our cooperation to do this |
| 2 | **Server operator (insider)** `[brief]` | Reads the store directly, or adds logging to the request path | Same as 1. The operator's position confers no cryptographic advantage over an intruder | `bounded` — same as 1, plus they can *modify* the service to serve altered client assets in the served build. See row 16 | Same as 1, plus: pin the client. A served build's asset hashes should be checkable against the published release |
| 3 | **Hosting / cloud provider** | Snapshots the volume; reads the block store; dumps service memory | Same as 1. Service memory contains no key even under a full hypervisor read | `bounded` — same as 1 | Same as 1. The property being checked is a property of the protocol, not of the deployment |
| 4 | **Network interception, passive** `[brief]` | Taps the path; captures the TLS stream | TLS 1.3 + the payload is already ciphertext. Two independent layers, and the inner one does not depend on the outer | `bounded` — sizes and timings, §7 | Capture the traffic yourself. Confirm the request body is high-entropy and that no key material or plaintext identifier appears in it |
| 5 | **Network interception, active** | Terminates TLS with a trusted-in-the-enterprise CA; alters or replays requests | Inner AEAD means a MITM cannot read or forge *content*. They can drop, reorder, replay whole versions, and deny service | `material` — replay of an old workspace version is possible unless version counters are authenticated and monotonic. Denial is always possible | Run the client behind your own interception proxy. Confirm no plaintext. Then confirm the client rejects a replayed older version |
| 6 | **Lost / stolen endpoint** `[brief]` | Takes the laptop; images the disk; recovers OPFS/IndexedDB and any `.fathom` files | Nothing sensitive persisted in plaintext. The envelope is sealed with a key derived from the passphrase; no key material is cached to disk | `material` — offline cracking against V1 (§2.4), plus any plaintext the *user* exported to disk, plus browser artifacts (row 14) | Steal your own laptop. Image it. Search the image for a known unique string from your workspace. That test is cheap and it is the one enterprises actually run |
| 7 | **Malicious image substitution** `[brief]` | Publishes a Trojan Docker image or a modified single-file build under our name | Signed images and releases; reproducible builds; hashes published in the release notes and in the tag | `material` — nothing forces a user to check, and §8 goal C shows most will not | Rebuild from the tag on your own machine, compare the hash to ours. This is the only mitigation in the table that a third party can verify *completely*, and it is why it is worth the cost |
| 8 | **Supply chain — runtime dependencies** `[brief]` | A crate or npm package in the shipped artifact ships a backdoor. `xz-utils` (CVE-2024-3094) is the reference case | Minimal runtime dependency surface (brief §8.4); `cargo-vet` / `cargo-deny` in CI; lockfiles committed; no runtime fetch of anything | `material` — a small dependency set is a smaller target, not a safe one | Read `Cargo.lock` and the vendored tree in the published source; rebuild and compare. An SBOM published with each release makes this a diff instead of an audit |
| 9 | **Supply chain — build toolchain** | Compromises the builder, the signing key, or a build-time-only dependency | Reproducible builds make a compromised builder *detectable* by anyone who rebuilds. Signing key handling belongs in `70-ops/` | `material` — detection requires someone to actually rebuild. If nobody rebuilds, reproducibility proves nothing | Rebuild independently. Publish your hash. **Reproducibility is a social control with a technical mechanism, and it fails if the social half is absent** |
| 10 | **Data exfiltration by the application** `[brief]` | The app quietly posts the workspace somewhere | Invariant 1. `connect-src 'none'` in the offline build; exactly one origin in the sync build; the policy is a build-time property, not a setting (`21` §7.5). No telemetry, no analytics, no font CDN, no error reporting | `bounded` — a *tampered* build can ship any CSP it likes, which routes this threat back to rows 7 and 9. At tier 1 this row does not apply: egress is the feature | Read the `<meta>` CSP in the single file, or `curl -I` the served build. Then run the app in a namespace with no route and use every feature. Then `wasm-objdump -x` and read the import section: no network host functions |
| 11 | **Malicious rule pack** | Publishes a pack that downgrades a real finding, or writes an `acceptable_when` that manufactures consent for a weakness | Ed25519/minisign detached signatures; scoped trust store; **no trust-on-first-use**; presentation-only overrides — `condition`, `applies_to`, `requires`, `platforms` cannot be changed under someone else's rule id (`12-rule-engine.md` §12.6, §13) | `material` — signing bounds *who*, never *what*. A trusted publisher who turns hostile or careless ships hostile or careless rules, correctly signed | `minisign -Vm pack.fpack -P <key>` using a key you obtained out of band and our tool nowhere in the loop. Then diff the pack's rule tree against the previous version |
| 12 | **Malicious corpus contributor** | Merges an explainer that teaches a wrong verification step — e.g. that a tunnel reading `UP` proves traffic is passing, which the field card explicitly denies | Invariant 10: human-authored, `reviewed_by` recorded per entry; corpus content is signed with the pack it ships in; content hashes published | `material` — review catches carelessness, not a patient contributor. And a *wrong* explainer is quieter than a wrong rule because nothing fires | Read the corpus. It is YAML, it is in the repo, and it is the most reviewable artifact we ship. `reviewed_by` gives a name to ask |
| 13 | **Colleague with workspace access** | Copies the workspace on the way out; or their account is phished and the attacker inherits everything | **Almost none, by design.** There is no in-workspace compartmentation: one passphrase, one document, everything. Git history gives after-the-fact attribution of changes, not of reads | `material`, and honestly closer to `total` for read access | Nothing to verify. This is a fact about the design, and §10 states it as a non-claim |
| 14 | **Local browser artifacts** | Recovers plaintext from swap, a renderer crash dump, a tab-discard snapshot, the back/forward cache, or a devtools heap snapshot | WASM linear memory can be explicitly zeroed on lock; the UI holds as little decrypted material as it can; no plaintext ever written to storage | `material` — the browser may page or snapshot the renderer at any time and we get no notification. The passphrase's JS string cannot be erased at all (§2.4) | Heap-snapshot the tab in devtools after locking the workspace and search for a known string. This is a test we should run in CI and publish (§12) |
| 15 | **Malicious pasted configuration** | Feeds the parsers hostile text: deep nesting, pathological backtracking, decompression bombs in a dropped file, invisible Unicode, prompt injection aimed at the AI layer | Safe Rust parsers (B1); explicit input caps; no `eval`; Trusted Types; and for the AI layer, the structural argument in `23-ai-safety-and-injection.md` — the model's powers are propose/select/order/ask/abstain and every one is deterministically checked | `bounded` for memory safety and DoS. `material` for injection: an injected instruction cannot be filtered out, only made worthless | Feed it the fuzzing corpus. We ship one. A reviewer can run it and can add to it |
| 16 | **Cross-origin attack on the served build** | XSS, clickjacking, or CSRF against the sync API from another origin | CSP with `default-src 'none'`, hash-pinned inline scripts, `require-trusted-types-for 'script'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`. Sync auth in a header, not an ambient cookie | `material` in the **single-file build only**: `frame-ancestors` and `report-uri` are ignored when the policy is delivered via `<meta>`, so that build has no CSP-level clickjacking control and no violation reporting. Its defence is that it is a `file://` document | Read the CSP. Try to frame it. The single-file gap is real and is stated here rather than papered over |
| 17 | **Sync service abuse** | Enumerates workspace ids; exhausts storage; floods versions to deny service | Opaque high-entropy workspace ids; per-account quota; rate limits; version-count caps | `bounded` — availability is not a property zero-knowledge protects, and an operator can always deny service to their own users | Try it against your own instance |
| 18 | **Update rollback / freeze** | Serves an old, correctly signed release with a known defect, or simply stops serving updates so the user never learns one exists | No silent auto-update. A signed version manifest with an expiry; the client knows its own build date offline and surfaces staleness | `material` — an offline single file cannot learn that a newer version exists. It can only report its own age, which is not the same thing | Check the manifest signature and expiry yourself. Compare your build date to the published release list |
| 19 | **Passphrase brute force** | Obtains the ciphertext (rows 1–6) and grinds offline | Argon2id with published parameters in the envelope header; a generated-passphrase path in the UI that is the default rather than the alternative; an entropy estimate shown at entry that is a floor, not a score out of five | `material` — see §2.4. This mitigation is a constant factor against an unbounded search | Read the KDF parameters out of the envelope header; they are in the clear and authenticated as AEAD associated data. Then benchmark it yourself |
| 20 | **Traffic analysis / metadata at the sync server** (moved here from §6.7 per ADR-0015 — it is mitigated, so it is in scope with a residual, not given up on) | The server correlates existence, size, change events and timing (§7.2's channels) into the inference §7.3 works through | Padmé padding on by default (§7.6); batching (§7.5); whole-container upload by default; and the honest option of not syncing at all | `material` — the channels are reduced, never closed. §7.7: no padding scheme fixes timing | Watch your own server's logs |

### 5.2 Six rows that need more than a cell

**Row 5, replay.** AEAD stops forgery, not replay. A network attacker or a hostile operator can
serve version *n−k* of a workspace and the client will decrypt it perfectly. The control is a
monotonic version counter inside the authenticated envelope plus a client-side record of the
highest version it has seen for that workspace id. Then a rollback is detectable — as a refusal,
with a clear message, not a silent acceptance. **The cost is a genuine false positive**: a user
restoring an older workspace from their own backup trips exactly the same check, and the flow to
override it is the flow an attacker wants them to learn. The mitigation for *that* is that the
override is a typed confirmation naming both versions and their dates, not a button.

**Row 7 and 9, reproducible builds.** These are the two rows with the strongest verification
story and the weakest realised value, and the honest statement is: reproducibility converts
"trust our build" into "trust that somebody rebuilt", and nobody rebuilds unless a third party
makes it their job. The mitigation for the mitigation is to run an independent rebuild in a
separate CI account with separately held credentials, publish the resulting hash, and make a
divergence a release blocker. That is a process control, it costs a second pipeline, and without
it row 7's verification column is aspirational.

**Row 10, the CSP.** The single most important property of the no-egress claim is that it is a
*build-time* property. A user cannot type an arbitrary endpoint into the offline single file and
have it work, because the policy in that artifact says `connect-src 'none'` and no setting
changes it (`21` §7.5). The cost is friction: a user who wants a provider we did not enumerate
must build their own artifact. That trade is correct — a security claim that a settings screen
can revoke is not a claim about the artifact.

**Row 11 and 12, the signing gap.** Say this in the review pack because someone will find it:
*a signature proves origin, not correctness.* A correctly signed pack from a trusted publisher
containing a rule that says PFS is optional is exactly as installable as a good one. The controls
that remain are that rule logic cannot be overridden under someone else's id, that packs are
diffable between versions, and that `acceptable_when` forces the justification into text a
reviewer can read. None of those is a technical guarantee of correctness and we should not imply
one.

**Row 14, browser artifacts.** This deserves emphasis because it is the row most likely to be
skipped by an implementer. Zeroing WASM memory on lock is straightforward and worth doing. It
does not cover: the OS paging the renderer to swap, the browser writing a session-restore
snapshot, a renderer crash dump, or JS strings that the language will not let us overwrite. The
honest position is that locking a workspace reduces the window and does not close it, and that
the only real control is closing the tab and, for anyone who cares seriously, full-disk
encryption with a powered-down machine.

**Row 15, injection.** The design does not try to prevent prompt injection; it tries to make it
boring. The full argument is in `23-ai-safety-and-injection.md` and this document does not repeat
it. The threat-model-level statement is: a successful injection buys the attacker no capability
they did not already have when they handed the user a config to look at, because the AI layer
cannot emit, cannot commit, cannot reach a device and cannot originate egress. That is a bound on
damage, not a prevention, and it is stated as such.

### 5.3 The verification column, as a checklist

An enterprise reviewer with a laptop, half a day, and no cooperation from us can establish the
following. This list is the deliverable of the whole security posture, so it is written as
something someone actually executes:

| # | Check | Command / action | What a pass looks like |
|---|---|---|---|
| 1 | The offline build cannot reach the network | Open the single file; read the `<meta http-equiv="Content-Security-Policy">` | `connect-src 'none'` present, `default-src 'none'` present |
| 2 | …and does not try | Run it in a network namespace with no default route, or with devtools Network open, and use every feature | Zero outbound requests |
| 3 | The core has no network capability at all | `wasm-objdump -x fathom_core.wasm` and read the import section | No imported host function that can originate a request |
| 4 | The build matches the source | Rebuild from the tag in a clean container; compare BLAKE3 | Identical hash to the published one |
| 5 | Rule packs are independently verifiable | `minisign -Vm fathom.ipsec-2.4.1.fpack -P <key>` | Valid, with our tool nowhere in the loop |
| 6 | The server sees only ciphertext | Run the Docker single-node; sync a workspace with a known unique string; dump every table and log; `grep` for it | Not found |
| 7 | The wire carries only ciphertext | Capture the sync request | Body is high-entropy; header fields are the ones §7.2 says they are and no others |
| 8 | Output is deterministic | Emit the same workspace twice, on two machines, same corpus version and build; `cmp` | Byte-identical config, byte-identical findings, identical finder ranking |
| 9 | Nothing sensitive survives on disk | Lock the workspace; heap-snapshot the tab; search for the known string | Not found in WASM memory. **It may still be found in a JS string — see row 14, and this check is expected to be partial** |
| 10 | The KDF is what we say | Read the envelope header, which is in the clear and authenticated | Argon2id, parameters as published |

Check 9 is written to fail partially on purpose. A checklist where every item passes is a
checklist somebody wrote backwards from the answers.

---

## 6. Out of scope

The owner's instruction is that this "must be documented, not hidden". So: no softening, no
"however", no compensating-control paragraph at the end of each item to make it feel handled.
Each item states why the architecture cannot address it, what the user should do instead, and
where the product says so.

### 6.1 The table

| Threat | Why it cannot be mitigated | What the user should do instead | Where the product says so |
|---|---|---|---|
| **Compromised browser** | Defensive code runs in the same context as the attacker. Every detection we could write is code the attacker rewrote first. §6.2 | Keep the browser current. Use a separate browser profile, or the CLI, for sensitive workspaces | Limits panel; the `unlock` screen's muted line |
| **Malicious browser extension** | The platform grants extensions access to the page's DOM and, with a debugger attach, to its whole JS context. There is no origin-level control that revokes it. §6.2 | Use a dedicated browser profile with no extensions. Or the CLI, which has no extension surface | Limits panel, first item, named as the most likely real compromise |
| **Compromised endpoint OS** | Malware with the user's privileges reads memory, keystrokes, screen and files. Encryption at rest protects against a thief, not against something running as you. §6.3 | Endpoint hygiene and full-disk encryption; treat a suspected compromise as workspace compromise and rotate the passphrase *and* assume prior disclosure | Limits panel |
| **Keyloggers** | The passphrase is typed. Anything between the keyboard and the input captures it. §6.3 | Prefer a password manager's autofill over typing, understanding it moves rather than removes the problem; rotate after any suspected compromise | Unlock screen; limits panel |
| **Shoulder-surfing, cameras, screen recording** | The product's job is to display network configuration. Displaying it is the feature. §6.4 | Screen position, privacy filters, awareness in shared spaces. Lock the workspace when you walk away | Limits panel; the lock control is deliberately prominent |
| **The user pasting output somewhere else** | The output is a `(line, provenance)` pair the user asked for, on their clipboard, by design. Invariant 2 means copy-paste is *the* delivery mechanism. §6.5 | Know where your ticketing system, chat and wiki store data and who can read them. Treat a config paste as a disclosure decision | Limits panel; the copy affordance carries the risk legend |
| **Coercion (rubber-hose)** | No amount of cryptography survives a person being compelled to disclose. §6.6 | Do not create the workspace in a jurisdiction or situation where this is your threat. Deniability is not a feature we offer | Limits panel, stated plainly with the legal note in §6.6 |

Traffic analysis at the sync server is **not** in this table (ADR-0015): the product does
mitigate it, so it belongs in §5.1 — row 20 — with a `material` residual. A mitigated channel
filed under "out of scope" teaches a reviewer to discount every other row here, and §6 must
contain only threats with a `total` residual.

### 6.2 Compromised browser and malicious extensions

This is the longest item because it is the most likely one to actually happen and the most
frequently hand-waved.

**The completion of the owner's truncated sentence.** Defensive code runs in the same context as
the attacker. Concretely: if hostile code executes in the Fathom origin, then

- it reads the decrypted graph out of WASM linear memory as a plain `Uint8Array`;
- it calls any exported core function, including `seal`/`open`, with any arguments;
- it reads the passphrase from the input element before we ever see it;
- it rewrites the DOM so the user sees a lock icon that means nothing;
- it rewrites any integrity check we wrote, because that check is a function it can replace;
- and it does all of this while the CSP still reads `connect-src 'none'`, because the CSP
  restricts *this document's* requests, and the attacker has other ways out.

There is no arrangement of application code that changes this. An application cannot be its own
trusted computing base.

**Extension mechanics, precisely.** The details matter because "extensions can read the page" is
usually asserted without the shape of it, and the shape has one nuance that people mistake for a
protection.

| Capability | Mechanism | What it reaches |
|---|---|---|
| Read and modify the rendered page | A content script with a matching host permission | The **whole DOM**: every emitted config line, every finding, every peer address on screen, and the value of the passphrase input |
| Observe everything the user types | DOM event listeners from that same content script | Keystrokes, including into the passphrase field. An extension keylogger needs no OS privilege |
| Reach the page's own storage and JS objects | **Not** directly from the isolated world — content scripts do not share the page's `localStorage`/IndexedDB namespace. But the extension injects into the page's own world (`chrome.scripting.executeScript({ world: "MAIN" })`, or a `<script>` element it appends) and that code *is* page code | OPFS, IndexedDB, every global, the WASM instance and its memory |
| Bypass the page CSP entirely | With the `debugger` permission plus host access, attach the DevTools protocol to the tab and call `Runtime.evaluate` | Arbitrary execution in the page context, outside the CSP's reach <!-- VERIFY: confirm current Chrome/Firefox behaviour for Runtime.evaluate versus page CSP before quoting this in the review pack. The Chromium issue tracker discussion of debugger-permission attacks is the anchor, not vendor documentation. --> |
| Exfiltrate what it read | The extension's own service worker, under the extension's own CSP and host permissions | Anywhere it likes. Our `connect-src 'none'` does not apply to it |

**The isolated world is not a security boundary for us.** It stops a *careless* content script
from colliding with page globals. It does not stop a *deliberate* extension from reaching the
page context, because the platform provides a documented, supported API for doing exactly that.
Anyone who cites isolated worlds as a mitigation has confused a namespacing mechanism for an
access control.

**What this means for the product, honestly.** The most probable route to a Fathom workspace
being read by someone who should not read it is not a cryptographic break, not a server
compromise, and not a network attack. It is a browser extension the user installed for some
unrelated convenience, in a browser they also use for work. That is one click away from every
Fathom user right now, and there is nothing we can build to stop it.

**What the user should do instead:** a dedicated browser profile with zero extensions for
workspace work, or the native CLI, which has no extension surface at all. This is the strongest
argument for shipping the CLI beyond automation, and it belongs in the CLI's own justification.

**Where the product says so:** the limits panel lists this first, not last, and the sentence is
*"an extension you installed for something else can read everything on this screen — including
this passphrase field."* Not a warning dialog. Dialogs get dismissed; the field card's device is
a single line of muted prose in the right place, and that is what this should be.

### 6.3 Compromised endpoint OS, and keyloggers

Malware running as the user is the user. It reads process memory (the decrypted graph), it reads
the keyboard (V1), it reads the screen, it reads files, it reads the clipboard, and it can wait
patiently for the workspace to be unlocked rather than attacking the crypto at all.

There is no client-side control for this because there is no position from which to apply one:
anything we run is running under the attacker's OS. Attestation does not help — an attested
measurement is only as good as the thing doing the measuring, which is also compromised.

**Instead:** treat endpoint compromise as workspace compromise. Rotate the passphrase, and
assume prior disclosure — rotation protects future ciphertext, not the copies already taken. If
the workspace contains peer identities and cipher choices for tunnels that lack PFS, the
appropriate response is a network change, not a password change. That is an unpleasant sentence
and it is the correct one.

**Surface:** the limits panel, and the passphrase-rotation flow, which should say what rotation
does and does not achieve rather than implying a clean slate.

### 6.4 Shoulder-surfing, cameras, screen capture

The product's entire purpose is to render network configuration legibly on a screen. Every
control against visual capture is a control against the product working.

There is one thing worth doing and it is small: the lock action must be one keystroke and must
clear the rendered content, not merely overlay it. An overlay is a screenshot away from nothing.

**Instead:** physical awareness, screen position, privacy filters, and locking on walk-away.

**Surface:** the lock control is visually prominent — one of very few things in an interface
whose design language explicitly forbids chrome — and the limits panel names screen capture.

### 6.5 The user pasting output somewhere else

This is not a failure mode; it is the delivery mechanism. Invariant 2 says the application never
touches a device, so **every useful output of this product ends its life on a clipboard and then
in a terminal, a change ticket, a chat message or a wiki page.** The moment it lands there it is
under that system's security model and ours has ended.

We cannot mitigate this without either (a) touching devices, which is a permanent product
boundary, or (b) monitoring what the user does with their clipboard, which would require exactly
the surveillance the product refuses. Both cures are worse.

**Instead:** know the retention and access model of your ticketing system before you paste a
config into it. The tool can help slightly by making the *scope* of what is being copied legible
— the copy affordance shows the risk legend, so a copy that includes `Disruptive` lines is
visibly different from one that does not — but that is a labelling improvement, not a control.

**Surface:** the limits panel, and the copy affordance itself.

### 6.6 Coercion

A `.fathom` file plus a person plus sufficient pressure equals plaintext. This holds under any
cryptosystem and any implementation.

Two specific reasons we do not offer a technical answer:

**Legal compulsion is a real, ordinary process in some jurisdictions.** In the UK, a notice under
s.49 of the Regulation of Investigatory Powers Act 2000 can require disclosure of a key or
passphrase, and s.53 makes knowing failure to comply an offence carrying up to two years'
imprisonment, or up to five in national-security and child-indecency cases. This is not an exotic
scenario; it is a documented power with documented penalties.

**We will not ship deniable encryption.** Hidden volumes and duress passphrases fail in practice
for reasons that are well understood: the container format, the file size, the access timestamps
and the sync history all argue for the existence of the hidden thing, and a coercer who believes
one exists escalates rather than stops. A deniability feature that does not survive an adversary
who knows the feature exists makes the user's position worse, not better, and every user of a
public tool is such a case by definition.

**Instead:** do not create the workspace where this is your threat model. There is no technical
answer, and offering one would be a lie with consequences.

**Surface:** the limits panel, in these words: *"if someone can compel you to give up the
passphrase, they get everything. We do not offer a duress passphrase or a hidden workspace,
because neither works against someone who knows the feature exists."*

### 6.7 Traffic analysis and metadata — moved (ADR-0015)

> **Moved to §5.1 row 20 per ADR-0015.** It is partially mitigated (§7), so it is in scope
> with a `material` residual; filing it here implied the project had given up on it. §6
> contains only threats whose residual is `total`.

### 6.8 Where all of this is surfaced — the limits panel

One place, dense, permanent, linked from the lock indicator on every screen. Not a modal, not an
onboarding step, not a tooltip, not an empty state.

The design language forbids the usual devices — no icons, no cards, no rounded corners, no
progress bars — which is exactly right for this content. The field-card grammar maps onto it
directly:

| Field card device | Use in the limits panel |
|---|---|
| The one-line imperative in caps at the top | `ENCRYPTION PROTECTS THE FILE, NOT THE MACHINE IT IS OPEN ON` |
| Two-column table, horizontal hairlines only | Left column: the threat. Right column: what to do instead. Exactly §6.1 |
| The margin tab, lowercase and unpunctuated | `outside the model`, `not protected`, `your endpoint`, `no technical answer` |
| The 4px left accent bar and wash | Used only where a *finding* is involved. **Not** used to decorate this panel — the three risk colours mean one thing each and threat text is not one of them (§1.4) |

**RECOMMENDATION —** the limits panel ships as content, in the corpus, with a `reviewed_by`,
under the same review discipline as any explainer. It should be the same text in the application,
in the README, and in the enterprise review pack, with no marketing pass applied to any of the
three. The moment those three diverge, the shortest one becomes the true one.

---

## 7. The metadata problem

### 7.1 The precise statement

Zero-knowledge is a claim about **contents**. It is not a claim about existence, size, change
frequency, time of day, duration, device count or source address. The server learns all of those
without decrypting anything, and it learns them as a *time series*, which is worth more than any
single observation.

Stated as the sentence that should appear in the sync setup screen:

> **The server cannot read your workspace. It can see that you have one, roughly how big it is,
> and every time you change it.**

### 7.2 The channels, enumerated

| # | Channel | Where it comes from | What it discloses |
|---|---|---|---|
| M1 | **Existence** | a row in the store | This account uses Fathom, and has *n* workspaces |
| M2 | **Size** | ciphertext length, chunk count in the envelope header | Estate scale. A 40 KiB workspace is one site; a 2 MiB one is a modelled estate |
| M3 | **Size over time** | the sequence of M2 | Growth rate. A step change is a project; a plateau is a finished build |
| M4 | **Change events** | upload timestamps | Working pattern, at whatever resolution the sync cadence provides |
| M5 | **Time-of-day / day-of-week** | the distribution of M4 | Timezone, working hours, and — the interesting one — *out-of-hours* activity, which correlates with change windows |
| M6 | **Device count** | distinct device identities syncing one workspace | Team size, and whether it changed |
| M7 | **Source addresses** | TLS connections | Organisation (from the netblock), site (from a fixed office IP), travel, home working |
| M8 | **Which delta changed** | if sync is CRDT-delta rather than whole-blob | *Which part* of the graph is being edited, at chunk granularity |
| M9 | **Envelope header fields** | `format_version`, `schema_version`, KDF parameters — deliberately outside the ciphertext (`11-ir-schema.md` §11.2) | Client version band. Negligible on its own; a fingerprint in aggregate |
| M10 | **Access pattern** | reads versus writes, and their ratio | Whether this workspace is being actively built or occasionally referenced |
| M11 | **Record kind in the clear** (`IndexEntry.kind_opaque`, `33` §2.5; added per ADR-0015) | the sync index | Which record is the suppressions record — ranked **V3** in §2.1 — making it individually identifiable and trackable: when the list of accepted risks grows, the server sees which record grew |

A twelfth channel — per-frame `hlc.wall_ms` and an actor pseudonym in the clear in every git
object — existed under the frame-based workspace format and was eliminated by ADR-0013's
removal of frames; it is recorded here so the enumeration's history is checkable.

M8 is the one that will be introduced accidentally. Delta sync is the obvious optimisation for a
CRDT workspace, and it turns a single coarse size signal into a fine-grained edit-location
signal. **That trade must be a decision, not a side effect of a performance change.**

### 7.3 A worked inference, to show why this is not academic

Nothing below requires a single byte of plaintext. Take a workspace observed for six weeks:

| Observation | Inference |
|---|---|
| Created 2026-03-02; 41 KiB | New engagement, one or two devices modelled |
| Grows to 2.1 MiB by 2026-04-14, in 23 steps | An estate being modelled. Roughly 800 devices at the sizes we would expect <!-- VERIFY: derive the KiB-per-device figure from real workspaces once the format exists. Do not quote 800 until it is measured. --> |
| Three distinct device ids, two source netblocks | A team of about three, working from two sites or one site plus home |
| Edits cluster 09:00–17:30 UTC, weekdays | UK/Ireland working hours |
| Except: 14 evening bursts, 18:00–23:00, all Tuesdays and Thursdays | Change windows. Fathom is being used *during* changes, not only to plan them |
| A 40 % size jump on 2026-04-09, then near-flat | A cutover completed on that date |
| Nothing at all after 2026-05-20 | Engagement finished, or moved offline |

If that organisation publishes its change windows — as regulated OT operators and many
enterprises do, in filings, in maintenance notices, or in a status page — M5 correlates the
workspace to the organisation without a single decryption. For a defence or OT customer, "an
external party can tell when we are making network changes, and how large the change was" is
itself the finding. The contents were never the point.

**This is why the honest answer for those customers is not a better padding scheme. It is: do
not sync.** The offline single file has no server, no account, no upload and no metadata. That
answer costs collaboration, and it is the correct answer for that customer.

### 7.4 Mitigations, and what each actually removes

| Mitigation | Removes | Leaves | Cost |
|---|---|---|---|
| **Padmé size padding** — pad each ciphertext to a Padmé bucket (Nikitin et al., PoPETs 2019) | Most of M2's resolution. Leakage bounded to O(log log M) bits of the length, comparable to next-power-of-two padding but with at most 12 % overhead, falling to ≈6 % at 1 MB and ≈3 % at 1 GB | The bucket. A 2.1 MiB workspace is still distinguishable from a 41 KiB one — coarse scale survives | Storage and bandwidth overhead as above. Cheap, and the best value in the table |
| **Constant-size blobs** — pad to a fixed size, e.g. 4 MiB, and re-upload whole | M2 and M3 entirely, and M8 with them | Nothing about size | Bandwidth: every save uploads the full padded size. Breaks delta sync. Caps workspace size at the padded size until the next size class, and crossing that class is itself an event |
| **Fixed-cadence batching** — upload on a timer, every *T*, whether or not anything changed | **M4, M5 and M10 entirely.** A constant-rate channel carries no information about activity | M2/M3 unless combined with padding | Up to *T* of divergence between clients; a conflict window of *T*; constant background traffic. §7.5 |
| **Cover traffic between users** | Some of M6/M7 correlation | Everything else | Only works with a large simultaneous user population, which a self-hosted deployment does not have. **Reject** — it is a control that pretends to work at the scale we ship at |
| **Whole-blob instead of delta sync** | M8 | M2–M7 | Bandwidth proportional to workspace size per save, not to the edit |
| **Self-hosting** | Nothing technically; changes *who* holds M1–M10 to someone the user already trusts | All channels, held by the operator | Operational cost. **This is the mitigation most enterprises will actually choose, and it is a governance answer rather than a technical one** |
| **Not syncing** | All of it | Nothing to leak | Loses collaboration, multi-device, and the CRDT story. The only complete answer |
| **Tor / a relay in front of the service** | M7 | Everything else | Latency, operational fragility, and it does not touch the channels that matter |

### 7.5 The batching cost, with numbers

Fixed-cadence batching is the mitigation people reach for and under-price, so here is the
arithmetic for one plausible configuration:

- Cadence *T* = 15 minutes, always, changed or not: **96 uploads per device per day.**
- Constant blob size 256 KiB: **24 MiB per device per day**, ≈ 8.6 GiB per device per year of
  upload, and the same again in stored versions if the server retains history.
- Conflict window: up to 15 minutes of concurrent edits merge at once rather than continuously.
  For a CRDT that is a merge-size problem, not a correctness problem, but it changes the user's
  experience of "I can see my colleague typing" into "I see their work eventually".
- Recovery point objective: **up to 15 minutes of work lost** if the endpoint dies before the
  next tick.
- A user who works for ten minutes and closes the tab produces exactly the same server-visible
  trace as a user who does nothing all day. That is the point, and it is the only mitigation in
  §7.4 that fully closes a channel rather than blurring it.

**The honest summary:** constant-rate plus constant-size reduces the sync server's knowledge to
M1, M6, M7 and M9 — that a workspace exists, how many devices touch it, where from, and roughly
which client version. Nothing removes M1 except not syncing.

### 7.6 DECISION — what ships by default

**DECISION —** Padmé padding on by default; fixed-cadence batching available and off by default;
delta sync explicitly deferred until M8's disclosure is designed for rather than inherited.

Reasoning: padding costs single-digit percent and removes the most-used channel's resolution, so
there is no case for making it opt-in. Batching costs a real recovery-point objective and real
bandwidth, and defaulting it on would make the product feel broken to the large majority of users
for whom M4/M5 are not a threat. Delta sync is a performance optimisation whose privacy cost is
larger than its performance benefit at the workspace sizes we expect, and shipping it first and
retrofitting privacy is the wrong order.

**The cost of this decision, stated plainly:** the default configuration leaks M4 and M5 — every
change, with its timestamp. A defence or OT customer must change a setting, or not sync. So the
setting must be presented at sync setup, not buried, and it must state the recovery-point cost in
the same sentence as the benefit.

### 7.7 What no padding scheme fixes

M1. The existence of a workspace, tied to an account, tied to an IP. If *that* is sensitive — and
for some customers the existence of a network-engineering engagement is the sensitive fact — the
only answer in this architecture is the offline single file. Say so at sync setup, once, in one
line, and do not dress it up.

---

## 8. Attack trees

Notation: `[OR]` — any child suffices. `[AND]` — all children required. Each leaf carries a rough
cost/skill tag: `L` low, `M` moderate, `H` high. Tags are relative judgements, not measurements,
and their only job is to rank the branches against each other.

### 8.1 Goal A — obtain the plaintext of a workspace

```text
A.  READ WORKSPACE W IN PLAINTEXT                                       [OR]
│
├── A1. Decrypt the ciphertext                                          [AND]
│   ├── A1.1 Obtain the ciphertext                                      [OR]
│   │   ├── A1.1.1 Compromise the sync service                      M   (row 1)
│   │   ├── A1.1.2 Be, or compromise, the hosting provider           M   (row 3)
│   │   ├── A1.1.3 Steal or image the endpoint                       L   (row 6)
│   │   ├── A1.1.4 Read the git repo the workspace is committed to   L   ← the forgotten one
│   │   ├── A1.1.5 Recover it from an endpoint backup                L
│   │   └── A1.1.6 Legal process against the operator                L   (nothing to hand over
│   │                                                                     but the ciphertext)
│   └── A1.2 Obtain the passphrase                                      [OR]
│       ├── A1.2.1 Offline guess                                    L–H  (entirely a function of
│       │                                                                 the user's entropy)
│       ├── A1.2.2 Keylog the endpoint                               M   (§6.3)
│       ├── A1.2.3 Extension keylogger on the unlock field           L   (§6.2) ★
│       ├── A1.2.4 Phish a convincing Fathom unlock page             L   ★
│       ├── A1.2.5 Shoulder-surf or camera                           L
│       ├── A1.2.6 Reuse from an unrelated breach                    L   ★
│       └── A1.2.7 Compel the user                                   —   (§6.6)
│
├── A2. Read it after decryption, inside the client                     [OR]
│   ├── A2.1 Malicious extension reads DOM + page context           L   ★★ cheapest overall
│   ├── A2.2 Browser or renderer exploit                             H
│   ├── A2.3 OS-level malware reads process memory                   M
│   ├── A2.4 Ship a malicious build (see goal C)                     H   ★ highest leverage
│   ├── A2.5 XSS in Fathom itself                                    M   (CSP + Trusted Types
│   │                                                                     make this expensive)
│   ├── A2.6 Screen capture / screenshot / camera                    L
│   └── A2.7 Recover from swap, crash dump or heap snapshot          M   (row 14)
│
├── A3. Have a human hand it over                                       [OR]
│   ├── A3.1 Be a colleague with legitimate access                   L   ★★ no attack required
│   ├── A3.2 Social-engineer an export                               L
│   ├── A3.3 Read what the user pasted into a ticket or chat         L   ★★ (§6.5)
│   └── A3.4 Compromise the colleague's account instead              M
│
└── A4. Learn enough without decrypting                                 [OR]
    └── A4.1 Metadata analysis at the server                        L   (§7 — yields M1–M10,
                                                                          not contents)
```

**What the tree says.** The starred leaves are the cheap ones, and none of them is a
cryptographic attack. A2.1, A3.1 and A3.3 dominate: an extension, a colleague, and a paste into
a ticket. The entire zero-knowledge architecture defends branch A1.1 — which the tree shows is
the *hard half of an AND* whose other half (A1.2) is usually cheaper to attack directly.

**The uncomfortable read:** if we spent the next quarter on cryptography, the tree would not
change. The next unit of security in this product comes from A3.1 (workspace compartmentation,
or at least export gating and after-the-fact attribution) and from making A1.2.1 expensive by
defaulting to generated passphrases.

**A1.1.4 deserves its own note.** The brief's §6.4 decision — inventory as a git-versionable
document rather than a database — is right, and it means workspaces will end up in git
repositories. A repository that is world-readable, or that gets forked, or that outlives the
engagement, is an unlimited-time offline cracking target with full version history. **Every
historical version is separately attackable**, so a passphrase rotation does not protect the old
commits. The product should say this at export time, in one line, next to the export.

### 8.2 Goal B — cause a bad configuration to be deployed

"Bad" here means either *weakens security* or *breaks the network*. This is the goal a targeted
attacker actually wants, and it is cheaper than goal A.

```text
B.  A HARMFUL CHANGE REACHES A PRODUCTION DEVICE                        [AND]
│   (needs: a harmful artifact  AND  a human who pastes it)
│
├── B1. Produce a harmful artifact                                      [OR]
│   │
│   ├── B1.1 Corrupt the intent (the graph)                             [OR]
│   │   ├── B1.1.1 Edit the workspace directly           — requires goal A       H
│   │   ├── B1.1.2 Poison a shared workspace via CRDT merge from a
│   │   │          compromised collaborator                                      M
│   │   └── B1.1.3 Prompt-injection via pasted config, aiming to have
│   │              the AI layer propose a weakening                              L
│   │              → bounded: proposals are typed, shown, and require
│   │                a human accept; the layer cannot emit or commit
│   │                (21 §2.5; 23 §5)
│   │
│   ├── B1.2 Corrupt the transform (graph → lines)                      [OR]
│   │   ├── B1.2.1 Malicious rule pack: downgrade or disable the
│   │   │          finding that would have caught it                             L ★
│   │   ├── B1.2.2 Malicious rule pack: an `acceptable_when` that
│   │   │          manufactures consent                                          L ★
│   │   ├── B1.2.3 Malicious corpus: a remediation string that is
│   │   │          syntactically valid and semantically wrong                     L ★
│   │   ├── B1.2.4 Compromise the build and alter an emitter                     H
│   │   └── B1.2.5 An ordinary emitter bug — not an attack, same outcome         —
│   │
│   └── B1.3 Corrupt the review                                         [OR]
│       ├── B1.3.1 Record a plausible suppression with a plausible reason        L ★
│       ├── B1.3.2 Bury the change in diff churn (reordering, renames)           M
│       │          → countered by invariant 9 determinism and stable IDs:
│       │            a rename is not a diff, and the same graph emits the
│       │            same bytes, so churn has to be deliberate to exist
│       └── B1.3.3 Time it into a change window where review is thin             L
│
└── B2. Get a human to paste it                                         [OR]
    ├── B2.1 The engineer trusts the tool and pastes                             L
    ├── B2.2 Change management approves it                                       M
    └── B2.3 Bypass Fathom entirely and just type it                             L
               → the baseline. Fathom's claim is not that it prevents this;
                 it is that a change made *through* Fathom carries a finding
                 and a provenance record that a typed change does not (§9)
```

**What the tree says.** Goal B's cheap branches are B1.2 and B1.3 — the rule pack, the corpus,
and the suppression. Every one of them is an attack on *judgement*, not on data, and the
mitigations that matter are the ones already in the design for other reasons: signed packs, no
TOFU, presentation-only overrides, `acceptable_when` forced into readable text, suppressions
stored in the workspace with a reason, and byte-determinism so that a diff means something.

**The residual is real:** a signature bounds *who*, never *what* (row 11). Nothing in this
architecture detects a correctly-signed, well-written, wrong rule.

**B2.3 is the honest floor.** Any engineer can type a weakening into a terminal. Fathom's
security value against goal B is not prevention — it is that the same change routed through the
tool leaves a finding, a suppression with a reason, a provenance record, and a deterministic
diff. §9 builds the whole abuse-case position on that distinction.

### 8.3 Goal C — impersonate the update channel

The highest-leverage goal in the model: it subsumes goals A and B for every user at once.

```text
C.  RUN ATTACKER CODE OR CONTENT AS FATHOM                              [OR]
│
├── C1. Impersonate the application artifact                            [OR]
│   ├── C1.1 Compromise the release host or CDN and replace the file    M
│   │        → signature + published hash detect it — IF anyone checks
│   ├── C1.2 Compromise the signing key                                 H  ★ defeats everything
│   │        below it; key handling is 70-ops' problem and it is the
│   │        single most valuable secret the *project* holds
│   ├── C1.3 Typosquat the download (domain, repo, package name)        L  ★
│   │        → no technical control. Only a canonical, published
│   │          location and a fingerprint users can compare
│   ├── C1.4 MITM the download                                          M
│   │        → TLS, and the signature underneath it
│   └── C1.5 Compromise the *served* deployment's assets (a hostile
│            operator serves an altered bundle to their own users)      M  ★
│            → this is row 2's residual, and it is why the served
│              build's asset hashes must be checkable against the
│              published release
│
├── C2. Impersonate a rule pack                                         [OR]
│   ├── C2.1 Steal a publisher's signing key                            H
│   ├── C2.2 Get the user to add an attacker key to the trust store     M
│   │        → countered by: no TOFU, full public key required, typed
│   │          fingerprint confirmation, and scoped keys, so an
│   │          `acme.internal.*` key cannot shadow `fathom.*`
│   └── C2.3 Be a legitimate publisher who turns hostile                L  ★ unmitigated
│
├── C3. Impersonate the corpus                                          [OR]
│   └── C3.1 Merge a hostile entry upstream                             M
│            → `reviewed_by` and content hashes make it attributable
│              after the fact, not preventable
│
├── C4. Compromise the build before signing                             [OR]
│   ├── C4.1 A build-time dependency                                    M  ★
│   ├── C4.2 The build host                                             M
│   └── C4.3 An insider with pipeline access                            M
│            → all three are detected by reproducible builds only if
│              somebody actually rebuilds (row 9)
│
└── C5. Rollback / freeze                                               [OR]
    ├── C5.1 Serve an old, validly signed release with a known defect   L  ★
    │        → signatures do not expire, so replay is free
    └── C5.2 Stop serving updates so the user never learns of one       L
             → an offline single file cannot detect this at all
```

**C5 is the branch that gets forgotten** because it defeats signing without breaking it. The
countermeasure is a **signed version manifest with an expiry**, checked when the client is online:
the manifest names the current version and stops being valid after a stated date, so serving a
stale one eventually fails closed. That is the shape of the answer The Update Framework
formalises, and adopting the shape does not require adopting the whole framework.

**DECISION — no silent auto-update, in any build.** An auto-updater is a signed remote code
execution channel pointed at every user, and it converts C1/C4 from "attack the artifact once"
into "attack the channel continuously". The costs are stated plainly: users will run old versions,
security fixes will propagate slowly, and we will have to say so when a defect is found. In
exchange, C5.1 becomes an availability problem rather than a compromise, and the offline
single-file build keeps the property that made it worth building — that what you have is what you
checked.

What the client does instead: it knows its own build date offline, and surfaces its age as a
margin tab (`build 2026-07-14 · 128 days old`) rather than a badge or a nag. Age is not the same
as staleness and the copy must not pretend it is.

### 8.4 What the three trees say together

| Observation | Consequence |
|---|---|
| The cheapest leaves in goal A are an extension, a colleague, and a paste — none cryptographic | Further cryptographic work has low marginal value (§8.1) |
| Goal B is cheaper than goal A for a targeted attacker | The rule pack and suppression paths deserve the review attention that the crypto usually gets |
| Goal C dominates both, and its cheapest leaves are typosquatting and rollback | Distribution hygiene and a canonical published location are security controls, not marketing |
| Reproducible builds appear as the mitigation in goals A and C both, and both times conditioned on "if somebody rebuilds" | Fund the independent rebuild. Without it, the strongest verification story in §5.3 is a story |

---

## 9. Abuse cases

Everything above is about attacks *on* the user. This section is about misuse *of the tool*, and
it exists because an enterprise reviewer will ask and because the answer is a design position
rather than an apology.

### 9.1 The position, stated once

> **Fathom refuses nothing a competent engineer could type themselves. Every weakening is
> labelled with its finding, and no weakening can be emitted silently.**

That is the whole policy. The rest of this section is what it implies and what it costs.

The argument for it is not liberal-mindedness, it is efficacy. A tool that refuses to emit
`delete security ipsec policy IPSEC-POL perfect-forward-secrecy` does not stop that change; it
relocates it to a text editor, where there is no finding, no `acceptable_when`, no suppression
record, no provenance and no rollback. **Refusal converts a labelled change into an unlabelled
one.** That is a worse security outcome, achieved at the cost of the tool's usefulness, and it is
the outcome every refusal-based design produces.

### 9.2 Abuse case 1 — reconnaissance of an illicitly obtained configuration

**The scenario.** Someone obtains a configuration they have no right to and pastes it into
Fathom's reverse-explanation path (brief §6.3) to understand it faster.

**Can we detect it?** No, and building the capability would require the exact surveillance the
product refuses. There is no identity in the product, no account in the offline build, no
telemetry by invariant 1, and no way to know whose config a given text is. An attestation
checkbox — "I am authorised to analyse this configuration" — is unenforceable, changes nobody's
behaviour, and would exist solely to shift liability. We will not ship one.

**What we add to the attacker, honestly.** The usual defence is that an attacker holding a config
already holds everything, so explanation adds nothing. That is true for §6.3's explainer and
**false for the findings engine.** Per §2.2, findings convert a description into a ranked
assessment with remediation syntax attached, which is exactly the work that separates a competent
attacker from an incompetent one. Fathom genuinely lowers the skill floor for turning a stolen
config into a target list. We are not going to pretend otherwise.

**Why we build it anyway.** Four reasons, in order of weight:

1. **The asymmetry favours defenders by a wide margin.** The population that inherits
   configurations it did not write and cannot read is enormous and almost entirely legitimate —
   the brief calls it *"the highest-value feature for anyone inheriting equipment and
   documentation they did not write. Which is eventually everyone."*
2. **The capability already exists.** Batfish is Apache-2.0 and ingests configs into a
   vendor-neutral model today. Withholding ours removes it from defenders and not from attackers.
3. **The attacker's alternative is cheap.** An adversary who can steal a configuration can hire
   or already possess the expertise to read it. The defender frequently cannot.
4. **The stolen config was already the crown jewel.** By §2.1 the config *is* V4–V8. An attacker
   holding it has already won most of what there is to win; our contribution is speed, not access.

**Where the line is.** We do not build features whose only use is against a network you do not
operate: no scanning, no reachability testing, no exploit generation, no credential handling, no
device access. Invariant 2 does most of that work already, and it does it as a permanent product
boundary rather than a policy that could be relaxed.

### 9.3 Abuse case 2 — deliberately weakening a configuration

**The scenario.** An insider uses Fathom to produce a change that weakens security, and wants it
to look routine.

**What the tool does.** It emits it — and it emits it labelled. Worked examples, all drawn from
the field card:

| The weakening | What Fathom attaches |
|---|---|
| `delete security ipsec policy IPSEC-POL perfect-forward-secrecy` | `ipsec.pfs.absent`, severity high, with the `why`: one compromised IKE SA secret unlocks every data key derived under it, including traffic recorded months ago (field card side 2) |
| `set security ike proposal IKE-P1 dh-group group2` | A legacy-DH finding. The field card is explicit that `group2` and `group5` are legacy and that `proposal-set standard` still leads with group 2 |
| `set security ike policy IKE-POL mode aggressive` | An identity-exposure finding: aggressive mode sends the identity in the clear and is offline-crackable, and exists almost solely for PSK with a dynamic peer IP |
| `set security ike gateway GW-B version v1-only` | A version finding, with the note that under v2-only `mode` is silently ignored — so a config showing `mode aggressive` under v2 means nothing and should not be chased |
| Removing `traffic-selector` from a VPN | A selector finding: with none configured the SRX proposes `0.0.0.0/0` any-to-any, which peers that build one SA per subnet pair reject outright |
| `set security policies from-zone TRUST to-zone VPN policy TO-B match source-address any destination-address any application any` | An over-permissive policy finding against V4 |
| `set security flow tcp-mss all-tcp mss 1350` | **Not** a security finding — a blast-radius finding. The field card: `all-tcp` hits everything through the box, a far bigger blast radius than most people intend. The distinction matters and the rule ids should keep it |
| `delete security ike traceoptions` | Nothing. This is the correct cleanup the field card insists on, and a tool that flagged it would be flagging good practice |

That last row is the discipline: a labelling scheme that fires on everything is muted within a
week (brief §5.2), so the labelling has to be *right*, not merely present.

**What the tool does not do.** It does not refuse, it does not report anyone, and it does not
phone home — invariant 1 forbids the mechanism that would be required, and the mechanism is
worse than the problem.

### 9.4 The interlock — how "cannot be emitted silently" is enforced

This is a hard architectural rule, not a UI convention, and it is enforceable because of a
decision already made for other reasons: emitters return `(line, provenance)` pairs, never
strings (brief §5.3, invariant 6).

```rust
/// A line whose emission removes, downgrades or bypasses a security control.
/// Constructed only by the emitter, never by the UI, and never by the AI layer.
pub struct Weakening {
    /// The rule that fires against the resulting graph state. Never empty:
    /// if no rule covers this weakening, the emitter cannot classify it as one,
    /// and that gap is a corpus bug filed against the rule pack.
    pub rule: RuleId,
    /// Which node and fields changed. Same identifiers the explainer binds to.
    pub node: NodeId,
    pub fields: Vec<FieldRef>,
    /// The control that goes away, in the user's vocabulary, from the rule's
    /// `title` — not prose invented at emit time.
    pub control_lost: RuleTitle,
    /// Present only if the user recorded one. Its absence is what blocks export.
    pub suppression: Option<SuppressionId>,
}

pub enum ExportGate {
    /// Every Weakening in the change set has either a live finding rendered
    /// alongside it, or a Suppression carrying a non-empty reason.
    Clear,
    /// At least one Weakening is neither shown nor suppressed. Export is refused,
    /// and the refusal names every offending line. This is the only place in the
    /// product where an export can be refused, and the refusal is always
    /// resolvable by the user in one step: look at it, or suppress it with a reason.
    Blocked { unaccounted: Vec<Weakening> },
}
```

Three properties fall out of this, and each is checkable:

1. **A weakening cannot reach the clipboard or a file without either its finding visible or a
   suppression with a reason recorded in the workspace.** The gate is in the emitter path, which
   is in the WASM core, not in the UI — so a UI bug cannot bypass it, and neither can a
   supervisor or subagent, which have no emit capability at all.
2. **The suppression is durable and reviewable.** It carries a reason, it is stored in the
   workspace, it shows up in the diff, and a reviewer sees both the waiver and its justification
   (brief §6.6). The insider can still write a false reason — but they must write one, under their
   own hand, in a record that outlives the change.
3. **The line carries its `Risk`.** This is the one place in this document the three-value enum
   appears: a weakening is `ChangesConfig` or `Disruptive`, never `ReadOnly`, and it renders in
   the field card's legend colours exactly as it does on paper. A change that drops live traffic
   looks the same in the tool as it does on the card, which is the point of keeping one legend.

**The cost, stated:** this makes the export path more complex, adds a refusal state to a product
that otherwise has almost none, and will occasionally block someone who knows exactly what they
are doing. The escape hatch is one step and it is a *record*, not a bypass. If we ever find
ourselves adding a second escape hatch, the interlock has failed and should be removed rather
than hollowed out.

### 9.5 What we refuse to build

Naming these matters, because each one will be proposed by somebody who means well:

| Proposal | Why not |
|---|---|
| "I am authorised to analyse this config" attestation | Unenforceable, changes no behaviour, exists only to shift liability |
| Usage telemetry to detect abusive patterns | Violates invariant 1. The mechanism is a worse outcome than everything it would detect |
| A blocklist of dangerous commands | The field card's content *is* dangerous commands. `clear security ike security-associations` on a hub tears down every spoke — and is sometimes exactly the right thing to run. A blocklist would have to include the correct answer |
| Refusing to emit a weakening | §9.1. It relocates the change to a text editor and removes the label |
| A "safe mode" that hides `Disruptive` output | Hiding the disruptive commands from the person about to run them is the worst available option. Label them; that is what the legend is for |
| Watermarking exported configs | Trivially stripped, and it would embed a per-user identifier in an artifact the product otherwise keeps identity-free |

---

## 10. What Fathom explicitly does NOT claim

Written to be quoted back. A sceptical enterprise reviewer's fastest win is finding one
overclaim, and the fastest way to lose a security-first position is to give them one.

### 10.1 The register

| We claim | We do **not** claim | How you check |
|---|---|---|
| The sync service cannot read your workspace | That it cannot tell you have one, roughly how big it is, or when you change it | §7. Watch your own server's logs |
| Nothing sensitive is persisted in plaintext | That nothing sensitive is *in memory* in plaintext while the workspace is open. It all is | Heap-snapshot the tab |
| The application originates no network connection you did not configure | That a compromised browser, a malicious extension or a tampered build cannot | §6.2. The CSP constrains this document, not the attacker |
| Encrypted at rest with published parameters | That this survives an endpoint compromise, a keylogger, or coercion | §6.3, §6.6 |
| Zero-knowledge: the server holds no key | That zero-knowledge helps at all against someone who has your passphrase | §2.4 |
| Emitted configuration is deterministic and carries provenance | That it is *correct for your network*. The field card's own imperative applies: **VERIFY AGAINST YOUR OWN BOX BEFORE ACTING** | Run it in a lab |
| Findings are grounded in authored rules with sources | That the rule set is complete, or current for your platform version. A rule correct on Junos 21 may be wrong on 23, which is why `versions` predicates are mandatory | Read the rules. They are YAML |
| The corpus is human-authored with a named reviewer | That it is free of errors, or that a named reviewer is a guarantee | `reviewed_by` gives you someone to ask |
| Rule packs are signed with a scoped trust store and no TOFU | That a signed pack is *correct*. A signature proves origin, never content | §5.2, row 11 |
| Reproducible builds and published hashes | That anyone has actually rebuilt. Reproducibility is only as good as the rebuilds that happen | Rebuild it yourself. That is the entire mechanism |
| **Single-user** workspace encryption is symmetric throughout. A **shared** workspace wraps the root key under X25519 and is harvest-now-decrypt-later exposed until suite `0x02` ships (`32` §10.7; corrected per ADR-0015) | Anything about post-quantum TLS, and nothing at all about your passphrase's entropy, which is the actual binding constraint | §2.4; `32` §10.7 |
| The application never touches a network device | That it prevents *you* from doing anything. It emits text; you decide | Invariant 2 |
| The application never accepts a device credential | That it holds *no* credential: at tier 1 it accepts and stores a provider API key. §14 | `21` §7.2 |
| We can bound what the AI layer does | That prompt injection is prevented. It is not. It is made unprofitable | `23` §1.2, §10 |
| Suppressions are recorded with a reason and reviewable | That a reason is *true*. An insider can write a plausible false one | §9.4 |
| A workspace is one encrypted document you own | Any in-workspace compartmentation. Anyone with the passphrase reads all of it | §5.1 row 13 |
| The graph records provenance and the age of parsed nodes | That the inventory reflects reality. Brief §6.5 scopes the diagram as a design tool, not a source of truth, precisely because documentation rots | §2.2 of the brief |
| No security audit claim of any kind | That the product has been independently audited, penetration-tested, formally verified, or validated against FIPS 140, Common Criteria or anything else. **None of that has happened.** If it ever does, this row changes to name the auditor, the date, the scope and the report | Ask for the report. There isn't one |

### 10.2 The paragraph for the review pack

Verbatim, in the application, the README and the enterprise review pack, with no marketing pass
applied to any of the three:

> Fathom's security position is that your configurations stay on your machine, and that when they
> are synced, the server holds ciphertext and never a key. That position is verifiable: the
> content security policy is in the artifact, the build is reproducible, the packs are signed with
> a format you can check using someone else's tool, and the server can be run locally and its
> database dumped.
>
> That position ends at the edge of your machine. If your browser is compromised, if you have
> installed a malicious extension, if your operating system is compromised, if someone is watching
> your screen, or if someone can compel you to give up your passphrase, Fathom offers you nothing.
> Its defensive code runs in the same context as the attacker's, and code cannot defend itself
> from code that is already inside it.
>
> Zero-knowledge protects contents. It does not protect the fact that a workspace exists, how
> large it is, or when it changed. If that is your threat, use the offline build and do not sync.
>
> We have not been independently audited. We do not claim any certification. Everything in this
> document that we could not verify, we have marked instead of guessed.

The temptation in review will be to add "but" to the end of that. Do not.

---

## 11. Residual risk register

Ranked by what should get attention next, not by severity. Every row has an owner and a revisit
trigger, because a residual with neither is a residual nobody has accepted.

| # | Residual | Tag | Accepted because | Revisit when |
|---|---|---|---|---|
| R1 | Anything with code execution in the origin reads everything | `total` | Structural. No application can defend against its own context | Never — this is the model |
| R2 | A malicious extension is one click away from every user | `total` | Platform-granted. §6.2 | If a browser ships an origin-level extension exclusion we can require |
| R3 | Endpoint compromise, keyloggers, screen capture, coercion | `total` | Out of scope, §6 | Never |
| R4 | Sync metadata M1, M6, M7, M9 survive every mitigation | `material` | §7.7. Only "do not sync" removes them | If a customer's requirement makes M1 disqualifying — the answer is the offline build, not a feature |
| R5 | Default sync configuration leaks M4/M5 | `material` | §7.6's decision, for RPO reasons | Once batching's cost is measured against real usage rather than estimated |
| R6 | A signature bounds who, not what: a trusted pack author can ship a wrong rule | `material` | No technical control exists. Diffability and `acceptable_when` are speed bumps | If a pack ecosystem grows beyond first-party plus a handful of org packs |
| R7 | Reproducible builds prove nothing unless someone rebuilds | `material` | Currently unfunded | **Now.** Fund the independent rebuild before the first public release |
| R8 | No in-workspace compartmentation: one passphrase, everything | `material` | Brief §6.4's document-not-database decision, and it is the right one at team scale | At the point §7.6 of the brief (CRDTs, multi-writer) becomes load-bearing |
| R9 | Offline passphrase cracking against every copy that exists, including old git commits | `material` | Argon2id is a constant factor; entropy is the user's | If generated-passphrase adoption measures low |
| R10 | The passphrase's JS string cannot be erased from the heap | `material` | Language limitation. WASM memory is zeroed; the string is not | If a browser ships a usable secure-input primitive |
| R11 | Single-file build has no `frame-ancestors` and no CSP reporting | `material` — reconciled to §5.1 row 16's tag per ADR-0015 | `<meta>`-delivered policies ignore both. The build is a local file | If the single file is ever served over HTTP by default — then it must carry a header |
| R12 | Rollback of a signed release; an offline build cannot learn a newer one exists | `material` — reconciled to §5.1 row 18's tag per ADR-0015 | No auto-update, deliberately (§8.3) | If the expiring version manifest ships, this drops to `bounded` |
| R13 | Prompt injection through pasted config is unpreventable | `material` | Structural. Bounded by the AI layer's small, checked powers | If the AI layer ever gains a capability beyond propose/select/order/ask/abstain — then reopen everything |
| R14 | At tier 1, a third party receives a structured description of part of your network | `material` | The user's explicit, scoped, per-send decision. `21` §8.7 | If any part of tier 1 becomes a default |
| R15 | At tier 1, the application holds a provider API key — a second credential | `material` | Necessary for BYOK. **But it contradicts invariant 3 as written.** §14 | Before invariant 3 is quoted in any external material |

---

## 12. What CI enforces

A threat model that is not tested is a document. These are the checks that make specific rows
above fail a build rather than age quietly.

| Check | Enforces | Fails the build when |
|---|---|---|
| CSP assertion on every built artifact | Row 10, invariant 1 | `connect-src` is anything other than `'none'` (offline/2a) or the exact enumerated origin set |
| WASM import-section allowlist | Row 10, §4.3 | The core imports any host function capable of originating a network request |
| No-network integration run | Row 10 | Any outbound connection is attempted with no route configured |
| Storage plaintext scan | Row 6, row 14 | A known canary string from a synced workspace appears in OPFS, IndexedDB, localStorage or any file the app wrote |
| Heap-snapshot scan after lock | Row 14, R10 | The canary appears in WASM linear memory after `lock()`. **Expected to still appear in a JS string — that part is asserted as a known gap, not as a pass** |
| Server-side plaintext scan | Rows 1–3 | The canary appears in any table, index or log of the sync service after a full sync cycle |
| Byte-determinism, two machines | Invariant 9, §8.2 B1.3.2 | Emitted config, findings or finder ranking differ |
| Reproducible build diff | Rows 7, 9 | The independent rebuild's hash differs from the release hash |
| Pack signature negative tests | Row 11 | An unsigned pack, a pack signed by an untrusted key, a pack signed by an out-of-scope key, or a pack whose override changes `condition`/`applies_to`/`requires`/`platforms` installs successfully |
| Export-gate tests | §9.4 | A `Weakening` reaches an export with neither a rendered finding nor a suppression carrying a non-empty reason |
| Rollback rejection test | Row 5, C5.1 | The client accepts a workspace version lower than the highest it has seen, without an explicit typed confirmation |
| Parser fuzz corpus | Row 15 | Any panic, any unbounded allocation, any input exceeding the configured time budget |
| Padding invariant | §7.6 | An uploaded blob's length is not a Padmé bucket boundary |
| Limits-panel text equality | §6.8 | The application's limits text, the README's, and the review pack's are not byte-identical |

The last one looks trivial and is not. Three copies of a security limitation, maintained by
hand, diverge — and the shortest, softest one becomes the one people quote.

---

## 13. Sources

| Claim | Source |
|---|---|
| Argon2id recommended parameters: first option t=1, p=4, m=2 GiB; second option t=3, p=4, m=64 MiB, 128-bit salt, 256-bit tag | RFC 9106 §4 |
| Padmé padding bounds length leakage to O(log log M) bits with at most 12 % overhead, ≈6 % at 1 MB, ≈3 % at 1 GB | Nikitin, Barman, Lueks, Underwood, Hubaux, Ford, *Reducing Metadata Leakage from Encrypted Files and Communication with PURBs*, PoPETs 2019(4) |
| PFS: Phase 2 keys derived from Phase 1 material without it; each Phase 2 runs its own DH with it; PFS on one side only fails Phase 2 while Phase 1 stays up; under IKEv2 the first child SA is keyed from the IKE SA regardless | Owner's SRX IPsec field card, side 2. Underlying protocol behaviour: RFC 7296 |
| Aggressive mode sends identity in the clear and is offline-crackable; `mode` is silently ignored under `v2-only`; `group2`/`group5` legacy; `proposal-set standard` still leads with DH group 2 | Owner's SRX IPsec field card, side 2 |
| With no `traffic-selector`, the SRX proposes `0.0.0.0/0` any-to-any and peers building one SA per subnet pair reject it | Owner's SRX IPsec field card, side 4, *Things that bite* |
| Missing `host-inbound-traffic system-services ike` causes Phase 1 timeout with nothing useful in the log | Owner's SRX IPsec field card, sides 1 and 4 |
| `tcp-mss all-tcp` has a far larger blast radius than `tcp-mss ipsec-vpn` | Owner's SRX IPsec field card, side 4 |
| Extensions: content scripts run in an isolated world and do not share the page's `localStorage`/IndexedDB; injecting into the page's own world is the documented way to reach them | Chrome extension and MDN WebExtensions content-script documentation |
| `chrome.scripting.executeScript({ world: "MAIN" })` runs code in the page context; extension-bundled scripts running there are subject to the page's CSP | Chrome for Developers, extensions scripting documentation |
| The `debugger` permission plus host access allows `Runtime.evaluate` in an attached target | Chrome DevTools Protocol; Chromium issue tracker discussion of debugger-permission attacks. <!-- VERIFY: confirm current behaviour with respect to page CSP before quoting in the review pack --> |
| `frame-ancestors` and `report-uri` are ignored in a `<meta>`-delivered CSP | CSP Level 3; also stated in `21-ai-layer-architecture.md` §7.5 |
| UK: a s.49 RIPA 2000 notice can compel disclosure of a key or passphrase; s.53 makes knowing failure an offence, up to 2 years, up to 5 in national-security and child-indecency cases | Regulation of Investigatory Powers Act 2000, Part III |
| A backdoor introduced through a build-time dependency in a widely used compression library | CVE-2024-3094 (xz-utils / liblzma), 2024 |
| Rule-pack signing: Ed25519, minisign-compatible detached signatures, scoped trust store, no TOFU, presentation-only overrides | `docs/10-core/12-rule-engine.md` §12.6, §13 |
| Envelope header carries `format_version` and `schema_version` outside the ciphertext, authenticated as AEAD associated data | `docs/10-core/11-ir-schema.md` §11.2 |
| AI layer: tiers, CSP per tier, the egress statement, injection unpreventable | `docs/20-ai/21-ai-layer-architecture.md` §7, §8; `docs/20-ai/23-ai-safety-and-injection.md` |
| Batfish is Apache-2.0, ingests configs into a vendor-neutral model with no device access | Owner brief §3.1 |

Claims not sourced above are design positions of this project and are argued in place rather than
cited.

---

## 14. Disagreements

Three, all raised under the conventions' own procedure rather than acted on unilaterally.

### 14.1 Invariant 3 is contradicted by tier 1 and should be amended

**The convention.** *"The application never accepts a credential. No PSKs, no certificates with
private keys, no SNMP communities, no TACACS keys, no device passwords. […] The one exception is
the workspace passphrase, which never leaves the client and is never transmitted in any form."*

**The objection.** `21-ai-layer-architecture.md` §7.2 has the user supply a provider API key,
stored "in the encrypted workspace, or in the browser's credential store". That is a second
credential the application accepts, and unlike the workspace passphrase it *is* transmitted —
on every request, to a third party, by design. As written, either the invariant is false at tier
1 or tier 1 violates it. A reviewer will find this in about ten minutes and it will cost us more
than the amendment would.

It also matters for this document specifically. A provider API key is a bearer token with a
billing consequence and often broad account scope; it is not V1, but it is not nothing, and §2.1
should be able to name it without contradicting a hard invariant.

**Proposed replacement.** Amend invariant 3 to:

> **3. The application never accepts a credential to a network device.** No PSKs, no certificates
> with private keys, no SNMP communities, no TACACS keys, no device passwords. Emitted config uses
> placeholders. Exactly two secrets exist in the product: the workspace passphrase, which never
> leaves the client and is never transmitted in any form; and, at tier 1 only, a user-supplied
> inference provider API key, which is stored in the encrypted workspace or the browser credential
> store and is transmitted only to the enumerated provider origin the user configured. No third
> secret may be added without amending this invariant.

The narrowing is deliberate: naming exactly two, and requiring an amendment for a third, keeps
the invariant's force. An invariant with an unbounded exception list is a preference.

### 14.2 "Findings are data, not code" needs a companion clause about trust

**The convention.** Invariant 5, and it is right.

**The objection.** It says nothing about trust, and this document's §5.1 row 11 and §8.2 branch
B1.2 both turn on the fact that rule *data* is an integrity-critical input. "Data, not code" is
routinely read as "therefore lower risk", and here the opposite is true: rule data decides what
the defender believes about their own network, which is a higher-value target than most code
paths in the product.

**Proposed addition**, as a second sentence to invariant 5, not a replacement:

> Rule packs are integrity-critical inputs. A signature bounds who published a pack, never whether
> its rules are correct.

### 14.3 The document conventions need a residual-risk scale, or every author invents one

**The convention.** The conventions pin the three-value `Risk` enum, forbid a fourth value, and
forbid reusing its colours — all correct, and this document obeys all three. But they pin no
scale for *threat* residual, and §5 and §6 cannot be written without one.

I invented `none | bounded | material | total` in §1.4 and flagged it as not the `Risk` enum. If
another security document invents a different one, the two documents will not compose, which is
exactly what the conventions exist to prevent.

**Proposed addition to `conventions.md`,** under a new heading, with the four values above,
rendered in neutrals with weight and rule treatment only, and an explicit note that it is
orthogonal to both `Risk` and finding severity — three scales, three purposes, no shared colours.
If a different four values are preferred, that is fine; what matters is that one is pinned before
a second security document is written.
