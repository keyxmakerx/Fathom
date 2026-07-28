# 33 — The sync protocol

> **Status:** Proposed

The server stores ciphertext and never holds a key (brief §1, invariant 4). Everything hard about
this protocol follows from that one sentence, and almost none of it is the cryptography.

A server that cannot decrypt cannot compact, cannot garbage-collect, cannot rebase, cannot resolve
a conflict, cannot validate what it stores, cannot deduplicate, cannot index, cannot answer a
query, and cannot tell abuse from use. Every one of those is a service a normal sync backend
provides, and every one of them has to be moved to the client or given up. Most published CRDT
sync designs assume the server can read the document; the parts that assume it are exactly the
parts that make the system efficient, and they are the parts that have to be rebuilt here.

**The governing rule of this document, stated once, in caps, at the top:**

> **THE SERVER IS A DUMB, HOSTILE, AVAILABLE DISK. IT ORDERS BYTES AND COUNTS THEM. EVERYTHING
> ELSE IS THE CLIENT'S JOB.**

A terminology note that matters throughout. A syncing installation — a laptop, a browser profile,
a CLI on a jump host — is a **client**. It is never a "device": `Device` is a node kind in the
graph (conventions, *Terminology*), and `31-threat-model.md` §7.2's metadata channel M6, "device
count", means *client* count in this document's vocabulary.

---

## 0. Contents

| § | |
|---|---|
| 1 | What the server is for, and the six things it must not be able to do |
| 2 | The API surface — nine operations, with types |
| 3 | Authentication, and the separation of the account credential from the workspace key |
| 4 | The CRDT — the decision, weighed |
| 5 | The op model and the merge function |
| 6 | Convergence semantics for this domain |
| 7 | Where the UI must stop and ask a human |
| 8 | Offline-first — long disconnection and a large backlog |
| 9 | Compaction, which the server cannot do |
| 10 | Rate limiting, quota, abuse and denial of service |
| 11 | Multi-device for one user — the common case |
| 12 | What this protocol adds to the metadata problem |
| 13 | Failure modes |
| 14 | What this costs |
| 15 | Open decisions |
| 16 | Sources |
| 17 | Proposed amendments to other documents |
| 18 | Disagreements |

---

## 1. What the server is for

### 1.1 The four jobs

| Job | Detail |
|---|---|
| **Availability** | Hold frames so a client that was not present when they were written can get them. This is the whole product of the service |
| **Ordering authority for replay defence** | Hold a signed, monotonic `generation` per workspace so a rollback is detectable (`31-threat-model.md` §5.2, row 5). Git does this job in the git transport (`17-workspace-format.md` §7.4); on the wire, the server does |
| **An availability ACL** | Refuse writes from a public key that is not in the workspace's member list. §3.5 states precisely how weak a control this is |
| **Metering** | Count bytes, frames and requests, and refuse past a limit. §10 |

That is all. Anything else proposed for the server should be tested against §1.2.

### 1.2 The six things the server must not be able to do

| Must not | Why it is structurally prevented |
|---|---|
| Read any workspace content | Frames are AEAD-sealed under keys derived from the workspace key, which never leaves a client (`17-workspace-format.md` §5.2) |
| Forge content | Same. A modified frame fails its tag. The server can only drop, delay, duplicate or reorder |
| Learn a passphrase or a key | It never receives one, in any form, including during authentication (§3.2) |
| Merge, compact, garbage-collect or rebase | It cannot decrypt. §9 is the entire consequence |
| Distinguish a real frame from padding, or a graph from a cache entry | Frame bodies are opaque and Padmé-padded. This is deliberate and it is also what makes §10's abuse story unpleasant |
| Learn who a client is beyond a public key and a source address | Accounts carry no name requirement. §12 lists what remains, which is not nothing |

### 1.3 What the server unavoidably does learn

Nothing new is invented here. `31-threat-model.md` §7.2 enumerates M1–M10 and §12 of this document
states which of them this protocol's specific choices create or worsen. The one-line version, which
belongs on the sync setup screen verbatim:

> **The server cannot read your workspace. It can see that you have one, roughly how big it is,
> and every time you change it.**

---

## 2. The API surface

### 2.1 Nine operations

Counted as `(method, path)` pairs. Nine, and the ninth is optional.

| # | Operation | Purpose |
|---|---|---|
| 1 | `POST /v1/auth` | OPAQUE, two round trips through one endpoint (§3.2) |
| 2 | `GET /v1/workspaces` | What this account may reach, each one's generation and size, and the account's quota |
| 3 | `GET /v1/w/{wid}/index` | The sync index: root, or one bucket's entries (§8.3) |
| 4 | `POST /v1/w/{wid}/frames` | Upload sealed frames |
| 5 | `GET /v1/w/{wid}/frames` | Download frames, by record range or digest list |
| 6 | `POST /v1/w/{wid}/compact` | Publish a compaction claim (§9.3) |
| 7 | `POST /v1/w/{wid}/members` | Add or remove a client public key (§3.5) |
| 8 | `DELETE /v1/w/{wid}` | Delete the server's copy |
| 9 | `GET /v1/w/{wid}/events` | Optional live channel. Strictly an optimisation over polling #3 |

**There is no create operation.** A workspace exists the first time frames are accepted for a
`wid` the client generated. This removes an endpoint, removes a namespace the server controls, and
removes the only place the server would have had to decide what a workspace *is*. Quota is enforced
on #4, where it has to be enforced anyway.

**There is no read-of-content operation**, because there is no content the server can produce.
Everything is frames.

### 2.2 Shared types

```rust
// ── identity ──────────────────────────────────────────────────────────
/// Generated client-side at workspace creation. 128 bits of CSPRNG output.
/// NEVER derived from a name — a workspace id that is `blake3("site-b")`
/// is a dictionary attack away from being a name (17 §6.1's failure mode,
/// moved to the wire).
pub struct WorkspaceId(pub [u8; 16]);

pub struct RecordId(pub [u8; 16]);        // ULID
pub struct FrameDigest(pub [u8; 32]);     // BLAKE3 over the whole frame
pub struct ClientId(pub [u8; 16]);        // ULID. One syncing installation
pub struct ClientPubKey(pub [u8; 32]);    // Ed25519 verifying key

// ── transport framing ─────────────────────────────────────────────────
/// Every request carries this. Never in a cookie — 31 §5.1 row 16.
/// Header: `Authorization: Bearer <base64url(SessionToken)>`
pub struct SessionToken(pub [u8; 32]);

/// Wire encoding for every body: canonical CBOR (RFC 8949), same as the
/// workspace format. One codec, one set of bugs.
```

Errors are a closed enum, and they are deliberately uninformative about anything the server should
not be distinguishing:

```rust
#[repr(u16)]
pub enum SyncError {
    Unauthenticated      = 401,
    NotAMember           = 403,
    NoSuchWorkspace      = 404,   // returned identically for "exists, not yours"
    GenerationConflict   = 409,   // optimistic concurrency; retry after a fetch
    PayloadTooLarge      = 413,
    QuotaExceeded        = 429,   // with Retry-After
    RateLimited          = 429,   // indistinguishable from QuotaExceeded to a caller
    Malformed            = 400,
    ServerFault          = 500,
}
```

`NoSuchWorkspace` for both "does not exist" and "exists but you are not a member" is deliberate:
otherwise the API is a workspace-id oracle, and workspace ids are the only thing linking an
account to a workspace. Ids are 128-bit random so enumeration is hopeless anyway, but an oracle
that confirms a *guessed* id is worth removing for free.

### 2.3 `POST /v1/auth`

Two calls, one endpoint. The state between them is a server-held `flow` token with a 30-second
expiry, so the endpoint is stateless from the client's point of view. Details in §3.2.

```rust
pub enum AuthRequest {
    Start  { username_hash: [u8; 32], ke1: OpaqueKe1 },
    Finish { flow: FlowToken, ke3: OpaqueKe3, client: ClientPubKey },
}

pub enum AuthResponse {
    Challenge { flow: FlowToken, ke2: OpaqueKe2 },
    Session   { token: SessionToken, expires: Timestamp, account: AccountId },
}
```

`username_hash` rather than a username: the server needs a stable lookup key, not an identifier.
`blake3_keyed(server_public_salt, username)` — the salt is published, so this is obfuscation and
not protection, and it is worth exactly what it costs, which is nothing. Do not describe it as
more.

### 2.4 `GET /v1/workspaces`

```rust
pub struct WorkspaceListResponse {
    pub workspaces: Vec<WorkspaceSummary>,
    pub quota: QuotaState,
}

pub struct WorkspaceSummary {
    pub id: WorkspaceId,
    pub generation: u64,
    /// Signature by a member key over (wid, generation, index_root).
    /// The client checks this before trusting `generation` for replay
    /// defence — the server must not be the authority on its own honesty.
    pub attest: MemberSignature,
    pub index_root: Blake3,
    pub bytes: u64,
    pub frames: u64,
    pub members: u16,
    pub last_write: Timestamp,
}

pub struct QuotaState {
    pub bytes_used: u64,
    pub bytes_limit: u64,
    pub workspaces_used: u16,
    pub workspaces_limit: u16,
    pub frames_today: u32,
    pub frames_today_limit: u32,
}
```

`attest` is the piece that matters. The server reports `generation`; a client that trusted that
number would accept a rollback from a hostile operator. The signature is produced by whichever
client last advanced the generation, using a key derived from the workspace key or held by the
member, and it is verified client-side. The server cannot produce it and cannot alter what it
covers.

### 2.5 `GET /v1/w/{wid}/index`

```rust
/// GET /v1/w/{wid}/index                    -> IndexRoot
/// GET /v1/w/{wid}/index?bucket=0x1f3        -> IndexBucket
pub struct IndexRoot {
    pub generation: u64,
    pub attest: MemberSignature,
    pub root: Blake3,
    /// 1 024 × 32 B = 32 KiB. Sent whole; it is smaller than one frame.
    pub buckets: [Blake3; 1024],
}

pub struct IndexBucket {
    pub bucket: u16,
    pub entries: Vec<IndexEntry>,      // sorted by record id
}

pub struct IndexEntry {
    pub record: RecordId,
    pub kind_opaque: u16,              // the record kind, in the clear — §12.3
    pub frames: u32,
    /// BLAKE3 over the sorted frame digests. Order-independent, so two
    /// clients holding the same frames agree without agreeing on order.
    pub set_digest: Blake3,
    pub bytes: u64,
    pub baseline_at: FrameDigest,
}
```

The 1 024-bucket Merkle structure is the same one in `17-workspace-format.md` §7.1, computed over
the same keyed pseudonyms, so the client's local index and the server's are directly comparable
without translation.

### 2.6 `POST /v1/w/{wid}/frames`

