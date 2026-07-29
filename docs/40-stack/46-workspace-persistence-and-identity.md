# 46 — Workspace persistence and identity

> **Status:** Proposed

Companion to `43-deployment-modes.md`, which owns the four shapes and whose D1 decision this
document implements and, in one row, corrects; to `34-browser-hardening.md`, which owns the CSP and
the `fathom serve` rules any save path must survive; to `32-cryptography.md`, which owns the KDF and
the envelope the username proposal touches; to `33-sync-protocol.md`, which owns the account/key
separation every SSO pattern in §6 must preserve; to `35-supply-chain-and-builds.md`, which prices
every artifact a native shell would add; and to `42-no-node-runtime.md`, which is why one of the
shells is never proposed. This document owns two questions the demo posture forces together:
**how the sealed workspace gets back onto the user's disk, in the place the user chose**, and
**what the username typed at unlock actually is**.

**The governing rule of this document, stated once, in caps, at the top:**

> **A PAGE THAT OVERWRITES A FILE THE USER CHOSE EXISTS ON DESKTOP CHROMIUM AND NOWHERE ELSE —
> PERMANENTLY, BY VENDOR DECISION, NOT BY LAG. AND A USERNAME IS CONTEXT, NEVER A KEY: NOTHING AN
> IDENTITY PROVIDER ASSERTS CAN DECRYPT A ZERO-KNOWLEDGE WORKSPACE.**

The first half is earned in §2 from vendor-published data fetched this session, and §4 plans around
it instead of waiting it out. The second half is earned in §5–§6 and is the sentence that keeps the
owner's AD / OneLogin ambitions from quietly re-coupling authentication to confidentiality — the
exact coupling `33` §3.1 exists to break.

---

## 0. Contents

| § | Section | |
|---|---|---|
| 1 | The demo posture, restated as binding | *read this first* |
| 2 | The browser reality, engine by engine | *verified, with the source class per row* |
| 3 | The options, priced | *six, including the two the corpus already rejected* |
| 4 | RECOMMENDATION — the demo answer and the eventual answer | **the decision** |
| 5 | The username — where it enters the KDF, and what it is not | |
| 6 | The SSO bridges the username keeps open | *IdPs authenticate; they do not decrypt* |
| 7 | The home-lab walk-through | *machine compromised, workspace exfiltrated* |
| 8 | Failure modes | |
| 9 | Open decisions | |
| 10 | Proposed amendments to other documents | |
| 11 | Sources consulted | *primary / secondary / memory, separated* |
| 12 | Disagreements | |

---

## 1. The demo posture, restated as binding

*margin tab: read this first*

The owner's instructions for the demo, mapped onto decisions the corpus has already made. Every row
below is binding on this document; none of it is new.

| # | Owner's instruction | What it binds to |
|---|---|---|
| 1 | **No server side — "as little of that as possible"** | The demo is D1, the offline single file (`43` §3.5, ADR-0017). `fathom serve` (D4 subcommand, loopback-only, no workspace passes through it — `34` §3.6) is the only tolerated process, and only as the fallback origin in §4.2 |
| 2 | **The workspace lives in a file the user explicitly chooses — never a default location** | `43` §2.1 D1 row, verbatim: *"Workspace storage — the user's chosen file only. Nothing in browser storage."* §2 of this document is about whether the platform can honour that |
| 3 | **Encrypted under username + password** | The password is `32`'s passphrase path, unchanged: Argon2id (per-workspace CSPRNG salt, FLOOR default per ADR-0014) → keyholder → `RK_e` → `WK_e` → per-record keys. The username is new and §5 specifies it. It changes nothing about the AEAD, the envelope, or the salt |
| 4 | **Nothing in browser storage** | `43` §3.5: *"no OPFS, no IndexedDB, no Cache API, no `localStorage`, no cookies, no service worker."* Enforced by the H19–H20 canary scan (`34` §10): after a full session, origin storage is **empty** — not "contains no plaintext", empty |
| 5 | **A compromise of the demo machine must not expose network data** | `31`'s at-rest posture plus rows 2 and 4 above. §7 walks the scenario end to end, including what each rejected option in §3 would have added to the attacker's haul |
| 6 | **The username exists as an identity hook for later AD / TACACS / OneLogin integration** | `33` §3.1's separation decision is the constraint: the account credential and the workspace key are different secrets and neither derives from the other. §6 shows which integration patterns that keeps open |

One terminology correction, applied throughout: the owner's brief says "workspace database". Per
`conventions.md` the word is **workspace**, and its on-disk shape is the packed workspace file
(`17` §2.1) — `site-b.fathom` in every example below.

---

## 2. The browser reality, engine by engine

*margin tab: the facts the plan stands on*

Every row states its source class. **Primary** means the data was fetched from the vendor's or the
standard body's own machine-readable source during the research for this document (caniuse
features-json, MDN browser-compat-data JSON, the WICG and WHATWG spec sources, the Chromium source
tree, each vendor's standards-positions repository). **Secondary** means a search-result summary of
a primary page the egress proxy would not serve — one notch weaker. **Memory** means training
recall, unverified, and it is never load-bearing for a decision in this document.

### 2.1 The capability table

The capability that matters is the File System Access pickers — `showOpenFilePicker`,
`showSaveFilePicker`, `showDirectoryPicker` — plus a writable `FileSystemFileHandle`. That is the
only mechanism by which a web page can overwrite a file the user chose, in place.

| Capability | Chromium desktop | Chromium Android | Firefox | Safari (macOS + iOS) | Source class |
|---|---|---|---|---|---|
| FSA pickers + writable handles | Chrome/Edge **86** partial, **105** full; Opera 72/91; behind a flag in 74–85 | Chrome **132**+ (Jan 2025), incl. WebView — the caniuse table (`and_chr` "n" at 150) is stale on this point | **Never shipped, any version** through 155 | **Never shipped, any version** through 27/TP | Primary (caniuse JSON + BCD JSON; the Android row corroborated by BCD, launch date secondary) |
| OPFS (whatwg/fs: `navigator.storage.getDirectory`, sync access handles) | 86+ | yes | **111**+ | **15.2**+; `createWritable` only from **26.0** (Sept 2025) | Primary (BCD); Safari 26 date secondary |
| `<a download>` | 14+ | yes | 20+ | 10.1+ / iOS 13+ | Primary (caniuse JSON) |
| `FileSystemHandle` structured-cloneable into IndexedDB (the only cross-reload handle persistence) | yes; restored handles come back at permission state `"prompt"` | yes | n/a (no pickers) | n/a | Primary (WICG spec IDL `[Serializable]` + spec text) |
| Persistent picker permissions ("Allow on every visit") | Chrome/Edge **122**+ | — | n/a | n/a | Primary (Chromium source: the persistent-permission and restore-prompt machinery is present) + secondary (the Chrome 122 blog) |
| Brave | **FSA disabled by default**; re-enable requires `brave://flags` and a relaunch | — | — | — | Secondary (Brave tracker issue titles; issue bodies not fetched) |

Three consequences, stated as the rules the rest of this document obeys:

