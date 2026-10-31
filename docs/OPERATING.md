# Operating Fathom

This is the operator's register ADR-0043 §9 requires: what you must know about the master key
before you run this in production. Plain, second person. Every command below exists in the tree;
where one does not exist yet, this says so rather than inventing it.

Sources: `docs/decisions/adr-0043-the-master-key-is-a-file-and-the-vault-takes-two-secrets.md`,
`docs/PHASE-2-STORAGE-DESIGN.md` §11–§13, `crates/fathom-server/src/{config.rs,keyprovider.rs,keys.rs,main.rs}`,
`compose.yaml` (its inline `configs` carry the key-generation and database init scripts).

## The key file

Two 32-byte root keys, not one. **The master key** (`FATHOM_MASTER_KEY`, default
`file:///var/lib/fathom/keys/master.key`) wraps the per-tenant and per-design keys that protect
design content. **The chain key** (`FATHOM_CHAIN_KEY`, default
`file:///var/lib/fathom/keys/chain.key`) is a separate root the per-design audit chains are sealed
under. They are deliberately different keys, checked at startup to make sure nobody has pointed
both settings at the same file (`KeyError::RootsIdentical`).

On a `file://` source with nothing at the path, the server generates 32 bytes from the OS CSPRNG
and writes them at mode `0400`, owned by whoever the process runs as
(`crates/fathom-server/src/keyprovider.rs::create_file`). This only happens for `file://`; a
`command://` key is the operator's program's to create, and `env://` has nothing to create.

Three providers, one interface (ADR-0043 §3):

- **`file:///path`** — the default, and right for a self-hosted or air-gapped deployment with no
  outside key service to call.
- **`command:///path/to/prog`** — Fathom runs the program and reads the key from its standard
  output. Right when you have AWS KMS, Vault, or another key service: the SDK lives in your
  wrapper, never in Fathom's own dependencies.
- **`env://NAME`** — supported, and discouraged in that order, per OWASP's guidance against keys in
  environment variables. Use it only if nothing else fits.

**Permissions.** The server refuses a `file://` key that anyone but its owner can read: the check
is on the group and other bits, so `0400` and `0600` both pass and `0440` or wider is refused with
the mode named in the error (`KeyError::TooPermissive`).

**If it is lost:** on a `file://` source, a missing file at the next start is silently regenerated
— it is 32 fresh random bytes, not a restore of the old ones. The new key's id will not match the
one stamped in the database at first use, so the server refuses to start rather than serve anything
under the wrong key (see Restore, below). There is no other copy inside Fathom. **Your data is
unrecoverable without the original key file.**

## Keys from your own secrets manager

By default the `db` container generates every key into the `keys` volume at first start
(`compose.yaml`, the `db_start` config), and the volume is where they live. If your organisation
keeps keys in a secrets manager instead, point the four key settings somewhere else. The server
then reads them from there and never creates one.

| Setting | Read by | Default |
|---|---|---|
| `FATHOM_MASTER_KEY` | `server`, `backup` | `file:///var/lib/fathom/keys/master.key` |
| `FATHOM_CHAIN_KEY` | `server`, `backup` | `file:///var/lib/fathom/keys/chain.key` |
| `FATHOM_VAULT_KEY` | `server`, `backup` | `file:///var/lib/fathom/keys/vault.key` |
| `FATHOM_BACKUP_KEY` | `backup`, `backup-keys` | `file:///var/lib/fathom/keys/backup.key` |

Set them in the `environment:` of each service named, in your compose file. Each key is 32 raw
bytes or 64 hex characters, with at most one trailing newline. The master, chain and vault keys
must all be different; the server refuses to start if any two are the same.

**A file your secrets manager puts on the host.** Mount it into the container and name it with
`file://`. Compose `secrets:` work, with one catch, seen with Docker Compose v5.6.1 on
2026-10-31: outside Swarm, Compose ignores a secret's `uid`, `gid` and `mode` (it warns, and
bind-mounts the host file as it is). The server runs as uid 65532 and refuses a key file that its
group or anyone else can read, so the file on the host must be owned by 65532 and mode `0400` or
`0600`:

```yaml
# beside services:, at the top level
secrets:
  fathom_master:
    file: /etc/fathom/master.key   # chown 65532:65532, chmod 0400, on the host

# in the server service (and backup)
    secrets:
      - source: fathom_master
        target: master.key          # appears at /run/secrets/master.key
    environment:
      FATHOM_MASTER_KEY: "file:///run/secrets/master.key"
```

**A program that fetches the key.** `command:///path/to/program` runs it at startup and reads the
key from its standard output (`crates/fathom-server/src/keyprovider.rs`). It is run directly, with
no shell, as uid 65532, with the container's environment and nothing on standard input. It has 10
seconds, and anything over 4096 bytes of output is refused. The server image is distroless, with no
shell and no tools, so the program must be a single static executable you mount in. This is how
a cloud key service or Vault fits: their client lives in your program, not in Fathom.

`env://NAME` also works, and is discouraged for the reason given under "The key file" above.

**What changes when you do this.**

- The `db` container still generates its files in the `keys` volume. Keys you have moved elsewhere
  are just never read from there. The three database passwords stay in the volume; they can only
  be read from a file (`FATHOM_DB_PASSWORD_FILE`, `FATHOM_MIGRATE_DB_PASSWORD_FILE`).
- **The keys file no longer covers them.** `backup-keys` seals the files in a folder (the `keys`
  volume unless you pass `--keys-dir`), not the keys the settings above point at. Either mount your
  key files into one folder under the names `master.key`, `chain.key`, `backup.key` and
  `vault.key` and pass that folder with `--keys-dir`, or treat your secrets manager as the backup
  of those keys and keep its own recovery in order. The Backups screen says when the keys file
  does not match the running keys.
- **Moving an install that already has data:** the keys in your secrets manager must be the same
  32 bytes as the ones in the volume now. A different key does not match the one stamped in the
  database, and the server refuses to start. Copy them out of the volume first
  (`docker compose exec -T db cat /var/lib/fathom/keys/master.key > master.key`, and the same for
  the others), store them, then switch.

## Backups

