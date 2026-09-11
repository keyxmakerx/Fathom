# 16 — The command finder

> **Status:** Proposed

Companion documents: `docs/60-content/61-command-corpus-spec.md` (the content this reads —
that document is the authoring format, this one is the machine),
`docs/10-core/18-diff-verify-rollback.md` (§4, the `Ladder` type — the finder renders
ladders, it does not own them), `docs/10-core/13-emitters-and-provenance.md` (§12, the
explainer resolution ladder — the reverse query shape reuses it rather than duplicating it).

Owner brief §6.1 calls this **the wedge** and says build it first:

> *"It is a few days of work on top of a corpus that already exists, and it is the feature
> people open ten times a day. […] Nobody adopts a network modelling platform on a Tuesday
> afternoon. Everybody uses a fast command finder immediately — zero setup, zero data entry,
> zero trust required."*

Two things in that paragraph are load-bearing and pull against each other. "A few days of
work" is true of the *shell* and false of the *ranking*, because the ranking is where the
vocabulary gap gets closed and the vocabulary gap is the reason the product exists (§2.1 of
the brief). "Zero trust required" is true only if the thing is deterministic, offline and
diffable — which rules out the one technique that would make the ranking easy.

So: the finder is a small amount of code over a large amount of authored structure. This
document specifies the code. The structure is `61-command-corpus-spec.md`.

---

## 0. Contents

| § | |
|---|---|
| 1 | The bar, and what "the wedge" has to survive |
| 2 | The vocabulary gap — why `answers` alone is not enough |
| 3 | The concept layer |
| 4 | Query normalisation |
| 5 | Matcher 1 — lexical (BM25F) |
| 6 | Matcher 2 — syntax (FST prefix + Levenshtein + Jaro-Winkler) |
| 7 | Matcher 3 — concept |
| 8 | Fusion — the ranking function, with weights |
| 9 | Index structures, sizes, and the build |
| 10 | Latency budget |
| 11 | Query shape classification and routing |
| 12 | Worked trace A — "check if a tunnel is up" |
| 13 | Worked trace B — half-remembered syntax |
| 14 | Worked trace C — cross-vendor |
| 15 | Worked trace D — reverse |
| 16 | Context awareness and slot binding |
| 17 | Answer-shaped results and the ladder group |
| 18 | The Rosetta layer |
| 19 | `Ctrl+K`, the keymap, and the shell |
| 20 | Links out — guidebook and walkthrough |
| 21 | Why not ship a small model |
| 22 | Failure modes |
| 23 | Complexity and budget summary |
| 24 | Open decisions |
| 25 | Sources consulted |
| 26 | Disagreements |

---

## 1. The bar, and what "the wedge" has to survive

The brief sets one hard performance bar and one hard behavioural bar.

> *"Must be a single keystroke (`Ctrl+K`) from anywhere. If it is slower than opening a
> browser tab, it will not be used."*

> *"Deterministic — fuzzy matching plus a synonym map, no model at runtime. Works offline,
> identical every run, diffable between releases."*

These are the forces, in the order they constrain the design.

| # | Force | Source | What it forces |
|---|---|---|---|
| F1 | The query does not contain the words in the answer | Brief §2.1 | A concept layer between query text and command text (§3). Lexical matching alone is structurally insufficient, and §12 shows it ranking the wrong command first. |
| F2 | Identical ranking every run, on every machine | Invariant 9 | No floats in the ordering key; IDF precomputed at build time, not `ln()` at query time (§8.5). |
| F3 | Offline, single file | Brief §1, §8 | The index ships in the bundle. Budget it (§9.4). No index server, no lazy fetch. |
| F4 | No egress | Invariant 1 | No query logging off-box. The miss log is a local file and exporting it is an explicit user action (§3.6). |
| F5 | Under one frame | Brief §6.1 | 16.67 ms keystroke-to-paint at 60 Hz, of which matching gets ≤3 ms (§10). |
| F6 | Zero setup, zero trust | Brief §6.1 | Works with no workspace open. Context awareness is an *upgrade*, never a precondition (§16.6). |
| F7 | Results must not be dangerous | Invariant 2/3, the risk enum | A finder that ranks `clear security ike security-associations` above `show security ike security-associations` for "check the tunnel" has done real harm. Risk is an input to ranking (§8.3), and `Disruptive` entries never auto-interpolate an unscoped form (§16.5). |
| F8 | Diffable between releases | Brief §6.1 | The ranking is a pure function of (query, index). CI pins a golden query set and diffs the top-5 on every corpus change (§9.6). |

F1 and F7 are the two that make this different from a generic search box. Everything else
is engineering that has been done before.

### 1.1 What the finder is not

| Not | Because |
|---|---|
| A general search engine over the docs | It searches *entries*, which are structured answers. Free-text search over prose is what makes vendor documentation useless (brief §2.1) and reproducing it would reproduce the failure. |
| A shell | Invariant 2. Nothing here executes. Every result ends at the clipboard. |
| A learner | No per-user ranking adaptation. Two engineers on the same corpus version get the same list, which is what makes a result shareable in a change ticket. Personalised ranking is a silent violation of invariant 9. |
| The owner of the verify ladder | Ladders are specified in `18-diff-verify-rollback.md` §4 and authored in the corpus. The finder *selects and renders* them (§17.3). |

---

## 2. The vocabulary gap — why `answers` alone is not enough

The brief's mechanism:

> *"**The `answers` field is the one that matters.** Matching against the question a command
> answers, rather than the command text, is what closes the vocabulary gap."*

That is correct and it is not sufficient, for a reason the field card itself supplies.

Take the query the brief uses: **"check if a tunnel is up"**. Now take the entry the brief
seeds:

```yaml
cmd: show security ipsec security-associations
answers: "Is Phase 2 installed and passing traffic?"
```

Token overlap between query and `answers`: **zero**. Not "low" — zero. `check`, `tunnel`,
`up` appear nowhere in `Is Phase 2 installed and passing traffic?`. A pure BM25 over
`answers` scores this entry at 0 and returns nothing.

So `answers` needs a bridge, and the bridge is the set of words that mean the same thing:
`up`, `working`, `established`, `passing traffic`, `installed`, `active`, `healthy`,
`came up`, `green`. The brief calls this "a synonym map". It cannot be a synonym map, and
the reason is the single most useful sentence on side 1 of the card:

> *"Phase 2 rides inside Phase 1. P1 can be perfectly healthy while P2 fails forever — that
> split is the most useful diagnostic fact on this card."*

`established` is **Phase 1's** word — it is the state of the IKE SA.
`Installed` is **Phase 2's** word — it is literally the value of the `State` field on
`show security ipsec security-associations`, per side 3's `READING THE SA OUTPUT`:

> *"State — P2 wants Installed. Anything else is not passing traffic."*

And `passing traffic` is **neither**, because side 1 says:

> *"Miss #1, #2, #4 or #5 and the tunnel reads UP while passing zero packets."*

A tunnel can be `established` and not `Installed`. It can be `Installed` and not passing
traffic. Flattening those three words into one synonym bucket destroys exactly the
distinction the tool exists to teach. Every one of them is a *different question with a
different command*.

**So the requirement is not convergence. It is convergence at the query end and separation
at the result end.** The user's vocabulary collapses three states into one word; the answer
has to expand it back into three commands, in ladder order, with the split named. That is
what §3.4 (breadth resolution) and §17.3 (the ladder group) do, and it is the central design
idea in this document.

### 2.1 The other half of the gap: things that look alike and are not

Brief §2.1:

> *"The same concept has four names (`ae` / `port-channel` / `bond` / LAG), and things that
> look alike are not alike — a Juniper `reth` sits next to a LAG in interface listings and is
> not aggregation at all."*

A synonym map handles the first clause and actively causes harm on the second: put `reth`
in the LAG synonym set and the finder now confidently returns aggregation commands for a
chassis-cluster query. The concept layer therefore carries **anti-synonyms** as first-class
data (§3.5), and a query that hits one renders the distinction inline rather than silently
dropping the wrong result.

---

## 3. The concept layer

### 3.1 Shape

A **concept** is a corpus node. It is not a tag and not a keyword list. Full authoring
format in `61-command-corpus-spec.md` §9; the machine-relevant shape:

```rust
pub struct Concept {
    pub id: ConceptId,                       // `concept:<domain>.<name>`
    pub kind: ConceptKind,
    /// Surface phrases, each with an authored confidence.
    pub surfaces: Box<[Surface]>,
    pub narrower: Box<[ConceptId]>,
    pub broader:  Box<[ConceptId]>,
    pub related:  Box<[ConceptId]>,
    /// Polar opposite. `state.down` for `state.operational`. Scored, at a discount.
    pub opposite: Option<ConceptId>,
    /// The reth/LAG problem. Rendered inline when both concepts match.
    pub not_the_same_as: Box<[Distinction]>,
    /// Number of corpus entries carrying this concept. Precomputed at build.
    pub entry_count: u32,
    /// Precomputed, quantised. Never computed at query time (§8.5).
    pub icf_milli: u16,
}

pub struct Surface {
    /// Normalised, whitespace-joined n-gram. `passing traffic` is one surface, n=2.
    pub text: Box<str>,
    /// 0..1000. `installed` → 1000 for p2.installed. `up` → 720 for state.operational.
    pub conf_milli: u16,
}

pub struct Distinction {
    pub other: ConceptId,
    /// One line, card voice. "A reth is chassis-cluster redundancy, not aggregation."
    pub because: Box<str>,
}

pub enum ConceptKind {
    Object,     // what the question is about: tunnel, ike-sa, st0, route, policy
    State,      // what condition it is in: operational, down, flapping, rekeying
    Action,     // what the user wants to do: verify, diagnose, configure, clear, capture
    Attribute,  // a knob: pfs, lifetime, dh-group, mtu, dpd
    Symptom,    // an observed failure: one-way-traffic, stalls-under-load, phase1-timeout
    Phase,      // protocol phase: p1, p2 — a domain-specific axis worth its own kind
}
```

`ConceptKind` is not decoration. §7.3 gates the score on `Object`, §3.4 resolves breadth on
`State`, and §11 uses `Action` to pick a ladder entry point. A concept with the wrong kind
ranks wrongly in a way that is hard to see in review, which is why the corpus spec makes
kind required and CI checks the distribution.

### 3.2 Worked concept — the one this whole section is about

```yaml
id: concept:state.operational
kind: state
label: "up, in the sense the person asking means it"
surfaces:
  - { text: "up",              conf: 0.72 }
  - { text: "is up",           conf: 0.80 }
  - { text: "working",         conf: 0.70 }
  - { text: "healthy",         conf: 0.70 }
  - { text: "active",          conf: 0.60 }
  - { text: "come up",         conf: 0.80 }
  - { text: "came up",         conf: 0.80 }
  - { text: "green",           conf: 0.55 }
  - { text: "alive",           conf: 0.60 }
narrower:
  - concept:p1.established
  - concept:p2.installed
  - concept:dataplane.passing
  - concept:iface.link-up
opposite: concept:state.down
notes: >
  "up" is the most overloaded word in the domain and none of the surfaces here
  are worth more than 0.8. That is deliberate. Nobody asking "is it up" knows
  which of the four narrower states they mean — that is the question, not a
  defect in the question. Resolve breadth (finder §3.4), do not guess.
reviewed_by: <named human>
```

And the narrow ones it expands to:

```yaml
id: concept:p2.installed
kind: state
label: "the IPsec SA is installed"
surfaces:
  - { text: "installed",         conf: 1.00 }
  - { text: "phase 2 up",        conf: 1.00 }
  - { text: "p2 up",             conf: 1.00 }
  - { text: "sa installed",      conf: 1.00 }
  - { text: "ipsec sa up",       conf: 0.95 }
broader: [concept:state.operational]
not_the_same_as:
  - other: concept:dataplane.passing
    because: >
      Installed proves crypto, not reachability. The tunnel reads UP while
      passing zero packets when st0 has no zone, no policy, or nothing
      routed at it.
sources:
  - { card: "srx-ipsec", side: 3, block: "READING THE SA OUTPUT" }
  - { card: "srx-ipsec", side: 4, block: "THINGS THAT BITE" }
reviewed_by: <named human>
```

Note what the `not_the_same_as` line is: it is a verbatim compression of side 4's *"Tunnel
UP, zero traffic. st0 has no zone, no policy, or nothing routed at it. The SA proves crypto,
not reachability."* The concept layer is where the card's teaching survives as machine-usable
structure rather than as prose someone has to read first.

### 3.3 Surface matching is exact, leftmost-longest, over n-gram windows

**DECISION — surface lookup is exact string matching against a precomputed phrase table, not
fuzzy.** A fuzzy concept lookup is a category error: it lets a typo change *which question
the user is understood to be asking*, which is the one thing that must not happen silently.
Typos are handled by matcher 2, at the command-token level, where being wrong costs the user
one glance.

Algorithm, over the normalised token stream `t[0..n]`:

```
i ← 0
while i < n:
    for k in min(4, n-i) down to 1:            # leftmost-longest, max 4-gram
        s ← join(t[i..i+k], " ")
        if s ∈ phrase_table:
            emit all (concept, conf) for s
            i ← i + k ; continue outer
    i ← i + 1
```

`O(4n)` hash lookups. For a 6-token query that is at most 24 lookups against an FHT with no
allocation. The 4-gram cap is chosen because the longest useful authored surfaces in the
corpus are things like `is not passing traffic` (4) and `no proposal chosen` (3); a 5-gram
cap costs 25% more lookups and buys nothing measured.

**Overlap policy:** leftmost-longest, and a token consumed by a longer surface is not
reconsidered. `passing traffic` beats `traffic`. The cost: `traffic selector mismatch`
consumes `traffic selector` and the standalone `traffic` concept never fires on that query —
which is correct here and will occasionally be wrong somewhere else. The alternative
(all-matches, no consumption) causes the same query to fire three overlapping concepts and
triple-count, which is worse and harder to debug.

### 3.4 Breadth resolution — the mechanism §2 demanded

