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

# ---- toolchain --------------------------------------------------------
# Shared by every Rust stage below (`build`, native, and `wasm-build`, for the
# browser engine) so the CA-trust and toolchain-version setup is written once.
FROM rust@sha256:cf09adf8c3ebaba10779e5c23ff7fe4df4cccdab8a91f199b0c142c53fef3e1a AS toolchain

# The BASE IMAGE IS the pinned toolchain -- `rust:1.94.1-slim` is 1.94.1, the
# same version `rust-toolchain.toml` pins -- so this says so and rustup stops
# there rather than going to the network to resolve one on its own. Pinning
# the digest above and then downloading a toolchain at build time would also
# make the build depend on rust-lang.org being reachable, which is one more
# thing between a checkout and a binary. `wasm-build` below still adds the
# `wasm32-unknown-unknown` target explicitly, on top of this same pinned
# toolchain, rather than let rustup fetch it from `rust-toolchain.toml`'s
# `targets` line on its own.
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

# ---- build (native, fathom-server) ---------------------------------------
FROM toolchain AS build

# --locked, always. ADR-0032 §4: a cargo command without it may rewrite
# Cargo.lock, and a build that resolves its own dependencies is a build that
# ships something nobody reviewed.
#
# --profile server, not --release: the workspace release profile is tuned for
# the WASM module and sets panic = "abort", which would turn one panicking
# request into a whole-server outage. See the comment on [profile.server] in
# the workspace Cargo.toml.
RUN cargo build --locked --profile server -p fathom-server

# ---- wasm-build (the browser engine, ADR-0052 §1) ------------------------
# `scripts/build-wasm.sh` in miniature: that script is for a developer's own
# checkout (it writes into `client/public/engine/`, gitignored, and is not
# itself invoked here because there is no host checkout inside this stage to
# write into) -- same command, same target, so the artifact this image ships
# is the one that script also produces, never a second recipe for it.
FROM toolchain AS wasm-build
RUN rustup target add wasm32-unknown-unknown
RUN cargo build --release --locked -p fathom-wasm --target wasm32-unknown-unknown

# A directory for the runtime stage to copy, and the reason it is made HERE:
# the runtime image is distroless, so there is no shell to `mkdir` with. See
# the `COPY` that uses it below for what it is for. The README is not
# decoration -- it is the one thing an operator finds if they go looking in the
# volume before the server has written anything, and a `COPY` of a genuinely
# empty directory is a thing not every builder agrees about.
RUN mkdir -p /bootstrap-seed && \
    printf '%s\n' \
      "This volume holds ONE file: the enrolment token for the first operator," \
      "written at first start (admin design 6.3) as first-operator-token." \
      "" \
      "It is a bearer secret. Read it, redeem it in a browser, delete it." \
      "If it is gone and nobody has enrolled a key yet, run:" \
      "" \
      "    docker compose run --rm server reissue-bootstrap-token" \
      "" \
      "Once any operator key is enrolled that command refuses, by design." \
      > /bootstrap-seed/README

# ---- run --------------------------------------------------------------
# Named `server` (not left anonymous) because this Dockerfile now builds
# more than one final image from one file -- `compose.yaml` names
# this stage with `target: server` for exactly that reason, so that adding
# the stages below can never silently change what an unqualified
# `docker build .` produces.
FROM gcr.io/distroless/cc-debian12@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f AS server

COPY --from=build /src/target/server/fathom-server /fathom-server

# The schema/ tree, at a fixed absolute path — NOT embedded in the binary.
# `main.rs` loaded it from `"schema"`, relative to the working directory; this
# stage copies only the binary, so a container run from anywhere but a
# checkout crash-looped on exit 7 with no `schema/` beside it and no override
# to point elsewhere (Finding 1). Copied from the build stage's checkout
# rather than the host context directly, so it is exactly the tree that was
# built against, byte for byte — the same reason the binary itself is copied
# `--from=build` rather than rebuilt here.
#
# Not compiled in: the crates that embed a tree in the binary are external
# dependencies, and 49 §20's dependency budget is guarded deliberately (see
# `crates/fathom-server/Cargo.toml`'s own comments on that budget) — a schema
# update should not require a new binary.
COPY --from=build /src/schema /schema
ENV FATHOM_SCHEMA_ROOT=/schema

# `corpus/`, beside `schema/`, for the SAME reason `schema/` is copied above
# rather than embedded: `main.rs` (~L513) loads the equipment catalogue from
# `FATHOM_SCHEMA_ROOT`'s PARENT, expecting `corpus/catalogue/` to sit next to
# `schema/` there (`design_api::load_catalogue`'s own doc). Without this line
# the schema tree loads, the catalogue does not, and the process refuses to
# start with a catalogue error naming the missing directory -- found running
# `compose.yaml` rather than reading it, same as the note above this
# one.
COPY --from=build /src/corpus /corpus

