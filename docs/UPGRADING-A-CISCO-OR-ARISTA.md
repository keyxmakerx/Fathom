# Upgrading a Cisco or Arista switch — the procedure, and what could not be established

**Read from the vendors' own pages on 2026-10-10** (unlike `docs/UPGRADING-A-JUNIPER.md`, whose
`juniper.net` pages were unreachable). Every URL below was fetched that day. Where a page did not say
something, this document says "could not establish" rather than filling the gap from memory. The
pages are for particular platforms and releases; check yours before a maintenance window.

Fathom stages the image and proves it whole; **the device pulls it and the operator runs every
command** (ADR-0045). Fathom's `commands` answer renders these steps with your filename, hash and
fetch URL. It holds a **SHA-256** only.

---

## The order, on every platform

1. Check space. 2. **Make room before the copy** (clean-up after a copy can remove what you just
copied). 3. Have the device pull the image from the fetch URL. 4. Prove the whole file arrived.
5. Check the vendor's signature where a command is documented. 6. Install (yours). 7. Check after.

## Cisco IOS XE (`ios-xe`)

Sources: [Upgrading Catalyst 9300](https://www.cisco.com/c/en/us/support/docs/switches/catalyst-9300-series-switches/222280-upgrading-catalyst-9300-switches.html),
[Transferring Files Using HTTP or HTTPS](https://www.cisco.com/en/US/docs/ios-xml/ios/https/configuration/xe-2/https-xe-2-book.html),
[IOS XE Integrity Assurance](https://www.cisco.com/c/en/us/about/security-center/ios-xe-integrity-assurance.html).

```
dir bootflash:                                         # 1 to 1.5 GB free (Cisco, Catalyst 9300)
install remove inactive                                # before the copy
copy https://<fetch-url> bootflash:<file>
verify /sha512 bootflash:<file>
show software authenticity file bootflash:<file>
install add file bootflash:<file> activate commit      # yours; reloads
show version
```

- **The hash step compares with Fathom's SHA-512, not its SHA-256.** `verify` takes `/md5` or
  `/sha512` (SHA-512 since 16.5.1). An on-device SHA-256 could not be established. Since 2026-10-31
  Fathom works out a SHA-512 at upload (and at an older image's first weekly re-check), so the plan
  gives `expected_sha512` to compare with. Compare it with the SHA-512 on Cisco's Software Download
  page too; that also shows the file is Cisco's.
- HTTPS copy: from 17.3.1 the server name must match the certificate's Subject Alternative Name; from
  17.15.1a the URL needs an absolute path. Whether the certificate chain is validated could not be
  established.
- Cisco's guide writes `flash:` for Catalyst 9300; `show file systems` lists your platform's name.
- Install mode (16.6.2 and later). Bundle mode differs. No rollback command is on the page read.
- `verify <file>` checks the signature of a `.pkg`; whether it does for a `.bin` could not be
  established.

## Cisco NX-OS (`nx-os`)

Sources: [Upgrade Nexus 3000 and 3100](https://www.cisco.com/c/en/us/support/docs/switches/nexus-3000-series-switches/216037-nexus-3000-and-3100-nx-os-software-upgra.html),
[Validate the Integrity of a Downloaded Software File](https://www.cisco.com/c/en/us/support/docs/storage-networking/mds-9000-san-management/211350-How-to-Validate-the-Integrity-of-a-Downl.html)
(MDS, same NX-OS family),
[Nexus 9000 10.3(x) troubleshooting guide](https://www.cisco.com/c/en/us/td/docs/dcn/nx-os/nexus9000/103x/troubleshooting/cisco-nexus-9000-series-nx-os-troubleshooting-guide-release-103x/m_before_contacting_technical_support_9x.html).

```
dir bootflash:
delete bootflash:<old image>                           # before the copy
copy https://<fetch-url> bootflash:<file> vrf management
show file bootflash:<file> sha256sum
show install all impact nxos bootflash:<file>
install all nxos bootflash:<file>                      # yours; reloads
show version        # and: show module
```

- Do **not** add `compact`: it rewrites the file, so its hash no longer matches anything published.
- `sha256sum` appears in Cisco's help output. Older releases may lack it: Cisco says only `md5sum` is
  on every version, `sha512sum` is on newer ones. Could not establish which release added SHA-256.
- Cisco's examples use `scp:`. Its Nexus 9000 guide lists `http:` among copy sources and names HTTPS
  only in passing. That `https://` works on your release could not be established.
- Change `vrf management` to the VRF that reaches Fathom.
- The bootflash note ("cannot hold two images") is from the Nexus 3000/3100 page.
- A stand-alone command that verifies the image signature could not be established; no rollback
  command is on the page read.

## Arista EOS (`eos`)

Sources: [Standard Upgrades and Downgrades](https://www.arista.com/en/um-eos/eos-standard-upgrades-and-downgrades)
(titled EOS 4.36.2F, examples still 4.13.2),
[Security Advisory 30](https://www.arista.com/en/support/advisories-notices/security-advisory/3577-security-advisory-30).

```
verify-swi <file>                                      # on your computer, before uploading
dir flash:                                             # room for two copies; 240 MB spare advised
delete flash:<old image>                               # before the copy
copy running-config flash:/<backup name>
copy https://<fetch-url> flash:/<file>
bash sha256sum /mnt/flash/<file>
verify /sha512 flash:/<file>
boot system flash:/<file>                              # config mode; yours
write
reload                                                 # yours
show version
```

- **Check the signature on your computer first.** `verify-swi` is from
  [swi-tools](https://pypi.org/project/switools), published in the aristanetworks GitHub organisation, read
  2026-10-31. It checks the SWI's signing certificate against Arista's root certificate and prints
  `SWI verification successful.`; anything else returns non-zero. A command that does this on the
  switch could not be established.

- **`https://` as a copy source could not be established.** Arista's page documents `http:`, `ftp:`,
  `scp:` and `usb`. If EOS refuses it, the fetch URL cannot be used as issued.
- `verify /sha512` is Arista's documented check (Security Advisory 30), compared with the SHA-512 on
  Arista's download page. `/md5` is the other form on the upgrade page. **An Arista-documented
  SHA-256 could not be established**, so Fathom's hash is compared with `bash sha256sum`, the Linux
  tool; the one-line `bash <command>` form comes from a third-party guide
  (`acws.duckdns.org/2025.4.ATL/references/arista_eos_guide`), not Arista. `/mnt/flash` is `flash:`
  (Arista's page).
- Arista's page says files may be deleted from `/mnt/flash` but gives no command; `delete` is not
  taken from it.
- A CLI command that verifies an SWI's signature could not be established. No rollback command is on
  the page read.
- Dual-supervisor switches: `install source <file> reload` replaces the last three steps.

---

## By hand, from a Windows PC or a Linux box

Fathom is a learning tool, so the upgrade plan's fetch step also shows the job done without Fathom:
**Fathom link · From Windows · From Linux** (`crates/fathom-server/src/firmware_by_hand.rs`). Only
getting the file there changes; every step above from "prove the whole file arrived" on is the same.
Read on 2026-10-25 unless marked.

**First, on your computer, check the file.** Linux `sha256sum <file>` (or `sha512sum` for IOS XE,
whose download page shows SHA-512); Windows PowerShell `Get-FileHash .\<file> -Algorithm SHA256`
(`SHA512` for IOS XE). `Get-FileHash` defaults to SHA-256 and prints it on its `Hash` line
([Microsoft Learn](https://learn.microsoft.com/powershell/module/microsoft.powershell.utility/get-filehash)).

**Cisco IOS XE: the computer pushes.** From Cisco's
[Copy Cisco IOS Images from PC to Router](https://www.cisco.com/c/en/us/support/docs/security-vpn/secure-shell-ssh/215450-copy-cisco-ios-images-from-pc-to-router.html)
(document 215450, updated 2025-09-15):

```
switch(config)# ip scp server enable          # the guide also has aaa new-model, local exec authorization, a privilege 15 user
pc$ scp -O <file> <you>@<switch>:<file>         # Windows: scp -O .\<file> ...
switch(config)# no ip scp server enable       # the guide: disable it after the copy
```

The guide gives only the file name after the colon, so the file lands on the default file system;
which one that is on your platform could not be established — `dir bootflash:` shows it. `-O` is
ADR-0045's trap: OpenSSH 9.0 and later speak SFTP unless told otherwise.

**Cisco NX-OS: the computer pushes.** `feature scp-server` enables the switch's SCP server (Cisco's
[Nexus 3000 and 9000 NX-API REST SDK guide, Configuring SSH](https://developer.cisco.com/docs/cisco-nexus-3000-and-9000-series-nx-api-rest-sdk-user-guide-and-api-reference/latest/configuring-ssh),
"Enabling the SCP Server"). Then `scp -O <file> <you>@<switch>:<file>` and `no feature scp-server`.
The scp destination form that names `bootflash:` could not be established from Cisco's pages; turning
the server off afterwards is carried over from Cisco's IOS advice, not from an NX-OS page.

**Arista EOS: the switch pulls from you.** Arista's
[upgrade page](https://www.arista.com/en/um-eos/eos-standard-upgrades-and-downgrades) shows the
switch copying from scp, ftp, http or a USB stick, and never a computer copying to the switch. So
the route turns around: run an SSH server on your computer, then on the switch
`copy scp://<you>@<your computer>/<folder>/<file> flash:/<file>`, or from a stick
`copy usb1:/<file> flash:/<file>`. On Windows that is OpenSSH Server, which Microsoft's table lists
as not installed by default on Windows 10 (1809 and later) or Server 2019 and 2022, and installed
but not enabled on Server 2025
([OpenSSH for Windows overview](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh-overview),
updated 2025-02-20).

**On a USB stick.** IOS XE: `copy usbflash0:<file> flash:` (install mode; `flash-x:` in bundle mode,
x the stack member) from Cisco's
[Catalyst 9300 upgrade guide](https://www.cisco.com/c/en/us/support/docs/switches/catalyst-9300-series-switches/222280-upgrading-catalyst-9300-switches.html)
(222280, updated 2025-10-15). EOS: `copy usb1:/<file> flash:/<file>` (Arista's upgrade page). NX-OS:
Cisco's vPC upgrade page (221034, updated 2026-06-12) says USB works but gives no command, so none
is shown.

**By TFTP, the old way, with a warning.** TFTP has "no login or access control mechanisms" (RFC 1350,
Security Considerations, read 2026-10-25), and nothing in it encrypts the file, so Fathom shows it
with that warning, keeps the server running only for the copy, and relies on the hash check on the
device. IOS XE: `copy tftp://<your computer>/<file> flash:` (222280). NX-OS:
`copy tftp://<your computer>/<file> bootflash: vrf management` (Cisco's
[Copying File to Bootflash](https://developer.cisco.com/docs/cisco-nexus-3000-and-9000-series-nx-api-rest-sdk-user-guide-and-api-reference/latest/copying-file-to-bootflash);
its CLI line has no VRF, its payload names `management`). On Linux the server is `tftpd-hpa`, serving
`/srv/tftp` (a third-party guide, tecmint.com, updated 2023-12-19). Fathom names no TFTP server for
Windows. Arista's upgrade page lists no TFTP source, so EOS gets none.

Juniper: neither USB nor TFTP is shown, because no Juniper page read gives the command
(`docs/UPGRADING-A-JUNIPER.md`).

---

## What this changes about Fathom's promise

Fathom's SHA-256 proves *the bytes on the device equal the bytes Fathom holds*, which equal what the
operator uploaded. It does not prove Cisco or Arista made them. On IOS XE the on-device check is a
SHA-512, so only the vendor's published value can be compared with it. Giving Fathom a SHA-512 as well
would let it say so itself; that is not built.
