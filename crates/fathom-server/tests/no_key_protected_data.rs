//! Successor to `stores_nothing.rs`, and **its premise changed with
//! `migrations/0007_key_hierarchy_and_designs.sql`.**
//!
//! # What this gate used to say, and why that sentence is now false
//!
//! `tests/stores_nothing.rs` forbade any table but the migrations table,
//! because ADR-0040 requires a data key per tenant **and** per design from the
//! first stored byte and `docs/OPEN-QUESTIONS.md` A1 -- where the master key
//! lives -- was open. This file then narrowed that to an allowlist of tables
//! that carry identity and structure, each claiming to hold **no design
//! payload, no device credential and no wrapped key**.
//!
//! ADR-0043 answered A1. `0007` creates the first tables that DO hold
//! key-protected material: wrapped keys, and the ciphertext of every design.
//! So the old claim -- "nothing here is protected by a key" -- cannot be made
//! about this schema any more, and **adding those tables to the old allowlist
//! would have been a lie in a list that exists to be true.**
//!
//! # What it says now, and why this is the stronger gate
//!
//! Three claims, in ascending order of how hard they are to fake:
//!
//! 1. **Every table is declared, and declares its kind.** A table is either
//!    plaintext-by-design, with a stated reason it carries nothing
//!    key-protected, or key-protected, naming the columns that hold the
//!    protected material and the key that protects them. A new table cannot
//!    appear without someone answering that question in the same diff.
//! 2. **A declared ciphertext column is `bytea`.** Checked against the live
//!    schema. Ciphertext in a `text` column means an encoding, and an encoding
//!    is where a plaintext copy gets kept "temporarily".
//! 3. **THE ONE THAT ACTUALLY TESTS THE CLAIM.** A design containing a
//!    distinctive marker is written through the real write path, and then
//!    every column of every row of every table in the database is swept --
//!    with row-level security bypassed, so nothing is hidden -- for that
//!    marker, as text and as the hex a `bytea` renders to. It must appear
//!    **nowhere**. That is a database-wide version of the old "stores
//!    nothing": the payload may be stored, and it may only be stored
//!    encrypted, including in any audit, metadata or diagnostic column
//!    anybody adds later.
//!
//!    It carries a **positive control**: a value that is deliberately in the
//!    clear -- an organisation's display name -- must be FOUND by the same
//!    sweep. Without that, a sweep that silently scanned nothing would pass.
//!
//! # What this gate does not claim
//!
//! It does not claim Fathom cannot read a design.
//! `docs/PHASE-2-STORAGE-DESIGN.md` §2a: the server encrypts, and the server
//! decrypts, because it has to serve designs. This gate is about what a
//! database dump discloses, which is the boundary ADR-0043 §5 draws.
//!
//! `display_name` on `organisations` and `scopes` is still plaintext:
//! `docs/OPEN-QUESTIONS.md` V2 decided in principle that it should be
//! encrypted, and §11.3 cost 3 is why it has not happened yet -- every
//! server-side surface that names a design or a scope loses the name, and a
//! plaintext copy kept in an audit row is the leak returning through a side
//! door. `designs` has no name column at all for exactly that reason.

use std::collections::BTreeSet;
use std::path::Path;

mod support;

/// How a table relates to the key hierarchy. Every table in the schema is one
/// or the other, and saying which is the whole control.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Protection {
    /// Carries no design payload, no device credential and no wrapped key.
    /// **This is a claim about the table, not a hope.**
    NoKeyProtectedMaterial,
    /// Holds key-protected material in the named columns.
    KeyProtected {
        /// The columns that hold it. Checked against the live schema: each
        /// must exist and must be `bytea`.
        columns: &'static [&'static str],
        /// Which key protects them, in one phrase.
        under: &'static str,
    },
}

struct TableClaim {
    name: &'static str,
    protection: Protection,
    /// Why the claim above is true. **Adding a table here is a claim, not a
    /// formality.**
    why: &'static str,
}

