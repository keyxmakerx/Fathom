# 24 — Determinism and offline operation of the AI layer

> **Status:** Proposed

Companion to `21-ai-layer-architecture.md`, which owns the boundary, the supervisor, the
consent model and the deployment tiers, and to `22-subagent-catalogue.md`, which owns the
subagents themselves. This document owns four things those two deliberately leave open:

1. **Where inference actually runs** when it is not a hosted provider, evaluated against real
   platform constraints rather than a vendor's landing page.
2. **Whether the browser may reach `http://localhost`**, treated as a security decision with a
   decision at the end of it.
3. **What reproducibility means once a model has touched a workspace**, and the machinery that
   makes the claim checkable rather than asserted.
4. **What happens when the model changes underneath a user**, which it will, silently, and
   which is the one failure in this system that nobody is watching for.

**The governing rule of this document, stated once, in caps, at the top:**

> **TEMPERATURE ZERO IS NOT REPRODUCIBILITY. THE RECORD IS.**

Everything below is a consequence of taking that sentence literally. We do not build a system
that tries to make the model deterministic. We build a system in which the model's
non-determinism is bounded, recorded, and irrelevant to every artifact the user takes away.

---

## 0. Contents

| § | Section | |
|---|---|---|
| 1 | What this document owns, and what it defers | *scope* |
| 2 | Four runtimes, evaluated against platform reality | *read this first* |
| 3 | The localhost sidecar is a security decision | *decide* |
| 4 | Determinism | *the guarantee* |
| 5 | Caching and pinning | *free and identical* |
| 6 | The graceful degradation matrix | *every row usable* |
| 7 | Model-version drift | *nobody is watching* |
| 8 | Failure modes of this document's own machinery | *what bites* |
| 9 | Open decisions | |
| 10 | Sources consulted | |
| 11 | Disagreements | |

---

## 1. What this document owns, and what it defers

| Owned here | Deferred to |
|---|---|
| Runtime selection: WebGPU / WASM / sidecar / enterprise endpoint | — |
| The loopback decision, its CSP and its transport | 23 §6 for exfiltration channels generally |
| `ModelPin`, `RuntimePin`, `PromptDigest`, `AiValueRecord` type definitions | 21 §4.10 references `ModelPin`; this document defines it |
| The response cache: key, canonicalisation, storage, eviction | — |
| The no-AI verification pass (`fathom verify --no-ai`) | 21 §9.5 sketches it; this specifies it |
| Drift detection, the canary suite, and what disarms | 22 §2.8 F10 names the failure; this specifies the response |
| The degradation matrix across model capability | 21 §7.6 gives a tier view; this gives a *capability* view, which is the one that matters once tier 2 has two sub-variants |
| What a small model can and cannot do, per subagent | 22 §3–§12 for the subagents themselves |
| Egress consent, pre-flight, redaction | 21 §8 |
| Injection, spotlighting, destructive-recommendation interlock | 23 |
| Subagent prompts, schemas, gates, eval sets | 22 |

Two things this document does **not** do, so nobody looks for them:

- It does not re-argue the boundary. R1 (the AI layer is never in the artifact path) and R2
  (every change arrives as a reviewable proposal) are taken as settled. Every claim below
  depends on them.
- It does not describe a way to make a hosted model reproducible. There is not one, and §4.1
  says why in detail rather than waving at it.

---

## 2. Four runtimes, evaluated against platform reality

### 2.1 The evaluation frame

A runtime is not "a place a model runs". For this product it has to supply seven things, and a
runtime that supplies six of them is a runtime that will fail in a specific, nameable way.

| # | Requirement | Why this product needs it |
|---|---|---|
| **1** | **Structured output that validates** | Every subagent's output is a JSON Schema (22 §2.6). Free prose is not an output type here. |
| **2** | **Constrained decoding, ideally** | 21 §6.6: grammar-constrained sampling makes malformed tool calls structurally impossible rather than merely rejected, and saves the repair budget. |
| **3** | **A verifiable model identity** | §7. Without it, `ModelPin.identity_confidence` is `Unknown` and the audit record records a rumour. |
| **4** | **Bounded, predictable cold start** | The deterministic answer is already on screen (21 §10.2). A 40-second first-token is not a correctness problem, it is an abandonment problem. |
| **5** | **A context ceiling that fits the working set** | 22 §2.5: the IPsec-relevant subgraph of one SRX is ≈ 1,300 tokens; S2 comprehension has a 24,000-token ceiling. A 2,048-token runtime cannot run half this catalogue. |
| **6** | **No new egress** | Invariant 1. |
| **7** | **A story for the offline single file** | §1 of the brief. If a runtime cannot exist in that artifact, say so rather than implying it can. |

### 2.2 (a) In-browser WebGPU

The model runs in the page, on the user's GPU, through a WebGPU runtime. The WebLLM/MLC
lineage is the mature option and the one to evaluate against.

**Platform status.** WebGPU is shipped by default in Chrome, Edge, Firefox and Safari; Apple
shipped it in Safari 26 (macOS Tahoe 26, iOS 26, iPadOS 26, visionOS 26) in September 2025,
and the feature reached Baseline in January 2026. Availability is no longer the constraint.
The constraints are memory, storage and origin.

**Memory — the limit people miss.** WebGPU's *default* limits are
`maxStorageBufferBindingSize` = 128 MiB and `maxBufferSize` = 256 MiB. Those are defaults,
not ceilings: an adapter can advertise far higher, and desktop adapters commonly do
(`maxStorageBufferBindingSize` up to 4 GiB), while mobile and many integrated GPUs sit at the
128 MiB default. The practical consequence is not "you cannot load a big model" — it is that
**weights must be sharded across many buffers and the shard size must be derived from
`adapter.limits` at runtime, not hard-coded.** A runtime that assumes desktop limits works on
the developer's machine and fails on the reviewer's laptop.

**Throughput — the arithmetic, not a benchmark.** At batch 1 a dense decoder reads
approximately its entire weight set per generated token, so the ceiling is
`tokens/s ≈ effective memory bandwidth ÷ resident weight bytes`. At `Q4_K_M` (≈ 4.8 bits per
weight) the resident bytes are ≈ 0.6 GB per billion parameters:

| Params | ≈ Q4_K_M bytes | Ceiling at 100 GB/s | Ceiling at 300 GB/s |
|---|---|---|---|
| 1 B | 0.6 GB | 165 tok/s | 500 tok/s |
| 3 B | 1.8 GB | 55 tok/s | 165 tok/s |
| 8 B | 4.9 GB | 20 tok/s | 61 tok/s |
| 14 B | 8.4 GB | 12 tok/s | 36 tok/s |

Published in-browser figures are consistent with the low end of that band once dispatch
overhead is taken out — the WebLLM paper states the engine "can retain up to 80% native
performance on the same device", and reported measurements put a 4-bit 8 B model in the
low-40s of tokens/second on high-end Apple silicon.
<!-- VERIFY: the specific reported figures (≈41 tok/s for a 4-bit 8B model, ≈71 tok/s for a ~3.8B model, both on an M3 Max) come from secondary write-ups, not from a first-party benchmark we have run. Measure on the target matrix before any of these appear in product copy. -->

**Use the arithmetic, not the anecdote.** The table above is a hardware ceiling and it is
honest; it tells an implementer that an 8 B model in a tab on a machine with 100 GB/s of
bandwidth will produce a 600-token proposal in roughly half a minute, which is a product
decision, not a tuning problem.

**Cold start.** Five components, and only two of them are ours:

| Component | Cost | Ours? |
|---|---|---|
| The user picks the weights file | seconds of human time, every session if storage is unavailable | no |
| Read + dequantise/repack shards | disk-bound; a 2 GB file at 1–2 GB/s is 1–2 s | partly |
| Upload to GPU | bus-bound; unified memory is much cheaper than discrete PCIe | no |
| WGSL shader compilation | per device *and driver*; browser-cached, not app-cached | no |
| Prefill of the system contract + tool schemas (≈ 2,000–3,500 tokens, 22 §2.5) | prefill is compute-bound, not bandwidth-bound; typically fast | ours |

<!-- VERIFY: measure total cold start (file pick → first token) on the target matrix. The shader-compilation component in particular varies by an order of magnitude across drivers and is invisible in every published benchmark, because benchmarks warm it. -->

**Storage, and the thing that kills this in the single-file build.** Caching multi-gigabyte
weights needs OPFS or the Cache API. Those are quota'd (Chrome allows an origin up to a large
fraction of free disk — currently documented at up to 80%) and, critically, **eviction-prone
unless `navigator.storage.persist()` has been granted.** Worse: a page loaded from a `file://`
URL has an *opaque* origin, and origin-partitioned storage is unavailable there. The offline
single-file artifact therefore **cannot cache weights at all** — the user re-picks the file
every session and pays full cold start every session.
<!-- VERIFY: confirm current behaviour of OPFS, IndexedDB and WebGPU adapter acquisition under a `file://` opaque origin in Chromium, Firefox and WebKit. IndexedDB is blocked; the other two need checking before the single-file story in §2.6 is finalised. -->

**Egress.** None, on one condition: **weights are loaded from a file the user selects, never
fetched.** 21 §7.2a already decided this. Fetching weights would put a model host in
`connect-src`, which is the one thing this tier exists to avoid. The cost is that the app can
never update the weights and the first-load experience is a file dialog.

**Verdict.** Good for the small end. `connect-src 'none'` survives. Model identity is
**verifiable** — we hash the bytes we were handed. Constrained decoding support depends on the
runtime and must be checked rather than assumed.
<!-- VERIFY: whether the chosen WebGPU runtime supports grammar- or JSON-Schema-constrained sampling, or only a post-hoc JSON mode. This determines whether 22 §2.6's repair loop runs on every call at this tier, which changes the cost model materially. -->

### 2.3 (b) WASM inference on CPU

The `wllama` lineage: llama.cpp compiled to WebAssembly, SIMD, no GPU. This is the runtime for
machines with no usable WebGPU adapter, for locked-down browsers, and for the case where the
GPU is busy doing something the user cares about more.

**Four hard constraints, all of them structural.**

| Constraint | Detail | Consequence |
|---|---|---|
| **`ArrayBuffer` size** | maximum single-file size ~2 GB; wllama's own guidance is to split models into chunks of at most 512 MB | Any model above ~3 B at Q4 must be sharded, and the sharding is the runtime's problem, not a packaging afterthought |
| **wasm32 address space** | 4 GiB, hard. `memory64` removes it but is still rolling out and carries a bounds-check performance penalty | Weights + KV cache + runtime must fit in 4 GiB. That is a ~3 B model at Q4 with a modest context, and not much more |
| **SIMD width** | WebAssembly SIMD is fixed 128-bit. There is no AVX2/AVX-512 path | Per-core throughput is materially below native llama.cpp on the same CPU, even before threading |
| **Threads need cross-origin isolation** | Multi-threaded WASM needs `SharedArrayBuffer`, which needs `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` — **response headers**, with no `<meta>` equivalent | The offline single file, served from `file://` with no server, **cannot set them, and is therefore single-threaded.** This is the single most important fact in this subsection |

**Throughput.** Same roofline as §2.2 but with CPU bandwidth (a modern laptop achieves
perhaps 20–50 GB/s in practice, far below the theoretical dual-channel figure) and a
compute-bound correction for SIMD128. A 1 B model at Q4 (0.6 GB) has a bandwidth ceiling
around 30–80 tok/s; realistic single-threaded WASM output is well below that.
<!-- VERIFY: measure wllama single-threaded and multi-threaded throughput for 0.5B / 1B / 3B at Q4_K_M on the target matrix. Do not publish a number that was not measured on our own build. -->

**Cold start.** Worse than WebGPU in one dimension and better in another: no GPU upload and no
shader compilation, but the model must be decompressed and laid out in the wasm heap, and on
`file://` there is no storage to cache it in.

**Verdict.** This is the **floor**, not a tier. It exists so that "no WebGPU" does not mean
"no assistance at all", and it can host exactly one class of job: classification and extraction
against a closed output schema, at ≤ 1 B parameters, with a context under about 4,000 tokens.
That covers S1 intake and nothing else in the catalogue. Recommending it for anything larger
would be dishonest about the 4 GiB ceiling.

