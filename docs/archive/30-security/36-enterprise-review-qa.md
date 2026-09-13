# 36 — The enterprise review, question by question

> **Status:** Proposed

The owner's brief says §7 "is written defensively on purpose" because it is "the section most
likely to be argued with in an enterprise review". This is the document that survives that
review. It is the questions, in the words they are actually asked, with the answers we will
actually give.

Three reviewers are in the room and they are not the same person:

| Reviewer | What they are really asking | The question that ends the meeting if we get it wrong |
|---|---|---|
| **A bank's security architect** | Can I place this in our control framework, name a control owner, and evidence it to an auditor? | "What is your SOC 2 status?" |
| **A defence contractor's ISSO** | Can this run inside the boundary, with no egress, and can I prove that to someone who will not take my word for it? | "It has an AI feature." |
| **A hospital's CISO / privacy officer** | Does this touch PHI, do I need a BAA, and what happens when it breaks at 03:00? | "What is your incident response?" |

**The governing rule of this document, stated once, in caps, at the top:**

> **EVERY ANSWER HERE IS ONE YOU CAN CHECK WITHOUT OUR COOPERATION. WHERE THE ANSWER IS NO, IT
> SAYS NO.**

Eighty-one questions follow. Twenty-five of the answers are "no". They are collected in §15 so a
reviewer who wants the bad news first can read one table and stop.

---

## 0. Contents

| § | |
|---|---|
| 1 | How to use this document |
| 2 | Where is our data — Q1–Q10 |
| 3 | Prove the server cannot read it — Q11–Q16, with the procedure |
| 4 | Prove there is no egress — Q17–Q23, with the five-minute procedure |
| 5 | The browser question — Q24–Q29 |
| 6 | The AI question — Q30–Q38 |
| 7 | Air gap — Q39–Q45 |
| 8 | Self-hosting, source, licence, contracts — Q46–Q53 |
| 9 | Certification and assurance — Q54–Q59 |
| 10 | The project — commit access, bus factor, disclosure, incident response — Q60–Q69 |
| 11 | People and offboarding — Q70–Q73 |
| 12 | Logging and audit — Q74–Q76 |
| 13 | What the tool could do to weaken you — Q77–Q78 |
| 14 | The questions we volunteer — Q79–Q81 |
| 15 | The register of everything that is "no" |
| 16 | What we will put in a contract |
| 17 | Sources |
| 18 | Disagreements |

---

## 1. How to use this document

### 1.1 The rules the answers obey

1. **Nothing here is softer than `31-threat-model.md`.** If an answer in this document reads
   more comfortably than the corresponding row in `31` §5, `31` is the true one and this
   document has a bug. `31` §12 proposes a CI check that the limits text is byte-identical
   across the application, the README and the review pack; the same discipline applies here.
2. **Every claim carries a check.** A security claim a reviewer cannot verify without our
   cooperation is a marketing claim. Where the honest answer is "you cannot check this without
   reading the source", the answer says that.
3. **We say no.** A hedged no costs two more meetings and then becomes a no anyway.
4. **We do not know some things and we say which.** Provider retention periods, other people's
   browser behaviour, what a rebuild you did not do would have shown.

### 1.2 The scales this document borrows and does not invent

`Risk` — `ReadOnly | ChangesConfig | Disruptive` — is the emitted-line risk enum from the brief
§5.3 and the field card's three-colour legend. It classifies **what a command does to a live
box** and appears in this document only in §13, where a weakening is labelled at emit time.

Residual risk uses `31` §1.4's four-value neutral scale — `none | bounded | material | total` —
unchanged. Finding severity is a third, separate scale. Three scales, three purposes, no shared
colours.

### 1.3 The deployment shape decides half the answers

`34-browser-hardening.md` §2.1 names five shapes. Half the questions below have a different
answer per shape, and the fastest way through a review is to fix the shape in the first ten
minutes. (Corrected per ADR-0017, which adopts `43` §3.5: the single file is a complete
single-session product, and the corpus-wide shape names are `43` §1.1's D1–D4 — the letters
below are retained only until the mechanical rename lands.)

| Mode | Artifact | Holds a workspace? | Server? | Egress | AI tiers available |
|---|---|---|---|---|---|
| **A / D1 — offline single file** | one `.html`, opened from disk | **yes — in memory, for one session; no browser storage of any kind** (ADR-0017) | no | `connect-src 'none'` | 0 |
| **B — offline workspace** | static bundle served from loopback by `fathom serve` | yes | loopback only | `'none'` | 0, 2a, 2b |
| **C — self-hosted with sync** | same bundle + the Axum service on one host you run | yes | yours | one origin, yours | 0, 1, 2 |
| **D — enterprise** | same code, load-balanced, your infrastructure | yes | yours | one origin, yours | 0, 1, 2, 3 |
| **E — CLI** | one native Rust binary | yes | no | none unless you configure one | 0, 2b |

**Most enterprise reviews land on B, D or E.** A review that starts by evaluating a hosted SaaS
is evaluating a product we do not lead with.

### 1.4 The four answers to read before anything else

| | |
|---|---|
| **We have no SOC 2, no ISO 27001, no penetration test report and no independent audit of any kind.** | §9. Nothing has happened. If your policy requires one to proceed, stop here and tell us. |
| **If your browser is compromised, we offer you nothing.** | §5. Defensive code runs in the same context as the attacker. Use the CLI. |
| **At AI tier 1, part of your network description leaves your building, and no amount of redaction changes that.** | §6. Tier 1 is off by default and is a build-time property, not a setting. |
| **We cannot notify you of a security advisory, because we do not know who you are.** | §10. No telemetry, invariant 1. Notification is pull, not push, and that is a real cost. |

---

## 2. Where is our data

### Q1. Where is our data?

On the machine the engineer is using. Every location, exhaustively:

| Location | State | Present in modes | Who reaches it |
|---|---|---|---|
| WASM linear memory in the tab, while the workspace is open | **plaintext** | B, C, D | anything with code execution in the origin; the browser; the OS |
| Process memory of the CLI, while it runs | **plaintext** | E | the OS |
| The DOM, for whatever is on screen | **plaintext** | B, C, D | any extension with host permissions; anyone looking at the screen |
| OPFS / IndexedDB working cache | ciphertext | B, C, D | same-origin code; a disk image |
| `workspace.fathom` file, or `workspace.fathom.d/` directory | ciphertext | B–E | file permissions |
| Your git repository, including **every historical version** | ciphertext | B–E | whoever can read the repo, forever |
| Your sync service, if you run one | ciphertext + metadata M1–M11 (`31` §7.2; M11 per ADR-0015) | C, D | your operator, your hosting provider |
| The clipboard | **plaintext, by design** | all | any application on the machine |
| Wherever the engineer pasted it — terminal, ticket, chat, wiki | **plaintext** | all | that system's access model. Outside our model entirely |
| A plaintext export, if someone made one | **plaintext, with a header saying so** | all | file permissions |
| A third-party inference provider, at tier 1 only | pseudonymised projection, plaintext at the provider | C, D | the provider |

The first three rows are the honest shape of it: **everything we control is at rest and in
transit; everything in use is your endpoint's problem.**

### Q2. Do you have a copy?

No. There is no "our server" in modes A, B, E, and in modes C and D the server is yours. If you
ever use a sync service we operate, we hold ciphertext and the metadata in `31` §7.2 — no key,
no plaintext, no ability to derive either.

### Q3. What is actually in a workspace? Give us the inventory, not the adjective.

`31` §2.1 ranks the assets. Condensed:

| | Asset | Why it matters to an attacker |
|---|---|---|
| V2 | the findings list | a ranked, deduplicated list of your estate's weaknesses **with the vendor syntax to fix each one attached** — which is also the precise description of each hole |
| V3 | suppressions with reasons | the subset you have looked at and decided to live with, each with a written explanation of why nobody is fixing it soon |
| V4 | zones, policies, `host-inbound-traffic`, zone pairs | the map of where enforcement is, and therefore where it is absent |
| V5 | peer identities and peer addresses | your external attack surface by name and address, with partner organisations implied |
| V6 | cipher choices, and which tunnels lack PFS | which recorded traffic is worth keeping (field card side 2) |
| V7 | addressing, routes, traffic selectors | where to go once inside |
| V8 | device platforms and versions | CVE matching |
| V9 | provenance and history | who changed what and when; which nodes are parsed truth and which are drawn aspiration |

Not in the list, because invariant 3 means the application never holds them: pre-shared keys,
certificate private keys, SNMP communities, TACACS keys, device passwords, enable secrets,
RADIUS secrets. Emitted config carries `pre-shared-key ascii-text "<PSK>"` and your engineer
pastes the real value into their own terminal.

### Q4. Which is more sensitive — the config or the findings?

The findings, and this is the counter-intuitive claim we will not soften. A configuration is a
description; a findings list is an assessment. The gap between them is skill, time and vendor
knowledge, and closing that gap is the entire point of the product (`31` §2.2).

Concretely: to get from a raw SRX configuration to *"the DC-EAST tunnel has no PFS, uses
`group2`, and the WAN zone permits `ike` from anywhere"*, an attacker must know that
`perfect-forward-secrecy` lives on the `ipsec policy` and not on the `ipsec vpn`, that its
absence is not a syntax error and will never fail a commit, and that an absent `ipsec policy`
statement means the default rather than nothing. That is hours per device for someone competent
and impossible for someone who is not. The findings list is that work, already done.

**Consequence for your DLP policy:** treat a findings export as more sensitive than a config
export, not less. The product agrees — `17-workspace-format.md` §15.5 puts this literal header
on one:

```
# THIS FILE IS A RANKED LIST OF THIS ESTATE'S WEAKNESSES, WITH THE SYNTAX TO FIX
# EACH ONE ATTACHED. IT IS MORE SENSITIVE THAN THE CONFIGURATION IT DESCRIBES.
```

Write your DLP rule on that string. It is deliberately stable and deliberately ugly.

### Q5. What happens if you get breached?

Depends on which "you", and this is the question where the deployment shape does the most work.

| Our asset compromised | Modes B/E (offline) | Modes C/D (you self-host) | If you ever use a sync service we operate |
|---|---|---|---|
| Our release signing key | **total**, and it is the worst case in the model — attacker code signed as us reaches everyone who installs after the compromise | same | same |
| Our source repository | integrity risk only; the source is public and diffable; reproducible builds make a silent change detectable *if someone rebuilds* | same | same |
| Our rule-pack signing key | a correctly signed pack can downgrade a finding or manufacture consent (`31` §5.1 row 11) | same | same |
| Our corporate email, laptops, tickets | nothing of yours is in them | nothing of yours is in them | your account email, if you gave us one |
| A sync service **we** operate | not applicable | not applicable | your ciphertext + M1–M11 (`31` §7.2) + account identifiers |
| Our hosting provider | not applicable | not applicable | same as above |

Two honest riders:

