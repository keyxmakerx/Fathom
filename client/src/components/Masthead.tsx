import { signOut } from '../api/auth';
import { ThemeToggle } from './ThemeToggle';

interface MastheadProps {
  address: string;
}

/**
 * `docs/UI-SPEC.md` "The shape": scope breadcrumb, cable-kind toggles,
 * port-colour mode, who else is here, zoom. Static for this slice — there
 * is no diagram yet for any of these to act on, so the controls that would
 * eventually drive it are rendered disabled rather than wired to nothing.
 */
export function Masthead({ address }: MastheadProps) {
  async function handleSignOut() {
    await signOut();
  }

  return (
    <header className="masthead">
      <span className="masthead__brand">Fathom</span>
      <span className="masthead__breadcrumb">No organisation selected</span>
      <div className="masthead__spacer" />
      <button type="button" className="masthead__control" disabled>
        Cable: all
      </button>
      <button type="button" className="masthead__control" disabled>
        Port colour: type
      </button>
      <button type="button" className="masthead__control" disabled>
        Zoom: 100%
      </button>
      <ThemeToggle />
      <div className="masthead__account">
        <span>{address}</span>
        <button type="button" className="masthead__control" onClick={handleSignOut}>
          Sign out
        </button>
      </div>
    </header>
  );
}
