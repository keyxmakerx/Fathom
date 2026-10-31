# ADR-0064: Firmware targets, holds and screens

**Status:** accepted 2026-10-10 (owner approved sign-off cards r13-firmware, r13-firmware-v2 and
r14-firmware; mockups in `design/r14-firmware/`).

Builds on ADR-0045 (the device pulls; Fathom never connects to a device, holds no device
credential and runs no upgrade). Nothing here changes that line.

## Decision

- **Images stay on the server** (ADR-0045 store). Migration 0038 adds an optional `platform`,
  `version` and `models` list to each image. Models can be replaced later by a steward
  (`PUT /organisations/{o}/firmware/{image}/models`, sealed as `firmware_models_changed`).
- **The chosen version per model and the per-device holds live in the design**, not in server
  tables: schema 0.19 `FirmwareTarget` (root child, identity `model`; `version`, optional
  `platform`, `image`, `image_sha256`, `note`) and `Device.firmware_hold` (set = held on purpose,
  value = the reason). The r13-firmware-v2 card said "server stores"; this was changed on merit:
  in the design they are encrypted with it, versioned, co-edited, undone like any edit, and the
  rule engine can read them. Plaintext server rows would have exposed device ids and estate
  structure the design otherwise keeps sealed.
- **"Behind" is an engine rule**, `fw.device.behind-chosen-version`, using a new `all: Kind`
  binding and the builtin `version_older(platform, have, want)` over the platform's
  `version_scheme` (junos R releases, iosxe, nxos, eos). A version that does not parse, or a tie
  decided only by a letter suffix, gives no finding: the rule claims nothing rather than guess.
- **Screens:** Inventory gains Firmware (one row per image) and Models (a model's chosen version
  with Hold/Release); the device editor gains a firmware group; right-click "Plan a firmware
  upgrade" and the Firmware list's "Plan an upgrade for them" make an ordinary maintenance plan
  of six plain steps with the vendor's commands from the server under them. The one-time fetch
  link is requested on the day, held in memory, and never written to the design.
- **Vendors:** Juniper (Junos), Cisco (IOS XE, NX-OS), Arista (EOS). Steps per platform are in
  `crates/fathom-server/src/firmware_commands.rs` with sources and dates, and in
  `docs/UPGRADING-A-CISCO-OR-ARISTA.md`; what could not be established is said in the response.
- **Compose:** firmware is on once `FATHOM_FIRMWARE_FETCH_BASE_URL` (the address switches reach)
  is set in `.env`; the `firmware` volume holds the images.

## Not done

- On-device SHA-256 was not found on IOS XE (`verify` offers MD5 and SHA-512), so that plan
  compares with Cisco's published SHA-512; computing a SHA-512 at upload would close the gap. EOS
  uses `bash sha256sum`, from a third-party guide, which the step says.
- Junos X, D, F, B and I releases are not ordered.

## Amended 2026-10-28 (sign-off r55, schema 0.31)

Owner-approved card r55-fw-by-hand, for upgrades Fathom holds no image for (an OPNsense router,
a NAS with no catalogue model):

- A device none of whose models has a target may carry its own, `Device.firmware_target`. A
  model's target always wins; the check reads the device's own only when no model target applies.
- The running version can be typed on the device page (marked typed), and a device no paste
  named a platform for can be given one of the platforms Fathom compares.
- `version_older` reads OPNsense, pfSense, RouterOS and Linux, each with its source; pfSense CE
  and Plus are never ordered against each other.
- Such a plan carries written steps for OPNsense, Debian, Ubuntu, TrueNAS or Synology DSM
  (`client/src/components/firmware/kits.ts`), each naming its page and date. Synology's own pages
  could not be read, so its steps say they are unchecked.
- A plan is known as a firmware plan by its "Record <version> as running" steps, not its title,
  so an upgrade can be added to an existing plan and one plan can hold several, each fetch step
  with its own image. Plans made before this are still known by their title.

## Amended 2026-10-31 (sign-off r62, first part)

Owner-approved card r62-firmware-security. Warn first everywhere a person acts; refuse only where
the server or its disk is at risk. This part is built:

- **Room.** `FATHOM_FIRMWARE_ORGANISATION_MAX_BYTES` (default 20 GiB) and
  `FATHOM_FIRMWARE_TOTAL_MAX_BYTES` (default 50 GiB), checked at declaration, `507` when over. The
  total is counted from the files on disk and stands in for the free-space check the card named:
  std has no portable call for it and the dependency that has one is not approved. `docs/OPERATING.md`
  says to set it below the volume's size.
- **Uploads at once.** One per organisation and three per server process, `429` with the upload
  token unspent. Device downloads are not limited (the owner's note: a dozen switches at once is
  normal).
- **Stalls.** An upload that sends nothing for 120 seconds is dropped, its file deleted, `408`.
- **The bytes read again before sending.** The fetch route hashes the open file before the first
  byte, then streams from the same handle, rewound. A mismatch is `500` and nothing is sent.

- **SHA-512 at upload** (`0059`), from the same pass as the SHA-256, shown with a Copy button on the
  image's page. Computed, never declared.
- **The weekly re-check.** Each staged image is hashed again every seven days, one at a time. A
  mismatch or a missing file sets `changed_at`, which is never cleared, and the page and list warn.
  Finding what is due crosses organisations under a read-only capability,
  `app.firmware_recheck_custody`; every write is under the image's own organisation.

Still to build from the same card: MD5 at upload (it needs `md-5`, a new crate, so it waits on a
`deps/decisions/` record and the owner's approval of it), retiring an image,
the warnings at link time (wrong model, downgrade, not the chosen version, where a download went),
the firmware activity list, the device signature-check steps, and an optional scanner add-on.