1. **"Chromium only" means desktop Chromium, excluding Brave at default settings.** A tablet demo,
   a phone demo, or a Brave user gets the fallback. Detection is by capability
   (`'showSaveFilePicker' in window`), never by user-agent string — the same gate VS Code for Web
   ships (`WebFileSystemAccess.supported()` is literally
   `typeof globalThis.showDirectoryPicker === 'function'`; primary, fetched from
   microsoft/vscode).
2. **Everything else gets `<a download>`**, whose exact behaviour is §2.4.
3. **The gap does not close by waiting.** §2.2.

### 2.2 The gap is vendor policy, not lag

Both non-Chromium engine vendors have published formal positions, fetched this session from their
own standards-positions repositories (primary):

| Vendor | Position | The recorded words |
|---|---|---|
| Mozilla, on the WICG File System Access API (entry 154) | **negative** | *"There's a subset of this API we're quite enthusiastic about (in particular providing a read/write API for files and directories as alternative storage endpoint), but it is wrapped together with aspects for which we do not think meaningful end user consent is possible to obtain (in particular cross-site access to the end user's local file system). Overall we consider this harmful therefore, but Mozilla could be supportive of parts, provided this were segmented better."* |
| Mozilla, on OPFS access handles (entry 562) | positive | *"A storage endpoint with a POSIX-like file system API is a valuable addition to the web platform"* |
| Mozilla, on a pickers-only subset (entry 738, opened January 2023) | **defer** — no rationale comment, no movement found through July 2026 | — |
| WebKit, on File System Access (issue 28) | **oppose**, concerns: security | The issue explicitly separates OPFS (*"already been implemented in WebKit"*) from *"the part that allows for direct access to local files"*, which is what is opposed |

Read the pattern: both vendors ship file APIs **inside the origin sandbox** (OPFS) and refuse the
part that touches the user's real filesystem. Cross-engine parity exists only inside the sandbox —
which is the one place `43` D1 and the owner's brief both forbid Fathom to store anything. That is
the structural fact the demo plans around rather than fights, and it is why every degraded-path
sentence in §4 is written as permanent, never as "your browser doesn't support this yet".

### 2.3 What the platform guarantees about a save that does happen

Two verified properties the recommendation leans on:

- **FSA writes are atomic by spec.** The WHATWG File System Standard (primary, fetched):
  *"User agents try to ensure that no partial writes happen, i.e. the file will either contain its
  old contents or it will contain whatever data was written through stream up until the stream has
  been closed"* — typically a temp file swapped in on close. This is the browser-side twin of `17`
  §16.3's atomic write, and it substantiates `43` §3.11's "a copy taken at any moment is either the
  old file or the new one" for the FSA path. A failed save must call `writable.abort()` so the swap
  never lands (§4.3).
- **The save picker's grant is immediate.** Per the WICG spec (primary), a successful
  `showSaveFilePicker` returns a handle whose readwrite permission is already `"granted"`, and the
  pickers require transient user activation and reject on an opaque origin with `SecurityError`.
  The immediacy is a hazard as much as a convenience: a user who picks the **wrong** file has
  granted the page the right to overwrite it, with no further prompt. §8 F1.

### 2.4 The download fallback, exactly

What `<a download>` actually does, because the fallback's precise shape is what the degraded UX in
§4.4 has to be honest about:

| Fact | Status |
|---|---|
| Chromium never overwrites: on a filename conflict it appends ` (1)`, ` (2)`, … up to a cap, then falls back to an ISO-8601 timestamp suffix. There is no way to target a user-chosen directory; bytes land in the browser's download directory | **Primary** — Chromium source, `download_path_reservation_tracker.cc` `CreateUniqueFilename`, fetched and read |
| Firefox and Safari also uniquify rather than overwrite, and also coerce output to the configured Downloads directory unless an ask-each-time setting is on | **Memory** — directionally consistent with the Chromium source, per-browser specifics unverified; do not quote a version or a suffix format for these engines |
| The page cannot observe success, failure, **or cancellation**. The canonical library's legacy path is literally `a.download = name; a.href = URL.createObjectURL(blob); a.click()`, with a documented caveat that *"the legacy save method, unfortunately, doesn't support exceptions"* | **Primary** — GoogleChromeLabs/browser-fs-access source and README, fetched |

So on the fallback path: every save mints a new numbered file, in a directory the user did not
choose, and the application cannot even tell whether the save happened. `32` §13.1 already calls
this outcome *"genuinely poor and there is no fixing it from inside a browser"*, and the research
confirms that judgement is accurate rather than pessimistic.

### 2.5 Handle persistence — per session, not per install, under D1's own rules

The corpus needs one correction here. `43` §3.8's Chromium row says *"the user picks the file once;
subsequent saves overwrite in place"* — which reads as pick-once-per-install. The verified truth:

1. A `FileSystemFileHandle` survives a reload **only** by structured-cloning it into IndexedDB —
   the spec marks the type `[Serializable]` and offers no other persistence (primary). The spec
   itself adds that a handle retrieved from IndexedDB is *"likely to return 'prompt'"* and
   re-granting write access requires `requestPermission()` under user activation.
2. Chrome 122+ adds a three-way prompt ("Allow this time" / "Allow on every visit") that can make
   the re-grant automatic on later visits (primary: the machinery is in current Chromium source).
3. **D1 bans IndexedDB** (`43` §3.8: *"No. None. Not for settings…"*). Therefore the platform's
   pick-once-ever path is unreachable without violating the decision of record.

So under D1 as decided, the Chromium story is: **pick the workspace file once per tab session; save
in place without further prompts until the tab closes; re-pick on next open.** That is what
Excalidraw ships in production with the identical constraint self-imposed — its FSA handle lives in
appState with persistence explicitly disabled (`fileHandle: { browser: false, export: false,
server: false }`, primary, read from source) — so this shape is existence-proven, not speculative.
§10 A1 carries the amendment to `43` §3.8; §3.3 prices the alternative of lifting the storage ban.

### 2.6 `file://` — the code trail and the one test that still has to run

`43` §3.8 carries a VERIFY on whether any of the FSA path functions under `file://`. The research
could not run a browser, but it fetched the enforcement chain from Chromium source (primary):

- `FileSystemAccessManagerImpl::BindReceiver` rejects only origins that are not *potentially
  trustworthy*, and `is_potentially_trustworthy.cc` explicitly returns **true** for the `file`
  scheme.
- The picker gate (`VerifyIsAllowedToShowFilePicker` → `SecurityOrigin::CanAccessFileSystem()`,
  which is `!IsOpaque()`) turns on origin opacity, and Blink's `ShouldTreatAsOpaqueOrigin` does
  **not** treat `file:` as opaque — it is a standard scheme and not in the no-access list. The
  spec's opaque-origin `SecurityError` therefore cannot fire on a `file://` document in Chromium.
- Content-settings gating (`CanObtainReadPermission` / `CanObtainWritePermission`) has no
  additional scheme-level block for `file://`.

