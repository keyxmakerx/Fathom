# ADR-0012 — One workspace container: `17` owns the layout, `32` owns the cryptography

> **Status:** Accepted
> **Date:** 2026-07-28
> **Register entry:** new — resolves `81` F1 and `83` F1; re-opens `73` §5.1 (D15)
> **Reversal cost:** R3 — every workspace a user holds must be rewritten by a migration that is correct first time
> **Supersedes:** the on-disk half of `32` §6 and §13.2–13.3; the cryptographic half of `17` §5.1–§5.2 and §5.6

## Context

This is the finding both the security and the coherence critiques put first, and it is the one item
that blocks all others: **`17-workspace-format.md` and `32-cryptography.md` each specify the full
on-disk container, in full, with code, neither aware of the other.** Both are `Status: Proposed`,
both dated the same day, and they agree on almost nothing.

| | `32` | `17` |
|---|---|---|
| Unit of encryption | `node_shard = blake3(node_id) mod 64`, `S_edges = 16`, fixed from empty to 5,000 nodes | Four records per device, plus 64 `Fabric` shards |
| Records at 500 devices | ~90 | ~2,100 |
| Filenames | Shard index `0x00`–`0x3f`, in the clear | Keyed pseudonyms, `base32(blake3_keyed(K_name, …))`, 1,024 buckets |
| AEAD | ChaCha20-Poly1305 (RFC 8439), 12 zero bytes, per-record salt → HKDF. **XChaCha explicitly rejected** | **XChaCha20-Poly1305, 24-byte random nonce** — the exact construction `32` rejected |
| Key commitment | `K_enc ‖ K_cmt = HKDF-Expand(prk, info, 48)` | `blake3_keyed(K_rec, "…/commit" ‖ nonce)[0..16]` |
| Key hierarchy | Epochs are first-class: passphrase → A2id → keyholder → `RK_e` → `WK_e` → per-record | **No epoch exists.** `K_name` and `K_capture` have no counterpart in `32` |
| Update model | Records rewritten whole; *"never re-seal a record whose canonical plaintext is unchanged"* | Append-only frame sets; an edit appends 69 bytes and never rewrites |
| Merge | **`INVARIANT — ciphertext is never merged`** | A git merge driver that **unions two files' frames keylessly**, called *"the most important result in this document"* |
| Manifest | Sealed record class `0x00`, rewritten every save, carrying a version vector | `manifest.fm` is in `.gitignore` |
| Extensions | `.fenv`, `nodes/00.fenv…3f.fenv`, `00-manifest.fenv` | `.frec`, `.fcap`, `records/2a/<ulid>.frec`, `manifest.fm` |

Five documents are built on one side or the other: `33` is built entirely on `17`'s frames (its wire
types are `FrameDigest`, `UploadFrame`, `set_digest`, `GET /frames?have=[…]`); `35` assumes `32`'s
envelope; `43` §2.1 assumes `17`; `44` §4.8 assumes **both, incoherently**; and `73` D15 cites `32`
only, so the register believes this is one open decision with a lean when it is two decisions
already taken differently.

`33` §3.4 states, of the key hierarchy, that *"full key management belongs to a document in
`30-security/` that has not been written"* — while `32` sits in that directory, 2,129 lines, having
written it.

## Decision

**Split ownership along the seam that actually exists, and delete the losing half of each document.**

> **`17-workspace-format.md` owns the container**: the on-disk tree, the record taxonomy, filenames,
> the update model, git behaviour, `fsck`, import and export.
>
> **`32-cryptography.md` owns the cryptography**: primitives, the KDF, the AEAD, key commitment, the
> key hierarchy and epochs, keyholders, padding, and the sealed envelope's content.
>
> Neither may specify the other's half.

The edits, all of which are deletions plus a deferral:

| Action | Document |
|---|---|
| Delete §6 (the record model) and §13.2–13.3 (on-disk shapes, git). Replace with a one-paragraph deferral to `17` | `32` |
| Delete §5.6 (its own key commitment) and §5.2's AEAD choice. **The 24-byte nonce field goes.** Recompute the frame-overhead arithmetic in §13.1 and §17 against `32`'s 112-byte header | `17` |
| Replace §3.4's *"has not been written"* with a deferral to `32` §3. Delete `K_name`, `K_capture`, `K_admin` and re-derive them as HKDF labels under `WK_e` | `33` |
| Delete the OPFS branch from D14 — ADR-0017 forbids browser storage in mode A, and `43` §3.12 prices the resulting loss of crash recovery, a cost `32` never sees | `32` |
| Rewrite §4.8 against one format. Every record count, byte figure and open-time estimate is recomputed | `44` |
| Move `17` §5.7's 512-byte small-frame floor into `32` §6.4 — it is a real improvement `32` lacks | `32`, `17` |
| `cachetextconv = true` in the ini block becomes `false`. One word; `32` §17.12 classifies `true` as *"total confidentiality loss for the repository"* and `17`'s own prose four lines below already says `false` | `17` §12.7 |

