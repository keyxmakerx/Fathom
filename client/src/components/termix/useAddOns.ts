// Which Termix add-ons this person's Termix runs (ADR-0080 decision 8): each add-on's button shows
// until Termix says it does not run it, then only one line naming the add-on. Asked once per key per page.

import { useEffect, useState } from 'react';

import { KEY_EVENT, listAddOns, readKey } from './termix';

const asked = new Map<string, Promise<Set<string>>>();

export function addOnsFor(origin: string, key: string): Promise<Set<string>> {
  const at = `${origin}\u0000${key}`;
  let p = asked.get(at);
  if (!p) {
    p = listAddOns(origin, key).catch((e: unknown) => {
      asked.delete(at);
      throw e;
    });
    asked.set(at, p);
  }
  return p;
}

/** The pasted key, following every paste and Forget key on the page. */
export function useTermixKey(): string | null {
  const [key, setKey] = useState<string | null>(() => readKey());
  useEffect(() => {
    const follow = () => setKey(readKey());
    window.addEventListener(KEY_EVENT, follow);
    return () => window.removeEventListener(KEY_EVENT, follow);
  }, []);
  return key;
}

/** null until known: no key yet, or Termix not asked yet. */
export function useAddOns(origin: string | null): Set<string> | null {
  const key = useTermixKey();
  const [known, setKnown] = useState<{ at: string; addOns: Set<string> } | null>(null);
  const at = origin && key ? `${origin}\u0000${key}` : null;
  useEffect(() => {
    if (!origin || !key) return;
    let live = true;
    addOnsFor(origin, key).then(
      (addOns) => live && setKnown({ at: `${origin}\u0000${key}`, addOns }),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [origin, key]);
  return known && known.at === at ? known.addOns : null;
}