const TABLES: &[TableClaim] = &[
    TableClaim {
        name: "_fathom_migrations",
        protection: Protection::NoKeyProtectedMaterial,
        why: "migration bookkeeping -- version numbers, filenames, byte lengths, checksums. \
              Never carries anything about a tenant, a design or a credential.",
    },
    // ---- ADR-0055 stream (a): `accounts` changes kind ---------------------
    //
    // It was `NoKeyProtectedMaterial` with the reason "carries no
    // authentication secret at all -- how an account proves who it is is
    // undecided". `0018` decides it, and one of the two answers IS a
    // key-protected secret, so the old claim cannot be made about this table
    // any more and leaving it would be a lie in a list that exists to be true
    // (this file's own header, on the same move for `0007`).
    TableClaim {
        name: "accounts",
        protection: Protection::KeyProtected {
            columns: &["totp_secret_ct"],
            under: "a subkey of the site chain key (`fathom/credentials/totp/v1`), which is \
                    derived from the chain master behind ADR-0043's provider interface and is \
                    never in PostgreSQL. `0018` §B, and the same construction \
                    `site_settings_versions.value_ct` uses one label over",
        },
        why: "identity -- id, email, display_name, still \"Low -- must be queryable\" per \
              `docs/PHASE-2-STORAGE-DESIGN.md` §1 -- and, since ADR-0055 decision 10, the \
              person's own credential. Three of those columns are declared and one is not, and \
              the difference is the point:\n\
              \n\
              * `totp_secret_ct` IS key-protected: it is the shared secret an app code is \
                computed from, it opens every future code, and it is sealed whole. Declared \
                above.\n\
              * `totp_secret_nonce` is a 96-bit AEAD nonce and `totp_secret_key_epoch` is an \
                integer. Neither is secret -- a nonce is published beside its ciphertext by \
                construction -- and neither is `bytea`-and-ciphertext, so declaring them would \
                claim a protection they do not have. `tenant_keys` and `design_payload` \
                declare only their ciphertext columns for the same reason.\n\
              * `password_hash` is NOT key-protected and `0018` §A argues it at length: a \
                password hash is already the one-way, salted, memory-hard function OWASP and \
                NIST describe, and wrapping it in this server's AEAD would add a second key an \
                attacker who has the database does not need -- and would suggest a property \
                (recoverability) a password hash must never have.\n\
              * `operator_key_hold_until` (`0021`) is a timestamp. `0021`'s own header says \
                why it is not sealed: the seal on an operator's authority is the \
                `operator_keys` row the hold prevents being written.\n\
              \n\
              **No device credential arrives here either** (CLAUDE.md rule 4): this is the \
              PERSON's credential, which is a different noun, and `0018`'s header draws the \
              same line at the schema.",
    },
    TableClaim {
        name: "organisations",
        protection: Protection::NoKeyProtectedMaterial,
        why: "the tenant boundary: id and a plaintext display_name (see the file header on \
              `docs/OPEN-QUESTIONS.md` V2). No design payload, credential or key lands here.",
    },
    TableClaim {
        name: "memberships",
        protection: Protection::NoKeyProtectedMaterial,
        why: "an account's role inside one organisation. Structure, not a secret.",
    },
    TableClaim {
        name: "scopes",
        protection: Protection::NoKeyProtectedMaterial,
        why: "the organisation -> network -> building -> rack hierarchy: opaque ids, a kind, a \
              materialised path built from those ids, and a plaintext display_name.",
    },
    TableClaim {
        name: "principals",
        protection: Protection::NoKeyProtectedMaterial,
        why: "an opaque id, a `kind` of `steward` or `operator`, and a creation time. There is \
              no free-text column at all, so there is nothing a payload could hide in.",
    },
    TableClaim {
        name: "operators",
        protection: Protection::NoKeyProtectedMaterial,
        why: "the machine-side principals -- an opaque id, a display name, a creation time. No \
              authentication secret: `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §4.5 gives the \
              operator surface no password path.",
    },
    TableClaim {
        name: "master_keys",
        protection: Protection::NoKeyProtectedMaterial,
        why: "ADR-0043 §4's stamp, and it holds NO KEY: a `key_id` is \
              HMAC-SHA-256(master key, \"fathom/key/id/v1\") truncated to 8 bytes -- a keyed \
              one-way function of the key, published so that a restore with the wrong key says \
              which two ids differ instead of failing like corruption. Retired rows are kept \
              forever and nothing deletes from this table.",
    },
    TableClaim {
        name: "chain_master_keys",
        protection: Protection::NoKeyProtectedMaterial,
        why: "ADR-0043 §4's stamp for the OTHER root, added by \
              `0008_append_only_fence_and_chain_master.sql`, and it holds NO KEY for the same \
              reason `master_keys` does not: a `key_id` is HMAC-SHA-256(chain master, \
              \"fathom/key/id/v1\") truncated to 8 bytes. It exists so that a lost chain key \
              file -- which startup recreates -- reports the wrong key rather than reporting \
              every history in the database as forged.",
    },
    TableClaim {
        name: "designs",
        protection: Protection::NoKeyProtectedMaterial,
        why: "a design's id, its tenant, its scope, who created it and when. Deliberately NO \
              name column -- §11.3 cost 3 -- so there is no plaintext design name here to \
              leak. The contents live in `design_payload`.",
    },
    TableClaim {
        name: "tenant_keys",
        protection: Protection::KeyProtected {
            columns: &["wrapped_key"],
            under: "the master key, which lives in a file PostgreSQL cannot read (ADR-0043 §1)",
        },
        why: "one random data key per organisation, sealed with `LP(aad_bytes) || key` as the \
              wrapped plaintext (§4's B1 fix). The key itself is never in this database in the \
              clear, and the master key that opens it is never in this database at all.",
    },
    TableClaim {
        name: "design_keys",
        protection: Protection::KeyProtected {
            columns: &["wrapped_key"],
            under: "the tenant key, which is itself wrapped under the master key",
        },
        why: "one random data key per design -- MANDATORY, not preferred (§12.3): random \
              96-bit nonces are safe only because one key covers one design's versions.",
    },
    TableClaim {
        name: "design_payload",
        protection: Protection::KeyProtected {
            columns: &["ciphertext"],
            under: "the design key, wrapped under the tenant key, wrapped under the master key",
        },
        why: "THE DESIGNS THEMSELVES, encrypted whole (§3) -- partial encryption would leak the \
              estate's shape while protecting only the labels. This is the table the sweep \
              below exists for.",
    },
    TableClaim {
        name: "chain_entries",
        protection: Protection::KeyProtected {
            columns: &["metadata"],
            under: "the organisation content key on an organisation entry, and a site metadata \
                    key derived from the chain master on a site entry. A DESIGN entry's \
                    metadata is canonical plaintext in this same column and is declared as \
                    such below.",
        },
        why: "the tamper-evident history at three levels. The MAC tags, sequence numbers and \
              entry types are in the clear by design -- §11.2 keys `content_hash` precisely so \
              that a dump holder cannot use it as a confirmation oracle against a guessed \
              payload. What changed with 0009 is the `metadata` column: on the ORGANISATION \
              chain it is AEAD ciphertext (§7.3), because the vault will file recipient sets \
              and mode changes there and in the clear that is an access map for anyone holding \
              a dump; on the SITE chain it is ciphertext under a key derived from the chain \
              master. On the DESIGN chain it stays canonical plaintext -- an actor, an entry \
              type and two version numbers -- and the design's contents live encrypted in \
              `design_payload`. No key is stored in this table.",
    },
    TableClaim {
        name: "org_content_keys",
        protection: Protection::KeyProtected {
            columns: &["wrapped_key"],
            under: "the tenant key, which is itself wrapped under the master key",
        },
        why: "one random data key per organisation, encrypting that organisation's chain entry \
              metadata (§7.3). Deliberately NOT the chain key -- a routine verifier holds that \
              one, and if it also opened organisation metadata then handing someone the ability \
              to verify a history would hand them the access map. Wrapped under the TENANT key, \
              which is what makes §12.6's re-wrap cover it without touching a byte of it.",
    },
    TableClaim {
        name: "deployments",
        protection: Protection::NoKeyProtectedMaterial,
        why: "one row: this deployment's opaque id and when it was first seen. It is the name \
              the site chain is sealed under (§7.1), so it is append-only by trigger -- but it \
              is an identifier and a timestamp, and there is no free-text column for anything \
              to hide in.",
    },
    TableClaim {
        name: "audit_spool",
        protection: Protection::NoKeyProtectedMaterial,
        why: "sealed entries queued for shipping off the box (§9). It carries exactly §7.3's \
              in-the-clear list -- seq, entry type, chain kind and id, timestamps, \
              chain_key_epoch and the seal -- and DELIBERATELY no metadata, in either form: a \
              copy of the ciphertext here would be a second copy of a thing already stored \
              once, and a copy of the plaintext would be §11.3 cost 3's leak through a side \
              door. A seal is a MAC tag, not a key.",
    },
    // ---- 0011, the authority layer (admin design §3.2) --------------------
    //
    // Six tables, none of them key-protected, and the reason is the same for
    // all six and is the point of the layer: **authority is expressed in
    // PUBLIC KEYS, SIGNATURES AND MAC TAGS.** A signature is not a secret, a
    // fingerprint is a hash of a public key, and a row seal is a MAC tag
    // whose key is the chain key -- which is behind ADR-0043's provider
    // interface and never in PostgreSQL. Nothing here is decrypted to be
    // used; it is verified.
    TableClaim {
        name: "organisation_roots",
        protection: Protection::NoKeyProtectedMaterial,
        why: "the organisation root PUBLIC key, its 16-byte id salt, the chain sequence its \
              genesis was announced in, and a row seal. §6.1 splits or wraps the PRIVATE half \
              on the creator's side and this server never receives it -- see \
              `grants::bootstrap_organisation`, which takes a public key and signatures and \
              nothing else.",
    },
    TableClaim {
        name: "account_keys",
        protection: Protection::NoKeyProtectedMaterial,
        why: "one row per enrolled signing key: the PUBLIC key, its fingerprint, the algorithm, \
              and a succession signature. §1.3 withholds it from the operator plane not because \
              it is secret but because a keyring is the map of who can sign what; the private \
              halves are §15.1's software keys, held wherever the steward holds them, and are \
              not in this database in any form.",
    },
    TableClaim {
        name: "scope_grants",
        protection: Protection::NoKeyProtectedMaterial,
        why: "who may open which scope, and the signature that says so. Every column is either \
              an opaque id, a capability word, a timestamp, a public-key fingerprint, a \
              64-byte signature or a MAC tag. §11.3's standing disclosure applies -- the \
              permission map is structure and is readable from a dump -- and that is stated \
              there rather than re-litigated here.",
    },
    TableClaim {
        name: "grant_secondings",
        protection: Protection::NoKeyProtectedMaterial,
        why: "the second signature §3.5's quorum needs. Same shape as `scope_grants`: ids, a \
              fingerprint, a signature, a seal.",
    },
    TableClaim {
        name: "grant_suspensions",
        protection: Protection::NoKeyProtectedMaterial,
        why: "append-only suspend/unsuspend acts. Ids, a word, a timestamp, an optional \
              fingerprint and signature, a seal. The one authority table an OPERATOR principal \
              may legitimately appear in (§1.1's suspend verb), which is a fact about \
              authority and not about keys.",
    },
    TableClaim {
        name: "grant_revocations",
        protection: Protection::NoKeyProtectedMaterial,
        why: "the positive, append-only fact that a grant is dead (§3.2). A revoker id, a \
              fingerprint, a signature, a chain sequence and a seal.",
    },
    TableClaim {
        name: "organisation_auth_head",
        protection: Protection::NoKeyProtectedMaterial,
        why: "one row per organisation: the authority epoch, the chain sequence, how many \
              grants are live, a keyed digest over them and the head seal. Two MAC tags and \
              three integers. Keyed under the organisation chain key so that a dump cannot \
              recompute them, which is integrity rather than confidentiality.",
    },
    // ---- 0013, sessions (admin design §4) ---------------------------------
    //
    // Three tables, none key-protected, and the reason is §4.1 itself: a
    // session is held together by a PUBLIC key the browser keeps the private
    // half of, a MAC tag this server takes under a key PostgreSQL cannot
    // read, and nonces that authorise nothing. **There is no password
    // anywhere in this schema** (§4.5, §5.1, OPEN-QUESTIONS C2), so there is
    // no verifier to protect either.
    TableClaim {
        name: "sessions",
        protection: Protection::NoKeyProtectedMaterial,
        why: "one row per live session: the principal and its kind, the browser's session \
              PUBLIC key (§4.2 generates the private half non-extractable in WebCrypto and it \
              never leaves the browser), the consumed bind nonce, the evidence signature and \
              its digest, a SHA-256 of the bearer token rather than the token, and the row \
              MAC. Every one of those is a public value, a signature or a hash; the MAC's key \
              is the site-scoped row key, behind ADR-0043's provider interface and never in \
              PostgreSQL.",
    },
    TableClaim {
        name: "session_nonces",
        protection: Protection::NoKeyProtectedMaterial,
        why: "32 random bytes, single-use, deleted at verification (§4.2). A nonce authorises \
              nothing on its own -- it is an input to a message somebody still has to sign -- \
              so it is not a secret this table is protecting.",
    },
    TableClaim {
        name: "sign_in_attempts",
        protection: Protection::NoKeyProtectedMaterial,
        why: "§13 item 7's fixed-window counters: a bucket kind, a bucket key (an opaque \
              account id, a source address, or since 0014 a KEYED HASH of a claimed address \
              -- NEVER an address that was typed), a window start, a count and two latches. \
              No credential, no key material, and nothing that was ever secret. The keyed \
              hash's key is derived from the site chain key and is not in PostgreSQL, which \
              is what makes the column a grouping rather than a list of addresses.",
    },
    // ---- 0014, sign-out recorded rather than only performed ---------------
    TableClaim {
        name: "session_revocations",
        protection: Protection::NoKeyProtectedMaterial,
        why: "one append-only row per signed-out session: the session id, the principal, a \
              reason, the time, the site-chain seq of the `account_signed_out` entry, and the \
              row MAC. A session id is not a secret and none of the rest ever was; the MAC's \
              key is the site-scoped row key, behind ADR-0043's provider interface and never \
              in PostgreSQL. It exists because deleting the session row left last night's \
              backup holding bytes that verified for ever.",
    },
    // ---- 0015, the operator console and the enrolment path ----------------
    TableClaim {
        name: "operator_keys",
        protection: Protection::NoKeyProtectedMaterial,
        why: "one operator's enrolled ES256 PUBLIC key, its fingerprint, the site-chain seq of \
              the entry that enrolled it, and a row seal. `account_keys` carries the same claim \
              for the account plane and for the same reason: a public key is public, and the \
              private half never reaches this server at all.",
    },
    TableClaim {
        name: "site_install",
        protection: Protection::NoKeyProtectedMaterial,
        why: "one row, written at first start: the install-time notice address §6.2 pins an \
              organisation's enrolment claim to. An address is identity, not a credential -- \
              `accounts.email` carries the same claim -- and no role may ever UPDATE this one.",
    },
    TableClaim {
        name: "organisation_shells",
        protection: Protection::NoKeyProtectedMaterial,
        why: "a name, the operator who created it, the chain seq that recorded it, and the \
              organisation its claim eventually produced. §6.2's shell holds no data by \
              definition: it exists precisely because there is nothing in it yet.",
    },
    TableClaim {
        name: "enrolment_tokens",
        protection: Protection::NoKeyProtectedMaterial,
        why: "the HASH of a single-use enrolment token, never the token, plus which subject it \
              names, who issued it, when it expires and whether it has been spent. The token \
              itself is returned once and is gone from this server the moment it is handed \
              out; the hash is useless to redeem with, exactly as `sessions.token_hash` is.",
    },
    TableClaim {
        name: "site_settings_versions",
        protection: Protection::KeyProtected {
            columns: &["value_ct"],
            under: "a subkey of the site chain key (`fathom/site/settings/v1`), which is derived \
                  from the chain master behind ADR-0043's provider interface and is never in \
                  PostgreSQL. §5.3: \"AEAD; SMTP credentials are credentials.\" `value_digest` \
                  is a digest of the ciphertext and is what §5.4's sealed entry names.",
        },
        why: "one version of one site setting. The value is a credential often enough to be \
              treated as one always, so it is stored only as ciphertext; everything else on the \
              row -- who requested it, who seconded it, when it takes effect, which sealed \
              entry applied it -- is the audit trail of the change and is meant to be read.",
    },
    TableClaim {
        name: "operator_requests",
        protection: Protection::NoKeyProtectedMaterial,
        why: "§5.5's two operator assertions for creating an operator: a display name, the two \
              operator ids, their two signatures over the change digest, the delay, and which \
              operator the applied request produced. Signatures are not secrets -- they are \
              what a later reader verifies -- and there is no free-text column a payload could \
              hide in.",
    },
    TableClaim {
        name: "operator_read_samples",
        protection: Protection::NoKeyProtectedMaterial,
        why: "§1.1's sampling latch: one row per (operator session, console surface), so that \
              `operator_read` is written once per surface per session rather than once per \
              poll. A session id and a surface name, and nothing else.",
    },
    TableClaim {
        name: "firmware_images",
        protection: Protection::NoKeyProtectedMaterial,
        why: "ADR-0045's staging record: which scope an image was staged for, the operator's own \
              name for the file, its length, the SHA-256 that was declared, the SHA-256 this \
              server computed over the bytes it wrote, and the state machine between them. \
              **The image itself is not here** -- one to two gigabytes goes to a directory, and \
              `0017` §A says why. A firmware image is a public vendor artefact, not a secret; \
              the two hashes are hashes of it. **No device credential can arrive on this table**: \
              there is no column for a password, a key, a host key or a device address, which is \
              CLAUDE.md rule 4's shape and ADR-0045 §4.1's decision made structural.",
    },
    TableClaim {
        name: "firmware_upload_tokens",
        protection: Protection::NoKeyProtectedMaterial,
        why: "the HASH of a single-use upload token, never the token. It authorises exactly one \
              thing -- sending the bytes of one already-declared image, at the length and hash \
              that declaration named -- and it is returned once, to the steward who declared, \
              and is gone from this server the moment it is handed out. The hash is useless to \
              upload with, exactly as `sessions.token_hash` is useless to sign with.",
    },
    TableClaim {
        name: "firmware_fetch_tokens",
        protection: Protection::NoKeyProtectedMaterial,
        why: "the HASH of the one-time URL a switch collects an image from, plus who issued it, \
              which sealed entry recorded that, when it expires, and whether and from where it \
              was redeemed. **The URL is a credential and this table does not hold it** -- \
              `H(LP(\"fathom/firmware/token/v1\") || LP(token))` and nothing more, so a database \
              read hands an attacker a hash and a hash cannot be fetched with. It is not \
              key-protected material either: it protects a public vendor image, it is single-use \
              and minutes long, and it wraps no key.",
    },
    // ---- ADR-0055 stream (a): migration 0018's two new tables -------------
    //
    // Added at the END of this list, in a labelled block, so the other two
    // ADR-0055 streams' additions land beside them and the merge is
    // mechanical. `operator_account_bindings` (`0019`) and the placement
    // table (`0020`) belong to streams (b) and (c) and are NOT declared here.
    TableClaim {
        name: "backup_codes",
        protection: Protection::NoKeyProtectedMaterial,
        why: "the HASH of a single-use backup code, never the code. \
              `H(LP(\"fathom/credentials/backup/code/v1\") || LP(code))` -- `0018` §C, the same \
              construction `enrolment_tokens` and `firmware_fetch_tokens` already use -- so a \
              database read hands an attacker a SHA-256 digest and a digest cannot be signed in \
              with. The ten codes are returned once, at the moment the app code is confirmed, \
              and are gone from this server before the transaction commits. It is not \
              key-protected material either: it wraps no key, and a one-way hash is not \
              something a key opens.",
    },
    TableClaim {
        name: "password_reset_tokens",
        protection: Protection::NoKeyProtectedMaterial,
        why: "the HASH of a reset token, never the token -- \
              `H(LP(\"fathom/credentials/reset/token/v1\") || LP(token))`, `0018` §D, the same \
              reasoning `enrolment_tokens` carries. Beside it: which account, the SOURCE the \
              request came from (never a destination -- the destination is always \
              `accounts.email`, which is what stops an operator-supplied address being an open \
              relay), when it expires, whether it was spent, and the seal. Every one of those \
              is the audit trail of a reset and is meant to be read. No key, no design payload \
              and no device credential lands here.",
    // ---- ADR-0055 stream (b) --------------------------------------------
    //
    // Added at the END of the list so that the three parallel ADR-0055 streams
    // merge mechanically. Stream (a) claims `backup_codes` and
    // `password_reset_tokens` and `0018`'s new `accounts` columns; stream (c)
    // claims `0020`'s placement table.
    TableClaim {
        name: "operator_account_bindings",
        protection: Protection::NoKeyProtectedMaterial,
        why: "ADR-0055 decision 1's sealed fact: operator X holds the custody on account Y. Two \
              opaque ids, the site-chain `seq` of the entry that created it, a timestamp, and a \
              32-byte seal over the pair. **No secret of any kind**, and deliberately no address \
              -- the address lives on `accounts` and this row points at it, so a database read \
              hands an attacker two ulids. Not key-protected material either: it wraps no key \
              and carries no payload. What the seal gives it is tamper evidence, which \
              `0019`'s own header argues a column on `operators` could not have had without \
              re-sealing every existing row under a key the migration role does not hold.",
    },
];

/// Object kinds a migration may create that are not themselves a place to
/// store row data: an index accelerates reads of an already-allowed table,
/// and a row-level-security policy is an access rule, not a place to put
/// rows. Both are still read off the SQL by [`created_objects`] and reported
/// by name, so a `CREATE INDEX`/`CREATE POLICY` on a table that is not on
/// [`TABLES`] is still visible in a diff, just not failed here --
/// there would be no table for it to index or govern in the first place.
///
/// `role` joined the list with `migrations/0005_planes.sql`: a database role
/// is a principal a connection authenticates as, not a relation, and it holds
/// no rows at all. Which roles exist and what they may read is checked by
/// `tests/planes.rs`, table by table, off the live schema.
/// `function` and `trigger` joined the list with
/// `migrations/0009_chains_at_three_levels.sql`. Neither holds a row: a
/// trigger is a rule attached to a table that already has to be declared
/// above, and the function it calls raises an exception and returns nothing.
/// Both are still read off the SQL by [`created_objects`] and reported by
/// name, so one appearing on a table that is not in [`TABLES`] is visible in a
/// diff.
const NON_STORAGE_KINDS: &[&str] = &["index", "policy", "role", "function", "trigger"];

/// Every migration file on disk, read from the directory rather than from
/// the `MIGRATIONS` constant -- so a file added and not yet wired in is
/// still checked.
fn migration_files() -> Vec<(String, String)> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).expect("migrations/ must exist") {
        let path = entry.expect("readable entry").path();
        if path.extension().and_then(|e| e.to_str()) != Some("sql") {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .expect("a file name")
            .to_string();
        let sql = std::fs::read_to_string(&path).expect("readable migration");
        out.push((name, sql));
    }
    out.sort();
    assert!(!out.is_empty(), "no migrations were found to check");
    out
}