**The conclusion "showSaveFilePicker works from `file://` in desktop Chromium" is an inference from
that chain, not an empirical result.** A search-result claim asserting the opposite ("file:// pages
have opaque origins so the API fails") was checked against the fetched source and discarded. The
30-second manual test on the actual demo machine is still mandatory before demo day
(§4.2 step 1), and `43` §3.8's VERIFY closes on that test, not on this chain.

<!-- VERIFY: on the demo machine, from file://, in the demo browser: open a picker, save, reload,
     re-pick, save again. Two minutes. Do this before anything else in §4 is built. -->

Two corpus wordings become casualties of this chain: `43` §2.1's *"Origin: opaque (`file://`)"* and
`32` §13.1's *"the opaque origin a `file://` document gets"* use "opaque" loosely — in spec and
implementation terms Chromium's `file:` origin is a non-opaque local origin, and that distinction
is now load-bearing because the picker gate turns on it. §10 A2.

---

## 3. The options, priced

*margin tab: six ways to put bytes where the user asked*

### 3.1 The comparison table

| | **O1** FSA, in-memory handle | **O2** FSA + IndexedDB handle | **O3** download-only | **O4** browser storage primary | **O5** D4 workspace endpoint | **O6** native shell (Tauri) |
|---|---|---|---|---|---|---|
| Save in place, user-chosen file | desktop Chromium | desktop Chromium 122+ | **never, anywhere** | never (no real file) | **every browser** | everywhere, no browser |
| Pick the file | once per session | once ever | n/a — browser picks Downloads | n/a | once, at launch | native dialog |
| Browser storage used | **none** | IndexedDB (handle) | none | OPFS/IndexedDB (the workspace) | none (OPFS cache optional, D2-style) | none |
| Firefox/Safari experience | numbered downloads | numbered downloads | numbered downloads | works identically | works identically | n/a |
| New artifact classes (`35` §2.1) | 0 | 0 | 0 | 0 | **0** (A4 absorbs it) | +3 signed artifacts + updater |
| Fits `43` D1 as decided | **exactly** | violates §3.8 | fallback row only | violates §3.5 twice | change to `34` §3.6, recorded | ADR-0017 #8 rejects for v1 |
| Verdict (§4) | **demo answer** | rejected | fallback only | rejected | **eventual answer** | trigger-gated; Electron never |

### 3.2 O1 — FSA with an explicit degraded fallback (the progressive pattern, minus browser storage)

What `43` §3.8 already specifies, made concrete by the shipping implementations the research read:
gate on `'showSaveFilePicker' in window`; hold the handle in memory only; every save overwrites in
place through `createWritable()` (spec-atomic, §2.3); everyone else gets the download fallback with
the vocabulary of §4.4. This is browser-fs-access's architecture (its entire progressive switch is
one capability check plus a cross-origin-iframe probe; its modern save path validates a retained
handle via `getFile()` before reuse) and Excalidraw's shipped configuration (handle in memory,
persistence disabled, dead buttons hidden on the fallback path).

- **Works:** desktop Chrome/Edge/Opera; per §2.6's chain, from `file://` (pending the manual test).
- **Fails, exactly:** every non-Chromium browser lands silently on §2.4's fallback unless the UI
  says so out loud — `site-b (14).fathom` accumulating in Downloads, no save-success signal, the
  user as the version control system. On Chromium, the handle dies with the tab: next session
  re-picks, and a user who re-picks the wrong file and saves has overwritten it (§2.3, §8 F1).
- **Costs:** the re-pick ceremony every session; the fallback's permanent poverty.
- **Corpus fit:** implements `43` §3.5/§3.8 and the H19–H20 canary as written; satisfies the
  owner's rows 1–5 in §1 on the browsers where the platform allows it, and honestly degrades where
  it does not.

### 3.3 O2 — persisted handle in IndexedDB + Chrome 122 persistent permissions ("pick once, ever")

The platform can deliver the pick-once-per-install experience (§2.5). The price:

- A serialized `FileSystemFileHandle` — a durable reference naming the workspace's location on disk
  — sits in origin storage on the very machine the owner says must not expose network data. It is
  a forensic artifact ("this machine edits a Fathom workspace, and here is where it lives"), it is
  evictable (silent regression to re-pick), and it fails the canary scan **by design**.
- Restored handles come back `"prompt"` unless the user chose "Allow on every visit", so the flow
  needs a user-activated re-grant path anyway.

**Rejected.** It directly violates `43` §3.8, reintroduces the eviction class `43` §3.5 argument 3
removed, and cannot be smuggled in as a convenience — adopting it would be an explicit, recorded
exception to D1's storage rule. The same verdict covers draw.io's IndexedDB draft cache (their
crash-recovery answer, verified in source): it is precisely the mitigation `43` §4 assigns to
**D2's** OPFS cache, at the wrong boundary for D1. `43` §3.12 F3 priced the no-recovery-cache cost
and this document does not reopen it.

### 3.4 O3 — `<a download>` as the only save path

Works in every engine back to roughly 2013, uniformly, with one code path. And it structurally
cannot meet the demo's core requirement: the browser, not the user, chooses where bytes land, and
no browser overwrites in place through it (§2.4). tldraw ships this shape today — save is a plain
download, and its real store is IndexedDB — which makes it O4's twin, not an independent answer.
**Acceptable as the fallback row it already is (`43` §3.8); indefensible as the primary path for a
demo whose premise is a user-chosen location.**

### 3.5 O4 — browser storage as the primary store (OPFS; the tldraw shape)

The one genuinely cross-engine option — Firefox 111+, Safari 15.2+/26+, Chromium 86+ — because it
is the only file-write surface the two refusing vendors actually ship (§2.2). And it fails the
brief twice in one sentence: the workspace would live in origin-private storage the user never
chose and cannot see, evictable by the browser, **on the demo machine, outside the sealed file** —
the exact at-rest exposure the owner excluded, in the exact stores `43` §3.5 bans by name. Under
`file://` there is not even a stable origin to key it to. **Rejected without a residual.** It is
listed because it is the industry's honest alternative (tldraw's primary store, Excalidraw's
autosave layer, draw.io's "Browser" mode — all verified in source): if you refuse FSA's asymmetry,
uniform browser storage is what you ship. `43` already refused that trade.

### 3.6 O5 — the corpus's own native path: `fathom serve` grows a workspace endpoint

The shape: `fathom serve --workspace ~/lab/site-b.fathom --open`. The browser page runs everything
it runs today — unlock, graph, engines, sealing in WASM — and PUTs **sealed bytes** to the loopback
CLI, which writes them to the user-specified path with `17` §16.3's atomic write. Plaintext never
crosses loopback; the file the user chose is honoured on **every** browser, Firefox and Safari
included, because the write happens in the native process the project already ships (A4, phase 0,
`71` §3.3).

- **Works:** everywhere a desktop browser runs. Save-in-place, no download dialog, no FSA
  dependency, no new artifact class — `35`'s signing and reproducibility story is untouched, and
  `42` is fully satisfied (the CLI is the static musl binary its §9.4 check 12 already tests).
