import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiRefusal } from '../../api/errors';
import { FRAME_CHANGE, FRAME_PRESENCE, FRAME_RELOAD, type FeedEvents, type LiveFrame } from '../../api/live';
import { changeOf, writeChange, type Change } from '../../document/change';
import { createRack, placeChassis } from '../../document/commands';
import { setDeviceField } from '../../document/edit';
import { edgesIn, emptyDocument, findNode, formatNodeId, type Document } from '../../document/model';
import { newUlid } from '../../document/ulid';
import { LiveEditing, type FeedLike, type LiveDeps, type LiveView } from './liveSession';

const T0 = 1_700_000_000_000;
const ME = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const THEM = '01BX5ZZKBKACTAV9WEVGEMMVRY';

const MODEL = {
  vendor: 'juniper',
  model: 'EX4300-48P',
  rackUnits: 1,
  reviewedBy: 'reviewer',
  source: { cite: 'cite', readOn: '2026-09-14' },
  psuSlots: [],
  faceplates: [{ face: 'front' as const, portCount: 1, ports: [{ kind: 'RJ45', number: 0, uplink: false, row: 'single' as const, column: 0, groupGapBefore: false }] }],
};

function world(): { base: Document; deviceId: string } {
  const premisesId = formatNodeId('Premises', newUlid(T0));
  const empty: Document = { ...emptyDocument(), nodes: [{ id: premisesId, existence: newUlid(T0), fields: {} }] };
  const withRack = createRack(empty, premisesId, { label: 'R1', heightU: 42, unitNumbering: 'ascending', actor: THEM, now: T0 + 1 });
  const rackId = withRack.nodes.find((n) => n.id !== premisesId)!.id;
  const placed = placeChassis(withRack, rackId, MODEL, 4, 'front', { actor: THEM, now: T0 + 2 });
  const chassisId = edgesIn(placed, rackId, 'MountedIn')[0].from;
  return { base: placed, deviceId: edgesIn(placed, chassisId, 'HasChassis')[0].from };
}

interface Rig {
  live: LiveEditing;
  views: LiveView[];
  events: () => FeedEvents;
  posts: Array<{ batch: string; after: number }>;
  saves: Document[];
  viewPosts: string[];
  feed: { restarts: number };
  post: ReturnType<typeof vi.fn>;
  reopen: ReturnType<typeof vi.fn>;
}

function rig(base: Document, over: Partial<LiveDeps> = {}): Rig {
  let events!: FeedEvents;
  const views: LiveView[] = [];
  const posts: Rig['posts'] = [];
  const saves: Document[] = [];
  const viewPosts: string[] = [];
  const feed = { restarts: 0 };
  const post = vi.fn(async (c: Change, after: number) => {
    posts.push({ batch: c.batch.id, after });
    return after + 1;
  });
  const reopen = vi.fn(async () => ({ doc: base, version: 10 }));
  const live = new LiveEditing(
    {
      me: ME,
      canDraw: true,
      reopen,
      post,
      postView: async (v) => void viewPosts.push(v),
      makeFeed: (_since, e): FeedLike => {
        events = e;
        return { start() {}, stop() {}, restart: () => (feed.restarts++, true) };
      },
      save: (d) => saves.push(d),
      onView: (v) => views.push(v),
      now: () => Date.now(),
      ...over,
    },
    base,
    10,
  );
  live.start();
  return { live, views, events: () => events, posts, saves, viewPosts, feed, post, reopen };
}

const last = (r: Rig) => r.views[r.views.length - 1];
const frame = (type: number, version: number, bytes: Uint8Array): LiveFrame => ({ type, version, bytes });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0 + 10_000);
});
afterEach(() => vi.useRealTimers());

