// When a menu, a pop-over, a card or a dialog is taken off the page, a still copy of it stays for a moment and fades
// out, so it leaves the way it came instead of vanishing. The real thing is gone the instant it closes, exactly as
// before. The copy is a picture in all but name: it takes no pointer and no key, assistive technology does not see
// it, and its words are drawn by CSS, so none of them is in the page for a search, a screen reader or a test to find.
// Some things leave no copy and close at once: see `GHOST_NEVER` and `GHOST_MOST`.

import { useCallback } from 'react';

/** How long the copy takes to go. Matches `--m-hover`: a thing leaves a little faster than it arrives. */
export const GHOST_MS = 120;

/** Attributes the copy must not keep: whatever names it, finds it, focuses it or explains it. */
export const GHOST_STRIPPED: readonly string[] = [
  'id',
  'role',
  'tabindex',
  'autofocus',
  'title',
  'alt',
  'name',
  'for',
  'href',
  'accesskey',
  'contenteditable',
  'data-testid',
  'data-hint',
  'data-hint-more',
  'data-hint-keys',
  'data-hint-side',
];

/** The `aria-` attributes the copy keeps, because a stylesheet draws from them: a pressed button, a ticked row.
 * They say a state and never a name, and nothing reads them: the copy is hidden from assistive technology whole. */
export const GHOST_KEPT_STATE: readonly string[] = ['aria-checked', 'aria-current', 'aria-disabled', 'aria-expanded', 'aria-pressed', 'aria-selected'];

/** What a thing must not hold if a copy of it is to stay behind. A thing that holds one closes at once. A box that
 * gates its own paste holds what was pasted before the gate has read it, and a password field holds a secret: a copy
 * would keep either on the page a moment after its owner closed. A copy of a camera picture or a canvas is empty. */
export const GHOST_NEVER = '[data-gate="self"], input[type="password"], video, canvas';

/** The most parts a thing may have and still leave a copy. A larger one costs more to copy and lay out than a
 * tenth of a second of fading is worth, so it closes at once. */
export const GHOST_MOST = 800;

/** Marks a part the copy leaves out: something the thing holds and does not show, a measuring pass for one. */
export const GHOST_SKIP = 'data-ghost-skip';

/** Inside a picture an id or a link is part of the drawing (a clip, a marker, a reused shape), so it stays. */
const DRAWN_IN_A_PICTURE: readonly string[] = ['id', 'href'];

/** Whether the copy drops an attribute: the listed ones, and every `aria-` one that does not draw. */
export function ghostDrops(attribute: string, inPicture = false): boolean {
  const name = attribute.toLowerCase();
  if (name.startsWith('aria-')) return !GHOST_KEPT_STATE.includes(name);
  if (inPicture && DRAWN_IN_A_PICTURE.includes(name)) return false;
  return GHOST_STRIPPED.includes(name);
}

/** How long a copy's own leaving animation runs, in ms, read from its computed `animation-duration` ("0.12s",
 * "160ms", or a list of them): a kind may leave slower than `GHOST_MS`, and its copy must last that long. */
export function ghostLife(duration: string): number {
  const times = duration.split(',').map((part) => {
    const text = part.trim();
    const n = Number.parseFloat(text);
    if (!Number.isFinite(n) || n < 0) return 0;
    return text.endsWith('ms') ? n : n * 1000;
  });
  return Math.max(GHOST_MS, ...times);
}

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** A copy of `el` and all inside it, less the parts marked to be left out. `reals` and `copies` are given each
 * part and its copy, in step. Null as soon as the thing proves too large to copy. */
function copyOf(el: Element, reals: Element[], copies: Element[]): Element | null {
  if (reals.length >= GHOST_MOST) return null;
  const copy = el.cloneNode(false) as Element;
  reals.push(el);
  copies.push(copy);
  for (let child = el.firstChild; child != null; child = child.nextSibling) {
    if (child.nodeType === Node.TEXT_NODE) {
      copy.appendChild(child.cloneNode(false));
    } else if (child instanceof Element && !child.hasAttribute(GHOST_SKIP)) {
      const part = copyOf(child, reals, copies);
      if (part == null) return null;
      copy.appendChild(part);
    }
  }
  return copy;
}

