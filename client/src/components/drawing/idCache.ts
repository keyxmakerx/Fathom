/** Per-id caches the drawing builds its nodes through: one keyed by a
 * dependency list, one that hands back the old reference for an equal value. */

/** Rebuilds an id's value only when its deps differ by `Object.is`; `sweep`
 * drops ids not asked for since the last sweep. */
export class IdCache<T> {
  private readonly entries = new Map<string, { deps: readonly unknown[]; value: T }>();
  private readonly touched = new Set<string>();

  get(id: string, deps: readonly unknown[], build: () => T): T {
    this.touched.add(id);
    const cached = this.entries.get(id);
    if (cached && sameDeps(cached.deps, deps)) return cached.value;
    const value = build();
    this.entries.set(id, { deps, value });
    return value;
  }

  sweep(): void {
    for (const id of this.entries.keys()) {
      if (!this.touched.has(id)) this.entries.delete(id);
    }
    this.touched.clear();
  }
}

function sameDeps(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!Object.is(a[i], b[i])) return false;
  }
  return true;
}

/** Hands back the previous value for an id when `isEqual` says the fresh one
 * matches it, so a cache depending on it sees no change. */
export class StableRef<T> {
  private readonly entries = new Map<string, T>();
  private readonly touched = new Set<string>();

  get(id: string, value: T, isEqual: (a: T, b: T) => boolean): T {
    this.touched.add(id);
    const prev = this.entries.get(id);
    if (prev !== undefined && (prev === value || isEqual(prev, value))) return prev;
    this.entries.set(id, value);
    return value;
  }

  sweep(): void {
    for (const id of this.entries.keys()) {
      if (!this.touched.has(id)) this.entries.delete(id);
    }
    this.touched.clear();
  }
}
