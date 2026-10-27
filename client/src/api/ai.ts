// AI access keys (ADR-0072). A person lets their own AI app read the designs they can read,
// in one organisation, and send ideas a person accepts. The key pair is made by the
// `fathom-ai` helper on their computer; Fathom only ever receives the public half. A Steward
// decides whether AI is on here, who may make keys and how much any key may see.
// Bodies are canonical JSON, like every organisation route.

import { body } from './fieldDefinitions';
import { signedFetch } from './signedFetch';

export const TIERS = ['layout', 'addresses', 'notes'] as const;
export type Tier = (typeof TIERS)[number];
export const KEY_DAYS = [30, 90, 365] as const;
export type KeyState = 'on' | 'disabled' | 'deleted' | 'expired';
/** Which AI apps may connect as a connector (ADR-0072 decision 16). Claude is on with AI;
 * the others are off until a Steward allows them. */
export const APPS = ['claude', 'claude-code', 'other'] as const;
export type App = (typeof APPS)[number];
export const APP_NAME: Record<App, string> = { claude: 'Claude', 'claude-code': 'Claude Code', other: 'Other AI apps' };
/** A key the helper paired, or a connector an app signed in as. */
export type KeyKind = 'helper' | 'connector';

export interface AiPolicy {
  allowed: boolean;
  makers: string[];
  ceiling: Tier[];
  maxDays: number;
  secondPersonScopes: string[];
  apps: App[];
  /** The organisation's tick: AI apps may change designs (ADR-0077 decision 1). */
  mayChange: boolean;
  changedBy: string | null;
  changedAt: number | null;
  version: number;
}

export interface AiKeyView {
  id: string;
  kind: KeyKind;
  /** `helper` for a helper key; for a connector, which app it was given to. */
  app: App | 'helper';
  owner: string;
  ownerName: string;
  /** The owner's Fathom sign-in address (ADR-0072 decision 24). */
  ownerEmail: string;
  /** The AI account the owner said it uses: what they typed, never checked. Null on older keys. */
  aiAccount: string | null;
  label: string;
  /** Empty: every folder the owner can read. */
  scopes: string[];
  sees: Tier[];
  mayRecommend: boolean;
  /** The connection's own tick to change designs; it needs the organisation's too. */
  mayChange: boolean;
  /** Seconds since the epoch, like the rest of this file's times. */
  createdAt: number;
  expiresAt: number;
  state: KeyState;
  stoppedAt: number | null;
  stoppedBy: string | null;
  stoppedByKind: 'owner' | 'steward' | 'operator' | null;
  stoppedReason: string | null;
  lastUsedAt: number | null;
  lastUsedFrom: string | null;
  requestsToday: number;
  mine: boolean;
  version: number;
}

export interface AiOverview {
  server: { allowed: boolean; reason: string | null };
  policy: AiPolicy;
  steward: boolean;
  canMake: boolean;
  keys: AiKeyView[];
  deployment: string;
  /** The address a person adds in their AI app, or null when the operator has not turned
   * the connector on. */
  connector: string | null;
}

export interface IdeaStep {
  action: 'add' | 'change' | 'remove' | 'connect' | 'move' | 'label';
  target: string | null;
  text: string;
}

export interface AiIdea {
  id: string;
  key: string;
  owner: string;
  ownerName: string;
  title: string;
  why: string;
  steps: IdeaStep[];
  createdAt: number;
  state: 'open' | 'accepted' | 'dismissed';
  decidedBy: string | null;
  decidedAt: number | null;
  version: number;
}

const org = (organisationId: string): string => `/organisations/${encodeURIComponent(organisationId)}/ai`;

