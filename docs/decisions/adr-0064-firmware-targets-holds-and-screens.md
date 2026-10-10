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
