import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { Document } from '../../document/model';
import { HistoryPanel, whenLabel } from './HistoryPanel';
import type { History } from './useHistory';

const SAVES = [
  { seq: 2, entryType: 'update', designVersion: 2, atUnix: 1_700_000_100, actor: 'ABC12345XYZ' },
  { seq: 1, entryType: 'create', designVersion: 1, atUnix: 1_700_000_000, actor: null },
];

function history(over: Partial<History> = {}): History {
  return {
    saves: SAVES,
    verifyLine: 'Checked: every save is intact',
    summaries: new Map([[2, 'added nas-01']]),
    shown: 15,
    showOlder: () => {},
    error: null,
    picked: null,
    pickVersion: async () => {},
    back: () => {},
    ...over,
  };
}

const render = (h: History, canDraw = true) =>
  renderToStaticMarkup(
    createElement(HistoryPanel, { history: h, accountId: null, accountAddress: null, canDraw, restoreText: 'This will remove 1 device.', onRestore: () => {}, onClose: () => {} }),
  );

describe('HistoryPanel', () => {
  it('leads with the check in words and lists saves newest first with their summary', () => {
    const html = render(history());
    expect(html).toContain('Checked: every save is intact');
    expect(html.indexOf('added nas-01')).toBeGreaterThan(0);
    expect(html.indexOf('added nas-01')).toBeLessThan(html.indexOf('…'));
    expect(html).toContain('ABC12345');
    expect(html).toContain('unknown');
  });

  it('offers Back to now and Restore on an older pick, Restore only to someone who can draw', () => {
    const picked = { version: 1, doc: {} as Document, change: { summary: 'x', changed: [] }, outline: [] };
    expect(render(history({ picked }))).toContain('Restore this version');
    expect(render(history({ picked }))).toContain('Back to now');
    expect(render(history({ picked }), false)).not.toContain('Restore this version');
  });

  it('does not offer Restore on the newest save', () => {
    const picked = { version: 2, doc: {} as Document, change: { summary: 'x', changed: [] }, outline: [] };
    expect(render(history({ picked }))).not.toContain('Restore this version');
  });
});

describe('whenLabel', () => {
  it('says Today and Yesterday, then the date', () => {
    const now = new Date(2026, 9, 3, 15, 0);
    expect(whenLabel(new Date(2026, 9, 3, 14, 2).getTime() / 1000, now)).toBe('Today 14:02');
    expect(whenLabel(new Date(2026, 9, 2, 9, 5).getTime() / 1000, now)).toBe('Yesterday 09:05');
    expect(whenLabel(new Date(2026, 8, 20, 9, 5).getTime() / 1000, now)).toBe('20 Sept 09:05');
  });
});