1. **The signing key is the whole game.** Everything else in this table is recoverable. That is
   why it does not live in CI, why it is offline, and why there is no auto-update channel to
   point it at (`31` §8.3's DECISION).
2. **A ciphertext breach is not a non-event.** It hands an attacker an unmetered, unlogged,
   parallel offline cracking target against your workspace passphrases, permanently. Argon2id
   multiplies their per-guess cost by a constant; it does not add entropy. The control is a
   generated passphrase, which is why it is the default path in the UI and not the alternative
   (`31` §2.4, `32-cryptography.md` §4.6).

### Q6. What is the blast radius compared to a SaaS competitor?

Theirs yields plaintext for every tenant. Ours yields ciphertext plus metadata. That is a real
difference and we are not going to dress it up beyond it: **for some customers the metadata
alone is the finding.** `31` §7.3 works an example in which six weeks of blob sizes and upload
timestamps produce team size, working hours, two sites, and the date of a cutover, without
decrypting a byte. For a defence or OT customer, "an external party can tell when we are making
network changes, and how large the change was" is itself the incident.

The answer for that customer is not a better padding scheme. It is: **do not sync.** Modes B and
E have no server, no account, no upload and no metadata.

### Q7. Data residency?

| Shape | Where the ciphertext is | Where the metadata is | Where anything else is |
|---|---|---|---|
| B, E | your disk | nowhere | nowhere |
| C, D | your infrastructure, your region | same | nowhere |
| Hosted sync operated by us | the region you selected at provisioning | same | nowhere |
| Tier 1 AI | not applicable to the workspace | not applicable | the pseudonymised projection sits with the provider, in their region, under their terms |

Detail, including the transfer-law analysis of shipping ciphertext across a border, is in
`37-privacy-and-compliance.md` §6.

### Q8. Sub-processors?

In modes B, C, D and E: none, because we process nothing. If you use a sync service we operate:
the hosting provider, named in the DPA, and nothing else. Specifically **no** analytics, **no**
error reporting, **no** CDN, **no** font host, **no** session replay, **no** support widget.
Invariant 1 forbids the mechanism, `34` §8 enforces it in CI, and you can confirm it in five
minutes with §4's procedure.

### Q9. Backups, and deletion from backups?

If you self-host, yours. If we operate sync: ciphertext backups, retention stated in the DPA,
and the ordinary honest gap — a deletion propagates to live storage immediately and to backups
on the backup rotation, not before. We will state the rotation as a number in the DPA rather
than as "promptly".

The second answer that used to stand here claimed crypto-erasure by key rotation. It was false
and is withdrawn (ADR-0015; R02): **crypto-erasure is not available against a backup that
contains the keyholder record, which every backup of a workspace does.** `RK_e` is recoverable
from any surviving epoch keyholder record by anyone holding the passphrase, the printed
recovery code, `k` Shamir shares, a member key or the WebAuthn PRF, and `32` §9.2 says so in
terms — *"the git-history problem is not solvable by rotation."* What is available is deletion
of the replica (`33` §2.8), plus the honest statement that the original is on your endpoints
and in your repository. `37` §7.4 states the corrected position.

### Q10. Can you produce our data on legal request?

We can produce what we hold: ciphertext, and the metadata channels in `31` §7.2. We cannot
produce plaintext and we cannot be compelled to produce a key we have never had. We will publish
a transparency statement listing the number and type of requests received.

**We will not run a warrant canary.** Their legal effect is contested, and a canary that lapses
because a maintainer was on holiday is worse than no canary — it manufactures an incident. If
that disappoints you, self-host; then the request comes to you and we are not in the path at
all.

---

## 3. Prove the server cannot read it

### Q11. "Zero-knowledge" is a marketing word. What does it mean here, precisely?

Four statements, each of which is a property of the protocol rather than of our conduct:

| Claim | Mechanism |
|---|---|
| The server never receives a key or key-derivation secret | The workspace key derives from the passphrase in the client (`32` §3). Account authentication is OPAQUE, so the server never receives the password, a hash of it, or anything password-equivalent (`33-sync-protocol.md` §3.2) |
| The server receives only AEAD-sealed records | `32` §7 (ADR-0012/ADR-0013: whole sealed records, no frames). A modified record fails its tag; the server can drop, delay, duplicate or reorder, and nothing else |
| The server cannot merge, compact or garbage-collect | It cannot decrypt. `33` §9 is the entire consequence, and it is a real operational cost we pay for this property |
| The server cannot distinguish content from padding | Record bodies are opaque and Padmé-padded (`31` §7.6; `32` §6.4) |

And the sentence that goes on the sync setup screen, verbatim, because the four statements above
are not the whole truth:

> **The server cannot read your workspace. It can see that you have one, roughly how big it is,
> every time you change it, and which kind of record changed.** *(last clause added per
> ADR-0015 — M11)*

### Q12. Prove it. On a running instance.

Forty minutes with a laptop, no cooperation from us. This is `31` §5.3 checks 6 and 7, written
as something a person executes.

| # | Step | Do this | Pass |
|---|---|---|---|
| 1 | Bring up the single node | `docker compose up` from the published compose file, image pinned **by digest**, not by tag | service healthy |
| 2 | Plant a canary in the most sensitive field class | Create a workspace. Set a `Device` description to `CANARY-8f2a1c-DO-NOT-REMOVE`. Free text is the class the redaction profile withholds by default, so it is the right canary | — |
| 3 | Add a second canary in a structural field | Name a device `CANARY-DEV-8f2a1c` | — |
| 4 | Sync, then edit, then sync again | two generations, so compaction and delta paths are exercised | — |
| 5 | Dump every table | `docker exec pg pg_dump -a --inserts fathom > /tmp/dump.sql` | — |
| 6 | Dump the blob store | `docker cp fathom-blobs:/data /tmp/blobs` | — |
| 7 | Grep, including encodings | `grep -R -a -F 'CANARY-8f2a1c' /tmp/dump.sql /tmp/blobs` and then the base32/base64/hex forms: `grep -R -a -F "$(printf 'CANARY-8f2a1c' \| base64)" …` | **no hits** |
| 8 | Grep the logs | `docker logs fathom-sync 2>&1 \| grep -a -F CANARY` | **no hits** |
| 9 | Grep service memory | `docker exec fathom-sync gcore -o /tmp/c 1` then `strings /tmp/c.1 \| grep -F CANARY` | **no hits**, on a running process with an active session |
| 10 | Inspect the wire | put mitmproxy in front, look at a record-upload body (`33` §2.6, as rebuilt against whole records per ADR-0013) | high-entropy bytes; the header fields are exactly the ones `33` §2.6 lists and no others |
| 11 | Inspect authentication | look at `POST /v1/auth` — two round trips, OPAQUE | no password, no password hash, no key, no passphrase-derived value |
| 12 | Confirm what *is* visible | read the same capture and the same tables for what the server legitimately holds | workspace id, sizes, generation counters, timestamps, device public keys, source IP, and the record kind in the clear. That is M1–M11 (`31` §7.2; M11 added per ADR-0015), and it is the honest answer to "what do you see" |

Step 12 is the one to actually spend time on. The interesting output of this exercise is not
"the canary was absent" — it is the list from step 12, which is what you are really deciding
about.

### Q13. Does this prove the *hosted* service behaves the same way?

**No.** It proves the deployment you ran. A hostile or compromised operator can serve altered
client assets to their own users (`31` §5.1 row 2 residual; `31` §8.3 branch C1.5), and no
amount of dumping their database detects that.

Two controls, in order of strength:

1. **Self-host.** Then the operator is you and the question dissolves. This is the shape we lead
   with and it is why modes C and D exist.
2. **Pin the client.** A served build's asset hashes must be checkable against the published
   release. Fetch the bundle, hash it, compare to the release manifest. If they differ, the
   operator is serving something other than what we published — which may be legitimate (they
   patched it) and is always something you should know.

### Q14. What does the server learn that you are not telling us about?

Nothing withheld — `31` §7.2 enumerates eleven channels (M11 was found after the first ten and
added per ADR-0015, which is itself the honest demonstration that this list is "the channels we
have found") and `33` §12 states which ones this protocol's specific choices create or worsen.
The short list, and the honest priority order:

| | Channel | Removed by |
|---|---|---|
| M1 | a workspace exists, tied to an account, tied to an IP | **nothing except not syncing** |
| M2/M3 | size, and size over time | Padmé padding (on by default) blurs it; does not remove scale |
| M4/M5 | every change, with its timestamp; therefore working hours and change windows | fixed-cadence batching, **off by default** — and the default therefore leaks these |
| M6 | device count, therefore team size | nothing |
| M7 | source addresses, therefore organisation and sites | a relay, which does not touch the channels that matter |
| M8 | which part of the graph was edited | whole-container sync, which is the default; per-record sync is opt-in with this cost named (`32` D7) |
| M11 | the record *kind* in the clear (`IndexEntry.kind_opaque`, `33` §2.5) — which makes the suppressions record, ranked **V3** in `31` §2.1, individually identifiable and trackable | enforcing per-kind caps client-side instead (`33` §18 S-3); until then it is a stated disclosure, added per ADR-0015 |

`31` §7.6's DECISION is that batching ships off by default because it costs a real
recovery-point objective, and the stated cost of that decision is exactly this: **the default
configuration leaks M4 and M5.** A defence or OT customer must change a setting or not sync, and
the setting is presented at sync setup rather than buried.

### Q15. Could a future version silently start uploading plaintext?

A future version could do anything; that is what a supply-chain risk is. What bounds it:

- The set of origins the application can reach is a **build-time** property, not a setting
  (`21-ai-layer-architecture.md` §7.5). A settings screen cannot revoke the claim.
- CI asserts the CSP on every built artifact and fails the build if `connect-src` is anything
  other than the expected value (`31` §12).
- CI asserts a WASM import allowlist, so the core cannot acquire a host function capable of
  originating a request.
- CI runs a server-side plaintext canary scan after a full sync cycle.
- Reproducible builds mean you can detect the change — **if somebody rebuilds.** `31` R7 is
  blunt about this: reproducibility is a social control with a technical mechanism, and without
  a funded independent rebuild the strongest verification story we have is a story.

### Q16. What if we do not trust your Docker image?

Rebuild it from the tag in a clean container and compare the digest. That is `31` §5.3 check 4
and it is the only mitigation in the whole threat model that a third party can verify
*completely*. If the digests differ, we have a problem and you found it before we did.

---

## 4. Prove there is no egress

> *"You say no egress. Prove it, on a running instance, in five minutes."*

This is the request we most want to receive, because it is the one claim in the product that is
fully checkable by a stranger in one sitting.

### Q17. The five-minute procedure

Preconditions: the artifact, a browser with devtools, a shell. Timings are the real ones.

| t | Step | Command / action | Pass |
|---|---|---|---|
| **0:00** | Hash the artifact you are about to test | `b3sum fathom-3.1.4.html` (or `sha256sum`) | matches the hash in the release notes and in the signed manifest |
| **0:30** | Read the policy in the artifact | Open it in an editor, find `<meta http-equiv="Content-Security-Policy">`. Do not grep for `connect-src` alone — read the whole policy | `default-src 'none'` and `connect-src 'none'` both present; `object-src 'none'`; `base-uri 'none'`; `form-action 'none'` |
| **1:00** | Corroborate: look for the other ways out | `grep -c -e sendBeacon -e 'new WebSocket' -e EventSource -e 'rel="preconnect"' -e 'rel="dns-prefetch"' -e 'navigator.sendBeacon' fathom-3.1.4.html` | `0`. Note honestly: `fetch` and `XMLHttpRequest` may appear inside vendored code and their presence proves nothing either way. **The CSP is the control; this step is corroboration** |
| **1:30** | Served build only: read the header, not the meta tag | `curl -sSI https://fathom.internal/ \| grep -i '^content-security-policy'` | the policy arrives as a response header, and `connect-src` is `'none'` or exactly the one origin you configured |
| **2:00** | Remove the network underneath it | Linux: `unshare -rn -- chromium --user-data-dir="$(mktemp -d)" file:///path/fathom-3.1.4.html`, or `firejail --net=none firefox`. macOS: an outbound-deny rule for the browser. Windows: an outbound-block WFP rule | the application works completely — finder, corpus, explainers — with no error and no degraded mode |
| **3:00** | Watch what it attempts | devtools → Network → tick **Preserve log** → filter **All**, not `Fetch/XHR` (that view hides `img`, `ping`, `beacon`, `ws`, `eventsource`) → reload → exercise every feature: finder, paste a config, emit, diff, export | zero rows other than the document itself and `data:` / `blob:` URLs |
| **3:30** | Catch anything devtools does not show | `chrome://net-export/` → *Start logging to disk* → exercise → stop → open the log in the NetLog viewer and filter `URL_REQUEST` | only the document. This step exists because the Network panel is a UI over a subset of what the network stack does |
| **4:00** | Capture from outside the browser | `sudo tcpdump -ni any -w /tmp/f.pcap 'not port 22'` with no other tabs open; or proxy the browser through `mitmdump -w /tmp/f.cap` | no flows to any host but the one you configured. In mode A: no flows at all |
| **4:30** | Prove the core has no network capability at all | `wasm-objdump -x fathom_core.wasm \| sed -n '/^Import\[/,/^Function\[/p'` — or `wasm2wat --enable-all fathom_core.wasm \| grep '(import'` | the import list contains memory, time and randomness only. **No imported host function that can originate a request** |
| **5:00** | Service workers and background code | devtools → Application → Service Workers; console: `navigator.serviceWorker.getRegistrations()` | `[]` in mode A. In mode B a worker may exist for offline caching; read its source, it is in the bundle |

### Q18. What does that procedure *not* prove?

Said plainly, because a checklist where every item passes is a checklist somebody wrote backwards
from the answers:

| Not proven | Why |
|---|---|
| That a *different* build behaves the same way | You tested a hash. Test the hash you deploy |
| That a compromised browser is not exfiltrating | The CSP restricts *this document's* requests. A malicious extension has its own origin, its own policy and its own host permissions, and ours does not apply to it (`31` §6.2) |
| That the user will not paste a config into a chat window | `31` §6.5. Copy-paste is the delivery mechanism, by invariant 2 |
| That a tampered artifact would have failed the test | A tampered artifact ships whatever CSP it likes. That routes back to signatures and reproducible builds, not to this procedure |
| Anything about tier 1 | At tier 1 egress is the feature. §6 |

### Q19. Can we run this continuously rather than once?

Yes, and we do. `31` §12 lists the CI checks that make specific claims fail a build rather than
age quietly: the CSP assertion, the WASM import allowlist, a no-network integration run, a
storage plaintext scan, a heap-snapshot scan after lock, a server-side plaintext scan, and
byte-determinism across two machines. You can run the same suite; it is in the repository, not
in a slide.

For your side, the useful continuous control is an egress-deny rule on the host or the proxy,
scoped to the browser profile the tool runs in, with alerting. That is a control you own and can
evidence to your auditor, which is worth more than a claim you inherit from us.

### Q20. Does the tool phone home for updates?

No. **DECISION, from `31` §8.3 — no silent auto-update, in any build.** An auto-updater is a
signed remote-code-execution channel pointed at every user, and it converts "attack the artifact
once" into "attack the channel continuously".

The costs are real and we state them: users will run old versions, security fixes propagate
slowly, and when a defect is found we have to say so publicly and hope you are listening. In
exchange, what you have is what you checked.

What the client does instead: it knows its own build date offline and surfaces its age as a
margin tab — `build 2026-07-14 · 128 days old` — rather than a badge or a nag. Age is not the
same as staleness and the copy does not pretend it is.

### Q21. Do you use a CDN, a font host, or an error reporter?

No, no and no. Fonts are bundled (`34` §8.4 treats the font question as the exception that is
not one). There is no Sentry, no Datadog RUM, no analytics of any kind. `34` §8.3 has CI fail
the build if a third-party runtime origin appears anywhere in the bundle.

### Q22. Does it set cookies or use local storage for tracking?

No cookies at all in modes A, B and E. In modes C and D the sync auth token travels in a header,
not as an ambient cookie, specifically so that CSRF against the sync API is not a thing that can
exist (`31` §5.1 row 16). Browser storage is used for the ciphertext working cache and nothing
else. `37` §9 covers the ePrivacy/PECR consequence, which is that there is no consent banner
because there is nothing to consent to.

### Q23. What about DNS? A lookup is egress.

Correct, and it is the leak people forget. In mode A there is nothing to resolve — the document
is a `file://` URL with no remote subresources, so no lookup occurs; confirm it with the tcpdump
in step 4:00 filtered to `port 53`. In modes C and D the only name resolved is the one origin you
configured. In mode B, `fathom serve` binds `127.0.0.1` and the browser resolves nothing.

---

## 5. The browser question

> *"This runs in a browser. Our threat model says browsers are compromised."*

This is the hardest question in the review and the one where hedging is fatal.

### Q24. So — is the browser in your threat model?

**No. It is explicitly out of scope, and we will not argue with you about it.**

The owner's brief terminates mid-sentence in exactly this table cell — *"Compromised browser |
Defensive code runs i—"* — and the completion is not in doubt. **Defensive code runs in the same
context as the attacker.** Concretely, if hostile code executes in the Fathom origin, then:

- it reads the decrypted graph out of WASM linear memory as a plain `Uint8Array`;
- it calls any exported core function, including `seal` and `open`, with any arguments;
- it reads the passphrase from the input element before we ever see it;
- it rewrites the DOM so the user sees a lock indicator that means nothing;
- it rewrites any integrity check we wrote, because that check is a function it can replace;
- and it does all of that while the CSP still reads `connect-src 'none'`, because the CSP
  restricts *this document's* requests and the attacker has other ways out.

There is no arrangement of application code that changes this. **An application cannot be its own
trusted computing base.**

### Q25. Then what is the most likely way our workspace gets read?

Not a cryptographic break, not a server compromise, not a network attack. **A browser extension
one of your engineers installed for something unrelated, in the browser they also use for work.**

`31` §3.3 calls this the most underrated actor in the model. It costs an attacker one plausible
utility in a store and a user who clicked *Add*. The mechanics, precisely, because "extensions
can read the page" is usually asserted without its shape:

| Capability | Mechanism | Reaches |
|---|---|---|
| Read and modify the rendered page | a content script with a matching host permission | the whole DOM: every emitted line, every finding, every peer address, and the value of the passphrase input |
| Log every keystroke | DOM event listeners from that same content script | the passphrase, with no OS privilege required |
| Reach page storage and page JS objects | not from the isolated world directly — but injecting into the page's own world (`chrome.scripting.executeScript({ world: "MAIN" })`, or an appended `<script>`) makes that code *page* code | OPFS, IndexedDB, every global, the WASM instance and its memory |
| Bypass the page CSP | the `debugger` permission plus host access, then `Runtime.evaluate` over the DevTools protocol | arbitrary execution in the page context <!-- VERIFY: confirm current Chrome and Firefox behaviour for Runtime.evaluate versus page CSP before quoting this figure in a customer meeting --> |
| Exfiltrate it | the extension's own service worker, under the extension's own CSP and host permissions | anywhere. Our `connect-src 'none'` does not apply to it |

**The isolated world is not a security boundary for us.** It stops a careless content script
colliding with page globals. It does not stop a deliberate extension reaching the page context,
because the platform provides a documented, supported API for exactly that. Anyone citing
isolated worlds as a mitigation has confused a namespacing mechanism for an access control.

### Q26. Given that, why should we use it at all?

Two honest reasons and one comparison.

1. **Do not use it in a browser.** Use mode E, the CLI. Same Rust core, native, no DOM, no
   extension surface, no renderer, no clipboard API. Emit, lint, diff, verify, pack, unpack,
   fsck, serve. This is the strongest argument for shipping the CLI beyond automation.
2. **If you will run a browser, run it properly** — Q27.
3. **The comparison you are actually making is not "browser versus nothing".** It is "browser
   versus what your engineers do today", which per the brief §2.4 is pasting configurations into
   web tools with no defined data handling. A tool that keeps the config local, labels every
   emitted line, and tells you what it cannot protect is a better position than that, and it is
   still worse than the CLI.

And the line we will say in the first meeting rather than the fourth: **if your threat model
excludes browsers and also excludes running a signed binary, we have nothing for you.** Say so
early and we will both save a quarter.

### Q27. What do we lose by using the CLI?

| Lost | Why it matters |
|---|---|
| The guided walkthroughs | the flagship interaction (brief §6.2). A terminal cannot do the inline-findings-as-you-answer loop well |
| The diagram | it is a manipulation surface, not just a render |
| `Ctrl+K` from anywhere | the finder works in the CLI; the ergonomics that make it get used ten times a day do not survive |
| The pre-flight payload view at tier 1 | there is a text equivalent and it is worse |

Kept: the graph, every emitter, every rule, findings, suppressions, diff, the verify ladder,
rollback generation, change-ticket output, the workspace format, fsck, and `fathom serve` if you
later decide a loopback browser is acceptable.

### Q28. Can we harden the browser instead?

Yes, and this is the control most worth pushing through your MDM because it is checkable and it
is yours:

| Control | How |
|---|---|
| A dedicated browser profile with **zero** extensions for workspace work | enterprise policy: Chrome/Edge `ExtensionInstallBlocklist: ["*"]` with an empty or minimal `ExtensionInstallAllowlist`; Firefox `ExtensionSettings` with `"*": {"installation_mode": "blocked"}` <!-- VERIFY: confirm the exact policy key names and JSON shapes against current Chrome Enterprise and Firefox policy documentation before putting them in a customer runbook --> |
| Mode B rather than mode A | `fathom serve` on loopback gets you response headers, so `frame-ancestors`, COOP, COEP and violation reporting all exist. A `<meta>`-delivered policy silently discards them (`34` §2.8, §3.3) |
| Egress deny at the host | belt and braces over the CSP, and it is a control you can evidence |
| No other tabs in that profile | reduces the same-origin and same-process neighbourhood |

What none of that touches: OS-level malware, a kernel keylogger, the screen, and coercion. Those
are `31` §6.3, §6.4 and §6.6, and they are out of scope with no compensating paragraph.

### Q29. What is the residual after all of that?

`total`. `31` R1 and R2 both. Anything with code execution in the origin reads everything, and a
malicious extension is one click away from every browser user. We do not have a mitigation, we
have a deployment recommendation.

---

## 6. The AI question

> *"It has an AI feature. Where does our config go?"*

The second-hardest question, and the one where an evasive answer is most likely to be caught.

### Q30. Where does our configuration go?

**At the default configuration: nowhere.** Tier 0 is the default, `fathom-ai` is not linked into
the artifact, and the dispatch arm that would call it is unreachable and the compiler knows it.

There are four tiers (`21` §7.0):

| | **Tier 0** | **Tier 1** | **Tier 2** | **Tier 3** |
|---|---|---|---|---|
| Name | No AI | BYOK hosted | Local model | Enterprise self-hosted |
| Where inference runs | nowhere | a third-party provider | the user's own machine | inside your boundary |
| Egress | **none** | to one configured origin | **none** | to one operator-configured origin |
| Zero-knowledge posture | intact | **broken for what is sent** | intact | intact with respect to third parties |
| Offline | yes | no | yes | no (LAN required) |
| Default? | **yes** | no — explicit per-workspace opt-in | no — requires setup | no — you provision it |
| Determinism of emitted config | full | full | full | full |

The last row is the one to notice: **the AI layer is never in the artifact path.** Same
workspace, same corpus version, same build gives byte-identical emitted config and byte-identical
findings at every tier (invariant 9). What differs is what the tool can help you *think* about,
and what leaves the machine.

### Q31. At tier 1, what exactly leaves?

An `EgressEnvelope` and nothing else, assembled only from tool results a broker has already
projected (`21` §8.2):

| Class | Examples | Default at tier 1 | Configurable |
|---|---|---|---|
| Structural | node kinds, edge roles, cardinalities, presence states | sent | no — without it nothing works |
| Crypto parameters | `dh_group`, `encryption_algorithm`, `lifetime_seconds`, `perfect_forward_secrecy`, IKE version, DPD mode | **withheld** (ADR-0015: `31` §2.1 ranks "which tunnels lack PFS" V6 — the boolean that says whose traffic is worth harvesting — and pseudonymising the gateway while sending it was exactly backwards) | yes — sending them is the per-field opt-in |
| Topology addresses | addresses, prefixes, ASNs | **pseudonymised** | yes → withhold |
| Names | hostnames, `GW-B`, `VPN-B`, zone names, descriptions | **pseudonymised** | yes → withhold |
| Free text | notes, descriptions | **withheld** | yes → send |
| Secret placeholders | `<PSK>` | sent as the placeholder — there is no secret to send | no |
| Raw pasted config | capture text | **withheld**; per-request opt-in, residue spans only | yes, per request |
| Provenance detail | capture ids, byte spans, parser versions | withheld; only origin kind, age and confidence | no |

Pseudonymisation is a per-session key-derived bijection into `100.64.0.0/10` that preserves
containment and mask length, so the reasoning survives:

```
10.1.0.0/16      →  100.72.0.0/16
10.1.5.0/24      →  100.72.5.0/24        (containment preserved)
10.2.0.0/16      →  100.88.0.0/16        (disjointness preserved)
203.0.113.10     →  100.66.14.9
GW-B             →  GW-7f3a
srx-edge-lhr-01  →  DEV-4c21
reth0.0          →  reth0.0              (vendor grammar, not identity — not pseudonymised)
```

**And the thing pseudonymisation does not do, which we say before you ask:** it does not
anonymise the workspace. A payload describing a hub with 41 spokes, IKEv1 to one peer on a fixed
address, PFS absent and an MSS clamp at 1350 is a fingerprint. Anyone who knows your estate can
identify it from the shape alone. We removed the addresses; we did not remove the topology, and
the topology is often the sensitive part.

### Q32. How do we know what left?

Three mechanisms, all of which you can inspect:

1. **The pre-flight.** Before the first byte is sent for a given (workspace, purpose) pair, the
   user sees the **literal request body** — not a summary, not a description, the bytes, with the
   size and a digest. It re-fires unconditionally when the purpose, redaction profile, system
   contract hash, tool schema hash or endpoint origin changes. Consent granted against one
   payload shape is not consent for another. Honest cost: after the second time, users will skim
   it. Its value is entirely in the first time, when somebody discovers that "just the tunnel
   config" includes their zone names.
2. **The egress log.** `21` §8.6's DECISION is that the log retains the **full literal request
   and response body** by default, not a digest. A digest lets you verify a body you already
   have; it does not let a reviewer see what left. Capped at 25 MB per workspace, evicting
   oldest-first to a recorded digest so the log downgrades entries rather than losing them.
   Exportable as deterministic YAML so you can hand it to your security team without our tooling.
3. **The armed indicator.** Persistent, in the masthead, and reproduced in every export and every
   generated change ticket. A change ticket produced in a workspace with egress armed says so on
   its front page, because the person reviewing that ticket should know.

### Q33. Can we turn it off centrally, and prove it stays off?

Yes, and better than a setting: **ship the tier-0 artifact.** The set of origins the application
can reach is a build-time property (`21` §7.5). A user cannot type an arbitrary endpoint into a
tier-0 build and have it work, because the policy in that artifact says `connect-src 'none'` and
no setting changes it.

You verify it with §4's five-minute procedure — read the policy, then remove the network and
watch nothing break. That is a stronger control than a group policy that disables a checkbox,
because it is a property of the artifact rather than of its configuration.

The cost, stated: a user who wants a provider we did not enumerate must build their own artifact.
That trade is correct — a security claim a settings screen can revoke is not a claim about the
artifact.

### Q34. Is our configuration used to train a model?

**We do not know, and we will not answer on a provider's behalf.** At tier 1 the data goes to a
provider you chose, under a contract you signed, and their training and retention terms are
between you and them. We cannot tell you their retention period; we will not guess it in copy.

If you need a no-training commitment, get it in your own contract with your provider, or use
tier 2 (a model on your own machine) or tier 3 (inference inside your boundary), where the
question does not arise.

### Q35. Can the AI layer change a configuration, or reach a device?

No, and the "no" is structural rather than a policy setting:

| Cannot | Why |
|---|---|
| Emit configuration | emitters are in the WASM core and the AI layer has no emit capability. It proposes; a human accepts; the deterministic emitter runs |
| Commit anything to a device | invariant 2. There is no SSH, no NETCONF, no API, anywhere in the product |
| Originate egress | the broker does, under a grant, with a pre-flight and a log |
| Bypass the export gate | the gate is in the emitter path in the core, not in the UI (`31` §9.4) |
| Read a credential | there are none. Invariant 3 |

The layer's whole power is propose / select / order / ask / abstain, and every one of those is
deterministically checked afterwards.

### Q36. Prompt injection. Somebody pastes a hostile config.

**Unpreventable, and we do not claim to prevent it.** An injected instruction cannot be filtered
out; it can only be made worthless.

The bound: a successful injection buys the attacker no capability they did not already have when
they handed your engineer a config to look at, because the layer cannot emit, cannot commit,
cannot reach a device and cannot originate egress. Proposals are typed, shown, and require a
human accept. `23-ai-safety-and-injection.md` is the full argument; `31` R13 records it as a
`material` residual with an explicit reopening trigger — if the layer ever gains a capability
beyond those five verbs, the entire threat model reopens.

### Q37. If the AI is wrong, what happens?

The same thing that happens when a human is wrong, minus one step: the deterministic path runs
*first* and the supervisor runs only if the deterministic resolver declines. Anything the
supervisor produces is a typed proposal shown to a person before it becomes graph state, and
nothing becomes emitted configuration without passing the rule engine, the export gate, and the
field card's own imperative:

> **VERIFY AGAINST YOUR OWN BOX BEFORE ACTING**

That imperative is in the corpus, on the emitted change block header, and on the export header,
because it is the most useful sentence in the whole product.

### Q38. Does the AI feature exist in the air-gapped build?

Tier 0 or tier 2 only. Tier 2a runs a model in the browser; tier 2b runs a local server on
loopback. Both are `connect-src 'none'` or loopback-only. Tier 1 does not exist in an offline
artifact because the artifact cannot reach anything.

---

## 7. Air gap

### Q39. Can we run it fully air-gapped?

Yes. That is a first-class deployment, not a degraded one — the brief §2.4 names air-gapped,
defence, OT and regulated as the market a SaaS competitor structurally cannot serve.

| Piece | Air-gapped answer |
|---|---|
| Everything, single-session — the finder, a workspace opened in memory, every engine, emit, and a sealed save back out | mode A / D1: one `.html`, opened from disk, no server, **no browser storage of any kind** (corrected per ADR-0017 — the earlier "no workspace" answer stated one side of a then-live fork as fact) |
| Workspaces with persistence, crash recovery and the full header set | mode B: a static bundle served from loopback by `fathom serve` |
| Everything, headless | mode E: the CLI |
| Sync | absent. There is no server, so there is no sync and no metadata |
| AI | tier 0, or tier 2 with a model file you supplied |

### Q40. There is a catch in that answer, isn't there?

Yes — two, and they are different catches from the one this answer used to give. (Rewritten per
ADR-0017: the earlier text told an air-gapped customer the single file could not hold a
workspace, which was `34` §3.3's since-superseded position. The single file is a complete
product for one session, and the HTML file that passes change control as a document is now also
the tool, not just the reference card.)

**Catch one — no crash recovery, at all.** Mode A / D1 holds the workspace in memory only and
uses no browser storage of any kind. A discarded tab loses everything since the last save, and
the user most likely to be in mode A is on an unfamiliar machine in a controlled environment,
which is exactly where a tab gets closed. The save path outside Chromium is genuinely poor:
`workspace (14).fathom` in the Downloads folder (`32` §13.1). There is no mitigation that does
not reintroduce browser storage, and we chose not to.

**Catch two — the missing headers.** A `<meta>`-delivered CSP silently discards
`frame-ancestors`, `sandbox`, COOP, COEP, CORP, `X-Frame-Options`, `Permissions-Policy` and
violation reporting. With no browser storage there is no secret at rest behind the missing
policy — which is what satisfies `34`'s own rule — but two post-XSS exfiltration channels
(top-level navigation and `window.open`) remain open in mode A permanently, and `34` §11
records that as a `material` residual specific to this mode rather than pretending the headers
do not matter.

Your options, in the order we would try them:

1. Use mode A as the air-gapped tool, saving early and often, with the residual above in your
   risk register.
2. Put the `fathom serve` binary through your software approval process for daily-driver use —
   one static Rust binary, reproducible, signed, no installer, no service, no network, no
   privileged operation — and keep mode A as the artifact that needs no approval at all.
3. **Tell us.** `34` §3.5 names the trigger that turns this into a packaged desktop application:
   a customer whose requirement is specifically "no browser extensions in the same process as our
   configurations". If enough air-gapped customers cannot take a binary, that trigger fires.

### Q41. How do we get updates air-gapped?

The transfer procedure. The critical property is in step 7: **the public key must reach the high
side once, out of band, and never on the same media as the artifact.** Otherwise you are checking
a signature against a key the attacker supplied.

```
LOW SIDE (connected)
 1  fetch    fathom-3.1.4-offline.tar.zst          + .minisig
             fathom-3.1.4.SHA256SUMS               + .minisig
             fathom.ipsec-core-2.9.0.fpack          + .minisig
 2  verify   minisign -Vm fathom-3.1.4-offline.tar.zst -P <public key held out of band>
 3  hash     sha256sum -c fathom-3.1.4.SHA256SUMS
 4  record   write the hashes onto the paper transfer form, by hand

MEDIA
 5  transfer via your one-way device or write-once media, per your policy

HIGH SIDE
 6  verify   sha256sum -c  — against the hand-carried form, NOT against a file on the media
 7  verify   minisign -Vm … -P <the key already installed on the high side>
 8  install  unpack; fathom pack verify for rule packs
 9  record   version, hash, date, operator, in the change record
```

Three things travel on this path and each has its own cadence:

| Artifact | Cadence | Consequence of being stale |
|---|---|---|
| The application build | on release | you miss security fixes and you cannot learn that one exists (Q42) |
| Rule packs | more often than the build | you miss new findings; existing findings stay correct |
| The corpus (commands, explainers) | most often | the finder's coverage is narrower; nothing becomes wrong |

Rule packs and corpus are signed independently of the build, with a scoped trust store and **no
trust-on-first-use** — you install the publisher key deliberately, with a typed fingerprint
confirmation, and a key scoped to `acme.internal.*` cannot shadow `fathom.*` (`12-rule-engine.md`
§13).

### Q42. How do we know a newer version exists?

**You do not, and this is a genuine gap.** `31` §5.1 row 18 and R12: an offline single artifact
cannot learn that a newer version exists. It can only report its own age, which is not the same
thing.

The countermeasure for the connected case is a signed version manifest with an expiry, so serving
a stale one eventually fails closed — the shape The Update Framework formalises, adopted without
adopting the whole framework. **That mechanism does not work air-gapped**, because there is
nothing to fetch the manifest.

So air-gapped staleness is a process control and we will say so in the review rather than implying
a technical one: a named person checks the release page on the low side on a stated cadence, the
transfer log records the installed version, and the client's build age is visible in the masthead
so the person using it can see it too.

### Q43. Can we mirror your releases internally?

Yes. Mirror the artifacts and the signatures; do not mirror trust. Your users should verify
against the publisher key you installed out of band, not against whatever key sits next to the
file on your mirror. If you re-sign with your own key after your own review, that is better than
mirroring and it is what we would do.

### Q44. Can we build it ourselves from source?

Yes, and we would rather you did. `31` §5.3 check 4: rebuild from the tag in a clean container
and compare hashes. If yours differs from ours, that is the single most valuable security finding
anyone could hand this project, and we want the email.

The uncomfortable rider is `31` R7: reproducibility proves nothing unless somebody rebuilds, and
today nobody is funded to. If your organisation rebuilds and publishes the hash, you have
materially improved this product's security posture for everyone, at a cost to you of one CI job.

### Q45. Does anything degrade air-gapped?

| Feature | Air-gapped |
|---|---|
| Finder, corpus, explainers | full |
| Graph, emitters, findings, suppressions, diff, verify ladder, rollback | full |
| Diagram | full |
| Determinism of output | full — same workspace, same corpus, same build, byte-identical output |
| Sync and multi-writer CRDT merge | absent. Collaboration is git, or sneakernet of the workspace file |
| AI tiers 1 and 3 | absent |
| Version-staleness detection | absent — Q42 |

---

## 8. Self-hosting, source, licence, contracts

### Q46. Can we self-host?

Yes, and it is the shape we lead with. Modes C and D are the same code as everything else — one
Rust core, one bundle, one Axum service — load-balanced or not, on your infrastructure, in your
region, with your TLS, behind your proxy, with your logging.

What you operate: a static file server and a small service with nine endpoints (`33` §2.1), a
blob store, and whatever database you point it at. What you do **not** operate: any component
that can read a workspace, because none exists.

### Q47. Can we audit the source?

Yes. It is public. The most reviewable artifacts, in order of how much they repay reading:

| Artifact | Why read it | Effort |
|---|---|---|
| The CSP in the built artifact | it is the no-egress claim, in one place | minutes |
| The WASM import section | it is the same claim, structurally | minutes |
| The corpus and the rule packs | YAML. Every explainer carries a `reviewed_by`. Every rule carries `acceptable_when`, `sources` and a `versions` predicate | hours, and it is the highest-value reading |
| The envelope and crypto path | `32` §7 specifies the header byte by byte; `32` §16 ships test vectors including negative vectors | a day for someone who knows what they are looking at |
| The parsers | `31` B12 — the only fully attacker-controlled boundary in the design. We ship the fuzzing corpus | a day |
| The sync service | nine endpoints, no content operation, no create operation | half a day |

### Q48. Will you sign an NDA?

Yes, mutual, standard. Two clauses we will not accept, and it is faster to say so now:

1. **Anything that restricts you publishing a vulnerability after coordinated disclosure.** We
   run a 90-day clock (§10) and we are not going to use a contract to extend it.
2. **Anything that makes the security documentation confidential.** `31`, `32`, `33`, `34` and
   this document are public on purpose. A security posture you cannot show your auditor, or that
   we can quietly revise per-customer, is not a posture.

There is also less to protect than you expect: the source is public, the corpus is public, the
format is specified with test vectors. The only genuinely confidential thing in the relationship
is **your** information, and the NDA should be weighted accordingly.

### Q49. Will you sign a DPA?

Depends on whether we process anything for you, which depends on the shape.

| Shape | Are we a processor? | What we sign |
|---|---|---|
| A, B, E | **No.** We receive nothing. There is no processing to govern | Nothing is needed. We will state this in writing, because procurement systems want a document |
| C, D (you self-host) | **No.** You operate the service; we supply software | A software licence and a support agreement. `37` §4 explains why a DPA here would be a fiction |
| Sync operated by us | **Yes**, of ciphertext plus metadata | A GDPR Article 28 DPA, with the honest clauses in `37` §5 — including the ones where the honest answer to "assist the controller with data subject requests" is "we cannot, because we cannot read it, and here is what we can do instead" |
| Tier 1 AI | Not us. **The provider is the processor and you engage them directly** | Your contract with your provider. We are not in that chain and will not pretend to be |

`37-privacy-and-compliance.md` is the whole answer and includes the DPA clause table with the
clauses we will strike and why.

### Q50. What licence?

**DECISION — not yet made, and this document is not the place to make it.** It matters to this
review because it decides whether you can fork the project if we disappear (Q64).

**RECOMMENDATION —** a permissive licence with an explicit patent grant for the core and the CLI,
so that a fork is unencumbered; a share-alike or copyleft licence for the sync service if we ever
want hosted parity to be a condition of running it; and a separate, clearly stated licence for
the corpus, which is authored prose and not code. If you have a licence constraint (many defence
and health customers do), raise it before the first release, because it is expensive to change
afterwards.

### Q51. What happens to our data if you shut down, or we stop paying?

Nothing happens to it. It is a file you already hold. Specifically:

- the format is specified byte by byte (`32` §7, `17`) with published test vectors including
  negative vectors (`32` §16);
- the CLI reads it, and so would any independent implementation of the spec;
- there is a plaintext export path with a deterministic output format (`17` §15);
- there is no licence check, no activation, no phone-home, and no server in the read path.

**No hostage-taking is possible by construction**, which is a property of the architecture rather
than a promise in a contract. That is the answer to give your procurement risk register.

### Q52. Will you complete our security questionnaire?

Yes — CAIQ, SIG, or your own spreadsheet. Expect a high proportion of "not applicable", and
expect us to write *why* in the comment column rather than leaving it blank. The recurring ones:

| Question class | Our answer |
|---|---|
| "Describe your data centre physical security" | Not applicable — we operate no data centre in your deployment. If you self-host, this is your row |
| "Describe your access control for customer data" | Not applicable — no employee of ours can access customer data, because no copy exists at our end |
| "Describe your encryption at rest and in transit" | `32`. Argon2id → ChaCha20-Poly1305, AEAD-sealed records, TLS 1.3 underneath, and the server holds no key |
| "Describe your SIEM and monitoring of customer activity" | We do not monitor customer activity. There is no telemetry (invariant 1) and there cannot be a read audit (§12) |
| "Do you hold SOC 2 / ISO 27001?" | No. §9 |
| "Do you use sub-processors?" | Not in your deployment. Q8 |

### Q53. Can we get support, and what does support see?

Support sees what you paste into a support ticket and nothing else. There is no remote session,
no diagnostic upload, no crash reporter, no "share workspace with support" button, and we do not
intend to add one — every version of that feature is an egress path with a friendly name.

What helps a support ticket without disclosing an estate: the build version and date, the corpus
and pack versions (both pinned in the workspace and shown in the masthead), the deterministic
output of `fathom fsck`, and a minimal reproduction built from the field card's own example
values — `203.0.113.10`, `10.1.0.0/16`, `10.2.0.0/16`, `GW-B`, `VPN-B`. Documentation examples
use those addresses deliberately so that a reproduction never needs a real one.

---

## 9. Certification and assurance

### Q54. What is your SOC 2 status?

**We do not have one. Nor ISO 27001, nor FedRAMP, nor Cyber Essentials, nor a penetration test
report, nor an independent cryptographic review, nor a formal verification of anything.**
`31` §10.1's last row states it in those words and will keep stating it until something changes,
at which point that row names the auditor, the date, the scope and the report.

### Q55. Fine — but our policy requires one. What do you actually offer instead?

First, the part of the question that matters more than the answer: **SOC 2 attests to a service
organisation's controls over a system it operates.** In modes A, B, D and E we operate nothing.
The system in scope for your audit is *yours*: your host, your TLS, your access control, your
backups, your logging. A SOC 2 report about us would attest to controls over a service you are
not using.

Where the ask is fair: if you use a sync service **we** operate. Then it is a service, we operate
it, and "no SOC 2" is a real gap rather than a category error. We will say so rather than
deflecting.

What exists today, and it is not nothing:

| Artifact | What it evidences | Where |
|---|---|---|
| A published threat model with residual risk and named owners | that the analysis happened and what it concluded | `31` |
| A cryptographic specification with test vectors, including negative vectors | that the crypto is checkable, not asserted | `32` §7, §16 |
| Reproducible builds and published hashes | that the artifact matches the source | `31` §5.3 check 4 |
| Signed releases and signed rule packs, scoped trust store, no TOFU | that what you install is what we published | `12-rule-engine.md` §13 |
| An SBOM per release | dependency review as a diff rather than an audit | §10 |
| A published vulnerability disclosure policy with a 90-day clock | that reports have somewhere to go | Q66 |
| The local verification procedures in §3 and §4 | that you can check the two headline claims yourself, in an hour | this document |
| CI checks that fail the build on a broken claim | that the claims are tested rather than aspirational | `31` §12 |

### Q56. Would you get a SOC 2 if we asked?

If a customer funds it, yes, and we will tell you exactly what it did and did not test. Left to
our own budget we would spend the same money differently, in this order:

1. **A funded independent rebuild** (`31` R7, marked *revisit: now*). Reproducible builds are the
   strongest verification story in the whole posture and they are currently worth nothing,
   because nobody rebuilds. One second CI pipeline in a separate account with separately held
   credentials, with a divergence as a release blocker, converts "trust our build" into
   "somebody checked".
2. **A real penetration test of the parsers and the sync service**, published in full including
   the findings we did not fix and why.
3. **An independent review of the envelope format against the test vectors.**

A Type I obtained to clear a procurement gate tells you about a point in time and about our
willingness to spend money. The three items above tell you about the artifact. If your policy
requires the first anyway, say so and we will price it.

### Q57. Are you FIPS 140 validated? Do you use FIPS-approved algorithms?

No, and mostly no. `32` D3 chooses ChaCha20-Poly1305 (RFC 8439) over AES-256-GCM because WASM has
no AES instructions and the acceleration argument only pays if you go through WebCrypto, which
means moving plaintext into the JS heap. Argon2id (RFC 9106) is not a NIST-approved KDF. BLAKE3
is not a NIST hash.

If your environment mandates FIPS-validated cryptographic modules, **this product does not meet
that requirement and no configuration of it does.** That is a clean no, and it is better for both
of us if it arrives in the first meeting.

### Q58. Has anyone independently reviewed the cryptography?

No. What we have instead is a specification detailed enough that review is possible without our
help: the header layout byte by byte, the AAD field by field with the attack each field stops,
the nonce-uniqueness argument in full, the key-commitment construction and why a
password-wrapped multi-recipient container needs one, and a test-vector tree with negative
vectors that a second implementation must fail correctly (`32` §5.4, §5.6, §7, §16).

We also state what is *not* rolled by hand and what is: `32` §15.2 says plainly that the places
we wrote code ourselves — the envelope framing, the record derivation, the member log replay —
are where the bugs will be.

### Q59. What about the EU Cyber Resilience Act / product security regulation?

Marked for legal review rather than answered here. The relevant obligations for a manufacturer of
a product with digital elements — vulnerability handling, a coordinated disclosure policy, an
SBOM, security updates for a support period, and reporting of actively exploited vulnerabilities
— map onto things this project intends to do anyway (§10). The parts that need counsel are
whether an open-source project distributed without monetisation falls inside scope, and what the
support period commitment must be.
<!-- VERIFY: CRA (Regulation (EU) 2024/2847) scope for open-source stewards versus manufacturers, the applicable dates for the reporting and main obligations, and whether a paid hosted sync service changes the classification. Get counsel; do not answer this from a blog post. -->

---

## 10. The project — commit access, bus factor, disclosure, incident response

### Q60. Who has commit access?

At the time of writing: one person, named in the repository. That is the honest answer and the
rest of this section is what we do about it rather than a denial.

Controls that exist:

| Control | What it does | What it does not do |
|---|---|---|
| Branch protection with required review | forces a pull request | **with one maintainer, review is not a control** — self-merge is possible and we will not pretend otherwise |
| Signed commits, hardware-backed 2FA | binds changes to a key rather than a password | nothing against the maintainer themselves |
| The release signing key is offline and is **not** in CI | a CI compromise cannot sign a release | nothing against the key holder |
| Reproducible builds | makes a silent source-to-artifact divergence detectable | only if someone rebuilds (`31` R7) |
| Public, diffable source and corpus | makes a malicious change detectable by anyone reading | requires someone to read |

**The honest statement:** with one maintainer, the controls that work are the ones that do not
depend on the maintainer — reproducible builds, a public diff, signed artifacts, and a documented
format. The controls that depend on process are theatre until there is a second person, and
adding a second name to a `CODEOWNERS` file does not create one.

### Q61. What happens if the maintainer disappears?

Ranked by what actually protects *you*, not by what sounds reassuring:

| # | Control | Status |
|---|---|---|
| 1 | **Your data outlives the project.** The workspace format is specified byte by byte with published test vectors; the CLI reads it; there is a plaintext export; there is no server in the read path and no licence check | shipped by design, and it is the single most important continuity control |
| 2 | **The corpus is the asset and it is the most portable thing we own.** YAML in a public repository, every entry with a `reviewed_by`. It survives the tooling | shipped by design |
| 3 | **A fork is legally possible** — subject to Q50's undecided licence | **DECISION outstanding**, and it blocks a clean answer to this question |
| 4 | **Signing key succession** — named backup holders and an offline revocation key, so a project that changes hands can prove it | **not yet designed.** Belongs in `70-ops/` |
| 5 | Source escrow | **theatre for a public-source project.** We will not sell it to you |

What we would sign instead of an escrow agreement: a commitment to keep the format specification
and the test vectors published, and to transfer the canonical release location and the domain to
a named successor or to a foundation rather than letting them lapse. A lapsed domain that someone
else registers is `31` C1.3 — typosquatting the download — with our own name on it.

### Q62. Is a k-of-n escrow of the signing key a good idea?

No, and it is worth saying why because someone always proposes it. **A k-of-n escrow of a signing
key is a k-of-n path to signing.** It converts a single high-value secret into a set of secrets
held by people who are, by construction, less practised at protecting it. The right shape is key
*rotation* with an offline revocation key and a published succession procedure, not key sharing.

Contrast with workspace recovery, where Shamir escrow **is** offered (`32` D12) — because there
the shares protect the customer's own data against the customer's own memory, and the threat
model is loss rather than compromise.

### Q63. What is your vulnerability disclosure process?

| | |
|---|---|
| **Where to send it** | the address in `/.well-known/security.txt`, per RFC 9116, with a `Contact`, an `Encryption` key, a `Policy` URL and an `Expires` field that we keep current |
| **Encrypted reports** | yes, key fingerprint published in the repository and in `security.txt` |
| **Acknowledgement** | 3 business days |
| **Triage and severity** | 10 business days, with our classification and our reasoning sent back to you |
| **Fix target** | per class, §Q65 |
| **Disclosure clock** | 90 days from report, or on the fix, whichever is first. Extendable once, by agreement, with the reason published |
| **If we go silent** | **publish.** We will not pursue you and we will not ask you to wait for a maintainer who is not answering |
| **Safe harbour** | testing against your own instance, in good faith, within the policy scope, is authorised and we will not pursue legal action. Do not test against another customer's instance; we cannot authorise that and neither can you |
| **Bounty** | **no.** Unfunded. A bounty programme with no budget is worse than none — it sets an expectation of payment and then argues about severity |
| **CVE assignment** | via GitHub Security Advisories as the CNA of last resort |
| **Advisory feed** | signed advisories at the canonical location, plus a mailing list and an RSS feed. Q68 explains why this is the *only* way you will hear from us |

Out of scope for the policy, stated so nobody wastes a week: findings that reduce to "the browser
is compromised", "an extension can read the page", "the clipboard is plaintext", "a colleague
with the passphrase can read everything", or "a signed pack from a trusted publisher can contain
a wrong rule". All five are documented residual risks in `31` §6 and `31` §11, not vulnerabilities.
A report that shows one of them is *worse than documented* is very much in scope.

### Q64. What is your incident response?

An incident here is not shaped like a SaaS incident, because there is no tenant data at our end
to lose. The classes, with what each actually requires:

| Class | Example | Who must act | Commitment |
|---|---|---|---|
| **P0 — release signing key compromise** | the key is exfiltrated or misused | everyone who installs after the compromise | revocation notice within 24 hours of confirmation, published at the canonical location, signed with the offline revocation key, and the new key fingerprint published through at least two independent channels |
| **P1 — cryptographic defect in the workspace format** | nonce reuse, a key-commitment bypass, a KDF misuse | everyone holding a workspace | advisory plus a detector (`fathom fsck --crypto`) plus a stated migration path, within 7 days of a fix existing |
| **P2 — remotely triggerable client defect** | a parser bug reachable from pasted configuration (`31` B12) | anyone who pastes | fix and advisory within 14 days |
| **P3 — sync service breach** | an operator's store is dumped | that operator's users | if you operate it, you notify. If we operate it, notification to controllers without undue delay and within 72 hours per GDPR Article 33(2) — see `37` §8 |
| **P4 — corpus or rule defect that could cause a harmful change** | a `remediation` string that is syntactically valid and semantically wrong; a `versions` predicate that makes a rule fire wrongly on Junos 23 | anyone on the affected pack version | pack yank, advisory, and a corrected pack with the version predicate fixed |
| **P5 — availability** | a service is down | that operator's users | best effort, and no SLA is offered at this stage. Saying "99.9%" without an on-call rota would be a lie |

What is **not** an incident: a finding you disagree with (file it against the rule pack); a rule
that is wrong for your platform version (a corpus bug, and the `versions` predicate is the fix);
a workspace whose passphrase was lost (unrecoverable by design, and the most common way users
will actually be harmed by this product).

### Q65. What is the timeline for a fix?

The table above is the commitment. The honest rider: those are targets held by one person. If
that is not good enough for your risk register — and for a bank it may well not be — the
compensating control is that you can read the diff, rebuild the artifact, and, in the limit,
fork it. That is a weaker guarantee than a support contract and a stronger one than a support
contract with a vendor that has gone quiet.

### Q66. How will we hear about it?

**We cannot tell you. You have to come and look.**

There is no telemetry (invariant 1), no accounts in modes A, B and E, no update check, and no
mailing list you are automatically on. That is a direct cost of the no-egress position and we
are not going to pretend it is a feature.

What you must do, and it belongs in your runbook rather than in ours:

| Action | Cadence |
|---|---|
| Subscribe to the signed advisory feed and the mailing list | once |
| Assign a named person to check the release page | monthly, and it is a control your auditor will accept |
| Record the installed build hash, corpus version and pack versions in your change record | per install |
| Watch the build-age margin tab in the masthead | continuously, for free |

If you operate modes C or D you can do better: your served build's version is known to you, so
your own configuration management can alert on it.

### Q67. Do you publish an SBOM?

Yes, per release, so that dependency review is a diff rather than an audit. The runtime
dependency surface is deliberately small (brief §8.4) and `cargo-deny` / `cargo-vet` run in CI
with lockfiles committed and no runtime fetch of anything. A small dependency set is a smaller
target, not a safe one — CVE-2024-3094 got in through a build-time dependency of a compression
library, which is exactly the shape we are exposed to.

### Q68. How do we know a rule pack we install is safe?

You know **who** signed it. You do not know that it is correct, and the distinction matters
enough that `31` §5.2 states it as a thing to say in the review pack before someone finds it:

> A signature proves origin, not correctness.

A correctly signed pack from a trusted publisher containing a rule that says PFS is optional is
exactly as installable as a good one. What remains:

- rule logic cannot be overridden under someone else's rule id — `condition`, `applies_to`,
  `requires` and `platforms` are not presentation-overridable (`12-rule-engine.md` §12.6);
- packs are diffable between versions, and the diff is meaningful because output is
  byte-deterministic;
- `acceptable_when` is mandatory on every rule (invariant 8), which forces the justification into
  text a human can read and disagree with;
- the trust store is scoped and there is no trust-on-first-use.

For a bank, the operational answer is pack pinning: pin the pack version in the workspace
(`17` §8), review the diff before bumping it, and treat a pack bump as a change like any other.

### Q69. What is in your dependency policy?

No runtime third-party JavaScript at all — `34` §8.3 fails the build if a third-party runtime
origin appears in the bundle. Fonts bundled, not fetched. Rust dependencies reviewed with
`cargo-vet`, denied with `cargo-deny`, lockfiles committed, and the Node.js that exists in the
build pipeline can be eliminated entirely if a customer requires it (brief §8.6).

---

## 11. People and offboarding

### Q70. What if an employee leaves with a workspace?

They have it. This is `31` §5.1 row 13, residual `material` and honestly closer to `total` for
read access, and it is a design consequence rather than an oversight:

- there is **no in-workspace compartmentation**. One passphrase, one document, everything;
- git history gives you after-the-fact attribution of *changes*, never of *reads*;
- rotating the passphrase protects future ciphertext. It does not protect the copy they took, and
  it does not protect old commits in a repository they cloned — **every historical version is
  separately attackable** (`31` §8.1, leaf A1.1.4).

What actually helps, in order:

| Control | Effect |
|---|---|
| **Member removal on a shared workspace** — eager and blocking: epoch bump, every record re-sealed before the flow reports success (`32` D11) | they cannot read anything written *after* removal. "Revoked, but 400 records are still readable by them" is a lie told by a progress bar, so we do not do lazy re-seal |
| **Root key rotation** (`32` §9.2) | protects ciphertext written **after** the rotation. It does not reach copies that already exist — every copy carries its epoch's keyholder record, so a departed colleague holding a clone plus any epoch credential still opens it (ADR-0015; and note `32` §11.1: a printed recovery code is re-wrapped at every epoch bump, so removal must include the re-print-or-revoke step) |
| **Treat departure as disclosure of everything they could read** | the appropriate response to a departure that matters is a network change — rotating the peer's PSK, revisiting the zones they knew about — not a password change. That is an unpleasant sentence and it is the correct one |
| Repository access removal and history rewriting | removes future access; does nothing about the clone they already have |

### Q71. Our DLP cannot inspect your file. That is a problem for us.

It is, and it cuts both ways, so here is the honest version. A ciphertext workspace is opaque to
content inspection by design; the same property that stops your hosting provider reading it stops
your DLP reading it.

What you can inspect, and it is more than it sounds:

| Surface | Inspectable | How |
|---|---|---|
| Plaintext exports | **yes** | they carry a fixed header block. Write DLP rules on `THIS FILE IS PLAINTEXT. EVERY PROTECTION THE WORKSPACE HAS ENDS HERE.` and on the findings-export header in Q4. Both strings are stable on purpose |
| Copied change blocks | **yes** | the clipboard payload carries the same header, including the workspace name, the corpus and pack versions, and the highest `Risk` in the block (`34` §6.3) |
| Workspace files | by extension and by size, not by content | `.fathom`, `.fathom.d/` |
| Sync traffic | by destination, not by content | one origin |
| Anything at tier 1 | by destination, and in the workspace's own egress log | `21` §8.6 |

The general principle: **the product makes its plaintext exits loud on purpose.** Every place
where protection ends carries a header that says so, in caps, and those headers exist partly so
that a security team can key on them.

### Q72. Can we prevent exports?

Not by a switch we ship, and we would rather be honest about why than sell you a checkbox that
`31` §9.1 argues against. Refusal relocates the action rather than preventing it: an engineer
who cannot export will screenshot, or retype, or paste into a chat window, and all three of those
are worse because they carry no header and leave no record.

What exists instead: an export log in the workspace (`17` §15.4) recording what was exported,
when, by whom, with a stated reason, and a plaintext gate that requires the reason before the
file is written. That converts an invisible action into a recorded one. If your policy needs
prevention rather than recording, the enforcement point is your endpoint DLP and your filesystem
permissions, not our UI.

### Q73. Can we see what a departing engineer had access to?

To their own workspaces: everything in them, in the clear. There is no partial access to model.

To a *shared* workspace: the member log is a hash-chained, append-only record with Ed25519
quorum signatures, replayed from genesis on every open (`32` D10). So you can establish who was
a member and when, and you can prove the server did not silently add one. You cannot establish
what any of them read, ever — §12.

---

## 12. Logging and audit

### Q74. What logging do we get?

Less than you are used to, and the reason is structural rather than an omission.

| Log | Where it lives | Who reads it | Contains |
|---|---|---|---|
| Sync service access log | your service, modes C/D | your operators | account, workspace id, generation, size, timestamp, source IP. No content, ever |
| Reverse proxy log | your infrastructure | you | whatever you configure |
| Export log | inside the workspace (`17` §15.4) | anyone with the passphrase | what was exported, when, by whom, and the stated reason |
| Egress log | inside the workspace (`21` §8.6) | same | the full literal request and response bodies at tier 1. Empty at tiers 0 and 2 because nothing left |
| AI audit record | inside the workspace (`17` §11) | same | proposals, acceptances, rejections, and the deterministic result they were compared against |
| Suppression records | inside the workspace | same | every waived finding, with a written reason, visible in the diff |
| Provenance | in the graph | same | how each value got in, and when |
| Git history | your repository | whoever can read the repo | every change, attributable, forever |

### Q75. Where is the audit of who *read* what?

**There is none, and there cannot be one in this architecture.** Say it plainly in the review
because it is a hard requirement in some frameworks:

A read audit requires an authority that observes reads. The only candidate is the sync service,
and the sync service cannot observe reads: a client fetches ciphertext records and decrypts them
locally, so "fetched a record" is not "read a device", and in the common case a user reads a
workspace they already have on disk without contacting anything at all. Adding a read audit means
adding a component that sees plaintext and knows who is looking at it, which is the surveillance
the product exists to avoid.

**If a per-user read audit trail is a hard control requirement in your framework, this product
fails it.** Not "partially satisfies with compensating controls" — fails it. What you can
substitute, and what a competent auditor will accept for a locally-installed tool, is
access-to-the-artifact control: who holds the workspace file, who holds the passphrase, who is in
the member log, and endpoint controls on the machines those live on.

### Q76. Can we ingest anything into our SIEM?

Yes, three streams:

| Stream | Format | Cadence |
|---|---|---|
| Sync service access events | structured JSON to stdout or syslog, from your own deployment | live |
| Export log | deterministic YAML via `fathom export-log --format yaml` | on demand, per workspace |
| Egress log | same dialect, full bodies or digests | on demand, per workspace |

The last two are pull, not push, because pushing them would require the application to originate
a connection to your SIEM, and invariant 1 says it opens no connection the user did not configure.
An operator who wants them pushed can wrap the CLI in a scheduled job, on a machine they control,
with credentials they hold — which is the right place for that decision anyway.

---

## 13. What the tool could do to weaken you

> *"What does the tool do that could weaken our security?"*

The question we most want asked, because the answer is a design position rather than an apology.

### Q77. So — what?

The position first, from `31` §9.1:

> **Fathom refuses nothing a competent engineer could type themselves. Every weakening is
> labelled with its finding, and no weakening can be emitted silently.**

That is not liberal-mindedness, it is efficacy. A tool that refuses to emit
`delete security ipsec policy IPSEC-POL perfect-forward-secrecy` does not stop that change; it
relocates it to a text editor, where there is no finding, no `acceptable_when`, no suppression
record, no provenance and no rollback. **Refusal converts a labelled change into an unlabelled
one.**

Now the concrete list. Every row is drawn from the owner's SRX IPsec field card, because that is
the material the product actually emits.

| # | What the tool does | The weakening | `Risk` of the emitted line | What is attached |
|---|---|---|---|---|
| 1 | Tells you to permit IKE inbound on the WAN zone: `set security zones security-zone WAN interfaces reth0.0 host-inbound-traffic system-services ike` | **This is the tool telling you to open a daemon to the internet.** It is required — miss it and Phase 1 times out with nothing useful in the log, because the box drops the peer's IKE before processing it (field card sides 1 and 4). Scope it to the zone rather than the interface, or leave it after decommissioning a peer, and you have exposed IKE more widely than you meant | `ChangesConfig` | a finding on over-broad `host-inbound-traffic` scope, and an emitter that prefers the per-interface form over the per-zone form <!-- VERIFY: confirm on current Junos that host-inbound-traffic can be scoped per-interface within a security zone, and the exact syntax, before shipping the emitter preference --> |
| 2 | Emits `set security flow tcp-mss all-tcp mss 1350` when you ask for an MSS clamp | `all-tcp` hits **everything** through the box, a far bigger blast radius than most people intend. `tcp-mss ipsec-vpn` clamps only tunnel traffic and is the clean fix (field card side 4) | `ChangesConfig` | a **blast-radius** finding, deliberately not a security finding. The rule ids keep the distinction |
| 3 | Returns `clear security ike security-associations <peer>` from the finder | Clearing Phase 1 tears down every child SA under it — on a hub that is every spoke at once (field card side 3) | `Disruptive` | the risk legend, in the same three colours as the printed card, and the finder entry's own note to always scope by peer or index |
| 4 | Emits `set security ipsec vpn VPN-B df-bit clear` as an MTU fix | Lets the network fragment the encrypted packet rather than drop it. It is the rescue when you control neither endpoint, and it costs reassembly at the peer and changes the fragmentation posture of the tunnel (field card side 4) | `ChangesConfig` | the three-fixes explainer, which insists you know the difference between clamping, lowering the MTU and clearing DF |
| 5 | Emits `set security ike traceoptions …` for a diagnosis | Traceoptions left on will fill `/var`, **which breaks logging and commits both** (field card side 3) | `ChangesConfig` | the cleanup lines are emitted in the same block, not as an afterthought: `delete security ike traceoptions` and `commit` |
| 6 | Builds a VPN with no `traffic-selector` | The SRX proposes `0.0.0.0/0` any-to-any, and peers that build one SA per subnet pair reject it outright (field card side 4) | `ChangesConfig` | a selector finding |
| 7 | Accepts `establish-tunnels responder-only` on both ends | Nobody initiates, nothing is misconfigured, the tunnel never comes up (field card side 4) | `ChangesConfig` | an availability finding across the pair, which requires both ends in the graph — one of the things a graph gives you that a template does not |
| 8 | Produces a findings export | **The most dangerous artifact the product makes** (Q4). It did not exist before you used the tool | n/a | the header in Q4, and the tightest export gate in the product |
| 9 | Ships a rule with a wrong `versions` predicate | A rule correct on Junos 21 and wrong on 23 is worse than no rule (brief §5.2) | n/a | version predicates are mandatory; a pack diff is reviewable; and this is a P4 incident class when it happens |
| 10 | Has an emitter bug | Deterministic, confident, wrong output — the same bytes every time, which is what makes people trust it | n/a | nothing technical. The mitigation is the field card's imperative and your lab |
| 11 | Lets an insider record a plausible suppression with a plausible reason | Launders a real weakness into an accepted one (`31` B1.3.1) | n/a | the suppression is durable, shows up in the diff, and carries a reason written under their own hand. They can lie; they must lie in writing, in a record that outlives the change |
| 12 | At tier 1, accepts a hostile instruction embedded in a pasted config | A proposal aimed at weakening | n/a | bounded, not prevented (Q36) |

And the row that is not on the list, because a labelling scheme that fires on everything is muted
within a week: `delete security ike traceoptions` gets **nothing**. It is the correct cleanup the
field card insists on, and a tool that flagged it would be flagging good practice.

### Q78. What should our change process require, given all that?

Concrete, and short enough to paste into a change template:

| Requirement | Why |
|---|---|
| Every Fathom-generated change block goes into the ticket **with its header intact** — workspace, corpus version, pack versions, build version, scope, highest `Risk` | it makes the change reproducible and attributable, and the reviewer can regenerate it |
| The verify ladder and the rollback are in the ticket, generated for **that** change | the product emits both; `18-diff-verify-rollback.md`. A generic ladder is not a ladder |
| `commit confirmed 5` is the first line, always, remotely | field card side 1, bring-up order #1. The tool emits it first because the card does |
| Any suppression created during the change is listed in the ticket with its reason | that is what makes a suppression a review artifact rather than a mute button |
| Pack and corpus versions are pinned, and a bump is its own change | Q68 |
| Lab verification before production for any new emitter path | **VERIFY AGAINST YOUR OWN BOX BEFORE ACTING** is the field card's own governing line and it is in the product for a reason |

---

## 14. The questions we volunteer

Three that rarely get asked and should be.

### Q79. "What is the most likely way this product hurts us?"

Not a breach. **A passphrase nobody wrote down.** Losing it loses the workspace; there is no
recovery flow to social-engineer because there is no recovery flow. `31` §2.4 names this as the
most common way users will actually be harmed by this product, and `32` D12 offers a printed
240-bit recovery code and a Shamir escrow, both **off by default** — which is the correct default
and a terrible one to have *only*.

Your control: decide, at rollout, whether your engineers use the printed recovery code, and where
those printed codes live. That is a five-minute policy decision that prevents the single most
likely bad outcome.

### Q80. "What would make you tell us not to buy this?"

Four requirements, any one of which is disqualifying:

| Requirement | Why we fail it |
|---|---|
| A per-user read audit trail | §12. Structurally impossible here |
| FIPS-validated cryptographic modules | Q57. No configuration meets it |
| A vendor SOC 2 report as a gate | Q54. We do not have one |
| No locally installed binaries and no browser-delivered applications | §5, §7. There is nothing left |

### Q81. "What is the strongest argument against your own architecture?"

That the cryptography is not where the risk is, and we know it. `31` §8.4: the cheapest attack
paths are a browser extension, a colleague with legitimate access, and a config pasted into a
ticket. None of them is cryptographic. If we spent the next quarter on cryptography the attack
tree would not change.

The correct read of that is uncomfortable and it is in the threat model rather than hidden from
it: **the zero-knowledge architecture defends well against the actors that are cheap to defend
against, and not at all against the actors that are cheap to become.** We build it anyway because
the alternative — a server that can read your estate — fails against those same cheap actors
*and* the expensive ones. But we are not going to present the crypto as the answer to a question
it does not answer.

---

## 15. The register of everything that is "no"

Every "no" in this document, in one table, so a reviewer can find them without reading it twice.

| # | Question | Answer | Where |
|---|---|---|---|
| 1 | Do you hold a copy of our data? | No | Q2 |
| 2 | Do you have SOC 2? | No | Q54 |
| 3 | ISO 27001? | No | Q54 |
| 4 | FedRAMP / Cyber Essentials / any certification? | No | Q54 |
| 5 | Independent penetration test report? | No | Q55 |
| 6 | Independent cryptographic review? | No | Q58 |
| 7 | FIPS 140 validated modules? | No, and no configuration achieves it | Q57 |
| 8 | Is the browser in your threat model? | No | Q24 |
| 9 | Can you defend against a malicious extension? | No | Q25 |
| 10 | Can you defend against endpoint malware, keyloggers, screen capture or coercion? | No | Q28 |
| 11 | Is tier 1 zero-knowledge? | No, and no redaction makes it so | Q30 |
| 12 | Can you tell us the provider's retention period? | No | Q34 |
| 13 | Does the tool auto-update? | No, by decision | Q20 |
| 14 | Can an offline build learn a newer version exists? | No | Q42 |
| 15 | Can you notify us of an advisory? | No — pull, not push | Q66 |
| 16 | Is there a per-user read audit? | No, and there cannot be | Q75 |
| 17 | Can you prevent exports? | No, and we argue against trying | Q72 |
| 18 | Is there in-workspace compartmentation? | No | Q70 |
| 19 | Does a signature prove a rule pack is correct? | No | Q68 |
| 20 | Is there a bug bounty? | No | Q63 |
| 21 | Will you sign an NDA that gags disclosure? | No | Q48 |
| 22 | Do you offer source escrow? | No — theatre for a public-source project | Q61 |
| 23 | Will you run a warrant canary? | No | Q10 |
| 24 | Is there an availability SLA? | No, not at this stage | Q64 |
| 25 | Is there a remote support session or diagnostic upload? | No, and we will not add one | Q53 |

Twenty-five. If that number goes down over time it should go down because something changed, not
because the wording softened.

---

## 16. What we will put in a contract

The list exists so that a legal review has something concrete to argue with rather than a
security document to interpret.

| Commitment | Shape it applies to | Notes |
|---|---|---|
| Reproducible builds; published hashes for every release artifact | all | the strongest thing we can commit to, because you can check it |
| Signed releases and signed rule packs; a published key fingerprint; a documented revocation procedure | all | |
| An SBOM per release | all | |
| A published vulnerability disclosure policy with the acknowledgement, triage and clock in §Q63 | all | |
| The incident classes and timelines in §Q64 | all | targets, and we will say "target" in the contract rather than "SLA" |
| The security documentation stays public and is not weakened per-customer | all | `31` §12's byte-equality check enforces it internally |
| Format specification and test vectors remain published; a successor is named for the release location and domain | all | the continuity commitment that actually protects you (Q61) |
| No telemetry, no analytics, no third-party runtime code, no CDN, no error reporting | all | CI-enforced; independently checkable in five minutes |
| A GDPR Article 28 DPA over ciphertext and metadata | hosted sync only | `37` §5, including the clauses we strike and why |
| Named sub-processor list, with notice of change | hosted sync only | one entry: the hosting provider |
| Data residency of ciphertext and metadata to a stated region | hosted sync only | |
| Deletion on request, with a stated backup rotation as a number | hosted sync only | replica deletion only — crypto-erasure is not available against existing copies and is not claimed (Q9, ADR-0015) |
| A transparency statement of legal requests received | hosted sync only | no canary (Q10) |

Not offered, and we will say so at contract stage rather than negotiate: an availability SLA with
credits, a security certification we do not hold, a training-data commitment on a provider's
behalf, and any promise about what a compromised browser does.

---

## 17. Sources

| Claim | Source |
|---|---|
| Compromised browser, extensions, isolated worlds, `world: "MAIN"`, the `debugger` permission | `31-threat-model.md` §6.2 and its sources |
| Metadata channels M1–M11, the six-week worked inference, Padmé padding, the batching cost | `31-threat-model.md` §7; Nikitin et al., PoPETs 2019(4) for the padding bounds |
| Attack trees, the cheapest leaves, no-auto-update DECISION, the rollback branch | `31-threat-model.md` §8 |
| Abuse-case position, the weakening interlock, the export gate types | `31-threat-model.md` §9 |
| The non-claims register, including "no security audit claim of any kind" | `31-threat-model.md` §10.1 |
| CI checks that make claims fail a build | `31-threat-model.md` §12 |
| Argon2id parameters, `p=1` decision, ChaCha20-Poly1305, key commitment, member log, revocation, recovery | `32-cryptography.md` D1–D15 |
| OPAQUE authentication; the server's four jobs and six prohibitions; nine endpoints | `33-sync-protocol.md` §1, §2, §3.2 |
| CSP per mode; `<meta>` discards `frame-ancestors` and reporting; the single-session single-file decision and its costs (rewritten per ADR-0017); clipboard headers; third-party isolation in CI | `34-browser-hardening.md` §2, §3, §6, §8 |
| AI tiers, build-time CSP, `EgressEnvelope`, pseudonymisation into `100.64.0.0/10`, the pre-flight, consent grants, the egress log retaining literal bodies, the armed indicator, the plain statement | `21-ai-layer-architecture.md` §7, §8 |
| Injection is bounded, not prevented | `23-ai-safety-and-injection.md` |
| Workspace format, export gate and export header text, version pins, the AI audit log | `17-workspace-format.md` §8, §11, §15 |
| Rule-pack signing, scoped trust store, no TOFU, presentation-only overrides | `12-rule-engine.md` §12.6, §13 |
| `host-inbound-traffic system-services ike` and the Phase 1 timeout with nothing in the log; `tcp-mss all-tcp` blast radius; clearing P1 tears down every child SA; traceoptions filling `/var`; the default `0.0.0.0/0` selector; both ends `responder-only`; `df-bit clear`; `commit confirmed 5` first | Owner's SRX IPsec field card, sides 1, 3 and 4 |
| Publicly available encryption source code, US export position | `37-privacy-and-compliance.md` §10, which carries the citations |
| RFC 9116 `security.txt` fields | RFC 9116 |
| CVE-2024-3094 as the reference build-time supply-chain case | CVE-2024-3094 (xz-utils / liblzma), 2024 |

Claims not sourced above are design positions of this project, argued in place.

---

## 18. Disagreements

One, raised under the conventions' procedure rather than acted on unilaterally.

### 18.1 The conventions need a word for a customer-facing deliverable, or every document invents one

**The convention.** The terminology table pins `workspace`, `graph`, `node`, `kind`, `rule`,
`rule pack`, `finding`, `suppression`, `emitter`, `explainer`, `corpus`, `platform`,
`supervisor` / `subagent` and `provenance`. It has no term for the bundle of documents handed to
a customer's security team.

**The objection.** `31` §6.8 and §10.2 both refer to "the enterprise review pack" and require its
text to be byte-identical to the application's limits panel and the README. `34` §13.3 already
notes that the terminology table has no word for the on-disk artifact. This document is a member
of that pack and refers to it four times. Three documents now depend on a term that is not
defined, and a CI check (`31` §12, limits-panel text equality) is specified against it.

**Proposed addition** to the terminology table:

| Term | Means | Never say |
|---|---|---|
| **review pack** | the fixed set of public documents handed to a customer's security review: the threat model, the cryptographic design, the browser hardening document, this Q&A, and the privacy and compliance document. Its security-limitation text is byte-identical to the application's limits panel and the README | "sales deck", "security whitepaper", "one-pager" |

The naming matters for one reason only, and it is the reason `31` §12's last check exists: three
hand-maintained copies of a security limitation diverge, and the shortest, softest one becomes
the one people quote.
