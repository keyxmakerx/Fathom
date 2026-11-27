// A menu, a card or a dialog that closes leaves a still copy of itself for about 120ms
// (`client/src/components/shell/ghost.ts`). The page keeps a note of every copy as it is made, so a drive never
// has to catch one while it lasts.

/** Starts the note on this page. Call it again after a reload. */
export async function watchCopies(page) {
  await page.evaluate(() => {
    window.__copies = [];
    if (window.__copiesWatched) return;
    window.__copiesWatched = true;
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement) || !node.hasAttribute('data-ghost')) continue;
          const texts = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
          let words = 0;
          for (let t = texts.nextNode(); t != null; t = texts.nextNode()) if (t.data.trim() !== '') words += 1;
          const box = node.querySelector('.float-sheet, .imp__box');
          const at = node.getBoundingClientRect();
          window.__copies.push({
            kind: node.classList.item(0),
            inert: node.inert,
            hidden: node.getAttribute('aria-hidden'),
            // Words left as text in the page, where a search or a screen reader could find them.
            words,
            named: node.querySelectorAll('[role], [aria-label], [data-testid], [tabindex], :not(svg *)[id]').length,
            typed: node.querySelector('input:not([type=checkbox]):not([type=radio]), textarea')?.value ?? null,
            parts: node.getElementsByTagName('*').length,
            leaves: getComputedStyle(node).animationName,
            boxLeaves: box ? getComputedStyle(box).animationName : null,
            left: Math.round(at.left),
            top: Math.round(at.top),
            // A part its owner holds and does not show: the Print panel's measuring pass.
            unseen: node.querySelector('[data-ghost-skip], .print-counter') != null,
          });
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
}

/** The copies made since the last call, oldest first, and the note emptied. */
export async function copiesMade(page) {
  return page.evaluate(() => (window.__copies ?? []).splice(0));
}
