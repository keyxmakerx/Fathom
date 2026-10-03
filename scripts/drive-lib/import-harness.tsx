// Test harness for scripts/drive-import.mjs, copied into client/src/ as drive.tsx only while the
// drive runs. It mounts the importer's dialog on its own (no app, no server): the design is a
// seeded document, the redaction gate is the real wasm, and the shared-field "server" is in memory.
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';

import './index.css';
import { ImportDialog } from './components/import/ImportDialog';
import { devicesByName } from './import/existing';
import { undo, undoable } from './document/undo';
import { writePlain } from './document/plain';
import { fieldValue, type FieldDefView } from './document/fields';
import type { Document } from './document/model';
import { newUlid } from './document/ulid';
import { Engine } from './engine/engine';
import { catalogueFrom, seedCanvasScene } from './drive-seed';

const ME = newUlid();

declare global {
  interface Window {
    __importState__: () => { devices: Array<Record<string, string>>; docText: string; undoSteps: number; defs: string[] };
    __loadFailures__: string[];
    __requests__: string[];
    __applied__: number;
  }
}

function Scene({ initial, engine, catalogue }: { initial: Document; engine: Engine; catalogue: ReturnType<typeof catalogueFrom> }) {
  const [doc, setDoc] = useState(initial);
  const [defs, setDefs] = useState<FieldDefView[]>([]);
  const [open, setOpen] = useState(true);

  window.__importState__ = () => ({
    devices: [...devicesByName(doc).values()].map((d) => ({
      name: d.name,
      serial: d.serial,
      role: d.role,
      mgmt: d.mgmt,
      model: d.model,
      owner: fieldValue(doc, d.deviceId, defs.find((x) => x.name === 'Owner')?.id ?? '') ?? '',
    })),
    docText: JSON.stringify(doc),
    undoSteps: undoable(doc, ME).length,
    defs: defs.map((d) => `${d.name}:${d.type}`),
  });

  const check = (next: Document, what: string) => {
    try {
      engine.loadPlain(writePlain(next));
    } catch (e) {
      window.__loadFailures__.push(`${what}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div style={{ padding: 16 }}>
      <button type="button" onClick={() => setOpen(true)}>Open importer</button>{' '}
      <button
        type="button"
        onClick={() => {
          const step = undoable(doc, ME)[0];
          if (!step) return;
          const next = undo(doc, step.id, { actor: ME, now: Date.now() });
          check(next, 'after undo');
          setDoc(next);
        }}
      >
        Undo
      </button>
      <p data-testid="count">{devicesByName(doc).size} devices</p>
      {open ? (
        <ImportDialog
          doc={doc}
          catalogue={catalogue}
          fieldDefs={defs}
          createField={async (kind, name, type) => {
            await new Promise((r) => setTimeout(r, 120));
            setDefs((d) => [...d, { id: newUlid(), appliesTo: kind, name, type, choices: [], version: 1, createdBy: ME, archived: false }]);
          }}
          redact={async (t) => engine.redactText(t).text}
          actor={ME}
          onApply={(next) => {
            window.__applied__ += 1;
            check(next, 'after import');
            setDoc(next);
          }}
          onCancel={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

async function main() {
  window.__loadFailures__ = [];
  window.__requests__ = [];
  window.__applied__ = 0;
  // Record every request the page makes, to prove the importer makes none.
  const realFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    window.__requests__.push(typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url);
    return realFetch(input as RequestInfo, init);
  };
  const cat = await (await fetch('/drive-catalogue.json')).json();
  const catalogue = catalogueFrom(cat);
  const engine = await Engine.init();
  window.__requests__.length = 0;
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Scene initial={seedCanvasScene(catalogue, ME)} engine={engine} catalogue={catalogue} />
    </StrictMode>,
  );
}

void main();
