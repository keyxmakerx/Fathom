#!/usr/bin/env node
// fathom-ai: lets an AI app read Fathom designs as you, and send ideas a person accepts.
// ADR-0072. One file, no dependencies, Node 20 or later.
//
//   node fathom-ai.mjs pair https://fathom.example.org
//       Makes a key on this computer (~/.fathom-ai/key.json, readable by you only) and
//       prints the public half to paste into Fathom: Organisation > AI > Connect an AI app > It uses a key.
//   node fathom-ai.mjs pair --for-cloud https://fathom.example.org
//       The same, and also prints the FATHOM_AI_KEY value to put in a cloud environment's
//       secrets (for an AI that runs in the cloud, such as Claude Code on the web).
//   node fathom-ai.mjs check
//       Asks Fathom what this key may do.
//   node fathom-ai.mjs            (no arguments)
//       Runs as an MCP server on stdin and stdout. Your AI app starts it this way.
//
// The key: FATHOM_AI_KEY from the environment if set, otherwise ~/.fathom-ai/key.json.
// Fathom only ever holds the public half. Every request is signed (four Fathom-AI-*
// headers over method, path, body, a fresh nonce, the time and the server's id), so a
// copied request cannot be replayed and a key file's contents never travel.

import { createECDH, createPrivateKey, createHash, randomBytes, sign as edsign } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const VERSION = '1.0.0';
const KEY_DIR = join(homedir(), '.fathom-ai');
const KEY_FILE = join(KEY_DIR, 'key.json');
const ENV_PREFIX = 'fai1.';
// P-256's group order, for the low-S form Fathom requires.
const N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551n;

// ---- small pieces -----------------------------------------------------------

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(s, 'base64url');

function lp(parts) {
  const out = [];
  for (const p of parts) {
    const b = Buffer.isBuffer(p) ? p : Buffer.from(p, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(b.length);
    out.push(len, b);
  }
  return Buffer.concat(out);
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ulid128(bytes16) {
  let n = 0n;
  for (const b of bytes16) n = (n << 8n) | BigInt(b);
  let out = '';
  for (let i = 0; i < 26; i++) {
    out = CROCKFORD[Number(n & 31n)] + out;
    n >>= 5n;
  }
  return out;
}

/** The key id Fathom derives from a public key (`ai::key_id_of`). */
export function keyIdOf(publicKey) {
  const digest = createHash('sha256').update(lp(['fathom/ai/key-id/v1', publicKey])).digest();
  return ulid128(digest.subarray(0, 16));
}

/** Canonical JSON (fathom-canon): sorted keys, no whitespace, one trailing LF. */
export function canonical(value) {
  const walk = (v) => {
    if (v === null) return 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') {
      if (!Number.isSafeInteger(v)) throw new Error('only whole numbers go to Fathom');
      return String(v);
    }
    if (typeof v === 'string') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(walk).join(',') + ']';
    if (typeof v === 'object') {
      return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort()
        .map((k) => JSON.stringify(k) + ':' + walk(v[k])).join(',') + '}';
    }
    throw new Error('that value cannot be sent');
  };
  return walk(value) + '\n';
}

// ---- the key ----------------------------------------------------------------

// A private scalar is 32 bytes; Node drops leading zero bytes, and JWK wants all 32.
function pad32(d) {
  if (d.length > 32) throw new Error('that is not a P-256 private key');
  return Buffer.concat([Buffer.alloc(32 - d.length), d]);
}

function publicFrom(d) {
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(d);
  return ecdh.getPublicKey(); // 65 bytes, 0x04 || x || y
}

function makeKey(server) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { server: server.replace(/\/+$/, ''), d: pad32(ecdh.getPrivateKey()) };
}

function envValue(key) {
  return ENV_PREFIX + b64u(key.server) + '.' + b64u(key.d);
}

