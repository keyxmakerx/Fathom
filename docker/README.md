# Running Fathom in Docker

```
docker compose up -d          # http://127.0.0.1:8080
docker compose down
```

Or, if you just want the file and no server:

```
docker build --target artifact -o out .    # writes out/fathom.html
```

## The one thing worth understanding first

**A config you paste is parsed in your browser. The server never receives it.**
The page has `connect-src 'none'` in its own CSP and makes no network requests
of any kind — it is one HTML file with the WebAssembly module inlined as base64.
So the server is a static file server that hands you one file and then has
nothing to do with what you do next. That holds even if the server is
compromised.

**The converse is the risk that does exist.** A compromised server could serve a
*modified* page, and a page's own CSP cannot protect you from a page that was
replaced. That is what the hardening below is for, and it is why the runtime
image is read-only, unprivileged and contains exactly one file.

## What is hardened, and why

| | |
|---|---|
| **Unprivileged image** | `nginxinc/nginx-unprivileged` — runs as uid 101, never root, listens on 8080 so no privileged port is needed |
| **`read_only: true`** | The container writes nothing. nginx's scratch dirs are `tmpfs`, `noexec,nosuid,nodev` |
| **`cap_drop: ALL`, `no-new-privileges`** | A static file server needs no capability at all |
| **Loopback-only publish** | `127.0.0.1:8080:8080`. Plain `8080:8080` publishes on every interface *and* bypasses most host firewalls, because Docker writes iptables rules ahead of yours |
| **GET and HEAD only** | Everything else is 405 before any handler runs |
| **No `error_page` → app** | Deliberate. Mapping errors onto the app would answer a rejected POST with 200 and a copy of Fathom |
| **`server_tokens off`** | No version in responses or error pages |
| **Memory and pid limits** | 128 MB, 64 pids. If you hit these, something is wrong rather than busy |

## The two traps

### 1. Do not add a `Content-Security-Policy` header

The page carries its own, in a `<meta>` tag, and it is strict. **When a page has
both a meta CSP and a header CSP, the browser enforces both — the effective
policy is the intersection.** So a header CSP that omits `'wasm-unsafe-eval'`
does not add security, it **breaks the app**: the WebAssembly module stops
instantiating and Fathom cannot read a config at all.

Exactly one CSP directive is sent from the server, and it is the one that
**cannot** be set from a meta tag: `frame-ancestors 'none'`. Browsers ignore
`frame-ancestors` in `<meta>` by specification, so the server is the only place
it can live — and it restricts nothing the page itself does, so it cannot break
it.

**If your reverse proxy injects a CSP header of its own, this is the thing that
will break, and the symptom will be "the paste button does nothing".**

### 2. Do not add CORS headers

There is nothing to allow. Fathom makes no cross-origin requests because it
makes no requests. An `Access-Control-Allow-Origin` header would grant other
origins the right to read this page's responses in exchange for nothing.

The correct CORS policy here is the absence of one. The headers that *are* sent
are the opposite of permissive — `Cross-Origin-Opener-Policy: same-origin`,
`Cross-Origin-Embedder-Policy: require-corp`,
`Cross-Origin-Resource-Policy: same-origin` — and they say *nobody embeds this,
nobody reads this cross-origin*.

## Behind a reverse proxy

Terminate TLS at the proxy. Keep `ports:` bound to loopback, or drop it entirely
and put the proxy in the same compose project.

```nginx
# TLS terminator -> Fathom
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;

    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # Fathom reads NONE of these headers — it has no backend logic. They are
    # here for your logs, not for the app, which is worth knowing: there is no
    # header-spoofing attack surface to defend, because nothing consumes them.

    # Do NOT add a CSP here. See trap 1. If your proxy adds security headers
    # globally, exclude this location or make sure the policy keeps
    # 'unsafe-inline' and 'wasm-unsafe-eval' on script-src, and worker-src blob:.
    # Do NOT add Access-Control-Allow-Origin. See trap 2.
}

# HSTS belongs here, at the TLS edge, not in the container.
add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
```

