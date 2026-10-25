// The explainers — `GET /learn/explainers`, `crates/fathom-server/src/design_api.rs`'s
// `explainers_handler` and `json_of_explainer`. Reference text from `corpus/explainers/`, the same
// for every caller (ADR-0066 item 1.1). `reviewed` is false while the entry's `reviewed_by` is
// still a placeholder, and every screen that shows one says so.

import { asRec, bool, optStr, str, type Rec } from './json';
import { signedFetch } from './signedFetch';

export interface ExplainerSource {
  publisher: string | null;
  doc: string;
  url: string | null;
  readOn: string | null;
  note: string | null;
}

export interface Explainer {
  id: string;
  /** `concept`, `symptom`, `error`, … as the corpus spells it. */
  kind: string;
  title: string | null;
  /** `subject.path`, e.g. `linux-debian.basics`; null for a verbatim subject. */
  subject: string | null;
  /** Platform registry ids, or `*` for all. */
  platforms: string[];
  tab: string | null;
  terse: string | null;
  explained: string | null;
  teaching: string | null;
  breaksIfWrong: string | null;
  reviewedOn: string | null;
  reviewed: boolean;
  sources: ExplainerSource[];
}

const WHAT = 'explainers';

function strings(rec: Rec, key: string): string[] {
  const v = rec[key];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new Error(`malformed ${WHAT} response: bad ${key}`);
  return v as string[];
}

function parseSource(v: unknown): ExplainerSource {
  const r = asRec(v, WHAT);
  return {
    publisher: optStr(r, 'publisher', WHAT),
    doc: str(r, 'doc', WHAT),
    url: optStr(r, 'url', WHAT),
    readOn: optStr(r, 'read_on', WHAT),
    note: optStr(r, 'note', WHAT),
  };
}

export function parseExplainers(bytes: Uint8Array): Explainer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error(`malformed ${WHAT} response`);
  }
  if (!Array.isArray(parsed)) throw new Error(`malformed ${WHAT} response`);
  return parsed.map((v) => {
    const r = asRec(v, WHAT);
    const sources = r.sources;
    if (!Array.isArray(sources)) throw new Error(`malformed ${WHAT} response: no sources`);
    return {
      id: str(r, 'id', WHAT),
      kind: str(r, 'class', WHAT),
      title: optStr(r, 'title', WHAT),
      subject: optStr(r, 'subject', WHAT),
      platforms: strings(r, 'platforms'),
      tab: optStr(r, 'tab', WHAT),
      terse: optStr(r, 'terse', WHAT),
      explained: optStr(r, 'explained', WHAT),
      teaching: optStr(r, 'teaching', WHAT),
      breaksIfWrong: optStr(r, 'breaks_if_wrong', WHAT),
      reviewedOn: optStr(r, 'reviewed_on', WHAT),
      reviewed: bool(r, 'reviewed', WHAT),
      sources: sources.map(parseSource),
    };
  });
}

export async function fetchExplainers(): Promise<Explainer[]> {
  return parseExplainers(await signedFetch('GET', '/learn/explainers'));
}
