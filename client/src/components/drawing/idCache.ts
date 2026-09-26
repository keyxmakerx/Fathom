/**
 * Two small memoisation caches `Drawing.tsx` keys by id — GitHub issue #66,
 * build item 2: "keep a node object's reference unless that device, rack or
 * port changed... keyed by id, with primitive dependencies... not by
 * comparing whole objects." Neither of these ever walks the whole design:
 * `IdCache` compares one id's own dependency list, element by element, the
 * same shape `useMemo`'s own dependency array already is (`Object.is`, not a
 * deep equal) — `useMemo` itself cannot sit inside the loop that builds one
 * node per rack/chassis/shelf, so this is that same idea keyed by a `Map`
 * instead of a hook slot. `RefSignatureCache` is the one place this drawing
 * *does* look past a reference: `document/view.ts`'s `viewOf` rebuilds the
 * whole `ClosetView` fresh on every edit, so an unrelated chassis gets a new
 * object reference even though nothing about it changed — this fingerprints
 * ONE object's own bounded slice of fields (never the design around it) and
 * only re-stringifies when the reference it was given actually changed, so a
 * hover or a zoom tick (where `view` itself is the same object) costs one
 * reference compare per id, never a stringify.
 */

/** `id -> {deps, value}`. `get` rebuilds only when this id's own deps differ
 * from last time, compared pairwise with `Object.is` — never a deep equal,
 * never a look past this one id's own dependency list. `sweep` drops any id
 * `get` was not asked for since the last sweep (a rack or chassis this
 * document no longer has). */
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

/** `id -> {ref, signature}`. `of` returns the SAME signature string without
 * re-stringifying whenever `value` is reference-equal to what this id was
 * given last time (the common case: `view` itself unchanged, so every
 * chassis/rack/shelf/surface object under it is still the same reference) —
 * only a genuinely new reference for this id (a real edit rebuilt the whole
 * view) pays for a fresh `JSON.stringify`, and that cost is bounded to this
 * one id's own slice, never the design around it. */
export class RefSignatureCache {
  private readonly entries = new Map<string, { ref: unknown; signature: string }>();

  /** `serialize` defaults to `JSON.stringify`; a caller signing a `Map`
   * (`Drawing.tsx`'s own `portSheath`, keyed by every chassis/shelf/surface
   * that reads it, not just one id) supplies its own — `JSON.stringify` on
   * a `Map` gives `"{}"`, every entry silently dropped, which would read
   * every sheath as unchanged forever. */
  of(id: string, value: unknown, serialize: (value: unknown) => string = JSON.stringify): string {
    const cached = this.entries.get(id);
    if (cached && cached.ref === value) return cached.signature;
    const signature = serialize(value);
    this.entries.set(id, { ref: value, signature });
    return signature;
  }

  sweep(liveIds: ReadonlySet<string>): void {
    for (const id of this.entries.keys()) {
      if (!liveIds.has(id)) this.entries.delete(id);
    }
  }
}

/** A callback that only ever closes over an id and stable setters (a
 * `useState` setter never changes reference) never needs rebuilding once
 * built — `id -> the one callback ever made for it`. Used for `onFlip`
 * handlers, which close over nothing but a rack or row key and a `useState`
 * setter, so the very first one built for a given id is correct forever. */
export function stableCallback<F>(cache: Map<string, F>, id: string, build: () => F): F {
  const cached = cache.get(id);
  if (cached) return cached;
  const value = build();
  cache.set(id, value);
  return value;
}
