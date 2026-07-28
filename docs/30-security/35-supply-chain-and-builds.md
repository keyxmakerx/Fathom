# 35 — Supply chain and builds

> **Status:** Proposed

This document is the mechanism behind one sentence in the owner brief: *"Malicious image
substitution | Signed images, reproducible builds, published hashes (§7.7)."* It is also the
mechanism behind rows 7, 8 and 9 of `31-threat-model.md` §5.1, all three of whose verification
columns say some version of *"rebuild it yourself"*, and behind attack-tree goal C, which `31`
§8.4 identifies as dominating both other goals.

**The governing rule of this document, stated once, in caps, at the top:**

> **A BUILD YOU CANNOT REPRODUCE IS A BUILD YOU ARE TRUSTING SOMEBODY ABOUT. REPRODUCIBILITY
> DOES NOT REMOVE THE TRUST — IT MOVES IT FROM US TO WHOEVER REBUILDS.**

Everything here is downstream of that sentence. §3 is the machinery, §4 is the procedure that
makes the machinery mean something, §12 is the honest limit, and §13 is the part that decides
whether any of it ever gets used.

The product's central claim is that it does nothing behind your back. `31` establishes that the
claim is checkable in principle: the CSP is readable, the WASM import section is dumpable, the
server can be run locally and its tables grepped. Every one of those checks is performed against
**the artifact you are running**. None of them tells you the artifact you are running is the
source you read. That gap is this document.

---

## 0. Contents

| § | |
|---|---|
| 1 | The claim, the chain of custody, and what reproducibility does not prove |
| 2 | The artifact register — everything we ship, and what "reproducible" means for each |
| 3 | Reproducible builds — the mechanics, and the nondeterminism register |
| 4 | The verification procedure a third party follows, with timings |
| 5 | Dependency policy — the cap, the count, the review, the tools |
| 6 | The build pipeline as attack surface, and the Node.js argument properly stated |
| 7 | Signing and distribution |
| 8 | The update channel, per deployment mode — including the one with no channel |
| 9 | Rule packs and corpus as a supply chain of their own |
| 10 | SBOM |
| 11 | CI/CD hardening |
| 12 | The insider-threat question |
| 13 | Verification UX |
| 14 | Residual risk register |
| 15 | What this costs, added up |
| 16 | Open decisions |
| 17 | Sources |
| 18 | Disagreements |

---

## 1. The claim, the chain of custody, and what reproducibility does not prove

### 1.1 The claim, in the form it has to survive review

> Given the git tag, a machine with a network connection, and the published build container,
> anyone can produce byte-identical copies of every artifact we publish, compare them against the
> hashes in the signed release manifest, and find that they match — without our cooperation, and
> without running any tool we wrote.

Three qualifiers in that sentence are load-bearing and each is argued below: **byte-identical**
(§3.1), **every artifact** (§2.2 — it is not every artifact, and the exceptions are named), and
**without running any tool we wrote** (§7.2 — which is why the release is signed twice, in two
formats, one of which is verifiable with a 200-line C program somebody else maintains).

### 1.2 The chain of custody

Every link is a place where the bytes can change. The question for each is: *who could change
them, and what would notice?*

```text
  SOURCE                        BUILD                        SIGN            DISTRIBUTE   RUN
  ┌──────────────┐              ┌──────────────┐             ┌───────┐       ┌────────┐   ┌────┐
  │ git tree     │─(L1)────────▶│ toolchain    │─(L4)───────▶│ keys  │─(L6)─▶│ CDN /  │──▶│user│
  │ + Cargo.lock │              │ + deps       │             │ + log │       │ ghcr / │   │    │
  │ + corpus     │              │ + build host │             └───────┘       │ mirror │   └────┘
  └──────────────┘              └──────────────┘                             └────────┘
         │                             │  ▲                                       │
       (L2) crates.io               (L3)│  │(L5) CI runner, actions, cache        │
         │                             │  │                                    (L7) TLS, DNS,
         ▼                             ▼  │                                         typosquat
  ┌──────────────┐              ┌──────────────┐
  │ dependency   │              │ npm graph    │  ← §6: this link is deleted, not hardened
  │ publishers   │              │ (Node build) │
  └──────────────┘              └──────────────┘
```

| Link | What can go wrong | What notices | Section |
|---|---|---|---|
| L1 | A commit nobody reviewed introduces a backdoor | Human review only. At a one-maintainer project, **nothing** | §12 |
| L2 | A dependency publisher ships malicious code | `cargo-vet`/`cargo-deny`, and reading the diff. **Not reproducibility** — every rebuilder reproduces the same poisoned bytes | §5, §6.5 |
| L3 | The toolchain is not the toolchain we named | Toolchain pinned by version **and** checksum; the rebuild fails loudly rather than diverging quietly | §3.2 |
| L4 | The build host modifies the artifact after compilation | Reproducibility — **if somebody rebuilds** | §3, §4 |
| L5 | A CI action, a cache entry or a runner is compromised | Pinned action digests, cacheless release builds, split build/publish credentials | §11 |
| L6 | The signing key is stolen, or an insider signs a different artifact | Transparency log: a signature that is not in the log fails verification, and one that is in the log is public | §7.3, §12 |
| L7 | The user downloads a different file entirely | TLS, a canonical published location, and a fingerprint they can compare. **No technical control against typosquatting** | §7.5, `31` §8.3 C1.3 |

The two links with no technical control are **L1** and **L7**, and both are named as such rather
than dressed up. That is the shape of the honest answer.

### 1.3 What reproducibility does not prove

This is the paragraph that has to be in the review pack, because a reviewer who has not thought
about it will over-credit reproducibility and a reviewer who has will test whether we understand
its limits.

| Reproducibility proves | Reproducibility does not prove |
|---|---|
| The published binary is the compilation of the published source, using the published dependency set | That the published source is benign. A backdoor in our own code reproduces perfectly |
| The build host did not inject anything after compilation | That a *dependency* is benign. Everyone rebuilding pulls the same crate and produces the same bytes. §6.5 |
| The same artifact went to everyone, if the log agrees | That the artifact is correct, safe, or free of defects |
| A divergence exists, when one exists | That anybody looked. §4.6 |

**The sharpest form of the limit:** reproducible builds defend link L4 and nothing else. They are
the *only* control on L4 and L4 is otherwise undefendable, which is why they are worth their cost
— but a project that treats them as a general supply-chain answer has misread what they do. The
xz-utils compromise (CVE-2024-3094) would not have been caught by a reproducible build. The
backdoor was in the released source tarball's build machinery; a rebuild from that tarball
reproduces it exactly.

### 1.4 Scales

This document does not introduce a scale. It uses two that already exist:

- **`Risk` — `ReadOnly | ChangesConfig | Disruptive`.** The emitted-line risk enum. It classifies
  what a command does to a live network device. It appears in this document in exactly one place,
  §9.5, where a hostile rule pack lies about it. It is not used for build status, not for
  verification outcomes, not for dependency risk, and its three colours are not reused.
- **Residual — `none | bounded | material | total`.** Defined in `31-threat-model.md` §1.4 and
  proposed there as a conventions addition. Used unchanged, in neutrals.

---

## 2. The artifact register

### 2.1 Everything we publish

| # | Artifact | Shape | Contains | Signed | Reproducible |
|---|---|---|---|---|---|
| A1 | `fathom-<ver>.html` | one file, offline | HTML + inlined CSS + inlined JS + base64 WASM + base64 finder index + first-party rule pack | yes | **byte** |
| A2 | `fathom-web-<ver>.tar` | static asset tree for the served build | same content, unbundled, plus a service worker if any | yes | **byte** |
| A3 | `fathom_core.wasm` | the Rust core | graph, rules, emitters, parsers, envelope, KDF | yes (inside A1/A2 and separately) | **byte** |
| A4 | `fathom-<ver>-<triple>` | native CLI, per target triple | same core, native | yes | **byte** on Linux; §2.3 for macOS/Windows |
| A5 | `ghcr.io/…/fathom-sync:<ver>` | container image | Axum sync service, static assets | cosign | **content**, not byte — §3.7 |
| A6 | `fathom.<domain>-<ver>.fpack` + `.minisig` | rule pack | rules, explainers, fixtures | minisign | **byte** — `12-rule-engine.md` §13.1 |
| A7 | `finder.idx`, `finder.toml` | command finder index | FST, trigram postings, concept graph | inside A1–A3 | **byte** — `16-command-finder.md` §9.5 |
| A8 | `fathom-<ver>.cdx.json` | SBOM, CycloneDX | code dependency closure | yes | **byte** |
| A9 | `fathom-corpus-<ver>.cdx.json` | content BOM | corpus entries, hashes, `reviewed_by` | yes | **byte** — §10.2 |
| A10 | `MANIFEST-<ver>.txt` + `.minisig` + `.sigstore.json` | the release manifest | every hash above, toolchain identity, build flags | twice | n/a — it *is* the record |
| A11 | `advisories-<date>.fadv` | signed advisory bundle | known-bad versions, known-bad keys | minisign | **byte** — §8.4 |

Eleven artifacts. That is more than it sounds like, and §15 counts what it costs.

### 2.2 Byte-reproducible versus content-reproducible

**Byte-reproducible** means: two independent builds from the same tag produce files whose SHA-256
digests are equal. This is the claim for A1–A4 and A6–A9.

**Content-reproducible** means: the *payload* is byte-identical, but the envelope around it is not
guaranteed to be. This is the claim for A5, the container image, and the reason is §3.7.

**RECOMMENDATION —** never blur these two in published material. A release page that says
"reproducible builds" and links to an image whose digest changes on every rebuild has taught the
reader that our claims need interpretation, which is the opposite of what the claim is for. The
manifest states the level per artifact, in a column, in words.

### 2.3 Where we do not claim byte reproducibility, and why

| Artifact | Why not | What we claim instead |
|---|---|---|
| macOS CLI binary, notarised | Apple's notarisation ticket is issued by Apple, is time-dependent, and is stapled into the artifact after signing. The stapled artifact cannot be reproduced by anyone but Apple <!-- VERIFY: confirm whether stapling modifies the Mach-O in a way that changes the digest, or attaches a detached ticket, for the current notarytool flow. --> | The **unsigned, unstapled** binary is byte-reproducible and its digest is in the manifest. Verify that one, then observe that codesign's payload matches |
| Windows CLI binary, Authenticode-signed | Same shape: the signature embeds a timestamp from a third-party timestamping authority | Same: the unsigned PE is in the manifest |
| Container image A5 | §3.7 | The app layer's tar digest, and the image digest, both in the manifest and both signed |
| Anything served over HTTP with on-the-fly compression | The gzip/brotli encoder version and level are the server's, not ours | Only the uncompressed asset digests are claimed. `Content-Encoding` is transport |

**The rule:** where a third party controls part of the byte sequence, we publish the digest of the
part we control and say which part that is. We do not claim what we cannot demonstrate.

---

## 3. Reproducible builds — the mechanics

*margin tab: read this first*

> **THE FIRST DIVERGENCE YOU FIND WILL BE OURS, NOT AN ATTACK. BUILD IT TWICE YOURSELF BEFORE YOU
> ACCUSE ANYONE.**

### 3.1 The definition we hold ourselves to

Three levels, in increasing strength. We claim the third and CI enforces the third.

| Level | Definition | Who this convinces |
|---|---|---|
| **R1 — same machine, twice** | Two builds in the same container, same host, different scratch directories, produce identical digests | Nobody. It catches timestamps and little else, but it is the cheapest CI gate and it catches regressions the day they land |
| **R2 — different machine, same environment** | Two builds in the same pinned container on different hosts, different CPU counts, different kernels, different hostnames, different clocks | Most reviewers |
| **R3 — different environment, from source** | A build from the tag on a host with a different distribution, different filesystem, different locale, different timezone, different `$HOME`, and a from-scratch toolchain fetch, produces identical digests | The reviewer who matters, and the one who will actually try |

**DECISION — R3 is the claim, and CI runs R1 on every commit, R2 on every release candidate, and
R3 nightly on a runner that deliberately differs.** The nightly R3 runner sets `TZ=Pacific/Chatham`,
`LC_ALL=tr_TR.UTF-8` (the Turkish locale, because dotted-I case folding has broken more build
tools than any other single locale), a 3-character `$HOME`, an ext4 filesystem where the reference
is overlayfs, and a CPU count that is not a power of two. If any of those changes the output, the
build is not R3 and we want to know on a Tuesday, not on release day.

### 3.2 Toolchain pinning

Everything that transforms bytes is named, versioned, and checksummed. Nothing is installed by a
version range, ever.

```toml
# rust-toolchain.toml — checked in, and the single source of truth for the Rust half
[toolchain]
channel    = "1.NN.N"                  # exact patch, never "stable"
components = ["rust-std", "rustc", "cargo"]
targets    = ["wasm32-unknown-unknown", "x86_64-unknown-linux-musl"]
profile    = "minimal"
```

```toml
# build/toolchain.lock.toml — everything rustup does not cover.
# Every entry: exact version, download URL, SHA-256 of the downloaded bytes.
# CI refuses to build if any checksum mismatches. No ranges. No "latest".

[rust]
channel  = "1.NN.N"
# rustup verifies its own manifest signature; we additionally pin the sha256 of
# each component tarball so a compromised rustup mirror is caught here.

[wasm-bindgen-cli]
version = "0.2.NNN"      # MUST equal the wasm-bindgen crate version in Cargo.lock exactly
sha256  = "…"

[binaryen]
version = "version_NNN"  # wasm-opt
sha256  = "…"

[typescript]
version = "7.N.N"        # the Go-native compiler; type-checking only, emits nothing
sha256  = "…"

[oxc]
# used as Rust library crates from the xtask binary, so it is pinned by Cargo.lock,
# not here. Listed for completeness.

[zstd]
# pure-Rust encoder, pinned in Cargo.lock. The C library is not used. §3.3 N14.
```

**The wasm-bindgen lockstep rule.** `wasm-bindgen` the crate and `wasm-bindgen-cli` the binary
must be the same version. A mismatch is not a subtle divergence — it is a hard failure with an
unhelpful message, and it is the single most common way a WASM build breaks when a lockfile is
regenerated. CI asserts equality between the `Cargo.lock` entry and the pinned CLI version before
it starts compiling, so the failure arrives in five seconds instead of five minutes.

**The build container.** All of the above is baked into one OCI image, published, and referenced
**by digest** in the release manifest — never by tag. The manifest records
`build_container: ghcr.io/…/fathom-build@sha256:…`, and that digest is what a third party pulls.
A tag is a mutable pointer and a mutable pointer in a reproducibility story is a hole.

**The circularity, named.** The build container is itself a build artifact, and it is not
byte-reproducible for the reasons in §3.7. So the chain bottoms out in "trust this container
digest, or read its Dockerfile and build your own". That is a real limit. The mitigation is that
the container contains **no first-party code** — it is a pinned distribution base plus pinned
toolchain tarballs with published checksums — so a reviewer can verify its contents without
verifying its build. `31` §5.1 row 9's residual is `material` and this is why.

### 3.3 The nondeterminism register

Every known source, the control, and whether the control is complete. This table is the working
document; if a divergence is ever found that is not in it, the fix is a new row, not a patch.

