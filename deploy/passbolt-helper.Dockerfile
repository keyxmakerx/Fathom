# fathom-passbolt-helper — the optional Passbolt helper (ADR-0071 part four, Passbolt; owner's
# answers 2026-10-26, r34-passbolt v2 B and r34-passbolt-crates A: "let this be an optional
# thing ... after the admin clarifies they do want this support").
#
# Built only when an operator switches the compose `passbolt` profile on, from
# `helpers/passbolt/` and its own Cargo.lock: the 124 packages rpgp brings are never in the
# server's image or its lock. The same two stages as deploy/Dockerfile, the same pinned digests.
#
# What the running container is allowed (compose.yaml, `passbolt-helper`): no network, a
# read-only filesystem, no capabilities, no new privileges, Docker's default seccomp profile,
# and one volume holding its socket. It holds no key between requests.

FROM rust@sha256:cf09adf8c3ebaba10779e5c23ff7fe4df4cccdab8a91f199b0c142c53fef3e1a AS build
ENV RUSTUP_TOOLCHAIN=1.94.1
# deploy/ca/README: an egress proxy's CA, builder stage only.
COPY deploy/ca/ /usr/local/share/ca-certificates/fathom-extra/
RUN if ls /usr/local/share/ca-certificates/fathom-extra/*.crt > /dev/null 2>&1; then \
        update-ca-certificates; \
    else \
        echo "no extra CA certificates; using the image's trust store"; \
    fi
WORKDIR /src
COPY rust-toolchain.toml ./
COPY helpers/passbolt/ helpers/passbolt/
RUN pinned=$(grep -E '^channel' rust-toolchain.toml | sed 's/.*"\(.*\)".*/\1/') && \
    if [ "$pinned" != "$RUSTUP_TOOLCHAIN" ]; then \
        echo "rust-toolchain.toml pins $pinned; this image is $RUSTUP_TOOLCHAIN" >&2; \
        exit 1; \
    fi
# --locked against the helper's own lockfile, always (ADR-0032 §4).
RUN cargo build --locked --release --manifest-path helpers/passbolt/Cargo.toml
RUN mkdir -p /socket-seed && \
    printf '%s\n' "The Passbolt helper's socket. Nothing else is kept here." > /socket-seed/README

FROM gcr.io/distroless/cc-debian13@sha256:4594d59540d1948417f6ca2829ddd9294493a7c68b7528f4dd459de7f203a750 AS helper
COPY --from=build /src/helpers/passbolt/target/release/fathom-passbolt-helper /fathom-passbolt-helper
COPY --from=build --chown=65532:65532 /socket-seed /run/fathom-passbolt
ENV FATHOM_PASSBOLT_SOCKET=/run/fathom-passbolt/helper.sock
USER 65532:65532
ENTRYPOINT ["/fathom-passbolt-helper"]