```rust
pub struct UploadRequest {
    /// Optimistic concurrency. The server rejects with GenerationConflict
    /// if its current generation is not this value. The client then fetches
    /// and retries. This is the only serialisation point in the protocol
    /// and it exists solely so `generation` stays monotonic.
    pub from_generation: u64,
    pub frames: Vec<UploadFrame>,
    pub client: ClientId,
    /// Ed25519 over BLAKE3("fathom/v1/upload" ‖ wid ‖ from_generation ‖
    ///                     sorted frame digests).
    pub sig: [u8; 64],
    /// The new signed head, produced by this client, that the server will
    /// serve to others as `attest`.
    pub attest: MemberSignature,
}

pub struct UploadFrame {
    pub record: RecordId,
    pub record_kind: u16,
    pub digest: FrameDigest,
    /// The sealed frame exactly as it appears on disk: header + ct + tag.
    /// The server verifies `digest == blake3(bytes)` and nothing else.
    pub bytes: Bytes,
}

pub struct UploadResponse {
    pub generation: u64,
    pub accepted: u32,
    /// Frames it already had. Not an error; a client reconnecting after a
    /// partial upload re-sends and this is how it learns it is done.
    pub duplicate: u32,
}
```

The server's checks, in order, and the list is exhaustive:

| Check | Cost |
|---|---|
| Session valid | `O(1)` |
| `client` is in the workspace's member list | `O(log m)` |
| `sig` verifies under that client's public key | one Ed25519 verify per request, not per frame |
| `from_generation` matches | `O(1)` |
| Frame count ≤ 256, body ≤ 16 MiB, each frame ≤ 1 MiB | `O(1)` |
| `digest == blake3(bytes)` for each frame | `O(bytes)` |
| Quota | `O(1)` |

It does not, and cannot, check that a frame is well-formed, that its AEAD tag is valid, that it
belongs to the record it claims, that it is not garbage, or that it is not a re-upload of
something the workspace already superseded. §10.4 is the consequence.

### 2.7 `GET /v1/w/{wid}/frames`

```rust
pub enum FrameQuery {
    /// Everything in a record that is not in `have`. The common case after
    /// an index descent finds one record differing.
    Record { record: RecordId, have: Vec<FrameDigest> },
    /// Explicit list. Bounded at 512 to prevent a 10 GB single request.
    Digests { digests: Vec<FrameDigest> },
}

pub struct FrameQueryResponse {
    pub frames: Vec<UploadFrame>,
    /// Set when the response was truncated at the size cap. The client
    /// re-issues with the remainder. Chunking is the client's problem
    /// because only the client knows what it still needs.
    pub more: bool,
}
```

`have` rather than a range, because frames are a set and not a sequence
(`17-workspace-format.md` §5.3). A range would require the two sides to agree on an order they do
not have.

### 2.8 `POST /v1/w/{wid}/compact`, `POST /v1/w/{wid}/members`, `DELETE`

Types are in §9.3 and §3.5 respectively, where they are argued rather than merely declared.
`DELETE /v1/w/{wid}` requires a member signature over `("fathom/v1/delete", wid, generation)` and
takes effect after a 7-day tombstone during which the workspace returns `NoSuchWorkspace` but the
bytes are retained. That grace period exists because a hostile or compromised member deleting a
team's workspace is a cheap attack against availability, and §3.5 states that the ACL is an
availability control — so it must be one that fails recoverably.

### 2.9 `GET /v1/w/{wid}/events` — the optional live channel

Server-sent events. One event type:

```text
event: head
data: {"generation":4128,"root":"blake3:9f21…","attest":"…"}
```

That is the entire payload — no frame contents, no record ids, no counts. A client that receives it
performs an index descent exactly as if it had polled. The channel is an optimisation and nothing
depends on it: with it, propagation is sub-second; without it, propagation is one poll interval.

**Why it is deliberately this thin.** A live channel that pushed frames would give the server a
reason to know which client wants which record, which is `31-threat-model.md` §7.2's M8 delivered
in real time. Pushing only "something changed" keeps the server's knowledge at the granularity it
already has.

**CSP consequence.** The sync build's `connect-src` is exactly one origin (invariant 1), and SSE
is a same-origin `EventSource` to that origin. No WebSocket, no second host, no CDN. If SSE proves
unworkable behind some corporate proxy, the fallback is polling — never a second origin.

---

## 3. Authentication

### 3.1 DECISION — the account credential and the workspace key are different secrets, and neither derives from the other

| | Account credential | Workspace key (WK) |
|---|---|---|
| What it proves | This client may write to this workspace on this server | This client may read the contents |
| Who checks it | The server | Nobody. It either decrypts or it does not |
| What it protects | Availability, quota, abuse | Confidentiality |
| Where it lives | Server holds an OPAQUE registration record; client holds a password | Client only; derived from the workspace passphrase or unwrapped from a member wrap |
| Rotating it costs | One OPAQUE re-registration. Zero bytes re-encrypted | A full re-encryption of every record (§3.6) |
| Losing it costs | A support flow, or a new account | **Everything.** There is no recovery |
| If the server is compromised | The attacker gets ciphertext and metadata | Nothing |

**Why they must be separate**, in the order the arguments actually matter:

1. **Rotation asymmetry.** People change passwords. If the workspace key derived from the account
   password, every password change would re-encrypt the entire workspace — 80 MB at 500 devices —
   and every historical frame would be unreadable or would have to be re-sealed. Separating them
   makes an account password change free.
2. **Enterprise identity.** A self-hosted deployment will want the account credential to be OIDC
   or SAML against the customer's IdP. That must be possible **without the IdP being able to
   decrypt anything**, which is only true if the account credential is not in the confidentiality
   path at all. This is the single strongest practical argument and it will come up in the first
   enterprise conversation.
3. **Sharing.** Giving a colleague access to a workspace is a key-wrapping operation between
   clients (§3.5). It is not an account operation and must not require the server's involvement or
   consent.
4. **Blast radius.** A phished account password yields the ability to write garbage and to read
   ciphertext. It does not yield a single plaintext byte.

**The honest limit:** nothing stops a user from typing the same string for both. Many will. The
product should not prevent it — a passphrase manager makes it a non-issue and a nag makes it a
habit — but the *generated-passphrase* default for the workspace (`31-threat-model.md` §2.4)
matters far more here than any warning, because a generated workspace passphrase cannot be reused
as an account password by accident.

### 3.2 The account credential: OPAQUE

**DECISION — OPAQUE (RFC 9807), not a password hash sent over TLS.**

OPAQUE is an augmented PAKE: the server never sees the password, not even during registration, and
a server compromise does not enable pre-computation against the stolen database. It was published
as RFC 9807 in July 2025 as a product of the CFRG — informational, not standards-track, and that
should be said rather than glossed.

Flow, mapped onto §2.3's single endpoint:

```text
  client                                            server
  ──────                                            ──────
  KE1 = ClientInit(password)
        ── POST /v1/auth {Start, username_hash, ke1} ──▶
                                       lookup registration record
                                       KE2 = ServerInit(record, ke1)
        ◀── {Challenge, flow, ke2} ─────────────────────
  KE3, session_key, export_key = ClientFinish(ke2)
        ── POST /v1/auth {Finish, flow, ke3, client_pk} ▶
                                       ServerFinish(ke3) → session_key
        ◀── {Session, token, expires} ──────────────────
```

**What we do with `export_key`: nothing.** OPAQUE yields a client-side `export_key` that is a
natural place to hang application secrets, and it is precisely the wrong place here. Deriving WK
from `export_key` would recreate the coupling §3.1 exists to break, and would make the server's
OPRF a participant in every decryption. It is discarded.

**Why not simply "hash the password client-side and send the hash":** because that hash *is* the
password — anyone who steals the server's database can replay it. Why not "send the password over
TLS and let the server hash it": because the server then sees every password, which is the thing
invariant 4 is about even though invariant 4 is written about keys.

**The cost of OPAQUE, stated:** a second round trip on login; a dependency on an OPAQUE
implementation in Rust and in WASM whose maturity must be assessed rather than assumed; and a
protocol that is harder to reason about than "bearer token from an IdP". For the self-hosted
enterprise case, OPAQUE is bypassed entirely in favour of OIDC (§3.3), which is a simpler
credential path that costs nothing because it was never in the confidentiality path.

<!-- VERIFY: audit status, maintenance and WASM footprint of the candidate Rust OPAQUE
     implementations before committing. RFC 9807 is informational; implementations vary in which
     ciphersuite and which OPRF they instantiate, and mismatches are silent interop failures. -->

### 3.3 The enterprise path

| Deployment | Account credential | Changes to anything below |
|---|---|---|
| Public or personal instance | OPAQUE | — |
| Self-hosted, enterprise | OIDC / SAML against the customer's IdP; the server exchanges an ID token for a `SessionToken` | **None.** The IdP learns who logged in; it learns nothing about content, because the account credential was never in the confidentiality path |
| Air-gapped | No server at all | The whole document is inapplicable. `17-workspace-format.md` and a USB stick |

That the enterprise path requires no change to §§4–9 is the payoff of §3.1's separation, and it is
worth stating as the reason rather than as a happy accident.

### 3.4 The workspace key hierarchy

Only the parts this protocol needs. Full key management belongs to a document in `30-security/`
that has not been written; where this document has to assume something, it says so.

```text
  workspace passphrase
      │  Argon2id(salt, params from the keys record header)   RFC 9106 §4
      ▼
     KEK ───────────────► unwraps ───────► WK  (256-bit, CSPRNG at creation)
                                            │
   member X25519 secret ─► HPKE open ───────┘   RFC 9180, mode_base
                                            │
        ┌───────────────────────────────────┼───────────────────────────┐
        ▼                   ▼               ▼                ▼          ▼
   K_rec[record]        K_name          K_manifest      K_admin      K_capture
   HKDF-Expand          filenames        manifest      Ed25519 seed  per-capture
   per record          (17 §6.3)                       (§3.5)        (17 §4.5)
```

All expansions are HKDF-Expand (RFC 5869) with a domain-separated `info` string of the form
`"fathom/v1/<purpose>"`, plus the record id where one applies. Per-record subkeys exist so that a
future per-record access control has somewhere to attach, and because it costs one HKDF invocation
per record open. **It is not compartmentation today**: `K_rec` is derived from WK, so holding WK
holds every record (`17-workspace-format.md` §17, and `31-threat-model.md` R8).

### 3.5 The member list, and how weak it is

The server holds, per workspace, in the clear:

```rust
pub struct MemberEntry {
    pub client: ClientId,
    pub pubkey: ClientPubKey,          // Ed25519 verifying key
    pub added_at: Timestamp,
    pub added_by: ClientId,
    pub role: MemberRole,              // Writer | Admin
    /// Signature by an Admin key over the whole entry.
    pub sig: [u8; 64],
}
```

```rust
pub struct MembersRequest {
    pub from_generation: u64,
    pub ops: Vec<MemberOp>,            // Add(MemberEntry) | Remove(ClientId)
    pub by: ClientId,
    pub sig: [u8; 64],
}
```

Bootstrap: the first client to upload frames for a `wid` becomes the sole `Admin`. The server
accepts that on trust-on-first-use, and that is acceptable **only because the ACL is not a
confidentiality control.** An attacker who claims an unused `wid` gets an empty workspace nobody
else can find, because `wid` is 128 bits of randomness held only by its creator.

**The sentence that has to be in the product's documentation, not only here:**

> **Removing a member from the list removes their ability to write to the server. It does not
> remove their ability to read.** They hold the workspace key. Every byte they already downloaded
> stays readable, and every byte written afterwards under the same key stays readable to them if
> they obtain it by any other route.

Real revocation is re-keying (§3.6). Most end-to-end-encrypted products blur this; we should not,
because a network engineer removing a departed colleague from a workspace will otherwise believe
something false about their estate's confidentiality.

### 3.6 Re-keying, priced

