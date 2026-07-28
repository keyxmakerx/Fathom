# 42 — No Node at runtime

> **Status:** Proposed

The owner brief §1 says: *"Node.js appears in the build pipeline only, and can be eliminated
entirely if desired (§8.6)."* §8.6 was not received. This document is the explicit answer it asked
for, and it takes the question apart before answering it, because the sentence contains two claims
of very different difficulty and the easy one is the one people say out loud.

**The governing rule of this document, stated once, in caps, at the top:**

> **NODE IN THE ARTIFACT WAS NEVER THE QUESTION. NODE IN THE BUILD IS — BECAUSE THE BUILD DECIDES
> WHAT THE ARTIFACT SAYS.**

`35-supply-chain-and-builds.md` §6.1 makes that argument and this document does not repeat it. What
this document adds is the part `35` left as a table row: **what, exactly, Node was doing; what
replaces each job; what breaks; where the purist position costs more than it buys; and how CI proves
the claim rather than asserting it.**

---

## 0. Contents

| § | |
|---|---|
| 1 | The three claims people conflate, separated and stated as testable propositions |
| 2 | What Node is normally doing — every job, and its non-Node replacement |
| 3 | The replacement toolchain, pinned, with the distribution-channel nuance |
| 4 | Testing without Node — the hard part, honestly |
| 5 | The developer inner loop, and what is lost |
| 6 | The counter-argument at full strength |
| 7 | The decision criterion, and the RECOMMENDATION |
| 8 | The build graph per deployment mode, with exact commands |
| 9 | "Zero runtime dependencies" defined precisely, and how CI enforces it |
| 10 | Failure modes of this position, and the recovery for each |
| 11 | What this costs, added up |
| 12 | Open decisions |
| 13 | Sources |
| 14 | Disagreements |

---

## 1. The three claims, separated

*margin tab: read this first*

### 1.1 They are not the same claim

| # | Claim | Difficulty | Who cares |
|---|---|---|---|
| **N1** | **No Node.js in the shipped artifact** | Trivial. True of any WASM + static-asset build by construction | Almost nobody, once they understand it |
| **N2** | **No JavaScript at runtime** | **False, and we do not claim it** | People who conflate it with N1 |
| **N3** | **No Node.js anywhere in the toolchain** | **Hard**, because the web tooling ecosystem *is* Node | The enterprise reviewer, and correctly |

**N1 is close to vacuous and saying it is close to marketing.** `35` §6.1 puts it exactly: *"the
runtime is a browser tab and a WASM module. Node was never going to be in the artifact. Saying it is
absent from the runtime is saying that a thing which could not have been there is not there."* A
reviewer who has read one architecture document will notice, and the credibility cost of an
impressive-sounding vacuous claim is higher than the benefit.

**N2 is false and must never be implied.** The artifact contains hand-written TypeScript compiled to
JavaScript — the render layer, the boundary, the views (`41` §4.4). It is our JavaScript, it is in
the reproducible build, its hashes are in the manifest, and there is no third-party JavaScript in it
(`34` §8.1). "No third-party JavaScript" is the true, useful, defensible claim. "No JavaScript" is
neither true nor desirable.

**N3 is the real question**, and it is hard for a reason worth stating rather than complaining about:
the JavaScript build ecosystem grew up inside Node, so even tools *written in Rust and Go* are
frequently distributed as npm packages, invoked from npm scripts, and configured by JavaScript config
files. Removing Node is not removing a language; it is removing a package manager, a plugin
convention, a config format and a distribution channel, and each has to be replaced separately.

### 1.2 The propositions we will actually defend

Five, numbered, each with an enforcement and a residual on `31` §1.4's scale
(`none | bounded | material | total`).

| # | Proposition | Enforcement | Residual |
|---|---|---|---|
| **Z1** | The shipped artifacts (A1–A7) contain no JavaScript runtime, no bundled third-party JavaScript, and no code fetched at runtime | Bundle scanner + WASM import allowlist + no-route runtime test (§9.4) | `none` for third-party JS; `bounded` for "a build tool injected something", which is `31` row 9 |
| **Z2** | **No npm package is installed or executed in any build stage that can influence an artifact byte** — stages 0–13 of `35` §3.4 | `which node` fails in the build container; no `package.json` anywhere; hermetic no-route build (§9.4) | `bounded` — a compromised *Rust* build script does the same job, `35` §5.7 |
| **Z3** | Every tool that transforms bytes into a shipped artifact is either a Rust library crate pinned by `Cargo.lock`, or a native binary pinned by SHA-256 in `build/toolchain.lock.toml` | Toolchain lock + manifest records the set | `bounded` |
| **Z4** | Tools that produce no artifact — type checking, linting, formatting, browser-driven tests — **may** use a non-Rust toolchain, but only downstream of the release manifest and never inside the build container | §7's criterion; CI job separation (§8.5) | `material` — a compromised checker cannot change bytes but can suppress a failing signal. Named, not mitigated |
| **Z5** | A developer can build, run and test the product on a machine with no Node installed | The `xtask` surface (§8) is the only supported entry point; CI runs on a Node-free image | `none` for the build; `bounded` for e2e, per §4 |

Z4 is the interesting line and §7 is where it gets argued. Everything else is enforcement detail.

---

## 2. What Node is normally doing, and what replaces it

*margin tab: fields that matter*

The honest way to answer "can we remove Node" is to list what it does first. Sixteen jobs. Several
of them we do not need at all, which is a bigger part of the answer than any replacement tool.

