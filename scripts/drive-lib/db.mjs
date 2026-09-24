// Database logins for the drives: the test suite's local defaults
// (crates/fathom-server/tests/support/mod.rs), overridable the same way.
const HOST = '127.0.0.1:5432';
const SUPERUSER = process.env.SUPERUSER_DATABASE_URL ?? `postgres://postgres:postgres@${HOST}/postgres`;

function onDatabase(url, db) {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

export const superuserUrl = (db) => onDatabase(SUPERUSER, db);
export const migrateUrl = (db) => `postgres://fathom_test:fathom_test_pw@${HOST}/${db}`;
export const runtimeUrl = (db) => `postgres://fathom_app:fathom_app_pw@${HOST}/${db}`;
