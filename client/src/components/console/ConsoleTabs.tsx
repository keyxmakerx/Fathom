import './console.css';

/** The console's sections, in the order they are offered. */
export type ConsoleSection = 'accounts' | 'organisations' | 'operators' | 'ai' | 'activity' | 'settings' | 'issued';

const LABEL: Record<ConsoleSection, string> = {
  accounts: 'Accounts',
  organisations: 'Organisations',
  operators: 'Operators',
  ai: 'AI',
  activity: 'Activity',
  settings: 'Settings',
  issued: 'Issued',
};

/** Accounts first, because that is what the owner opens Admin to do (invite
 * someone); "Issued" only once this session has minted something, since until
 * then it would be an empty tab. A function so a runner with no DOM can check
 * the order. */
export function consoleSections(anyMinted: boolean): ConsoleSection[] {
  const base: ConsoleSection[] = ['accounts', 'organisations', 'operators', 'ai', 'activity', 'settings'];
  return anyMinted ? [...base, 'issued'] : base;
}

export interface ConsoleTabsProps {
  sections: readonly ConsoleSection[];
  current: ConsoleSection;
  onSelect: (section: ConsoleSection) => void;
}

/**
 * Accounts · Organisations · Operators · AI · Activity · Settings (· Issued). One section at
 * a time instead of one long page, because the owner got lost in it on
 * 2026-10-12 ("it's easy to navigate. i got lost when i tried to accept her
 * invite"). The look is Home's tab row (`home/home.css`), restated under the
 * console's own class names so neither screen's stylesheet leans on the other.
 */
export function ConsoleTabs({ sections, current, onSelect }: ConsoleTabsProps) {
  return (
    <div className="console__tabs" role="tablist" aria-label="Admin sections">
      {sections.map((section) => (
        <button
          key={section}
          type="button"
          role="tab"
          aria-selected={section === current}
          className={section === current ? 'console__tab console__tab--on' : 'console__tab'}
          data-testid={`console-tab-${section}`}
          onClick={() => onSelect(section)}
        >
          {LABEL[section]}
        </button>
      ))}
    </div>
  );
}