| # | Job | Typical Node tool | Our replacement | Form | Do we need it? |
|---|---|---|---|---|---|
| 1 | **Package management** | npm / pnpm / yarn | **none** — there are no JS packages | — | no |
| 2 | **TypeScript → JavaScript** | `tsc`, babel, esbuild, swc | `oxc` transformer | Rust library crate, called from `xtask`, pinned by `Cargo.lock` | yes |
| 3 | **Type checking** | `tsc --noEmit` on Node | The Go-native TypeScript compiler | pinned native binary, `--noEmit` only, **produces no artifact** | yes — and Z4 applies |
| 4 | **Bundling / module resolution** | rollup, vite, webpack, esbuild | `xtask assemble` over the checked-in asset manifest | first-party Rust | **barely** — see below |
| 5 | **Minification (JS)** | terser, esbuild, swc | `oxc` minifier | Rust library crate | optional — see §10.1 |
| 6 | **Tree shaking** | rollup, esbuild | **none needed** — we import what we use, and there is no third-party JS to shake | — | no |
| 7 | **CSS processing** — nesting, prefixing, custom media | postcss + autoprefixer | `lightningcss` | Rust library crate | yes |
| 8 | **CSS minification and bundling** | cssnano, postcss-import | `lightningcss` | same crate | yes |
| 9 | **Asset hashing and inlining** | vite, webpack | `xtask assemble` — deterministic order, base64, CSP hashes over final bytes | first-party Rust | yes |
| 10 | **Dev server + HMR** | vite | `fathom serve --dev` + `cargo watch` | first-party Rust | yes, minus HMR — §5 |
| 11 | **Unit tests (logic)** | vitest, jest | `cargo test` — the logic is Rust | Rust | yes |
| 12 | **Unit tests (browser/DOM)** | vitest + jsdom, karma | `wasm-bindgen-test` against a real headless browser over WebDriver | Rust test runner + a browser driver | yes — §4 |
| 13 | **End-to-end tests** | Playwright, Cypress | `fantoccini`/`thirtyfour` (WebDriver) or `chromiumoxide` (CDP), from `cargo test` | Rust | yes, and this is the hard one — §4.3 |
| 14 | **Linting** | ESLint + plugins | `oxlint`, with the sink ban list as rules | Rust binary | yes — and `34` §5.8 makes it security-relevant |
| 15 | **Formatting** | prettier | `dprint` or `oxc`'s formatter | Rust | yes, cosmetic |
| 16 | **Font subsetting → WOFF2** | fonttools (Python) / harfbuzzjs | `allsorts` (pure Rust, parses and subsets OpenType/WOFF/WOFF2) + a pure-Rust Brotli encoder | Rust library crate | **yes, and `35` §6.2's table omits it** — see §2.2 |

Three of these deserve more than a table row.

### 2.1 Bundling is barely a job here, and noticing that is worth more than replacing it

`35` §6.2 makes the point in passing and it is the most useful observation in this whole area:

> *"a single-file artifact has a trivial bundling problem — the 'bundle' is a concatenation in a
> fixed order."*

The reason bundlers are complicated is code splitting, dynamic import graphs, vendor chunking, shared
chunk hoisting, and the interaction of all four with caching. We have:

| Bundler feature | Do we use it? |
|---|---|
| Code splitting | **no** — mode A is one file; modes B–D are three files by design |
| Dynamic `import()` | **no** — banned by lint; it is a script-URL sink under Trusted Types and a fetch under CSP |
| Vendor chunks | **no** — there are no vendors |
| Tree shaking | **no** — nothing dead to shake |
| Content-hashed filenames | yes — twelve lines |
| Source maps | not shipped (`34` §7.5); published separately alongside the reproducible build |

So the "bundler" is: read `build/assets.toml` in its declared order, run each file through the
transform, concatenate, hash. That is `xtask assemble`, it is a few hundred lines, and it is
first-party code whose determinism we control — which `35` §3.5 requires anyway.

### 2.2 Font subsetting is a real gap in the current build plan

`34` §8.4 requires Liberation Sans and DejaVu Sans Mono, subset to a named codepoint range, shipped
as WOFF2 and inlined as `data:` in mode A. `35` §6.2's replacement table does not have a row for it.
The default tool for this job is **fonttools**, which is Python — so taking the obvious path swaps a
Node dependency for a Python one and Z3 is violated with a different logo on it.

The options:

| Option | Assessment |
|---|---|
| **`allsorts`** — font parser, shaping engine and subsetter, entirely in Rust, handling OpenType, WOFF and WOFF2 | **Preferred.** It is a Rust library crate, so it is pinned by `Cargo.lock` and called from `xtask` like `lightningcss`. <!-- VERIFY: confirm allsorts' WOFF2 *write* path and whether it depends on a non-Rust Brotli implementation; the subsetting path is the documented strength, the WOFF2 encode path is what needs checking. --> |
| **`fontcull`** | Rust subsetting, but its README states C++ is present for WOFF2 compression. That is C7 (`35` §5.1) for a build tool. Build tools are not in the shipped closure, so C7 does not literally forbid it — but importing a C++ compressor into the artifact-producing path for a job a pure-Rust Brotli encoder can do is a bad trade |
| **Subset offline, commit the WOFF2 files** | The pragmatic fallback: run the subsetter once, review the output, commit four binary files with their hashes in the asset manifest, and remove font subsetting from the build entirely. Costs: changing the codepoint range becomes a manual, reviewed step. **Gains: one fewer build-time tool, and the fonts become auditable artifacts in the repository rather than build outputs** |

**RECOMMENDATION — commit the subset WOFF2 files.** Four faces, changed perhaps twice in the
product's life, each with a SHA-256 in `build/assets.toml`. A build step that runs twice a decade is
a build step whose failure modes nobody remembers. This is an instance of `35` §6.2's fallback
principle — *"the answer is to do less, not to reintroduce npm"* — applied to a job `35` did not list.

### 2.3 The corpus pipeline is already Node-free and it is the biggest "JS-shaped" job in the product

`15` §6.4 compiles the corpus markdown subset to an AST **at build time**, and no markdown parser
runs on the client. `61` §— and `16` §9.5 build the finder index with `fathom-corpus build`. Both are
Rust binaries in our own workspace.

In a conventional stack, "compile a large content corpus to a typed AST and build a search index"
would be the single largest Node job in the build. Here it is `cargo run -p fathom-corpus -- build`.
That is not a replacement decision; it is a consequence of `41` §2.3's one-core argument, and it
removes more Node than every tool substitution in §2 combined.

---

## 3. The replacement toolchain, pinned

*margin tab: why it exists*

### 3.1 The set

| Tool | Job | Form | Pinned by | Can it change an artifact byte? |
|---|---|---|---|---|
| rustc / cargo | everything Rust | rustup, exact patch channel | `rust-toolchain.toml` + component SHA-256 | **yes** |
| `wasm-bindgen-cli` | WASM glue generation | native binary | `build/toolchain.lock.toml`, SHA-256, **lockstep with the crate version** | **yes** |
| `wasm-opt` (Binaryen, C++) | WASM optimisation | native binary | SHA-256 + a checked-in flag vector | **yes** |
| `oxc` (transformer, minifier) | TS → JS, minify | **Rust library crate** | `Cargo.lock` | **yes** |
| `lightningcss` | CSS transform + minify | **Rust library crate** | `Cargo.lock` | **yes** |
| `allsorts` *(or committed WOFF2)* | font subsetting | Rust library crate, or no tool at all | `Cargo.lock` / asset manifest | yes / **no** |
| `xtask` | assembly, SBOM, manifest, codegen | first-party Rust | the repository | **yes** |
| TypeScript compiler (Go-native) | `--noEmit` type check | native binary | SHA-256 | **no — emits nothing** |
| `oxlint` | the DOM-sink lint (`34` §5.8) | native binary or crate | SHA-256 / `Cargo.lock` | **no** |
| `dprint` | formatting | native binary | SHA-256 | no (CI checks, does not rewrite) |
| chromedriver / geckodriver + browser | headless browser tests | native binaries | SHA-256 | **no** |
| BuildKit | container packaging | — | image digest | packaging only |

