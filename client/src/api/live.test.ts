import { afterEach, describe, expect, it, vi } from 'vitest';

import { setSession, type ActiveSession } from '../state/sessionState';
import { ApiRefusal } from './errors';
import { FRAME_CHANGE, FRAME_HEARTBEAT, FRAME_PRESENCE, FrameReader, LiveFeed, isRefusal, liveChannelName, parseAuthor, parsePresence, presenceInView, whyDown, type FeedStatus, type LiveFrame } from './live';

function frame(type: number, version: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(13 + body.length);
  const view = new DataView(out.buffer);
  view.setUint8(0, type);
  view.setBigUint64(1, BigInt(version), true);
  view.setUint32(9, body.length, true);
  out.set(body, 13);
  return out;
}

const text = (s: string) => new TextEncoder().encode(s);

function streamOf(...chunks: Uint8Array[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const chunk of chunks) c.enqueue(chunk);
        c.close();
      },
    }),
  );
}

describe('FrameReader', () => {
  it('reads frames however the bytes are cut', () => {
    const all = new Uint8Array([...frame(FRAME_CHANGE, 7, text('abc')), ...frame(FRAME_HEARTBEAT, 7, new Uint8Array(0)), ...frame(FRAME_PRESENCE, 0, text('[]'))]);
    for (const cut of [1, 5, 13, 14, 20]) {
      const r = new FrameReader();
      const out: LiveFrame[] = [];
      for (let i = 0; i < all.length; i += cut) out.push(...r.push(all.slice(i, i + cut)));
      expect(out.map((f) => [f.type, f.version, new TextDecoder().decode(f.bytes)])).toEqual([
        [1, 7, 'abc'],
        [4, 7, ''],
        [3, 0, '[]'],
      ]);
    }
  });

  it('refuses a frame that claims to be enormous', () => {
    const bad = frame(1, 1, new Uint8Array(0));
    new DataView(bad.buffer).setUint32(9, 0xffffffff, true);
    expect(() => new FrameReader().push(bad)).toThrow(/too large/);
  });
});

const ann = { account: '01A', initials: 'AN', name: 'Ann Lee' };
const bob = { account: '01B', initials: 'BO', name: 'Bob Roe', selected: 'chassis:X' };

describe('parsePresence', () => {
  it('takes {self, others} with names and what others have selected, and nothing else', () => {
    expect(parsePresence(text(JSON.stringify({ self: ann, others: [bob, { ...bob, account: '01C', selected: null }] })))).toEqual({
      self: ann,
      others: [bob, { ...bob, account: '01C', selected: null }],
    });
    expect(parsePresence(text('[{"account":"01A","initials":"KM"}]'))).toEqual({ self: null, others: [] });
    expect(parsePresence(text('{"others":["SK",{"initials":"SK"},null]}'))).toEqual({ self: null, others: [] });
    expect(parsePresence(text('not json'))).toEqual({ self: null, others: [] });
  });
});

describe('parseAuthor', () => {
  it('reads one named person', () => {
    expect(parseAuthor(text(JSON.stringify(ann)))).toEqual(ann);
    expect(parseAuthor(text('{"account":"01A"}'))).toBeNull();
  });
});

describe('presenceInView', () => {
  it('shows the dots only in the view the stream owner is in', () => {
    const people = [bob];
    expect(presenceInView(people, 'canvas', 'canvas')).toEqual(people);
    expect(presenceInView(people, 'canvas', 'inventory')).toEqual([]);
    // The owner tab itself (no relayed view) shows what the server sent.
    expect(presenceInView(people, undefined, 'inventory')).toEqual(people);
  });
});

describe('isRefusal', () => {
  it('tells a refusal from a failure to deliver', () => {
    expect(isRefusal(new ApiRefusal(409, 'x', null))).toBe(true);
    expect(isRefusal(new ApiRefusal(422, 'x', null))).toBe(true);
    expect(isRefusal(new ApiRefusal(429, 'x', 3))).toBe(false);
    expect(isRefusal(new ApiRefusal(401, 'x', null))).toBe(false);
    expect(isRefusal(new ApiRefusal(503, 'x', null))).toBe(false);
    expect(isRefusal(new TypeError('network'))).toBe(false);
  });
});