/// Strip `--` line comments and `/* */` blocks, so a table named only inside
/// a comment is not counted -- and, more importantly, so a real
/// `CREATE TABLE` cannot be hidden from this test by putting a decoy in a
/// comment.
fn strip_comments(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let bytes: Vec<char> = sql.chars().collect();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == '-' && bytes.get(i + 1) == Some(&'-') {
            while i < bytes.len() && bytes[i] != '\n' {
                i += 1;
            }
        } else if bytes[i] == '/' && bytes.get(i + 1) == Some(&'*') {
            i += 2;
            while i < bytes.len() && !(bytes[i] == '*' && bytes.get(i + 1) == Some(&'/')) {
                i += 1;
            }
            i += 2;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    out
}

/// Every identifier this SQL creates, by object kind.
///
/// Deliberately blunt: it looks for `CREATE`, skips the modifiers PostgreSQL
/// allows between `CREATE` and the object kind, and takes the next
/// identifier. A blunt reader that over-reports is the right failure
/// direction here -- a false positive is one line in this file explaining
/// why an object is fine; a false negative is a table nobody noticed.
/// Replace every single-quoted SQL string literal with a space, and return
/// the literals alongside.
///
/// **Why this was needed, and what it costs.** `0007` writes
/// `CHECK (entry_type IN ('create', 'update', 'reencrypt'))`, and the blunt
/// reader below saw `create` followed by `update` and reported that the
/// migration creates "an update called reencrypt". A word inside a string
/// literal is data, not DDL.
///
/// The cost is that DDL hidden inside a literal -- `EXECUTE 'CREATE TABLE
/// ...'` -- would stop being seen, so
/// [`no_migration_hides_ddl_inside_a_string_literal`] checks the literals
/// themselves. Two narrow checks beat one blunt one that has to be argued
/// with every time a constraint mentions a verb.
fn strip_string_literals(sql: &str) -> (String, Vec<String>) {
    let mut out = String::with_capacity(sql.len());
    let mut literals = Vec::new();
    let chars: Vec<char> = sql.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '\'' {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        i += 1;
        let mut literal = String::new();
        while i < chars.len() {
            if chars[i] == '\'' {
                // '' is an escaped quote inside a literal, not the end of one.
                if chars.get(i + 1) == Some(&'\'') {
                    literal.push('\'');
                    i += 2;
                    continue;
                }
                i += 1;
                break;
            }
            literal.push(chars[i]);
            i += 1;
        }
        literals.push(literal);
        out.push(' ');
    }
    (out, literals)
}

fn created_objects(sql: &str) -> Vec<(String, String)> {
    const MODIFIERS: &[&str] = &[
        "or",
        "replace",
        "unlogged",
        "temporary",
        "temp",
        "global",
        "local",
        "unique",
        "materialized",
        "recursive",
        "if",
        "not",
        "exists",
    ];
    let (cleaned, _literals) = strip_string_literals(&strip_comments(sql));
    let cleaned = cleaned.to_ascii_lowercase();
    let words: Vec<&str> = cleaned
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .filter(|w| !w.is_empty())
        .collect();

    let mut found = Vec::new();
    let mut i = 0;
    while i < words.len() {
        if words[i] != "create" {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        while j < words.len() && MODIFIERS.contains(&words[j]) {
            j += 1;
        }
        if j >= words.len() {
            break;
        }
        let kind = words[j].to_string();
        // Skip the modifiers that can also follow the kind: `IF NOT EXISTS`.
        let mut k = j + 1;
        while k < words.len() && MODIFIERS.contains(&words[k]) {
            k += 1;
        }
        if k < words.len() {
            found.push((kind, words[k].to_string()));
        }
        i = j + 1;
    }
    found
}

fn allowed_table_names() -> BTreeSet<String> {
    TABLES.iter().map(|t| t.name.to_string()).collect()
}

#[test]
fn every_table_the_migrations_create_is_on_the_allowlist() {
    let allowed = allowed_table_names();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for (name, sql) in migration_files() {
        for (kind, ident) in created_objects(&sql) {
            if kind != "table" {
                continue;
            }
            assert!(
                allowed.contains(&ident),
                "{name} creates a table called `{ident}`, which is not in this test's \
                 `TABLES`. That list is the whole control: a table must be declared there as \
                 either carrying no key-protected material, with a stated reason, or as \
                 key-protected, naming the columns and the key that protects them."
            );
            seen.insert(ident);
        }
    }
    assert_eq!(
        seen, allowed,
        "the migrations must create every table on the allowlist, and nothing this test has not \
         been told about"
    );
}

#[test]
fn the_migrations_create_no_view_sequence_or_other_undeclared_place_to_put_rows() {
    // A view, materialised view or sequence is still a place data could end
    // up; an index or a row-level-security policy is not. G8's original
    // point ("this order stores NOTHING") is preserved for every OTHER kind
    // of object -- it just no longer covers `table` itself, which has its
    // own allowlist above.
    for (name, sql) in migration_files() {
        for (kind, ident) in created_objects(&sql) {
            assert!(
                kind == "table" || NON_STORAGE_KINDS.contains(&kind.as_str()),
                "{name} creates a {kind} called `{ident}`, which is neither an allowlisted table \
                 nor one of {NON_STORAGE_KINDS:?}. Anything else is an undeclared place to put \
                 rows."
            );
        }
    }
}

#[test]
fn the_checker_itself_detects_what_it_is_looking_for() {
    // A test that only ever passes is not evidence. Drive the reader over
    // SQL it MUST flag, so a change that broke it would be caught here
    // rather than by the absence of an error.
    let cases = [
        ("CREATE TABLE tenants (id uuid);", "tenants"),
        ("create unlogged table Designs (id uuid);", "designs"),
        ("CREATE TABLE IF NOT EXISTS users (id uuid);", "users"),
        ("CREATE\n  TABLE\n  nodes (id uuid);", "nodes"),
    ];
    for (sql, expected) in cases {
        let found = created_objects(sql);
        assert!(
            found.iter().any(|(k, n)| k == "table" && n == expected),
            "the reader missed `{expected}` in: {sql}\nsaw: {found:?}"
        );
    }

    // ...and it must not be fooled by a decoy in a comment.
    let decoy = "-- CREATE TABLE tenants (id uuid);\nCREATE TABLE _fathom_migrations (a int);";
    let found = created_objects(decoy);
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].1, "_fathom_migrations");

    // A view is reported as a view, not silently ignored -- and not
    // mistaken for one of the non-storage kinds this test allows.
    let view = "CREATE MATERIALIZED VIEW estate AS SELECT 1;";
    assert!(created_objects(view).iter().any(|(k, _)| k == "view"));
    assert!(!NON_STORAGE_KINDS.contains(&"view"));

    // A policy and an index must both be recognised as their own kinds
    // (never silently folded into "table"), which is what lets the other
    // test above tell them apart from an undeclared storage object.
    let policy = "CREATE POLICY p ON scopes USING (true);";
    assert!(created_objects(policy)
        .iter()
        .any(|(k, n)| k == "policy" && n == "p"));
    let index = "CREATE INDEX idx ON scopes (path);";
    assert!(created_objects(index)
        .iter()
        .any(|(k, n)| k == "index" && n == "idx"));
    // ...and a role, which `migrations/0005_planes.sql` creates inside a
    // `DO $$ ... $$` block. If the reader stopped seeing it, a `CREATE TABLE`
    // in the same block would stop being seen too.
    let role = "DO $$ BEGIN CREATE ROLE fathom_operator NOLOGIN; END $$;";
    assert!(created_objects(role)
        .iter()
        .any(|(k, n)| k == "role" && n == "fathom_operator"));
}

