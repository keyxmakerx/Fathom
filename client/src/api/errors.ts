// `crates/fathom-server/src/api.rs`'s `Refusal` keeps a fixed sentence per
// status and sends the real reason nowhere but its own log line -- "a
// refusal that explained itself would tell an attacker which of the checks
// they failed". This module carries that sentence to the screen verbatim
// and adds nothing: no interpretation, no invented cause, no distinction
// this client was not told about.

/** A refusal exactly as the server sent it: a status, its fixed sentence,
 * and — for the rate limiter only — how long it says to wait. */
export class ApiRefusal extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | null;

  constructor(status: number, message: string, retryAfterSeconds: number | null) {
    super(message);
    this.name = 'ApiRefusal';
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export async function refusalFrom(response: Response): Promise<ApiRefusal> {
  const text = (await response.text()).trim();
  const retryAfterHeader = response.headers.get('retry-after');
  const parsedRetryAfter = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : NaN;
  return new ApiRefusal(
    response.status,
    text.length > 0 ? text : 'refused',
    Number.isFinite(parsedRetryAfter) ? parsedRetryAfter : null,
  );
}
