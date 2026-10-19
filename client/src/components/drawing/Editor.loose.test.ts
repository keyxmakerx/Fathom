import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { EditorActions } from './contract';
import { EditorFor, needsFinishingChange, oneEndCableChange } from './Editor';
import { NEEDS_A, UNKNOWN_A, WHOLE, missingLinksView } from './missingLinksFixture';

// Missing links on the details panels: the "Needs finishing" toggle on a cable with one end
// connected, and "Add a cable, far end open" on a free port. Render-to-string only, as the other
// panel tests here are.

const VIEW = missingLinksView();
const WRITER: EditorActions = { onEdit: vi.fn() };
const READER: EditorActions = {};

function cablePanel(id: string, actions: EditorActions): string {
  return renderToStaticMarkup(EditorFor({ kind: 'cable', id }, VIEW, actions) as never);
}

describe('the change shapes', () => {
  it('say only what is asked', () => {
    expect(needsFinishingChange('c1', true)).toEqual({ kind: 'cable-needs-finishing', id: 'c1', on: true });
    expect(needsFinishingChange('c1', false)).toEqual({ kind: 'cable-needs-finishing', id: 'c1', on: false });
    expect(oneEndCableChange('p1')).toEqual({ kind: 'cable-one-end', portId: 'p1' });
  });
});

describe("a cable with one end connected, in the cable's panel", () => {
  it('offers the Needs finishing toggle, off for an Unknown end', () => {
    const html = cablePanel(UNKNOWN_A, WRITER);
    expect(html).toContain('data-testid="loose-end-field"');
    expect(html).toContain('>Unknown<');
    expect(html).toMatch(/<button[^>]*aria-pressed="false"[^>]*>Needs finishing<\/button>/);
  });

  it('shows it pressed once marked', () => {
    const html = cablePanel(NEEDS_A, WRITER);
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>Needs finishing<\/button>/);
    expect(html).toContain('Drag from a free port onto this cable&#x27;s port to finish it.');
  });

  it('has no toggle for a reader, but still says what the end is', () => {
    const html = cablePanel(NEEDS_A, READER);
    expect(html).not.toContain('<button');
    expect(html).toContain('>Needs finishing<');
  });

  it('has no Missing links controls on a cable with both ends connected', () => {
    expect(cablePanel(WHOLE, WRITER)).not.toContain('loose-end-field');
  });
});