#[test]
fn every_embedded_migration_matches_a_file_on_disk() {
    // `include_str!` means the binary carries the SQL, so a file could be
    // renamed or removed and the binary would not notice. This test is the
    // thing that notices.
    let on_disk: BTreeSet<String> = migration_files().into_iter().map(|(n, _)| n).collect();
    let embedded: BTreeSet<String> = fathom_server::migrate::MIGRATIONS
        .iter()
        .map(|m| m.name.to_string())
        .collect();
    assert_eq!(
        on_disk, embedded,
        "the migrations on disk and the ones embedded in the binary differ"
    );

    for m in fathom_server::migrate::MIGRATIONS {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("migrations")
            .join(m.name);
        let sql = std::fs::read_to_string(&path).expect("readable migration");
        assert_eq!(
            sql, m.sql,
            "{} on disk differs from the embedded copy",
            m.name
        );
    }
}

/// The static SQL scan above proves what the migration *text* declares. This
/// proves what a real, migrated database actually contains -- the two could
/// disagree if, say, a table were created by something other than a
/// `CREATE TABLE` this reader recognises.
#[tokio::test]
async fn the_real_database_holds_exactly_the_allowed_tables() {
    let pool = support::migrated_pool().await;
    let client = pool.get().await.expect("connection");
    let rows = client
        .query(
            "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
            &[],
        )
        .await
        .expect("list tables");
    let actual: BTreeSet<String> = rows.iter().map(|r| r.get::<_, String>(0)).collect();

    assert_eq!(
        actual,
        allowed_table_names(),
        "the real database's tables must match `TABLES` exactly -- if this fails, \
         something is creating (or has stopped creating) a table that the static SQL scan above \
         did not catch"
    );
}

