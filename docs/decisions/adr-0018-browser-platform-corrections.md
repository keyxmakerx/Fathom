# ADR-0018 — Browser platform corrections: WebAuthn, `img-src`, and the link rule

> **Status:** Accepted
> **Date:** 2026-07-28
> **Register entry:** new — raised by `83` P1, `81` §7.1, §5.1.2, §5.1.3, `83` §7 items 8–9
> **Reversal cost:** R2 — header policy and one server behaviour
> **Supersedes:** the `publickey-credentials-get` row of `34` §2.2's Permissions-Policy

## Context

`34-browser-hardening.md` is the second-strongest document in the corpus. `81` §7 credits §1.1's
concession, §2.11's list of what CSP does not stop, §4.6's *"anyone who describes this as a defence
against XSS is wrong"*, and §9.4's decision to render no external links at all. It has one hole, one
unpriced channel, and one collision with a sibling.

**1. The hardware-key keyholder is structurally impossible in every artifact that can open a
workspace** (`83` P1). `34` §2.2 sets `Permissions-Policy: … publickey-credentials-get=() …` in
modes B, C and D, and CI check H11 asserts *"every listed feature is denied"*. An empty allowlist on
`publickey-credentials-get` denies WebAuthn assertions **to the top-level document**, not only to
frames. `32` D13 ships **WebAuthn PRF as an additional keyholder, on by default**, and §12.3 requires
*"register the credential, then immediately perform a `get()` to obtain the PRF output"*.

As written, `publickey-credentials-create` is **not** denied — so enrolment works and unlock does
not, which is the worst of the three available outcomes: a user enrols a passkey and gets a workspace
they cannot open with it, and CI enforces the impossibility.

**2. `img-src 'self'` in modes C/D is an egress channel to the server the threat model calls
untrusted** (`81` §7.1). In those modes `'self'` **is** the sync service — the component `31` §4.1's
diagram labels `SYNC SERVICE — UNTRUSTED BY DESIGN`. After an XSS in mode C (in scope: `31` §5.1 row
16, §8.1 A2.5) the payload needs no `sandbox` escape, no navigation and no third-party origin:

```js
new Image().src = '/' + btoa(plaintextGraph);   // permitted by img-src 'self'
```

and the plaintext lands in the sync service's HTTP access log, in the clear, at a party the
architecture explicitly does not trust. `34` §2.7 makes exactly this argument about `img-src` and
then reasons only about *foreign* hosts; §2.4's *"the step from `'none'` to `'self'` is not a
weakening of the confidentiality claim"* is false in this case.

**3. Two cross-reference defects that teach an implementer the wrong thing.** `23` §6.3 attributes
closure of the link-exfiltration channel C3 to *"CSP `connect-src`/`form-action` + link discipline"*
— but a link click is a **top-level navigation**, which `34` §2.11 and §9.4 both state is not covered
by any CSP fetch directive. And `34` §1.4 cites `23`'s catalogue as **C1–C9** when `23` §6.1 defines
**C1–C6**, so a reviewer who follows the reference finds three missing channels and reasonably
assumes they were removed because they were awkward.

**4. `21` §7.5's mode A policy sets `img-src 'self' data:` and `font-src 'self' data:` under an
opaque origin where `'self'` matches nothing**; `34` §2.2 proposes the fix and `23` §6.2 then cites
the *unfixed* policy as the control closing C2.

## Decision

**Five corrections, all in header policy, server behaviour or cross-references.**

1. **Remove `publickey-credentials-get` from the Permissions-Policy deny list in modes B–D**, leaving
   it at its `self` default, and state explicitly in `34` §2.2 that `publickey-credentials-create` is
   likewise not denied. CI check H11 is amended to assert the *intended* set rather than the listed
   set. WebAuthn PRF stays as `32` D13 ships it.

2. **`fathom serve` and the mode C/D server return `404` for any path not in the built asset
   manifest, and do not log request paths for non-manifest paths.** `34` §3.6 already specifies the
   manifest check for mode B; this extends it. The residual is stated in `34` §11 as `material`,
   because a 404 does not prevent the request from reaching a reverse proxy the operator also runs.

3. **`34` §2.4's sentence is qualified**: the step from `'none'` to `'self'` is not a weakening of
   the confidentiality claim **except in modes C and D, where `'self'` is the sync origin and
   `img-src 'self'` is a post-XSS exfiltration channel into its access log.**

