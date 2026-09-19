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

`deploy/compose.yaml` builds a three-container deployment (PostgreSQL, the server, and Caddy in
front of both), with the database passwords generated at first start and the images pinned by
digest rather than by tag.

**Nobody has run it end to end. Docker is not available in the environment this repository is
developed in, so the compose path can only be proven on your machine, and until you do, treat this
section as reasoning rather than evidence.** Everything below this stack's own shape was written
without ever running `docker compose up` — read `deploy/Dockerfile`, `deploy/Caddyfile` and
`deploy/compose.yaml` themselves, which carry a comment on every line that is a decision rather
than boilerplate, for the reasoning this page only summarises.

**The stack's shape, as of 2026-09-19: Caddy now serves the client, not only the API.**
`deploy/Dockerfile` gained two build stages — `client-build` (Node, pinned by digest like every
other image here) runs `npm ci && npm run build` against the same checkout the server builds
from, and a `caddy` stage bakes that build's `client/dist` into `/srv/www` on top of the same
pinned Caddy image the stack already used. `deploy/Caddyfile` now routes every path
`crates/fathom-server`'s own routers actually serve (`/session`, `/organisations`, `/catalogue`,
`/admin`, `/enrolment`, `/firmware`, `/health`, `/schema/kinds` — enumerated, not wildcarded, the
same choice `client/vite.config.ts`'s dev-time proxy already made) to the `server` container, and
serves everything else as a static file from `/srv/www`. Before this change the compose stack
brought up a server and a proxy with nothing at all for the proxy to serve except the API; a
browser pointed at `https://localhost:8443/` got nothing.

Also fixed in the same change: `deploy/Dockerfile` used to copy `schema/` into the server image
but not `corpus/`, and `main.rs` loads the equipment catalogue from `corpus/`'s being beside
`schema/` — so the containerised server refused to start with a catalogue error. `corpus/` is now
copied alongside `schema/`.

Beyond the catalogue and the client above, two more first-start faults have been found by reading
this stack. The first is fixed; the second needs one action from you.

**Fixed:** the first-start operator token was written beside the master key, and the key volume is
mounted read-only on purpose, so the server could not start. The token now has its own writable
volume, `FATHOM_BOOTSTRAP_TOKEN_FILE` points at it, and the key volume is unchanged.

**You must do this: generate the two keys before the first `compose up`.** The server creates them
itself when they are missing, which is right when you run it from source and impossible in the
container, because it would be writing into the read-only key volume. Seed the volume first:

```sh
docker volume create fathom_keys        # match your compose project's volume name
docker run --rm -v fathom_keys:/keys alpine sh -c '
  head -c 32 /dev/urandom > /keys/master.key
  head -c 32 /dev/urandom > /keys/chain.key
  chown 65532:65532 /keys/master.key /keys/chain.key
  chmod 400 /keys/master.key /keys/chain.key'
```

`65532` is the unprivileged user the distroless image runs as. The server refuses to load a key file
that is readable by anyone but its owner, which is why the mode matters and why the database
container's generated password files are a separate, world-readable thing.

**Generating the keys yourself is better than letting the server do it, and not only because of the
mount.** It puts the backup conversation at the start, where it belongs. Copy that volume somewhere
your database backups are not, before you put a single design in. There is no recovery path and that
is deliberate (ADR-0043).

`FATHOM_OPERATOR_NOTICE_ADDRESS` must be set in your environment; the compose file requires it rather
than defaulting it. The install record it feeds is write-once by design, no role can update it, and
organisation enrolment claims are pinned to it, so a plausible-looking placeholder would be
permanently wrong in any deployment that did not read the comment.

**The sign-in rate limit's source bucket, fixed 2026-09-19.** Behind any reverse proxy, every
request the server sees arrives from that proxy's own address unless told otherwise
(`src/config.rs`'s own comment on `FATHOM_TRUSTED_CLIENT_IP_HEADER`) — and this stack puts Caddy
in front of the server, so without that variable set, every sign-in attempt from every real
client shared one rate-limit bucket. `deploy/compose.yaml` now sets
`FATHOM_TRUSTED_CLIENT_IP_HEADER=X-Forwarded-For`, and it is safe to set only because
`deploy/Caddyfile` overwrites that exact header on every proxied request with the address Caddy
itself accepted the connection from (`header_up X-Forwarded-For {remote_host}`), rather than
trusting whatever a client sent — a deployment that set the variable without that guarantee would
let a client pick its own rate-limit bucket instead.

**If you lose the first-start token before redeeming it**, `fathom-server reissue-bootstrap-token`
issues another. It refuses the moment any operator key has ever been enrolled, including a retired
one, because a re-issue that still worked after that would be a way for anyone who can run a command
on the host to make themselves an operator.

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
