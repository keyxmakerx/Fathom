// Runs the "It's down" session for one open design (ADR-0061 troubleshooting). The draft lives here, in memory:
// nothing is written until "Save as an issue" or "Plan a fix", so abandoning leaves no trace. The engine, the
// redaction gate and the plans controller are the ones the page already holds; this boots nothing itself.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { foldFrom } from '../../document/freeform';
import {
  IssueRefusal,
  TYPED_AS_WRITTEN,
  closeIssue,
  createIssue,
  issuesTouching,
  linkPlan,
  listIssues,
  readIssue,
  type Issue,
  type TextGate,
  type Answer,
} from '../../document/issues';
import type { Document } from '../../document/model';
import { PlanRefusal, addStep, createPlan } from '../../document/plans';
import { buildCanon, isTypingTarget, type Canon } from '../checks/checksModel';
import { ENGINE_DOWN, refusalText } from '../plans/usePlansController';
import { outcomeText } from './pointing';
import {
  canvasKeys,
  fixSteps,
  issueTitle,
  nextOpen,
  planFixState,
  planTitle,
  pointOf,
  startDraft,
  toDraftSteps,
  troubleEscTarget,
  withAnswer,
  withNote,
  firstOpen,
  type Draft,
} from './troubleModel';
import { createTroubleStore, type TroubleStore } from './troubleStore';

export interface TroubleController {
  store: TroubleStore;
  doc: Document | null;
  canEdit: boolean;
  /** The running checklist, or null. */
  draft: Draft | null;
  /** A saved issue being read, or null. */
  viewing: Issue | null;
  /** Which step is open (0-based); -1 when none. */
  focus: number;
  panelOpen: boolean;
  setPanelOpen(open: boolean): void;
  /** The step whose Why? card is open, or null. */
  why: number | null;
  openWhy(index: number, trigger?: HTMLElement | null): void;
  closeWhy(): void;
  notice: string | null;
  clearNotice(): void;
  /** Close was asked with unsaved answers: say so before throwing them away. */
  confirmingClose: boolean;
  /** Saved issues, newest first. */
  issues: Issue[];
  issuesOf(deviceId: string): Issue[];
  /** Right-click "It's down" or the device's button: a chassis or device id. Returns whether a session opened. */
  start(elementId: string): boolean;
  openIssue(id: string): void;
  focusStep(index: number): void;
  answer(index: number, answer: Answer): void;
  setNote(index: number, note: string, pasted: boolean): void;
  save(): Promise<boolean>;
  planAFix(): Promise<boolean>;
  markClosed(): Promise<boolean>;
  /** Ends the session. With unsaved answers the first call asks; `force` throws them away. */
  close(force?: boolean): void;
  keepGoing(): void;
}

interface Inputs {
  doc: Document | null;
  boot: () => Promise<unknown>;
  /** The redaction gate, once the engine is up (`Engine.redactText`); null before. */
  redact: () => TextGate | null;
  applyDocChange: (doc: Document) => void;
  actor: { actor: string } | undefined;
  authorName?: string;
  canEdit: boolean;
  /** Opens a maintenance plan in the plans controller (Plan a fix). */
  openPlan: (id: string) => void;
}

const IDENTITY: Canon = (id) => id;

