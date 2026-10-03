// Test harness for the drawing drives, copied into client/src/ as drive.tsx
// only while a drive runs. Mounts the real App signed in, with fetch answered
// here; the redaction gate is the real wasm, never reimplemented.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './index.css';
import App from './App';
import { concatBytes, lp, u64LE } from './crypto/bytes';
import { generateKeyPair } from './crypto/keys';
import { readPlain, SCHEMA_VERSION, writePlain } from './document/plain';
import { viewOf } from './document/view';
import { newUlid } from './document/ulid';
import { Engine } from './engine/engine';
import { setSession } from './state/sessionState';
import {
  catalogueFrom,
  seedCanvasScene,
  seedLookScene,
  seedCableGroupsScene,
  seedCableGroupsSpeedScene,
  seedShowScene,
  seedConflictingChange,
  seedConnectedDevices,
  seedDockerScene,
  seedEmptyDesign,
  seedFreestanding,
  seedManyDevicesScene,
  seedNetworksScene,
  seedPrintAttackScene,
  seedPrintLoftScene,
  seedPrintScene,
  seedShelfScene,
  seedSingleDevice,
  seedTagsScene,
  seedUnplacedDevice,
} from './drive-seed';

const ORG_ID = 'org-drive';
const SCOPE_ID = 'scope-drive';
const DESIGN_ID = 'design-drive';
/** GitHub issue #54's own drive — "open a second design: it has its own
 * list." Every other scene still opens exactly one design (`DESIGN_ID`
 * alone); this one is seeded too only when `scene === 'cable-groups'`,
 * below. */
