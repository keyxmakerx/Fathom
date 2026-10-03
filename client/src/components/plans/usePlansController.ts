// Runs the maintenance plan surface for one open design (ADR-0061 round 7): which plan is open, the engine's
// preview of it, and every command a person gives it. The engine and mirror are the ones the page already
// holds (RacksPlace); this boots nothing itself. Pasted text goes through the gate before it is stored; typed text is
// stored as typed (ADR-0053 section 6), and the form says so.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { FIELD_KEYS } from '../../../../schema/generated/ir_types';
import { IncompatibleConnectorError, PortAlreadyTerminatedError } from '../../document/cables';
import type { Document } from '../../document/model';
import {
  PlanRefusal,
  addStep,
  createPlan,
  currentStep,
  listPlans,
  markDone,
  markWentDifferently,
  moveStep,
  readPlan,
  recordPlan,
  removeStep,
  setPlanHead,
  startPlan,
  type Plan,
  type PlanOutcome,
  TYPED_AS_WRITTEN,
  type TextGate,
} from '../../document/plans';
import type { CheckFinding, PlanStepPreview } from '../../engine/engine';
import type { Mirror } from '../../engine/mirror';
import { buildCanon, CHECKS_DEBOUNCE_MS, isTypingTarget, standingDelay, type Canon } from '../checks/checksModel';
import { buildMarks, buildStep, changedMarks, EMPTY_FORM, focusKeys, planEscTarget, prefillFor, stepCheck, titleFor, type StepForm } from './plansModel';
import { createPlansStore, type PlansStore } from './plansStore';

const STORAGE_KEY = 'fathom.plans.panel';

export interface PlanPanelPrefs {
  x: number;
  y: number;
  /** null = not chosen: open whenever a plan is. */
  open: boolean | null;
}

export function loadPanelPrefs(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): PlanPanelPrefs {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return { x: 0, y: 0, open: null };
    const v = JSON.parse(raw) as Partial<PlanPanelPrefs>;
    return {
      x: typeof v.x === 'number' && Number.isFinite(v.x) ? v.x : 0,
      y: typeof v.y === 'number' && Number.isFinite(v.y) ? v.y : 0,
      open: typeof v.open === 'boolean' ? v.open : null,
    };
  } catch {
    return { x: 0, y: 0, open: null };
  }
}

function savePanelPrefs(p: PlanPanelPrefs, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    // Private mode or a full disk: the panel just forgets where it was.
  }
}

/** A sentence for a refused command: the plan's own words, never a code, an id or the engine's text. */
export function refusalText(e: unknown): string {
  if (e instanceof PlanRefusal) return e.message.charAt(0).toUpperCase() + e.message.slice(1) + (/[.!?]$/.test(e.message) ? '' : '.');
  if (e instanceof IncompatibleConnectorError) return 'That cable cannot be made: the port connectors do not pair.';
  if (e instanceof PortAlreadyTerminatedError) return 'That cable cannot be made: one of its ports already has a cable.';
  return 'That did not go through.';
}

/** What a step's edit failing says on the day, with the way out in words. */
export function editFailureText(e: unknown): string {
  const said = e instanceof PlanRefusal || e instanceof IncompatibleConnectorError || e instanceof PortAlreadyTerminatedError ? refusalText(e) : 'That change cannot be made to the design as it stands.';
  return `${said} If it went another way on the day, mark it Went differently.`;
}

export const ENGINE_DOWN = "Fathom's engine did not start, so nothing was changed. Try again.";

const howOf = (pasted: boolean): 'typed' | 'pasted' => (pasted ? 'pasted' : 'typed');

const fieldKey = (name: string): number | undefined => (FIELD_KEYS as Readonly<Record<string, number>>)[name];

