# Extra CA certificates for the build

Drop `.crt` files here (PEM, one certificate per file) and `deploy/Dockerfile` will trust them
inside the **builder stage only**.

## Why this exists

An enterprise network that re-terminates TLS at an egress proxy is the normal case in the
environments this product is deployed into, not an exception. Without this, `cargo` inside the
builder cannot reach crates.io and the build fails with `invalid peer certificate:
UnknownIssuer` — which reads like a broken Dockerfile rather than a trust configuration.

**This was not hypothetical.** The session that wrote `deploy/Dockerfile` (2026-09-03) hit exactly
that: the sandbox it ran in routes outbound HTTPS through a proxy with its own CA, and the first
build died fetching `axum`.

## What it does NOT do

The certificates here are added to the **builder** stage. The runtime image is distroless and
carries only the binary — nothing here reaches it. So this widens what the build machine trusts
while fetching dependencies, and changes nothing about what the running server trusts.

**A CA added here can sign for any host.** That is what a TLS-inspecting proxy is. It does not
weaken the controls that matter for what actually lands in the binary: `Cargo.lock` pins every
crate by checksum, `--locked` refuses to re-resolve, and `scripts/gate-zero.sh`, `deny.toml`,
`cargo audit` and the cooldown all run before anything compiles. A proxy that can see the traffic
still cannot substitute a crate without failing the lockfile's checksum.

Certificates are gitignored: the ones an organisation uses are its own, and a repository is the
wrong place for them.
