#!/usr/bin/env node
// Licences for the browser client (ADR-0060 decision 12). Every package in
// client/package-lock.json must be under a licence on the list below, the same
// list deny.toml holds the Rust dependencies to. The About page's list of
// shipped libraries must also match the lockfile.
//
// Run: node scripts/licences-npm.mjs          check; exit 1 on any problem
//      node scripts/licences-npm.mjs --write  regenerate the About page's list
//                                              (reads copyright lines from node_modules)

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK = process.env.LICENCES_LOCK ?? join(ROOT, 'client/package-lock.json');
const OUT = process.env.LICENCES_OUT ?? join(ROOT, 'client/src/components/about/licences.json');
const MODULES = process.env.LICENCES_MODULES ?? join(ROOT, 'client/node_modules');

const SHIPPED = new Set([
  'Apache-2.0',
  'Apache-2.0 WITH LLVM-exception',
  'MIT',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'Unicode-3.0',
  'Zlib',
  'CC0-1.0',
]);
// Build tools never reach the browser bundle, so MPL-2.0's file-level copyleft
// asks nothing of Fathom. It appears through Vite's CSS tooling.
const BUILD_ONLY = new Set([...SHIPPED, 'MPL-2.0']);

// An SPDX expression: OR needs one side allowed, AND needs both, WITH binds an
// exception to the licence before it.
function allowed(expression, list) {
  const tokens = expression.replace(/[()]/g, (p) => ` ${p} `).trim().split(/\s+/);
  let i = 0;
  function factor() {
    if (tokens[i] === '(') {
      i += 1;
      const v = orExpr();
      if (tokens[i] !== ')') throw new Error('unbalanced parentheses');
      i += 1;
      return v;
    }
    let id = tokens[i];
    i += 1;
    if (id === undefined) throw new Error('empty expression');
    if (tokens[i] === 'WITH') {
      id = `${id} WITH ${tokens[i + 1]}`;
      i += 2;
    }
    return list.has(id);
  }
  function andExpr() {
    let v = factor();
    while (tokens[i] === 'AND') {
      i += 1;
      v = factor() && v;
    }
    return v;
  }
  function orExpr() {
    let v = andExpr();
    while (tokens[i] === 'OR') {
      i += 1;
      v = andExpr() || v;
    }
    return v;
  }
  try {
    const v = orExpr();
    return i === tokens.length && v;
  } catch {
    return false;
  }
}

function copyrightOf(name) {
  for (const file of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'LICENCE', 'license.md']) {
    const path = join(MODULES, name, file);
    if (!existsSync(path)) continue;
    const line = readFileSync(path, 'utf8')
      .split('\n')
      .find((l) => /copyright/i.test(l) && /\d{4}|\(c\)|©/i.test(l));
    return line ? line.trim().replace(/<<([^>]+)>>/g, '<$1>') : null;
  }
  return null;
}

const lock = JSON.parse(readFileSync(LOCK, 'utf8'));
const problems = [];
const shipped = new Map();
let buildOnly = 0;

for (const [path, entry] of Object.entries(lock.packages ?? {})) {
  if (path === '') continue;
  const name = entry.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
  const dev = entry.dev === true;
  const licence = typeof entry.license === 'string' ? entry.license.trim() : '';
  if (licence === '') {
    problems.push(`${name}@${entry.version}: no licence recorded in the lockfile`);
    continue;
  }
  if (!allowed(licence, dev ? BUILD_ONLY : SHIPPED)) {
    problems.push(`${name}@${entry.version}: "${licence}" is not on the ${dev ? 'build-tool' : 'shipped'} list`);
  }
  if (dev) buildOnly += 1;
  else shipped.set(`${name}@${entry.version}`, { name, version: entry.version, license: licence });
}

const list = [...shipped.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

if (process.argv.includes('--write')) {
  const withCopyright = list.map((p) => ({ ...p, copyright: copyrightOf(p.name) }));
  writeFileSync(OUT, `${JSON.stringify(withCopyright, null, 2)}\n`);
  console.log(`licences-npm: wrote ${list.length} shipped packages to ${OUT}`);
} else {
  let current = null;
  try {
    current = JSON.parse(readFileSync(OUT, 'utf8'));
  } catch {
    problems.push(`${OUT} is missing or unreadable: run node scripts/licences-npm.mjs --write`);
  }
  if (current !== null) {
    const key = (p) => `${p.name}@${p.version} ${p.license}`;
    const want = list.map(key).join('\n');
    const have = Array.isArray(current) ? current.map(key).join('\n') : '';
    if (want !== have) {
      problems.push("the About page's list does not match the lockfile: run node scripts/licences-npm.mjs --write");
    }
  }
}

if (problems.length > 0) {
  for (const p of problems) console.log(`licences-npm: FAIL  ${p}`);
  process.exit(1);
}
console.log(`licences-npm: OK  ${list.length} shipped packages and ${buildOnly} build tools, all on the list`);
