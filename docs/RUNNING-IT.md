# Running Fathom — 2026-09-19

Two ways to start it: **from source**, which is verified below and is what you want today, and
**Docker Compose**, which nobody has yet run end to end and which needs one thing done by hand
first. Both end in the same place: a server, a browser client, and one operator who can invite
people.

**Read `docs/STATE.md` for what is and is not built.** The short version, current as of
2026-09-19 (read the actual page for the rest; this paragraph is corrected here because an
earlier draft of this file said the client was a shell with no diagram, which stopped being true
several sessions ago): you sign in, land on Home, and draw a rack-first network diagram with
React Flow — racks, devices, ports and cables, a rear elevation, shelves and wall-mounted gear,
a view-only config drawer behind the redaction gate, and an inventory with notes and undo. What
is still missing: nothing is emailed, nothing talks to a live device, and the credential vault
(private notes, secrets) is not built yet.

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

See `docs/OPERATING.md` for the key file, backups, restore, rekey and the operator notice address —
the full operator's register ADR-0043 §9 requires.

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

The browser engine (the paste box and the config drawer's redaction gate, ADR-0052 §1) ships as a
file, not a package, and is not checked in — `client/public/engine/` is gitignored. Build it once,
from the repository root, before the client can use either surface:

```sh
./scripts/build-wasm.sh
```

Then:

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

### Verified on 2026-09-14, from source

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

From a clean checkout, on a machine with Docker:

```sh
cp .env.example .env         # then set FATHOM_OPERATOR_NOTICE_ADDRESS in it
docker compose up -d
```

That pulls the two images GitHub built from the last merge to `main`
(`ghcr.io/keyxmakerx/fathom-server` and `fathom-caddy`, pushed by `.github/workflows/publish.yml`
after the same gate floor CI runs, with provenance attested per image). `docker compose up -d
--build` builds the same two stages from the checkout instead, which is what CI does and what to
do on a machine that cannot reach the registry. To freeze a deployment on one build, set
`FATHOM_TAG=sha-<the 40-hex commit>` in `.env`; `latest` follows `main`.

**If a pull is refused, the package is private.** GitHub's documentation says a package first
published under a personal account is private whatever the repository's visibility ("Configuring
a package's access control and visibility", read 2026-09-19); in practice the first publish on
2026-09-19 came out public, both images listable anonymously from `ghcr.io` within minutes.
Should a pull ever be refused, either make the package public from its page under the
repository's Packages (not reversible) or `docker login ghcr.io` with a personal access token
that can read packages.

Then open <https://localhost:8443/>. The certificate is Caddy's own local one, so the browser will
warn once. To sign in the first time, read the one-time token the first start wrote and paste it
into the enrolment screen:

```sh
docker compose cp server:/var/lib/fathom/bootstrap/first-operator-token ./first-operator-token
cat ./first-operator-token
```

The token is a bearer secret with one use; delete both copies once redeemed. If it is lost before that,
`docker compose run --rm server reissue-bootstrap-token` mints another, and refuses the moment any
operator key has ever been enrolled.

**What the stack does for itself.** A one-shot `keys-init` container runs first and generates,
into the `keys` volume, whatever is missing: the master key and the chain key (mode 0400, owned by
the server's uid) and the three database passwords (bootstrap, migration, runtime; mode 0444). A
restart keeps what exists. **Copy that volume somewhere your database backups are not before the
first design goes in**; there is no recovery path without it, by design (`docs/OPERATING.md`).

**What is required of you.** `FATHOM_OPERATOR_NOTICE_ADDRESS`, and nothing else. It is recorded
once, at first start, and cannot be changed afterwards; a default would create an operator nobody
can reach. `FATHOM_HTTPS_PORT` moves Caddy off 8443 if you need to.

**What runs.** Three containers plus the one-shot: PostgreSQL 16, the server (distroless,
read-only root, unprivileged, not published to the host), and Caddy terminating TLS and serving
the client, routing exactly the paths the server serves and nothing else (the Caddyfile, inline in
`compose.yaml`, enumerates them from the server's own routers). Every image is pinned by digest. The server reads
the client's address from the `X-Forwarded-For` header Caddy overwrites on every proxied request,
so the sign-in rate limit counts per client rather than per proxy.

**Proven where.** `.github/workflows/ci.yml`'s `compose` job builds every image from the checkout
on every push and pull request (under a tag no registry holds, so it never pulls a published image
in place of the one it built), brings the stack up, waits for the server's healthcheck, asks
Caddy for `/health` and the client over TLS, reads the first-operator token, restarts the server
and checks the keys were kept. Before 2026-09-19 nobody had run this file at all, because the
environment it was written in has no Docker daemon; three first-start faults were found by
reading it, and the fourth (the database container could not write into a root-owned volume) by
reading it again when the first three were fixed. The published images
(`.github/workflows/publish.yml`, on every merge to `main`) are the same two stages.

**In a compose front end (Arcane and the like).** `compose.yaml` is self-contained: the Caddyfile
and the two first-start scripts ride inside it as inline `configs`, so nothing has to exist on the
host beside it. Two ways in, read from Arcane's source on 2026-09-19 (it drives Compose through
the `docker/compose` library, v5, which knows inline configs):

- **From the repository.** A GitOps sync pointed at this repository with the compose path
  `compose.yaml`; the repository carries no `.env`, so put `FATHOM_OPERATOR_NOTICE_ADDRESS` in the
  project's environment in Arcane, which it writes beside the compose file as `project.env` and
  merges into `.env`.
- **Pasted.** Create a project, paste this file's contents as the compose file, and put
  `FATHOM_OPERATOR_NOTICE_ADDRESS=you@example.com` in its environment. Leave `FATHOM_TAG` unset for
  the newest published build, or pin `sha-<commit>`. The `build:` sections are ignored unless a
  build is asked for; the images are pulled.

Either way the first-operator token is read the same way as above; a front end's console on the
`server` container will not do, because the image has no shell, so use `docker compose cp` from a
terminal on the host.

**Backups and everything after.** `docs/OPERATING.md`.

## What does not work yet

Corrected 2026-09-19 against `docs/STATE.md`, which is the page of record — read it, not this
list, for anything more specific than the headline gaps below:

- **The diagram is real** (racks, cables, a rear elevation, shelves and wall-mounted gear, a
  view-only config drawer, an inventory with notes and undo), **but the credential vault is
  not built.** Private notes and device secrets have nowhere to live yet.
- **Nothing is emailed.** There is no mail path at all, so an invitation is a token you hand over
  yourself, and the two-operator interlock on settings refuses correctly but notifies nobody.
- **Nothing talks to a live device.** Everything comes from pasted text, through the redaction
  gate.
- **The audit trail is unwitnessed** unless you set `FATHOM_AUDIT_SYSLOG`. Without it, every entry is
  sealed and stored, and nothing outside the machine holds a copy — so whoever holds the machine
  holds all of it. The server says so at startup.
