import type { HomeTab } from './homeTabs';
import './home.css';

const LABEL: Record<HomeTab, string> = { designs: 'Designs', work: 'Work', teams: 'Teams', passwords: 'Passwords', organisation: 'Steward', ai: 'AI', admin: 'Admin' };

export interface HomeTabsProps {
  tabs: readonly HomeTab[];
  current: HomeTab;
  onSelect: (tab: HomeTab) => void;
  /** `data-testid` per tab, for the browser drives. */
  testIds?: Partial<Record<HomeTab, string>>;
}

/** Designs · Passwords · Steward, and Admin set apart at the right end (ADR-0060 decision 7, r116). Drawn only
 * when there is more than one to choose between. */
export function HomeTabs({ tabs, current, onSelect, testIds }: HomeTabsProps) {
  if (tabs.length < 2) return null;
  return (
    <div className="home-tabs" role="tablist" aria-label="Home">
      {tabs.map((tab) => (
        <button
          key={tab}
          type="button"
          role="tab"
          aria-selected={tab === current}
          className={[
            'home-tabs__tab',
            tab === current ? 'home-tabs__tab--on' : '',
            // r116: Admin is the server's, not the organisation's: at the right end, set apart.
            tab === 'admin' ? 'home-tabs__tab--apart' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          data-testid={testIds?.[tab]}
          onClick={() => onSelect(tab)}
        >
          {LABEL[tab]}
        </button>
      ))}
    </div>
  );
}
