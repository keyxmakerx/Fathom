# ADR-0072: AI access keys — an AI reads a design as you, and recommends

**Status:** proposed 2026-10-25. Owner answered sign-off cards ai-reach ("connector signed in as
you"), ai-key ("read and propose", all three data ticks), ai-accept ("anyone with Draw, a Steward can
require a second person") and ai-when ("after beta, ADR now") on 25 October, then added requirements
the same day (below). Built as a draft PR that is not merged until the owner says so. Cards
r33-ai-pair, r33-ai-org, r33-ai-admin and r33-ai-recs carry the choices still open; this record
follows their recommended picks until answered.

**Reopens** ADR-0023 on merit (CLAUDE.md rule 6). That record exposed only the corpus and named
"the workspace, the graph, any parsed capture" as never exposed. The owner now asks for the
opposite on purpose: an AI that reads a real design. **Keeps** ADR-0020's rule that a model makes
proposals, never facts, and ADR-0046's "suggestions are never facts".

## What the owner asked for (25 October)

> it should never be a full site/db wide btw, and have no access to passwords. Only read from
> design, dynamic and powerful selection of privileges for both admins and org managers, because
> admins should be able to say "no ai allowed" or "disable this key" if it finds something maybe
> compromised. [...] ai should basically be able to, with full privs, read and then recommend builds
> in a nice and easy to understand and see way. Perhaps only certain people should even have access
> to do this?

And on the cards: the key's permissions can be changed after it is made; the screens must be easy
to understand; a security sweep follows the build.

## Sources checked (rule 1)

- **MCP authorization**, specification revision 2026-07-28,
  https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization, read 2026-10-25.
  It says: "Implementations using an STDIO transport SHOULD NOT follow this specification, and
  instead retrieve credentials from the environment." An HTTP transport instead makes the server an
  OAuth 2.1 resource server with protected-resource metadata, audience-bound tokens and an
  authorization server. That is the reason for decision 3.

## Decided

1. **An AI key belongs to one person in one organisation.** Never the server, never the database,
   never two organisations. It acts as that person and can never do more than that person can do
   at the moment of each request: every request re-checks the person's own grant on the design's
   folder (`grants::authorise_account`, the same seven steps a browser request takes). A person who
   loses Read loses it for their keys in the same instant.
2. **Read and recommend, nothing else.** A key can list the designs it may see, read one, and send
   recommendations. It cannot save a version, change a name, upload a file, send a correction, see
   history, invite, grant, sign, reach the Admin console, or touch the vault, credentials, sessions
   or private notes' keys. These are not refused route by route: AI requests have their own router
   under `/ai/v1/` and their own extractor, and the type that proves a browser session
   (`VerifiedSession`) cannot be made from an AI request, so no browser route can be reached with
   one. A test lists every route the server has and proves an AI-signed request reaches none of
   them outside `/ai/v1/`.
3. **The key is an ES256 key pair, and the private half stays on the person's computer.** A small
   helper (`fathom-ai`, an MCP server over stdio, one file with no dependencies, served by Fathom
   itself) makes the pair, prints a pairing code, and signs every request. The person pastes the
   code into Fathom and picks permissions there. Fathom stores only the public half. (Card
   r33-ai-pair; the other option is Fathom making the key and the browser downloading it.)
4. **The "extra header" is a signature, not a second secret.** Every request carries
   `Fathom-AI-Key` (the key's id), `Fathom-AI-Time`, `Fathom-AI-Nonce` and `Fathom-AI-Signature`,
   an ES256 signature over a labelled message: method, path and query, SHA-256 of the body, nonce,
   time, and the deployment id. A copied request cannot be replayed (single-use nonce, two-minute
   window), cannot be sent to another Fathom (deployment id), and cannot be changed in flight. A
   static shared header would add nothing a stolen key file does not already carry, so there is
   none.
5. **Permissions are set when the key is made and can be changed after.** Per key: which folders
   (or every folder the person can read), what data (layout always; addresses, VLANs and configs;
   notes), whether it may recommend, and when it expires (30, 90 or 365 days; 90 by default; no key
   is forever). The owner can narrow or widen their own key; widening needs a fresh sign-in
   signature like any other change. A Steward can narrow or disable anyone's key in their
   organisation but cannot widen it. Every change is a sealed entry on the organisation chain.
6. **What leaves is an allowlist.** A design reaches the AI as a purpose-built reading (devices,
   models, ports, cables, racks, places, tags; then addresses and VLANs; then notes), built field by
   field from the stored graph. A field nobody listed does not leave. History, provenance, file
   contents and anything the redaction gate marked never leave at any tick. Configs are already
   credential-free (rule 4); the reading carries what the engine bound from them, never the text.
7. **Private notes need the vault.** ADR-0053 puts the private layer under account keys that arrive
   with the vault. Until then the "notes" tick means shared notes only. When the private layer
   exists, a key can read only its own owner's private notes, and only with the tick.
8. **Only chosen people can make keys, and AI is off until a Steward turns it on.** Organisation ›
   AI holds: AI allowed (off by default), who may make keys (named people; nobody by default), the
   most a key may see (a ceiling on decision 5's ticks), the longest a key may last, and every key in
   the organisation with Disable. (Card r33-ai-org.)
9. **An admin can stop AI and stop any key, and can grant nothing.** Admin › AI (the operator
   plane, ADR-0055) has one server-wide switch, "No AI on this server", and a list of every key on
   the server: label, person, organisation, made, last used, from which address. Disable takes a
   reason ("may be compromised"), is immediate, and tells the key's owner and the organisation's
   Stewards. An admin cannot turn AI on for an organisation, make a key, change a key's permissions
   or see any design: those belong to the organisation. Disabling is a refusal, and an operator can
   already refuse everything by stopping the server, so this gives an operator no new reach into
   data. (Card r33-ai-admin.)
10. **A recommendation is never a change.** The AI sends a recommendation: a title, a plain reason,
    and a list of typed steps from a small vocabulary (add a device of a catalogue model in a place,
    connect two ports, rename, set a tag, add a note). Its text passes the credential check and the
    same cleaning as a cable correction, and is sealed like one. On the canvas it shows dashed (the
    style `51` §9 reserves for AI-proposed content), with the list beside it (card r33-ai-recs). A
    person with Draw accepts it, step by step or whole; accepting is an ordinary edit that person
    makes in the browser, one undo step, recorded as theirs with "recommended by AI (key label) via
    Key Maker" beside it. A Steward can require that the accepter is not the key's owner, per folder.
11. **Every use is recorded.** Last used, from which address, and a count per day on the key's row;
    key made, changed, disabled, revoked and expired as sealed organisation-chain entries; a
    recommendation's creation and its accept or dismiss with who did it.
12. **Limits.** Per key: 60 requests a minute, 20 open recommendations per design, 200 open per
    organisation. A disabled or expired key answers exactly as an unknown key does.

## What this rules out

A bearer token in an `Authorization` header that the AI vendor's servers hold; a key that spans
organisations; an AI that saves; an admin who can grant AI access; a reading built by deleting
fields from the whole graph (a denylist) instead of naming the fields that may leave.

## Negative consequences

- **Data leaves to the AI vendor.** Whatever the key may read, the person's AI app sends to its
  model's vendor. Fathom cannot see or stop that once it has answered. The key screen says so in
  plain words, and none of CLAUDE.md's four forbidden sentences appear anywhere.
- **Prompt injection is real and is not solved here.** Text inside a design (a description in a
  pasted config, a note) can steer the AI's recommendations. The review step is the defence, which
  is why decision 10 never lets anything apply itself. ADR-0022 found the same leak in `ask_human`.
- **Desktop only, at first.** A stdio helper serves AI apps that run on the person's computer
  (desktop apps, coding tools). A browser- or phone-only AI app cannot use it. Serving those means
  Fathom becoming an OAuth 2.1 authorization server (MCP revision 2026-07-28), a separate record.
- **A stolen key file is a working key until it is disabled or expires.** The file is the key; the
  helper keeps it readable only by the person's own account. Expiry, the owner's list, the Steward's
  list and the admin's Disable are the answer, and the expiry has no "never".
- **More surface on a security-first product, before beta.** The owner's own card says after beta;
  this is built now as an unmerged draft so the decision can be judged on working code, and a
  security sweep follows before any merge.
