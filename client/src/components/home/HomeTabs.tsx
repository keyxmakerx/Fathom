import { useLayoutEffect, useRef, useState } from 'react';

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
  const rowRef = useRef<HTMLDivElement>(null);
  // The line under the chosen tab is one mark that slides to the next, as under the bar's views. Until the row
  // has been measured, the chosen tab draws its own line.
  const [mark, setMark] = useState<{ left: number; width: number } | null>(null);
  const shown = tabs.join(' ');
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (row == null) return undefined;
    const measure = () => {
      const on = row.querySelector<HTMLElement>('[aria-selected="true"]');
      setMark((prev) => {
        if (on == null) return null;
        if (prev != null && prev.left === on.offsetLeft && prev.width === on.offsetWidth) return prev;
        return { left: on.offsetLeft, width: on.offsetWidth };
      });
    };
    measure();
    // A tab changes width when its font arrives or the window narrows; the row alone would not say so.
    const watch = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    watch?.observe(row);
    for (const tab of Array.from(row.children)) watch?.observe(tab);
    return () => watch?.disconnect();
  }, [shown, current]);

  if (tabs.length < 2) return null;
  return (
    <div className={mark != null ? 'home-tabs home-tabs--marked' : 'home-tabs'} role="tablist" aria-label="Home" ref={rowRef}>
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
          data-label={LABEL[tab]}
          onClick={() => onSelect(tab)}
        >
          {LABEL[tab]}
        </button>
      ))}
      {mark != null && <span className="home-tabs__mark" aria-hidden="true" style={{ left: mark.left, width: mark.width }} />}
    </div>
  );
}