**One AEAD: ChaCha20-Poly1305 per RFC 8439, zero nonce, per-record HKDF-derived subkey** —
`32` D4's construction. `17`'s XChaCha choice carried its own `VERIFY` conceding the draft status
and deferring to *"the key-management document in `30-security/`"*, which is this one.

**One extension family**, chosen by `17` and free of the product name per ADR-0005.

The record granularity and the update model are the substantive part of the fork and are decided
separately in ADR-0013, because they are a product decision rather than an ownership one.

## Consequences

### Positive

- There is an implementable format. Until this is resolved, six documents specify a product that
  cannot be built, and no work on `33`, `35`'s BOM or `44`'s open-path budgets is safe.
- `36` Q11 and Q12 stop citing two formats eight answers apart, and the published forty-minute
  verification procedure becomes runnable.
- The seam is the same one the specialisms already have: `32`'s author is a cryptographer and `17`'s
  author is a systems person, and each document is strongest inside its own half.
- `17` §5.4's keyless merge driver — a genuinely elegant result — survives the split as `17`'s
  property to keep or lose, which ADR-0013 then decides on its merits rather than by ownership.

### Negative

- **This invalidates work in six documents and some of it is the best work in the corpus.** `32`'s
  §6 record-model argument, `17`'s §5.6 commitment construction, and `33`'s key hierarchy are each
  carefully reasoned and three of them are now deleted for compatibility rather than for being wrong.
- **The seam is not clean where padding and commitment live.** Padmé sits between layout and crypto:
  `32` owns the algorithm and `17` owns the small-frame floor, so one property is specified in two
  places by construction. ADR-0014's arithmetic fix has to land in `32` while the floor lands in
  `17`, and a future editor will re-merge them.
- **`33` loses its independence.** Its wire format is derived from `17`'s record model, so any change
  to the container is a protocol change. That coupling is real and was hidden while both documents
  had their own hierarchy.
- **Whoever executes this holds four documents open at once** and the edit is mechanical, long and
  exactly the kind that introduces a defect in a cryptographic specification. It should be done as
  deletions with deferrals, never as rewrites.
- **`44`'s numbers are unusable until ADR-0013 lands.** §4.8 currently states *"records at unlock:
  4 / 12"* against a class floor of ≥85 under `32` and ~70 at 20 devices under `17`. Neither is 4 or
  12, so §4.8.3's "below 30 records, verify everything" safety case is dead on arrival either way.

## Alternatives considered

| Option | Strongest argument for it | Why rejected |
|---|---|---|
| **`32` owns everything, including the container** | It is the strongest document in the corpus, its citations check out, its D4 zero-nonce argument is correct on its own terms, and `35` already builds on its envelope | It also specifies a git story it did not derive and a record model whose consequences (`44` §4.8.6: per-device laziness *"impossible"*) it never priced. And `33` — nine operations, five taking or returning frames — would be rewritten wholesale |
| **`17` owns everything, including the crypto** | `33`, `43` and `44`'s lazy-loading model already assume it, and its frames make the git story work | It ships XChaCha20 with a 24-byte random nonce and its own key-commitment construction, both of which `32` evaluated and rejected with reasons. `81` §3.7(d) also notes that `17` §5.2 argues only against counters and never addresses the CSPRNG-replay case `32` §5.4 identifies as the real risk |
| **Merge the two documents** | One artifact, no seam, no ownership argument | ~4,000 lines spanning two specialisms. Nobody reviews it, and the review is the control that makes a cryptographic design trustworthy |
| **Write a third document that supersedes both** | Clean slate, no legacy | Discards two carefully argued documents to avoid an editing session, and produces a third specification with the same failure mode and none of the review history |
| **Ship both and let the implementer pick** | It is the current state and it requires no decision | `83`'s governing rule: *"two documents that disagree about bytes on disk are not two opinions, they are two products"* |

## Revisit if

- The container and the cryptography turn out to need a joint change more than about once a year —
  the seam is in the wrong place and a single owner with a review requirement is better.
- A third document starts specifying container internals, which would mean the ownership register
  (ADR-0001) is not being read.
- An independent cryptographic review of `32` recommends a construction that forces a layout change,
  in which case the split has to be re-argued rather than worked around.
