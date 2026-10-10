// A device's page, the troubleshooting half (ADR-0061): the "It's down" button for someone who can edit, and the
// issues saved against the device (or that lit it) for anyone who can read. Plain buttons; no colour.
import { historyLine } from './troubleModel';
import type { TroubleController } from './useTroubleController';
import './trouble.css';

/** The "It's down" button alone, quiet, for the head of a device's panel. */
export function ItsDownButton({ controller, chassisId }: { controller: TroubleController; chassisId: string }) {
  if (!controller.canEdit) return null;
  return (
    <button type="button" className="btn-quiet" onClick={() => controller.start(chassisId)} data-testid="its-down-button">
      It's down
    </button>
  );
}

export function DeviceIssues({ controller, chassisId, deviceId, withButton = true }: { controller: TroubleController; chassisId: string; deviceId: string; withButton?: boolean }) {
  const issues = controller.issuesOf(deviceId);
  if ((!withButton || !controller.canEdit) && issues.length === 0) return null;
  return (
    <section className="trouble-history" aria-label="Issues" data-testid="device-issues">
      {withButton && controller.canEdit && (
        <button type="button" className="trouble-btn" onClick={() => controller.start(chassisId)} data-testid="its-down-button">
          It's down
        </button>
      )}
      {issues.length > 0 && (
        <>
          <h3 className="trouble-label">Issues · {issues.length}</h3>
          <ul className="trouble-history__list">
            {issues.map((i) => (
              <li key={i.id}>
                <button type="button" className="trouble-link" onClick={() => controller.openIssue(i.id)} data-testid="device-issue">
                  {historyLine(i)}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
