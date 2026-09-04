# fathom-server — `43` §5.4's posture, built for `49` §5's architecture.
#
# TWO STAGES, AND THE SECOND ONE HAS NOTHING IN IT. The runtime image is
# distroless: no shell, no package manager, no curl. That is why the binary
# carries its own `healthcheck` subcommand (see `src/healthcheck.rs`) — adding
# curl to a production image so a probe can run would put a network tool in the
# container to solve a problem the binary can solve in forty lines.
#
# EVERY IMAGE IS PINNED BY DIGEST, NEVER BY TAG. `35` §7.4: the digest is the
# artifact; the tag is a pointer. Digests read 2026-09-03. Changing one is a
# deliberate act, and it shows up in a diff.

# ---- build ----------------------------------------------------------------
FROM rust@sha256:cf09adf8c3ebaba10779e5c23ff7fe4df4cccdab8a91f199b0c142c53fef3e1a AS build

# The BASE IMAGE IS the pinned toolchain -- `rust:1.94.1-slim` is 1.94.1, the
# same version `rust-toolchain.toml` pins -- so this says so and rustup stops
# there. Without it, rustup reads the toolchain file, sees its `targets` and
# `components` lines, and goes to the network to install a wasm32 target this
# image will never build. Pinning the digest above and then downloading a
# toolchain at build time would also make the build depend on rust-lang.org
# being reachable, which is one more thing between a checkout and a binary.
#
# **If this version and rust-toolchain.toml's ever disagree, the build is
# wrong**, and the check below is what says so rather than silently building
# with whichever one won.
ENV RUSTUP_TOOLCHAIN=1.94.1

# An enterprise network that re-terminates TLS at an egress proxy is the normal
# case in the environments this product is deployed into, not an exception --
# and without its CA, `cargo` inside this stage cannot reach crates.io and the
# build dies with `invalid peer certificate: UnknownIssuer`, which reads like a
# broken Dockerfile rather than a trust setting. Drop the certificates in
# `deploy/ca/`; see the README there for what this does and does not widen.
#
# BUILDER STAGE ONLY. The runtime image below is distroless and carries the
# binary and nothing else, so nothing here reaches the running server.
COPY deploy/ca/ /usr/local/share/ca-certificates/fathom-extra/
RUN if ls /usr/local/share/ca-certificates/fathom-extra/*.crt > /dev/null 2>&1; then \
        update-ca-certificates; \
    else \
        echo "no extra CA certificates; using the image's trust store"; \
    fi

WORKDIR /src
COPY . .

RUN pinned=$(grep -E '^channel' rust-toolchain.toml | sed 's/.*"\(.*\)".*/\1/') && \
    if [ "$pinned" != "$RUSTUP_TOOLCHAIN" ]; then \
        echo "rust-toolchain.toml pins $pinned; this image is $RUSTUP_TOOLCHAIN" >&2; \
        echo "Update the FROM digest and RUSTUP_TOOLCHAIN together." >&2; \
        exit 1; \
    fi && rustc --version

# --locked, always. ADR-0032 §4: a cargo command without it may rewrite
# Cargo.lock, and a build that resolves its own dependencies is a build that
# ships something nobody reviewed.
#
# --profile server, not --release: the workspace release profile is tuned for
# the WASM module and sets panic = "abort", which would turn one panicking
# request into a whole-server outage. See the comment on [profile.server] in
# the workspace Cargo.toml.
RUN cargo build --locked --profile server -p fathom-server

# ---- artifact -------------------------------------------------------------
# The browser product: one self-contained HTML file with the WASM module inside
# it. This is what a demo actually shows — the server stores nothing until WO-12
# is executed, so without this the stack serves a health endpoint and nothing a
# person can look at.
#
# THIS STAGE DELIBERATELY DOES WHAT THE SERVER STAGE DELIBERATELY AVOIDS. The
# comment on RUSTUP_TOOLCHAIN above explains that pinning it stops rustup
# fetching a wasm32 target "this image will never build". That is true of the
# server stage and false here: the artifact EMBEDS the WASM module, so the
# target is required and the network call is unavoidable rather than accidental.
# It is in its own stage so the server image is unaffected either way.
FROM build AS artifact

RUN rustup target add wasm32-unknown-unknown && \
    cargo build --locked --release --target wasm32-unknown-unknown -p fathom-wasm && \
    cargo run --locked -p fathom-artifact

# ---- web ------------------------------------------------------------------
# Caddy with the product baked in, so ONE ORIGIN serves both the page and the
# API. That is not a convenience: the pivot (`49`) makes the browser a window
# onto the server, so the destination has one origin, and standing a second
# container up beside it to serve static files would be scaffolding pretending
# to be architecture.
#
# WHEN TO DELETE THIS STAGE: when the server serves the application itself.
# Then `caddy` goes back to the digest-pinned upstream image with no COPY, and
# the Caddyfile loses its `file_server` block. Written down because scaffolding
# with no removal condition is still there in a year being explained to someone.
#
# The base is the same digest the compose file pinned before this stage existed,
# so `35` §7.4 still holds — the digest is the artifact, the tag is a pointer.
FROM caddy@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648 AS web

COPY --from=artifact /src/target/artifact/fathom-dev.html /srv/index.html

# ---- run ------------------------------------------------------------------
FROM gcr.io/distroless/cc-debian12@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f

COPY --from=build /src/target/server/fathom-server /fathom-server

# 65532:65532 is distroless's `nonroot`. The compose file says so as well; both
# say it so that neither alone is load-bearing.
USER 65532:65532

EXPOSE 8080
ENTRYPOINT ["/fathom-server"]
