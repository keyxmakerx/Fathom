# ADR-0072: AI access keys — an AI reads a design as you, and recommends

**Status:** proposed 2026-10-25. Owner answered sign-off cards ai-reach ("connector signed in as
you"), ai-key ("read and propose", all three data ticks), ai-accept ("anyone with Draw, a Steward can
require a second person") and ai-when ("after beta, ADR now") on 25 October, then added requirements
the same day (below). Built as a draft PR that is not merged until the owner says so. Cards
r33-ai-pair, r33-ai-org, r33-ai-admin and r33-ai-recs carry the choices still open; this record
follows their recommended picks until answered. **Revised the same evening** (decisions 13 to 20): the
owner pasted Claude's "Add custom connector" form and approved r33-ai-reach A, Fathom as a
connector you sign in to.

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
   itself) makes the pair, prints its public half and key id, and signs every request. The person
   pastes the public half into Fathom and picks permissions there. Fathom stores only the public
   half. (Card r33-ai-pair.) Since decision 13 this is the way in for an AI app on the person's own
   computer that does not speak the connector sign-in, and for a Fathom no AI vendor can reach.
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
   is forever). The owner can narrow or widen their own key, within the organisation's ceiling and
   only while still named as a maker; the request is the same signed browser request as any other
   change. A Steward can narrow or disable anyone's key in their
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

## Revised 25 October: Fathom is a connector you sign in to

The owner pasted Claude's "Add custom connector" form, which takes a name and an HTTPS MCP address,
and asked whether the helper was the right way. It is not the way Claude's connectors are built.
Card r33-ai-reach A was approved: "that's fine i think, but we also need non-claude ones too. Is
there anyway we can validate it is coming from claude? What about self hosted versions like our
company corp one?"

Sources, all read 2026-10-25:

- Claude, *Authentication for connectors*, https://claude.com/docs/connectors/building/authentication:
  OAuth 2.0 with DCR or a Client ID Metadata Document (CIMD); a `401` with
  `WWW-Authenticate: Bearer resource_metadata=...` starts sign-in; S256 PKCE always; redirect URI
  `https://claude.ai/api/mcp/auth_callback` for the hosted apps and a loopback redirect on any port
  for Claude Code; refresh tokens rotated for public clients; static request headers are a beta for
  a limited set of organisations and are one credential for every member of a Claude organisation;
  Anthropic's outbound traffic comes from `160.79.104.0/21`.
- Claude's client metadata documents, fetched: `https://claude.ai/oauth/mcp-oauth-client-metadata`
  (client name "Claude", redirect `https://claude.ai/api/mcp/auth_callback`, public client) and
  `https://claude.ai/oauth/claude-code-client-metadata` ("Claude Code", redirects
  `http://localhost/callback` and `http://127.0.0.1/callback`).
- Anthropic, *IP addresses*, https://platform.claude.com/docs/en/api/ip-addresses: the outbound
  range is "stable", used "when making MCP tool calls to external servers", and "will not change
  without notice".
- MCP specification 2025-11-25, *Authorization*,
  https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization: protected-resource
  metadata (RFC 9728) is required; tokens must be audience-bound to the server (RFC 8707) and sent
  only in the `Authorization` header; exact redirect-URI matching; the server must display the
  redirect host and should warn when the only redirects are loopback, because "any local process
  can bind a port and claim to be the client".
- MCP specification 2026-07-28, *Authorization*,
  https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization: the same rules, plus
  the authorization server "SHOULD include the `iss` parameter in authorization responses"
  (RFC 9207) and advertise `authorization_response_iss_parameter_supported`; Dynamic Client
  Registration "is deprecated and retained for backwards compatibility".
- MCP specification 2025-11-25, *Transports*,
  https://modelcontextprotocol.io/specification/2025-11-25/basic/transports: one endpoint; an
  invalid `Origin` gets `403`; a notification gets `202`; `GET` may answer `405`.
- Claude, *Authenticate to MCP servers behind a tunnel*,
  https://claude.com/docs/connectors/mcp-tunnels/oauth: MCP tunnels are a research preview on the
  Enterprise plan; the person's browser opens the authorization endpoint, Anthropic's servers call
  the token endpoint; "split metadata" points each at the address its caller can reach.