| Step | Cost at 500 devices |
|---|---|
| Generate WK′, re-wrap to remaining members | milliseconds |
| Re-seal every record under keys derived from WK′ | full rewrite: ~80 MB, all 2 100 records |
| Upload | 80 MB, or a coordinated "everyone re-fetch" |
| In git | 80 MB of new blobs; every old blob retained forever, still readable under WK |
| Filenames change | `K_name` changes, so **every file is renamed**. Git sees 2 100 deletes and 2 100 adds |
| What it achieves | Future writes are unreadable to the removed member |
| What it does not achieve | Everything they already have. Every historical git commit. Every frame the sync server retained under the old key |

`17-workspace-format.md` §6.3 makes filenames a function of `K_name`, so a re-key is also a
complete rename of the tree. That is unpleasant in git and it is the correct behaviour: if
filenames survived a re-key, they would be a stable cross-key identifier, which is worse.

**RECOMMENDATION —** offer re-keying, present it with exactly the table above, and never present
it as "revoking access". Call it what it is: rotating the key so that *future* content is closed.

---

## 4. The CRDT

### 4.1 What the choice actually has to satisfy

Six requirements, in the order that eliminated candidates:

| # | Requirement | Where it comes from |
|---|---|---|
| R1 | **The server never decrypts.** So the library's sync protocol, if it has one, cannot be used as-is — every published CRDT sync protocol assumes the peer can inspect what it is syncing | Invariant 4 |
| R2 | **Per-field-class conflict semantics.** Last-writer-wins is wrong for a security tool (§6). The resolution ladder in `11-ir-schema.md` §8.6 already exists and is not any library's ladder | §6 |
| R3 | **Conflicts must be representable, not resolved.** `Field::Conflicted` is a first-class state in the schema and an L2 emit blocker | `11-ir-schema.md` §5.4, §9.1 |
| R4 | **Determinism to the byte.** Two clients with the same op set serialise identically | Invariant 9 |
| R5 | **Bounded growth with client-driven compaction.** Nobody else can compact for us | §9 |
| R6 | **Small WASM footprint, Rust-native.** The core is Rust compiled to WASM and to a CLI | Brief §8 |

Note what is *not* on that list: a sequence CRDT. Fathom's graph has no long ordered text. The
closest things to sequences are `proposals` on an IKE policy (a handful of names), address-set
members (unordered), and `order_hint` on emitted lines (derived, not stored). **The hardest and
largest part of every CRDT library — correct sequence interleaving — is the part we do not use**,
and it is most of what we would import in both bytes and semantics.

### 4.2 The comparison

| | **Automerge 3** | **Yjs / yrs** | **Loro** | **Hand-rolled over the typed graph** |
|---|---|---|---|---|
| Rust-native core | yes | `yrs` is a port; JS is the reference implementation | yes | yes — it is part of a core we already compile |
| Data-model fit | untyped Map/List/Text. The typed graph must be projected in and back out on every read | same | same, plus a movable tree | **exact.** Ops are typed against `schema.yaml` and checked by the compiler |
| R2 per-class semantics | must be layered on top of Automerge's own resolution | not possible without abandoning its registers | same as Automerge | native |
| R3 conflicts representable | **yes** — keeps concurrent values, exposed via `conflicts()`. The closest of the three | no — pure LWW, the loser is discarded | LWW registers | native; `Field::Conflicted` *is* the register's state |
| R5 history growth | monotonic. Automerge 3 (July 2025) cut *runtime* memory dramatically — the reference example is pasting Moby Dick, 700 MB under Automerge 2 versus 1.3 MB under 3 — but that is a runtime representation win, not history GC | tombstones retained; deleted content GC'd, identity kept | **best off-the-shelf**: shallow snapshots trim history before a chosen frontier, with the stated limitation that peers can only sync if they hold versions after that point | ours; §9 |
| R1 encrypted transport | Beelay is building exactly this — encrypted payloads a server cannot decrypt, a sedimentree commit-DAG structure and a reachability index the server maintains as a CRDT over links it cannot read. **Pre-alpha, unstable API, unaudited by its own README** | no story | no story | by construction |
| R6 footprint | large; a WASM module plus initialisation cost | smallest overall — no WASM in the JS build | mid; Rust + WASM | smallest possible: no new dependency |
| Battle-testing | **highest** | highest by deployment count | growing fast | **none. This is the cost, and it is the only column that argues against** |
| Text CRDT quality | good | good | best (Fugue) | n/a — we do not need one |

<!-- VERIFY: the bundle-size and encoding-size comparisons circulating for these three libraries
     come from secondary write-ups, not from measurement in our build. Before this table is used
     to defend the decision to anyone, compile all three to `wasm32-unknown-unknown` with our
     release profile and measure. The Automerge 3 memory figures are from the project's own
     announcement and are about runtime representation, not about history size. -->

### 4.3 DECISION — a hand-rolled op-based CRDT over the typed graph

The decisive rows are R2, R3 and the absence of a sequence requirement. Adopting a library would
mean projecting a typed graph into an untyped document, layering our resolution ladder on top of
the library's, and carrying a sequence CRDT we never invoke — three costs, to buy back a
correctness argument we would then have to re-make anyway at the layer where our semantics live.

**What we are actually building, stated as a bound so the scope is arguable:** four convergent
types, no more.

| Type | Used for | Convergence |
|---|---|---|
| **Grow-only set** | Provenance records, captures, AI value records, export log | Union. Elements are immutable and ULID-keyed. Trivially convergent |
| **Add-wins observed-remove set (OR-Set)** | Node and edge existence; set-valued fields; suppressions | Add wins over a concurrent remove. Remove carries the op ids it observed |
| **Multi-value register** | Every scalar field | Keeps all causally-maximal writes. Resolution to one value happens at *read*, per §6 |
| **Last-writer-wins register** | Diagram position, colour, per-block depth override, cache entries | `(hlc, actor)` order. Losing one costs nothing |

There is no sequence type, no counter, no text type, no move operation. Four types is a surface a
person can hold in their head and a property test can cover exhaustively.

### 4.4 The cost of hand-rolling, without softening

| Cost | Detail |
|---|---|
| **We own the correctness argument** | Nobody else has run this code for five years against thousands of documents. Automerge and Yjs have. That is a real difference in the probability of a convergence bug reaching a user |
| **A convergence bug is a data-loss bug** | Two clients disagreeing permanently about the same workspace is the worst failure this product can have, and it is silent |
| **We own the performance work** | Automerge 3's memory rearchitecture was a substantial engineering effort by people who do this full time |
| **Interop is zero** | No existing tooling reads our op log. No `automerge-repo`, no inspector, no ecosystem |
| **We must build the test apparatus that libraries ship with** | §4.6 |

### 4.5 The reversal trigger, named in advance

> **If the property tests in §4.6 cannot be made to pass within one milestone, adopt Loro**, layer
> the §6 resolution on top of its registers, and accept the projection cost. Loro is the fallback
> rather than Automerge because R5 — shallow snapshots — is the requirement a library must satisfy
> that we would otherwise have to build, and it is the only one of the three that ships an answer.

Writing the reversal trigger down before starting is the difference between a decision and a
commitment. It should be checked at the milestone whether or not anyone remembers to ask.

### 4.6 How we buy back confidence

| Test | What it establishes |
|---|---|
| **Commutativity property test** | For a random op set of size *n*, applying it in 1 000 random orders yields byte-identical serialisation. This is invariant 9 as an executable test and it is the single most important test in the product |
| **Idempotence** | Applying the same op twice changes nothing. Covers duplicate delivery, which the protocol permits |
| **Associativity across merge shapes** | `merge(merge(a,b),c) == merge(a,merge(b,c))`, exercising git's recursive and octopus merges |
| **Differential test against Automerge** | For the subset where our semantics coincide with Automerge's — grow-only sets and LWW registers — run the same op sequence through both and compare. Cheap, and it catches the class of bug where our concurrency detection is subtly wrong |
| **Convergence under adversarial partition** | Simulate *k* clients with random partitions, random offline durations up to 18 months of simulated time, random clock skew including backwards jumps, and assert convergence |
| **Compaction equivalence** | For any op set and any compaction point, the compacted state and the uncompacted state resolve every field identically, including `Conflicted` fields and their candidate sets. §9.4 depends on this |

The last one is the one that will find bugs, because compaction is where a hand-rolled CRDT
usually loses information it did not know it needed.

---

## 5. The op model

### 5.1 Ops

```rust
pub struct OpEnvelope {
    pub id: OpId,
    pub op: Op,
}

/// Total order for serialisation and for LWW. NOT a causality test — §5.3.
#[derive(PartialOrd, Ord)]
pub struct OpId { pub hlc: Hlc, pub actor: ActorPseudonym }

/// Hybrid logical clock. `wall_ms` tracks real time so provenance timestamps
/// are meaningful to humans; `counter` breaks ties and keeps the clock
/// monotonic when the wall clock goes backwards, which it does.
pub struct Hlc { pub wall_ms: u64, pub counter: u16 }

pub enum Op {
    AddNode  { node: NodeId, kind: NodeKind, prov: ProvenanceId },
    AddEdge  { edge: EdgeId, kind: EdgeKind, from: NodeId, to: NodeId, prov: ProvenanceId },

    /// The only value-writing op. It carries the WHOLE value, never a delta
    /// against a previous value. Ops are state-carrying. §9.4 depends on this
    /// and it is why an op is ~96 bytes instead of ~40.
    SetField { field: FieldRef, value: PresenceRepr, prov: ProvenanceId, class: FieldClass },

    /// 11 §10.5: absence is not deletion. This is the normal removal.
    Tombstone { element: ElementId, at: Timestamp },

    /// The only destructive op, issued only by a human, only against an
    /// already-tombstoned element, and carrying a reason.
    Purge { element: ElementId, reason: BoundedText<200> },

    SetAdd    { set: FieldRef, member: MemberKey, prov: ProvenanceId },
    /// OR-Set remove: names exactly the adds it observed. An add it did not
    /// observe survives. §6.4.
    SetRemove { set: FieldRef, member: MemberKey, observed: SmallVec<[OpId; 4]> },

    Suppress   { suppression: Suppression },
    Unsuppress { id: SuppressionId, observed: SmallVec<[OpId; 2]> },

    /// Grow-only. Immutable content, ULID-identified. Never conflicts.
    ProvRecord { rec: ProvenanceRecord },
    Capture    { id: CaptureId, digest: Blake3 },
    AiValue    { rec: AiValueRecord },
    Export     { rec: ExportRecord },
}
```

### 5.2 Frames carry the causality summary, not ops

Deciding "did A see B?" needs causal information. Carrying it per op would double the op size.
Carrying it per frame amortises it across a batch:

```rust
/// One frame body. ~30 ops is typical for an interactive save.
pub struct FrameBody {
    /// What this client had applied when it produced these ops.
    pub vv: VersionVector,
    pub ops: Vec<OpEnvelope>,
    pub schema_version: SchemaVersion,     // §8.5
}

/// One entry per actor that has ever written to this workspace.
pub struct VersionVector(pub BTreeMap<ActorPseudonym, Hlc>);
```

| | Size |
|---|---|
| Version vector, 4-person team | 4 × 16 B = 64 B |
| Version vector, 20 clients | 320 B |
| Amortised over 30 ops | 2–11 B per op |
| An op | ~96 B sealed and padded |

