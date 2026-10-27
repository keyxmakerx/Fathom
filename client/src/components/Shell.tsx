import { useCallback, useEffect, useRef, useState } from 'react';

import '../styles/shell.css';
import { Bar } from './shell/Bar';
import { useElementWidth, useWindowWidth } from './shell/Dock';
import { fitPanels, loadPanelWidth, panelMax, savePanelWidth, PANEL_DEFAULT, type PanelId } from './shell/panelSizing';
import { PANEL_OF, RightDock } from './shell/RightDock';
import { BottomPill, CanvasStrip } from './shell/CanvasBar';
import { PlacesMap } from './places/PlacesMap';
import { focusFor, upperStopsFor, type UpperStop } from './places/placesMap';
import { MIN_ZOOM } from './drawing/geometry';
import { nextActive, SideSlots } from './shell/sideSlot';
import { rememberedTab, useRightTab, type RightTab } from './shell/useRightTab';
import { loadResume, patchResume } from './design/resume';
import { isTypingTarget, matches } from './shell/shortcuts';
import type { ShellProps } from './shell/types';

export type {
  AccountInfo,
  Lens,
  PathItem,
  PathPart,
  Place,
  PresenceUser,
  ShellProps,
} from './shell/types';
export { LENSES, LENS_LABEL, isLensLit, pathToItems } from './shell/types';

/**
 * The application shell — the bar, the folded rail strip, the drawing, and
 * the editor surface, per the board the owner approved 2026-09-16
 * (`design/shell/Main.dc.html`, `docs/decisions/adr-0047-*`). Driven
 * entirely by props: no sample data lives here. See `./shell/types.ts` for
 * the full contract.
 */