**Four tools can change a shipped byte: rustc, `wasm-bindgen-cli`, `wasm-opt`, and our own `xtask`
(which contains `oxc` and `lightningcss` as libraries).** That is the number worth publishing, and
it is the shape of `35` §6.3's argument extended to the full list.

### 3.2 The distribution-channel nuance, stated because it will be raised

Several of the best non-Node tools are *distributed* through npm even though they are not Node
programs. esbuild is a Go binary whose primary distribution is an npm package (it can also be built
with `go install`, or extracted from the npm tarball with `curl` and `tar` without ever running npm
or Node). The Go-native TypeScript compiler is distributed the same way. oxc's tools ship as both
crates and npm packages.

Three positions, and they are genuinely different:

| Position | What it forbids | Assessment |
|---|---|---|
| **P1 — no npm registry, at all** | Downloading a tarball from `registry.npmjs.org` even with `curl` | Purity theatre. A tarball fetched by URL and verified against a committed SHA-256 is exactly as trustworthy as a GitHub release fetched the same way. The registry is a CDN here, not a package manager |
| **P2 — no `npm install`, no lifecycle scripts, no `node_modules`, no `package.json`** | The install-script execution channel, the transitive tree, the lockfile ecosystem | **This is the real control.** `35` §6.1's argument is entirely about `preinstall`/`install`/`postinstall` running arbitrary code on the build host and about tree size. Neither applies to `curl | sha256sum -c | tar -x` |
| **P3 — no non-Rust artifact-producing tool at all** | `wasm-opt` (C++), and any pinned binary | Already impossible: `wasm-opt` is Binaryen and Binaryen is C++. `35` §6.3 accepts it because its output is double-built and diffed |

**DECISION — P2 is the policy.** The rule is *how the bytes are obtained and verified*, not *which
CDN they came from*. Written out: **a tool may be fetched from any URL, must be verified against a
SHA-256 committed in `build/toolchain.lock.toml`, must not be installed by a package manager that
executes code, and must not bring transitive dependencies.**

This matters because the alternative — refusing a Go binary because its download URL contains
`npmjs.org` — is the kind of rule that gets bypassed the first time it is inconvenient, which
`35` §5.3 question 9 warns about in a different context.

---

## 4. Testing without Node

*margin tab: most-missed*

This is the hardest section and the one where the position is weakest. Everything else in §2 has a
mature Rust replacement. Browser testing does not have a Playwright.

### 4.1 What we need to test, and where each lands

| Layer | What | Node needed? |
|---|---|---|
| Core logic — graph, rules, emitters, parsers, finder, CRDT, crypto | `cargo test`, `proptest`, `insta` snapshots, `cargo-fuzz` | **no** |
| Determinism (invariant 9) | build twice, hash, diff — `35` §3.1 R1 | **no** |
| The WASM module in a real engine | `wasm-bindgen-test` with `wasm_bindgen_test_configure!(run_in_browser)`, driven over WebDriver against Chrome, Firefox or Safari | **no** — the runner is a Rust binary that speaks WebDriver to `chromedriver`/`geckodriver`/`safaridriver` |
| The TypeScript UI's pure logic — the packed-format reader, the store, the reconciler | see §4.2 | **the problem** |
| Full-page behaviour — CSP violations, Trusted Types enforcement, resource timing, the `34` §10 H-checklist | see §4.3 | **the problem** |

### 4.2 Unit-testing the TypeScript without a JS test runner

Every JS unit-test runner is a Node program. Three ways out:

| Option | How | Assessment |
|---|---|---|
| **A — write the tests as `wasm-bindgen-test` browser tests** | The Rust test harness loads the page, calls into the TS through a small test hook, asserts on the DOM | Works. Awkward for pure-logic tests, because a reconciler unit test becomes a browser test with a browser test's latency |
| **B — a first-party micro-runner** | ~80 lines of TS: a `test(name, fn)` registry, an `assert`, and an HTML page that runs them and writes results to `document.title`. Driven by the same WebDriver harness | **Preferred.** It is small, it is ours, it runs in a real engine rather than jsdom (which is a *simulation* of a DOM and is exactly wrong for a codebase whose rules are about DOM sinks), and it removes the runner question entirely |
| **C — port the logic to Rust** | The packed-format reader could be generated (`41` §8.4) and tested on the Rust side | Partial: it removes the highest-value TS tests and leaves the DOM ones |

**DECISION — B, with C where the logic is generated anyway.** The deciding argument is that jsdom is
the wrong environment for this codebase specifically: `34`'s R1–R10 are claims about what real
browsers do with real sinks under real Trusted Types enforcement, and a simulated DOM cannot falsify
them.

### 4.3 End-to-end, and the honest comparison to Playwright

| | **Playwright (Node)** | **`fantoccini` / `thirtyfour` (WebDriver, Rust)** | **`chromiumoxide` (CDP, Rust)** |
|---|---|---|---|
| Cross-browser | Chromium, Firefox, WebKit, one API | Chrome, Firefox, Safari via their drivers | Chromium only |
| Auto-wait, retrying assertions | **yes, and it is the reason it is pleasant** | no — you write the waits | no |
| Trace viewer, video, time-travel debugging | **yes** | no | no |
| Reading CSP violations, `performance.getEntriesByType`, console errors | yes | yes, via `execute_script` | yes, natively via CDP events |
| Network interception (needed to *assert no requests*) | yes | limited | **yes** — CDP is the right tool for `34` §8.3 check 4 |
| Requires Node | **yes** | no | no |
| Ergonomics | best in class | workable | workable, Chromium-only |

**The honest statement: dropping Playwright costs real quality of life and some real capability.**
Auto-waiting assertions eliminate a class of flaky test that we will now have to eliminate by hand,
and the trace viewer is the single best debugging tool in browser testing.

**DECISION — WebDriver via a Rust client for the cross-browser matrix, plus `chromiumoxide` for the
checks that need protocol-level access** (network interception for the no-egress assertion, CSP
violation events, precise resource timing). Two harnesses is a cost; it is smaller than the cost of
either one alone missing half the checks.

