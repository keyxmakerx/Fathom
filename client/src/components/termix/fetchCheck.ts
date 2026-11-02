// Fetch from Termix for a check step (ADR-0080 decision 9): off unless a steward turned it on, run
// only when the person presses it, and only for a command on the read-only list (`readOnly.ts`).
// Termix's Snippets add-on runs a stored snippet, not a line (`POST /plugin-api/snippets/execute`
// {snippetId, hostId}, Snippets 1.2.0 `d66ae50`, `src/backend/routes.ts`), so Fathom makes a snippet
// holding exactly the command, reads it back and runs it only if it is still exactly that, and
// deletes it afterwards whatever happened. The answer comes back to the browser, where it is treated
// as a paste: it goes into the check's paste box, and the redaction gate runs on it before anything
// is kept. Fathom never acts on it.

import { readOnlyVerdict } from './readOnly';
import { TermixError, call } from './termix';

export const CHECK_FOLDER = 'Fathom / checks';

type Fetch = typeof fetch;

export interface Fetched {
  output: string;
  /** Termix's own word: the command exited non-zero, or printed to stderr. */
  failed: boolean;
}

/** Termix's answer to /execute, including its own error words for 4xx and 5xx (Snippets' routes give them). */
async function execute(origin: string, key: string, snippetId: number, hostId: number, f: Fetch): Promise<Fetched> {
  let res: Response;
  try {
    res = await f(new URL('/plugin-api/snippets/execute', origin).toString(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ snippetId, hostId }),
      credentials: 'omit',
      redirect: 'error',
    });
  } catch {
    throw new TermixError('This browser could not reach Termix.');
  }
  if (res.status === 401) throw new TermixError('Termix refused the API key. It may have expired or been switched off; paste a new one.', 401);
  const body = (await res.json().catch(() => null)) as { output?: unknown; error?: unknown; errorOutput?: unknown; success?: unknown } | null;
  const words = typeof body?.error === 'string' ? body.error : '';
  if (!res.ok && typeof body?.output !== 'string') throw new TermixError(words || `Termix answered ${res.status}.`, res.status);
  const out = typeof body?.output === 'string' ? body.output : '';
  const err = typeof body?.errorOutput === 'string' ? body.errorOutput : words;
  return { output: err ? `${out}${out.endsWith('\n') || out === '' ? '' : '\n'}${err}` : out, failed: !res.ok || body?.success === false };
}

/**
 * Runs one read-only command on one Termix host and answers what it printed. Refuses, before sending
 * anything, a command that is not on the platform's read-only list.
 */
export async function fetchCheck(origin: string, key: string, platform: string, hostId: number, command: string, f: Fetch = fetch): Promise<Fetched> {
  const verdict = readOnlyVerdict(platform, command);
  if (!verdict.ok) throw new TermixError(verdict.why);
  try {
    await call(origin, key, 'POST', '/plugin-api/snippets/folders', { name: CHECK_FOLDER }, f);
  } catch (e) {
    if (!(e instanceof TermixError) || e.status !== 409) throw e;
  }
  const made = (await call(
    origin,
    key,
    'POST',
    '/plugin-api/snippets',
    { name: `Fathom check · ${command.slice(0, 60)}`, content: command, description: 'Made by Fathom for one read-only check, and deleted after it runs.', folder: CHECK_FOLDER, hostFilter: [hostId] },
    f,
  )) as { id?: unknown } | null;
  const id = typeof made?.id === 'number' ? made.id : Number(made?.id);
  if (!Number.isSafeInteger(id) || id < 1) throw new TermixError('Termix did not say which snippet it made.');
  try {
    const now = (await call(origin, key, 'GET', `/plugin-api/snippets/${id}`, undefined, f)) as { content?: unknown } | null;
    if (now?.content !== command) throw new TermixError('The snippet Fathom made changed before it ran, so it was not run.');
    return await execute(origin, key, id, hostId, f);
  } finally {
    await call(origin, key, 'DELETE', `/plugin-api/snippets/${id}`, undefined, f).catch(() => undefined);
  }
}
