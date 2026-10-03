import { describe, expect, it } from 'vitest';

import { addSketchPort, createSketchDevice, removeChassis } from './commands';
import {
  DocRefusalError,
  MAX_LINKS,
  addDoc,
  addDocFile,
  addDocLink,
  designDocs,
  docView,
  docsOf,
  editDoc,
  modelDocs,
  modelKey,
  removeDoc,
  removeDocFile,
  removeDocLink,
  safeUrl,
  thingLabel,
} from './docs';
import { edgesOut, emptyDocument, parseNodeId, type Document } from './model';
import { undo } from './undo';

const NOW = 1_700_000_000_000;
const ACTOR = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

function deviceDoc(): {
  doc: Document;
  deviceId: string;
  chassisId: string;
  portId: string;
} {
  const bare = createSketchDevice(emptyDocument(), { now: NOW });
  const deviceId = bare.nodes.find((n) => parseNodeId(n.id).kind === 'Device')!.id;
  const chassisId = bare.nodes.find((n) => parseNodeId(n.id).kind === 'Chassis')!.id;
  const doc = addSketchPort(bare, chassisId, { label: 'eth0', connector: 'rj45', face: 'front' }, { now: NOW });
  return {
    doc,
    deviceId,
    chassisId,
    portId: edgesOut(doc, chassisId, 'HasPort')[0]!.to,
  };
}

const input = {
  title: 'Runbook',
  body: '# Steps\n\n- one',
  how: 'typed' as const,
};

describe('docs', () => {
  it('a doc on a thing shows on that thing, with who and when', () => {
    const { doc, deviceId } = deviceDoc();
    const made = addDoc(doc, { kind: 'thing', id: deviceId }, input, {
      actor: ACTOR,
      now: NOW,
    });
    const [d] = docsOf(made.doc, deviceId);
    expect(d).toMatchObject({
      title: 'Runbook',
      body: input.body,
      how: 'typed',
      ownerId: deviceId,
      who: ACTOR,
      when: NOW,
    });
    expect(d!.onModel).toBeUndefined();
    expect(designDocs(made.doc)).toEqual([]);
  });

  it('a doc on a model shows on every thing of that model, marked, after its own', () => {
    const { doc, deviceId, portId } = deviceDoc();
    const own = addDoc(doc, { kind: 'thing', id: deviceId }, { ...input, title: 'Own' }, { now: NOW });
    const onModel = addDoc(own.doc, { kind: 'model', model: 'SRX 345' }, { ...input, title: 'Model' }, { now: NOW });
    const seen = docsOf(onModel.doc, deviceId, 'SRX 345');
    expect(seen.map((d) => [d.title, d.onModel === true])).toEqual([
      ['Own', false],
      ['Model', true],
    ]);
    expect(docsOf(onModel.doc, deviceId, 'MX204').map((d) => d.title)).toEqual(['Own']);
    expect(docsOf(onModel.doc, portId)).toEqual([]);
    expect(modelDocs(onModel.doc).map((d) => d.model)).toEqual([modelKey('SRX 345')]);
    expect(modelKey('SRX 345')).toBe('SRX-345');
  });

  it('a design-wide doc is in designDocs and on no thing', () => {
    const { doc, deviceId } = deviceDoc();
    const made = addDoc(doc, { kind: 'design' }, input, { now: NOW });
    expect(designDocs(made.doc).map((d) => d.title)).toEqual(['Runbook']);
    expect(docsOf(made.doc, deviceId)).toEqual([]);
  });

  it('refuses an empty or over-long title, an over-long body and an owner that cannot have docs', () => {
    const { doc, chassisId } = deviceDoc();
    expect(() => addDoc(doc, { kind: 'design' }, { ...input, title: '  ' })).toThrow(DocRefusalError);
    expect(() => addDoc(doc, { kind: 'design' }, { ...input, title: 'x'.repeat(121) })).toThrow(/120/);
    expect(() => addDoc(doc, { kind: 'design' }, { ...input, body: 'x'.repeat(50_001) })).toThrow(/50000/);
    expect(() => addDoc(doc, { kind: 'thing', id: chassisId }, input)).toThrow(/attach to/);
  });

  it('edits title and body, a paste makes it pasted for good, no change writes nothing', () => {
    const { doc } = deviceDoc();
    const made = addDoc(doc, { kind: 'design' }, input, {
      actor: ACTOR,
      now: NOW,
    });
    expect(editDoc(made.doc, made.id, { title: 'Runbook', body: input.body })).toBe(made.doc);
    const edited = editDoc(
      made.doc,
      made.id,
      { title: 'Run book', body: 'new', how: 'pasted' },
      { actor: 'other', now: NOW + 5 },
    );
    expect(docView(edited, made.id)).toMatchObject({
      title: 'Run book',
      body: 'new',
      how: 'pasted',
      who: 'other',
      when: NOW + 5,
    });
    const again = editDoc(edited, made.id, { body: 'typed over' }, { now: NOW + 9 });
    expect(docView(again, made.id)!.how).toBe('pasted');
  });

  it('removes a doc with its links and edges together, and undo brings it back', () => {
    const { doc, deviceId } = deviceDoc();
    const made = addDoc(doc, { kind: 'thing', id: deviceId }, input, {
      actor: ACTOR,
      now: NOW,
    });
    const linked = addDocLink(
      made.doc,
      made.id,
      { title: 'Vendor', url: 'https://example.com/a?b=1' },
      { actor: ACTOR, now: NOW },
    );
    const gone = removeDoc(linked, made.id, { actor: ACTOR, now: NOW + 1 });
    expect(docView(gone, made.id)).toBeUndefined();
    expect(docsOf(gone, deviceId)).toEqual([]);
    const batch = gone.batches[gone.batches.length - 1]!;
    const back = undo(gone, batch.id, { actor: ACTOR, now: NOW + 2 });
    expect(docView(back, made.id)?.links).toHaveLength(1);
    expect(docsOf(back, deviceId)).toHaveLength(1);
  });

  it('links: http and https only, host shown, none with a login, capped, removable', () => {
    const { doc } = deviceDoc();
    const made = addDoc(doc, { kind: 'design' }, input, { now: NOW });
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,<b>',
      'file:///etc/passwd',
      '//evil.test',
      'ftp://x.test',
      'https://u:p@x.test/',
      '',
      'not a url',
      'JaVaScRiPt:alert(1)',
      ' \tjavascript:alert(1)',
    ]) {
      expect(() => addDocLink(made.doc, made.id, { title: 't', url: bad })).toThrow(/web address/);
    }
    const ok = addDocLink(made.doc, made.id, { title: '', url: ' https://Docs.Example.com:8443/x ' }, { now: NOW });
    expect(docView(ok, made.id)!.links[0]).toMatchObject({
      title: 'docs.example.com:8443',
      url: 'https://docs.example.com:8443/x',
    });
    expect(safeUrl('https://docs.example.com:8443/x')).toEqual({
      href: 'https://docs.example.com:8443/x',
      host: 'docs.example.com:8443',
    });
    const id = docView(ok, made.id)!.links[0]!.id;
    expect(docView(removeDocLink(ok, id), made.id)!.links).toEqual([]);
    let many = made.doc;
    for (let i = 0; i < MAX_LINKS; i += 1)
      many = addDocLink(many, made.id, {
        title: `l${i}`,
        url: `https://x.test/${i}`,
      });
    expect(() => addDocLink(many, made.id, { title: 'one more', url: 'https://x.test/z' })).toThrow(/at most/);
  });

  it('a doc whose thing is removed is not lost: it is listed with the design', () => {
    const { doc, deviceId, chassisId } = deviceDoc();
    const made = addDoc(doc, { kind: 'thing', id: deviceId }, input, {
      now: NOW,
    });
    expect(thingLabel(made.doc, deviceId)).toBe('Device');
    const removed = removeChassis(made.doc, chassisId, { now: NOW + 1 });
    const left = designDocs(removed);
    expect(left.map((d) => d.title)).toEqual(['Runbook']);
    expect(docsOf(removed, deviceId)).toEqual([]);
  });
});