**Version vectors grow with the number of actors that have *ever* written, forever.** 200 actors
over five years is 3.2 KB per frame, which at 30 ops per frame is worse than the ops. The bound is
compaction: a baseline frame absorbs every prior actor into a single summary entry, so the live
version vector tracks only actors that have written since the last baseline. That is one more
reason §9 is not optional.

### 5.3 Concurrency is a causality test, never a clock comparison

```text
concurrent(a, b)  ⟺  ¬(a.id ≼ vv(b))  ∧  ¬(b.id ≼ vv(a))

where  x ≼ V  ⟺  V contains x.actor with V[x.actor] ≥ x.hlc
```

`O(1)` per test with a hash lookup; `O(actors)` to compare two version vectors.

**This is the load-bearing definition in the whole document and it must not be replaced by a
timestamp comparison.** Two clients that have been offline for a month have wall clocks that agree
to within whatever their NTP happened to do, which for a laptop that was suspended in a bag is
"not at all". A hybrid logical clock bounds skew only among participants that are exchanging
messages; two participants exchanging nothing have no bound at all. §6.3 is what follows.

### 5.4 The merge function

```text
apply(state, frame):
    for op in frame.ops sorted by op.id:          # sort for byte-determinism,
        dispatch(state, op, frame.vv)             # NOT for correctness
    state.vv = join(state.vv, frame.vv)

dispatch:
    AddNode / AddEdge        -> insert if absent; idempotent on the id
    SetField                 -> push (op.id, value, prov, frame.vv) into the
                                field's candidate set; prune dominated candidates
    Tombstone                -> set absent_since = min(existing, at)
    Purge                    -> mark purged; the element and its candidates drop
    SetAdd                   -> insert (member, op.id)
    SetRemove                -> delete exactly the (member, op.id) pairs in
                                `observed`; adds not observed survive
    ProvRecord / Capture /
      AiValue / Export       -> insert into the grow-only store, keyed by id
```

| Operation | Complexity |
|---|---|
| Apply one op | `O(1)` amortised, plus `O(c)` candidate pruning where `c` is the field's live candidate count — 1 in the overwhelming majority of cases |
| Apply a backlog of *n* ops | `O(n)` plus `O(n log n)` for the per-frame sort |
| Resolve a field at read | `O(c)`, `c` ≤ concurrent writers |
| Merge two states | `O(Δ)` in the ops one side lacks. Never `O(state)` |

**Candidate pruning.** A candidate is dominated if some other candidate for the same field was
written by a client that had already seen it (`a.id ≼ vv(b)`). Dominated candidates are dropped at
apply time, so a field that has been written a thousand times sequentially holds exactly one
candidate. Only genuine concurrency grows the set, and only until a human resolves it.

### 5.5 Resolution runs at read, not at write

This is a design choice with a consequence worth naming: the stored state keeps the candidate set,
and the single value is computed on demand by §6.2's algorithm. The alternative — resolving at
write — is faster to read and destroys the information a human needs to resolve a conflict. Since
the whole point of §6 is that some conflicts must reach a human, the information has to survive
until they see it.

Resolution is cached per field and invalidated when a candidate is added, so the read cost in
steady state is a pointer dereference.

---

## 6. Convergence semantics for this domain

### 6.1 Why the generic answer fails here

The generic CRDT answer to "two people set the same field to different values" is last-writer-wins
by some deterministic tiebreak. That answer is correct in the sense that it converges, and wrong in
the sense that convergence is not the property we need. Field card, side 2, in caps at the top of
the page:

> **BOTH ENDS MUST AGREE — EVERY VALUE, EXACTLY**

A merge that silently picks a value produces a configuration that no engineer chose, for a protocol
where the far end will not negotiate down to a common denominator. The consequence is not a lost
edit. It is a tunnel that does not come up, and a diagnostic hunt that starts from a config the
tool wrote.

Restated as the imperative for the merge review screen:

> **A MERGED VALUE NOBODY CHOSE IS THE ONE THAT REACHES THE BOX**

### 6.2 The resolution algorithm

```text
resolve(field) -> Field<T>

 1. C ← candidates(field), dominated ones already pruned (§5.4)
 2. if |C| == 1                              -> Resolved(C[0])
 3. if all of C agree on the VALUE           -> Resolved(any), keeping every
                                                provenance record. Agreement is
                                                agreement even from two sources
 4. run 11 §8.6's ladder on C:
      a. higher Confidence wins:  Asserted > Derived > Heuristic
      b. then Origin precedence:  Hand > Parsed > Imported > Inferred > Defaulted
      c. then later asserted_at
    ── but with the amendment in §6.3 applied at step (c) ──
 5. if the ladder leaves exactly one         -> Resolved(winner)
      and if the winner was Hand while a Parsed candidate disagreed
                                             -> Resolved(Hand) + Divergent marker
                                                + finding merge.divergent.observed
 6. otherwise                                -> Conflicted(C ordered by ProvenanceId)
```

Steps 1–3 and 4a–4b are `11-ir-schema.md` §8.6 unchanged. Steps 4c, 5 and 6 are where this
document has something to add.

### 6.3 DECISION — recency does not resolve a concurrent write to a security-material field

`11-ir-schema.md` §8.6 says, correctly for the sequential case:

> *Two `Hand` assertions at different times do resolve by recency, which is last-writer-wins and
> is the standard, lossy, understood answer — the loser is still in the history and the UI shows
> it.*

That is right when one writer saw the other's value. It is wrong when neither did. **Recency is a
valid tiebreak only when it encodes "I looked at your value and chose differently". Under
concurrency it encodes nothing but clock skew.**

> **DECISION —** for fields in class A (§6.4), if two candidates are *concurrent* by §5.3's
> causality test, the ladder's timestamp step is not applied. The field becomes `Conflicted`,
> regardless of timestamps, regardless of how far apart they are.

This is a proposed amendment to `11-ir-schema.md` §8.6 and is recorded as such in §17.

**The cost, stated:** more conflicts reach humans than a pure ladder would produce. A team of four
working on the same device will meet this. The mitigation is that it applies only to class A —
roughly 15 % of fields by count and 100 % of the ones that decide whether a tunnel comes up — and
that a `Conflicted` field is a specific, resolvable thing with two named values and two named
authors, not a merge marker in a text file.

### 6.4 The field classes

The class is a property of the field in `schema.yaml` (`11-ir-schema.md` §11.6), generated into the
Rust types, so `FieldClass` on a `SetField` op is checked rather than asserted.

| Class | What is in it | Concurrent divergence resolves to |
|---|---|---|
| **A — security-material** | `dh_group`, `encryption_algorithm`, `authentication_algorithm`, `authentication_method`, `perfect_forward_secrecy`, `lifetime_seconds`, `lifetime_kilobytes`, IKE `version`, `mode`, `local_identity`/`remote_identity`, `PeerSpec`, DPD, traffic selectors, `establish_tunnels`, policy actions, zone `host_inbound_traffic`, `df_bit`, MSS and MTU values | **`Conflicted`.** Never auto-resolved. Blocks emit at L2 (`11-ir-schema.md` §9.1) |
| **N — name** | `name` on any kind | **`Conflicted`**, and both names appended to `Node.aka` (§6.7) |
| **B — descriptive** | `description`, notes, diagram position, colour, per-block depth override | **LWW** by `(hlc, actor)`. The loser is in history and the UI can show it |
| **C — append-only** | Provenance records, captures, AI value records, export log, field history | **Union.** Conflict is not representable |
| **D — structural** | Node and edge existence, containment, tombstones | **Add-wins**, with §6.6's rule |
| **E — set-valued** | `proposals` on an IKE policy, address-set and application-set members, zone interface lists, suppressions | **OR-Set add-wins**, with §6.8's finding |

**Why `description` is class B and `name` is class N.** Losing a description costs a sentence.
Losing a name costs every emitted line for that object, every cross-device reference in a config
Fathom cannot see, and the suppression natural key (`12-rule-engine.md` §11.4). The field card puts
it plainly: Junos builds a VPN from six named objects, each referencing the one before it *by name*.

### 6.5 Worked case 1 — two people set the same DH group

**The situation.** A, at the London office, sets the Phase 1 proposal's `dh-group` to `group14` to
match what the peer's engineer confirmed. B, on a train with no connectivity, sets the same field
to `group19` after reading the field card's note that `group19`/`group20` are the ECP options. B's
laptop clock is 40 seconds ahead. Neither client has seen the other's write.

**Under last-writer-wins:**

```text
set security ike proposal IKE-P1 dh-group group19
```

That line is emitted, pasted, committed. Phase 1 never comes up. `show log kmd | match <peer-ip>`
gives `NO_PROPOSAL_CHOSEN (P1)`, and the field card's error decoder sends the engineer to check
"dh-group, encryption, hash, authentication-method" — a hunt through four parameters for a value
the tool chose on their behalf 40 seconds of clock skew ago. If the mismatch had been on the PFS
group instead, the log would read `INVALID_KE_PAYLOAD`, and the decoder sends you to "P1 dh-group
or PFS keys". In both cases the engineer's first move is to open the config they trusted.

**Under §6.3:**

```text
  ┌ EMIT BLOCKED ─────────────────────────────────────────────────────────
    IKE-P1  dh-group  is conflicted and cannot be emitted

    group14   j.okonkwo   2026-07-28 09:14:02Z   hand
    group19   r.marchetti 2026-07-28 09:14:42Z   hand

    Neither writer had seen the other's value. Both ends must agree
    exactly; there is no negotiating down to a common denominator.
    Pick one.
  ───────────────────────────────────────────────────────────────────────
```

Two values, two authors, two times, and a blocked emit. The engineer resolves it in one click and
the loser stays in history.

**What it costs:** a merge that could have completed silently now requires a human. That is the
trade and it is the right one for exactly this field.

### 6.6 Worked case 2 — one deletes an `IkeGateway` another is referencing

**The situation.** B removes `GW-B` because the peer was decommissioned. Concurrently A binds
`VPN-B` to `GW-B` — `set security ipsec vpn VPN-B ike gateway GW-B` — because A is mid-build on
the same tunnel.

**The naive merge** produces an edge whose target does not exist. That is an **L0 violation**:
`11-ir-schema.md` §9.1 requires every edge's endpoints to exist, and the store refuses to hold an
L0-invalid graph. So "delete wins" is not merely undesirable here, it is unrepresentable.

**What the schema already decided.** `11-ir-schema.md` §10.5: absence is not deletion. A node that
disappears is *tombstoned*, not destroyed, and it is deleted only by a human. So B's action was
already a `Tombstone` op, not a destruction.

**The rule:**

> A `Tombstone` concurrent with any op that references the element resolves to: the element
> **survives**, `absent_since` is set to the tombstone's timestamp, the referencing edge survives,
> and the rule `merge.reference.tombstoned` fires naming both authors and both actions.

The element is excluded from emit while `absent_since` is set, so the tunnel is not silently built
against a gateway somebody deleted — and it is not silently destroyed either.

