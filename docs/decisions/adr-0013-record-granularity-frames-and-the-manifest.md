# ADR-0013 — Fixed hash shards, whole-record rewrite, a committed manifest, and the compatibility promise

> **Status:** Accepted
> **Date:** 2026-07-28
> **Register entry:** `73` §5.1 (D15), §5.2 (D16); resolves `83` §3.2 and `81` §3.4
> **Reversal cost:** R3 — `S` is fixed at workspace creation; changing it rewrites every record
> **Supersedes:** `17` §4.2's per-device record model; `17` §7.4's uncommitted manifest

## Context

ADR-0012 assigned ownership. This is the substantive fork underneath it, and `83` §3.2 is right that
it *"cannot be reconciled by a merge"* — three rows are load-bearing in opposite directions.

**Granularity.** `32` §6.1 shards by node-ID hash specifically to hide the device count: *"in an
exploded directory, the filename set is metadata… anyone with read access to that repository can
count devices by counting files."* `17`'s per-device records **publish the device count in the file
count**, exactly, forever, in git history. `17` §6.3's keyed pseudonyms hide the *names* and not the
*count*, and `17` §6.3 concedes it: *"for a workspace in git, every historical commit preserves that
signal permanently."*

**Update model.** `32` §5.4 declares `INVARIANT — ciphertext is never merged`. `17` §12.4's git merge
driver is a **set union over ciphertext frames performed without the key, by a subprocess**. Under
`32`'s model there are no frames to union. These are two products.

**Metadata.** `17` §5.1 puts a wall-clock millisecond timestamp (`hlc.wall_ms`) and an actor
pseudonym **in the clear**, permanently, in git history — which is precisely the per-operation model
`32` §6.1 evaluated and rejected: *"an operation log records that somebody edited
`IpsecPolicy.perfect_forward_secrecy` at 22:40 on a Tuesday… the shape is the reconnaissance in `31`
§7.3, at higher resolution and with no server required."* `17` §5.5 prices this honestly and offers
`opaque_frames` — **off by default**.

Separately, `81` §3.4 finds that rollback protection does not exist in the git shape at all: `32` §8
requires the manifest's version vector and per-record digests at every open, and `17` §3 marks
`manifest.fm` **not committed**. So in the shape the brief leads with, `32` §8.2's rollback rule never
runs, and the CI checks testing it are testing a path that does not exist where it matters.

## Decision

**Fixed hash shards, whole-record rewrite, a committed manifest, and `opaque_frames` semantics folded
into the record itself.** Concretely:

1. **Granularity: sharded, `S_nodes` and `S_edges` fixed at creation**, per `32` §6.2 and `73` D15.
   `S` is a **creation-time question with the trade stated**, not a preference: `S = 8` for a small
   workspace, 64 by default, 256 for a large one. `Suppressions` is deliberately one record and stays
   one record — splitting it leaks the suppression count, and a suppression list is a list of known
   unfixed weaknesses each with a written reason it will not be fixed.

2. **Update model: whole-record rewrite.** `32` §13.4's rule holds — never re-seal a record whose
   canonical plaintext is unchanged. **`17`'s append-only frames are not adopted**, and with them go
   the keyless merge driver, the per-frame HLC and the actor pseudonym in the clear.

3. **The manifest is committed.** It is a sealed record class carrying the version vector and the
   per-record digests, and it travels with the workspace in every shape. Without it there is no
   rollback detection in the git shape, and `32` §19's C11 has to be re-tagged `material` rather
   than `bounded`.

4. **Merging happens on opened plaintext, in the core.** `32` §5.4's invariant stands. Git conflicts
   on a record are resolved by opening both sides and merging values (`11` §8.6), which requires the
   key and therefore a human with the passphrase.

5. **The compatibility promise begins at phase 1's release** (D16), with a written migration policy
   and published test vectors, and at most one `schema_version` major per 24 months with the window
   announced in advance (`72`).

**What `17` keeps, because it is better:** the 512-byte small-frame floor (moved into `32` §6.4 per
ADR-0012), `fsck` and `fsck --repair`, the import paths, the plaintext export gate and export log,
and the directory-versus-packed container shapes.

## Consequences

### Positive

- The device count stops being published in the filename set. That is the single highest-value
  metadata property in the design and it is the one `17`'s model gives away permanently to anyone
  with repository read access.
- The per-frame wall-clock timestamp and actor pseudonym disappear, which removes `81` §4.2's channel
  M12 — a pseudonymous per-record, per-writer, wall-clock edit-activity map showing team size per
  device, working hours per person and change windows. It was materially worse than any channel in
  `31` §7.2's list and it went to whoever could read the repository.
