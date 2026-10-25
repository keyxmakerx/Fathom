# ADR-0071: The password vault, part one (logins only people can read)

**Status:** accepted 2026-10-25, part two built the same day (owner answered the round-32 cards on the sign-off page: look v2,
admins A, lockout A, external, breach A with a weekly re-check, and "make sure the checks can be per
org, or even like per type of passwords", all 25 October). Part one builds ADR-0042's Mode A.

**Context.** ADR-0042 (accepted) lets Fathom keep the device logins a person chooses to store, never
in the design and never without being shown and chosen. ADR-0043 §6 and the storage design §13 set
the construction. This record says what part one built, where it departs from the approved mockups,
and what parts two and three hold.

## Decided

1. **Its own schema.** The vault lives in a PostgreSQL schema called `vault` (`keys`, `entries`,
   `wraps`, `shares`, `recovery_uses`; migration `0041_vault.sql`), not in `public`. Every
   no-key-protected-data test now walks every non-system schema with qualified names, and the
   real-database test asserts the schemas are exactly `public` and `vault`. **A backup that copies only
   `public` loses every stored login**; `docs/OPERATING.md` says so.
2. **Sealed in the browser (Mode A).** A login's user name, password and note are sealed together
   with AES-256-GCM under a per-login content key, the additional data naming the organisation, the
   login and its epoch. The content key is wrapped to each holder's P-256 vault key (ephemeral ECDH,
   HKDF-SHA256, AES-GCM; §13.7), and the holder list is signed ES256 by whoever shared it, with each
   wrap bound by SHA-256. A browser checks that signature before it opens any wrap.
3. **What the server sees.** That a login exists, its sealed metadata, who holds it, its age and
   epoch. Not its name in the clear, not its user name, password or note. "Used on" (the devices it
   belongs to) is in the sealed metadata, not in the design: a field not in `schema/` does not exist,
   and a password's whereabouts are not design data.