When the query's `State` concept is **broad** (has ≥2 `narrower` entries) and the query also
carries an `Object` concept, the finder does not pick a narrower concept. It expands.

```
resolve_breadth(Q):
    for each State concept c in Q with |narrower(c)| ≥ 2:
        N ← { n ∈ narrower(c) : entries(n) ∩ platform_filter ≠ ∅ }
        if |N| ≥ 2:
            mark c as BROAD
            for each n ∈ N: add n to Q with conf = conf(c) × 0.6 and flag DERIVED
            if ∃ ladder L with L.answers_concepts ⊇ {c} and L.object ∈ Q:
                record ladder candidate (L, entry_point = L.entry_for[action_concept(Q)])
```

Three consequences:

1. Entries carrying any narrower concept score, at a 0.6 discount from the broad concept's
   contribution. Nothing is excluded on a guess.
2. If the corpus has a **ladder** that answers the broad concept for that object, the ladder
   becomes a candidate result. §17.3 renders it as a group.
3. The `0.6` discount is the same constant used for `broader`/`narrower` traversal in §7.2,
   deliberately: one number, one place to tune, one thing to explain.

**The honest cost.** Breadth resolution widens the candidate set for the most common query
shape in the product ("is X up"), which is exactly the shape where the user wants one answer
fast. Mitigation is presentational (the ladder group collapses to two rows), not algorithmic,
and a user who wants flat results has a preference for it. If that preference is set by more
than a small minority of users in practice, the breadth design is wrong and this is where to
look first.

### 3.5 Anti-synonyms

`not_the_same_as` fires when **both** concepts appear in the candidate set with meaningful
score. The renderer inserts one hairline row between the two groups carrying the `because`
line, in the card's note treatment (4px accent bar + wash, no icon, no box — design language,
*devices worth stealing* item 2).