function parse(bytes: Uint8Array): Record<string, unknown> | unknown[] {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown> | unknown[];
  } catch {
    throw new Error('malformed AI access response: body is not JSON');
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const tiers = (v: unknown): Tier[] => strs(v).filter((t): t is Tier => (TIERS as readonly string[]).includes(t));

export function parsePolicy(raw: unknown): AiPolicy {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    allowed: o.allowed === true,
    makers: strs(o.makers),
    ceiling: tiers(o.ceiling),
    maxDays: num(o.maxDays) ?? 90,
    secondPersonScopes: strs(o.secondPersonScopes),
    apps: Array.isArray(o.apps) ? strs(o.apps).filter((a): a is App => (APPS as readonly string[]).includes(a)) : ['claude'],
    mayChange: o.mayChange === true,
    changedBy: typeof o.changedBy === 'string' ? o.changedBy : null,
    changedAt: num(o.changedAt),
    version: num(o.version) ?? 0,
  };
}

export function parseKey(raw: unknown): AiKeyView {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.version !== 'number') throw new Error('malformed AI key in the response');
  const state = o.state as KeyState;
  const kind = o.stoppedByKind;
  const app = str(o.app);
  return {
    id: o.id,
    kind: o.kind === 'connector' ? 'connector' : 'helper',
    app: (APPS as readonly string[]).includes(app) ? (app as App) : 'helper',
    owner: str(o.owner),
    ownerName: str(o.ownerName) || 'Someone',
    ownerEmail: str(o.ownerEmail),
    aiAccount: typeof o.aiAccount === 'string' && o.aiAccount !== '' ? o.aiAccount : null,
    label: str(o.label),
    scopes: strs(o.scopes),
    sees: tiers(o.sees),
    mayRecommend: o.mayRecommend === true,
    mayChange: o.mayChange === true,
    createdAt: num(o.createdAt) ?? 0,
    expiresAt: num(o.expiresAt) ?? 0,
    state: ['on', 'disabled', 'deleted', 'expired'].includes(state) ? state : 'disabled',
    stoppedAt: num(o.stoppedAt),
    stoppedBy: typeof o.stoppedBy === 'string' ? o.stoppedBy : null,
    stoppedByKind: kind === 'owner' || kind === 'steward' || kind === 'operator' ? kind : null,
    stoppedReason: typeof o.stoppedReason === 'string' ? o.stoppedReason : null,
    lastUsedAt: num(o.lastUsedAt),
    lastUsedFrom: typeof o.lastUsedFrom === 'string' ? o.lastUsedFrom : null,
    requestsToday: num(o.requestsToday) ?? 0,
    mine: o.mine === true,
    version: o.version,
  };
}

export function parseIdea(raw: unknown): AiIdea {
  const o = (raw ?? {}) as Record<string, unknown>;
  const state = o.state;
  if (typeof o.id !== 'string' || typeof o.version !== 'number' || (state !== 'open' && state !== 'accepted' && state !== 'dismissed')) {
    throw new Error('malformed AI idea in the response');
  }
  const steps = Array.isArray(o.steps)
    ? o.steps.map((s) => {
        const step = (s ?? {}) as Record<string, unknown>;
        return { action: str(step.action) as IdeaStep['action'], target: typeof step.target === 'string' ? step.target : null, text: str(step.text) };
      })
    : [];
  return {
    id: o.id,
    key: str(o.key),
    owner: str(o.owner),
    ownerName: str(o.ownerName) || 'Someone',
    title: str(o.title),
    why: str(o.why),
    steps,
    createdAt: num(o.createdAt) ?? 0,
    state,
    decidedBy: typeof o.decidedBy === 'string' ? o.decidedBy : null,
    decidedAt: num(o.decidedAt),
    version: o.version,
  };
}

export function parseOverview(raw: unknown): AiOverview {
  const o = (raw ?? {}) as Record<string, unknown>;
  const server = (o.server ?? {}) as Record<string, unknown>;
  return {
    server: { allowed: server.allowed !== false, reason: typeof server.reason === 'string' ? server.reason : null },
    policy: parsePolicy(o.policy),
    steward: o.steward === true,
    canMake: o.canMake === true,
    keys: Array.isArray(o.keys) ? o.keys.map(parseKey) : [],
    deployment: str(o.deployment),
    connector: typeof o.connector === 'string' ? o.connector : null,
  };
}

export async function fetchAi(organisationId: string): Promise<AiOverview> {
  return parseOverview(parse(await signedFetch('GET', org(organisationId))));
}

