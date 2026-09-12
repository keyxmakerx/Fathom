# Phase 2 — The administrator model and the sealed audit trail

**Status:** Design, 2026-09-12. Written to be built from.
**Answers:** `docs/REBUILD-PLAN.md` Phase 2 "Operational foundations" items 2 and 3, and
`docs/OPEN-QUESTIONS.md` A2 (an audit log ships in the first release, because item 3 depends on it).
**Owns:** the principal model, scope grants, session assurance, the administrative surface, the site
and organisation chains, break-glass.
**Does not own:** the sealed chain construction — `docs/PHASE-2-STORAGE-DESIGN.md` §11.2 and §12 own
it and this document reuses it unchanged, adding only new derivation labels, which must land in that
document's §12.2 table in the same pass. Key custody is ADR-0043's and is not reopened here.

**Reading shorthand:** *storage §N* means `docs/PHASE-2-STORAGE-DESIGN.md` §N. A bare §N is this
document. *Tier 1/2/3* are the three attackers defined in §0.1 and are used in every claim below.

---

## 0. The shape of the answer, in one page

The owner's words: *"an Admin page(s) where they may not have access to certain networks but instead
have access to what users/groups/orgs permissions, smtp setup, but maybe make sure they can't just
reset a users password to themselves to hostile takeover."*

**Two custodies.** *Operators* hold the machine: accounts, authentication, mail, settings, backups,
the audit trail's plumbing. *Stewards* hold the data: who may open which rack. They are different
kinds of principal, and the database's own foreign keys forbid an operator principal from ever
appearing in a membership, a scope grant or a recovery-holder row.

**The server verifies; it never vouches.** Every fact that opens design bytes — this account may read
this scope, this request came from the browser that authenticated, this key belongs to this person —
is a signature over canonical bytes, checked at use, against a public key pinned in an append-only
sealed keyring. The corresponding private keys are hardware authenticators and browser-held session
keys. The server can check them and cannot produce them. Writing the row was never the hard part.

**Administration is deliberately sightless**, and that is what makes the rest cheap. An operator's
database role has no `SELECT` privilege on design payload; an operator transaction never opens a
tenant context; and a third, independent fence — a transaction-local `app.design_capability` setting
that is hard-wired to `no` on the operator path — sits inside the row-level-security policy on the
payload table itself. Because administration is worthless as a target, recovering an organisation
whose stewards have gone can be made survivable without creating a new way in.

**Stopping the log stops the act.** No administrative change takes effect while its `sealed_seq` is
`NULL`, and nothing on the operator surface can stamp it. An operator who silences the audit trail
to work unobserved finds the work does not apply either. That converts the trail from after-the-fact
evidence into a gate.

**Five fences.** Every claim below names which ones it stands on, and against which attacker.

| Fence | What it is | Binds against |
|---|---|---|
| **Grant** | a PostgreSQL table privilege the role does not hold. Privileges are checked before row security, so a withheld `GRANT` is stronger than any policy | tiers 1–2 |
| **Constraint** | foreign key, `CHECK`, or `SECURITY DEFINER` trigger. Binds at every privilege level including superuser — but the schema owner can `DROP` it, which is detected, not prevented | tiers 1–2 |
| **Seal** | HMAC-SHA-256 under a key from ADR-0043's provider interface, never in PostgreSQL | tier 2 |
| **Signature** | verified at use; the private half never reaches the server | tier 3, prospectively |
| **Witness** | a countersignature from a key held off the box | tier 3, for everything already received |

Anything resting on one fence is a weakness; §12 lists the places where that is still true.

### 0.1 The three attackers, named separately

Earlier drafts of this model said "the administrator" and then quietly mixed three capabilities. The
routes below only make sense tier by tier.

- **Tier 1 — the admin surface.** Someone signed in to `/admin`. No database credential, no shell.
- **Tier 2 — the database.** Tier 1 plus any of the PostgreSQL credentials: the app role, the admin
  role, the schema owner.
- **Tier 3 — the host.** Tier 2 plus files as the `fathom` user: `master.key`, `chain_master`, the
  served client bundle, the clock, the process.

**In a Docker deployment, whoever writes `compose.yaml` has the Docker socket and is therefore tier
3.** A previous draft listed "the compose file" as a tier-1 capability and then claimed controls that
only hold at tier 2; that is corrected here. The consequence is load-bearing and is acted on in §1.4:
**the application's own database password must never appear in the compose file or the environment.**
It is generated at first start into the master-key volume, so that "the admin role cannot read design
payload" is a statement about an attacker who has the admin credential, rather than about an
attacker who has whichever credential the operator typed.

Tier 3 defeats confidentiality of designs at rest and always will — the server decrypts designs to
serve them (`PHASE-2-STORAGE-DESIGN.md` §2a, ADR-0043 §5). What this design defends at tier 3 is
narrower and is stated as such in §12: an attacker who takes the host cannot mint steward authority
in an existing organisation without catching a real steward at a real hardware touch, cannot rewrite
what a witness already holds, and cannot open a vault.

---

## 1. What an administrator can do

An **operator** is a principal of kind `operator`. The `/admin` surface runs on its own connection
pool as the `fathom_admin` role and serves nothing else.

### 1.1 The verbs

| Verb | Gate | Sealed entry |
|---|---|---|
| List organisations, their scope tree shape, members, grants and capability map | operator session | `operator_read` (sampled: one entry per session per surface) |
| Create an account shell (email, display name) | operator session, rate-limited | `account_created` |
| Send a password-reset link to an account's **address of record** | operator session, rate-limited | `reset_link_sent` |
| Disable / re-enable an account | rate-limited; notifies every steward of every scope the account holds; a steward of the organisation may re-enable | `account_disabled` / `account_enabled` |
| **Suspend** a scope grant (immediate) | operator session; any steward of that organisation may lift it; if no steward is live, the recovery key lifts it | `grant_suspended` / `grant_unsuspended` |
| Initiate an authenticator-enrolment token | operator may issue; only a steward co-signature or an existing factor redeems it (§4.4) | `enrolment_token_issued` |
| Change SMTP, shipper, cadence, quorum, retention | two operator assertions + delay + witness receipt (§5.3) | `setting_*` |
| Request a contact-address change on someone else's account | two operator assertions + 72h + notice to the old address (§5.2) | `contact_change_*` |
| Create an organisation shell and issue its enrolment claim | operator session; the claim is bound to an install-time notice address (§6.2) | `org_shell_created` |
| Take a backup; perform a restore; apply a migration; `rewrap` / `rotate` | operator session; a restore is quarantined until acknowledged (§7.6) | `backup_taken`, `restore_performed`, `migration_applied`, `rewrap`, `rotate_*` |
| Run chain verification and export the audit trail | operator session | `verification_run` |

**Granting is not on that list, and neither is reading a design.** This is the narrowing of the
owner's sentence, and it is deliberate: *"access to what users/groups/orgs permissions"* is read here
as **seeing and revoking the permission map, not writing it**. The alternative — let administrators
grant — is exactly the thing the same sentence asks to prevent, because a grant to a sockpuppet
account is a takeover with an extra step. **This is a judgement call and the owner may overrule it**;
the cost of overruling is that an administrator can read every design in the estate, and the rest of
this document then has nothing to stand on.

### 1.2 Sightless, and what that costs support

Once `OPEN-QUESTIONS.md` V2 lands and scope and design names are encrypted under the tenant
hierarchy, the admin surface shows **organisation display names in the clear and everything below
them as opaque ids and shape**. Organisation names stay readable because support and billing need to
know which customer they are looking at; scope and design names do not.

The cost is real: an operator helping with "the Manchester rack is missing" sees `01J8…` and a tree
silhouette. The compensation is that the customer's own steward can read the id off their screen.
Say this in the operator's register rather than discovering it in a support call.

### 1.3 Two database roles, and the admin one cannot reach a design

```sql
-- fathom_app: the product.
GRANT SELECT, INSERT, UPDATE, DELETE ON designs, design_versions, design_payload, scopes,
    memberships, scope_grants, grant_revocations, organisation_auth_head, account_keys,
    sessions, change_requests, site_settings_versions, operators TO fathom_app;
GRANT SELECT, INSERT ON chain_entries, chain_receipts, chain_anchors, audit_spool TO fathom_app;

-- fathom_admin: the admin pages. READ ONLY, and note what is absent.
GRANT SELECT ON organisations, scopes, memberships, accounts, operators, scope_grants,
    grant_revocations, change_requests, site_settings_versions, chain_entries,
    chain_receipts TO fathom_admin;
REVOKE ALL ON designs, design_versions, design_payload, vault_entries, account_keys,
    tenant_keys, sessions, audit_spool FROM fathom_admin;
-- No INSERT, UPDATE or DELETE on anything, for any table, ever.
```

**The admin pool is read-only.** Every administrative *write* goes through an application endpoint
on the `fathom_app` role, which writes the row and its chain entry in one transaction. An earlier
draft granted `INSERT ON operators, change_requests, site_settings_versions` to `fathom_admin`, and
that single line handed a tier-2 attacker every two-operator control in the document: connect with
the admin credential, `INSERT` a sibling settings row with a second operator's id and a back-dated
`effective_at`, and the newest-effective-row resolver picks it. Withholding the privilege closes it
at the privilege layer, which is checked before row security and therefore before any policy
expression anyone could get wrong.

Neither role is a superuser. REBUILD-PLAN item 4 already requires that; it is now load-bearing three
times over.

Two tests make this a claim rather than a hope, and they belong in the same commit as the migration:

```rust
#[tokio::test]
async fn admin_role_cannot_read_design_payload() {
    let c = admin_pool().get().await.unwrap();
    let e = c.query("SELECT ciphertext FROM design_payload LIMIT 1", &[]).await.unwrap_err();
    assert_eq!(e.code(), Some(&SqlState::INSUFFICIENT_PRIVILEGE));
}

#[tokio::test]
async fn admin_role_cannot_write_anything() {
    for stmt in EVERY_TABLE_INSERT_PROBE {           // one probe per table in the schema
        let e = admin_pool().get().await.unwrap().execute(stmt, &[]).await.unwrap_err();
        assert_eq!(e.code(), Some(&SqlState::INSUFFICIENT_PRIVILEGE), "{stmt}");
    }
}
```

The second is a loop over the *schema*, not over a list someone maintains by hand, so a table added
next year is covered the day it is added.

### 1.4 The credential that must not be in the compose file

At first start, if `/var/lib/fathom/keys/db_app.pw` does not exist, the server generates a random
password, writes it 0400 in the master-key volume beside `master.key`, and `ALTER ROLE fathom_app
PASSWORD` it. The compose file carries the *admin* credential and the bootstrap credential only. The
operator's register gains one line: *"the application's own database password is generated at first
start into the key volume; if you copy that volume off the machine, you have copied it too."*

Without this, "the admin role cannot read designs" is a claim about a role the attacker does not
have to use. With it, reaching design payload through SQL requires reading the key volume — which is
tier 3, and tier 3 already has the master key. The fence stops being decorative.

---

## 2. What an administrator provably cannot do

Each row names the fences and the highest tier it holds against.

| Cannot | How | Fences | Holds to |
|---|---|---|---|
| Appear in a membership, a scope grant, or a recovery-holder row | composite FK to `principals (id, kind)` with a generated `kind` column on the referencing table | Constraint | tier 2 |
| Produce a grant signature | grants are WebAuthn assertions over `grant_bytes` from a registered hardware authenticator (§3.3) | Signature | tier 3 |
| Read design payload in an operator session | no `GRANT`; no tenant context; `app.design_capability` is `no` | Grant, Constraint | tier 2 |
| Read design payload by taking over an account | a password reset yields an `A0` session, and design reads need a **per-request signature** by a key the browser holds (§4) | Signature | tier 3 |
| Mint a second genesis for an existing organisation | the organisation id is derived from the organisation root public key and recomputed at every authorisation (§6.1) | Signature | tier 3 |
| Resurrect a revoked grant by clearing a column | "live" is a positive, sealed statement in `organisation_auth_head`, not the absence of a value (§3.4) | Seal | tier 2 |
| Have a settings change, a contact change or an enrolment take effect unlogged | the execution interlock: `sealed_seq IS NULL` means not effective, and the operator surface cannot stamp it (§5.4) | Grant, Seal | tier 2 |
| Make a stopped audit trail look like a quiet afternoon | sealed heartbeats at a known cadence, countersigned by a witness key not on the box (§7.5) | Witness | tier 3 |
| Rewrite what the witness already holds | the receipt chain; the server stores receipts it cannot produce | Witness | tier 3 |
| Open a credential vault | ADR-0043, unchanged | Signature | tier 3 until the next unlock under a substituted bundle |

Two honest corrections to phrasing that has appeared in earlier drafts:

- **"Constraints bind even for a superuser"** is true of *bypass* — PostgreSQL exempts superusers
  from row security but not from referential integrity or `CHECK`. It is false of `DROP CONSTRAINT`.
  A tier-3 attacker drops the constraint; the schema fingerprint in §7.2 detects it. Detection, not
  prevention, and the table above says tier 2 for that reason.
- **PostgreSQL's privilege-before-policy ordering and the trigger-invoker rule** in this section are
  behaviour claims, and under CLAUDE.md rule 1 they are not asserted from memory. Each is written as
  a test that must pass in the commit that introduces it (§14 lists them). A trigger function that
  reads a row-level-security-protected table must be `SECURITY DEFINER` with a pinned `search_path`,
  or it runs as the invoker, sees nothing, and passes vacuously — that trap is named here because a
  reviewed design in this project's history got it backwards.

