// A design open for live co-editing (ADR-0063), without React: the live
// document, the stream, the queue of changes waiting to be sent, presence and
// the sentences the person is shown. `useDesignSession` wires it to the page.
//
// Modes. `connecting`: the stream has not answered yet; edits wait as pending
// changes. `live`: it has; edits are sent as changes. `legacy`: the very first
// open was refused, so the server has no live feed for this design and edits
// are whole-document saves exactly as before.

import { ApiRefusal } from '../../api/errors';
import {
  FRAME_AUTHOR,
  FRAME_CHANGE,
  FRAME_PRESENCE,
  FRAME_RELOAD,
  FRAME_RESYNC,
  isRefusal,
  parseAuthor,
  parsePresence,
  presenceInView,
  type FeedEvents,
  type FeedStatus,
  type LiveFrame,
  type Person,
  type PresenceBody,
} from '../../api/live';
import { ChangeError, readChange, type Change } from '../../document/change';
import {
  applyRefusal,
  applyReload,
  applyRemote,
  droppedSentence,
  keepLabel,
  localEdit,
  mergedSentence,
  openLive,
  overwriteLines,
  panelLabel,
  putMineBack,
  yoursLine,
  type LiveState,
  type Overwrite,
} from '../../document/liveDoc';
import type { Document } from '../../document/model';

export type LiveMode = 'connecting' | 'live' | 'legacy';

export interface LiveView {
  doc: Document;
  mode: LiveMode;
  /** The stream is up. */
  connected: boolean;
  /** The stream dropped and is being reopened. */
  reconnecting: boolean;
  /** Changes made here the server has not yet confirmed. */
  pendingCount: number;
  /** A sentence about a change that was dropped or refused. */
  note: string | null;
  /** "<who> changed <field> on <device> just after you": one notice, a line and a Put mine back for each field. */
  overwrite: { lines: string[]; items: Array<{ id: string; yours: string }>; keep: string; anchor: string } | null;
  /** Said once when this person's change merged with someone else's. */
  merged: string | null;
  /** This person, as the server names them. */
  self: Person | null;
  /** The others in this view, with what each has selected. */
  people: Person[];
}

export interface FeedLike {
  start(): void;
  stop(): void;
  restart(): boolean;
}

export interface LiveDeps {
  /** The signed-in account, which wrote what is "mine". */
  me: string | undefined;
  canDraw: boolean;
  reopen(): Promise<{ doc: Document; version: number }>;
  post(change: Change, after: number): Promise<number>;
  postView(body: PresenceBody): Promise<void>;
  makeFeed(since: () => number, events: FeedEvents, view: () => string): FeedLike;
  /** Legacy mode: save the whole document. */
  save(doc: Document): void;
  onView(view: LiveView): void;
  now?: () => number;
}

const RETRY_MS = [1000, 2000, 4000, 8000, 15000];
const PRESENCE_GAP_MS = 500;
const MERGED_MS = 20_000;

/** The view this person is looking at. A rack is never a view of its own: the canvas holds them all. */
export function presenceViewOf(place: 'racks' | 'inventory'): string {
  return place === 'inventory' ? 'inventory' : 'canvas';
}

export class LiveEditing {
  private readonly d: LiveDeps;
  private readonly now: () => number;
  private readonly sittingStart: number;
  private state: LiveState;
  private mode: LiveMode = 'connecting';
  private connected = false;
  private down = false;
  private sendFailed = false;
  private note: string | null = null;
  private overwrites: Overwrite[] = [];
  private merged: string | null = null;
  private mergedTimer: ReturnType<typeof setTimeout> | undefined;
  private self: Person | null = null;
  private people: Person[] = [];
  private heard: { people: Person[]; ownerView: string | undefined } = { people: [], ownerView: undefined };
  private directory = new Map<string, Person>();
  private readonly sent = new Set<string>();
  private sending = false;
  private retries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private reloading = false;
  private disposed = false;
  private readonly feed: FeedLike;

  private view = '';
  private selected: string | null = null;
  private viewSent: string | null = null;
  private viewAt = 0;
  private viewTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(deps: LiveDeps, doc: Document, version: number) {
    this.d = deps;
    this.now = deps.now ?? Date.now;
    this.sittingStart = this.now();
    this.state = openLive(doc, version);
    this.feed = deps.makeFeed(
      () => this.state.version,
      {
        frame: (f) => this.onFrame(f),
        status: (s) => this.onStatus(s),
      },
      () => this.view,
    );
  }

  start(): void {
    this.feed.start();
    this.emit();
  }

  dispose(): void {
    this.disposed = true;
    this.feed.stop();
    clearTimeout(this.retryTimer);
    clearTimeout(this.viewTimer);
    clearTimeout(this.mergedTimer);
  }

  get doc(): Document {
    return this.state.visible;
  }

  get pendingCount(): number {
    return this.state.pending.length;
  }

