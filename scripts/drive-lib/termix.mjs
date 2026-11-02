// A real Termix, set up the way its own admin would through its API (ADR-0080 decision 1), for
// `scripts/drive-termix.mjs` and the CI job that runs it. Nothing here is Fathom code: this plays
// the Termix admin who makes a user and gives that user an API key.
//
// Routes read from Termix's source (github.com/Termix-SSH/Termix, v26.10.6 at c759a14, read
// 1 November 2026):
// - `POST /users/create` {username, password}: the first user made is the admin
//   (`src/backend/database/routes/users.ts`).
// - `POST /users/login` {username, password}: sets the `jwt` cookie (same file; the cookie is
//   written by `src/backend/auth/login-pipeline.ts`).
// - `GET /users/me`: `userId`, `username`, `is_admin` (same file).
// - `POST /users/api-keys` {name, userId}, admin only: answers `token`, `tmx_` and 64 hex, shown
//   once; `DELETE /users/api-keys/{id}` revokes it (`src/backend/database/routes/user-api-key-routes.ts`).
// - `GET`/`POST /host/db/host` and `DELETE /host/db/host/{id}` (`src/backend/database/routes/host.ts`).

/** Termix's own answer, or a thrown error naming the route and status. */
async function call(base, method, path, { body, cookie, bearer } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const res = await fetch(new URL(path, base), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // not JSON
  }
  return { status: res.status, json, text, res };
}

async function must(base, method, path, opts) {
  const r = await call(base, method, path, opts);
  if (r.status < 200 || r.status > 299) throw new Error(`Termix ${method} ${path} answered ${r.status}: ${r.text.slice(0, 300)}`);
  return r;
}

/** Waits until Termix's backend answers its health route. */
export async function waitForTermix(base, timeoutMs = 180000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(new URL('/health', base));
      if (r.ok) return true;
    } catch {
      // not up yet
    }
    if (Date.now() > end) return false;
    await new Promise((res) => setTimeout(res, 1000));
  }
}

/** The admin: made when there is no user yet, then signed in. Answers its cookie and id. */
export async function termixAdmin(base, username, password) {
  const made = await call(base, 'POST', '/users/create', { body: { username, password } });
  if (made.status !== 200 && made.status !== 201 && made.status !== 409) {
    throw new Error(`Termix POST /users/create answered ${made.status}: ${made.text.slice(0, 300)}`);
  }
  const login = await must(base, 'POST', '/users/login', { body: { username, password } });
  const set = login.res.headers.getSetCookie?.() ?? [];
  const jwt = set.map((c) => c.split(';')[0]).find((c) => c.startsWith('jwt='));
  const cookie = jwt ?? (login.json?.token ? `jwt=${login.json.token}` : null);
  if (!cookie) throw new Error(`Termix signed ${username} in but set no jwt cookie: ${login.text.slice(0, 300)}`);
  const me = await must(base, 'GET', '/users/me', { cookie });
  return { cookie, userId: me.json.userId, isAdmin: me.json.is_admin === true };
}

/** An API key for a user, made by the admin. Answers `{ id, token }`. */
export async function makeApiKey(base, admin, userId, name) {
  const r = await must(base, 'POST', '/users/api-keys', { cookie: admin.cookie, body: { name, userId } });
  return { id: r.json.id, token: r.json.token };
}

export async function revokeApiKey(base, admin, id) {
  await must(base, 'DELETE', `/users/api-keys/${encodeURIComponent(id)}`, { cookie: admin.cookie });
}

/** The hosts the key's user can see, as Termix answers them. */
export async function hosts(base, token) {
  return (await must(base, 'GET', '/host/db/host', { bearer: token })).json;
}

/** A host made as the key's user, the way a person would in Termix. */
export async function addHost(base, token, host) {
  return (await must(base, 'POST', '/host/db/host', { bearer: token, body: { connectionType: 'ssh', authType: 'none', port: 22, ...host } })).json;
}

/** Turns a Termix add-on on or off, as Termix's admin (`PATCH /plugins/{id}/state`, core v26.10.6,
 * `src/backend/database/routes/plugins.ts`). Answers Termix's reply. */
export async function setAddOn(base, admin, id, enabled) {
  return call(base, 'PATCH', `/plugins/${encodeURIComponent(id)}/state`, { cookie: admin.cookie, body: { enabled } });
}

/** `GET /plugins` as the key's user: `id`, `enabled`, `state` for each installed add-on. */
export async function addOns(base, token) {
  return (await must(base, 'GET', '/plugins', { bearer: token })).json;
}

export { call as termixCall };