---

## 3. Grants: the thing an administrator cannot forge

> **CORRECTED 2026-09-12 — §3.3 had two errors, see §15.**
>
> **`second_bytes` must not bind `H(granter_sig)`.** ECDSA signatures are malleable two ways at once
> — the `(r, s)`/`(r, −s)` pair, and non-canonical DER encodings of the same values — so one
> authority can produce several byte-distinct `granter_sig` values over one `grant_bytes`, each
> yielding a different `second_bytes`. A seconding signature would be bound to an encoding rather
> than to a fact. **Bind `LP(H(grant_bytes)) ‖ LP(granter_key_fpr)` instead** and drop
> `H(granter_sig)`. Costs nothing; the granter is already pinned by fingerprint.
>
> **The verification-step list is incomplete.** It omits `rpIdHash`, the **UP** bit (mandatory,
> unlike UV), `C.type`, and that the signature is over the binary concatenation
> `authData ‖ SHA-256(clientDataJSON)`. It also says "checks the origin" — **that must not be a
> suffix match**; shipping one is exactly the `webauthn-rs` bug in §15.5. The challenge comparison is
> against the **base64url** form of the issued challenge, not the raw digest.

### 3.1 Capabilities, not a role

`memberships.role` stays as the organisation-level distinction it already is. It no longer decides
who sees a design. Design visibility comes from `scope_grants`:

| Capability | Means |
|---|---|
| `read` | open designs at or below this scope |
| `draw` | edit them |
| `steward` | grant, second, suspend and revoke within this subtree; move scopes; move devices between scopes |

Stewardship is the only grant-granting power in the product and it lives *inside* the scope. There
is no path from any operator verb to it.

### 3.2 The tables

```sql
-- 0005_authority.sql

-- The root of authority for one organisation. Its private half is Shamir-split
-- at creation and never reassembled on the server (§8 break-glass).
CREATE TABLE organisation_roots (
    organisation_id text PRIMARY KEY REFERENCES organisations(id) ON DELETE CASCADE,
    root_pubkey     bytea NOT NULL,
    root_alg        smallint NOT NULL,        -- COSE algorithm id
    id_salt         bytea NOT NULL CHECK (octet_length(id_salt) = 16),
    created_seq     bigint NOT NULL,
    row_seal        bytea NOT NULL
);

-- Append-only, sealed keyring. One row per registered authenticator or
-- successor key. Never updated in place except to record supersession.
CREATE TABLE account_keys (
    id              text PRIMARY KEY CHECK (char_length(id) = 26),
    account_id      text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    credential_id   bytea NOT NULL UNIQUE,
    public_key      bytea NOT NULL,           -- COSE_Key
    alg             smallint NOT NULL,
    aaguid          bytea,
    fpr             bytea NOT NULL UNIQUE,    -- H("fathom/key/fpr/v1" || LP(public_key))
    enrolled_seq    bigint NOT NULL,
    enrolled_at     timestamptz NOT NULL,
    superseded_by   text REFERENCES account_keys(id),
    succession_sig  bytea,                    -- old key signs the new one (§8.4)
    retired_at      timestamptz,
    row_seal        bytea NOT NULL
);

CREATE TABLE scope_grants (
    id                text PRIMARY KEY CHECK (char_length(id) = 26),
    organisation_id   text NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    scope_id          text NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
    subject_id        text NOT NULL,
    subject_kind      text NOT NULL GENERATED ALWAYS AS ('account') STORED,
    subject_key_fpr   bytea NOT NULL,          -- pins WHICH key this grant is for
    capability        text NOT NULL CHECK (capability IN ('read','draw','steward')),

    granter_kind      text NOT NULL CHECK (granter_kind IN ('account','org_root')),
    granted_by        text,                    -- NULL exactly when granter_kind='org_root'
    granter_principal_kind text GENERATED ALWAYS AS
        (CASE WHEN granted_by IS NULL THEN NULL ELSE 'account' END) STORED,
    granter_key_fpr   bytea NOT NULL,          -- the key that must verify granter_sig
    granter_sig       bytea NOT NULL,          -- WebAuthn assertion, or org-root signature

    seconded_by       text,
    seconder_kind     text GENERATED ALWAYS AS
        (CASE WHEN seconded_by IS NULL THEN NULL ELSE 'account' END) STORED,
    seconder_key_fpr  bytea,
    seconder_sig      bytea,

    is_genesis        boolean NOT NULL DEFAULT false,
    is_recovery       boolean NOT NULL DEFAULT false,
    auth_epoch        integer NOT NULL,
    effective_from    timestamptz NOT NULL,
    expires_at        timestamptz,             -- NOT NULL for steward and recovery grants
    suspended_at      timestamptz,
    suspended_by      text REFERENCES operators(id),
    chain_seq         bigint NOT NULL,
    row_version       integer NOT NULL DEFAULT 1,
    row_seal          bytea NOT NULL,

    FOREIGN KEY (subject_id,  subject_kind)           REFERENCES principals (id, kind),
    FOREIGN KEY (granted_by,  granter_principal_kind) REFERENCES principals (id, kind),
    FOREIGN KEY (seconded_by, seconder_kind)          REFERENCES principals (id, kind),

    -- Genesis and recovery grants are signed by the organisation root key, which is
    -- not a principal, so the self-grant question does not arise for them.
    CHECK (granter_kind = 'org_root' OR subject_id <> granted_by),
    CHECK ((granter_kind = 'org_root') = (granted_by IS NULL)),
    CHECK (seconded_by IS NULL OR (seconded_by <> granted_by AND seconded_by <> subject_id)),
    CHECK (capability <> 'steward' OR expires_at IS NOT NULL),
    CHECK (NOT is_recovery OR (capability = 'steward' AND expires_at IS NOT NULL))
);

-- Revocation is a positive, append-only fact. There is no nullable column
-- whose absence means "live".
CREATE TABLE grant_revocations (
    grant_id        text PRIMARY KEY REFERENCES scope_grants(id),
    organisation_id text NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    revoked_at      timestamptz NOT NULL,
    revoked_by      text NOT NULL,
    revoked_sig     bytea NOT NULL,
    chain_seq       bigint NOT NULL,
    row_seal        bytea NOT NULL
);

-- The sealed statement of what is live. One row per organisation.
CREATE TABLE organisation_auth_head (
    organisation_id text PRIMARY KEY REFERENCES organisations(id) ON DELETE CASCADE,
    auth_epoch      integer NOT NULL,
    chain_seq       bigint NOT NULL,
    live_count      integer NOT NULL,
    live_digest     bytea NOT NULL,
    head_seal       bytea NOT NULL
);

CREATE UNIQUE INDEX scope_grants_genesis_pair
    ON scope_grants (organisation_id, subject_id) WHERE is_genesis;

-- Genesis grants may only be written while the organisation's authority is still
-- at epoch 0 -- i.e. in the transaction that creates it. Afterwards the root key
-- signs ONLY `is_recovery` grants, which are time-boxed, announced before they
-- issue, and bannered for their duration (§8.2). Without this, a reassembled root
-- key could write an unbounded, unannounced "genesis" steward at any later date,
-- which is break-glass with none of break-glass's controls. SECURITY DEFINER,
-- `search_path` pinned, because it reads a row-security-protected table.
CREATE FUNCTION genesis_is_creation_only() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
    IF NEW.is_genesis AND EXISTS (SELECT 1 FROM organisation_auth_head h
                                   WHERE h.organisation_id = NEW.organisation_id
                                     AND h.auth_epoch > 0) THEN
        RAISE EXCEPTION 'genesis grants are creation-only; use a recovery grant';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER scope_grants_genesis_creation_only
    BEFORE INSERT OR UPDATE ON scope_grants
    FOR EACH ROW EXECUTE FUNCTION genesis_is_creation_only();
CREATE INDEX scope_grants_subject_idx ON scope_grants (organisation_id, subject_id, scope_id);
```

The same composite-kind FK pattern goes on `recovery_holders.account_id`. **An operator principal id
in any of those columns is rejected by the database, in every session, at every privilege level,
through every interface, including `psql` as superuser.** That is the cheapest strong thing in this
document.

A human may hold both an operator principal and an account principal; forbidding that is not
possible and pretending otherwise would be theatre. What is forbidden is a *session* carrying both,
and what is guaranteed is that the operator principal gives the account principal nothing. The admin
page shows *"this operator's address matches account X"* as a standing note, so nobody discovers it
during an incident.

### 3.3 The signed bytes, and why the signature is a hardware touch

Length-prefixed throughout, per `PHASE-2-STORAGE-DESIGN.md` §11.2 — `LP(x) = u32_le(len(x)) ‖ x` —
because the same splice applies: subject `ab` + scope `c` must not canonicalise to subject `a` +
scope `bc`.

```
grant_bytes   = LP("fathom/grant/v1")
              ‖ LP(organisation_id) ‖ LP(root_pubkey_fpr) ‖ LP(scope_id)
              ‖ LP(subject_id) ‖ LP(subject_key_fpr)
              ‖ LP(capability)
              ‖ LP(granter_id_or_empty) ‖ LP(granter_key_fpr)
              ‖ u64(effective_from_unix) ‖ u64(expires_at_unix_or_0)
              ‖ u32(auth_epoch)

grant_challenge  = H("fathom/grant/challenge/v1" ‖ grant_bytes)
second_bytes     = LP("fathom/grant/second/v1") ‖ LP(H(grant_bytes)) ‖ LP(H(granter_sig))
second_challenge = H("fathom/grant/second/challenge/v1" ‖ second_bytes)
revoke_bytes     = LP("fathom/grant/revoke/v1") ‖ LP(organisation_id) ‖ LP(grant_id)
                 ‖ LP(H(grant_bytes)) ‖ u64(revoked_at_unix)
move_bytes       = LP("fathom/scope/move/v1") ‖ LP(organisation_id) ‖ LP(scope_id)
                 ‖ LP(old_path) ‖ LP(new_path) ‖ u64(at_unix)
reparent_bytes   = LP("fathom/device/reparent/v1") ‖ LP(organisation_id)
                 ‖ LP(canon(sorted list of (device_id, from_scope_id, to_scope_id)))
                 ‖ u64(at_unix)
```

**`granter_sig` is a WebAuthn assertion, not a software signature.** The granter's browser calls the
authenticator with `challenge = grant_challenge`; the stored signature is the triple
`(authenticatorData, clientDataJSON, signature)`, and verification recomputes `grant_bytes` from the
row, recomputes the challenge, checks it against the challenge inside `clientDataJSON`, checks the
origin and the user-verification flag, and verifies the signature under the public key in
`account_keys`.

Three things follow, and the third is why this shape was chosen over a software key unwrapped by the
vault:

1. **A captured passphrase mints nothing.** A substituted client bundle that steals both vault
   secrets — the residual ADR-0043 §8 and `PHASE-2-ATTACK-REPORT.md` B3 both name — gets the
   vault. It does not get the authenticator. Grant minting then requires catching a real steward at
   a real touch, prospectively, one grant at a time.
2. **The signing key cannot be escrowed into the team password manager**, which is what a software
   key protected by two printable secrets will become the first time a laptop dies (§8.4).
3. **It costs a touch per grant.** That is the friction, and it is priced in §11.4.

**`subject_key_fpr` and `granter_key_fpr` are both inside the signed bytes.** Without the first, an
administrator swaps the subject's public key for one they hold and replays a year-old legitimate
grant. Without the second, a granter's key rotation leaves no statement of which key should have
verified the grants they signed, and every one of them either stops verifying or verifies under
whatever key the keyring currently holds — both wrong. Verification uses the keyring entry live at
`effective_from`, and §8.4's key succession carries grants forward without a re-signing campaign.

### 3.4 Verification at every use, and what is cached

`repo::authorise_account` does not ask whether a grant row exists. It does this:

1. Read the scope's current `path`, split into ancestor ids.
2. Read `organisation_auth_head` for the organisation; **verify `head_seal`** under `K_seal` derived
   from the organisation chain key. If it does not verify, the transaction fails closed with
   `AuthorityUnverifiable` — never "no grants found", which would render as an ordinary permission
   error and teach nobody anything.
3. Check `auth_epoch` against the in-process high-water mark for that organisation (§7.6). A head
   whose epoch is *lower* than one this container has already seen is a rollback: fail closed, raise
   `authority_rollback` as an incident.
4. Read candidate grants for this subject at any ancestor scope id. For each: **verify `row_seal`**,
   then confirm the grant id is inside `live_digest` (recomputed over the organisation's live set —
   see below), then check `effective_from`/`expires_at`/`suspended_at`, then fetch the granter's and
   seconder's keys from `account_keys`, **verify the keyring rows' own seals**, and verify
   `granter_sig` and `seconder_sig` over recomputed bytes.
5. If the grant chains to genesis, **recompute the organisation id** from `organisation_roots` and
   compare (§6.1).
6. Check the quorum rule for the capability.
7. Only then return `Capabilities`, and only then may the caller set `app.design_capability`.

```
K_row       = HKDF-Expand(chain_key_epoch_e, info = "fathom/chain/kdf/row/v1", 32)

row_seal    = MAC(K_row, LP("fathom/row/v1") ‖ LP(table_name) ‖ LP(row_id)
                  ‖ u64(chain_seq) ‖ u32(row_version) ‖ LP(canon(row_state)))

live_digest = MAC(K_row, LP("fathom/authhead/live/v1") ‖ LP(organisation_id)
                  ‖ u32(auth_epoch) ‖ u32(live_count)
                  ‖ ⟦ LP(grant_id_i) ‖ LP(row_seal_i) for i in sorted(live grants) ⟧)

head_seal   = MAC(K_seal, LP("fathom/authhead/seal/v1") ‖ LP(organisation_id)
                  ‖ u32(auth_epoch) ‖ u64(chain_seq) ‖ LP(live_digest))
```