4. **A vault key and a passphrase.** A person's private vault key is sealed under
   Argon2id(passphrase, salt, secret = a 128-bit vault key shown once on the Emergency Kit), with
   m = 64 MiB, t = 3, p = 1, measured at about 280 ms in Node. Sources, read 2026-10-25: the OWASP
   Password Storage Cheat Sheet (minimum m = 19 MiB, t = 2, p = 1 or an equivalent) and Bitwarden's
   KDF page ("By default, Bitwarden is set to allocate 32 MiB of memory, iterate over it 6 times, and
   do so across 4 threads"). Fathom's setting asks for twice that memory over one lane instead,
   above both. The server checks every request against bounds (19 MiB to 256 MiB, 2 to 10
   passes, 1 to 4 lanes). Argon2 runs in the Rust engine,
   compiled for the browser; no new crate (`deps/decisions/argon2.md`).
5. **Nobody locks themselves out (lockout A).** The Emergency Kit is saved before the passphrase is
   chosen, and setup does not continue until the person ticks that they saved it. The organisation's
   recovery sheet (52 characters, printed) is added as a holder of every new login. Opening a login
   with the sheet is an act on the organisation's history, listed on the admin page for every admin.
   After an unlock, a browser re-shares to the current sheet and keys any login it holds that they do
   not cover. Resetting the sign-in password never touches the vault.
6. **Admins (admins A).** An admin sees every login's name, holders and age, can take a copy away or
   delete one, and reads only what is shared with them, the same as anyone. Reading one not shared
   needs the recovery sheet, which is logged.
7. **Where it shows (look v2).** A Logins tab on a device's right panel, a Passwords kind in
   Inventory, the admin's list under Organisation › Passwords, and a lock badge on the avatar with
   "Vault unlocked · locks itself in N minutes" and Lock now in the avatar menu. Unlocked for 15
   minutes per tab; signing out locks it.

## Departures from the approved mockups

- **Fingerprints are 24 characters, not nine words.** Four groups of six Crockford base32
  characters (120 bits of SHA-256). A word list is another dependency to vet and another thing to
  mistype in a language it was not written for; characters compare the same way the recovery sheet
  and the kit are read.
- **A member who is not an admin keeps their vault under Home › Passwords.** The mockups had no
  place for it: a plain member may have no folder, so no design and no Inventory. Admins keep theirs
  under Organisation › Passwords.
- **A browser with no signing key of its own is told so before setup.** The vault key is endorsed by
  this browser's account key, which is made at a sign-in with the authenticator app. Someone who
  signed in with a password alone is asked to set one up first, not after choosing a passphrase.

## Part two: logins Fathom itself can use (Mode B), built 2026-10-25

8. **A copy the server seals, beside the people's copies.** Mode B adds a copy; it does not replace
   the browser-sealed one, so the people who held the login keep it. The owner's browser opens the
   login and hands it, as canonical JSON `{n, p, u}`, to one route; the server seals it at once
   with ChaCha20-Poly1305 under HKDF-Expand(`vault.key`, "fathom/vault/fathom-copy/key/v1" ‖
   LP(organisation)), the additional data naming the organisation, the login, its epoch and the key
   id. No new crate. `vault.key` is a root key file of its own (`FATHOM_VAULT_KEY`, default
   `/var/lib/fathom/keys/vault.key`, the slot the backup work reserved); it is never the master
   key, so restoring `master.key` alone opens no login.
9. **Who may change it (storage design §13.5).** Only someone who holds it now (R1). Of those, only
   its owner consents to A to B (R2), by an ES256 account-key signature over
   `vault_fathom::mode_change_bytes`, which names the organisation, the login, both epochs, the
   owner and their key, the holders of the new epoch, `vault.key`'s id, the time and the share entry
   it follows. The browser builds those bytes itself; `bytes.test.ts` and the server's unit test pin
   the same SHA-256. A to B always shares the login again first under a fresh key (epoch after >
   epoch before), so its holders are named again at the moment it becomes server-readable. Shared
   with anyone besides the owner, it waits until another admin signs the same stored bytes. B to A
   (R3) is the owner or any admin, with no consent; the copy is emptied and the row kept.
10. **Every use on the record.** `vault_fathom::use_login(tx, auth, key, login, design, element,
    purpose)` is the only way Fathom opens a copy: the login must be on, its copy at the current
    epoch and under this server's `vault.key`, marked as used on that device, and the caller able to
    draw in that design. It writes `vault_read` to the organisation's history and a row the card
    counts, both before opening. Purposes are `autopopulate` and `check`.
11. **A changed login.** A new epoch (a changed password or set of holders) leaves Fathom's copy out
    of date, and an out-of-date copy is never used; the browser that made the epoch hands Fathom the
    new one. A copy still waiting for its second signature is not refreshed: the admin must sign over
    the holders the owner named, so the owner asks again.
12. **What the person is told.** The consent screen quotes the storage design's sentences word for
    word, and needs a tick before the account key signs. Turning it off shows the B-to-A sentence
    with two words changed: the design says "while it was in Mode B, with the master key", and the
    screen says "while Fathom could use it, with the server's vault.key file", because here that
    key file, not the master key, opens the copy, and "Mode B" is a word only this record uses.
    Not built yet: the chain verifier's check that each `vault_read` names a login then in Mode B.

## Part three: breach checks, built 2026-10-25

13. **Three levels, most specific wins** (owner, 25 October: "make sure the checks can be per org,
    or even like per type of passwords"). A login marked critical is always checked, re-checked every
    7 days, and a breached password refused. Otherwise its kind's level if the organisation set one,
    otherwise the organisation's, otherwise off. Resolved in `vault_breach::effective` and mirrored in
    `breach.ts`'s `effectivePolicy`, each unit-tested. An admin sets the policy; the owner or an admin
    marks a login critical; both are `vault_breach_policy_set` entries on the organisation's history.
    No DELETE: a kind that goes back to "same as the organisation" keeps its row, marked to inherit.
14. **The check is the browser's.** A browser that holds the login sends the first five hex
    characters of the password's SHA-1 to `https://api.pwnedpasswords.com/range/` with `Add-Padding:
    true` and compares the rest itself (source: HIBP API v3 page, read 2026-10-25). It runs at save,
    and after an unlock for the logins that person holds whose check is due, paced as OPERATING.md
    says. The server records, per login and epoch, only found or not and when, and only from someone
    holding it at that epoch; a changed password starts unchecked. It cannot refuse a password it never
    sees, so a refusal is the saving browser's, and the policy card says so.
15. **One more origin in the CSP.** `connect-src` gains `https://api.pwnedpasswords.com` and nothing
    else (`src/client.rs`, departure 4). Whether that API answers the CORS preflight the padding
    header causes could not be established from the build machine; the drive answers it with a
    stand-in, and a list that cannot be reached leaves logins "Not checked yet" without blocking a
    save.

## Not decided here (after part three)
- **External vaults** (Mode C), Vaultwarden first, each limited to one folder or collection. Each
  vault's current documentation is read again before it is built.