/// Every column declared as holding key-protected material exists, and is
/// `bytea`.
///
/// **Why the type matters.** Ciphertext in a `text` column means somebody
/// chose an encoding, and an encoding is where a plaintext copy gets kept "for
/// debugging". `bytea` also means a `::text` cast renders hex rather than
/// whatever the bytes happen to spell, which is what makes the sweep below
/// able to search a whole database uniformly.
#[tokio::test]
async fn every_declared_ciphertext_column_exists_and_is_bytea() {
    let pool = support::migrated_pool().await;
    let client = pool.get().await.expect("connection");

    let mut checked = 0;
    for table in TABLES {
        let Protection::KeyProtected { columns, under } = table.protection else {
            continue;
        };
        assert!(
            !under.is_empty(),
            "{} is declared key-protected without naming the key",
            table.name
        );
        for column in columns {
            let row = client
                .query_opt(
                    "SELECT data_type FROM information_schema.columns \
                     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2",
                    &[&table.name, column],
                )
                .await
                .expect("read the column's type");
            let data_type: String = row
                .unwrap_or_else(|| {
                    panic!(
                        "{}.{column} is declared as holding key-protected material and does not \
                         exist",
                        table.name
                    )
                })
                .get(0);
            assert_eq!(
                data_type, "bytea",
                "{}.{column} holds key-protected material and is {data_type}, not bytea",
                table.name
            );
            checked += 1;
        }
    }
    assert!(
        checked >= 5,
        "only {checked} key-protected columns were checked; the hierarchy has at least five \
         (three wrapped keys, one payload, and organisation chain metadata)"
    );
}

