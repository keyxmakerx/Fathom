// The save queue: "every change saves" (the server is where the data
// lives), one save in flight at a time, and the next change queued behind
// it — never two concurrent saves of the same design, never a lost change.
//
// Pushing while a save is running replaces whatever was queued with the
// newest value: only the latest matters, since a save that lands is the
// whole document as of that push, not a diff. A refusal is reported to the
// caller and does not stop the queue — whatever is queued (the change the
// person made since) still goes out next.

export class SaveQueue<T> {
  private readonly save: (value: T) => Promise<void>;
  private readonly onRefusal: (error: unknown, value: T) => void;
  private inFlight = false;
  private queued: T | null = null;

  constructor(save: (value: T) => Promise<void>, onRefusal: (error: unknown, value: T) => void) {
    this.save = save;
    this.onRefusal = onRefusal;
  }

  /** True while a save is in progress — exposed for tests only. */
  get isSaving(): boolean {
    return this.inFlight;
  }

  /** True while a change is waiting behind the in-flight save — exposed for
   * tests only. */
  get hasQueued(): boolean {
    return this.queued !== null;
  }

  push(value: T): void {
    if (this.inFlight) {
      this.queued = value;
      return;
    }
    this.run(value);
  }

  private run(value: T): void {
    this.inFlight = true;
    this.save(value)
      .catch((error: unknown) => this.onRefusal(error, value))
      .finally(() => {
        this.inFlight = false;
        const next = this.queued;
        this.queued = null;
        if (next !== null) this.run(next);
      });
  }
}