### 2.4 (c) A local sidecar reached over loopback

`llama-server` (llama.cpp) or Ollama, running as a process on the user's machine.

**Vendor facts, checked rather than assumed** (July 2026):

| | `llama-server` | Ollama |
|---|---|---|
| Default bind | `127.0.0.1:8080` | `127.0.0.1:11434` |
| Auth | `--api-key` (comma-separated list) or `--api-key-file` | none built in <!-- VERIFY: confirm Ollama still ships without a first-party API-key/bearer mechanism; if one now exists, §3.7's preference for llama-server as the *bundled* sidecar weakens. --> |
| CORS default | `--cors-origins` defaults to **`*`** | allows `127.0.0.1` and `0.0.0.0` by default; widen via `OLLAMA_ORIGINS` |
| Browser-extension origins | via `--cors-origins` | documented: `chrome-extension://*`, `moz-extension://*`, `safari-web-extension://*` |
| Constrained decoding | `--grammar` (GBNF), `--json-schema`, and `response_format` on `/v1/chat/completions` | `format` accepts a JSON Schema on `/api/generate` and `/api/chat` |
| Determinism controls | seed and sampler params | `options.seed`, `options.temperature` |
| Model identity | model file path; hash it yourself | `/api/tags` and `/api/show` return `digest`, `family`, `parameter_size`, `quantization_level`, `modified_at` |
| Idle unload | server holds the model for its lifetime | `keep_alive`, default `"5m"` |

Four observations an implementer should not have to rediscover.

1. **`llama-server`'s CORS default is `*`.** Out of the box, *any* page in the user's browser
   can drive their local model. That is not a llama.cpp bug — it is a reasonable default for a
   tool intended to be driven by a local UI — but it means a design that tells users "just run
   llama-server" is a design that widens their attack surface and then benefits from it.
   §3 treats this as load-bearing.
2. **Ollama's `keep_alive` default of five minutes is a cold-start generator.** An engineer who
   asks a question, reads the answer, thinks for six minutes and asks a follow-up pays a full
   model load twice. If we do not own the process, we must at minimum set `keep_alive`
   explicitly and show the reload in the UI rather than letting it look like a hang.
3. **Ollama's `digest` is a genuine pin.** It is the strongest model identity available at any
   tier except "we hashed the file ourselves", and it is free. Record it.
4. **Both support schema-constrained decoding.** This is the only runtime family where 21
   §6.6's "malformed tool calls are structurally impossible" is available without qualification.

**Capability envelope.** With GPU offload, a sidecar comfortably runs 7–14 B at Q4 on an 8–16 GB
GPU and 24–32 B at Q4 on 24 GB, at throughputs governed by the same roofline as §2.2 but with
real VRAM bandwidth (hundreds of GB/s to over a terabyte). This is the first runtime where
S2-A residue binding and S6 interop are worth switching on at all.

**Cold start.** Process already running: model load only (seconds, dominated by reading the
GGUF into VRAM). Process not running: we must either start it or tell the user to. See §3.7 —
this is a large part of why the decision goes the way it does.

**Verdict.** Best capability-per-privacy ratio available. It is also the runtime that requires
this document's hardest decision, because reaching it from a page is a real loosening. §3.

### 2.5 (d) An enterprise-hosted endpoint inside the customer boundary

Tier 3 in 21 §7.4. An OpenAI-compatible endpoint on the customer's own infrastructure —
typically vLLM or SGLang behind a gateway, in their VPC, their datacentre, or their enclave.

From the application's perspective this is tier 1 with a different origin and a different trust
story: data leaves the browser but not the organisation. Everything in 21 §8 still applies —
projection, redaction, pre-flight, armed indicator, egress log — with an operator policy file
that may only tighten.

**The one property this tier has that no other tier has.** The operator controls the inference
server, which means the operator can run batch-invariant kernels (§4.1). **Tier 3 is the only
tier at which bitwise-reproducible sampling is even theoretically achievable.**

We do not build on that, for three reasons, and it is worth being explicit because it is
tempting:

| Reason | |
|---|---|
| We cannot verify it from the client | The endpoint asserts a model name. It does not attest to its kernels. `identity_confidence` stays `Advertised`. |
| It buys nothing the record does not already buy | §4.3's `AiValueRecord` makes the session auditable whether or not it is replayable. Replayability is a nice-to-have with no consumer. |
| A guarantee that holds at one tier and not the others is a guarantee nobody can state | The product would have to say "reproducible, if your administrator configured it that way". That sentence fails in review. |

**Capability envelope.** Whatever the customer runs, which in practice is the largest open-weight
model their hardware supports. This is the tier at which the full catalogue is viable.

**Cold start.** Effectively zero — the endpoint is warm. Latency is network plus queueing, and
queueing under multi-tenant load is exactly what §4.1's batch non-invariance is about.

### 2.6 Side by side

| | **(a) WebGPU in-page** | **(b) WASM CPU** | **(c) Loopback sidecar** | **(d) Enterprise endpoint** |
|---|---|---|---|---|
| Practical model size | 1–8 B at Q4; 8 B needs desktop-class limits and ≥ 8 GB GPU memory | ≤ ~3 B at Q4, hard-capped by wasm32's 4 GiB | 7–32 B at Q4 with GPU offload | whatever the operator runs |
| Resident footprint | 0.6 GB per B at Q4, sharded across buffers | same, inside a 4 GiB address space shared with everything else | same, in VRAM/RAM the OS manages | not ours |
| Throughput (batch 1) | roofline in §2.2; ≈ 80% of native at best | materially below native; SIMD128, often single-threaded | native | native, plus queueing |
| Cold start | file pick + read + upload + shader compile; **no caching under `file://`** | file pick + heap layout | model load, or nothing if warm; `keep_alive` matters | none |
| Constrained decoding | runtime-dependent — VERIFY | via llama.cpp's grammar support in the WASM build <!-- VERIFY: confirm wllama exposes GBNF grammars, not only free sampling. --> | **yes**, GBNF and JSON Schema | provider-dependent |
| Model identity | **Verified** (we hash the file) | **Verified** | **Verified** (hash) or **Advertised** (`/api/tags` digest) | **Advertised** |
| Egress | none | none | loopback only — §3 | one origin, consented, logged |
| Works in the offline single file | yes, degraded: no storage, no caching, re-pick every session | yes, degraded: single-threaded | **no. Never.** §3.5 | no |
| Requires the user to install something | no | no | yes | no (the operator did) |
| Reproducible sampling possible | no | no | in practice on one machine, one build, batch 1, fixed seed — §4.1 | theoretically, operator-dependent |

### 2.7 Which subagents are viable at which capability level

The catalogue's ids are from 22 §0. Capability bands are stated in parameters at Q4 because
that is what the runtime constrains; a band is not a promise about any specific model.

| Subagent | ≤ 1 B | 3–4 B | 7–14 B | 24 B+ / hosted | Why the floor is where it is |
|---|---|---|---|---|---|
| **S1** intake and triage | **viable** | good | good | good | Closed enum classification + concept selection, 6,000-token ceiling. The output space is small and the answer is in the context. |
| **S2-A** config comprehension (residue binding) | no | **poor — ship off** | fair | good | Needs vendor syntax knowledge that is *in the model*, not in the context. G5's round-trip gate makes small-model errors safe and makes the yield near zero. A gate that rejects 90% of proposals is not a feature. |
| **S3F** diagnostic fall-through advisor | marginal | **viable** | good | good | Orders ≤ 6 hypotheses it was handed and picks ≤ 3 commands the finder already returned. Closed sets both sides. |
| **S6** interop advisor | no | **no — off, not "poor"** | fair, gated | good, gated | Cross-vendor value-surface judgement. G6 turns weak output into a stream of discarded claims, and what survives is worse than the authored comparison table it replaced. |
| **S7** change-narrative writer | no | no | fair | fair | See below — this one does not become good at any size. |
| **S8** adversarial reviewer | no | no | only if ≥ the producer | good | An adversary weaker than the producer produces *false assurance*, which is worse than no adversary. This is a rule, not a preference. |
| **S5 / S9 / S10** (build time) | n/a | n/a | n/a | n/a | Run in CI on whatever the corpus maintainers provision. Not constrained by this document. |

**The general shape.** The jobs a small model does well are the jobs where **the answer is
already in the context and the model's job is to pick, order, extract or transcribe.** The jobs
it does badly are the jobs where **the answer is in the model.**

| Job shape | Concrete example in this product | Small model? |
|---|---|---|
| Classify into a closed enum | `TaskClass`, `GapKind`, `Underdetermination` | yes |
| Extract known surfaces from noisy text | pulling `NO_PROPOSAL_CHOSEN (P2)`, `INVALID_KE_PAYLOAD`, `TS_UNACCEPTABLE` out of pasted `show log kmd` output — the card's `ERROR DECODER` left column | yes |
| Rank a set that was already retrieved | S3F ordering; choosing among 8 finder hits | yes |
| Emit structured output against a schema | every subagent, given a grammar | yes |
| Map a paraphrase onto authored concepts | *"check if the tunnel is up"* → the concepts behind `show security ipsec security-associations` | yes |
| Multi-hop synthesis over ~14 nodes | *"P2 cycles, P1 solid"* across `IpsecVpn`, `IpsecPolicy`, `IpsecProposal`, selectors and the bound `st0` unit | **no** |
| Cross-vendor value-surface judgement | S6: *"the peer only offers `3des-cbc` and `group2` — what do I do"* | **no** |
| Prose at Teaching depth | S7 narrative; explainer bodies | **no — and not at any size** |
| Bind unfamiliar vendor syntax to the graph | S2-A residue on a platform the corpus barely covers | **no** |

The last row of the second table deserves its own sentence, because it is the one people argue
with. `.context/design-language.md` closes by saying the card's voice *"is achievable by a
human writing YAML"* and *"is not reliably achievable by a language model improvising at
runtime"*. That is a claim about the task, not about the parameter count. A bigger model writes
more fluent prose that still does not name the misdiagnosis it prevents, because naming the
misdiagnosis requires having watched somebody make it. **Scaling does not fix S7. Authoring
fixes S7.**

---

## 3. The localhost sidecar is a security decision

### 3.1 What is actually being asked

Fathom's offline artifact ships with `connect-src 'none'`. That single directive is most of the
security claim: an artifact you can read, whose policy says it cannot open a connection, cannot
open a connection. It is verifiable by a reviewer with a text editor and no trust in us.

Reaching a sidecar means writing `connect-src http://127.0.0.1:8080` into a build. That is not
a small edit to a config file. It changes the claim from *"this cannot talk to anything"* to
*"this can talk to one thing, and here is why you should believe that one thing is what you
think it is"*, and the second claim is much harder to defend.

So: analyse it properly, then decide.

### 3.2 CSP

| Directive | Offline single file | A loopback-capable build |
|---|---|---|
| `default-src` | `'none'` | `'none'` |
| `script-src` | `'sha256-…' 'wasm-unsafe-eval'` | same |
| `connect-src` | **`'none'`** | **`http://127.0.0.1:<port> http://[::1]:<port>`** |
| `img-src` | `'self' data:` | same |
| `form-action` / `base-uri` / `object-src` | `'none'` | same |
| `require-trusted-types-for` | `'script'` | same |

Three implementer notes.

- **`http://127.0.0.1:<port>` and `http://[::1]:<port>` are two distinct origins.** A policy
  naming only the v4 form breaks on a machine where the resolver or the runtime prefers v6.
  Both must be listed, which means the "exactly one origin" phrasing in the conventions is
  already imprecise — see §11.
- **The port must be in the policy.** `connect-src http://127.0.0.1` without a port permits
  every port on loopback, which is every local service the user runs. Pin it.
- **A `<meta>`-delivered CSP cannot express `frame-ancestors` or `report-uri`.** The single-file
  build already lives with that (21 §7.5). A loopback build is served, so it gets a real header
  and should use one.

### 3.3 Mixed content

An `https:` page issuing a request to `http://127.0.0.1` is **not** blocked as mixed content:
loopback is treated as a potentially trustworthy origin. That has been true for years and it is
why the pattern exists at all.

It is also no longer the whole story, because the exemption now interacts with how the browser
classifies the *target address space* before the request is made — see §3.4. An implementer who
reads only the mixed-content spec will conclude this works and be wrong in Chromium 142+.