<!-- VERIFY: confirm current maintenance status and WebDriver-spec coverage of the Rust WebDriver
     clients, and that chromiumoxide's CDP bindings cover Network.requestWillBeSent and
     Security/CSP violation events at the version we would pin. If either is unmaintained, §7's
     criterion permits Playwright downstream of the manifest — that is exactly what Z4 is for. -->

### 4.4 What we lose, listed rather than minimised

| Lost | Consequence | Mitigation |
|---|---|---|
| Auto-waiting assertions | Flaky tests, written by hand, that fail at 2 % and get retried | A first-party `wait_until(predicate, timeout)` helper used everywhere, and a **zero-retry policy** in CI: a flaky test is a bug in the test |
| Trace viewer / video | Debugging a CI-only failure is much harder | Screenshot + full DOM dump + console log on every failure, saved as CI artifacts |
| WebKit coverage on Linux | Playwright bundles a WebKit build; `safaridriver` needs macOS | A macOS runner for the Safari matrix, or accept a documented gap. **Say which** |
| Component-level testing conventions | We write our own | §4.2 B |
| Contributors' familiarity | A contributor who knows Playwright has to learn our harness | Documentation, and keeping the harness small enough to read |

---

## 5. The developer inner loop

*margin tab: verify as you go*

```bash
# terminal 1 — rebuild the core on change
cargo watch -x 'run -p xtask -- dev-core'      # cargo build --target wasm32 + wasm-bindgen

# terminal 2 — rebuild the UI on change
cargo watch -w ui -x 'run -p xtask -- dev-ui'  # oxc transform, lightningcss, no minify

# terminal 3 — serve it
cargo run -p fathom-cli -- serve --dev --port 7440
```

`fathom serve --dev` differs from production `serve` in exactly three ways, all of which are compiled
out of release builds behind a `dev` feature that CI asserts is absent from A4:

1. It serves from the target directory rather than from the embedded asset tree.
2. It sends `Cache-Control: no-store` and a `Last-Modified` per file.
3. It exposes `/__reload`, a long-poll the dev page uses to trigger `location.reload()`.

**No HMR, and that is the cost.** A UI edit reloads the page, which discards the open workspace.
Mitigations, in the order they should be built:

| Mitigation | Effect |
|---|---|
| A dev-only fixture loader: `?fixture=srx-ipsec-site-to-site` reloads straight into a known workspace | Removes most of the pain. The fixture is a real test asset (`fixtures/`), so it earns its keep twice |
| Session state (open panel, selected node, scroll position) persisted to `sessionStorage`… | **Rejected.** `34` §5.7 bans `sessionStorage` outright. Dev-only exceptions to a security lint are how security lints die |
| …persisted instead into the URL fragment, dev builds only | Acceptable, and it costs nothing in production because the code is behind the `dev` feature |

**The honest comparison:** a Vite HMR loop preserves component state and updates in ~50 ms. Ours is a
full reload in ~300 ms plus fixture load. For a UI of a few thousand lines with no animation and no
multi-step wizard state that cannot be re-entered from a URL, that is an irritation, not an
impediment. For a UI with a complex editing session — which the diagram editor eventually is — it
will hurt, and the fixture loader is what keeps it bounded.

---

## 6. The counter-argument, at full strength

*margin tab: why it exists*

A document that only argues its own side is not an architecture document. Here is the strongest
version of the case against, made properly.

### 6.1 Purity costs velocity, and the cost is not small

| Where | Cost |
|---|---|
| Browser testing | §4.4. Weeks of harness work, and a permanent quality-of-life reduction |
| The dev loop | §5. No HMR, ever |
| A UI test runner we maintain | ~80 lines to write, and an indefinite obligation |
| Onboarding | Every web developer knows the npm loop; nobody knows ours |
| The moment a genuinely-needed library exists | `34` §8.2 already names it: a graph layout library. Writing layered layout is weeks (`41` §4.5b). "We have no package manager" makes the cheap option unavailable |
| Tool maturity risk | `oxc`'s minifier, the Go TypeScript compiler and the Rust WebDriver clients are each younger than the Node tool they replace. Each is a place where we hit a bug the mainstream path does not have |

Add it up and it is plausibly **six to ten person-weeks in year one**, plus a standing tax. That is
real money for a small team, and pretending it is free is the failure mode this section exists to
prevent.

### 6.2 "A build-time dependency is a supply-chain risk whether it is Node or Rust"

This is the strong form and it is substantially correct.

| | npm | Cargo |
|---|---|---|
| Arbitrary code at **install** time | `preinstall`/`install`/`postinstall` scripts | **no** — cargo does not run install scripts |
| Arbitrary code at **build** time | build steps in the package's own scripts | **yes** — `build.rs`, with the build host's full privileges, no sandbox |
| Arbitrary code at **compile** time | — | **yes** — proc macros, no sandbox, can read the filesystem, the clock, the environment and the network |
| Typical tree size for a web toolchain | hundreds to thousands of packages | our whole shipped closure is ~130 (`41` §7.4) |
| Demonstrated worm-scale compromise via the install channel | **yes** — `35` §6.1 cites the September 2025 campaign and the resulting CISA alert | not at that scale |

`35` §5.7 concedes the middle rows in its own words: *"A `build.rs` and a proc macro are arbitrary
programs that run on the build machine with the build machine's privileges… There is no sandbox in
stable Cargo… Residual: `material`. Named, capped, enumerated, read — and still a hole."*

**So the honest position is:** Cargo is not categorically safe. It is *quantitatively* better on
three axes — no install-time execution, a far smaller tree, and a culture where `build.rs` is
unusual rather than routine — and it is *equally* bad on the axis that matters most, which is that
arbitrary code runs on the machine that produces the artifact you sign.

Anyone who says "we use Rust so our build is safe" has stopped thinking. The correct sentence is:
*we reduced the number of arbitrary programs that run during our build from several hundred to
roughly six, and we read those six.*

### 6.3 Where the counter-argument fails

It fails on **volume and on our specific shape**, not on principle.

| Fact | Why it decides this |
|---|---|
| Our UI is a few thousand lines of hand-written TypeScript with no framework, no component library, no icons, no CSS-in-JS and no dynamic imports (`41` §4, `34` §8.2) | The toolchain we are declining to install is one that exists to solve problems we do not have. Refusing npm costs a React app enormously and costs this UI a test runner and HMR |
| The largest "JS-shaped" build job — corpus compilation and search-index construction — is already Rust (`§2.3`) | The Node build was going to be small anyway |
| The product's central claim is *"you can rebuild this yourself and get the same bytes"* (`35` §1.1) | Every additional toolchain is a thing a third-party rebuilder must install and match. Four toolchains is a rebuild instruction people follow; a Node version, an npm version and a lockfile is one they abandon |
| The threat model's flagship deployment is air-gapped and defence (`brief` §2.4) | The reviewers in those environments have specific, informed opinions about npm, and "we do not use it" is a sentence that ends a conversation rather than starting one |

