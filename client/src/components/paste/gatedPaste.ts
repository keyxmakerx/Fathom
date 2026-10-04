// Pasted text into a text box goes through the redaction gate (CLAUDE.md rule 4); typed text stays
// as typed. The gate is the wasm engine, passed in as `redact`; it is not reimplemented here. The
// splice and the gating are pure so they test without a browser; PasteGateBoundary is the glue.

export type Redact = (text: string) => Promise<string>;

/** A one-line box takes no line breaks or tabs: they become single spaces, so the gate reads one statement. */
export function oneLine(text: string): string {
  return text.replace(/[\r\n\t]+/g, ' ');
}

/** Gates pasted text as one statement. A gate that fails throws, and nothing is inserted. */
export async function gatePasted(redact: Redact, text: string, multiline = false): Promise<string> {
  const flat = multiline ? text : oneLine(text);
  return flat.trim() === '' ? flat : redact(flat);
}

/** `clean` put over the selection `[start, end)` of `value`; the caret lands after it. */
export function spliceAt(value: string, start: number, end: number, clean: string): { value: string; caret: number } {
  const a = Math.max(0, Math.min(start, value.length));
  const b = Math.max(a, Math.min(end, value.length));
  return { value: value.slice(0, a) + clean + value.slice(b), caret: a + clean.length };
}

/** What a box would hold after `text` is pasted over its selection, gated. Throws if the gate fails. */
export async function gatedInsert(
  redact: Redact,
  box: { value: string; selectionStart: number | null; selectionEnd: number | null },
  text: string,
  multiline = false,
): Promise<{ value: string; caret: number }> {
  const start = box.selectionStart ?? box.value.length;
  const end = box.selectionEnd ?? start;
  const clean = await gatePasted(redact, text, multiline);
  return spliceAt(box.value, start, end, clean);
}
