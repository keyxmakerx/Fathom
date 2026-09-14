# Running Fathom — 2026-09-14

Two ways to start it: **from source**, which is verified below and is what you want today, and
**Docker Compose**, which is not yet verified and has a known first-start fault being fixed. Both
end in the same place: a server, a browser client, and one operator who can invite people.

**Read `docs/STATE.md` for what is and is not built.** The short version: you can sign in, and there
is no diagram yet. The canvas is the next block of work.

---

## What you need

- **PostgreSQL 16.** Anything that can run a recent PostgreSQL is fine; it does not have to be on
  the same machine.
- **Rust**, the version `rust-toolchain.toml` pins. `rustup toolchain install` reads it.
- **Node 22 or newer**, for the browser client.
- **Two 32-byte keys.** Instructions below. Losing them loses the data; there is no recovery path
  and that is deliberate (ADR-0043).

---

## From source

### 1. A database, and two roles that are not the same role

Fathom uses two database roles on purpose and refuses to start if you collapse them. The
**migration** role owns the schema and can create roles. The **runtime** role has data privileges
only, and the server checks at startup that it is neither a superuser nor exempt from row-level
security — because PostgreSQL ignores row-level security for superusers, and tenant isolation
through a superuser would pass every test while protecting nothing.

```sh
psql -h 127.0.0.1 -U postgres -d postgres \
  -c "CREATE ROLE fathom LOGIN PASSWORD 'change-me' NOSUPERUSER CREATEROLE;" \
  -c "CREATE DATABASE fathom OWNER fathom;"
```

The runtime role is not created here. The server creates it during migration, which is how "run the
chain from an empty database" produces the whole fence rather than half of it.

### 2. The keys

```sh
mkdir -p /var/lib/fathom/keys
head -c 32 /dev/urandom > /var/lib/fathom/keys/master.key
head -c 32 /dev/urandom > /var/lib/fathom/keys/chain.key
chmod 600 /var/lib/fathom/keys/*.key
```

**Back these up somewhere your database backups are not.** A backup that contains both halves is a
backup that contains your data in the clear to whoever holds it. The server says this at every
startup, which is not decoration.

### 3. Start the server

```sh
cargo build --release -p fathom-server

DATABASE_URL="postgres://fathom_app:CHOOSE-ONE@127.0.0.1:5432/fathom" \
FATHOM_MIGRATE_DATABASE_URL="postgres://fathom:change-me@127.0.0.1:5432/fathom" \
FATHOM_SCHEMA_ROOT="$PWD/schema" \
FATHOM_MASTER_KEY="file:///var/lib/fathom/keys/master.key" \
FATHOM_CHAIN_KEY="file:///var/lib/fathom/keys/chain.key" \
FATHOM_OPERATOR_NOTICE_ADDRESS="you@example.com" \
FATHOM_BIND="127.0.0.1:8080" \
./target/release/fathom-server
```

`FATHOM_OPERATOR_NOTICE_ADDRESS` has no default on purpose. It is the address the first operator is
created against, and a guessed default would bootstrap an operator nobody can reach.

A first start applies every migration, loads both keys, writes `deployment_started` to the audit
chain, loads the equipment catalogue, and **creates the first operator with a one-time enrolment
token**. The token is written to a file and never to the log, because logs get shipped off the
machine and a token in a log is a token in whatever holds the logs. The log names the path.

Startup refuses rather than half-working. A catalogue that will not parse, a key it cannot read, a
schema tree that fails a gate, a database role that turns out to be a superuser: each one is an exit
with a reason, not a server that runs with a piece missing.

### 4. Start the client

```sh
cd client
npm ci --ignore-scripts          # --ignore-scripts is not optional, see below
npm run dev
```

`--ignore-scripts` stops package install scripts running on your machine. That is exactly how the
August 2026 registry attack worked, and disabling it costs nothing here.

The dev server proxies API calls to `127.0.0.1:8080`. Override with `FATHOM_API_PROXY_TARGET` if
your server is elsewhere.

### 5. Sign in

Open the client, redeem the operator token from step 3, and let the browser generate your key. There
is no password anywhere in this product, and no self-registration: every account arrives by
invitation.

### Verified on 2026-09-14

Run here against a real PostgreSQL 16, from an empty database:

```
migrations applied                        15
keys loaded                               master + chain
site chain                                deployment_started, operator_bootstrapped,
                                          enrolment_token_issued
catalogue loaded                          1 model
GET /health                               200
GET /schema/kinds                         200
GET /catalogue/models                     401  (session required)
GET /organisations/{org}/designs          401  (session required)
GET /nope                                 404
client dev server                         200
API call through the client's proxy       401 from the real server
restart                                   one operator, no re-bootstrap
```

---

## Docker Compose

`deploy/compose.yaml` builds a two-container deployment behind Caddy, with the database passwords
generated at first start and the images pinned by digest rather than by tag.

**It has never been started end to end, and it has a known first-start fault.** The key volume is
mounted read-only, correctly, and the first-start operator token is currently written beside the key
— so the first start fails. The fix, in progress, moves the token to its own writable volume and adds
a way to re-issue it if it is lost before anyone redeems it. **This section will say "verified" when
somebody has actually run it, and not before.**

Docker is not available in the environment this repository is developed in, so the compose path can
only be proven on your machine.

---

## What does not work yet

- **There is no diagram.** The client has a shell, a sign-in, and a page showing the five port
  glyphs. Racks, faceplates and cables are the next block of work.
- **Nothing is emailed.** There is no mail path at all, so an invitation is a token you hand over
  yourself, and the two-operator interlock on settings refuses correctly but notifies nobody.
- **Nothing talks to a live device.** Everything comes from pasted text.
- **The audit trail is unwitnessed** unless you set `FATHOM_AUDIT_SYSLOG`. Without it, every entry is
  sealed and stored, and nothing outside the machine holds a copy — so whoever holds the machine
  holds all of it. The server says so at startup.