**Never put the key volume and a database backup in the same archive.** In a compose deployment the
`keys` volume holds `master.key`, `chain.key`, `backup.key`, `vault.key` (the password vault, below) and — generated at first
start since 2026-09-19 by `compose.yaml` (the `db` container's start since 2026-10-31) — the passwords for all three database roles. Anyone holding that volume and a database dump (or
replica, or `SELECT`-capable credential) has both the ciphertext and everything needed to unwrap
it. A backup routine that tars every volume, which is the ordinary self-hosted habit, would put
both halves in one file.

So a Fathom backup is **two files, kept in different places** (ADR-0070):

- a **data file** (`.fdata`): the database dump and the staged firmware, sealed under `backup.key`.
  Make it as often as you like; nightly is the plan.
- a **keys file** (`.fkeys`): every file in the key volume, sealed under a **recovery phrase** that
  is printed once and never stored. Make it at install, and again whenever a key changes.

Neither opens anything without the other, and the keys file needs its phrase too. The credential
vault (ADR-0042), once built, needs nothing extra: its rows are in the dump, Mode A passwords stay
sealed by each person's own passphrase, and `vault.key` (Mode B) joins the keys file by itself.
A keys file made before `vault.key` existed does not hold it, so make a new one when the vault
arrives: until then the Backups screen and the banner say the vault key is not in it.

**Compose: it runs by itself.** Since 2026-10-25 the stack has a `backup` service (the postgres
image, for `pg_dump` and `pg_restore`, with the server binary added). Every night at 02:00 UTC it
writes a data file into the `backups` volume and keeps the newest 14; every Sunday it then restores
the newest into a throwaway database and drops it again. Admin › Settings › Backups shows what it
last did, and the console's banner says when a backup or a restore test failed, when none has been
made for two days, and when there is no keys file or the keys changed since it was made. On an
install older than this, `docker compose up -d` once generates `backup.key` and starts the service.

| `.env` | Default | |
|---|---|---|
| `FATHOM_BACKUP_AT` | `02:00` | UTC, `HH:MM` |
| `FATHOM_BACKUP_KEEP` | `14` | data files kept in the volume |
| `FATHOM_BACKUP_TEST_DAY` | `7` | ISO weekday of the restore test, 1 is Monday |

The one step it cannot do for you is the keys file, because its phrase has to reach a person:

```sh
# Once, and again whenever the banner says the keys file is out of date.
# The phrase is printed on the terminal; the keys file goes to standard output.
docker compose run --rm -T backup-keys > fathom-keys-$(date +%F).fkeys

# Now, rather than tonight:
docker compose exec backup backup-loop.sh once
docker compose exec backup backup-loop.sh test

# Take a data file off the host (or use the off-site copy below):
docker compose cp backup:/var/lib/fathom/backups/fathom-<stamp>.fdata .

# Prove a backup opens, without writing anything (asks for the phrase):
docker compose run --rm -v "$PWD":/work:ro --entrypoint fathom-server backup \
  restore /work/fathom-<stamp>.fdata --keys /work/fathom-keys-<date>.fkeys --check
```

A data file kept only on the host it backs up is not yet a backup. Copy it off, or turn on the
off-site copy.

**Off-site copy to S3-compatible storage.** The `offsite` profile adds `backup-offsite`, a pinned
rclone container that copies the data files to a bucket every day at 03:00 UTC (AWS S3, Backblaze
B2, Wasabi, Cloudflare R2, MinIO and the like). Only data files go; the keys file never does, since
a bucket holding both would be the one archive this section forbids. It uses `rclone copy`, never
`sync`, so pruning on the host never deletes anything in the bucket: give the bucket a lifecycle
rule for how long to keep them, and object lock if your provider offers it, so that whoever takes
the host cannot also delete its backups. Use a key that can only write to that one bucket. In
`.env`:

```sh
FATHOM_OFFSITE_BUCKET=my-fathom-backups
FATHOM_OFFSITE_PREFIX=fathom               # folder in the bucket, default fathom
FATHOM_OFFSITE_PROVIDER=Other              # rclone's s3 provider: AWS, Cloudflare, Minio, Wasabi, ...
FATHOM_OFFSITE_ENDPOINT=https://s3.example.com   # empty for AWS
FATHOM_OFFSITE_REGION=
FATHOM_OFFSITE_ACCESS_KEY_ID=...
FATHOM_OFFSITE_SECRET_ACCESS_KEY=...
FATHOM_OFFSITE_AT=03:00
```

then `docker compose --profile offsite up -d`, and `docker compose --profile offsite run --rm
backup-offsite once` to copy now. The Backups screen shows the last copy, and the banner says when
one fails. rclone reads the remote from `RCLONE_CONFIG_<NAME>_<OPTION>` variables, so no config
file exists; `copy --immutable` refuses to overwrite a copy that differs instead of replacing it
(rclone v1.75.2, `docs/content/docs.md`, sections "Config file" and "--immutable", read on GitHub
2026-10-25).