| # | Source | Mechanism | Control | Complete? |
|---|---|---|---|---|
| N1 | **Codegen unit scheduling** | `codegen-units` defaults to 16; parallel LLVM codegen produces varying output. rust-lang/rust#128675, closed as not planned | `codegen-units = 1` in the release profile | Yes, at a real compile-time cost (§15) |
| N2 | **Parallel compiler frontend** | `-Zthreads` parallelises frontend work; the stabilisation plan's initial determinism option is to turn frontend parallelism off | Never set `-Zthreads`. Assert it is absent from `RUSTFLAGS` in CI | Yes |
| N3 | **Absolute build paths** | Source paths embedded in panic messages, debug info, and `file!()` | `trim-paths` in the release profile (RFC 3127), plus explicit `--remap-path-prefix` for `$CARGO_HOME` and `$PWD` | **No.** Coverage is incomplete for some secondary outputs and diagnostics (rust-lang/rust#129080). Mitigated by also building at a fixed path inside the container |
| N4 | **`$CARGO_HOME` in dependency paths** | Registry sources live under `$CARGO_HOME/registry/src/...` and leak into the same places as N3 | Fixed `CARGO_HOME=/build/cargo` inside the container **and** a remap rule | Yes, given the container |
| N5 | **Build timestamps** | Anything calling `SystemTime::now()` at build time | `SOURCE_DATE_EPOCH` set to the tag's committer timestamp, exported into every build step. No first-party code reads the wall clock at build time; CI greps for it | Yes for our code; see N6 for dependencies |
| N6 | **Dependency crates that embed timestamps** | e.g. `rust-embed` records filesystem mtimes by default and needs its `deterministic-timestamps` feature | Any crate that embeds files or times is either configured deterministically or not used. Checked at dependency-review time (§5.3) | Only as far as the review catches it — R1 catches the rest, same day |
| N7 | **`-Cdebuginfo=2`** | Known open nondeterminism on several platforms | Release profile uses `debug = 0` (line tables only where needed for panics, and `strip = "symbols"` on the WASM path) | Yes for our profile; the cost is worse stack traces, §15 |
| N8 | **`HashMap`/`HashSet` iteration in build scripts and proc macros** | Rust's default hasher is randomly seeded per process | Forbid `HashMap` iteration order from affecting output in first-party code (`BTreeMap` or explicit sort). For dependencies: R1 catches it | No, by inspection — but R1 catches it deterministically because two runs in the same container will differ |
| N9 | **Filesystem directory order** | `read_dir` returns entries in filesystem order, which differs between ext4, overlayfs, APFS and tmpfs | Every directory walk in first-party build code sorts by byte-lexicographic path before use. Enforced by a lint: `read_dir` is banned outside one wrapper function that sorts | Yes |
| N10 | **Locale and timezone** | Case folding, collation, date formatting | `LC_ALL=C`, `TZ=UTC` in the build container. Also deliberately violated by the nightly R3 runner (§3.1) to prove we do not depend on them | Yes |
| N11 | **Environment leakage** | `RUSTFLAGS`, `CARGO_BUILD_JOBS`, `CARGO_ENCODED_RUSTFLAGS`, `RUSTC_WRAPPER`, `CC`, `CFLAGS` | The build runs with a scrubbed environment: an explicit allowlist of variables, everything else unset. The allowlist is in the manifest | Yes |
| N12 | **Dependency re-resolution** | Cargo picking a different semver-compatible version | `--locked` on every invocation. `Cargo.lock` committed for the workspace **and** for the CLI binary | Yes |
| N13 | **`ar`/archive metadata** | Static library members carry mtime, uid, gid, mode | Rust emits deterministic archives; not relied on — the WASM path does not produce archives, and the musl CLI is checked by R1 | Yes in practice; asserted by R1 |
| N14 | **Compression encoder drift** | zstd and gzip output changes between library versions at the same level | Pure-Rust zstd encoder pinned in `Cargo.lock`; level recorded in the manifest; no C `zstd-sys`. Applies to `.fpack` (`12` §13.1) and to the finder index | Yes, given the pin. **The pin is the whole control** — a zstd bump is a release-visible change and CI treats it as one |
| N15 | **`wasm-opt` version and flags** | Binaryen passes change between releases; output differs | Pinned by version and SHA-256; the exact flag vector is a checked-in file and is echoed verbatim into the manifest. `--converge` is **not** used (§3.6) | Yes |
| N16 | **`wasm-bindgen` version skew** | Generated glue changes between versions | Lockstep assertion, §3.2 | Yes |
| N17 | **Asset enumeration order** | Globbing CSS/JS/font/icon inputs | An explicit, checked-in asset manifest with fixed order. No globs in the build. §3.5 | Yes |
| N18 | **Minifier and CSS transformer versions** | Output changes between releases | `oxc` and `lightningcss` are Rust library crates, pinned by `Cargo.lock`, invoked from our own `xtask` binary. No npm, no separate binary to pin | Yes |
| N19 | **Base64 and inlining** | Line wrapping, padding, alphabet | One canonical encoder in first-party code: standard alphabet, padded, no line breaks. Asserted by a unit test with a fixed vector | Yes |
| N20 | **Container image layers** | Timestamps, layer ordering, base image drift | §3.7. Partially controlled | **No** — hence "content-reproducible" for A5 |
| N21 | **LLVM version** | The same rustc always carries the same LLVM, so this collapses into N-none provided the toolchain is pinned by exact patch version | Exact patch pin (§3.2). Never `stable` | Yes, given the pin |
| N22 | **Proc macros with ambient inputs** | A proc macro may read files, the clock, the environment, or the network at compile time. There is no sandbox | Enumerate every proc-macro crate in the closure (§5.7) and review each for ambient input. Cap the count | **No.** This is the weakest row in the table and §5.7 says so |

**Read the register the way the field card's error decoder is read:** left column is the symptom
you are chasing, right column is where to look. §4.5 turns it around and indexes it by what the
diff looks like.

### 3.4 The build graph

Stages, in order. Every arrow is an input hash recorded in the manifest, so a divergence can be
localised to a stage instead of to "the build".

```text
 stage 0  git tag ─────────────────────────────────────────┐
          tree hash, committer timestamp → SOURCE_DATE_EPOCH│
                                                            │
 stage 1  toolchain fetch                                   │  all inputs hashed
          rustup components + wasm-bindgen-cli + wasm-opt   │  into MANIFEST
          + tsc(go), each by sha256                         │
                                                            │
 stage 2  cargo fetch --locked                              │
          registry sources → $CARGO_HOME (fixed path)       │
          hash: Cargo.lock digest + vendor tree digest      │
                                                            │
 stage 3  type check          tsc --noEmit                  │  no artifact, gate only
                                                            │
 stage 4  cargo build --release --locked --target wasm32… ──┼─▶ fathom_core.raw.wasm
          codegen-units=1, lto=fat, opt-level=z, panic=abort│
                                                            │
 stage 5  wasm-bindgen --target web --no-typescript ────────┼─▶ core_bg.wasm + core.js
                                                            │
 stage 6  wasm-opt <pinned flag vector> ────────────────────┼─▶ A3 fathom_core.wasm
                                                            │
 stage 7  xtask ui-build (oxc transform+minify,             │
          lightningcss) over the checked-in asset manifest ─┼─▶ app.js, app.css
                                                            │
 stage 8  cargo run -p fathom-corpus -- build ──────────────┼─▶ A7 finder.idx, finder.toml
          (sorted iteration, SOURCE_DATE_EPOCH honoured)    │
                                                            │
 stage 9  cargo run -p fathom-pack -- build ────────────────┼─▶ A6 .fpack (tar+zstd, §12/13.1)
                                                            │
 stage 10 xtask assemble ───────────────────────────────────┼─▶ A1 single file, A2 asset tree
          deterministic inline order, CSP hashes computed   │
          over final bytes                                  │
                                                            │
 stage 11 cargo build --release --locked --target …musl ────┼─▶ A4 CLI
                                                            │
 stage 12 xtask sbom (cargo metadata, same feature set) ────┼─▶ A8, A9
                                                            │
 stage 13 xtask manifest ───────────────────────────────────┴─▶ A10 MANIFEST
          every digest above + toolchain identity + flags

 ── the line below is crossed only by the release job, with different credentials ──

 stage 14 sign (minisign, offline key) + cosign (keyless, OIDC) ─▶ .minisig, .sigstore.json
 stage 15 publish
```

Stages 0–13 need **no secrets at all**. That is not an accident; it is the property that lets a
third party run them, and it is the property §11.6 enforces by splitting the jobs. If a build
stage ever needs a credential, that stage has stopped being reproducible by anyone but us.

### 3.5 Deterministic assembly of the single file

The single-file build (A1) is the deployment shape the project exists for, and it is assembled by
first-party code, which means every nondeterminism in it is ours. The algorithm is small enough to
state completely.

```rust
/// One entry in the checked-in asset manifest. There is no globbing anywhere in
/// the build: if a file is not in this list, it is not in the artifact, and a
/// file in this list that does not exist is a build failure, not a warning.
pub struct AssetEntry {
    /// Repo-relative, NFC-normalised, forward slashes, no `..`, no leading `/`.
    pub path: RelPath,
    pub slot: Slot,
    /// Position within the slot. Explicit, not derived from the file system.
    pub order: u32,
    pub inline: Inline,
}

pub enum Slot { HeadStyle, BodyScript, WasmBlob, IndexBlob, PackBlob }

pub enum Inline {
    /// UTF-8, LF-normalised, BOM stripped, then inserted verbatim.
    Text,
    /// Standard base64 alphabet, padded, no line breaks, one canonical encoder.
    Base64,
}

/// Assembly is a fold over the manifest in (slot, order, path) order.
/// `path` is the final tiebreak so that a duplicated `order` is a deterministic
/// bug rather than a nondeterministic one — and CI rejects duplicated `order`
/// anyway.
pub fn assemble(manifest: &[AssetEntry], template: &str) -> Vec<u8> { /* … */ }
```

Five rules, each of which exists because breaking it is the obvious way to build this:

1. **No globs.** Ever. The manifest is a checked-in file and adding an asset is a reviewed diff.
   A glob makes the artifact a function of the filesystem, which makes it a function of the
   checkout order, which makes it a function of git's packfile layout.
2. **One canonical text normalisation, applied once.** LF line endings, no BOM, NFC. Applied at
   read time, so a contributor on Windows cannot change the artifact by checking out with CRLF.
3. **CSP script hashes are computed over the final inlined bytes**, after normalisation and after
   minification, in the same pass that writes them. Computing them earlier is how the CSP and the
   scripts drift apart, and a CSP that does not match its own scripts fails closed at runtime —
   loudly, but only for the user, which is the worst place to find out.
4. **No timestamps anywhere in the output.** Not in a comment, not in a banner, not in a
   `<!-- built at -->`. The build date belongs in the manifest and in one string constant that is
   set from `SOURCE_DATE_EPOCH` and formatted as `YYYY-MM-DD`, which is what the staleness margin
   tab renders (§8.3).
5. **The template has explicit slots and no logic.** The assembler is a fold, not a renderer.

**The cost of base64.** Inlining the WASM and the finder index as base64 costs 4/3 of their byte
length. `16-command-finder.md` §9.4 already prices the index at ≈1.4 MB inlined. The WASM core
pays the same multiplier. The alternative — a multi-file build — is not available for A1 because
A1's whole purpose is to be one file you can put on a USB stick. This is a real cost, it is
accepted, and it is the reason A2 exists for anyone who does not need one file.

### 3.6 `wasm-opt` — DECISION

**DECISION — run `wasm-opt`, pinned by exact version and SHA-256, with a fixed flag vector, and
without `--converge`.**

| Option | Size | Build cost | Reproducibility cost | Verdict |
|---|---|---|---|---|
| No `wasm-opt`; rely on `opt-level="z"` + `lto="fat"` | Largest | Lowest | One fewer toolchain to pin, one fewer C++ binary in the build container | Rejected — the size difference matters for A1 |
| `wasm-opt -Oz`, pinned | Binaryen's own documentation puts typical wins at 10–20 % over LLVM's raw output <!-- VERIFY: this figure is from Binaryen/cargo-wasi documentation and is a general claim, not a measurement of our artifact. Measure ours and replace this cell with the real number before it appears in any published material. --> | Seconds | One pinned binary; N15 | **Chosen** |
| `wasm-opt -Oz --converge` | A few percent better again | Multiplies passes until fixpoint | Any per-pass nondeterminism compounds across iterations, and the iteration count itself becomes an input | Rejected. The marginal size is not worth making N15 harder to reason about |

The flag vector lives in `build/wasm-opt.flags`, one flag per line, and is copied verbatim into
the manifest. A reviewer comparing two releases can diff that file. Flags are not assembled by a
script, because a script that assembles flags conditionally is a script that produces different
flags on a different machine.

### 3.7 The container image, honestly

BuildKit can rewrite file timestamps inside layers to `SOURCE_DATE_EPOCH` with
`rewrite-timestamp=true` on the image exporter, and the Dockerfile must declare
`ARG SOURCE_DATE_EPOCH` for the value to reach image metadata. It is not on by default, because
rewriting layers costs. There is a known issue where base-image layers are still rewritten in some
cases (moby/buildkit#4805).

Our position:

| We do | We do not |
|---|---|
| Pin the base image **by digest**, not tag. The base is a distroless/static image with no package manager | Claim a byte-stable image digest across BuildKit versions |
| Declare `ARG SOURCE_DATE_EPOCH` and export with `rewrite-timestamp=true` | Pretend the known base-layer issue does not exist |
| Publish the **SHA-256 of the application layer's uncompressed tar**, which contains only our artifacts, and which *is* byte-stable | — |
| Publish the image digest and sign it with cosign, so the thing you pull is the thing we pushed | — |
| Record the BuildKit version in the manifest, because it is an input | — |

**What a reviewer does with that:** they do not rebuild the image. They pull it, extract the
application layer, and check that every file in it matches a digest already in the manifest — the
same digests they can reproduce from source. That check is strictly stronger than a matching image
digest would be, because it verifies the contents rather than the packaging, and it is achievable
without a byte-reproducible image. §4.3 step 7.

This is the honest version of "reproducible container images", and it is a smaller claim than most
projects make.

### 3.8 What CI enforces about reproducibility

| Gate | Runs on | Fails when |
|---|---|---|
| R1 double-build | every commit | Any artifact digest in A1–A4, A6–A9 differs between the two builds |
| Toolchain checksum | every build | Any pinned download's SHA-256 mismatches |
| `wasm-bindgen` lockstep | every build | CLI version ≠ `Cargo.lock` crate version |
| Environment scrub | every build | An environment variable outside the allowlist is set |
| `read_dir` lint | every commit | `std::fs::read_dir` is called outside the one sorting wrapper |
| Glob lint | every commit | The asset manifest is bypassed, or an entry has a duplicate `(slot, order)` |
| Wall-clock lint | every commit | Build-time code calls `SystemTime::now`, `Instant::now` or `chrono::Utc::now` |
| R2 cross-host | every release candidate | Digests differ across two runners |
| R3 hostile environment | nightly | Digests differ under the deliberately-different environment of §3.1 |
| Independent rebuild | every release | The second pipeline's digests differ from the first's — §4.6 |

---

## 4. The verification procedure a third party follows

*margin tab: verify as you go*

> **STOP AT THE FIRST MISMATCH. A LATER STEP PASSING WHILE AN EARLIER ONE FAILED TELLS YOU
> NOTHING.**

The field card's Bring-Up Order is a numbered ladder with an instruction to stop at the first
failure, and a note that *"Steps 5–8 failing while 2–4 are clean is plumbing, not crypto."* The
same shape applies here and for the same reason: the steps are ordered so that where you stop
tells you what class of problem you have.

### 4.1 The ladder

| # | Step | Command | Answers |
|---|---|---|---|
| 1 | Get the manifest and both signatures | download `MANIFEST-<ver>.txt`, `.minisig`, `.sigstore.json` | — |
| 2 | Verify the project signature | `minisign -Vm MANIFEST-<ver>.txt -P <pubkey>` | Did the holder of the project key sign this manifest? |
| 3 | Verify the Sigstore bundle and log inclusion | `cosign verify-blob --bundle MANIFEST-<ver>.sigstore.json --certificate-identity <workflow> --certificate-oidc-issuer https://token.actions.githubusercontent.com MANIFEST-<ver>.txt` | Was it signed by our release workflow, and is that signature in a public log? |
| 4 | Check the artifact you already have | `sha256sum -c` against the manifest | Is the file you downloaded the file we published? |
| 5 | **Stop here if that is all you needed.** Steps 1–4 are ~2 minutes and answer *"is this our artifact"*. They do not answer *"does it match the source"* | | |
| 6 | Pull the build container by digest | `docker pull ghcr.io/…/fathom-build@sha256:…` | — |
| 7 | Rebuild from the tag | `git checkout <tag> && ./build/repro.sh` | — |
| 8 | Compare | `sha256sum -c MANIFEST-<ver>.txt` against your own output | Does the published binary match the published source? |
| 9 | If it differs: `diffoscope` the two | `diffoscope theirs.wasm yours.wasm` | Which *class* of difference — §4.5 |
| 10 | Check the container's application layer | extract, hash each file, compare against the manifest | Does the image contain the artifacts you just reproduced? |
| 11 | Check the artifact's own claims | the ten checks in `31` §5.3 — CSP, WASM imports, no-network run, determinism, storage scan | Does the artifact behave as documented? |

Steps 1–4 are *"is this ours"*. Steps 6–8 are *"is ours the source"*. Step 11 is *"is the source
what it says"*. They are three different questions and most reviewers only need the first.

### 4.2 How long it takes

Split into compute and human time, because they are spent by different people and only one of them
is the constraint.

| Depth | Compute | Human | What you can then say |
|---|---|---|---|
| Signature + hash (steps 1–4) | < 1 min | 2 min, once you have the key | "This is the artifact the project published, and the signature is in a public log" |
| Full rebuild (steps 6–8) | 20–40 min <!-- VERIFY: estimate. `codegen-units=1` plus `lto="fat"` on a workspace with a curve25519/blake3/argon2 dependency set is the dominant cost, plus a container pull. Measure on 4-core and 16-core runners and replace this range with real figures before publishing it. --> | 10 min of attention | "The published binary is the compilation of the published source" |
| Rebuild + contents (steps 6–11) | as above + 10 min | half a day | "…and it behaves as its own security documentation claims" |
| Full dependency audit (§5) | days | days | "…and I have looked at what it is compiled from" |

**What dominates the compute.** `codegen-units = 1` and `lto = "fat"` are chosen for determinism
and size, and both are the slow options. This is a direct trade: we made the build slower so that
the build is checkable. The compile is single-digit-CPU-bound and does not parallelise well at
`codegen-units = 1`, so a 16-core machine is not four times faster than a 4-core one.

**What dominates the human time is reading, not waiting.** That is worth saying to anyone
budgeting the exercise: the rebuild runs unattended.

### 4.3 The rebuild script

`build/repro.sh` is checked in, is under 60 lines, has no arguments, and does exactly what the
release pipeline does at stages 0–13. If the release pipeline and `repro.sh` are ever two different
things, the reproducibility claim has quietly become a claim about a script nobody runs.

**DECISION — the release pipeline invokes `repro.sh`. It does not reimplement it.** The CI
workflow's build job is: check out the tag, pull the container by digest, run `repro.sh`, upload
the outputs. Everything else in CI is signing, publishing, and gates. This is the only way to
guarantee the two stay identical, and it costs the pipeline some convenience.

### 4.4 What we publish to make step 8 possible

| Published | Why it is needed |
|---|---|
| The exact git tag and its tree hash | So "the source" is unambiguous |
| `SOURCE_DATE_EPOCH` as a literal integer | The tag's committer timestamp is derivable, but publishing it removes a class of "I used the wrong one" |
| The build container digest | §3.2 |
| The full environment allowlist and its values | N11 |
| Every toolchain version and SHA-256 | §3.2 |
| The `wasm-opt` flag vector, verbatim | N15 |
| `Cargo.lock`, in the tag | N12 |
| The asset manifest, in the tag | N17 |
| Both hash families per artifact: BLAKE3-256 and SHA-256 | §7.5 |

### 4.5 When it does not match — the mismatch decoder

Modelled on the field card's `ERROR DECODER`: left column is what you are looking at, right column
is where to go. **Correlate before you theorise.**

| WHAT THE DIFF LOOKS LIKE | GO LOOK AT |
|---|---|
| Only the `producers` custom section differs in the WASM | Toolchain version skew. You are not on the pinned rustc or the pinned `wasm-bindgen`. N16, N21 |
| Strings containing `/home/`, `/Users/`, `/build/`, or a registry path | Path remapping. N3, N4 — and check you ran inside the container |
| Function bodies identical, function *order* differs | `codegen-units`, or someone set `-Zthreads`. N1, N2 |
| A handful of bytes differ near the end of a data section | An embedded timestamp. N5, N6 |
| The WASM matches but the HTML does not | Asset order, minifier version, or a normalisation difference. N17, N18, N19 |
| The HTML differs only inside the `<meta>` CSP | Script hashes computed over different bytes — §3.5 rule 3 |
| Everything matches except the `.fpack` | zstd encoder version, or tar metadata. N14, and `12` §13.1 |
| Everything matches except the container image | Expected. §3.7 — check the application layer, not the image digest |
| The whole artifact differs, no recognisable structure | Wrong toolchain entirely, or wrong tag. Re-read step 6 |
| Two of *your own* builds differ from each other | It is not us. Something in your environment is leaking in — N8, N9, N10. **This is the most common outcome and it is why step 7 says build it twice** |
| Everything matches and you expected it not to | Nothing. That is the pass condition and it is unexciting by design |

**Intermittent divergence → cause**, in the shape of the card's `FLAP PATTERN → CAUSE`:

| PATTERN | LIKELY CAUSE |
|---|---|
| Differs on some machines, never on one machine | Filesystem order (N9) or CPU-count-dependent scheduling (N1) |
| Differs on every run, same machine | Hash seeding (N8) or a wall clock read (N5) |
| Differs only after a dependency update | A crate that embeds time or paths (N6), or a compression pin moved (N14) |
| Differs only in CI, never locally | Cache poisoning or a leaked environment variable. §11.7, N11 |
| Was reproducible, silently stopped | Somebody pinned by tag instead of digest somewhere. §3.2 |

### 4.6 The independent rebuilder

`31` §11 lists **R7 — reproducible builds prove nothing unless someone rebuilds** as `material`,
unfunded, with a revisit trigger of **"Now."** This section is the answer to that trigger.

**DECISION — every release is built twice, by two pipelines, under two sets of credentials, and a
divergence blocks the release.**

| Property | Primary | Secondary |
|---|---|---|
| CI provider | one | a **different** one |
| Credential set | release-signing identity | read-only checkout, no publish rights, no signing key |
| Trigger | tag push | the same tag, polled |
| Output | the release artifacts | digests only, published as a signed attestation |
| On divergence | — | the release is blocked and both digest sets are published |

This is the mechanism that converts reproducibility from a property into an observation. It costs
a second CI account and roughly a doubling of release-path compute. It does **not** make us
independent — both pipelines run our script against our container. It defeats a compromise of one
build host, not a compromise of the build definition.

**RECOMMENDATION — solicit a genuinely third-party rebuilder before the first public release**, on
the rebuilderd model: somebody who is not us, runs their own worker, publishes their own results,
and whose disagreement is public without asking us first. Until that exists, say "built twice by
us" rather than "independently verified", because the second phrase is not true and a reviewer will
find out.

---

## 5. Dependency policy

*margin tab: fewest that works*

> **EVERY DEPENDENCY IS A PUBLISHER YOU HAVE GIVEN CODE-EXECUTION RIGHTS ON EVERY USER'S MACHINE.
> COUNT THE PUBLISHERS, NOT THE CRATES.**

### 5.1 The caps

Six numbers. All are enforced in CI, all are per-artifact, and each has a named owner and an
escape procedure (§5.8).

| # | Cap | Value | Applies to |
|---|---|---|---|
| C1 | **Direct runtime dependencies** | **≤ 30** | The shipped core (A3), counting `[dependencies]` across the workspace crates that are actually compiled into it |
| C2 | **Total distinct crates in the shipped closure** | **≤ 160** | Unique `name@version` in `Cargo.lock` reachable from the shipped targets. Excludes dev-dependencies and build-only tooling |
| C3 | **Distinct publishing identities** | **≤ 25** | The count that actually matters — §5.2 |
| C4 | **Crates with a `build.rs` in the closure** | **≤ 12** | Build scripts execute on the build host, with the build host's rights |
| C5 | **Proc-macro crates in the closure** | **≤ 10** | Same, at compile time, with no sandbox — N22 |
| C6 | **npm packages, at any stage** | **0** | §6 |

And two that are not numeric:

- **C7 — no C or C++ in the shipped closure.** No `*-sys` crates, no `cc` build scripts, no
  vendored C. This is a determinism requirement as much as a memory-safety one: C toolchain
  version differences are a nondeterminism source we would then have to pin and control. It is why
  `32-cryptography.md` §15.1 rejected `ring`, and why the zstd encoder is pure Rust (N14).
  Binaryen is C++ and is a build tool, not a dependency: it transforms our output, it does not
  enter it.
- **C8 — one implementation per job.** Two HPKE crates, two YAML parsers, two base64 encoders is
  twice the surface for no benefit. `32` §15.1 already says this about HPKE. `cargo-deny`'s `bans`
  check enforces the general form.

### 5.2 Why publisher count is the metric that matters — DECISION

**DECISION — C3, distinct publishing identities, is the primary dependency metric. C1 and C2 are
secondary and exist to stop the closure growing quietly.**

Crate count is a proxy and a bad one. The RustCrypto organisation publishes `sha2`, `digest`,
`block-buffer`, `crypto-common`, `hybrid-array`, `cipher`, `aead`, `universal-hash`, `poly1305`,
`argon2`, `password-hash`, `hkdf`, `chacha20`, `chacha20poly1305` and more. That is a dozen-plus
crates and **one** compromise scenario: whoever can publish as RustCrypto can reach all of them.
Counting them as a dozen risks overstates the diversity of the trust surface; counting them as one
publisher states it correctly.

Conversely, a single small crate from a single anonymous author with no other packages is one
crate and one publisher, and it is a *worse* risk than four crates from an organisation with
published release engineering, even though it scores better on crate count.

The realistic publisher set for this stack:

| Publisher / org | Crates it supplies here | Notes |
|---|---|---|
| rust-lang | `libc`, `getrandom`, `cfg-if`, `log`, `hashbrown` (via std) | Effectively the same trust root as the compiler |
| RustCrypto | the AEAD/hash/KDF/password-hash stack | Largest single block |
| dalek-cryptography | `curve25519-dalek`, `x25519-dalek`, `ed25519-dalek`, `signature` | |
| BLAKE3 team | `blake3`, `constant_time_eq`, `arrayvec`/`arrayref` (partly) | |
| dtolnay | `serde`, `serde_derive`, `proc-macro2`, `quote`, `syn`, `thiserror`, `itoa`, `ryu` | Enormous transitive reach across all of Rust |
| rustwasm / wasm-bindgen | `wasm-bindgen`*, `js-sys`, `web-sys`, `bumpalo` | WASM target only |
| BurntSushi | `fst`, `memchr`, `regex-automata` (if used) | |
| unicode-rs | `unicode-normalization`, `unicode-ident` | |
| the HPKE crate's author | `hpke` | Single-maintainer. Flagged, §5.8 |
| the zstd decoder/encoder author | pure-Rust zstd | Single-maintainer. Flagged |
| the ULID crate's author | `ulid` | Single-maintainer. **Candidate for removal** — ULID generation is under 100 lines and we already have `getrandom` and a monotonic counter requirement the crate does not encode |
| minisign verifier author | `minisign-verify` | Single-maintainer, small, and the security-critical one. §9.2 |
| oxc / lightningcss | build-only, not in the closure | §6.2 |

<!-- VERIFY: this table is derived from the crate set named in `32-cryptography.md` §15.1 plus the
     obvious additions for parsing, indexing and WASM glue. It has not been generated from a real
     `Cargo.lock`, because there is no code yet. Regenerate it from `cargo metadata` the day the
     workspace exists, and replace every count below with a measured one. -->

**Estimated realistic counts for this stack, and whether the caps hold:**

| Cap | Estimate | Holds? |
|---|---|---|
| C1 ≤ 30 direct | ~26–28 | **Yes, but with no headroom.** The 30th direct dependency will be a real argument, which is the point of the number |
| C2 ≤ 160 closure | ~130–170 | **Marginal.** The RustCrypto and `syn`/`serde` blocks are ~60 % of it between them. If the measured figure lands above 160 the honest response is to raise the cap once, with a written reason, not to quietly stop counting |
| C3 ≤ 25 publishers | ~12–16 | **Yes, comfortably.** This is the number that is genuinely good, and it is the number worth publishing |
| C4 ≤ 12 build scripts | ~6–10 | Yes |
| C5 ≤ 10 proc macros | ~5–8 | Yes. `serde_derive`, `wasm-bindgen-macro` and friends dominate |
| C6 = 0 npm | 0 | Yes — §6 |

**The honest statement about C2:** a cap of 100 is not achievable without either hand-rolling
cryptography (which `32` §15 correctly refuses) or dropping HPKE (which the sync design needs). A
cap that would require a worse security decision to satisfy is a bad cap. 160 is set where it is
because it is roughly what this design costs plus a small margin, and its job is to make growth
visible, not to be impressive.

### 5.3 Adding a dependency

Every addition is a reviewed change with a recorded decision. The record lives in
`deps/decisions/<crate>.md`, is committed, and is referenced from the SBOM.

The questionnaire — nine questions, all of which must be answered in the file:

| # | Question | Why it is on the list |
|---|---|---|
| 1 | What does it do that we cannot do in under 200 lines? | The `ulid` case above. Small crates that wrap something we already have are the cheapest to remove and the easiest to add by reflex |
| 2 | Who publishes it, and is that publisher already in our set? | C3. Adding a crate from an existing publisher costs less than adding a new publisher |
| 3 | How many crates does it add to the closure, transitively? | C2, and it is routinely surprising |
| 4 | Does it add a `build.rs` or a proc macro? | C4, C5, N22 |
| 5 | Does it add C, C++, or a `*-sys` crate? | C7. Automatic rejection |
| 6 | Does it read the clock, the filesystem, the environment or the network at build time? | N5, N6, N22 |
| 7 | What is its release cadence and its response to the last advisory that touched it? | Unmaintained is a supply-chain state, not a licensing one |
| 8 | Is it in the `cargo-vet` imported audit sets, and at what criteria? | §5.4 |
| 9 | **`acceptable_when`** — under what circumstances would we accept keeping it despite a finding against it? | Borrowed from invariant 8. A dependency exception with no stated conditions is a permanent exception |

Question 9 is deliberate. The rule format requires `acceptable_when` on every rule because a tool
that flags everything at maximum severity gets muted (brief §5.2). The same failure mode applies to
dependency policy: a policy with no articulated exceptions gets bypassed the first time it is
inconvenient, and after that it is decoration. So exceptions are first-class, they carry a reason,
and — like a suppression — they carry an expiry.

### 5.4 `cargo-vet` or `cargo-crev` — DECISION

| | `cargo-vet` | `cargo-crev` |
|---|---|---|
| Model | Organisation-level audit records, committed to the repo, imported from other organisations' audit sets | Individual reviewer identities with a web of trust |
| Identity layer | None — audits are attributed to the organisation, not a person | Cryptographic per-reviewer identity |
| Transitive trust | **None by design.** Trusting another org's audits is an explicit, independent decision | Yes, via the trust graph |
| Coverage today | Large, because Mozilla and Google publish audit sets that cover much of the popular crate space | Smaller |
| Fit with a repo-first, offline-first project | Audits are files in our repo; they diff, they review, they need no service | Requires the reviewer's identity infrastructure |

**DECISION — `cargo-vet`, with imported audit sets, and `cargo-crev` not adopted.**

Reasoning: `cargo-vet`'s artifact is a committed file, which fits a project whose entire
verification story is "the record is in the repo and you can read it". Its lack of transitive trust
is a feature here — importing an audit set is a decision we make once, in a diff, with a name on
it. `cargo-crev`'s per-reviewer identity is genuinely better in principle and worse in practice at
this scale, because a project with one maintainer contributes exactly one identity to a web of
trust, which is not a web.

**The honest cost:** importing Mozilla's and Google's audit sets means our dependency assurance is
substantially *theirs*. We are not auditing the RustCrypto stack ourselves and will not pretend to.
What we do is: import, record which sets we imported and at which criteria, and audit ourselves
only the crates nobody else has covered — which is precisely the single-maintainer tail in §5.2's
table, and which is also the highest-risk part of the set. That is the right allocation of a small
amount of review capacity, and it should be stated in exactly those words rather than as "our
dependencies are vetted".

`cargo-vet`'s criteria matter and get recorded: `safe-to-run` versus `safe-to-deploy` are different
claims, and a crate that reaches WASM linear memory holding a decrypted graph needs the latter.

### 5.5 `cargo-deny`

All four checks, in CI, on every commit, with the policy in `deny.toml`.

| Check | Policy | Failure is |
|---|---|---|
| `advisories` | Deny on any RustSec advisory. Deny `unmaintained`. **No `ignore` entries without an expiry date and a written reason in the same file** | Build-blocking |
| `licenses` | Allowlist only: Apache-2.0, MIT, BSD-2/3-Clause, ISC, Unicode-3.0, Zlib, CC0-1.0. Deny everything else including anything unlicensed or with a missing SPDX expression | Build-blocking |
| `bans` | `multiple-versions = "deny"` with a short, expiring skip list. Explicit deny list for crates we have decided against. `wildcards = "deny"` | Build-blocking |
| `sources` | crates.io only. **Zero git dependencies in the shipped closure**, ever — a git dependency is a mutable reference to somebody's branch | Build-blocking |

Two notes on the licence list. **Copyleft is denied not because it is bad but because A1 is a
single file that inlines everything**, and the obligations of a strong copyleft licence inside a
single-file artifact distributed by end users are a question we do not want to make our users
answer. And **`unmaintained` is denied as an advisory, not as a licence question**, because an
unmaintained crate is a crate whose next advisory has no responder.

`cargo-deny` runs against the same feature resolution as the build (§10.3). A `deny` run with
different features than the build checks a different graph.

### 5.6 Transitive depth — the position

**Depth is the wrong metric.** A closure of 160 crates at depth 3 and a closure of 160 crates at
depth 9 present the same attack surface: 160 crates' worth of code compiled into the artifact, from
however many publishers. Depth measures the shape of the graph, not its size, and a project that
optimises depth ends up flattening `Cargo.toml` — adding direct dependencies on things that were
already transitive — which makes the number better and the situation identical.

What we measure instead:

| Metric | Cap | What it actually bounds |
|---|---|---|
| Publisher count (C3) | 25 | The number of parties who can push code to our users |
| Closure size (C2) | 160 | The volume of code |
| Build-script count (C4) | 12 | The number of arbitrary programs run on the build host |
| Proc-macro count (C5) | 10 | The number of arbitrary programs run at compile time |
| **Newly-introduced-by-one-crate delta** | reported per PR, no cap | Makes "this adds one dependency" honest when it adds twenty-two |

The last one is the number that changes behaviour. `cargo tree` diffed before and after, printed
into the PR by CI, so the reviewer sees the real cost of the change rather than the declared one.

### 5.7 Build scripts and proc macros — the honest gap

This is the weakest part of the dependency story and it deserves its own paragraph rather than a
table cell.

**A `build.rs` and a proc macro are arbitrary programs that run on the build machine with the build
machine's privileges.** They can read the environment, read the filesystem, open sockets, and write
files. `cargo build` on an untrusted project is equivalent to running that project. There is no
sandbox in stable Cargo, and a proposal for sandboxed, deterministic proc-macro execution via WASM
exists but is not the shipping reality.

<!-- VERIFY: check whether any sandboxed proc-macro or build-script execution has stabilised since
     this was written. If it has, this section changes materially and C4/C5 can be relaxed. -->

What we do:

1. **Cap and enumerate** (C4, C5). Every build script and every proc macro in the closure is listed
   by name in `deps/build-scripts.md`, with one line on what it does.
2. **Read them.** For a closure this size that is a genuinely finite task — a few thousand lines
   total, mostly `cfg` probing and code generation — and it is the single highest-value manual
   review in the whole dependency policy, because it is where a compromise would go.
3. **Build with no network.** The build container has no route to anything except a local crate
   mirror populated in stage 2. A build script that tries to fetch fails. This does not stop a
   build script from doing damage locally, but it removes exfiltration and remote fetch, which are
   most of what these attacks want.
4. **Do not rely on reproducibility to catch it.** A malicious build script that behaves the same
   on every machine reproduces perfectly. §6.5 again.

**Residual: `material`.** Named, capped, enumerated, read — and still a hole. Anyone claiming
otherwise about a Cargo project is mistaken.

### 5.8 When we cannot satisfy the policy

Three crates in §5.2's table are single-maintainer and security-relevant. That is a real position
and the options are all imperfect:

| Option | When it is right |
|---|---|
| **Replace with a first-party implementation** | When the crate is small and the semantics are ours anyway. `ulid` is the clear case: we need monotonic-in-time generation with a specific ID format the conventions already pin, and that is less code than reviewing someone else's |
| **Vendor and freeze** | When the crate is correct today and we do not need its future. Vendoring converts a supply-chain risk into a maintenance obligation, and the obligation is real: we now own its advisories |
| **Audit it ourselves and record the audit** | When it is small enough to read completely. `minisign-verify` is in this category and must be, because it is the crate that decides whether a rule pack is trusted |
| **Accept, with an expiry** | When none of the above is affordable. The decision file carries an `acceptable_when` and a revisit date, exactly like a suppression |

**DECISION — no `[patch]` sections and no git dependencies in the shipped closure.** If we need a
fix that is not released, we vendor it into `vendor/` with the diff visible in our repo, or we wait.
A `[patch]` pointing at a fork is a dependency whose contents are not in the lockfile's hash.

---

## 6. The build pipeline as attack surface

*margin tab: why it exists*

> **THE ARTIFACT IS WHATEVER THE LAST PROGRAM TO TOUCH IT SAYS IT IS.**

### 6.1 The Node.js argument, properly stated

The owner brief §1 says: *"Node.js appears in the build pipeline only, and can be eliminated
entirely if desired (§8.6)."* That framing understates the case, and the understatement is worth
correcting, because the usual argument for removing Node is the weak one.

**The weak argument (runtime).** "No Node.js at runtime" is close to vacuous for this product. The
runtime is a browser tab and a WASM module. Node was never going to be in the artifact. Saying it
is absent from the runtime is saying that a thing which could not have been there is not there.

**The strong argument (build).** Node's absence from the *build* is load-bearing, and here is
exactly why:

| Property | Consequence for Fathom |
|---|---|
| `npm install` executes `preinstall`/`install`/`postinstall` scripts from arbitrary packages in the dependency tree, with the build host's privileges | Every package in the tree is a program that runs on the machine that produces the artifact users trust |
| Typical JS build trees are hundreds to thousands of packages | C2's equivalent number for a modern JS toolchain is an order of magnitude larger than the entire Rust closure |
| The install-script channel has been used for self-replicating worms at ecosystem scale — the "Shai-Hulud" campaign from September 2025 onward, which spread via `postinstall`, stole cloud and registry tokens, and re-published itself from compromised maintainer accounts, prompting a CISA alert on 2025-09-23 | This is not a hypothetical class. It is a demonstrated, repeated, automated one |
| Anything running on the build host can modify the artifact **before** it is hashed and signed | Link L4. Reproducibility catches this only if the malicious package behaves differently on different machines — and a competent one does not |

The last row is the one that settles it. **A build-time dependency is a runtime dependency of the
artifact it produces.** The distinction between "build" and "runtime" is meaningful for the user's
machine and meaningless for the artifact's integrity: a `postinstall` script that appends twelve
bytes to `app.js` produces an artifact that ships, hashes, signs and reproduces perfectly.

So the correct statement is not *"we removed Node.js from the runtime"*. It is:

> **We removed the JavaScript package ecosystem from the build, because the build defines the
> artifact and the artifact is the thing we ask you to trust.**

### 6.2 What replaces it

The Rust ecosystem now covers the whole JS/CSS toolchain as *library crates*, which means the UI
build becomes a Cargo target rather than a second package manager.

| Job | Was | Now | Form |
|---|---|---|---|
| TypeScript → JavaScript | `tsc` / babel / esbuild (Node) | `oxc` transformer | Rust library crate, called from our `xtask` binary. Pinned by `Cargo.lock` |
| Minification | terser / esbuild (Node) | `oxc` minifier | Same |
| Bundling | rollup / vite / webpack (Node) | Our own `xtask assemble` over the checked-in asset manifest (§3.5), plus `oxc` for module resolution if needed | Same. Note that a single-file artifact has a trivial bundling problem — the "bundle" is a concatenation in a fixed order |
| CSS | postcss / autoprefixer (Node) | `lightningcss` | Rust library crate |
| **Type checking** | `tsc` on Node | TypeScript 7's native Go compiler, which shipped 2026-07-08 and does not require Node <!-- VERIFY: confirm the 7.0 release date and that the distributed compiler is a standalone binary with no Node dependency for `--noEmit` type checking. Also confirm the missing public compiler API does not affect a plain `tsc --noEmit` gate — we do not use the API, but check. --> | A pinned native binary in the build container, SHA-256 recorded |

<!-- VERIFY: confirm that `oxc`'s minifier is production-ready as a Rust library crate at the
     version we would pin, independent of the npm distribution. If it is not, the fallback is to
     ship unminified JavaScript in A1 and pay the size, which is an acceptable outcome — the
     single file is already dominated by base64 WASM and index. Do not adopt a Node-based
     minifier as the fallback. -->

**The fallback position, stated so it is not invented under pressure later:** if any of the above
is not ready, the answer is to **do less**, not to reintroduce npm. Ship unminified JavaScript.
Write plain ES modules with no bundler. Hand-write the CSS. The UI is described in the brief as
"thin TypeScript" and in the design language as deliberately bare — no icon sets, no component
library, no gradients, no shadows. A UI with those constraints does not need a modern JS toolchain,
and noticing that is worth more than replacing the toolchain.

### 6.3 The residual: we still have toolchains

Removing npm does not produce a build with one toolchain. After the change:

| Toolchain | In the build for | Trust basis |
|---|---|---|
| Rust (rustup) | everything | Pinned by version and component checksum; the same trust root as the language |
| Binaryen (C++ binary) | `wasm-opt` | Pinned by SHA-256; transforms output only, and its output is verified by the R1 double-build |
| TypeScript 7 (Go binary) | type checking only, `--noEmit` | Pinned by SHA-256; **produces no artifact**, so a compromise of it cannot alter the output — it can only fail to report a type error |
| BuildKit | container image only | §3.7 |

**Three toolchains instead of four, and — more usefully — only one of them can change the
artifact.** That is the property worth stating: `tsc` emits nothing, `wasm-opt`'s output is
double-built and diffed, BuildKit only packages already-hashed files. The Rust toolchain is the
sole thing whose compromise silently changes what ships, and it is the one with the strongest
distribution security of the four.

That is a materially better position than "we took Node out", and it is the version that survives
being asked "so what is left?".

### 6.4 The build host

| Property | Requirement |
|---|---|
| Ephemeral | Fresh container per build. No state carried between builds. §11.7 |
| Network | No egress except a crate mirror in stage 2 and toolchain downloads in stage 1, both checksum-verified. Everything after stage 2 runs with no route |
| Credentials | **None**, stages 0–13. §3.4 |
| Cache | **Disabled for release builds.** §11.7 — a build cache is an input, and an input that persists between runs is a place to hide |

### 6.5 What reproducibility does not cover, restated where it bites

Stated in §1.3 and repeated here because it is the sentence most likely to be skipped:

> **A malicious dependency reproduces perfectly.** Every rebuilder fetches the same crate at the
> same version, compiles it, and gets the same bytes. Ten independent rebuilders confirming a
> release confirms that the release matches the source *and the dependency set*. It says nothing
> about the dependency set.

The controls for that are §5 — publisher count, audits, build-script review, and the fact that the
closure is small enough that reading it is a finite task. Those are weaker controls than
reproducibility and they defend a bigger surface. That asymmetry is uncomfortable and it is
accurate.

---

## 7. Signing and distribution

### 7.1 Two signature systems — DECISION

**DECISION — every release is signed twice: once with a long-lived offline project key in minisign
format, and once keyless via Sigstore with the signature recorded in the Rekor transparency log.**

The two answer different questions, and neither answers both.

| | Project key (minisign / Ed25519) | Sigstore keyless (Fulcio + Rekor) |
|---|---|---|
| Answers | "The holder of this specific key signed this" | "This exact CI workflow, in this repo, at this ref, signed this — and it is publicly logged" |
| Verifiable offline | **Yes.** Air-gapped, with a small tool | No. Needs the trust root and, for full assurance, the log |
| Verifiable with someone else's tool | Yes — `minisign`, which we did not write | Yes — `cosign`, which we did not write |
| Survives our infrastructure disappearing | Yes, if you have the public key | The log survives; the identity binding is to a repo that may not |
| Detects a targeted, one-user artifact | **No** | **Yes** — §12.3 |
| Fails if the key is stolen | Yes, silently, until revoked | An OIDC identity cannot be stolen the same way; a compromised workflow is visible in the log entry |
| Cost | Key custody, forever | A dependency on a public-good service |

Using only the project key means a stolen key is undetectable. Using only Sigstore means an
air-gapped verifier cannot check anything, which is disqualifying for a product whose flagship
deployment is a file on a USB stick. So: both, and the manifest carries both.

This is the same reasoning that made `12-rule-engine.md` §13.2 choose minisign format for rule
packs — *"the ability to check our work with someone else's tool is worth more than a bespoke
format"* — extended one step.

### 7.2 The project key

| Property | Choice |
|---|---|
| Algorithm | Ed25519, minisign-format detached signatures |
| Custody | Offline. Not on a CI runner, not in a secrets store, not in an HSM we rent. Signing is a manual step on an offline machine, §11.5 |
| Published | Full public key in the README, in the repo, in the release page, and in the application's build-identity panel (§13.3). Fingerprint in the enterprise review pack |
| Rotation | A new key is announced by a message signed with the old key, published for a stated overlap period during which releases are signed with both |
| Compromise | Announced by a signed message from the new key **and** by an entry in the advisory bundle (§8.4) **and** in the Rekor log via the Sigstore path, which is the one a stolen project key cannot suppress |

**The cost of offline custody, stated:** releases cannot be fully automated. A human runs a signing
step on a machine that is not the build machine. That is friction, it makes hotfixes slower, and it
is the correct trade — a signing key on a CI runner is a signing key in reach of anyone who can
change a workflow file.

**Note on hash families.** The project's internal content hash is BLAKE3-256 (`12` §13.2, `32`).
The release manifest carries **both** BLAKE3-256 and SHA-256 for every artifact, because
`sha256sum`, OCI registries, cosign and most enterprise tooling speak SHA-256 and a verifier should
not have to install anything to do step 4 of §4.1. Using our preferred hash at the boundary where
other people's tools have to work is a small vanity with a real cost.

### 7.3 Sigstore, Rekor, and what the log is actually for

`cosign` signs with a short-lived certificate from Fulcio, bound to an OIDC identity — for a GitHub
Actions release job, that identity encodes the repository, the workflow file and the ref. The
signature, certificate and inclusion proof are recorded in Rekor and packaged in a Sigstore bundle.
Rekor v2 went GA in October 2025 on a tile-backed backend, is sharded by year, and cosign gained
v2 support in v2.6.0.

**Verification, for the manifest:**

```bash
cosign verify-blob \
  --bundle MANIFEST-<ver>.sigstore.json \
  --certificate-identity-regexp '^https://github\.com/<org>/<repo>/\.github/workflows/release\.yml@refs/tags/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --use-signed-timestamps \
  MANIFEST-<ver>.txt
```

**The point of the log is not the signature. It is the absence of a second one.** A signature says
"we signed this". A transparency log says "this is what we signed, and here is everything else we
signed, and there is nothing else". That is the property that makes a targeted backdoor — a build
shipped to one user and nobody else — detectable rather than merely wrong, and it is the single
strongest control in §12.

**RECOMMENDATION — publish, alongside each release, the Rekor log index and inclusion proof**, so a
verifier can check log membership without a search API (Rekor v2 dropped the search index).

**In-toto build provenance.** In addition to signing artifacts, the release workflow attests build
provenance. GitHub Artifact Attestations bind the artifact digest to a SLSA provenance predicate
signed with a Sigstore certificate; the documentation is explicit that attestations alone reach
SLSA v1.0 Build Level 2, and that Build Level 3 requires generation via a reusable workflow so the
provenance generator can be centrally verified. We use a reusable workflow. `actions/attest` is the
current entry point; `actions/attest-build-provenance` is a wrapper over it from v4 onward.

<!-- VERIFY: confirm the current recommended action name and the exact SLSA level language before
     putting a level number in published material. Claiming a SLSA level we do not meet is exactly
     the kind of overclaim `31` §10 exists to prevent. -->

**RECOMMENDATION — do not put a SLSA level number on the download page.** Publish the provenance
and let a reviewer assign the level. A level number is a claim that ages badly and that reviewers
enjoy disproving.

### 7.4 Container signing

`cosign sign` the image by digest, keyless, and additionally attach the SBOM (A8) and the
provenance attestation. Verification by digest, never by tag. The tag is a pointer; the digest is
the artifact.

### 7.5 What a release consists of

```text
fathom-<ver>/
  MANIFEST-<ver>.txt                 every artifact: path, size, blake3, sha256, repro level
  MANIFEST-<ver>.txt.minisig         project key
  MANIFEST-<ver>.sigstore.json       keyless bundle + inclusion proof
  fathom-<ver>.html                            A1
  fathom-web-<ver>.tar                         A2
  fathom_core-<ver>.wasm                       A3
  fathom-<ver>-x86_64-unknown-linux-musl       A4
  fathom-<ver>-aarch64-apple-darwin            A4  (unsigned digest in manifest; §2.3)
  fathom-<ver>-x86_64-pc-windows-msvc.exe      A4  (unsigned digest in manifest; §2.3)
  fathom.ipsec-<packver>.fpack + .minisig      A6
  fathom-<ver>.cdx.json                        A8
  fathom-corpus-<ver>.cdx.json                 A9
  advisories-<date>.fadv + .minisig            A11
  REPRODUCE.md                       the ladder in §4.1, on one page
  toolchain.lock.toml                the pins
  wasm-opt.flags                     verbatim
```

**Every individual artifact is not separately signed.** The manifest is signed and it contains every
digest. One signature to check, one file to read, and a verifier who checks the manifest and then
checks digests has exactly the same assurance with a tenth of the ceremony. The `.fpack` is the
exception because it is installable independently of a release and must carry its own signature
(`12` §13.2).

### 7.6 The version manifest with an expiry

`31` §8.3 identifies rollback and freeze (branch C5) as the branch that defeats signing without
breaking it, and specifies the countermeasure: a signed version manifest that names the current
version and stops being valid after a stated date, so serving a stale one eventually fails closed —
the shape The Update Framework formalises, without adopting the whole framework.

| Field | Purpose |
|---|---|
| `current_version` | What the project considers current |
| `known_bad` | Versions with a published advisory, with the advisory id |
| `issued` / `expires` | The freshness window. Default 30 days |
| `min_supported` | Below this, the client says so plainly |

The **online** builds fetch it from the one origin they are allowed to talk to and surface
staleness. The **offline** build never fetches it, cannot fetch it, and §8.2 is about what that
means.

There is a pleasing echo here with the field card's first bring-up step, `commit confirmed 5` — a
change that reverts itself unless someone actively confirms it. An expiring manifest is the same
idea pointed at a release: freshness that must be re-asserted rather than assumed.

### 7.7 Distribution

| Channel | Control |
|---|---|
| One canonical download location, named in the README, in the app, and in the review pack | Against typosquatting there is no technical control (`31` §8.3 C1.3) — only a canonical location and a fingerprint people can compare |
| TLS, HSTS, and a published fingerprint underneath it | Layered, and the signature does not depend on the transport |
| Mirrors | Permitted and expected, especially for air-gapped sites. **A mirror is untrusted**: the manifest signature is what makes a mirror safe, which is the point of signing the manifest rather than trusting the host |
| Registries (crates.io for the CLI, ghcr for the image) | Both are third parties. Both get the same treatment: publish the digest, sign the digest, verify by digest |

---

## 8. The update channel, per deployment mode

*margin tab: no channel at all*

> **AN OFFLINE ARTIFACT CANNOT LEARN THAT IT IS DANGEROUS. SOMEBODY HAS TO TELL A PERSON.**

### 8.1 The modes

`31` §8.3 already contains the governing decision: **no silent auto-update, in any build.** An
auto-updater is a signed remote-code-execution channel pointed at every user. What follows is what
each mode does instead.

| Mode | Learns about updates how | Applies them how | Time to patch |
|---|---|---|---|
| **Offline single file (A1)** | **Not at all.** `connect-src 'none'`. It cannot ask and will not be told | A human downloads a new file | **Unbounded.** §8.2 |
| **Docker single-node (A5)** | The operator's own image-update process | Operator pulls a new digest, restarts | Hours to months, depending on the operator |
| **Enterprise cluster** | Same, plus whatever change process wraps it | Rolling restart | Same |
| **Served browser build (A2)** | The user gets whatever the operator serves, on reload | Automatically, on reload, from the operator's origin — **which is why `31` §5.1 row 2's residual includes serving altered assets** | Immediate, and immediacy is the risk here, not the benefit |
| **CLI (A4)** | Package manager, or the version manifest if online | Whatever the operator does | Varies |

The served build is the only mode where an update propagates quickly, and that speed is also its
weakness: the operator can change what every user runs without anyone downloading anything. The
control is that the served build's asset digests are checkable against the published release
(`31` §8.3 C1.5), and §13.3 puts them where a user can copy them.

### 8.2 The offline mode, and what shipping a security fix means

State it plainly, because there is no clever answer:

> **For an offline single-file install, there is no update channel, there will not be one, and a
> security fix reaches that install only when a human being downloads a new file and replaces the
> old one. Some installs will never do this. Some installs will run a build with a known defect for
> years. That is a direct consequence of invariant 1 and we are not going to trade invariant 1 for
> a patch pipeline.**

What follows from that, concretely:

1. **Defect severity is scoped by what the artifact can do.** This is the mitigation, and it is
   structural rather than procedural. An offline A1 has no egress, holds no device credentials
   (invariant 3), touches no device (invariant 2), and the server holds no key (invariant 4). The
   realistic worst case for a defect in A1 is: it renders a wrong finding, emits a wrong config
   line, or fails to protect the workspace at rest. All three are serious. None of them is
   "attacker gains remote access", because there is no remote.
2. **Therefore the defect classes that matter most are the ones §11 and §5 are aimed at.** A
   cryptographic defect in the envelope, a parser defect that corrupts a graph, an emitter defect
   that produces a weakening without a finding (`31` §9.4). These are the ones worth a coordinated
   announcement.
3. **The announcement is the delivery mechanism.** Not the software. A published advisory, signed,
   at a canonical location, plus the advisory bundle in §8.4 for sites that carry files in on
   removable media.
4. **The artifact tells the user how old it is**, which is not the same as telling them it is
   stale, and §8.3 is careful about that distinction.
5. **Enterprises are the realistic patch path for air-gapped installs.** An organisation that runs
   Fathom offline has a software-distribution process for everything else it runs offline. The
   useful thing we can build for them is not an updater; it is a machine-readable manifest and a
   `fathom verify` command their existing process can call. §13.2.

**The cost, added up:** mean time to patch for offline installs is unbounded and unmeasurable — we
have no telemetry (invariant 1) and would refuse it if offered. We cannot say how many installs are
running an old build. We will be asked this in enterprise review and the answer is "we do not know,
by design, and here is how you find out for your own estate: `fathom verify` in your inventory
tooling."

### 8.3 Staleness, surfaced honestly

`31` §8.3 specifies the shape: the client knows its own build date offline and surfaces its age as
a margin tab (`build 2026-07-14 · 128 days old`) rather than a badge or a nag, and **age is not the
same as staleness**.

| The app can say | The app must not say |
|---|---|
| `build 2026-07-14 · 128 days old` | "Update available" — it does not know that |
| `advisories known at build: 3` | "You are secure" |
| `advisory bundle: none loaded` | "No known issues" — absence of information is not information |
| When online and the manifest was fetched: `current release 2026-11-02 · you are 3 releases behind` | Anything at all, when offline |

The distinction between *"I am 128 days old"* and *"I am out of date"* is exactly the distinction
the field card draws between a tunnel reading `UP` and a tunnel passing traffic. The first is a
fact about the local object. The second is a claim about the world that the local object is not in
a position to make.

### 8.4 The advisory bundle — DECISION

**DECISION — advisories ship as a signed, installable file with the same shape, trust root and
install path as a rule pack.**

```text
advisories-2026-11-02.fadv          tar + zstd, deterministic (as `12` §13.1)
advisories-2026-11-02.fadv.minisig  first-party key only; scope does not permit third-party keys
```

Contents:

| Field | Purpose |
|---|---|
| `issued`, `expires` | Freshness, same as the version manifest |
| `bad_versions[]` | Fathom versions with a published defect, with id, severity, one-line description, and what to do |
| `bad_keys[]` | Revoked signing keys, first-party or pack-publisher (`12` §13.7's "revocation list shipped with each app release", made carryable) |
| `bad_packs[]` | Rule pack id + version ranges withdrawn |
| `advisory_urls[]` | For anyone who can reach the network |

**Why this shape and not a network fetch:** it costs nothing to design, because the verification
path, the trust store, the caps and the offline install flow already exist for rule packs (`12`
§13.5). An air-gapped site already carries `.fpack` files in on removable media; `.fadv` rides the
same trip. And it does not require the application to open a connection, so invariant 1 is
untouched.

**Its limit, stated:** a site that carries nothing in learns nothing. This mechanism helps sites
with a process and does nothing for a file somebody downloaded once and forgot. Nothing helps that
case. Saying so is better than shipping something that appears to.

---

## 9. Rule packs and corpus as a supply chain of their own

*margin tab: what a pack can do*

> **A SIGNATURE BOUNDS WHO, NEVER WHAT.**

### 9.1 Why these are a supply chain and not content

A rule pack changes what the user is told about their own network, and a corpus entry changes what
the user learns. `31` §2.2 argues that the findings list outranks the configuration as an asset;
§8.2's attack tree finds that goal B — cause a bad configuration to be deployed — is *cheaper* than
goal A, and that its cheapest branches are all rule-pack and corpus branches. So packs are not
"content with a signature bolted on". They are downloadable code-equivalent artifacts whose effect
is on judgement rather than on execution.

### 9.2 What is already decided, and not re-decided here

| Property | Where | Summary |
|---|---|---|
| Container and determinism | `12` §13.1 | tar, sorted, zeroed metadata, zstd 19, caps on size and entry count, path rules against zip-slip |
| Signature | `12` §13.2 | Ed25519, minisign-compatible detached, trusted comment carries pack id, version, BLAKE3-256, covered by the second global signature |
| Trust root | `12` §13.3 | First-party key compiled into the binary, not configurable. No trust-on-first-use. Imported keys require the full public key and a typed fingerprint confirmation. Keys are **scoped** by pack-id prefix |
| Install path | `12` §13.5 | Eleven steps, entirely local, no network ever |
| Revocation | `12` §13.7 | `pack.expires` default build date + 400 days; revocation list per app release; key scoping. **Offline revocation is not solvable** |
| Override limits | `12` §12.6 | Presentation-only overrides. `condition`, `applies_to`, `requires`, `platforms` cannot be changed under someone else's rule id |

This document adds four things on top.

### 9.3 What this document adds

**1. Pack builds are reproducible and the pack build is part of the release verification.** The
`.fpack` bytes are a function of the pack source tree, and `12` §13.1 already designs for that. What
§4 adds is that the pack is in the release manifest, so verifying a release verifies the pack, and
a third party rebuilding from the tag reproduces the pack bytes too. A pack whose bytes cannot be
reproduced from a public source tree should not be signed by the first-party key.

**2. Packs get provenance and log entries.** First-party packs are signed by the project key **and**
recorded in Rekor via the release. Third-party packs cannot be, and that asymmetry should be
visible in the UI: a pack signed by a key in the trust store with a public log entry and a pack
signed by a key someone imported are not the same thing, and the pack list should say which is
which in the muted register rather than treating both as "trusted".

**3. A content BOM.** A9. The corpus is a supply chain and nobody produces a bill of materials for
one. §10.2.

**4. The corpus review gate.** Invariant 10 requires a named human reviewer in `reviewed_by` on
every corpus entry. CI enforces it as a build gate: an entry with an empty, missing, or
non-resolving `reviewed_by` fails the corpus build. And — because this is the part that gets
skipped — **the reviewer may not be the author.** A commit that adds an entry and names its own
author as reviewer is rejected. At a one-maintainer project that is a hard constraint with an
uncomfortable consequence, and §12 does not pretend otherwise.

### 9.4 What a malicious pack can and cannot do

The bound comes from the engine's sandboxing decision (`12` §3): a rule condition is written in
`fex`, which is not Turing-complete, has no I/O, no loops, a bounded evaluation, and a name
environment restricted to the selected node's fields.

| A malicious pack **can** | A malicious pack **cannot** |
|---|---|
| Suppress a real weakness by shipping a rule that never fires | Execute code |
| Downgrade severity so a finding sorts below the fold | Read the workspace outside its selector |
| Write an `acceptable_when` that manufactures consent | Open a network connection — the engine has no such capability and the CSP has no such origin |
| Ship a remediation whose syntax is valid and whose semantics are wrong | Reach the passphrase, the envelope, or key material |
| **Mislabel a remediation's `Risk`** — mark a `Disruptive` line `ReadOnly` | Change another pack's rule logic — `12` §12.6 forbids overriding `condition`, `applies_to`, `requires`, `platforms` under someone else's id |
| Ship explainer prose that teaches a wrong verification step | Alter the emitter, the parser, the graph schema, or the export gate (`31` §9.4) |
| Consume install-time resources up to the caps | Exceed the 64 MiB / 5,000-entry caps, or escape the path rules |

**The `Risk` mislabelling row is the most dangerous entry in the table** and it is worth pulling
out. The three-value legend is the same on paper and in the tool, deliberately (brief §5.3), and its
whole value is that an engineer trusts it at a glance. A pack that marks
`clear security ike security-associations` as `ReadOnly` is attacking that trust directly — and per
the field card, clearing Phase 1 *"tears down every child SA under it — on a hub that is every
spoke at once."*

**RECOMMENDATION — `Risk` on a remediation line is not a pack-authored field for command forms the
first-party corpus already knows.** Where a remediation names a command that exists in the command
corpus, the engine takes `risk` from the corpus entry, not from the pack, and a disagreement is a
pack validation failure. Where the command is unknown to the corpus, the pack's value stands and
the line is rendered with a muted margin note saying the classification is the pack's. This costs a
cross-check at pack compile time and removes the highest-consequence lie a pack can tell.

### 9.5 Worked example — a hostile pack, from the field card

The field card's PFS section is the most complete piece of security reasoning in the source
material, and `63-rulepack-spec.md` §17.1 turns it into `ipsec.pfs.absent`. Here is what a hostile
version looks like, and exactly which controls fire.

```yaml
# acme.internal.baseline 4.2.0 — a hostile override. What happens to each line.
overrides:
  - rule: ipsec.pfs.absent
    severity: info                    # ALLOWED. Presentation-only override (12 §12.6).
                                      # Effect: the finding sorts below the fold and
                                      # stops looking like something to act on.
    acceptable_when: >                # ALLOWED, and this is the real payload.
      Acceptable on any tunnel to a partner that has not completed its
      2027 platform refresh. Compensate at the firewall.
                                      # Reads like the card. Is not true. The card:
                                      # "One compromised IKE SA secret unlocks every
                                      # data key derived under it — including traffic
                                      # somebody recorded off the wire months ago."
    condition: "false"                # REJECTED. `condition` cannot be overridden
                                      # under another pack's rule id. Install fails,
                                      # naming the field and the owning pack.
    platforms: []                     # REJECTED. Same reason.
```

| Control | Fires? | What it does |
|---|---|---|
| Signature check (`12` §13.5 step 2) | Only if the key is untrusted | A pack signed by a key the org imported deliberately passes. **This is the residual: signing bounds who, not what** |
| Key scope (step 3) | Yes, if mis-scoped | `acme.internal.*` cannot sign `fathom.ipsec`. It *can* ship overrides under its own pack id, which is what the example does |
| Override field allowlist (`12` §12.6) | **Yes** | `condition` and `platforms` are rejected; install fails and names them |
| Severity override | No | Permitted by design. Organisations legitimately re-rank findings |
| `acceptable_when` text | **No** | Nothing checks whether a justification is true. There is no mechanism that could |
| Install summary (step 11) | Partly | The summary shows n rules, n quarantined, n shadowed, n severity-high — so a pack that downgrades forty high-severity rules is *visible at install*, if anyone reads it |
| Pack diff between versions | Yes, if run | The pack is deterministic and diffable. `4.1.0 → 4.2.0` shows the severity change and the prose change as a text diff |

**The honest conclusion:** the only controls that catch this are the install summary and the diff,
and both require a human to look. Everything technical passes. That is `31` §5.1 row 11's `material`
residual, in a worked example, and the reason `31` §14.2 proposes adding *"a signature bounds who
published a pack, never whether its rules are correct"* to invariant 5.

**What we can do that we are not doing yet:** make the diff mandatory rather than available. A pack
upgrade that changes severity or `acceptable_when` on any rule the user has an active finding
against should show that specific diff at install, not just a count. That is a UI change and it is
listed in §16.

---

## 10. SBOM

### 10.1 Format — DECISION

**DECISION — CycloneDX 1.6 JSON as the published SBOM, generated in-build; `cargo auditable` used
additionally to embed the dependency list in the CLI binary.**

| Option | Verdict |
|---|---|
| **CycloneDX 1.6 JSON** (`cargo-cyclonedx`) | **Chosen.** An Ecma standard <!-- VERIFY: the standard number for CycloneDX 1.6 --> with first-class Rust tooling, good support in scanners, and a compact JSON form that diffs |
| SPDX (ISO standard, 2.2.1 onward) | Not chosen as the primary. Better recognised in procurement, larger documents, weaker Rust-native generation. **We convert on request** rather than maintaining two |
| `cargo auditable` alone | Not sufficient as a published SBOM: it uses its own compact format, deliberately, because it operates under different constraints. `auditable2cdx` converts a binary's embedded data back to CycloneDX |
| No SBOM | Not an option for anything an enterprise will deploy |

**Both, in different places, for different reasons.** The published CycloneDX file is for humans and
scanners before deployment. The embedded `cargo auditable` data is for the incident responder who
has a binary and no idea which release it came from — which is the actual situation during an
incident, and the reason the embedded copy is worth its few kilobytes.

<!-- VERIFY: confirm `cargo auditable`'s linker-section embedding works on `wasm32-unknown-unknown`
     as a custom section, and that `wasm-opt` does not strip it. If wasm-opt strips it, either add
     the section after wasm-opt or accept that A3 has no embedded BOM and rely on A8. -->

### 10.2 What goes in — and the part nobody does

Two documents, because there are two supply chains.

**A8 — `fathom-<ver>.cdx.json`, the code BOM.** Standard: every crate in the shipped closure with
name, version, purl, licence, and hash. Plus, in `metadata`:

| Field | Why |
|---|---|
| Toolchain identity: rustc version, `wasm-bindgen`, `wasm-opt`, BuildKit | The toolchain is part of the supply chain and almost no SBOM records it |
| The build container digest | §3.2 |
| `SOURCE_DATE_EPOCH` and the git tree hash | Ties the BOM to a reproducible build |
| The feature set the build resolved | §10.3 |
| Per-component: whether it has a `build.rs`, whether it is a proc macro | C4, C5 — and it is the field a reviewer actually wants |

**A9 — `fathom-corpus-<ver>.cdx.json`, the content BOM.** The corpus is authored YAML that decides
what the user is told, and it has versions, provenance, reviewers and hashes exactly like code does.
Nobody ships a BOM for this and it is strictly more relevant to this product than the crate list.

| Component | Fields |
|---|---|
| Each rule pack | id, semver, BLAKE3 of the canonicalised rule tree, signing key fingerprint, `expires` |
| Each rule | id, version, severity, `platforms`, `versions`, `reviewed_by`, source citations |
| Each explainer | id, depth coverage, `reviewed_by` |
| Each command corpus entry | id, platform, `risk`, `reviewed_by` |
| The finder index | version, content hash, the weights file hash |

**What A9 buys a consumer that A8 does not:** the ability to answer *"which of our findings came
from a rule that changed in the last release, and who reviewed it"* — which is the question a
security team asks after a tool tells them something surprising, and which is unanswerable today
for every comparable product.

### 10.3 Generation and publication

Generated **inside the build**, at stage 12, from the same `cargo metadata` invocation and the same
feature resolution as stages 4 and 11.

**This is the trap in SBOM generation and it is worth a paragraph.** Cargo unifies features across a
resolution. An SBOM generated by a separate `cargo cyclonedx` run with different feature flags, a
different target, or dev-dependencies included lists a *different set of crates* than the ones in
the artifact. It is then wrong in the most dangerous way available: plausible, detailed, and not a
description of the thing you shipped. So:

| Rule | Enforced by |
|---|---|
| Same target triple, same `--features`, same `--no-default-features` as the shipped build | The SBOM step takes its arguments from the same variable as the build step |
| dev-dependencies and build-only tooling **excluded from the component list**, listed separately under a distinct property | The generator config, asserted by a CI test |
| The SBOM's own SHA-256 is in the release manifest | Stage 13 |
| CI cross-check: the set of crates in A8 equals the set of crates the linker actually saw | A test that reads `cargo build --build-plan` output <!-- VERIFY: confirm a stable mechanism for extracting the actually-linked crate set on the wasm target; `--build-plan` is unstable. `cargo auditable`'s embedded data is the fallback source of truth. --> |

### 10.4 What a consumer does with it

Three consumers, three different actions, and only one of them is the one people talk about.

| Consumer | What they do | What they need from us |
|---|---|---|
| **Vulnerability scanner / security team, before deployment** | Ingest A8, match purls against advisory databases, produce a finding list | Accurate purls, accurate versions, a licence field, and the file to be signed so they know it is ours |
| **Procurement / compliance** | Check the licence set against policy, check for anything with an unclear licence | The licence field, and A8 to be present at all — for many organisations its existence is the requirement |
| **Incident responder, during an incident** | "CVE-X is in crate Y. Are we affected, and which of our deployments?" Answer in minutes, from binaries they already have | The **embedded** `cargo auditable` data (§10.1), plus A8 archived per release. This is the one that matters and the one SBOM programmes usually under-serve, because they publish SBOMs and then cannot map a running binary to one |

The fourth thing people expect and do not get: **an SBOM does not tell you a dependency is safe.**
It tells you what was declared. `31` §10.1's discipline applies — the claim is "here is what is in
it", not "here is why that is fine".

### 10.5 The honest limits

| Limit | Detail |
|---|---|
| Declared, not observed | It lists what the manifest resolved, not what executed. A crate compiled in but never called still appears |
| No transitive semantics | It cannot say a vulnerable function is unreachable. `cargo-audit`'s reachability analysis is a separate, partial thing |
| Wrong the moment features change | §10.3 |
| Silent about first-party code | The largest single body of code in the artifact is ours, and an SBOM says nothing about it. The controls there are §12 and public source |
| Silent about the toolchain, unless you add it | Which is why A8 does (§10.2) |

---

## 11. CI/CD hardening

*margin tab: least privilege*

> **A CI RUN IS A SHELL ON THE MACHINE THAT BUILDS WHAT YOUR USERS RUN.**

### 11.1 What a compromised CI run can do

| If an attacker can run code in… | They can |
|---|---|
| A PR build from a fork | Read whatever the job can read. **With no secrets and no write token, that is the public repo — which they already have** |
| A build on the default branch | Modify the artifact before it is hashed. §3.4 stages 0–13 |
| The release job | Sign a modified artifact — unless the signing key is offline (§7.2), in which case they can only get a Sigstore signature, which is **public and logged** |
| The workflow definition | Everything above, and it is a reviewable file, which is the control |
| The build cache | Modify the artifact via a poisoned cache entry, on a build that looks entirely normal |

The last row is the underrated one and §11.7 addresses it.

### 11.2 Token scope

| Scope | Value |
|---|---|
| Default `GITHUB_TOKEN` permissions | `contents: read`, repository-wide, set at the top of every workflow |
| Per-job elevation | Only the job that needs it, only the permission it needs, on one line, in that job's block |
| `id-token: write` | **Only** the attestation/signing job. It is the permission that mints a Sigstore identity |
| `packages: write` | Only the publish job |
| `contents: write` | Only the release-publishing job |
| PAT / long-lived tokens | None in CI. Anywhere |
| Third-party service tokens | None. If a service needs a token, it is not in the release path |

### 11.3 Pinned actions

| Rule | Reason |
|---|---|
| Every `uses:` is pinned to a **full 40-character commit SHA**, with the human version in a trailing comment | A tag is mutable. `@v4` is a pointer to whatever the action's owner points it at today |
| Updates arrive as PRs from an automated updater, and each is **reviewed as a dependency addition** (§5.3), not merged on green | An automated updater that auto-merges pinned digests has reinvented the mutable tag with extra steps |
| The action set is capped and enumerated in `.github/ACTIONS.md`, with a one-line justification each | The same discipline as §5.7 |
| No action in the release path that is not published by GitHub or by a project we have explicitly reviewed | The release path is the shortest path to every user |

### 11.4 Fork PRs

| Rule | Reason |
|---|---|
| `pull_request_target` is **forbidden**. Not discouraged — forbidden, and a CI lint greps for it | It runs the base repository's workflow with write access and secrets, in a context an attacker controls the code of. It is the single most-exploited GitHub Actions pattern |
| Fork PR builds get no secrets, `contents: read`, and no `id-token` | There is nothing for a malicious PR to steal |
| Fork PR builds do not run on self-hosted runners | A self-hosted runner executing fork code is a shell on your infrastructure |
| Fork PR builds do not publish anything, including preview deployments | A preview deployment is a publish |
| A maintainer merging a fork PR is the point at which the code becomes trusted, and that is a **human review**, not a label | There is no automation for "is this contributor benign". `31` §5.1 row 12 |

### 11.5 The release path

| Control | Detail |
|---|---|
| Protected default branch | No direct pushes, required review, required status checks, linear history |
| Tag protection | Release tags match a protected pattern and cannot be created or moved by anyone outside the release role |
| Environment gate | The publish job runs in a protected environment with required reviewers; the approval is recorded |
| **Two-person review on the release path** | Required — and §12.3 states the condition under which this is currently a lie |
| Signing | The Sigstore half is automated in CI. The project-key half is **manual, offline, on a machine that is not the build machine** (§7.2) |
| Build/publish split | §11.6 |

### 11.6 The build/publish split

Two jobs, two credential sets, one handover, and the handover is a digest.

```text
job: build            permissions: contents: read
                      secrets: none
                      runs: repro.sh
                      uploads: artifacts + MANIFEST (unsigned)

              ── artifact digests are the only thing that crosses ──

job: attest           permissions: id-token: write, attestations: write
                      needs: build
                      verifies: digests match what build declared
                      produces: provenance attestation, sigstore bundle

job: publish          permissions: contents: write, packages: write
                      needs: attest
                      environment: release (required reviewers)
                      pulls artifacts BY DIGEST, publishes
```

The build job has nothing worth stealing. The publish job builds nothing. Neither job holds the
project key. This is the same reasoning as `31` §5.1 row 2's separation of concerns, applied to our
own infrastructure.

### 11.7 The build cache

**DECISION — release builds run with all caching disabled.**

A build cache is an input to the build. A cache entry is a file produced by an earlier run,
restored into a later one, and used without being rebuilt. If an attacker can write to the cache —
from a fork PR build, from a compromised earlier run, from a cache-key collision — they can change
what a later build produces without touching the source.

| Build kind | Cache |
|---|---|
| PR builds, tests, lints | Cached. Speed matters, and a poisoned test result is a nuisance, not a shipped artifact |
| Release builds, R1/R2/R3 reproducibility builds, the independent rebuild | **No cache.** Cold every time |

The cost is the §4.2 compile time, twice per release, plus the nightly. That is the correct price
and it is small compared with the class of attack it removes.

**Cache scoping, for the builds that do cache:** keys include the toolchain version and the
`Cargo.lock` hash, caches are not shared between the default branch and PR branches, and fork PRs
get an isolated scope.

### 11.8 What CI enforces — this document's rows

To be merged with `31` §12's table rather than duplicated.

| Check | Enforces | Fails the build when |
|---|---|---|
| R1 double-build | §3.1 | Any artifact digest differs between two builds in one run |
| R2 / R3 | §3.1 | Digests differ across hosts, or under the hostile environment |
| Independent rebuild | §4.6 | The second pipeline's digests differ |
| Toolchain checksums | §3.2 | Any pinned download mismatches |
| `wasm-bindgen` lockstep | §3.2 | CLI version ≠ crate version |
| Environment scrub | N11 | A variable outside the allowlist is set |
| `read_dir` / glob / wall-clock lints | N5, N8, N9, N17 | First-party build code can observe filesystem order, hash order, or the clock |
| `cargo-deny check` (all four) | §5.5 | Any advisory, non-allowlisted licence, banned crate, duplicate version, or non-crates.io source |
| `cargo-vet` | §5.4 | Any crate in the closure lacks an audit or an exemption with a reason and an expiry |
| Cap assertions C1–C6 | §5.1 | Any cap exceeded, with the specific number in the failure message |
| `cargo tree` delta report | §5.6 | Never fails; always posts. A PR adding 22 crates says so in the PR |
| SBOM feature-set equality | §10.3 | The SBOM's crate set differs from the build's |
| `pull_request_target` lint | §11.4 | The string appears in any workflow |
| Action pin lint | §11.3 | Any `uses:` is not a 40-hex SHA |
| Cache-disabled assertion | §11.7 | A release or reproducibility job restores a cache |
| Corpus `reviewed_by` gate | §9.3 | An entry has no reviewer, or the reviewer is the author |
| Pack `Risk` cross-check | §9.4 | A pack's remediation `risk` disagrees with the command corpus |

---

## 12. The insider-threat question

*margin tab: the honest one*

> **NOTHING STOPS THE MAINTAINER SHIPPING A BACKDOOR. THE ARCHITECTURE MAKES IT DETECTABLE,
> ATTRIBUTABLE AND PERMANENT IN A PUBLIC LOG. THAT IS A DIFFERENT PROPERTY AND IT IS THE ONLY ONE
> ON OFFER.**

### 12.1 The answer

Asked directly — *what stops you shipping a backdoor?* — the answer is: nothing does.

Every control in this document is a **detection** control, not a **prevention** control:

| Control | Prevents | Detects |
|---|---|---|
| Reproducible builds | Nothing a maintainer does | A binary that does not match the source. Useless against a backdoor *in* the source |
| Public source | Nothing | A backdoor, by anyone who reads that code path. Nobody reads all of it |
| Transparency log | Nothing | A targeted artifact — §12.3. This is the one with real teeth |
| Two-person review | A single person acting alone, **if two people exist** | §12.4 |
| SBOM | Nothing | A dependency change |
| Deterministic output (invariant 9) | Nothing | Behaviour that varies between runs — which a competent backdoor would not do |

`31` §3.1 already ranks A12, the insider with build or release access, as having *"A8's leverage
with A1's legitimacy"* at a cost of *"zero, if we hired them"*. This section is what to say about
that.

### 12.2 What actually raises the cost

Ranked by how much they raise it, which is not the order they are usually listed in.

| # | Control | Effect | Honest weakness |
|---|---|---|---|
| 1 | **The transparency log** | Converts "we ship everyone the same artifact" from a promise into a checkable fact. A targeted build either has no log entry (verification fails) or has one (it is public forever) | Only helps if verification is actually performed. §13 |
| 2 | **Reproducible builds + published source** | Forces the backdoor into the source, where it is at least in principle readable, rather than into the build, where it would be invisible | "In principle readable" is doing enormous work |
| 3 | **Determinism as a product invariant** | Invariant 9 means the same workspace produces the same bytes. A backdoor that behaves differently for a targeted user breaks the invariant, and CI checks it across machines | A backdoor that behaves the same for everyone is unaffected |
| 4 | **The export gate** (`31` §9.4) | A weakening cannot reach the clipboard without a rendered finding or a written suppression, and the gate lives in the WASM core rather than the UI | A maintainer edits the gate. It raises the cost of a *subtle* backdoor, not a deliberate one |
| 5 | **The narrow artifact surface** | Invariants 1–4 mean there is no egress, no device access, no credential store and no server-side key. A backdoor has fewer places to send anything | It can still lie about findings, which per `31` §2.2 is the higher-value attack anyway |
| 6 | **Corpus `reviewed_by`** | Attribution for content, per entry | Attribution, not prevention, and §12.4 |
| 7 | **Two-person review on the release path** | Real, when there are two people | §12.4 |

### 12.3 Why the log is the one that matters

The specific attack a small project is most exposed to is not "ship a backdoor to everyone" — that
is loud and eventually found. It is **ship a modified artifact to one organisation**, or to one
download, or from one mirror.

Against that:

- A signature alone does not help. A maintainer can sign two different artifacts with the same key
  and nobody outside sees both.
- A published hash alone does not help much either; the targeted user is given a matching hash.
- **A transparency log does help**, because the log entry is public, immutable and enumerable. Two
  artifacts for one version means two entries, and the second one is visible to anyone. One
  artifact with no entry fails `cosign verify-blob`.

That is why §7.1 refuses to pick one signature system. The offline-verifiable project key is
required by the product's air-gapped deployment. The log is required by the insider question. They
do not substitute for one another.

### 12.4 Two-person review, and the size of this project

The conventions and this document both call for two-person review on the release path. State the
condition plainly:

> **Two-person review is a control that requires two people. At the time of writing this project
> has one maintainer. Until a second reviewer exists, the release path has one-person review, and
> saying otherwise in a security document would be the first dishonest sentence in this corpus.**

**DECISION — pick one of these, before the first public release, and say which one in the README:**

| Option | What it means | Cost |
|---|---|---|
| **A. Recruit a second release reviewer** | A named person, with the ability to block a release, who is not the maintainer. They do not need to review all code — they review the release diff and the manifest, and their approval is recorded in the environment gate | Finding a person who will do it, reliably, for years |
| **B. Do not claim it** | The README says: one maintainer, one-person release path, and here is the list of things that make that detectable rather than preventable | Honest and weaker. Some enterprise reviewers will stop here, and they are not wrong to |
| **C. Delay the claim** | Ship with B, adopt A when it is true | The only one that is both honest now and improvable |

**RECOMMENDATION — C.** And note what is *not* an option: writing "two-person review" in a policy
document and having the same person approve their own release. That is worse than B, because it
converts an absent control into a false one, and a reviewer who discovers it discounts everything
else in this corpus. `31` §10's whole method is that the fastest way to lose a security-first
position is to hand a reviewer one overclaim.

### 12.5 The bus factor is the same problem

A one-maintainer project has two failure modes with the same root: the maintainer turns hostile, and
the maintainer stops. The second is far more likely and gets less attention.

The relevant supply-chain controls are the same in both cases:

| Control | Hostile maintainer | Absent maintainer |
|---|---|---|
| Public source, permissive licence | Someone can fork and audit | Someone can fork and continue |
| Reproducible builds from a public container | A third party can verify | A third party can **build**, which is what a fork needs |
| No first-party code in the build container | — | The container can be rebuilt by anyone |
| Pack trust root compiled into the binary (`12` §13.3) | Cannot be changed remotely | **A fork must be able to rebuild with its own key.** `12` §13.3 already says an org can build its own binary with its key baked in, and that path must stay working |
| Documented format with test vectors (`32` §16) | — | A future client written by someone who has never spoken to us can open the same workspace |

That last row is the one that makes the honest answer to "what if you disappear" something other
than a shrug: the workspace format has published test vectors, so the user's data outlives the
project. Say that in the README next to the bus-factor admission.

### 12.6 What we will not claim

| We will not say | Because |
|---|---|
| "Our releases are tamper-proof" | They are tamper-evident, conditionally on somebody checking |
| "Independently verified" | Until a third party actually rebuilds and publishes, §4.6 |
| "Audited" | `31` §10.1's last row. Nothing has been audited, including this |
| "SLSA Level N" | §7.3. Publish the provenance; let the reviewer assign the level |
| "You do not have to trust us" | You do. Reproducibility narrows *what* you have to trust us about, from "the binary" to "the source and the dependencies". That is a real narrowing and it is not the same as zero |

---

## 13. Verification UX

*margin tab: who actually checks*

> **THE APPLICATION CANNOT VERIFY ITSELF. ANYTHING IN THE UI THAT SAYS "VERIFIED" IS A STRING THE
> ATTACKER ALSO CONTROLS.**

### 13.1 The honest answer for a non-expert user

They do not verify. Not in the sense meant by this document.

A network engineer downloading a single HTML file is not going to install `minisign`, obtain our
public key through an independent channel, pull a build container by digest, and wait thirty minutes
for a rebuild. Designing as though they will is how verification stories become decorative.

And the deeper problem is structural, not motivational: **the application cannot verify itself.**
`31` §6.2 establishes it for the compromised-browser case and the same argument applies here —
defensive code runs in the same context as the attacker, so a tampered build displays whatever
"verified" indicator we designed, computed by code the tamperer replaced. Every self-check we could
write is a function the tamperer rewrote first.

So the design splits into three, by who is doing the checking:

| Who | What they can actually do | What we build |
|---|---|---|
| A non-expert user, alone | Compare a short fingerprint against a canonical page, at most | §13.3 — a build-identity panel that makes the fingerprint copyable, and no claim of verification |
| A non-expert user, with a security team | Hand the security team a block of text | §13.3, and §13.4's one-page card |
| A security team | Everything in §4 | §13.2's `fathom verify`, and §13.4 |

### 13.2 `fathom verify` — the smallest thing that helps

One command in the CLI (A4), with no arguments beyond a path, that a security team can drop into
whatever they already run.

```text
$ fathom verify ./fathom-3.2.0.html

ARTIFACT       fathom-3.2.0.html
SIZE           28,114,552 bytes
SHA-256        3f1c…9ab2
BLAKE3-256     7d02…41ee

MANIFEST       MANIFEST-3.2.0.txt          found in ./ (not fetched)
  project key  OK      RWQf6L…  (key fingerprint printed in full)
  sigstore     OK      workflow release.yml@refs/tags/v3.2.0
  rekor        OK      log2026-1  index 41,338,902  inclusion proof verified
  digest       OK      matches manifest entry for fathom-3.2.0.html

ARTIFACT CONTENT
  csp          OK      default-src 'none'; connect-src 'none'
  wasm imports OK      12 imports, none capable of originating a request
  build date   2026-07-14   (14 days old)
  corpus       fathom.ipsec 2.4.1  blake3 a91c…  signed by first-party key
  advisories   none loaded

REBUILD        not attempted   (run with --rebuild; needs docker and ~30 min)

RESULT         4 of 5 checks performed, 4 passed, 1 not attempted
```

Design rules for it, each of which is a decision:

| Rule | Reason |
|---|---|
| **Never fetches anything unless told to.** Default is fully offline: it checks the files you have against the files you have | Invariant 1's spirit applies to our tooling. An air-gapped verifier must get the same output |
| **Exit codes are the interface.** `0` all attempted checks passed; `1` a check failed; `2` a check could not be attempted; `3` malformed input | It goes in someone's pipeline. A tool whose interface is prose does not |
| **Prints what it did *not* check**, prominently | A verification tool that reports only successes is a tool that teaches over-confidence. The `not attempted` line is as important as the `OK` lines |
| **`--rebuild` does §4's ladder** and prints the mismatch decoder entry (§4.5) on divergence rather than a diff dump | The decoder is the useful output. A hex diff is not |
| **`--json`** emits a structured record | So it lands in an inventory system |
| **Ships as a standalone static binary** whose own digest is in the manifest | And which can therefore be verified by the previous release's copy of itself |

**The circularity, named:** verifying an artifact with a tool from the same project is
question-begging. It is mitigated but not solved by: (a) the underlying signature is minisign
format, so a paranoid verifier uses `minisign` and skips us entirely; (b) `cosign` does the
Sigstore half; (c) `sha256sum` does the digests. **`fathom verify` is a convenience wrapper around
three tools we did not write, and the documentation says exactly that, with the three equivalent
commands printed underneath.** That sentence is what makes it acceptable to ship.

### 13.3 The in-app build identity panel

Not a verification claim. An **identity disclosure** — the artifact stating what it believes itself
to be, so a human can compare that against something we do not control.

Rendered in the field card's register: hairline-ruled two-column table, no vertical rules, mono for
every identifier, muted labels, no icon, no badge, no colour. The three risk colours are not used
here; nothing on this panel is a `Risk`.

```text
 B U I L D   I D E N T I T Y                                    what you are running

 version           3.2.0
 build date        2026-07-14         14 days old
 artifact sha-256  3f1c…9ab2          [copy]
 core wasm         7d02…41ee
 corpus            fathom.ipsec 2.4.1  a91c…
 finder index      2.4.1               c4e0…
 signing key       RWQf6L…             first-party, compiled in
 advisories        none loaded

 ─────────────────────────────────────────────────────────────────────────────
 this panel is what this file says about itself. it is not a check.
 to check it, compare the sha-256 above against the published manifest, or run
 fathom verify. a modified build would print whatever it was told to print.
                                                             [copy all as text]
```

Three deliberate choices:

1. **The disclaimer is the last line and it is not softened.** The panel exists to be copied into an
   email to a security team, and the disclaimer has to travel with it.
2. **`[copy all as text]` copies the whole block**, including the disclaimer, in a fixed format that
   `fathom verify --json` can also produce. That is the handover from a non-expert to an expert, and
   it is one click.
3. **No green tick, ever.** §13.5.

### 13.4 The verification card

One side, in the field card's grammar, published as a page and shipped in the release as
`REPRODUCE.md`. It is the artifact a security team executes, and it is short enough to execute.

```text
──────────────────────────────────────────────────────────── 3px rule
 FATHOM · VERIFY A RELEASE                        one side · read this first
 W H A T   Y O U   A R E   R U N N I N G
 companion to the release manifest
 STOP AT THE FIRST MISMATCH — A LATER PASS AFTER AN EARLIER FAIL MEANS NOTHING
──────────────────────────────────────────────────────────── 1px rule

 ▌ TWO MINUTES                          ▌ THIRTY MINUTES
   1 get MANIFEST + .minisig              6 docker pull <container>@sha256:…
   2 minisign -Vm MANIFEST -P <key>       7 git checkout <tag>
   3 cosign verify-blob --bundle …        8 ./build/repro.sh
   4 sha256sum -c MANIFEST                9 sha256sum -c MANIFEST
   ▌ this answers: is this ours           ▌ this answers: is ours the source

 ▌ IF IT DOES NOT MATCH                 ▌ WHAT THIS DOES NOT PROVE
   build it twice yourself first.         that the source is benign
   then read the decoder — §4.5.          that a dependency is benign
   the first divergence is usually        that anybody else checked
   the environment, not an attack.        §1.3

────────────────────────────────────────────────────────────
 ONE SIDE — VERIFY A RELEASE
```

The card's own devices, used as designed: the one-line imperative at the top, the numbered ladder,
two columns with no vertical rules, the margin tab, and a section that states the limit rather than
burying it.

### 13.5 What we refuse to build

| Proposal | Why not |
|---|---|
| A green tick in the UI reading "verified build" | The app cannot verify itself. §13.1. A tampered build shows the tick |
| An in-app "check for updates" button in the offline build | Invariant 1. There is no origin it may contact and no setting that changes that (`21` §7.5) |
| Auto-update in any build | `31` §8.3's decision. A signed remote-code-execution channel pointed at every user |
| A hosted "paste your hash here" checker | It moves the trust from a signature you can check offline to a web page we control. A user who trusts our web page did not need to check the hash |
| A "security score" for the build | It is a number that means nothing and that people will optimise |
| Telemetry to measure how many users verify | Invariant 1. We will not know, and that is the cost of the invariant, and we accept it |

---

## 14. Residual risk register

Continuing `31` §11's numbering as `S1…`, to keep the two registers mergeable.

| # | Residual | Tag | Accepted because | Revisit when |
|---|---|---|---|---|
| S1 | **A malicious dependency reproduces perfectly.** Reproducibility does not defend link L2 | `material` | Structural. Controls are §5, which are weaker and cover more | If sandboxed build-script/proc-macro execution stabilises |
| S2 | **Build scripts and proc macros run unsandboxed on the build host** | `material` | No sandbox exists in stable Cargo. Capped, enumerated, read, and run with no network | Same as S1 |
| S3 | **Reproducibility proves nothing unless somebody rebuilds** (`31` R7) | `material` | §4.6 funds a second pipeline, which is *us twice*, not independence | **Before first public release** — solicit a genuine third-party rebuilder |
| S4 | **One-person release path** | `material` | §12.4. The project has one maintainer | The moment a second reviewer exists, or at first public release, whichever is first |
| S5 | **A backdoor in first-party source reproduces perfectly** | `total` | Nothing in this architecture prevents it. Public source and the log make it detectable and attributable | Never — this is the model |
| S6 | **Offline installs have no update channel and unbounded time-to-patch** | `material` | Invariant 1, deliberately. §8.2 | If a defect class emerges that the artifact's narrow surface does not bound |
| S7 | **Container images are content-reproducible, not byte-reproducible** | `bounded` | §3.7. The application layer's contents are verifiable, which is the part that matters | If BuildKit's known base-layer issue is fixed and byte-stability becomes cheap |
| S8 | **Notarised/Authenticode binaries are not byte-reproducible** | `bounded` | Third parties control part of the byte sequence. §2.3 | Never, realistically |
| S9 | **A correctly-signed pack from a trusted publisher can ship a wrong rule** (`31` R6) | `material` | §9.5. Signing bounds who, never what | If the pack ecosystem grows beyond first-party plus a handful of org packs |
| S10 | **A pack can mislabel a remediation's `Risk`** | `bounded` **after** §9.4's cross-check ships; `material` before | The cross-check is proposed, not built | When §9.4's RECOMMENDATION is implemented or rejected |
| S11 | **The build container is itself not reproducible** | `material` | §3.2's named circularity. Mitigated by it containing no first-party code | If a reproducible base-image toolchain becomes practical |
| S12 | **`cargo-vet` assurance is largely imported from Mozilla and Google** | `material` | §5.4. It is the correct allocation of a small review budget, and it is somebody else's judgement | If either party's audit criteria change materially |
| S13 | **Nobody will run `fathom verify`** | `material` | §13.1. Verification is a capability we provide, not a behaviour we can cause | If usage were measurable — which it is not, by invariant 1 |
| S14 | **Typosquatting the download has no technical control** | `material` | `31` §8.3 C1.3. Only a canonical location and a comparable fingerprint | Never |
| S15 | **Toolchain pins age into advisories** | `bounded` | An exact rustc pin means we do not get compiler security fixes until we move the pin, and moving the pin changes every digest | Each release: the pin moves deliberately, with the digest change expected and announced |

S15 deserves a sentence because it is the cost nobody anticipates: **pinning is a security control
and an anti-security control at the same time.** Every pin is a decision not to take upstream fixes
until someone acts. The mitigation is that pins move on a schedule with the release, not that they
never move.

---

## 15. What this costs, added up

Depth is the deliverable, and so is honesty about price.

| Cost | Magnitude | Falls on |
|---|---|---|
| `codegen-units = 1` + `lto = "fat"` | Release compile time measured in tens of minutes rather than minutes <!-- VERIFY: measure --> | Every release, every reproducibility build, every rebuilder |
| No release caching (§11.7) | The above, cold, every time | CI budget |
| Double build (R1) on every commit | 2× CI compute on the build job | CI budget |
| Independent rebuild (§4.6) | A second CI account and 1× more release compute | CI budget, plus setup |
| Nightly R3 | 1× release compute per night | CI budget |
| Offline signing (§7.2) | A manual step per release; hotfixes are slower | The maintainer |
| Eleven published artifacts (§2.1) | Release ceremony and a manifest that has to be right | The maintainer |
| Dependency review per addition (§5.3) | 30–90 minutes per crate, honestly | The maintainer |
| Build-script and proc-macro reading (§5.7) | A few thousand lines, once, then on each change | The maintainer |
| Content BOM (A9) | New tooling nobody else has written | Build engineering |
| `debug = 0` (N7) | Worse panic backtraces in the field | Debugging |
| Base64 inlining (§3.5) | 4/3 on WASM and index in A1 | Download size |
| No auto-update | Slow propagation of fixes; some installs never patch | Users, and it is the largest user-facing cost in this document |
| Pinned toolchains (S15) | Compiler and tooling fixes arrive only when we move a pin | Security posture, between releases |

**The one to argue about** is `codegen-units = 1`. It is a real, recurring, everyday cost paid for a
property — determinism — that is only realised if somebody rebuilds. If the third-party rebuilder in
§4.6 never materialises, that cost buys nothing, and the honest response would be to say so rather
than keep paying it for the appearance of rigour. That is the strongest reason to fund S3 rather
than defer it.

---

## 16. Open decisions

| # | Decision | Options | Blocking |
|---|---|---|---|
| O1 | Third-party rebuilder | Solicit one; or ship with "built twice by us" and say so | First public release. S3 |
| O2 | Two-person release review | §12.4 A / B / C | First public release. S4 |
| O3 | `Risk` cross-check for pack remediations (§9.4) | Implement; or accept S10 as `material` | Before third-party packs are supported |
| O4 | Mandatory pack diff at upgrade (§9.5) | Show the specific severity/`acceptable_when` diff for rules with active findings; or keep counts only | Pack ecosystem work |
| O5 | `wasm-opt` at all (§3.6) | Confirmed once A3's real size is known — if the win is under 5 % the pinned C++ toolchain is not worth it | First measurable build |
| O6 | SPDX alongside CycloneDX (§10.1) | Generate on request; or publish both | First enterprise procurement conversation |
| O7 | `ulid` crate versus 100 lines of first-party code (§5.2) | Replace; or keep and audit | Before C3 is published as a number |
| O8 | Does `cargo auditable` survive `wasm-opt` (§10.1) | Order the stages differently; or accept A3 has no embedded BOM | First WASM build |

---

## 17. Sources

| Claim | Source |
|---|---|
| `codegen-units` default 16 produces nondeterministic binaries; `codegen-units=1` is the workaround; issue closed as not planned | rust-lang/rust issue #128675 |
| Open reproducibility bugs: `-Cdebuginfo=2` nondeterminism, incomplete `--remap-path-prefix` coverage, skipped `tests/run-make/reproducible-builds` combinations | rust-lang/rust issue #129080 (tracking issue for reproducible build bugs and challenges) |
| `trim-paths` as a Cargo profile setting; default `none` for dev and `object` for release; `--remap-path-scope` | RFC 3127, and the Cargo profile documentation <!-- VERIFY: the Rust version in which `trim-paths` stabilised --> |
| `--locked` prevents dependency re-resolution; `SOURCE_DATE_EPOCH` for build timestamps; `rust-embed` records mtimes unless its `deterministic-timestamps` feature is used; `diffoscope` for locating divergence | reproducible-builds.org, *Rust* page and *SOURCE_DATE_EPOCH* specification |
| The initial rustc determinism option turns off frontend parallelism while keeping codegen/linking parallelism | rust-lang/compiler-team issue #1005 |
| `diffoscope` recursively unpacks archives and renders binary formats for comparison | diffoscope.org |
| rebuilderd: independent rebuilders repeat builds in an identical environment and compare; a failed rebuild is more often nondeterminism than compromise; running your own is encouraged | kpcyrd/rebuilderd README and Arch Wiki |
| `wasm-opt` typically achieves 10–20 % size reduction over LLVM's raw output | Bytecode Alliance `cargo-wasi` documentation, *Running wasm-opt*. <!-- VERIFY: treat as a general claim, not a measurement of our artifact --> |
| BuildKit `rewrite-timestamp=true` image exporter option (v0.13+); Dockerfile must declare `ARG SOURCE_DATE_EPOCH`; not default due to layer-rewrite overhead; base-image layers still rewritten in some cases | moby/buildkit documentation and issue #4805 |
| `cargo-deny` checks: `advisories`, `bans`, `licenses`, `sources`, configured in `deny.toml` | EmbarkStudios/cargo-deny documentation |
| `cargo-vet` is organisation-level with no separate reviewer identity and **no transitive trust**; audit sets can be imported from organisations such as Mozilla and Google. `cargo-crev` uses per-reviewer identities and a web of trust | mozilla.github.io/cargo-vet (Introduction, FAQ) |
| `cargo auditable` embeds dependency data in a dedicated linker section using its own compact format rather than CycloneDX or SPDX; `auditable2cdx` converts it to CycloneDX | rust-secure-code/cargo-auditable |
| SPDX 2.2.1 is an ISO standard; CycloneDX 1.6 is an Ecma standard | CycloneDX and SPDX project material <!-- VERIFY: the Ecma standard number --> |
| Cosign keyless signing: Fulcio issues a short-lived certificate binding an ephemeral key to an OIDC identity; the signature and certificate are recorded in Rekor | sigstore/cosign and Sigstore documentation |
| Rekor v2 GA October 2025; tile-backed backend (Tessera); sharded by year, e.g. `log2026-1.rekor.sigstore.dev`; search index dropped; `hashedrekord` and `dsse` retained; client support from cosign v2.6.0 | Sigstore blog, *Rekor v2 GA*; sigstore/rekor-tiles CLIENTS.md |
| GitHub Artifact Attestations bind an artifact digest to a SLSA provenance predicate in in-toto format, signed with a short-lived Sigstore certificate; attestations alone provide SLSA v1.0 Build Level 2; Build Level 3 requires a reusable workflow; `actions/attest-build-provenance` v4+ wraps `actions/attest` | GitHub Docs, *Artifact attestations*; actions/attest-build-provenance |
| The "Shai-Hulud" npm campaign propagated via `postinstall` scripts, stole cloud and registry tokens, self-replicated by re-publishing from compromised maintainer accounts, affected hundreds of packages from September 2025, with an evolved variant in November 2025 | CISA alert, 2025-09-23, *Widespread Supply Chain Compromise Impacting npm Ecosystem*; Unit 42 and Sysdig analyses |
| A backdoor introduced through build machinery in a widely used compression library | CVE-2024-3094 (xz-utils / liblzma), 2024 |
| TypeScript 7.0, the Go-native compiler, shipped 2026-07-08 and runs as a standalone binary without Node.js; it ships without a public compiler API | Microsoft/TypeScript release material and contemporaneous coverage <!-- VERIFY: confirm date, packaging, and that `--noEmit` works standalone --> |
| Rolldown reached 1.0 RC in January 2026; `oxc` provides parser, transformer and minifier as Rust crates; `oxc-minify` is Rolldown's default minifier | Rolldown and oxc project material <!-- VERIFY: crate-level maturity of `oxc`'s minifier --> |
| PFS: without it, Phase 2 keys derive from Phase 1 key material and one compromised IKE SA secret unlocks every data key derived under it, including previously recorded traffic. Clearing Phase 1 tears down every child SA under it — on a hub, every spoke at once | Owner's SRX IPsec field card, sides 2 and 3 |
| `commit confirmed 5` as the first step of the bring-up order; stop at the first failure; correlate before you theorise | Owner's SRX IPsec field card, sides 1 and 4 |
| Rule pack container, signing, trust store, scoping, install path, revocation | `docs/10-core/12-rule-engine.md` §§12.6, 13.1–13.7 |
| Pack override field restrictions; `acceptable_when` requirements; worked `ipsec.pfs.absent` | `docs/60-content/63-rulepack-spec.md` §§10, 16, 17.1 |
| Threat rows 7/8/9, attack-tree goal C, no-auto-update decision, residual scale, verification checklist, CI enforcement table | `docs/30-security/31-threat-model.md` §§1.4, 5.1, 5.2, 5.3, 8.3, 8.4, 9.4, 10, 11, 12 |
| Crate pins for the cryptographic primitives; `ring` rejected partly for reproducibility; `Cargo.lock` committed and checked by `cargo-deny`/`cargo-vet`; workspace format test vectors | `docs/30-security/32-cryptography.md` §§15.1, 15.2, 16 |
| Finder index build determinism: sorted iteration, no `HashMap` in the builder, no timestamps, `SOURCE_DATE_EPOCH` honoured, CI asserts byte-identical output | `docs/10-core/16-command-finder.md` §9.5 |
| tree-sitter rejected partly because it brings Node.js and emscripten into the build at the point §8.6 wants them gone | `docs/10-core/14-parsers-and-ingest.md` §3.3 |

Claims not sourced above are design positions of this project and are argued in place rather than
cited.

---

## 18. Disagreements

Two, raised under the conventions' own procedure.

### 18.1 The conventions pin no term for a build artifact, and this document needed one

**The convention.** The terminology table pins `workspace`, `graph`, `rule pack`, `corpus` and
others, and forbids loose alternatives. It says nothing about the things we build and ship.

**The objection.** Three security documents now refer to the same objects — the single file, the
served asset tree, the WASM core, the container image — and each has used slightly different words
for them. `31` says "the artifact", "the shipped code", "a modified single-file build" and "the
served build" in the space of two sections. This document invents an artifact register (§2.1) with
identifiers `A1…A11` because it could not proceed without one. If a fourth document invents a
different register, the cross-references between them stop resolving, which is precisely what the
conventions exist to prevent.

**Proposed addition to `conventions.md`,** under *Terminology*:

| Term | Means | Never say |
|---|---|---|
| **artifact** | one published, hashed, signed output of the build — the single file, the asset tree, the core WASM, a CLI binary, an image, a pack, an SBOM, the manifest | "build" (that is the process), "binary" (only one artifact is one), "release" (a release is a set of artifacts plus a manifest) |
| **release** | one manifest plus the set of artifacts it names, at one version | "build", "drop" |
| **manifest** | the signed document listing every artifact in a release with its digests and build inputs | "checksums file", "index" |

And a pointer from the conventions to the artifact register in this document as the canonical list,
so that a fifth document extends it rather than restating it.

### 18.2 Invariant 9's determinism guarantee should name the build as an input, explicitly

**The convention.** Invariant 9: *"Same workspace + same corpus version + same build ⇒ byte-identical
emitted config, byte-identical findings, identical finder ranking."*

**The objection.** The phrase "same build" is doing a great deal of unexamined work. Two people
comparing output need to know what makes a build "the same" — and until this document, nothing in
the corpus said. Is it the version string? The artifact digest? The source tag? They are different
things: two artifacts built from the same tag on different toolchains have the same version and
different behaviour, and that is exactly the case the invariant needs to exclude.

This matters practically. `31` §12 makes byte-determinism across two machines a CI gate. That gate
is only meaningful if "same build" means "same artifact digest", because that is the only definition
a test can check.

**Proposed replacement for invariant 9's first sentence:**

> **9. Determinism where it is observable.** Same workspace + same corpus content hash + same
> artifact digest ⇒ byte-identical emitted config, byte-identical findings, identical finder
> ranking. "Same build" means the same artifact digest, not the same version string — two artifacts
> with one version number and two digests are two builds, and the invariant does not span them.

The rest of the invariant — the quarantine of nondeterminism behind the AI layer's boundary, and
the labelling requirement — is unchanged and correct.
