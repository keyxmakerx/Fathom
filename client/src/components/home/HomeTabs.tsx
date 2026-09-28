import type { HomeTab } from './homeTabs';
import './home.css';

const LABEL: Record<HomeTab, string> = { designs: 'Designs', organisation: 'Organisation', admin: 'Admin' };

export interface HomeTabsProps {
  tabs: readonly HomeTab[];
  current: HomeTab;
  onSelect: (tab: HomeTab) => void;
  /** `data-testid` per tab, for the browser drives. */
  testIds?: Partial<Record<HomeTab, string>>;
}

/** Designs · Organisation · Admin (ADR-0060 decision 7). Drawn only when there
 * is more than one to choose between. */
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
          className={tab === current ? 'home-tabs__tab home-tabs__tab--on' : 'home-tabs__tab'}
          data-testid={testIds?.[tab]}
          onClick={() => onSelect(tab)}
        >
          {LABEL[tab]}
        </button>
      ))}
    </div>
  );
}