export interface PlansController {
  store: PlansStore;
  doc: Document | null;
  canon: Canon;
  plans: Plan[];
  plan: Plan | null;
  canEdit: boolean;
  /** The band shows: a plan is open, or the picker was asked for. */
  bandOpen: boolean;
  setBandOpen(open: boolean): void;
  openPlan(id: string | null): void;
  panelOpen: boolean;
  setPanelOpen(open: boolean): void;
  prefs: PlanPanelPrefs;
  setOffset(x: number, y: number): void;
  listMode: boolean;
  setListMode(on: boolean): void;
  /** Per step, as the engine reads the plan; null before it has answered. */
  preview: PlanStepPreview[] | null;
  unavailable: boolean;
  notice: string | null;
  clearNotice(): void;
  /** The Done a check refused: the step and the finding behind it. */
  refused: { stepId: string; finding: CheckFinding } | null;
  why: CheckFinding | null;
  whyToken: number;
  openWhy(f: CheckFinding, trigger?: HTMLElement | null): void;
  closeWhy(): void;
  showChanges: boolean;
  toggleShowChanges(): void;
  /** Form values the right-click set; the add-step form starts from them. */
  prefill: { token: number; form: StepForm } | null;
  planChange(elementId: string): void;
  // `pasted`: a real paste reached that form (see `PasteMark`); its text goes through the redaction gate.
  create(input: { title: string; windowStart?: string; windowEnd?: string }, pasted?: boolean): Promise<boolean>;
  rename(title: string, pasted?: boolean): Promise<boolean>;
  addStep(form: StepForm, pasted?: boolean): Promise<boolean>;
  removeStep(stepId: string): Promise<boolean>;
  moveStep(stepId: string, index: number): Promise<boolean>;
  start(): Promise<boolean>;
  done(stepId: string): Promise<boolean>;
  wentDifferently(stepId: string, note: string, pasted?: boolean): Promise<boolean>;
  record(outcome: PlanOutcome, text: string, pasted?: boolean): Promise<boolean>;
}

interface Inputs {
  doc: Document | null;
  boot: () => Promise<Mirror>;
  mirrorNow: (load?: boolean) => Mirror | null;
  loadCostMs: () => number | null;
  /** The redaction gate, once the engine is up (`Engine.redactText`); null before. */
  redact: () => TextGate | null;
  applyDocChange: (doc: Document) => void;
  /** `actorOpts(accountId)`. */
  actor: { actor: string } | undefined;
  authorName?: string;
  canEdit: boolean;
  /** A plan to start with open (a link, or a test). */
  initialOpen?: string | null;
}

