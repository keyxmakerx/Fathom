# Running Fathom with Docker

> **Status: written 2026-09-04, NOT RUN.** Every line below follows from files in this
> repository, but the session that wrote it could not execute it: pulling a base image is
> refused by that environment's egress policy (403 on `production.cloudfront.docker.com`).
> **Treat the first run as the test.** §5 lists what to expect if a step is wrong, so a
> failure tells you which line to look at rather than sending you back here.

## 1. What you get, and what you do not

One origin, `https://localhost:8443`, serving **the browser product** — the whole tool as a
single self-contained page: inventory, diagram, finder, findings, cabling, and pasting a
device config to build an estate. Behind it, the enterprise shape: **PostgreSQL as its own
service**, the server as a distroless read-only container that binds no host port, and TLS
terminated in front.

**What the server does NOT do yet, and you should know before you demo it: it stores
nothing.** WO-11 created exactly one table, the migrations table, and its acceptance gate
G8 forbids any other until the key boundary is built (ADR-0040). `/health` is its only
route. **So the page holds your work in the browser, not on the server** — that is
WO-12's job and WO-12 is written but not executed.

This matters for what you claim in the room. See §4.

## 2. Bring it up

```sh
cd deploy
umask 077                                                    # the file is created owner-only
echo "POSTGRES_PASSWORD=$(openssl rand -base64 24)" > .env   # no default, on purpose
chmod 600 .env                                               # and stays owner-only
docker compose up --build
```

**Every secret this stack needs lives in `deploy/.env` and nowhere else** — the owner's rule,
2026-09-04 (`70` §20.9): never inline in `compose.yaml`, never with a default, and the file is
git-ignored (`.gitignore` carries `deploy/.env`) and owner-only. When the vault arrives, its
credential goes in the same file under the same rule.

Then open **https://localhost:8443**.

Two things about that first run:

- **The build compiles Rust twice** — once for the server, once for the WASM module the page
  embeds — so it is slow the first time and cached afterwards.
- **Your browser will warn about the certificate.** `tls internal` uses Caddy's own
  certificate authority, which is right for a local bring-up and wrong for anything else.
  For a real host name, replace `localhost:8443` in `Caddyfile` and drop `tls internal` so
  Caddy gets a publicly trusted certificate.

Behind a corporate TLS-inspecting proxy, drop the CA certificate into `deploy/ca/` before
building or `cargo` cannot reach crates.io — see the note in `Dockerfile`.

Check the server half separately:

```sh
curl -k https://localhost:8443/health
docker compose ps          # all three healthy
```

## 3. What each piece is, and why

| service | what it is | why it looks like this |
|---|---|---|
| `db` | PostgreSQL, its own service, **not published to the host** | Nothing outside the compose network reaches it, which is also what lets the driver run without TLS |
| `server` | `fathom-server`, distroless, `read_only`, all capabilities dropped, non-root, **binds no host port** | It is reachable only through Caddy. A directly reachable server would be a plaintext endpoint that works, which is how that mistake survives |
| `caddy` | TLS in front, and the product baked in | TLS terminates here so the server's dependency closure stays free of C and C++ (`49` §6). The baked-in page is temporary — see below |

**The page is served by Caddy today and that is scaffolding with a stated end.** The pivot
makes the browser a window onto the server, so the destination has one origin serving both.
Until the server can serve the application, the `web` stage in `Dockerfile` bakes the page
into Caddy. The removal condition is written next to it.

## 4. Demoing this honestly

The strongest thing here is that **it never had to phone home to be useful**: paste a device
configuration into the page and it builds an estate, names every line it did not understand,
and destroys credentials at the gate before anything is stored. That is a live demo, not a
slide.

Three questions an enterprise reviewer asks in the first meeting, with the honest answers:

- **"Where do the keys live?"** Decided, not built: ADR-0040 puts a data key per tenant and
  per design behind a master key, with the custody switch designed so a customer-supplied key
  replaces the house key by re-wrapping keys rather than re-encrypting data. Which service
  holds the master key is `OPEN-FOR-THE-OWNER.md` §A1 and is open.
- **"Is there an audit log?"** Not yet, and it is §A2 on that page. A record started later
  can never cover the period before it existed, which is the whole of the trade.
- **"Can you read our network map?"** Today the server holds nothing to read. After WO-12 it
  will hold ciphertext and the keys to it, and §B2 — whether an operator may open a customer's
  design — has no answer on paper yet.

**Four sentences are forbidden in writing until a customer holds their own key** (ADR-0040
§6): *zero-knowledge*, *end-to-end*, *we cannot read your data*, *only you hold the key*. A CI
check enforces it. The one that is true and worth saying: **device credentials are protected
by never arriving** — the redaction gate destroys them in the browser, before anything is sent.

## 5. If it does not come up

| symptom | cause | fix |
|---|---|---|
| `set POSTGRES_PASSWORD` | No `.env` | §2's first command. There is no default: a default database password is a password everyone has |
| `invalid peer certificate: UnknownIssuer` during build | Corporate TLS interception | Put the proxy CA in `deploy/ca/` |
| TLS handshake fails with no useful message | A site address with no host name for `tls internal` to issue for | Keep `localhost:8443`, do not change it to `:8443` |
| Database starts, then reports an incompatible data directory | An old volume mounted at `/var/lib/postgresql/data` | The mount is one level up, at `/var/lib/postgresql`. Found by running it, 2026-09-03 |
| Page loads but is blank | The `web` stage did not get the artifact | `docker compose build --no-cache caddy`, and check the `artifact` stage ran `cargo run -p fathom-artifact` |
| `/health` returns 503 | The server is up and the database is not | That is the health check doing its job. `docker compose logs db` |

## 6. Without Docker

The page is one file and needs no server at all:

```sh
cargo build --locked --release --target wasm32-unknown-unknown -p fathom-wasm
cargo run --locked -p fathom-artifact      # writes target/artifact/fathom-dev.html
```

Open that file from disk. It makes no network request. That is the fastest way to show the
product, and it is how every browser driver in `docs/80-review/evidence/` runs.
