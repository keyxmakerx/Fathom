// The live feed and the calls beside it (ADR-0063, "Wire"). One signed GET
// streams frames down; changes and presence go up as signed POSTs.

import { ApiRefusal } from './errors';
import { withSchemaPrefix } from './payload';
import { getSession, subscribe } from '../state/sessionState';
import { signedFetchWithHeaders, signedStream } from './signedFetch';

export const FRAME_CHANGE = 1;
export const FRAME_RELOAD = 2;
export const FRAME_PRESENCE = 3;
export const FRAME_HEARTBEAT = 4;
export const FRAME_RESYNC = 5;
export const FRAME_AUTHOR = 6;

export interface LiveFrame {
  type: number;
  version: number;
  bytes: Uint8Array;
  /** Relayed presence frames: the view of the tab that owns the stream. */
  view?: string;
}

const HEADER = 13;
const MAX_FRAME = 16 * 1024 * 1024;

/** `u8 type ‖ u64_le version ‖ u32_le length ‖ bytes`, fed in whatever pieces arrive. */
export class FrameReader {
  private buf = new Uint8Array(0);

  push(chunk: Uint8Array): LiveFrame[] {
    if (chunk.length > 0) {
      const joined = new Uint8Array(this.buf.length + chunk.length);
      joined.set(this.buf, 0);
      joined.set(chunk, this.buf.length);
      this.buf = joined;
    }
    const out: LiveFrame[] = [];
    let at = 0;
    while (this.buf.length - at >= HEADER) {
      const view = new DataView(this.buf.buffer, this.buf.byteOffset + at, HEADER);
      const length = view.getUint32(9, true);
      if (length > MAX_FRAME) throw new Error('live frame is too large');
      if (this.buf.length - at < HEADER + length) break;
      out.push({
        type: view.getUint8(0),
        version: Number(view.getBigUint64(1, true)),
        bytes: this.buf.slice(at + HEADER, at + HEADER + length),
      });
      at += HEADER + length;
    }
    if (at > 0) this.buf = this.buf.slice(at);
    return out;
  }
}

// ---------------------------------------------------------------------------
// Presence

export interface Person {
  account: string;
  initials: string;
  /** The display name. */
  name: string;
  /** The element this person has selected (others only). */
  selected?: string | null;
  /** Where this person's pointer is, in canvas coordinates (others only; absent when it is not on the canvas). */
  pointer?: { x: number; y: number };
}