# THE ONE PATH THIS SERVER WRITES, and the one reason this image is not
# entirely read-only. Admin design §6.3's first start mints the first operator
# and writes their single-use enrolment token to a file for a human to read;
# `FATHOM_BOOTSTRAP_TOKEN_FILE` names where. It is NOT in the key volume --
# that volume is mounted read-only on the server, deliberately, and deriving
# this path from the master key's is what stopped `compose.yaml` from
# ever completing a first start (see its header).
#
# **Owned by 65532 here so that the named volume inherits it.** Docker seeds a
# fresh named volume from whatever is at the mount point in the image,
# ownership included; a mount point that does not exist in the image is created
# root-owned, and this container does not run as root, so the server could not
# create the file at all. `--chown` on `COPY` is how a distroless stage sets
# ownership without a shell to `chown` with.
COPY --from=build --chown=65532:65532 /bootstrap-seed /var/lib/fathom/bootstrap
ENV FATHOM_BOOTSTRAP_TOKEN_FILE=/var/lib/fathom/bootstrap/first-operator-token

# 65532:65532 is distroless's `nonroot`. The compose file says so as well; both
# say it so that neither alone is load-bearing.
USER 65532:65532

EXPOSE 8080
ENTRYPOINT ["/fathom-server"]

# ---- client build -------------------------------------------------------
# Owner: this stack served no client at all until this stage existed --
# `compose.yaml` brought up a server and a proxy with nothing for the
# proxy to serve except the API. This builds the client the same way
# `docs/RUNNING-IT.md`'s "from source" section does: `npm ci`, the wasm
# engine staged into `client/public/engine/` (below), then `npm run build`,
# into `client/dist`.
#
# Digest read 2026-09-19 from `registry-1.docker.io/v2/library/node/manifests/22-slim`
# (the `docker-content-digest` response header on a manifest-list GET,
# authenticated the way `docker pull` itself does) -- 22 is the current Node
# LTS line. Pinned by digest, never by tag, for the identical reason every
# other `FROM` in this file is (see the file header): the digest is the
# artifact, the tag is a pointer.
FROM node@sha256:f1127b82781601ca2a57c96811cf6be9da3d1f77d58ec13bab49e5f79cf8c84c AS client-build

# `COPY . .` at `/src`, not a hand-picked file list: `client/src/index.css`
# imports `../../design/tokens.css` (`client/vite.config.ts`'s own comment
# names it), so the client's build needs the repository root beside it, not
# just `client/`. The Rust build stage above makes the identical choice for
# the identical reason -- one checkout, copied whole, rather than a file list
# that silently drifts from what the build actually reads.
WORKDIR /src
COPY . .
WORKDIR /src/client

# `ci`, never `install`: a build that resolves its own client dependency
# versions is the same objection ADR-0032 §4 makes of a cargo build run
# without `--locked` -- `package-lock.json` is what was reviewed, and `ci`
# refuses to touch it. `client/package.json` names no new package for this
# change to have reviewed; it is `react`, `react-dom` and `@xyflow/react`,
# already in the tree.
RUN npm ci

# `scripts/build-wasm.sh`'s destination, staged from `wasm-build` above
# rather than left for `npm run build` to discover missing: without this,
# `client/src/engine/wasm.ts`'s fetch of `/engine/fathom_wasm.wasm` 404s at
# runtime and the paste box and config drawer refuse every input, closed
# (`client/src/components/design/DesignPlace.tsx`'s own `Engine.init()`
# catch) -- a dead feature, not a leak, but dead all the same, and `vite
# build` has no way to notice a public/ file that was never staged.
COPY --from=wasm-build /src/target/wasm32-unknown-unknown/release/fathom_wasm.wasm /src/client/public/engine/fathom_wasm.wasm

RUN npm run build

# ---- caddy, with the client baked in -------------------------------------
# Owner: this is the SAME pinned Caddy image `compose.yaml` used to
# pull directly -- digest unchanged, read 2026-09-03 per the file header
# above -- now as a build stage so the client's built files can be copied
# into it. Caddy's own official image has no `npm`, so the client cannot be
# built inside it; it is only ever copied in, already built, from the stage
# above.
FROM caddy@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648 AS caddy

# `/srv/www`, matching `deploy/Caddyfile`'s `root * /srv/www`; the two say
# the same path so that neither alone is load-bearing, the same convention
# `compose.yaml`'s bootstrap-token path uses across three files.
COPY --from=client-build /src/client/dist /srv/www

# `deploy/Caddyfile` itself is still a bind mount, from `compose.yaml`
# -- deliberately not copied in here -- so that a TLS or host-name change
# (this file's own "a real deployment replaces this block" comments) does
# not need an image rebuild to take effect.
