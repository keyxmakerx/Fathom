// "About this platform" in a device's panel: the platform's read-this-first explainers, one line
// each with a way into the whole thing (ADR-0066 item 1.1). Nothing shows for a device with no
// platform recorded or a platform nobody has written about yet.

import { Fold } from '../drawing/Fold';
import { useLearn } from './context';
import { aboutPlatform, titleOf } from './explainers';
import { Prose, UnreviewedMark } from './LearnOverlay';

/** `folded`: the canvas panel shows it as one line (r30-device), the first explainer's title. */
export function AboutSection({ deviceId, folded = false }: { deviceId: string; folded?: boolean }) {
  const api = useLearn();
  if (!api || api.status !== 'ready') return null;
  const entries = aboutPlatform(api.explainers, api.platformOf(deviceId));
  if (entries.length === 0) return null;
  const [first, ...rest] = entries;
  const body = (
    <div className="drawing-editor__field learn-about" data-testid="learn-about">
      {folded ? null : <div className="drawing-editor__group">Learn</div>}
      <div className="learn-about__title">
        {titleOf(first!)} <UnreviewedMark e={first!} />
      </div>
      {first!.terse ? (
        <div className="learn-about__terse">
          <Prose text={first!.terse} />
        </div>
      ) : null}
      <button type="button" className="learn-link" onClick={() => api.openExplainer(first!.id)}>
        Read more
      </button>
      {rest.length > 0 ? (
        <ul className="learn-about__more">
          {rest.map((e) => (
            <li key={e.id}>
              <button type="button" className="learn-link" onClick={() => api.openExplainer(e.id)}>
                {titleOf(e)}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
  if (!folded) return body;
  return (
    <Fold title="Learn" summary={titleOf(first!)} testId="learn-fold">
      {body}
    </Fold>
  );
}