**Dump as `fathom_bootstrap`, not as `fathom`.** Until 2026-10-25 this page said `-U fathom`, and
that never worked on a real install: 43 tables are `FORCE ROW LEVEL SECURITY`, so their owner is
filtered too, and `pg_dump` (which turns row security off and refuses to dump a filtered table)
stops with *"query would be affected by row-level security policy for table "account_keys""*.
Checked against this schema on PostgreSQL 16, 2026-10-25. The service connects as the bootstrap
role with its password from the key volume. By hand, inside the `db` container, it connects over
the local socket, which initdb sets to `trust` when it is given no `--auth` (PostgreSQL 16's initdb,
checked the same day; the postgres image's entrypoint only appends a `host` rule):

```sh
docker compose exec -T db pg_dump -U fathom_bootstrap -d fathom -Fc \
  | docker compose run --rm -T --no-deps server backup > fathom-$(date +%F).fdata
```

**From source**, with the server's environment set:

```sh
fathom-server keys-file > fathom-keys-$(date +%F).fkeys
pg_dump -h 127.0.0.1 -U <a superuser> -d fathom -Fc | fathom-server backup > fathom-$(date +%F).fdata
fathom-server restore fathom-$(date +%F).fdata --keys fathom-keys-<date>.fkeys --check
```

`backup` takes `--firmware DIR` (default: `FATHOM_FIRMWARE_DIR`), and `keys-file` takes
`--keys-dir DIR` (default `/var/lib/fathom/keys`). `FATHOM_BACKUP_KEY` names the backup key in the
same three shapes as the master key, default `file:///var/lib/fathom/keys/backup.key`.

Put the keys file and its phrase somewhere the data files are not, before you put a single design
in Fathom, and run `restore --check` on a real backup. A backup you have not opened is a guess.

**By hand**, as before, if you would rather not use the commands: tar the key volume on its own to
storage the database backups do not share, and `pg_dump -Fc` separately.

```sh
docker run --rm -v fathom_keys:/keys -v "$PWD":/out alpine \
  tar czf /out/keys-$(date +%F).tar.gz -C /keys .
docker compose exec db pg_dump -U fathom_bootstrap -d fathom -Fc -f /tmp/fathom.dump
docker compose cp db:/tmp/fathom.dump ./fathom-$(date +%F).dump
```

## The password vault

ADR-0071. Logins people store are sealed in their own browsers before they are sent; the server
keeps ciphertext it cannot open. What that means for you:

- **Back up the whole database.** The vault is its own schema, `vault`, next to `public`. The
  `pg_dump` commands above copy every schema; a dump limited with `--schema=public` loses every
  stored login.
- **The master key does not open the vault.** Losing `master.key` loses the server's own
  encryption; restoring it does not give anyone a stored password. Nothing you hold on the host
  does.
- **The recovery sheet belongs to the organisation's admins, not to you.** It is printed from
  Steward › Passwords, held by every new login, and each use is written to the organisation's
  history and listed for every admin. Advise admins to keep it on paper, away from the server.
- **A person who loses both their Emergency Kit and their passphrase** loses only their own copy:
  logins also held by a colleague or the sheet are shared to them again once they set up afresh.

### Logins Fathom itself can use, and `vault.key` (part two)

A login's owner can let Fathom use it, so that Auto-populate can sign in to the device. Fathom then
keeps a second copy, sealed by the server under a key derived from **`vault.key`**, a root key file
of its own beside `master.key` and `chain.key` (`FATHOM_VAULT_KEY`, default
`file:///var/lib/fathom/keys/vault.key`; the `db` container's start makes it, and a server started
without one makes it). The server refuses to start (exit code 10) if it is the same key as either
of the other two.

- **This copy is readable by the server.** It protects a stolen database or backup, not a
  compromised server: anyone who can read files as the `fathom` user, or the running process's
  memory, can open it. The owner is told so word for word and signs that they read it; when the
  login is shared with anyone else, a second admin signs too before Fathom uses it.
- **Back `vault.key` up with the other key files, never beside the database.** A database backup
  and `vault.key` together open every login Fathom can use.
- **Losing `vault.key` loses only Fathom's copies.** The people who hold each login still hold it,
  and any of them can hand Fathom a fresh copy. A restore with the wrong `vault.key` is named, not
  reported as corruption: each copy records the id of the key it was sealed under, and the server
  logs its own key's id at startup.
- **Every opening is on the record.** Each time Fathom opens a copy it writes a `vault_read` entry
  to the organisation's history first, then opens it, and only for a device the login is marked as
  used on, for someone who may draw in that design. Turning it off empties the copy at once; a
  backup taken while it was on still holds it, which the screen says too.

### Breach checks (part three)

Checks are off until an organisation's admin turns them on under Steward › Passwords, and the
policy has three levels, most specific first: one login marked critical (always checked, re-checked
weekly, a breached password refused), a kind of login (device login, SNMP, Wi-Fi, API key, other),
and the organisation (on or off, daily, weekly, every 30 or 90 days, warn or refuse). Each change
of policy, and each critical mark, is on the organisation's history.

**A refusal is the browser's, not the server's.** The server never sees a password, so it cannot
check one; the browser that saves a password refuses a breached one where the policy says so, and
records what it found. The server keeps only, per login and epoch, "found" or "not found" and when.
If the list cannot be reached, a save goes ahead and the login reads "Not checked yet".

The browser's Content-Security-Policy allows exactly one origin besides Fathom's own for this,
`https://api.pwnedpasswords.com`, in `connect-src`.

The check sends the first 5 hex characters of a password's SHA-1 to the Have I Been Pwned range
API, with padding, from the browser that holds the password; the password and the rest of its hash
never leave it. The HIBP API v3 page (read 2026-10-25) says "There is no rate limit on the Pwned
Passwords API" and asks only for a user agent and no use meant to limit availability. Fathom paces
itself anyway, so one organisation never looks like abuse from your address:

- at most 10 prefixes a second from one browser, 4 at a time;
- de-duplicated by prefix, so 100,000 passwords need at most 100,000 of the 1,048,576 prefixes,
  usually far fewer requests;
- batches of 500, oldest-checked first, resumed at the next unlock (checks run after an unlock, for
  the logins that person holds whose check is due);
- a full pass of 100,000 passwords is about three hours of unlocked time, spread over the week.

A browser must be able to reach `api.pwnedpasswords.com` for checks to run; behind a proxy that
blocks it, the Passwords pages say "Not checked yet" and nothing else changes. The request carries
`Add-Padding: true`, which a browser sends only after a CORS preflight; HIBP's page says CORS
"accepts all origins" on its non-authenticated APIs, but whether the range API answers that
preflight could not be established from the build machine (it cannot reach the API). The drive
answers it with a stand-in. If real browsers show "Not checked yet" for everything, that is the
first thing to look at.

### Outside vaults (part four)

A member can connect their own Vaultwarden, Delinea Secret Server or Passbolt, so Fathom reads logins from
one collection (one folder) in it. The server makes the requests, over HTTPS, to the address the
member types; your firewall must let the server reach it.

- **`FATHOM_OUTSIDE_VAULT_HOSTS`**: comma-separated host names. When set, members may connect
  vaults at these hosts only. Unset means any host the server can reach, which lets a member make
  the server send two fixed HTTPS requests to an address of their choosing; set it if the server
  sits beside services that should not be probed. Secret Server is four requests: a sign-in
  (`/oauth2/token`), its folders, its secrets, and one secret when Fathom uses it.
- **`FATHOM_OUTSIDE_VAULT_CA`**: a PEM file of certificates to trust beside Mozilla's roots, for a
  vault behind a private CA. The server refuses to start (exit code 10) if the file holds none.
  There is no setting that skips certificate checks.
- The API key and the organisation key, or Secret Server's account name and password, are sealed
  under `vault.key`, like Fathom's own copies: readable by the server, so the same backup rules
  apply. Disconnecting empties them; the key or password still works in the vault until someone
  changes it there.
- **Passbolt is optional.** It needs OpenPGP, which runs in a second container:
  `docker compose --profile passbolt up -d` starts `passbolt-helper` beside the server. It has no
  network, a read-only filesystem and no capabilities, and answers only on a Unix socket in the
  `passbolt-socket` volume, which the server mounts read-only and finds through
  `FATHOM_PASSBOLT_HELPER` (set in `compose.yaml`). Without the profile the helper does not run and
  Passbolt reads "Not on this server". It holds no key: Fathom's Passbolt key is sealed under
  `vault.key` like the others and sent to the helper for each step. Its packages are not in the
  server's lockfile; they have their own records and gate (`helpers/passbolt/`,
  `scripts/gate-passbolt-helper.sh`), and two advisories in them are ignored for the reason in
  ADR-0071 26. Each Passbolt read is a handful of requests (`/auth/verify.json`, the sign-in, then
  `/users/me.json`, metadata keys, folders and resources) and one secret when Fathom uses it.
  Fathom asks the person to confirm Passbolt's server key fingerprint at setup; get it from
  Passbolt's administrator, not from the same screen. An account with multi-factor sign-in cannot
  be used.