### Cosmos Cloud — checked, and nothing needs disabling

Cosmos injects headers, and it has a per-route **Disable Header Hardening**
switch that looks like it might be required. **It is not.** Leave it off, and
leave the route's CORS Origin field empty.

The reason is that Cosmos's injected CSP is exactly one directive —
`Content-Security-Policy: frame-ancestors 'self'` (`src/utils/middleware.go:160`).
It sets no `script-src`, so it cannot intersect away `'wasm-unsafe-eval'` and
cannot break the module. Trap 1 above is the thing that would have bitten, and
Cosmos does not trip it.

What Cosmos does to the headers this container sends, on default settings:

| Header | What happens |
|---|---|
| `Content-Security-Policy: frame-ancestors 'none'` | Deleted, replaced with Cosmos's `'self'`. Marginally weaker; the `X-Frame-Options: DENY` below survives and still blocks framing |
| `X-Content-Type-Options` | Deleted, then re-set to the same `nosniff` |
| `Strict-Transport-Security` | Not sent by this container. Cosmos sets it when serving HTTPS |
| COOP, COEP, CORP, `Permissions-Policy`, `Referrer-Policy`, `Cache-Control` | Untouched |
| `Access-Control-Allow-Origin` | Cosmos **adds** one, set to your own Cosmos hostname (not `*`), with credentials. Same-origin, so it grants nothing — trap 2 is not violated |

Turning header hardening **on** is what strips and re-sets those; turning it
**off** would also stop Cosmos deleting `Access-Control-Allow-Origin` headers
from upstreams and stop it setting `nosniff` and HSTS. Off is the worse
posture, and Fathom does not need it.

Verified by reading the source, not from memory (ADR-0034): `azukaar/Cosmos-Server`
at commit `2470b36`, dated 2026-08-02 — `src/utils/middleware.go:151-186`
(`SetSecurityHeaders`, `CORSHeader`), `src/proxy/routeTo.go:242-249` (the six
`resp.Header.Del` calls, guarded by `DisableHeaderHardening`),
`src/proxy/routerGen.go:193-237` (`originCORS` defaulting to the configured
hostname). Checked 2026-08-10. **Not tested against a running Cosmos instance** —
this is a source reading, and the first deployment is still the test.

**Authentication.** The app holds no data and the server sees no config, so
there is nothing on the server to protect. Put basic auth or SSO at the proxy if
you want to control *who can reach the tool*, not because the tool is storing
anything.

## The published image

`.github/workflows/publish.yml` builds the `serve` stage on every push to `main`
and pushes it to **`ghcr.io/keyxmakerx/fathom`**.

| Tag | When |
|---|---|
| `latest` | every push to `main` — use this one |
| `main` | every push to `main`, same image |
| `sha-<full commit>` | every build — pin to this to reproduce one |
| `v1.2.3` | on a `v*` git tag push |

**A tag that does not exist fails as `denied`, not `not found`.** GHCR does not
distinguish a missing tag from one you are not allowed to see, so the error for a
typo'd tag is indistinguishable from an authentication problem and will send you
looking at credentials. If a pull is denied, check in this order: does the
workflow exist on `main` and has it actually run; does that exact tag appear in
the package; and only then, is the package private.

```
docker pull ghcr.io/keyxmakerx/fathom:latest
docker run --rm -p 127.0.0.1:8080:8080 ghcr.io/keyxmakerx/fathom:latest
```

**Pull by digest for anything you care about**, not by tag — a tag is a moving
pointer, a digest is the image. Each run prints the digest, the commit and the
SHA-256 of the served page into its GitHub Actions job summary.

Every published image carries a signed provenance attestation binding it to the
commit and workflow that produced it. For Fathom this is not decoration: the
entire security story is *the page you are running is the page we built*, and
this is how that stops being something you take on trust.

```
gh attestation verify oci://ghcr.io/keyxmakerx/fathom:latest --repo keyxmakerx/Fathom
```

The image is `linux/amd64` only. No arm64 — it would need a cross toolchain for
both the wasm and native builds, and nobody has asked for it.

