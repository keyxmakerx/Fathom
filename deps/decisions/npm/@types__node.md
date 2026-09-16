# `@types/node` — recorded 2026-09-16

**Owner-approved** as a consequence of the TypeScript/Vite stack decision of 2026-09-11: Vite's own
config (`client/vite.config.ts`, `client/vitest.config.ts`) and tooling run under Node and are
type-checked against it.

| | |
|---|---|
| **Job** | TypeScript type declarations for Node.js APIs — needed so `client/vite.config.ts` and `client/vitest.config.ts` type-check; `vite` itself depends on it for the same reason |
| **Version** | `26.5.1`, pinned in `client/package-lock.json` |
| **Publisher** | DefinitelyTyped, published under the npm `types` account, maintained by Microsoft's types bot (`maintainers`: `types <ts-npm-types@microsoft.com>`); `repository.url` = `https://github.com/DefinitelyTyped/DefinitelyTyped.git`, this package's subtree at `types/node` (checked via `npm view @types/node`, 2026-09-16) |
| **Licence** | MIT — compatible with ADR-0004 |
| **Ships or tooling** | **Tooling only.** `devDependencies`. Type declarations have no runtime presence at all — erased entirely by the TypeScript compiler |
| **Install scripts** | None on this package's lockfile entry (checked 2026-09-16) |
| **Native/postinstall code** | None. Pure `.d.ts` declaration files |
| **Determinism** | Not evaluated against ADR-0032's criterion — has no runtime behaviour to assess |

## Why not first-party

Hand-writing Node's own type declarations would mean re-deriving Node's API surface from its
documentation and keeping it in step forever; DefinitelyTyped is the community's single shared
answer to that and every TypeScript project depending on Node uses it.

## Advisories

**Checked 2026-09-16**: `npm audit --json` over the whole lockfile — 0 vulnerabilities. A type-only
package has essentially no runtime attack surface to begin with. Goes stale immediately.
