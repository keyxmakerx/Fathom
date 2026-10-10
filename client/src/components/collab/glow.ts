// The amber double outline that marks changed things for a moment. React Flow owns the boxes' class
// names and mounts them lazily, so the class is added from outside and re-added as boxes appear, the way
// History outlines a past save (DesignPlace). The fade is CSS (`collab.css`); this only holds the window.

import { outlineSelectors } from '../../document/historyDiff';

/** How long a glow lasts, matching `--m-glow` in `collab.css`. */
export const GLOW_MS = 1500;

/** The most things outlined at once; a large import changes thousands and none of them can be told apart. */
const MAX_GLOWING = 300;

/** Outlines the canvas elements for `ids` for `ms`, then removes the mark. Returns a stop function. */
export function glowThings(ids: readonly string[], ms = GLOW_MS, root: ParentNode = document, clock: () => number = () => performance.now()): () => void {
  if (ids.length === 0) return () => {};
  const selector = outlineSelectors(ids.slice(0, MAX_GLOWING)).join(',');
  const started = clock();
  const marked = new Set<Element>();
  const apply = () => {
    const elapsed = Math.min(ms, clock() - started);
    root.querySelectorAll(selector).forEach((el) => {
      if (marked.has(el)) return;
      marked.add(el);
      el.classList.add('collab-glow');
      // A box that mounts late joins the fade where it should be, not at the start.
      (el as HTMLElement).style.setProperty('animation-delay', `-${Math.round(elapsed)}ms`);
    });
  };
  apply();
  const observer = new MutationObserver(() => {
    // React Flow rewrites class names on selection; put the mark back on what lost it.
    marked.forEach((el) => {
      if (!el.classList.contains('collab-glow')) el.classList.add('collab-glow');
    });
    apply();
  });
  const watch = root instanceof Document ? root.body : (root as Element);
  observer.observe(watch, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  const timer = setTimeout(stop, ms);
  function stop() {
    clearTimeout(timer);
    observer.disconnect();
    marked.forEach((el) => {
      el.classList.remove('collab-glow');
      (el as HTMLElement).style.removeProperty('animation-delay');
    });
    marked.clear();
  }
  return stop;
}