function loadKey() {
  const env = process.env.FATHOM_AI_KEY;
  if (env) {
    const [tag, server, d] = env.trim().split('.');
    if (tag + '.' !== ENV_PREFIX || !server || !d) throw new Error('FATHOM_AI_KEY is not a value Fathom gave you');
    return { server: unb64u(server).toString('utf8'), d: pad32(unb64u(d)), from: 'FATHOM_AI_KEY' };
  }
  if (!existsSync(KEY_FILE)) throw new Error(`no key: run "node fathom-ai.mjs pair <your Fathom address>" first`);
  const saved = JSON.parse(readFileSync(KEY_FILE, 'utf8'));
  return { server: saved.server, d: pad32(unb64u(saved.d)), from: KEY_FILE };
}

function signer(key) {
  const pub = publicFrom(key.d);
  const jwk = { kty: 'EC', crv: 'P-256', d: b64u(key.d), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) };
  const privateKey = createPrivateKey({ key: jwk, format: 'jwk' });
  return {
    publicKey: pub,
    id: keyIdOf(pub),
    sign(message) {
      const sig = edsign('sha256', message, { key: privateKey, dsaEncoding: 'ieee-p1363' });
      let s = BigInt('0x' + sig.subarray(32).toString('hex'));
      if (s > N / 2n) s = N - s; // Fathom accepts the low-S form only.
      return Buffer.concat([sig.subarray(0, 32), Buffer.from(s.toString(16).padStart(64, '0'), 'hex')]);
    },
  };
}

// ---- talking to Fathom ------------------------------------------------------

let deployment = null;

async function serverId(key) {
  if (deployment) return deployment;
  const res = await fetch(key.server + '/ai/v1/server');
  if (!res.ok) throw new Error(`${key.server} did not answer as a Fathom server (${res.status})`);
  deployment = (await res.json()).deployment;
  return deployment;
}

