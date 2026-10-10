import { useState } from 'react';

import { getThemeChoice, setThemeChoice, THEME_CHOICES, type ThemeChoice } from '../theme';
import '../styles/appearance.css';

const LABEL: Record<ThemeChoice, string> = { system: 'System', light: 'Light', dark: 'Dark' };

/** The Appearance section of the account screen: System, Light or Dark. The same choice the
 * account menu's theme row cycles through; both read and write `theme.ts`. */
export function Appearance() {
  const [choice, setChoice] = useState<ThemeChoice>(() => getThemeChoice());
  const pick = (next: ThemeChoice) => {
    setChoice(next);
    setThemeChoice(next);
  };

  return (
    <section className="signin__section appearance" aria-labelledby="account-appearance">
      <h2 className="signin__heading" id="account-appearance">
        Appearance
      </h2>
      <div className="appearance__segments" role="radiogroup" aria-labelledby="account-appearance">
        {THEME_CHOICES.map((value) => (
          <label key={value} className={`appearance__segment${choice === value ? ' appearance__segment--on' : ''}`}>
            <input
              type="radio"
              name="account-theme"
              value={value}
              checked={choice === value}
              onChange={() => pick(value)}
            />
            <span>{LABEL[value]}</span>
          </label>
        ))}
      </div>
      <p className="appearance__note">System follows your device. The choice is kept in this browser.</p>
    </section>
  );
}