### 3.4 Local Network Access — the change that moves this decision

Chromium previously experimented with **Private Network Access (PNA)**, which required a CORS
preflight in which the *target device* opted in. PNA was put on hold. It has been replaced by
**Local Network Access (LNA)**, which gates the whole class behind a **user permission prompt**.

The facts that matter here:

| | |
|---|---|
| What triggers it | A request from the **public** address space to a **local network or loopback** destination. Loopback is explicitly in scope — `127.0.0.0/8` and `::1`, alongside RFC 1918 ranges, link-local and IPv6 ULAs. |
| Ship vehicle | Enabled for opt-in testing behind `chrome://flags#local-network-access-check` from Chrome 138; the permission prompt launching in **Chrome 142**. <!-- VERIFY: pin the exact stable milestone and the current enterprise-policy names before shipping anything that depends on this. Reporting on the 141/142 boundary is inconsistent. --> |
| Developer-side control | The fetch option `targetAddressSpace: "local"`, which declares the intent up front and carries the mixed-content exemption with it. |
| Denial | A denied permission is a user decision that persists for the origin. There is no second bite. |
| Enterprise | This is exactly the kind of permission a managed-browser policy blocks wholesale. |

**Read that table as a product risk, not a compatibility note.** A design in which a
Fathom page hosted at `https://fathom.example` reaches the user's sidecar depends on:

1. a permission prompt whose wording we do not write,
2. shown at a moment we do not choose,
3. whose denial is sticky,
4. which the user's IT department may have disabled before they ever saw it,
5. describing an action ("this site wants to access devices on your local network") that a
   security-conscious network engineer — which is precisely our user — is **correctly trained
   to deny.**

That last point is not ironic, it is fatal. Our best users will say no, and they will be right.

**One important sub-case.** LNA gates *public → local*. A page **served from loopback** is
already in the local address space, so a loopback-to-loopback request should not be gated at
all. If that holds, the loopback build flavour in §3.7 sidesteps the prompt entirely, which is
a large part of why it survives as the secondary answer.
<!-- VERIFY: confirm that a page served from http://127.0.0.1:<a> fetching http://127.0.0.1:<b> is not subject to the LNA permission prompt in Chromium 142+, and check WebKit's and Gecko's positions. This single behaviour determines whether the loopback build flavour needs a permission grant. -->

### 3.5 DNS rebinding against a local inference server

This is not a hypothetical for this class of software. It has already happened, to the exact
product we would be recommending.

> **CVE-2024-28224 — Ollama, versions prior to v0.1.29.** A DNS rebinding attack allowed a
> malicious web page to bypass the browser's same-origin policy and reach the local Ollama API
> without authorisation — chatting with models, deleting models, causing denial of service,
> and exfiltrating file data readable by the Ollama process. The fix was **HTTP `Host` header
> validation**, restricting accepted values to authorised ones such as `localhost` and
> `127.0.0.1`.

The mechanism, stated plainly, because the mitigation only makes sense once it is:

```
1. user visits evil.example
2. evil.example resolves to the attacker's server, TTL ≈ 1 s
3. the page is served, and begins polling http://evil.example/...
4. the DNS record is re-pointed to 127.0.0.1
5. the browser re-resolves; the page's ORIGIN is still evil.example,
   so the same-origin policy is satisfied, but the CONNECTION goes to loopback
6. the request arrives at the local service carrying  Host: evil.example
```

Two defences, and only two:

| Defence | Held by | Effective? |
|---|---|---|
| The service validates the `Host` header against an allowlist | **the sidecar** | Yes, completely. Step 6 fails. |
| The service requires an auth token the attacker does not have | **the sidecar** | Yes, completely. |
| The browser's CORS policy | the browser | **No.** Rebinding does not violate the same-origin policy; it satisfies it. |
| Our CSP | us | **No.** Our `connect-src` constrains *our* page. It says nothing about `evil.example`. |

**Both effective defences live in software we do not ship and cannot require.** A user running
an old Ollama, or a `llama-server` started with the default `--cors-origins *` and no
`--api-key`, is exposed regardless of how carefully Fathom is written. And if our documentation
is the reason that sidecar is running, we own a share of that.

### 3.6 The four candidate shapes

| | **A · hosted page → user's sidecar** | **B · browser extension** | **C · native shell (Tauri)** | **D · loopback-only build flavour** |
|---|---|---|---|---|
| Page origin | `https://fathom.example` | `chrome-extension://<id>` | not a web origin; the shell's webview | `http://127.0.0.1:<a>` (our tiny static server) |
| `connect-src` change needed | yes — a remote origin gains loopback reach | yes, in the extension's own CSP | **none. `'none'` survives** | yes — two loopback origins |
| LNA prompt | **yes**, and denial is sticky | extension origins are handled differently <!-- VERIFY: confirm LNA's treatment of extension-origin requests to loopback in Chromium 142+. --> | not applicable — no browser request | probably not (§3.4 VERIFY) |
| Mixed content | exempt, but via the moving `targetAddressSpace` path | n/a | n/a | n/a (http → http) |
| Sidecar CORS config the user must do | must add our remote origin; path of least resistance is `*` | Ollama documents `chrome-extension://*` — which allows **every** extension | **none — we own the process** | must add our loopback origin |
| DNS rebinding exposure | full (§3.5), and we caused the sidecar to exist | full | **none — no DNS, no browser transport** | full, but only against a sidecar the user chose to run |
| Who starts the sidecar | the user, by hand | the user, by hand | **we do**, as a child process | the user, by hand |
| Model identity | `Advertised` (whatever the sidecar says) | `Advertised` | **`Verified` — we hash the weights we hand it** | `Advertised`, or `Verified` if the user points us at the file |
| Cross-origin isolation (COOP/COEP) for WASM threads | possible | possible | **yes** | **yes** — this is why the flavour is served rather than `file://` |
| New distributable | none | one per store, per browser | one per OS, signed and notarised | one archive |
| Update channel we control | yes | **no — store review** | yes | yes |
| Offline single file unaffected | yes | yes | yes | yes |

### 3.7 DECISION

**DECISION — the primary answer is a native shell that owns the sidecar as a child process
(shape C). A served loopback-only build flavour (shape D) is supported and documented as the
secondary. Shape A is rejected outright. Shape B is not built, but is the named fallback if C
slips.**

The reasoning, in the order that decided it.

**1. Shape C is the only shape in which `connect-src 'none'` survives.** The webview never
makes the request. The inference call is an IPC command from the page to the shell; the shell
holds the transport. The page's policy is unchanged from the offline artifact's, and the
security claim that took the most work to earn does not have to be renegotiated. Every other
shape trades that claim for capability.

**2. Shape C removes both DNS-rebinding defences from the user's hands and puts them in ours.**
We bind an ephemeral loopback port, we generate a per-launch bearer token, we set the CORS
allowlist to exactly one origin, and none of that is a documentation step the user can skip.

**3. Shape C is the only shape with `IdentityConfidence::Verified` for free.** We read the
weights file, we hash it, we start the process pointing at it. §7 is materially cheaper.

**4. Shape A fails on its users, not on its engineering.** §3.4: a network engineer shown
"this site wants to access devices on your local network" will deny it, and should. Designing a
core capability behind a prompt our own audience is trained to refuse is designing a feature
that does not ship.

**5. Shape A makes us the reason a user widens their sidecar's CORS.** The instruction
"set `OLLAMA_ORIGINS=https://fathom.example`" is one copy-paste away from
"set `OLLAMA_ORIGINS=*`", and `llama-server`'s default is already `*`. We would be writing
documentation whose most likely misreading turns the user's local model into an open service.

The concrete shape of C:

```rust
/// Owned entirely by the native shell. The webview never sees any field of this
/// type — not the port, not the token, not the path. 21 §6.1 principle 6:
/// "the model never sees a URL, a path, or a hostname it could act on", and
/// neither does the page.
pub struct SidecarLaunch {
    /// Bundled binary, pinned by version and hash, or a user-nominated one.
    pub binary: SidecarBinary,
    /// The weights file the user selected. Hashed before launch; the hash
    /// becomes ModelPin.weights_digest with IdentityConfidence::Verified.
    pub weights: PathBuf,
    pub weights_digest: Blake3,
    /// bind("127.0.0.1:0") and read back the assigned port. Never a fixed port:
    /// a well-known port is discoverable by anything on the machine.
    pub port: u16,
    /// 32 bytes from the OS CSPRNG, regenerated on every launch, never
    /// persisted, passed to the child via --api-key-file on a 0600 temp file
    /// rather than argv (argv is world-readable in /proc on Linux).
    pub token: Secret<[u8; 32]>,
    /// Exactly one origin: the shell's own webview origin. Never `*`.
    pub cors_origin: OriginRef,
    /// We own the process, so idle-unload policy is ours, not `keep_alive`'s.
    pub idle_unload: Option<Duration>,
}
```

Launch invariants, each one enforced in code and covered by a test that starts a real child
process and asserts the negative:

| # | Invariant | Test |
|---|---|---|
| 1 | The child is bound to `127.0.0.1` only, never `0.0.0.0` | connect from a second interface; expect refusal |
| 2 | An unauthenticated request to the port is refused | `curl` without the token; expect 401 |
| 3 | A request with `Origin: https://evil.example` is refused | expect a CORS rejection, not a 200 |
| 4 | A request with `Host: evil.example` is refused | the rebinding case; expect refusal |
| 5 | The child dies with the shell, including on SIGKILL of the parent | orphan check after `kill -9` |
| 6 | The token is not in `argv`, not in the environment of any other process, and not on disk after exit | inspect `/proc`, inspect the temp dir |
| 7 | The webview's CSP is byte-identical to the offline artifact's | string compare in CI |

Invariant 7 is the one to defend in review. It is the whole argument for shape C reduced to a
CI assertion.

### 3.8 What this decision costs

State it plainly; it is not cheap.

| Cost | Size |
|---|---|
| **A new distributable per OS**, code-signed and notarised, with its own update channel | This is a real, ongoing engineering and release burden, and it is the first artifact in this project that is a binary rather than a bundle. The reproducible-build story (§7.7 of the brief) now has to cover it. |
| **We ship someone else's CVE surface** | Bundling `llama-server` means its advisories are ours. Mitigation: pin the version, publish its hash beside ours, and subscribe to its security channel. There is no mitigation for the residual risk, only ownership of it. |
| **The users who most need this cannot install it** | Locked-down enterprise desktops, air-gapped enclaves, OT environments — §2.4 of the brief's own target market — often cannot install a signed desktop app either. **The shape we chose for security reasons is the one the most security-constrained users cannot run.** Their answer is tier 0, which is the whole product, and we should say that rather than pretending the shell is universal. |
| **Shape D still needs the sidecar's CORS configured by hand** | The secondary path retains the documentation risk of §3.7 point 5, in smaller form. Mitigation: the loopback flavour ships a setup checker that makes an intentionally-wrong-origin request and refuses to proceed if the sidecar answers it. |
| **We lose the "just open the web app" on-ramp for local inference** | Correct and painful. The command finder (§6.1 of the brief) remains a zero-install browser page, and it is the on-ramp; local inference is not, and should not pretend to be. |

**And the boundary this decision draws, permanently:**

> **The offline single-file build never reaches a sidecar. `connect-src` in that artifact is
> `'none'` and no setting, flag, or build option changes it. If you need a local model, you
> need the shell or the loopback flavour, both of which are separate artifacts with separate
> hashes and separate release notes.**

---

## 4. Determinism

### 4.1 Why temperature 0 is not determinism

The belief that `temperature = 0` yields reproducible output is the single most common wrong
assumption in this problem space, and building on it would put a false claim in a security
document. Five independent reasons it fails, in descending order of how much they matter here.

**1 · Batch non-invariance — the big one.** Many inference kernels (matmul, RMSNorm, attention)
produce numerically different results for the *same* sample depending on the **batch size** of
the operation, because the reduction order changes and floating-point addition is not
associative. Batch size is a function of concurrent server load, which from the client's
perspective is random. Thinking Machines Lab reported sampling 1,000 completions at
temperature 0 from a 235 B model and getting **80 distinct outputs, diverging at token 103**,
and showed that swapping in batch-invariant kernels produced bitwise-identical results across
runs. Their `batch-invariant-ops` work has been picked up by serving stacks.
<!-- VERIFY: confirm the current state of batch-invariant kernel support in vLLM and SGLang before asserting it in an enterprise review pack. -->

