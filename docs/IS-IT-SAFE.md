# Is it safe to point Fathom at my network?

This page answers the questions a careful network engineer asks before running someone else's tool
near their gear. Each answer names the file or decision that holds it, so you can check it rather than
take our word for it. If something here and the code disagree, the code is right and this page is a
bug: please open an issue.

Written 2026-11-14 against `main` at 5d622c1.

---

## The short version

- **Fathom can read a device with a read-only login you chose; it never changes one.** No SNMP
  SetRequest exists in the code, and SSH commands come from a fixed list. (ADR-0082)
- **It reaches nothing outside your own stack until you turn it on.** Device reading is off twice by default, and every
  outbound connection listed below stays off until the operator sets it.
- **It never sweeps a network.** It reads only the management addresses of devices you drew, inside
  ranges a Steward listed.
- **A pasted config's credentials never reach the server.** They are destroyed in your browser first,
  and the server refuses any that still arrive. (CLAUDE.md rule 4, ADR-0052)
- **The source is public** under Apache-2.0 (the corpus under CC BY-SA 4.0), and every published
  image has a signed record of the commit that built it. How to check one is at the end.

---

## What Fathom reads from a device

Device reading is **off unless the operator sets `FATHOM_DEVICE_READ=on`** and runs the separate
`reader` container, and **then off until a Steward turns it on** for their organisation
(`docs/OPERATING.md`, "Device reading"; ADR-0082 §4.4).

When it is on:

| | |
|---|---|
| **Who starts a read** | A person with Draw access presses Read on one device. Nothing reads on a schedule yet; a schedule would get its own sign-off first (ADR-0082 §4.6). |
| **Where it may connect** | Only a device's management address, and only inside a range a Steward listed. Loopback, link-local, multicast, reserved and the server's own addresses are refused whatever is listed. |
| **Protocol** | **SNMPv3, authPriv only.** HMAC-SHA-256/512 with AES-128 preferred; HMAC-SHA-96 accepted and marked older; MD5, DES, noAuth and noPriv refused. **SNMP v1 and v2c are never offered** (RFC 3410 §8.2 calls their community strings plain text). SSH reading from a fixed command list is the next part; it is not built yet. |
| **What it asks for** | Fixed lists only: system, entity inventory (model, serial, firmware), interfaces, LLDP neighbours, MAC and ARP tables. No full walk, because some tables describe credentials. |
| **What it can send** | GetRequest, GetNextRequest and GetBulkRequest. The encoder has no SetRequest path, and a test fails if the reader's PDU type is ever SetRequest's (`helpers/reader/`). |
| **First contact** | Before any login is sent, a person confirms the device's SNMP engine ID. A changed one stops every read of that device until someone confirms again. |
| **A refused login** | Never retried at once. Fathom waits a minute, then 15 minutes, then an hour, so it never uses up the lockout budget an engineer needs. |
| **Where the read runs** | In a separate `reader` container with its own network. The main server holds no SNMP or SSH client (ADR-0082 §4.3). |
| **What happens to the answer** | It passes the redaction gate's detector, is sealed under the organisation's key, and is shown as "differs from drawing". **Nothing changes in the design until a person presses Accept** (ADR-0046). A reading never starts another read, a plan, an alert or anything else. |

The login itself should be a read-only account on the device. Fathom cannot see how the device
configured it, so the vault asks you to tick "This is a read-only account" before Fathom may use it.
That account is the real boundary; the rest is Fathom making sure it never even tries.

---

## Every connection Fathom can make

The server opens no connection the operator did not configure (`.context/conventions.md`,
invariant 1). There is no telemetry, analytics, error reporting, update check or font CDN. Here is
everything it can reach, and the setting that turns each one on. Unset means off.

| Connection | Turned on by | Notes |
|---|---|---|
| Its own PostgreSQL | Always (compose) | On the compose network. |
| Devices, to read them | `FATHOM_DEVICE_READ=on` and the `reader` profile | Through the reader container only, as above. |
| An outside password vault (Vaultwarden, Delinea) | `FATHOM_OUTSIDE_VAULT_HOSTS` | Only the hosts listed; one folder or collection, checked before every read. |
| Passbolt | The `passbolt` profile | Through its own helper container. |
| Off-site backup copy (S3-compatible) | `FATHOM_OFFSITE_*` | Sealed before it leaves (ADR-0070). |
| Syslog for the audit or access log | `FATHOM_AUDIT_SYSLOG`, `FATHOM_ACCESS_SYSLOG` | Unset, nothing ships. |
| Termix | `FATHOM_TERMIX_URL` | Your browser talks to Termix; the server does not. |