export function useTroubleController({ doc, boot, redact, applyDocChange, actor, authorName, canEdit, openPlan }: Inputs): TroubleController {
  const [store] = useState(createTroubleStore);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [focus, setFocus] = useState(-1);
  const [panelOpen, setPanelOpen] = useState(true);
  const [why, setWhy] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const whyTrigger = useRef<HTMLElement | null>(null);
  const tokenRef = useRef(0);
  const latest = useRef({ doc, boot, redact, applyDocChange, actor, authorName, canEdit, openPlan, draft });
  latest.current = { doc, boot, redact, applyDocChange, actor, authorName, canEdit, openPlan, draft };

  const canon = useMemo<Canon>(() => (doc ? buildCanon(doc) : IDENTITY), [doc]);
  const issues = useMemo(() => (doc ? listIssues(doc) : []), [doc]);
  const viewing = useMemo(() => {
    if (doc == null || viewingId == null) return null;
    try {
      return readIssue(doc, viewingId);
    } catch {
      return null;
    }
  }, [doc, viewingId]);

  // A saved issue that is gone (undone, or another editor's) closes itself.
  useEffect(() => {
    if (viewingId != null && doc != null && viewing == null) setViewingId(null);
  }, [viewingId, doc, viewing]);

  // What the canvas reads. One write per change of the session; the camera moves once when it opens.
  const sessionKey = draft ? `d|${draft.deviceId}|${draft.openedAt}` : viewing ? `v|${viewing.id}` : '';
  const lastSession = useRef('');
  useEffect(() => {
    if (draft == null && viewing == null) {
      if (store.get().active) store.set({ active: false, chain: new Set(), current: new Set(), suspects: new Set() });
      lastSession.current = '';
      return;
    }
    const moved = sessionKey !== lastSession.current;
    lastSession.current = sessionKey;
    if (moved) tokenRef.current += 1;
    if (draft != null) {
      const k = canvasKeys(draft, focus, canon);
      store.set({ active: true, chain: k.chain, current: k.current, suspects: k.suspects, ...(moved ? { token: tokenRef.current } : {}) });
    } else if (viewing != null) {
      const chain = new Set(viewing.steps.flatMap((s) => s.targets.map(canon)));
      store.set({ active: true, chain, current: new Set(), suspects: new Set(), ...(moved ? { token: tokenRef.current } : {}) });
    }
  }, [draft, viewing, focus, canon, store, sessionKey]);
  useEffect(() => () => store.set({ active: false, chain: new Set(), current: new Set(), suspects: new Set() }), [store]);

  const closeWhy = useCallback(() => {
    setWhy(null);
    const back = whyTrigger.current;
    whyTrigger.current = null;
    if (back?.isConnected) back.focus();
  }, []);

  const end = useCallback(() => {
    setDraft(null);
    setViewingId(null);
    setFocus(-1);
    setWhy(null);
    setNotice(null);
    setConfirmingClose(false);
  }, []);

  // Esc closes the Why? card, then the panel. Not while typing or in a dialog.
  useEffect(() => {
    if (draft == null && viewingId == null) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (isTypingTarget(e.target as HTMLElement | null) || isTypingTarget(document.activeElement)) return;
      if (document.querySelector('[role="dialog"], [role="menu"], [aria-modal="true"]') != null) return;
      const which = troubleEscTarget({ why: why != null, panel: panelOpen });
      if (which == null) return;
      e.preventDefault();
      if (which === 'why') closeWhy();
      else setPanelOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [draft, viewingId, why, panelOpen, closeWhy]);

  const stamp = () => ({ ...(latest.current.actor ?? {}), now: Date.now() });

  // One door for every write. 'pasted' needs the engine's gate and refuses without it, changing nothing; 'typed'
  // stores the text as typed and needs no engine. A refusal is said in words.
  const run = useCallback(async (make: (doc: Document, gate: TextGate) => Document | null, how: 'typed' | 'pasted'): Promise<boolean> => {
    const now = latest.current;
    if (!now.canEdit) {
      setNotice('You can look at this but not change it.');
      return false;
    }
    if (how === 'pasted') {
      try {
        await now.boot();
      } catch {
        setNotice(ENGINE_DOWN);
        return false;
      }
    }
    const gate = how === 'pasted' ? latest.current.redact() : TYPED_AS_WRITTEN;
    const base = latest.current.doc;
    if (gate == null) {
      setNotice(ENGINE_DOWN);
      return false;
    }
    if (base == null) return false;
    try {
      const next = make(base, gate);
      if (next == null) return false;
      latest.current.applyDocChange(next);
      setNotice(null);
      return true;
    } catch (e) {
      setNotice(e instanceof IssueRefusal || e instanceof PlanRefusal ? refusalText(e) : 'That did not go through.');
      return false;
    }
  }, []);

  const howOf = (d: Draft): 'typed' | 'pasted' => (d.steps.some((s) => s.pasted && s.note.trim() !== '') ? 'pasted' : 'typed');

  /** Saves the draft as an issue unless it is already saved; returns the doc and the issue's id. */
  const saveInto = (doc0: Document, d: Draft, gate: TextGate): { doc: Document; id: string } => {
    if (d.savedId !== null) return { doc: doc0, id: d.savedId };
    return createIssue(doc0, {
      deviceId: d.deviceId,
      title: issueTitle(d.deviceName),
      steps: toDraftSteps(d),
      author: latest.current.authorName,
      outcome: outcomeText(d.steps.map((s, i) => ({ ordinal: i, answer: s.answer, suspects: s.suspects, tests: s.tests }))),
      gate,
      ...stamp(),
    });
  };

  const api: TroubleController = {
    store,
    doc,
    canEdit,
    draft,
    viewing,
    focus,
    panelOpen,
    setPanelOpen,
    why,
    openWhy: (index, trigger) => {
      whyTrigger.current = trigger ?? null;
      setWhy(index);
    },
    closeWhy,
    notice,
    clearNotice: () => setNotice(null),
    confirmingClose,
    issues,
    issuesOf: (deviceId) => (doc ? issuesTouching(doc, deviceId, canon) : []),
    start: (elementId) => {
      const now = latest.current;
      if (now.doc == null || !now.canEdit) return false;
      const device = buildCanon(now.doc)(elementId);
      const made = startDraft(now.doc, device, Date.now());
      if (made == null) {
        setNotice("That is not a device Fathom can ask about.");
        return false;
      }
      setViewingId(null);
      setDraft(made);
      setFocus(firstOpen(made.steps));
      setPanelOpen(true);
      setWhy(null);
      setNotice(null);
      setConfirmingClose(false);
      return true;
    },
    openIssue: (id) => {
      setDraft(null);
      setFocus(-1);
      setViewingId(id);
      setPanelOpen(true);
      setWhy(null);
      setNotice(null);
      setConfirmingClose(false);
    },
    focusStep: (index) => {
      setFocus(index);
      setWhy(null);
    },
    answer: (index, answer) => {
      const d = latest.current.draft;
      if (d == null || !latest.current.canEdit) return;
      const next = withAnswer(d, index, answer, Date.now());
      setDraft(next);
      setWhy(null);
      setFocus(nextOpen(next.steps, index));
    },
    setNote: (index, note, pasted) => {
      const d = latest.current.draft;
      if (d == null) return;
      setDraft(withNote(d, index, note, pasted));
    },
    save: async () => {
      const d = latest.current.draft;
      if (d == null || d.savedId !== null) return false;
      let savedId: string | null = null;
      const ok = await run((doc0, gate) => {
        const saved = saveInto(doc0, d, gate);
        savedId = saved.id;
        return saved.doc;
      }, howOf(d));
      if (ok && savedId !== null) setDraft((cur) => (cur ? { ...cur, savedId } : cur));
      return ok;
    },
    planAFix: async () => {
      const d = latest.current.draft;
      if (d == null) return false;
      const state = planFixState(d, latest.current.canEdit);
      if (!state.ok) {
        setNotice(state.reason);
        return false;
      }
      const steps = fixSteps(pointOf(d));
      let planId: string | null = null;
      const ok = await run((doc0, gate) => {
        const from = doc0.batches.length;
        const saved = saveInto(doc0, d, gate);
        const made = createPlan(saved.doc, { title: planTitle(d.deviceName), author: latest.current.authorName, gate, ...stamp() });
        let cur = made.doc;
        for (const s of steps) cur = addStep(cur, made.id, { kind: 'other', change: s.change, targets: [s.target], gate, ...stamp() }).doc;
        cur = linkPlan(cur, saved.id, made.id, stamp());
        planId = made.id;
        // Issue, plan, steps and link are one change to undo.
        return foldFrom(cur, from);
      }, howOf(d));
      if (ok && planId !== null) {
        end();
        latest.current.openPlan(planId);
      }
      return ok;
    },
    markClosed: async () => {
      const id = viewing?.id ?? latest.current.draft?.savedId ?? null;
      if (id == null) return false;
      return run((doc0, gate) => closeIssue(doc0, id, { gate, ...stamp() }), 'typed');
    },
    close: (force = false) => {
      const d = latest.current.draft;
      const unsaved = d != null && d.savedId === null && d.steps.some((s) => s.answer !== 'unanswered');
      if (unsaved && !force) {
        setConfirmingClose(true);
        return;
      }
      end();
    },
    keepGoing: () => setConfirmingClose(false),
  };
  return api;
}
