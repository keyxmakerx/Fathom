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
