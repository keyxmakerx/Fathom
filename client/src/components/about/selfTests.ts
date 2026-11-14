// The checks "About this Fathom" runs when it opens and on "Run again" (card r135, question 2,
// A). Each one is something this browser can see for itself, and none of them sends anything
// anywhere but this server. The outside world is passed in, so a test can drive every branch.

import type { About } from '../../api/about';

export type Outcome = 'pass' | 'fail' | 'skip';

export interface CheckResult {
  id: 'server' | 'build' | 'gate' | 'protections' | 'reader';
  label: string;
  outcome: Outcome;
  /** One sentence a person can read: what was found. */
  detail: string;
}

export interface SelfTestDeps {
  /** `GET /health`'s body, or a thrown error. */
  health: () => Promise<string>;
  /** `GET /about`, already parsed, or a thrown error. */
  about: () => Promise<About>;
  /** The commit this page was built from; empty in a development build. */
  pageCommit: string;
  /** Runs text through the real redaction gate (the engine, compiled for the browser). */
  redact: (text: string) => Promise<string>;
  /** The page's own address. */
  location: { protocol: string; hostname: string };
  /** The `Content-Security-Policy` header this server sent with the page, or null. */
  pagePolicy: () => Promise<string | null>;
}

/**
 * The canary the engine's own tests use (a real IOS line, with a password a device would take).
 * The gate must take the secret out; the check never sends the text anywhere.
 */
export const CANARY_SECRET = 'Sup3rS3cret!';
const CANARY = `enable secret ${CANARY_SECRET}`;

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Runs every check. Never throws: a check that cannot run says so in its own row. */
export async function runSelfTests(deps: SelfTestDeps): Promise<{ about: About | null; results: CheckResult[] }> {
  const results: CheckResult[] = [];

  try {
    const body = (await deps.health()).trim();
    results.push(
      body === 'ok'
        ? { id: 'server', label: 'Server and database', outcome: 'pass', detail: 'The server answered and can reach its database.' }
        : { id: 'server', label: 'Server and database', outcome: 'fail', detail: 'The server answered, but not with “ok”.' },
    );
  } catch (e) {
    results.push({ id: 'server', label: 'Server and database', outcome: 'fail', detail: `The server did not answer: ${why(e)}` });
  }

  let about: About | null = null;
  try {
    about = await deps.about();
  } catch (e) {
    results.push({ id: 'build', label: 'Same build', outcome: 'fail', detail: `Could not ask the server which build it is: ${why(e)}` });
  }
  if (about) {
    if (about.commit === '' || deps.pageCommit === '') {
      results.push({ id: 'build', label: 'Same build', outcome: 'skip', detail: 'This is a development build, which carries no commit to compare.' });
    } else if (about.commit === deps.pageCommit) {
      results.push({ id: 'build', label: 'Same build', outcome: 'pass', detail: 'This page and the server were built from the same commit.' });
    } else {
      results.push({
        id: 'build',
        label: 'Same build',
        outcome: 'fail',
        detail: 'This page and the server were built from different commits. Reload the page; if it stays, the server was updated part way.',
      });
    }
  }

  try {
    const out = await deps.redact(CANARY);
    results.push(
      out.includes(CANARY_SECRET)
        ? { id: 'gate', label: 'Redaction gate', outcome: 'fail', detail: 'A test password went through the gate untouched. Do not paste configs until this passes.' }
        : { id: 'gate', label: 'Redaction gate', outcome: 'pass', detail: 'A test password pasted here was taken out before anything could be sent.' },
    );
  } catch (e) {
    results.push({ id: 'gate', label: 'Redaction gate', outcome: 'fail', detail: `The gate did not start: ${why(e)}` });
  }

  const secure = deps.location.protocol === 'https:' || LOCAL.has(deps.location.hostname);
  let policy: string | null = null;
  try {
    policy = await deps.pagePolicy();
  } catch {
    policy = null;
  }
  const locked = policy != null && policy.trim().startsWith("default-src 'none'");
  if (!secure) {
    results.push({ id: 'protections', label: 'Browser protections', outcome: 'fail', detail: 'This page was not loaded over HTTPS, so what you send can be read on the way.' });
  } else if (!locked) {
    results.push({
      id: 'protections',
      label: 'Browser protections',
      outcome: policy == null && LOCAL.has(deps.location.hostname) ? 'skip' : 'fail',
      detail:
        policy == null
          ? 'The page came without its content policy, which a development server leaves off.'
          : 'The page’s content policy is not the one Fathom sends.',
    });
  } else {
    results.push({
      id: 'protections',
      label: 'Browser protections',
      outcome: 'pass',
      detail: 'Loaded over HTTPS, with the content policy that limits where this page may send anything.',
    });
  }

  if (about?.connections.deviceRead) {
    results.push(
      about.reader
        ? { id: 'reader', label: 'Device reader', outcome: 'pass', detail: 'The device reader answered. Checking it read nothing from any device.' }
        : { id: 'reader', label: 'Device reader', outcome: 'fail', detail: 'Device reading is on, but the reader did not answer.' },
    );
  }

  return { about, results };
}
