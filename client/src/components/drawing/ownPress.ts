// A thing that answers its own press stops the click there, so that the canvas under it does not answer too.
// The quick card listens for clicks on the document and never hears a stopped one. A thing that should still
// get its card stops its click with `ownPress`, which passes the click on to the card by name.

/** Sent on the window, with the click itself as its detail. */
export const OWN_PRESS_EVENT = 'fathom:own-press';

/** Stops a click at the thing it landed on, and tells the quick card about it. */
export function ownPress(event: { stopPropagation(): void; nativeEvent: MouseEvent }): void {
  event.stopPropagation();
  window.dispatchEvent(new CustomEvent<MouseEvent>(OWN_PRESS_EVENT, { detail: event.nativeEvent }));
}