- `32` §5.4's ciphertext-merge invariant survives, so no subprocess ever combines two sealed records.
- Rollback protection actually runs in the shape the product leads with.
- `36` Q12's step 10 — *"inspect the wire: high-entropy bytes"* — becomes true. Under frames a
  reviewer would have found a 69-byte plaintext header at step 10 of a procedure that predicted
  randomness, which is the worst possible way to learn a true thing.

### Negative

- **Write amplification, and it is the price of the whole decision.** A one-field change rewrites
  ~25 KiB instead of ~2 KiB on a 1.6 MiB graph. A busy workspace's git history is roughly an order
  of magnitude larger than per-device records would produce, and git's delta compression will not
  help because the bytes are ciphertext. Users will notice repository size.
- **`17` §5.4's keyless merge driver is deleted, and it is the most elegant single result in the
  corpus.** `83` §14 names it as something that must not be lost, and this decision loses it. What
  replaces it is worse in daily use: a git merge conflict on a shard now requires opening the
  workspace with the passphrase and resolving in the application. The engineer who wanted
  `git merge` to just work does not get that.
- **Per-device lazy loading becomes impossible** (`44` §4.8.6 says so in terms). Opening a workspace
  means opening every shard that holds a touched node, which under hash sharding is all of them.
  The open-path budget in `44` §4.8 has to be recomputed and it will get worse, not better.
- **`33` loses the wire shape it was designed around.** Nine operations, five of which take or return
  frames, plus `set_digest` over sorted frame digests and `GET /frames?have=[…]`, all rebuilt against
  whole records. Under ADR-0016 that work is deferred rather than lost, which is the only reason this
  is affordable.
- **`S` fixed at creation is a question asked of a user who has just decided to try the tool.**
  `83` M4 is right that four irreversible creation-time decisions now exist across four documents
  (`S`, `DeviceFloor`, the AI tier ceiling, the container shape) and no document specifies the
  screen. ADR-0025's product work has to include it.
- **A committed manifest rewritten every save is a guaranteed git conflict on every concurrent
  edit**, which under ADR-0016's single-writer model is acceptable and under any future multi-writer
  model is the first thing that breaks.

## Alternatives considered

| Option | Strongest argument for it, in its own terms | Why rejected |
|---|---|---|
| **Per-device records with pseudonymous filenames + append-only frames (`17`)** | *"Git merges frames. Fathom merges values."* It makes the brief's primary collaboration story — a git-versionable document — work without a key, without a server, and without a CRDT. Diffs are small, sync is incremental, and `17` §5.5 prices its own disclosure honestly and offers a mitigation | The disclosure is the device count and a per-writer edit-activity map, permanently, in every historical commit, to anyone with repository read access. The mitigation is off by default. It also requires ciphertext merging, which `32` §5.4 forbids for reasons that survive the argument |
| **`17`'s frames with `opaque_frames` defaulted on for multi-member workspaces** (`81` §4.2's fix) | Keeps the elegant merge for solo users and closes the disclosure for teams | The disclosure that matters most — the device count — is not closed by `opaque_frames`, and a format whose security properties depend on a setting will be deployed with the setting wrong |
| **Whole-workspace encryption, one blob** | Leaks least of any option: one size, one change event. Simplest possible implementation | No partial sync, no meaningful git history, 100% write amplification on every keystroke-to-save. `73` D15's table is right that it is competitive only if real workspaces are edited in large batches, which is unmeasured |
| **Per-operation log** | Append-only, clean history, cheapest sync | Leaks edit count and timing at full resolution, forever. It is `17`'s disclosure with the volume turned up |
| **Leave the manifest uncommitted and re-tag C11 `material`** | Honest, and it is one word rather than a design change | It concedes that the product's flagship collaboration shape has no rollback detection, permanently. A hostile store that drops the `Suppressions` record makes the workspace look clean, and that is the exact scenario `32` §8.1 exists for |

## Revisit if

- Phase 2 measures the real save pattern and finds workspaces are edited in large batches rather than
  field-by-field — whole-workspace becomes competitive and leaks less than sharding.
- Repository growth becomes the top pilot complaint, which would reopen granularity with real data
  instead of a leak argument.
- ADR-0016's evidence arrives and multi-writer sync is built, at which point the committed manifest's
  conflict behaviour has to be re-argued before the CRDT, not after.
- A user population appears for whom the device count is not sensitive — a public reference estate,
  a lab — in which case `17`'s model is strictly better for them and a per-workspace choice becomes
  arguable. Note that this is a creation-time choice and therefore R3 for anyone who picks wrong.
