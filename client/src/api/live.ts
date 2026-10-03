// The live feed and the calls beside it (ADR-0063, "Wire"). One signed GET
// streams frames down; changes and presence go up as signed POSTs.

import { ApiRefusal } from './errors';
import { withSchemaPrefix } from './payload';
import { signedFetchWithHeaders, signedStream } from './signedFetch';

export const FRAME_CHANGE = 1;
export const FRAME_RELOAD = 2;
export const FRAME_PRESENCE = 3;
export const FRAME_HEARTBEAT = 4;
export const FRAME_RESYNC = 5;

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
}

/** The people in the stream owner's view: `[{"account": "<ulid>", "initials": "KM"}]`. */
export function parsePresence(bytes: Uint8Array): Person[] {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return [];
  }
  if (!Array.isArray(json)) return [];
  const out: Person[] = [];
  for (const item of json) {
    const o = item as { account?: unknown; initials?: unknown } | null;
    if (o !== null && typeof o === 'object' && typeof o.account === 'string' && typeof o.initials === 'string') {
      out.push({ account: o.account, initials: o.initials.slice(0, 3) });
    }
  }
  return out;
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

export async function postPresence(organisationId: string, designId: string, view: string): Promise<void> {
  const body = new TextEncoder().encode(view.slice(0, 64));
  await signedFetchWithHeaders('POST', `${base(organisationId, designId)}/presence`, body, true);
}

/** Whether a failed change was refused (drop it) rather than not delivered (send it again). */
export function isRefusal(error: unknown): boolean {
  if (!(error instanceof ApiRefusal)) return false;
  return error.status >= 400 && error.status < 500 && error.status !== 401 && error.status !== 408 && error.status !== 429;
}

// ---------------------------------------------------------------------------
// The feed

export type FeedStatus = 'connecting' | 'up' | 'down' | 'unavailable';

export interface FeedEvents {
  frame(frame: LiveFrame): void;
  status(status: FeedStatus): void;
}

export interface FeedOptions {
  organisationId: string;
  designId: string;
  /** The last version this tab has applied. */
  since(): number;
  events: FeedEvents;
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
  | { k: 'status'; status: FeedStatus };

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 15000];

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

  constructor(options: FeedOptions) {
    this.o = options;
  }

  get owns(): boolean {
    return this.owner;
  }

  start(): void {
    const name = `fathom-live-${this.o.designId}`;
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
    else if (m.k === 'status') this.o.events.status(m.status);
  }

  private tell(status: FeedStatus): void {
    this.last = status;
    this.o.events.status(status);
    this.channel?.postMessage({ k: 'status', status } satisfies Relay);
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
      try {
        const response = await open(path, ctl.signal);
        if (!response.body) throw new Error('the live feed has no body');
        everUp = true;
        this.tell('up');
        const reader = response.body.getReader();
        const frames = new FrameReader();
        const arm = (): void => {
          clearTimeout(timer);
          timer = setTimeout(() => ctl.abort(), silenceMs);
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
        this.tell('down');
        await wait(BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)]);
        failures += 1;
      }
    }
  }
}
