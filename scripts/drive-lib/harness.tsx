// Test harness for the drawing drives, copied into client/src/ as drive.tsx
// only while a drive runs. Mounts the real App signed in, with fetch answered
// here; the redaction gate is the real wasm, never reimplemented.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './index.css';
import App from './App';
import { concatBytes, lp, u64LE } from './crypto/bytes';
import { generateKeyPair } from './crypto/keys';
import { SCHEMA_VERSION, writePlain } from './document/plain';
import { newUlid } from './document/ulid';
import { Engine } from './engine/engine';
import { setSession } from './state/sessionState';
import {
  catalogueFrom,
  seedConflictingChange,
  seedConnectedDevices,
  seedEmptyDesign,
  seedFreestanding,
  seedNetworksScene,
  seedSingleDevice,
} from './drive-seed';

const ORG_ID = 'org-drive';
const SCOPE_ID = 'scope-drive';
const DESIGN_ID = 'design-drive';
/** The signed-in account this harness installs — every seeded batch below
 * is stamped with this same id, so `document/undo.ts`'s `undoable` finds
 * them as "mine". A real ulid, not a readable string: the wasm engine
 * parses every provenance `assertedBy` as one (`Id(Ulid(...))`) the moment a
 * chassis is selected and the document is loaded into it. */
const ME = newUlid();
/** ADR-0053 §3's "you undo your own changes": a second, real account whose
 * own batch can conflict with one of mine — also a real ulid, for the same
 * reason. */
const COLLEAGUE = newUlid();

// Bytes to latin1, built in a loop — never `String.fromCharCode(...bytes)`
// with a spread, which overflows the call stack on a real document's byte
// length and would show up here as a fake save conflict.
function bytesToLatin1(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
  return s;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}

async function bodyBytes(init?: RequestInit): Promise<Uint8Array> {
  const body = init?.body;
  if (body == null) return new Uint8Array(0);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return new Uint8Array(await new Response(body as BodyInit).arrayBuffer());
}

function schemaMinor(): number {
  const m = /^0\.(\d+)$/.exec(SCHEMA_VERSION);
  if (!m) throw new Error(`SCHEMA_VERSION "${SCHEMA_VERSION}" is not "0.<minor>"`);
  return Number.parseInt(m[1], 10);
}

interface RecordedRequest {
  method: string;
  url: string;
  bodyLatin1: string;
}

declare global {
  interface Window {
    __requests__: RecordedRequest[];
    /** The two real ulids `ME`/`COLLEAGUE` above, so a driving script can
     * assert against the colleague's actual id without guessing one. */
    __driveActors__: { me: string; colleague: string };
    /** Every payload this mocked backend "saves" (the `POST .../versions`
     * handler below) is also loaded through the real engine, right here, the
     * moment it lands — so a document the server would actually refuse can
     * never hide behind a mock that accepted it. Empty when every save this
     * scene made was loadable; a driving script asserts on that after each
     * scene. */
    __saveLoadFailures__: string[];
    /** "Assert each scene saved at least once" — every successful
     * `POST .../versions` this scene's mocked backend answered, so a driving
     * script can tell a scene that never wrote anything apart from one whose
     * writes all happened to load fine. */
    __saveCount__: number;
  }
}