export async function setPolicy(
  organisationId: string,
  policy: Pick<AiPolicy, 'allowed' | 'makers' | 'ceiling' | 'maxDays' | 'secondPersonScopes' | 'apps' | 'mayChange'>,
  ifVersion: number,
): Promise<AiPolicy> {
  // Only the fields the route takes: it refuses any other, and a whole `AiPolicy` carries more.
  const { allowed, makers, ceiling, maxDays, secondPersonScopes, apps, mayChange } = policy;
  return parsePolicy(
    parse(await signedFetch('POST', `${org(organisationId)}/policy`, body({ allowed, makers, ceiling, maxDays, secondPersonScopes, apps, mayChange, ifVersion }))),
  );
}

/** The public half as the helper's pair step prints it: 130 hex characters, starting 04. */
export function cleanPublicKey(raw: string): string | null {
  const hex = raw.replace(/\s+/g, '').toLowerCase();
  return /^04[0-9a-f]{128}$/.test(hex) ? hex : null;
}

export async function makeKey(
  organisationId: string,
  key: { publicKey: string; label: string; aiAccount: string; scopes: string[]; sees: Tier[]; mayRecommend: boolean; mayChange: boolean; days: number },
): Promise<{ key: AiKeyView; deployment: string }> {
  const o = parse(await signedFetch('POST', `${org(organisationId)}/keys`, body(key))) as Record<string, unknown>;
  return { key: parseKey(o.key), deployment: str(o.deployment) };
}

export async function changeKey(
  organisationId: string,
  key: Pick<AiKeyView, 'id' | 'version'>,
  change: Partial<{ label: string; scopes: string[]; sees: Tier[]; mayRecommend: boolean; mayChange: boolean; endsInDays: number }>,
): Promise<AiKeyView> {
  const path = `${org(organisationId)}/keys/${encodeURIComponent(key.id)}`;
  return parseKey(parse(await signedFetch('POST', path, body({ ...change, ifVersion: key.version }))));
}

/** Stop a key. A Steward stopping someone else's gives a reason, which they see. */
export async function stopKey(
  organisationId: string,
  key: Pick<AiKeyView, 'id' | 'version'>,
  verb: 'disable' | 'delete',
  reason?: string,
): Promise<AiKeyView> {
  const path = `${org(organisationId)}/keys/${encodeURIComponent(key.id)}/${verb}`;
  const fields: Record<string, unknown> = { ifVersion: key.version };
  if (reason && reason.trim() !== '') fields.reason = reason.trim();
  return parseKey(parse(await signedFetch('POST', path, body(fields))));
}

const ideas = (organisationId: string, designId: string): string =>
  `/organisations/${encodeURIComponent(organisationId)}/designs/${encodeURIComponent(designId)}/ai-ideas`;

export async function fetchIdeas(organisationId: string, designId: string): Promise<AiIdea[]> {
  const list = parse(await signedFetch('GET', ideas(organisationId, designId)));
  if (!Array.isArray(list)) throw new Error('malformed AI idea list');
  return list.map(parseIdea);
}

/** Accepting marks the idea; the edit itself is the accepter's own, made in the design. A
 * dismissal keeps nothing of what the AI wrote. */
export async function decideIdea(
  organisationId: string,
  designId: string,
  idea: Pick<AiIdea, 'id' | 'version'>,
  verb: 'accept' | 'dismiss',
): Promise<AiIdea> {
  const path = `${ideas(organisationId, designId)}/${encodeURIComponent(idea.id)}/${verb}`;
  return parseIdea(parse(await signedFetch('POST', path, body({ ifVersion: idea.version }))));
}

