# `oxlint` — recorded 2026-10-27

**Owner-approved** on sign-off card r48 ("adopt eslint", ticked 2026-10-27). ESLint itself was
the pick, but it cannot read this client: `typescript-eslint` 8.72.1, the newest release, declares
`typescript: >=4.8.4 <6.1.0` as a peer (checked via `npm view`, 2026-10-27), and the client is on
TypeScript 7. `oxlint` parses TypeScript on its own, runs the same rule names (`react-hooks/*`,
`no-control-regex`, ...) and honours the `eslint-disable` comments already in the code, so it does
the job the owner approved.

| | |
|---|---|
| **Job** | Lints the client: `npm run lint` |
| **Version** | `1.88.0`, exact, pinned in `client/package-lock.json`. Released 2026-10-13; the newest (1.90.0) was a few hours old on the day of this record, so a two-week-old release was taken instead |
| **Publisher** | The oxc project, `repository.url` = `git+https://github.com/oxc-project/oxc`, maintainer `boshen` (checked via `npm view oxlint`, 2026-10-27) |
| **Licence** | MIT, compatible with ADR-0004 |
| **Ships or tooling** | **Tooling only.** `devDependencies`. Never reaches the built artifact |
| **Install scripts** | None on `oxlint` or the `@oxlint/binding-linux-x64-gnu` binding (`npm view ... scripts` empty, 2026-10-27). CI installs with `--ignore-scripts` regardless |
| **Native code** | Yes: the linter is a Rust binary shipped as one `@oxlint/binding-<platform>` optional dependency per platform. npm installs only the one matching the machine; every one is pinned by integrity in the lockfile like any other package |
| **Closure** | 20 lockfile entries, all `oxlint` and its per-platform bindings; no JavaScript dependencies |

## Why not first-party

A linter for TypeScript and React's hook rules is a parser plus a rule engine. Writing one buys
nothing and is time not spent on the product.

## Advisories

**Checked 2026-10-27**: `npm audit` reports nothing against `oxlint` or its bindings. It does report
four advisories already present before this package arrived, against `vite`, `vitest`,
`@vitest/mocker` and `source-map-js`; those are dev-server and test-runner issues and are tracked
separately. Goes stale immediately.

## The rules, and what is off

`client/.oxlintrc.json` turns on the correctness category as errors and React's two hook rules
(`rules-of-hooks` as an error, `exhaustive-deps` as a warning that does not fail CI yet, 38 open on
the day of adoption). Off for now: the React Compiler rules (`react/refs`, `set-state-in-effect`,
`immutability`, `purity`, `globals`, `use-memo`, `preserve-manual-memoization`), which flag about
130 places in code not written for the compiler, and five style rules (`unicorn/no-new-array`,
`no-useless-fallback-in-spread`, `no-useless-spread`, `prefer-string-starts-ends-with`,
`react/no-children-prop`). A disable comment that suppresses nothing fails the lint, so they stay
honest.
