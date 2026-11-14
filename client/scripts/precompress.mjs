// Writes `name.br` and `name.gz` beside every compressible file in `dist/`, so the server
// (`crates/fathom-server/src/client.rs`) can send the compressed bytes to a browser that accepts
// them without compressing anything itself. Node's own `zlib` does the work: no package is added.
// A file is only given a variant when the variant is smaller than the original.
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'

const DIST = new URL('../dist', import.meta.url).pathname
const COMPRESSIBLE = new Set(['.js', '.mjs', '.css', '.html', '.svg', '.json', '.wasm', '.webmanifest', '.txt'])
const SMALLEST = 1024

let before = 0
let brTotal = 0
let gzTotal = 0

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      walk(path)
      continue
    }
    if (!COMPRESSIBLE.has(extname(name))) continue
    const bytes = readFileSync(path)
    if (bytes.length < SMALLEST) continue
    const br = brotliCompressSync(bytes, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
      },
    })
    const gz = gzipSync(bytes, { level: 9 })
    before += bytes.length
    if (br.length < bytes.length) {
      writeFileSync(`${path}.br`, br)
      brTotal += br.length
    } else brTotal += bytes.length
    if (gz.length < bytes.length) {
      writeFileSync(`${path}.gz`, gz)
      gzTotal += gz.length
    } else gzTotal += bytes.length
  }
}

walk(DIST)
console.log(`precompress: ${before} bytes -> ${brTotal} brotli, ${gzTotal} gzip`)
