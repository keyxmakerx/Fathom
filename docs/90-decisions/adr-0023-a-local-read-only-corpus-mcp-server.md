# ADR-0023 — A local, read-only corpus MCP server ships with the CLI

> **Status:** Proposed
> **Date:** 2026-07-28
> **Register entry:** new — raised by `84` P3 and §14 item 4
> **Reversal cost:** R1 — a separate binary surface over an existing index
> **Supersedes:** —

## Context

`84` P3 states the finding as a gap in the corpus's imagination: **the AI section considers every
way to put a model inside Fathom and no way to put Fathom inside a model.** `21` specifies four
tiers, a supervisor, subagents, a broker, redaction profiles and an egress log — 14–22 solo weeks —
all importing non-determinism into a product whose case rests on not having any. Nowhere is the
inverse evaluated.

The market evidence points the same way. Two of the three healthiest products in this exact genre
concluded that **the corpus is the asset and the search box is not the destination**: Fig's
completion corpus now lives inside an assistant, and Dash — the one durable paid product in the
category — responded to models by shipping MCP integration so assistants can query its docsets.
NetBox shipped an MCP server framed as structured context for agents. `72` §11.4 already concedes
the first interaction against a general assistant *"is lost and cannot be won"*, and `72` §11.2's
own strategy is *"make the durable properties legible"*.

An entry carrying `acceptable_when`, a `risk` label, `verified_against` and a named human reviewer,
delivered inside the tool the engineer already has open, is that strategy executed at the first
interaction instead of the third.

Checked against the invariants, and this is why it is worth proposing rather than dismissing:

| Invariant | Status |
|---|---|
| 1 — no egress by default | Satisfied. Loopback origin the user configured, exactly as `21` §7.3's sidecar is |
| 2 — never touches a device | Satisfied. It serves corpus text |
| 3 — never accepts a credential | Satisfied |
| 4 — server never holds a key | Satisfied. There is no server and no workspace |
| 9 — determinism | Satisfied. Retrieval is the finder's own deterministic ranking; the prose is the user's assistant, outside our artifact path |

`03` §4.8 refuses a chatbot **as the primary interface**. This is not one.

## Decision

**Ship `fathom mcp` — a local, read-only MCP server over the corpus — as a subcommand of the CLI
that already ships in phase 0 (ADR-0006).**

Scope, stated tightly, because the scope is the entire safety argument:

| Property | Value |
|---|---|
| Exposes | The command corpus, the explainer corpus, the rule prose, the risk legend. Read-only |
| Does **not** expose | The workspace, the graph, any parsed capture, any emitted config, any suppression, any finding against a real node |
| Transport | stdio and loopback only. No listener on a routable interface, ever |
| Determinism | Retrieval uses the same index and the same ranking as `Ctrl+K` (`16`) |
| Response shape | Whole authored entries, verbatim, with `verified_against`, `reviewed_by`, `risk` and `acceptable_when` **always attached and never truncated** |
| Provenance | Every response carries the corpus version and content hash, so a quoted answer is checkable later |

**It is not part of the AI layer.** It links no `fathom-ai` code, holds no capability grant, runs no
gate, and appears nowhere in `21`'s tier table. `fathom verify` must continue to pass with it
installed, and `xtask check-deps` asserts the MCP crate does not depend on `fathom-graph`.

## Consequences

### Positive

- It puts the one thing no competitor can copy — *a named human ran this command on a real box on a
  stated date* — inside the surface where the engineer's first question is actually asked.
- Cost is days, against 14–22 weeks for the tiers it partially substitutes for. `84` §9.1 argues that
  6a plus this satisfies *"there needs to be a supervisor AI and sub agents"* more honestly than
  tiers 1–3 do: the supervisor is the assistant the engineer already runs, the subagent is Fathom,
  the boundary is a process boundary rather than a prompt, and invariant 9 is untouched because
  retrieval is deterministic and the prose was never ours.