**Every grant lifecycle event increments `auth_epoch`, writes a chain entry, and rewrites the head in
the same transaction.** So the current state of the *set* is authenticated, not merely the author of
each row. That is the gap every earlier draft left: signatures proved who wrote a row and nothing
proved what the rows currently say or which of them are still there.

**No verdict is ever stored.** An earlier draft cached "the verified capability set" in the session
table, which is a row the threat model says the attacker owns — one `UPDATE` and the signature check
never runs. What may be memoised is the *live set itself*, keyed by `(organisation_id, auth_epoch)`,
**in process memory**, re-derived independently by each container, discarded on epoch change. This
is not session state and does not violate REBUILD-PLAN item 1: it is a pure function of sealed rows,
both containers compute the same value, and losing it costs one recomputation. Process memory is
also the one place the tier-2 attacker cannot write.

Cost, measured rather than asserted at build time: one `head_seal` verification plus one
`live_digest` recomputation — `live_count` HMAC invocations, which for an organisation with a
hundred grants is a hundred HMACs on a memoised path — plus a handful of signature verifications per
authorisation on a miss. If that proves too slow, the fix is a wider memo, never a stored verdict.

### 3.5 Quorum, and the sole-steward problem solved rather than declared

| Action | Quorum |
|---|---|
| grant `read` or `draw` | 1 steward |
| grant `steward` | **min(2, live distinct stewards of the organisation)** |
| revoke or suspend anything | 1 steward (or 1 operator, for suspend only) |
| move a scope; batch-reparent devices | 1 steward at each end |
| set recovery holders | min(2, live distinct stewards) |
| raise a quorum | the quorum being raised |
| lower a quorum | the quorum being lowered, plus 72h and a witness receipt |

**`min(2, live stewards)` is the fix for a deadlock that a fixed quorum of 2 creates and cannot
escape.** A sole steward — the ordinary shape for a small network team, which is the ordinary
customer — can otherwise never appoint a second, because appointing one needs two. They then cannot
arm break-glass either, because that needs two as well. The organisation is permanently
single-stewarded, and the product's own controls have made the honest configuration unreachable. The
observed outcome of that is not compliance; it is one person creating two accounts with two mail
aliases and both sets of secrets in the team password manager, after which **every** two-signature
control in the product is satisfied by one human in two tabs, with the audit faithfully recording
two.

So: a sole steward may appoint a second alone, with a 24-hour delay, an undismissable in-product
banner, a mailed notice, and a cancel button for the appointer. What matters — that no new
grant-granting authority appears silently — survives. What does not survive is the demand for a
second signature that cannot exist.

**And the 30-day block on new networks for a single-steward organisation is dropped.** A control
that halts the customer's work is the control they will demand the administrator disable. It becomes
a standing warning that escalates in prominence, plus a refusal to arm break-glass with fewer than
`t` holders, which is a statement of fact rather than a punishment.

### 3.7 Groups, and directory sync — owner's requirement of 2026-09-12, constraints decided, tables not yet designed

The owner: *"permissions wise we need people to be able to have groups, and view only, etc. There
should be an admin mode where they can go in and change those settings. Eventually it should
probably be able to sync with LDAP."*

**View-only already exists**: it is the `read` capability in §3.1, granted per scope, so "this team
can see the Leeds site and nothing else" is native. **Groups do not exist yet** — every grant is to
one account — and they must, because a steward granting the same thing to forty people one at a time
is how permission maps rot. **"Admin mode" is two screens, not one**, and the distinction is the whole
anti-takeover design: the operator console (`/admin`: accounts, organisations, SMTP, site settings —
*sees* the permission map, §1.1) and the steward's permission screen inside the organisation
(*writes* it: groups, who is in them, what each may see or edit). Both need drawing in `UI-SPEC.md`.

**Constraints decided now, so that the group design cannot reopen a closed takeover route:**

1. **A group is a principal of its own kind, and a grant to a group is a signed grant like any
   other** (§3.3), made by a steward of that scope. Nothing here changes who may grant.
2. **Adding a person to a group is a sealed, steward-signed act, exactly like a grant.** It has to
   be: if an operator could add an account to a group that holds `draw` on everything, the sockpuppet
   route of §1 reopens with one extra step. So group membership is written by stewards, never by
   operators, and the operator console shows it and can suspend it (§1.1's suspend verb extends to
   group membership), nothing more.
3. **Stewardship never flows through a group.** A group may hold `read` and `draw`; the `steward`
   capability is granted only to an individually enrolled account with its own signing key, because
   a steward signs things and a group cannot. This also keeps §3.5's quorum meaningful.
4. **Directory sync (LDAP first; the same door serves Active Directory, SCIM and the rest later)
   provisions accounts and group *membership*, never grants and never stewardship.** Whoever
   controls the directory is an operator-equivalent for this product, so a synced group is marked as
   synced, can hold `read` and `draw` only, and what it may see is still decided by a signed steward
   grant to that group. A directory administrator can therefore put someone in the "network
   viewers" group and cannot decide what network viewers see. Sync writes are sealed entries on the
   organisation chain attributed to the sync principal, so a directory-side change is visible in
   the trail as what it is.
5. **Removal from a group takes effect at once and is reversible by a steward**, the same posture
   as suspension; a directory removal is a removal, not a suspension, and says so in the entry.

**Still to design, and then to attack before building:** the `groups` and `group_members` tables
with their composite foreign keys onto `principals`, the signed bytes for a membership change (the
`second_bytes` lesson in §3 applies: bind the fact, not an encoding), how a grant-to-group is
resolved at request time without a second cache to poison (§3.4), and the LDAP connector's own
credential — which is a device-credential-shaped secret and goes through the redaction gate and the
vault like any other (CLAUDE.md rule 4). Sequenced after the account and enrolment work in §14;
the schema is not touched until the group design has had its own attack round.

### 3.6 `move_subtree`, and the cheaper route around it

`repo::move_subtree` today calls `authorise` and accepts any member, then rewrites every descendant
path in one `UPDATE`. Under path-prefix evaluation, moving someone else's rack under a network you
hold hands you their rack. Changes:

- It requires `steward` at the source's current parent **and** at the destination, both verified as
  in §3.4, and is co-signed over `move_bytes` by a steward at each end.
- It emits a sealed `scope_moved` entry and notifies every grantee of both subtrees.
- `expected_parent_kind`, the cycle guard, the `FOR UPDATE` lock and the `changed == 0` check stay
  exactly as they are. They solve a different problem and they solve it correctly.

**Gate the outcome, not the verb.** Two signatures per rack move is the price of a datacentre
migration week, and the cheaper route is already open: create a fresh rack under the destination,
copy the devices, abandon the original. One person, one afternoon, no ceremony, no `scope_moved`
entry, nobody at the source notified — and an estate of record accumulating duplicate racks with no
provenance, which damages the product's other co-equal goal by means of its own control. So:

- **Cross-scope device reparenting** and **emptying or deleting a non-empty scope** carry the same
  co-signature as a move. The cheap route costs what the expensive route costs.
- **A batch move exists**: one assertion per steward over `reparent_bytes`, a canonical sorted list
  rendered in full in the browser before the touch, capped (default 500 entries) so that one touch
  cannot silently cover an estate. The sanctioned path becomes genuinely cheaper than the workaround,
  which is the only way a control of this kind survives contact with a migration.

---

## 4. Sessions: the per-request proof

The server decrypts designs to serve them. Nothing here changes that, so the only place to stand is
*which session gets served*.

### 4.1 The rule

**A session may receive design payload only if (a) its authentication included a factor the server
cannot re-issue, and (b) the request itself carries a fresh signature by a key the session's browser
holds and the server has never seen.**

Clause (a) alone is what an earlier draft had, and it is not enough. That draft stored the WebAuthn
assertion in the session row and re-verified it at design-read — which defeats *fabrication*, since
inventing an assertion achieves nothing, but not *copying*. A tier-2 attacker lifts the victim's
genuine assertion out of their real session row (or out of last night's backup, where assertions
never expire as bytes) into a new row whose bearer token the attacker chose. Re-verification
succeeds, because the assertion is authentic. It proves the assertion was made once; it never proves
this session's holder made it. The sign counter is no defence when the attacker owns the row holding
the last-seen counter.

Clause (b) is the fix, and it is a design change rather than a test.

### 4.2 How a session is bound

At sign-in the browser generates a **session keypair** (non-extractable, `WebCrypto`, stored in
IndexedDB — it never leaves the browser and is not exportable by script). The WebAuthn challenge is
derived from its public half:

```
server_nonce      = 32 random bytes, stored once, consumed at verification
session_challenge = H("fathom/session/bind/v1" ‖ LP(session_pubkey) ‖ LP(server_nonce)
                      ‖ LP(deployment_id))
```

The assertion is accepted only if the challenge inside its `clientDataJSON` recomputes from the
`session_pubkey` the client is asking to register. The nonce is single-use and deleted at
verification, so the same assertion cannot bind a second public key.

Every request for design payload or vault ciphertext then carries:

```
request_bytes = LP("fathom/session/req/v1") ‖ LP(session_id) ‖ LP(method) ‖ LP(path)
              ‖ LP(H(body)) ‖ u64(unix_ms) ‖ u64(request_counter)
```

signed by the session private key. The server verifies it against `sessions.session_pubkey` before
setting `app.design_capability`. Replaying the row yields a session whose private half the attacker
does not hold; cloning it into another browser fails for the same reason.

**Vault-unlock assurance finally gets a definition too.** An earlier draft let "a vault unlock" stand
as the non-re-issuable factor and never said what the stored evidence was — so for an account with no
authenticator it was whatever the implementer picked, which against this attacker is a boolean. Here
it is a signature by the account's registered key over the same `session_challenge`. One rule, one
shape, one verification path.

### 4.3 The session row, and a second fence under it

```sql
CREATE TABLE sessions (
    id                text PRIMARY KEY CHECK (char_length(id) = 26),
    principal_id      text NOT NULL,
    principal_kind    text NOT NULL CHECK (principal_kind IN ('account','operator')),
    token_hash        bytea NOT NULL UNIQUE,
    session_pubkey    bytea NOT NULL,
    session_alg       smallint NOT NULL,
    bound_nonce       bytea NOT NULL,
    credential_id     bytea,                  -- NULL for A0
    assertion_digest  bytea,                  -- H(authenticatorData ‖ clientDataJSON ‖ signature)
    assurance         text NOT NULL CHECK (assurance IN ('A0','A1')),
    request_counter   bigint NOT NULL DEFAULT 0,
    issued_at         timestamptz NOT NULL,
    expires_at        timestamptz NOT NULL,
    row_mac           bytea NOT NULL,
    FOREIGN KEY (principal_id, principal_kind) REFERENCES principals (id, kind)
);
```

```
K_sess  = HKDF-Expand(chain_master, LP("fathom/session/mac/v1") ‖ LP(deployment_id) ‖ u32(epoch), 32)
row_mac = MAC(K_sess, LP("fathom/session/row/v1") ‖ LP(id) ‖ LP(principal_id) ‖ LP(principal_kind)
              ‖ LP(session_pubkey) ‖ LP(credential_id_or_empty) ‖ LP(assertion_digest_or_empty)
              ‖ LP(assurance) ‖ u64(issued_at) ‖ u64(expires_at))
```

Two independent fences, deliberately: a tier-2 attacker cannot mint a session row at all, because
`K_sess` is not in PostgreSQL; a tier-3 attacker can mint one and still cannot sign a request. The
`request_counter` is anti-replay against a network observer, not against the database attacker — they
own the column it is compared against. Say that where the column is defined, so nobody later cites
it as a control it is not.

Sessions are rows and not memory, which is REBUILD-PLAN item 1 satisfied as a side effect, and
either container verifies a request without shared state.

`A0` — a password-only session — may sign in, see the organisation list and scope tree, change its
own password, register an authenticator *using an existing one*, and read notices. It receives no
design payload and no vault ciphertext. **The rule is uniform on purpose.** Written as "sessions
created after a password reset are restricted", it would be a stored boolean, and a stored boolean is
one `UPDATE` from being false. Written as "did this request carry a signature that verifies", it is a
question an administrator cannot answer yes to by editing a row.

### 4.4 Registering and removing authenticators

Registration requires one of: an existing registered authenticator on that account; a vault unlock;
or a one-time enrolment token **and** a steward co-signature (one steward of a scope the account
holds, or two where the account holds none yet). An operator may *initiate* the third path — that is
legitimate help-desk work — and cannot complete it.

**Removing an account's last authenticator is a steward-co-signed action, never an operator one.**
Otherwise the operator strips the factor and drops the account to `A0`-plus-reset, which is the
takeover with an extra step.

**Two authenticators at enrolment, not one.** The interface asks for a second — a spare key in a
drawer or a safe — at the moment the first is registered, and says why: the alternative to a spare is
a steward-co-signed recovery every time a laptop dies, and the observed response to that friction is
key escrow (§8.4).

### 4.5 The operator surface has no password path at all

An operator session is `A1` or it does not exist. There is no password sign-in, no reset link, and no
"forgot" flow on `/admin`; an operator who loses their authenticators is re-enrolled by two other
operators through the §5.4 machinery, or, for the last operator standing, from the master-key volume
(§6.3).

