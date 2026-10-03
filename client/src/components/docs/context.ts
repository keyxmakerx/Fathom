import { createContext } from 'react';
import type { DocFileView, DocHow, DocTarget, DocView } from '../../document/docs';

export type Refused = { refused: string };

/** What the docs panels need from the open design. Absent (null) where no design is open. */
export interface DocsApi {
  /** Draw or steward; a reader can read docs and nothing else. */
  canEdit: boolean;
  of(ownerId: string, model?: string | null): DocView[];
  get(id: string): DocView | undefined;
  /** Every doc in the design, for the list. */
  all(): DocView[];
  label(id: string): string;
  /** `pasted`: the text had a paste in it, so it goes through the gate first. */
  create(target: DocTarget, input: { title: string; body: string; pasted: boolean }): Promise<{ id: string } | Refused>;
  update(id: string, patch: { title?: string; body?: string; pasted?: boolean }): Promise<Refused | void>;
  remove(id: string): Refused | void;
  addLink(id: string, input: { title: string; url: string; pasted: boolean }): Promise<Refused | void>;
  removeLink(linkId: string): Refused | void;
  /** Checks (text goes through the gate), uploads and records a file on a doc. */
  addFile(docId: string, file: File): Promise<Refused | { note: string }>;
  removeFile(fileNodeId: string): Refused | void;
  download(file: DocFileView): Promise<Refused | void>;
  open(view: DocsView): void;
}

export type DocsView =
  | { kind: 'list' }
  | { kind: 'doc'; id: string; from?: 'list' }
  | { kind: 'new'; ownerId?: string; model?: string | null; from?: 'list' };

export const DocsContext = createContext<DocsApi | null>(null);

export type { DocHow };