/// **The one that tests the claim.**
///
/// Write a design carrying a distinctive marker through the real write path,
/// then sweep every column of every row of every table for it — as a
/// superuser, so row-level security hides nothing — and require that it
/// appears nowhere. Then sweep for a value that IS in the clear and require
/// that it appears, so the sweep cannot pass by scanning nothing.
#[tokio::test]
async fn a_marker_written_as_a_design_appears_in_no_column_of_any_table() {
    use fathom_server::crypto::Key32;
    use fathom_server::keys::KeyRing;
    use fathom_server::repo::ScopeKind;
    use fathom_server::{designs, repo};

    // The same master key every other test in this crate uses: ADR-0043 §4
    // allows one active master key per database, so a second one here would
    // be refused -- which is itself correct behaviour, and tested in
    // `tests/design_storage.rs`.
    let ring = KeyRing::from_keys(Key32::from_bytes([21; 32]), Key32::from_bytes([71; 32]));
    let pool = support::migrated_pool().await;

    let stamp = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    // Two values: one that must never be stored in the clear, one that is
    // deliberately in the clear and is the positive control.
    let marker = format!("SWEEPMARKER-{stamp}-10.1.1.0/24-core-fw-01");
    let in_the_clear = format!("SWEEPCONTROL-{stamp}");

    let account = repo::create_account(&pool, &format!("sweep-{stamp}@example.test"), "Sweeper")
        .await
        .expect("account");
    let org = repo::create_organisation(&pool, account.id, &in_the_clear)
        .await
        .expect("organisation");
    let network = repo::create_scope(
        &pool,
        org.id,
        account.id,
        None,
        ScopeKind::Network,
        "sweep network",
    )
    .await
    .expect("network");
    let design = designs::create_design(&pool, org.id, account.id, network.id)
        .await
        .expect("design");
    designs::write_version(
        &pool,
        &ring,
        org.id,
        account.id,
        design,
        format!(r#"{{"devices":[{{"name":"{marker}"}}]}}"#).as_bytes(),
        1,
    )
    .await
    .expect("write the design");

    let found_marker = sweep(&marker).await;
    assert!(
        found_marker.is_empty(),
        "the design's marker was found in the clear in: {found_marker:?}. A design payload may \
         be stored, and it may only be stored ENCRYPTED -- including in any audit, metadata or \
         diagnostic column."
    );

    // The positive control. If this fails, the sweep is broken, and the
    // assertion above proved nothing.
    let found_control = sweep(&in_the_clear).await;
    assert!(
        found_control.contains(&"organisations".to_string()),
        "the sweep did not find a value that IS stored in the clear ({in_the_clear}), so it \
         cannot be trusted to have looked for the marker either. Found: {found_control:?}"
    );
}

/// Every table in which `needle` appears, as text or as the hex a `bytea`
/// renders to.
///
/// Casting a whole row to `text` is what makes this uniform: every column of
/// every type arrives in one string, `bytea` included, so a column added later
/// is swept without this function being edited.
async fn sweep(needle: &str) -> Vec<String> {
    let client = support::superuser_client_on_test_database().await;
    let hex: String = needle.bytes().map(|b| format!("{b:02x}")).collect();

    let tables: Vec<(String, String)> = client
        .query(
            "SELECT tablename, quote_ident(tablename) FROM pg_tables WHERE schemaname = 'public'",
            &[],
        )
        .await
        .expect("list tables")
        .iter()
        .map(|r| (r.get(0), r.get(1)))
        .collect();
    assert!(
        !tables.is_empty(),
        "no tables to sweep is not a passing state"
    );

    let mut hits = Vec::new();
    for (name, quoted) in tables {
        let rows = client
            .query(&format!("SELECT t::text FROM public.{quoted} t"), &[])
            .await
            .unwrap_or_else(|e| panic!("sweep {name}: {e}"));
        for row in rows {
            let rendered: Option<String> = row.get(0);
            let Some(rendered) = rendered else { continue };
            if rendered.contains(needle) || rendered.to_ascii_lowercase().contains(&hex) {
                hits.push(name.clone());
                break;
            }
        }
    }
    hits
}

/// The complement to [`strip_string_literals`]: nothing may create a place to
/// put rows from inside a string literal, where the reader above no longer
/// looks.
///
/// This is the `EXECUTE format('CREATE TABLE %I ...')` shape. No migration in
/// this chain does it, and if one ever wants to, it should be an argued change
/// to this test rather than a quiet bypass of the one above.
#[test]
fn no_migration_hides_ddl_inside_a_string_literal() {
    const HIDDEN: &[&str] = &[
        "create table",
        "create unlogged table",
        "create view",
        "create materialized view",
        "create sequence",
        "create temp table",
        "create temporary table",
    ];
    for (name, sql) in migration_files() {
        let (_, literals) = strip_string_literals(&strip_comments(&sql));
        for literal in literals {
            let flat = literal.to_ascii_lowercase();
            let flat = flat.split_whitespace().collect::<Vec<_>>().join(" ");
            for shape in HIDDEN {
                assert!(
                    !flat.contains(shape),
                    "{name} has `{shape}` inside a string literal. The object reader strips \
                     literals so that a CHECK constraint naming a verb is not mistaken for DDL; \
                     dynamic DDL would therefore pass unseen."
                );
            }
        }
    }
}

/// The literal stripper itself, driven over what it must and must not do.
#[test]
fn the_literal_stripper_keeps_ddl_and_drops_data() {
    let (stripped, literals) =
        strip_string_literals("CHECK (t IN ('create', 'update'));\nCREATE TABLE x (a int);");
    assert_eq!(literals, vec!["create".to_string(), "update".to_string()]);
    assert!(stripped.contains("CREATE TABLE x"), "{stripped}");
    assert!(!stripped.contains("'create'"), "{stripped}");

    // A doubled quote is an escaped quote, not the end of the literal: a
    // stripper that got this wrong would resynchronise on the wrong side and
    // could hide real DDL after it.
    let (stripped, literals) =
        strip_string_literals("SELECT 'it''s fine'; CREATE TABLE y (a int);");
    assert_eq!(literals, vec!["it's fine".to_string()]);
    assert!(stripped.contains("CREATE TABLE y"), "{stripped}");

    // And the reader, driven over the exact shape that caught this out.
    let sql = "CREATE TABLE chain_entries (entry_type text CHECK (entry_type IN ('create', \
               'update', 'reencrypt')));";
    let found = created_objects(sql);
    assert_eq!(
        found,
        vec![("table".to_string(), "chain_entries".to_string())],
        "{found:?}"
    );
}

/// Every declaration says something. A blank reason is an entry someone added
/// to make a test pass, which is the failure mode this list exists to prevent
/// — the list is only a control while each line of it is a sentence somebody
/// had to be willing to write.
#[test]
fn every_table_declares_a_reason_and_no_table_is_declared_twice() {
    let mut seen = BTreeSet::new();
    for table in TABLES {
        assert!(
            seen.insert(table.name),
            "{} is declared twice in TABLES",
            table.name
        );
        assert!(
            table.why.len() > 40,
            "{} is declared with no real reason: {:?}",
            table.name,
            table.why
        );
        if let Protection::KeyProtected { columns, under } = table.protection {
            assert!(
                !columns.is_empty(),
                "{} is declared key-protected and names no column",
                table.name
            );
            assert!(
                under.len() > 10,
                "{} is declared key-protected and does not say under which key",
                table.name
            );
        }
    }
    assert!(
        TABLES
            .iter()
            .any(|t| matches!(t.protection, Protection::KeyProtected { .. })),
        "no table is declared key-protected. Since 0007 at least three are, and a list that \
         claims otherwise is the old premise coming back."
    );
}