This closes the route that made every two-operator control in the earlier draft collapse: the
assurance rule was written for accounts and design payload only, so a password — which the server can
re-issue — held the admin surface. **The admin surface is the last place a re-issuable factor is
acceptable.**

---

## 5. Password reset, contact address, settings, and the execution interlock

### 5.1 Reset

- The admin page has no "set password" control. It has "send a reset link", and the link goes only to
  the account's verified address of record. No override field, no operator-supplied destination.
- The reset produces an `A0` session. It yields no design bytes.
- It does not open the vault. ADR-0043, unchanged.
- It writes sealed `reset_link_sent` and `password_changed` entries and notifies the holder.

### 5.2 Contact address

An operator-initiated address change on someone else's account is a `change_requests` row: **two
operator assertions, a 72-hour window, notice to the old address and to every steward of the
account's scopes, cancellable during the window by the holder or any of those stewards.** A holder
changing their own address confirms at both addresses and involves no operator.

### 5.3 SMTP and site settings

```sql
CREATE TABLE site_settings_versions (
    id                   text PRIMARY KEY CHECK (char_length(id) = 26),
    key                  text NOT NULL,      -- 'smtp','shipper','cadence','quorum','retention',...
    value_ct             bytea NOT NULL,     -- AEAD; SMTP credentials are credentials
    value_digest         bytea NOT NULL,     -- H(value_ct), and it is inside the sealed entry
    requested_by         text NOT NULL REFERENCES operators(id),
    request_sig          bytea NOT NULL,     -- assertion over the request digest
    seconded_by          text REFERENCES operators(id),
    second_sig           bytea,
    requested_at         timestamptz NOT NULL,
    effective_at         timestamptz NOT NULL,
    effective_receipt_id text REFERENCES chain_receipts(id),
    cancelled_at         timestamptz,
    applied_at           timestamptz,
    sealed_seq           bigint,             -- NULL until the tenant plane stamps it
    row_seal             bytea,
    CHECK (seconded_by IS NULL OR seconded_by <> requested_by)
);
```

Two operators, a 24-hour delay, and during the delay **the old settings still apply** — so the notice
of the change travels the mail path the change is trying to capture, plus the syslog sink. The
operator who redirects mail is not the operator who receives the warning. A test-send goes only to
the requesting operator's own verified address, is rate-limited, and is itself a sealed entry: an
SMTP form is not an outbound-connection console.

**First-version rule, stated now so nobody invents a skip flag later.** *A setting with no prior
applied version applies immediately, with no delay and no second operator.* On a fresh install there
is no old value to protect and no mail path to capture, so the delay protects nothing and only makes
the product look broken out of the box — and the remedy someone would otherwise ship is an
environment variable in the compose file, which is tier 3's own property and reopens the whole
route. The condition is checkable, not a mode:

```sql
NOT EXISTS (SELECT 1 FROM site_settings_versions
             WHERE key = $1 AND applied_at IS NOT NULL AND cancelled_at IS NULL)
```

Single-operator deployments are real. `FATHOM_SINGLE_OPERATOR=true` reduces the second signature to
none and **keeps the delay, the notice and the witness receipt**. It writes a sealed
`single_operator_mode` entry at every startup, so nobody can later claim two-person control was in
force. Quorum 1 with no delay is not a configuration the product offers.

### 5.4 The execution interlock

**No administrative change takes effect while `sealed_seq IS NULL`, and nothing reachable from the
operator surface can stamp it.** `sealed_seq` is written by the application, in the same transaction
that appends the chain entry, using a chain key the admin role has no path to. The resolver that
answers *"what is the effective value of `smtp`?"* does not read the newest row. It does this:

1. Take candidate rows with `applied_at IS NOT NULL`, `cancelled_at IS NULL`, `sealed_seq IS NOT NULL`.
2. For each, load site-chain entry `sealed_seq`, **verify its seal**, and check that the entry's
   sealed metadata contains this row's `(id, key, value_digest, effective_at)`.
3. Check the entry links: `prev_seal` matches entry `sealed_seq - 1`, whose seal also verifies.
4. Check `effective_receipt_id` names a witness receipt whose timestamp is at or after
   `effective_at` (§7.4 — the delay is measured by the party it protects).
5. Take the newest survivor. A candidate that fails any check is **not** silently skipped: it raises
   `setting_unresolvable` as an incident and the deployment banners it.

This is the one move that turns the audit trail from evidence into a gate. **Stopping the log to act
unobserved also stops the act.** It is also what makes the forged-sibling-row attack inert: a row
inserted directly into PostgreSQL has no sealed entry naming its digest, so step 2 rejects it.

### 5.5 Who may second

`CHECK (seconded_by <> requested_by)` tests that two ids differ, not that two humans acted. A
`SECURITY DEFINER` trigger (owned by the audit role, `search_path` pinned, because a plain trigger
function runs as the invoker and would read `operators` through row security and pass vacuously)
enforces the rest:

- the seconder was not created by the requester;
- the seconder has an independent sign-in on record (`first_independent_signin_at IS NOT NULL`);
- that sign-in is older than the longest delay window in force (default 7 days);
- the seconder's `second_sig` is a fresh assertion over `H(change digest)`, so seconding is a
  hardware touch and not a row.

And **operator creation is itself routed through this machinery**: two existing operator assertions,
the delay, notice to every organisation's stewards, sealed, shipped to the witness as a first-class
alert, and a first sign-in that must register an authenticator. The earlier draft's `GRANT INSERT ON
operators TO fathom_admin` made minting a colleague a form submission that looked exactly like
onboarding, and made the honest path (declaring single-operator mode, permanently, visibly) strictly
more expensive and more embarrassing than the dishonest one. The admin page shows *"created by X,
never independently signed in"* beside every operator until that stops being true.

---

## 6. Membership: how it is granted, and who bootstraps the first

### 6.1 Genesis is the organisation root key, and the organisation id is derived from it

At organisation creation the creator's browser generates an **organisation root keypair**. It:

1. draws a 16-byte `id_salt` and derives
   `organisation_id = b32(H("fathom/org/id/v1" ‖ LP(root_pubkey) ‖ LP(id_salt)))[0..26]`;
2. signs one or two **genesis steward grants** with the root private key — `granter_kind =
   'org_root'`, `is_genesis = true` — naming subjects who already have an enrolled authenticator;
3. Shamir-splits the root private key *t*-of-*n* (default 2-of-3), wraps each share to a named
   recovery holder's account key, renders each as a printable artefact, and **discards the assembled
   key**;
4. uploads the public half, the salt, the wrapped shares and the genesis grants.

The server verifies the derivation before storing anything, and **recomputes it at every
authorisation that chains to genesis** (§3.4 step 5).

**This is what makes a second genesis unconstructible rather than merely detected.** Without it, the
genesis grant is the one signature in the design that anybody can produce, because it is self-signed,
and the only things making it authoritative are a boolean column and a partial unique index — both
owned by a tier-2 attacker. Clear the boolean, register a real account with a real authenticator,
sign a fresh genesis with that account's own key, insert it, append a correctly sealed chain entry
with the chain key from the key volume, and sign in through the front door as a steward of an
existing organisation, with every signature genuine and the audit recording the access as
legitimate. With the id bound to the root key, a re-minted genesis under a different key yields a
*different organisation id* and matches no existing row. The attack stops being detected and starts
being impossible.

**After creation the root key signs only recovery grants.** A second genesis written later would be
an unbounded, unannounced steward — break-glass with none of break-glass's controls — so the trigger
above refuses it once `auth_epoch > 0`. A tier-3 attacker who reassembles enough shares to sign
anything must therefore take the recovery path, which is announced before it issues, bannered for its
duration, vetoable, and expires (§8.2).

Pair it with two cheap far-end rules: record the genesis fingerprint off-box at creation, and alarm
on any `org_genesis` entry for an organisation whose creation date is not today.

### 6.2 The operator's bounded role

An operator may create an **organisation shell**: a row with a name, no genesis, and an enrolment
claim. The shell holds no data and permits no design creation until the claim is redeemed by an
account with a registered authenticator.

The claim is **pinned to an install-time `notice_address`** recorded in `site_install` at first
start, which no role can `UPDATE` — the column has no `UPDATE` privilege for any role and a trigger
raises on any attempt. This is the one piece taken from a competing design's weakest point rather
than its strongest: that design let an operator reseat an organisation using a channel and a PIN both
inside the operator plane, and then asserted the opposite in its own words. Pinning the claim to an
address the operator surface cannot rewrite is the difference.

**The residual, named rather than implied:** an operator who controls SMTP can intercept the
enrolment mail for a shell *they created* and become its genesis steward. The organisation is empty.
It gives them nothing anywhere else, because every existing organisation's genesis is bound to a key
that already exists and an id already derived from it. The interface says *"this organisation was
bootstrapped by operator X on date D"* on the organisation's own page, permanently, rendered from the
chain.

### 6.3 The very first operator, and the very first organisation

Both are written to the master-key volume, not mailed — because on a fresh install there is no mail.

- At first start, if no operator exists, the server writes a single-use enrolment token to
  `/var/lib/fathom/keys/first_operator.token`, 0400, and logs the path. Whoever can read that volume
  is the legitimate installer. Redeeming it registers an authenticator and writes
  `operator_bootstrapped`.
- The first organisation's enrolment claim is displayed once in that operator's own session and
  written to the same volume.

This removes the reason anyone would ever build a global "skip the delay" flag, which is the shape
that would hand a permanent instant-SMTP-change power to exactly the attacker this document is about.

### 6.4 Everything after genesis

> **EXTENDED 2026-09-12 (storage design §13.5 R5).** Offboarding does not end at *"operator disables
> the account, steward revokes the grants."* It gains a vault step: the interface generates the list
> of every credential the leaver owned or could read — a rotation worklist for Mode B entries,
> because the departure removes none of the server's ability to serve them, and an *unrecoverable*
> notice for sole-recipient Mode A entries. Plus a standing `vault_owner_absent` state.

- **New scopes:** created by a steward of the parent; stewardship inherits down the path, so no new
  signature.
- **New members:** a steward signs a grant naming a subject who **already has a registered key**.
  There is no way to grant access to a phantom account, which is the "invite a fresh account I
  control" route closed at its root.
- **Bulk import at go-live:** one assertion over a canonical sorted batch, with the full list
  rendered in the browser before the touch and a cap (default 500). Without a batch path the first
  day of a thousand-device estate is unusable; without the cap and the rendering, one captured touch
  mints a thousand grants.
- **Offboarding:** an operator disables the account (authentication), a steward revokes the grants
  (authorisation). Either alone stops access; both are recorded; only the second is permanent.

---

## 7. The audit trail

### 7.1 Reuse, not reinvention

Same construction as `PHASE-2-STORAGE-DESIGN.md` §11.2 and §12: HMAC-SHA-256, HKDF-Expand subkeys
(`from_prk`, not `new`), length-prefixed fields, `seq`, `prev_seal`, `chain_key_epoch` on every entry,
retired chain keys kept forever, and the three verification outcomes with *"links verified, content
not re-bound"* as its own sub-state. Chain keys sit behind ADR-0043's provider interface and never in
PostgreSQL.

Three new chain kinds join the per-design edit chain, each with its own domain-separated derivation
so entries cannot be spliced between them. **These labels belong in `PHASE-2-STORAGE-DESIGN.md`
§12.2's table**, which owns them:

```
site_chain_key_e = HKDF-Expand(chain_master,
    info = LP("fathom/chain/key/site/v1") ‖ LP(deployment_id) ‖ u32(epoch), 32)
org_chain_key_e  = HKDF-Expand(chain_master,
    info = LP("fathom/chain/key/org/v1")  ‖ LP(organisation_id) ‖ u32(epoch), 32)
read_chain_key_e = HKDF-Expand(chain_master,
    info = LP("fathom/chain/key/read/v1") ‖ LP(organisation_id) ‖ LP(design_id) ‖ u32(epoch), 32)