describe('docs on the wire', () => {
  it('survive the plain file and read back', async () => {
    const { readPlain, writePlain } = await import('./plain');
    const { doc, deviceId } = deviceDoc();
    const made = addDoc(doc, { kind: 'thing', id: deviceId }, input, {
      actor: ACTOR,
      now: NOW,
    });
    const linked = addDocLink(
      made.doc,
      made.id,
      { title: 'V', url: 'https://example.com/' },
      { actor: ACTOR, now: NOW },
    );
    const back = readPlain(writePlain(linked));
    expect(docView(back, made.id)).toMatchObject({
      title: 'Runbook',
      ownerId: deviceId,
      links: [{ title: 'V', url: 'https://example.com/' }],
    });
  });
});

describe('doc files', () => {
  const file = {
    name: 'runbook.txt',
    size: 120,
    media: 'text' as const,
    checked: 'removed' as const,
    removed: 2,
    fileId: 'a'.repeat(32),
    sha256: 'b'.repeat(64),
  };

  it('records a file on a doc, lists it, removes it with the doc, undo brings it back', () => {
    const { doc: base } = deviceDoc();
    const { doc, id } = addDoc(base, { kind: 'design' }, { title: 'T', body: '', how: 'typed' }, { now: NOW });
    const withFile = addDocFile(doc, id, file, { actor: ACTOR, now: NOW });
    const f = docView(withFile, id)!.files;
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ name: 'runbook.txt', size: 120, checked: 'removed', removed: 2, media: 'text' });
    const gone = removeDocFile(withFile, f[0]!.id, { actor: ACTOR, now: NOW + 1 });
    expect(docView(gone, id)!.files).toHaveLength(0);
    expect(
      docView(undo(gone, gone.batches[gone.batches.length - 1]!.id, { actor: ACTOR, now: NOW + 2 }), id)!.files,
    ).toHaveLength(1);
    const noDoc = removeDoc(withFile, id, { now: NOW });
    expect(noDoc.nodes.every((n) => n.absentSince !== undefined || !n.id.includes('doc-file'))).toBe(true);
  });

  it('refuses a bad id, hash, size or a missing doc, and caps the count', () => {
    const { doc: base } = deviceDoc();
    const { doc, id } = addDoc(base, { kind: 'design' }, { title: 'T', body: '', how: 'typed' }, { now: NOW });
    expect(() => addDocFile(doc, id, { ...file, fileId: 'zz' })).toThrow(DocRefusalError);
    expect(() => addDocFile(doc, id, { ...file, sha256: 'x' })).toThrow(DocRefusalError);
    expect(() => addDocFile(doc, id, { ...file, size: 0 })).toThrow(DocRefusalError);
    expect(() => addDocFile(doc, id, { ...file, size: 26 * 1024 * 1024 })).toThrow(DocRefusalError);
    expect(() => addDocFile(doc, 'doc:nope', file)).toThrow(DocRefusalError);
    let d = doc;
    for (let i = 0; i < 20; i += 1) d = addDocFile(d, id, file, { now: NOW + i });
    expect(() => addDocFile(d, id, file)).toThrow(/at most 20/);
  });
});
