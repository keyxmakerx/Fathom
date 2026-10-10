import { useState } from 'react';

import { getThemeChoice, setThemeChoice, THEME_NAME, THEME_ORDER, type ThemeChoice } from '../../theme';
import '../../styles/theme-menu.css';

/** The account menu's Theme list: Dark, Light or Follow my system, the current one ticked. The
 * change shows at once; the menu stays open until it is closed. */
export function ThemeMenu() {
  const [choice, setChoice] = useState<ThemeChoice>(() => getThemeChoice());
  const pick = (next: ThemeChoice) => {
    setChoice(next);
    setThemeChoice(next);
  };
  return (
    <div className="theme-menu" role="group" aria-label="Theme">
      <div className="theme-menu__head">Theme</div>
      {THEME_ORDER.map((value) => (
        <button
          key={value}
          type="button"
          role="menuitemradio"
          aria-checked={choice === value}
          className={choice === value ? 'theme-menu__row theme-menu__row--on' : 'theme-menu__row'}
          data-testid={`theme-${value}`}
          onClick={() => pick(value)}
        >
          <span className="theme-menu__box" aria-hidden="true">
            {choice === value ? '☑' : '☐'}
          </span>
          {THEME_NAME[value]}
        </button>
      ))}
    </div>
  );
}