/** What a clone does not carry over: what was typed or ticked since the thing was drawn. */
function carryFields(from: readonly Element[], to: readonly Element[]): void {
  from.forEach((real, i) => {
    const copy = to[i];
    if (real instanceof HTMLInputElement && copy instanceof HTMLInputElement) {
      copy.checked = real.checked;
      copy.indeterminate = real.indeterminate;
      if (real.type !== 'file') copy.value = real.value;
    } else if (real instanceof HTMLTextAreaElement && copy instanceof HTMLTextAreaElement) {
      copy.value = real.value;
    } else if (real instanceof HTMLSelectElement && copy instanceof HTMLSelectElement) {
      copy.selectedIndex = real.selectedIndex;
    }
  });
}

/** Makes a copy inert and nameless, and turns its words into drawn text. `parts` is the copy and all inside it. */
function quiet(root: HTMLElement, parts: readonly Element[]): void {
  for (const el of parts) {
    const inPicture = el.closest('svg') != null;
    for (const name of el.getAttributeNames()) {
      if (ghostDrops(name, inPicture)) el.removeAttribute(name);
    }
  }
  root.setAttribute('data-ghost', '');
  root.setAttribute('aria-hidden', 'true');
  root.setAttribute('inert', '');
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node != null; node = walker.nextNode()) texts.push(node as Text);
  for (const text of texts) {
    // A field or a picture draws its own words; white space alone names nothing.
    if (text.data.trim() === '' || text.parentElement?.closest('select, textarea, script, style, svg') != null) continue;
    const drawn = document.createElement('span');
    drawn.setAttribute('data-ghost-text', text.data);
    text.replaceWith(drawn);
  }
}

/** Whether `el` is a copy, or part of one. */
function isGhost(el: Element): boolean {
  return el.closest('[data-ghost]') != null;
}

/** Everything on the page whose class is `kind`: the real things and the copies. */
function ofKind(kind: string): Element[] {
  return Array.from(document.getElementsByClassName(kind));
}

/** Takes away every copy of `kind` still on the page. */
function clearGhosts(kind: string): void {
  for (const el of ofKind(kind)) {
    if (el.hasAttribute('data-ghost')) el.remove();
  }
}

/** Leaves a fading copy of `el` where it hung. Called as `el` is being taken off the page. */
function leaveGhost(el: HTMLElement, parentAtMount: Element | null): void {
  if (typeof document === 'undefined' || reducedMotion()) return;
  const parent = el.parentElement ?? parentAtMount;
  const kind = el.classList.item(0);
  if (parent == null || kind == null) return;
  if (el.querySelector(GHOST_NEVER) != null) return;
  const next = el.nextSibling;
  const reals: Element[] = [];
  const copies: Element[] = [];
  const ghost = copyOf(el, reals, copies) as HTMLElement | null;
  if (ghost == null) return;
  carryFields(reals, copies);
  // How far each part had scrolled, to put back once the copy is on the page: off it, nothing scrolls.
  const scrolled: Array<[Element, number, number]> = [];
  reals.forEach((real, i) => {
    const copy = copies[i];
    if (copy != null && (real.scrollTop !== 0 || real.scrollLeft !== 0)) scrolled.push([copy, real.scrollTop, real.scrollLeft]);
  });
  quiet(ghost, copies);
  // Once the page has finished changing: only where the thing really went, where it hung is still there, and
  // nothing of its kind is on the page, so a copy is never there beside a real one.
  queueMicrotask(() => {
    if (el.isConnected || !parent.isConnected) return;
    clearGhosts(kind);
    if (ofKind(kind).some((other) => !isGhost(other))) return;
    parent.insertBefore(ghost, next != null && next.parentNode === parent ? next : null);
    for (const [copy, top, left] of scrolled) {
      copy.scrollTop = top;
      copy.scrollLeft = left;
    }
    const done = () => ghost.remove();
    ghost.addEventListener('animationend', (event) => {
      if (event.target === ghost) done();
    });
    // Should the animation never say it ended (a hidden tab), the copy still goes, a moment after it would have.
    window.setTimeout(done, ghostLife(getComputedStyle(ghost).animationDuration) + 100);
  });
}

/** A ref for something that floats over the page. Taken off the page, it leaves its copy; arriving, it clears any
 * copy of the last one of its kind (its first class), so there is never a copy on the page with the real thing.
 * `own` is given the element too. */
export function useGhostRef<T extends HTMLElement>(own?: { current: T | null }): (el: T | null) => (() => void) | undefined {
  return useCallback(
    (el: T | null) => {
      if (own != null) own.current = el;
      if (el == null) return undefined;
      const parent = el.parentElement;
      const kind = el.classList.item(0);
      if (kind != null) clearGhosts(kind);
      return () => {
        if (own != null) own.current = null;
        leaveGhost(el, parent);
      };
    },
    [own],
  );
}
