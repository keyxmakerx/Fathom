// What a plan puts over the canvas: the side panel, or the whole list page when that view is on.
import { PlanListPage } from './PlanListPage';
import { PlanPanel } from './PlanPanel';
import type { PlansController } from './usePlansController';
import { InSideSlot } from '../shell/sideSlot';

export function PlansSurface({ controller, besideChecks }: { controller: PlansController; besideChecks: boolean }) {
  const { plan } = controller;
  if (plan == null) return null;
  if (controller.listMode) return <PlanListPage controller={controller} plan={plan} />;
  return controller.panelOpen ? (
    <InSideSlot id="plan">
      <PlanPanel controller={controller} plan={plan} besideChecks={besideChecks} />
    </InSideSlot>
  ) : null;
}