This is decisive for tiers 1 and 3: **you cannot get determinism from an endpoint whose queue
you do not control**, no matter what sampling parameters you send.

**2 · Kernel non-determinism at fixed batch.** Atomics, split-k reductions and autotuned kernel
selection vary with device, driver and library version. The same model and the same batch on
two GPUs is not the same arithmetic.

**3 · The model changes behind a stable name.** Providers rotate weights behind floating
aliases. §7 is about this.

**4 · Runtime and quantisation drift.** A new llama.cpp changes a quant format, a sampler
default, or a rope implementation, and the same GGUF file produces different tokens on the same
machine. The weights are pinned; the arithmetic is not.

**5 · Template and tokeniser drift.** The chat template ships alongside the weights and gets
corrected. A corrected template renders the same typed inputs into a different prompt string.
The model did not change; the input did.

**What is achievable, stated honestly.** At the sidecar tier, on **one machine**, with **one
build**, at **batch 1**, with a **fixed seed**, run-to-run identity is achievable in practice.
It does not survive a different machine, a different backend, a different thread count or a
runtime upgrade.
<!-- VERIFY: confirm llama.cpp's current position on cross-backend and cross-thread-count reproducibility before quoting the "one machine, one build, batch 1" claim as vendor-supported rather than as our own observation. -->

**DECISION — we set `temperature = 0` and a fixed seed anyway, and we describe them as variance
reduction, never as reproducibility.** Lower variance is worth having: it reduces the rate at
which the same question produces a differently-shaped proposal and makes the cache in §5 hit
more often. It is not a guarantee and no user-facing string may imply that it is.

### 4.2 The guarantee, restated to exclude AI-touched values

Invariant 9 says: same workspace + same corpus version + same build ⇒ byte-identical emitted
config, byte-identical findings, identical finder ranking.

The AI layer does not weaken it, because R1 keeps the model out of the artifact path and 21
§2.5.1 turns every accepted proposal into an ordinary human-asserted field value. That argument
is made in 21 §9.1 and is not repeated here. What this document adds is the **statement of the
exclusion**, in the exact words that go into the product and the review pack, because a claim
that is only true when correctly interpreted will be incorrectly interpreted:

> **What is reproducible:** everything the workspace contains. Given the same workspace file,
> the same corpus version, the same rule-pack versions and the same build, Fathom emits the
> same config bytes, raises the same findings in the same order, and ranks the finder the same
> way. This holds whether or not a model was ever used, and whether or not one is installed
> now.
>
> **What is not reproducible:** how any particular value came to be in the workspace. A value a
> model proposed and a human accepted is reproducible — it is a value in a file. The proposing
> is not. We do not offer session replay, we do not offer "regenerate that proposal", and we do
> not claim that a recorded call would reproduce, because it would not.
>
> **What is recorded instead:** for every field a model ever touched — the model's identity,
> the runtime it ran in, a hash of exactly what it was asked, its output, the citations it
> relied on, the human who accepted it, and when. That record is inside your workspace, it is
> encrypted with your key, and reading it requires neither a model nor a network.

Note the sentence *"this holds whether or not a model is installed now"*. That is the property
that makes the whole boundary worth its cost, and it is checkable — §4.5.

### 4.3 What is recorded, per AI-touched value

21 §9.3 stores sessions, proposals and egress records. That is the raw material. What a reviewer
needs is a **field-keyed index over it** that answers one question in one lookup: *did a model
touch this value, and what do I need to know about that?*

```rust
/// `fathom:aivalue:<ulid>`. Written on accept, never mutated, never deleted
/// while the field it references exists. One per (field, acceptance) pair —
/// a field accepted twice from two proposals has two records, ordered.
pub struct AiValueRecord {
    pub id: AiValueId,
    pub field: FieldRef,                    // (NodeId, FieldId) — stable IDs, per invariant 7

    // ── what was proposed, and what was kept ──────────────────────────────
    /// The value the model proposed.
    pub proposed: PresenceRepr,
    /// The value the human accepted. Differs from `proposed` iff `amended`.
    pub accepted: PresenceRepr,
    pub amended: bool,

    // ── who proposed it ───────────────────────────────────────────────────
    pub proposal: ProposalId,
    pub session: AiSessionId,
    pub subagent: Option<SubagentId>,
    pub basis: Basis,                       // Cited | SanctionedException | Judgement
    pub citations: SmallVec<[CorpusRef; 4]>, // each carries a content_hash — 21 §2.3.3

    // ── what produced it ──────────────────────────────────────────────────
    pub model: ModelPin,
    pub runtime: RuntimePin,
    pub prompt: PromptDigest,
    pub output_digest: Blake3,
    /// The raw structured output. Retained by default; downgraded to a digest
    /// under the same eviction ledger as the egress log (21 §8.6).
    pub output: RecordBody,

    // ── the world it was produced in ──────────────────────────────────────
    pub corpus_version: CorpusVersion,
    pub pack_versions: SmallVec<[(PackId, PackVersion); 4]>,
    pub engine_version: EngineVersion,

    // ── who accepted it ───────────────────────────────────────────────────
    pub reviewer: UserId,
    pub reviewed_at: Timestamp,
    /// Required when `basis == Judgement` or when the op was a DraftSuppression
    /// (21 §2.5.1). A model may not write this field, ever.
    pub review_note: Option<Text>,
    /// True when the proposal card's emit preview was expanded before accept.
    /// This is the input to `blind_accept_rate` (21 §3.4).
    pub preview_expanded: bool,
}

pub enum RecordBody { Retained(Bytes), Evicted { digest: Blake3, bytes: u32 } }
```

#### 4.3.1 `ModelPin` — defined here, referenced by 21 §4.10

```rust
pub struct ModelPin {
    /// What the endpoint or file calls itself, verbatim, unparsed, untrimmed.
    /// Recording the provider's own string is the point; normalising it loses
    /// the evidence.
    pub advertised: BoundedText<128>,
    /// Present when we hashed the weights ourselves (WebGPU, WASM, shell-owned
    /// sidecar) or when the sidecar reports a content digest (Ollama /api/tags).
    pub weights_digest: Option<WeightsDigest>,
    pub parameter_size: Option<BoundedText<16>>,     // "7.6B"
    pub quantisation: Option<BoundedText<16>>,       // "Q4_K_M"
    pub sampling: SamplingPin,
    pub observed_at: Timestamp,
    pub identity_confidence: IdentityConfidence,
}

pub enum WeightsDigest {
    /// We read the bytes and hashed them. The strongest form.
    Ours(Blake3),
    /// The sidecar told us. Recorded with its scheme so it can be compared
    /// later against the same scheme, and never against a different one.
    Vendor { scheme: BoundedText<16>, value: BoundedText<80> },
}

pub enum IdentityConfidence {
    /// We hashed the weights. A change is detectable with certainty.
    Verified,
    /// The endpoint asserted an identity. A change is detectable only if the
    /// endpoint chooses to tell us.
    Advertised,
    /// Neither. The endpoint returned no usable identity at all. The AI layer
    /// refuses to run — see §7.2.
    Unknown,
}

pub struct RuntimePin {
    pub kind: RuntimeKind,                  // WebGpu | WasmCpu | Sidecar | Endpoint
    pub version: BoundedText<64>,           // llama.cpp build, runtime version, gateway version
    /// Hash of the chat template / prompt rendering in force. Changing this
    /// changes the model's input without changing the model. §4.1 reason 5.
    pub template_hash: Option<Blake3>,
    pub constrained_decoding: ConstrainedDecoding,
}

pub struct SamplingPin {
    /// f32 has no Ord/Hash. Use an ordered wrapper with a canonical bit
    /// representation, or this type cannot be a cache key component (§5.1).
    pub temperature: OrderedF32,
    pub top_p: OrderedF32,
    pub top_k: Option<u32>,
    pub seed: Option<u64>,
    pub max_output_tokens: u32,
    pub repeat_penalty: Option<OrderedF32>,
}

pub enum ConstrainedDecoding {
    Grammar(Blake3),        // GBNF source hash
    JsonSchema(Blake3),     // schema hash
    None,                   // 22 §2.6's repair loop is live on every call
}
```

`identity_confidence` is the honest field and it does real work. At the shell-owned sidecar we
hashed the file, so it is `Verified`. At an enterprise endpoint the gateway asserts a name, so
it is `Advertised`. §7.4 branches on this value.

#### 4.3.2 `PromptDigest` — five hashes, not one

```rust
pub struct PromptDigest {
    /// "fathom.prompt.v1". Bumped whenever canonicalisation changes, which
    /// invalidates every cache key — deliberately, and cheaply.
    pub scheme: &'static str,
    pub system_hash: Blake3,     // the pinned system contract (21 §4.9)
    pub tools_hash: Blake3,      // the tool-schema bundle for this subagent's grant
    pub frame_hash: Blake3,      // the typed task frame, canonicalised — §5.2
    pub context_hash: Blake3,    // the ordered tool results, canonicalised
    pub sampling_hash: Blake3,
    /// BLAKE3 over the five above, in declaration order, length-prefixed.
    pub combined: Blake3,
}
```

Five components rather than one costs 160 bytes and buys diagnosis. Two sessions whose
`combined` differs are uninformative. Two sessions that differ **only** in `context_hash` tell
you the corpus or the graph moved; differing **only** in `system_hash` tells you we shipped a
new contract; differing **only** in `sampling_hash` tells you somebody changed a slider. That
is the difference between an audit log and a debuggable audit log.

**The digest is over the canonical *typed* form, not the rendered prompt string.** Rendering is
runtime-dependent (§4.1 reason 5); the typed frame is ours. The rendered form is covered
separately by `RuntimePin.template_hash`, and the cache key (§5.1) includes both — because
provenance wants to know *what we asked* and the cache needs to know *what the model saw*.

### 4.4 Replay and audit without re-running the model

**DECISION — the audit reader is a separate crate that must not depend on `fathom-ai`, and CI
fails on the reversed edge.** This is the same crate-level control 21 §2.1 uses for R1, applied
to a second boundary, for the same reason: a dependency rule is the cheapest enforcement in the
whole design.

```
fathom-core    ── graph, corpus, rules, emitters, finder, crypto, workspace codec
fathom-audit   ── depends on fathom-core ONLY. Reads sessions, proposals,
                  AiValueRecords, egress records, the cache index.
fathom-ai      ── depends on fathom-core. NOTHING depends on fathom-ai.
fathom-verify  ── binary. Links fathom-core + fathom-audit. Never fathom-ai.
```

What a reviewer can do with no model, no network and no runtime installed:

```text
$ fathom audit --workspace site-b.fathom --ai-touched

  A I - A S S I S T E D   V A L U E S                                  7 fields
  workspace site-b.fathom · corpus 4.2.1 · packs ipsec-core 2.9.0

  fathom:ikeproposal:01JZ…  IKE-P1.dh_group          group14
    accepted   j.okonkwo · 2026-02-11 · unamended · preview expanded
    proposed   constraint.negotiator · session 01JZ8… · basis SanctionedException
    cited      explain:rule:ipsec.pfs.absent#acceptable_when @4.2.1
               blake3:c1a8…  ── CITATION CHANGED at corpus 4.4.0   [ diff ]
    model      "<advertised>" · Advertised · sampling t=0 seed=7
    prompt     fathom.prompt.v1 · combined blake3:9f21…

  fathom:ikegateway:01JZ…   GW-B.dead_peer_detection  always-send 10 × 3
    accepted   j.okonkwo · 2026-02-11 · AMENDED (proposed 10 × 5)
    …
```

Three properties of that output that are worth the machinery:

1. **It is a projection of the workspace, not a query against a service.** It works in an
   air-gapped enclave six months after the vendor of the model in question ceased to exist.
2. **The `CITATION CHANGED` line is the payoff of `CorpusRef.content_hash` (21 §2.3.3).** The
   reviewer learns not only what was cited but that what was cited has since moved, which is
   the case the hash exists for.
