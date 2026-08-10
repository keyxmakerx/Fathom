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

**Authentication.** The app holds no data and the server sees no config, so
there is nothing on the server to protect. Put basic auth or SSO at the proxy if
you want to control *who can reach the tool*, not because the tool is storing
anything.

## What has not been tested

**These files have not been built or run.** They were written on a machine with
no Docker daemon, so the Rust build, the nginx config syntax and the compose
schema are all unverified by execution. The first `docker compose up` is the
test. If the nginx config has a typo the container will fail to start and say
which line.