- **Fails, exactly:** it contradicts the current spec **by design**. `34` §3.6 defines
  `fathom serve` as *"No workspace passes through this process. No API. No upload."* — the rule
  that keeps it from growing features. Accepting writes means a recorded amendment to `34` §3.6 and
  `43` §7.8, plus the loopback hardening the corpus already designed for the AI sidecar (`24` §3.7:
  per-launch bearer token delivered outside argv, Host validation, one allowed origin) — without
  which a hostile local page could overwrite the workspace via DNS rebinding. And the user must
  launch a terminal binary before a browser: `43` §7.8's own words, *"a lower bar than Docker and a
  higher bar than 'open a file'"*. The air-gapped jump-host persona who cannot run binaries gets
  nothing from this path and stays on O1's story.
- **Corpus fit:** the strongest in the field. `34` §3.5 already credits this shape as *"the whole
  reason the decision lands where it does"*, and `43` §3.13 row 4 names D4 as the no-limit recovery
  for "save in place, outside Chromium". §4.5 makes it the eventual answer; §10 A3 stages the
  amendment so it is pre-written when the trigger fires, not improvised.

### 3.7 O6 — the native shell: Tauri measured, Electron never

**Tauri**, measured rather than estimated: a minimal `tauri = "2"` probe resolved this session to a
**233-crate** normal-dependency closure on x86_64-linux (250 with build deps; 419-package union
lockfile). `35` §5.1 C2 caps the entire shipped closure at **≤160** and estimates the whole current
product at ~130–170 — the shell alone roughly triples the closure before Fathom's own code counts.
On Linux it dynamically links the system webkit2gtk (never `42` §9.4's static musl shape), and it
adds three signed artifacts plus an updater to `35` §2.3's already-carved-out signing asterisk.
ADR-0017 #8 pins "no desktop app in v1" and reserves the one shell that may ever exist for the AI
transport (ADR-0020, `24` §3.7); `73`'s knot table warns the desktop cluster unties in one
direction only. **If the owner wants Tauri anyway, the honest route is to invoke `34` §3.5's
revisit trigger deliberately, merge with ADR-0020's shell so there is one desktop artifact class
ever, and accept the C2 fork in writing.** A demo preference is not yet the trigger's evidence.

**Electron** is ruled out categorically, three times over, and `42` is the document that does it
despite its title: Z1 forbids any JavaScript runtime in shipped artifacts and Electron embeds Node
— the governing rule *"NODE IN THE ARTIFACT WAS NEVER THE QUESTION"* holds only because it was
structurally impossible, and Electron is the thing that makes it possible; Z2 forbids npm in
artifact-producing stages and Electron's packaging ecosystem is npm-native; `35` C7 forbids C/C++
in the shipped closure and Electron ships two of the largest C++ codebases in existence. draw.io's
desktop app (Electron, verified in source, built because the web save story could never satisfy
their security segment) is the cautionary precedent that the trigger plausibly fires someday — and
the proof that when it does, the answer is still not Electron.

---

## 4. RECOMMENDATION — the demo answer and the eventual answer

*margin tab: the decision*

### 4.1 The two answers, named

**RECOMMENDATION — for the demo: O1 on D1, with desktop Chromium stated as a prerequisite in one
sentence, `fathom serve` rehearsed as the fallback origin, and §4.3's defensive mechanics. For the
product, when `34` §3.5's trigger fires ("measurable loss of user work through the save path"): O5,
the D4 workspace endpoint, whose amendment §10 A3 pre-writes. They differ because the demo audience
can be told which browser to open; the product's cannot.**

The demo prerequisite sentence, in full: *"The demo requires Chrome or Edge on a desktop."* That is
the entire cost of the Chromium requirement, paid once, in the calendar invite. §12.2 defends it.

### 4.2 The demo sequence, in order

1. **Run the `file://` smoke test on the demo machine** (§2.6's VERIFY). Two minutes. If it passes,
   the demo runs from `file://` — the purest form of "no server side". If it fails, the demo runs
   from `fathom serve` on loopback (`34` §2.2 mode B headers, still no server in the owner's
   sense — no workspace passes through it in its current, unamended form). Rehearse both before
   demo day; never discover the answer live.
2. **Unlock:** the user picks `site-b.fathom` with `showOpenFilePicker`, types username +
   passphrase (§5). The masthead states the posture (`34` §3.7's control, unchanged).
3. **First save:** on the user's click, acquire the writable **immediately** (§4.3 rule 1), seal,
   write, close. Subsequent saves reuse the in-memory handle — overwrite in place, no prompts, an
   explicit gesture every time (`43` §3.8: no autosave; do not copy draw.io's handle-gated
   autosave).
4. **Tab closes:** the handle dies, origin storage is empty (canary-verified), the file on disk is
   the only artifact. Next session re-picks. The unsaved-count masthead and armed `beforeunload`
   (`43` §3.8) remain the only safety net; `43` §3.12 F3's loss window is accepted, not reopened.

### 4.3 The save path mechanics — four rules from shipping code

Each rule is lifted from source read this session, not invented here:

| # | Rule | Why, and whose scar |
|---|---|---|
| 1 | **Acquire the picker/writable on the user's gesture, before sealing.** Sealing and packing take real time, and the pickers require transient user activation — generate the bytes after the activation is spent and the picker is refused | draw.io's `LocalFile` carries an explicit comment: data generation can outlive the activation window, blocking the prompt. Their fix is `createWritable()` before serialising; ours is picker-then-seal-then-write |
| 2 | **Before writing, re-validate the handle and check for concurrent modification**: `handle.getFile()`, compare `lastModified` against the value cached at open/last save; on mismatch, refuse with `43` §3.12 F7's diff-summary flow | browser-fs-access re-validates via `getFile()`; draw.io compares `lastModified` and enters a conflict state instead of clobbering. This is F7's exact scenario, solved in production code |
| 3 | **On any write error, `writable.abort()`** — discard the swap file so a failed save never half-writes the target (§2.3's spec atomicity only holds if the stream is closed or aborted, never abandoned) | draw.io aborts on error; the whatwg/fs temp-swap semantics make this the difference between "old file intact" and "undefined" |
| 4 | **Verify the picked file is the workspace it claims to be before the first save into it**: the header's workspace id + generation must match the open workspace, else refuse | Fathom-specific, closing §8 F1: the save-picker grant is immediate readwrite (§2.3) and a wrong pick must not become a destroyed file |

### 4.4 The degraded path, in plain words

What a Firefox or Safari user experiences under O1: the open flow works (`<input type="file">` is
universal). The moment they save, a numbered copy lands in their Downloads folder — not the file
they picked, not the folder they chose — and every subsequent save adds another. The application
cannot detect whether the save succeeded or was cancelled (§2.4). Their newest download **is** the
workspace, and re-opening means picking that newest file by eye.

The product's obligations on this path, all vocabulary, all verified against what Excalidraw and
draw.io ship:

- **Rename the verb.** The button is not "Save"; it is **"Export a copy"** (Excalidraw hides its
  dead "Save as" button and reframes the card as export; draw.io names its mechanisms "Device" vs
  "Download" in the storage chooser). "Saved to `site-b.fathom`" is shown only when a handle
  actually wrote in place.
- **Name the file usefully.** Workspace name plus a monotonic counter, so the newest copy is
  identifiable in Downloads (`32` §13.1 already requires this).
- **Never clear the unsaved-change count on a legacy export** — the export cannot confirm success,
  so the masthead treats it as a copy taken, not a save completed (§8 F9).
- **Show the permanent notice, once per session, at first save.** The exact sentence the product
  shows, and it is written as permanent because §2.2 shows it is:

> **"This browser cannot write back to the file you chose. Each save will produce a new, numbered
> copy in your Downloads folder — the newest copy is your workspace. This is a browser policy, not
> a bug: Firefox and Safari have declined the capability that lets a page overwrite a file in
> place. To save in place, use Chrome or Edge on a desktop, or the Fathom CLI."**

No "yet", no "currently", no "coming soon". The masthead register (`43` §3.8) applies: a fact, in
the same place, always.

### 4.5 The eventual answer, and its trigger

When the fallback path measurably loses a user's work — `34` §3.5's and ADR-0017's own named
revisit trigger — the answer is **O5**, not the desktop shell: `fathom serve` gains a
narrowly-scoped, token-authenticated workspace-IO endpoint (ciphertext only, loopback only,
hardening per `24` §3.7's invariants), and every browser gets save-in-place at zero new artifact
classes. The desktop shell remains where ADR-0017 #8 and ADR-0020 put it: gated on the AI
transport, merged into one shell if it ever exists, never Electron. §10 A3 carries the pre-written
amendment so the change is a decision, not a scramble.

---

## 5. The username — where it enters the KDF, and what it is not

*margin tab: identity is context, not entropy*

### 5.1 What exists today, and the one place a username can land

`32`'s scheme, unchanged by this document: passphrase (UTF-8 NFC) → `A2id(pw, kdf_salt, m, t, 1,
32)` with a **random 128-bit per-workspace salt** stored cleartext in the keyholder descriptor and
authenticated as `aad_ext` → the unlock key `UK` is the parent for the `Passphrase` keyholder
envelope → `RK_e` → `WK_e` → per-record keys. `derive_record_keys` (`32` §3.2) already folds every
descriptor byte into HKDF-Expand's `info`, so the envelope will not open if a single byte differs.
No new primitive is needed to bind a username; the only question is whether it is **stored** (as
descriptor content) or **typed** (as derivation context that exists nowhere in the file).

### 5.2 RECOMMENDATION — the username is typed HKDF context, never stored

**RECOMMENDATION — the username is presented at every unlock like the passphrase, normalised by one
pinned function, folded into the keyholder parent derivation, and stored nowhere in any form.**

```text
UK   = A2id(passphrase, kdf_salt, m, t, 1, 32)          # 32 §4.2, unchanged — the salt
                                                        # stays CSPRNG(16), never identity
UK'  = HKDF-Expand(
         HKDF-Extract("fathom/v1/user", UK),
         "user|" || normalize(username),
         32)                                            # UK' replaces UK as the parent for
                                                        # the Passphrase keyholder envelope

normalize(u) = case_fold(trim(nfc(u)))                  # one function, in the format spec,
                                                        # with cross-implementation vectors
                                                        # in 32 §16
```

Three properties, stated in the order they matter:

1. **The workspace carries no identity.** Not cleartext, not hashed. Every copy — the file on the
   demo machine, the copy on a USB stick, a future sync server, every git commit — is exactly as
   anonymous as it is today. This is ADR-0014's sealed-`label` reasoning applied a fortiori: that
   ADR moved *"Kate's laptop"* inside the sealed secret because cleartext personal data at the
   processor is indefensible to a DPO (`37` classes usernames as person-identifying, and its §2.5
   refuses to let the parser silently ingest `system login user` for the same reason).
2. **Domain separation for free.** Two workspaces, or two users, sharing an identical passphrase
   derive unequal unlock parents. Cross-file key equality and keyholder substitution confusions
   die here.
3. **The identity join key for §6 exists and costs nothing now.** A future IdP subject / UPN maps
   to the same normalised string, which maps to a keyholder — without identity ever entering the
   confidentiality path in a form a server could use.

The info strings above are format bytes: `32` §2.4 — *"They are part of the format. Changing one is
a `format_version` bump."* This decision therefore lands **before first ship** or it costs a
version. §9 Q1.

### 5.3 What the username is NOT — the table the UI must obey

| The username is not | Because | The rule that says so |
|---|---|---|
| **A secret** | It is on badges, in AD, in logs, in the demo invite. Treat it as public even though it is never stored | `32`'s governing rule: the passphrase is the whole system |
| **Entropy** | Folding a guessable public string into HKDF adds approximately zero bits and must be advertised as zero. The unlock screen must not imply two fields are stronger than one | `32` §4.7: *"Argon2id multiplies the attacker's per-guess cost by a constant. It does not add bits"* — and neither does a username |
| **The Argon2 salt** | Identity-derived salts are deterministic and public: an attacker who knows the username can precompute before ever seeing the file. Bitwarden's `emailToSalt` (verified in source: PBKDF2 salt = normalised email; Argon2id salt = SHA-256(email)) is a compatibility artifact of an account system, not a virtue; Fathom's random 16-byte salt is strictly stronger and stays | `32` §4.2; the 1Password lesson (secondary): the component that adds bits is **random key material** distributed alongside identity — the ~128-bit Secret Key — never the identity itself |
| **A verified claim** | In D1 nothing checks it. It either contributes to a parent that opens the keyholder or it does not | `33` §3.1, workspace-key row: *"Who checks it: Nobody. It either decrypts or it does not"* |
| **An authorisation boundary** | Holding `WK_e` holds every record; no username partitions that | `33` §3.4, `17` §17 |
| **An account** | There is no server in the demo, and when there is one, the account credential is OPAQUE or OIDC and never in the confidentiality path | `33` §3.1, §3.2 (the `export_key` is deliberately discarded), §3.3 |

### 5.4 The cost, stated: a new indistinguishable-typo class

A wrong or differently-normalised username produces `WrongKey` — indistinguishable from a wrong
passphrase. ADR-0014 just spent an ADR making tampering distinguishable from typos, and this
proposal quietly adds a new typo class to the `WrongKey` bucket. Worse: a normalisation mismatch
between two implementations is a **permanently unopenable workspace** — the Bitwarden/1Password
lesson (both normalise identity before derivation, verified/secondary respectively) is that the
normalisation function is format, not UI. Mitigations, all mandatory if §9 Q1 lands (a): one
normalisation function specified with byte-level test vectors in `32` §16; the unlock error says
*"wrong username or passphrase — check both fields"*; and the username field is pre-filled with the
OS username **as a suggestion only**, never silently used.

### 5.5 The rejected storage variants

| Variant | Why rejected |
|---|---|
| **Cleartext username in the descriptor** ("it's never a secret, so store it") | "Never a secret" is true; "therefore fine in cleartext" does not follow. It recreates byte-for-byte the defect ADR-0014 corrected for `label`: personal data in every copy, at any future sync server, in every backup, forever. The corpus has already litigated exactly this trade, in an accepted ADR, and decided. The only pre-unlock identifier stays the opaque random `id: [u8;16]` |
| **`BLAKE3(normalize(username))` truncated, as a descriptor hint** (padded per ADR-0014; enables "wrong username" as a distinct error and multi-keyholder pre-selection) | Usernames are low-entropy, so the hash is offline-guessable from any copy — the corpus's own precedent label applies: `33` §2.3 calls its published-salt `username_hash` *"obfuscation, not protection… do not describe it as more."* It also needs a new leak-register row in `31` §7/`32` §6.5. Defensible if the multi-keyholder unlock UX (`32` §7.4's trial-decryption cost) ever hurts enough; not for the demo. §9 Q2 |

---

## 6. The SSO bridges the username keeps open

*margin tab: IdPs authenticate; they do not decrypt*

### 6.1 The structural fact, stated plainly

An AD, TACACS, or OneLogin authentication yields **no key material**. An OIDC or SAML assertion is
an ephemeral, server-verified claim; nothing in it is simultaneously *stable*, *secret from the
IdP*, and *derivable client-side* — so SSO alone can never decrypt a zero-knowledge workspace, and
any product that appears to do it has hidden one of four patterns below. This is not a Fathom
limitation; it is why `33` §3.1's separation decision exists (*"the single strongest practical
argument and it will come up in the first enterprise conversation"*), why `33` §3.2 discards
OPAQUE's `export_key`, and why `33` §3.3's enterprise path *"changes nothing below"*.

One scoping note, from memory and flagged as such: TACACS+ is device-AAA for network equipment, not
a web-SSO protocol; the realistic AD bridge is LDAP/Kerberos fronted by an OIDC/SAML broker (ADFS,
Keycloak, OneLogin itself). The owner's "AD / TACACS / OneLogin" list collapses, for this product,
to "an OIDC/SAML IdP" — which is exactly what `33` §3.3 already speaks.

### 6.2 The four patterns, each verified in shipping form

| Pattern | Shipping proof (source class) | Zero-knowledge survives? | Fit for Fathom |
|---|---|---|---|
| **(a) SSO gates access; a separate secret decrypts** | Bitwarden's default "Login with SSO" (primary: clients repo @ d5e021e) | **Yes** | Already Fathom's written position: `33` §3.3 over `33` §3.1. The username of §5 is the join key: IdP subject/UPN → `normalize()` → the same derivation context → keyholder. Nothing to build today except keeping the normalisation stable. The recurring objection — "why am I still typing a passphrase after SSO" — is the pattern's honest cost |
| **(b) Escrowed key released after SSO** | Bitwarden Key Connector (primary: `setMasterKeyFromUrl` literally downloads the master key from the connector post-SSO) | **No — broken for the connector's operator**, their backups, and anyone who compromises that host | The escrow host becomes exactly the single machine whose compromise exposes everything — the owner's stated exclusion, self-defeated. Stays *possible* forever under §5.2 (escrow is just another keyholder over `RK_e`), and stays off the roadmap |
| **(c) Passkey PRF — the authenticator holds the secret** | Bitwarden PRF unlock (primary: fixed eval input, HKDF-expanded into unwrap keys) — the same shape as Fathom's own `WebAuthnPrf` keyholder, `32` §12.2 | **Yes** — the PRF output comes from the authenticator's `hmac-secret`, never transits the IdP; the W3C spec's context-separation hashing (`SHA-256("WebAuthn PRF" ‖ 0x00 ‖ input)`) is confirmed against the spec source (primary), as is the two-ceremony setup `32` §12.3 mandates | The credible "feels like SSO" bridge: enterprise-managed passkeys, OR-composed so the passphrase floor stands. Per-platform unevenness is real (`32` §12.3's table is corroborated by the July-2026 secondary sources nearly row-for-row; its VERIFY marker **stays**, because those are vendor guides, not release notes). `32` §12.4's warning applies unreduced: a synced passkey relocates the secret's root into Apple/Google escrow, and the UI must name which kind it is |
| **(d) Recovery agents / org reset** | Bitwarden trusted-device + org reset path (primary) — `32` §11.2's Shamir escrow is Fathom's version | **No — k shareholders decrypt everything, forever** | The corpus already used the correct word: *"It is a threshold backdoor, and the setup flow should use that word."* Off by default, stays off, ADR-0014 #6's re-armed-paper footgun noted |

### 6.3 What forecloses what

| Choice made today | Doors it closes |
|---|---|
| §5.2 typed-context username | **None.** Every pattern above re-presents the username at login regardless of who authenticated it; (b), (c), (d) are additional keyholders over `RK_e`, which `32` §3's hierarchy accepts by construction |
| Storing identity cleartext in the envelope (rejected, §5.5) | The DPO conversation, in every backup, forever — and with it the clean `37` story pattern (a) depends on |
| Deriving any key from IdP-held material (never proposed) | Zero knowledge itself. This is the one genuinely irreversible door and the reason §6.1 is written in the declarative |
| Requiring SSO before unlock (a server-side gate) | The demo posture (no server side) and D1 itself. Access-gating is a served-mode feature; the file must always open with username + passphrase alone |

---

## 7. The home-lab walk-through

*margin tab: the owner's scenario, end to end*

The scenario the owner named: the demo machine in the home lab is compromised; the workspace file
is exfiltrated. Under §4's demo answer plus §5.2's username scheme:

**What is on the machine.**

| Artifact | What it yields an attacker |
|---|---|
| `fathom-<ver>.html` | Nothing — it is the published artifact, one file, one hash; a tampered copy fails its own CSP hash and does not execute (`43` §3.12 F8) |
| `site-b.fathom` | One sealed workspace: Argon2id (FLOOR, per-workspace random salt) → ChaCha20-Poly1305, key-committing, padded (ADR-0014). The holder learns the size and the format version (`17` §2.2) — no device names, no topology, no findings, **no identity**: the username is not in the file in any form |
| Numbered fallback copies in Downloads, if the fallback was ever used | The same envelope, older generations. Each historical copy is separately attackable under whatever key epoch sealed it (`32` §4.7 #3) — more copies is more ciphertext, not more plaintext |
| Browser profile (origin storage) | **Empty**, by decision and by CI canary (`43` §3.8, `34` §10 H19–H20). No OPFS, no IndexedDB, no serialized file handle naming the workspace's path — the artifact O2 would have left is the one this walk-through exists to show absent |
| Process memory, if the compromise is live during an unlocked session | Everything — graph, keys, plaintext. `31` §6.2 owns this and no storage decision changes it: a compromised endpoint with an open session is lost in every design. The mitigation is operational: lock when not presenting, dedicated browser profile, or the CLI |

**The offline attack, with the numbers the corpus already publishes.** The exfiltrated file's only
defence is the passphrase (`32`'s governing rule). At the shipping FLOOR, ADR-0014's honest table:
a memorable ~30-bit sentence falls in ≈2.9 hours to 10⁴ GPUs; six EFF-wordlist words survive
geological time. The username adds approximately zero bits to this search (§5.3) and must never be
counted. **Operational consequence for the demo, binding: the demo workspace uses a generated
six-word passphrase (`32` §4.7 #1), not a memorable sentence invented at the kitchen table.**

**What each rejected option would have added to the haul:** O2 — a durable origin-storage artifact
naming the workspace's path and marking the machine as a Fathom editor. O4 — the workspace
ciphertext itself in browser storage, plus an eviction class. Pattern (b) — a second machine whose
compromise decrypts everything with no passphrase search at all. The recommended scheme adds
nothing: the file, and only the file, was always the target, and the file is sealed.

---

## 8. Failure modes

Residuals on the `none | bounded | material` scale `43` §3.12 uses.

| # | Failure | Symptom | Handling | Residual |
|---|---|---|---|---|
| **F1** | User re-picks the **wrong** file at session start and saves — the save-picker grant is immediate readwrite (§2.3) | An unrelated file is overwritten with a sealed workspace | §4.3 rule 4: header workspace-id + generation checked before the first write into any picked file; mismatch refuses with a named dialog. For save-as-new, an explicit "create new workspace file" path, never the same button | `bounded` — rule 4 closes the workspace-over-workspace case; overwriting a deliberately chosen non-workspace file via "create new" remains user intent |
| **F2** | Transient user activation expires before the picker is called (seal-then-pick ordering bug) | First save fails with `SecurityError` after a long seal | §4.3 rule 1: picker on the gesture, seal after. Regression-tested with an artificially slow seal | `none`, once the ordering is a test |
| **F3** | Non-Chromium visitor never notices they are on the fallback | Downloads fills with numbered copies; user edits an old one | §4.4 in full: renamed verb, the permanent notice, workspace-name + counter filenames, unsaved count never cleared by an export | `material` — the fallback is structurally poor (§2.4); this is priced, not fixed |
| **F4** | The workspace file changed on disk under an open session (second tab, another tool, a sync client) | Silent last-writer-wins | §4.3 rule 2: `getFile().lastModified` compared before every write; mismatch enters the F7 conflict flow (`43` §3.12) | `bounded` — detection, not merge; D1's one-writer model stands |
| **F5** | Write fails mid-save (disk full, device removed) | Potentially torn file | §2.3 spec atomicity + §4.3 rule 3 `writable.abort()`: the file is the old one or the new one | `none` on the FSA path; the fallback path never overwrites anything |
| **F6** | Brave, or any Chromium with FSA disabled | Capability check fails despite a Chromium UA | Detection is by capability, never UA (§2.1); the user lands on §4.4's path with its honest notice | `bounded` — correct behaviour, surprising browser |
| **F7** | The §2.6 inference is wrong on the demo machine: pickers refuse under `file://` | Save falls to the download path mid-demo | The smoke test (§4.2 step 1) runs before demo day; `fathom serve` is the rehearsed fallback origin | `none`, if and only if the rehearsal happened |
| **F8** | Username normalisation mismatch — between sessions, keyboards, or future implementations | `WrongKey` for a correct passphrase; at worst a permanently unopenable workspace | §5.4: one pinned `normalize()` in the format spec, byte vectors in `32` §16, "check both fields" error copy | `bounded` — the typo class is real and permanent; the vectors keep it from becoming the unopenable-workspace class |
| **F9** | Legacy export cannot report success or cancellation (§2.4) | The app believes work is saved when the user cancelled the download | The unsaved count is cleared only by a confirmed in-place write; exports never clear it (§4.4) | `bounded` — honest state, mildly nagging UI |

---

## 9. Open decisions

| # | Decision | Options | Leaning |
|---|---|---|---|
| **Q1** | Does the username enter the KDF for the demo, or is the field UI-only until the format vectors exist? | (a) §5.2 now, vectors in `32` §16 before first ship (b) UI-only placeholder, derivation unchanged, format bump later | **(a)** — `32` §2.4 makes the info string a format matter; deciding after ship costs a `format_version`. If (b), the field must be visibly labelled as not yet part of the encryption, which is an awkward sentence to defend |
| **Q2** | The hashed-username descriptor hint (§5.5) | (a) never (b) add when multi-keyholder unlock UX hurts | (a) for the demo; (b) needs a new leak-register row first |
| **Q3** | When the trigger fires, does `fathom serve` gain the workspace endpoint (O5) or does the trigger re-open the shell debate? | (a) O5, amendment pre-staged (§10 A3) (b) re-litigate | **(a)** — zero new artifact classes against three signed ones; `34` §3.5 already wrote the conclusion |
| **Q4** | Demo origin | (a) `file://` if the smoke test passes (b) `fathom serve` regardless | (a), with (b) rehearsed. `file://` is the purer demo of "no server side" and F8/`43` §3.12's tamper story is identical either way |
| **Q5** | Is Chrome-for-Android 132+ support claimed anywhere user-facing? | (a) no — desktop-only claim (b) claim it | (a). The two primary sources disagree in freshness (BCD says 132+, caniuse still says "n"); a support claim that eats a workspace is the one error class this document exists to prevent. Test on a real device before ever claiming it |
| **Q6** | IndexedDB functionality under `file://` | unresolved — no primary source consulted | Moot under D1's storage ban and recorded so it stays moot: if the ban is ever relaxed (O2), this becomes load-bearing and must be tested first |

---

## 10. Proposed amendments to other documents

**A1 — `43` §3.8, the Chromium save row.**
*The text:* "The user picks the file once; subsequent saves overwrite in place."
*The correction:* once **per tab session**. Cross-reload persistence requires structured-cloning
the handle into IndexedDB (spec, §2.5), which §3.8's own storage rule bans — so the row's truth
under D1 is pick-per-session, and the platform's pick-once-ever (Chrome 122+) is reachable only by
a recorded exception to D1. Also qualify "Chromium-family" as **desktop Chromium, excluding Brave
at defaults** (§2.1). This closes half of that section's VERIFY; the `file://` half closes on
§2.6's manual test.

**A2 — the word "opaque" for `file://` origins, in `43` §2.1, `43` §3.3, and `32` §13.1.**
Chromium treats `file:` as a non-opaque, potentially-trustworthy local origin (§2.6, source-read),
and the FSA picker gate turns on exactly that distinction. The loose usage was harmless when
nothing depended on it; now something does. Reword after the smoke test, and re-examine `32`
§13.1's "IndexedDB blocked under file://" claim (inherited from `24` §2.2), which this research
did not verify and which Q6 quarantines.

**A3 — `34` §3.6 and `43` §7.8, pre-staged for the day `34` §3.5's trigger fires.**
Add, as a dormant amendment: `fathom serve --workspace <path>` accepts PUT of sealed workspace
bytes and writes them atomically (`17` §16.3) to the launch-named path — ciphertext only, loopback
only, per-launch bearer token delivered via a 0600 file and never argv, Host validation as today,
one allowed origin (`24` §3.7's invariants applied to a second listener). Until the trigger fires,
`34` §3.6's "No workspace passes through this process" stands unamended.

**A4 — `32` §16, contingent on Q1(a):** username normalisation vectors (NFC, trim, case-fold —
including a non-ASCII case and a trailing-space case) join the cross-implementation set, and `32`
§7.4's unlock-error copy gains the two-field wording of §5.4.

---

## 11. Sources consulted

Per the research-quality bar this document was commissioned under: primary means fetched and read
this session; secondary means a search summary of an unreachable primary; memory means training
recall, flagged inline wherever used and never load-bearing.

| Claim cluster | Source | Class |
|---|---|---|
| FSA/pickers support matrix; `<a download>` support | caniuse `features-json` (`native-filesystem-api.json`, `download.json`), raw | Primary |
| Picker/OPFS per-browser versions incl. Chrome Android 132, Firefox 111, Safari 15.2/26 | MDN browser-compat-data JSON (`api/Window.json`, `FileSystemHandle`, `FileSystemFileHandle`, `FileSystemWritableFileStream`, `StorageManager`) | Primary |
| Mozilla positions 154 (negative, verbatim rationale), 562 (positive), 738 (defer) | mozilla/standards-positions `merged-data.json` + issue 738 | Primary |
| WebKit positions 28 (oppose, security; OPFS carve-out wording), 121 (oppose) | WebKit/standards-positions `summary.json` + issue 28 | Primary |
| Picker preconditions (opaque origin, activation), `[Serializable]`, IndexedDB-restored handles "likely prompt", save-picker readwrite grant | WICG/file-system-access `index.bs` | Primary |
| Atomic write-then-swap semantics; OPFS scoping | whatwg/fs `index.bs` | Primary |
| `file://` trustworthiness chain; picker origin gate; Chrome 122 persistent-permission machinery; content-settings gating; download uniquifier `(N)`-then-timestamp | Chromium source: `file_system_access_manager_impl.cc`, `is_potentially_trustworthy.cc`, `global_file_system_access.cc`, `security_origin.cc/h`, `chrome_file_system_access_permission_context.cc`, `download_path_reservation_tracker.cc` | Primary |
| Progressive pattern: one-check support gate, `existingHandle` re-save with `getFile()` validation, exception-less legacy save, no persistence story | GoogleChromeLabs/browser-fs-access source + README | Primary |
| Excalidraw: in-memory handle with persistence disabled, hidden dead buttons, export vocabulary, browser-storage autosave layer | excalidraw source (`filesystem.ts`, `appState.ts`, `actionExport.tsx`, `JSONExportDialog.tsx`, `en.json`, `LocalData.ts`) | Primary |
| draw.io: capability gate, Device/Download naming, handle-gated autosave, activation-window comment, `lastModified` conflict check, `abort()` on error, IndexedDB drafts, Electron desktop rationale | jgraph/drawio + drawio-desktop source | Primary |
| tldraw: IndexedDB-primary, download-only save | tldraw source | Primary |
| VS Code Web's capability gate | microsoft/vscode `webFileSystemAccess.ts` | Primary |
| Tauri architecture, system-webview identities, webkit2gtk requirement; **measured 233-crate closure** for a minimal `tauri = "2"` probe (cargo 1.94.1) | tauri README + tauri-cli README + a resolved (not built) probe project | Primary (measurement this session) |
| Bitwarden: `emailToSalt`, PBKDF2/Argon2id salt handling, Key Connector's post-SSO key download, PRF unlock, trusted-device + org reset | bitwarden/clients @ d5e021e; bitwarden/sdk-internal `kdf.rs` | Primary |
| WebAuthn PRF construction and creation-time-eval caveat | w3c/webauthn `index.bs` | Primary |
| Chrome 122 blog details; Chrome 132 Android launch date; Safari 26.0 release date; Brave FSA-off default; Firefox bug 1246236 still open; July-2026 PRF support matrix; 1Password two-secret model | search summaries (developer.chrome.com, webkit.org, Brave tracker, Corbado/Yubico guides, agilebits whitepaper) — each corroborated by a primary where one exists | Secondary |
| Firefox/Safari download uniquification specifics; Electron artifact sizes; TACACS+ scope; 1Password derivation fine detail | training memory, flagged at point of use | Memory |
| Every corpus citation (`43` §§2–3, §7; `34` §§3.5–3.7; `32` §§2–4, §7.4, §12, §13; `33` §§2.3, 3; `35` §§2, 5; `42` §§1, 9; `71` §3.3; `24` §3.7; `73`; ADR-0014; ADR-0017) | read from this repository during writing | Primary |

Not done, and stated so it cannot be mistaken for done: no live browser test of any kind ran during
the research — the `file://` picker conclusion is a source-chain inference (§2.6), and the demo
sequence's first step exists because of that gap.

---

## 12. Disagreements

### 12.1 Username + password is buying ergonomics and future plumbing, not security — and the product must say so

What I actually think: the owner's instinct to add the username is right for the roadmap and wrong
if anyone ever presents it as strengthening the encryption. It buys domain separation, a clean IdP
join key, and an unlock screen that matches enterprise muscle memory. It buys approximately zero
bits — the security of the exfiltrated file is the passphrase, entirely, exactly as `32`'s
governing rule states, and the honest number for the username's contribution to §7's attack table
is a rounding error on a public string. The one place this opinion has teeth: the unlock screen
must not render two fields as two locks. One lock, one hint of who is opening it.

### 12.2 The demo should simply require Chromium — yes, say it and stop apologising

The alternatives to the one-sentence prerequisite are: a degraded path the owner would be
demonstrating instead of the product; a loopback binary that dilutes "no server side" before the
first slide; or a native shell that triples the dependency closure the security story is built on
(§3.7, measured). Against that, "The demo requires Chrome or Edge on a desktop" costs one line in
an invite the owner controls. Firefox and Safari users are not being snubbed; they are being told
the truth §2.2 documents — their vendors declined this capability, on the record, with reasoning
those vendors find principled. The degraded path exists, is honestly worded (§4.4), and is nobody's
demo.

### 12.3 A support claim is a safety claim in this document, and the corpus's shorthand was too loose

"Chromium only" appears three times in the corpus (`43` §3.4, §3.8; `32` §13.1) and all three mean
"desktop Chromium, at least 105, not Brave at defaults, per-session handle" — four qualifiers the
shorthand drops. Normally shorthand is fine. Here a reader who ships the shorthand produces a save
path that eats a workspace on a tablet or in Brave, which is why §2 carries source classes per row
and §10 A1 asks `43` to carry the qualifiers. The convention I would add to `conventions.md`: **a
browser-support claim in a decision document names the engine, the form factor, and the earliest
version, or it cites a row that does.**

### 12.4 The residual scale, again

This document uses `none | bounded | material` in §8, as `43` §3.12 does, and the conventions still
pin no residual scale. `43` §14.1 already proposed pinning `none | bounded | material |
unmitigated`; this document adds one more voice and no new proposal.

No convention in `conventions.md` is violated by this document. The terminology table's ban on
"database" and bare "file" for the workspace is obeyed (§1); the owner's own phrase "workspace
database" is corrected rather than echoed, which `conventions.md` requires be done in the open —
here, and in §1.
