// Pages with an address of their own (sign-off r71, "its own URL": "firmware settings get their own
// pages in Fathom, with addresses you can bookmark"). `#admin/<section>` opens Admin on that
// section and `#steward/<page>` the Steward tab on that page. Only these two shapes are read or
// written here; every other `#…` (a design, an Inventory list) belongs to its own screen.

export type PageLink = { tab: 'admin'; page: string } | { tab: 'steward'; page: string };

const SHAPE = /^#(admin|steward)\/([a-z][a-z-]{0,30})$/;

export function readPageLink(hash: string): PageLink | null {
  const m = SHAPE.exec(hash.trim());
  if (!m) return null;
  return { tab: m[1] as 'admin' | 'steward', page: m[2]! };
}

export const pageLinkHash = (link: PageLink): string => `#${link.tab}/${link.page}`;

/** The page now open, put in the address bar without a history entry. */
export function showPageLink(link: PageLink): void {
  if (typeof window === 'undefined') return;
  const hash = pageLinkHash(link);
  if (window.location.hash !== hash) window.history.replaceState(window.history.state, '', hash);
}

/** The page's link at load, when there is one. */
export function initialPageLink(): PageLink | null {
  return typeof window === 'undefined' ? null : readPageLink(window.location.hash ?? '');
}
