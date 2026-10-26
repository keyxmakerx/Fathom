// The vault on the avatar (mockup r32-vault-look-menu, approved 25 Oct): a small lock badge while
// any vault is unlocked in this tab, and in the avatar menu how long is left and Lock now. There
// is no lock button of its own in the bar.

import { PopoverRow } from '../shell/Popover';
import { UNLOCK_MINUTES, lockVault } from '../../vault/session';
import { useMinuteTick } from './parts';
import { useVaultUnlocked } from './useVault';

import './vault.css';

export function VaultBadge() {
  const unlocked = useVaultUnlocked();
  if (!unlocked) return null;
  return (
    <span className="vault-badge" aria-hidden="true" data-testid="vault-badge">
      <svg viewBox="0 0 10 10">
        <rect x="1.5" y="4.5" width="7" height="5" fill="currentColor" />
        <path d="M3 4.5V3a2 2 0 0 1 4 0v1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
      </svg>
    </span>
  );
}

/** The avatar menu's vault rows, above the caller's own rows. Nothing while locked. */
export function VaultMenuRows() {
  const unlocked = useVaultUnlocked();
  const now = useMinuteTick();
  if (!unlocked) return null;
  const minutes = Math.max(1, Math.min(UNLOCK_MINUTES, Math.ceil((unlocked.until - now) / 60_000)));
  return (
    <>
      <div className="vault-menu" data-testid="vault-menu">
        <span className="vault-menu__title">Vault unlocked</span>
        <span className="vault-small">Locks itself in {minutes === 1 ? '1 minute' : `${minutes} minutes`}</span>
      </div>
      <PopoverRow onSelect={lockVault} testId="vault-lock-now">
        Lock now
      </PopoverRow>
    </>
  );
}
