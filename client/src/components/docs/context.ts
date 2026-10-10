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
  addFile(
    docId: string,
    file: File,
    confirmed?: boolean,
  ): Promise<Refused | { note: string } | { confirm: 'image' | 'PDF' }>;
  removeFile(fileNodeId: string): Refused | void;
  download(file: DocFileView): Promise<Refused | void>;
  /** Erases the stored bytes; the name, size and hash stay in the design's history. */
  deleteFileForGood(file: DocFileView): Promise<Refused | void>;
  open(view: DocsView): void;
  /** Round 15, device photo: the picture shown on a thing's panel, or null. */
  photoOf(ownerId: string): DocFileView | null;
  /** The picture's bytes, checked against the design's hash, as a `data:` URL for an `<img>`. */
  readImage(file: DocFileView): Promise<Refused | { url: string }>;
  /** Uploads an image onto the thing's "Photo" doc, making the doc if it has none. An image
   * cannot be checked for passwords, so the person confirms it shows none first. */
  addPhoto(ownerId: string, file: File, confirmed?: boolean): Promise<Refused | { note: string } | { confirm: 'image' }>;
}

export type DocsView =
  | { kind: 'list' }
  | { kind: 'doc'; id: string; from?: 'list' }
  | { kind: 'new'; ownerId?: string; model?: string | null; from?: 'list' };

export const DocsContext = createContext<DocsApi | null>(null);

export type { DocHow };
