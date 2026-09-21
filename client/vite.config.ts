import { fileURLToPath, URL } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig, searchForWorkspaceRoot } from 'vite'

// The repository root, one level up from `client/`. `design/tokens.css`
// lives there, and `index.css` imports it in place rather than copying it
// (see src/index.css). Vite's dev server refuses to read files outside its
// detected workspace root unless told to, so that root is added to the
// allow list explicitly rather than assumed.
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

// Where the Rust server listens. Read from `crates/fathom-server/src/config.rs`
// (`FATHOM_BIND`, default `127.0.0.1:8080`) and confirmed against
// `deploy/compose.yaml`, which publishes the same port. Overridable so a
// developer running the server on a different port does not have to edit
// this file.
const apiTarget = process.env.FATHOM_API_PROXY_TARGET ?? 'http://127.0.0.1:8080'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      // `ports.html` is the static port-glyph gallery (`docs/UI-SPEC.md`
      // "Ports"); a second page, so it has to be named here to be built.
      input: {
        main: fileURLToPath(new URL('index.html', import.meta.url)),
        ports: fileURLToPath(new URL('ports.html', import.meta.url)),
      },
    },
  },
  server: {
    fs: {
      allow: [searchForWorkspaceRoot(process.cwd()), repoRoot],
    },
    // Only the routes `crates/fathom-server/src/api.rs` actually serves.
    // Widen this list as later slices add routes; a wildcard proxy here
    // would silently forward requests to endpoints that do not exist yet.
    proxy: {
      '/session': { target: apiTarget, changeOrigin: true },
      '/organisations': { target: apiTarget, changeOrigin: true },
      '/enrolment': { target: apiTarget, changeOrigin: true },
      '/admin': { target: apiTarget, changeOrigin: true },
      '/catalogue': { target: apiTarget, changeOrigin: true },
      // ADR-0055 stream (c): the unauthenticated console-host flag
      // (`GET /placement/flag`). It is deliberately NOT under `/admin` --
      // the answer a client needs on a host that is not the console host is
      // "no", and `/admin` is answered 404 exactly there -- so it needs its
      // own entry here. Without it the dev server answers 404 itself and the
      // failure looks like a missing route on the server.
      '/placement': { target: apiTarget, changeOrigin: true },
      // ADR-0055 client (a): the credential plane —
      // `/credentials/password`, `/credentials/key`,
      // `/credentials/totp/*` and `/credentials/reset*`
      // (`api.rs`'s `credential_router`). `/enrolment/operator/setup` is
      // already covered by the `/enrolment` entry above. Without this line
      // the dev server answers 404 itself and the failure looks like a
      // missing route on the server.
      // `/credentials/*` -- the password, the app code and this browser's
      // key. They are account-plane and answer on every host, exactly like
      // `/session`, so they need an entry of their own here; without it the
      // dev server answers its own 404 and the failure looks like a missing
      // route on the server.
      '/credentials': { target: apiTarget, changeOrigin: true },
    },
  },
})
