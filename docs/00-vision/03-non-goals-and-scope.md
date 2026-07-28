# 03 — Non-goals and scope

> **Status:** Proposed

Companion documents: `.context/conventions.md` (the four hard invariants this document makes
testable), `docs/00-vision/02-prior-art-and-positioning.md` (what each refusal points the user
at instead), `docs/70-ops/71-roadmap.md` §13 (deferred and never built — the sequencing view of
the same boundary), `docs/70-ops/72-risks.md` §§4, 7 (the content problem and adoption, which
are the two pressures that will argue against every refusal here),
`docs/30-security/31-threat-model.md` and `34-browser-hardening.md` (the egress controls §3.3
depends on), `docs/40-stack/45-testing-strategy.md` (where the tests named in this document
live), `docs/70-ops/74-governance-and-licensing.md` §13.3 (why no governance body may repeal
§3).

---

## 0. Contents

| § | |
|---|---|
| 1 | How to read this, and the governing rule |
| 2 | The three classes of boundary, and the register |
| 3 | The four permanent product boundaries |
| 4 | The product non-goals |
| 5 | The decidable scope rule |
| 6 | Domain and platform scope |
| 7 | Where the pressure will come from |
| 8 | The refusals that cost money |
| 9 | Things that look like non-goals and are in scope |
| 10 | How a non-goal is retired |
| 11 | What this document costs |
| 12 | Decisions this document asks for |
| 13 | Sources consulted |
| 14 | Disagreements |

---

## 1. How to read this, and the governing rule

*margin tab: read this first*

> **A SCOPE BOUNDARY YOU CANNOT TEST IS A PREFERENCE**

Every project has a non-goals document and almost all of them are decoration, for one reason:
they are written as rhetoric. "We are not a monitoring tool" is a sentence nobody can disagree
with and nobody can enforce, and eighteen months later the product polls a device every five
minutes and nobody remembers deciding to.

This document is written to be enforceable. Every entry carries the same seven fields, and two
of them are the point:

| Field | Why it is there |
|---|---|
| **The adjacent thing we DO build** | Almost every non-goal has a legitimate 90% that Fathom must build. Naming it stops the refusal from being used to reject work that is in scope |
| **The adjacent thing we REFUSE** | The specific, plausible, well-argued version of the feature that is one step past the line. This is the testable boundary. If you cannot write this field, you have not drawn a boundary — you have written a slogan |
| **The test** | What in CI, the PR template, or the review checklist catches a drift toward it |

If a proposal is not clearly on one side of the refused-adjacent line, it is a §10 amendment, not
a product decision.

### 1.1 Why this is the highest-leverage document in the repository

`72` §4 concludes that the content problem is the most likely cause of death and that the corpus
grows at reviewer speed. Everything in this document is a decision not to spend the project's
scarcest resource on something. The brief's own list of six views is already more than one person
can build. **Scope is the largest risk, and non-goals are the only instrument that manages it.**

---

## 2. The three classes of boundary, and the register

| Class | Marker | Means | Retired by |
|---|---|---|---|
| **Permanent** | `N-P` | An invariant. Changing it produces a different product with a different trust story, and it requires a rename (`74` §13.3) | Nothing short of §10.3 |
| **Deferred** | `N-D` | Not now. A named condition would reopen it | The condition being met, plus §10.1 |
| **Refused** | `N-R` | Technically easy, deliberately not done. Reopening it needs an argument, not a trigger | §10.1 |

The register, on one page:

| ID | Boundary | Class | § |
|---|---|---|---|
| `N-P-1` | Never touches a network device | Permanent | 3.1 |
| `N-P-2` | Never accepts a credential | Permanent | 3.2 |
| `N-P-3` | No egress by default | Permanent | 3.3 |
| `N-P-4` | The server never holds a key | Permanent | 3.4 |
| `N-R-1` | Not a monitoring tool | Refused | 4.1 |
| `N-R-2` | Not a source of truth of record | Refused | 4.2 |
| `N-R-3` | Not a ticketing system | Refused | 4.3 |
| `N-R-4` | Not an orchestrator | Refused | 4.4 |
| `N-R-5` | Not a discovery tool | Refused | 4.5 |
| `N-R-6` | Not a lab or simulator | Refused | 4.6 |
| `N-R-7` | Not a certification trainer | Refused | 4.7 |
| `N-R-8` | Not a chatbot | Refused | 4.8 |
| `N-R-9` | Not a packet analyser | Refused | 4.9 |
| `N-R-10` | Not a config backup or archive | Refused | 4.10 |
| `N-R-11` | Not a compliance attestation product | Refused | 4.11 |
| `N-R-12` | Not a write-once-deploy-anywhere abstraction | Refused | 4.12 |
| `N-D-1` | Multi-tenant hosted service | Deferred | 4.13 |
| `N-D-2` | Fleet-scale workspace (thousands of devices) | Deferred | 4.13 |

---

## 3. The four permanent product boundaries

These restate `.context/conventions.md` invariants 1–4. This document's contribution is the
refused-adjacent column and the tests, because the invariants as written are statements and what
a maintainer needs at review time is a decision procedure.

### 3.1 `N-P-1` — the application never touches a network device

| Field | |
|---|---|
| **The statement** | No SSH, no NETCONF, no gNMI, no REST to a device, no SNMP, no serial. Output is copy-paste, always |
| **Why** | It removes the entire class of "the tool broke production." It also removes the credential requirement (`N-P-2`) and most of the threat model. Brief §7.1 and `31` depend on it |
| **The adjacent thing we DO build** | Everything up to the clipboard. Emitted config with provenance. A verification ladder for the change just made. The rollback for that change. A change-ticket body. Paste-ready commands with the workspace's real values interpolated |
| **The adjacent thing we REFUSE** | Listed below. Each has been argued for by somebody reasonable |
| **Use instead** | Ansible, Nornir, NAPALM, Netmiko for push. NSO, Apstra, Panorama for managed deployment. `junos-mcp-server` if you want a model to commit config, with the risks in `02` §9.4 |
| **The test** | §3.5 |
| **What would reopen it** | Nothing. `74` §13.3 |

**The refused adjacents, in the order they will be proposed:**

| # | The proposal | Why it is refused |
|---|---|---|
| 1 | "Just read-only. Only `show` commands. `ReadOnly` risk only" | It requires a credential, which is `N-P-2`. It requires egress, which is `N-P-3`. And the read-only claim is not enforceable from the client side: `show security ipsec statistics` is read-only but `clear security ipsec statistics` differs by one word, and the moment a connection exists the only thing preventing a write is the application's own filtering |
| 2 | "A CLI that runs on the engineer's jump host, where the credentials already are" | The application is one artifact with one set of invariants across all three deployment modes (`43`). A CLI that connects is a device-touching application wearing a different hat |
| 3 | "Generate an Ansible playbook and offer a Run button" | The button is the boundary. Generating the playbook text is in scope (§9.3). Running it is `N-P-1` |
| 4 | "A browser extension that types into your existing SSH session" | The user has already authenticated, so no credential is handled — and this is the most seductive version, because it is technically true. Refused anyway: the tool is now originating keystrokes on a production device, and the blast radius of a wrong emitted line changes from "the user reads it first" to "it executed." The user's review step *is* the safety control |
| 5 | "An optional plugin, off by default, that users opt into" | An invariant with an opt-out is not an invariant. It also destroys the claim in `36` that the shipped artifact cannot reach a device, which is the claim that gets the tool onto a locked-down laptop |
| 6 | "It only pastes into a terminal the user has focused" | Same as 4. The distinction between typing and executing does not survive contact with a terminal |

