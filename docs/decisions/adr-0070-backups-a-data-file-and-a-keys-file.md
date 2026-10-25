# ADR-0070: Backups are a sealed data file and a separate keys file

**Status:** proposed 2026-10-25, built on the recommended defaults while the owner's answer is
pending (sign-off card `backup-v1`, "Back up Fathom"). The owner asked: *"did we ever setup some
sort of backup tool for this? How would the passwords work in that regards? would it be like an
encrypted compression with two db files or something?"*

**Context.** Until now `docs/OPERATING.md` only described a manual procedure: `pg_dump` by hand,
and the key volume tarred separately. There was no command, no schedule and no restore test.
ADR-0043 §9 sets the rule a backup tool must keep: *"never put `master.key` and a database dump in
the same archive"*. ADR-0042's vault is about to exist (the Ansible thread, ADR-0066), with
Mode A secrets sealed in the browser, Mode B secrets under a server-held key, and Mode C a
reference to Passbolt, Vaultwarden or Delinea.

## Decided

1. **Two files, never one.** A **data file** (`.fdata`) holds the `pg_dump -Fc` archive and the
   staged firmware images. A **keys file** (`.fkeys`) holds every file in the key volume:
   `master.key`, `chain.key`, `backup.key`, `vault.key` once the vault exists, and the database
   role passwords. A single passphrase-sealed file was the alternative on the card; it would make
   that passphrase the only thing between a stolen backup and everything, which is the shape
   ADR-0043 §9 forbids.
2. **One database dump, not two.** The vault lives in its own schema in the same database
   (ADR-0042 §4.4), so the dump carries it. Its rows are already ciphertext.
3. **The vault's passwords, by mode.** Mode A secrets travel still sealed by each person's
   passphrase and vault key; nothing in a backup can open them, and a forgotten passphrase stays
   lost (ADR-0043 §6). The fix for that is a break-glass recipient enrolled in the vault, not the
   backup. Mode B secrets are under `vault.key`, which goes in the keys file (the card's default;
   a separate vault keys file was the alternative). Mode C holds references only; the external
   vault backs itself up.
4. **The data file is sealed too,** under a key derived from `backup.key`, which exists only in
   the key volume and the keys file. A leaked data file then shows neither people's addresses nor
   the organisation tree, which a plain dump would. The server can make it unattended because it
   reads `backup.key` like any other key.
5. **The keys file is sealed under a recovery phrase,** 128 random bits shown once as 26 base32
   characters in six groups (the size and alphabet ADR-0043 §6 chose for the vault key), and never
   stored. Keys change rarely, so the keys file is made at install and again when a key changes;
   the data file is made every night.
6. **Each file carries a label of key ids** (ADR-0043 §4's non-secret ids). Restore reads both
   labels before asking for the phrase and before decrypting anything, and names the wrong keys
   file instead of reporting damage, exiting 11 like the server's own wrong-key refusal.
7. **Restore has a check-only mode**, `restore --check`, which decrypts and verifies every chunk
   and keeps nothing. It is the restore test.

## The construction

- **Data file.** `FATHOMBD ‖ u16 version ‖ LP(label) ‖ salt[32]`, then chunks. The file key is
  `HKDF-Expand(backup.key, LP("fathom/backup/data/v1") ‖ salt)`, so every file has its own key.
  Chunks are 1 MiB of plaintext under ChaCha20-Poly1305 (the AEAD `docs/PHASE-2-STORAGE-DESIGN.md`
  §12 already chose), with the nonce built the way age builds its payload nonce: *"the first 11
  bytes are a big endian chunk counter starting at zero … the last byte is 0x01 for the final chunk
  and 0x00 for all preceding ones"*, and *"Streaming decryption MUST signal an error if the end of
  file is reached without successfully decrypting a final chunk"* (C2SP `age.md`, "Payload", read
  2026-10-25). A counter nonce is safe here, where `crypto.rs` forbids one for stored rows, because
  the key is fresh for every file; the storage design's objection (a restore moving a counter
  backwards under the same key) does not arise. Every chunk's associated data binds the SHA-256 of
  the header, so a label cannot be moved onto another file's chunks. Inside, the plaintext is a
  sequence of frames (file start, bytes, file end, end of backup); names are plain relative paths,
  and restore refuses anything with a root, `.` or `..`.
- **Keys file.** `FATHOMBK ‖ u16 version ‖ Argon2id m, t, p ‖ salt[16] ‖ nonce[12] ‖ LP(label)`,
  then one ChaCha20-Poly1305 ciphertext with the whole header as associated data. The key is
  Argon2id over the phrase's 16 bytes at the parameters `credentials.rs` already cites (OWASP
  Password Storage Cheat Sheet, read 2026-09-21: 19 MiB, t=2, p=1). With 128 random bits the
  memory-hard step is belt and braces, not the bound. A reader refuses parameters far above any
  honest writer's, so a crafted file cannot demand gigabytes.
- **No new dependency.** `argon2`, `chacha20poly1305`, `hkdf` and `sha2` are already in the tree.

## The commands

`fathom-server backup`, `keys-file` and `restore`, none of which needs the database or the full
configuration. The server image is distroless and has no `pg_dump`, so in compose the dump comes
from the `db` container and is piped in; `docs/OPERATING.md` has the lines. `keys-init` now
generates `backup.key` beside the other keys.

**The dump is taken as the superuser, `fathom_bootstrap`.** The manual procedure this replaces said
`pg_dump -U fathom`, which fails on a real install: 43 tables are `FORCE ROW LEVEL SECURITY`, so the
owner is filtered and `pg_dump` refuses (reproduced against this schema on PostgreSQL 16,
2026-10-25). Restoring needs the two roles the migrations create, made as `fathom`, before
`pg_restore`; `docs/OPERATING.md` gives the order, and a dump restored that way was started by the
server, which continued the site chain and refused a different master key with exit 11.

## Not yet built, in the order the card lists them

The Settings › Backups screen, the nightly schedule with retention, the weekly restore test shown on
that screen, and a notice when a backup fails or the keys file is out of date. Copying to
S3-compatible storage is later still, and unticked on the card.

## Sources

- C2SP, `age.md`, "Payload" section, `github.com/C2SP/C2SP/blob/main/age.md`, read 2026-10-25.
- Hoang, Reyhanitabar, Rogaway, Vizár, *Online Authenticated-Encryption and its Nonce-Reuse
  Misuse-Resistance*, IACR ePrint 2015/189, read 2026-10-25: names STREAM; its construction is in
  the full version, which was not read, so the nonce layout above is cited to age, not to it.
- OWASP Password Storage Cheat Sheet, as cited in `crates/fathom-server/src/credentials.rs`
  (read 2026-09-21).
- `pg_dump -Fc` output begins with the bytes `PGDMP`: checked on 2026-10-25 against PostgreSQL 16's
  own `pg_dump`, then restored with `pg_restore` after a round trip through these commands.