**The generalisable version:** the no-Node position is cheap *because the UI is austere*, and the UI
is austere because the design language demands it. If the design language ever loosens — if someone
wants a chart library, a rich text editor, a date picker — the cost of this position rises steeply
and the decision should be re-examined rather than defended.

---

## 7. The decision criterion, and the RECOMMENDATION

### 7.1 The criterion

Not "is it Node". One question:

> **Can this tool change a byte in an artifact we sign?**

| Answer | Rule |
|---|---|
| **Yes** | It must be a Rust library crate pinned by `Cargo.lock`, or a native binary pinned by SHA-256 in `build/toolchain.lock.toml`, and it runs inside the hermetic no-route build container. **No exceptions, and no npm at any point.** This is Z2 and Z3 |
| **No — it only reports** (type check, lint, format, test, screenshot) | It is a **policy** question, not a security one. It may use any toolchain, but it runs **after** stage 13 in a separate job that has no write access to the artifacts, and its failure blocks the release without its output ever entering one. This is Z4 |

The criterion is sharp because it maps onto something already true of the build: `35` §3.4 splits
stages 0–13 (no credentials, artifact-producing) from stages 14–15 (credentials, signing). Z4's
tools sit between them, in a third job that has neither.

**What Z4 does not buy, said plainly:** a compromised type checker or e2e runner cannot alter the
artifact, but it *can* make a failing check pass. That is a real attack — suppressing a signal is
cheaper than forging one — and the residual is `material`. The mitigations are that the checks are
also run in a second place (the Rust-side determinism gates, the WASM import allowlist, the bundle
scanner — all of which are `xtask` subcommands inside the hermetic build) and that a check's *absence*
is itself a CI failure. Neither closes it.

### 7.2 RECOMMENDATION

> **Adopt Z2 as a hard gate: no npm, no `package.json`, no `node_modules`, no Node binary in the
> build container, ever. Adopt Z5 as a hard gate too — the product must build and run on a Node-free
> machine. Treat Z4 as a permitted escape hatch that is currently unused, and prefer the Rust
> harnesses in §4 for v1.**

The reasoning, in order:

1. **Z2 is nearly free for this project** (§6.3) and it is the claim that survives review. Take it.
2. **Z5 is what makes Z2 stick.** A rule about the build container that developers route around
   locally decays within a quarter.
3. **Z4 exists because §4.3 is genuinely weaker without Playwright**, and pretending otherwise would
   produce exactly the outcome `35` §5.3 question 9 warns about: an absolute policy that gets
   bypassed the first time it is inconvenient, after which it is decoration. Naming the conditions
   under which Node is acceptable is what keeps the rest of the policy real.
4. **But do not spend the escape hatch on day one.** Build the Rust harness, measure the pain over
   two quarters, and if the flakiness or the missing WebKit coverage is costing more than it saves,
   invoke Z4 *deliberately*, in a pull request, with the isolation in §7.1 built first.

**The condition that would make us invoke Z4:** e2e flake above ~2 % of runs after a genuine effort
at explicit waits, or a `34` §10 checklist item that cannot be asserted from the Rust harness at all.
Write that number down now, because the argument is much harder to have later.

---

## 8. The build graph per deployment mode

*margin tab: read this first*

Stage numbers refer to `35` §3.4, so the two documents can be read side by side. Every command below
runs inside the pinned build container with a scrubbed environment (`35` N11), `SOURCE_DATE_EPOCH`
exported, `LC_ALL=C`, `TZ=UTC`, and no network after stage 2.

### 8.1 Common prefix — stages 0 to 6, every mode that ships WASM

```bash
# stage 0 — identity
export SOURCE_DATE_EPOCH="$(git log -1 --pretty=%ct)"
export CARGO_HOME=/build/cargo
export LC_ALL=C TZ=UTC

# stage 1 — toolchain, each entry verified against build/toolchain.lock.toml
xtask toolchain-fetch --lock build/toolchain.lock.toml   # rustup components, wasm-bindgen-cli,
                                                          # wasm-opt, tsgo; sha256 each
xtask assert-lockstep                                     # wasm-bindgen crate == CLI version

# stage 2 — sources; the last stage with a network route
cargo fetch --locked

# ---- network is removed here ----

# stage 4 — the core
cargo build --release --locked --target wasm32-unknown-unknown -p fathom-wasm

# stage 5 — glue
wasm-bindgen target/wasm32-unknown-unknown/release/fathom_wasm.wasm \
  --target web --no-typescript --out-dir dist/wasm

# stage 6 — optimise, with the checked-in flag vector, no --converge (35 N15)
wasm-opt $(cat build/wasm-opt.flags) dist/wasm/fathom_wasm_bg.wasm -o dist/wasm/fathom_core.wasm
```

```toml
# Cargo.toml — the release profile that stages 4 and 11 depend on
[profile.release]
opt-level        = "z"
lto              = "fat"
codegen-units    = 1        # 35 N1
panic            = "abort"
strip            = "symbols"
debug            = 0        # 35 N7
overflow-checks  = true     # 41 §2.5 — a wrapped length in a parser is the bug we are here to avoid
incremental      = false
```

### 8.2 Mode A — the reference artifact, one HTML file

```bash
# stage 7 — UI: oxc transform + minify, lightningcss; both are Rust libraries inside xtask
cargo run -p xtask --release -- ui-build --manifest build/assets.toml --mode single-file

# stage 8 — corpus + finder index
cargo run -p fathom-corpus --release -- build --out dist/finder

# stage 9 — first-party rule pack
cargo run -p fathom-pack --release -- build --domain ipsec --out dist/packs

# stage 10 — assemble. Deterministic inline order; CSP hashes computed over the FINAL bytes
cargo run -p xtask --release -- assemble \
  --mode A \
  --wasm dist/wasm/fathom_core.wasm \
  --index dist/finder/finder.idx --weights dist/finder/finder.toml \
  --pack dist/packs/fathom.ipsec-<ver>.fpack \
  --fonts assets/fonts/*.woff2 \
  --out dist/fathom-<ver>.html
```

What mode A contains, in the fixed inline order `xtask assemble` uses:

