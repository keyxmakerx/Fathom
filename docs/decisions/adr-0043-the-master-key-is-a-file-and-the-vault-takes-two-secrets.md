# ADR-0043 — The master key is a file on the server, and the vault takes two secrets

**Status:** Accepted, 2026-09-12
**Closes:** ADR-0040 §9 items 1 and 2 (which key-management service; the self-hosted key story), and
`docs/OPEN-QUESTIONS.md` A1 and V1. Supersedes V3.
**Decided by the project, not the owner.** The owner was asked and answered: *"I can not answer
those, you will need to research those yourself."* **Every decision here is reversible and theirs to
overrule on sight**, and each states what it gives up so an overrule is a short conversation.

---

## 1. The decision

**The master key is 32 bytes in a file on the Fathom server**, generated at first start, owned by the
Fathom process user, mode 0400, in its own volume — not the PostgreSQL volume, and not in any
database backup. Everything else plugs in behind one interface with three shapes: `file://` (default),
`command://`, and `env://` (supported, documented as discouraged).

**The credential vault takes two secrets, and both are required** — a Fathom-generated 128-bit vault
key shown once at enrolment, and a passphrase. They are combined in the key derivation, not used as
two alternative unlock paths. The vault key is cached in the browser after enrolment, so day to day a
person types only the passphrase; a new browser or laptop needs both, once.

## 2. Why a file, when a cloud key service is stronger on paper

**Because every comparable product does this, and because the alternatives fail a constraint that is
not negotiable.** Seven self-hostable products were read in their own repositories rather than their
documentation sites — Vaultwarden, Passbolt, NetBox, netbox-secrets, authentik, Keycloak, Nextcloud.
In their default self-hosted configuration, **every one of them holds the key in a file or a config
value.** Not one requires an external key service.

Two constraints decide it:

**Fathom may run air-gapped.** A customer on their own hardware with no cloud connection is a stated
deployment, so anything *requiring* a cloud service is not a default — it is an option.

**The owner wants it to run for years without maintenance, and HashiCorp Vault's own documentation
concedes the problem:** *"Automated tools can easily install, configure, and start Vault, but
unsealing it using Shamir seals is a manual process."* A key that needs a human after every 3 a.m.
reboot fails the stated bar in practice however good it looks on a questionnaire. Vault also warns
that if the seal mechanism or its keys are permanently deleted, the cluster cannot be recovered *even
from backups* — a failure mode a file does not have.

And the standards position supports the placement rather than merely tolerating it. OWASP's
Cryptographic Storage guidance, read from its source repository: *"if the data is stored in a
database, the keys should be stored in the filesystem."* On the fallback: *"Avoid storing keys in
environment variables, as these can be accidentally exposed."* That is why `env://` is supported and
discouraged in that order — it is citable, not taste.

## 3. The provider interface, and why it costs no dependency

Three shapes only:

- **`file:///path/to/master.key`** — the default.
- **`command:///path/to/prog`** — Fathom runs it and reads the key from stdout. Established practice:
  restic's `--password-command`, and Vault's own `seal` stanza taking indirect `env://`, `file://` and
  `string://` references.
- **`env://NAME`** — supported, discouraged, with the citation in the documentation.

**AWS KMS, Google, Azure, HashiCorp Vault, CyberArk and Delinea all become `command://` with a
wrapper the operator supplies.** This is the load-bearing consequence: the SDK lives in the
operator's container or PATH, never in `Cargo.lock`. Fathom supports every key service on the market
without arguing a single one through the dependency gate. It also preserves the byte-identical
re-wrap requirement in `PHASE-2-STORAGE-DESIGN.md` §4, because a provider's only job is to return or
unwrap 32 bytes.

For a bare-metal operator wanting more than file permissions, **document but do not build**
`systemd-creds`, which encrypts a credential under a TPM2-derived secret not stored on the host. With
`command://` that is a three-line wrapper and no Fathom code.

