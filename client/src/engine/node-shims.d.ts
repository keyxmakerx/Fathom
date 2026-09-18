// Minimal ambient declarations for the handful of Node built-ins this
// directory's test harness and disk loader need.
//
// `@types/node` is already an approved devDependency
// (`client/package.json`, `deps/decisions/npm/@types__node.md`) but is
// deliberately NOT wired into `tsconfig.app.json`'s `"types"` — that file
// is DOM-only, mirroring the equally deliberate opposite split
// `tsconfig.node.json` makes for `vite.config.ts` (node-only, no DOM).
// Widening `tsconfig.app.json` to pull in all of `@types/node` for the sake
// of three functions used only by test/dev-time code would put Node's
// ambient globals in scope for every browser-shipped file under `src/`.
// These few lines are the narrower fix, scoped to the directory that
// actually needs them, and typed no wider than they are actually used.
declare module 'node:fs' {
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, encoding: 'utf8'): string;
}

declare module 'node:fs/promises' {
  // The real return type is `Buffer`, which is a `Uint8Array` subtype; typing
  // it as the parent is sufficient for every use in this directory
  // (`.buffer`/`.byteOffset`/`.byteLength`, all present on `Uint8Array`) and
  // avoids needing `Buffer`'s own ambient type.
  export function readFile(path: string): Promise<Uint8Array>;
}

declare module 'node:path' {
  export function dirname(path: string): string;
  export function resolve(...paths: string[]): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}
