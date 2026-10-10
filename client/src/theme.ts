// `design/tokens.css` derives dark from `prefers-color-scheme` by default and
// honours `data-theme="light"` / `data-theme="dark"` on the root element as
// an explicit override — this module is just that switch, kept out of any
// component so the same rule applies everywhere.

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'fathom-theme';

export function getStoredTheme(): Theme | null {
  const value = localStorage.getItem(STORAGE_KEY);
  return value === 'light' || value === 'dark' ? value : null;
}

export function applyTheme(theme: Theme | null): void {
  const root = document.documentElement;
  if (theme) {
    root.setAttribute('data-theme', theme);
    localStorage.setItem(STORAGE_KEY, theme);
  } else {
    root.removeAttribute('data-theme');
    localStorage.removeItem(STORAGE_KEY);
  }
}

/** What the person chose: follow the system, or pin light or dark. */
export type ThemeChoice = 'system' | Theme;

export const THEME_CHOICES: readonly ThemeChoice[] = ['system', 'light', 'dark'];

export function getThemeChoice(): ThemeChoice {
  try {
    return getStoredTheme() ?? 'system';
  } catch {
    return 'system';
  }
}

export function setThemeChoice(choice: ThemeChoice): void {
  applyTheme(choice === 'system' ? null : choice);
}

/** At startup: put the stored choice on the page before anything is drawn. Writes nothing back. */
export function applyStoredTheme(): void {
  try {
    const stored = getStoredTheme();
    if (stored) document.documentElement.setAttribute('data-theme', stored);
  } catch {
    // storage blocked: follow the system
  }
}