This is the `reth`/LAG problem, and it is also the `established`/`Installed` problem, and it
is also `mode aggressive` under `v2-only` (side 2: *"`mode` is silently ignored under
`v2-only`. Seeing `mode aggressive` in a v2 config means nothing — do not chase it."*).

The rule that makes this cheap: **an anti-synonym is authored on the concept, once, and is
therefore true for every entry that carries it and every platform.** There is no per-entry
disambiguation text to maintain.

### 3.6 Who authors this, and how it stays honest

| Question | Answer |
|---|---|
| Who writes concepts? | The same network engineers who write command entries. Every concept carries `reviewed_by` (invariant 10). A concept is not a programming artefact and must not require one. |
| Where does it live? | The corpus repo, `concepts/<domain>.yaml`, one file per domain, not per concept. Small files per concept produce a directory nobody reads. |
| Where do surfaces come from? | **Harvested, not invented.** Three sources: (a) the `aka:` list on command entries, lifted mechanically at build time; (b) vendor documentation section titles, which are the words the vendor thinks in; (c) the local miss log (below). Inventing surfaces at a desk produces a map of what one author would type. |
| Can one person add a concept? | No. A new `ConceptId` needs a second reviewer, because concept ids are the join keys for Rosetta (§18) and for ladders. A new *surface* on an existing concept needs one reviewer. This is the same rule the rule packs apply to rule ids. |
| How do misses get back? | A **local** `misses.log` in the workspace: query text, timestamp, top score, whether the user copied anything. Never transmitted (invariant 1). Exporting it is an explicit menu action producing a file the user reads before sending. The corpus repo has an issue template that takes that file. |
| What stops the map rotting? | CI. Every concept must have ≥1 entry on ≥1 platform (orphan concepts fail the build). Every entry must carry ≥1 `Object` and ≥1 `Action` concept. A golden query set pins expected top-3 for ~120 queries and a diff is a review item, not a failure — the reviewer decides whether the ranking change is the improvement it claims to be. |

**The cost, stated.** This is a second authoring surface that can drift from the first. A
corpus author who adds a command and forgets its concepts gets an entry that is unfindable by
intent and findable only by syntax — a silent half-failure. The CI gate above catches the
absent case; it cannot catch the *wrong concept* case, and that one will happen. The
mitigation is the golden query set and nothing else. Budget review time for it.

---

## 4. Query normalisation

Deterministic, allocation-light, and identical in the index builder and the query path — one
function, compiled once, used twice. A normaliser that differs between build and query is
the classic silent search bug and the type system should prevent it (the builder and the
runtime link the same `normalize` crate; CI asserts a fixture corpus of 400 strings round
trips identically through both binaries).

### 4.1 Pipeline

| Step | Action | Note |
|---|---|---|
| 1 | NFKC | Unicode-normalise. Corpus is ASCII today; queries are not guaranteed to be. |
| 2 | Lowercase (simple, not locale-aware) | Locale-aware casing is non-deterministic across platforms. Turkish dotless-i would change ranking by locale, which violates invariant 9. |
| 3 | Strip a leading device prompt | `user@srx-a>` , `srx-a#`, `(config)#`, `admin@PA-220>`. Matches `^[\w.@\-]+[>#]\s*`. People paste prompts. |
| 4 | Strip a leading `run ` | Junos configuration-mode prefix. |
| 5 | Split the pipe suffix | Everything from the first ` \| ` is held aside as a **filter clause** (§15.3), not tokenised into the query. |
| 6 | Tokenise | Split on whitespace and on `,` `;` `"` `'` `(` `)` `?` `!`. **Do not split on** `-` `/` `.` `:` `_` — those are inside identifiers (`aes-256-gcm`, `st0.0`, `10.2.0.0/16`, `reth0.0`). |
| 7 | Emit sub-tokens | A token containing `-` or `.` additionally emits its parts at a 0.6 boost multiplier: `inactive-tunnels` → `inactive-tunnels` (1.0), `inactive` (0.6), `tunnels` (0.6). This is what lets `tunnel` match `inactive-tunnels` without letting it match as strongly as `tunnel` would. |
| 8 | Shape-classify each token | `Ip4`, `Ip6`, `Prefix`, `Integer`, `Identifier`, `Word`. Used by slot binding (§16.2) and by reverse capture (§15). Cheap: first-character dispatch plus one validating parse. |
| 9 | Conservative lemmatisation | §4.2. |
| 10 | Stopword marking | Marked, **not removed**. §4.3. |

### 4.2 DECISION — conservative suffix stripping, never a general stemmer

A Porter/Snowball stemmer applied to this vocabulary is actively harmful. It maps
`associations` → `associ`, which is fine, and it will happily mangle identifiers that survive
tokenisation as bare words. The failure is silent and shows up as a command that cannot be
found by its own name.

The rule:

```
lemma(tok):
    if tok ∈ identifier_lexicon: return tok        # union of all corpus command tokens
    if tok is not pure-alphabetic: return tok
    if len(tok) < 5: return tok
    for suffix in ["ies", "es", "ed", "ing", "s"]:      # ordered, first match wins
        if tok ends with suffix and len(tok) - len(suffix) >= 3:
            stem ← tok minus suffix
            if suffix == "ies": stem ← stem + "y"
            if stem ∈ lemma_lexicon or tok ∈ lemma_lexicon: return canonical form
            return stem
    return tok
```

`identifier_lexicon` is not a guess: it is generated at index-build time as the set of every
token appearing in any entry's `cmd`, in any `output_fields` name, or in any schema field
name. `ike`, `ipsec`, `esp`, `sa`, `st0`, `reth0`, `kmd`, `dpd`, `mss`, `gcm` are in it by
construction and are never touched.

`lemma_lexicon` is an authored override table for the ~40 domain words where the mechanical
rule is wrong (`statistics` must not become `statistic`; `establishes`/`established`/
`establishing` must all reach `establish`). Authored, reviewed, diffable — which is the
property a stemmer does not have.

**Cost:** roughly 40 authored entries at v1 and a long tail forever. Cheaper than the class of
bug the stemmer produces, and every miss is one line of YAML rather than a discussion about
algorithm choice.

### 4.3 Stopwords are marked, not removed

`if`, `a`, `is`, `the`, `to`, `do`, `i`, `my`, `on`, `it`, `me`, `how` — about 60 words.

They are excluded from BM25 (they carry no discrimination and dominate short-document
scoring) but they are **retained in the token stream** because concept surfaces need them:
`is up`, `passing traffic`, `come up`, `not passing`, `no proposal chosen`. Dropping `is`
before concept lookup loses the `is up` surface, which is a higher-confidence surface than
bare `up`, and quietly degrades the most common query in the product.

Negation is not a stopword and is not handled by scoring: `not`, `no`, `isn't`, `won't`,
`can't`, `never`, `down` participate in surfaces (`not passing traffic` is a `Symptom`
concept in its own right). **The finder does not implement general negation.** A query like
"tunnel up but not passing traffic" is answered by the `Symptom` concept
`concept:symptom.up-no-traffic`, which exists and is authored, not by a boolean operator.
Where no such concept exists the finder will return the affirmative results and be wrong in
a way the user can see immediately.

---

## 5. Matcher 1 — lexical (BM25F)

### 5.1 Why BM25 and not something simpler

The alternatives considered:

| Option | Rejected because |
|---|---|
| Substring / `includes()` | No ranking. Returns 200 rows for `show`. |
| TF-IDF cosine | BM25's term-frequency saturation is the property that matters here: an `answers` field that says "tunnel" three times is not three times more about tunnels. Length normalisation matters too — `answers` fields range from 4 to 20 tokens. |
| Trigram similarity over whole entries | Good for typos, bad for relevance; it has no notion of a rare term. Used at the *term* level in §6.3, which is where it belongs. |
| Vector similarity | §21. |

BM25 with field weighting (BM25F) is the right size of tool: ~120 lines of Rust, no
dependencies at query time, well-understood parameters, and every score decomposes into
per-term contributions that can be shown in a debug panel — which matters because "why did
this rank here" is a question the corpus authors will ask constantly.

### 5.2 The formula, as implemented

Per query term `t`, over entry `e`:

```
tf̃(t,e) = Σ_f  boost_f · sub_f · tf(t, e.f)
                ─────────────────────────────
                 1 − b_f + b_f · (len_f / avgdl_f)

score_bm25(q,e) = Σ_t  idf(t) ·  tf̃(t,e)
                                ──────────────
                                 k₁ + tf̃(t,e)

idf(t) = ln( 1 + (N − df(t) + 0.5) / (df(t) + 0.5) )
```

`k₁ = 1.2`. Lucene's default; the corpus has no property that argues for a different
saturation and picking a novel value would be a number nobody could defend in review.
Lucene/Elasticsearch have used `k₁ = 1.2, b = 0.75` as defaults for many years.

Note the BM25F numerator is `tf̃`, not `(k₁+1)·tf̃`: the constant factor is dropped because
it does not change ordering and it keeps the raw score in a range where the squash constant
in §8.2 is interpretable.

`sub_f` is the sub-token multiplier from §4.1 step 7: `1.0` for a whole token, `0.6` for a
piece of a hyphenated one.

### 5.3 Fields and their parameters

| Field | `boost_f` | `b_f` | `avgdl_f` (planning) | Rationale |
|---|---|---|---|---|
| `answers` | 3.0 | 0.75 | 9 | The brief's mechanism. Highest boost, full length normalisation because lengths vary 4–20. |
| `aka` | 2.0 | 0.30 | 12 | Harvested alternative phrasings. Low `b`: a long `aka` list is thoroughness, not padding, and should not be punished. |
| `concept_labels` | 2.5 | 0.30 | 8 | The `label:` text of every concept the entry carries, indexed as text. Gives the concept layer a lexical shadow so a partially-matching phrase still contributes. |
| `title` | 1.5 | 0.50 | 5 | |
| `cmd` | 1.0 | 0.30 | 5 | Command tokens. Deliberately *not* the highest boost — the whole premise is that the user does not know these words. Matcher 2 is where command text earns its ranking. |
| `read_field` | 0.8 | 0.50 | 6 | `"State — want Installed"`. Contains the words the user reads on screen, which is a real query source ("what does Installed mean"). |
| `output_fields[].means` | 0.5 | 0.75 | 30 | |
| `explain.terse` | 0.4 | 0.75 | 14 | |

`explain.explained` and `explain.teaching` are **not indexed.** They are long, they are the
same subject matter as the short fields, and indexing them makes every entry match every
query weakly, which flattens the score distribution and destroys the cutoff in §8.4. Cost: a
query using a word that appears only in teaching text returns nothing. That is the correct
failure — that word belongs in `aka` or in a concept surface, and the miss log will say so.

### 5.4 Determinism trap

`ln()` is not bit-identical across libm implementations, and the WASM build and any native
CLI build will not use the same one. **IDF is computed once at index build time on the build
host, quantised to `u16` milli-nats, and stored.** The query path performs no transcendental
arithmetic at all. Same for `icf_milli` on concepts and for the per-field length norms, which
are precomputed per (entry, field) as a `u16` reciprocal.

This is not paranoia; it is invariant 9. A ranking that differs between the CLI and the
browser on the same corpus is a bug report nobody can reproduce.

---

## 6. Matcher 2 — syntax

The half-remembered-syntax shape: `show security ike... something`,
`show sec ipsec sa`, `show secuirty ipsec security-associations`.

### 6.1 The command tree

Every entry's `cmd` is a token path. The set of all paths forms a trie:

```
show ─┬─ security ─┬─ ike ─┬─ security-associations ─┬─ (leaf: ike.sa.show)
      │            │       │                          ├─ detail  (leaf: ike.sa.show-detail)
      │            │       │                          └─ index ⟨n⟩ detail
      │            │       └─ active-peer             (leaf: ike.active-peer)
      │            └─ ipsec ─┬─ security-associations
      │                      ├─ inactive-tunnels
      │                      ├─ statistics
      │                      └─ next-hop-tunnels
      ├─ interfaces ─ st0.0 ─┬─ terse
      │                      └─ detail
      └─ route ⟨prefix⟩
```

Stored as an `fst::Map` keyed on the **space-joined normalised command string**, valued by
entry ordinal. The `fst` crate builds a minimal finite state transducer, supports ordered
prefix streaming, and — with its `levenshtein` feature — supports running a Levenshtein
automaton over the whole set to find all keys within a bounded edit distance. That is
exactly the three operations this matcher needs, in one structure, with no query-time
allocation beyond the output.

### 6.2 Exact prefix

The dominant case and the cheapest. The user types `show security ipsec` and wants the six
things under it.

```
prefix_hits(q) = fst.range(from: q, to: q ++ 0xFF).take(64)
```

Score: `Ŝ_prefix = 0.70 + 0.25 · (|q| / |key|)` for a key the query prefixes — so
`show security ipsec` scores `show security ipsec statistics` (0.70 + 0.25·(19/32) = 0.848)
above `show security ipsec security-associations vpn-name ⟨vpn⟩ detail` (0.70 + 0.25·(19/57)
= 0.783). Shorter, more general commands rank first for a prefix query, which is what someone
who has typed a prefix is asking for.

Cap 64: beyond that the user has not typed enough and the list is noise. The row count shown
is capped at 25 anyway (§19.4).

### 6.3 Fuzzy — two mechanisms, at two granularities

**Token-level (the common case).** One token is misspelled. For each query token not present
in the term dictionary, find candidate dictionary terms and score them:

1. **Trigram candidate generation.** The term dictionary has a companion index
   `trigram → [term_ord]`. A token is padded (`$$secuirty$$`) and split into character
   trigrams. Candidates are terms sharing ≥ 2 trigrams. This is a cheap recall filter, not a
   score.
2. **Jaro-Winkler rescoring.** Each candidate is scored with Jaro-Winkler (`p = 0.1`, prefix
   cap 4, boost applied only when Jaro > 0.7 — Winkler's threshold, pinned so the
   implementation cannot drift). Accept `JW ≥ 0.86`. Take the best 3.

Two hand-computed examples, because the threshold is the whole design and it should be
checkable:

| Pair | Jaro | prefix ℓ | Jaro-Winkler | Accepted at 0.86? |
|---|---|---|---|---|
| `secuirty` vs `security` | 0.9583 | 4 | **0.9750** | yes — this is the case the matcher exists for |
| `assoc` vs `associations` | 0.8056 | 4 | **0.8833** | yes |
| `ike` vs `ipsec` | 0.6889 | 1 | **0.6889** (below the 0.7 boost threshold, so no prefix boost) | **no** — and it must not be, because `ike` and `ipsec` name the two phases the card spends a side separating |

That last row is the reason the threshold is 0.86 and not something more forgiving. Fuzzing
`ike` into `ipsec` would produce a finder that answers Phase 1 questions with Phase 2
commands, which is the single worst thing this tool could do in this domain.

**Guard rails, all necessary:**

| Guard | Value | Why |
|---|---|---|
| Minimum token length for fuzzy | 4 | `sa`, `ike`, `esp`, `ah`, `p1`, `p2`, `st0` are all ≤3 and all mean something exact. Fuzzing them is never right. |
| Maximum fuzzy tokens per query | 2 | A query with three misspelled tokens is not a typo, it is a different query. Beyond 2 the syntax matcher returns nothing and the concept matcher carries the query. |
| Candidate cap after trigram filter | 400 | Bounds the worst case at 400 Jaro-Winkler evaluations, ~80 µs. |
| Never fuzzy across a hyphen boundary | — | `security-associations` is compared as `security` + `associations` sub-tokens as well as whole. Comparing `assoc` against the 21-character whole token gives Jaro 0.62; against the sub-token `associations` it gives 0.883. Sub-token comparison is what makes this work. |

**Whole-command-level (the second mechanism).** When the query has ≥3 tokens and looks like a
command (`g_syn` ≥ 0.5, §8.1), run the `fst` Levenshtein automaton at distance 1 over the
whole normalised command string, capped at 32 results. This catches transpositions that span
tokens and missing spaces (`showsecurity ike sa`). Distance 2 is available but off by
default: at distance 2 over a ~1,200-key FST the result set stops being precise and starts
being a list of everything short. Measure before enabling; the flag exists so it can be
measured.

### 6.4 The syntax score

```
Ŝ(e,q) = max( Ŝ_prefix(e,q),
              0.60 · cover(e,q) + 0.40 · mean_jw(e,q),
              0.55  if e matched via whole-command Levenshtein at distance 1 )
```

`cover(e,q)` = fraction of query tokens matched to a token of `e.cmd` exactly or via an
accepted fuzzy candidate, in order (order matters: `security ike` and `ike security` are not
the same command path, and an out-of-order match takes a 0.15 penalty rather than being
rejected, because people do mistype the order).

`mean_jw` is the mean Jaro-Winkler over the fuzzy-matched tokens, 1.0 for exact.

---

## 7. Matcher 3 — concept

### 7.1 Query concept set

From §3.3, a set `Q = {(c, conf)}`, then expanded by §3.4 breadth resolution.

### 7.2 Entry match strength

For entry `e` carrying concept set `C(e)`:

```
match(e, c) = 1.00   if c ∈ C(e)
              0.60   if ∃ n ∈ narrower*(c) ∩ C(e)      # one hop; see below
              0.60   if ∃ b ∈ broader(c)  ∩ C(e)
              0.35   if ∃ r ∈ related(c)  ∩ C(e)
              0.30   if opposite(c) ∈ C(e)
              0
```

Highest applicable wins; they do not sum.

**One hop only.** `narrower*` is a single hop, not a transitive closure. Transitive concept
traversal reaches everything within three hops in a densely-authored graph and turns the
concept score into a constant. If two concepts need to be two hops apart and still match,
they are one hop apart and the hierarchy is wrong.

**The `opposite` discount at 0.30 is a deliberate, card-derived choice.** Side 3:

> *"`inactive-tunnels` is the underused one — it names what is down and prints a Tunnel Down
> Reason, which is often the whole answer."*

"Is it up?" and "what is down?" are the same investigation. Scoring the opposite at zero
would bury the single most useful diagnostic command in the corpus for the single most common
query. Scoring it equally would put "what's broken" above "is it fine" for a healthy-path
query. 0.30 puts it in the visible list, below the direct answers. It appears at rank 5 in
§12 and that is where it belongs.

### 7.3 The object gate

```
C(e) = ( Σ_{c ∈ Q} conf(c) · icf(c) · match(e,c) ) / Z   ·   gate(e,Q)

Z = Σ_{c ∈ Q} conf(c) · icf(c)

gate(e,Q) = 1.00  if Q has no Object concept
            1.00  if ∃ o ∈ Q of kind Object with match(e,o) > 0
            0.35  otherwise
```

`icf(c) = ln(1 + N / entry_count(c))` — inverse concept frequency, precomputed and quantised
(§5.4). It does for concepts what IDF does for terms: `concept:act.verify` is on 300 entries
and must not dominate; `concept:p2.installed` is on 9 and should.

**The gate is the mechanism that keeps `show bgp summary` out of the tunnel results.** An
`Object` concept is the *subject* of the question. Matching only the predicate (`up`,
`verify`) means answering a different question about a different thing. 0.35 rather than 0
because the object concept is sometimes absent from the query and inferred from context, and
a hard zero would make the finder brittle in exactly the case where it is guessing.

`Z` normalises `C` into `[0,1]`, which is what makes the fusion weights in §8 interpretable
as "concept is worth 3× lexical" rather than as arbitrary constants.

---

## 8. Fusion — the ranking function

### 8.1 The function

```
S(e,q) = w_c · C(e,q)                     concept        w_c = 3.0
       + w_l · L̂(e,q)                     lexical        w_l = 1.0
       + w_s · g_syn(q) · Ŝ(e,q)          syntax         w_s = 2.0
       + w_x · X(e,q)                     context        w_x = 1.0
       + P(e,q)                           prior          (bounded ±0.45)
```

**`g_syn` is a continuous gate, not a classifier branch.**

```
g_syn(q) = ( |{t ∈ q : t ∈ cmd_token_dict}| + 0.5·|{t ∈ q : t is a strict prefix of some cmd token}| )
           ────────────────────────────────────────────────────────────────────────────────────────────
                                        |q \ stopwords|
```

For `check if a tunnel is up`: `check` is a command token (Junos `commit check`), `tunnel`
and `up` are not whole command tokens. `g_syn = 1/3 = 0.33`. For `show security ike sec
assoc`: `show`, `security`, `ike` are command tokens, `sec` and `assoc` are prefixes/
sub-token prefixes → `(3 + 2·0.5)/5 = 0.80`.

The reason this is a gate on the *weight* and not a branch to a different code path: a hard
classifier gets the boundary case wrong silently and the user has no way to tell that the
finder decided their query was "syntax" when they meant "intent". A continuous gate degrades.

### 8.2 Squashing BM25

BM25 is unbounded. Normalising by the maximum in the result set is the usual fix and it is
wrong here: it makes score magnitudes incomparable between queries, which destroys the
absolute cutoff in §8.4 and makes "no good result" indistinguishable from "one mediocre
result".

```
L̂ = bm25 / (bm25 + κ)        κ = 6.0
```

Monotone, corpus-independent, deterministic, and it puts a typical strong lexical match
(bm25 ≈ 6) at 0.5 and a weak one (bm25 ≈ 1.8) at 0.23. `κ` is pinned in the index manifest
and any change to it or to the §5.3 field boosts requires re-running the golden query set,
because the two are calibrated together.

### 8.3 The prior

```
P(e,q) = 0.10 · canonicality(e)          # authored `weight: 0..3` → 0.00 … 0.30
       + risk_prior(e.risk)              # ReadOnly +0.05, ChangesConfig −0.10, Disruptive −0.25
       − 0.25  if e has an unsatisfiable `requires` in this context
       − 0.15  if e.status == draft
       − 0.30  if e is version-gated out by the workspace's recorded version
```

The **risk prior is a safety control, not a relevance signal**, and it is stated as such.
F7: `clear security ike security-associations` and `show security ike security-associations`
share almost every word and almost every concept. Nothing in a relevance model separates
them. The card does:

> *"Clearing P1 tears down every child SA under it — on a hub that is every spoke at once."*

−0.25 on `Disruptive` does not hide the command — it is one row lower, and it is still there
when the user actually wants it, at which point they will have typed `clear` and matcher 2
will have put it back on top. It only demotes it when the user did *not* ask for it.

`requires` (corpus spec §8.4) is the "you need a value you do not have yet" dependency:
`show security ipsec statistics index ⟨id⟩` needs an SA index that only comes out of
`show security ipsec security-associations`. Demoting it by 0.25 when nothing can supply the
index is why it lands at rank 4 rather than rank 1 in §12 despite an identical concept score
to the winner.

### 8.4 Cutoff, ordering, ties

| Rule | Value |
|---|---|
| Show cutoff | `S ≥ 1.00`. Below it, the entry is not shown at any rank. |
| "Confident" band | `S ≥ 2.50` — rendered without the "did you mean" affordances. |
| Max rows | 25, virtualised. |
| Ordering key | `(−S_milli, −canonicality, corpus_id)` — descending score in **integer milli-units**, then descending authored canonicality, then ascending corpus id as a total tie-break. |
| Empty result | `S_max < 1.00` for every entry → the miss state (§19.5), and a line in the local miss log. |

**Scores are ordered as `i32` milli-units.** Accumulate in `f64` in a fixed iteration order
(entries in ordinal order, terms in dictionary order — both `BTreeMap`/slice iteration, never
a hash map), then quantise with `(s * 1000.0).round() as i32` exactly once. Ordering never
touches a float. This costs a rounding artefact at the third decimal and buys a guarantee
that the CLI, the WASM build and the golden test all produce the same list.

### 8.5 Where the weights came from, and what would change them

Honest answer: they are chosen from the structure of the problem, not fitted to data, because
there is no data yet.

| Weight | Reasoning | What would move it |
|---|---|---|
| `w_c = 3.0` | §2: for the flagship query the lexical overlap with the correct answer is *zero*. Concept has to be able to win alone. At `w_c = 3` a full concept match (1.0) outscores a strong lexical match (L̂ ≈ 0.5) by 6:1. | If the golden set shows concept-only matches beating obviously-better lexical matches, drop toward 2.5. |
| `w_l = 1.0` | The unit. Everything else is expressed as a multiple of "a decent word match". | — |
| `w_s = 2.0` | Gated by `g_syn`, so its effective weight on an intent query is near zero and on a syntax query is near 2.0. When someone types command text, they know what they want and matching it should dominate. | If prefix queries return the right family but the wrong specificity, tune the §6.2 length term first, not this. |
| `w_x = 1.0` | Context is worth about as much as a decent word match: it should reorder near-ties, never overturn a clear winner. A workspace with one tunnel in it must not make every tunnel command outrank a directly-matching one. | If users report "it keeps giving me commands for the device I have open", drop to 0.6. |
| `P` bounded ±0.45 | The prior must be able to demote a `Disruptive` command past a near-tie and must never be able to overturn a real relevance difference. `Disruptive` (−0.25) plus draft (−0.15) is −0.40; a full concept match is +3.00. | — |

These are pinned in `finder.toml` alongside the corpus, shipped with the index, and printed
in the debug panel. Changing one is a corpus release, diffable, with the golden-set delta in
the changelog.

---

## 9. Index structures, sizes, and the build

### 9.1 Layout

One file, `finder.idx`, a versioned little-endian slab. Sections are 8-byte aligned and
addressed by an offset table so the whole thing is usable zero-copy from a single
`Vec<u8>` — no deserialisation pass on load, no per-entry allocation.

| § | Structure | Contents |
|---|---|---|
| `HDR` | fixed 64 B | magic, format version, corpus semver, blake3 of the rest, offsets |
| `TERM` | `fst::Map<Vec<u8>>` | normalised term → `(postings_offset, df, idf_milli)` packed into the FST value `u64` |
| `POST` | delta-varint blocks | per term: `[Δdocid varint][field bitmap u8][per-field tf nibbles]` |
| `NORM` | `[u16; entries × fields]` | precomputed reciprocal length norms |
| `CMD` | `fst::Map<Vec<u8>>` | normalised full command string → entry ordinal |
| `TRI` | `[(u32 trigram, u32 term_ord)]`, sorted | trigram → term candidates, binary-searched |
| `CPHR` | `fst::Map<Vec<u8>>` | concept surface phrase → `(concept_ord, conf_milli)` |
| `CGRF` | CSR adjacency | concept graph: narrower / broader / related / opposite, and `entry_count`, `icf_milli` |
| `E2C` | CSR adjacency | entry → concepts |
| `C2E` | CSR adjacency | concept → entries (the reverse index; drives candidate generation) |
| `META` | `[EntryMeta; entries]` | 24 B per entry: platform id, risk, canonicality, status, version predicate ordinal, slot count, ladder membership bitset offset |
| `TEXT` | zstd blocks, 64 entries per block | the display payload: `cmd`, `answers`, `read_field`, risk label, slot spans. Decompressed lazily, LRU of 8 blocks. |

`TEXT` is separate and lazy on purpose: the ranked list needs 25 entries' display text, not
1,200. Everything above `TEXT` is resident.

### 9.2 Why CSR and not `HashMap`

Compressed sparse row (`offsets: [u32; n+1]`, `values: [u32; nnz]`) for every adjacency.
Reasons, in order: it is iterable in a deterministic order without sorting (invariant 9); it
is zero-copy from the slab; it has no per-entry allocation; and its traversal is a sequential
read, which is the access pattern the candidate generator has. A `HashMap` gives none of
these and costs a full rebuild on load.

### 9.3 Candidate generation

The union of three sets, capped:

```
candidates = ( ⋃_{c ∈ Q}  C2E[c]                     )      # concept postings, capped 600
           ∪ ( ⋃_{t ∈ q}  postings(t) if df(t) ≤ 400 )      # lexical, skip near-stopword terms
           ∪ ( prefix_hits ∪ fuzzy_hits               )      # syntax, capped 64 + 32
```

Capped at **1,024 distinct entries**. Beyond that the query is not selective and the extra
entries cannot reach the cutoff anyway. Scoring is then a single pass over the candidate set
with a bounded binary heap of size 25.

The `df(t) ≤ 400` skip is what stops `show` from being a candidate generator. `show` still
*scores* (its idf is tiny, so it contributes almost nothing), but it does not drag 900
entries into the candidate set.

### 9.4 Size — planning figures

**These are computed from assumptions, not measured. Nothing is built yet.** Assumptions
stated so they can be checked against reality on day one.

Assumed v1 corpus: **1,200 command entries** (junos-srx ≈ 420, ios-xe/ios ≈ 260, panos ≈ 210,
fortios ≈ 150, nx-os/eos/other ≈ 160), **~340 concepts**, ~30 indexed tokens per entry after
normalisation, ~9,000 distinct terms.

| Section | Derivation | Size |
|---|---|---|
| `TERM` | 9,000 keys, FST with a `u64` value each | ~110 KB |
| `POST` | 1,200 × 30 = 36,000 postings × ~4 B | ~144 KB |
| `NORM` | 1,200 × 8 fields × 2 B | ~19 KB |
| `CMD` | 1,200 command strings, mean 34 B, FST-shared prefixes | ~46 KB |
| `TRI` | 9,000 terms × ~8 trigrams × 8 B | ~576 KB |
| `CPHR` | ~2,400 surface phrases | ~44 KB |
| `CGRF` + `E2C` + `C2E` | ~4,800 concept-entry pairs + ~1,100 concept edges, CSR | ~30 KB |
| `META` | 1,200 × 24 B | ~29 KB |
| **Resident total** | | **≈ 1.0 MB** |
| `TEXT` | 1,200 entries × ~260 B, zstd ≈ 3.5:1 | ~89 KB on disk, ≤ 24 KB resident (8-block LRU) |

`TRI` is over half of it and is the obvious optimisation target: switching the postings from
`u32 term_ord` to `u16` (viable to 65,535 terms) halves it. Not worth doing until the corpus
is real.

Scaling: roughly linear. A 10,000-entry corpus is ~8 MB resident, which is still fine in a
browser tab and is the point at which `TRI` should be reworked into a bit-signature filter.

**In the offline single-file build** the index is embedded base64, costing 4/3: ~1.4 MB of
the HTML. Against a target single file in the tens of megabytes that is acceptable and it is
the number §21 compares a model against.

### 9.5 The build is part of the corpus build

`fathom-corpus build` → `finder.idx` + `finder.toml` (the weights) + a blake3 content hash
published in the corpus manifest. Deterministic: sorted iteration everywhere, no `HashMap`
in the builder, no timestamps in the output, `SOURCE_DATE_EPOCH` respected. Two builds of the
same corpus tree produce byte-identical index files, and CI asserts it — the same property the
rule packs assert on their tree hash.

### 9.6 The golden query set

`golden/queries.yaml`: ~120 queries with pinned expected top-3 and a short note on why.

```yaml
- q: "check if a tunnel is up"
  note: "the brief's own example; must produce the bring-up ladder group"
  expect_group: ladder:junos-srx/ipsec.bringup
  expect_top3: [junos-srx/ike.sa.show, junos-srx/ipsec.sa.show, junos-srx/ipsec.inactive-tunnels]
- q: "why does it stall on big files"
  expect_top3: [junos-srx/ping.dnf-sized, junos-srx/mtu.st0.show, junos-srx/flow.tcp-mss.show]
- q: "clear the tunnel"
  note: "must NOT put the unscoped P1 clear first — risk prior"
  expect_not_rank1: junos-srx/ike.sa.clear-all
```

A diff in the golden set is a **review item, not a build failure**. The reviewer decides
whether the ranking moved because the corpus got better or because someone broke it. A hard
failure here would train authors to update the expectations without reading them, which is
how golden tests stop working.

---

## 10. Latency budget

Target: **16.67 ms keystroke to painted frame**, one frame at 60 Hz, per the brief's bar.

| Stage | Budget | Basis |
|---|---|---|
| Event → WASM call | 0.3 ms | JS event handling + one string copy across the boundary |
| Normalise + tokenise + lemmatise | 0.1 ms | ~8 tokens, no allocation beyond a 256 B stack buffer |
| Concept surface lookup | 0.05 ms | ≤24 FST lookups |
| Breadth resolution | 0.02 ms | ≤4 CSR traversals |
| Candidate generation | 0.4 ms | ≤1,024 entries into a bitset; CSR sequential reads |
| BM25F scoring | 0.6 ms | ≤6 terms × ≤400 postings = 2,400 postings; integer-heavy inner loop |
| Concept scoring | 0.3 ms | ≤1,024 candidates × ≤8 query concepts, CSR intersect |
| Fuzzy (worst case) | 0.5 ms | ≤2 tokens × 400 candidates × Jaro-Winkler |
| FST prefix / Levenshtein | 0.4 ms | capped at 64 / 32 results |
| Fusion + top-25 heap | 0.15 ms | |
| Slot resolution (§16) | 0.5 ms | ≤25 rows × ≤3 slots, graph index lookups |
| `TEXT` decompression | 0.6 ms | ≤3 zstd blocks on a cold cache, 0 warm |
| **Matching subtotal** | **≈ 3.9 ms cold, ≈ 2.5 ms warm** | |
| WASM → JS result marshalling | 0.4 ms | packed `[u32 ordinal, i32 score, u16 span…]`, not JSON |
| Render 25 virtualised rows | 6–9 ms | the actual variable; this is a UI problem, not a search problem |
| **Total** | **≈ 11–14 ms** | |

**The honest headline: matching is not the hard part. The render is.** Anyone optimising this
should instrument the render first. The three things that will blow the budget, in order of
likelihood:

1. **Re-rendering unchanged rows.** Keyed rows, `memo` on `(ordinal, score, slot_state)`.
2. **Marshalling as JSON.** `JSON.stringify`/`parse` of 25 result objects with nested slot
   spans is comfortably a millisecond and it is pure waste. Return a packed buffer, resolve
   display text lazily per visible row.
3. **Layout thrash from the ladder group.** A group that expands/collapses on every keystroke
   forces reflow. The group's collapsed height is fixed.

**No debounce.** A debounce is the admission that the search is too slow, and it converts a
fast search into a laggy one perceptually. If a query cannot be served in a frame, the fix is
the query path, not a timer. The one exception is the whole-command Levenshtein pass in §6.3,
which is only run when `g_syn ≥ 0.5` and is capped.

---

## 11. Query shape classification and routing

The brief's four shapes. All four run through the same pipeline; the classifier only decides
**routing and presentation**, never which matchers run.

| Shape | Detection | Effect |
|---|---|---|
| **A — Intent → command** | Default. No other shape's detector fires. | Nothing special. §12. |
| **B — Half-remembered syntax** | `g_syn ≥ 0.5`. Continuous, not a branch (§8.1). | Syntax weight rises with `g_syn`. Results render with the matched prefix highlighted. §13. |
| **C — Cross-vendor** | A platform-name token (`junos`, `srx`, `cisco`, `ios`, `palo`, `pan`, `panos`, `fortigate`, `fortios`, `nexus`, `nx-os`, `arista`, `eos`) **and** a translation cue (`version of`, `equivalent`, `equivalent of`, `in`, `on`, `for`, `→`, `->`, `to`) **and** a residue with `g_syn ≥ 0.5` against a *different* platform's command tree. All three, or it is shape A. | Re-route to the Rosetta path. §14, §18. |
| **D — Reverse** | First non-stopword token ∈ `{show, set, delete, clear, monitor, ping, traceroute, request, restart, get, diagnose, execute, display, run, configure, commit}` **and** the query matches ≥2 tokens deep into some command tree. | Re-route to reverse explanation. §15. |

**Ambiguity between C and D** is real: `show crypto ipsec sa junos` fires both. Rule: C wins
when a platform token is present *and* the syntax residue matches a platform other than the
named one. Otherwise D.

**Ambiguity between A and D** is also real and is handled by not resolving it: a query that
fires D still gets shape-A results below the reverse explanation, under a hairline. Someone
who pastes `show security ipsec security-associations` may want to know what it does, or may
want the neighbouring commands. Give both, in that order, and let one keystroke pick.

---

## 12. Worked trace A — "check if a tunnel is up"

The brief's own example, computed end to end. Corpus assumptions from §9.4 (`N = 1,200`).
Workspace: one SRX device (`junos-srx`, version recorded), one `IpsecVpn` named
`VPN-DC-EAST` with `bind-interface st0.0`, one `IkeGateway` with `address 203.0.113.10`.

### 12.1 Normalisation

```
raw:        "check if a tunnel is up"
tokens:     [check] [if]* [a]* [tunnel] [is]* [up]        (* = stopword-marked, retained)
lemmas:     check, if, a, tunnel, is, up                  (no suffix stripped: len<5 or in identifier lexicon)
shapes:     Word × 6
g_syn:      "check" ∈ cmd_token_dict (Junos `commit check`); tunnel, up are not
            = 1 / 3 non-stopword tokens = 0.333
```

### 12.2 Concept lookup (§3.3, leftmost-longest)

| Window | Hit | Concept | conf |
|---|---|---|---|
| `check if a tunnel` (4) | — | | |
| `check if a` (3) | — | | |
| `check if` (2) | — | | |
| `check` (1) | ✔ | `concept:act.verify` | 1.00 |
| `if a tunnel is` … | — | | |
| `tunnel` (1) | ✔ | `concept:obj.tunnel` | 1.00 |
| `is up` (2) | ✔ | `concept:state.operational` | 0.80 |

`is up` beats bare `up` (0.72) by leftmost-longest, which is why stopwords are retained
(§4.3). Query concept set:

```
Q = { act.verify 1.00, obj.tunnel 1.00, state.operational 0.80 }
```

<!-- VERIFY: that `commit check` is spelled exactly that way in the Junos operational/
configuration mode this corpus targets, since it is what puts `check` in cmd_token_dict and
therefore sets g_syn to 0.333 rather than 0. If it is not, g_syn is 0 and the syntax term
drops out entirely — which does not change the ranking below, because Ŝ = 0 for every
candidate anyway. -->

### 12.3 Breadth resolution

`state.operational` is `State`, `|narrower| = 4`, and 3 of the 4 have entries on `junos-srx`
(`p1.established`, `p2.installed`, `dataplane.passing`; `iface.link-up` also does — 4 of 4).
`obj.tunnel` is present. So:

- `state.operational` is marked **BROAD**.
- Narrower concepts enter `Q` as derived at `conf × 0.6`.
- Ladder `ladder:junos-srx/ipsec.bringup` declares
  `answers_concepts: [state.operational, p1.established, p2.installed]` and
  `object: obj.tunnel` → it becomes a candidate group.
- Its entry point for `act.verify` is step `p1` (not `guard`, which is the `commit
  confirmed 5` step and belongs to `act.deploy`).

### 12.4 Precomputed quantities used below

| Quantity | Value | Derivation |
|---|---|---|
| `idf(tunnel)`, df = 96 | 2.521 | `ln(1 + (1200−96+0.5)/96.5) = ln(12.446)` |
| `idf(up)`, df = 140 | 2.146 | `ln(1 + 1060.5/140.5) = ln(8.548)` |
| `idf(check)`, df = 58 | 3.022 | `ln(1 + 1142.5/58.5) = ln(20.530)` |
| `icf(obj.tunnel)`, 84 entries | 2.727 | `ln(1 + 1200/84)` |
| `icf(act.verify)`, 300 entries | 1.609 | `ln(1 + 1200/300) = ln 5` |
| `icf(state.operational)`, 40 entries | 3.434 | `ln(1 + 1200/40) = ln 31` |
| `Z` | 6.809 | `1.00·2.727 + 1.00·1.609 + 0.80·3.434` … see note |

Note on `Z`: computed with the *pre-breadth* query concepts at their authored confidences.
Derived narrower concepts do not enter `Z` — otherwise breadth resolution would dilute the
normaliser and depress every score on exactly the queries it is meant to help. Using
conf 0.72 for bare `up` gives `Z = 6.809`; with `is up` at 0.80, `Z = 2.727 + 1.609 + 2.747
= 7.083`. **The trace below uses `Z = 6.809`** and the corresponding `state.operational`
weight of `0.72 × 3.434 = 2.473`, i.e. the bare-`up` case, because it is the harder and more
common one. With `is up` every `C` below rises by ~4% and the ordering does not change.

### 12.5 Candidates and their concept sets

| # | Entry | `cmd` | Concepts | Risk | `weight` |
|---|---|---|---|---|---|
| E1 | `junos-srx/ipsec.sa.show` | `show security ipsec security-associations` | obj.tunnel, p2.installed, act.verify | ReadOnly | 3 |
| E2 | `junos-srx/ike.sa.show` | `show security ike security-associations` | obj.ike-sa, p1.established, act.verify | ReadOnly | 3 |
| E3 | `junos-srx/ipsec.inactive-tunnels` | `show security ipsec inactive-tunnels` | obj.tunnel, state.down, act.diagnose | ReadOnly | 2 |
| E4 | `junos-srx/ipsec.statistics.index` | `show security ipsec statistics index ⟨id⟩` | obj.tunnel, dataplane.passing, act.verify | ReadOnly | 1 |
| E5 | `junos-srx/interface.st0.terse` | `show interfaces ⟨st0-unit⟩ terse` | obj.st0, state.operational, act.verify | ReadOnly | 1 |
| E8 | `junos-srx/interface.terse` | `show interfaces terse` | obj.interface, state.operational, act.verify | ReadOnly | 2 |
| E9 | `junos-srx/bgp.summary` | `show bgp summary` | obj.bgp-peer, bgp.established, act.verify | ReadOnly | 2 |

`obj.ike-sa`, `obj.ipsec-sa` and `obj.st0` are `narrower` of `obj.tunnel`. `obj.interface`
and `obj.bgp-peer` are not.

### 12.6 Concept scores

```
C(e) = ( Σ conf(c)·icf(c)·match(e,c) ) / 6.809 · gate(e)
```

| Entry | obj.tunnel term | act.verify term | state.operational term | Σ | `gate` | **C** |
|---|---|---|---|---|---|---|
| E1 | 2.727 × 1.00 = 2.727 | 1.609 × 1.00 = 1.609 | 2.473 × 0.60 = 1.484 (p2.installed, narrower) | 5.820 | 1.00 | **0.855** |
| E2 | 2.727 × 0.60 = 1.636 (ike-sa, narrower) | 1.609 | 2.473 × 0.60 = 1.484 (p1.established) | 4.729 | 1.00 | **0.695** |
| E3 | 2.727 × 1.00 = 2.727 | 1.609 × 0.35 = 0.563 (diagnose, related) | 2.473 × 0.30 = 0.742 (state.down, opposite) | 4.032 | 1.00 | **0.592** |
| E4 | 2.727 | 1.609 | 2.473 × 0.60 = 1.484 (dataplane.passing) | 5.820 | 1.00 | **0.855** |
| E5 | 2.727 × 0.60 = 1.636 (st0, narrower) | 1.609 | 2.473 × 1.00 = 2.473 (direct) | 5.718 | 1.00 | **0.840** |
| E8 | 0 | 1.609 | 2.473 | 4.082 | **0.35** | **0.210** |
| E9 | 0 | 1.609 | 0 | 1.609 | **0.35** | **0.083** |

The object gate does the work on E8 and E9. Without it, `show interfaces terse` scores 0.600
and lands third.

### 12.7 Lexical scores

Query terms after stopword exclusion: `check`, `tunnel`, `up`.

**E1.** `answers: "Is Phase 2 installed and passing traffic?"` — contains none of them.
`aka: [tunnel up, is the vpn up, p2 state, phase 2 status]`, 12 tokens, `avgdl` 12, `b` 0.30
→ norm = 1.000. `explain.terse` contains `tunnel` twice, 40 tokens vs `avgdl` 34, `b` 0.75 →
norm = 0.25 + 0.75·(40/34) = 1.132.

| term | `tf̃` | `tf̃/(k₁+tf̃)` | × idf | |
|---|---|---|---|---|
| `tunnel` | 2.0·1/1.000 + 0.4·2/1.132 = 2.707 | 0.693 | 1.747 | |
| `up` | 2.0·2/1.000 = 4.000 | 0.769 | 1.650 | |
| `check` | 0 | — | 0 | **the highest-idf term in the query contributes nothing to the right answer** |
| | | | **3.397** | `L̂ = 3.397/9.397 = 0.362` |

**E5.** `answers: "Is the tunnel interface up?"` — 5 tokens, `avgdl` 9, `b` 0.75 → norm =
0.25 + 0.75·(5/9) = 0.667. Both `tunnel` and `up` present at tf 1, boost 3.0 → `tf̃` = 4.500
each → 0.789 each → 1.990 + 1.694 = **3.684**, `L̂ = 0.380`.

**E2.** `answers: "Is Phase 1 up with this peer?"` (8 tokens, norm 0.917) → `up` `tf̃` =
3.0/0.917 = 3.272, plus `aka` "ike up" → +2.000 = 5.272 → 0.815 → 1.748. `tunnel` only in
`explain.terse` → 0.574. Total **2.322**, `L̂ = 0.279`.

**E3.** `cmd` token `inactive-tunnels` emits sub-token `tunnels` → lemma `tunnel`, boost
1.0 × sub 0.6, norm 1.000 → 0.600. `answers: "Which tunnels are down, and what reason does
the box give?"` (11 tokens, norm 1.167) → 3.0/1.167 = 2.571. `tf̃` = 3.171 → 0.726 → **1.829**,
`L̂ = 0.234`.

**E4.** `answers: "Is the tunnel actually passing packets, in both directions?"` (9 tokens,
norm 1.000) → `tf̃(tunnel)` = 3.000 → 0.714 → **1.801**, `L̂ = 0.231`.

**E8.** `answers: "Which interfaces are up, admin and link?"` (8 tokens, norm 0.917) →
`tf̃(up)` = 3.272 → 0.732 → **1.570**, `L̂ = 0.207`.

**E9.** ≈ 0.02.

### 12.8 Context and prior

Workspace has an SRX and one `IpsecVpn`. `X = 0.10·(fraction of slots resolvable) +
0.15·(platform present in workspace)`.

| Entry | slots | resolvable | `X` | `P` |
|---|---|---|---|---|
| E1 | `vpn` → `IpsecVpn.name` | yes (sole candidate) | 0.25 | 0.30 + 0.05 = **0.35** |
| E2 | `peer` → `IkeGateway.address` | yes | 0.25 | **0.35** |
| E3 | none | n/a → 1.0 | 0.25 | 0.20 + 0.05 = **0.25** |
| E4 | `id` → **runtime SA index** | **no source in the graph** | 0.15 | 0.10 + 0.05 − 0.25 = **−0.10** |
| E5 | `st0-unit` → `IpsecVpn.bind_interface` | yes | 0.25 | 0.10 + 0.05 = **0.15** |
| E8 | none | n/a | 0.25 | 0.20 + 0.05 = **0.25** |
| E9 | none | n/a | 0.25 | **0.25** |

### 12.9 Fusion

`S = 3.0·C + 1.0·L̂ + 2.0·0.333·Ŝ + 1.0·X + P`. Every `Ŝ` is 0 here — no candidate's command
text matches `check`, `tunnel` or `up` as a command token — so the syntax term vanishes
despite `g_syn` being non-zero. That is the gate behaving correctly.

| Rank | Entry | `3·C` | `L̂` | `X` | `P` | **S** |
|---|---|---|---|---|---|---|
| 1 | E1 `show security ipsec security-associations` | 2.564 | 0.362 | 0.25 | 0.35 | **3.526** |
| 2 | E5 `show interfaces st0.0 terse` | 2.519 | 0.380 | 0.25 | 0.15 | **3.300** |
| 3 | E2 `show security ike security-associations` | 2.084 | 0.279 | 0.25 | 0.35 | **2.963** |
| 4 | E4 `show security ipsec statistics index ⟨id⟩` | 2.564 | 0.231 | 0.15 | −0.10 | **2.845** |
| 5 | E3 `show security ipsec inactive-tunnels` | 1.777 | 0.234 | 0.25 | 0.25 | **2.510** |
| 6 | E8 `show interfaces terse` | 0.629 | 0.207 | 0.25 | 0.25 | **1.336** |
| — | E9 `show bgp summary` | 0.248 | 0.020 | 0.25 | 0.25 | **0.768** — below the 1.00 cutoff, not shown |

**Read the failures in this table, because they are the argument for the rest of the design.**

- **Lexical alone gets it wrong.** By `L̂`, E5 (`show interfaces st0.0 terse`, 0.380) beats E1
  (0.362). "Is the tunnel interface up?" contains literally every content word of the query.
  It is also not the first thing you run, and side 1 of the card says so explicitly: st0 is
  step 5, after P1 and P2. **The concept layer is what demotes it, and it only just does.**
- **E4 has an identical concept score to the winner** and lands fourth entirely on the
  `requires`-unsatisfiable penalty and its low canonicality. Without `requires`, the finder
  would hand a user a command containing `index ⟨id⟩` with no way to fill it.
- **E3, the card's "underused one", reaches rank 5 only through the `opposite` discount.** It
  carries `state.down`, the polar opposite of what was asked. At `opposite = 0` it scores
  1.768 and sits below `show interfaces terse`.
- **E9 is excluded by one mechanism only**: the object gate. Its `act.verify` match is real.

### 12.10 The grouping transform

Breadth resolution (§12.3) produced a ladder candidate. Post-ranking, §17.3 applies:

```
group_score = max(S over members present in the ranked list) = 3.526
members     = ranked list ∩ ladder.steps, ordered by LADDER POSITION, not by S
```

Final rendering:

```
▌ BRING-UP LADDER — junos-srx · 6 of 9 steps apply here          verify as you go
  1  show security ike security-associations 203.0.113.10                 READ-ONLY
     P1 up?      read: State — want UP
  2  show security ipsec security-associations vpn-name VPN-DC-EAST detail  READ-ONLY
     P2 installed?   read: State — want Installed
     ┄ 4 more steps — → to walk it ┄

  show security ipsec statistics index ⟨id⟩                               READ-ONLY
    Is the tunnel actually passing packets, in both directions?
    read: encrypted vs decrypted byte counters
    needs: an SA index — get it from show security ipsec security-associations

  show interfaces terse                                                   READ-ONLY
    Which interfaces are up, admin and link?
```

The order inside the group is P1 → P2 → inactive-tunnels → st0 → route → ping: **the card's
own bring-up order**, reproduced not by hardcoding it but because the ladder is corpus data
and the finder selected it. The most useful diagnostic fact on the card — *"P1 can be
perfectly healthy while P2 fails forever"* — is expressed as an ordering rather than as a
sentence someone has to read.

**The cost, stated plainly.** A user who typed "check if a tunnel is up" and wanted exactly
one command now sees a group. That is one extra glance, every time, on the most common query
in the product. Mitigations: the group collapses to two rows; `↓` past it reaches flat
results in one keystroke; and a `flat results` preference exists. If telemetry existed we
would measure this — it does not (invariant 1), so the only evidence available will be the
miss log and people complaining, and the design should be revisited on either.

---

## 13. Worked trace B — half-remembered syntax

Query: `show security ike sec assoc`

```
tokens:  show, security, ike, sec, assoc
g_syn:   show ✔ security ✔ ike ✔ (whole command tokens)
         sec → strict prefix of "security" ✔ (0.5)
         assoc → not a whole token; sub-token prefix of "associations" ✔ (0.5)
       = (3 + 2×0.5) / 5 = 0.80
```

**Concept matcher:** `ike` is a surface of `concept:obj.ike-sa` (conf 0.85). `show` is a
surface of `concept:act.verify` (conf 0.60). Nothing else. `C` is real but modest.

**Syntax matcher:**

1. `show security ike` is an exact prefix of 11 keys in `CMD`. Prefix stream returns them.
2. `sec` and `assoc` are not in the term dictionary. Trigram candidates for `assoc`
   (`$$a`, `$as`, `ass`, `sso`, `soc`, `oc$`, `c$$`) intersect the sub-token `associations`.
   Jaro-Winkler(`assoc`, `associations`) = **0.883** ≥ 0.86 → accepted, `mean_jw` term.
   `sec` → `security`: Jaro-Winkler(`sec`, `security`) — but `sec` is length 3, below the
   minimum fuzzy length of 4, so it is *not* fuzzy-matched. It matches as an exact **prefix**
   in the prefix walk instead, which is both cheaper and more precise.
3. `cover` for `show security ike security-associations` = 5/5 (three exact, `sec` by prefix,
   `assoc` by fuzzy), in order, no penalty. `mean_jw` = (1+1+1+1+0.883)/5 = 0.977.
   `Ŝ = 0.60·1.00 + 0.40·0.977 = 0.991`.

**Fusion** for the leaf `show security ike security-associations`:

```
S = 3.0 · C(≈0.31) + 1.0 · L̂(≈0.44) + 2.0 · 0.80 · 0.991 + 0.25 + 0.35
  = 0.930 + 0.440 + 1.586 + 0.25 + 0.35 = 3.556
```

versus `show security ike security-associations detail`, whose `cover` is also 5/5 but whose
`Ŝ_prefix` term is lower (the query covers less of a longer key) and whose canonicality is 2
rather than 3: `S ≈ 3.34`. Versus `show security ike active-peer`, which shares the `show
security ike` prefix but has `cover` = 3/5 and no fuzzy match for `assoc`:
`Ŝ = 0.60·0.60 + 0.40·1.0 = 0.760`, `S ≈ 2.75`.

Result order: the exact leaf, then `detail`, then `index ⟨n⟩ detail`, then `active-peer`.
The syntax term contributes 1.586 of the winner's 3.556 — 45% — which is what `g_syn = 0.80`
is for.

**The rendering difference for shape B:** matched spans are highlighted in the command text
(exact spans in ink, fuzzy spans underlined), so the user can see that `assoc` was read as
`associations` and that `ike` was *not* read as `ipsec`. Showing the fuzz is how the user
learns to trust it.

---

## 14. Worked trace C — cross-vendor

Query: `Junos version of show crypto ipsec sa`

**Detection (§11):** platform token `junos` ✔; translation cue `version of` ✔; residue
`show crypto ipsec sa` has `g_syn` = 1.00 against the `ios-xe` command tree and 0.00 against
`junos-srx` ✔. All three → shape C.

**Step 1 — resolve the source.** `show crypto ipsec sa` → `ios-xe/ipsec.sa.show`, exact.

**Step 2 — read its concepts,** not its text:

```
C(ios-xe/ipsec.sa.show) = { obj.ipsec-sa, p2.installed, act.verify, attr.spi, attr.counters }
```

**Step 3 — find target-platform entries carrying those concepts,** filtered to `junos-srx`,
scored by concept overlap weighted by `icf`. Then look up the authored `rosetta` document for
the pair (§18) to get the equivalence class and the `differs` line.

**Result:**

```
  show crypto ipsec sa                    ios-xe
  ───────────────────────────────────────────────────────────────────────────
  show security ipsec security-associations                junos-srx   SAME
     Is Phase 2 installed and passing traffic?
     read: State — want Installed

  show security ipsec statistics index ⟨id⟩                junos-srx   NARROWER
     differs: IOS prints packet and byte counters inside the same SA output.
              On Junos the counters are a separate command, keyed by SA index.

  show security ipsec inactive-tunnels                     junos-srx   NO EQUIVALENT ON ios-xe
     differs: Junos names what is down and prints a Tunnel Down Reason. IOS has
              no command that reports a reason for an SA that does not exist —
              you read the ISAKMP/IKEv2 debug instead.
```

The third row is the point. It is the one the user needs, it is the one no lookup table
would produce, and it is authored as `equivalence: none` **in the reverse direction** with a
`differs` sentence. A Rosetta layer that only emits pairs it can match is a Rosetta layer that
silently hides the interesting half of the mapping.

**Step 4 — the reverse of the query is offered as one keystroke.** `Tab` swaps direction:
"what is the IOS-XE version of `show security ipsec inactive-tunnels`" → `none`, with the
same sentence read the other way.

---

## 15. Worked trace D — reverse

Query (pasted): `user@srx-a> show security ipsec security-associations vpn-name VPN-B detail | match Installed`

### 15.1 Normalisation

| Step | Result |
|---|---|
| Prompt strip (§4.1 step 3) | `show security ipsec security-associations vpn-name VPN-B detail \| match Installed` |
| Pipe split (step 5) | command = `show security ipsec security-associations vpn-name VPN-B detail`; filter = `match Installed` |
| Tokenise, shape-classify | `show`(Word) `security`(Word) `ipsec`(Word) `security-associations`(Word) `vpn-name`(Word) `VPN-B`(Identifier) `detail`(Word) |

### 15.2 Longest-prefix walk with argument capture

Walk the `CMD` FST greedily. Corpus entries in that subtree:

```
show security ipsec security-associations                          → ipsec.sa.show
show security ipsec security-associations detail                   → ipsec.sa.show-detail
show security ipsec security-associations vpn-name ⟨vpn⟩ detail    → ipsec.sa.show-vpn-detail
show security ipsec security-associations index ⟨n⟩ detail         → ipsec.sa.show-index-detail
```

`⟨vpn⟩` is a **slot**, declared on the entry (corpus spec §6). Slots match any token whose
shape is in the slot's declared `accepts` list. `VPN-B` is `Identifier`; the `vpn` slot
accepts `Identifier` → match. Full-depth match on `ipsec.sa.show-vpn-detail`, with
`vpn := "VPN-B"` captured.

**Degradation is explicit, never silent.** If the walk stops short — say the user pasted a
knob the corpus does not carry — the result is:

```
  matched:     show security ipsec security-associations
  not in corpus:  ⟨foo⟩ bar
  → this is show security ipsec security-associations, with two arguments Fathom
    does not have an entry for. File a corpus gap?
```

Guessing at the meaning of unrecognised tokens is the failure mode that makes a reverse
explainer untrustworthy: one confident wrong explanation costs more than ten honest gaps.

### 15.3 Filter clauses

Filters are their own small corpus (`junos-srx/filter.match`, `filter.last`,
`filter.display-set`, `filter.count`, `filter.except`, `filter.no-more`), explained
separately below the command:

```
  | match Installed        keeps only lines containing "Installed". Case-sensitive.
                           Filtering SA output by State hides the SPI and lifetime
                           lines you usually want next.
```

### 15.4 What the result renders

Command explanation at the active depth, the captured arguments named, `output_fields`
(§17.1), then the shape-A results underneath the hairline (§11's A/D ambiguity rule).

### 15.5 `set` and `delete` lines route elsewhere

A pasted **configuration** line (`set security ipsec vpn VPN-B bind-interface st0.0`) is not
a command-corpus lookup. It parses to a `StatementPath` and enters the explainer resolution
ladder in `13-emitters-and-provenance.md` §12.2 — `explain:line:` → `explain:field:` →
`explain:kind:` → honest fall-through. **One corpus, one resolution path, entered from a
different key.** The finder detects the `set`/`delete`/`deactivate`/`activate` verb and
hands off; it does not implement a second explainer.

---

## 16. Context awareness and slot binding

Brief §6.1:

> *"With a workspace open, results interpolate real values — `...vpn-name VPN-DC-EAST detail`,
> paste-ready. The difference between a lookup and an answer."*

The hard question is not interpolation. It is **which object**, when several match.

### 16.1 Slots

```rust
pub struct Slot {
    pub name: Box<str>,                 // "vpn", "peer", "st0-unit", "prefix", "id"
    /// Where a value could come from in the graph. None ⇒ runtime-only (§16.4).
    pub binds: Option<Binding>,
    /// Token shapes acceptable in reverse capture (§15.2).
    pub accepts: ShapeSet,
    /// Rendered when unresolved. Always angle-bracketed.
    pub placeholder: Box<str>,          // "<vpn-name>"
    pub required: bool,
}

pub struct Binding {
    pub kind: KindId,                   // IpsecVpn
    pub field: FieldId,                 // name
    /// Optional edge chain from the anchor to `kind`, ≤3 hops, edge ROLES not names.
    pub via: SmallVec<[EdgeRole; 3]>,
}
```

Bindings reference **kinds, fields and edge roles by id** — invariant 7. Renaming
`VPN-DC-EAST` re-interpolates; it does not break the slot.

### 16.2 The resolution ladder — deterministic, five rungs, no guessing at the bottom

| # | Rung | Rule | Example |
|---|---|---|---|
| 1 | **Named in the query** | A query token whose shape and value match a candidate node's bound field, case-insensitively. Beats everything. | `check VPN-DC-EAST` → binds that VPN, even if another is selected. |
| 2 | **Focus** | The shell maintains a `FocusStack` (depth 8, most-recent-first) of node ids: the diagram selection, the config block open in the inspector, the node the last finding attached to, the node last edited. First entry of the required kind (or reachable from one by the slot's `via` chain) wins. | Inspector open on `VPN-DC-EAST` → that VPN. |
| 3 | **Sole candidate** | Exactly one node of the required kind exists in the workspace. | A workspace with one tunnel. |
| 4 | **Recency** | Most recently *edited* node of the required kind, if edited within the session. Not most recently viewed — viewing is rung 2's job and conflating them makes rung 4 fire on things the user merely scrolled past. | |
| 5 | **Ambiguous** | **Stop. Do not pick.** | Three tunnels, none focused. |

Rung 5 renders the slot as a **chooser chip** inline in the command:

```
  show security ipsec security-associations vpn-name [ VPN-DC-EAST ▾ 3 ] detail
```

`Tab` moves between chips, `↑`/`↓` cycles candidates, `Enter` commits. **Copying with an
uncommitted chip copies the placeholder `<vpn-name>`, never a candidate.** This is a hard
rule and it is the one thing in the context feature that must not be got wrong: a command
copied out of Fathom with the wrong VPN name in it is a change made to the wrong tunnel, and
the tool would have caused it.

### 16.3 Which rung fired is visible

The interpolated span carries a one-word muted margin tab in the card's idiom: `selected`,
`only one`, `you typed it`, `last edited`, `pick one`. Lowercase, unpunctuated, at the right
edge. The user should never have to wonder where a value came from — the same principle as
provenance on graph fields (§5.1 of the brief), applied to a search result.

### 16.4 Runtime-only slots

Some slots cannot be bound from the graph because their value comes out of a *previous
command's output*: SA `index`, session id, SPI. `binds: null`.

These slots:

- render as `⟨id⟩` in the card's angle-bracket idiom, never as a fake value;
- trigger the `requires:` penalty in §8.3 when no entry in the current result set supplies
  them;
- render the supplier inline: *"needs: an SA index — get it from `show security ipsec
  security-associations`"* — which is a `related` edge in the corpus (§17.2) used for a
  second purpose.

### 16.5 Risk gates interpolation

**DECISION — a `Disruptive` entry is never rendered in an unscoped form when a scoping slot
exists and is unresolved.**

The card:

> *"Clearing P1 tears down every child SA under it — on a hub that is every spoke at once.
> Always scope by peer or index."*

So `junos-srx/ike.sa.clear-peer` declares `scope_required: [peer]`. Behaviour:

| Condition | Rendering |
|---|---|
| `peer` resolves (rungs 1–4) | `clear security ike security-associations 203.0.113.10`, with the `DISRUPTIVE` label and the blast-radius line. |
| `peer` ambiguous | Chooser chip. Copy yields `clear security ike security-associations <peer-ip>`. |
| No workspace | `clear security ike security-associations <peer-ip>`. |
| The unscoped form (`clear security ike security-associations` with no argument) | A **separate corpus entry** (`ike.sa.clear-all`), `risk: Disruptive`, `blast_radius` populated, and **not shown unless the query's syntax match reaches it directly**. It is never a concept-match result. |

The last row is the important one. There is a real command that clears every IKE SA on the
box and it must be findable — a tool that hides a command an engineer needs is a tool they
stop trusting. But it must not surface for "restart the tunnel". Splitting scoped and
unscoped into two entries, and letting only matcher 2 reach the unscoped one, is how both
hold.

### 16.6 No workspace — the zero-setup path

Brief §6.1: *"zero setup, zero data entry, zero trust required."* With no workspace:

| Aspect | Behaviour |
|---|---|
| Ranking | Identical, except `X = 0` for every entry and the version-gate penalty never fires (nothing is known to be out of range). |
| Slots | All placeholders, angle-bracketed. |
| Platform filter | None. All platforms shown, with the platform id as a muted right-aligned label on every row. |
| Rosetta | Fully available — it needs no workspace at all. |
| Ladders | Fully available, uninterpolated. |
| The prompt | One muted line under the input: `no workspace — placeholders`. Not an empty state, not an illustration, not a call to action. The design language forbids all three, and the brief's whole point is that this mode is legitimate and complete. |

`X = 0` uniformly means the *relative* order is unchanged from the workspace case except
where `X` differed between entries. In §12, `X` was 0.25 for four entries and 0.15 for one —
so with no workspace E4 rises by 0.10 relative to the rest and still lands fourth. Context is
a tiebreak, by construction.

---

## 17. Answer-shaped results and the ladder group

Brief §6.1:

> *"Return the command, plus what to read in the output, plus the next command if it's bad.
> The verify ladder is already a directed graph of 'if this, then that.'"*

### 17.1 Row anatomy

```
▌ show security ipsec security-associations vpn-name VPN-DC-EAST detail    junos-srx
▌ READ-ONLY — SAFE ON PRODUCTION
  Is Phase 2 installed and passing traffic?
  read   State — want Installed
  if bad show security ipsec inactive-tunnels — names what is down and prints
         a Tunnel Down Reason
```

The 4px left accent bar in `#1F6F4A` on `#EEF5F1`, the legend text verbatim from the card.
Three risk colours, no fourth, no other use of those colours anywhere in the row.

Expanded (`→` or `Enter`), the row adds:

| Block | Source |
|---|---|
| **Output fields** | `output_fields[]` — a two-column, no-vertical-rules table. Field name left, what it means right. This is side 3's `READING THE SA OUTPUT` block, encoded. |
| **If bad** | `next_if_bad[]`, one hop, each with its own risk chip. |
| **Related** | `related[]`. |
| **Rosetta** | The equivalence row for each platform in the corpus that has one (§18). |
| **Why** | `explain.explained` at the active depth, with a `terse · explained · teaching` margin tab. |
| **Guidebook / walkthrough** | §20. |

### 17.2 The graph in the corpus

Side 3's `ERROR DECODER` is an `on_fail` edge table and side 1's `BRING-UP ORDER` is a spine.
The corpus encodes both, at two levels of fidelity:

| Level | Where | Shape | Purpose |
|---|---|---|---|
| **Entry-local** | `next_if_bad: [...]` on a command entry | Unconditional, one hop, an ordered list of `CommandId \| RuleId \| ExplainKey` | The finder result row. Cheap, always available, no ladder needed. |
| **Ladder** | `ladder:<platform>/<name>` documents | Conditional: `on_pass`, and `on_fail` branches keyed by `Signal::Token` / `Signal::Field` / `Always`, terminating in `Goto::Step \| Explain \| Rule \| Stop` | The walkable diagnostic. Specified in `18-diff-verify-rollback.md` §4.2–4.3. |

**CI enforces containment:** if a command entry is a step in any ladder, its `next_if_bad`
must be a subset of that ladder's `on_fail` targets. Two sources of truth for "what to do
when this fails" would drift within one release, and the drift would be invisible because
they are rendered in different places.

`next_if_bad` exists at all — rather than making the finder read ladders — because most
commands are not in a ladder and still have an obvious next step, and because the finder must
render a next step without loading a ladder.

### 17.3 The ladder group

Emitted when §3.4 marks a `State` concept BROAD and a matching ladder exists.

| Property | Rule |
|---|---|
| Position | At the score of its highest-scoring member. It competes; it is not pinned to the top. |
| Membership | Ladder steps that (a) survived the cutoff independently, or (b) are `on_pass` successors of a member. (b) is what pulls `show route ⟨prefix⟩` into the group in §12 even though it never scored — a ladder with holes in it is not a ladder. |
| Order | Ladder position. Never score. |
| Entry point | `ladder.entry_for[action_concept]` — `act.verify` → the P1 step, `act.deploy` → the `commit confirmed 5` guard. A diagnostic query must not start with a config change. |
| Collapsed height | Fixed: 2 steps + a rule + a count. Fixed so keystrokes do not reflow the list (§10). |
| Members are not repeated below | An entry in the group does not also appear as a flat row. |
| Keyboard | `→` walks it step by step; `↓` skips past it to flat results. |
| Opt out | `flat results` preference. |

---

## 18. The Rosetta layer

Brief §6.1 seeds it as a flat map:

```yaml
rosetta: { panos: "show vpn ipsec-sa", ios: "show crypto ipsec sa" }
```

That form is right for the ~30% of cases where the mapping is 1:1 and wrong — silently,
confidently wrong — for the rest. Four failure shapes, all real:

| Shape | Example | Why a flat map lies |
|---|---|---|
| **One → many** | Junos `show security ike security-associations` covers IKEv1 and IKEv2. On IOS those are `show crypto isakmp sa` and `show crypto ikev2 sa`. | A single string picks one and hides the other. Someone with a v1 tunnel gets a v2 command and an empty result. |
| **Many → one** | `show crypto session detail` on IOS reports session state, uptime and counters together. On Junos that is spread across `ipsec security-associations`, `ipsec statistics` and `show security flow session`. | The map has to say "these three, together". |
| **No equivalent** | `show security ipsec inactive-tunnels` prints a *Tunnel Down Reason*. | There is no IOS command that reports a reason for an SA that does not exist. A flat map either omits the row (hiding the most useful Junos command) or invents a near-miss. |
| **Same words, different blast radius** | `clear crypto sa` vs `clear security ike security-associations`. | The scope differs. A map that pairs them by name pairs two different operations. |

### 18.1 DECISION — mappings hang off concepts, not off command pairs, and carry a typed equivalence

```yaml
# rosetta/p2-state.yaml
id: rosetta:p2.state
concept: concept:p2.installed
question: "Is the Phase 2 / IPsec SA installed and carrying traffic?"
reviewed_by: <named human>

platforms:

  junos-srx:
    primary: junos-srx/ipsec.sa.show
    equivalence: same
    verified_on: { platform: junos-srx, version: "<train>" }

  panos:
    primary: panos/ipsec.sa.show          # show vpn ipsec-sa
    equivalence: same
    differs: >
      PAN-OS reports Phase 1 and Phase 2 through two separate commands as Junos
      does: show vpn ike-sa and show vpn ipsec-sa.
    confidence: unverified

  ios-xe:
    primary: ios-xe/ipsec.sa.show          # show crypto ipsec sa
    equivalence: broader
    also: [ios-xe/crypto.session.show]     # show crypto session
    differs: >
      show crypto ipsec sa prints the SPIs, the selectors and the packet
      counters in one block, so it answers "installed?" and "passing traffic?"
      at once — on Junos those are two commands. show crypto session gives the
      one-line UP-ACTIVE / UP-IDLE / DOWN summary Junos has no direct analogue
      for.
    confidence: unverified

  fortios:
    primary: fortios/ipsec.tunnel.summary  # get vpn ipsec tunnel summary
    equivalence: broader
    also: [fortios/ipsec.tunnel.list]      # diagnose vpn tunnel list
    differs: >
      The summary line carries selectors(total,up) and rx/tx counters together,
      so it answers the counter question inline.
    confidence: unverified
```

<!-- VERIFY: every `differs` sentence above against a real box of that platform before the
`confidence: unverified` flag is cleared. The command names are checked against vendor
documentation; the *output field semantics* asserted in the `differs` text are not, and that
is exactly the class of claim this project must not ship unverified. -->

### 18.2 The equivalence enum

Five values. This is **not** the risk enum and must not be coloured with the risk palette
(conventions: those three colours mean one thing each and nothing else). Rendered as
letterspaced uppercase muted labels, in the card's table idiom.

| Value | Means | Rendering | `differs` required? |
|---|---|---|---|
| `same` | Same question, same scope, output fields map essentially 1:1 | plain | no |
| `narrower` | Answers part of the source question | `NARROWER` + the part it answers | **yes** |
| `broader` | Answers the source question and more; you must filter | `BROADER` + what else it shows | **yes** |
| `split` | Needs ≥2 commands together; `also:` is ordered and non-optional | rendered as a numbered pair | **yes** |
| `none` | No equivalent exists on this platform | `NO EQUIVALENT` + `nearest:` + the gap | **yes** |

**A `differs` sentence is a build gate on every value except `same`.** An unexplained
`narrower` is a mapping the author did not finish thinking about, and it will be read as
`same` by everyone who sees it.

### 18.3 Direction and asymmetry

Mappings are authored **one-directional from the concept**, and the inverse is derived only
where it is sound:

| Authored | Derived inverse | Sound? |
|---|---|---|
| `same` | `same` | yes |
| `narrower` | `broader` | yes |
| `broader` | `narrower` | yes |
| `split` | — | **no.** A split has an ordering and a rationale that do not invert. Author both directions or leave the reverse absent. |
| `none` | — | **no.** "IOS has nothing for this" says nothing about whether Junos has something for an IOS command. |

Authoring cost is `O(platforms)` per concept, not `O(platforms²)`. Adding a sixth platform
means writing one block per concept, not five pairs. That is the whole reason the mapping
hangs off the concept rather than off the command, and it is the same argument the brief
makes for rules carrying a `platforms` predicate instead of there being per-vendor engines
(§5.2): *"`N` vendors × `M` domains grows linearly, not quadratically."*

### 18.4 Honesty controls

| Control | Effect |
|---|---|
| `confidence: verified \| unverified` | Default `unverified`. Renders a muted `unverified` margin tab on the row. Not hidden — labelled. |
| `verified_on: { platform, version }` | Required to set `verified`. The author states which box they ran it on. |
| `sources` | Same shape as rule pack sources (`63-rulepack-spec.md` §12), including `{ card: ..., side: n, block: ... }` for anything drawn from the field card. |
| Never a URL as a citation | URLs rot and invariant 1 means we cannot fetch them to check. A human-locatable document title only. |

**Say the cost out loud: the Rosetta layer is where this corpus will be wrongest.** A command
entry needs one author who knows one platform. A mapping needs one author who knows two, well
enough to know where the output *semantics* differ and not just where the words do. That
person is rare. The `unverified` default and the mandatory `differs` sentence are the only
defences, and they are procedural, not technical. Expect the first external bug reports to be
here.

---

## 19. `Ctrl+K`, the keymap, and the shell

### 19.1 Opening

| Binding | Where |
|---|---|
| `Ctrl+K` / `Cmd+K` | Anywhere in the app, including inside text inputs and the config editor. |
| `/` | When focus is not in a text input. |
| Click the input | Always present in the header, never a modal-only affordance. |

The handler is a capture-phase listener on `window` with `preventDefault()`. In Firefox
`Ctrl+K` focuses the browser search bar, and `preventDefault` on a focused page suppresses it;
if the page does not have focus there is nothing we can or should do. `Cmd+K` on macOS is the
platform convention and is bound in parallel — not instead, because macOS users with external
keyboards use `Ctrl+K` too.

### 19.2 The keymap

Keyboard-only operation is complete. Nothing in the finder requires a pointer.

| Key | Action |
|---|---|
| `↑` `↓` | Move selection. Wraps at neither end (wrapping loses the user's place). |
| `→` | Expand row / walk into a ladder group |
| `←` | Collapse / leave a ladder group |
| `Enter` | Copy the rendered command to the clipboard and close |
| `Shift+Enter` | Copy with placeholders un-interpolated (`<vpn-name>`) |
| `Alt+Enter` | Copy the whole answer block: command, risk label, what to read, next-if-bad — the paste-into-a-change-ticket form |
| `Tab` / `Shift+Tab` | Move between unresolved slot chips |
| `Ctrl+↑` `Ctrl+↓` (on a chip) | Cycle slot candidates |
| `G` | Open the guidebook entry (§20) |
| `W` | Open the walkthrough (§20) |
| `R` | Rosetta: expand cross-vendor rows |
| `V` | Cycle explainer depth: terse · explained · teaching |
| `P` | Cycle platform filter |
| `Esc` | Close. Second `Esc` within 400 ms clears the query rather than closing — so a mistyped query is one key away from empty without losing the panel. |
| `?` | Show this table |

### 19.3 Focus and accessibility

ARIA combobox: `role="combobox"` on the input, `aria-expanded`, `aria-controls`,
`aria-activedescendant` pointing at the selected row's id, `role="listbox"`/`role="option"`.
Focus stays in the input at all times — arrow keys move `aria-activedescendant`, never DOM
focus. On close, focus returns to the element that had it before opening (stored on open, not
inferred).

The risk label is **text, not colour alone**: `READ-ONLY — SAFE ON PRODUCTION` is announced.
This is also why the card prints the words next to every colour bar, and it is one of the
reasons the design language is worth following literally.

### 19.4 List behaviour

25 rows maximum, virtualised, fixed row heights per row type (collapsed row, expanded row,
group). Fixed heights are a performance requirement (§10) before they are a design choice.

### 19.5 The miss state

No results above the cutoff. The design language forbids empty states, illustrations and
calls to action, so:

```
─────────────────────────────────────────────────────────────
  nothing above the cutoff for "reup the crypto thing"

  nearest concepts:   tunnel · rekey · clear
  nearest commands:   show security ipsec security-associations   0.71
                      clear security ipsec security-associations  0.63
─────────────────────────────────────────────────────────────
  logged locally · export misses
```

Below-cutoff entries are shown *with their scores*, because a user who can see that the
system nearly matched can adjust; a user shown nothing cannot. The `export misses` action
writes a file the user can read and choose to send (§3.6). It never transmits anything.

---

## 20. Links out — guidebook and walkthrough

Brief §6.1:

> *"Every result then carries a link into the guidebook ('why does this work') and into the
> walkthrough ('build this properly')."*

| Link | Corpus field | Target | Notes |
|---|---|---|---|
| **Guidebook** | `guidebook: [guide:ipsec.phase2.state]` | A long-form authored explainer, the `teaching` depth, in the reading surface rather than the finder. | Many entries share one guide. `show security ipsec security-associations`, `inactive-tunnels` and `statistics` all point at `guide:ipsec.phase2.state`. |
| **Walkthrough** | `walkthrough: [walk:junos-srx.s2s-ipsec]` | The guided builder (brief §6.2). | Optionally deep-linked to a step: `walk:junos-srx.s2s-ipsec#phase2-policy`. |
| **Rule** | `related_rules: [ipsec.pfs.absent]` | The rule pack entry. | Not a "link" so much as a join: a command that verifies a thing a rule checks should say so. `show security ipsec security-associations` ↔ `ipsec.pfs.absent` via `symptom_if_mismatched`. |

Every one of these is a **corpus id**, resolved against the loaded corpus. CI checks all three
targets exist. A dangling `walkthrough:` is a build failure, not a broken link at runtime —
this content ships offline and there is nothing to re-fetch.

**The links are one-directional in the data and bidirectional in the UI.** The guidebook page
for `guide:ipsec.phase2.state` lists the commands that point at it, derived at build time from
the reverse index. Authors maintain one direction.

---

## 21. Why not ship a small model

This deserves a real answer rather than an appeal to the brief, because the case *for* is
genuinely strong and it is exactly the vocabulary gap this document spends its first three
sections on.

### 21.1 The case for

A sentence embedding model would close the intent→command gap without an authored concept
layer. "Check if a tunnel is up" and "Is Phase 2 installed and passing traffic?" are near in
embedding space with no synonym authoring at all. That is not a small thing: §3.6 admits the
concept layer is a second authoring surface with a permanent long tail, and the model makes
that surface unnecessary for the flagship query shape. A MiniLM-class encoder (6 layers,
384-dimensional output) quantised to int8 is in the tens of megabytes and runs in WASM.

<!-- VERIFY: the exact parameter count and int8 size of the specific encoder before quoting
a number in any external material. The order of magnitude — tens of MB quantised, against
~1 MB for the index in §9.4 — is what the argument below rests on and is not in doubt; the
precise figure is not checked here. -->

### 21.2 The case against, in the order the arguments actually bite

| # | Argument | Weight |
|---|---|---|
| 1 | **Invariant 9.** Ranking must be identical every run and diffable between releases. Quantised inference on WASM SIMD, on the scalar fallback, and on a native CLI build can differ in the low bits, and near-ties reorder. You can quantise the output to force stability — which means shipping a model whose determinism is an artefact of truncation. That is a fragile property to promise an air-gapped customer, and it is not a property you can test cheaply. | Decisive |
| 2 | **The single-file build.** Brief §1: deployable as a single offline file. ~1.4 MB of base64 index (§9.4) versus tens of MB of base64 model weights. The single file is a product commitment, not a packaging preference. | Decisive |
| 3 | **The frame budget.** A forward pass per keystroke in WASM is not a sub-3 ms operation on the hardware this will run on. The fix is a debounce, and a debounce is precisely the "slower than opening a browser tab" failure the brief names. | Decisive |
| 4 | **Wrongness is unfixable by the people who own the corpus.** When BM25 + concepts rank wrong, the fix is one line of YAML in a reviewed PR, shipped in a corpus release, visible in a diff. When an embedding ranks wrong, a network engineer has no move. `63-rulepack-spec.md` states the reader this content is written for: *"a network engineer who can explain why `perfect-forward-secrecy` on one side and absent on the other fails Phase 2 while Phase 1 stays up, and who has never written a parser."* That person can author a concept. They cannot fine-tune an encoder. | Decisive |
| 5 | **It helps one shape of four and hurts two.** Half-remembered syntax needs exact prefix and bounded edit distance. Reverse needs exact longest-prefix parsing with argument capture. Semantic similarity is worse than useless for both — `ike` and `ipsec` are *close* in embedding space, which is the one confusion this domain cannot afford (§6.3). | Strong |
| 6 | **The vocabulary is closed and small.** ~1,200 entries, a domain vocabulary in the low thousands of terms, and a corpus that a small team authors deliberately. Embeddings earn their keep on open vocabularies at scale. This is neither. | Strong |
| 7 | **Corpus provenance.** Invariant 10: *"No model output ships in the corpus without a named human reviewer."* A runtime model is not corpus, so it sidesteps the invariant while producing the same class of unreviewed output — in the user-facing ranking rather than in the text. That is a loophole the project should not use. | Strong |
| 8 | **Trust posture.** Brief §6.1: the finder is the on-ramp *because* it needs "none of the crypto, none of the server, none of the graph". Adding a model adds a thing an enterprise reviewer will ask about, in the one feature whose entire strategic value is that there is nothing to ask about. | Contextual, and the reason it is listed last — it is a real argument but not a technical one |

### 21.3 What we give up, honestly

The model would answer the queries nobody authored. "site b isn't reaching the dc", "the vpn
went weird after the change last night", "why does it only break on big files" — the last of
which the corpus *can* answer via a `Symptom` concept (`concept:symptom.stalls-under-load`,
straight off side 4 of the card: *"Ping works. SSH connects. Then `ls` hangs… Handshake fine,
data stalls = MTU until proven otherwise"*), but only because someone thought to author it.
The first two, the deterministic finder will miss, and the miss log will record them, and
they will be fixed in the next corpus release rather than at query time.

That is a real loss and it is the reason §3.6's miss log and §9.6's golden set are not
optional extras. They are the deterministic system's learning loop, moved from runtime to
authoring time.

### 21.4 Where a model *does* belong

The owner's added direction requires a supervisor/subagent AI layer, and reconciling it with
"no model at runtime" is called out as a first-class architectural problem. The finder's
answer:

**A model may rewrite the query. It may never rank.**

```
free prose ──▶ [supervisor: prose → concept set + platform hint]  ← non-deterministic, labelled
                            │
                            ▼
              deterministic finder (§4–§8)                        ← invariant 9 holds here
                            │
                            ▼
                     ranked results
```

Properties this preserves:

- The ranking function is deterministic **given the concept set**. The concept set is shown to
  the user, editable, and removable with one keystroke.
- The non-deterministic step is quarantined behind the AI layer's boundary and labelled in the
  UI — which is exactly what invariant 9 requires, in its own words.
- It is off by default and absent entirely from the offline single-file build.
- It cannot produce a command that is not in the corpus, cannot produce an explanation that a
  human did not write, and cannot change the order of anything.

That is the whole of the AI layer's business inside the finder. The full design is not this
document's; it is `docs/20-ai/`.

---

## 22. Failure modes

| # | Failure | Symptom | Mitigation | Residual risk |
|---|---|---|---|---|
| 1 | **Concept over-attachment.** An author tags 400 entries with `state.operational` because it "seems relevant". | Everything scores ~0.8 on the flagship query; ranking flattens; the cutoff stops separating. | `icf` is exactly this defence: 400 entries → `icf = ln(4) = 1.39` versus 40 entries → 3.43. A concept's influence self-limits. CI warns above 15% of the corpus. | An author can still attach *many* concepts to *one* entry, which `icf` does not penalise. Lint caps entries at 6 concepts. |
| 2 | **Surface poisoning.** A well-meaning PR adds `down` as a surface of `state.operational` ("people say 'is it down'"). | "is the tunnel down" now returns the same list as "is it up", and the `opposite` mechanism is bypassed. | Golden query set diff. Two reviewers for a new concept, one for a new surface — and this is the argument for making it two for surfaces too if it happens twice. | Real. This is the most likely corpus regression in the system. |
| 3 | **The `installed` collision.** `installed` is `p2.installed` and also software installation (`request system software add`). | A query about software returns tunnel commands. | Object gate (§7.3): a software query carries `obj.software`, and no tunnel entry carries it or anything narrower → `gate = 0.35`. | Handled, but only because someone authored `obj.software`. The general case is "the object concept does not exist yet". |
| 4 | **Fuzzy hijack.** A short domain token fuzz-matches a different one. | `ike` returns `ipsec` results. | Minimum fuzzy length 4 and a 0.86 threshold, both computed against this exact pair in §6.3. | Low. Worth a regression test asserting `ike ↛ ipsec` explicitly, by name, forever. |
| 5 | **Version drift.** A command's syntax changed between Junos trains; the corpus has one form. | A user on an older train pastes a command their box rejects. | `versions:` predicate per entry (VERS, `63-rulepack-spec.md` §6). With a recorded workspace version, out-of-range entries take −0.30 and render a `not on your train` tab. With no version, all are shown. | The corpus will lag reality. `verified_on` records what was actually checked. |
| 6 | **Slot mis-binding.** Rung 2 (focus) picks a node the user was not thinking about. | An interpolated command names the wrong tunnel. Worst case: it is a `Disruptive` command. | The provenance tab (§16.3) shows which rung fired. `Disruptive` + unresolved scope never interpolates (§16.5). | Real and the highest-consequence failure in the document. Rung 5 refusing to guess is the load-bearing decision. |
| 7 | **The index and the corpus disagree.** A stale `finder.idx` shipped against newer entry text. | Results reference entries that render differently or not at all. | The index header carries the corpus content hash; a mismatch is a hard startup error, not a warning. | Low. |
| 8 | **Rosetta rot.** A vendor renames or deprecates a command. | The finder confidently offers a command that no longer exists. | `confidence: unverified` by default; `verified_on` records platform + version; the pack's `expires` (rule pack §3) marks stale content rather than disabling it. | Certain, over years. This is why the mappings are labelled rather than trusted. |
| 9 | **Render regression eats the frame.** | Typing feels laggy despite matching at 2 ms. | Fixed row heights, memoised rows, packed marshalling, a perf test in CI on a synthetic 25-row list. | The most likely cause of the product missing its own bar. §10. |
| 10 | **The golden set becomes a rubber stamp.** Reviewers accept every diff. | Ranking degrades one PR at a time, invisibly. | Diffs are review items with a required note, not auto-updated. `queries.yaml` carries a `note:` per query saying *why* the expectation is what it is — a reviewer who cannot square the diff with the note has to think. | Real, and only process defends against it. |

---

## 23. Complexity and budget summary

| Operation | Complexity | At 1,200 entries |
|---|---|---|
| Normalise + tokenise | `O(\|q\|)` | µs |
| Concept surface lookup | `O(4\|q\|)` FST lookups | ≤24 lookups |
| Breadth resolution | `O(\|narrower\|)` CSR | ≤8 |
| Candidate generation | `O(Σ_{c∈Q}\|C2E[c]\| + Σ_t df(t))`, capped 1,024 | ≤1,024 |
| BM25F scoring | `O(\|q\| · mean df)`, `df` capped at 400 | ≤2,400 postings |
| Concept scoring | `O(\|cand\| · \|Q\|)` CSR intersect | ≤8,192 pair tests |
| Trigram candidates | `O(8 log \|TRI\|)` binary searches | ≤8 × 17 |
| Jaro-Winkler rescore | `O(cand · \|s₁\| · \|s₂\|)`, capped 400 | ≤400 |
| FST prefix stream | `O(\|q\| + k)`, `k` ≤ 64 | |
| FST Levenshtein d=1 | output-sensitive, capped 32 | |
| Fusion + top-25 | `O(\|cand\| log 25)` | ≤5,000 comparisons |
| Slot resolution | `O(rows · slots · log \|graph index\|)` | ≤75 lookups |
| **Total matching** | | **≈ 2.5–4 ms** |
| Index build | `O(entries · tokens + terms log terms)` | seconds |
| Resident memory | `O(entries + terms)` | ≈ 1.0 MB (§9.4) |

Nothing here is superlinear in the corpus. The two structures that grow fastest are `TRI`
(`O(terms · trigrams)`) and `POST` (`O(entries · unique tokens)`), and both are addressed in
§9.4 before they matter.

---

## 24. Open decisions

| # | Decision | Options | Leaning |
|---|---|---|---|
| D1 | Does the ladder group appear at position 1 always, or compete on score? | (a) pinned (b) competes | **(b) competes**, as specified. Pinning makes it impossible for a directly-matching single command to win, which will feel wrong for `show security ipsec inactive-tunnels` typed almost in full. Revisit if users report the opposite. |
| D2 | Whole-command Levenshtein at distance 2 | on / off / adaptive on query length | **Off** at v1. Measure precision on the golden set before enabling. |
| D3 | Should the finder filter to the workspace's platforms by default? | filter / demote / neither | **Demote** (the `X` platform term), not filter. Filtering hides the cross-vendor answer, which is a feature people came for. |
| D4 | Per-user recency of *use* as a ranking input | yes / no | **No.** It is a silent invariant-9 violation and it makes a ranked list unshareable. Revisit only with an explicit, visible, workspace-stored, exportable form. |
| D5 | Should `related` edges pull entries into the candidate set, or only render on an expanded row? | pull / render-only | **Render-only** at v1. Pulling makes candidate generation transitive and the cap starts biting. |
| D6 | Multi-locale surfaces | now / later | **Later.** The rule packs already have an i18n story (`63-rulepack-spec.md` §14) and concepts should reuse it, but a non-English concept layer is a second vocabulary problem and it should not be attempted while the English one is unproven. |
| D7 | `Alt+Enter` change-ticket format | plain text / markdown / both | Needs a look at what change systems actually accept. `18-diff-verify-rollback.md` §6 owns the ticket format; this should match it, not invent a second. |

---

## 25. Sources consulted

| Source | Used for |
|---|---|
| `.context/field-card-srx-ipsec.txt`, sides 1–4 | Every Junos command, output field, failure mode, blast-radius warning and ladder ordering in this document. Cited by side and block in the corpus entries. |
| Apache Lucene `BM25Similarity` documentation | `k₁ = 1.2`, `b = 0.75` defaults, and the `ln(1 + (N−df+0.5)/(df+0.5))` IDF form. |
| `BurntSushi/fst` (crate + `transducers` write-up) | FST as term dictionary and command index; ordered prefix streaming; the optional Levenshtein automaton for bounded-edit-distance queries over the key set; memory-mappable / zero-copy construction. |
| Winkler's prefix modification of the Jaro similarity | `p = 0.1`, prefix cap 4, 0.7 boost threshold. The three worked pairs in §6.3 are computed by hand from the definition, not quoted. |
| Palo Alto Networks documentation | `show vpn ike-sa` (Phase 1) and `show vpn ipsec-sa` (Phase 2) as the two PAN-OS status commands; `test vpn ike-sa gateway` / `clear vpn ike-sa gateway`. |
| Cisco documentation and support material | `show crypto session` (UP-ACTIVE / UP-IDLE / DOWN), `show crypto ipsec sa`, `show crypto ikev2 sa`, `show crypto isakmp sa`. |
| Fortinet documentation | `get vpn ipsec tunnel summary` (`selectors(total,up)`, rx/tx counters), `diagnose vpn ike gateway list`, `diagnose vpn tunnel list`. |
| `docs/10-core/18-diff-verify-rollback.md` §4 | The `Ladder` / `Step` / `Signal` / `Goto` types this document renders and does not redefine. |
| `docs/10-core/13-emitters-and-provenance.md` §12 | The explainer resolution ladder reused by the reverse shape for `set` lines. |
| `docs/60-content/63-rulepack-spec.md` §5, §6, §12 | Platform registry, VERS version predicates, source citation shapes — all reused verbatim by the corpus spec. |

Vendor command *names* above are checked against vendor documentation. Vendor output-field
*semantics* asserted in Rosetta `differs` text are marked `confidence: unverified` in the
corpus until someone runs them.

---

## 26. Disagreements

**1. `rosetta` as an entry field.** The brief's example puts the cross-vendor map on the
command entry:

```yaml
rosetta: { panos: "show vpn ipsec-sa", ios: "show crypto ipsec sa" }
```

I have moved it to a separate document keyed by concept (§18.1) and kept `rosetta:` on the
entry only as a **derived, read-only convenience** materialised at index build. Objection: the
inline form is `O(platforms²)` to author, cannot express `split` or `none`, and has nowhere to
put the `differs` sentence that keeps a non-1:1 mapping honest. Proposed replacement is §18 in
full. This is a change to the shape of §6.1's example, not to its intent — the brief's own
prior-art section makes the identical argument about rules (*"`N` vendors × `M` domains grows
linearly, not quadratically"*), and this applies it to mappings.

**2. "A synonym map".** §6.1 says *"fuzzy matching plus a synonym map"*. I have built a
concept graph with kinds, hierarchy, opposites and anti-synonyms instead, because a flat
synonym map cannot express the one distinction the field card cares most about — that
`established`, `Installed` and `passing traffic` are three different states of the same
tunnel and collapsing them destroys the teaching (§2). This is an elaboration of the brief's
intent rather than a contradiction of it, but it is a materially larger authoring
commitment than "a synonym map" implies and it should be costed as such before work starts.

**3. "A few days of work."** §6.1 estimates the finder at *"a few days of work on top of a
corpus that already exists."* The shell, the index and the three matchers are a few days. The
concept layer, the ladders and the Rosetta documents are not — they are the corpus, and
§9.4's 1,200 entries with ~340 concepts is months of authoring by people who know these
platforms. **I do not propose changing the plan.** Build the finder first, exactly as the
brief says, seeded with the four sides of the SRX card, which is enough content to be useful
on day one. But the estimate should be read as "a few days to the machine" and not "a few
days to the wedge", because the wedge is the content.

No convention in `.context/conventions.md` is disputed.
