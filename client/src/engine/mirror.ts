// ADR-0052 §4's "the module mirrors the document" — two doors load the
// plain face into `fathom-wasm` and export it back, so the weld the module
// holds is never reimplemented in JavaScript (CLAUDE.md rule 4) and every
// save carries exactly what the gate let through. This class is the one
// place those two doors and the third ("paste under a placed device") are
// used together: load a document in, paste under a device, read the
// document back out. Nothing here decides what a paste means — `engine.ts`
// speaks the wire, `fathom-wasm` runs the gate, `document/plain.ts` reads
// and writes the one graph format both sides agree on; this class only
// sequences the three calls the ADR names.

// `InsideFaces` and `Engine.inside` are `OP_INSIDE` decoded — the inside
// stop's own contract, added to `engine.ts` by the builder who owns
// `InsideStop.tsx`. This file only forwards to it, the same as `load`/
// `pasteInto` above forward to `engine.ts`'s other doors; it does not
// decode `OP_INSIDE` itself.
import { Engine, EngineError, ERRORS, type InsideFaces, type PasteResult } from './engine';
import { errorName } from './protocol.constants';
import { readPlain, writePlain } from '../document/plain';
import type { Document } from '../document/model';

export class Mirror {
  private readonly engine: Engine;

  constructor(engine: Engine) {
    this.engine = engine;
  }

  /** Door one: write the held document to the plain face and hand it to the
   * module (`OP_LOAD_PLAIN`) — nothing round-trips back from this call, the
   * module simply now holds what the page already had. */
  load(doc: Document): void {
    this.engine.loadPlain(writePlain(doc));
  }

  /** Door three, then door two: paste under an already-placed device
   * (`OP_PASTE_INTO` — choosing this faceplate is ADR-0010's human answer
   * to "is this the same box"), then export the module's held estate back
   * out (`OP_EXPORT_PLAIN`) and read it into a fresh `Document`. The
   * returned `doc` is the one thing the caller should go on holding — it
   * carries the new `Capture` node and every field the paste bound, with
   * their provenance already resolved against that capture's id (ADR-0052
   * §3: "no join"), which is what lets `document/capture.ts`'s `captureOf`
   * derive the drawer's gutter straight back off it. `result` is the raw
   * paste reply, for the summary numbers and the refusal text a caller
   * wants immediately, without waiting on a second read of `doc`. */
  pasteInto(deviceId: string, text: string): { doc: Document; result: PasteResult } {
    const result = this.engine.pasteInto(deviceId, text);
    const doc = readPlain(this.engine.exportPlain());
    return { doc, result };
  }

  /** `OP_INSIDE`, decoded by `engine.ts`'s own `inside` (the inside stop's
   * builder) — forwarded here so a caller that already holds a `Mirror`
   * rather than a raw `Engine` has one object for every door this session's
   * drawer and inside stop both open. */
  inside(deviceId: string): InsideFaces {
    return this.engine.inside(deviceId);
  }
}

/** Maps an `OP_PASTE_INTO` refusal to the drawer's own sentence (ADR-0052
 * §5's amendment: "the door refuses a second paste and says so"). Kept here
 * rather than in `ConfigDrawer.tsx`, which only renders whatever sentence
 * it is handed (its own `refusal: string | null` prop) — this is the one
 * place an `EngineError`'s code is read, so a caller that catches
 * `mirror.pasteInto`'s throw has exactly one function to call to get back
 * what the drawer should show.
 *
 * `ERR_WELD_REFUSED` carries `fathom_weld::WeldError`'s own `{e:?}` in its
 * detail (`shell.rs::paste_into`'s own doc) — a debug string, not a
 * sentence, for every variant except the one this drawer actually expects
 * an operator to hit: `AlreadyCaptured` (`fathom-weld/src/apply.rs`), which
 * renders as exactly that bare token with no braces (a unit variant). Any
 * other `WeldError` reaching a person here is `fathom-wasm`'s bug to fix,
 * not this page's guess to word — the fallback below says so and prints
 * what the module actually sent rather than inventing a friendlier lie. */
export function refusalSentence(error: unknown): string {
  if (!(error instanceof EngineError)) {
    return error instanceof Error ? error.message : 'That paste did not complete.';
  }
  switch (error.code) {
    case ERRORS.ERR_NO_DICTIONARY:
    case ERRORS.ERR_NOTHING_UNDERSTOOD:
    case ERRORS.ERR_INGEST_REFUSED:
    case ERRORS.ERR_NO_ELEMENT:
      // These three (plus the display-id lookup) already carry a full,
      // human sentence as their own detail (`shell.rs`'s `ingest_paste_text`
      // and its callers word it there) — repeating it in different words
      // here would be a second place for the same fact to be wrong.
      return error.detail;
    case ERRORS.ERR_WELD_REFUSED:
      if (error.detail === 'AlreadyCaptured') {
        return 'This device already carries a live capture. Fathom will not paste a second one over it — export what is here, or wait for reconciliation, before trying again.';
      }
      return `Fathom refused this paste: ${error.detail}`;
    case ERRORS.ERR_BAD_UTF8:
      return 'This paste is not text Fathom can read — it is not valid UTF-8.';
    case ERRORS.ERR_PASTE_FRAME:
      return 'That paste did not reach the engine in one piece. Try again.';
    case ERRORS.ERR_NOT_INITIALISED:
      return 'No design is loaded yet.';
    default:
      return `Fathom refused this paste (${errorName(error.code) ?? `error ${error.code}`}): ${error.detail}`;
  }
}
