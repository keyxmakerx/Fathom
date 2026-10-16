import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { DocFileView } from '../../document/docs';
import { addDoc, addDocFile, photoOf } from '../../document/docs';
import { createSketchDevice } from '../../document/commands';
import { emptyDocument } from '../../document/model';
import { DevicePhoto } from './DevicePhoto';
import { DocsContext, type DocsApi } from './context';
import { imageDataUrl, imageMime } from './sniff';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

const file = (over: Partial<DocFileView> = {}): DocFileView => ({
  id: 'doc-file:1',
  name: 'front.jpg',
  size: 10,
  media: 'image',
  checked: 'unread',
  removed: 0,
  fileId: 'a'.repeat(32),
  sha256: 'b'.repeat(64),
  ...over,
});

const api = (canEdit: boolean, photo: DocFileView | null) =>
  ({ canEdit, photoOf: () => photo, readImage: async () => ({ url: 'data:image/png;base64,AA==' }), addPhoto: async () => ({ note: '' }) }) as unknown as DocsApi;

const render = (a: DocsApi) => renderToStaticMarkup(createElement(DocsContext.Provider, { value: a }, createElement(DevicePhoto, { ownerId: 'device:1', name: 'nas-1' })));

describe('DevicePhoto', () => {
  it('offers a drop well to an editor when there is no photo', () => {
    const html = render(api(true, null));
    expect(html).toContain('Drop a photo · shown on the device panel');
    expect(html).toContain('Choose a photo');
    expect(html).toContain('standing in front of the rack');
  });

  it('shows nothing to a reader when there is no photo', () => {
    expect(render(api(false, null))).toBe('');
  });

  it('loads a photo there is, and offers a replacement', () => {
    const html = render(api(true, file()));
    expect(html).toContain('Loading the photo');
    expect(html).toContain('Replace the photo');
  });
});

describe('photoOf', () => {
  it('takes the newest image on the device own docs, a Photo doc first', () => {
    let doc = createSketchDevice(emptyDocument(), { hostname: 'nas-1', now: 1 });
    const deviceId = doc.nodes.find((n) => n.id.startsWith('device:'))!.id;
    expect(photoOf(doc, deviceId)).toBeNull();
    const notes = addDoc(doc, { kind: 'thing', id: deviceId }, { title: 'Manual', body: '', how: 'typed' }, { now: 2 });
    doc = addDocFile(notes.doc, notes.id, { name: 'label.png', size: 9, media: 'image', checked: 'unread', removed: 0, fileId: 'c'.repeat(32), sha256: 'd'.repeat(64) }, { now: 3 });
    expect(photoOf(doc, deviceId)?.name).toBe('label.png');
    const photo = addDoc(doc, { kind: 'thing', id: deviceId }, { title: 'Photo', body: '', how: 'typed' }, { now: 1 });
    doc = addDocFile(photo.doc, photo.id, { name: 'front.jpg', size: 9, media: 'image', checked: 'unread', removed: 0, fileId: 'e'.repeat(32), sha256: 'f'.repeat(64) }, { now: 4 });
    doc = addDocFile(doc, photo.id, { name: 'manual.pdf', size: 9, media: 'pdf', checked: 'unread', removed: 0, fileId: '1'.repeat(32), sha256: '2'.repeat(64) }, { now: 5 });
    expect(photoOf(doc, deviceId)?.name).toBe('front.jpg');
  });
});

describe('image data URLs', () => {
  it('names an image by its bytes and refuses anything else', () => {
    expect(imageMime(PNG)).toBe('image/png');
    expect(imageDataUrl(PNG)).toMatch(/^data:image\/png;base64,/);
    expect(imageDataUrl(new TextEncoder().encode('<svg onload="x()"/>'))).toBeNull();
  });
});
