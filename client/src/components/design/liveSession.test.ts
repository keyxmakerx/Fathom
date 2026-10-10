import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiRefusal } from '../../api/errors';
import { FRAME_AUTHOR, FRAME_CHANGE, FRAME_PRESENCE, FRAME_RELOAD, FRAME_RESYNC, type FeedEvents, type LiveFrame } from '../../api/live';
import { changeOf, writeChange, type Change } from '../../document/change';
import { createRack, placeChassis } from '../../document/commands';
import { setDeviceField, setRackField } from '../../document/edit';
import { PUT_BACK_LABEL, putMineBack } from '../../document/liveDoc';
import { edgesIn, emptyDocument, findNode, formatNodeId, type Document } from '../../document/model';
import { newUlid } from '../../document/ulid';
import { LiveEditing, presenceViewOf, type FeedLike, type LiveDeps, type LiveView } from './liveSession';

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
  viewPosts: Array<{ view: string; selected: string | null }>;
  feed: { restarts: number; stops: number };
  post: ReturnType<typeof vi.fn>;
  reopen: ReturnType<typeof vi.fn>;
}

function rig(base: Document, over: Partial<LiveDeps> = {}): Rig {
  let events!: FeedEvents;
  const views: LiveView[] = [];
  const posts: Rig['posts'] = [];
  const saves: Document[] = [];
  const viewPosts: Array<{ view: string; selected: string | null }> = [];
  const feed = { restarts: 0, stops: 0 };
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
        return { start() {}, stop: () => void feed.stops++, restart: () => (feed.restarts++, true) };
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

  it('shows the reconnecting line while a change cannot be delivered, and clears it once it is', async () => {
    const { base, deviceId } = world();
    const r = rig(base);
    r.events().status('up');
    r.post.mockRejectedValueOnce(new TypeError('network'));
    r.live.edit(setDeviceField(base, deviceId, 'hostname', 'one', { actor: ME, now: Date.now() }));
    await vi.advanceTimersByTimeAsync(0);
    expect(last(r).connected).toBe(true);
    expect(last(r).reconnecting).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.post).toHaveBeenCalledTimes(2);
    expect(last(r).reconnecting).toBe(false);
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

  it('after 20 s of failing says what it keeps running into, and forgets it once a frame gets through', async () => {
    const { base } = world();
    const r = rig(base);
    r.events().status('up');
    r.events().status('down', 'The server answered 429: too many live streams on this design for this account');
    expect(last(r).reconnecting).toBe(true);
    expect(last(r).stuck).toBeNull();
    await vi.advanceTimersByTimeAsync(15_000);
    // Opening and failing again does not restart the clock: no frame came through.
    r.events().status('up');
    r.events().status('down', 'The server answered 429: too many live streams on this design for this account');
    expect(last(r).stuck).toBeNull();
    await vi.advanceTimersByTimeAsync(6_000);
    r.events().status('down', 'The server answered 429: too many live streams on this design for this account');
    expect(last(r).stuck).toBe('The server answered 429: too many live streams on this design for this account');
    r.events().status('up');
    expect(last(r).stuck).toBeNull();
    r.events().frame(frame(FRAME_PRESENCE, 10, new TextEncoder().encode('{"self":null,"others":[]}')));
    r.events().status('down', 'The server could not be reached.');
    expect(last(r).stuck).toBeNull();
  });

  it('says why after a change has failed to send four times', async () => {
    const { base, deviceId } = world();
    const r = rig(base);
    r.events().status('up');
    r.post.mockRejectedValue(new ApiRefusal(500, 'internal error', null));
    r.live.edit(setDeviceField(base, deviceId, 'hostname', 'one', { actor: ME, now: Date.now() }));
    await vi.advanceTimersByTimeAsync(0);
    expect(last(r).reconnecting).toBe(true);
    expect(last(r).stuck).toBeNull();
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000);
    expect(r.post).toHaveBeenCalledTimes(4);
    expect(last(r).stuck).toBe('Sending a change failed: the server answered 500: internal error');
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
  const person = (account: string, name: string, initials: string, selected?: string | null) => ({ account, name, initials, ...(selected !== undefined ? { selected } : {}) });
  const presenceFrame = (self: object | null, others: object[]) =>
    frame(FRAME_PRESENCE, 0, new TextEncoder().encode(JSON.stringify({ self, others })));

  /** I wrote the role and it is confirmed; Bob then writes over it. */
  function overwritten() {
    const { base, deviceId } = world();
    const r = rig(base);
    r.events().status('up');
    r.events().frame(presenceFrame(person(ME, 'Ann Lee', 'AL'), [person(THEM, 'Bob Roe', 'BR')]));
    const mine = setDeviceField(base, deviceId, 'role', 'router', { actor: ME, now: Date.now() });
    r.live.edit(mine);
    r.events().frame(frame(FRAME_CHANGE, 11, writeChange(changeOf(base, mine))));
    const theirs = setDeviceField(mine, deviceId, 'role', 'switch', { actor: THEM, now: Date.now() + 5 });
    r.events().frame(frame(FRAME_CHANGE, 12, writeChange(changeOf(mine, theirs))));
    return { r, base, deviceId, mine, theirs };
  }

  it('tells the person, by name, device and panel label, when another person’s change lands on a field they wrote', async () => {
    const { r, deviceId } = overwritten();
    expect(last(r).self).toEqual(person(ME, 'Ann Lee', 'AL'));
    expect(last(r).people).toEqual([person(THEM, 'Bob Roe', 'BR')]);
    expect(last(r).overwrite?.lines).toEqual(['Bob Roe changed the role on an unnamed device just after you']);
    expect(last(r).overwrite?.items.map((i) => i.yours)).toEqual(["yours router → Bob's switch"]);
    expect(last(r).overwrite?.keep).toBe("Keep Bob's");
    expect(last(r).overwrite?.anchor).toBe('role');
    expect(last(r).overwrite?.element).toBe(deviceId);
    expect(last(r).overwrite?.items.map((i) => i.field)).toEqual(['role']);
    expect(last(r).overwrite?.parts).toEqual([{ head: 'Bob Roe changed the role', on: 'an unnamed device', tail: ' just after you' }]);
    expect(findNode(last(r).doc, deviceId)!.fields['Device.role'].value).toBe('switch');

    r.live.putBack(last(r).overwrite!.items[0].id);
    await vi.advanceTimersByTimeAsync(0);
    expect(last(r).overwrite).toBeNull();
    expect(findNode(last(r).doc, deviceId)!.fields['Device.role'].value).toBe('router');
    expect(last(r).pendingCount).toBe(1);
    expect(r.posts[r.posts.length - 1].after).toBe(12);
  });

  it('keeps several overwrites in one notice, each with its own line and Put mine back', async () => {
    const { r, base, deviceId, theirs } = overwritten();
    const hostMine = setDeviceField(theirs, deviceId, 'hostname', 'mine-name', { actor: ME, now: Date.now() + 10 });
    r.live.edit(hostMine);
    r.events().frame(frame(FRAME_CHANGE, 13, writeChange(changeOf(theirs, hostMine))));
    const hostTheirs = setDeviceField(hostMine, deviceId, 'hostname', 'their-name', { actor: THEM, now: Date.now() + 15 });
    r.events().frame(frame(FRAME_CHANGE, 14, writeChange(changeOf(hostMine, hostTheirs))));
    void base;
    const o = last(r).overwrite!;
    expect(o.lines).toHaveLength(2);
    expect(o.lines[0]).toContain('Bob Roe changed the role');
    expect(o.lines[1]).toBe('Bob Roe changed the name on their-name just after you');
    expect(o.items).toHaveLength(2);
    r.live.putBack(o.items[0].id);
    await vi.advanceTimersByTimeAsync(0);
    expect(last(r).overwrite?.items).toHaveLength(1);
  });

  it('says it was a put-back when the other person puts their value back', () => {
    const { r, base, deviceId, theirs } = overwritten();
    void base;
    // Bob's value stands; Ann puts hers back, which Bob sees as Ann's put-back.
    const back = putMineBack(theirs, last(r).overwrite ? { element: deviceId, key: 'Device.role', by: ME, mine: { presence: 'set', value: 'router' }, theirs: { presence: 'set', value: 'switch' }, on: 'x', putBack: false, at: 1 } : (undefined as never), { actor: ME, now: Date.now() + 20 })!;
    expect(back.batches[back.batches.length - 1].label).toBe(PUT_BACK_LABEL);
  });

  it('keeping theirs just dismisses the notice', () => {
    const { r } = overwritten();
    expect(last(r).overwrite).not.toBeNull();
    r.live.dismissOverwrite();
    expect(last(r).overwrite).toBeNull();
    expect(last(r).pendingCount).toBe(0);
  });

  it('says once that a change merged with another person’s on the same thing, and lets it go after a while', async () => {
    const { base, rackId } = (() => {
      const w = world();
      const rackId = w.base.nodes.find((n) => n.id.startsWith('rack:'))!.id;
      return { base: w.base, rackId };
    })();
    const r = rig(base);
    r.events().status('up');
    r.events().frame(presenceFrame(null, [person(THEM, 'Bob Roe', 'BR')]));
    const mine = setRackField(base, rackId, 'row', 'Row A', { actor: ME, now: Date.now() });
    r.live.edit(mine);
    r.events().frame(frame(FRAME_CHANGE, 11, writeChange(changeOf(base, mine))));
    const theirs = setRackField(mine, rackId, 'bay', 2, { actor: THEM, now: Date.now() + 5 });
    r.events().frame(frame(FRAME_CHANGE, 12, writeChange(changeOf(mine, theirs))));
    expect(last(r).merged).toBe("Your row change merged; you changed different fields. Both are in history.");
    expect(last(r).overwrite).toBeNull();
    await vi.advanceTimersByTimeAsync(21_000);
    expect(last(r).merged).toBeNull();
  });

  it('learns an author’s name from an author frame sent before their first change', () => {
    const { base, deviceId } = world();
    const r = rig(base);
    r.events().status('up');
    const mine = setDeviceField(base, deviceId, 'role', 'router', { actor: ME, now: Date.now() });
    r.live.edit(mine);
    r.events().frame(frame(FRAME_CHANGE, 11, writeChange(changeOf(base, mine))));
    r.events().frame(frame(FRAME_AUTHOR, 11, new TextEncoder().encode(JSON.stringify(person(THEM, 'Cy Dunn', 'CD')))));
    const theirs = setDeviceField(mine, deviceId, 'role', 'switch', { actor: THEM, now: Date.now() + 5 });
    r.events().frame(frame(FRAME_CHANGE, 12, writeChange(changeOf(mine, theirs))));
    expect(last(r).overwrite?.keep).toBe("Keep Cy's");
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

  it('on a resync frame takes the design as it is now and streams on from its version', async () => {
    const { base, deviceId } = world();
    const r = rig(base);
    r.events().status('up');
    const whole = setDeviceField(base, deviceId, 'role', 'switch', { actor: THEM, now: Date.now() });
    r.reopen.mockResolvedValue({ doc: whole, version: 30 });
    r.events().frame(frame(FRAME_RESYNC, 0, new Uint8Array(0)));
    await vi.advanceTimersByTimeAsync(0);
    expect(r.reopen).toHaveBeenCalledTimes(1);
    expect(findNode(last(r).doc, deviceId)!.fields['Device.role'].value).toBe('switch');
    expect(r.feed.restarts).toBe(1);
  });

  it('stops listening when its own requests are refused for want of access', async () => {
    const { base, deviceId } = world();
    const r = rig(base);
    r.events().status('up');
    r.post.mockRejectedValueOnce(new ApiRefusal(403, 'no', null));
    r.live.edit(setDeviceField(base, deviceId, 'hostname', 'one', { actor: ME, now: Date.now() }));
    await vi.advanceTimersByTimeAsync(0);
    expect(r.feed.stops).toBe(1);
    expect(last(r).connected).toBe(false);
    expect(last(r).note).toContain('no longer have access');
    expect(r.post).toHaveBeenCalledTimes(1);
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
  it('the view is what is being looked at, never what is selected', () => {
    expect(presenceViewOf('racks')).toBe('canvas');
    expect(presenceViewOf('inventory')).toBe('inventory');
  });

  it('a tab in another view than the stream owner shows no dots, and shows them when it moves to the owner’s', () => {
    const { base } = world();
    const r = rig(base);
    r.events().status('up');
    r.live.setPresence('inventory', null);
    const bytes = new TextEncoder().encode(JSON.stringify({ self: null, others: [{ account: THEM, initials: 'SK', name: 'Sam Kerr', selected: null }] }));
    r.events().frame({ ...frame(FRAME_PRESENCE, 0, bytes), view: 'canvas' });
    expect(last(r).people).toEqual([]);
    r.live.setPresence('canvas', null);
    expect(last(r).people).toEqual([{ account: THEM, initials: 'SK', name: 'Sam Kerr', selected: null }]);
  });

  it('sends the view and selection when the stream is up and at most twice a second after that', async () => {
    const { base } = world();
    const r = rig(base);
    r.live.setPresence('canvas', null);
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.viewPosts).toEqual([]); // not connected

    r.events().status('up');
    await vi.advanceTimersByTimeAsync(0);
    expect(r.viewPosts).toEqual([{ view: 'canvas', selected: null }]);
    r.live.setPresence('canvas', 'chassis:a');
    r.live.setPresence('canvas', 'chassis:b');
    r.live.setPresence('inventory', 'chassis:b');
    await vi.advanceTimersByTimeAsync(100);
    expect(r.viewPosts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(r.viewPosts).toEqual([
      { view: 'canvas', selected: null },
      { view: 'inventory', selected: 'chassis:b' },
    ]);
    // The same view and selection again sends nothing.
    r.live.setPresence('inventory', 'chassis:b');
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.viewPosts).toHaveLength(2);
  });
});