Two things about the workflow worth knowing. It runs the **full verification
floor inline before building**, duplicating `ci.yml`, because `needs:` does not
reach across workflow files and a failing `ci.yml` would not otherwise stop a
publish. And it uses **no GitHub Actions build cache** — that cache is writable
by any run on the repository, which is a place to plant a layer that ends up
inside a published image, and it would save about twenty seconds.

**After the first publish, check the package's visibility.** A GHCR package is
not automatically public. If it is private, either make it public in the
package's settings, or give Cosmos a registry credential (a PAT with
`read:packages`) — otherwise the pull fails with an authentication error that
reads like the image does not exist.

## Deploying under Cosmos Cloud

Cosmos runs images; it does not build them. There is no `build:` field in its
container schema, so `docker-compose.yml` above cannot be handed to it — point it
at `ghcr.io/keyxmakerx/fathom:latest` instead.

Set `cosmos-auto-update` to **false**. Updates should come from a merge you made,
not from a nightly pull.

### Do you even need this container?

Cosmos has a `STATIC` route mode that serves a directory itself with Go's file
server (`src/proxy/routeTo.go:375`), so in principle you could skip the container
and point a route at a directory holding `index.html`.

**Don't.** You would lose gzip — Go's file server does not compress, and this is
a 1.1 MB mostly-base64 file — and you would lose every security header in
`nginx.conf` except the four Cosmos sets itself, which does not include
`X-Frame-Options`, `Referrer-Policy`, COOP/COEP/CORP, `Permissions-Policy` or
`Cache-Control`. The nginx container is 23 MB doing exactly one job, and that job
is the deployment's whole hardening story.

### Three things that will bite

1. **`http://fathom:8080` does not resolve by default.** Cosmos dials the target
   from inside its own container using Docker's embedded DNS, so Cosmos must be
   a member of the same network. Add `"cosmos-network-name": "auto"` to the
   service's labels and Cosmos creates a network and joins itself to it.
   Otherwise every request to the route fails DNS and you get a 502.
2. **Four hardening fields are dropped silently.** `read_only`, `pids_limit`,
   `tmpfs` and `logging` have no equivalent in the Cosmos container schema. None
   of them is the first line of defence — the first line is that this server has
   no handler an attacker can reach — but two of them compound: without
   `read_only` *and* without the `noexec` tmpfs, `/tmp` becomes a writable,
   executable scratch directory inside the container. That matters only after
   someone already has code execution, but it turns a one-shot compromise into a
   persistent one. `mem_limit` **is** supported, as a units string (`"128m"`, not
   an integer of bytes; an unparseable value aborts the whole service creation),
   so use the field rather than `docker update` — the field survives a redeploy
   and `docker update` does not. Only `pids_limit` genuinely needs
   `docker update --pids-limit 64 fathom`, re-applied after every deploy.
   `docker update` has no `--read-only` flag, so that one cannot be recovered
   that way at all.
3. **Leave SmartShield off for this route.** If a client trips its budget
   mid-response it emits a 503 header after bytes are already on the wire, which
   truncates the 1.2 MB single-file response.

Cosmos also strips this container's `Content-Security-Policy` header and
substitutes its own, so **the CSP line in `nginx.conf` is inert behind Cosmos**.
The framing posture weakens from `'none'` to `'self'`; `X-Frame-Options: DENY`
survives and preserves the intent.

**Authentication stops being optional here.** The advice above assumes loopback.
The moment this is a public hostname, put auth on the Cosmos route.

## Alternative: bind-mount, no custom image

If you would rather not pull an image at all, the `serve` stage is only stock
`nginx-unprivileged` plus two files, so you can bind-mount both from appdata.

**This trades away the property the published image exists to provide**: the
served page moves from an immutable, content-addressed image layer to a
host-writable file. For a tool where someone pastes a firewall config into the
page, a swapped page with a modified CSP could exfiltrate that config while every
other control here still passes. If you go this way, record the hash and check
it.