```

Storage §6's own note that a tenant-level chain *"is cheap and should also exist"* is discharged by the
organisation chain; the site chain covers everything organisation-independent.

### 7.2 Entry types

**Site chain** — `deployment_started`, `schema_fingerprint`, `migration_applied`,
`client_build_digest`, `operator_bootstrapped`, `operator_created|seconded|enrolled|disabled`,
`operator_signin|signin_failed`, `account_created`, `account_disabled|enabled`, `reset_link_sent`,
`password_changed`, `authenticator_registered|removed`, `enrolment_token_issued|redeemed|expired`,
`contact_change_requested|seconded|applied|cancelled`,
`setting_requested|seconded|applied|cancelled`, `setting_unresolvable`, `single_operator_mode`,
`org_shell_created`, `backup_taken`, `restore_performed`, `rewrap`, `rotate_started|finished`,
`shipper_config_changed`, `shipper_gap`, `spool_pressure`, `clock_step`, `epoch_opened`,
`witness_receipt`, `verification_run`, `heartbeat`.

**Organisation chain** — `org_genesis`, `account_key_enrolled|superseded|retired`, `grant_signed`,
`grant_seconded`, `grant_suspended|unsuspended`, `grant_revoked`, `auth_head_advanced`,
`scope_created`, `scope_moved`, `scope_deleted`, `devices_reparented`, `recovery_holders_set`,
`break_glass_opened|vetoed|used|closed`, `design_created`, `design_deleted`, `member_added|removed`,
`authority_rollback`, `heartbeat`.

**Per-design read chain** — `payload_decrypted`, carrying account id, session id, scope id, design
version, and the id of the request signature that authorised it. Separate from the edit chain because
reads outnumber edits by orders of magnitude and read retention must be prunable at an epoch boundary
without touching the edit history storage §11.2 defines. This is the first answer in the product to ADR-0043
§8's own named weakest point: *without it, nothing can say who decrypted what.*

**Read volume is a judgement call.** Default: one entry per `(session, design, design_version)`,
deduplicated within a 15-minute window and carrying a count, which keeps *"who opened this rack
today"* exact and *"how many times"* approximate. The alternative — one entry per decryption — is the
honest maximum and costs roughly two orders of magnitude more rows. Whichever ships must be written
in the operator's register, because an auditor will ask.

### 7.3 Metadata is encrypted; the seal covers the stored bytes and a keyed binding of the plaintext

`PHASE-2-STORAGE-DESIGN.md` §11.3 cost 3 says it exactly: *"a plaintext copy in the audit log is the
leak returning through a side door."* So entry metadata is stored as AEAD ciphertext — under a
per-organisation content key (a wrapped data key in the design-key shape, storage §12.2) for
organisation and read chains, under a site metadata key derived from `chain_master` for the site
chain. In the clear: `seq`, `entry_type`, ids, timestamps, `chain_key_epoch`, the seal, and a
`metadata_binding` keyed under `K_content` over the plaintext.

**Corrected 2026-09-12.** This section first said the seal is computed over `canon(metadata)` in
plaintext "exactly as storage §11.2 specifies", and that §11.2's two-tier shape made the routine
check free. Both halves were wrong: §11.2's two tiers were over the *payload*, and sealing the
plaintext metadata meant a routine check holding only the chain key could not recompute a single seal
on a chain whose metadata column is ciphertext. The builder found it. §11.2 is corrected: the seal
covers the metadata **as stored** plus the keyed binding, so routine verification — links plus
bindings, no decryption — recomputes every seal from stored columns with the chain key alone, and a
swapped or corrupted ciphertext breaks the seal; deep verification decrypts and re-checks the
binding. One construction at all three levels. A routine verifier holding `chain_master` can read
site metadata (its key is derived from `chain_master`) and cannot read organisation metadata; the
site chain holds no tenant data, so that asymmetry is intended.

### 7.4 Off the box means countersigned, not sent

This is the correction that matters most in this section, because the alternative is a control that
evaporates on the day it is installed.

**A tip digest counts as anchored only when a receipt comes back signed by a key the server never
holds.**

```sql
CREATE TABLE chain_receipts (
    id            text PRIMARY KEY CHECK (char_length(id) = 26),
    chain_kind    text NOT NULL CHECK (chain_kind IN ('site','org','design','read')),
    chain_id      text NOT NULL,
    seq           bigint NOT NULL,
    tip_digest    bytea NOT NULL,
    witness_key_id text NOT NULL,
    receipt_sig   bytea NOT NULL,
    witness_time  timestamptz NOT NULL,
    received_at   timestamptz NOT NULL,
    UNIQUE (chain_kind, chain_id, seq, witness_key_id)
);
```

Without receipts, the shipper's target is whatever the operator pointed it at — and the configuration
a careful operator chooses on install day, when the SIEM is not ready and the spool is filling, is
rsyslog in the same compose file on the same host. Heartbeats then always succeed, gaps never occur,
nothing complains, and every guarantee in this section is held on the box the attacker owns while the
product reports itself healthy. A receipt the server cannot forge is the only thing that
distinguishes a witness from a folder.

Consequently:

- **The admin page, the startup log line and the operator's register all show "last independent
  countersignature: `<time>` from `<witness key id>`"**, and the documentation never calls an
  un-countersigned target an anchor.
- **Gated changes require a receipt** (§5.4 step 4), which is also how delays stop being measured by
  a clock the attacker owns: the window elapses when the *witness* says it has. Burst 288 sealed
  heartbeats and step the host clock forward and nothing moves, because the receipts carry the
  witness's own timestamps. The far end alarms on heartbeats arriving *faster* than cadence as well
  as slower — one comparison, currently made nowhere.
- **Heartbeat counting is derived, not hard-coded:** a delay of `D` seconds at cadence `C` requires
  `ceil(D / C)` heartbeats, floor 2, computed against the cadence in force when the request was
  filed. A cadence change that would shorten an in-flight window is refused. A hard-coded "288
  heartbeats for 24 hours" means 288 *days* on an air-gapped deployment's daily cadence, and the
  observed response to that is either a five-minute cadence nobody carries out of the room — which
  is theatre — or a patch that removes the delay.
- **The witness challenges back.** Each heartbeat, the far end replies *"you should hold entries to
  seq N with tip D"*, and the server must answer from its own tables. A tier-2 attacker who disables
  the trigger, deletes the entries behind a banner they do not want shown, and re-enables it, is
  caught on the next cadence rather than at the next restart — which may never come.
- **Any surface that renders a security banner re-verifies first:** `seq` contiguity and `prev_seal`
  across the relevant range, before drawing. A deleted `break_glass_opened` then renders as storage §11.2's
  *"broken at entry N"* at exactly the moment the banner would have shown.

### 7.5 What the heartbeat still buys, stated narrowly

Every chain emits a sealed `heartbeat` on a fixed cadence (default 5 minutes; daily in air-gapped
mode) whether or not anything happened. The witness knows the cadence, so **a gap is an incident** and
an administrator who stops the shipper cannot make the silence look ordinary.

But a gap only catches an attacker who goes quiet, and a competent one has no reason to. With the
chain key — a file, by design — they leave the shipper running and ship a forged stream: same
cadence, contiguous `seq`, correct `prev_seal`, correct seals, omitting their actions and including
plausible ones, while doing the real work out of band with `psql` and the master key, where no
`payload_decrypted` entry would exist even if they were not forging. Routine verification at the far
end then reports *verified* on a fabrication.

**So the receipt chain is not an optimisation; it is the thing that makes the far end's holdings mean
anything.** Verification requires an unbroken chain of receipts, and a receipt cannot be minted on
the compromised box. What survives a tier-3 attacker, in exactly these words:

1. Entries the witness received before the compromise are fixed. They cannot be reissued, because the
   witness holds them and the attacker does not control it.
2. A gap, a burst, or a divergence from the witness's challenge is visible off-box within one cadence.
3. **Nothing is guaranteed about entries written after the compromise.** They are signed only by the
   compromised party and are therefore evidence about nothing. An audit trail that overstates itself
   teaches people to trust it during exactly the event it fails.

### 7.6 Rollback, restore, and why the anchor is not a local file

Each seal binds backwards only, so restoring last month's tables produces a rollback the chain
verifies perfectly. Four detections, in descending order of strength:

1. **The witness.** Its receipt says the deployment held `seq N`; the deployment now says `seq N-400`.
   That is an incident at the witness, not a judgement call on the box.
2. **In-process high-water marks.** Each container remembers the highest `(chain, seq, auth_epoch)`
   it has seen since startup. A rollback *during runtime* fails closed immediately (§3.4 step 3) —
   and process memory is the one store the tier-2 attacker cannot write.
3. **Client-remembered tips.** Each browser remembers the last site and organisation chain tip it
   saw, per user, and refuses to render quietly when the server's tip is behind it.
   `PHASE-2-STORAGE-DESIGN.md` B4's note that a client-remembered tip *"covers nothing"* is true for
   per-design chains nobody reopens; it is false for the site and organisation chains, which every
   working user touches daily. A rollback then announces itself to exactly the population that was
   working when it happened.
4. **The `chain_anchors` table**, holding every tip the deployment has published and every receipt id
   that covered it. In the database, shared by both containers, because a local file is not available
   to a replica and is trivially restored in step with the database it is supposed to witness.

**An earlier draft put an append-only `anchor.log` on the master-key volume and claimed it detected
rollback "with no network, no SIEM, and no external witness".** It does not. The volume is a
directory on a filesystem tier 3 owns and the file carries no signature they cannot produce:
`docker compose stop`, restore the database snapshot, `truncate` the anchor back to the matching tip,
`docker compose start`, and both halves agree. It also writes a file from the application, which
REBUILD-PLAN item 1 forbids, and it diverges or races across two replicas — so on an ordinary rolling
deploy the starting replica finds itself "behind", quarantines the whole deployment, and an operator
acknowledges a restore that never happened. By month two the acknowledgement is muscle memory and a
real restore presents identically. **A benign operation that renders as an attack teaches operators
to dismiss the alarm** — storage §11.2 already learned this with `reencrypt`.

So: **startup quarantine compares against shared state only** — `chain_anchors` and
`chain_receipts` — never against a local file, and never against another replica's private notion of
the tip. If the tip is behind a receipted anchor, the deployment serves no design payload until an
operator acknowledges, which writes a sealed `restore_performed` naming the anchor it went back past
and the window of entries lost. Every affected organisation then banners that window until a steward
dismisses it. **A restore is allowed; a silent restore is not.**

For a genuinely air-gapped site with no witness, the local anchor is a **single-writer sidecar with
its own volume that the server reads and never writes**, plus the printed daily digest somebody
carries out of the room. That is smaller than the networked case and the documentation says so.

### 7.7 Audit tables are immutable, and owned by a role nobody logs in as

```sql
REVOKE UPDATE, DELETE ON chain_entries, chain_receipts, chain_anchors FROM PUBLIC, fathom_app, fathom_admin;
CREATE FUNCTION audit_is_append_only() RETURNS trigger LANGUAGE plpgsql AS
  $$ BEGIN RAISE EXCEPTION 'chain entries are append-only'; END $$;
CREATE TRIGGER chain_entries_append_only BEFORE UPDATE OR DELETE ON chain_entries
    FOR EACH ROW EXECUTE FUNCTION audit_is_append_only();