function personFrom(item: unknown): Person | null {
  const o = item as { account?: unknown; initials?: unknown; name?: unknown; selected?: unknown; pointer?: unknown } | null;
  if (o === null || typeof o !== 'object') return null;
  if (typeof o.account !== 'string' || typeof o.initials !== 'string' || typeof o.name !== 'string') return null;
  const person: Person = { account: o.account, initials: o.initials.slice(0, 3), name: o.name };
  if (typeof o.selected === 'string') person.selected = o.selected;
  else if (o.selected === null) person.selected = null;
  const at = o.pointer as { x?: unknown; y?: unknown } | null | undefined;
  if (at != null && typeof at === 'object' && typeof at.x === 'number' && typeof at.y === 'number' && Number.isFinite(at.x) && Number.isFinite(at.y)) {
    person.pointer = { x: at.x, y: at.y };
  }
  return person;
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/** A presence frame: `{"self": P, "others": [P...]}`, `P` = `{account, initials, name}` plus `selected` for others. */
export function parsePresence(bytes: Uint8Array): { self: Person | null; others: Person[] } {
  const json = parseJson(bytes) as { self?: unknown; others?: unknown } | null;
  if (json === null || typeof json !== 'object') return { self: null, others: [] };
  const others = Array.isArray(json.others) ? json.others.map(personFrom).filter((p): p is Person => p !== null) : [];
  return { self: personFrom(json.self), others };
}

/** An author frame: one `P`, sent before the first change from an author the stream has not named. */
export function parseAuthor(bytes: Uint8Array): Person | null {
  return personFrom(parseJson(bytes));
}

/** The server sends each browser only the people in the owner tab's view. A
 * tab in another view shows none of them. */
export function presenceInView(people: Person[], ownerView: string | undefined, ownView: string): Person[] {
  return ownerView === undefined || ownerView === ownView ? people : [];
}

// ---------------------------------------------------------------------------
// Calls

function base(organisationId: string, designId: string): string {
  return `/organisations/${encodeURIComponent(organisationId)}/designs/${encodeURIComponent(designId)}`;
}

/** `POST …/changes?after=N`: answers the version the change took. */
export async function postChange(organisationId: string, designId: string, change: Uint8Array, after: number): Promise<number> {
  const path = `${base(organisationId, designId)}/changes?after=${encodeURIComponent(String(after))}`;
  const { bytes } = await signedFetchWithHeaders('POST', path, withSchemaPrefix(change));
  const version = Number.parseInt(new TextDecoder().decode(bytes).trim(), 10);
  if (!Number.isFinite(version)) throw new Error('change response is not a version number');
  return version;
}

export interface PresenceBody {
  view: string;
  selected: string | null;
}

export async function postPresence(organisationId: string, designId: string, body: PresenceBody): Promise<void> {
  let bytes = new TextEncoder().encode(JSON.stringify({ view: body.view, selected: body.selected }));
  if (bytes.length > 256) bytes = new TextEncoder().encode(JSON.stringify({ view: body.view, selected: null }));
  await signedFetchWithHeaders('POST', `${base(organisationId, designId)}/presence`, bytes, true);
}

/** `POST …/pointer`: where the pointer is on the canvas (canvas coordinates), or `null` once it has left. */
export async function postPointer(organisationId: string, designId: string, pointer: { x: number; y: number } | null): Promise<void> {
  await signedFetchWithHeaders('POST', `${base(organisationId, designId)}/pointer`, new TextEncoder().encode(pointerBody(pointer)), true);
}

/** The body the server reads: coordinates to a tenth, plain decimals, nothing else. */
export function pointerBody(pointer: { x: number; y: number } | null): string {
  if (pointer === null) return '{"pointer":null}';
  const tenth = (v: number) => (Math.round(v * 10) / 10 + 0).toFixed(1);
  return `{"pointer":{"x":${tenth(pointer.x)},"y":${tenth(pointer.y)}}}`;
}

/** Whether a failed change was refused (drop it) rather than not delivered (send it again). */
export function isRefusal(error: unknown): boolean {
  if (!(error instanceof ApiRefusal)) return false;
  return error.status >= 400 && error.status < 500 && error.status !== 401 && error.status !== 408 && error.status !== 429;
}

// ---------------------------------------------------------------------------
// The feed

/** The lock and channel name: design and account, so only tabs of one account share a stream. */
export function liveChannelName(designId: string, scope: string): string {
  return `fathom-live-${scope}-${designId}`;
}

function scopeOfSession(): string {
  return getSession()?.accountId ?? 'none';
}

export type FeedStatus = 'connecting' | 'up' | 'down' | 'unavailable';

export interface FeedEvents {
  frame(frame: LiveFrame): void;
  /** `why`, with `down`: what the last attempt ran into, in words the page can show. */
  status(status: FeedStatus, why?: string): void;
}

export interface FeedOptions {
  organisationId: string;
  designId: string;
  /** The last version this tab has applied. */
  since(): number;
  events: FeedEvents;
  /** Whose stream this is: tabs share one only within the same account. */
  scope?: string;
  /** The view of this tab, relayed with presence frames when it owns the stream. */
  view?: () => string;
  /** Test seams. */
  open?: (path: string, signal: AbortSignal) => Promise<Response>;
  delay?: (ms: number) => Promise<void>;
  /** Silence longer than this (heartbeats come every 25 s) ends the stream. */
  silenceMs?: number;
}

type Relay =
  | { k: 'hello' }
  | { k: 'frame'; type: number; version: number; bytes: Uint8Array; view?: string }
  | { k: 'status'; status: FeedStatus; why?: string };

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 15000];

/** "server answered 429: <its sentence>", the sentence left out when it is a proxy's error page. */
export function serverAnswered(error: ApiRefusal): string {
  const said = error.message.length <= 160 && !/[<\n]/.test(error.message) ? `: ${error.message}` : '.';
  return `server answered ${error.status}${said}`;
}

/** What a failed attempt ran into: the server's own status and sentence when
 * it answered, otherwise only what this browser saw. */
export function whyDown(error: unknown, quiet: boolean): string {
  if (quiet) {
    return 'The live connection opened but nothing came through it. A proxy in front of Fathom may be holding the stream back.';
  }
  if (error instanceof ApiRefusal) return `The ${serverAnswered(error)}`;
  if (error instanceof TypeError) return 'The server could not be reached.';
  return 'The live connection was cut.';
}