3. **`AMENDED (proposed 10 × 5)` preserves the human's correction.** In the card's terms: the
   model proposed the Junos default of `interval 10 threshold 5` — 50 seconds of blackhole
   before failover even starts — and the engineer tightened it to the card's `10 × 3`
   "reasonable middle". The record shows a human made that call. That is exactly the fact a
   reviewer wants and exactly the fact a system that only stored the final value would lose.

### 4.5 The no-AI verification pass

The command:

```text
$ fathom verify --workspace site-b.fathom \
                --ticket CHG-2026-0211.yaml \
                --no-ai --strict
```

`fathom verify` is built from `fathom-verify`, which does not link `fathom-ai`. `--no-ai` is
therefore redundant and is accepted anyway, because a flag that documents an invariant in the
command line a reviewer pastes into a ticket is worth its parsing cost.

**Nine steps, numbered as content, in the card's idiom.** Unlike the card's bring-up order,
this ladder **does not stop at the first failure** — it runs every step and reports all of
them, because a verification pass exists to produce a complete report for a change reviewer,
not to guide someone standing at a console. That difference is deliberate and worth naming.

```text
#1  workspace integrity    AEAD tag, workspace content hash
#2  no-AI assertion        fathom-ai symbol table absent from this binary
#3  version pinning        corpus 4.2.1, ipsec-core 2.9.0, engine 0.7.3, schema 3
                           present locally, exact match, NO silent substitution
#4  re-emit                84 lines, per device, per platform → byte compare
#5  re-lint                7 findings → canonical serialisation compare
#6  re-rank                41 canonical finder queries → ordering compare
#7  re-diff                the ticket's change set → recompute → compare
#8  AI-value recheck       every AiValueRecord: citations resolve, hashes match,
                           SanctionedException still sanctioned by a live rule
#9  cache independence     drop the response cache, redo #4–#7 → identical
```

Specification of the comparisons, because "the same findings" is ambiguous and the ambiguity is
where a false green comes from:

| Step | Compared how | Failure severity |
|---|---|---|
| #4 | Byte-for-byte over the emitted line text, in emitter order, per `(device, platform)`. Provenance is compared structurally (node ID, field IDs, rule IDs, `Risk`) but not by memory layout. | **E** — a mismatch is an engine bug or an undeclared build difference |
| #5 | Canonical serialisation of the finding set in the rule engine's own total order (`12-rule-engine` §9.4), using the deterministic findings-export dialect (`12-rule-engine` §10.4). Includes `Risk` on any attached remediation, severity, anchor node ID, and the witness tuples. | **E** |
| #6 | The full ranking, not the top-k. A reordering below the fold is still a determinism failure and hiding it makes the check weaker than it looks. | **E** |
| #7 | The recomputed change set against the ticket's recorded one, including the verification ladder and the rollback availability verdict. | **E** |
| #8 | Per record: every `CorpusRef` resolves in the pinned corpus; `content_hash` matches; if `basis == SanctionedException { rule }` the rule still exists, still applies to that node's kind and platform, and its `acceptable_when` is still non-empty. | **W** — this is a *staleness* signal, not a determinism failure |
| #9 | Steps #4–#7 rerun with `--drop-cache`. | **E** — a difference means the cache leaked into the artifact path, which is R1 violated |

Output, in the card's grammar:

```text
─ 1px rule ─────────────────────────────────────────────────────────────────
  V E R I F I C A T I O N   P A S S                              no model
  site-b.fathom · CHG-2026-0211 · 2026-07-28T09:14:02Z
─ 1px hairline ─────────────────────────────────────────────────────────────
  #1 workspace integrity                                              OK
  #2 no-AI assertion            fathom-ai not linked                  OK
  #3 version pinning            corpus 4.2.1 · ipsec-core 2.9.0       OK
  #4 re-emit                    84 lines · 3 devices                  IDENTICAL
  #5 re-lint                    7 findings                            IDENTICAL
  #6 re-rank                    41 queries                            IDENTICAL
  #7 re-diff                    18 ops · rollback PARTIAL             IDENTICAL
  #8 AI-value recheck           7 records                             1 STALE
     ▌ IKE-P1.dh_group — cited explain:rule:ipsec.pfs.absent
       #acceptable_when at 4.2.1; text changed at 4.4.0.
       The accepted value is unchanged and still emits identically.
       This is a citation-drift notice, not a determinism failure.
  #9 cache independence         --drop-cache                          IDENTICAL
─ 1px rule ─────────────────────────────────────────────────────────────────
  DETERMINISM OK · 1 STALE CITATION            exit 0 (exit 2 with --strict)
```