```

The tables are owned by `fathom_audit`, a role with **no password and no login**, created by the
bootstrap migration; its credential is generated at first start into the key volume alongside the app
password and is never in the compose file. That is what makes `ALTER TABLE ... DISABLE TRIGGER USER`
a tier-3 move rather than a tier-2 one, and the schema fingerprint plus the witness challenge is what
catches it afterwards.

---

## 8. Break-glass

Treated first-class, because the naive version *is* the takeover route: *"an administrator can
recover an organisation that has lost its admin"* is *"an administrator can take any organisation,
having first arranged for it to lose its admin."*

### 8.1 Recovery authority is the organisation root key

There is no separate recovery mechanism. The authority that signed genesis (§6.1) *is* the recovery
authority; it is Shamir-split *t*-of-*n* at creation and kept in cold storage. This is why the design
has one root and not two: a second root is a second way in.

```sql
CREATE TABLE recovery_holders (
    organisation_id text NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    account_id      text NOT NULL,
    holder_kind     text NOT NULL GENERATED ALWAYS AS ('account') STORED,
    wrapped_share   bytea NOT NULL,
    share_index     smallint NOT NULL,
    threshold       smallint NOT NULL CHECK (threshold >= 2),
    set_seq         bigint NOT NULL,
    row_seal        bytea NOT NULL,
    PRIMARY KEY (organisation_id, share_index),
    FOREIGN KEY (account_id, holder_kind) REFERENCES principals (id, kind)
);
```

A holder added *after* creation must have held a live `steward` grant in the organisation for at
least 7 days. Since stewardship requires an assertion an operator cannot produce, **an operator
cannot become a holder, cannot appoint one, and cannot nominate themselves in an emergency** — the
same root closes this door as closes the others, and that is the property to check if this design is
ever modified.

### 8.2 The path

1. *t* holders reconstruct the root private key **in the browser**. The server sees no share and can
   never assemble one.
2. The root key signs a `recovery_grant`: a `scope_grants` row with `is_recovery = true`, `capability
   = 'steward'`, one subject, one subtree, `expires_at` at most 7 days out and 24 hours by default.
3. `break_glass_opened` is sealed to the organisation chain **and shipped and receipted** before any
   capability is issued. Where a witness exists and does not receipt, the capability does not issue.
4. A notice period runs (default 24 hours; zero if the organisation has no live steward *and* two
   holders have signed). During it: every account in the organisation, every operator and the syslog
   sink are notified, and an undismissable banner renders in every session in that organisation,
   **from the chain**, so no mail configuration suppresses it and no row edit removes it.
5. **Veto.** Any live steward, or any operator, may veto during the notice period. A veto is sealed,
   notified, and extends the window by 72 hours; sustaining it past that takes a second operator or a
   second steward. It cannot block indefinitely. Authority to *deny* is cheap and widely held;
   authority to *grant* is narrow and expensive, and that asymmetry is what lets a time-lock have
   teeth without creating a new escalation. **The bound on the veto is a judgement call**: unbounded,
   an operator can block recovery forever, which is a denial the organisation cannot route around;
   bounded, a determined operator delays it by 72 hours and is loudly on record.
6. On expiry, `break_glass_closed`. The capability is gone. Persisting it requires an ordinary grant
   signed by someone.

### 8.3 Prevention, which is where this earns its keep

A scope with exactly one live steward raises a standing warning immediately, escalating in prominence
weekly, and the organisation page shows *"break-glass cannot be armed: `t` holders required, `n`
configured"* until it can. Break-glass that fires once a decade is defensible; break-glass that fires
monthly becomes routine, and routine break-glass is an administrator override wearing a costume. The
cheapest control here is making sure the door is rarely approached — and, per §3.5, making the second
steward reachable so the warning is actionable rather than a nag.

### 8.4 Key loss, succession, and the escrow habit

A lost authenticator is the common case and the earlier draft made it expensive enough to be
dangerous: with `subject_key_fpr` inside the signed bytes, a replacement key invalidates every grant
naming the old one, so one dropped laptop becomes a re-signing campaign across a thousand-device
estate — and where the lost key belonged to a scope's only steward, a Shamir reconstruction. The
observed response to that is not diligence. It is both secrets in the shared password manager for
everyone on enrolment day, at which point the whole *"an administrator provably cannot mint a grant"*
claim collapses to the strength of a store built for sharing, which the administrator often also runs.

Three changes:

- **Signed key succession.** `account_keys.succession_sig` is the old key's assertion over
  `LP("fathom/key/succeed/v1") ‖ LP(old_fpr) ‖ LP(new_fpr) ‖ u64(at)`, sealed on the organisation
  chain. Grants carry forward automatically. Succession costs the key holder one touch instead of
  costing stewards *N*.
- **Verification uses the keyring entry live at `effective_from`**, with `granter_key_fpr` inside the
  signed bytes naming which key must have signed — so a rotation never leaves a grant verifying under
  whatever key the keyring currently holds.
- **A succession that cannot present the old key** falls back to ordinary re-granting at the current
  quorum. That is the path a genuinely lost key takes, and it is the reason §4.4 asks for a spare at
  enrolment.

### 8.5 What is refused

If every holder is gone and every printed share is lost, **the organisation cannot be recovered.**
There is no operator escrow, no vendor master key, no support override. Adding one would be the
takeover route with a polite name and would make every other control here decorative, because an
attacker would simply use it. This is the same refusal ADR-0043 §6 makes about the forgotten
passphrase, for the same reason, and like that one it must appear **in the interface at the moment
holders are chosen** — not in a help page discovered afterwards.

---

## 9. When the audit destination is unreachable

This is the case that decides whether the trail is a control or a formality, because it is the case
every deployment hits in its first week.

**Spool in PostgreSQL, not on container disk.** `audit_spool` holds unshipped entries with their own
monotonic sequence. Both containers share it, neither writes a local file, REBUILD-PLAN item 1 holds,
and entries do not die with a replaced container — which is the failure mode that leaves the witness
a permanent, unexplained gap while the deployment's own tip is *ahead*, so quarantine never fires for
the one case that actually lost evidence.

**Bounded by time first, size second.** Default 72 hours or 1 GiB, whichever comes first. Banners to
operators from the first hour and to stewards from the sixth, escalating; `shipper_gap` and
`spool_pressure` entries at each threshold.

**Degrade, do not stop.**

| Spool state | Behaviour |
|---|---|
| Within bounds | everything normal; entries queue; banners escalate |
| Gated changes | settings, contact changes, enrolments and break-glass **do not apply** without a receipt (§5.4), whatever the spool says — they queue |
| Beyond bounds | design **writes** stop; design **reads** continue and keep spooling; the deployment is marked `unwitnessed` in every session |
| Spool physically full | oldest `payload_decrypted` roll-ups are collapsed into counts first; never a lifecycle entry; if still full, writes stop and reads continue |

A previous draft stopped serving design payload entirely when the spool filled, on the principle
*"serve nothing I cannot account for"*. The principle is right and the consequence was not: a
documentation tool that refuses to show the rack diagram during somebody else's SIEM outage is the
control that gets removed from the compose file, and the documented way out — a setting that drops
audit instead — is itself a 24-hour quorum-gated change, i.e. unavailable at precisely the moment it
is needed. Worse, it makes a total outage of every tenant reachable from the admin page by pointing
the shipper at a host that accepts connections and never acknowledges. **Availability is not
defended against the party who holds the machine** (§12), so a fail-closed rule that hands them a
one-click site-wide outage buys nothing and costs the customer everything.

**Shipper endpoint changes dual-ship.** For the whole delay window the shipper sends to the old
endpoint *and* the new one, and the change does not apply until the old endpoint has receipted a
statement naming the new one. This is exactly the reasoning §5.3 applies to SMTP; an earlier draft
failed to apply it to its own witness.

**No witness configured at all.** Permitted, and permanently marked. The startup log line, the admin
page, the organisation pages and the operator's register all say `unwitnessed`; delays are described
as *advisory*; §7.5's guarantees 1 and 2 are documented as absent. The product must never let a
customer believe otherwise, and the four forbidden sentences apply here as everywhere.

**Air-gapped.** Cadence is daily. The witness is a removable-media export plus a printed daily tip
digest plus, optionally, an offline verifier that signs receipts on separate hardware — which is the
only shape that restores §7.5's guarantee 1. Delay windows are advisory and the documentation says
so, because a delay counted by a clock and a heartbeat stream both owned by the attacker is not a
control. A five-minute cadence nobody carries out of the room is theatre, and the product refuses to
configure one in air-gapped mode.

---

## 10. Every takeover route, closed or admitted

The twenty-five routes raised against the leading design, in their original order. "Closed" means
the attacker cannot reach design bytes or authority by that route, not that the attempt is logged.

**1. Create a second operator, second your own change.** Closed at tier 1. Operator creation goes
through §5.5's machinery (two assertions, delay, notice, sealed, alerted); a new operator cannot
second anything until an independent sign-in older than the longest delay window; the admin surface
has no password path (§4.5), so "reset the other operator's password and sign in as them" has nothing
to reset. Residual: one human with two authenticators — collusion, §12.

**2. `INSERT` a forged seconded settings row as `fathom_admin`.** Closed at tier 2. The admin role
has no `INSERT` on anything (§1.3); and the resolver reads the sealed chain, not the newest row
(§5.4), so even the app role's own `INSERT` is inert without an entry whose seal covers the row's
digest. The app's database password leaves the compose file (§1.4), so the privilege fence is about
an attacker who has the admin credential rather than the one the operator typed.

**3. Clear `revoked_at` on your own old grant and never restart.** Closed at tier 2. There is no
`revoked_at`: revocation is a positive row plus an entry, and liveness is a sealed statement in
`organisation_auth_head` (§3.4). Suppressing a revocation now requires forging `head_seal`, which
needs a key that is not in PostgreSQL. Steward grants also carry a mandatory `expires_at`, so
suppression buys a bounded window rather than forever.

**4 and 9. Copy a stored WebAuthn assertion into a new session row.** Closed at tier 3. The challenge
binds the browser-held session public key and is single-use; every design request carries a fresh
signature by the session private key (§4.2). A copied row yields a session whose private half the
attacker does not hold. `row_mac` under `K_sess` is a second, independent fence that stops a tier-2
attacker minting the row at all. Vault-unlock assurance is defined as a signature over the same
challenge, so the "implementer picks something" hole is closed too.

**5. Point the shipper at a black hole, fill the spool, go dark; or disable every account.** Closed
as a confidentiality route; **admitted as an availability route.** §9 degrades instead of stopping and
dual-ships endpoint changes; account disable is rate-limited, notifies every steward of every scope
the account holds, and any steward may re-enable a member of their own organisation. But an operator
holds the machine and can stop it — §12 says so plainly rather than pretending a quorum fixes it.

**6 and 17. The one-steward organisation, bricked and then faked.** Closed. Quorum is
`min(2, live stewards)` (§3.5), so a sole steward appoints a second alone under delay, banner and
cancel; the 30-day block on new networks is dropped; `CHECK (granter_kind = 'org_root' OR subject_id
<> granted_by)` no longer forbids the row genesis requires, and genesis is signed by the organisation
root key rather than self-signed by an account (§6.1), so the contradiction disappears entirely.

**7. Disable the trigger, delete the inconvenient entries, re-enable, never restart.** Detected, not
prevented, and it is now a tier-3 move rather than a tier-2 one: the audit tables are owned by a
no-login role whose credential is generated into the key volume (§7.7). Detection is continuous
rather than at startup — the witness challenges back each cadence (§7.4) and every security banner
re-verifies `seq` contiguity and `prev_seal` before rendering.

**8. Re-mint the genesis grant of an existing organisation.** Closed at tier 3. The organisation id
is derived from the organisation root public key and recomputed at every authorisation that chains to
genesis (§6.1). A re-minted genesis under any other key is a different organisation and matches
nothing.

**10. Write the cached verdict instead of the grant.** Closed at tier 2. No verdict is ever stored;
what is memoised is the live set, in process memory, keyed by `(organisation, auth_epoch)`, re-derived
per container from sealed rows (§3.4).

**11. Resurrect a revoked grant.** Same as route 3, plus: the revocation set is a runtime input
re-read on every epoch change rather than a startup-only comparison, and `auth_epoch` monotonicity is
checked against an in-process high-water mark, so the "never restart" half of the route stops helping.

**12. Roll back the database and its anchor together.** **Admitted at tier 3 for an unwitnessed
deployment; closed where a witness exists.** The local `anchor.log` is removed for the reasons in
§7.6; detection is the witness's receipts, the in-process high-water marks, and the clients' own
remembered tips. With no witness and no user working at the time, a tier-3 rollback is not detected.
Stated in §12 rather than claimed away.

**13. Ship a forged chain at the correct cadence.** Closed only by the witness (§7.5). Where receipts
exist, the fabrication cannot be receipted and verification fails. Where they do not, the honest
statement replaces the guarantee: post-compromise entries are signed by the compromised party and are
evidence about nothing.

**14. Burst the heartbeats to collapse every delay.** Closed where a witness exists. Delays elapse on
witness receipt timestamps, not on local heartbeat counts or the host clock, and the far end alarms
on cadence too fast as well as too slow (§7.4). Air-gapped: advisory, and documented as such.

**15 and 24. Create a colleague, second yourself, and look compliant.** Closed at tier 1, as route 1,
with one addition aimed squarely at the incentive: the honest path (single-operator mode) must not be
more expensive or more embarrassing than the dishonest one, so it is a supported configuration that
keeps the delay, the notice and the receipt, and declares itself at every startup.

**16. Substitute the client bundle.** **Bounded, not closed.** The self-reported `client_build_digest`
is not detection — the measurement is taken by the thing being measured — and the design says so.
Release hashes are published out of band and the witness compares the shipped digest against the
published hash for the running version, which catches a mismatched *claim*. What bounds the damage is
that grants are hardware assertions (§3.3): a captured vault mints nothing, batch signing is capped
and rendered, and minting steward authority requires catching a real steward at a real touch,
prospectively. That last sentence is the guarantee worth defending; it is the only one on this list
that tier 3 does not defeat outright.

**18. Point the shipper at rsyslog on the same host.** Closed as a *claim*, which is the part that
matters: an un-countersigned target is never called an anchor, the deployment is marked
`unwitnessed`, and the last independent countersignature is shown on the admin page, in the startup
log and in the register (§7.4). The operator may still choose it; nobody may believe it is off-box.

**19. The lost laptop and the password-manager habit.** Closed by signed key succession,
`granter_key_fpr` inside the signed bytes, a spare authenticator asked for at enrolment, and a signing
key that is hardware and therefore cannot be escrowed at all (§8.4).

**20. Anchors and spool break the two-container rule and train operators to dismiss quarantine.**
Closed. Both live in PostgreSQL; quarantine compares only against shared state; an air-gapped local
anchor is a single-writer sidecar the server reads and never writes (§7.6, §9).

**21. Copy the rack instead of moving it.** Closed by gating the outcome — cross-scope device
reparenting and emptying a non-empty scope carry the same co-signature as a move — and by making the
sanctioned path cheaper with a capped, rendered batch (§3.6).

**22. The bootstrap escape hatch.** Closed by rule rather than by flag: a setting with no prior
applied version applies immediately (§5.3), the first operator token and the first organisation claim
are written to the key volume rather than mailed (§6.3). There is no global skip to find later.

**23. Air-gapped delay counters that never elapse.** Closed. Heartbeat requirements derive from the
cadence in force when the request was filed, floor 2; a cadence change that would shorten an in-flight
window is refused (§7.4).

**25. Notification flood until nobody reads the window.** Closed by separating routine from alarming:
a holder's own self-service change notifies the holder alone; only an operator-initiated action
against someone else's account reaches stewards, and it reaches them as an in-product blocking
acknowledgement rendered from the chain, with mail as a copy rather than the channel of record;
everything else is digested and rate-limited. **And it is measured:** if a steward receives more than
a handful of these a month, the cancellation window is not a control and this document's claims that
lean on it must be revised rather than repeated.

### 10.1 The original list, for completeness

| Route | Closed by |
|---|---|
| Reset a password, sign in as them | `A0` session; per-request proof (§4) |
| Change the target's email, then "forgot password" | two operators, 72h, notice to the **old** address, steward cancel (§5.2); and the reset is still `A0` |
| Change SMTP so mail comes to them | two operators, delay during which the **old** settings apply, receipt-measured window (§5.3); and the reset is still `A0` |
| Flip `memberships.role` to admin | `role` no longer decides design access (§3.1) |
| Insert a scope grant for themselves | composite FK on principal kind; no admin `GRANT`; signature fails at read (§3.2–3.4) |
| Create an organisation and nominate themselves | bounded to empty shells, permanently marked (§6.2) |
| Invite a fresh account they control | the subject must already hold an enrolled key, and the grant still needs a steward's touch (§6.4) |
| `move_subtree` someone else's rack | steward at both ends, co-signed, notified (§3.6) |
| Restore an old backup | quarantine against receipted anchors; sealed `restore_performed`; banners (§7.6) |
| Delete or rewrite audit rows | `REVOKE`, trigger, no-login owner role, seal, witness challenge (§7.4, §7.7) |
| Stop the shipper | heartbeats, receipts, spool, degradation (§7.5, §9) |
| Add a "log in as user" feature | there is none. If support ever needs one: the target approves in their own live session, 30-minute box, `A0` so no design payload, sealed and bannered |
| Wait to be the last person standing | a stewardless scope promotes nobody; recovery is the organisation root key, not an operator power (§8) |
| Ship a modified client bundle | bounded, not closed (§10 route 16, §12) |
| Set the clock forward | witness receipt timestamps; `clock_step` entries; far end alarms on fast cadence (§7.4) |
| Use SMTP test-send as a delivery oracle | only to the requesting operator's own verified address, rate-limited, sealed (§5.3) |
| Swap a public key and replay an old grant | `subject_key_fpr` and `granter_key_fpr` inside the signed bytes; append-only sealed keyring (§3.3) |
| Reduce a quorum to one | quorum changes are quorum-gated, delayed and receipted; single-operator mode declares itself at every startup (§5.3) |

---

## 11. What it costs

### 11.1 Schema

Six migrations, `0004`–`0009`:

- **0004 `principals`** — the `principals` table, generated `kind` columns and composite foreign keys
  on `accounts` and `memberships`, the `operators` table, `site_install` with its un-updatable
  `notice_address`.
- **0005 `authority`** — `organisation_roots`, `account_keys`, `scope_grants`, `grant_revocations`,
  `organisation_auth_head`, `recovery_holders`.
- **0006 `sessions`** — `sessions`, `session_nonces`.
- **0007 `admin_surface`** — `change_requests`, `site_settings_versions`, `operator_enrolments`, the
  `SECURITY DEFINER` seconder-eligibility trigger.
- **0008 `chains`** — `chain_entries` (one table discriminated by `chain_kind`/`chain_id`, serving
  site, organisation, per-design edit and per-design read chains), `chain_receipts`, `chain_anchors`,
  `audit_spool`, the append-only triggers, the `fathom_audit` owner role.
- **0009 `planes`** — the two database roles and their grants; the operator `FOR SELECT` policies; the
  `app.design_capability` policy on `design_payload`.

Three notes that belong in the migration comments themselves, not only here:

**The operator policies are `FOR SELECT` and never `FOR ALL`.** A `USING` clause with no `WITH CHECK`
on a `FOR ALL` policy is reused as the write check, and this branch as a write check reads *"any
operator transaction may insert any membership row it likes"* — migration 0003's bug with a new name.
The comment must say so and a test must insert a membership from an operator transaction and expect a
policy violation.

**Withholding the `GRANT` is the fence; the policy is only how the admin pages get their rows.**
The 0003 policies are role-agnostic and evaluate to zero rows for a transaction with no
`app.tenant_id` and no membership, so an admin plane with grants and no policies reads nothing at all.
Each added policy is a new place for the 0003 failure mode to live, which is why there are exactly
three and all are `FOR SELECT`.

**`app.design_capability` is set from a verified authorisation and nothing else:**

```sql
CREATE POLICY design_payload_readable ON design_payload
    FOR SELECT USING (
        organisation_id = current_setting('app.tenant_id', true)
        AND current_setting('app.design_capability', true) = 'yes');