- It is the only channel in the plan where the corpus can be *cited* rather than *browsed*, which is
  the shape the surviving comparables converged on independently.
- It degrades gracefully: if MCP as a protocol dies, the loss is a subcommand.

### Negative

- **It hands the corpus to the competitor.** A model that can query every authored entry can also
  summarise, paraphrase and reproduce them at scale, without attribution, into a context window the
  user never sees the provenance of. `74`'s CC BY-SA licence (ADR-0004) is unenforceable against
  that. The project's single durable asset becomes free training-adjacent input, and this decision
  hands over the API to do it.
- **It concedes the destination.** `84` §3.2's pattern is that the wedge converts to a bookmark or an
  acquisition and never to a platform on the wedge-owner's terms; shipping the MCP server is the
  project agreeing to be the corpus inside somebody else's surface. Every hour a user spends asking
  their assistant is an hour they do not spend in the tool, and phases 1–3 exist to be that tool.
- **The provenance discipline survives the boundary in form and not in effect.** We can attach
  `verified 2026-05-12 · K. Okafor` to every response; we cannot stop the model from dropping it,
  and in practice it will. The differentiator that survives a model — `84` §5.4 — is delivered
  through a channel that erases it.
- **A `risk` label stripped in paraphrase is a safety failure.** The three-colour legend is the only
  safety affordance the product has (ADR-0011); an assistant that renders a `Disruptive` command
  without its band has produced exactly the artifact the field card warns about.
- **It creates a support surface for other people's clients.** MCP client behaviour varies, and every
  bug report will arrive as "Fathom's answer was wrong" when the answer was the model's.
- **It is a new listening surface in a product whose posture is that it opens no connections.** Even
  loopback-only, `24` §3.5's DNS-rebinding analysis applies, and the mitigations live in software the
  project does not ship.

## Alternatives considered

| Option | Strongest argument for it | Why rejected |
|---|---|---|
| **Do not build it (status quo)** | Protects the corpus, keeps the destination thesis intact, and costs nothing | It declines the one channel where being the citation is a win, in a project that has already conceded the first interaction is lost. `84` P3's point stands: the corpus refuses this without ever evaluating it |
| **Publish the corpus as plain files and let anyone index it** | ADR-0004's licence already permits it, it costs nothing, and it avoids the listening surface | It loses the ranking, the provenance attachment and the version pinning. It is also the same disclosure with none of the control — the negative consequences above land either way once the repository is public |
| **Expose the workspace through MCP too** | It is what users will ask for within a week, and it is where the real value is | It hands a model the estate. Every invariant that survives the read-only version fails here, and `03` §4.8's refusal becomes live |
| **Build it, but only after phase 3** | Sequencing it behind the destination product tests the destination thesis first | The CLI ships in phase 0 and the corpus is the deliverable in phase 0. Delaying costs nothing to build and forgoes the only early evidence about which surface users prefer |
| **Ship it as the primary interface** | It is where the users are | `03` §4.8's refusal is correct: a chatbot as the primary interface abandons the deterministic surfaces that are the product |

## Revisit if

- Usage evidence — which under invariant 1 can only be anecdotal — suggests pilot engineers use the
  MCP path instead of the finder rather than alongside it. That is `84` F7 firing, and it falsifies
  the destination thesis and with it ADR-0006's sequencing.
- An assistant is observed reproducing corpus entries without their `risk` band or `acceptable_when`
  in a way that leads to a real incident. The response is to withdraw the server, not to add
  guardrails to somebody else's client.
- MCP is superseded by a different protocol, in which case the decision is about the *shape* — a
  local, read-only, deterministic corpus endpoint — and the transport is an implementation detail.
- **This ADR stays `Proposed` until the owner rules on it**, because it changes what the AI layer is
  *for* — from consuming a model to being consumed by one — and that is their call, not an
  engineering one.