  get currentMode(): LiveMode {
    return this.mode;
  }

  private emit(): void {
    if (this.disposed) return;
    this.d.onView({
      doc: this.state.visible,
      mode: this.mode,
      connected: this.connected,
      reconnecting: this.down || (this.sendFailed && this.state.pending.length > 0),
      pendingCount: this.state.pending.length,
      note: this.note,
      overwrite: this.overwriteView(),
      merged: this.merged,
      self: this.self,
      people: this.people,
    });
  }

  private nameOf = (account: string): string => this.directory.get(account)?.name ?? 'Someone';

  private overwriteView(): LiveView['overwrite'] {
    if (this.overwrites.length === 0) return null;
    return {
      lines: overwriteLines(this.overwrites, this.nameOf),
      items: this.overwrites.map((o) => ({ id: `${o.element}\n${o.key}`, yours: yoursLine(o, this.nameOf) })),
      keep: keepLabel(this.overwrites, this.nameOf),
      anchor: panelLabel(this.overwrites[0].key),
    };
  }

  // ---- what the person does -------------------------------------------

  /** A command produced `next`; show it and send it. */
  edit(next: Document): void {
    if (this.disposed) return;
    if (this.mode === 'legacy') {
      this.state = { ...this.state, visible: next, confirmed: next };
      if (this.d.canDraw) this.d.save(next);
      this.emit();
      return;
    }
    if (!this.d.canDraw) return;
    try {
      this.state = localEdit(this.state, next).state;
    } catch (e) {
      if (!(e instanceof ChangeError)) throw e;
      this.note = 'That edit no longer fits what others just changed, so nothing was changed.';
      this.emit();
      return;
    }
    this.emit();
    void this.pump();
  }

  /** Put mine back: a new ordinary change restoring the earlier value of one field. */
  putBack(id: string): void {
    const o = this.overwrites.find((x) => `${x.element}\n${x.key}` === id);
    if (!o) return;
    this.overwrites = this.overwrites.filter((x) => x !== o);
    if (!this.d.me) return this.emit();
    const next = putMineBack(this.state.visible, o, { actor: this.d.me, now: this.now() });
    if (next === undefined) {
      this.note = 'That part is gone now, so there was nothing to put back.';
      return this.emit();
    }
    this.edit(next);
  }

  /** Keep theirs: all the overwrites stand. */
  dismissOverwrite(): void {
    this.overwrites = [];
    this.emit();
  }

  dismissNote(): void {
    this.note = null;
    this.emit();
  }

  /** Tells the person something in one sentence, in the same place as the rest. */
  tell(sentence: string): void {
    this.note = sentence;
    this.emit();
  }

  reload(): void {
    if (this.mode === 'legacy') return;
    void this.reopen();
  }

  // ---- presence -------------------------------------------------------

  /** The view this person is in ("canvas" or "inventory") and what they have selected. At most twice a second. */
  setPresence(view: string, selected: string | null): void {
    this.view = view;
    this.selected = selected;
    const people = presenceInView(this.heard.people, this.heard.ownerView, view);
    if (people !== this.people && (people.length > 0 || this.people.length > 0)) {
      this.people = people;
      this.emit();
    }
    this.schedulePresence();
  }

  private presenceKey(): string {
    return `${this.view}\n${this.selected ?? ''}`;
  }

  private schedulePresence(): void {
    if (this.mode !== 'live' || !this.connected || this.disposed) return;
    if (this.view === '' || this.presenceKey() === this.viewSent) return;
    clearTimeout(this.viewTimer);
    const wait = Math.max(0, this.viewAt + PRESENCE_GAP_MS - this.now());
    this.viewTimer = setTimeout(() => {
      const key = this.presenceKey();
      if (key === this.viewSent || !this.connected) return;
      const body = { view: this.view, selected: this.selected };
      this.viewSent = key;
      this.viewAt = this.now();
      this.d.postView(body).catch((e: unknown) => {
        if (this.lostAccess(e)) return;
        if (this.viewSent === key) this.viewSent = null;
      });
    }, wait);
  }

  // ---- the stream -----------------------------------------------------

  private onStatus(status: FeedStatus): void {
    if (this.disposed) return;
    if (status === 'up') {
      this.connected = true;
      this.down = false;
      this.mode = this.mode === 'legacy' ? 'legacy' : 'live';
      this.viewSent = null;
      this.schedulePresence();
      void this.pump();
    } else if (status === 'down') {
      this.connected = false;
      this.down = true;
      this.people = [];
      this.heard = { people: [], ownerView: undefined };
    } else if (status === 'unavailable') {
      this.connected = false;
      this.down = false;
      if (this.mode === 'connecting') {
        this.mode = 'legacy';
        const waiting = this.state.pending.length > 0;
        this.state = { ...this.state, confirmed: this.state.visible, pending: [] };
        if (waiting && this.d.canDraw) this.d.save(this.state.visible);
      }
    }
    this.emit();
  }