```text
<meta http-equiv="Content-Security-Policy" …>   ← 34 §2.2, minus the four discarded directives
<style>          hand-written CSS, lightningcss-minified
<style>          @font-face with base64 WOFF2 (four faces)
<script>         app.js — our TypeScript, transformed and minified
<script>         base64 WASM  →  instantiated from a Uint8Array, never fetched
<script>         base64 finder index
<script>         base64 rule pack
```

**Nothing in that file is fetched.** `connect-src 'none'` is not a promise about our behaviour; there
is no code path that could make a request, which §9.4 check 6 proves from the WASM import section and
check 2 proves from the bundle.

### 8.3 Mode B — the offline workspace: static bundle + `fathom serve`

```bash
cargo run -p xtask --release -- ui-build --manifest build/assets.toml --mode assets
cargo run -p xtask --release -- assemble --mode B --out dist/web/        # A2 asset tree
cargo run -p xtask --release -- embed-assets --in dist/web --out crates/fathom-cli/src/generated/assets.rs
cargo build --release --locked --target x86_64-unknown-linux-musl -p fathom-cli   # stage 11 → A4
```

`embed-assets` generates Rust source containing a **sorted, explicit** file list with contents and
content-type — no glob (`35` N17), no mtime (`35` N6), no directory-order dependence (`35` N9). The
generated file is committed, exactly like the boundary types (`41` §8.4), so the asset set is visible
in a diff.

### 8.4 Modes C and D — self-hosted with sync, and enterprise

```bash
cargo build --release --locked --target x86_64-unknown-linux-musl -p fathom-sync
cargo run -p xtask --release -- sbom --features "store-redb,serve"          # stage 12 → A8, A9
cargo run -p xtask --release -- manifest --out dist/MANIFEST-<ver>.txt      # stage 13 → A10

# packaging only — BuildKit never transforms a shipped byte
docker buildx build --file build/sync.Dockerfile --output type=oci,dest=dist/sync-oci.tar .
```

```dockerfile
# build/sync.Dockerfile — no shell, no libc, no package manager
FROM scratch
COPY --from=artifacts fathom-sync /fathom-sync
COPY --from=artifacts MANIFEST-<ver>.txt /MANIFEST.txt
USER 65534:65534
ENTRYPOINT ["/fathom-sync"]
```

Mode D differs from C only in operator configuration (`store-postgres` instead of `store-redb`,
multiple replicas, an external TLS terminator). **It is the same binary and the same asset tree**,
which is what `31` §1.1's "same code" claim requires and what makes one manifest cover both.

### 8.5 Mode E — the CLI, and the three triples

```bash
for T in x86_64-unknown-linux-musl aarch64-unknown-linux-musl aarch64-apple-darwin; do
  cargo build --release --locked --target "$T" -p fathom-cli
done
# macOS and Windows: the UNSIGNED binary's digest goes in the manifest (35 §2.3);
# codesign/notarise and Authenticode happen after stage 13 and break byte reproducibility.
```

### 8.6 The gate job — Z4's territory, downstream of the manifest

```bash
tsgo --noEmit -p ui/tsconfig.json          # type check; emits nothing
oxlint --config ui/.oxlintrc.json ui/src   # the 34 §5.8 sink ban list
dprint check                               # formatting
cargo test --workspace --locked            # core logic, property tests, snapshots
cargo run -p xtask -- check-deps           # crate edges (41 §8.2) + C1–C7 caps
wasm-pack test --headless --chrome --firefox crates/fathom-wasm   # WebDriver, no Node
cargo test -p fathom-e2e -- --test-threads=1                      # WebDriver + CDP (§4.3)
cargo run -p xtask -- verify-artifact dist/fathom-<ver>.html      # §9.4 checks 1–8
```

**This job has read-only access to `dist/` and no signing credentials.** It cannot alter an artifact;
it can only refuse one. That separation is what makes Z4 statable at all.

### 8.7 The reproducibility gate

```bash
./build/repro.sh                                  # full build, scratch dir #1
./build/repro.sh --scratch /build/alt             # full build, scratch dir #2
sha256sum -c dist/MANIFEST-<ver>.txt              # R1: same machine, twice (35 §3.1)
```

---

## 9. "Zero runtime dependencies", defined precisely

*margin tab: fields that matter*

### 9.1 The definition

The phrase is used loosely enough to be worthless. Here it means one thing:

> **After the artifact is on the user's machine, nothing else needs to be present, fetched, resolved
> or installed for it to work — and nothing else is.**

Per artifact:

| Artifact | Requires | Requires nothing else — specifically |
|---|---|---|
| A1 (single HTML file) | **a browser** | no server, no network, no font host, no CDN, no runtime, no extension, no installed application |
| A2 + A4 (mode B) | **a browser and a kernel** | the CLI is a static musl binary; `ldd` reports "not a dynamic executable" |
| A4 (CLI) | **a kernel** | no libc, no OpenSSL, no Java, no Python, no Node |
| A5 (sync service) | **a kernel and a writable directory** (mode C) or a Postgres endpoint (mode D) | no shell in the image, no package manager, no sidecar, no init system |
| A6 (rule pack) | the application | no network fetch at install; packs are files, verified by signature |

### 9.2 What is *not* a runtime dependency, and why the distinction is honest

| Thing | Is it a runtime dependency? | Why |
|---|---|---|
| The Rust crates compiled into the WASM module | **no** | They are *in* the artifact. `34` §8.1 already refuses to call this "zero third-party code": third-party code is present and executing, and it is enumerated in the SBOM (A8). What is absent is anything **resolved or fetched at run time** |
| The browser | no, in the sense used here | It is the platform. Stating a browser support matrix is `34` §8.2's job |
| Fonts | **no** | Subset, shipped, inlined (`34` §8.4). A font from a host would be one, which is why there isn't one |
| The rule pack | no | A file, signed, loaded from disk |
| WebCrypto | no | A platform API, and `32` uses it only for `crypto.getRandomValues` — one import (`41` §3.7) |

**The sentence that must not be written:** *"Fathom has zero dependencies."* It has around 130 crates
in the shipped closure (`41` §7.4) and an SBOM that says so. The true claim is narrower and stronger:
**zero runtime resolution.** Nothing is fetched, nothing is discovered, nothing is version-resolved
on the user's machine.

### 9.3 The negative claims, and which are structural rather than behavioural

