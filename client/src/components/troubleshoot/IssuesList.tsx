// Issues as an Inventory kind (ADR-0061 troubleshooting): the saved "It's down" sessions, newest first. Read only;
// the checklist itself opens from the canvas.
import type { Document } from '../../document/model';
import { listIssues } from '../../document/issues';
import { nameOf } from '../plans/plansModel';
import { whenText } from './troubleModel';

export function IssuesList({ doc }: { doc: Document }) {
  const issues = listIssues(doc);
  return (
    <table className="inventory-place__grid" data-testid="issues-list">
      <thead>
        <tr>
          <th aria-hidden="true" />
          <th>Issue</th>
          <th>Device</th>
          <th>Opened</th>
          <th>State</th>
          <th>Where the answers pointed</th>
        </tr>
      </thead>
      <tbody>
        {issues.length === 0 ? (
          <tr>
            <td colSpan={6} className="inventory-place__muted">
              No issues yet. Right-click a device on the canvas and choose It's down.
            </td>
          </tr>
        ) : (
          issues.map((i) => (
            <tr key={i.id} className="inventory-place__row">
              <td aria-hidden="true" />
              <td>{i.title}</td>
              <td>{nameOf(doc, (id) => id, i.deviceId)}</td>
              <td>{whenText(i.openedAt)}</td>
              <td>{i.stage}</td>
              <td>{i.outcome.split('\n')[0]}</td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}
