import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { addSketchPort, createSketchDevice } from '../../document/commands';
import { edgesOut, emptyDocument, parseNodeId, type Document } from '../../document/model';
import { tagObject, tagsOf, untagObject } from '../../document/tags';
import { TagsPanel, tagsPanelRows, thingsWord } from './TagsPanel';

// Render-to-string smoke tests, as the other component tests here do: no DOM library is installed.

const NOW = 1_800_000_000_000;

function tagged(): Document {
  const bare = createSketchDevice(emptyDocument(), { now: NOW });
  const deviceId = bare.nodes.find((n) => parseNodeId(n.id).kind === 'Device')!.id;
  const chassisId = bare.nodes.find((n) => parseNodeId(n.id).kind === 'Chassis')!.id;
  let doc = addSketchPort(bare, chassisId, { label: 'eth0', connector: 'rj45', face: 'front' }, { now: NOW });
  const portId = edgesOut(doc, chassisId, 'HasPort')[0]!.to;
  doc = tagObject(doc, deviceId, 'cameras', { now: NOW });
  doc = tagObject(doc, portId, 'cameras', { now: NOW });
  doc = tagObject(doc, deviceId, 'old lab', { now: NOW });
  doc = tagObject(doc, deviceId, 'aaa spare', { now: NOW });
  // "old lab" ends up carried by nothing.
  const oldLab = tagsOf(doc, deviceId).find((c) => c.name === 'old lab')!.tagId;
  return untagObject(doc, deviceId, oldLab, { now: NOW + 1 });
}

const panel = (doc: Document | null, canDraw: boolean) =>
  renderToStaticMarkup(createElement(TagsPanel, { doc, canDraw, applyDocChange: () => undefined }));

describe('Inventory › Tags', () => {
  it('lists used tags by name, then the empty ones marked Not used', () => {
    expect(tagsPanelRows(tagged()).map((t) => t.name)).toEqual(['aaa spare', 'cameras', 'old lab']);
    const out = panel(tagged(), true);
    expect(out).toContain('2 things');
    expect(out).toContain('1 thing<');
    expect(out).toContain('Not used');
    expect(out).toContain('aria-label="Delete tag cameras"');
    expect(out).toContain('aria-label="Rename tag old lab"');
  });

  it('a reader sees the list but cannot rename or delete', () => {
    const out = panel(tagged(), false);
    expect(out).toContain('cameras');
    expect(out).not.toContain('Delete');
    expect(out).not.toContain('Rename');
  });

  it('says so when there are no tags', () => {
    expect(panel(emptyDocument(), true)).toContain('No tags yet.');
  });

  it('counts things in words', () => {
    expect(thingsWord(1)).toBe('1 thing');
    expect(thingsWord(1200)).toBe('1,200 things');
  });
});