| Claim | Structural or behavioural? |
|---|---|
| No network request is ever made in mode A | **structural** — the WASM module imports two functions, neither capable of a request (`41` §3.2), and `connect-src 'none'` is in the document |
| No third-party JavaScript executes | **structural** — there is none in the bundle, and CSP forbids loading any |
| No dynamic code is generated | **structural** — `eval`, `new Function` and dynamic `import()` are lint-banned and CSP-blocked |
| No data is written outside the workspace | **behavioural** — enforced by `34` §5.7's storage bans and reviewed code, not by the platform |
| No telemetry | **structural** in mode A; **behavioural** in C/D, where an origin exists and the code chooses not to use it beyond sync |

Publishing which is which is worth more than publishing the claims, because a reviewer's next
question is always "how would I know".

### 9.4 CI enforcement

Fourteen checks. Each names the claim it defends, so a check that starts failing has an owner and a
meaning rather than being a red square someone disables.

| # | Check | Command / mechanism | Fails when | Defends |
|---|---|---|---|---|
| 1 | **No Node in the build container** | `! command -v node && ! command -v npm && ! command -v npx` at container start | Any is present | Z2, Z5 |
| 2 | **No JS package manifests anywhere** | `git ls-files \| grep -E '(^\|/)(package\.json\|package-lock\.json\|pnpm-lock\.yaml\|yarn\.lock)$'` returns nothing; `! test -d node_modules` | Any appears | Z2 |
| 3 | **Hermetic build** | Stages 3–13 run with no route; a fetch attempt fails the build | The build needs the network | Z2, Z3, `34` §8.3 check 3 |
| 4 | **Toolchain lock complete** | Every binary invoked by `xtask` is in `build/toolchain.lock.toml` with a matching SHA-256; `xtask` refuses to exec anything else | A tool is invoked that is not pinned | Z3 |
| 5 | **WASM import allowlist** | `wasm-objdump -x fathom_core.wasm`, import section compared to a committed list — currently `fathom_entropy`, `fathom_now_ms` | Any other import, or any import that could originate a request | Z1, `34` §8.3 check 6 |
| 6 | **WASM export allowlist** | Same, exports side — the ten opcode entry points plus `memory`, `fathom_alloc`, `fathom_free` | A debug or test export survives into a release artifact | `32` §16.3, `34` §7.5 |
| 7 | **Bundle scanner** | Parse A1 and A2's JS/CSS/HTML; every `src`, `href`, `url()`, `@import`, `new URL()` literal must resolve to `data:` or a same-origin relative path | Any absolute off-origin URL | Z1, `34` §8.3 check 2 |
| 8 | **String scan for known hosts** | `strings` over A1–A4 for `http://`, `https://`, `cdn.`, `fonts.`, `googleapis`, `unpkg`, `jsdelivr` — allowlist the sync origin placeholder and nothing else | A hostname appears | Z1, defence in depth behind 7 |
| 9 | **No dynamic code** | `oxlint` rules banning `eval`, `new Function`, dynamic `import()`, string-argument timers, plus the `34` §5.8 sink list | Any appears | Z1 |
| 10 | **Runtime egress assertion** | e2e: exercise every feature with CDP network interception; assert zero requests in mode A, and only the sync origin in C/D. Cross-check `performance.getEntriesByType('resource')` | Any request | Z1, `34` §8.3 check 4 |
| 11 | **No-route runtime run** | Run the full e2e suite in a network namespace with no route | Any feature fails that should not, or any connection is attempted | Z1, `31` §12 |
| 12 | **Static linkage** | `ldd dist/fathom-<ver>-x86_64-unknown-linux-musl` reports "not a dynamic executable"; `file` confirms static | Dynamically linked | §9.1 |
| 13 | **Container has no runtime** | The image's layer set is exactly `{binary, manifest}`; assert no `/bin/sh`, no libc, no package DB | Anything else in the image | §9.1 |
| 14 | **Manifest records the toolchain set** | A10 lists every tool, version and SHA-256 used in stages 0–13, and CI diffs it against `build/toolchain.lock.toml` | They differ | Z3, `35` §3.2 |

```rust
// xtask verify-artifact — checks 5, 6, 7, 8, 12, 13 in one command, so that
// "did we run the checks" is one exit code rather than a CI YAML reading exercise.
pub fn verify_artifact(paths: &Artifacts, allow: &Allowlists) -> Result<Report, Vec<Violation>>;
```

