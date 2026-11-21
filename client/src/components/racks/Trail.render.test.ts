import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { createRack } from '../../document/commands';
import { setRackField } from '../../document/edit';
import { emptyDocument, formatNodeId, type Document } from '../../document/model';
import { newUlid } from '../../document/ulid';
import { Trail, TrailRecord } from './Trail';

const NOW = 1_700_000_000_000;
const ME = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const THEM = '01ARZ3NDEKTSV4RRFFQ69G5FBV';

function threeChanges(): Document {
  const premisesId = formatNodeId('Premises', newUlid(NOW));
  const base: Document = { ...emptyDocument(), nodes: [{ id: premisesId, existence: newUlid(NOW), fields: {} }] };
  const racked = createRack(base, premisesId, { label: 'R1', heightU: 42, unitNumbering: 'ascending', actor: ME, now: NOW });
  const rackId = racked.nodes.find((n) => n.id !== premisesId)!.id;
  const one = setRackField(racked, rackId, 'row', 'Row A', { actor: THEM, now: NOW + 1 });
  return setRackField(one, rackId, 'bay', 2, { actor: ME, now: NOW + 2 });
}

const html = (doc: Document) =>
  renderToStaticMarkup(
    createElement(Trail, { doc, accountId: ME, accountAddress: 'ana@example.net', designId: 'd1', sealedBatchIds: new Set<string>(), undoRefusal: null, pendingComment: '', onPendingCommentChange: () => {} }),
  );

const rowsOf = (out: string) => out.match(/<button[^>]*class="racks-trail__row[^"]*"[^>]*>/g) ?? [];

describe('Trail — a row can be pressed', () => {
  it('draws each change as a button that says its record is closed', () => {
    const rows = rowsOf(html(threeChanges()));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row).toContain('type="button"');
      expect(row).toContain('aria-expanded="false"');
      expect(row).not.toContain('aria-controls');
    }
  });

  it('gives Tab one stop in the rows, the newest, however many there are', () => {
    const rows = rowsOf(html(threeChanges()));
    expect(rows.map((row) => /tabindex="(-?\d)"/.exec(row)?.[1])).toEqual(['0', '-1', '-1']);
  });

  it('shows no record until a row is pressed', () => {
    expect(html(threeChanges())).not.toContain('racks-trail__record');
  });

  it('says in its heading line that a row can be pressed', () => {
    expect(html(threeChanges())).toContain('press a row for its full record');
  });

  it('keeps what a pointer reads by resting on a row', () => {
    const out = html(threeChanges());
    expect(out).toContain(`title="ana@example.net · account ${ME}"`);
    expect(out).toContain(`title="Account ${THEM}"`);
    expect(out).toContain('title="Recorded as: set Rack.bay"');
  });

  it('draws no list for a design with no changes, only the line that says so', () => {
    const out = html(emptyDocument());
    expect(out).toContain('No changes yet.');
    expect(out).not.toContain('racks-trail__list');
    expect(rowsOf(out)).toHaveLength(0);
  });
});

describe('TrailRecord', () => {
  it('sets each line as a name and its value, under the id its row points at', () => {
    const out = renderToStaticMarkup(
      createElement(TrailRecord, {
        id: 'rec',
        lines: [
          { label: 'When', value: '20 Nov 2026 21:04:07 (UTC-06:00)' },
          { label: 'Account id', value: ME },
        ],
      }),
    );
    expect(out).toBe(
      '<dl class="racks-trail__record" id="rec">' +
        '<div class="racks-trail__record-line"><dt>When</dt><dd>20 Nov 2026 21:04:07 (UTC-06:00)</dd></div>' +
        `<div class="racks-trail__record-line"><dt>Account id</dt><dd>${ME}</dd></div>` +
        '</dl>',
    );
  });

  it('writes a value as text, whatever is in it', () => {
    const out = renderToStaticMarkup(createElement(TrailRecord, { id: 'rec', lines: [{ label: 'Recorded as', value: '<b>rename</b> & more' }] }));
    expect(out).toContain('<dd>&lt;b&gt;rename&lt;/b&gt; &amp; more</dd>');
  });
});
