# Fathom in a container — build the artifact, then serve it.
#
# WHAT THIS CHANGES, AND WHAT IT DOES NOT.
#
# Fathom is one HTML file with everything inline. It needs no server and normally
# you double-click it. This exists so you can run it on a lab box or hand a URL
# to somebody without copying files around.
#
# The product's posture is unchanged: the page makes zero network requests, has
# `default-src 'none'` and `connect-src 'none'` in its own CSP, and never touches
# a device. **A config you paste is parsed in your browser and is never sent
# anywhere** — the server is a static file server and receives none of it. That
# holds even if the server is compromised.
#
# What IS different from opening the file off your disk: a web server now exists,
# and anyone who can reach the port gets the app. And a compromised server could
# serve a MODIFIED page — the page's own CSP cannot protect you from a page that
# was replaced. That is why the runtime image is read-only, unprivileged, and
# holds exactly one file. It is a deployment decision, not a product change, and
# it is written here rather than left to be discovered.
#
# Three ways to use it:
#   docker compose up -d                       # serve on 127.0.0.1:8080
#   docker build --target artifact -o out .    # just write out/fathom.html
#   docker build -t fathom . && docker run --rm -p 127.0.0.1:8080:8080 fathom

# ---------------------------------------------------------------- build ----
# Pinned to rust-toolchain.toml's channel. That file also declares
# `targets = ["wasm32-unknown-unknown"]`, so rustup installs the wasm target on
# the first cargo invocation — no separate `rustup target add` is needed, and
# adding one would let the two drift.
FROM rust:1.94.1-slim AS build
WORKDIR /src

# The assembler shells out to `cargo build --target wasm32-unknown-unknown`
# (crates/fathom-artifact), so the toolchain must be present when that binary
# RUNS, not only when it compiles. Hence a full builder stage.
COPY . .

# --locked on every invocation. A cargo command without it may rewrite
# Cargo.lock, so an unlocked step silently repairs the lockfile a later locked
# step was meant to catch — the same reason ci.yml carries it (ADR-0032 §4).
RUN cargo run --locked -p fathom-artifact \
 && test -s target/artifact/fathom-dev.html

# ------------------------------------------------------------- artifact ----
# `docker build --target artifact -o out .` writes the single file to ./out and
# builds no image at all. For when you want the file, not a server.
FROM scratch AS artifact
COPY --from=build /src/target/artifact/fathom-dev.html /fathom.html

# ----------------------------------------------------------------- serve ----
# The UNPRIVILEGED nginx image: runs as uid 101, never as root, and listens on
# 8080 rather than needing a privileged port. Using it is why this container
# needs no `user:` override and no capabilities at all.
FROM nginxinc/nginx-unprivileged:alpine AS serve

# Replace the default site entirely rather than adding beside it, so nothing
# ships that this file did not put there.
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/target/artifact/fathom-dev.html /usr/share/nginx/html/index.html

# The image serves exactly one file and needs to write nothing, so it runs
# read-only. docker-compose.yml supplies the tmpfs mounts nginx wants for its
# scratch directories.
EXPOSE 8080

# `wget --spider` rather than curl: it is in busybox, already present, and adds
# nothing to the image.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:8080/ || exit 1