**Worked example of what staying inside the line looks like.** The field card's bring-up order is
nine steps: `commit confirmed 5`, then IKE SAs, IPsec SAs, inactive tunnels, `show interfaces
st0.0 terse`, `show route`, a ping across sourced from the LAN side, `show security flow session`,
and `show log kmd | match <peer>`. Fathom emits that ladder for the specific change the user just
built, with the workspace's real VPN name and peer address interpolated, each step labelled with
its `Risk` value, and each step carrying the "stop at the first failure" rule and the note that
steps 5–8 failing while 2–4 are clean is plumbing, not crypto. **Fathom never runs step one.** The
value delivered is the same value the printed card delivers; the difference is that it knows the
peer's address.

### 3.2 `N-P-2` — the application never accepts a credential

| Field | |
|---|---|
| **The statement** | No pre-shared keys, no private keys, no certificates with private material, no SNMP communities, no TACACS or RADIUS secrets, no device passwords, no API tokens. The one exception is the workspace passphrase, which never leaves the client and is never transmitted in any form |
| **Why** | Brief §6.2 says it best: it removes the highest-value secret from the application entirely and shrinks the threat model more than any cryptographic control. A tool that never holds a PSK cannot leak one |
| **The adjacent thing we DO build** | Placeholders in emitted config, and explanation of what goes in them. `set security ike policy IKE-POL pre-shared-key ascii-text "<PSK>"` with an explainer that says what a good one looks like, where it must match, and that a mismatch reads as `AUTHENTICATION_FAILED` — which is easily misread as a wrong key when the actual fault is identity |
| **The adjacent thing we REFUSE** | See below |
| **Use instead** | A password manager, a vault, or the terminal. The engineer pastes the real value at commit time |
| **The test** | §3.5 |
| **What would reopen it** | Nothing |

**The refused adjacents:**

| # | The proposal | Why it is refused |
|---|---|---|
| 1 | "Store it encrypted in the workspace, so the config is complete and paste-ready" | The workspace is encrypted, so this sounds safe. It is not: it moves the highest-value secret in the estate into a file that gets git-committed, synced, backed up and shared with a colleague. Every one of those is a normal workspace operation and none of them is a normal PSK operation |
| 2 | "A client-side-only field that is never persisted, just for this session" | The value now exists in the DOM, in browser memory, in a crash dump, and in whatever an extension can read. It also creates a UI affordance that trains users to type secrets into the tool, and the training is the damage |
| 3 | "Certificates, since the public half is not secret" | Public certificates alone are acceptable and are in scope for explaining a chain. The refusal is on any bundle that may contain a private key, and users will paste a `.pfx` because it is the file they have. **DECISION — no certificate import of any format that can carry private material** |
| 4 | "A generated PSK, so we never receive one but the user still gets a strong value" | Generating is not accepting, so this passes the letter. It fails on a different ground: a generated secret displayed by the application is a secret the application has held, and the entropy source, the display, and the copy path all become security-relevant. The tool tells the user to generate one with `openssl rand` and stays out of it |
| 5 | "SNMP community strings — they are barely secrets" | They are read credentials for the entire estate. The word "barely" in a scope argument is a warning sign in itself |

### 3.3 `N-P-3` — no egress by default

| Field | |
|---|---|
| **The statement** | The application never opens a connection the user did not configure. `connect-src 'none'` in the offline build; exactly one origin in the sync build. No telemetry, no analytics, no font CDN, no error reporting, no update check, no avatar service, no map tiles |
| **Why** | It is the only version of the confidentiality claim that a user can *verify* rather than believe. A packet capture with the tool open and a workspace loaded shows nothing. That check takes two minutes and it is worth more than any policy page |
| **The adjacent thing we DO build** | Sync, to exactly one origin the user configured, carrying ciphertext only (`33`). Rule-pack updates as a file the user downloads and imports deliberately |
| **The adjacent thing we REFUSE** | See below |
| **Use instead** | Nothing. This one has no alternative because there is no legitimate need being refused |
| **The test** | §3.5 |
| **What would reopen it** | Nothing |

**The refused adjacents — every single one of these will be proposed and each is individually reasonable:**

| # | The proposal | Why it is refused |
|---|---|---|
| 1 | "One anonymous ping so we know how many users there are" | The claim is "nothing leaves the machine." One exception makes it "almost nothing leaves the machine, and you would have to read the code to know which." That is a different and much weaker claim, and it is not checkable in two minutes |
| 2 | "A version check, so users know they are running something with a known vulnerability" | Genuinely valuable and genuinely refused. A version check is a beacon: it tells an observer that this IP runs this tool at this version at this time. The mitigation is `74` §11.3's liveness release plus advisories the user can subscribe to *outside* the application |
| 3 | "Automatic rule-pack updates, since rules are how findings stay correct" | Auto-update is an egress channel and a code-delivery channel at once. Rule packs are signed files the user imports. `63` specifies the flow |
| 4 | "Error reporting, so we can fix crashes" | The stack trace of a crash in a tool operating on network configuration contains network configuration |
| 5 | "A web font, for typography" | `design-language.md` specifies Liberation Sans and DejaVu Sans Mono with local substitute stacks. Fonts are embedded or substituted. A font CDN is a third party learning every page load |
| 6 | "Documentation links that open the vendor's site" | Links are fine — the *user* clicks and the browser navigates. The refusal is on the application originating a request. The distinction is exact and testable: `connect-src` governs fetch, XHR, WebSocket and EventSource; a user-initiated navigation is not the application connecting |
| 7 | "The AI layer needs a model endpoint" | The AI layer's egress is a configured origin, off by default, labelled in the UI, and it is the one place non-determinism is permitted (invariant 9). `21` §§5, 7–9 specify the boundary. It is not an exception to `N-P-3`; it is the "the user did not configure" clause doing its job |

### 3.4 `N-P-4` — the server never holds a key