- **This is the only place the server's binary carries C**: rustls's `ring` provider (ADR-0032 C7's
  one exception, `deps/decisions/ring.md`). Building from source needs a C compiler; the published
  image's build stage has one.

### Termix (ADR-0078)

**`FATHOM_TERMIX_URL`** names one Termix (the self-hosted SSH manager), as an origin:
`https://termix.example.lan`, or `http://localhost:8080` for one on the same machine. A path, a user
name or anything else is refused at startup (exit code 2, like any malformed setting). Set, a device
with a management address gets "Open in Termix", and that one origin is added to the client's
`connect-src`. Unset, nothing changes.

- **The server never calls Termix.** People's browsers do, with their own Termix API keys, which a
  Termix admin makes (Termix › Users › API keys) and which never reach Fathom's server. So the
  browsers must reach Termix; the server need not.
- If Termix's operator set `CORS_ALLOWED_ORIGINS`, Fathom's own address must be in that list, or
  browsers are refused. Unset, Termix allows any origin.
- Fathom adds hosts to Termix with no user name and no password, tagged `fathom`: one device in the
  folder `Fathom`, or many from Inventory › Devices (Send to Termix) in `Fathom / <design>`. Credentials are Termix's to keep.
- **Who may use it.** Each person uses their own Termix key, so each sees what their Termix user
  can. Leaving `FATHOM_TERMIX_URL` unset turns it off for the whole deployment. Inside an
  organisation a steward turns it off for everyone (Organisation › People, the Termix box) or for one
  person (their page); each change is on the organisation's history as `termix_access_set`. That
  hides Termix in Fathom and stops the server giving out its address; it does not stop someone who
  knows the address opening Termix themselves. To take Termix from a person, revoke their key in Termix.

## Restore

ADR-0043 §4's stamp is what tells a wrong-key restore from corruption. The configured master key's
id and the configured chain key's id are each checked against a row in `master_keys` and
`chain_master_keys` — on every startup, and for the master key again on the first key use in every
write transaction, so a key file swapped under a running server is caught at the next write
(`crates/fathom-server/src/keys.rs::register_master_key`, `register_chain_master_key`).

If they do not match, the server refuses to start (exit code 11) rather than let the mismatch
surface as an AEAD tag failure that reads like corruption. The exact text, from
`MasterKeyError::Display`:

> this database was encrypted under master key `<stored>`, the configured key is `<configured>`.
> Nothing has been read or written. This is a wrong-key error and not corruption: point the server
> at the key file that belongs with this database, or restore the database that belongs with this
> key. Retired master keys are kept forever precisely so that an older backup stays readable.

The chain key has the same check with its own wording, because the failure it prevents is worse: a
missing `chain.key` is also silently regenerated at startup, and without this check every design's
history would report *broken at entry 1* — an operator error rendered as a forged history. Its
text names that explicitly: *"This is a wrong-key error and NOT a forged history... a missing one
is recreated at startup, which is why this check exists."*

**From a data file and its keys file.** `restore` reads both labels first and names the wrong keys
file (exit code 11) before it asks for the phrase or decrypts anything:

```sh
fathom-server restore fathom-2026-10-25.fdata --keys fathom-keys-2026-10-25.fkeys --out restored
#   restored/data/database.dump   for pg_restore
#   restored/data/firmware/       the staged images
#   restored/keys/                the key volume's files, at compose's modes
```

The phrase is read from the terminal, or from `FATHOM_RECOVERY_PHRASE`.

First get the data file: from the `backups` volume if the host survived (`docker compose cp
backup:/var/lib/fathom/backups/<name> .`), otherwise from the bucket or wherever you copied it.

**Into a fresh compose deployment**, in this order. The order matters: `db`'s start generates any key
that is missing, and its first start sets the `fathom` role's password from the key volume, so the
old keys must be in place before anything starts.

```sh
# 1. The key volume, from restored/keys, at compose's owners and modes:
docker volume create fathom_keys
docker run --rm -v fathom_keys:/keys -v "$PWD/restored/keys":/in:ro alpine sh -c \
  'cp /in/* /keys/ && chown 65532:65532 /keys/*.key && chmod 0400 /keys/*.key \
   && chown 0:0 /keys/*.pw && chmod 0444 /keys/*.pw'

# 2. The database: start db alone, make the two roles the migrations made (as `fathom`, so it
#    can manage them later), then restore as the superuser.
docker compose up -d db
docker compose exec -T db psql -U fathom -d fathom \
  -c 'CREATE ROLE fathom_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS' \
  -c 'CREATE ROLE fathom_operator NOLOGIN NOINHERIT'
docker compose exec -T db pg_restore -U fathom_bootstrap -d fathom --exit-on-error \
  < restored/data/database.dump

# 3. Firmware, if there was any, then everything else:
docker run --rm -v fathom_firmware:/fw -v "$PWD/restored/data/firmware":/in:ro alpine \
  sh -c 'cp -a /in/. /fw/ && chown -R 65532:65532 /fw'
docker compose up -d
```