/** "In plain words": what a key does, for the person about to make or change one. */
export function plainWords(
  key: { scopes: string[]; sees: Tier[]; mayRecommend: boolean; mayChange?: boolean },
  folderName: (id: string) => string,
): string[] {
  const where = key.scopes.length === 0 ? 'every design you can read' : `designs in ${key.scopes.map(folderName).join(', ')}`;
  const sees = ['devices, ports, cables, racks, places and tags'];
  if (key.sees.includes('addresses')) sees.push('addresses and VLANs');
  if (key.sees.includes('notes')) sees.push('notes');
  return [
    `Reads ${where}, as you: ${sees.join(', ')}.`,
    key.mayChange
      ? 'Can change designs you can draw in, in your name and marked as the AI\'s. Each change is one undo.'
      : key.mayRecommend
        ? 'Can send ideas. Nothing changes until a person accepts one.'
        : 'Can only read. It cannot send ideas or change anything.',
    ...(key.mayChange ? ['Text inside a design can steer an AI. Only tick this for an AI you watch.'] : []),
    'Never sees passwords, the vault, or anything you cannot see.',
    'What it reads goes to the company behind your AI app.',
  ];
}

// ---- The connector sign-in (ADR-0072 decisions 13 to 20) ----

/** What the sign-in page learns about an app's request before the person decides. */
export type ConnectCheck =
  | { ok: true; app: { id: string; name: string; kind: App; returnsTo: string } }
  | { ok: false; description: string; back: string | null };

/** Unsigned: the page asks what the app's request is. `query` is the page's own query string. */
export async function checkConnect(query: string): Promise<ConnectCheck> {
  const res = await fetch('/oauth/authorize/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: query.replace(/^\?/, ''),
  });
  if (res.status === 404) return { ok: false, description: 'This Fathom does not have AI connections turned on. Ask whoever runs it.', back: null };
  let o: Record<string, unknown>;
  try {
    o = (await res.json()) as Record<string, unknown>;
  } catch {
    return { ok: false, description: 'Fathom could not read this sign-in request.', back: null };
  }
  const app = o.app as Record<string, unknown> | undefined;
  if (res.ok && app && typeof app.id === 'string') {
    const kind = str(app.kind);
    return {
      ok: true,
      app: { id: app.id, name: str(app.name), kind: (APPS as readonly string[]).includes(kind) ? (kind as App) : 'other', returnsTo: str(app.returnsTo) },
    };
  }
  return {
    ok: false,
    description: str(o.description) || str(o.error_description) || 'Fathom could not accept this sign-in request.',
    back: typeof o.back === 'string' ? o.back : null,
  };
}

/** The person's answer. Answers where the browser goes next: back to the app. */
export async function answerConnect(
  organisationId: string,
  request: string,
  answer:
    | { allow: false }
    | { allow: true; label?: string; aiAccount: string; scopes: string[]; sees: Tier[]; mayRecommend: boolean; mayChange: boolean; days: number },
): Promise<{ redirect: string; key: AiKeyView | null }> {
  const o = parse(await signedFetch('POST', `${org(organisationId)}/connect`, body({ request: request.replace(/^\?/, ''), ...answer }))) as Record<
    string,
    unknown
  >;
  return { redirect: str(o.redirect), key: o.key ? parseKey(o.key) : null };
}

/** The AI account as the server will keep it, or null when it is not one address. Mirrors `ai::clean_account`. */
export function cleanAccount(raw: string): string | null {
  const t = raw.trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+$/.test(t) && t.length >= 3 && t.length <= 254 ? t : null;
}

/** Where a sign-in may send the browser back to: https anywhere, or http on this computer. */
export function safeRedirect(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]');
  } catch {
    return false;
  }
}

// ---- The helper, for an app that cannot sign in (ADR-0072 decision 3) ----

/** Where the helper is served: Fathom serves its own copy, so the file matches this server. */
export const HELPER_PATH = '/fathom-ai.mjs';

/** The line a person runs to make a key on their computer. `origin` is this Fathom's address. */
export function helperPairCommand(origin: string): string {
  return `node fathom-ai.mjs pair ${origin}`;
}

/** The lines a person adds to an app that starts MCP servers itself, with the helper's path. */
export function helperAppConfig(file: string): { json: string; claudeCode: string } {
  const json = JSON.stringify({ mcpServers: { fathom: { command: 'node', args: [file] } } }, null, 2);
  return { json, claudeCode: `claude mcp add fathom -- node ${file}` };
}
