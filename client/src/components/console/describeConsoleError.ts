import { ApiRefusal } from '../../api/errors';

/**
 * The server's own wording where it gave one (`api/errors.ts`: *"a refusal
 * that explained itself would tell an attacker which of the checks they
 * failed"*), with two additions this board can stand behind and nothing
 * else. No interpretation, no invented cause.
 *
 * - **404 on a console route** is what `admin_exposure.rs` answers when the
 *   console is confined elsewhere than this request. An operator who sees it
 *   needs to be told which door to try, and since ADR-0055 there are two
 *   places that confinement can come from: the environment, or a placement
 *   set in this console.
 * - **503** is a route that exists and has nothing behind it yet; its
 *   sentence is the server's.
 */
export function describeConsoleError(error: unknown): string {
  if (error instanceof ApiRefusal) {
    if (error.status === 404) {
      return (
        'The console does not answer on this host or from this address. Either FATHOM_ADMIN_HOSTS / ' +
        'FATHOM_ADMIN_SOURCES confine it, or a placement set in this console moved it and has not been ' +
        'confirmed from here.'
      );
    }
    return error.retryAfterSeconds != null
      ? `${error.message} Try again in ${error.retryAfterSeconds}s.`
      : error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'That request did not complete.';
}