describe('sending', () => {
  it('shows an edit at once, sends it once the stream is up, in order, naming the confirmed version', async () => {
    const { base, deviceId } = world();
    const r = rig(base);
    const a = setDeviceField(base, deviceId, 'hostname', 'one', { actor: ME, now: Date.now() });
    r.live.edit(a);
    const b = setDeviceField(a, deviceId, 'hostname', 'two', { actor: ME, now: Date.now() + 1 });
    r.live.edit(b);
    expect(last(r).pendingCount).toBe(2);
    expect(last(r).doc).toBe(b);
    expect(r.posts).toEqual([]); // stream not up yet

    r.events().status('up');
    await vi.advanceTimersByTimeAsync(0);
    expect(last(r).mode).toBe('live');
    expect(r.posts).toEqual([
      { batch: a.batches[a.batches.length - 1].id, after: 10 },
      { batch: b.batches[b.batches.length - 1].id, after: 10 },
    ]);

    // Echoes come back through the stream and empty the queue.
    r.events().frame(frame(FRAME_CHANGE, 11, writeChange(changeOf(base, a))));
    r.events().frame(frame(FRAME_CHANGE, 12, writeChange(changeOf(a, b))));
    expect(last(r).pendingCount).toBe(0);
    expect(last(r).doc).toBe(b);
  });

  it('drops a refused change and shows the server’s own sentence', async () => {
    const { base, deviceId } = world();
    const r = rig(base);
    r.events().status('up');
    r.post.mockRejectedValueOnce(new ApiRefusal(422, 'that value is not allowed', null));
    r.live.edit(setDeviceField(base, deviceId, 'hostname', 'one', { actor: ME, now: Date.now() }));
    await vi.advanceTimersByTimeAsync(0);
    expect(last(r).pendingCount).toBe(0);
    expect(last(r).note).toBe('that value is not allowed');
    expect(findNode(last(r).doc, deviceId)!.fields['Device.hostname']).toBeUndefined();
  });

  it('keeps a change it could not deliver and sends it again', async () => {
    const { base, deviceId } = world();
    const r = rig(base);
    r.events().status('up');
    r.post.mockRejectedValueOnce(new TypeError('network'));
    r.live.edit(setDeviceField(base, deviceId, 'hostname', 'one', { actor: ME, now: Date.now() }));
    await vi.advanceTimersByTimeAsync(0);
    expect(last(r).pendingCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.post).toHaveBeenCalledTimes(2);
  });

  it('says it is reconnecting while the stream is down, and keeps changes without sending them', async () => {
    const { base, deviceId } = world();
    const r = rig(base);
    r.events().status('up');
    r.events().status('down');
    expect(last(r).reconnecting).toBe(true);
    r.live.edit(setDeviceField(base, deviceId, 'hostname', 'one', { actor: ME, now: Date.now() }));
    await vi.advanceTimersByTimeAsync(0);
    expect(r.post).not.toHaveBeenCalled();
    expect(last(r).pendingCount).toBe(1);
    r.events().status('up');
    await vi.advanceTimersByTimeAsync(0);
    expect(r.post).toHaveBeenCalledTimes(1);
    expect(last(r).reconnecting).toBe(false);
  });

  it('a reader sends nothing', async () => {
    const { base, deviceId } = world();
    const r = rig(base, { canDraw: false });
    r.events().status('up');
    r.live.edit(setDeviceField(base, deviceId, 'hostname', 'one', { actor: ME, now: Date.now() }));
    await vi.advanceTimersByTimeAsync(0);
    expect(r.post).not.toHaveBeenCalled();
    expect(last(r).pendingCount).toBe(0);
  });
});

describe('without a live feed', () => {
  it('falls back to whole-document saves, today’s behaviour, including edits made while connecting', () => {
    const { base, deviceId } = world();
    const r = rig(base);
    const a = setDeviceField(base, deviceId, 'hostname', 'one', { actor: ME, now: Date.now() });
    r.live.edit(a);
    r.events().status('unavailable');
    expect(last(r).mode).toBe('legacy');
    expect(r.saves).toEqual([a]);
    const b = setDeviceField(a, deviceId, 'hostname', 'two', { actor: ME, now: Date.now() + 1 });
    r.live.edit(b);
    expect(r.saves).toEqual([a, b]);
    expect(last(r).doc).toBe(b);
    expect(last(r).pendingCount).toBe(0);
    expect(r.post).not.toHaveBeenCalled();
  });
});