13. **Fathom serves `/mcp` and is its own OAuth authorization server, when the operator turns it
    on.** `FATHOM_AI_PUBLIC_URL` names the address Claude's servers reach (`<url>/mcp`, the discovery
    documents and the token endpoint); `FATHOM_AI_SIGN_IN_URL`, if set, names the address a person's
    browser opens to sign in, which may be on a company network only (the split metadata above).
    Without `FATHOM_AI_PUBLIC_URL` none of it exists and every one of those paths is a `404`.
14. **A connection is the same grant as a key.** Signing in shows decision 5's form, titled with the
    app's name and the host the sign-in returns to; Allow makes an `ai_keys` row of kind
    `connector`, bound to the app's client id, with every rule above unchanged: one organisation,
    the policy at every request, a Steward's narrow and disable, the operator's switch. The tools
    over `/mcp` are the helper's five.
15. **Tokens are opaque and only their hashes are stored.** An access token lasts one hour; a
    refresh token is single-use and replaced on each use, up to the grant's end. A refresh token
    used twice ends every token of that sign-in (OAuth 2.1's reuse detection). An authorization
    code lasts one minute, is single-use, and needs the S256 verifier, the same redirect URI and the
    same `resource`, which must be this server's `/mcp`.
16. **Which apps may connect is the organisation's choice.** Fathom knows Claude and Claude Code by
    their published client ids and exact redirects, pinned in the server, so Fathom fetches nothing
    from a client id it is shown. Any other app registers itself (RFC 7591, an `https` or loopback
    redirect only; deprecated in MCP 2026-07-28 but still what most apps without a pinned identity
    can do, and it needs no fetch) and is shown by its redirect's host. The policy says which of Claude, Claude Code
    and other apps may connect; Claude is allowed when AI is turned on, the others are off until a
    Steward allows them.
17. **Is it really Claude?** The sign-in result goes only to `https://claude.ai/api/mcp/auth_callback`
    and needs the verifier of whoever started it, so only Claude's servers can turn it into a token.
    A Claude connection can further be held to Anthropic's published range
    (`FATHOM_AI_CLAUDE_RANGES`, default `160.79.104.0/21`, `off` to switch off): `/mcp` and token
    requests on a Claude grant from elsewhere are refused. Claude Code cannot be told apart from
    another program on the same computer; its sign-in page says so, and a Steward can leave it off.
18. **A company Fathom.** Claude Code and the helper run on the person's computer and reach Fathom
    where it is. For claude.ai, only `/mcp`, `/.well-known/oauth-*` and `/oauth/token` and
    `/oauth/register` need to face Anthropic's range or an MCP tunnel; the sign-in page stays
    internal.
19. **`/mcp` refuses a browser.** An `Origin` header that is not this server's own sign-in address
    is a `403` before anything is read, and no browser session header is ever read there.
20. **What changes in decision 3 and the consequences.** The helper stays for local apps and for a
    Fathom no vendor can reach; "desktop only, at first" no longer holds; and "a bearer token that the
    AI vendor's servers hold" moves from ruled out to decided, for the reasons above: it is what
    Claude's connectors are, it is short-lived, audience-bound, revocable by three people, and
    checked against the policy on every request.

## Added 27 October: plans, issues, and which account

The owner asked whether an AI can "setup maintenances, plans, troubleshoot", and said a connection
should be per person but people should be warned off personal accounts: "I wish there was a way to
verify that".

21. **Plans and issues are read like the rest of a design.** At `layout`: a maintenance plan's title,
    window, stage and outcome, and each step's order, kind, what it touches, its sentence and where it
    stands; an "It's down" issue's title, device, when it opened, stage and the plan made from it, and
    each check's question, what it lights and the answer. At `notes`: what a step says before and
    after, what was typed while doing or answering, a plan's record and where an issue pointed.
    **Never:** who wrote a plan or ran an issue (a person's name), and a step's stored `edit` (the
    machine line Done applies, which can carry a typed value). Decision 2 stands: the AI still only
    reads and sends ideas.
22. **A person can make an idea a plan.** "Make it a plan" on an AI idea makes a draft maintenance
    plan, one step per idea step (`connect` becomes a cable step, `move` a move step, anything else
    "other"), in one undo step, and accepts the idea. No step carries an edit: nothing changes until a
    person adds the edits and marks steps done. The AI's words are not typed by the person, so they
    go through the redaction gate, as pasted text does (ADR-0053 section 6). A target no longer in
    the design is left off.
23. **Fathom cannot tell which Claude account connects, and says so.** The connection page and
    Organisation › AI tell the person to use the account their organisation gave them, not a personal
    one, and that Fathom cannot check. The way that would prove it (Enterprise Managed Auth, below)
    is a choice on the sign-off page (r42-ai-account), not built.

24. **The person says which AI account it is, and the people who look after the organisation see
    it.** The owner approved card r42-ai-account (A, the check after beta) and asked: "maybe we do
    opt in for who can add. Can the users email be displayed to the org managers and admins?" Who
    may connect is already opt-in (decision 1: only people a Steward names). Allow and Make key now
    ask "Which AI account is it signed in to?", as an email address, and will not go ahead without
    one. It is stored on the key (`ai_keys.ai_account`, migration 0049), inside the row seal when
    present, and never put in the tamper-evident chain, so a person's address is not kept forever.
    Stewards see it and the owner's Fathom sign-in address beside each connection, and so does Admin
    › AI, which reads the address under the account custody beside the operator one, as the
    operator register does. Every screen says Fathom cannot check it. Keys made before this have
    none and say so.

Sources checked (rule 1), all read 2026-10-27:

- **Authentication for connectors**, https://claude.com/docs/connectors/building/authentication.
  Claude identifies itself to the authorization server as a client (a Client ID Metadata Document,
  Dynamic Client Registration, or a client Anthropic holds); the user signs in to the service with
  their own account. Nothing on the page sends the Claude user's identity or organisation to the
  server. Of the shared request-header credential it says: "Treat it as the organization's
  credential, not a person's ... don't use it to identify which user is calling." Traffic comes from
  `160.79.104.0/21`, which proves the request came through Anthropic, not whose account it was.
- **Get started with custom connectors using remote MCP**, https://support.claude.com/en/articles/11175166.
  On Team and Enterprise plans an Owner adds a custom connector for the organisation and each member
  connects it; the page does not say any user or organisation identity reaches the server.
- **Enterprise Managed Auth for connectors**, https://claude.com/docs/connectors/building/enterprise-managed-auth.md.
  On Team and Enterprise plans, Claude can present "a signed JSON Web Token (JWT), issued by the
  customer's identity provider, that vouches for the user's identity", exchanged at the token
  endpoint with the JWT bearer grant (RFC 7523). The authorization server must keep "an explicit
  allowlist of trusted issuer URLs per tenant" and reject any other issuer. DCR is not supported
  with it. This is the only way found by which Fathom could know the person came through their
  organisation's own sign-in.

## What this rules out

A pasted key shared by a whole Claude organisation (static request headers); fetching a client
metadata document Fathom has not pinned; a key that spans
organisations; an AI that saves; an admin who can grant AI access; a reading built by deleting
fields from the whole graph (a denylist) instead of naming the fields that may leave.

## Negative consequences

- **Data leaves to the AI vendor.** Whatever the key may read, the person's AI app sends to its
  model's vendor. Fathom cannot see or stop that once it has answered. The key screen says so in
  plain words, and none of CLAUDE.md's four forbidden sentences appear anywhere.
- **Prompt injection is real and is not solved here.** Text inside a design (a description in a
  pasted config, a note) can steer the AI's recommendations. The review step is the defence, which
  is why decision 10 never lets anything apply itself. ADR-0022 found the same leak in `ask_human`.
- **Fathom is now an OAuth authorization server.** That is new code on a security-first product:
  discovery, registration, consent, code and token handling. Decisions 13 to 19 keep it small and
  off by default.
- **A connector token is a bearer token.** Anyone holding a live access token can use it for up to
  an hour. Hashed storage, the one-hour life, refresh rotation with reuse detection, the Claude
  address range and the three people who can stop a grant are the answer.
- **A stolen key file is a working key until it is disabled or expires.** The file is the key; the
  helper keeps it readable only by the person's own account. Expiry, the owner's list, the Steward's
  list and the admin's Disable are the answer, and the expiry has no "never".
- **More surface on a security-first product, before beta.** The owner's own card says after beta;
  this is built now as an unmerged draft so the decision can be judged on working code, and a
  security sweep follows before any merge.
