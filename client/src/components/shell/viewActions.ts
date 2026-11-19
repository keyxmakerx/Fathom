// The four views as rows of the command palette, in the words the bar's tabs use, so the palette and the tabs
// name the same four places. Each place offers them with its own way of switching (`usePaletteActions`).

import { VIEW_LABEL, VIEWS } from './hintWords';
import type { PaletteAction } from './palette';
import type { MainView, ShellProps } from './types';

/** Other words a person might type for each view, the older names among them. */
const VIEW_KEYWORDS: Record<MainView, readonly string[]> = {
  diagram: ['show', 'open', 'switch', 'boxes', 'lines', 'map', 'topology', 'logical'],
  canvas: ['show', 'open', 'switch', 'racks', 'rack', 'drawing', 'room', 'physical'],
  inventory: ['show', 'open', 'switch', 'lists', 'table', 'devices', 'ports', 'cables', 'networks'],
  sheet: ['show', 'open', 'switch', 'spreadsheet', 'table', 'grid', 'tabs'],
};

export function viewActions(mainView: NonNullable<ShellProps['mainView']>): PaletteAction[] {
  return VIEWS.map((view) => ({
    id: `view-${view}`,
    label: `${VIEW_LABEL[view]} view`,
    group: 'go' as const,
    keywords: VIEW_KEYWORDS[view],
    disabled: mainView.value === view ? 'Already showing' : undefined,
    run: () => mainView.onChange(view),
  }));
}