/**
 * One stream per design per browser: the tab holding the Web Lock opens it
 * and relays frames over a BroadcastChannel; the others listen and take the
 * lock over when it closes. Without Web Locks or BroadcastChannel, each tab
 * opens its own.
 */
export class LiveFeed {
  private readonly o: FeedOptions;
  private stopped = false;
  private owner = false;
  private channel: BroadcastChannel | null = null;
  private abort = new AbortController();
  private current: AbortController | null = null;
  private last: FeedStatus = 'connecting';
  private restarting = false;
  private unsubscribe: (() => void) | null = null;

  constructor(options: FeedOptions) {
    this.o = options;
  }

  get owns(): boolean {
    return this.owner;
  }

  start(): void {
    // This tab's own sign-out (or a different account) ends its part in the shared stream.
    const account = getSession()?.accountId;
    this.unsubscribe = subscribe(() => {
      if (getSession()?.accountId !== account) this.stop();
    });
    const name = liveChannelName(this.o.designId, this.o.scope ?? scopeOfSession());
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    if (locks && typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(name);
      this.channel.onmessage = (event: MessageEvent<Relay>) => this.heard(event.data);
      this.channel.postMessage({ k: 'hello' } satisfies Relay);
      locks
        .request(name, { signal: this.abort.signal }, async () => {
          if (this.stopped) return;
          this.owner = true;
          try {
            await this.run();
          } finally {
            this.owner = false;
          }
        })
        .catch(() => {});
    } else {
      this.owner = true;
      void this.run();
    }
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.stopped = true;
    this.abort.abort();
    this.current?.abort();
    this.channel?.close();
    this.channel = null;
  }

  /** Reopens the stream from the caller's current `since`. False when another tab owns it. */
  restart(): boolean {
    if (!this.owner) return false;
    this.restarting = true;
    this.current?.abort();
    return true;
  }

  private heard(m: Relay): void {
    if (this.stopped || this.owner) return;
    if (m.k === 'frame') this.o.events.frame({ type: m.type, version: m.version, bytes: m.bytes, view: m.view });
    else if (m.k === 'status') this.o.events.status(m.status, m.why);
  }

  private tell(status: FeedStatus, why?: string): void {
    this.last = status;
    this.o.events.status(status, why);
    this.channel?.postMessage({ k: 'status', status, why } satisfies Relay);
  }

  private deliver(frame: LiveFrame): void {
    this.o.events.frame(frame);
    const view = frame.type === FRAME_PRESENCE ? this.o.view?.() : undefined;
    this.channel?.postMessage({ k: 'frame', ...frame, view } satisfies Relay);
  }

  private async run(): Promise<void> {
    if (this.channel) {
      // Answer a tab that opened after us with where things stand.
      const previous = this.channel.onmessage;
      this.channel.onmessage = (event: MessageEvent<Relay>) => {
        if (event.data.k === 'hello') this.channel?.postMessage({ k: 'status', status: this.last } satisfies Relay);
        else previous?.call(this.channel!, event);
      };
    }
    const wait = this.o.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const open = this.o.open ?? signedStream;
    const silenceMs = this.o.silenceMs ?? 60_000;
    let failures = 0;
    let everUp = false;

    while (!this.stopped) {
      const ctl = new AbortController();
      this.current = ctl;
      this.restarting = false;
      const path = `${base(this.o.organisationId, this.o.designId)}/live?since=${encodeURIComponent(String(this.o.since()))}`;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let quiet = false;
      try {
        const response = await open(path, ctl.signal);
        if (!response.body) throw new Error('the live feed has no body');
        everUp = true;
        this.tell('up');
        const reader = response.body.getReader();
        const frames = new FrameReader();
        const arm = (): void => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            quiet = true;
            ctl.abort();
          }, silenceMs);
        };
        arm();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          arm();
          failures = 0;
          for (const frame of frames.push(value)) {
            if (frame.type === FRAME_HEARTBEAT) continue;
            this.deliver(frame);
          }
        }
        // The server ended it (ten minutes, or a resync): open it again.
        clearTimeout(timer);
        if (this.stopped) return;
        failures = 0;
        await wait(200);
        continue;
      } catch (error) {
        clearTimeout(timer);
        if (this.stopped) return;
        if (!everUp && error instanceof ApiRefusal) {
          this.tell('unavailable');
          return;
        }
        if (this.restarting) {
          this.restarting = false;
          continue;
        }
        const why = whyDown(error, quiet);
        console.warn(`live feed: ${why}`, error);
        this.tell('down', why);
        await wait(BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)]);
        failures += 1;
      }
    }
  }
}
