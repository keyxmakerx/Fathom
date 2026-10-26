import { commandParts, type CommandPart } from './typeItYourself';
import './typing.css';

/**
 * One command shown to be typed: each part with what it is under it, in order, one space between each.
 * The text is not selectable while this is drawn. A part that is a one-time link is shown masked as
 * `shownLink`, because the link has its own copy and is not something to learn by typing.
 */
export function CommandToType({ command, link, shownLink }: { command: string; link?: string; shownLink?: string }) {
  const parts = commandParts(command, link);
  if (parts.length === 0) return null;
  return (
    <span className="type-cmd" data-testid="type-cmd" aria-label={`Type: ${parts.map((p) => partText(p, link, shownLink)).join(' ')}`}>
      {parts.map((p, i) => (
        <span key={i} className={`type-cmd__part type-cmd__part--${p.label.replace(' ', '-')}`}>
          <span className="type-cmd__text" aria-hidden="true">
            {partText(p, link, shownLink)}
          </span>
          <span className="type-cmd__label" aria-hidden="true">
            {p.label}
          </span>
        </span>
      ))}
    </span>
  );
}

function partText(p: CommandPart, link?: string, shownLink?: string): string {
  return link !== undefined && shownLink !== undefined ? p.text.split(link).join(shownLink) : p.text;
}

/** The one line that says how to read the parts, said once above a list of them. */
export function TypeItYourselfNote() {
  return (
    <p className="type-note" data-testid="type-note">
      Commands are shown to be typed: one space between each part. Links and hashes still copy.
    </p>
  );
}