const DESIGN_ID_2 = 'design-drive-2';
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
    /** Every body this backend stored as a doc file, as Latin-1 text. */
    __uploads__: string[];
    /** The `positionU` the last saved document gives the chassis with this hostname. */
    __savedPositionU__: (hostname: string) => number | null;
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
  else if (scene === 'canvas') doc = seedCanvasScene(catalogue, ME);
  else if (scene === 'look') doc = seedLookScene(catalogue, ME);
  else if (scene === 'show') doc = seedShowScene(catalogue, ME);
  else if (scene === 'conflict') doc = seedConflictingChange(catalogue, ME, COLLEAGUE);
  else if (scene === 'note' || scene === 'typed') doc = seedSingleDevice(catalogue, ME);
  else if (scene === 'freestanding') doc = seedFreestanding(catalogue, ME);
  else if (scene === 'networks' || scene === 'networks-010') doc = seedNetworksScene(catalogue, ME);
  else if (scene === 'tags') doc = seedTagsScene(catalogue, ME);
  else if (scene === 'docker') doc = seedDockerScene(catalogue, ME);
  else if (scene === 'unplaced') doc = seedUnplacedDevice(ME);
  else if (scene === 'print') doc = seedPrintScene(catalogue, ME);
  else if (scene === 'print-attack') doc = seedPrintAttackScene(catalogue, ME);
  else if (scene === 'print-loft') doc = seedPrintLoftScene(catalogue, ME);
  else if (scene === 'node-identity') doc = seedManyDevicesScene(catalogue, ME);
  else if (scene === 'shelf') doc = seedShelfScene(catalogue, ME);
  else if (scene === 'cable-groups') doc = seedCableGroupsScene(catalogue, ME);
  else if (scene === 'cable-groups-speed') doc = seedCableGroupsSpeedScene(catalogue, ME, Number(params.get('count') ?? '2100'));
  else doc = seedEmptyDesign();

  let bytes = writePlain(doc);
  // ADR-0058's drive check: "open a 0.10 design" — the header alone is
  // downgraded (decision 6 is additive, and ACCEPTED_OLDER_SCHEMA_VERSIONS
  // accumulates rather than replaces, so a 0.10 declaration over this
  // scene's nodes is still legal at 0.12), the same substitution
  // `plain.test.ts`'s "opens a 0.10 vector" tests make.
  if (scene === 'networks-010') {
    const text = new TextDecoder().decode(bytes);
    const downgraded = text.replace(`schema ${SCHEMA_VERSION}`, 'schema 0.10');
    if (downgraded === text) throw new Error('networks-010: the schema-version substitution did not land');
    bytes = new TextEncoder().encode(downgraded);
  }
  const minor = schemaMinor();

  // GitHub issue #54's own drive: a second, wholly separate design —
  // `fathom.cables.<designId>` (`cableGroups.ts`) is per design, so a second
  // one must open with no list of its own. Every other scene keeps carrying
  // exactly the one entry every earlier version of this harness held as
  // plain `version`/`bytes` locals; `designs` below is that same pair,
  // generalised to a map so the two id-addressed routes further down can
  // serve either design by id rather than only ever `DESIGN_ID`.
  const designs = new Map<string, { version: number; bytes: Uint8Array }>();
  designs.set(DESIGN_ID, { version: 1, bytes });
  if (scene === 'cable-groups') {
    designs.set(DESIGN_ID_2, { version: 1, bytes: writePlain(seedEmptyDesign()) });
  }

  // Boot the real engine once, so every mocked save below can be checked
  // against it — the same `engine.loadPlain` the lead's "a design stays
  // saveable after undo" proof calls, just run here for every scene rather
  // than one test.
  window.__saveLoadFailures__ = [];
  window.__saveCount__ = 0;
  window.__uploads__ = [];
  const driveFiles: Record<string, Uint8Array> = {};
  let verifyEngine: Engine | null = null;
  try {
    verifyEngine = await Engine.init();
  } catch (e) {
    window.__saveLoadFailures__.push(`the verifying engine itself failed to boot: ${e instanceof Error ? e.message : String(e)}`);
  }

  window.__savedPositionU__ = (hostname) => {
    const saved = viewOf(readPlain(designs.get(DESIGN_ID)!.bytes), catalogue);
    return saved.racks.flatMap((r) => r.chassis).find((c) => c.hostname === hostname)?.positionU ?? null;
  };

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
          display_name: scene === 'print-loft' ? 'Loft' : 'Drive network',
          depth: 0,
          path: 'drive',
          capability: 'steward',
        },
      ]);
    }
    if (method === 'GET' && p === `${org}/designs`) {
      return json(
        [...designs.entries()].map(([id, entry]) => ({
          design_id: id,
          scope_id: SCOPE_ID,
          created_at_unix: Math.floor(Date.now() / 1000),
          created_by: ME,
          capability,
          latest_version: entry.version,
        })),
      );
    }
    const designMatch = /^\/organisations\/[^/]+\/designs\/([^/]+)$/.exec(p);
    if (method === 'GET' && designMatch) {
      const entry = designs.get(designMatch[1]);
      if (!entry) return new Response('no such design\n', { status: 404 });
      return new Response(entry.bytes as BodyInit, {
        status: 200,
        headers: {
          'fathom-design-version': String(entry.version),
          'fathom-payload-schema-version': String(minor),
        },
      });
    }
    const versionsMatch = /^\/organisations\/[^/]+\/designs\/([^/]+)\/versions$/.exec(p);
    if (method === 'POST' && versionsMatch) {
      const entry = designs.get(versionsMatch[1]);
      if (!entry) return new Response('no such design\n', { status: 404 });
      const base = Number(u.searchParams.get('base'));
      if (base !== entry.version) {
        return new Response(`the design is at version ${entry.version}; this save was based on version ${base}\n`, {
          status: 409,
        });
      }
      const nextVersion = entry.version + 1;
      const nextBytes = requestBody.slice(4);
      designs.set(versionsMatch[1], { version: nextVersion, bytes: nextBytes });
      window.__saveCount__ += 1;
      if (verifyEngine) {
        try {
          verifyEngine.loadPlain(nextBytes);
        } catch (e) {
          window.__saveLoadFailures__.push(`save at version ${nextVersion} does not load through the engine: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return new Response(`${nextVersion}\n`, { status: 200 });
    }
    // Doc files: kept in memory, answered the way `store_file_handler` does (`{id} {media}`).
    if (method === 'POST' && p === `${org}/designs/${DESIGN_ID}/files`) {
      const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (x) => x.toString(16).padStart(2, '0')).join('');
      const head = String.fromCharCode(...requestBody.slice(0, 5));
      const media = head === '%PDF-' ? 'pdf' : requestBody[0] === 0x89 ? 'image' : 'text';
      driveFiles[id] = requestBody;
      window.__uploads__.push(bytesToLatin1(requestBody));
      return new Response(`${id} ${media}\n`, { status: 200 });
    }
    if (method === 'GET' && p.startsWith(`${org}/designs/${DESIGN_ID}/files/`)) {
      const hit = driveFiles[p.split('/').pop() ?? ''];
      return hit ? new Response(hit as BodyInit, { status: 200 }) : new Response('no such file\n', { status: 404 });
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

  // A render counter `ChassisNode.tsx` adds to when this is a number; under
  // `StrictMode` in dev a count is up to twice a production one.
  (window as unknown as { __cn: number }).__cn = 0;

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void main();
