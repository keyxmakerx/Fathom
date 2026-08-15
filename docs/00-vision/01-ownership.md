# 01 — The ownership register

> **Status:** Accepted — created by ADR-0001, which ordered it *"written before any other item in
> this ADR set is executed"*.

One table, one row per settled question, naming the document that owns it. It decides nothing on its
own: it records where a decision already lives so that two documents never specify the same artifact.

## 0. Contents

| § | | margin tab |
|---|---|---|
| 1 | The rule this register serves | *read this first* |
| 2 | The register | *the table* |
| 3 | What is not in the register yet | *gaps, named* |
| 4 | How a row is added or moved | |
| | Failure modes | |
| | Open decisions | |
| | Sources consulted | |
| | Disagreements | |

---

## 1. The rule this register serves

The precedence rule, verbatim from ADR-0001 item 2 and now carried in `.context/conventions.md`:

> **Precedence.** Where two documents specify the same artifact, exactly one is the **owner** of
> that artifact and every other document references it rather than restating it. The owner is named
> in the artifact's own document header. A document that needs to change something it does not own
> raises a `## Disagreements` entry and **may not ship a second specification in the meantime.**

Two consequences worth stating plainly, because both are easy to lose:

1. **A non-owner may not ship a second specification while it disagrees.** Raising the disagreement
   is the whole remedy. Writing a competing spec "temporarily" is the failure this rule exists to
   prevent, and it is how `88` §3's pattern — decisions accepted and never executed — becomes
   decisions accepted and *contradicted*.
2. **Ownership is of a question, not of a file.** A document owns the answer to something. Where a
   question has never been asked, it has no owner, and §3 says so rather than implying coverage the
   register does not have.

## 2. The register

Adopted from ADR-0001's Decision item 1, which took it from `81` §13.1's proposal and `83` §11's
table. Reproduced exactly; additions since are marked.

| Question | Owner |
|---|---|
| Workspace container layout, record taxonomy, git behaviour | `10-core/17` |
| Cryptographic primitives, key hierarchy, key management, envelope content | `30-security/32` |
| The wire | `30-security/33` |
| The browser platform and the CSP per mode | `30-security/34` |
| Deployment shapes and their lettering | `40-stack/43` |
| Size, memory and latency budgets | `40-stack/44` |
| The measured composition of the release WASM module, and the instrument that measures it | `40-stack/47` (added 2026-08-15; it measures and recommends, `44` decides — a byte figure in `47` that contradicts `44` is a correction `44` has not yet taken, not a second budget) |
| The IR, node kinds, identity tuples, re-identification | `10-core/11` |
| The rule engine, `fex`, suppression shape | `10-core/12` |
| The subagent catalogue, tool grants, gates | `20-ai/22` |
| The AI boundary, verbs, tiers, egress machinery | `20-ai/21` |
| The keymap | `50-design/53` |
| Design tokens, the channel budget | `50-design/51` |
| Open decisions and their register IDs | `70-ops/73` |

## 3. What is not in the register yet

ADR-0001's table was written before several questions were settled, and a register that implies
coverage it does not have is worse than a short one. These are named rather than assigned, because
assigning an owner is a decision and this document does not make decisions.

| Question | Where it is currently answered | Why it is not a row yet |
|---|---|---|
| The schema-as-artifact grammar | `10-core/62` | Almost certainly `62`'s to own; nobody has said so |
| Platform registration and the platform list | `schema/platforms.yaml`, `70-ops/70` §7 | The data is the artifact (ADR-0008); whether a *document* owns the question is unsettled |
| The execution protocol and the work-order queue | `70-ops/78`, `79-work-orders/00-INDEX.md` | `78` was written after this table |
| The diagram's legibility ceiling and aggregation | `50-design/59` §2–§3 | `59` amends `44` §4.7.4 and `56`; which of the three owns the ceiling is exactly the ambiguity this register exists to resolve |
| Motion and its three tests | ADR-0033 (Proposed) | Unratified. `51` and `53` both have a claim |
| Version predicates and target releases | `70-ops/70` §7.4–§7.5 | Owner-blocked; no field exists yet |

## 4. How a row is added or moved

Adding a row is cheap and is planning work. **Moving** one is not: it means an artifact changed
hands, which is an ADR. The distinction is the same one `75` §2 draws about the capability register —
recording is cheap, deciding in the register is a defect.

ADR-0001's remaining three items are not this document's to execute and are tracked with it:

| ADR-0001 item | State |
|---|---|
| 1. This register exists | **Done** — this file |
| 2. The precedence rule in `conventions.md` | **Done** — `.context/conventions.md` § *Precedence* |
| 3. `Status:` gains `Superseded by NN §M`; a document contradicted by a sibling reads `Contested` | **Not done.** ADR-0001 names `17`, `32`, `21`, `22`, `34`, `43` and `44` as reading `Contested` *"today"* — that assessment predates the ADR set's execution and needs re-checking before it is applied, not applying on trust |
| 4. Every document's §1 declares what it builds on | **Not done.** A sweep across ~100 documents; it wants a work order, not a drive-by |

## Failure modes

1. **The register goes stale and nobody notices**, because nothing reads it at build time. It is
   prose about prose. The guard is §4's rule that moving a row is an ADR — an ADR is visible where a
   quiet edit is not — but nothing enforces it mechanically.
2. **§3 is mistaken for a to-do list.** It is a list of questions with no assigned owner. Some of
   them may not need one.
3. **The register is read as authority over the documents it names.** It is the reverse: it records
   what those documents already own. Where this table and a document's own header disagree, the
   header wins and this table is corrected.

## Open decisions

1. Whether each §3 row gets an owner, and which. Planning proposes; the ADR set decides.
2. ADR-0001 items 3 and 4, per §4's table. Item 4 in particular is a real body of work that no work
   order carries.

## Sources consulted

| Source | What was taken |
|---|---|
| `docs/90-decisions/adr-0001-*.md` Decision items 1–4 | The register table verbatim, the precedence text, and the four items in §4 |
| `.context/conventions.md` § *Precedence* | The rule as it now reads, added in the same pass as this file |
| `docs/80-review/88-state-review-and-recommendations.md` §3, §4.3 | That ADR-0001 and ADR-0002 were accepted and never executed, which is why this file did not exist |

## Disagreements

1. **ADR-0001 item 3's `Contested` list is not applied here.** The ADR states seven documents read
   `Contested` *"today"*, but "today" was before ADR-0002 and the rest of the set were executed —
   and several of those contradictions were the very things the set resolved. Applying the list on
   trust would mark documents contested that are no longer in conflict. Re-checking each is real
   work and is filed in §4 rather than done badly here.

2. **The register's granularity is inherited, not chosen.** Rows like *"the wire"* and *"the
   keymap"* are very different sizes. That came from `81` §13.1 and `83` §11 and is left alone: a
   re-cut would be a decision, and this document does not make decisions.
