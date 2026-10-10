# Fathom

A security-first network documentation and diagramming tool. One typed graph, several views over it:
a drawing (racks, devices, ports, cables), an inventory, checks that say why, and docs. Teaching and
estate-of-record are co-equal goals.

**Server product.** Data lives on the server and the browser is a window onto it. Multi-tenant,
organisations and designs, live co-editing.

**Status (2026-10-10): built and green, not yet usable.** "Usable" is the owner's word and means beta:
polished, the app basically done, a few features allowed to be missing. Green gates do not grant it; a
walkthrough by the owner does. What exists is in `docs/STATE.md`; what is next is in GitHub issues.

## What it will never do

- **Touch a device.** No SSH, SNMP, polling or discovery. Configuration arrives because a person pastes
  or types it.
- **Keep a device credential.** The redaction gate (Rust, compiled to WebAssembly, run in the browser)
  destroys passwords, pre-shared keys and community strings at the paste box, before anything is stored
  or sent; the server refuses any that still arrive. A secret typed by hand into a free-text field is not
  pasted config: Fathom marks it and stores it as typed (ADR-0041).
- **Claim more than it has.** The server holds the keys and says so (ADR-0040). `CLAUDE.md` rule 5 lists
  the four sentences that stay forbidden until customer-held keys are real; `scripts/forbidden-claims.sh`
  enforces it.

## Try it

```
cp .env.example .env     # set FATHOM_OPERATOR_NOTICE_ADDRESS and FATHOM_SETUP_PASSWORD
docker compose up -d
```

Open the published port behind your own TLS proxy, redeem the setup token, sign in. Full steps, from
source too: `docs/RUNNING-IT.md`. Keys, backups, restore and rekey: `docs/OPERATING.md`. Short worked
tasks on what main supports: `docs/EXAMPLES.md`.

## Where things are

| | |
|---|---|
| `CLAUDE.md` | Rules that bind every session; the pointer page |
| `docs/STATE.md` | What is built right now |
| `docs/UI-SPEC.md` | The interface, approved |
| `docs/decisions/` | ADRs; `README.md` is the index |
| `docs/NEXT.md` | How to work on it |
| `docs/REBUILD-PLAN.md` | The rebuild's reasoning and phases |
| `docs/archive/` | History. Do not read unless a task names a file |
| `.context/` | Conventions and the owner's original inputs |
| `schema/` | The declared graph schema (a field not here does not exist) |
| `corpus/` | Device dictionaries, catalogue, rules (with fixtures), explainers; CC BY-SA 4.0 |
| `crates/` | Rust: engine crates (`fathom-schema`, `-ir`, `-graph`, `-ingest`, `-rules`, `-layout`, `-wasm`, ...) and `fathom-server` |
| `client/` | React + Vite + React Flow web app, plain CSS |
| `deploy/`, `compose.yaml` | The image and the composed stack |
| `scripts/` | CI gates and the browser drive scripts |

## Contributing

`CONTRIBUTING.md`. Sign off commits (DCO). Before a pull request:

```
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo test --workspace --locked
cargo run -p fathom-schema --bin fathom-schema-check
./scripts/gate-zero.sh
./scripts/gate-npm.sh
```

Licence: Apache-2.0 (`LICENSE`, `NOTICE`); `corpus/` is CC BY-SA 4.0. *Fathom* is a working name
(ADR-0005 requires a rename before publication).