export function Shell({
  place,
  onPlaceChange,
  path,
  tree,
  lens,
  onLensChange,
  look,
  layers,
  views,
  viewsFolded,
  presence,
  zoom,
  onZoomIn,
  onZoomOut,
  onZoomFit,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onPrint,
  onShare,
  onDocs,
  onHistory,
  historyOpen,
  account,
  editor,
  history,
  selectionKey,
  resume,
  notices,
  noticeField,
  noticeElement,
  announce,
  rail,
  autoEquipment,
  equipmentRequest,
  trail,
  trailOpen,
  onTrailOpenChange,
  children,
  viewOnly,
  barExtra,
  band,
  menu,
  adminPill,
  onHome,
  search,
  cablesGroupsSummary,
  hiddenCablesCount,
  onShowAllHiddenCables,
  sideTabs,
  mainView,
  designExtra,
  doing,
  layersExtra,
  zoomStops,
  places,
  task,
  cablesGroupsPopover: groupsPopover,
}: ShellProps) {
  // r31-bar A: on the drawing, its own controls sit on it (a strip top left, a pill at the bottom), not in the bar.
  const toolsOnCanvas = place === 'racks';

  // ADR-0074: above the closet the same camera goes on to the building, the site and every site,
  // drawn from the folders over the canvas, which stays mounted beneath.
  const [above, setAbove] = useState<{ stop: UpperStop; focusId: string | null } | null>(null);
  const currentScopeId = places?.currentScopeId ?? null;
  useEffect(() => setAbove(null), [currentScopeId]);
  const upper = places && zoomStops ? upperStopsFor(places.scopes, places.currentScopeId) : [];
  const goUp = (stop: UpperStop) => places && setAbove({ stop, focusId: focusFor(places.scopes, stop, places.currentScopeId) });
  const UPPER_LABEL: Record<UpperStop, string> = { estate: 'Every site', site: 'Site', building: 'Building' };
  const pillStops: ShellProps['zoomStops'] =
    zoomStops && upper.length > 0
      ? {
          stops: [...[...upper].reverse().map((id) => ({ id, label: UPPER_LABEL[id] })), ...zoomStops.stops],
          current: above?.stop ?? zoomStops.current,
          onGo: (id) => {
            if ((upper as string[]).includes(id)) return goUp(id as UpperStop);
            setAbove(null);
            zoomStops.onGo(id);
          },
        }
      : zoomStops;
  // Zooming out past the closet goes up a stop; zooming in from the nearest one comes back down.
  const zoomOut = () => {
    if (above) {
      const next = upper[upper.indexOf(above.stop) + 1];
      if (next) goUp(next);
      return;
    }
    if (upper.length > 0 && zoom <= MIN_ZOOM * 100 + 1) return goUp(upper[0]);
    onZoomOut();
  };
  const zoomIn = () => {
    if (!above) return onZoomIn();
    const at = upper.indexOf(above.stop);
    if (at <= 0) setAbove(null);
    else goUp(upper[at - 1]);
  };
  // The notice sits under its field when the open panel shows it; otherwise in the canvas corner.
  const [anchored, setAnchored] = useState(false);
  const inEditor = editor != null && anchored;

  // The side panels: Equipment, Details, History and Trail share one slot on the right, one open at a time.
  // It folds to a strip of labelled tabs, slides, and is resized by its handle, and the canvas keeps its width.
  const accountId = resume?.accountId ?? null;
  const designId = resume?.designId;
  const [stored] = useState(() => (designId != null ? loadResume(accountId, designId) : null));
  const rememberPick = useCallback(
    (pick: RightTab | null) => {
      if (designId != null) patchResume(accountId, designId, { tab: rememberedTab(pick), equipmentOpen: pick === 'equipment' });
    },
    [accountId, designId],
  );
  const rememberEquipmentClosed = useCallback(() => {
    if (designId != null) patchResume(accountId, designId, { equipmentClosedOnce: true });
  }, [accountId, designId]);
  const { shown, choose, fold } = useRightTab({
    hasEquipment: rail != null,
    initialEquipment: stored?.equipmentOpen ?? false,
    hasDetails: editor != null,
    historyOpen: historyOpen ?? false,
    trailOpen: trailOpen ?? false,
    hasTrail: trail != null,
    selectionKey: selectionKey ?? null,
    initialTab: stored?.tab ?? null,
    restoredKey: stored?.selection?.id ?? null,
    onHistory,
    onTrailOpenChange,
    onPick: rememberPick,
    equipmentClosedOnce: stored?.equipmentClosedOnce ?? false,
    onEquipmentClosed: rememberEquipmentClosed,
    autoEquipment,
    equipmentRequest,
  });
  // r30-panels: a side tab that opens takes the panel; one that closes gives it back.
  const [sideActive, setSideActive] = useState<string | null>(null);
  const sideWasOpen = useRef<Record<string, boolean>>({});
  useEffect(() => {
    const tabs = sideTabs ?? [];
    const next = nextActive(sideActive, sideWasOpen.current, tabs);
    sideWasOpen.current = Object.fromEntries(tabs.map((t) => [t.id, t.open]));
    if (next !== sideActive) setSideActive(next);
  });
  const [sideEls, setSideEls] = useState<Record<string, HTMLElement | null>>({});
  const sideRefs = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const sideRef = useCallback((id: string) => {
    let ref = sideRefs.current.get(id);
    if (ref == null) {
      ref = (el) => setSideEls((now) => (now[id] === el ? now : { ...now, [id]: el }));
      sideRefs.current.set(id, ref);
    }
    return ref;
  }, []);
  const slotIds = [...(sideTabs ?? []).map((t) => t.id), ...(toolsOnCanvas ? ['canvas-tools', 'jump-trail'] : [])];
  const slots = sideTabs == null && !toolsOnCanvas ? null : Object.fromEntries(slotIds.map((id) => [id, sideEls[id] ?? null]));
  const chooseRight = useCallback(
    (t: RightTab) => {
      setSideActive(null);
      choose(t);
    },
    [choose],
  );

  const [wants, setWants] = useState<Record<PanelId, number>>(() => ({
    rail: loadPanelWidth('rail'),
    details: loadPanelWidth('details'),
    history: loadPanelWidth('history'),
    trail: loadPanelWidth('trail'),
  }));
  const resizePanel = useCallback((panel: PanelId, width: number, commit: boolean) => {
    setWants((w) => ({ ...w, [panel]: width }));
    if (commit) savePanelWidth(panel, width);
  }, []);
  const resetPanel = useCallback((panel: PanelId) => {
    setWants((w) => ({ ...w, [panel]: PANEL_DEFAULT[panel] }));
    savePanelWidth(panel, PANEL_DEFAULT[panel]);
  }, []);
  const [resizing, setResizing] = useState(false);
  const windowWidth = useWindowWidth();
  const [bodyRef, bodyWidth] = useElementWidth<HTMLDivElement>();
  const lastRight = useRef<RightTab>(rail != null ? 'equipment' : 'details');
  if (shown != null) lastRight.current = shown;
  const rightPresent = rail != null || editor != null || onHistory != null || trail != null || (sideTabs?.length ?? 0) > 0;
  const stripsWidth = rightPresent ? 28 : 0;
  const fit = fitPanels({
    bodyWidth,
    windowWidth,
    stripsWidth,
    left: null,
    right: sideActive != null ? wants.details : shown != null ? wants[PANEL_OF[shown]] : null,
  });
  // While a panel slides shut its slot still needs a width to shrink from.
  const lastWidths = useRef({ right: wants[PANEL_OF[lastRight.current]] });
  useEffect(() => {
    if (fit.right > 0) lastWidths.current.right = fit.right;
  });
  const rightWidth = fit.right > 0 ? fit.right : Math.min(lastWidths.current.right, wants[PANEL_OF[lastRight.current]]);
  const rightMax = panelMax(windowWidth, bodyWidth, stripsWidth, 0);

  // The bar's zoom buttons from the keyboard, on the canvas only and never while typing.
  useEffect(() => {
    if (place !== 'racks') return undefined;
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || isTypingTarget(event.target)) return;
      const act = matches(event, 'zoom-in') ? onZoomIn : matches(event, 'zoom-out') ? onZoomOut : matches(event, 'zoom-fit') ? onZoomFit : undefined;
      if (act == null) return;
      event.preventDefault();
      act();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [place, onZoomIn, onZoomOut, onZoomFit]);

  return (
    <div className="shell">
      {announce !== undefined && (
        <div className="shell__sr-only" role="status" aria-live="polite">
          {announce}
        </div>
      )}
      <Bar
        place={place}
        onPlaceChange={onPlaceChange}
        path={path}
        tree={tree}
        lens={lens}
        onLensChange={onLensChange}
        look={look}
        layers={layers}
        views={views}
        viewsFolded={viewsFolded}
        presence={presence}
        zoom={zoom}
        onZoomIn={onZoomIn}
        onZoomOut={onZoomOut}
        onZoomFit={onZoomFit}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={onUndo}
        onRedo={onRedo}
        onPrint={onPrint}
        onShare={onShare}
        onDocs={onDocs}
        onHistory={onHistory}
        historyOpen={historyOpen}
        account={account}
        viewOnly={viewOnly}
        barExtra={barExtra}
        menu={menu}
        adminPill={adminPill}
        onHome={onHome}
        search={search}
        cablesGroupsPopover={groupsPopover}
        cablesGroupsSummary={cablesGroupsSummary}
        hiddenCablesCount={hiddenCablesCount}
        onShowAllHiddenCables={onShowAllHiddenCables}
        mainView={mainView}
        designExtra={designExtra}
        doing={doing}
        toolsOnCanvas={toolsOnCanvas}
        task={task}
      />
      {band}
      <div className="shell__body" ref={bodyRef} data-resizing={resizing ? '' : undefined}>
        <main className="shell__drawing" aria-label="Drawing">
          <SideSlots.Provider value={slots}>{children}</SideSlots.Provider>
          {toolsOnCanvas && above && places && (
            <PlacesMap
              scopes={places.scopes}
              currentScopeId={places.currentScopeId}
              stop={above.stop}
              focusId={above.focusId}
              designScopeIds={places.designScopeIds}
              onGo={(stop, focusId) => setAbove({ stop, focusId })}
              onOpenScope={places.onOpenScope}
              onBack={() => setAbove(null)}
              floorPlan={places.floorPlan}
            />
          )}
          {toolsOnCanvas && (
            <>
              {/* Lenses and layers are the canvas's; above the closet there is no canvas to set them on. */}
              {!above && <CanvasStrip
                place="racks"
                lens={lens}
                onLensChange={onLensChange}
                cablesGroupsPopover={groupsPopover}
                cablesGroupsSummary={cablesGroupsSummary}
                layers={layers}
                look={look}
                layersExtra={layersExtra}
                views={views}
                hiddenCablesCount={hiddenCablesCount}
                onShowAllHiddenCables={onShowAllHiddenCables}
                slotRef={sideRef}
              />}
              <BottomPill canUndo={canUndo} canRedo={canRedo} onUndo={onUndo} onRedo={onRedo} zoom={{ value: zoom, onIn: zoomIn, onOut: zoomOut, onFit: above ? undefined : onZoomFit, stops: pillStops }} />
            </>
          )}
          {!inEditor && notices != null && <div className="shell__notices-corner">{notices}</div>}
        </main>
        {/* One right-hand slot: Equipment, Details, History and the Trail are its tabs; one is open at a time. */}
        <RightDock
          shown={shown}
          equipment={rail ?? null}
          details={editor}
          history={history ?? null}
          trail={trail ?? null}
          canOpenHistory={onHistory != null}
          historyLive={historyOpen ?? false}
          editorProps={{ notices, noticeField, noticeElement, onAnchored: setAnchored }}
          width={rightWidth}
          max={rightMax}
          onChoose={chooseRight}
          onFold={fold}
          onResize={resizePanel}
          onReset={resetPanel}
          onDragging={setResizing}
          side={sideTabs}
          active={sideActive}
          onActivate={setSideActive}
          slotRef={sideRef}
        />
      </div>
    </div>
  );
}
