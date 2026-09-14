import '../styles/shell.css';
import { Centre } from './Centre';
import { Inspector } from './Inspector';
import { LeftRail } from './LeftRail';
import { Masthead } from './Masthead';

interface ShellProps {
  address: string;
}

/** The application shell — masthead, left rail, centre, right inspector —
 * per `docs/UI-SPEC.md` "The shape". Static content only in this slice. */
export function Shell({ address }: ShellProps) {
  return (
    <div className="shell">
      <Masthead address={address} />
      <LeftRail />
      <Centre />
      <Inspector />
    </div>
  );
}
