// Guards the hand-written table in `protocol.constants.ts` against the
// generated one another agent is adding in parallel
// (`client/src/engine/protocol.generated.json`, opcodes/faces/errors). Until
// that file exists this test skips, loudly, rather than passing silently —
// the difference between "nothing to check yet" and "checked and agrees"
// matters here, because a green suite with a skipped guard reads very
// differently from a green suite with no guard at all.
//
// Expected generated shape: `{ opcodes: {...}, faces: {...}, errors: {...} }`
// — three name-to-number tables, the same three this file hand-maintains,
// named the way `protocol.rs`/`lib.rs` spell their own constants (e.g.
// `OP_PASTE`, `FACE_PASTE`, `ERR_NO_DICTIONARY`). If the generator lands with
// a different shape, this test's failure message says exactly what it read
// instead of what it expected, which is the fastest way to find out.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ERRORS, FACES, OPCODES } from './protocol.constants';

const GENERATED_PATH = fileURLToPath(new URL('./protocol.generated.json', import.meta.url));

interface GeneratedTables {
  opcodes?: Record<string, number>;
  faces?: Record<string, number>;
  errors?: Record<string, number>;
}

function diffTable(name: string, ours: Record<string, number>, theirs: Record<string, number>): string[] {
  const problems: string[] = [];
  const keys = new Set([...Object.keys(ours), ...Object.keys(theirs)]);
  for (const key of keys) {
    const mine = ours[key];
    const generated = theirs[key];
    if (mine === undefined) {
      problems.push(`${name}.${key}: generated says ${generated}, protocol.constants.ts has no entry`);
    } else if (generated === undefined) {
      problems.push(`${name}.${key}: protocol.constants.ts says ${mine}, protocol.generated.json has no entry`);
    } else if (mine !== generated) {
      problems.push(`${name}.${key}: protocol.constants.ts says ${mine}, protocol.generated.json says ${generated}`);
    }
  }
  return problems;
}

describe('protocol.constants.ts vs. protocol.generated.json', () => {
  if (!existsSync(GENERATED_PATH)) {
    it.skip(
      'protocol.generated.json does not exist yet — another agent is adding it in parallel; ' +
        'protocol.constants.ts is the hand-copied authority until it lands',
      () => {},
    );
    return;
  }

  it('agrees with the generated tables, name for name and number for number', () => {
    const generated = JSON.parse(readFileSync(GENERATED_PATH, 'utf8')) as GeneratedTables;
    const problems = [
      ...diffTable('opcodes', OPCODES, generated.opcodes ?? {}),
      ...diffTable('faces', FACES, generated.faces ?? {}),
      ...diffTable('errors', ERRORS, generated.errors ?? {}),
    ];
    expect(problems, problems.join('\n')).toEqual([]);
  });
});