## 4. Two things this forces, both cheap now and expensive later

**Stamp a non-secret key id into a metadata row.** A restore with the wrong key must report *"this
database was encrypted under master key `a41f…`; the configured key is `9c02…`"* rather than
surfacing as an AEAD tag failure that reads like corruption. Without it the most common operator
error produces the most alarming possible symptom.

**Keep retired master keys forever.** OWASP: *"old keys should generally be stored for a certain
period after they have been retired, in case old backups of copies of the data need to be
decrypted."* A rotation that deletes the old key silently destroys every existing backup.

## 5. What this buys, and what it does not — both sentences, in this order

**A stolen database dump, a stolen replica, last night's SQL backup, or an account with `SELECT` on
every table yields ciphertext for design contents.** PostgreSQL runs as a different user in a
different container and cannot read the key file.

**Anyone who can read files as the Fathom user has both halves** — root on the host, a shell in the
container, or whoever carries the server out of the building. The server decrypts designs in normal
operation because it has to serve them (§2a). If the hardware can be physically stolen, host disk
encryption is what closes that gap, and Fathom cannot do it for the operator. Nextcloud says the same
thing about their own server-side encryption, and they are right to.

**Still readable in a dump with no key at all:** everything §11.3 lists — tenant identity, the
organisation → network → building → rack tree, design names, authorship, timestamps, activity
volumes. Narrowed to a silhouette if §11.3's name encryption is taken, which it is (V2).

## 6. The vault: two secrets, not two doors

**The shape that does not work** is a passphrase *or* a recovery key, each wrapping the same vault
master key. An attacker picks the cheaper wrap, so the bound is the passphrase and the recovery key
is decoration. The illustration a network engineer already knows is LUKS: several keyslots, all
yielding one volume key, and the volume is as strong as the weakest slot.

**So both are required, combined in the derivation.** Argon2id takes a secret input alongside the
passphrase — the RustCrypto crate supports it directly, so this costs no dependency. Against an
offline attacker holding a stolen database the bound is then **128 bits, not the passphrase**, which
is the outcome the generated key was for, without anyone typing 26 characters a day.

The pattern is shipped practice: Bitwarden persists a device key so a trusted device unlocks without
the master password; KeePassXC requires password *and* key file *and* token together, then offers a
cheap unlock after one full unlock. 1Password's two-secret derivation is the closest precedent and is
**unverified** — every 1Password host and its white-paper repository were unreachable — so it is
named as corroboration, not authority.

**A forgotten passphrase stays unrecoverable.** Do not add a second wrap to fix it; that reintroduces
the bound this decision removes. Organisational survivability comes from §5's per-recipient sharing:
enrol a break-glass recipient whose key is protected by a printed secret in a safe. That survives a
person leaving without weakening anyone's vault.

## 7. V3, the server-held pepper, is superseded — and its write-up was wrong

Two reasons, and the second is a correction.

**It is redundant.** The 128-bit vault key in §6 does what a pepper was for: it makes a stolen dump
uncrackable regardless of passphrase strength. It does it better, because the user holds it.

**And the pepper never stayed on the server anyway.** Mode A derivation happens in the browser, so a
pepper must be delivered to every authenticated client at unlock. `PHASE-2-STORAGE-DESIGN.md` §11.4
described it as server-held, which would have reached owner-facing documentation as a stronger claim
than the mechanism supports. It still defeats the dump-only attacker — the actual threat — but that
is a different sentence, and §11.4 is corrected.

## 8. The strongest arguments against, stated rather than waited for

**On the file:** it puts the key and the data on one machine, with no log of key use and no remote
kill switch. A cloud key service gives an enterprise buyer an audit trail of every decrypt,
revocation triggerable from elsewhere while the compromised host still runs, and a key that never
exists in the process in exportable form. On a security questionnaire *"key file on the server"* reads
worse than *"AWS KMS with CloudTrail"* — a commercial cost as well as a technical one. It also
interacts with A2: without a key service, key-use logging exists nowhere in the product, so the audit
log is the only answer to *"who decrypted what"*, and it is not built. `command://` exists precisely
so a customer needing that trail can have it without Fathom taking the dependency.

