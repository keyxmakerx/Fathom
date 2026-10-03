// Benchmark for incremental Checks loading (OP_SYNC). Builds an N-device design with the app's own commands,
// times the first full load, then typical edits (move, add a cable, set a field, tag, undo, ...) through
// Mirror.sync + checks against the built module, no CPU throttle. Prints p50/p95.
//
// Usage: bash scripts/build-wasm.sh (once), then
//   node scripts/bench-checks-sync.mjs [--devices 1000] [--edits 20] [--old 3]
// Overrides: FATHOM_ROOT. The client sources are bundled with the client's own vite, so run `npm ci` in client/ first.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = process.env.FATHOM_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = join(ROOT, 'client');
const WASM = join(CLIENT, 'public/engine/fathom_wasm.wasm');
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : dflt;
};

if (!existsSync(WASM)) {
  console.error(`${WASM} does not exist; run: bash scripts/build-wasm.sh`);
  process.exit(2);
}

const vite = await import(pathToFileURL(createRequire(join(CLIENT, 'package.json')).resolve('vite')).href);
const out = mkdtempSync(join(tmpdir(), 'fathom-bench-'));
try {
  await vite.build({
    root: CLIENT,
    configFile: false,
    logLevel: 'error',
    build: { ssr: join(ROOT, 'scripts/bench-checks-sync.entry.ts'), outDir: out, emptyOutDir: true, minify: false },
    ssr: { noExternal: true },
  });
  const bundle = join(out, 'bench-checks-sync.entry.js');
  const { run } = await import(pathToFileURL(bundle).href);
  await run({
    wasmPath: WASM,
    devices: arg('devices', 1000),
    edits: arg('edits', 20),
    oldPath: arg('old', 3),
    log: (line) => console.log(line),
  });
} finally {
  rmSync(out, { recursive: true, force: true });
}