The roles in step 2 are the ones `migrations/0005_planes.sql` and `0006_runtime_role.sql` create;
a dump carries a database, not the cluster's roles. They are made as `fathom` because a
`CREATEROLE` role may only alter roles it administers (seen on PostgreSQL 16, 2026-10-25: made by the
superuser instead, the server could not set the login and refused to start), and the server
sets `fathom_app`'s login at every start.

**Restoring correctly** means the database dump and the key archive it was taken alongside travel
together, even though they must never be *stored* together. Restore the database, put the matching
`master.key` and `chain.key` at the paths (or providers) your configuration names, and start the
server. A mismatch tells you immediately which key or which database is the wrong one; it never
guesses.

## Rekey

**There is no `rekey` verb in the binary today.** `fathom-server`'s subcommands are `healthcheck
[--addr HOST:PORT]`, `recover-operator <address>` (break-glass, its own section below),
`console-placement --reset` (also below), and `backup`, `keys-file` and `restore` (Backups, above) (`crates/fathom-server/src/main.rs`). `reissue-bootstrap-token`
is kept as a deprecated alias for `recover-operator`: ADR-0055 decision 8 folded it in on
2026-09-21, and it takes an optional address, falling back to `FATHOM_OPERATOR_NOTICE_ADDRESS`.

ADR-0043 §9's operator text says to "run `fathom rekey`" if you suspect the host was compromised —
that command does not exist yet, under that name or any other, and nothing in this repository wires
one up.

What does exist, as library code only, not reachable from any CLI subcommand or HTTP route: two
distinct key operations defined in `crates/fathom-server/src/keys.rs`
(`KeyOperation::{Rewrap,Rotate}`, `rewrap_master_key`), built to the rule
`docs/PHASE-2-STORAGE-DESIGN.md` §12.6 sets out —

- **re-wrap** changes custody only: the data keys are unchanged, only their wrapping under the
  master key changes. It revokes nothing — anyone holding the old master key and a copy of the key
  rows from before the switch can still decrypt everything, including data written afterwards.
- **rotate** re-encrypts: new data key, new ciphertext. It is the only one of the two that revokes
  anything.

Neither is exposed as something you can run today. When one is built as an operator-facing command,
it should follow §12.6's rule verbatim: the two operations must never share a verb, and no
configuration flag may accept "rotate" as a synonym for "re-wrap."

## The operator notice address and the quorum

`FATHOM_OPERATOR_NOTICE_ADDRESS` has no default (`crates/fathom-server/src/config.rs`). It is read
at every start but used only at the first: it is the address the first operator's account is
created against, and it is recorded once into `site_install`, where no role can update it
afterwards. Set it before your first start — a compose deployment refuses to come up at all without
it — because a deployment bootstrapped against a guessed address has an operator nobody can reach,
with no way to correct it short of destroying the database.

**`FATHOM_SINGLE_OPERATOR` is retired** (ADR-0055 decision 3). It used to remove the second
signature a settings change needed, for a deployment with genuinely one operator, and keep the
delay standing in its place. The server now refuses to start at all if it is set — naming the
variable and the decision, exit code 2 — rather than run with a switch that no longer does
anything: a control somebody believes is in force and is not is worse than a refusal. The quorum
today is `min(2, live independent operators)`, counted off the operator register at every act, not
declared anywhere: a sole operator's own request stands alone and applies after the 24-hour delay,
the same rule §3.5 already gave stewards, finally ported. Two operators is the standing
expectation, not a requirement — a sole operator is a supported, working shape, and the server
never blocks work over it. It says so, twice, at every start with one live operator: a warning
naming the count and quoting GitHub's own advice on the risk of one owner, and — separately —
that recovery by mail is unavailable until SMTP is set in the console, so the only recovery until
then is `fathom-server recover-operator`. Neither line is decoration; read them off a real start,
not off this page.

## The setup password

`FATHOM_SETUP_PASSWORD` (ADR-0057 decision 1) is a secret in `.env`, the same as any credential this
file names: it opens the first-run setup screen for thirty minutes after each start, while the first
operator has no stored password, and is otherwise inert. Put the value in single quotes — an
unquoted `$` or `#` changes it — and generate it with something like `openssl rand -base64 24`
rather than typing one. **Remove it from `.env` once setup is done, then run `docker compose up
-d`** — a plain `docker compose restart` does not re-read `.env`
(docker/compose `docs/reference/compose_restart.md`), so the old value stays live in the running
container until you do — the server warns at every start while it is still set and no longer
needed.

## Session timeouts and the address check

ADR-0057 decision 4 keeps a signed-in tab signed in across a reload, and bounds how long it stays
that way; decisions 6 and 7 add two further limits that a reload cannot undo. None of these are
configurable — see each number's own reasoning below for why.

**Idle and absolute limits**, enforced server-side in SQL against `now()`, never against this
process's own clock:

| Plane | Idle | Absolute |
|---|---|---|
| Account | 1 hour | 12 hours |
| Operator (Admin) | 15 minutes | 12 hours |

An idle session's row is deleted the moment a request is checked against it — not on a timer — and
that deletion is not a recorded sign-out, the same way an expired one is not. NIST SP 800-63B-4
(read 2026-09-25) gives AAL2 an idle bound of at most one hour and an absolute one of at most a day;
the account plane sits at that idle bound and well inside the absolute one. The operator plane's
fifteen minutes sits inside NIST's AAL3 figures, because the console is the more sensitive plane.
(It once matched the freshness window of an account session's second-factor proof; that window is
now the session's whole life, [`SECOND_FACTOR_FRESHNESS`](../crates/fathom-server/src/sessions.rs),
so one code per sign-in opens Admin — owner, 2026-10-12.) OWASP ASVS 5.0.0 7.1.1 asks that the
reasoning behind a number like this be written down; this is that writing.

