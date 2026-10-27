// The field view's tabs along the bottom, in reach of a thumb (ADR-0075 decision 1): Scan, Find (the
// Inventory, which already folds to one column) and Canvas (to look at, not to edit), and Ideas while
// an AI idea is waiting (ADR-0075).

import type { Place } from '../shell/types';
import './phone.css';

export interface PhoneTabsProps {
  place: Place;
  onPlaceChange(place: Place): void;
  onScan(): void;
  scanning: boolean;
  /** Open AI ideas on this design; the tab shows only while there are some. */
  ideas?: number;
  ideasOpen?: boolean;
  onIdeas?(): void;
}

export function PhoneTabs({ place, onPlaceChange, onScan, scanning, ideas = 0, ideasOpen = false, onIdeas }: PhoneTabsProps) {
  const tab = (label: string, on: boolean, act: () => void) => (
    <button type="button" className={on ? 'phone-tabs__tab phone-tabs__tab--on' : 'phone-tabs__tab'} aria-pressed={on} onClick={act}>
      {label}
    </button>
  );
  return (
    <nav className="phone-tabs" aria-label="Field view">
      {tab('Scan', scanning, onScan)}
      {tab('Find', !scanning && !ideasOpen && place === 'inventory', () => onPlaceChange('inventory'))}
      {tab('Canvas', !scanning && !ideasOpen && place === 'racks', () => onPlaceChange('racks'))}
      {(ideas > 0 || ideasOpen) && onIdeas && tab(`Ideas ${ideas}`, ideasOpen, onIdeas)}
    </nav>
  );
}
