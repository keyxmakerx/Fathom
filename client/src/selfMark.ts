/**
 * The two letters others see for you on the canvas come from the server, which reads your display name. Home has
 * no live session, so it once drew letters from the address and showed a different mark for the same person.
 * The canvas remembers what the server said, per address and for this browser tab, and Home uses it.
 */
const known = new Map<string, string>();
const KEY = 'fathom.selfMark';

function store(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function rememberSelfMark(address: string, initials: string): void {
  if (address === '' || initials === '') return;
  known.set(address, initials);
  try {
    store()?.setItem(KEY, JSON.stringify(Object.fromEntries(known)));
  } catch {
    /* a tab with no storage still shows the right mark while it lives */
  }
}

export function selfMark(address: string): string | null {
  if (known.size === 0) {
    try {
      const raw = store()?.getItem(KEY);
      const parsed: unknown = raw == null ? null : JSON.parse(raw);
      if (parsed != null && typeof parsed === 'object') {
        for (const [a, m] of Object.entries(parsed as Record<string, unknown>)) if (typeof m === 'string' && m !== '') known.set(a, m);
      }
    } catch {
      /* unreadable: fall back to the address */
    }
  }
  return known.get(address) ?? null;
}

/** Test seam: forget everything remembered. */
export function forgetSelfMarks(): void {
  known.clear();
  try {
    store()?.removeItem(KEY);
  } catch {
    /* nothing to forget */
  }
}
