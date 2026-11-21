// A request to show a thing on the canvas, from Search or "Show on rack", is answered once.
//
// The canvas answers when the request arrives, or when the design does if the request came first. The design
// is a new object after every change, so "the design changed" must not read as "asked again": it once did, and
// every change made after a pick in Search brought the selection back to that pick and opened its config.

/** The request still to be answered, or null: there is one, the design is here, and it is not the request
 * answered last. Each request is a new object, so the same thing asked for twice is answered twice. */
export function focusToAnswer<T extends object>(asked: T | null | undefined, designHere: boolean, answered: T | null): T | null {
  return asked != null && designHere && asked !== answered ? asked : null;
}