Firmware files go the other way: a switch fetches an image from Fathom, at
`FATHOM_FIRMWARE_FETCH_BASE_URL`, when a person runs that step by hand.

In the browser, the page's Content-Security-Policy starts from `default-src 'none'` and allows
Fathom's own origin plus one outside address (`crates/fathom-server/src/client.rs`):

| From your browser | When | What is sent |
|---|---|---|
| Have I Been Pwned's range API (`api.pwnedpasswords.com`) | A vault login is marked critical, or a Steward turned breach checks on | The first five characters of the password's SHA-1, with padding. The password and the rest of its hash never leave the tab (ADR-0071 part three, `client/src/vault/breach.ts`). |

Anyone signed in can see which of these a server has switched on: **About this Fathom**, in the account menu or as "About" in Ctrl K. It shows on or off for each, never an address or a key, along with the build's commit and a few checks this browser runs for itself (`crates/fathom-server/src/about.rs`, `client/src/components/about/`).

---

## Where credentials go

- **In a pasted or dropped config:** destroyed in your browser by the Rust redaction gate, compiled to
  WebAssembly, before anything is stored or sent. The server runs a second check and refuses any that
  arrive. The design never holds a credential.
- **In the vault, if you choose to store one:** sealed in your browser under your passphrase, kept
  apart from the design, and never part of an export or an AI reading (ADR-0042, ADR-0071).
- **For Fathom to read a device:** only a vault login whose owner chose to let Fathom use it, marked
  for that device, with a second admin's countersignature for a shared login. Every use is written to
  the organisation's tamper-evident history first.

---

## What Fathom does not read

Being plain about the limits is part of being trustworthy. "Not yet" means it may come and would get a
sign-off first. "No" means it is outside what Fathom is for.

| | |
|---|---|
| **No: writing to a device** | No SNMP Set, no config push, no command outside the fixed list. Changes stay copy-paste, or a file a person runs. |
| **No: sweeping or scanning a network** | No ping sweeps, port scans or DHCP probes. Bring discovery in by importing an nmap file instead. |
| **No: SNMP v1 or v2c** | Community strings travel in plain text. |
| **No: live monitoring or alerting** | Fathom is a record and a planner, not a monitor. |
| **Not yet: SSH reading** | Allowed by ADR-0082 and next to be built, from a fixed per-platform command list. |
| **Not yet: overlays and tunnels** | VXLAN, EVPN, GENEVE, GRE and MPLS are not read or modelled. Mesh VPNs (Tailscale, WireGuard and others) are entered by hand. |
| **Not yet: flow data** | No NetFlow, sFlow or IPFIX. |
| **Not yet: vendor APIs** | No NETCONF, RESTCONF, gNMI or controller APIs. Configs come in by paste, by a dropped folder, or from a backup playbook. |
| **Not yet: PoE draw per port** | There is no schema field for it. |
| **Partly** | CDP and LLDP neighbour lists are read from a paste. VRFs are read from Arista configs and kept in the IP plan. Pasted configs are read for ten platforms (`docs/STATE.md`). |

---

## Checking that a release is really ours

Every image published from `main` (server, backup, Passbolt helper and reader) gets a provenance
attestation from GitHub Actions, signed for that image's digest: which repository, workflow and commit
built it (`.github/workflows/publish.yml`). The release workflow refuses to name a release whose image
does not verify this way.

To check an image yourself with the GitHub CLI, use the same command the release workflow runs
(`.github/workflows/release.yml`; flags read from `gh attestation verify --help`, gh 2.89.0,
2026-10-25):

```
gh attestation verify oci://ghcr.io/keyxmakerx/fathom-server@sha256:<digest> \
  --repo keyxmakerx/Fathom \
  --signer-workflow keyxmakerx/Fathom/.github/workflows/publish.yml \
  --source-ref refs/heads/main \
  --deny-self-hosted-runners
```

Add `--source-digest <commit>` to tie it to one commit. Swap `fathom-server` for `fathom-backup`,
`fathom-passbolt-helper` or `fathom-reader` to check the others. Get an image's digest from
`docker image inspect --format '{{index .RepoDigests 0}}' <image>`, or from the publish run's summary.
To make your server run exactly that digest, set `FATHOM_DIGEST` (and its siblings) in `.env`;
`docs/RUNNING-IT.md` explains pinning.

Base images in the Dockerfiles are pinned by hash, and the Rust and npm dependency gates in
`scripts/` run on every pull request (`CONTRIBUTING.md` §4).