| Field | |
|---|---|
| **The statement** | Zero-knowledge. The sync service stores ciphertext and metadata. No key, no key-derivation material, no recovery escrow, no server-side decryption for any purpose including support |
| **Why** | It makes server compromise and a malicious server operator the same, already-mitigated threat (brief §7.1). It is also what makes `74` §11.4's continuity answer true |
| **The adjacent thing we DO build** | Sync of ciphertext, conflict resolution over metadata the server can see, and the metadata leakage budget documented in `33` rather than denied |
| **The adjacent thing we REFUSE** | See below |
| **Use instead** | If an organisation needs recoverable escrow, they need a different product |
| **The test** | §3.5 |
| **What would reopen it** | Nothing |

**The refused adjacents:**

| # | The proposal | Why it is refused |
|---|---|---|
| 1 | "Optional key escrow for enterprises whose policy requires recoverable data" | This is a real, common, well-argued enterprise requirement and it is the single most likely reason a large deployment says no. Refused because an optional escrow is a server that *can* hold a key, and every subsequent security claim becomes conditional on a configuration flag |
| 2 | "Server-side search over workspaces" | Requires plaintext or a searchable encryption scheme that leaks. `17` handles search client-side |
| 3 | "Support access, with the customer's consent, to debug an issue" | The consent is real and the flow is normal in other products. Refused: the moment a support path exists, it is the path an attacker with a phone and a plausible story uses. `74` §11.4 states the cost — there is no support path that ends in "we restored it for you" |
| 4 | "Server-side rendering of the diagram for a share link" | Requires plaintext. Sharing is a client-side export |

### 3.5 The tests — how each permanent boundary is enforced

**A boundary with no test is `N-P` in name only.** These live in `45` and run on every PR.

