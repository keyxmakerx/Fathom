# ADR-0042 — Fathom keeps credentials, in a vault it cannot read by default

**Status:** Accepted, 2026-09-11
**Owner decision.** Amends invariant 3 in `.context/conventions.md`.
**Supersedes in part:** the reading of invariant 3 as *"Fathom never holds a device credential."*

---

## 1. The decision

Fathom will store device credentials. The owner's words: *"Fathom will have to house
credentials. There's no way to feasibly get around the functionality that would provide."*

The concern was raised — that this reverses the project's central security claim and makes
Fathom a higher-value target — and the decision was reaffirmed. It is recorded here as taken
deliberately, with the consequences named, not drifted into.

## 2. What changes and what does not

**Invariant 3 as written is no longer true** and must be amended rather than quietly reinterpreted.
Its old text: *"The application stores no device credential."*

**What survives intact:** a credential is never stored *silently*, and never stored *in the design*.
The design graph holds a reference, never a secret.

## 3. The shape: three modes, one default

The owner chose a per-credential choice plus external integration, with the strict mode
recommended: *"maybe c and d... or if it's on its own it can do both, but recommends A."*

### Mode A — user-held (the default, and what the interface recommends)

The secret is encrypted in the browser with a key derived from the user's own credentials. The
server stores bytes it cannot read. A stolen server yields nothing.

- **Cost:** Fathom itself can never use the credential. No automated config pull.
- **Cost:** a forgotten master password means those entries are unrecoverable. This must be said
  plainly at the moment of choosing, not buried.

### Mode B — server-usable (opt-in, per credential)

The server can decrypt on request. Every access is written to the audit log.

- Protects against a stolen database or backup, which is the common breach.
- Does **not** protect against full server compromise. This must never be described as though
  it does.
- Exists because the long-term goal is Fathom pulling configs itself. A read-only monitoring
  account is the intended occupant of this mode; a break-glass root password is not.

### Mode C — external vault (deployment option)

Fathom holds only a reference and fetches from the customer's own secret store. Named by the
owner: Delinea, Vaultwarden; add HashiCorp Vault and CyberArk.

- Fathom holds no credential at all. The strongest story and the easiest enterprise sell.
- Useless to a customer who runs no vault, which is most smaller shops. Hence not the only mode.

## 4. Construction requirements

1. **Tokenization.** The design graph stores a reference (`cred_<id>`), never a secret. An export,
   a diagram and an inventory row carry the reference only.
2. **Separate key hierarchy.** Vault keys are unrelated to design-data keys. Compromising the
   design keys must yield nothing in the vault.
3. **The wrapping key never lives in PostgreSQL.** A key stored beside the data it protects is
   decoration. It comes from outside the database: a file the database role cannot read, an
   operator-supplied secret at boot, or an external key service.
4. **Separate storage.** Vault rows do not share a table with design data, and ideally not a
   schema. A leak of the design tables must not include ciphertext the same key opens.
5. **Access is logged.** Every mode-B decryption writes an audit record. Non-optional.

## 5. The ingest gate is repurposed, not removed

Today the gate finds a credential in a pasted config and destroys it. It now finds it and
**offers** it: *"3 credentials found — store in the vault?"*

Nothing is ever stored without being shown and chosen. That was the real property the gate
protected, and it survives. The union rule still holds: nothing arriving after the build may reduce
what the gate detects, only increase it.

## 6. Consequences taken knowingly

- **Fathom becomes a credential store, and therefore a higher-value target.** Breach impact rises
  from "an attacker learns the network's shape" to "an attacker may hold the estate's keys."
- **NetBox deleted its secrets store in v3.0 and points at a vault; Nautobot never built one.**
  Both reached the opposite conclusion. This decision knowingly diverges, and mode C is the hedge.
- **Mode A and the monitoring goal are incompatible by construction.** A credential Fathom cannot
  read is a credential Fathom cannot use. Anything automated must live in mode B or C. This is not
  a defect to engineer around later; it is the trade being bought.

## 7. Forbidden claims

ADR-0040's four forbidden sentences still bind the product as a whole. For the vault specifically,
mode A may eventually justify language mode B never can. Until that distinction is built, tested
and separately reviewed, no marketing sentence may describe the vault as unreadable by Fathom.

## 8. Open decisions

1. What happens to mode-A credentials on password reset. Loss is the honest answer; it must be
   stated in the interface before the first secret is stored, not after.
2. Whether a shared credential can exist in mode A at all — several people needing one secret
   means key sharing, and revocation then means re-keying.
3. Whether mode B decryption requires re-authentication, or a standing session suffices.
4. Which external vaults ship first.

## 9. Sources consulted

- ADR-0040 (key custody), ADR-0041 (typed credentials are marked, never refused).
- `.context/conventions.md` invariants 3 and 4.
- The owner's answers, 2026-09-11, quoted above.

<!-- VERIFY: the NetBox v3.0 secrets-store removal and Nautobot's position are carried from earlier
project notes and were not re-checked against primary sources on 2026-09-11. Rule 1 applies before
either is cited in anything customer-facing. -->
