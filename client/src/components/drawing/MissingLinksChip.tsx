import { Popover, usePopoverClose } from '../shell/Popover';
import { looseEndText, missingLinkCount, type LooseEnd, type MissingLinks } from './missingLinks';
import '../../styles/missing-links.css';

/** The bar's "Missing links · N": cables Fathom found, from the drawing, that a person marked
 * Needs finishing. Hidden when none. It opens the list; "Go" on a row selects that cable and brings
 * it into view. Below, a folded "Unknown (n)" lists the loose ends nobody has marked, not counted.
 * Nothing here is typed: it is all read off the drawing. */
export function MissingLinksChip({ found, onGo }: { found: MissingLinks; onGo: (end: LooseEnd) => void }) {
  const n = missingLinkCount(found);
  if (n === 0) return null;
  return (
    <Popover
      align="right"
      renderTrigger={({ open, triggerProps, triggerRef }) => (
        <button
          type="button"
          className="shell-chip shell-chip--ink missing-links__chip"
          data-testid="missing-links-chip"
          aria-label={`Missing links, ${n}`}
          aria-pressed={open}
          ref={(el) => {
            triggerRef.current = el;
          }}
          {...triggerProps}
        >
          Missing links · {n}
        </button>
      )}
    >
      <MissingLinksList found={found} onGo={onGo} />
    </Popover>
  );
}

function Row({ end, onGo }: { end: LooseEnd; onGo: (end: LooseEnd) => void }) {
  const close = usePopoverClose();
  return (
    <li className="missing-links__row" data-testid="missing-links-row" data-cable-id={end.id}>
      <span className="missing-links__text">
        {looseEndText(end)}
        {end.label != null ? <span className="missing-links__sub">{end.label}</span> : null}
      </span>
      <button
        type="button"
        className="btn-quiet"
        onClick={() => {
          close();
          onGo(end);
        }}
      >
        Go
      </button>
    </li>
  );
}

/** The list itself, without the popover, so it can be rendered and tested on its own. */
export function MissingLinksList({ found, onGo }: { found: MissingLinks; onGo: (end: LooseEnd) => void }) {
  return (
    <div className="missing-links" data-testid="missing-links-list">
      <h2 className="missing-links__title">Missing links · {missingLinkCount(found)}</h2>
      <p className="missing-links__note">Found by Fathom from the drawing. Nothing here is typed.</p>
      <ul className="missing-links__list">
        {found.needsFinishing.map((end) => (
          <Row key={end.id} end={end} onGo={onGo} />
        ))}
      </ul>
      {found.unknown.length > 0 ? (
        <details className="missing-links__unknown" data-testid="missing-links-unknown">
          <summary>Unknown ({found.unknown.length})</summary>
          <p className="missing-links__note">Nobody has said what is at the far end. These are not counted.</p>
          <ul className="missing-links__list">
            {found.unknown.map((end) => (
              <Row key={end.id} end={end} onGo={onGo} />
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