async function main() {
  window.__driveActors__ = { me: ME, colleague: COLLEAGUE };
  const params = new URLSearchParams(window.location.search);
  const scene = params.get('scene') ?? 'empty';
  const capability = params.get('capability') === 'read' ? 'read' : 'steward';

  const cat = await (await fetch('/drive-catalogue.json')).json();
  const catalogue = catalogueFrom(cat);

  let doc;
  if (scene === 'trail') doc = seedConnectedDevices(catalogue, ME);
  else if (scene === 'conflict') doc = seedConflictingChange(catalogue, ME, COLLEAGUE);
  else if (scene === 'note' || scene === 'typed') doc = seedSingleDevice(catalogue, ME);
  else if (scene === 'freestanding') doc = seedFreestanding(catalogue, ME);
  else if (scene === 'networks' || scene === 'networks-010') doc = seedNetworksScene(catalogue, ME);
  else doc = seedEmptyDesign();

  let version = 1;
  let bytes = writePlain(doc);
  // ADR-0058's drive check: "open a 0.10 design" — the header alone is
  // downgraded (decision 6 is additive, so a 0.10 declaration over this
  // scene's nodes is still legal), the same substitution `plain.test.ts`'s
  // "opens a 0.10 vector" tests make.
  if (scene === 'networks-010') {
    const text = new TextDecoder().decode(bytes);
    const downgraded = text.replace(`schema ${SCHEMA_VERSION}`, 'schema 0.10');
    if (downgraded === text) throw new Error('networks-010: the schema-version substitution did not land');
    bytes = new TextEncoder().encode(downgraded);
  }
  const minor = schemaMinor();

  // Boot the real engine once, so every mocked save below can be checked
  // against it — the same `engine.loadPlain` the lead's "a design stays
  // saveable after undo" proof calls, just run here for every scene rather
  // than one test.
  window.__saveLoadFailures__ = [];
  window.__saveCount__ = 0;
  let verifyEngine: Engine | null = null;
  try {
    verifyEngine = await Engine.init();
  } catch (e) {
    window.__saveLoadFailures__.push(`the verifying engine itself failed to boot: ${e instanceof Error ? e.message : String(e)}`);
  }

  window.__requests__ = [];
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const requestBody = await bodyBytes(init);
    window.__requests__.push({ method, url, bodyLatin1: bytesToLatin1(requestBody) });

    const u = new URL(url, location.origin);
    const p = u.pathname;
    const org = `/organisations/${ORG_ID}`;

    if (method === 'POST' && p === '/session/nonce') {
      // LP(nonce) || u64(issued_counter), the answer the client reads (ADR-0057 decision 4).
      const nonce = lp(crypto.getRandomValues(new Uint8Array(16)));
      return new Response(concatBytes(nonce, u64LE(0)) as BodyInit, { status: 200 });
    }
    if (method === 'GET' && p === '/setup/state') {
      return new Response(lp(new TextEncoder().encode('done')) as BodyInit, { status: 200 });
    }
    if (method === 'GET' && p === '/placement/flag') {
      return new Response(lp(new TextEncoder().encode('no')) as BodyInit, { status: 200 });
    }
    if (method === 'GET' && p === '/organisations') {
      return json([{ organisation_id: ORG_ID, display_name: 'Drive Org' }]);
    }
    if (method === 'GET' && p === `${org}/scopes`) {
      return json([
        {
          scope_id: SCOPE_ID,
          parent_scope_id: null,
          kind: 'network',
          display_name: 'Drive network',
          depth: 0,
          path: 'drive',
          capability: 'steward',
        },
      ]);
    }
    if (method === 'GET' && p === `${org}/designs`) {
      return json([
        {
          design_id: DESIGN_ID,
          scope_id: SCOPE_ID,
          created_at_unix: Math.floor(Date.now() / 1000),
          created_by: ME,
          capability,
          latest_version: version,
        },
      ]);
    }
    if (method === 'GET' && p === `${org}/designs/${DESIGN_ID}`) {
      return new Response(bytes as BodyInit, {
        status: 200,
        headers: {
          'fathom-design-version': String(version),
          'fathom-payload-schema-version': String(minor),
        },
      });
    }
    if (method === 'POST' && p === `${org}/designs/${DESIGN_ID}/versions`) {
      const base = Number(u.searchParams.get('base'));
      if (base !== version) {
        return new Response(`the design is at version ${version}; this save was based on version ${base}\n`, {
          status: 409,
        });
      }
      version += 1;
      bytes = requestBody.slice(4);
      window.__saveCount__ += 1;
      if (verifyEngine) {
        try {
          verifyEngine.loadPlain(bytes);
        } catch (e) {
          window.__saveLoadFailures__.push(`save at version ${version} does not load through the engine: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return new Response(`${version}\n`, { status: 200 });
    }
    if (method === 'GET' && p === '/catalogue/models') {
      return json(cat.list);
    }
    if (method === 'GET' && p.startsWith('/catalogue/models/')) {
      const parts = p.split('/');
      const vendor = decodeURIComponent(parts[3] ?? '');
      const model = decodeURIComponent(parts[4] ?? '');
      const hit = cat.models[`${vendor}/${model}`];
      return hit ? json(hit) : new Response('no such model\n', { status: 404 });
    }
    return realFetch(input as RequestInfo, init);
  };

  setSession({
    sessionId: 'drive-session',
    kind: 'steward',
    token: new Uint8Array(32),
    sessionKeyPair: await generateKeyPair(),
    expiresAtUnix: Math.floor(Date.now() / 1000) + 36_000,
    address: 'drive@fathom.test',
    accountId: ME,
  });

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void main();