**Why resurrection rather than deletion.** Asymmetric recoverability. A wrongly-resurrected node is
visible, flagged, excluded from emit and deleted again in one action. A wrongly-destroyed node
takes its provenance, its history, its suppressions and its diagram position with it, and there is
no undo across an encrypted-document save (`11-ir-schema.md` §10.5's own reasoning).

**What would have happened without the rule.** `VPN-B` emits with no `ike gateway` statement, and
the field card is explicit about the outcome: *"Junos enforces these references at commit — a
missing policy name fails the commit."* The engineer would get a commit failure rather than a
broken tunnel, which is the better of the two bad outcomes and still not one the tool should
produce.

**`Purge` is the escape hatch and it is deliberately narrow.** It applies only to an
already-tombstoned element, requires a typed reason, and — the part that matters here — a `Purge`
concurrent with a reference **also** resolves in favour of survival, downgrading itself to a
tombstone and raising `merge.purge.contested`. There is no op in this protocol that destroys data
another client concurrently used.

### 6.7 Worked case 3 — concurrent renames

**Three sub-cases, three different answers.**

| Sub-case | Resolution |
|---|---|
| **Same node, two new names.** A renames `GW-B` → `GW-DC-EAST`; B renames `GW-B` → `GW-SITE-B` | `Conflicted` (class N). Emit blocked, because the name appears in every emitted line for the object and in every line that references it. **Both names appended to `Node.aka`**, so `12-rule-engine.md` §11.4's natural-key rebinding matches either, and no suppression is orphaned by the conflict |
| **Two different nodes, same new name.** A renames `GW-B` → `GW-EAST`; B renames `GW-C` → `GW-EAST`, on the same device | Both renames apply — they are writes to different fields on different nodes, so there is no register conflict at all. What fires is a **uniqueness check**: names must be unique per `(device, kind)`, so `merge.name.collision` raises and **emit is blocked for both**. Junos would reject the commit; the tool must not produce a configuration that cannot commit |
| **Rename concurrent with a value edit on the same node** | No conflict. Different fields. This is the case that must *not* be made harder, because it is the common one |

**The limitation that no merge rule can fix**, and it is `11-ir-schema.md` §10.6's last row: if the
peer device's configuration references `GW-B` by name and that configuration is not in this
workspace, renaming here breaks the far end and **Fathom cannot know.** The tool warns when the
`Tunnel` has a modelled peer, and it cannot warn otherwise. That belongs in the rename affordance's
own copy, not only in a merge document.

### 6.8 Worked case 4 — concurrent set membership, and why add-wins is uncomfortable here

Add-wins is the standard OR-Set choice and it is the wrong *default* to state without qualification
for a security tool: on a security policy's address set, add-wins means **permissive-wins**.

A removes `10.2.0.0/16` from an address set used by a `from-zone TRUST to-zone VPN` policy. B
concurrently adds `10.3.0.0/16` to the same set, having not seen the removal. Add-wins converges to
a set containing both changes — which is correct, and which is also a policy that is broader than
either engineer intended.

> **The rule:** OR-Set semantics for convergence, plus a finding. `merge.set.widened` fires
> whenever a merge results in a set that is a strict superset of what at least one writer last
> observed, on any set inside a `SecurityPolicy`, `AddressSet`, `ApplicationSet` or
> `Zone.host_inbound_traffic`. Severity is a matter for the rule pack; the point is that it exists
> and that it is not silent.

Compare the case where nothing is needed: A suppresses `ipsec.pfs.absent` with a reason while B
actually configures `perfect-forward-secrecy keys group14`. Both apply — a suppression add and a
field write. The suppression's `match_count` then goes to zero and `12-rule-engine.md` §11.5's
orphan sweep lists it. **No new machinery, and the right outcome.** Not every concurrent edit needs
a rule, and inventing one for this case would be exactly the "flag everything" failure that brief
§5.2 warns gets a tool muted within a week.

### 6.9 Worked case 5 — `Absent` concurrent with `Set`

A asserts, explicitly, "there is no PFS on this policy" — `Presence::Absent`, which
`11-ir-schema.md` §8.5 permits only from a closed-world parse or an explicit human assertion. B
concurrently sets `perfect-forward-secrecy keys group14`.

This is class A, so it is `Conflicted`, and the reason it *must* be is precise: `ipsec.pfs.absent`
fires on `Presence::Absent` and only on `Presence::Absent`. Silently picking `Absent` invents a
high-severity finding against a policy that has PFS. Silently picking `Set` hides a real one.
`11-ir-schema.md` §8.5 is explicit that this is the rule that makes `ipsec.pfs.absent`
trustworthy — *"`Absent` only exists where somebody actually looked"* — and a merge that
manufactures or destroys an `Absent` breaks that guarantee at its root.

### 6.10 The summary table

| Concurrent situation | Outcome | Human involved? | Blocks emit? |
|---|---|---|---|
| Class A, two different values | `Conflicted` | **yes** | yes |
| Class A, same value from two sources | `Resolved`, both provenances kept | no | no |
| Class A, `Hand` vs `Parsed`, different | `Resolved(Hand)` + `Divergent` + finding | reviews the finding | no |
| Class A, `Absent` vs `Set` | `Conflicted` | **yes** | yes |
| Class N, same node | `Conflicted` + both in `aka` | **yes** | yes |
| Class N, two nodes to one name | Both apply + `merge.name.collision` | **yes** | yes, both nodes |
| Class B | LWW, loser in history | no; margin tab only | no |
| Class C | Union | no | no |
| Class D, tombstone vs reference | Element survives, tombstoned, finding | reviews the finding | yes, for that element |
| Class D, purge vs reference | Downgraded to tombstone, finding | **yes** | yes |
| Class E, general | Add-wins | no | no |
| Class E, inside a security policy, widened | Add-wins + `merge.set.widened` | reviews the finding | no |

---

## 7. Where the UI must stop and ask

### 7.1 A conflict has teeth because it is already an emit blocker

`11-ir-schema.md` §9.1 defines L2 — Emittable — as requiring, among other things, that **no field
is `Conflicted`**. So "surface it to a human" is not a UI convention that a redesign can weaken. A
conflicted field produces a `Blocker` from the emit path in the WASM core, and the emit path is the
only way configuration leaves the product.

That is the enforcement. Everything below is presentation.

### 7.2 The presentation, in the field card's grammar

Merge conflicts render in **neutrals only**. The three semantic colours mean `ReadOnly`,
`ChangesConfig` and `Disruptive` and nothing else (conventions, *The risk enum*; design language).
A conflict is not a risk level and must not borrow the palette.

| Field card device | Use for conflicts |
|---|---|
| Two-column table, horizontal hairlines only, no vertical rules | Left: the value. Right: who, when, and what origin. This is the `ERROR DECODER` layout applied to a merge |
| The margin tab — lowercase, unpunctuated, muted `#5C6772` | `conflicted · 2 values`, `divergent from box`, `renamed twice`, `set widened` |
| The one-line imperative in caps | `A MERGED VALUE NOBODY CHOSE IS THE ONE THAT REACHES THE BOX` |
| The 4px left accent bar | **Not used.** It carries a wash from the risk palette and this is not a risk |
| Numbered plumbing (`#1 the tunnel interface`) | The resolution list: conflicts numbered in emit order, so resolving them top to bottom walks the object chain the way the card does |

No modal. No badge. No toast. A dismissible notification for a merge conflict is a merge conflict
that gets dismissed.

### 7.3 What is surfaced without stopping anything

| Event | Surface |
|---|---|
| Class B LWW resolution | Margin tab on the field: `2 values · showing newest`. Hover shows both |
| A finding raised by a merge rule | The findings panel, like any other finding, with `merge.*` rule ids so they can be filtered and so a rule pack can set their severity |
| A backlog applied on reconnect | One line: `applied 27 412 operations from 3 clients · 6 conflicts · 41 findings changed` |
| Compaction | One line, before it happens, naming the record count and the byte cost (§9.5) |

### 7.4 The one thing the UI must never do

**Never offer "resolve all conflicts automatically".** It will be requested, it is one line of
code, and it converts every guarantee in §6 into a button. If a bulk action is unavoidable for
class B, it must be scoped to class B by construction and must not be reachable from a screen
showing class A conflicts.

---

## 8. Offline-first

### 8.1 The scenarios, and which one is actually hard

| Offline for | Ops accumulated (one active engineer) | Frames | Bytes | The hard part |
|---|---|---|---|---|
| 1 hour | ~40 | ~2 | ~4 KB | nothing |
| 1 day | ~200 | ~8 | ~20 KB | nothing |
| 30 days | ~4 300 | ~150 | ~420 KB | a handful of conflicts |
| 6 months | ~27 000 | ~900 | ~2.6 MB | **the review burden, not the compute** |
| 18 months, across a schema major | ~80 000 | ~2 700 | ~7.8 MB | **the schema major.** §8.5 |

Assumes ~200 field assertions per working day, ~30 ops per frame, ~96 bytes per sealed op.

The compute is not the problem: applying 80 000 ops at `O(n)` is milliseconds of work in Rust.
<!-- VERIFY: measure op-apply throughput in the WASM build. The claim that a 6-month backlog is
     imperceptible depends on it and has not been measured. -->

### 8.2 What the client does while offline

Everything. This is not a degraded mode:

- Edits apply locally and immediately; there is no server round trip in any write path.
- Ops accumulate in frames and are written to the local workspace exactly as they would be if
  online. **The on-disk format is identical online and offline** (`17-workspace-format.md`),
  which is what makes "offline" a connectivity state rather than a mode.
- Findings, emit, verify ladders, rollbacks, the finder and the diagram all work, because none of
  them touches the server (brief §6.1's on-ramp argument, and `24-ai-determinism-and-offline.md`
  §6.2's "no model" column, which is also the "no server" column).
- `generation` does not advance. It is a server-side concept.

### 8.3 Reconnection

```text
 1. GET /v1/w/{wid}/index                       → root, 32 B, plus 32 KiB of buckets
 2. verify `attest` against the member list;
    reject if `generation` < highest seen       ← replay defence, 31 §5.2 row 5
 3. if root == local root: done                 ← 1 round trip, ~32 KiB
 4. diff the 1 024 bucket digests               ← O(1024) locally, no I/O
 5. for each differing bucket:
      GET /v1/w/{wid}/index?bucket=…            → entries
      compare (frames, set_digest) per record
 6. POST frames we have and it does not         ← chunked at 256 frames / 16 MiB
    GET  frames it has and we do not            ← chunked at 512 digests
 7. apply, resolve, surface
```

| Cost | Value |
|---|---|
| Round trips when nothing changed | **1** |
| Bytes when nothing changed | ~32 KiB |
| Round trips when *k* buckets differ | 1 + *k* + ceil(bytes / chunk) |
| Bytes for the index descent at 5 000 devices | 32 KiB + *k* × (bucket entries × 60 B) |
| Local work | `O(1024)` digest compares, then `O(records in differing buckets)` |

**Why a Merkle bucket descent and not a full manifest exchange.** At 5 000 devices the manifest
holds ~21 000 record entries at ~60 bytes each — 1.2 MB, fetched on every poll. The descent
replaces that with 32 KiB fixed plus only the buckets that moved. At a 15-second poll interval the
difference is 1.2 MB versus 32 KiB every fifteen seconds per client, which is the difference
between a protocol and a bandwidth problem.

`set_digest` is BLAKE3 over the sorted frame digests — order-independent, `O(f log f)` to compute,
recomputed only when a record changes. <!-- VERIFY: an incremental multiset hash such as LtHash
would make it `O(1)` per frame added rather than `O(f log f)` per change. Worth measuring at
5 000 devices before adding a homomorphic-hash dependency for a cost that may not matter. -->

Beelay solves the same reconciliation with rateless invertible Bloom lookup tables, which are
strictly better when the difference is small and the sets are large. This design does not use them
because the bucket descent is `O(1)` round trips in the common case and RIBLT's advantage appears
in the regime where you cannot afford a 32 KiB fixed cost. If polling frequency ever makes 32 KiB
expensive, RIBLT is the upgrade path.

### 8.4 The backlog problem is a review problem

27 000 operations produce, at a plausible rate, a few dozen class A conflicts. Twelve is
reviewable. Two hundred is not, and a screen with two hundred conflicts on it produces the same
outcome as no screen at all.

| Mitigation | Effect |
|---|---|
| Group by device, then by object chain position | Six IKE-proposal conflicts on one gateway read as one problem, because they are |
| Class B never appears in the blocking list | Roughly 60 % of conflicts by count vanish from the review, resolved by LWW with a margin tab |
| Order by emit order | Resolving top to bottom walks the field card's object chain: proposal → policy → gateway → proposal → policy → VPN. The engineer is already thinking in that order |
| "Accept all mine" / "accept all theirs" **scoped to one device** | Bounded blast radius, and the scope is the unit a person reasons about. Never workspace-wide (§7.4) |
| A conflict review export | The same artifact shape as the suppression review pack, so a merge after a long absence can be reviewed by someone other than the person who did it |

### 8.5 The genuinely hard case: reconnecting across a schema major

An offline client on schema 3.2 produces ops for eighteen months. The team moves to schema 4.0.
Ops reference fields that no longer exist, or exist with a different type
(`11-ir-schema.md` §11.3: a field removed, renamed or retyped is a **major**).

Every frame carries `schema_version` (§5.2) precisely so this is answerable rather than a
corruption:

| Relationship | Behaviour |
|---|---|
| Op's minor < current minor | Applies directly. Minor changes are additive by `11-ir-schema.md` §11.3 |
| Op's minor > current minor | Preserve mode (`11-ir-schema.md` §11.4). The op applies to fields this build understands; unknown fields round-trip in `RawMap` and are not resolved by a build that cannot see them |
| Op's **major** < current major | **Quarantined**, then migrated. The op is passed through the same chained, total, deterministic migration functions the workspace uses (`11-ir-schema.md` §11.5), producing an op at the current major with `Origin::Migrated` and the prior record nested. Ops that cannot be migrated to a live field become a `Note` and a finding — never an error, never a guess |
| Op's major > current major | **Refused, and the client says which build can read them.** A build that does not understand a major must not apply ops written under it |

**The cost, and it is severe and specific.** Migrating ops is not the same code path as migrating
a workspace, and it needs the same golden-fixture discipline: a checked-in op log per historical
schema version, migrated and applied, whose resulting state must match the migrated workspace
state byte for byte. That is real work for a case that arises rarely — and it arises exactly in
the air-gapped and defence deployments the product exists for (`11-ir-schema.md` §11.4's own
statement of the cost).

### 8.6 Clock skew, stated separately because it will be assumed away

A hybrid logical clock keeps `wall_ms` close to real time **for participants that exchange
messages.** Two clients that have exchanged nothing for six months have no bound on their relative
skew, and one of them may have had its clock set backwards.

| Consequence | Handling |
|---|---|
| LWW on class B may pick the "older" edit | Accepted. It is class B; the loser is in history |
| `asserted_at` in provenance may be wrong | Displayed as recorded, never corrected. A provenance timestamp is a claim by the client that made it, and rewriting it would be worse |
| Class A resolution | **Unaffected**, by construction: §6.3 removes the timestamp step under concurrency |
| A clock far in the future poisons `hlc.wall_ms` for everyone who merges it | Clamp: an incoming `hlc.wall_ms` more than 24 hours ahead of local time does not advance the local clock, and the frame is marked. Convergence is unaffected — `hlc` is a tiebreak, not a truth |

---

## 9. Compaction

### 9.1 The central difficulty, stated precisely

A CRDT's op log grows monotonically with edits. Every production CRDT system controls that growth
by periodically replacing a prefix of the log with a snapshot of the state it produced — and in
every one of them, the server does it, because the server can read the document.

Ours cannot. Concretely, the following are all impossible server-side and each is a service that
normally exists:

| Impossible | Consequence |
|---|---|
| Replace *k* frames with a state snapshot | The log only grows |
| Drop a tombstone that everyone has seen | Tombstones are forever |
| Deduplicate two writes of the same value to the same field | Every re-parse re-writes every field |
| Drop ops for elements that were purged | Purged elements' history persists as ops |
| Rebase, re-encode, or re-compress | The wire format is the storage format, permanently |
| Notice that a workspace is 90 % redundant | Only quota notices |

Beelay is the closest published attempt at avoiding this — its sedimentree structure lets the
server compress *runs of commits structurally*, without reading them, by treating the commit DAG
as data and the payloads as opaque. That is a genuinely clever move and it bounds a different
thing: it reduces the number of objects, not the redundancy of their contents. A thousand writes
to one field remain a thousand writes. **Structural compaction without keys is possible; semantic
compaction without keys is not**, and semantic redundancy is where the bytes are.

### 9.2 Growth if a client never compacts

| Event | Ops | Sealed bytes | State it produces |
|---|---|---|---|
| Create a device by walkthrough | ~120 | ~14 KB | ~12 KB |
| Parse a mid-size firewall | ~7 700 | ~840 KB | ~500 KB |
| Re-parse the same device, no changes | ~7 700 | ~840 KB | **~0 KB of new state** |
| One field edit | 2 (`SetField` + `ProvRecord`) | ~350 B | ~90 B |

The third row is the whole problem. A re-parse asserts every field again with fresh provenance —
it must, because provenance is per-value and a fresh observation is a fresh fact
(`11-ir-schema.md` §8.1) — and produces 840 KB of ops for a device whose state did not change.

| Scenario | Op-log bytes | Compacted state | Amplification |
|---|---|---|---|
| One device, parsed once | 840 KB | 500 KB | 1.7× |
| One device, re-parsed monthly for 12 months | 10.1 MB | 500 KB | **20×** |
| 500 devices, 30 % parsed, re-parsed quarterly, 2 years | ~1.0 GB | ~80 MB | **12.6×** |
| 500 devices, edits only, no re-parses, 2 years, 4 people | ~36 MB | ~80 MB | 0.45× |

**The rule that falls out:** op-log bytes grow with *edits*; state bytes grow with the *estate*.
Only compaction connects the two, and re-parsing is the operation that decouples them fastest.
A workspace whose users follow brief §6.3's advice — paste is the primary on-ramp for inventory —
is exactly the workspace that needs compaction most.

### 9.3 Client-driven compaction

```rust
pub struct CompactionClaim {
    pub record: RecordId,
    /// A frame with flags = Baseline. Its body is the resolved state of the
    /// record, including per-field OpIds and every live Conflicted candidate
    /// set. §9.4.
    pub baseline: FrameDigest,
    /// Frames the baseline subsumes. The server may delete these after the
    /// grace period.
    pub subsumes: Vec<FrameDigest>,
    /// The version vector the baseline covers. Absorbed into one entry so
    /// retired actors stop costing bytes (§5.2).
    pub covers: VersionVector,
    pub by: ClientId,
    /// Ed25519 over BLAKE3("fathom/v1/compact" ‖ wid ‖ record ‖ baseline ‖
    ///                     sorted(subsumes)).
    pub sig: [u8; 64],
}
```

The server's part, in full:

1. Verify `by` is a member and `sig` verifies. *(It cannot verify anything else.)*
2. Verify every digest in `subsumes` is a frame it currently holds for that record.
3. Verify `baseline` is a frame it holds.
4. Mark the subsumed frames for deletion after a **grace period, default 7 days**.
5. Advance `generation`.

**The grace period is not optional.** A client that fetched the index before the claim and is
fetching frames after it would otherwise receive `404` mid-sync. Seven days covers a weekend and a
flight; it costs the storage it defers.

**What the server cannot verify, and must not be described as verifying:** that the baseline
actually represents the subsumed frames. A malicious or buggy member can claim a baseline that
discards other people's work, and the server will honour it. The defences are that the claim is
signed and therefore attributable, that clients keep their own frames locally until they have
verified the baseline covers them, and that git (where used) retains everything regardless. **This
is a real hole and it is unavoidable without a key.** It is stated in §13 as a failure mode with
an owner.

### 9.4 Why compaction is safe for a client that was offline

Two properties do all the work, and both were paid for elsewhere:

1. **Ops are state-carrying** (§5.1). A `SetField` carries the whole value, never a delta against
   a previous value. So an op from an offline client applies to a baseline it has never seen: it
   does not need the history the baseline replaced.
2. **The baseline stores per-field `OpId`s and live `Conflicted` candidate sets**, not just
   resolved values. So when the late op turns out to be *concurrent* with the baseline's value for
   a class A field, the result is `Conflicted(baseline_value, late_value)` — exactly as it would
   have been without compaction.

Property 2 is the one a naive implementation gets wrong, because a snapshot naturally stores "the
value" and throws the candidate structure away. §4.6's compaction-equivalence property test exists
specifically to catch that: for any op set and any compaction point, every field must resolve
identically compacted and uncompacted, `Conflicted` states included.

**What is genuinely lost by compaction, and it is not nothing:** the individual `ProvenanceRecord`
lineage beyond `11-ir-schema.md` §8.6's retention set — the most recent 16 entries plus the
earliest per origin — which was already bounded, and which the baseline preserves at exactly that
bound. Compaction does not make history worse than the schema's own retention policy. It makes it
*exactly* that, immediately, rather than eventually.

### 9.5 Triggers, and who pays

```text
compact record R when
      frame_bytes(R) > max(2 × baseline_bytes(R), 256 KiB)
   or frames(R)      > 512
   or an explicit `fathom compact` names it
```

| Property | Value |
|---|---|
| Where it runs | Client, foreground, on save, chunked and cancellable |
| Cost | Re-seal the record's state: one AEAD seal over ~200 KB, plus the upload |
| Who pays | Whoever saves next after the trigger fires. That is arbitrary and mildly unfair, and the alternative — a designated compactor — is a coordinator, which this design does not have |
| What the user sees | One line before it happens: `compacting 12 records · 2.4 MB will be rewritten`. Not a spinner, not a modal |
| In git | **A cost, not a saving.** `17-workspace-format.md` §13.6: the compacted record is a new whole blob and every pre-compaction blob stays in history forever |

The git interaction is the reason compaction policy is per-transport rather than global, and it is
the single most counter-intuitive consequence in either document.

---

## 10. Rate limiting, quota, abuse and denial of service

### 10.1 What the server can meter

Everything it can count, which is everything except meaning: bytes, frames, records, workspaces,
members, requests, connections, and their rates. That turns out to be enough for availability and
not enough for anything else.

### 10.2 The limits

| Limit | Default | Why this number |
|---|---|---|
| Frame size | 1 MiB | A baseline for a fully-parsed device is ~500 KB (`17-workspace-format.md` §13.1); 1 MiB is that with headroom and no more |
| Frames per upload | 256 | Bounds per-request digest work at ~256 MiB worst case, and one Ed25519 verify covers the batch |
| Upload body | 16 MiB | 256 × 64 KiB typical |
| Digest list on `GET /frames` | 512 | Prevents a single request asking for 10 GB |
| Records per workspace | 65 536 | 5 000 devices × 4 records, with slack. Above this the document model has already stopped working (`17-workspace-format.md` §13.3) |
| Workspace bytes | 2 GiB soft | An all-parsed 5 000-device workspace is ~2.5 GB — the limit sits deliberately just below the point the model breaks, so it is reached by the wrong shape of use rather than by growth |
| Members per workspace | 32 | A team. Above that, re-keying on a departure (§3.6) is unworkable anyway, so a higher limit would be selling something that does not work |
| Requests | 60/min sustained, burst 300, per session, GCRA | Four clients polling at 15 s is 16/min. The burst covers a reconnection descent |
| Index descents | 20/min per session | The only server-side work that is not `O(1)` per request |
| New workspaces | 8 per account per day | Anti-abuse without obstructing real use |
| Account bytes | Deployment policy | The only limit that actually bounds storage abuse (§10.4) |

Rate limiting is GCRA — a virtual-scheduling leaky bucket that needs one timestamp per key rather
than a window of counters, which matters because the server is holding this state for every session
and must not itself become the memory problem.

### 10.3 What rate limiting must not leak

`RateLimited` and `QuotaExceeded` both return `429` with `Retry-After` and are **indistinguishable
to the caller**. Otherwise the error code is an oracle for another account's storage state on a
shared instance. Similarly, `Retry-After` is quantised to 5-second buckets; a precise value is a
side channel into the server's view of other traffic.

### 10.4 Abuse, stated as an operational fact rather than a feature

> **A Fathom sync server is an authenticated, quota-limited, anonymous encrypted blob store, and
> it cannot be anything else.** It cannot inspect what it holds. It cannot moderate. It cannot
> distinguish a network engineer's workspace from arbitrary data padded to look like one. It
> cannot comply with a content-based takedown by looking.

Three controls exist. There is no fourth, and pretending otherwise would be a lie an operator
discovers at the worst moment.

| Control | What it does |
|---|---|
| **Enrolment gating** | No open sign-up by default. A self-hosted instance issues enrolment tokens or binds accounts to an IdP (§3.3). This is the control that actually matters, because it converts anonymous storage into attributable storage |
| **Per-account quota** | Bounds the damage per account. Content-blind by design, and therefore never circumventable by making the content look innocent |
| **Account termination** | The only response to an external report. It acts on an account, never on content, because content is not inspectable |

For a public instance, the abuse cost has to come from outside the protocol — payment, or an
organisational binding. That is a product decision, not a protocol one, and it belongs in the
operations documentation with this section quoted verbatim.

### 10.5 Denial of service

| Vector | Bound |
|---|---|
| Large uploads | Frame, batch and body caps (§10.2) |
| Expensive reads | Index descent is the only non-`O(1)` path; rate-limited separately at 20/min |
| Storage exhaustion by a stranger | Not possible: writes require membership, membership requires an admin signature |
| **Storage exhaustion by a member** | **Possible, and not solved.** Any writer can consume the whole workspace quota with padded garbage, denying service to colleagues. Per-client sub-quota is the mitigation and it costs a per-client byte counter the server holds in the clear — more metadata, for a threat that is a colleague. §13 records it as accepted |
| Connection exhaustion on the live channel | Max 4 concurrent `events` streams per account; the channel is an optimisation and dropping it degrades to polling |
| Amplification | No endpoint returns more than a bounded multiple of its request size |
| Generation-conflict thrashing | Two clients uploading continuously can 409 each other. Bounded by exponential backoff with jitter, client-side, and by the fact that a 409 costs the server `O(1)` |
| **The operator denying service to their own users** | Unaddressable, by construction. Zero-knowledge protects contents and never availability (`31-threat-model.md` §5.1 row 17) |

---

## 11. Multi-device for one user

### 11.1 The common case must not pay for the general one

One person with a laptop and a desktop is the most common deployment of "sync", and it is far
simpler than a team. If the team design makes it painful, the design is wrong.

**DECISION — two sharing modes, and the simple one has no protocol at all.**

| | **Mode 1 — passphrase-shared** | **Mode 2 — key-wrapped** |
|---|---|---|
| Who holds what | Everyone holds the workspace passphrase | Each member holds an X25519 keypair; WK is wrapped to each |
| Adding a member | Type the passphrase on the new client. **Nothing else happens.** No server call, no approval, no wrap record | An admin wraps WK to the new member's public key (HPKE, RFC 9180) and uploads the wrap |
| Member-list admin key | Derived: `K_admin = HKDF-Expand(WK, "fathom/v1/admin-sign")`. Anyone with the passphrase can sign member changes | Held by admins only |
| Removing someone | Re-key (§3.6) | Remove from the list, and re-key if you want future content closed |
| Right for | **One person, several clients.** Also small trusted teams | Teams where someone must be removable, or where the passphrase must not be shared |
| Default | **Yes** | Opt-in |

Mode 1's whole enrolment flow is: install, open the workspace, type the passphrase. The client
generates its own signing keypair, derives `K_admin`, signs itself into the member list, and syncs.
The multi-user machinery exists only for what mode 1 genuinely cannot do — give someone access
without giving them the passphrase — and it is not on the path of the common case.

### 11.2 The three transports for one user, ranked by how little they require

| | Requires | Conflicts |
|---|---|---|
| **Copy the file** | A USB stick. Nothing else in this document | Whole-file overwrite. The older copy loses. Adequate for one person who is disciplined and terrible for one who is not |
| **Git** | `git clone`, `fathom git install` | Frame union, keyless (`17-workspace-format.md` §12.4). Conflicts surface at open |
| **Sync server** | An account, mode 1 enrolment | Continuous. Sub-second with the live channel, one poll interval without |

All three are supported, and the first is the honest answer for a single user with two machines and
no wish to run anything.

### 11.3 One user is still concurrent editing

A laptop edited on a train and a desktop edited at the office are two concurrent writers, and §6's
rules apply unchanged. Two details make the experience different and both are worth building:

1. **The conflict is between one person's two intents**, which is much easier to resolve than a
   disagreement with a colleague — the reviewer remembers both.
2. **The UI should say so.** `you · laptop` and `you · desktop`, not two pseudonymous actor ids.
   Client names are local labels, stored in the workspace, never sent to the server.

### 11.4 What multi-device does not get for free

| Not free | Detail |
|---|---|
| A second client is a second copy of everything | `31-threat-model.md` §8.1 branch A1.1.3 twice over. The workspace is now on two disks and in two browser profiles |
| A second client is a second entry in M6 | The server learns the client count changed. `31-threat-model.md` §7.2 |
| Losing one client does not revoke it | Mode 1 has no per-client key to remove. A lost laptop means re-keying, or accepting that the workspace is compromised — which for a stolen unlocked machine it is anyway (`31-threat-model.md` §6.3) |

---

## 12. What this protocol adds to the metadata problem

`31-threat-model.md` §7 owns this and is not restated. What follows is only the delta this
protocol's specific choices create.

| Channel | This protocol's contribution |
|---|---|
| M2 size | Padmé at frame granularity rather than whole-workspace, which is *finer* and therefore leakier than padding one blob. Accepted as the price of not re-uploading the workspace on every save |
| M4/M5 change events | One upload per save. `31-threat-model.md` §7.6's fixed-cadence batching, when enabled, applies here as a per-client upload timer |
| **M8 which delta changed** | **This protocol is delta sync, so M8 is live.** `31-threat-model.md` §7.6 defers delta sync until M8's disclosure is designed for rather than inherited. §12.2 is that design |
| M6 client count | The member list is in the clear, by necessity: the server checks signatures against it. So the server knows the *exact* client count and each client's public key, not an estimate |
| M9 header fields | `format_version`, `schema_version`, KDF parameters, and now `record_kind` per record — one more field than the workspace format alone discloses. §12.3 |

### 12.2 M8, designed for rather than inherited

Delta sync means the server sees **which record changed and how often**. Record identity is a keyed
pseudonym (`17-workspace-format.md` §6.3), so the server does not learn *what* a record is — but it
does learn a per-record change time series, which is a fine-grained activity map: which parts of the
estate are being worked on, when, and by which client public key.

| Mitigation | Removes | Costs |
|---|---|---|
| Upload in a randomised order with a random inter-frame delay | Nothing about *which*; blurs *when* within one session | Latency |
| **Batch every save into one upload for all dirty records** | Correlation between one record and one moment. The server sees "these 6 records changed together" instead of six timestamps | Nothing. **This is the default** |
| Fixed-cadence uploads (`31-threat-model.md` §7.6) | M4/M5 entirely, and M8's timing with them | Up to *T* of recovery-point objective; constant background traffic |
| Cover frames — upload padding frames for records that did not change | M8's *which* | Bandwidth and storage proportional to the number of records covered. At 2 100 records this is not affordable, and a partial version is worse than none because the covered set is itself a signal. **Rejected** |
| Whole-blob sync | M8 entirely | The entire design. `17-workspace-format.md` §1 |

**DECISION —** batch-per-save on by default; randomised ordering on by default because it is free;
cover frames rejected; fixed cadence available and off by default, exactly as
`31-threat-model.md` §7.6 has it.

**The honest statement:** M8 is real, it is not fully mitigated, and the customer for whom a
per-record activity map is disqualifying should not sync. That is the same answer §7.7 of the threat
model gives for M1, and it is the same answer for the same reason.

### 12.3 `record_kind` in the clear

`IndexEntry.kind_opaque` (§2.5) tells the server whether a record is a device graph, a provenance
store, a fabric shard, suppressions, settings or an AI store. That is not nothing: it lets the
server distinguish "this account has 500 devices" from "this account has one device and a large AI
cache", and it makes the suppressions record individually identifiable and individually trackable.

It is in the clear because the server enforces per-kind byte caps (`24-ai-determinism-and-offline.md`
§5.4's cache budgets are enforced here) and because clients fetch by kind during a partial open.

**The alternative** is to make the kind opaque and enforce budgets client-side. That is defensible
and it moves a control to the party the control exists to constrain. `VERIFY` this against a real
deployment's needs before shipping: if per-kind server-side caps turn out to be unnecessary, remove
`kind_opaque` and take the disclosure back.

---

## 13. Failure modes

| # | Failure | Symptom | Handling | Residual |
|---|---|---|---|---|
| F1 | Server serves an old `generation` | Client sees a workspace that lost work | Rejected: `attest` is signed by a member, and the client tracks the highest generation it has seen (`31-threat-model.md` §5.2 row 5). Override requires a typed confirmation naming both versions and dates | `material` — a user restoring their own older backup trips the same check, and the override flow is the one an attacker wants them to learn |
| F2 | Server drops frames silently | A record's `set_digest` never matches | Detected on the next descent. The client re-uploads its own frames unconditionally | `bounded` — the server can always deny service |
| F3 | Malicious compaction claim discards a colleague's work | Frames vanish server-side | Signed and attributable. Clients retain their own frames until they verify the baseline covers them. Git retains everything | `material` — §9.3. Unavoidable without a key |
| F4 | Two clients thrash on `GenerationConflict` | Neither makes progress | Exponential backoff with jitter; the loser fetches and retries | `none` |
| F5 | Clock set far in the future poisons `hlc` | Every subsequent op sorts after it | Clamped at 24 h ahead (§8.6); convergence unaffected because `hlc` is a tiebreak | `bounded` — LWW on class B may be wrong for a while |
| F6 | A convergence bug in our CRDT | Two clients permanently disagree, silently | §4.6's property tests. Plus a `fathom fsck --compare` that takes two workspace copies and reports the first field where they differ | `material`, and this is the largest residual in the document. It is the cost named in §4.4 |
| F7 | A member fills the workspace quota | Colleagues cannot save | Per-client sub-quota, at the cost of more metadata. Not implemented by default | `material` — §10.5 |
| F8 | Offline client reconnects across a schema major | Ops reference fields that no longer exist | Quarantine and migrate (§8.5) | `material` — the migration path for ops is separate work with its own fixture discipline |
| F9 | Live channel blocked by a corporate proxy | No push notifications | Degrade to polling, automatically, with no configuration | `none` |
| F10 | Member removed but still holds WK | Believes they are locked out; is not | Re-key (§3.6), and the product must say what removal does and does not do | `material` — inherent to any e2ee system |

Residual tags use the four-value scale `31-threat-model.md` §1.4 defines and §14.3 of that document
proposes pinning in the conventions. This document adopts it.

---

## 14. What this costs

| Cost | Detail |
|---|---|
| **A hand-rolled CRDT** | §4.4. Nobody else has run this code. A convergence bug is a silent data-loss bug, and it is the largest single risk in the design |
| **More conflicts reach humans than a generic design would produce** | §6.3. Deliberate, scoped to class A and class N, and the reason the tool can be trusted with a `dh-group` |
| **Emit is blocked by conflicts** | A merge can leave a workspace unable to emit configuration for a unit until someone chooses. That is the intended behaviour and it will still be experienced as the tool being in the way |
| **Compaction is the client's job and nobody wants to do it** | §9. It runs on whoever saves next, it costs a full record rewrite, and in git it makes the repository permanently larger |
| **The member list is an availability control that reads like an access control** | §3.5. This will be misunderstood by someone in every deployment, and the only defence is saying it in the product |
| **Re-keying is a full rewrite and a full rename** | §3.6. Removing a departed colleague properly is an 80 MB operation at 500 devices, and it still does not un-read what they read |
| **M8 is live** | §12.2. Delta sync buys the entire design and discloses a per-record activity map |
| **Two credentials** | §3.1's separation is right and it means a user has two secrets. Some will use the same string for both, and nothing prevents it |
| **The server cannot help with anything** | No server-side search, no server-side validation, no server-side recovery, no "we can restore your workspace". Every one of those will be asked for |

---

## 15. Open decisions

| # | Decision | Options | Leaning |
|---|---|---|---|
| S-1 | Live channel transport | (a) SSE. (b) WebSocket. (c) Long-poll | (a). One origin, one connection type, works through most proxies, and the payload is 100 bytes |
| S-2 | Per-client sub-quota | (a) Ship it, accept the metadata. (b) Do not, accept F7 | (b) initially; revisit the first time a team hits it |
| S-3 | `kind_opaque` in the index | (a) Keep, for server-side per-kind caps. (b) Remove, enforce client-side | (b) if per-kind server caps prove unnecessary. §12.3 |
| S-4 | Compaction assignment | (a) Whoever saves next. (b) A designated compactor client | (a). (b) requires a coordinator, and we do not have one |
| S-5 | Set reconciliation | (a) Merkle bucket descent. (b) RIBLT, as Beelay uses | (a) until the fixed 32 KiB descent cost is shown to matter |
| S-6 | Should a `Conflicted` field block emit for the whole *device* or only the affected *emit unit* | (a) Emit unit, per `11-ir-schema.md` §9.2. (b) Device | (a). Blocking more than necessary is how an interlock gets disabled |
| S-7 | Do we support an operator-run "recovery mode" that retains deleted frames beyond the grace period for a customer's own compliance | (a) Yes, as an operator setting. (b) No | (a), and it must be visible to clients in `GET /v1/workspaces`, because a retention policy the user cannot see is a retention policy they will assume is absent |

---

## 16. Sources

| Claim | Source |
|---|---|
| OPAQUE: augmented PAKE, server never learns the password including during registration, security against pre-computation on server compromise; published as an informational CFRG product in July 2025 | RFC 9807 |
| HPKE, used to wrap the workspace key to member public keys | RFC 9180 |
| HKDF, used for all subkey derivation | RFC 5869 |
| Argon2id parameters | RFC 9106 §4 |
| Canonical CBOR for every wire body | RFC 8949 |
| Automerge 3.0 (July 2025): same file format as Automerge 2, near-full API compatibility, and a large runtime-memory reduction from using the compressed representation at runtime — the project's own example is 700 MB under Automerge 2 versus 1.3 MB under 3 for the same document | Automerge project announcement, *Automerge 3.0* |
| Loro shallow snapshots: history before a chosen frontier is trimmed; peers can only sync if they hold versions after the shallow start point; export modes are snapshot, update, shallow-snapshot and updates-in-range | Loro documentation, *Shallow Snapshots* and the `ExportMode` API reference |
| Beelay: an experimental Automerge sync protocol that synchronises end-to-end-encrypted payloads a server cannot decrypt; sedimentree structure over the commit DAG; a server-side reachability index maintained as a CRDT over links; RIBLT for set reconciliation; pre-alpha, unstable, unaudited by its own README | `automerge/beelay`, `docs/protocol.md` and README; Ink & Switch, *Keyhive* |
| Partitioning-oracle attacks against non-committing AEADs, motivating the key-commitment tag | Len, Grubbs, Ristenpart, *Partitioning Oracle Attacks*, USENIX Security 2021 |
| Padmé padding bounds and overheads | Nikitin et al., *Reducing Metadata Leakage from Encrypted Files and Communication with PURBs*, PoPETs 2019(4) |
| `Presence`, `Field::Conflicted`, the resolution ladder, provenance, absence-is-not-deletion, L0/L1/L2 validity, schema versioning and migration | `docs/10-core/11-ir-schema.md` §§5, 8.5, 8.6, 9.1, 10.5, 11 |
| `Suppression`, natural-key rebinding, orphan sweep | `docs/10-core/12-rule-engine.md` §11 |
| Frames, records, keyed pseudonymous filenames, the keyless merge driver, size budgets, compaction versus git | `docs/10-core/17-workspace-format.md` |
| Metadata channels M1–M10, the worked inference, Padmé default, batching costs, replay defence, the abuse-case position | `docs/30-security/31-threat-model.md` §§5.2, 7, 9 |
| AI store layout and cache budgets carried inside the workspace | `docs/20-ai/24-ai-determinism-and-offline.md` §5.3, §5.4 |
| `NO_PROPOSAL_CHOSEN (P1)` → dh-group, encryption, hash, authentication-method; `INVALID_KE_PAYLOAD` → DH group mismatch, P1 dh-group or PFS keys; "both ends must agree — every value, exactly"; there is no negotiating down to a common denominator; Junos enforces object references at commit; a VPN is built from six named objects each referencing the previous one by name | Owner's SRX IPsec field card, sides 1, 2 and 3 |

---

## 17. Proposed amendments to other documents

**A1 — `11-ir-schema.md` §8.6, the resolution ladder, needs a concurrency guard.**

*The text:* *"Two `Hand` assertions at different times do resolve by recency, which is
last-writer-wins and is the standard, lossy, understood answer."*

*The objection:* correct for sequential edits, wrong for concurrent ones. Recency is only
meaningful when the later writer saw the earlier value; under concurrency it encodes clock skew
between two laptops that have not spoken in a month. Applied to `dh_group` it produces a
configuration nobody chose, for a parameter the field card says must match the peer exactly.

*Proposed replacement for step 3 of the ladder:*

> 3. Then later `asserted_at` wins — **but only if the two assertions are causally ordered.** If
>    the two assertions are concurrent (neither writer had observed the other's operation) and the
>    field is in class A or class N, the timestamp step is skipped and the field becomes
>    `Field::Conflicted`. Recency resolves a sequence of edits; it does not resolve a disagreement.

This is §6.3, stated as the amendment it is.

**A2 — `31-threat-model.md` §7.6's deferral of delta sync should be closed.**

*The text:* *"delta sync explicitly deferred until M8's disclosure is designed for rather than
inherited."*

*The objection:* this protocol is delta sync. It cannot not be — whole-blob sync at 80 MB per save
is not a protocol. §12.2 is the design M8 was deferred pending, and the deferral should either be
closed by adopting it or the decision to sync at all should be revisited.

**A3 — `31-threat-model.md` §14.3's proposed residual scale should be pinned in the conventions.**

This document uses `none | bounded | material | total` in §13 because there is no alternative and
because a second security document inventing a second scale is exactly the failure the conventions
exist to prevent. That is the second document now using it. Pin it.

---

## 18. Disagreements

**18.1 — The conventions' terminology table needs `client`, and needs to say that `device` is
taken.**

*The convention:* the terminology table pins `workspace`, `graph`, `node`, `edge`, `kind`, `model`,
`rule`, `rule pack`, `finding`, `suppression`, `emitter`, `explainer`, `corpus`, `platform`,
`supervisor`/`subagent` and `provenance`. It does not pin a word for a syncing installation.

*The objection:* the obvious word is "device", and it is already taken — `Device` is a node kind,
and using it for a laptop makes sentences like "the device count for this device" possible.
`31-threat-model.md` §7.2's channel M6 is already called "device count" and means client count,
which is the confusion arriving before the vocabulary did.

*Proposed addition:*

| Term | Means | Never say |
|---|---|---|
| **client** | one syncing installation — a browser profile, a CLI, a desktop app | "device" (a `Device` is a network device node), "endpoint", "instance" |

And a corresponding correction to `31-threat-model.md` §7.2's M6 label.

**18.2 — Invariant 9 needs the word "converged".**

Identical to `17-workspace-format.md` §21.1 and raised there in full. Repeated here only so that a
reader of this document alone sees it: two clients mid-sync hold the same workspace and different
bytes, and the invariant as written can be read to forbid that. The proposed wording is *same
converged workspace state*, with converged defined as holding the same operation set regardless of
layout, compaction state or receipt order.

**18.3 — Invariant 3, as amended by `31-threat-model.md` §14.1, should also name the account
credential.**

*The convention, as `31` proposes amending it:* exactly two secrets exist — the workspace
passphrase and, at tier 1, a provider API key.

*The objection:* this document introduces a third — the account credential for the sync server.
It is a genuinely different kind of secret: it never protects confidentiality, it is transmitted
(as an OPAQUE exchange, never as the password itself), and it may be an enterprise IdP credential
that Fathom never sees at all. But "exactly two" becomes false the moment sync ships, and an
invariant with an unbounded exception list is a preference — `31` §14.1's own words.

*Proposed replacement for the enumeration clause:*

> Exactly three secrets exist in the product. (1) The **workspace passphrase**, which never leaves
> the client and is never transmitted in any form. (2) At tier 1 only, a user-supplied **inference
> provider API key**, transmitted only to the enumerated provider origin the user configured.
> (3) In the sync build only, an **account credential**, which authenticates a client to the sync
> server, is never in the confidentiality path, and may be delegated entirely to an external
> identity provider. No fourth secret may be added without amending this invariant.