describe('what others do', () => {
  it('tells the person when another person’s change lands on a field they wrote', async () => {
    const { base, deviceId } = world();
    const r = rig(base);
    r.events().status('up');
    r.events().frame(frame(FRAME_PRESENCE, 0, new TextEncoder().encode(JSON.stringify([{ account: THEM, initials: 'SK' }]))));
    expect(last(r).people).toEqual([{ initials: 'SK', account: THEM }]);

    const mine = setDeviceField(base, deviceId, 'hostname', 'mine', { actor: ME, now: Date.now() });
    r.live.edit(mine);
    await vi.advanceTimersByTimeAsync(0);
    r.events().frame(frame(FRAME_CHANGE, 11, writeChange(changeOf(base, mine))));
    const theirs = setDeviceField(mine, deviceId, 'hostname', 'theirs', { actor: THEM, now: Date.now() + 5 });
    r.events().frame(frame(FRAME_CHANGE, 12, writeChange(changeOf(mine, theirs))));

    expect(last(r).overwrite?.sentence).toBe('SK changed hostname just after you.');
    expect(findNode(last(r).doc, deviceId)!.fields['Device.hostname'].value).toBe('theirs');

    r.live.putBack();
    await vi.advanceTimersByTimeAsync(0);
    expect(last(r).overwrite).toBeNull();
    expect(findNode(last(r).doc, deviceId)!.fields['Device.hostname'].value).toBe('mine');
    expect(last(r).pendingCount).toBe(1);
    expect(r.posts[r.posts.length - 1].after).toBe(12);
  });

  it('keeping theirs just dismisses the notice', () => {
    const { base, deviceId } = world();
    const r = rig(base);
    r.events().status('up');
    const mine = setDeviceField(base, deviceId, 'hostname', 'mine', { actor: ME, now: Date.now() });
    r.live.edit(mine);
    r.events().frame(frame(FRAME_CHANGE, 11, writeChange(changeOf(base, mine))));
    const theirs = setDeviceField(mine, deviceId, 'hostname', 'theirs', { actor: THEM, now: Date.now() + 5 });
    r.events().frame(frame(FRAME_CHANGE, 12, writeChange(changeOf(mine, theirs))));
    expect(last(r).overwrite).not.toBeNull();
    r.live.dismissOverwrite();
    expect(last(r).overwrite).toBeNull();
    expect(last(r).pendingCount).toBe(0);
  });

  it('asks the stream to start again from its last version when one is missed', () => {
    const { base, deviceId } = world();
    const r = rig(base);
    r.events().status('up');
    const theirs = setDeviceField(base, deviceId, 'hostname', 'theirs', { actor: THEM, now: Date.now() });
    r.events().frame(frame(FRAME_CHANGE, 13, writeChange(changeOf(base, theirs))));
    expect(r.feed.restarts).toBe(1);
    expect(last(r).doc).toBe(base);
  });

  it('on a reload frame reopens the design and replays what is pending on top', async () => {
    const { base, deviceId } = world();
    const r = rig(base);
    r.events().status('up');
    r.post.mockImplementation(() => new Promise(() => {})); // never answers
    const mine = setDeviceField(base, deviceId, 'hostname', 'mine', { actor: ME, now: Date.now() });
    r.live.edit(mine);
    const whole = setDeviceField(base, deviceId, 'role', 'switch', { actor: THEM, now: Date.now() });
    r.reopen.mockResolvedValue({ doc: whole, version: 20 });
    r.events().frame(frame(FRAME_RELOAD, 20, new Uint8Array(0)));
    await vi.advanceTimersByTimeAsync(0);
    const fields = findNode(last(r).doc, deviceId)!.fields;
    expect(fields['Device.hostname'].value).toBe('mine');
    expect(fields['Device.role'].value).toBe('switch');
    expect(last(r).pendingCount).toBe(1);
  });
});

describe('presence', () => {
  it('a tab in another view than the stream owner shows no dots, and shows them when it moves to the owner’s', () => {
    const { base } = world();
    const r = rig(base);
    r.events().status('up');
    r.live.setView('inventory');
    const bytes = new TextEncoder().encode(JSON.stringify([{ account: THEM, initials: 'SK' }]));
    r.events().frame({ ...frame(FRAME_PRESENCE, 0, bytes), view: 'canvas' });
    expect(last(r).people).toEqual([]);
    r.live.setView('canvas');
    expect(last(r).people).toEqual([{ account: THEM, initials: 'SK' }]);
  });

  it('sends the view when the stream is up and at most twice a second after that', async () => {
    const { base } = world();
    const r = rig(base);
    r.live.setView('canvas');
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.viewPosts).toEqual([]); // not connected

    r.events().status('up');
    await vi.advanceTimersByTimeAsync(0);
    expect(r.viewPosts).toEqual(['canvas']);
    r.live.setView('rack:a');
    r.live.setView('rack:b');
    r.live.setView('inventory');
    await vi.advanceTimersByTimeAsync(100);
    expect(r.viewPosts).toEqual(['canvas']);
    await vi.advanceTimersByTimeAsync(500);
    expect(r.viewPosts).toEqual(['canvas', 'inventory']);
  });
});
