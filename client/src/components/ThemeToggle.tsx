import { useState } from 'react';

import { applyTheme, getStoredTheme, type Theme } from '../theme';

const NEXT: Record<'system' | Theme, 'system' | Theme> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
};

const LABEL: Record<'system' | Theme, string> = {
  system: 'Theme: system',
  light: 'Theme: light',
  dark: 'Theme: dark',
};

export function ThemeToggle() {
  const [mode, setMode] = useState<'system' | Theme>(() => getStoredTheme() ?? 'system');

  function cycle() {
    const next = NEXT[mode];
    setMode(next);
    applyTheme(next === 'system' ? null : next);
  }

  return (
    <button type="button" className="theme-toggle" onClick={cycle}>
      {LABEL[mode]}
    </button>
  );
}
