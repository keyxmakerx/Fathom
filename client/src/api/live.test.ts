import { describe, expect, it } from 'vitest';

import { ApiRefusal } from './errors';
import { FRAME_CHANGE, FRAME_HEARTBEAT, FRAME_PRESENCE, FrameReader, LiveFeed, isRefusal, parsePresence, presenceInView, type FeedStatus, type LiveFrame } from './live';

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

describe('parsePresence', () => {
  it('takes the fixed shape and nothing else', () => {
    expect(parsePresence(text('[{"account":"01A","initials":"KM"}]'))).toEqual([{ account: '01A', initials: 'KM' }]);
    expect(parsePresence(text('["SK"]'))).toEqual([]);
    expect(parsePresence(text('[{"initials":"SK"},null]'))).toEqual([]);
    expect(parsePresence(text('{"a":1}'))).toEqual([]);
    expect(parsePresence(text('not json'))).toEqual([]);
  });
});

describe('presenceInView', () => {
  const people = [{ account: '01A', initials: 'KM' }];
  it('shows the dots only in the view the stream owner is in', () => {
    expect(presenceInView(people, 'canvas', 'canvas')).toEqual(people);
    expect(presenceInView(people, 'canvas', 'inventory')).toEqual([]);
    expect(presenceInView(people, 'rack:a', 'rack:b')).toEqual([]);
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
