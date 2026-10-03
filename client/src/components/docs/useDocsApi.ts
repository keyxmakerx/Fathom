import { useCallback, useMemo, useRef, useState } from 'react';
import {
  addDoc,
  addDocLink,
  allDocs,
  docView,
  docsOf,
  editDoc,
  removeDoc,
  removeDocLink,
  thingLabel,
} from '../../document/docs';
import type { Document } from '../../document/model';
import type { Engine } from '../../engine/engine';
import { refusalSentence } from '../../engine/mirror';
import { DocsContext, type DocsApi, type DocsView } from './context';

export { DocsContext };

const READ_ONLY = { refused: 'You can read docs here, not change them.' };

/** Builds the docs api over the open design. Writes are refused unless the person may draw;
 * pasted text goes through the gate first (ADR-0053 §6), typed text is stored as typed. */
export function useDocsApi(opts: {
  doc: Document | null;
  canDraw: boolean;
  accountId: string | null;
  applyDocChange: (next: Document) => void;
  ensureEngine: () => Promise<Engine>;
}): {
  api: DocsApi;
  view: DocsView | null;
  setView: (v: DocsView | null) => void;
} {
  const { doc, canDraw, accountId, applyDocChange, ensureEngine } = opts;
  const [view, setView] = useState<DocsView | null>(null);
  // The gate is async; whatever changed meanwhile (an undo) must not be written over.
  const latest = useRef(doc);
  latest.current = doc;
  const actor = accountId ? { actor: accountId } : undefined;

  const gate = useCallback(
    async (text: string, pasted: boolean): Promise<string> =>
      pasted ? (await ensureEngine()).redactText(text).text : text,
    [ensureEngine],
  );
  const run = useCallback(
    (f: (d: Document) => Document): { refused: string } | void => {
      if (!canDraw) return READ_ONLY;
      if (doc == null) return { refused: 'No design is open.' };
      try {
        applyDocChange(f(doc));
      } catch (e) {
        return {
          refused: e instanceof Error ? e.message : 'That was refused.',
        };
      }
    },
    [canDraw, doc, applyDocChange],
  );

  const api = useMemo<DocsApi>(
    () => ({
      canEdit: canDraw,
      of: (ownerId, model) => (doc ? docsOf(doc, ownerId, model) : []),
      get: (id) => (doc ? docView(doc, id) : undefined),
      all: () => (doc ? allDocs(doc) : []),
      label: (id) => (doc ? thingLabel(doc, id) : ''),
      async create(target, input) {
        if (!canDraw) return READ_ONLY;
        if (doc == null) return { refused: 'No design is open.' };
        try {
          const body = await gate(input.body, input.pasted);
          const title = await gate(input.title, input.pasted);
          const made = addDoc(
            latest.current ?? doc,
            target,
            { title, body, how: input.pasted ? 'pasted' : 'typed' },
            actor,
          );
          applyDocChange(made.doc);
          return { id: made.id };
        } catch (e) {
          return {
            refused: e instanceof Error ? e.message : refusalSentence(e),
          };
        }
      },
      async update(id, patch) {
        if (!canDraw) return READ_ONLY;
        if (doc == null) return { refused: 'No design is open.' };
        try {
          const pasted = patch.pasted === true;
          const body = patch.body === undefined ? undefined : await gate(patch.body, pasted);
          const title = patch.title === undefined ? undefined : await gate(patch.title, pasted);
          applyDocChange(
            editDoc(latest.current ?? doc, id, { title, body, how: pasted ? 'pasted' : undefined }, actor),
          );
        } catch (e) {
          return {
            refused: e instanceof Error ? e.message : refusalSentence(e),
          };
        }
      },
      remove: (id) => run((d) => removeDoc(d, id, actor)),
      async addLink(id, input) {
        if (!canDraw) return READ_ONLY;
        if (doc == null) return { refused: 'No design is open.' };
        try {
          const title = await gate(input.title, input.pasted);
          const url = await gate(input.url, input.pasted);
          applyDocChange(addDocLink(latest.current ?? doc, id, { title, url }, actor));
        } catch (e) {
          return {
            refused: e instanceof Error ? e.message : refusalSentence(e),
          };
        }
      },
      removeLink: (linkId) => run((d) => removeDocLink(d, linkId, actor)),
      open: setView,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `actor` is derived from accountId
    [doc, canDraw, accountId, applyDocChange, gate, run],
  );
  return { api, view, setView };
}