| ID | Test | Fails when |
|---|---|---|
| `T-P1-a` | Static: no network-capable crate in the WASM build's dependency graph. Denylist checked against the resolved graph, not the manifest | A transitive dependency pulls in a socket, TLS or SSH implementation |
| `T-P1-b` | Static: the core crate declares no feature enabling any transport | A feature flag reintroduces one |
| `T-P1-c` | Runtime: the emitted-artifact test harness asserts every emitter output is `String` bound for the clipboard, and that no code path invokes an executor | Somebody adds a run path |
| `T-P2-a` | Corpus test: no emitted line, in any golden output, matches the secret-shaped regex set — base64 runs over N chars, PEM headers, `ascii-text "` followed by anything other than a placeholder token | A rule or emitter starts producing a real-looking secret |
| `T-P2-b` | UI test: no `<input>` in the application has `type="password"` or `autocomplete` values in the credential family, except the single workspace-passphrase component, which is allowlisted by ID | A credential field appears anywhere |
| `T-P2-c` | Parser test: the config-paste path redacts recognised secret material at parse time, before it reaches the graph, and the redaction is asserted on a fixture containing a real-shaped PSK, an SNMP community and a TACACS key | A pasted config's secrets reach the graph, which would put them in the workspace |
| `T-P3-a` | Build: the offline artifact's CSP is asserted byte-for-byte, including `connect-src 'none'` | Any relaxation |
| `T-P3-b` | Static: source grep for `fetch(`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator.sendBeacon`, `import(` with a remote specifier — allowlisted only inside the sync module and the AI boundary module, both of which are excluded from the offline build | An egress call appears outside the two allowed modules |
| `T-P3-c` | Integration: the offline build is loaded in a browser with a proxy that fails all requests, a workspace is created, a config is pasted, findings run and config is emitted. Zero requests observed | Anything phones home |
| `T-P3-d` | Asset test: no asset in the bundle references an external origin — no `@import url(http`, no `<link>` to a remote host, no remote `src` | A CDN reference sneaks in |
| `T-P4-a` | Protocol test: the sync service's request handler is asserted to reject any payload field that is not ciphertext or documented metadata, against a schema | A plaintext field is added |
| `T-P4-b` | The metadata leakage budget in `33` is asserted as a test, not a paragraph: the server-visible field set is compared against an approved list | A new field leaks structure |
| `T-INV` | PR template: any diff touching `crypto/`, `sync/`, the CSP, or the dependency manifest requires an explicit statement naming which invariant was considered, and CI refuses the merge without it | Somebody changes a boundary without noticing |

`T-P3-c` is the important one and it is the one that will be tempting to skip because it needs a
browser and a proxy. It is the only test that checks the property the way a user checks it, and
`36` cites it as the answer to the enterprise question "how do we know."

---

## 4. The product non-goals

Each entry uses the seven fields from §1. They are shorter than §3 because the boundaries are
less contested — but the refused-adjacent column is where each one earns its place.

### 4.1 `N-R-1` — not a monitoring tool

| Field | |
|---|---|
| **What it would look like** | Poll devices, chart interface counters, alert on a tunnel going down, show a status dashboard, keep history |
| **Why refused** | It requires `N-P-1` and `N-P-3`, it requires a server that runs continuously, and it is the most crowded, most mature category in networking. The three pillars do not include "observe" |
| **The adjacent thing we DO build** | Everything about monitoring *as configuration and as knowledge*. Emitting `set security ipsec vpn VPN-B vpn-monitor source-interface reth1.0 destination-ip 10.2.0.1` and `set security ipsec vpn-monitor-options interval 10 threshold 5`; explaining that vpn-monitor pings through the tunnel and tears the SA down on failure, taking st0 with it, which is what lets a route or adjacency over st0 fail over — and that without it a route out st0 stays "good" while traffic blackholes; explaining that DPD's time-to-declare-dead is `interval × threshold`, that the Junos default of 10 × 5 is 50 seconds of blackhole before failover even starts, and that 10 × 3 is a reasonable middle. A finding when `vpn-monitor` is absent on a tunnel carrying a routing adjacency |
| **The adjacent thing we REFUSE** | "A small status panel showing whether the tunnels in this workspace are currently up." One reachability check. It is a device connection, and the panel would be the most-looked-at surface in the product, which means the whole product would drift toward serving it |
| **Also refused** | Importing a monitoring system's alert feed to correlate against the graph. It is egress plus a credential, and it makes the workspace stale-dependent on a live system |
| **Use instead** | The vendor's own tooling; LibreNMS, Zabbix, Prometheus with an exporter; Forward Networks or an assurance platform if the budget exists (`02` §4) |
| **The test** | `T-P1-a`, `T-P3-b`. Plus a review rule: no UI component may have a refresh interval bound to anything outside the workspace |
| **Reopens if** | Never as monitoring. A `provenance` age display — "this node was parsed from a config on 2026-05-12" — is in scope and is *not* monitoring, and brief §6.5 already requires it |

**The distinction that makes this testable:** Fathom knows what *should* be true because the graph
says so. Monitoring knows what *is* true because it asked. Every proposal is decided by which of
those two it needs.

### 4.2 `N-R-2` — not a source of truth of record

| Field | |
|---|---|
| **What it would look like** | The authoritative inventory for an organisation, integrated with IPAM, DCIM, procurement, cabling and change management |
| **Why refused** | Brief §6.5 draws it: scope the diagram as a design tool, not a source of truth, because claiming it records what exists invites documentation rot. The category is well served (`02` §5) and the on-ramp problem that kills manual source-of-truth entry would kill Fathom's too |
| **The adjacent thing we DO build** | An inventory that is the same schema as the intent model (brief §6.4) — a partially populated graph the engines run against the moment it exists. Nodes parsed from real configs are marked as such and show their age. Facts that argue back: add a second SRX and the tool observes a cluster candidate and what RG0 and RG1 would need |
| **The adjacent thing we REFUSE** | "A workspace flag marking it authoritative, with a scheduled reconciliation against devices." Reconciliation needs `N-P-1`, and the flag makes a claim the tool cannot keep |
| **Also refused** | Becoming the write target for other systems. Fathom reads NetBox; NetBox does not read Fathom as its master |
| **Use instead** | NetBox, Nautobot, Infrahub. Import from them (§9.1) |
| **The test** | Review rule: no field in the workspace format asserts currency or authority; provenance records *how and when* a value arrived, never *that it is correct now* |
| **Reopens if** | Never. This is the refusal that keeps the product honest about §2.2 of the brief |

### 4.3 `N-R-3` — not a ticketing system

| Field | |
|---|---|
| **What it would look like** | Tickets, assignees, statuses, approvals, SLAs, notifications, an audit trail of who approved what |
| **Why refused** | It is a workflow product, it needs multi-user state and identity, and identity needs a server that knows things — which fights `N-P-4`. Every organisation already has one and none of them wants a second |
| **The adjacent thing we DO build** | The *contents* of a ticket. Brief §6.7: the tool knows what it just built, so it emits the verification ladder and the rollback for that specific change, paste-ready into a change record. Suppressions are first-class, carry a reason, and are stored in the workspace so a reviewer can see what was waived and why (brief §6.6) |
| **The adjacent thing we REFUSE** | "Push the change record into Jira/ServiceNow when the user clicks Submit." Egress, a credential, and the moment Fathom writes into a workflow system it owns a workflow |
| **Also refused** | Approval state inside the workspace — "this change is approved by X". That is an assertion about a human process the tool cannot verify, stored somewhere it can be edited |
| **Use instead** | Whatever the organisation already runs. Copy the emitted block into it |
| **The test** | Review rule: no workspace field represents a human's approval or a process state. Suppressions record a *reason*, authored by whoever holds the workspace, and claim nothing about authority |
| **Reopens if** | Never |

### 4.4 `N-R-4` — not an orchestrator

| Field | |
|---|---|
| **What it would look like** | Ordered multi-device rollouts, dependency graphs of changes, staged deployment, automatic rollback on failure, drift remediation |
| **Why refused** | It is `N-P-1` restated at a larger scale, and it is the category NSO and Apstra occupy properly (`02` §7) |
| **The adjacent thing we DO build** | Ordering as *content*. `order_hint` on every emitted line (brief §5.3) so config comes out in an order that works. The five plumbing pieces in the right sequence, with the note that missing #3 times out Phase 1 with nothing useful in the log while missing #1, #2, #4 or #5 leaves the tunnel reading UP and passing zero packets. A per-change rollback block. `commit confirmed 5` as the first line of every change, always, remotely |
| **The adjacent thing we REFUSE** | "A multi-device change plan with a Deploy button." The plan is in scope and is genuinely useful; the button is `N-P-1` |
| **Also refused** | Modelling deployment state — "device A has this change applied, device B does not." That is a fact about the world, which is `N-R-2` |
| **Use instead** | NSO, Apstra, Ansible with a runner, or the change process the organisation already has |
| **The test** | `T-P1-c`. Plus: emitted output is text with an order, never a plan object with an execution status |
| **Reopens if** | Never |

### 4.5 `N-R-5` — not a discovery tool

| Field | |
|---|---|
| **What it would look like** | SNMP or LLDP sweep, CDP neighbours, subnet scanning, topology inferred from a live network |
| **Why refused** | `N-P-1`, `N-P-2` and `N-P-3` simultaneously. It is also the most mature category in the survey (brief §3.4) |
| **The adjacent thing we DO build** | Discovery *from text*. Config paste is the primary on-ramp (brief §6.3): `show configuration \| display set` in, populated graph out, diagram drawn, findings listed. Multiple devices pasted, and inferred adjacency where two configs reference each other — a gateway whose `address` matches another device's `external-interface` address is a tunnel edge, and that inference is a fact about two texts, not about a network |
| **The adjacent thing we REFUSE** | "Paste the output of `show lldp neighbors` and we will build the topology." This one is *in scope*, and stating that is the point: it is text the user gathered, not a network the tool probed. The refused version is Fathom gathering it |
| **Also refused** | Reading a `.pcap` to infer topology (§4.9) |
| **Use instead** | Netdot, OpenWISP Network Topology, an assurance platform, or the vendor's own tooling |
| **The test** | `T-P1-a`, `T-P3-b` |
| **Reopens if** | Never. The input side is already open: any text the user can paste is fair game |

### 4.6 `N-R-6` — not a lab or simulator

| Field | |
|---|---|
| **What it would look like** | Spin up virtual devices, converge a control plane, let the user break things and watch |
| **Why refused** | It needs container or VM orchestration, vendor images with licensing, and gigabytes of resources — none of which fits a single offline file in a browser. And it is done well already: containerlab is a single binary needing only Docker, wiring containerised NOS images from Nokia, Cisco, Juniper, Arista, SONiC, Cumulus, VyOS and FRR into topologies |
| **The adjacent thing we DO build** | Counterfactuals as *content*, at Teaching depth (brief §5.4): what happens if PFS is set on one side only, what the log says, what to look at. That is the pedagogical value of a lab without the lab |
| **The adjacent thing we REFUSE** | "A tiny IKE state machine so users can watch Phase 1 negotiate." Genuinely appealing, genuinely refused: a simulator that is 95% accurate teaches the 5% wrong, and the 5% is where the failures live. `design-language.md`'s "verify against your own box before acting" is the card's own governing rule and it applies to the tool |
| **Also refused** | Routing-table computation. Batfish does this properly and Fathom does not do it at all (`02` §4.1) |
| **Use instead** | containerlab, netlab, GNS3, EVE-NG, Packet Tracer, or a spare SRX |
| **The test** | Review rule: no code computes a protocol outcome that the tool then presents as what a device would do. Rules assert *configuration* properties, never simulated results |
| **Reopens if** | Never as a simulator. A deterministic *config* consistency check across two devices — do these two proposals actually match, every value, exactly — is in scope and is not simulation (§9.5) |

### 4.7 `N-R-7` — not a certification trainer

| Field | |
|---|---|
| **What it would look like** | A curriculum, modules, quizzes, progress tracking, exam-objective mapping, a certificate |
| **Why refused** | Teaching is a pillar; *training* is a product. A curriculum imposes an order, and Fathom's teaching is indexed by the thing in front of you, not by a syllabus. Progress tracking is also user state that wants a server |
| **The adjacent thing we DO build** | Three depths — Terse, Explained, Teaching — toggled globally and per block (brief §5.4). Same corpus, three densities. A senior engineer and a new hire read the same entry at different weights |
| **The adjacent thing we REFUSE** | "A guided learning path through the corpus, with a checklist of what you have read." The checklist is progress tracking, and progress tracking turns a reference into a course with a completion metric — which changes what content gets written |
| **Also refused** | Quizzes, badges, streaks, any gamification. `design-language.md`: no progress bars, no avatars, no empty states |
| **Use instead** | JNCIA/JNCIS, CCNA/CCNP, PCNSE tracks; video courses; ipSpace; a lab |
| **The test** | Review rule: no corpus entry may declare a prerequisite ordering, and no UI surface may record what a user has read |
| **Reopens if** | Never in-product. A separately published, corpus-derived study guide is a `74` §12.2-compliant downstream use and somebody else is welcome to build it |

### 4.8 `N-R-8` — not a chatbot

| Field | |
|---|---|
| **What it would look like** | A conversational box as the primary interface. Ask anything, get an answer |
| **Why refused** | Four reasons, in weight order. **(1)** Determinism: invariant 9 requires byte-identical output for the same inputs, and a chat surface is a promise of the opposite. **(2)** The interface would become the product, and every other view would degrade into something the chat describes. **(3)** It is the interface every competitor in `02` §9 already has and is better at. **(4)** `design-language.md` is a printed-reference aesthetic; a chat window is the single most opposed interaction to it |
| **The adjacent thing we DO build** | The command finder: `Ctrl+K` from anywhere, deterministic, fuzzy matching plus a synonym map, no model at runtime, works offline, identical every run, diffable between releases (brief §6.1). It answers the same questions a chatbot would, and it answers them the same way twice |
| **And** | A supervisor and subagents behind a labelled boundary, off by default, with a configured egress origin, and everything they produce marked as non-deterministic in the UI. `21` specifies it. That is an assistant with a fence around it, not a chat interface |
| **The adjacent thing we REFUSE** | "A chat box in the corner that can also edit the graph." Two failures at once: a non-deterministic path into the deterministic artifact, and a surface whose gravity pulls the product toward it |
| **Also refused** | Natural-language input as the *only* way to reach a feature. Every AI-layer capability must have a deterministic equivalent reachable without it, or the offline build loses the feature (`24`) |
| **Use instead** | A general assistant, with the confidentiality caveat in `02` §9.3 |
| **The test** | `24`'s offline-parity test: every feature reachable with the AI layer disabled. Plus: no AI-layer output writes to the graph without an explicit user action that is itself recorded as provenance |
| **Reopens if** | Never as the primary interface |

### 4.9 `N-R-9` — not a packet analyser

| Field | |
|---|---|
| **What it would look like** | Load a `.pcap`, decode IKE, show the exchange, diff the proposals both sides offered |
| **Why refused** | It is a large, exacting subsystem with its own parsing threat surface, and Wireshark exists and is superb. The temptation is high because IKE capture analysis is *exactly* the diagnostic step the field card's error decoder points at |
| **The adjacent thing we DO build** | Teaching the user what to look for and when. That NAT-T shows as remote port 4500 in `show security ike security-associations detail`. That under IKEv2 the first child SA is always keyed from the IKE SA regardless, so a capture of the initial bring-up showing no DH is not a misconfiguration. That the lifetime countdown can be used to time a capture around the rekey event |
| **The adjacent thing we REFUSE** | "Just the IKE handshake, just the proposal payloads, since that is where mismatches live." A binary parser reading attacker-influenced input inside the same origin as the workspace. `23` would have to grow a whole section for it |
| **Use instead** | Wireshark, `tcpdump`, or the box's own traceoptions — with the card's warning that traceoptions left on will fill `/var`, which breaks logging and commits both, so `delete security ike traceoptions` and commit, always |
| **The test** | `T-P1-a`-style dependency denylist extended to packet-parsing crates |
| **Reopens if** | Pasted *text* output of a decoder — the human-readable form — is in scope as a parseable input, and that covers most of the value at none of the cost |

### 4.10 `N-R-10` — not a config backup or archive

| Field | |
|---|---|
| **What it would look like** | Scheduled config collection, versioned history per device, restore |
| **Why refused** | Collection is `N-P-1`. Long-horizon storage of every device's full config makes the workspace an archive of the estate's most sensitive material, which raises the impact of an endpoint compromise well past what `31` assumes |
| **The adjacent thing we DO build** | The workspace is git-versionable and diffable by construction (brief §6.4), so history exists at the granularity the user chooses. Parsed-node provenance records the source config's date |
| **The adjacent thing we REFUSE** | "Keep the original pasted config text in the workspace so we can re-parse it later." Reasonable, and refused: it converts the workspace from a graph into a config archive, multiplies its plaintext-equivalent value, and undermines the redaction in `T-P2-c` by keeping the pre-redaction text |
| **Use instead** | Oxidized, RANCID, Nautobot's config-backup app, or the vendor's own |
| **The test** | Workspace format review: no field stores raw device configuration text beyond the current parse session |
| **Reopens if** | A user-initiated, explicitly-labelled attachment is a §10 amendment, not a default |

### 4.11 `N-R-11` — not a compliance attestation product

| Field | |
|---|---|
| **What it would look like** | "PCI DSS compliant," "CIS benchmark passed," a report an auditor accepts |
| **Why refused** | The project cannot stand behind a compliance claim about somebody else's estate, and `72` §6 already identifies correctness liability as a standing risk. Attestation converts a helpful finding into a warranty |
| **The adjacent thing we DO build** | Findings with severity, `acceptable_when`, remediation and sources; suppressions with recorded reasons a reviewer can inspect. A user may map those to a framework themselves, and a rule pack may carry framework references in `sources` |
| **The adjacent thing we REFUSE** | "A compliance score, or a pass/fail badge per framework." A score is an attestation with the caveats compressed out of it |
| **Also refused** | Any UI element that renders a percentage of rules passed. It creates an incentive to suppress rather than fix, which is the exact failure `acceptable_when` exists to prevent |
| **Use instead** | An auditor. A GRC platform. The vendor's own hardening guide |
| **The test** | Review rule: no aggregate finding metric is rendered as a score, grade or badge. Counts by severity are fine; a ratio presented as a result is not |
| **Reopens if** | Never as attestation |

### 4.12 `N-R-12` — not a write-once-deploy-anywhere abstraction

| Field | |
|---|---|
| **What it would look like** | Describe a security policy once, emit it for Junos, PAN-OS and IOS-XE, and expect the three to behave identically |
| **Why refused** | `11` §12.2 already concludes cross-vendor emit of a security policy is not a supported operation and probably never will be. `72` §3.2.3 proposes the narrower claim: the graph is neutral enough that `explain`, `lint` and `render` work across platforms even where `emit` does not |
| **The adjacent thing we DO build** | Cross-vendor *understanding*. The Rosetta mapping in the command finder — `show security ipsec security-associations` ↔ `show vpn ipsec-sa` ↔ `show crypto ipsec sa`. Explanations that hold across platforms because the protocol does. Findings that fire on any platform whose `platforms` predicate matches |
| **The adjacent thing we REFUSE** | "One click to retarget this workspace's config to another vendor." It produces plausible, wrong output, and plausible-and-wrong is the worst possible failure for a tool whose claim is that you can trust what it emits |
| **Use instead** | NSO, if you have it and can write the service models (`02` §7.2) |
| **The test** | Emitter tests: an emitter refuses to emit for a platform where the graph carries a field with no faithful representation, and says which field, rather than approximating |
| **Reopens if** | Per-domain, never wholesale. Some domains — interface addressing, static routes — do map cleanly and `13` may support them explicitly |

### 4.13 `N-D-1` and `N-D-2` — the two deferred boundaries

| ID | Boundary | Not now, because | Would reopen when |
|---|---|---|---|
| `N-D-1` | Multi-tenant hosted service | It requires identity, RBAC and tenant isolation on the server, and every one of those wants to know something about the data. `43` covers single-node and clustered self-hosting, which is a different thing | Somebody funds it *and* the design survives review against `N-P-4` with no exception. Until then the answer is "self-host it" |
| `N-D-2` | Fleet-scale workspaces — several thousand devices | Brief §6.4 states the trade: inventory as a document loses fleet-scale querying and native multi-writer concurrency. For team-sized deployments that is a good trade | The CRDT work in the brief's §7.6 becomes load-bearing, which is a phase-7 question (`71`), not a phase-1 one |

Both are `N-D` rather than `N-R` because they are scale problems, not principle problems. Neither
requires breaking an invariant. That is the whole distinction between the classes and it should
be applied strictly: **if a proposal needs an invariant relaxed, it is `N-P` or `N-R`; if it needs
engineering, it is `N-D`.**

---

## 5. The decidable scope rule

*margin tab: why it exists*

§4 is a list, and lists are incomplete by construction. This is the rule that decides the cases
the list does not cover.

### 5.1 The rule

> **A feature is in scope if and only if it is a pure projection of the workspace and the corpus,
> and it requires no capability the application does not already have.**

Formally, for a proposed feature `F`:

```
in_scope(F)  ⟺   ∃ f.  F = f(graph, corpus, user_input)
                 ∧  capabilities(F) ⊆ { read_workspace,
                                        read_corpus,
                                        read_user_text,
                                        write_workspace,
                                        write_clipboard,
                                        write_screen }
                 ∧  deterministic(f)  ∨  behind_ai_boundary(F)
```

Three clauses, and each one kills a different class of proposal:

| Clause | Kills |
|---|---|
| **Projection** — it is a function of what we already have | Monitoring (needs the live network), discovery (same), backup (needs history we do not keep) |
| **Capability closure** — it needs no new I/O verb | Everything in §3. There is no `open_socket`, no `read_credential`, no `execute_on_device` in the set, and adding one is a §10.3 decision, not a feature |
| **Determinism** — or explicitly fenced | Chat as a primary surface, and any generative path that writes to the graph unlabelled |

### 5.2 Applying it to the register

| Non-goal | Which clause it fails |
|---|---|
| Monitoring | Projection, capability |
| Source of truth of record | Projection — "is currently true" is not a function of the workspace |
| Ticketing | Capability (egress), projection (approval is a fact about people) |
| Orchestrator | Capability |
| Discovery | Projection, capability |
| Lab / simulator | Projection — a simulated outcome is not a projection of the graph, it is a computation about a hypothetical device |
| Certification trainer | Projection — progress is state about a person, not about the graph |
| Chatbot | Determinism |
| Packet analyser | Projection — a capture is not in the workspace |
| Backup / archive | Projection |
| Compliance attestation | Determinism, in a subtler sense: an attestation asserts something about the world that the graph cannot support |
| Write-once-deploy-anywhere | Projection — the emit is not faithful, so `f` is not total over the input |

**Every one of the twelve refusals falls out of the rule.** That is the evidence the rule is the
right one, and it means a future proposal can be decided in a review comment rather than a
meeting.

### 5.3 The rule's honest weakness

`user_input` is doing a lot of work, and it is the crack the rule will be widened through.
"Paste the output of `show lldp neighbors`" is user input and is in scope (§4.5). "Paste the
output of a monitoring API" is also user input, and is technically in scope by the letter of the
rule while plainly violating §4.1's spirit.

**The patch:** `user_input` is *text the user chose to give us*, and the test is whether Fathom
could plausibly have obtained it itself. If a feature's value depends on the input being fresh,
it is monitoring wearing a paste button. `T-freshness`: a review question, not a CI test — *does
this feature get worse if the input is a week old?* If yes, it is `N-R-1`.

---

## 6. Domain and platform scope

Scope is not only about categories. It is about how much of networking this tool claims.

### 6.1 Platforms

| Tier | Platforms | Commitment |
|---|---|---|
| **Primary** | `junos-srx` | Full: parser, emitters, rules, command corpus, explainers at all three depths |
| **Second** | Decided at phase 7 (`71` §10) | The schema bet is settled or falsified here |
| **Command corpus only** | Others may appear in the Rosetta mapping without a parser or emitter | A `rosetta` entry is a fact about two command strings and costs one line |
| **Never** | Anything the project cannot get a named expert reviewer for (`74` §9.4) | The named-expert rule is the binding constraint, not engineering effort |

**The refusal that matters:** a platform is not "supported" because a parser exists. It is
supported when there is a reviewer who has run it. `74` §9.4's `community` tier is where
unreviewed platform content lives — unsigned, off by default, never in the offline build.

### 6.2 Domains

| Domain | In | Note |
|---|---|---|
| IPsec site-to-site | Phase 1 | The field card's subject, and the deepest available source material |
| Zones, policies, host-inbound | Phase 1 | Inseparable from the above — the card's five plumbing pieces are half zone and policy work |
| Interfaces, addressing, `reth`/LAG, static routes | Phase 1 | Required to make the above emit anything |
| MTU, MSS clamping, fragmentation | Phase 1 | The card's side 4. High value, low modelling cost |
| Dynamic routing protocols | Deferred | Large, and the value without simulation is limited |
| NAT | Deferred, and needed sooner than it looks | The card's own "things that bite" names source NAT eating tunnel traffic — the interface NAT rule for internet-bound traffic also grabs packets routed at st0, and the far end sees the wrong source and rejects the selector. A tunnel product that cannot see that is missing a top-five failure |
| Remote-access VPN, SSL VPN | Not planned | Different problem, different audience |
| Wireless, QoS, MPLS, EVPN, SD-WAN | Not planned | Each is a product |

**DECISION — NAT is promoted out of "deferred" for the specific case of no-NAT rules interacting
with tunnel traffic.** Not general NAT modelling; one failure mode, one rule, one explainer,
because the card identifies it as one of the six things that bite and a tunnel walkthrough that
omits it produces configuration that fails in a way the user cannot diagnose.

---

## 7. Where the pressure will come from

Every refusal above will be argued against, and the arguments are predictable. Naming them now
means the answer is a link rather than a debate.

| Source | The request | The standard answer |
|---|---|---|
| A new user, week one | "Can it just check if my tunnel is up?" | §4.1. Point at the verify ladder it emits, which is the useful half |
| An enterprise evaluator | "Does it integrate with our CMDB / ticketing / SSO?" | §4.2, §4.3, §8. Import yes, write no |
| An enterprise security team | "We need key escrow for recoverability" | §3.4 refused adjacent 1. This is the one that loses deals and there is no softer answer |
| A contributor | "I added an optional SSH module behind a feature flag" | §3.1 refused adjacent 5. Closed with thanks and a link |
| A contributor | "I added a version check so users know about advisories" | §3.3 refused adjacent 2. The most sympathetic proposal in the document |
| The AI layer's own gravity | "The supervisor could just fetch the current config to ground its answer" | §3.1, §3.3, and `21` §7. The supervisor operates on the graph, never on a device |
| The owner, on a Tuesday | "This would be so easy to add" | §10. Easy is not the criterion; the capability set is |
| A funder | "We need a hosted multi-tenant version to sell" | `N-D-1`, and §8 |

The AI-layer row deserves emphasis because it is the one with a built-in advocate. An agent
architecture creates continuous pressure toward giving the subagent more capabilities, and each
individual grant is defensible. `21` §§7–9 fences it; this document is why the fence exists.

---

## 8. The refusals that cost money

*margin tab: approx*

Honest accounting. These are the deals not done.

| Refusal | Revenue or adoption forgone |
|---|---|
| `N-P-4`, no escrow | Any enterprise whose data policy requires recoverable encryption. In regulated sectors this is common and it is a hard no from their side, not a negotiation |
| `N-P-1`, no device contact | The entire "and it deploys it for you" market, which is where the budget is. NSO and Apstra live there (`02` §7) |
| `N-P-3`, no telemetry | No usage data, ever. Every product decision is made without knowing what people use, which is a real and permanent handicap |
| `N-R-2`, not a source of truth | The system-of-record budget line, which is bigger than the tooling line |
| `N-R-11`, no compliance attestation | Compliance budgets are the easiest security budgets to access, and this refuses all of them |
| `N-D-1`, no multi-tenant SaaS | The only business model in this space with predictable revenue |
| `74` §5, Apache-2.0 | A competitor may host a closed fork with no reciprocity |
| No support, SLA or indemnity (`36`) | Blocks enterprise procurement outright, independently of everything above |

**The sum of this table is that Fathom has no obvious business model.** That is not hidden here
and it should not be hidden anywhere. What it has is a user — the engineer on a locked-down
laptop in an air-gapped, defence, OT or regulated environment whom brief §2.4 identifies as
structurally unservable by SaaS competitors — and a set of refusals that are the only reason that
user can run it at all. Every refusal above is also the reason for the one advantage.

---

## 9. Things that look like non-goals and are in scope

The inverse list, because an over-applied non-goals document is as expensive as an absent one.
Each of these has been or will be challenged as out of scope, and each is in.

### 9.1 Importing from a source of truth

Reading a NetBox or Nautobot export into the graph is in scope. It is text the user exported, it
is a pure projection into the graph, and it needs no new capability. §4.2 refuses being the
system of record, not reading one. `T-freshness` passes: an export from last week is still useful.

### 9.2 Emitting a change-ticket body

In scope, and it is brief §6.7. `verify(diff(graph))` rendered as text the user pastes. §4.3
refuses running a workflow, not producing its contents.

### 9.3 Emitting Ansible, Terraform or a Python script — as text

In scope. An emitter's output is `(line, provenance)` pairs and it does not matter whether the
lines are Junos `set` commands or YAML tasks. What is refused is a Run button (§3.1 refused
adjacent 3). This is worth stating clearly because it looks like a violation and is not: **the
target syntax is irrelevant to the invariant; the presence of an executor is the invariant.**

### 9.4 Reading pasted operational output

`show security ipsec security-associations`, `show security ipsec inactive-tunnels` with its
Tunnel Down Reason, `show log kmd` excerpts, `show system commit` — all in scope as pasted text.
The reverse-explanation feature (brief §6.3) points at exactly this, and the card's error decoder
is the corpus that makes it useful: `NO_PROPOSAL_CHOSEN (P1)` sends you to dh-group, encryption,
hash and authentication-method, and the same code from the responder rather than from you tells
you whose config to open.

This is *not* §4.1 monitoring because the input is a snapshot the user chose to give us and its
value does not depend on freshness — the whole point of correlating a flap against `show system
commit` is that the commit happened in the past.

### 9.5 Cross-device consistency checks

Comparing two devices' configurations in the same workspace and reporting that the proposals do
not match is in scope and is not simulation (§4.6). It is a pure predicate over two subgraphs.
The card's governing rule for side 2 — **both ends must agree, every value, exactly** — is
precisely a rule that can be evaluated over the graph, and it catches the largest single class of
tunnel failure without computing anything about a running device.

### 9.6 Age and staleness display

Showing that a node was parsed from a config on a given date, and that the date is six months
old, is in scope. Brief §6.5 requires it. It is provenance, not monitoring: it states when we
learned something, never whether it is still true.

---

## 10. How a non-goal is retired

### 10.1 For `N-R` and `N-D`

| Step | |
|---|---|
| 1 | An issue titled with the boundary's ID, stating the refused-adjacent text and arguing why the boundary is wrong — not why the feature is useful. Usefulness is assumed |
| 2 | The proposal states which clause of §5.1 it satisfies, or asks for the clause to change |
| 3 | Two maintainers agree, and a record lands in `90-decisions/` |
| 4 | This document is amended in the same PR as the first line of implementation, never later |
| 5 | The register in §2 records the retirement date and the decision record's ID. **Retired boundaries are struck through, not deleted** — the history of what a project refused is the most useful part of a non-goals document to a reader two years later |

### 10.2 For `N-P`

Not by this process. An `N-P` boundary is one of the four hard invariants, and `74` §13.3 places
it outside what any governance body may authorise.

### 10.3 The only route

Changing an `N-P` boundary means shipping a different product. The route, stated so that it
exists and so that its cost is visible:

| Step | |
|---|---|
| 1 | A decision record arguing the change, with the threat-model delta explicit (`31`) |
| 2 | A new name (`74` §12), because users who trusted the old guarantee must not be silently moved onto a new one |
| 3 | A migration path that lets a user keep the old artifact working — which they can, because the offline build has no egress and nothing can be switched off remotely (`74` §11.4) |
| 4 | The old artifact remains published, with its hashes, indefinitely |

**Step 2 is the real cost and it is deliberate.** A rename discards the accumulated trust, which
is exactly the price that should be paid for discarding the property that earned it.

---

## 11. What this document costs

| Cost | |
|---|---|
| **Features users genuinely want, refused** | The status panel (§4.1), the version check (§3.3), escrow (§3.4). Each will be asked for repeatedly and each answer is no |
| **A smaller product than the competition** | §13 of `02` lists eleven categories where Fathom is worse. This document makes most of those permanent |
| **No business model** | §8 |
| **Test maintenance** | §3.5 is fourteen tests that must keep working, including one that needs a browser and a proxy. They will break for uninteresting reasons and somebody must keep fixing them |
| **Argument overhead** | Every refusal is a conversation. A well-argued proposal from a good contributor, declined, sometimes costs the contributor |
| **The risk of being wrong** | If `N-R-1` or `N-D-1` turns out to be the thing that would have made the product viable, this document is why it was not built. That is the honest failure mode of a scope document and it is not hypothetical |

The last row is why §10 exists and why retired boundaries are struck through rather than deleted.
**A non-goals document that cannot be wrong is not a decision; it is dogma.**

---

## 12. Decisions this document asks for

| # | Question | Recommendation | Consequence if deferred |
|---|---|---|---|
| D1 | Are `N-P-1` … `N-P-4` genuinely permanent, requiring a rename to change (§10.3)? | Yes | The invariants become defaults, and defaults erode one reasonable exception at a time |
| D2 | Do the fourteen tests in §3.5 ship in phase 0, before there is much to test? | Yes | A test written after the first violation is a test written to accommodate it |
| D3 | Is §5.1's capability set closed, with additions requiring a decision record? | Yes | Without closure the rule is advisory |
| D4 | Is NAT's tunnel-interaction case promoted into phase 1 (§6.2)? | Yes | A tunnel walkthrough that omits it emits config that fails in a way the user cannot diagnose |
| D5 | Is `T-P2-c` — parse-time redaction of secrets from pasted configs — a phase-1 requirement? | Yes | The first pasted production config puts a real PSK in a workspace, and it will be a real one |
| D6 | Does the corpus carry entries for the tools we point users at in "use instead"? | Yes, minimally | A refusal without an alternative reads as an excuse, and the alternatives are the most credible thing the project can say |
| D7 | Is `N-D-1` reviewed at a fixed date rather than on demand? | Annually, with `02` §15.1's re-verification | Deferred boundaries with no review date become permanent by neglect rather than by decision |

---

## 13. Sources consulted

| Claim | Source |
|---|---|
| The four hard invariants, the `Risk` enum, terminology, determinism (invariant 9) | `.context/conventions.md` |
| Copy-paste output; never accept credentials; inventory and intent as one schema; inventory as a document; the diagram as a design tool not a source of truth; verification and rollback generation; the command finder's determinism and `Ctrl+K`; the three explainer depths; `order_hint` and `(line, provenance)` | `.context/owner-brief.md` §§5.3, 5.4, 6.1–6.7 |
| No progress bars, no avatars, no empty states, no gamification; "verify against your own box before acting" | `.context/design-language.md` |
| The bring-up order and its "stop at the first failure" rule; the five plumbing pieces and what each omission looks like; `vpn-monitor` semantics and what it buys; DPD `interval × threshold` and the 10 × 5 default; NAT-T on port 4500 in SA detail; the IKEv2 first-child-SA caveat; the error decoder; source NAT eating tunnel traffic; traceoptions filling `/var`; "both ends must agree — every value, exactly"; `show system commit` and "correlate before you theorise" | `.context/field-card-srx-ipsec.txt`, sides 1–4 |
| containerlab is a single binary requiring Docker and supports NOS images across Nokia, Cisco, Juniper, Arista, SONiC, Cumulus, VyOS and FRR | [containerlab.dev](https://containerlab.dev/) |
| The alternatives named in every "use instead" row, and what each does and does not do | `docs/00-vision/02-prior-art-and-positioning.md` §§4–10 |
| Cross-vendor emit of a security policy is not a supported operation; the narrower schema claim | `docs/10-core/11-ir-schema.md` §12.2; `docs/70-ops/72-risks.md` §3.2.3 |
| The AI boundary, offline parity, and the egress statement | `docs/20-ai/21-ai-layer-architecture.md` §§5, 7–9; `docs/20-ai/24-ai-determinism-and-offline.md` |
| Correctness liability; the content problem as the binding constraint | `docs/70-ops/72-risks.md` §§4, 6 |
| Deployment modes and what each artifact is | `docs/40-stack/43-deployment-modes.md` |
| Where the tests live, and what "proved" means | `docs/40-stack/45-testing-strategy.md` |
| The named-expert rule, the `community` tier, what no governance body may authorise, and the continuity answer | `docs/70-ops/74-governance-and-licensing.md` §§9.4, 11.4, 13.3 |
| Support, SLA and indemnity as procurement blockers | `docs/30-security/36-enterprise-review-qa.md` |

---

## 14. Disagreements

**1. No hard invariant, terminology entry, or the risk enum is disputed.** The `Risk` enum appears
in §3.1 only, describing the labelling of emitted verification steps, with the three values as
pinned.

**2. A proposed addition to the conventions, not a deviation.** §5.1 defines a closed capability
set — `read_workspace`, `read_corpus`, `read_user_text`, `write_workspace`, `write_clipboard`,
`write_screen` — and makes any addition a decision record. `.context/conventions.md` states the
four invariants as prohibitions; this states the same boundary as a positive enumeration, which
is the form a reviewer can actually check a diff against. If it is accepted, it belongs in the
conventions and this section should become a citation.

**3. A proposed sharpening of brief §6.5, offered for the owner's judgement.** The brief scopes
the diagram as a design tool rather than a source of truth. §4.2 generalises that from the
diagram to the whole workspace and makes it a permanent refusal with a testable consequence: no
field in the workspace format may assert currency or authority, only provenance. That is a
constraint on `17`'s format that the brief does not state.

**4. A proposed promotion in the roadmap's domain order, §6.2 D4.** `71` sequences NAT as a later
domain. This document argues that one NAT case — the interface source-NAT rule capturing traffic
routed at st0 — belongs in phase 1, because the field card lists it among six failures that bite
and because a tunnel walkthrough that omits it produces config which fails silently at the far
end. This is a scope *addition*, which is unusual in a non-goals document, and it is recorded
here rather than assumed because it contradicts a sequencing decision already made in `71`.

**5. A disagreement with a common practice, not with a convention.** It is normal to write
non-goals as a short rhetorical list. This document is long, has fourteen tests, and spends most
of its length on the refused-adjacent column. The justification is §1: a boundary without a
testable adjacent case is not a boundary. If the length is judged excessive, the section to cut
is §4's prose, never §3.5's tests.