**A reload keeps the account session, never the operator one.** Decision 4's non-extractable
session keypair survives a reload in `fathom-tab-sessions`, IndexedDB, one record per browser tab;
decision 6 keeps the operator (Admin) session out of that database entirely; a reload of a tab that
was in Admin always asks for a fresh verification code, however fresh the account session's own
proof still is. The grace decision 2 gives that proof (the session's life, since 2026-10-12) is itself gated on a token this
tab holds only in memory — never written anywhere — so a copied browser profile, which carries
everything IndexedDB does, still cannot skip the code. Restoring tabs after a browser restart is
the same reload, so a tab the browser brings back opens straight back into the account session it
held — no sign-in door — provided that session's own idle limit above had not already run out.

**`FATHOM_SESSION_ADDRESS_CHECK`** (decision 7), default `site`: a session whose requests start
coming from a different address than the one it signed in from is ended by it, on the operator
plane only. `all` ends an account session the same way; `off` checks neither. An account session is
never ended by this under the default, because laptops, VPNs and phones change address in the
ordinary course of things — mainstream products do not sign people out for it either — but the
change is recorded against the session regardless, for whoever reads it later. The check binds an
IPv4 address exactly and an IPv6 address by its `/64`, because RFC 8981's temporary addresses rotate
inside one `/64` without a network change. See `.env.example` for the three settings. With
`FATHOM_TRUSTED_PROXIES` unset, every client arrives as the proxy's own address (see above), so this
check compares the proxy with itself and never ends anything — set it for this check to mean
anything behind a proxy.

## Where the operator console answers

Since 2026-09-20 the console (`/admin/*` and `/enrolment/operator`) can be confined to host names
(`FATHOM_ADMIN_HOSTS`) and to source addresses or ranges (`FATHOM_ADMIN_SOURCES`), enforced by the
server, not the proxy (`crates/fathom-server/src/admin_exposure.rs`). A request that fails a
configured check is answered 404: on that host, from that address, the console does not exist.
The site is unaffected on every host. Two facts the proxy must get right for this to hold, the
same two the rate limiter needs: it forwards the original `Host`, and it is named in
`FATHOM_TRUSTED_PROXIES`, which is what lets its `X-Forwarded-For` be believed and nobody else's
(`crates/fathom-server/src/client_address.rs`). With neither variable set the console answers everywhere, and the
server logs a warning saying so at every start.

**Since 2026-09-21 (ADR-0055 decision 11) the console can also place itself**, from inside the
console, with no restart: an operator sets a host and source list there, the page warns what is
about to happen, the change applies at once and is sealed, and the browser is taken to the new
host. Signing in there inside the window (default five minutes, from one to sixty, cannot be
turned off) confirms it; if nobody does, the placement reverts on its own to the last confirmed one
— or to open, if there was none — and every operator session banners the revert.
`FATHOM_ADMIN_HOSTS` / `FATHOM_ADMIN_SOURCES` **win outright when set**: the console's own form
says so and goes read-only. If a confirmed placement locks everyone out and the host it pointed at
is gone — confirm-or-revert has nothing left to revert to — `fathom-server console-placement
--reset`, run on the host where the key volume is mounted, clears it: sealed, loud, and it mints
nothing and grants nobody anything. The console then answers wherever the environment variables
say, or everywhere if neither is set.

**Every console request and every sign-in is logged with the client's address** (since
2026-10-27, `crates/fathom-server/src/access_log.rs`): one `access` line in the server's log with
`plane` (`operator console` or `sign-in`), method, path without its query, status, `client` and
`via`, and the `Host` it asked for. `client` is the address the rule above believes; `via` is the
connection's own peer, normally your proxy. If the two are always the same proxy address, the
proxy is not named in `FATHOM_TRUSTED_PROXIES`. Requests the console refuses off its hosts are
logged too, as `status=404`. Nothing from a request body is logged. The lines go to the
container's standard output, so `docker compose logs server` shows them and your log collector
keeps them as long as you tell it to.

**The sealed history keeps the same two addresses.** Every site entry written while a request is
served (operator and steward sign-ins, refused sign-ins, and every act on the console) carries
`client` and `via` in its sealed, encrypted metadata, so they cannot be changed afterwards.
Entries written before 2026-10-27 have neither. **Admin › Activity** shows these entries newest
first: when, what, who, from (`client`) and through (`via`), with filters for sign-ins and
refusals. It reads them out of the sealed history and checks each entry's seal before showing it;
one that does not verify is shown as such, and that is an incident: the row was changed in the
database.

**To send the access lines to a log server too**, set `FATHOM_ACCESS_SYSLOG=host:port`: one RFC
5424 line per request over TCP, LF-framed, app name `fathom-access`, the plane as MSGID
(`operator_console` or `sign-in`) and `method= path= status= client= via= host=` as the message.
It is separate from `FATHOM_AUDIT_SYSLOG` because these lines carry addresses and the audit lines
carry none; both may name the same server. **It is best effort**: a line the server cannot send
within three seconds, or while the log server is down, is dropped, and the server's own log says
when the log server stops and starts answering. Nothing is lost that matters: the server's own
log keeps every line and the sealed history keeps the addresses. TLS is not offered; put the log
server on the same private network, or a local rsyslog in front that forwards over TLS.

## The audit trail

Every sealed history entry is also queued in the database (`audit_spool`) to be shipped to a log
server you name with `FATHOM_AUDIT_SYSLOG=host:port` (RFC 5424 over TCP). **Unset, nothing ships**:
the entries stay in the database, the start says the deployment is `unwitnessed` (nothing off this
machine holds a copy), and design writes carry on as normal.

**Set, the queue is a measure of how far behind the log server is.** If the oldest unshipped entry
is older than `FATHOM_AUDIT_SPOOL_MAX_AGE` seconds (default 72 hours), or the queue is larger than
`FATHOM_AUDIT_SPOOL_MAX_BYTES` (default 1 GiB), design writes stop and reads carry on, and a save
says so: *"this design was NOT saved: the audit trail spool has passed its age bound"*. They resume
by themselves once the log server takes the backlog. Until 2026-10-28 the bound held with no log
server named too, so every install that never set one stopped saving designs 72 hours after its
first write; updating the server ends that, and nothing queued is lost.