  private onFrame(frame: LiveFrame): void {
    if (this.disposed || this.mode === 'legacy') return;
    if (frame.type === FRAME_PRESENCE) {
      const heard = parsePresence(frame.bytes);
      this.heard = { people: heard.others, ownerView: frame.view };
      if (heard.self) {
        this.self = heard.self;
        this.directory.set(heard.self.account, heard.self);
      }
      for (const p of heard.others) this.directory.set(p.account, p);
      this.people = presenceInView(this.heard.people, this.heard.ownerView, this.view);
      this.emit();
    } else if (frame.type === FRAME_AUTHOR) {
      const person = parseAuthor(frame.bytes);
      if (person) this.directory.set(person.account, person);
    } else if (frame.type === FRAME_CHANGE) {
      this.onChange(frame);
    } else if (frame.type === FRAME_RELOAD) {
      void this.reopen();
    } else if (frame.type === FRAME_RESYNC) {
      // Reopening the same `since` would be told to resync again: take the design as it is now.
      void this.reopen().then((ok) => {
        if (ok) this.feed.restart();
      });
    }
  }

  private onChange(frame: LiveFrame): void {
    if (this.reloading) return; // the next frame finds the gap and starts again
    try {
      const change = readChange(frame.bytes);
      const r = applyRemote(this.state, change, frame.version, {
        me: this.d.me ?? '',
        sittingStart: this.sittingStart,
        now: this.now(),
      });
      if (r.gap) {
        if (!this.feed.restart()) void this.reopen();
        return;
      }
      this.state = r.state;
      if (r.dropped.length > 0) {
        for (const c of r.dropped) this.sent.delete(c.batch.id);
        this.note = droppedSentence(r.dropped);
      }
      for (const o of r.overwrites) {
        this.overwrites = [...this.overwrites.filter((x) => x.element !== o.element || x.key !== o.key), o];
      }
      if (r.merged) {
        this.merged = mergedSentence(r.merged.keys, this.nameOf(r.merged.by));
        clearTimeout(this.mergedTimer);
        this.mergedTimer = setTimeout(() => {
          this.merged = null;
          this.emit();
        }, MERGED_MS);
      }
      this.emit();
      if (r.echoed) void this.pump();
    } catch (e) {
      if (!(e instanceof ChangeError)) throw e;
      void this.reopen();
    }
  }

  /** This tab's own requests were refused for want of access: stop listening. */
  private lostAccess(e: unknown): boolean {
    if (!(e instanceof ApiRefusal) || (e.status !== 401 && e.status !== 403)) return false;
    this.feed.stop();
    this.connected = false;
    this.down = false;
    this.people = [];
    this.note = 'You no longer have access to this design here, so live updates have stopped.';
    this.emit();
    return true;
  }

  private async reopen(): Promise<boolean> {
    if (this.reloading) return false;
    this.reloading = true;
    try {
      const { doc, version } = await this.d.reopen();
      if (this.disposed) return false;
      const r = applyReload(this.state, doc, version);
      this.state = r.state;
      this.sent.clear();
      if (r.dropped.length > 0) this.note = droppedSentence(r.dropped);
      this.emit();
      void this.pump();
      return true;
    } catch (e) {
      if (this.lostAccess(e)) return false;
      this.note = 'Could not reopen the design just now. Your changes are kept.';
      this.emit();
      return false;
    } finally {
      this.reloading = false;
    }
  }

  // ---- sending --------------------------------------------------------

  private async pump(): Promise<void> {
    if (this.sending || !this.d.canDraw || !this.connected || this.mode !== 'live' || this.disposed) return;
    this.sending = true;
    try {
      for (;;) {
        const next = this.state.pending.find((p) => !this.sent.has(p.batch.id));
        if (!next || !this.connected || this.disposed) break;
        try {
          await this.d.post(next, this.state.version);
          this.sent.add(next.batch.id);
          this.retries = 0;
          if (this.sendFailed) {
            this.sendFailed = false;
            this.emit();
          }
        } catch (e) {
          if (isRefusal(e) && !(e instanceof ApiRefusal && e.status === 403)) {
            const r = applyRefusal(this.state, next.batch.id);
            this.state = r.state;
            this.note = e instanceof ApiRefusal ? e.message : 'The server refused that change.';
            for (const c of r.dropped.slice(1)) this.sent.delete(c.batch.id);
            this.emit();
            continue;
          }
          if (this.lostAccess(e)) break;
          this.sendFailed = true;
          this.emit();
          this.retryLater();
          break;
        }
      }
    } finally {
      this.sending = false;
    }
  }

  private retryLater(): void {
    clearTimeout(this.retryTimer);
    const wait = RETRY_MS[Math.min(this.retries, RETRY_MS.length - 1)];
    this.retries += 1;
    this.retryTimer = setTimeout(() => void this.pump(), wait);
  }
}