```bash
mkdir -p /mnt/user/appdata/fathom/{html,conf}

# Build the artifact anywhere that has Docker; the serving box needs no Rust.
docker build --target artifact -o /tmp/fathom-out .

install -m 644 /tmp/fathom-out/fathom.html /mnt/user/appdata/fathom/html/index.html
install -m 644 docker/nginx.conf           /mnt/user/appdata/fathom/conf/default.conf
chmod 755 /mnt/user/appdata/fathom /mnt/user/appdata/fathom/{html,conf}

sha256sum /mnt/user/appdata/fathom/html/index.html   # write this down; see below
```

`index.html` should be about **1.1 MiB**. Anything in the kilobytes is a failed
or truncated build. Create both directories *before* the first deploy: if they
are missing, Cosmos creates them `0750` owned by `101:101`, which is the opposite
of leaving them world-readable and is why the "just rely on the other-read bit"
advice only works when you got there first.

Then point Cosmos at `nginxinc/nginx-unprivileged:alpine` with the html directory
mounted read-only at `/usr/share/nginx/html`, the conf file read-only at
`/etc/nginx/conf.d/default.conf`, `user: 101:101`, `cap_drop: ALL`,
`no-new-privileges`, no published ports, and a Cosmos route to
`http://fathom:8080`.

### What the build actually needs from the network

**Not crates.io.** The workspace has zero third-party dependencies, so no crate
is ever fetched. What it does need is `static.rust-lang.org`: `rust-toolchain.toml`
declares the `wasm32-unknown-unknown` target, and rustup downloads that standard
library on the first cargo call. On a locked-down box, allowlisting crates.io and
not `static.rust-lang.org` fails the build *at the first instruction*, with an
error that names a host the plan never mentioned.

Worth saying plainly: **a crates.io request during this build is a supply-chain
event, not background noise.** Stop and find out why.

The compile is roughly 22 seconds cold on four cores. It is not a long build;
there is no third-party code to compile. The image pulls dominate.

### Two more traps, specific to bind-mounting

The Cosmos traps listed above still apply. These two are additional, and both
fail quietly:

1. **Verify the mounts really landed read-only.**
   `docker inspect -f '{{json .HostConfig.Mounts}}' fathom` must show
   `"ReadOnly":true` on both. Read-only mounts are the *only* compensating
   control you have left once `read_only` is gone, and their absence is
   completely silent — the app works perfectly either way. Related: opening the
   container's Volumes tab in the Cosmos UI and clicking save converts both
   mounts to read-write and recreates the container, with no warning. Change
   mounts by editing the compose, never in that tab.
2. **Mounting a single file that does not exist yet** makes Docker create a
   *directory* at that path. The container then fails with "not a directory", and
   the sting is that your fix — copying the file in — lands it *inside* the stray
   directory, so the next attempt fails identically. Install the file first, or
   mount the whole `conf/` directory over `/etc/nginx/conf.d` and sidestep it.

And one that fails quietly in the other direction: if `nginx.conf` lands anywhere
other than `/etc/nginx/conf.d/default.conf`, the image's own default config is
still there. The `default_server` on this file's `listen` line is there to win
that fight, but check anyway — one command tells you which block answered:

```
curl -sI https://<host>/ | grep -i x-frame-options
```

Empty means a different server block is serving the page, and every header in
`nginx.conf` is silently absent.

## What has not been tested

**`docker-compose.yml` and the `Dockerfile` have not been built or run** on a
machine with a working Docker daemon in this project's history. The first
`docker compose up` is the test.

**`docker/nginx.conf` has been executed** against a real
`nginxinc/nginx-unprivileged:alpine` container: `nginx -t` is clean with zero
warnings, a sibling container on a user-defined network fetched
`http://fathom:8080/` and got 200 with the full header set, and both the
IPv6-listen failure and the `gzip_types` warning were reproduced before being
fixed. What has *not* been tested is any of it against a running Cosmos instance
— the Cosmos findings above are a reading of its source at commit `2470b36`
(2026-08-02), checked 2026-08-11.