## AI connections

ADR-0072. AI access is off in every organisation until a Steward turns it on, and Admin › AI turns it
off for the whole server at once (a reason is asked and shown to every organisation's Stewards).

**The connector** lets Claude, Claude Code and, if a Steward allows them, other AI apps sign in to Fathom
the way they sign in to any remote MCP server. It exists only when this is set:

| Variable | What it is |
|---|---|
| `FATHOM_AI_PUBLIC_URL` | The address AI apps reach this server at, `https://host[:port]`, no path. Apps add `<this>/mcp`. `http://` only to a loopback host, for one computer. Unset: no `/mcp`, no `/oauth/*`, no `/.well-known/oauth-*`. |
| `FATHOM_AI_SIGN_IN_URL` | Optional. Where a person's browser signs in, when that is a company address the AI vendor cannot reach. Default: the public address. |
| `FATHOM_AI_CLAUDE_RANGES` | Comma-separated ranges a Claude (claude.ai) connection may be used from. Default `160.79.104.0/21`, Anthropic's published outbound range (platform.claude.com/docs/en/api/ip-addresses, read 2026-10-25), also when empty. `off` switches the check off. |

**What has to be reachable.** Claude's hosted apps call from Anthropic's cloud: they need `/mcp`,
`/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/oauth/token` and
`/oauth/register` from that range. The sign-in page, `/oauth/authorize`, is opened by the person's own
browser and may stay internal (`FATHOM_AI_SIGN_IN_URL`). Claude Code and the helper run on the person's
computer and reach Fathom wherever the person can. The source-address check needs the proxy named in
`FATHOM_TRUSTED_PROXIES`, as the sign-in rate limit does.

**Without the connector.** AI access does not need `FATHOM_AI_PUBLIC_URL`. A person can still connect an
app on their own computer with the Fathom AI helper, which Fathom serves at `/fathom-ai.mjs` and which
calls `/ai/v1/*` with a key the person made on that computer (Steward › AI › Connect an AI app ›
"It uses a key"; docs/EXAMPLES.md §9). Fathom stores only the key's public half.

**Stopping one.** A person, a Steward (with a reason) or an admin (with a reason) turns a connection off
at its next request; it cannot be turned back on. Tokens are stored only as hashes: a database copy
cannot be used to call `/mcp`.

## Firmware space and uploads

Staged images live in the `firmware` volume, outside the database. Three numbers keep them from
crowding out anything else (sign-off r62, ADR-0064 amendment of 2026-10-31):

| Setting | Default | What it limits |
|---|---|---|
| `FATHOM_FIRMWARE_MAX_BYTES` | 2 GiB | One image |
| `FATHOM_FIRMWARE_ORGANISATION_MAX_BYTES` | 20 GiB | One organisation's staged images, plus declared ones whose upload can still start |
| `FATHOM_FIRMWARE_TOTAL_MAX_BYTES` | 50 GiB | Every `.img` and `.part` file in the staging directory |

**Set the total below what the volume can hold.** Fathom does not read the disk's free space (std
has no portable call for it, and reading it needs a dependency not yet approved), so this number is
the guard. If the volume shares a disk with PostgreSQL, leave room for the database to grow too.
Both space checks run when an image is declared, before any bytes are sent, and refuse with `507`
saying how much is held.

**The file's numbers are where the server starts** (sign-off r71). On Admin › Firmware an admin
saves any of the three, the two upload counts, the stall time and the download address; a saved
value wins over the file's until Reset, without a restart. Below them, each organisation has a
**ceiling** (empty: the per-organisation number above) and a **lock**. A Steward sets their own
organisation's total, at most the ceiling, and the address their devices download from, on Steward ›
Firmware. While an organisation is locked its Stewards' values do not count and they see your reason.
Each change is sealed: the server's on the site chain, an organisation's on its own chain too, so
its Stewards read it; each row also carries a seal, and a row whose seal does not check is shown as
such on Admin › Firmware and refused when firmware is read for an upload. A one-time download link
names one image, so devices never need a port each and the server never picks an image by the
address a request came from.

Uploads: one at a time per organisation and three per server process, refused with `429` (the
upload token stays good). An upload that sends nothing for two minutes is dropped and its partial
file deleted. Behind a load balancer each server counts its own uploads; the organisation total is
read from the database, so it holds across all of them. Device downloads are not limited.

Before each download the server reads the image again and compares its SHA-256 with the one computed
at upload. A file changed on disk is refused with `500` and logged as an error; restage it from the
vendor's download.

**The weekly re-check.** Once an hour the server looks for staged images it has not hashed for seven
days and hashes them again, one at a time, so it reads one file at once and never competes with
uploads for more. An image that no longer matches, or whose file is gone, is marked (its page and
the list say so) and logged as a warning that names the image; it is never sent. If one appears,
compare the firmware volume with a backup before trusting anything else on it. An image staged
before the re-check existed gets its SHA-512 at its first re-check, and only once its SHA-256 has
matched. Each server runs its own re-check; two servers re-checking the same image is harmless.

**Retiring frees space.** Nothing else ever removes an image. A Steward can retire one from its
page: the server seals `firmware_retired` on the organisation's chain, marks the row `retired`,
then deletes the file. The record and every fetch of it stay. If the file can't be deleted, the
log says so and the image still serves nothing, but its bytes count against the totals until you
remove the file named `<image id>.img` from the firmware volume.

## Break-glass: recovering an operator from the host

