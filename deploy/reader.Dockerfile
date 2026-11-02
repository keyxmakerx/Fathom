# fathom-reader — the device reader (ADR-0082 §4.3; owner's answers 2026-11-02,
# r76-device-reading question 1 A and r87-reader-packages).
#
# Built only when an operator switches the compose `reader` profile on, from `helpers/reader/`
# and its own Cargo.lock: its SNMP and SSH packages are never in the server's image or its lock.
# The same two stages and pinned digests as the Passbolt helper's image.
#
# What the running container is allowed (compose.yaml, `reader`): its own network and no other,
# a read-only filesystem, no capabilities, no new privileges, Docker's default seccomp profile,
# and one volume holding its socket. It holds no login between jobs.

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
COPY helpers/reader/ helpers/reader/
RUN pinned=$(grep -E '^channel' rust-toolchain.toml | sed 's/.*"\(.*\)".*/\1/') && \
    if [ "$pinned" != "$RUSTUP_TOOLCHAIN" ]; then \
        echo "rust-toolchain.toml pins $pinned; this image is $RUSTUP_TOOLCHAIN" >&2; \
        exit 1; \
    fi
# --locked against the helper's own lockfile, always (ADR-0032 §4).
RUN cargo build --locked --release --manifest-path helpers/reader/Cargo.toml
RUN mkdir -p /socket-seed && \
    printf '%s\n' "The device reader's socket. Nothing else is kept here." > /socket-seed/README

FROM gcr.io/distroless/cc-debian13@sha256:4594d59540d1948417f6ca2829ddd9294493a7c68b7528f4dd459de7f203a750 AS reader
COPY --from=build /src/helpers/reader/target/release/fathom-reader /fathom-reader
COPY --from=build --chown=65532:65532 /socket-seed /run/fathom-reader
ENV FATHOM_READER_SOCKET=/run/fathom-reader/reader.sock
USER 65532:65532
ENTRYPOINT ["/fathom-reader"]
