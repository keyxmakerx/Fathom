# The bundled common-password list — vendored 2026-09-21

**Not a crate.** A text file, `crates/fathom-server/data/common-passwords.txt`, pulled into the
binary with `include_str!` by `crates/fathom-server/src/credentials.rs`. It adds nothing to
`Cargo.lock` and nothing to `scripts/gate-zero.sh`'s count; it is recorded here anyway because it
is third-party content this product ships, and that is the same question a crate record answers.

## Why it exists

ADR-0055 decision 10: a password is *"refused when it is on a bundled list of common passwords"*,
and the ADR's own reading of NIST SP 800-63B revision 4 §3.1.1.2 is that a password used with a
second factor must be *"checked against a blocklist of known-compromised values"*. The same
decision says the online breach check *"is an option for a server with egress and off otherwise,
because Fathom may run air-gapped"* — so the offline list is the part that always works, and it is
what ships.

## What was fetched, exactly

| | |
|---|---|
| **Source** | `danielmiessler/SecLists`, `Passwords/Common-Credentials/10k-most-common.txt` |
| **URL** | `https://raw.githubusercontent.com/danielmiessler/SecLists/master/Passwords/Common-Credentials/10k-most-common.txt` |
| **Fetched** | 2026-09-21, over HTTPS, in this worktree |
| **Licence** | MIT. `https://raw.githubusercontent.com/danielmiessler/SecLists/master/LICENSE`, read the same day: *"MIT License / Copyright (c) 2018 Daniel Miessler"* |
| **Size** | 73,026 bytes, 10,001 entries, one per line, all distinct |
| **SHA-256 of the vendored file** | `68782d6a4a19a4768d5f15dd66bd534e7a33055cc755411e33f16d18c50fdcce` |

**The file the task named was not the file that exists, and this is the correction.** The brief
said `10-million-password-list-top-10000.txt`. That path answers **404** on
`raw.githubusercontent.com` today, checked twice, against both `master` and
`refs/heads/master`; the repository itself answers 200, so it is the path that moved and not the
network. `10k-most-common.txt` is the file at the same directory today, it holds the same ten
thousand entries the named file held, and it is what was vendored. **Nothing was invented and no
entry was written by hand** — the file is byte-for-byte what the URL above returned.

**No commit hash is recorded, and that is a gap.** `api.github.com` is not reachable from this
session (the proxy answers with a message about repository access), so the commit that `master`
pointed at could not be read. The SHA-256 above is what stands in its place: it pins the content,
which is the fact that matters, and it is reproducible by anyone who fetches the same URL and gets
the same bytes. Re-establish the commit before quoting this record anywhere user-facing.

## What the list is and is not

It is a **list of the most common passwords**, not a list of this deployment's compromised ones.
Refusing a password on it stops the guess an attacker makes first; it says nothing about whether a
password not on it has been breached. `credentials.rs` compares **lowercased**, so `PASSWORD` and
`Password` are refused exactly as `password` is — the attacker's dictionary is case-folded and
the check has to be too.

It is deliberately **not** the whole ten-million list, which is tens of megabytes: this one is 73
kibibytes compiled into the binary, and the ADR's ceiling argument (`35` §5.1) is about what
ships. A server with egress may later add the online breach check decision 10 names as an option;
this file is the floor that works air-gapped.

## Determinism, build.rs, proc macros

None, none, none. It is a text file read at compile time by `include_str!`. The same bytes produce
the same binary.