ADR-0055 decision 8, in its own words: *"Break-glass is a host command, loud."* `fathom-server
recover-operator <address>`, run where the key volume is mounted, works for an operator who
**already exists** and is not disabled. It prints a one-shot ten-minute setup code to stdout — and
only to stdout, never to the log, never to a file — that lets that person set a new password and
set up a new authenticator app. **It also dispossesses whoever holds that seat right now**: every operator
key on the seat is retired, every live session of both the account and the operator is ended
(as sealed revocations, which a restore does not undo), the authenticator and its recovery codes are
cleared, and any seat hold from a mailed reset is cleared — so a stolen browser loses its access
the moment the command runs. **It mints no new operator**: an address nobody is bound to gets a
refusal and nothing is written. There is no delay, on purpose — the host already holds every key
(ADR-0043 §2), so a delay here would be theatre, not protection; what protects this act is custody
of the host plus the record that it happened, the same shape Microsoft Entra uses for emergency
access accounts. Every use appends a sealed `operator_recovered_from_host` entry to the site chain,
notifies every live operator, and **banners every operator session for seven days**
(`GET /admin/notices`). `reissue-bootstrap-token` is kept as a deprecated alias, folded into this
command: it takes an optional address, falls back to `FATHOM_OPERATOR_NOTICE_ADDRESS`, and prints a
line saying it is deprecated.

**Rehearse this every 90 days** — the cadence ADR-0055's own research names, from Microsoft Entra's
guidance on emergency-access accounts (*"validated at least every 90 days"*). Run it against a real
deployment, confirm the code signs in, confirm the seven-day banner appears in every operator's
session, and confirm the sealed entry is on the site chain where `GET /admin/notices` and a chain
read both expect it.

## Pinning a host to one build

Written 2026-10-25 for the Alpha host. A pinned host runs one image until you change `.env`, however
many merges land on `main`. Compose only; from source you are already on the commit you built.

**1. Pick the build.** A release tag (`v0.1.0-alpha.1`) is the usual pick: `.github/workflows/release.yml`
names an image `main` already published, without rebuilding it, after checking its provenance says
`publish.yml` built it from that commit on `main`. The run's summary prints the two lines step 3
needs. Any merged commit works too, as `sha-<the 40-hex commit>`. Either way, read the digest
yourself:

```sh
docker buildx imagetools inspect ghcr.io/keyxmakerx/fathom-server:v0.1.0-alpha.1
#   Digest:    sha256:<64 hex>      <- this one
```

**2. Back up the keys and the database, separately, and look at both.** The new build may run
forward-only migrations on its first start, and the pin is only worth having if you can go back.
These are the commands from Backups above, plus a look inside each file, because a backup you have
not opened is a guess:

```sh
# The key volume, to its own destination:
docker run --rm -v fathom_keys:/keys -v "$PWD":/out alpine \
  tar czf /out/keys-$(date +%F).tar.gz -C /keys .
tar tzf keys-$(date +%F).tar.gz          # lists master.key, chain.key and the *.pw files

# The database, to a different destination:
docker compose exec db pg_dump -U fathom_bootstrap -d fathom -Fc -f /tmp/fathom.dump
docker compose exec db pg_restore --list /tmp/fathom.dump | head   # a table of contents, not an error
docker compose cp db:/tmp/fathom.dump ./fathom-$(date +%F).dump
docker compose exec db rm /tmp/fathom.dump
```

Move the two files to different places before going on. Staged firmware lives in the `firmware`
volume; back it up too if you want images to survive (the database keeps only their hashes).

**3. Pin.** In `.env`, beside the file `compose.yaml` reads:

```sh
FATHOM_TAG=v0.1.0-alpha.1
FATHOM_DIGEST=sha256:<the 64 hex from step 1>
```

With both set the image is `name:tag@sha256:…`, and the digest is what gets pulled: if the tag were
ever pushed again, this host would not follow it. `FATHOM_TAG` alone also pins, but to a name rather
than to bytes. Check what compose will run before it runs it:

```sh
docker compose config | grep 'fathom-server:'
#   image: ghcr.io/keyxmakerx/fathom-server:v0.1.0-alpha.1@sha256:<64 hex>
```

The backup service's image, `ghcr.io/keyxmakerx/fathom-backup`, carries the same tag and is
promoted by the same release run, which prints its digest as `FATHOM_BACKUP_DIGEST`; set that too
to pin it to bytes as well.

**4. Start it and check.** `docker compose up -d`, then:

```sh
docker compose ps server                                    # running, healthy
docker image ls --digests ghcr.io/keyxmakerx/fathom-server   # a row with sha256:<the same 64 hex>
```

…and the list under "What to check after an upgrade" below.

**To leave the pin**, delete both lines and `docker compose up -d`: the host follows `latest` again.
**To move it**, repeat from step 1; step 2 is not optional for a move, for the same reason.

## What to check after an upgrade

- **Upgrading from a build before ADR-0055 (2026-09-21):** the first start of the new build does
  two things, in this order, and logs both. First it re-seals every `operators` row an older build
  wrote (the row seal gained a field in the fix round; a row that verifies under the old shape is
  re-sealed under the new one, and a row that verifies under neither refuses the start as
  tampering). Then it binds the operator the old build created to the install address on record,
  retires that operator's browser keys and ends their sessions (the old flow had no second
  factor). The log says `UPGRADE:`. Since ADR-0057 decision 1 (2026-09-24) no token is written
  anywhere: with `FATHOM_SETUP_PASSWORD` set and passing the account password policy, the same
  thirty-minute setup window opens for the adopted operator as for a first start — see §"Sign in"
  of `docs/RUNNING-IT.md`. The act is a sealed `operator_adopted` entry on the site chain, once;
  every later start finds the binding and does nothing. Three shapes are refused and logged
  instead of bound, with the address named: the account at that address is disabled; it is already
  bound to another operator; the bootstrapped operator is disabled. If the address already holds an
  account with a confirmed authenticator, no setup window is offered, whoever holds that account
  now holds the operator custody, and the log says so. Operators the old console created beside the
  first one have no binding either; they cannot sign in, the start lists them, and they should be
  disabled from the console. `recover-operator` refuses an unbound operator, so run the server once
  on the new build before reaching for it.
- The startup log line naming `master_key_id` and `chain_key_id` — the same ids as before the
  upgrade. If the server exits instead with a wrong-key error, see Restore above; it did not start.
- The migration count in the startup log — it should match what you expect for the version you
  installed, and the server refuses to start rather than run with some migrations missing.
- The catalogue load line — a catalogue that will not parse is a refusal to start, not a warning.
- `GET /health` returns `200`.
- If you run `FATHOM_AUDIT_SYSLOG`, that the receiving end is still getting entries; if you do not,
  the log still says `unwitnessed` at every start, which is expected and not a new problem.