async function call(key, method, path, body) {
  const s = signer(key);
  const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(canonical(body), 'utf8');
  const nonce = randomBytes(32);
  const time = Math.floor(Date.now() / 1000);
  const message = lp([
    'fathom/ai/req/v1', await serverId(key), s.id, method, path,
    createHash('sha256').update(bytes).digest(), nonce,
  ]);
  const t = Buffer.alloc(8);
  t.writeBigUInt64LE(BigInt(time));
  const res = await fetch(key.server + path, {
    method,
    headers: {
      'Fathom-AI-Key': s.id,
      'Fathom-AI-Time': String(time),
      'Fathom-AI-Nonce': nonce.toString('hex'),
      'Fathom-AI-Signature': s.sign(Buffer.concat([message, t])).toString('hex'),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : bytes,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Fathom said ${res.status}: ${text.trim()}`);
  return JSON.parse(text);
}

const id = (raw) => {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(raw ?? '')) throw new Error('a design id is 26 letters and digits');
  return raw;
};

// ---- the MCP tools ----------------------------------------------------------

const TOOLS = [
  {
    name: 'fathom_whoami',
    description: 'What this Fathom key may do: which organisation, what it can see, until when. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: (key) => call(key, 'GET', '/ai/v1/whoami'),
  },
  {
    name: 'fathom_list_designs',
    description: 'The network designs this key can read, with their ids and names.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: (key) => call(key, 'GET', '/ai/v1/designs'),
  },
  {
    name: 'fathom_read_design',
    description:
      'One design: its devices, ports, cables, racks, places and tags, its maintenance plans and "It\'s down" issues ' +
      'with their steps, and addresses or notes if this key may see them. ' +
      'Never passwords. Anything that looked like a secret was left out and counted in "withheld".',
    inputSchema: {
      type: 'object',
      properties: { design: { type: 'string', description: 'The design id from fathom_list_designs.' } },
      required: ['design'],
      additionalProperties: false,
    },
    run: (key, a) => call(key, 'GET', `/ai/v1/designs/${id(a.design)}`),
  },
  {
    name: 'fathom_list_recommendations',
    description: 'The recommendations this key sent for a design, and whether a person accepted or dismissed each.',
    inputSchema: {
      type: 'object',
      properties: { design: { type: 'string' } },
      required: ['design'],
      additionalProperties: false,
    },
    run: (key, a) => call(key, 'GET', `/ai/v1/designs/${id(a.design)}/recommendations`),
  },
  {
    name: 'fathom_recommend',
    description:
      'Recommend a change to a design. Nothing changes until a person accepts it in Fathom. ' +
      'Write it for a person: a short title, why, and 1 to 20 plain steps in the order they should be done, one change each; ' +
      'a person can turn it into a maintenance plan. Never include a password or key.',
    inputSchema: {
      type: 'object',
      properties: {
        design: { type: 'string' },
        title: { type: 'string', maxLength: 120 },
        why: { type: 'string', maxLength: 1000 },
        steps: {
          type: 'array', minItems: 1, maxItems: 20,
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['add', 'change', 'remove', 'connect', 'move', 'label'] },
              target: { type: 'string', description: 'The element id it is about, as the reading gives it (kind:ID).' },
              text: { type: 'string', maxLength: 300 },
            },
            required: ['action', 'text'],
            additionalProperties: false,
          },
        },
      },
      required: ['design', 'title', 'steps'],
      additionalProperties: false,
    },
    run: (key, a) =>
      call(key, 'POST', `/ai/v1/designs/${id(a.design)}/recommendations`, {
        title: a.title,
        why: a.why ?? '',
        steps: (a.steps ?? []).map((s) => ({ action: s.action, target: s.target ?? null, text: s.text })),
      }),
  },
  {
    // Listed only when whoami says mayChange: the organisation and the key's owner both allowed it.
    name: 'fathom_change_design',
    mayChange: true,
    description:
      'Change a design now, as one change. It is made in the name of the person who made this key, marked as made by an ' +
      'AI, and History can restore the version before it. Give the version fathom_read_design gave: if the design moved ' +
      'since, nothing changes and you are told to read it again. Operations run in order: set a field (null clears it), ' +
      'add_node, add_edge or remove. The reading\'s mayChange lists the kinds and fields you may add and set. Name existing ' +
      'elements by the reading\'s ids, or give an add an `as` name for later operations. A removal takes what the element ' +
      'holds: at most 20 things, never a place still holding things, never anything holding what you cannot see. ' +
      'Never include a password or key; a change carrying one is refused whole. Prefer fathom_recommend when a person should decide.',
    inputSchema: {
      type: 'object',
      properties: {
        design: { type: 'string' },
        version: { type: 'integer', minimum: 1, description: 'The version fathom_read_design gave.' },
        summary: { type: 'string', maxLength: 120, description: 'What the change does, in one line. History shows it.' },
        operations: {
          type: 'array', minItems: 1, maxItems: 200,
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['set', 'add_node', 'add_edge', 'remove'] },
              element: { type: 'string', description: 'set, remove: an id from the reading (kind:ID), or a name an earlier add gave.' },
              field: { type: 'string', description: 'set: a field name as the reading shows it.' },
              value: { description: 'set: the new value, in the shape the reading shows; null clears it.' },
              kind: { type: 'string', description: 'add_node, add_edge: a kind from the reading\'s mayChange.' },
              from: { type: 'string', description: 'add_edge: the node it starts at, an id or a name.' },
              to: { type: 'string', description: 'add_edge: the node it ends at, an id or a name.' },
              as: { type: 'string', description: 'add_node, add_edge: a name for later operations.' },
              fields: { type: 'object', description: 'add_node, add_edge: field name to value.' },
            },
            required: ['op'],
            additionalProperties: false,
          },
        },
      },
      required: ['design', 'version', 'summary', 'operations'],
      additionalProperties: false,
    },
    run: (key, a) =>
      call(key, 'POST', `/ai/v1/designs/${id(a.design)}/changes`, {
        version: a.version,
        summary: a.summary,
        operations: (a.operations ?? []).map((o) => {
          const out = {};
          for (const k of ['op', 'element', 'field', 'kind', 'from', 'to', 'as', 'fields']) if (o[k] !== undefined) out[k] = o[k];
          if (o.op === 'set') out.value = o.value ?? null;
          return out;
        }),
      }),
  },
];

function serve() {
  let key;
  try {
    key = loadKey();
  } catch (e) {
    process.stderr.write(`fathom-ai: ${e.message}\n`);
  }
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  const lines = createInterface({ input: process.stdin });
  lines.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      return;
    }
    const reply = (result) => msg.id !== undefined && send({ jsonrpc: '2.0', id: msg.id, result });
    const fail = (code, message) => msg.id !== undefined && send({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
    switch (msg.method) {
      case 'initialize':
        reply({
          protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'fathom-ai', version: VERSION },
          instructions:
            'Fathom is a network documentation tool. These tools read designs as the person who made this key, and ' +
            'send recommendations a person accepts or dismisses. Only if fathom_whoami says mayChange can they change a ' +
            'design, as one change a person can undo. They never return passwords.',
        });
        return;
      case 'ping':
        reply({});
        return;
      case 'tools/list': {
        let mayChange = false;
        try {
          if (!key) key = loadKey();
          mayChange = (await call(key, 'GET', '/ai/v1/whoami')).mayChange === true;
        } catch {
          // Unreachable or refused: list what reads and recommends, and let those calls say why.
        }
        reply({ tools: TOOLS.filter((t) => mayChange || !t.mayChange).map(({ run, mayChange: _, ...t }) => t) });
        return;
      }
      case 'tools/call': {
        const tool = TOOLS.find((t) => t.name === msg.params?.name);
        if (!tool) return fail(-32602, `no tool named ${msg.params?.name}`);
        try {
          if (!key) key = loadKey();
          const out = await tool.run(key, msg.params?.arguments ?? {});
          reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
        } catch (e) {
          reply({ content: [{ type: 'text', text: e.message }], isError: true });
        }
        return;
      }
      default:
        if (msg.id !== undefined && !String(msg.method ?? '').startsWith('notifications/')) {
          fail(-32601, `method not found: ${msg.method}`);
        }
    }
  });
}

// ---- the command line -------------------------------------------------------

async function main(args) {
  if (args.length === 0) return serve();
  const [cmd, ...rest] = args;
  if (cmd === 'pair') {
    const cloud = rest.includes('--for-cloud');
    const server = rest.find((a) => !a.startsWith('--'));
    if (!server || !/^https?:\/\//.test(server)) throw new Error('give your Fathom address, for example https://fathom.example.org');
    const key = makeKey(server);
    const pub = publicFrom(key.d);
    if (!cloud) {
      mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
      writeFileSync(KEY_FILE, JSON.stringify({ server: key.server, d: b64u(key.d) }) + '\n', { mode: 0o600 });
      chmodSync(KEY_FILE, 0o600);
      console.log(`Made a key in ${KEY_FILE} (only your account can read it).`);
    }
    console.log(`\nPaste this into Fathom (Organisation > AI > Connect an AI app > It uses a key):\n\n${pub.toString('hex')}\n`);
    console.log(`Its key id will be ${keyIdOf(pub)}; Fathom shows the same.`);
    if (cloud) {
      console.log(
        '\nThen put this in the cloud environment as a secret named FATHOM_AI_KEY.\n' +
          'It is the private half: it is shown once and kept nowhere else.\n\n' + envValue(key) + '\n',
      );
    }
    return;
  }
  if (cmd === 'check') {
    const key = loadKey();
    console.log(`Key from ${key.from}, server ${key.server}`);
    console.log(JSON.stringify(await call(key, 'GET', '/ai/v1/whoami'), null, 2));
    return;
  }
  if (cmd === '--version') return console.log(VERSION);
  throw new Error(`unknown command "${cmd}": pair, check, or no arguments to run for your AI app`);
}

main(process.argv.slice(2)).catch((e) => {
  process.stderr.write(`fathom-ai: ${e.message}\n`);
  process.exit(1);
});
