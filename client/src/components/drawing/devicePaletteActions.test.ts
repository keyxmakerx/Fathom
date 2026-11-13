import { describe, expect, it, vi } from 'vitest';

import { matchActions } from '../shell/palette';
import { DEVICE_WORDS, deviceMenuItems, type MenuActions } from './contextMenuItems';
import { devicePaletteActions } from './devicePaletteActions';

const fn = () => vi.fn();
const all: MenuActions = {
  onSelect: fn(),
  onOpen: fn(),
  onOpenInside: fn(),
  onTraceFrom: fn(),
  onItsDown: fn(),
  onPlanChange: fn(),
  onPlanFirmware: fn(),
  onSwapModel: fn(),
  onFitCard: fn(),
  onSuggestCables: fn(),
  onAddPort: fn(),
  onTakeOut: fn(),
  onDuplicateDevice: fn(),
  onRemoveDevice: fn(),
};

describe('Ctrl K and the device actions that left the menu (r116)', () => {
  const palette = devicePaletteActions(deviceMenuItems('c1', all, { inPanel: true, all: true }), 'sw-1');

  it('finds each of them by name, called for the device', () => {
    for (const word of [DEVICE_WORDS.openInside, DEVICE_WORDS.planFirmware, DEVICE_WORDS.swapModel, DEVICE_WORDS.fitCard, DEVICE_WORDS.suggestCables, DEVICE_WORDS.addPort, DEVICE_WORDS.takeOut]) {
      const found = matchActions(palette, word.toLowerCase().replace('…', ''));
      expect(found.map((a) => a.label)).toContain(`${word} · sw-1`);
    }
  });

  it('runs one on its device', () => {
    palette.find((a) => a.label.startsWith(DEVICE_WORDS.takeOut))!.run();
    expect(all.onTakeOut).toHaveBeenCalledWith('c1');
  });

  it('carries the greyed reason and the key hint of a row', () => {
    const withReason = devicePaletteActions(deviceMenuItems('c1', { ...all, firmwareNeedsVersion: () => true }, { inPanel: true, all: true }), '');
    expect(withReason.find((a) => a.label === DEVICE_WORDS.planFirmware)!.disabled).toBe('Choose a version on its model first');
    expect(withReason.find((a) => a.label === DEVICE_WORDS.remove)!.hint).toBeDefined();
  });
});
