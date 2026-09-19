# Operating Fathom

This is the operator's register ADR-0043 §9 requires: what you must know about the master key
before you run this in production. Plain, second person. Every command below exists in the tree;
where one does not exist yet, this says so rather than inventing it.

Sources: `docs/decisions/adr-0043-the-master-key-is-a-file-and-the-vault-takes-two-secrets.md`,
`docs/PHASE-2-STORAGE-DESIGN.md` §11–§13, `crates/fathom-server/src/{config.rs,keyprovider.rs,keys.rs,main.rs}`,
`deploy/compose.yaml`, `deploy/init-db/10-app-role.sh`.

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

## Backups

**Never put the key volume and a database backup in the same archive.** In a compose deployment the
`keys` volume holds `master.key`, `chain.key`, and — since `deploy/init-db/10-app-role.sh` — the
generated passwords for both database roles. Anyone holding that volume and a database dump (or
replica, or `SELECT`-capable credential) has both the ciphertext and everything needed to unwrap
it. A backup routine that tars every volume, which is the ordinary self-hosted habit, would put
both halves in one file.

**From source:**

```sh
# The key volume, on its own, to storage the database backups do not share:
tar czf keys-$(date +%F).tar.gz -C /var/lib/fathom keys
scp keys-$(date +%F).tar.gz backup-host:/offsite/fathom-keys/

# The database, separately:
pg_dump -h 127.0.0.1 -U fathom -d fathom -Fc -f fathom-$(date +%F).dump
```

**Compose:**

```sh
# The key volume:
docker run --rm -v fathom_keys:/keys -v "$PWD":/out alpine \
  tar czf /out/keys-$(date +%F).tar.gz -C /keys .

# The database, from the db container:
docker compose exec db pg_dump -U fathom -d fathom -Fc -f /tmp/fathom.dump
docker compose cp db:/tmp/fathom.dump ./fathom-$(date +%F).dump
```

Copy the key archive off the machine before you put a single design in it, and test a restore with
it. The server says the same thing in its startup log every time it loads the keys.

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

**Restoring correctly** means the database dump and the key archive it was taken alongside travel
together, even though they must never be *stored* together. Restore the database, put the matching
`master.key` and `chain.key` at the paths (or providers) your configuration names, and start the
server. A mismatch tells you immediately which key or which database is the wrong one; it never
guesses.

## Rekey

**There is no `rekey` verb in the binary today.** `fathom-server`'s only subcommands are
`healthcheck [--addr HOST:PORT]` and `reissue-bootstrap-token` (`crates/fathom-server/src/main.rs`).
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

## The operator notice address and the interlock

`FATHOM_OPERATOR_NOTICE_ADDRESS` has no default (`crates/fathom-server/src/config.rs`). It is read
at every start but used only at the first: it is the address the first operator is created against,
and it is recorded once into `site_install`, where no role can update it afterwards. Set it before
your first start — a compose deployment refuses to come up at all without it — because a
deployment bootstrapped against a guessed address has an operator nobody can reach, with no way to
correct it short of destroying the database.

`FATHOM_SINGLE_OPERATOR` is the documented escape for a deployment with genuinely one operator.
Ordinarily, changing a setting needs two operators' signatures and a delay; this flag removes the
second signature. **It does not remove the delay** — the delay is what gives anyone a chance to
notice a change before it takes effect, and with one operator it is the only thing left standing
between a compromised operator and a changed setting. Fathom records that the deployment is running
in this mode on the site chain at startup, with a warning in the log, rather than leaving it as
something only your environment file remembers.

## What to check after an upgrade

- The startup log line naming `master_key_id` and `chain_key_id` — the same ids as before the
  upgrade. If the server exits instead with a wrong-key error, see Restore above; it did not start.
- The migration count in the startup log — it should match what you expect for the version you
  installed, and the server refuses to start rather than run with some migrations missing.
- The catalogue load line — a catalogue that will not parse is a refusal to start, not a warning.
- `GET /health` returns `200`.
- If you run `FATHOM_AUDIT_SYSLOG`, that the receiving end is still getting entries; if you do not,
  the log still says `unwitnessed` at every start, which is expected and not a new problem.
