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
import { Engine, EngineError, EngineTrap, ERRORS, type CableEnd, type CheckFinding, type ChecksResult, type InsideFaces, type PasteResult, type TraceResult } from './engine';
import { errorName } from './protocol.constants';
import { readPlain, writeDelta, writePlain } from '../document/plain';
import type { Document } from '../document/model';

/** Is `next` the document the module holds (`held`) with batches appended, and nothing earlier
 * changed? Batch objects are compared by identity first (the common case, a document edited by
 * `commands.ts`), then by value, so a copy of the same history still counts and a comment added
 * to an old batch does not. */
function continues(held: Document, next: Document): boolean {
  // A held document with elements and no batches has no last batch for the module to check
  // against, so nothing says the module holds it: load whole.
  if (held.batches.length === 0 && (held.nodes.length > 0 || held.edges.length > 0)) return false;
  const a = held.batches;
  const b = next.batches;
  if (b.length < a.length) return false;
  if (a === b) return true;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (x.id !== y.id || x.label !== y.label || x.comment !== y.comment || x.reverses !== y.reverses) return false;
    if (x.ops !== y.ops && JSON.stringify(x.ops) !== JSON.stringify(y.ops)) return false;
  }
  return true;
}

function liveCount(items: readonly { absentSince?: number }[]): number {
  let n = 0;
  for (const x of items) if (x.absentSince === undefined) n += 1;
  return n;
}

/** What `sync` did: the whole design went in, only new batches did, or nothing needed to. */
export type SyncKind = 'full' | 'delta' | 'none';

export class Mirror {
  private readonly engine: Engine;
  /** The document the module holds, as far as this page knows; `null` when unknown (nothing loaded,
   * a load failed, a paste in flight). The module checks the last batch id itself (`OP_SYNC`'s base)
   * and answers its node and edge counts, so a stale guess costs a reload, never a wrong estate. */
  private held: { doc: Document } | null = null;

  constructor(engine: Engine) {
    this.engine = engine;
  }

  /** The module trapped: discard this mirror and its engine, and boot another. */
  get trapped(): boolean {
    return this.engine.trapped;
  }

  /** Door one: write the held document to the plain face and hand it to the
   * module (`OP_LOAD_PLAIN`) — nothing round-trips back from this call, the
   * module simply now holds what the page already had. */
  load(doc: Document): void {
    this.held = null;
    this.engine.loadPlain(writePlain(doc));
    this.hold(doc);
  }

  /** Bring the module in step with `doc` for checks. The first call, a document that does not
   * continue what the module holds (another design, a restored version), and a module that
   * answers "resync needed" do the full load (`load`); otherwise only the batches the module has
   * not seen are sent (`OP_SYNC`) and the checks cache stays warm. The full load is the oracle
   * and the fallback, never skipped when anything is in doubt. */
  sync(doc: Document): SyncKind {
    const held = this.held;
    if (held != null && held.doc === doc) return 'none';
    if (held != null && continues(held.doc, doc)) {
      let counts: { nodes: number; edges: number } | null = null;
      try {
        counts = this.engine.syncDelta(writeDelta(doc, held.doc.batches.length));
      } catch (e) {
        // A trap leaves the module unusable: say so rather than load into it. Anything else (a
        // delta that could not be built, a refusal that is not "resync") falls back to a full load.
        if (e instanceof EngineTrap) {
          this.held = null;
          throw e;
        }
      }
      // Live counts that differ are a tombstone, revive or element no batch told the module about.
      if (counts != null && counts.nodes === liveCount(doc.nodes) && counts.edges === liveCount(doc.edges)) {
        this.hold(doc);
        return 'delta';
      }
      this.held = null;
    }
    this.load(doc);
    return 'full';
  }

  private hold(doc: Document): void {
    this.held = { doc };
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
    // The module's estate is now neither the document it was given nor any the page holds.
    this.held = null;
    const result = this.engine.pasteInto(deviceId, text);
    const doc = readPlain(this.engine.exportPlain());
    // What was read back is exactly what the module holds, so later syncs can continue from it.
    this.hold(doc);
    return { doc, result };
  }

  /** `OP_INSIDE`, decoded by `engine.ts`'s own `inside` (the inside stop's
   * builder) — forwarded here so a caller that already holds a `Mirror`
   * rather than a raw `Engine` has one object for every door this session's
   * drawer and inside stop both open. */
  inside(deviceId: string): InsideFaces {
    return this.engine.inside(deviceId);
  }

  /** `OP_TRACE` over the estate `load` last put in the module. */
  trace(from: string, to: string, flow?: { protocol: number; port: number }): TraceResult {
    return this.engine.trace(from, to, flow);
  }

  /** `OP_CHECKS` over the estate `load` last put in the module. */
  checks(): ChecksResult {
    return this.engine.checks();
  }

  /** `OP_CHECK_GESTURE` for a cable; reads the estate `load` last put in the module. */
  checkCable(near: CableEnd, far: CableEnd, media = ''): CheckFinding[] {
    return this.engine.checkCable(near, far, media);
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
