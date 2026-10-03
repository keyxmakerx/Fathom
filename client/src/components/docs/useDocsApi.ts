import { useCallback, useMemo, useRef, useState } from 'react';
import {
  addDoc,
  addDocFile,
  addDocLink,
  allDocs,
  docView,
  docsOf,
  editDoc,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_TITLE,
  removeDoc,
  removeDocFile,
  removeDocLink,
  thingLabel,
} from '../../document/docs';
import { ApiRefusal } from '../../api/errors';
import { fetchFile, saveAsDownload, storeFile } from '../../api/files';
import { sniffFile } from './sniff';
import type { Document } from '../../document/model';
import type { Engine } from '../../engine/engine';
import { refusalSentence } from '../../engine/mirror';
import { DocsContext, type DocsApi, type DocsView } from './context';

export { DocsContext };

function fileRefusal(e: unknown): string {
  if (e instanceof ApiRefusal) {
    if (e.status === 413) return 'That file is over 25 MB.';
    if (e.status === 415) return 'Fathom keeps PDFs, images and text files only.';
    if (e.status === 403) return 'You can download files here, not add them.';
    if (e.status === 404) return 'That file is not there any more.';
    if (e.status === 422) return `The server found something that looks like a password in that file: ${e.message}`;
  }
  return e instanceof Error ? e.message : 'That file was refused.';
}

const READ_ONLY = { refused: 'You can read docs here, not change them.' };

/** Builds the docs api over the open design. Writes are refused unless the person may draw;
 * pasted text goes through the gate first (ADR-0053 §6), typed text is stored as typed. */
export function useDocsApi(opts: {
  organisationId: string;
  designId: string;
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
  const { organisationId, designId, doc, canDraw, accountId, applyDocChange, ensureEngine } = opts;
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
      async addFile(docId, file) {
        if (!canDraw) return READ_ONLY;
        if (doc == null) return { refused: 'No design is open.' };
        try {
          if (file.size === 0) return { refused: `${file.name} is empty.` };
          if (file.size > MAX_FILE_BYTES) return { refused: `${file.name} is over 25 MB.` };
          // What addDocFile would refuse is checked before anything is uploaded.
          if (file.name.trim().length === 0 || file.name.length > MAX_TITLE)
            return { refused: `A file name must be 1 to ${MAX_TITLE} characters.` };
          if ((docView(latest.current ?? doc, docId)?.files.length ?? 0) >= MAX_FILES)
            return { refused: `A doc has at most ${MAX_FILES} files.` };
          const raw = new Uint8Array(await file.arrayBuffer());
          const kind = sniffFile(raw);
          if (kind === 'refused')
            return { refused: `${file.name} is not a PDF, an image or a text file, so Fathom will not keep it.` };
          let bytes = raw;
          let checked: 'clean' | 'removed' | 'unread' = 'unread';
          let removed = 0;
          if (kind === 'text') {
            // Only the redacted copy is ever sent; a gate that fails stops the upload.
            const out = (await ensureEngine()).redactText(new TextDecoder().decode(raw));
            bytes = new TextEncoder().encode(out.text);
            removed = out.drops.length;
            checked = removed > 0 ? 'removed' : 'clean';
          }
          if (bytes.length === 0) return { refused: `${file.name} is empty.` };
          const stored = await storeFile(organisationId, designId, bytes);
          applyDocChange(
            addDocFile(
              latest.current ?? doc,
              docId,
              {
                name: file.name,
                size: bytes.length,
                media: stored.media,
                checked: stored.media === 'text' ? checked : 'unread',
                removed,
                fileId: stored.fileId,
                sha256: stored.sha256,
              },
              actor,
            ),
          );
          return {
            note:
              checked === 'removed'
                ? `${removed} password${removed === 1 ? '' : 's'} removed from ${file.name}.`
                : checked === 'clean'
                  ? `${file.name}: no passwords found.`
                  : `${file.name} was stored, but Fathom can't read it to check for passwords.`,
          };
        } catch (e) {
          return { refused: fileRefusal(e) };
        }
      },
      removeFile: (nodeId) => run((d) => removeDocFile(d, nodeId, actor)),
      async download(file) {
        try {
          saveAsDownload(file.name, await fetchFile(organisationId, designId, file.fileId, file.sha256));
        } catch (e) {
          return { refused: fileRefusal(e) };
        }
      },
      open: setView,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `actor` is derived from accountId
    [doc, canDraw, accountId, applyDocChange, gate, run, organisationId, designId, ensureEngine],
  );
  return { api, view, setView };
}