**On the vault:** the 128-bit bound holds only against the attacker with a stolen database. The cached
vault key makes the browser the new soft spot — the same server serves the JavaScript, so a
compromised instance can ship a client that takes both secrets at the next unlock, and a cached key is
reachable by XSS. Operators will hear *"128-bit"* and believe more than that. The friction is moved,
not removed: every new browser profile and replacement laptop needs the printed key. **If the friction
must go entirely, the passphrase becomes the bound and that must be said.** There is no third option.

And one honest note about the audience: network engineers already keep credentials in a password
manager, so storing the vault key there is a habit rather than a burden — which also means the
vault's practical strength becomes their password manager's. That belongs in the documentation, not
in a discovery.

## 9. What must be written, in the operator's register

> Fathom encrypts every design before it reaches PostgreSQL. The key that unlocks the per-tenant keys
> is 32 bytes in `/var/lib/fathom/keys/master.key`, readable only by the `fathom` user. It is not in
> the database, not in an environment variable, and not in any backup Fathom takes. PostgreSQL cannot
> read it.
>
> **What that buys you:** a stolen database dump, a stolen replica, last night's SQL backup, or an
> account with `SELECT` on every table yields ciphertext for design contents.
>
> **What it does not buy you:** anyone who can read files as `fathom` — root on the host, a shell in
> the container, or whoever carries the server out of the building — has both halves. Fathom's server
> decrypts designs during normal operation because it has to render and serve them.
>
> **Your jobs:** (1) at install, copy `master.key` off the machine, somewhere the database backups are
> not, and test a restore with it; (2) never put `master.key` and a database dump in the same archive;
> (3) if you suspect the host was compromised, run `fathom rekey` — and understand that a copy the
> attacker already took still opens the backups they already have; (4) if the hardware can be stolen,
> encrypt the host disk. That is what protects a powered-off box, and Fathom cannot do it for you.

## 10. Consequences

- **Nothing blocks storage any more.** A1 was the reason `stores_nothing` existed; it is answered.
- The key file gets its **own named volume**, a startup log line naming the volume that must never be
  archived with the database, and that sentence repeated in the backup documentation. The standard
  self-hosted backup recipe is *"tar all the volumes"*, and it would otherwise put both halves in one
  archive.
- `fathom rekey` is a **re-wrap**, with everything §12.6 requires of that word — including that it
  revokes nothing.
- ADR-0042's title, *"a vault it cannot read"*, is broader than its own §3, where Modes B and C exist
  and the server can. §2a already flags this; fix it in the same pass, because the title is the part
  people quote.

## 11. Sources

Read 2026-09-12 from source repositories, because the published documentation sites were unreachable
through this session's proxy: `dani-garcia/vaultwarden.wiki`, `passbolt/passbolt_api`,
`netbox-community/netbox`, `Onemind-Services-LLC/netbox-secrets`, `goauthentik/authentik`,
`keycloak/keycloak`, `nextcloud/documentation`, `hashicorp/web-unified-docs`,
`OWASP/CheatSheetSeries`, `bitwarden/clients`, `keepassxreboot/keepassxc`, `FiloSottile/age`,
`restic/restic`, `systemd/systemd`, `gitlab.com/cryptsetup/cryptsetup`,
`RustCrypto/password-hashes`.

**Unverified and named as such:** 1Password's two-secret key derivation, Apple's recovery key, and
Passbolt's account-recovery escrow — all search-derived, all hosts blocked. **Still unread:** RFC 9106,
and the advisory status of `argon2` and `chacha20poly1305` (both advisory services were unreachable
this session, which is weaker than §12.4's check against a working control — redo it before merge).