4. **Delete `connect-src` and `form-action` from C3's mitigation cell in `23` §6.1 and from §6.3's
   heading.** The control is *"the application renders no clickable external link, in any surface,
   ever"* and nothing else. Listing a CSP directive beside it teaches an implementer that loosening
   the anchor rule is safe because the CSP will catch it. It will not.

5. **Fix the two dangling references**: `34` §1.4 cites C1–C6; `21` §7.5's mode A policy adopts `34`
   §2.2's correction and `23` §6.2 cites the corrected policy.

**Adopt `34` §13.1's amendment to invariant 1** (already carried in ADR-0002): the invariant names
`sandbox` and the per-directive allowlist, because §7.1 shows the current wording is actively
misleading about what `'self'` means in a mode where the origin is adversarial.

## Consequences

### Positive

- A shipped, on-by-default keyholder mechanism becomes usable. A user who enrols a passkey can open
  their workspace with it.
- The post-XSS exfiltration path into the untrusted server's access log is narrowed to paths the
  operator deliberately logs elsewhere, and — more importantly — it is *stated*, so a customer
  deploying mode C knows what their own access log can contain.
- An implementer reading `23` no longer believes a CSP directive is holding a door that a navigation
  walks through.
- `34`'s cross-references resolve, which matters more than it sounds: a reviewer who follows a
  reference and finds nothing stops trusting the other references.

### Negative

- **Un-denying `publickey-credentials-get` genuinely widens the attack surface.** The Permissions-
  Policy deny list exists because a denied feature cannot be abused by injected script; after this
  change, post-XSS script in modes B–D can invoke WebAuthn. The realistic exploit is limited (a
  `get()` needs user gesture and returns a PRF output the attacker still has to use in-page), and it
  is a real reduction in a document whose value is that it denies everything it does not need.
- **The asset-manifest 404 is a partial control and will be read as a complete one.** It does not
  cover a reverse proxy, a WAF, a CDN or a load balancer in front of `fathom-sync` — all of which are
  present in exactly the mode-D deployments this affects, and none of which we ship or configure.
  The honest control is the residual statement, and residual statements do not stop payloads.
- **`img-src 'self'` cannot simply be removed**, because the application legitimately loads its own
  assets in modes C/D. The alternative — `img-src 'none'` plus data URIs for everything — is
  achievable and it is a real constraint on every future UI feature that wants an image, forever.
- **These are five edits across four documents that each look trivial in isolation**, which is
  precisely how one of them gets applied and the other four do not.
- **CI check H11 becomes weaker.** "Assert the intended set" requires somebody to maintain the
  intended set, whereas "assert every listed feature is denied" was mechanical and self-checking.

## Alternatives considered

| Option | Strongest argument for it | Why rejected |
|---|---|---|
| **Delete `32` D13 and §12 — drop the WebAuthn keyholder** | Keeps the deny-everything Permissions-Policy intact, and a hardware keyholder is a convenience rather than a requirement. It also removes a platform-support matrix that `81` §11 could not verify | The WebAuthn PRF keyholder is one of the few controls that meaningfully improves a weak-passphrase workspace, which ADR-0014 shows is the realistic case at the shipping KDF floor. Deleting a real control to preserve the tidiness of a policy is backwards |
| **Keep both and rely on the frame-scoped reading of Permissions-Policy** | If the deny applied only to frames, there would be no conflict | It does not. The empty allowlist denies the top-level document, which is what makes this a defect rather than an ambiguity |
| **`img-src 'none'` with data URIs in all modes** | Closes the channel completely rather than narrowing it | Forecloses every future image, including diagram export previews, and moves the same bytes into the HTML where they cost size in mode A. Worth revisiting if a real exploit is demonstrated |
| **Serve assets from a second origin in modes C/D** | `'self'` would no longer be the sync origin, which removes the channel at its root | Requires two origins, two certificates and a CORS story for a self-hosted deployment, in a product whose deployment simplicity is a selling point |
| **Leave `23` §6.1's C3 cell as-is and add a footnote** | Less churn | The cell is what an implementer reads. A footnote under a table that says a control exists does not stop somebody relying on the control |

## Revisit if

- `34` §2.11's four-part `sandbox` VERIFY resolves either way. If it fails, egress channels 1 and 2
  are `material` everywhere and the whole per-mode CSP table needs re-deriving.
- The WebAuthn PRF platform-support matrix in `32` §12.3 turns out to be wrong — it is one of the
  items `81` §11 could not confirm and it decides whether this correction buys anything at all.
- A post-XSS `img-src` exfiltration is demonstrated against a real mode-C deployment, which would
  move the answer from "narrow and state it" to `img-src 'none'`.
