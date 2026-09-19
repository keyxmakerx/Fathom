// ADR-0054 §1: "a save names the version it was based on … The server …
// refuses a base that is not the current version with a conflict answer
// naming both numbers in one sentence, writes nothing and appends nothing,
// and otherwise writes base plus one. The client keeps its base on a
// refusal and never adopts the server's current version, because that is
// the silent overwrite by another name."
//
// This module is the one place that base lives. It is set exactly twice:
// from the version `openDesign` returned (the constructor) and from the
// version a save that actually landed returned (`save`, only once its
// promise resolves). A refusal — a 409 naming the real version, or anything
// else — leaves it untouched, because the assignment below simply never
// runs: this file never reads `fathom-design-version` off a refusal, so
// there is no code path that could adopt it even by accident. A later
// `save()` call after a refusal reads the same base field and sends the
// same old base again, which is refused the same way until something
// outside this module (a reload) constructs a fresh instance.

import { saveDesign } from '../../api/payload';

export class ConditionalSave {
  private base: number;

  /** `openedVersion` — `OpenedDesign.version`, `open_design_handler`'s own
   * `fathom-design-version` header at the moment this document was read. */
  constructor(openedVersion: number) {
    this.base = openedVersion;
  }

  /** The version the next `save()` will send as its precondition. Exposed
   * for tests and for a caller that wants to show it; nothing outside this
   * class ever assigns it. */
  get currentBase(): number {
    return this.base;
  }

  /**
   * Saves `bytes` against the base this instance currently holds. Resolves
   * with the version the server wrote and moves the base to it. Rejects
   * with whatever `saveDesign` rejected with — in particular an
   * `ApiRefusal` with `status === 409` on a conflict — and, on any
   * rejection, leaves the base exactly where it was.
   */
  async save(organisationId: string, designId: string, bytes: Uint8Array): Promise<number> {
    const version = await saveDesign(organisationId, designId, bytes, this.base);
    this.base = version;
    return version;
  }
}
