import './history.css';

export interface SaveBannerProps {
  /** Which save is on show, in words. */
  words: string;
  /** Leaves the save for the design as it is now. */
  onBack: () => void;
}

/** The line over the canvas while a past save is shown, with its own way back to now. The canvas bar places it
 * (`.shell-canvas-bar__note`). Only the words are the status: the button is not read out with them. */
export function SaveBanner({ words, onBack }: SaveBannerProps) {
  return (
    <div className="history-banner" data-testid="history-banner">
      <span className="history-banner__words" role="status">
        {words}
      </span>
      <button type="button" className="btn-small history-banner__back" data-testid="history-banner-back" onClick={onBack}>
        Back to now
      </button>
    </div>
  );
}