describe('LiveFeed (one tab, no Web Locks)', () => {
  function run(open: (path: string, signal: AbortSignal) => Promise<Response>, stopAfter: (frames: LiveFrame[], statuses: FeedStatus[]) => boolean) {
    const frames: LiveFrame[] = [];
    const statuses: FeedStatus[] = [];
    const paths: string[] = [];
    let since = 10;
    let feed: LiveFeed;
    const done = new Promise<void>((resolve) => {
      const check = () => {
        if (stopAfter(frames, statuses)) {
          feed.stop();
          resolve();
        }
      };
      feed = new LiveFeed({
        organisationId: 'o 1',
        designId: 'd1',
        since: () => since,
        events: {
          frame: (f) => {
            frames.push(f);
            since = f.version;
            check();
          },
          status: (s) => {
            statuses.push(s);
            check();
          },
        },
        open: (path, signal) => {
          paths.push(path);
          return open(path, signal);
        },
        delay: () => Promise.resolve(),
      });
      feed.start();
    });
    return { done, frames, statuses, paths };
  }

  it('reopens from the last version it applied when the server ends the stream', async () => {
    let n = 0;
    const r = run(
      async () => {
        n += 1;
        return n === 1 ? streamOf(frame(FRAME_CHANGE, 11, text('a')), frame(FRAME_HEARTBEAT, 11, new Uint8Array(0))) : streamOf(frame(FRAME_CHANGE, 12, text('b')));
      },
      (f) => f.length === 2,
    );
    await r.done;
    expect(r.frames.map((f) => f.version)).toEqual([11, 12]);
    expect(r.paths).toEqual(['/organisations/o%201/designs/d1/live?since=10', '/organisations/o%201/designs/d1/live?since=11']);
    expect(r.statuses[0]).toBe('up');
  });

  it('is down after a network failure and up again on the next try', async () => {
    let n = 0;
    const r = run(
      async () => {
        n += 1;
        if (n === 1) throw new TypeError('network');
        return streamOf(frame(FRAME_CHANGE, 11, text('a')));
      },
      (f) => f.length === 1,
    );
    await r.done;
    expect(r.statuses.slice(0, 2)).toEqual(['down', 'up']);
  });

  it('is unavailable when the very first open is refused', async () => {
    const r = run(
      async () => {
        throw new ApiRefusal(404, 'not found', null);
      },
      (_f, s) => s.includes('unavailable'),
    );
    await r.done;
    expect(r.statuses).toEqual(['unavailable']);
    expect(r.paths).toHaveLength(1);
  });
});

describe('liveChannelName', () => {
  it('differs by account and design, and not by tab, so one account shares one stream', () => {
    const a = liveChannelName('d1', 'acct1');
    expect(liveChannelName('d1', 'acct1')).toBe(a);
    expect(liveChannelName('d1', 'acct2')).not.toBe(a);
    expect(liveChannelName('d2', 'acct1')).not.toBe(a);
  });
});

describe('LiveFeed and this tab’s own session', () => {
  it('stops when the tab signs out', async () => {
    const fake = { sessionId: 's', kind: 'steward', accountId: 'acct1' } as unknown as ActiveSession;
    setSession(fake);
    let signal!: AbortSignal;
    const feed = new LiveFeed({
      organisationId: 'o',
      designId: 'd',
      since: () => 0,
      events: { frame() {}, status() {} },
      open: (_p, s) => {
        signal = s;
        return new Promise<Response>(() => {});
      },
    });
    feed.start();
    await Promise.resolve();
    expect(signal.aborted).toBe(false);
    setSession(null);
    expect(signal.aborted).toBe(true);
  });
});

describe('LiveFeed on a half-dead connection', () => {
  afterEach(() => vi.useRealTimers());

  it('treats 60 s without any frame as dead, says down, aborts and opens again', async () => {
    vi.useFakeTimers();
    const statuses: FeedStatus[] = [];
    const whys: Array<string | undefined> = [];
    const aborted: boolean[] = [];
    let opens = 0;
    const feed = new LiveFeed({
      organisationId: 'o',
      designId: 'd',
      since: () => 0,
      events: { frame() {}, status: (s, why) => (statuses.push(s), whys.push(why)) },
      open: async (_p, signal) => {
        opens += 1;
        aborted.push(false);
        const i = opens - 1;
        // A socket that never closes and never speaks again; it only ends when aborted.
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              signal.addEventListener('abort', () => {
                aborted[i] = true;
                c.error(new DOMException('aborted', 'AbortError'));
              });
            },
          }),
        );
      },
    });
    feed.start();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(statuses).toEqual(['up']);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(aborted[0]).toBe(true);
    expect(statuses.slice(0, 2)).toEqual(['up', 'down']);
    expect(whys[1]).toMatch(/opened but nothing came through/);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(opens).toBe(2);
    expect(statuses.slice(0, 3)).toEqual(['up', 'down', 'up']);
    feed.stop();
  });
});

describe('whyDown', () => {
  it('says what the server answered, or only what the browser saw', () => {
    expect(whyDown(new ApiRefusal(429, 'too many live streams for this account', null), false)).toBe(
      'The server answered 429: too many live streams for this account',
    );
    expect(whyDown(new ApiRefusal(502, '<html><body>Bad Gateway</body></html>', null), false)).toBe('The server answered 502.');
    expect(whyDown(new TypeError('Failed to fetch'), false)).toBe('The server could not be reached.');
    expect(whyDown(new DOMException('aborted', 'AbortError'), true)).toMatch(/nothing came through/);
  });
});