```

`authorise_operator` sets it to `no` before examining anything; absence (the empty string) is already
a refusal, so a code path that forgets to set it fails closed. This is the fence that closes
REBUILD-PLAN's stated hole *below* the handler, in the database, for every query anyone writes later.

### 11.2 Code

- `repo::authorise` splits into `authorise_account` — which returns verified `Capabilities`, not a
  bare `Role`, and performs §3.4's seven steps — and `authorise_operator`, which sets
  `app.operator_id` and `app.design_capability = 'no'` and **has no argument from which it could set
  `app.tenant_id`**. Because that setting stays empty, every policy in 0002 and 0003 already returns
  zero rows for an operator transaction; no new policy is needed to keep an operator out of tenant
  data, and a policy nobody wrote is a policy nobody can later edit.
- `add_member` becomes `sign_grant` / `second_grant` / `suspend_grant` / `revoke_grant`, each writing
  row, entry and head in one transaction.
- `move_subtree` gains the two-ended steward check and the co-signature; `reparent_devices` and
  `delete_scope` gain the same gate.
- A second connection pool and a second database role; a third, no-login role owning the audit tables.
- The chain writer generalises from per-design to four chain kinds. Mechanically small: storage §11.2 and §12
  already fix the construction and storage §12.2's derivation shape gains three labels.
- A shipper with a PostgreSQL-backed spool, replay, heartbeats, receipt verification and the
  challenge-response handler.
- Server-side WebAuthn verification, used for three things rather than one: sign-in, grant signing,
  and operator seconding.
- Browser: session keypair generation and per-request signing; assertion-based grant signing with the
  canonical list rendering; Shamir split and reconstruct at organisation creation and break-glass.

### 11.3 Dependencies — the largest single item, and unverified

Public-key signatures are unavoidable: the whole design rests on the server verifying something it
cannot produce, and an HMAC cannot do that, because a verifier that can check can also forge. So this
adds, at minimum, a signature primitive and server-side WebAuthn verification, plus Shamir secret
sharing in the browser.

**Nothing below has been looked up. Per CLAUDE.md rule 1 and ADR-0034, none of it may be read as
though it had.** Before any of this is built:

1. A dated lookup per crate against **both** advisory databases with working controls — RustSec and
   the crates.io subset of the GitHub Advisory Database, which storage §12.5 added as a gate input precisely
   because RustSec alone missed a live advisory on the chain MAC's own path.
2. A `deps/decisions/` record per crate, per ADR-0032, including for anything already in the closure
   that this design names in a manifest for the first time.
3. `cargo tree` against the recorded cap of 160 external crates — roughly 123 are projected after
   the four cryptographic roles storage §12.4 costs, so the headroom is real but not generous.
4. **An explicit `multiple-versions = "deny"` check.** Storage §12.4 records a near-miss where the version in
   an approved decision record could not actually be used because it split a major in the graph. A
   signature crate pulling a different RustCrypto `digest`/`sha2`/`rand_core` series than the
   lockfile already carries fails the gate in exactly that way, and it is checkable from the repo
   before anyone writes code.
5. **A decision on the COSE algorithm.** Whether to verify `ES256` only, `EdDSA` only, or both
   changes which crate is needed and which authenticators work. It is a lookup, not a preference.
6. **The WebAuthn verification steps themselves must be read from the current specification text**,
   not reproduced from memory — challenge comparison, origin check, `rpIdHash`, the user-presence and
   user-verification flags, algorithm restriction, and what the sign counter does and does not prove.
   This document states the shape; it does not state the specification.

**If WebAuthn verification proves too heavy to take**, the fallback is software signing keys stored
encrypted under ADR-0043's vault key — which costs no new WebAuthn surface, keeps every structural
property in §3, and gives up exactly one thing: §10 route 16's bound, because a substituted bundle
then captures the signing key at the next unlock, and §8.4's escrow habit returns. That trade must be
made deliberately and recorded, not discovered.

### 11.4 Daily friction for a working network engineer

- **First sign-in:** register two authenticators, enrol a vault key. The vault half ADR-0043 already
  required; the second key is new and takes a minute once.
- **Every day:** sign in with the passkey, open designs. **Zero additional steps.** This matters more
  than anything else in this section — a model that taxes ordinary work gets disabled.
- **New laptop:** register from an existing authenticator, a vault unlock, or a steward-co-signed
  token. Genuinely new friction, the same shape as ADR-0043's printed vault key, and the reason the
  spare exists.
- **Granting a colleague read access:** one touch, one click. Weekly at most in a settled estate.
- **Promoting a steward:** two touches — or one plus a 24-hour delay in a sole-steward organisation.
- **Moving a rack between buildings:** two touches. Batch for a migration.
- **Go-live import:** one touch covers a rendered, capped batch.
- **For the operator:** settings changes need a second operator and a day; single-operator mode keeps
  the day and the notice. In a one-person shop that is a real cost and it is the honest one.

### 11.5 If it lands in stages

The composite foreign keys on principal kind, the two database roles, the withheld privileges, the
`app.design_capability` policy and the app-password-out-of-compose change are cheap and close the
crudest routes on their own. The chains reuse work already specified. Signatures and WebAuthn are the
expensive half and can follow — **provided the schema carries the signature and seal columns from the
first migration.** Retrofitting a signed grant onto unsigned rows means either invalidating every
existing grant or accepting a permanently unsigned tail, and the second is a hole with a date on it.

---

## 12. What this does not protect against

**Root on the host, or a shell in the container (tier 3).** They hold the master key, the chain key,
the session MAC key and the client bundle. **They read every design the server can decrypt, directly,
with `psql` and forty lines of code, and no `payload_decrypted` entry is written because the
application is never involved.** They forge chain entries from that moment forward and stop the
shipper. What survives: entries the witness already holds; the receipt chain they cannot mint; the
vaults, per ADR-0043, until the next unlock under their bundle; and the inability to mint steward
authority in an existing organisation without a real steward's touch.

**A malicious client build.** The same server serves the JavaScript, so a compromised instance can
ship a client that captures vault secrets at the next unlock. Recording the build digest as a chain
entry is *not* detection — the measurement is taken by the thing being measured. Out-of-band
published hashes compared by the witness catch a mismatched claim. Subresource integrity is not a
control when the same server serves the page declaring it.

**Availability.** An operator holds the machine and can stop it: the process, the database, the
network, the accounts. Nothing here defends uptime against the party who runs the deployment, and the
design deliberately chose degradation over fail-closed in §9 rather than hand them a one-click
site-wide outage dressed as a security control.

**An operator who is also a legitimately granted steward.** Separation of duties is a fact about
people. The product can refuse to let one *principal* be both, flag a shared address, and seal every
identity switch. It cannot stop one person holding two hats they were both properly given.

**Collusion, and the one-person deployment.** Every quorum is a bet that the named number of people
will not act together. A single engineer with two accounts, two authenticators and two mail aliases
satisfies every two-signature control in the product while the audit faithfully records two. §3.5
removes the *reason* to do this; it cannot remove the ability.

**A steward exfiltrating what they may see.** Nothing here is data-loss prevention. Someone with
`read` can screenshot, export, or retype.

**Revocation is not retroactive.** A revoked member keeps everything they already opened. The
interface must say so at the moment of revocation, and the remedy for a genuinely burned design is
the same as for a burned credential: change the underlying thing.

**Metadata.** `PHASE-2-STORAGE-DESIGN.md` §11.3 stands unchanged, and the audit trail makes it
*richer* — which is why §7.3 encrypts entry metadata. Ids, types, sequence and timing stay in the
clear by necessity, and they are informative.

**Physical theft of the host.** ADR-0043 §5. Host disk encryption is the operator's job.

**An empty organisation shell bootstrapped by an operator who controls SMTP.** §6.2, deliberate,
bounded, and permanently marked on that organisation's page.

**A single-operator deployment.** One signature with a delay, a notice and a receipt is weaker than
two, straightforwardly. It is offered because the alternative is customers disabling the mechanism,
and it announces itself at every startup.

**An unwitnessed or air-gapped deployment.** With no countersigning far end: §7.5's guarantees 1 and
2 are absent, delay windows are advisory, and a tier-3 rollback of the database is not detected except
by whichever browsers happened to be working at the time. The product marks itself `unwitnessed` and
the documentation says this in these words.

**`DROP CONSTRAINT`, `DISABLE TRIGGER`, `DROP POLICY`.** The schema owner can remove the constraint
fences. The schema fingerprint and the witness challenge detect it; nothing prevents it. That is why
§2's table says tier 2 for every constraint-backed claim.

**The per-request proof assumes the check is actually run.** It is one code path in the design-serving
handler. It needs a test asserting that a session without a valid request signature receives a
refusal for design payload, and another asserting an `A0` session does. Those two tests are the thing
standing between this design and a very quiet regression.

**And an accounting boundary rather than a security one:** an audit trail proves what the
*application* recorded. It does not authenticate intent, and it cannot tell a legitimate grant from a
coerced one.

---

## 13. What authentication must later provide

There is no authentication layer; `repo.rs` says so plainly in its own module documentation and this
design does not pretend otherwise. The list it must satisfy:

1. **`actor` comes from a session, never from the caller.** Every guarantee here rests on that one
   sentence.
2. **A session carries exactly one principal**, and its kind is recorded. Operator sign-in is a
   separate surface on the `fathom_admin` pool.
3. **Assurance is evidence bound to the session, not a flag and not a stored record of a past
   ceremony** (§4.2): a browser-held session keypair, a challenge that binds it, single-use nonces,
   and a signature on every request that reaches design payload or vault ciphertext.
4. **Sessions are rows, not memory** — REBUILD-PLAN item 1 — and §4.3 satisfies it as a side effect,
   with a `row_mac` so a row is not mintable from SQL alone.
5. **WebAuthn registration, succession and removal** per §4.4 and §8.4, including that the last
   authenticator cannot be removed by an operator and that two are asked for at enrolment.
6. **`accounts_insertable ... WITH CHECK (true)`** in migration 0003 already names itself as the diff
   to look for. This design adds that the insert must create the `principals` row with
   `kind = 'account'` **in the same transaction**, or the composite foreign keys make the account
   useless. It also adds that registration must answer `OPEN-QUESTIONS.md` B5 — whether a stranger
   may create an account and an organisation — because §6.2's shell path assumes the answer is no.
7. **Rate limiting, lockout, and the sign-in surface itself**, which this design does not specify.
8. **`OPEN-QUESTIONS.md` C2 binds the operator surface too.** If device passwords are ever accepted
   for sign-in, §4.5's "no password path on `/admin`" is the line that must not move.
9. **Directory sync is a provisioning source, not an authority** (§3.7, 2026-09-12). An LDAP or
   Active Directory connector may create accounts and place them in synced groups; it may not grant,
   second, or hold stewardship, and its own bind credential is vault-held. If sign-in against the
   directory is ever offered, the session rules above apply unchanged: `actor` still comes from a
   Fathom session bound to a browser-held key, never from the directory's say-so.

---

## 14. Build order, and the tests that must exist

Ordered so that each step is useful alone and none of them has to be undone.

1. **Roles and privileges** (0009's role half, brought forward), the app password out of the compose
   file, and the two privilege tests in §1.3. Cheap; closes tier-2 crudeness immediately.
2. **`principals` and the composite foreign keys** (0004). Cheap; the strongest constraint fence in
   the document.
3. **`app.design_capability`** and its policy. One policy, one setting, one test that an operator
   transaction reads zero payload rows.
4. **The chains** (0008), heartbeats, the spool, and routine verification — reusing storage §11.2 wholesale.
5. **Sessions and the per-request proof** (0006). Nothing above depends on it; everything about
   takeover does.
6. **Authority** (0005): keys, grants, revocations, the head, `authorise_account`'s seven steps, the
   organisation id derivation.
7. **The admin surface** (0007) and the execution interlock.
8. **Receipts and the witness protocol**, then break-glass.

The tests that must exist before any of this is described as working, in addition to the workspace's
standing gates:

- `fathom_admin` cannot `SELECT` design payload, and cannot write to any table in the schema.
- An operator transaction cannot insert a membership (the 0003 failure mode, in its new location).
- An operator transaction reads zero rows from `design_payload` even with a tenant id supplied.
- A hand-inserted `scope_grants` row grants nothing.
- Editing `capability` on a real grant grants nothing.
- Deleting a `grant_revocations` row does not restore the grant (the head no longer verifies).
- A session row copied from another account's assertion yields a refusal for design payload.
- A session with no request signature yields a refusal for design payload.
- An `A0` session yields a refusal for design payload.
- A settings row with `sealed_seq IS NULL`, or whose digest is not inside the named entry, never
  resolves — and raises `setting_unresolvable`.
- A re-minted genesis under a different root key authorises nothing.
- A rolling deploy of two replicas does **not** trigger quarantine (the regression §7.6 exists to
  prevent).
- Chain verification reports `broken at entry N` for a deleted entry, and the banner path refuses to
  render rather than rendering from unverified rows.

---

## 15. Primitives and proportionality — decided 2026-09-12

### 15.0 Two naming and privilege calls, decided 2026-09-12

**The operator database role is `fathom_operator`, not §1.3's `fathom_admin`.** `memberships.role`
already carries the value `admin`, and an `admin` there is a **steward** — the exact confusion this
document's whole vocabulary exists to prevent. §1.3 is amended rather than the code. `operator` is
also the word §0 already uses for the machine side, so the code now matches the design's own language
instead of cutting across it.

**The migration role and the runtime role are separated.** Until now one role owned the tables, ran
the migrations and served requests — and building `0005` added `CREATEROLE` to it, because roles are
created inside the migration chain.

*Roles stay in the migration chain.* The alternative, provisioning them in the container's init
script, runs **once, at database creation**: a role added by a later migration would silently never
appear on an existing deployment. That is invariant 11's failure shape exactly — works on an empty
database, fails where there is data — and it is worse than the privilege it saves.

*But the runtime role must not carry that privilege.* A role that owns every table, can issue DDL and
can create roles, used to serve every request, is the one-credential-does-everything pattern this
whole design exists to refuse. **Two roles: a migration role that owns the schema and holds
`CREATEROLE`, used once at startup and then dropped; and a runtime role with data privileges only —
no DDL, no `CREATEROLE`, no ownership.** An injection at runtime then cannot reshape the database or
mint a role, and the cost is one extra connection string.

Both decisions are reversible and the owner's to overrule.


§11.3 flagged every primitive claim here as not looked up. They are now looked up, against both
advisory databases cloned locally with working controls, and against seven comparable products read
in their own repositories. **Two design errors were found in the process and are corrected in §3.3.**

### 15.1 Hardware authenticators are NOT required for v1. Software keys are the default.

**This is the biggest change to the design and it is a deliberate downgrade.** The evidence:

| Product | Second factor | Fallback |
|---|---|---|
| NetBox | **none at all** | — |
| Nautobot | **none** (SSO only) | — |
| LibreNMS | TOTP only | — |
| Passbolt CE | TOTP, Duo, YubiKey — **no WebAuthn** | — |
| phpIPAM | passkeys, **off by default**, behind an optional library | password |
| Vaultwarden | TOTP, Duo, WebAuthn | **printed recovery code, every enrolment** |
| authentik | TOTP, WebAuthn, Duo | **static backup codes** |

Three tools in this market require no second factor at all. NetBox's own threat model says outright
that infrastructure operators and superusers are *trusted* — which is less than this design attempts
with software keys alone. The only network tool here with passkeys ships them off by default. Both
products that *can* require WebAuthn ship a printed fallback as standard equipment.

**A design that opens with "buy two security keys per person before you can create your first rack"
does not get evaluated on a Friday afternoon. A design nobody deploys protects nothing.**

**What software keys keep — which is nearly everything structural:** the composite `principals
(id, kind)` foreign keys, so an operator is unrepresentable in any authority row at every privilege
level including `psql` as superuser; grants as signatures over canonical bytes verified at use;
`organisation_auth_head`; the organisation id derived from the root public key; two database roles
and withheld `GRANT`s; `app.design_capability`; the app password out of the compose file; the
execution interlock.

**What it gives up, and §11.3 understated this.** §2's table row *"produce a grant signature —
Signature — tier 3"* becomes **"tier 3 until the next unlock under a substituted bundle"** — the
same caveat §2 already attaches to the vault row, for the same reason. One bundle substitution plus
one unlock mints grants for that steward indefinitely, where hardware would have required catching a
real steward at a real touch, one grant at a time. **At tier 1 and tier 2 a software key is exactly
as strong as hardware.** Set against what §12 already concedes — tier 3 reads every design directly
with `psql` — what hardware buys is narrow: it stops the minting of durable authority, not reading.

**Shipped as `FATHOM_REQUIRE_HARDWARE_STEWARD=false`**, same shape and honesty as
`FATHOM_SINGLE_OPERATOR`, with a sealed entry at startup recording which mode is in force.
**Deferring it costs no migration at all** — it is policy on top of `0005`, which is exactly why it
can wait. It is a very good trade at v2, as an opt-in.

**§4.5 stays hard even so: the operator surface has no password path.** With software keys, operator
`A1` means "signed a challenge with a key protected by both ADR-0043 secrets" rather than "touched
hardware" — and that still closes the route, because the server can re-issue a password and cannot
re-issue the vault key. **Keep the rule; relax the factor.**

### 15.2 Shamir is staged last, and its shape is reconsidered

HashiCorp Vault's own documentation, on the most widely deployed use of Shamir in the industry:
*"For most users, auto unseal provides a better experience"* — and *"if the seal mechanism or its
keys are permanently deleted, then the Vault cluster cannot be recovered, even from backups."* The
3 a.m. reboot failure does not transfer, because Fathom's split is not a startup gate. **The other
one does: shares get lost, and Vault's remedy was to replace the mechanism rather than improve share
custody.**

With software keys the organisation root private key can instead be wrapped to each named recovery
holder's account key, so any one of *k* named holders recovers alone. **That is weaker on paper and
must be said so** — but every recovery is still announced before it issues, bannered for its
duration, vetoable and expiring per §8.2, and it removes the artefact that must survive years in a
safe and work exactly once under pressure. If the split stays: **`vsss-rs 6.0.1`, and `sharks` is
refused by name** — it carries RUSTSEC-2024-0398 with **no patched version**, and `deny.toml`'s own
policy is that an advisory with no fix is an escalation, not an ignore line.

### 15.3 The signature primitive: ES256, `p256 0.14.0` + `ecdsa 0.17.0`

EdDSA would have been ten crates cheaper and was the better primitive on paper. **It was rejected
because FIDO's metadata service was unreachable, so which authenticators support EdDSA could not be
established** — choosing it would have meant betting on an unverified belief, which rule 1 forbids.
ES256 is the choice that does not need the lookup that could not be done. Revisit if that service
becomes reachable.

One family covers all three signing roles: WebAuthn assertions, §4.2's browser session key, and
§6.1's organisation root key. Closure: 113 external crates today → 139 with ES256 (160 cap). Exactly
one duplicate in the projected graph, `syn` 2.x/3.x, already skipped. No C carriers. Advisory sweep
over all 93 projected crates in both databases: every hit is against a version below what resolves.

**Constant-time is barely relevant to the server here and the design must not claim it is.** The
server only verifies; there is no secret scalar in this process on this path. It matters for
browser-side reconstruction and nothing else new.

### 15.4 WebAuthn verification is hand-written, and that is allowed

**No Rust crate passes this project's bar.** `webauthn-rs 0.5.5` depends on `openssl` and
`openssl-sys`, both banned by name in `deny.toml` on C7 grounds — not negotiable by feature flags.
`webauthn-rs 0.6.1-dev` is worse: a pinned prerelease pulling `rsa`, which carries the Marvin Attack
advisory **with no fixed version**. `passkey-*` pins five crates a major behind the lockfile.

**Hand-writing does not break the "never hand-roll a primitive" rule, because assertion verification
is not a primitive.** It decomposes into a fixed-layout binary parse, a byte comparison, one
SHA-256, and one signature verification. Only the last two are primitives and both are crates.
This is the same category as the sealed chain this project already writes itself.

**And the specification makes it cheaper than this document assumed.** WebAuthn Level 3's Limited
Verification Algorithm gives a byte-prefix comparison for `clientDataJSON`, explicitly for verifiers
that cannot support a full JSON parser. **So the assertion path needs no JSON parser and no CBOR
parser** — `serde_json`, `ciborium` and `coset` all come off the closure. CBOR is needed only at
registration, for a small fixed COSE_Key map, parsed by hand rather than trusting the browser's
`getPublicKey()` output, since §12 already says the bundle can be substituted.

**Require ES256 (-7). Refuse RS256 (-257)** — supporting it means taking `rsa` and its unfixed
advisory. That excludes some older TPM-backed Windows Hello credentials; say so in the register
rather than letting it be discovered. ES256 assertion signatures are DER-encoded, so a DER parse of
attacker-supplied bytes sits on the verification path: **fuzz it.**

### 15.5 A second instance of the gate gap, and two stale reasons

`GHSA-22w3-693w-x895`: `webauthn-rs-core`'s origin check used a suffix match without requiring a dot,
so `hermit-crab.example` was accepted for RP ID `crab.example`. **It is not in RustSec** — the second
such case after the `cmov` finding in `PHASE-2-STORAGE-DESIGN.md` §12.5, and this one is in an origin
check. The GitHub Advisory Database is not optional as a gate input.

Separately, `deny.toml`'s two `[[bans.skip]]` entries name the wrong reachers — other crates reach
both `syn` majors now — and they pin exact versions, so any `cargo update` trips the gate until the
skip is edited. Correct behaviour; wrong recorded reason, in a file whose entire value is that a
human read the reason.

Also settled in passing: **`argon2` and `chacha20poly1305` are clean in both databases** as of
2026-09-12, closing ADR-0043 §11's open item.

### 15.6 The order to build in

**Load-bearing — these deliver the owner's sentence:**

1. **`0004 principals`** — the composite-kind foreign keys. Pure schema, no friction, no crate, and
   the strongest fence in this document. **On its own it delivers "an administrator cannot take over
   the site."**
2. **`0009 planes`** — two roles, withheld grants, read-only admin pool, `app.design_capability`, and
   the app password out of the compose file. Closes tier-2 crudeness. No friction.
3. **`0005 authority`** — take the tables and the signature columns **now**, fill them with software
   keys. §11.5 is right that retrofitting means invalidating every grant or accepting a permanently
   unsigned tail. Take the schema; defer only the factor.
4. **`0006 sessions`** — the highest value per unit of friction in the document, and it needs no
   WebAuthn: a non-extractable browser keypair costs the user **zero** extra steps and defeats the
   copied-assertion attack of §4.1, which works at tier 2, not merely tier 3.

**Stageable:** `0008 chains` (reuses the storage construction wholesale; no friction, ship early
anyway), then `0007 admin_surface` and the interlock, then receipts and witness, then break-glass.

### 15.7 Before any of this merges

Nothing above was run against the repository's own gates — the reviewer has no write tools, and the
closure figures come from an isolated probe, so several crates resolved one patch above what the repo
pins. **Re-run `cargo tree`, `cargo deny` and `cargo audit` in-repo with `--locked`, and re-run both
advisory sweeps, immediately before merge.** Both results go stale from the moment they were taken.
Crates.io publish dates were unreachable, so cooldown was checked against git tag dates as a proxy —
`der 0.8.2` is on the seven-day boundary and `hybrid-array 0.4.15` is four days old, which bites only
if anything is added without `--locked`.

New `deps/decisions/` records are needed for `p256`, `ecdsa`, `elliptic-curve`, `crypto-bigint`,
`der`, `sec1`, `signature`, `subtle`, `zeroize`, `vsss-rs`, and the already-flagged `hmac` and `sha2`.

---
## Disagreements

None with `.context/conventions.md`.

One extension to an artifact this document does not own: `PHASE-2-STORAGE-DESIGN.md` §12.2 owns the
chain-key derivation labels, and §7.1 above adds three (`site`, `org`, `read`) plus the row-seal
subkey label in §3.4. They are raised here and must land in that document's own table rather than
existing only in this one, per the precedence rule.