export function usePlansController({ doc, boot, mirrorNow, loadCostMs, redact, applyDocChange, actor, authorName, canEdit, initialOpen = null }: Inputs): PlansController {
  const [store] = useState(createPlansStore);
  const [openId, setOpenId] = useState<string | null>(initialOpen);
  const [bandShown, setBandShown] = useState(false);
  const [listMode, setListMode] = useState(false);
  const [prefs, setPrefs] = useState<PlanPanelPrefs>(() => loadPanelPrefs());
  const [preview, setPreview] = useState<PlanStepPreview[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [refused, setRefused] = useState<{ stepId: string; finding: CheckFinding } | null>(null);
  const [why, setWhy] = useState<CheckFinding | null>(null);
  const [whyToken, setWhyToken] = useState(0);
  const [showChanges, setShowChanges] = useState(false);
  const [prefill, setPrefill] = useState<{ token: number; form: StepForm } | null>(null);
  const whyTrigger = useRef<HTMLElement | null>(null);
  const tokenRef = useRef(0);
  const latest = useRef({ doc, boot, mirrorNow, loadCostMs, redact, applyDocChange, actor, authorName, canEdit });
  latest.current = { doc, boot, mirrorNow, loadCostMs, redact, applyDocChange, actor, authorName, canEdit };

  const canon = useMemo<Canon>(() => (doc ? buildCanon(doc) : (id) => id), [doc]);
  const plans = useMemo(() => (doc ? listPlans(doc) : []), [doc]);
  const plan = useMemo(() => {
    if (doc == null || openId == null) return null;
    try {
      return readPlan(doc, openId);
    } catch {
      return null;
    }
  }, [doc, openId]);
  const stage = plan?.stage ?? null;
  const planId = plan?.id ?? null;

  // A plan that is gone (undone, or another editor's) closes itself.
  useEffect(() => {
    if (openId != null && doc != null && plan == null) {
      setOpenId(null);
      setListMode(false);
    }
  }, [openId, doc, plan]);

  // What the canvas reads: the stage's colour, the marks, what stays lit. One write per change of the plan.
  const current = plan ? currentStep(plan) : null;
  const focusToken = `${planId ?? ''}|${stage ?? ''}|${current?.id ?? ''}|${showChanges}`;
  const lastFocusToken = useRef('');
  useEffect(() => {
    if (plan == null) {
      if (store.get().stage != null) store.set({ stage: null, marks: [], focus: null });
      lastFocusToken.current = '';
      return;
    }
    const focus = focusKeys(plan, canon, showChanges, doc);
    const marks = plan.stage === 'recorded' && showChanges ? changedMarks(plan, canon, doc) : buildMarks(plan, canon, doc);
    const moved = focus != null && focusToken !== lastFocusToken.current;
    lastFocusToken.current = focusToken;
    if (moved) tokenRef.current += 1;
    store.set({ stage: plan.stage, marks, focus, ...(moved ? { token: tokenRef.current } : {}) });
  }, [plan, canon, doc, showChanges, store, focusToken]);
  useEffect(() => () => store.set({ stage: null, marks: [], focus: null }), [store]);

  // Show these changes belongs to the plan it was asked of.
  useEffect(() => {
    setShowChanges(false);
    setRefused(null);
    setWhy(null);
    setNotice(null);
  }, [planId]);
  useEffect(() => {
    if (stage !== 'recorded') setShowChanges(false);
  }, [stage]);

  // The preview: after the document has been quiet, and never while a pointer is down (a drag is on).
  const pressed = useRef(false);
  useEffect(() => {
    const press = () => {
      pressed.current = true;
    };
    const lift = () => {
      pressed.current = false;
    };
    window.addEventListener('pointerdown', press, true);
    window.addEventListener('pointerup', lift, true);
    window.addEventListener('pointercancel', lift, true);
    window.addEventListener('blur', lift);
    return () => {
      window.removeEventListener('pointerdown', press, true);
      window.removeEventListener('pointerup', lift, true);
      window.removeEventListener('pointercancel', lift, true);
      window.removeEventListener('blur', lift);
    };
  }, []);
  useEffect(() => {
    if (doc == null || planId == null || stage === 'recorded') {
      setPreview(null);
      return undefined;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = () => {
      if (pressed.current) {
        timer = setTimeout(run, CHECKS_DEBOUNCE_MS);
        return;
      }
      latest.current
        .boot()
        .then(() => {
          if (cancelled) return;
          const mirror = latest.current.mirrorNow();
          if (mirror == null) return;
          setPreview(mirror.planPreview(planId));
          setUnavailable(false);
        })
        .catch(() => {
          if (!cancelled) setUnavailable(true);
        });
    };
    timer = setTimeout(run, standingDelay(latest.current.loadCostMs()));
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [doc, planId, stage]);

  const update = useCallback((patch: Partial<PlanPanelPrefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch };
      savePanelPrefs(next);
      return next;
    });
  }, []);

  const closeWhy = useCallback(() => {
    setWhy(null);
    const back = whyTrigger.current;
    whyTrigger.current = null;
    if (back?.isConnected) back.focus();
  }, []);

  // Esc closes the topmost of: the Why card, a notice, the changes shown. Not while typing or in a dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (isTypingTarget(e.target as HTMLElement | null) || isTypingTarget(document.activeElement)) return;
      if (document.querySelector('[role="dialog"], [role="menu"], [aria-modal="true"]') != null) return;
      const which = planEscTarget({ why: why != null, changes: showChanges, notice: notice != null });
      if (which == null) return;
      e.preventDefault();
      if (which === 'why') closeWhy();
      else if (which === 'notice') setNotice(null);
      else setShowChanges(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [why, showChanges, notice, closeWhy]);

  // One door for every command. 'pasted' needs the engine's gate and refuses without it, changing nothing; 'typed'
  // stores the text as typed and needs no engine; 'engine' is Done, which reads the checks. A refusal is said in words.
  const run = useCallback(async (make: (doc: Document, gate: TextGate, mirror: Mirror | null) => Document | null, how: 'typed' | 'pasted' | 'engine' = 'typed'): Promise<boolean> => {
    const now = latest.current;
    if (!now.canEdit) {
      setNotice('You can look at this plan but not change it.');
      return false;
    }
    let mirror: Mirror | null = null;
    if (how !== 'typed') {
      try {
        mirror = await now.boot();
      } catch {
        setNotice(ENGINE_DOWN);
        return false;
      }
    }
    const redact = how === 'pasted' ? latest.current.redact() : null;
    const base = latest.current.doc;
    if (how === 'pasted' && redact == null) {
      setNotice(ENGINE_DOWN);
      return false;
    }
    if (base == null) return false;
    try {
      const gate: TextGate = redact == null ? TYPED_AS_WRITTEN : (t) => redact(t);
      const next = make(base, gate, mirror);
      if (next == null) return false;
      latest.current.applyDocChange(next);
      setNotice(null);
      return true;
    } catch (e) {
      setNotice(refusalText(e));
      return false;
    }
  }, []);

  const stamp = () => ({ ...(latest.current.actor ?? {}), now: Date.now() });

  const openPlan = useCallback((id: string | null) => {
    setOpenId(id);
    if (id != null) setBandShown(true);
    setPrefill(null);
    if (id == null) setListMode(false);
  }, []);

  const api: PlansController = {
    store,
    doc,
    canon,
    plans,
    plan,
    canEdit,
    bandOpen: bandShown || openId != null,
    setBandOpen: (o) => {
      setBandShown(o);
      if (!o) {
        setOpenId(null);
        setListMode(false);
      }
    },
    openPlan,
    panelOpen: prefs.open ?? true,
    setPanelOpen: (o) => update({ open: o }),
    prefs,
    setOffset: (x, y) => update({ x, y }),
    listMode,
    setListMode,
    preview,
    unavailable,
    notice,
    clearNotice: () => setNotice(null),
    refused,
    why,
    whyToken,
    openWhy: (f, trigger) => {
      whyTrigger.current = trigger ?? null;
      setWhy(f);
      setWhyToken((n) => n + 1);
    },
    closeWhy,
    showChanges,
    toggleShowChanges: () => setShowChanges((s) => !s),
    prefill,
    planChange: (elementId) => {
      const d = latest.current.doc;
      if (d == null || !latest.current.canEdit) return;
      const c = buildCanon(d);
      const form = { ...EMPTY_FORM, ...(prefillFor(d, c, elementId) ?? {}) };
      tokenRef.current += 1;
      const at = tokenRef.current;
      // Add to the plan being written, if there is one; else start one named for the thing.
      if (plan != null && plan.stage === 'planned') {
        setPrefill({ token: at, form });
        update({ open: true });
        setListMode(false);
        return;
      }
      void run((doc0, gate) => {
        const made = createPlan(doc0, { title: titleFor(doc0, c, elementId), author: latest.current.authorName, gate, ...stamp() });
        setOpenId(made.id);
        setBandShown(true);
        setListMode(false);
        setPrefill({ token: at, form });
        update({ open: true });
        return made.doc;
      });
    },
    create: ({ title, windowStart, windowEnd }, pasted = false) =>
      run((doc0, gate) => {
        const made = createPlan(doc0, { title, windowStart, windowEnd, author: latest.current.authorName, gate, ...stamp() });
        setOpenId(made.id);
        setBandShown(true);
        setPrefill(null);
        update({ open: true });
        return made.doc;
      }, howOf(pasted)),
    rename: (title, pasted = false) => run((doc0, gate) => (plan ? setPlanHead(doc0, plan.id, { title }, { gate, ...stamp() }) : null), howOf(pasted)),
    addStep: (form, pasted = false) =>
      run((doc0, gate) => {
        if (plan == null) return null;
        const built = buildStep(doc0, canon, form);
        if ('error' in built) throw new PlanRefusal('bad-edit', built.error);
        const out = addStep(doc0, plan.id, { ...built, gate, ...stamp() });
        setPrefill(null);
        return out.doc;
      }, howOf(pasted)),
    removeStep: (stepId) => run((doc0) => removeStep(doc0, stepId, stamp())),
    moveStep: (stepId, index) => run((doc0) => moveStep(doc0, stepId, index, stamp())),
    start: () => run((doc0) => (plan ? startPlan(doc0, plan.id, stamp()) : null)),
    done: (stepId) => {
      setRefused(null);
      return run((doc0, _gate, mirror) => {
        if (mirror == null) return null;
        const kept: { finding: CheckFinding | null } = { finding: null };
        // Bring the module up to this document: the check reads what the design is now.
        const m = latest.current.mirrorNow() ?? mirror;
        const check = stepCheck(
          m,
          fieldKey,
          (f) => {
            kept.finding = f;
          },
          doc0,
        );
        try {
          return markDone(doc0, stepId, { check, ...stamp() });
        } catch (e) {
          if (kept.finding != null) {
            setRefused({ stepId, finding: kept.finding });
            // The card under the step says it (and is the alert); a second notice would say it twice.
            setNotice(null);
            return null;
          }
          setNotice(editFailureText(e));
          return null;
        }
      }, 'engine');
    },
    wentDifferently: (stepId, note, pasted = false) => {
      setRefused(null);
      return run((doc0, gate) => markWentDifferently(doc0, stepId, { note, gate, ...stamp() }), howOf(pasted));
    },
    record: (outcome, text, pasted = false) =>
      run((doc0, gate) => (plan ? recordPlan(doc0, plan.id, { outcome, text, gate, ...stamp() }) : null), howOf(pasted)),
  };
  return api;
}