**RECOMMENDATION — publish the output of `xtask verify-artifact` with each release.** It is the
cheapest verification UX in the whole product (`35` §13's concern): a reviewer reads fourteen lines
and can re-run any of them with tools we did not write.

---

## 10. Failure modes of this position

*margin tab: what the log means*

Every one of these will happen. The recovery is the useful part.

| # | Failure | Symptom | Recovery |
|---|---|---|---|
| 1 | **The `oxc` minifier miscompiles our JS** | A subtle runtime break that only appears in release builds, which is the worst class of bug to find | The e2e suite runs against **both** minified and unminified builds on release candidates. If they diverge, ship unminified and file upstream. `35` §6.2 already names this as an acceptable outcome; the file is dominated by base64 WASM anyway |
| 2 | **The Go-native TypeScript compiler regresses or is unavailable** | The type-check gate fails or cannot run | The gate is Z4 — it emits nothing. A release can proceed with the gate red and a recorded exception, which is *worse*, not fatal. The fallback is type-checking in a container that does have Node, downstream of the manifest, which §7.1 explicitly permits |
| 3 | **A contributor adds `package.json` out of habit** | It works on their machine | Check 2 (§9.4). The failure message names this document |
| 4 | **A genuinely-needed JS library appears** — graph layout is the live case | The build-it-ourselves estimate is weeks | `34` §8.2's rule already governs it: vendor it into the repository, pin to a commit, review it, compile it in, and it must return coordinates and never touch the DOM. Vendoring is not npm. **Do not relax the package-manager rule to acquire one library** |
| 5 | **The e2e harness is too flaky to trust** | Retries creep into CI | §7.2's stated threshold. Invoke Z4 deliberately with the isolation built first, or cut the flaky test and replace the coverage with a `wasm-bindgen-test` |
| 6 | **`wasm-bindgen` / CLI version skew** | A hard failure with an unhelpful message, usually right after a lockfile regeneration | `xtask assert-lockstep` in stage 1 — the failure arrives in five seconds instead of five minutes (`35` §3.2) |
| 7 | **Two build paths drift**: `trunk` for a developer, `xtask` for CI | "Works locally, fails in CI", or worse, the reverse | **DECISION — `trunk` is not adopted.** It is a good tool and it manages `wasm-bindgen`/`wasm-opt` for you, which is precisely the pinning `35` §3.2 requires *us* to own. One build path, `xtask`, used by developers and CI alike |
| 8 | **Someone needs a browser we cannot drive from Rust** | A support-matrix gap | Document the gap in the support matrix rather than adding a toolchain to hide it |

---

## 11. What this costs, added up

| Cost | Size |
|---|---|
| Browser test harness, built rather than adopted | 2–4 person-weeks, plus standing maintenance |
| A first-party TS micro-runner | ~80 lines, plus the habit of using it |
| No HMR, forever | An irritation that grows with UI complexity; bounded by the fixture loader (§5) |
| Tool maturity risk on `oxc`'s minifier, the Go TypeScript compiler, and the Rust WebDriver clients | Each is a place we hit a bug the mainstream does not have. Mitigated by every one being replaceable with "do less" |
| Contributor onboarding | Everyone knows npm; nobody knows `xtask` |
| Font subsetting has no clean Rust story yet | Resolved by committing the WOFF2 files (§2.2), at the cost of a manual step twice a decade |
| **What it buys** | Four toolchains, of which one can silently change what ships (`35` §6.3); a rebuild instruction a third party will actually follow; a sentence that ends the npm conversation in an air-gapped review |

---

## 12. Open decisions

| # | Question | Lean | Blocked on |
|---|---|---|---|
| 1 | Font subsetting: `allsorts` in the build, or committed WOFF2 files | **Committed files** (§2.2) | Nothing. This is a scoping call and the cheap answer is right |
| 2 | Rust WebDriver client vs `chromiumoxide` vs both | **Both** (§4.3) | Confirming maintenance status of the WebDriver clients |
| 3 | Is the Go-native TypeScript compiler a viable pinned binary for `--noEmit` today? | Assume yes, per `35` §6.2 | Same VERIFY `35` already carries; do not duplicate the claim, resolve it once |
| 4 | Does `oxc`'s minifier meet the correctness bar as a library crate at a pinnable version? | Assume not yet; ship unminified until proven | Differential e2e (§10.1) |
| 5 | Safari/WebKit coverage without Playwright's bundled build | A macOS runner, or a documented gap | A decision about the support matrix, which is `34` §8.2's |
| 6 | Should Z4 be permitted at all, or should the policy be absolute? | Permitted, unused (§7.2) | The owner. This is the one judgement call in the document that is genuinely a preference |

---

## 13. Sources

| Claim | Source |
|---|---|
| Trunk runs `cargo build` for `wasm32`, then `wasm-bindgen`, and downloads and manages `wasm-bindgen` and `wasm-opt` itself — which is why it is a good tool and the wrong one for a build whose pinning we must own | [trunkrs.dev](https://trunkrs.dev/); [trunk-rs/trunk](https://github.com/trunk-rs/trunk) |
| `wasm-bindgen-test` drives real headless browsers over WebDriver — `chromedriver`, `geckodriver`, `safaridriver` — and Node is a separate, optional configuration | [wasm-bindgen guide — testing in headless browsers](https://rustwasm.github.io/docs/wasm-bindgen/wasm-bindgen-test/browsers.html) |
| Lightning CSS is a Rust CSS parser, transformer, bundler and minifier usable as a library crate, built on `cssparser` and `selectors` | [lightningcss.dev](https://lightningcss.dev/); [parcel-bundler/lightningcss](https://github.com/parcel-bundler/lightningcss) |
| `oxc_minifier` exists as a Rust crate; oxlint reached 1.0 with 650+ rules implemented in Rust and later gained an ESLint-compatible JavaScript plugin API for custom rules | [oxc_minifier](https://crates.io/crates/oxc_minifier); [Announcing Oxlint 1.0](https://voidzero.dev/posts/announcing-oxlint-1-stable); [oxlint JS plugins](https://oxc.rs/docs/guide/usage/linter/js-plugins) |
| esbuild is a Go program; it can be obtained with `go install`, or its precompiled binary extracted from a tarball with `curl` without running Node — the npm package is a distribution channel, not a runtime requirement | [esbuild — getting started](https://esbuild.github.io/getting-started/); [evanw/esbuild#918](https://github.com/evanw/esbuild/issues/918) |
| `allsorts` is a font parser, shaping engine and subsetter written entirely in Rust, covering OpenType, WOFF and WOFF2; `fontcull` is Rust subsetting that retains C++ for WOFF2 compression | [yeslogic/allsorts](https://github.com/yeslogic/allsorts); [bearcove/fontcull](https://github.com/bearcove/fontcull) |
| Cargo does not execute install scripts, but `build.rs` and proc macros run arbitrary code at build and compile time with no sandbox | `35` §5.7, which states this against itself |
| The npm install-script channel has been used for ecosystem-scale self-replicating compromise, prompting a CISA alert | `35` §6.1, which carries the citation |

Field-card material referenced in the CI messaging and the failure-mode framing — *"stop at the first
failure"*, *"correlate before you theorise"* — is from `.context/field-card-srx-ipsec.txt`, sides 1
and 4.

---

## 14. Disagreements

**With the conventions: none.**

**With `35-supply-chain-and-builds.md` §5.1, cap C6 — one proposed change, stated as a change:**

C6 is currently *"npm packages, at any stage: 0"*. §7.1 proposes splitting it:

| | Proposed |
|---|---|
| **C6a** | **npm packages in any stage that can influence an artifact byte (stages 0–13): 0.** Hard gate, no exception procedure |
| **C6b** | **npm packages in report-only tooling downstream of stage 13: 0 by default, with a written exception that names the tool, the isolation, and the residual.** Currently zero and expected to stay zero |

The argument for the split is `35`'s own, from §5.3 question 9: a policy with no articulated
exceptions gets bypassed the first time it is inconvenient, and after that it is decoration. The
argument against — that any crack widens — is real, and §7.2's recommendation answers it by keeping
the exception unused and requiring the isolation to be built *before* it is invoked rather than
during the incident that motivates it.

**Note the direction of the change:** C6a is *stronger* than C6 as written, because "can influence an
artifact byte" is a testable property while "any stage" is a boundary nobody has drawn. The split
tightens the important half and makes the unimportant half honest.

**With `34-browser-hardening.md` §8.3, check 1 — a correction rather than a disagreement:**

Check 1 reads *"`dependencies` in `package.json` is `{}`"*, which presumes a `package.json` with
`devDependencies` in it. Under C6/Z2 there is no `package.json` at all. §9.4 check 2 is the
replacement wording — *no `package.json`, no lockfile, no `node_modules`, anywhere in the repository
or the container* — and it is both stronger and easier to verify. `34` check 1 should be replaced
with it. `41` §12 records the same correction from the other side.
