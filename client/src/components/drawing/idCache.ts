/** Two per-id caches Drawing.tsx builds its React Flow nodes through: one
 * keyed by a primitive dependency list, one that hands back a stable
 * reference when a freshly-rebuilt value is equal to what this id had last
 * time. Neither ever stringifies a whole object; `nodeEquality.ts` compares
 * fields directly. */

/** `id -> {deps, value}`. `get` rebuilds only when this id's own deps differ
 * from last time, compared pairwise with `Object.is`. `sweep` drops any id
 * `get` was not asked for since the last sweep. */
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

/** `id -> the last value handed back for it`. A fresh `value` (any edit
 * rebuilds the whole view, so every id gets a new object reference) is
 * handed back AS the stable answer when `isEqual` says it carries the same
 * fields as last time — so a caller using that answer as another cache's
 * own dependency sees no change at all, with no string ever built. */
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