Exit codes: `0` clean, `1` a determinism failure (#4–#7, #9), `2` staleness only (#8) when
`--strict` is set, `3` the workspace or its pins could not be loaded.

### 4.6 What the verification pass cannot prove — say this out loud

**It proves the engines agree with themselves. It does not prove the value is right.**

A wrong `dead-peer-detection interval 3 threshold 2` that a human accepted emits identically on
every machine, forever, and passes every step above. The card's own line applies exactly:
*"Too tight and a two-second underlay hiccup tears down a healthy tunnel — you then spend a
week debugging self-inflicted flaps."* Determinism will not tell you that. The rule engine
might, if somebody wrote the rule; the `acceptable_when` field might, if somebody wrote it;
the human review gate is the actual defence and it is a human one.

Three other honest limits:

| Limit | |
|---|---|
| Step #4–#7 compare against snapshots stored **in the same workspace** | Someone who can edit the workspace can edit the snapshots. The defence is that the change ticket's hashes are exported and, in the sync build, signed at export — so the ticket in the change-management system is the independent copy. A verification pass run only against the workspace proves internal consistency, not integrity. |
| Step #2 is a link-time assertion, not a runtime one | It proves this binary cannot call a model. It does not prove the *value* in the workspace was not produced by one — that is what §4.3's record is for, and the two checks are complementary rather than redundant. |
| A missing `AiValueRecord` is invisible | If a value was model-proposed and the record was never written, nothing detects it. The defence is that `Workspace::apply_proposal` writes the record in the same transaction as the field; there is no code path that writes one without the other. That is a code-review property, not a verification-pass property, and it should be tested by a fixture that tries. |

---

## 5. Caching and pinning

### 5.1 The key

The assignment's triple — model id, prompt hash, corpus version — is the **minimum**. Each
addition below is justified by a specific way the triple serves a wrong answer.

```rust
/// Content-addressed. The entry's identifier IS the hash of this struct's
/// canonical CBOR (RFC 8949 §4.2.1 deterministic encoding). There is no ULID
/// here on purpose: a ULID is monotonic in time and would make every key unique.
pub struct ResponseCacheKey {
    pub scheme: u8,                  // 1. Bumped on any canonicalisation change.
    pub subagent: SubagentId,
    /// Hash over ModelPin's IDENTITY-bearing fields only: advertised name,
    /// weights_digest, parameter_size, quantisation. NOT observed_at, NOT
    /// identity_confidence.
    pub model_identity: Blake3,
    /// PromptDigest.combined — what we asked, semantically.
    pub prompt: Blake3,
    /// RuntimePin.template_hash + runtime version — what the model actually saw.
    pub render: Blake3,
    pub sampling: SamplingPin,
    pub corpus: CorpusVersion,
    pub packs: PackVersionSet,       // sorted, deduplicated, canonical
    /// Hash of the output JSON Schema in force for this subagent.
    pub out_schema: Blake3,
    /// Hash of the Rust type definitions the frame was serialised from,
    /// generated by the derive macro. §8, failure 2.
    pub frame_schema: Blake3,
}
```

| Component | What breaks without it |
|---|---|
| `model_identity` | A model swap serves the old model's answers forever. This is also the mechanism that makes §7.4's response to drift automatic: change the model, and every cached answer becomes unreachable rather than stale. |
| `prompt` | Obvious. |
| `render` | A runtime upgrade that corrects a chat template silently serves entries produced under a different prompt rendering. The typed inputs are identical; the model's input is not. |
| `sampling` | A user who raises temperature to explore alternatives is served the temperature-0 answer and concludes the slider does nothing. |
| `corpus` | The assignment's third element. A corpus correction must not be masked by a cached answer that quoted the old text. |
| `packs` | Rule packs version separately from the corpus (conventions §Identifiers). A pack upgrade can change an `acceptable_when` that a cached proposal's `Basis::SanctionedException` depends on. Omitting this is the subtlest correctness bug available here. |
| `out_schema` | A schema change means the cached output no longer validates, and the read path either throws or — worse — coerces. |
| `frame_schema` | Adding a field to the task frame without changing the key means two semantically different frames hash the same. §8, failure 2. |
| `subagent` | Two subagents can be handed identical frames with different grants and different contracts. |

### 5.2 Canonicalisation — the part that is actually hard

The key is only as good as the canonical form the hashes are taken over. Requirements:

**1 · Deterministic encoding.** Canonical CBOR per RFC 8949 §4.2.1: definite-length items,
integers in shortest form, map keys sorted by their encoded bytes. Not JSON — JSON has no
canonical form that survives a serialiser change.

**2 · Nothing time-varying in the hashed region.** No timestamps, no wall clock, no session ID,
no `observed_at`. This is easy to get wrong because `ModelPin` legitimately carries
`observed_at` for the audit record; the key hashes a *subset*, and the subset must be produced
by an explicit function rather than by serialising the struct.

**3 · No raw node IDs.** Node IDs are ULIDs (conventions §Identifiers) — monotonic in time,
unique per workspace. Hashing them means two engineers asking the identical question about
structurally identical tunnels never share a cache entry, which defeats the point.

**DECISION — the frame is canonicalised by replacing node IDs with frame-local ordinals derived
from a deterministic traversal, and the model's output is re-bound to real IDs on retrieval
using the `OpRef`/`TempId` machinery that already exists for this exact purpose (21 §2.3).**

The traversal:

```text
1. Sort roots by (kind ordinal, then the canonical encoding of the node's
   identity fields).                                   O(r log r)
2. Breadth-first from each root, visiting edges in (edge-role ordinal,
   then target kind ordinal, then target identity encoding) order.  O(n + e)
3. Assign ordinals 0..n in visit order.
4. Rewrite every NodeId in the frame to its ordinal.   O(n + e)
5. Drop fields whose Presence is Unknown *only if* the subagent's contract
   says Unknown is not distinguishable for it. Otherwise keep — the four-state
   Presence model (11-ir-schema §5) is load-bearing and collapsing it here
   would produce cache hits across genuinely different graphs.
```

Complexity `O(n log n + e)` on the projection, and projections are bounded: `graph.query`
returns at most 64 nodes (22 §2.3) and the natural IPsec working set is ~14 nodes. This is
microseconds. The hard part is not the cost, it is the discipline: **every field that can
change the answer must be in the canonical form, and every field that cannot must not be.**
Getting the second half wrong costs hit rate. Getting the first half wrong serves wrong answers.

**4 · Pseudonymisation must not poison the key.** 21 §8.2.1 derives the pseudonym map per
*session* from the workspace key, and discards it when the session ends. If the key were
computed over pseudonymised values, every session would produce a fresh key and the cache would
never hit.

**DECISION — the cache key is computed over the pre-pseudonymisation canonical frame, and
pseudonymisation is applied after the cache is consulted, on the egress path only. Cached
outputs are stored de-pseudonymised.**

Three consequences, all good:

| Consequence | |
|---|---|
| A cache hit at tier 1 or 3 **skips the egress entirely** | The best possible outcome for the security story: the second engineer to ask the question sends nothing. |
| The per-session pseudonym map stays per-session | 21 §8.2.1 is unchanged, which matters because a long-lived pseudonym map is a long-lived correlation handle. |
| The cache holds real names and addresses | Fine — it is inside the encrypted workspace with everything else. But it means §5.3's retention warning applies. |

This is a cross-document constraint on 21 §8.2.1's ordering, not a contradiction of it, and it
is listed in §9.

### 5.3 Where it lives, and what that costs

**DECISION — inside the encrypted workspace, under `ai/cache/`, in two segments.**

```text
workspace
└── ai/
    ├── sessions/        Session records (21 §4.10)
    ├── proposals/       Proposal + HumanReview
    ├── values/          AiValueRecord (§4.3) — the audit truth
    ├── egress/          EgressRecord (21 §8.6)
    └── cache/
        ├── index        key → (entry hash, segment, last_hit, hit_count, written_by)
        ├── corpus/      frames containing ZERO graph projection
        └── graph/       frames containing any graph projection
        └── ledger       eviction and invalidation events, capped ring
```

| Property | Consequence |
|---|---|
| Ciphertext at rest and on the sync server | Zero-knowledge is preserved. The server sees cache growth as workspace growth and nothing else. |
| Travels with the workspace | A colleague who opens the workspace inherits the hits. On a team where four engineers hit the same interop question, three of them get it free and **identical**. This is the strongest single argument for putting it here rather than in browser storage. |
| Git-versionable along with the workspace (§6.4 of the brief) | The cache diffs as ciphertext, which is noise in a diff. Mitigation: the cache is a separate object in the workspace container so a `--no-cache` export produces a clean diff for review. |
| **Model output accumulates here** | A user who deletes a node does **not** thereby delete the cached response that described it. This is the same caveat as the egress log (21 §8.6) and it must be in the product documentation, not just here. `fathom workspace purge --ai` deletes `cache/` and `egress/` bodies while retaining `values/` digests. |
| Browser storage is not used | Deliberate. OPFS/IndexedDB are unencrypted, origin-scoped, evictable without warning, and unavailable under `file://` (§2.2). Putting model output there would put plaintext workspace-derived data outside the encrypted container, which is the one thing this project does not do. |

**DECISION — the two segments have different sharing rules.**

| Segment | Contains | Shared? |
|---|---|---|
| `cache/graph/` | Any frame that included a graph projection | **Never** beyond the workspace. Cross-workspace sharing would leak between workspaces the same user holds at different classifications, which is a failure mode with no upside. |
| `cache/corpus/` | Frames whose entire input is the query plus corpus (S1 intake, S6 interop against authored value surfaces, S3F ordering over authored hypotheses) | Shareable in principle, and this is where the interesting move is — see below. |

**The corpus segment closes the loop with the gap pipeline.** A `cache/corpus/` entry that
recurs across many workspaces is, by definition, a question the corpus should answer directly.
21 §3.4 already opens a rule-pack ticket at `recurrence ≥ 5` for repeated `Basis::Judgement`
ops; the corpus cache gives the same signal for *cited* answers, which are the ones easiest to
promote. **What ships is not the cache — it is a corpus entry authored from it, with a
`reviewed_by`, per invariant 10.** We never ship model output as corpus. We ship the evidence
that a human should write an entry, and the entry a human then wrote.

### 5.4 Eviction

**Budgets** (per workspace, defaults, all settable downward, capped upward):

| Segment | Default | Hard cap |
|---|---|---|
| `cache/corpus/` | 8 MB | 32 MB |
| `cache/graph/` | 24 MB | 96 MB |
| `ledger` | 256 KB ring | — |

A structured-output response is small — a proposal with 24 ops and a rationale is well under
4,000 output tokens (21 §10.1), so entries are single-digit kilobytes. 24 MB is thousands of
entries, which is more than a workspace's realistic question space.

**Policy — segmented LRU, not plain LRU.**

```text
insert         → PROBATIONARY, at MRU
hit in PROB    → promote to PROTECTED, at MRU
hit in PROT    → move to MRU within PROTECTED
evict          → LRU end of PROBATIONARY first
                 if PROBATIONARY is empty, demote LRU of PROTECTED to
                 PROBATIONARY's MRU, then evict PROBATIONARY's LRU

PROTECTED capacity = 80% of the segment budget
```

O(1) per access with intrusive doubly-linked lists plus the index map. The reason it is not
plain LRU: an engineer working through a long list of one-off questions performs a scan, and
under plain LRU a scan evicts exactly the small set of repeatedly-asked entries that the cache
exists for. Segmented LRU makes a single-hit entry cheap to discard and a twice-hit entry
expensive.

**Invalidation is separate from eviction, and is the more important mechanism.** Because
`corpus`, `packs`, `model_identity`, `render`, `out_schema` and `frame_schema` are all *in the
key*, a change to any of them makes the old entries **unreachable**, not wrong. They still
occupy bytes, so:

| Trigger | Action |
|---|---|
| Corpus or pack version change | Sweep entries whose version is neither current nor immediately previous. Keeping `n-1` makes a rollback cheap; keeping more is hoarding. |
| Model identity change | Sweep the entries for the old identity **after** recording the change in the ledger. §7.4 wants the count. |
| `scheme` or `frame_schema` bump | Sweep everything for the old value. This happens on our releases and it should be visible in the release notes as "the assistance cache is rebuilt". |
| Workspace passphrase rotation | Nothing — the cache is inside the container and re-wrapped with it. |

**TTL — none, with one exception.** The key contains everything that can change the answer, so
an old entry is not stale; it is precisely what the pinned inputs produce. Adding a blanket TTL
would mean re-asking a question whose inputs did not change, which is what the cache exists to
prevent. The exception:

> **Entries whose proposal carries `Basis::Judgement` expire after 90 days.**

Uncited model output is the class we least want to become permanent infrastructure. A judgement
answer that is still being served two years later is a corpus gap that stopped being visible.
The TTL forces it back through the model, where 21 §3.4's `uncited_op_rate` metric can see it
again, or through the gap pipeline, where somebody writes the rule.

**The ledger.** Every eviction, invalidation sweep and TTL expiry writes
`{ key_prefix, segment, reason, at, bytes }` to a capped ring. Reason: "why did this get slow
again" is otherwise unanswerable, and a cache whose behaviour cannot be explained gets turned
off by the first person who suspects it.

### 5.5 What the cache must never do

Five hard rules. Each is a one-line assertion in code and a test.

| # | Rule | Why |
|---|---|---|
| **C1** | **`resolve()` never reads the cache.** The deterministic path (21 §3.2) is cache-free. | If the finder's ranking depended on what had been asked before, invariant 9 would be false and two engineers with the same workspace would get different rankings. This is the single most important rule here. |
| **C2** | **A cache hit produces a `Proposal`, not an acceptance.** It still requires `HumanReview`. | A cached proposal is not a pre-approved proposal. The review gate is the product's actual safety property; caching around it would delete it. |
| **C3** | **All deterministic gates re-run on cache read.** G1 (reference resolution), G2 (evidence binding), G3 (invariant scan), G9 (citation ban) — every one, on every read, exactly as on model output. | The corpus may have moved since the entry was written even when the *version* is unchanged in a development build. Gates are microseconds (22 §2.7). Skipping them because "we already ran them" is how a stale reference gets served. |
| **C4** | **The cache never skips the consent *grant* check** at tiers 1 and 3, even though it skips the egress. | A grant can be revoked or expired (21 §8.4). A cache hit under a revoked grant is a policy violation that happens to cost no bytes. |
| **C5** | **Deleting the entire cache changes nothing except latency and cost.** | Verified by step #9 of the verification pass. This is what makes the cache an optimisation rather than a component. |

### 5.6 Poisoning, multi-writer, and provenance of a hit

A synced, multi-writer workspace (§7.6 of the brief, CRDTs) means the cache has more than one
author. Threat and response:

| Threat | Response |
|---|---|
| A colleague's compromised session writes a malicious entry | Entries carry `written_by: UserId` and `session: AiSessionId`. C3 re-runs every gate on read, so a poisoned entry cannot smuggle a fabricated citation (G1/G9) or a credential-shaped value (G3). What it *can* do is propose something plausible and wrong — which is what an uncompromised model can also do, and which is what the review gate exists for. |
| An entry written by another user is presented as though it were fresh | The proposal card renders the margin tab `cached · another session`, in the muted lowercase idiom, with the writing user and date. No new colour — the three semantic colours stay reserved for `Risk`. |
| Someone edits the workspace file directly to insert entries | They can already do worse; they hold the key. The cache is not a trust boundary and must not be described as one. |
| Key collision | BLAKE3 at full 256 bits. **Do not truncate.** A 128-bit truncation looks harmless and gives a birthday bound around 2⁶⁴ entries, which is irrelevant in practice and impossible to reason about in a security review. Full width costs 16 bytes per entry. |

---

## 6. The graceful degradation matrix

### 6.1 The columns

| Column | Means | Typical runtime |
|---|---|---|
| **no model** | Tier 0. `fathom-ai` not linked, or linked and disarmed. **The default, and the only configuration the security documentation describes without qualification.** | — |
| **small local** | ≤ ~4 B at Q4, on the user's own hardware | §2.2 WebGPU in-page, or §2.3 WASM CPU at ≤ 1 B |
| **large local** | 7–32 B at Q4, on the user's own hardware | §2.4 sidecar, owned by the shell (§3.7) |
| **remote** | A hosted provider (tier 1, BYOK) or an operator endpoint inside the customer boundary (tier 3) | §2.5 |

**The rule this matrix is built to satisfy:** *no cell in the "no model" column says
"unavailable".* Every cell names what the user gets. If a row cannot satisfy that, the feature
does not ship — that is criterion A3 (21 §5.3) restated as a table constraint.

### 6.2 The matrix

| Feature | **no model** | **small local** | **large local** | **remote** |
|---|---|---|---|---|
| **Finder, rules, emitters, diff, verify ladder, rollback, change ticket, inventory, diagram** | **Full. Byte-identical.** This row is the product. | identical | identical | identical |
| **Under-determination surface** (21 §7.1) | **Full.** Disambiguation list + live findings on the matched entities + gap-filing affordance | identical, plus AI output appended *below* it | identical | identical |
| **S1 intake / query classification** | ~40-pattern intent grammar + leftmost-longest concept lookup. Good on common shapes; unusual phrasing lands in the disambiguation list, which is a useful answer | **good** — closed enum, ≤ 6,000 tokens, constrained output | good | good, marginally better on long rambling queries |
| **Concept extraction from pasted error text** | The `ERROR DECODER` table is authored: the literal strings `NO_PROPOSAL_CHOSEN`, `INVALID_KE_PAYLOAD`, `TS_UNACCEPTABLE`, `AUTHENTICATION_FAILED` match by surface lookup and route straight to the authored answer | **good, and this is the row where a small model earns its keep** — it adds recall on paraphrase (*"it says no proposal chosen for phase two"*) that the surface map misses | good | good |
| **S2-A residue binding** | Residue preserved, classified, marked and gap-filed; extension bag holds it (11-ir-schema §12.4). **The user loses auto-population of a few nodes, not correctness** | **off by default.** G5's round-trip gate makes small-model errors safe and the yield near zero | fair on covered platforms | good |
| **Diagnostic tree** (22 §5.2–§5.4) | **Full. Deterministic, and better than a model** — the `FLAP PATTERN → CAUSE` and `ERROR DECODER` tables *are* the correlation logic, in authored form, with citations | identical | identical | identical |
| **S3F fall-through ordering** | Surviving hypotheses in authored order, all discriminators shown, gap filed. A genuinely small delta | **fair** — ordering ≤ 6 given items, selecting ≤ 3 finder-returned commands | fair–good | good |
| **S6 interop advisor** | The authored value surfaces, the rules and their `acceptable_when`, rendered as a two-column comparison. *This is most of the value already* | **off. Not "poor" — off.** G6 discards what it produces; what survives is worse than the table it replaced | fair, gated by G6/G8/G10 | good, gated |
| **S7 change-narrative** | The deterministic diff + verify ladder + rollback, rendered into the ticket. **Already paste-ready and already the deliverable** | off — G11 strips it | fair | fair. *This row does not improve with scale* (§2.7) |
| **S8 adversarial reviewer** | The rule engine is the adversary, and at tier 0 there are no AI proposals to review | **off** — an adversary weaker than the producer is false assurance | on only when ≥ the producer's capability | good |
| **Corpus gap filing** | **Full.** The under-determination surface and the diagnostic tree both file gaps; the user can file one by hand | full, plus a drafted `suggested_symptom_surface` | full | full |
| **Response cache** (§5) | n/a — nothing to cache. But the corpus segment's recurrence signal produces authored corpus entries, so **tier 0 benefits one release later** | full | full | full, **and a hit sends zero bytes** |
| **Egress** | **none** | **none** | **loopback only**, via the shell's IPC (§3.7) | one origin, consented, pre-flighted, logged |
| **Latency to first AI output** | n/a | 1–4 s warm; cold start dominates and is not cached under `file://` | 2–10 s warm; model load if cold | 2–8 s |
| **Reproducibility of every artifact** | **full** | **full** | **full** | **full** |

### 6.3 How to read it

Three things the matrix is designed to make visible.

**1 · The first row and the last row are the same in every column.** Nothing that leaves the
product — config, findings, ladders, rollbacks, tickets — differs by model capability. That is
R1 rendered as a table, and it is the answer to *"what do we lose by running with no model?"*

**2 · Four rows have "off" in the small-local column, and that is a design output, not a
shortfall.** `S2-A`, `S6`, `S7`, `S8`. In every case the reason is the same: a gate that
rejects most of a weak model's output does not produce a weaker feature, it produces a slower
version of the fallback. Shipping it "on, but poor" would be shipping a spinner.

**3 · Reading down the "no model" column gives a complete product description.** That is the
test. If reading that column left you asking what the tool actually does, tier 0 would be a
stub and the whole boundary would be theatre. It does not, and that is the point of the
column's existence in this document.

---

## 7. Model-version drift

### 7.1 The asymmetry

> **A MODEL YOU CANNOT PIN IS A DEPENDENCY YOU CANNOT SHIP.**

| | Corpus and rule packs | Models |
|---|---|---|
| Versioned | semver, with the content hash published alongside (conventions §Identifiers) | sometimes, behind an alias that moves |
| Signed | yes | no |
| Changes when we say | yes | **no** |
| Change is announced | in the release notes we write | sometimes, retroactively, in someone else's changelog |
| Change is detectable | trivially — hash the content | only if the endpoint tells us, or if we hold the weights |
| Rollback available | yes, `n-1` kept in cache and on disk | only if the user holds the old weights |

Everything the project controls is versioned and hashed. The model is the one input that can
change without any signal reaching us. And the failure it produces is the quiet kind: nothing
errors, nothing 500s, the JSON still validates, and the proposals get subtly worse — or subtly
different, which is harder to notice and harder to argue about.

This is 22 §2.8's **F10**, and 22 correctly says it must be "detected by the eval suite on a
schedule, not by users". This section specifies that.

### 7.2 Pin what can be pinned, per runtime

| Runtime | Weights identity | Runtime identity | `identity_confidence` |
|---|---|---|---|
| WebGPU in-page | BLAKE3 of the file the user selected, computed by us as we read it | our build's runtime version | **`Verified`** |
| WASM CPU | same | same | **`Verified`** |
| Shell-owned sidecar (§3.7) | BLAKE3 of the weights file, computed before launch | bundled binary version + hash | **`Verified`** |
| User-run sidecar (shape D) | Ollama `/api/tags` → `digest`, `parameter_size`, `quantization_level`, `modified_at`. `llama-server` → the served model's path/name <!-- VERIFY: check what identity `llama-server`'s `/props` and `/v1/models` currently expose; if there is no content digest, this row is `Advertised` and should say so. --> | server version string | `Verified` (Ollama digest) or `Advertised` |
| Enterprise endpoint | whatever the response body's model field says, verbatim | gateway version if offered | **`Advertised`** |
| Hosted provider | same | — | **`Advertised`** |

**DECISION — `IdentityConfidence::Unknown` disarms the AI layer.** If an endpoint returns no
usable model identity at all, the layer does not run and the UI says why:

```text
  ▌ ASSISTANCE UNAVAILABLE                                     no identity
    The endpoint at <origin> did not report which model answered.
    Fathom records the model behind every accepted value, and it will
    not record "unknown". Deterministic results above are complete.
```

That is a deliberately unhelpful behaviour and it is correct. An audit record whose model field
says `unknown` is worse than no record, because it looks like a record.

### 7.3 Detection — the canary suite

**Shape.** A set of **frozen probes** — typed task frames with known-good structured outputs —
stored in the build, not in the workspace, versioned and hashed like corpus. Target: ~40 probes,
covering every runtime subagent's output schema, drawn from the same fixtures as 22 §2.9's
evaluation sets so there is one corpus of truth rather than two.

**Each probe asserts a checkable property, never an expected string.** Comparing generated
prose across runs produces alarms nobody reads (§7.5). Properties, with the field card as the
source of the material:

| Probe class | Example | Property asserted |
|---|---|---|
| Classification stability | a query containing `NO_PROPOSAL_CHOSEN (P2)` | `TaskClass == Diagnose`, and the concept set includes the Phase-2 proposal concept. Per the card's `ERROR DECODER`, P2's `NO_PROPOSAL_CHOSEN` means "PFS group, ESP algorithms, esp vs ah" — a classifier that routes it to Phase 1 has drifted |
| Cardinality reasoning | an `IpsecVpn` with three `TrafficSelector`s and `IkeGateway.version = v1-only` | the adversary must object. Under IKEv1 there is **one** proxy-ID pair, not many selectors — the card's `INVALID_ID_INFORMATION` row. Missing this is the exact failure 21 §5.2.4 built the adversary for |
| Value-surface discipline | a peer offering `3des-cbc` and `group2` | every asserted value appears in `corpus.value_surfaces`. Counts **G6 trips**, which is the sharpest available fabrication signal |
| Citation discipline | any probe | **zero** outputs containing a citation shape (`RFC \d+`, a vendor doc id, a CVE). Counts **G9 trips**. Models fabricate citations first and most confidently; this is the canary that fires earliest |
| Structural validity | all probes | schema validity ≥ 99% with constrained decoding, ≥ 95% without. A fall below the floor is a runtime or template change, not a model change |
| Risk parity | any probe producing a patch | the stated `Risk` matches `emit.dry_run`'s worst line. **Understatement is a hard fail** (G10), overstatement is allowed |
| Refusal shape | a probe whose only correct answer is abstention | the output is an abstention, not a confident guess. Drift toward guessing is the most damaging drift and the least visible |

**Sampling.** N = 5 per probe at deployed parameters, **worst sample reported, not the mean**
(22 §2.9). Users experience samples.

**Schedule.**

| Trigger | |
|---|---|
| First use of a `model_identity` in a workspace | Always. This is the baseline the later runs compare against. |
| `ModelPin` changes | Always, immediately, before the layer is re-armed. |
| Every 14 days of *active* use | Not wall-clock — a workspace nobody opens does not run canaries. |
| Manually, from the assistance settings | Because a user who suspects drift should be able to check. |

**Cost.** 40 probes × ~1,500 input tokens ≈ 60,000 input tokens plus a few thousand output.
At tier 1 that is roughly the cost of a single §13-scale request — cents, not dollars, on the
user's own key, and it should be shown as such before it runs. At the local tiers it is a
couple of minutes of the user's own GPU. Cheap enough that the schedule above is affordable;
expensive enough that running it per request would be absurd.

**Report.**

```rust
pub struct CanaryReport {
    pub at: Timestamp,
    pub model: ModelPin,
    pub runtime: RuntimePin,
    pub probes_run: u16,
    pub samples_per_probe: u8,
    /// Fraction of probes whose property failed on the WORST sample.
    pub drift_score: f32,
    /// Per-gate trip rates. G6 and G9 are the fabrication canaries.
    pub gate_trips: BTreeMap<GateId, f32>,
    pub schema_validity: f32,
    pub abstention_shape_ok: bool,
    /// Delta against the baseline run for this model identity, if one exists.
    pub baseline: Option<CanaryDelta>,
    pub verdict: CanaryVerdict,             // Pass | Degraded | Fail
}
```

### 7.4 What happens on detection

Two distinct cases, and conflating them is the mistake.

**Case A — the identity changed.** `model_identity` differs from the one recorded for this
workspace.

```text
  ▌ M O D E L   C H A N G E D                                 disarmed
    The endpoint is now answering as a different model.

    was   "<advertised-old>"   Advertised   first seen 2026-02-11
    now   "<advertised-new>"   Advertised   first seen 2026-07-28

    Assistance is disarmed for this workspace until you re-arm it.
    Deterministic results are unaffected and are complete.

    canary   38/40 pass · G9 trips 0.00 · G6 trips 0.05 · schema 1.00
    cache    412 entries for the previous model are now unreachable

    [ run the canary again ]  [ re-arm ]  [ leave disarmed ]
```

| Action | |
|---|---|
| **Disarm the AI layer for that workspace.** | Not global, not silent. The user chose a model; a different model is a different choice. |
| **Run the canary and show the result before re-arming.** | The user re-arms with evidence rather than with a shrug. |
| **At tier 1 and 3, re-fire the egress pre-flight.** | 21 §8.3's re-fire list covers purpose, profile, system hash, tools hash and origin — but not the model. It should. See §9. The model that receives your topology is part of what you consented to. |
| **Cached entries for the old identity become unreachable** by construction (§5.1). | No stale answers, no sweep required for correctness. The sweep in §5.4 is a space reclamation, and the ledger records the count so the UI can show it. |
| **Accepted `AiValueRecord`s are not invalidated.** | The value is human-asserted. It emits identically. What changes is the audit view, which annotates those records `model changed since` so a reviewer can ask the question. |

**Case B — the identity did not change, but the canary regressed.** This is the silent case:
the provider changed something behind a fixed string, or the runtime updated, or a template
was corrected.

| Verdict | Response |
|---|---|
| `drift_score` ≤ 0.05 and no G6/G9 regression | Pass. Record and continue. |
| `drift_score` in (0.05, 0.20], or a G6/G9 rate above baseline + 0.05 | **Degraded.** Do not disarm the layer. Disable **the affected subagents only**, show the report in the workspace health panel, and require an acknowledgement to re-enable them. A partial degradation should produce a partial response. |
| `drift_score` > 0.20, or schema validity below the floor, or any G10 understatement, or the abstention probe now guesses | **Fail.** Disarm as in Case A. G10 understatement and lost abstention are unconditional: one says the model is now describing a `Disruptive` change as safe, the other says it has stopped saying "I don't know". Neither is a degradation, both are a different product. |

In both cases the report is written to the workspace under `ai/canary/`, so the history is
there for the reviewer in §4.4 and for the drift question *"when did this start"*.

### 7.5 What we deliberately do not do

| Not done | Why |
|---|---|
| **Detect drift by diffing free-text output** | Two calls to the *same* model produce different prose. A prose diff produces alarms that are indistinguishable from noise, and an alarm nobody reads is worse than no alarm. Properties, not strings. |
| **Auto-select a different model** | Silently changing which model answers is the exact failure we are detecting. Doing it ourselves is not better because our intentions are good. |
| **Silently degrade to a smaller model** | Same. If capability drops, the matrix in §6 says what that means and the user decides. |
| **Pin by refusing to run on a new model** | We disarm and ask; we do not block. The user may know exactly why the model changed and be fine with it. |
| **Claim reproducibility we cannot verify** | §4.1. The canary detects *behavioural* drift. It is not a reproducibility guarantee and no UI string may imply it is. |

### 7.6 The gap that has no fix

At tier 1 and tier 3 the provider can change the model **between** the canary run and the next
request. The canary is a sample of past behaviour; there is no attestation channel that would
let a client verify which weights answered a given request. Sub-request drift is undetectable
from where we stand.

The honest statement, for the review pack:

> At a hosted or operator-run endpoint, Fathom records the model identity the endpoint
> reported. It cannot verify that report, and it cannot detect a change that happens between
> one request and the next. If you need to know with certainty which model produced a value,
> run the model on hardware you control, where Fathom hashes the weights file itself. That is
> what `Verified` means in the audit record and it is the only place it appears.

That paragraph is also the strongest argument in this document for §3.7's decision, and it is
why the decision went to the shape that hashes the weights.

---

## 8. Failure modes of this document's own machinery

| # | Failure | Shape | Mitigation | Residual |
|---|---|---|---|---|
| 1 | **Cache key collision** | Two different frames hash to one key; the wrong answer is served, gated, and looks fine | Full-width BLAKE3-256, never truncated. Collision probability is not a concern anyone has to reason about | none worth stating |
| 2 | **Canonicalisation under-specification** | A field that *can* change the answer is not in the canonical form. Two genuinely different frames collide. **This is the dangerous one, and it is a code bug, not a hash bug** | The canonical form is derived from the typed schema by a derive macro; `frame_schema` (a hash of those type definitions) is itself a key component, so adding, removing or retyping a field changes every key. A hand-written canonical serialiser is banned | A field added *without* changing the type — e.g. widening an enum's meaning — still slips through. Covered only by review |
| 3 | **Canonicalisation over-specification** | A field that cannot change the answer is in the form. Hit rate collapses | Cheap and visible: the cache's hit rate is a metric. A near-zero hit rate on repeated identical questions is the symptom | Nothing serious. Wasted tokens, not wrong answers |
| 4 | **Verification pass false green** | Steps #4–#7 compare against snapshots stored in the same workspace, which someone who can edit the workspace can edit | The change ticket's hashes are exported and, in the sync build, signed at export. The independent copy lives in the change-management system, not in the workspace | A workspace verified only against itself proves internal consistency, not integrity. Say so in the output |
| 5 | **`AiValueRecord` never written** | A model-proposed value with no record is indistinguishable from a hand-entered one | `Workspace::apply_proposal` writes the record in the same transaction as the field. There is no other write path from a proposal | A code-review property, not a runtime one. Test with a fixture that tries to write one without the other and asserts it does not compile |
| 6 | **Canary false positive** | A probe fails for a reason unrelated to the model — a corpus edit changed the value surfaces the probe expects | Probes are versioned and hashed with the corpus, and a corpus release re-baselines them in CI before it ships | A user on a hand-built corpus can see spurious `Degraded`. Acceptable |
| 7 | **Canary cost surprises a tier-1 user** | 60,000 input tokens arrive unannounced on someone's own key | The scheduled run shows its estimated cost and requires the first acknowledgement per workspace | none |
| 8 | **The cache becomes a retention surface** | Deleted nodes survive in cached responses | Documented (§5.3), `purge --ai` provided, and the eviction ledger makes the retention visible | Real, and inherent to caching model output at all. It is the price of the feature and must be in the product documentation rather than only here |
| 9 | **Segmented LRU tuned wrong** | 80% protected is a guess | The ledger records eviction reasons; hit rate by segment is a metric | The number should be re-derived from the first release's local-only telemetry, not defended |
| 10 | **The shell's sidecar outlives the shell** | An orphaned inference server keeps a loopback port open with a token nobody holds | Launch invariant 5, tested with `kill -9` on the parent | On a hard power loss the child dies too. On a stuck child, the next launch detects the stale port and refuses rather than reusing it |

---

## 9. Open decisions

| # | Decision | Owner | Why it cannot wait |
|---|---|---|---|
| **D1** | **Amend 21 §8.3's pre-flight re-fire list to include the model identity.** The list currently covers purpose, redaction profile, system-contract hash, tool-schema hash and endpoint origin. §7.4 argues the model that receives the payload is part of what was consented to. | 21's owner | Changing consent semantics after users have granted consent is not possible without re-prompting everyone |
| **D2** | **Confirm §5.2's ordering constraint against 21 §8.2.1.** The cache key must be computed before pseudonymisation. 21 does not currently state where in the pipeline pseudonymisation is applied. | 21's owner | A cache that never hits at tiers 1 and 3 is a cache that was not worth building |
| **D3** | Whether the loopback build flavour (shape D) ships at all, or whether the native shell is the only local-inference path. | product | Shape D's setup checker and its documentation are non-trivial, and building both is a real cost |
| **D4** | Which sidecar binary is bundled by the shell. `llama-server` is preferred here for `--api-key` and GBNF; Ollama is preferred by users who already run it. | product | It determines the CVE surface we adopt (§3.8) |
| **D5** | Whether the corpus-segment cache's recurrence signal opens tickets automatically, at what threshold, and whether that threshold is the same as 21 §3.4's `recurrence ≥ 5`. | corpus maintainers | Two different thresholds for the same signal will diverge |
| **D6** | The `PROTECTED` fraction in §5.4, the segment budgets, and the 90-day `Judgement` TTL. All three are stated as defaults and none is measured. | after first release | They are cheap to change and expensive to defend as though they were derived |
| **D7** | Whether `fathom verify` gains a `--against-ticket-signature` mode that checks the exported, signed hashes rather than the workspace's own snapshots (§8, failure 4). | security | It is the difference between "internally consistent" and "verified" |

---

## 10. Sources consulted

Standards and specifications:

- RFC 8949, *Concise Binary Object Representation (CBOR)*, §4.2 "Deterministically Encoded CBOR"
  — the canonical encoding requirement in §5.2.
- RFC 6598 — shared address space, referenced by 21 §8.2.1's pseudonymisation.
- RFC 7296 §1.3.2 — cited by the `ipsec.pfs.absent` rule in the owner's brief.

Platform behaviour, checked July 2026:

- Chrome for Developers, *New permission prompt for Local Network Access* —
  https://developer.chrome.com/blog/local-network-access
- MDN, *Storage quotas and eviction criteria* —
  https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria
- MDN, *GPUSupportedLimits* / WebGPU Fundamentals, *Limits and Features* —
  https://webgpufundamentals.org/webgpu/lessons/webgpu-limits-and-features.html
- WebKit, *News from WWDC25: WebKit in Safari 26 beta* — WebGPU shipping in Safari 26.
- V8, *Up to 4GB of memory in WebAssembly* — https://v8.dev/blog/4gb-wasm-memory

Runtimes:

- Ruan, Yang, Lai et al., *WebLLM: A High-Performance In-Browser LLM Inference Engine*,
  arXiv:2412.15803 — the "up to 80% native performance" figure in §2.2.
- `wllama` documentation — the 2 GB `ArrayBuffer` limit and the 512 MB shard guidance —
  https://github.ngxson.com/wllama/docs/
- `llama.cpp` server README — `--host`, `--port`, `--api-key`, `--cors-origins` (default `*`),
  `--grammar`, `--json-schema`, `response_format` —
  https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
- Ollama FAQ and API reference — default bind `127.0.0.1:11434`, default CORS origins,
  `OLLAMA_ORIGINS`, extension origins, `format` with JSON Schema, `options.seed`,
  `keep_alive` default `"5m"`, `/api/tags` `digest` / `parameter_size` /
  `quantization_level` / `modified_at` — https://docs.ollama.com/faq

Determinism:

- Thinking Machines Lab, *Defeating Nondeterminism in LLM Inference* — batch non-invariance,
  the 1,000-completions-at-temperature-0 result, and batch-invariant kernels —
  https://thinkingmachines.ai/blog/defeating-nondeterminism-in-llm-inference/

Security:

- NCC Group, *Technical Advisory — Ollama DNS Rebinding Attack (CVE-2024-28224)* — affected
  versions prior to v0.1.29, `Host` header validation as the fix —
  https://www.nccgroup.com/research-blog/technical-advisory-ollama-dns-rebinding-attack-cve-2024-28224/

Project documents:

- `.context/owner-brief.md`, `.context/conventions.md`, `.context/design-language.md`,
  `.context/field-card-srx-ipsec.txt` — every worked example in this document is drawn from
  the field card.
- `21-ai-layer-architecture.md`, `22-subagent-catalogue.md`, `23-ai-safety-and-injection.md`,
  `11-ir-schema.md`, `12-rule-engine.md`, `13-emitters-and-provenance.md`,
  `15-explainer-corpus.md`, `16-command-finder.md`, `18-diff-verify-rollback.md`.

Every `<!-- VERIFY -->` marker in this document names a claim that was not confirmed against a
first-party source at the time of writing. None of them should survive into a release.

---

## 11. Disagreements

Two conventions are obeyed as written throughout this document, and both are, I think, slightly
wrong. Stated per `conventions.md`'s own instruction. A third disagreement — with `21` §7.3
rather than with the conventions — is filed at §11.2a, late, per M16.

### 11.1 Invariant 9 omits the rule-pack version

**The convention.** Hard invariant 9: *"Same workspace + same corpus version + same build ⇒
byte-identical emitted config, byte-identical findings, identical finder ranking."*

**The objection.** Rule packs are versioned **separately** from the corpus. `conventions.md`
§Identifiers says so directly — *"Corpus and rule-pack versions: semver, with the content hash
published alongside"* — and 21 §4.10's `Session` carries `corpus_version` and `pack_versions`
as two distinct fields. A rule-pack upgrade changes the finding set without changing the corpus
version. As written, invariant 9 is therefore satisfiable by two runs that produce different
findings, which makes it unusable as the specification for §4.5's verification pass. I have had
to write the pass against the four-tuple regardless, which means the document and the invariant
disagree on their face.

**Proposed replacement:**

> **9. Determinism where it is observable.** Same workspace + same corpus version + same
> rule-pack version set + same build ⇒ byte-identical emitted config, byte-identical findings,
> identical finder ranking. Anything non-deterministic is quarantined behind the AI layer's
> boundary and labelled as such in the UI.

Cost of the change: one sentence in `conventions.md`, and every document that quoted the old
wording gains a word. Cost of not changing it: the verification pass, the cache key and the
audit record all pin four things while the invariant names three, and somebody will eventually
"simplify" one of them to match.

### 11.2 Invariant 1's "exactly one origin" is already false

**The convention.** Hard invariant 1: *"`connect-src` is `'none'` in the offline build and
exactly one origin in the sync build."*

**The objection.** Three counts are already wrong, and two of them appear in documents that are
themselves obeying this invariant:

1. `http://127.0.0.1:<port>` and `http://[::1]:<port>` are **two distinct origins**, and both
   are required for a loopback build to work on a machine that prefers IPv6. 21 §7.5's own CSP
   table lists both.
2. A sync build with tier 1 enabled has the sync origin **and** the provider origin. 21 §7.2
   describes exactly this.
3. Shape D (§3.7) would have the sync origin plus two loopback origins.

The invariant's intent is clear and correct — *no origin the user did not configure, and no
unbounded set* — but the literal wording is violated by the architecture document that cites it,
which means it will be quoted in an enterprise review and then contradicted by the artifact.

**Proposed replacement:**

> **1. No egress by default.** The application never opens a connection the user did not
> configure. `connect-src` is `'none'` in the offline build. In every other build it is a
> **closed, build-time-fixed** list: at most one remote origin, plus the loopback origins of a
> local inference sidecar where that build supports one. The list is a property of the
> artifact, not a runtime setting, and it is published in the release notes. No telemetry, no
> analytics, no font CDN, no error reporting.

This keeps the teeth — build-time, closed, published — and stops the invariant being trivially
falsifiable by counting.

### 11.2a A third disagreement, filed late — `21` §7.3's loopback shape (added per M16, ADR-0020)

**The sibling decision.** `21` §7.3/§7.5 specifies tier 2b as a served browser page reaching
`llama-server` over loopback, with `connect-src http://127.0.0.1:<port>` in its CSP table, and
rates tier 2 as the tier the product should want people on.

**The objection, which this document argued in §§2–3 without filing it.** §3.4's Local Network
Access argument is decisive: the first interaction with that shape is a browser permission
prompt whose wording we do not write, shown at a moment we do not choose, whose denial is
sticky, describing an action a security-conscious network engineer — precisely our user — is
correctly trained to deny. §3.7's DECISION picks a native shell that owns the sidecar as a
child process; §3.8 prices it, including the sentence that matters most: *"the shape we chose
for security reasons is the one the most security-constrained users cannot run."*

**Resolution — ADR-0020 adopts this document's position.** `21` §7.3 is rewritten from §§2–3
here; tier 2b is *native shell (primary) / served loopback flavour (secondary)*; the CSP
surface for local inference is owned by `34` per ADR-0001, so three documents stop describing
three different CSP surfaces.

### 11.3 One thing that is not a disagreement, recorded so it is not raised as one

`conventions.md` §Identifiers specifies ULIDs for node IDs. §5.1 uses a **content hash** as the
cache entry's identifier instead. That is not a deviation: the convention governs graph nodes,
and a cache entry is not a node. The distinction is load-bearing and worth stating — a ULID is
monotonic in time, so using one as a cache identifier would make every entry unique and the
cache would never hit. **Content-addressed things get content addresses.** Where a document in
this repo needs an identifier for something whose identity *is* its content, it should say so
explicitly rather than reaching for the ULID scheme by default.
