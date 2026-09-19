# Upgrading a Juniper — the procedure, and the traps

**Written 2026-09-14 from the research round of that date.** `juniper.net` was unreachable from the
environment this was written in, so **most of what follows is a search summary describing Juniper's
documentation rather than a verbatim read of it.** Each step says which it is. Check anything marked
*summary* against the real hardware guide for your platform and release before a maintenance window
you care about. ADR-0034 is why this warning is here rather than omitted.

This works today, by hand, with no Fathom involved. ADR-0045 describes what Fathom will do for you,
which is stage the image and check the hash — never run the upgrade.

---

## The five traps, before the steps

1. **`request system storage cleanup` can delete the image you just copied.** The documented order
   is: check space, clean up, **then** copy. A sequence that copies first and cleans second deletes
   its own payload. *(summary)*
2. **A partial transfer is accepted as a file.** Juniper's own documentation notes that images
   sometimes do not transfer completely, and `truncated or corrupted package` at install is a real
   reported failure. **Always compare hashes after the copy.** Juniper's own `splitcopy` tool does
   this by default and needs a flag to skip it. *(splitcopy README: primary read. The rest: summary)*
3. **Your `scp` probably does not speak SCP.** The OpenSSH manual states, verbatim, *"Since OpenSSH
   9.0, scp has used the SFTP protocol for transfers by default."* Junos has disabled incoming SFTP
   globally by default since Release 19.1R1. So a modern laptop copying to a device from the last
   seven years fails unless SFTP was explicitly enabled on it. The failure looks like a subsystem
   error, not a permission error. **`scp -O` forces the old protocol**, which is the documented
   escape. *(OpenSSH manual: primary read. Junos default: summary)*
4. **The published checksum is weaker than you would hope.** Juniper documents MD5, and the download
   site shows MD5 or SHA-1. Whether SHA-256 or a detached signature is published today could not be
   established. MD5 and SHA-1 catch a truncated download; they do not protect against a substituted
   image. **The real authenticity control is the signature Junos checks at install**, not the
   published hash. *(summary)*
5. **Take the snapshot twice.** Once before, and once after a successful upgrade. Skip the second
   and your alternate boot media stays out of sync with the primary. *(summary)*

---

## The procedure

Everything below is a *summary* of Juniper's documentation unless marked otherwise. Commands are
given as they were reported; confirm them for your platform.

### 1. Before you touch anything

```
show version
show system storage
request system snapshot
request system configuration rescue save
```

`request system snapshot` copies the running system to alternate media. The rescue save gives
`rollback rescue` a known-good configuration to return to.

### 2. Make room, in this order

```
show system storage
request system storage cleanup dry-run
request system storage cleanup
```

`/var` is the partition that fills. On Junos OS Evolved, 90% or more on `/soft`, `/var` or `/data`
means there is not enough room to install. `request system software delete` removes old packages if
cleanup is not enough.

**Do this before copying the image, not after.** See trap 1.

### 3. Get the image onto the device

Two shapes. The second is the one ADR-0045 chose for Fathom, and it is the better one.

**Push it from your machine.** Note `-O`, per trap 3:

```sh
sha256sum junos-install-....tgz          # write this down
scp -O junos-install-....tgz user@device:/var/tmp/
```

If `-O` fails, the device has SFTP enabled and you do not need it. If the transfer fails without
`-O` and succeeds with it, trap 3 is exactly what you hit.

**Or have the device pull it**, which avoids the protocol question entirely because the device uses
its own transfer stack:

```
file copy https://your-host/path/junos-install-....tgz /var/tmp/
```

Junos `file copy` accepts local paths, `ftp://`, `http://`, `https://`, `scp://` and `sftp://`
sources. HTTP and HTTPS are **source only**.

**Whether Junos verifies TLS certificates on an `https://` source could not be established.** Do not
rely on the transport for authenticity either way. Step 4 is what establishes it.

### 4. Prove the whole file arrived — do not skip this

```
file checksum sha-256 /var/tmp/junos-install-....tgz
```

Compare against the hash you took of the source in step 3. `file checksum sha-256` has been
available since Junos 9.5, so it is on anything you will meet. If they differ, the file is wrong;
delete it and copy again.

### 5. Prove Juniper made it

```
request system software validate /var/tmp/junos-install-....tgz
```

This checks the vendor signature, chaining to a Juniper root certificate. Success looks like:

```
Verified junos-install-... signed by PackageProductionEc_... method ECDSA256+SHA256
```

Failure is explicit: `ERROR: Package signature validation failed. Aborting install.`

**This is the step that answers "did Juniper make this".** It does not answer "is this the release I
meant", which is yours to check.

### 6. Install

```
request system software add /var/tmp/junos-install-....tgz
request system reboot
```

### 7. After it comes back

```
show version
request system snapshot
```

The second snapshot is trap 5. If the upgrade went wrong:

```
request system software rollback
```

which reverts to the last successfully installed package, keeping the current configuration by
default. `rollback rescue` returns the configuration to what step 1 saved.

---

## If you are automating this, three constraints

From the same research, and they are the reason ADR-0045 came out the way it did.

- **`connection-limit` and `rate-limit` under `[edit system services ssh]` are global to the
  service, not per user.** An automated client that retries can consume the budget an operator needs
  to get in. `lockout-period` reaches 43,200 minutes, which is thirty days. *(summary)*
- **Never retry on an authentication failure.** Retry on transport failure only, with backoff. A
  stale password in a loop is how an account gets locked for a month.
- **Never change the device's configuration to make room for your own tooling.** Juniper's own
  `splitcopy` deactivates `connection-limit` and `rate-limit` to get its work done and restores them
  afterwards *(primary read)*. That is reasonable for a tool an operator runs by hand and watches,
  and it is not reasonable for a server: it is a configuration change on production equipment and a
  window where a protection is absent.

## What could not be established, and would change this document

- The minimal Junos permission set that can receive a file and nothing else. Both `operator` and
  `read-only` have SCP and SFTP server functionality **disabled**, so the obvious least-privilege
  answers do not work, and `maintenance` is documented as letting a user become super-user.
- Whether Junos honours `authorized_keys` restrictions such as `restrict` and `command="…"` on a key
  configured through the Junos hierarchy. On an ordinary Unix host that is how a key becomes
  single-purpose.
- Whether Junos verifies TLS certificates on an `https://` source.
- Whether Juniper publishes SHA-256, or any detached signature, alongside images today.
- Any Junos command that displays the device's own SSH host key fingerprint, and whether Juniper
  publishes one out of band. None was found, which is why first contact is trust-on-first-use and
  why Juniper's own management platform asks a human to acknowledge a fingerprint.
