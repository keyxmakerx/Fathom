import { useState } from 'react';

import { createDesign, renameDesign, type DesignSummary } from '../../api/designs';
import { createScope, type Scope } from '../../api/scopes';
import { writePlain } from '../../document/plain';
import { Engine } from '../../engine/engine';
import { buildRacksDocument, estatePlan, hasSites, planCounts, type EstatePlan } from '../../import/estate';
import { gateTable } from '../../import/gate';
import { readFile } from '../../import/read';
import { getSession } from '../../state/sessionState';

export interface EstateImportProps {
  organisationId: string;
  scopes: readonly Scope[];
  /** The folder of every design the person can see, so a re-import makes no second design. */
  designScopeIds: readonly string[];
  /** What accepting made, for the lists to show without a refetch. */
  onImported: (made: { scopes: Scope[]; designs: DesignSummary[] }) => void;
  onClose: () => void;
}

let engine: Promise<Engine> | null = null;
const redact = async (text: string) => {
  engine ??= Engine.init();
  return (await engine).redactText(text).text;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * ADR-0074 §8: drop a NetBox rack or device export, see the sites, buildings and racks it names as
 * one plan, and accept it. Every value passes the redaction gate before the plan is made (CLAUDE.md
 * rule 4). Accepting makes the missing folders and, per location, one design holding its racks in a
 * row; devices then go in from each design's own Import.
 */
export function EstateImport({ organisationId, scopes, designScopeIds, onImported, onClose }: EstateImportProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<EstatePlan | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function take(file: File | undefined) {
    if (!file || busy) return;
    setError(null);
    setPlan(null);
    setDone(null);
    try {
      setBusy('Reading the file…');
      const raw = await readFile(file);
      setBusy('Passing every value through the redaction gate…');
      const table = await gateTable(raw, redact);
      if (!hasSites(table)) {
        setError('This file has no site column, so it cannot say where anything is. Export racks or devices from NetBox with Site (and Location).');
      } else {
        setPlan(estatePlan(table, scopes, designScopeIds));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'This file could not be read.');
    }
    setBusy(null);
  }

  async function accept(p: EstatePlan) {
    setError(null);
    const made: { scopes: Scope[]; designs: DesignSummary[] } = { scopes: [], designs: [] };
    const actor = getSession()?.accountId ?? '';
    try {
      for (const site of p.sites) {
        setBusy(`Making ${site.name}…`);
        let siteFolder = site.existing;
        if (!siteFolder) {
          siteFolder = await createScope(organisationId, null, site.name);
          made.scopes.push(siteFolder);
        }
        for (const loc of site.locations) {
          let folder = loc.name === '' ? siteFolder : loc.existing;
          if (!folder) {
            folder = await createScope(organisationId, siteFolder.scopeId, loc.name);
            made.scopes.push(folder);
          }
          if (loc.racks.length === 0 || loc.hasDesign) continue;
          const where = loc.name || site.name;
          const doc = buildRacksDocument(where, loc.racks, { actor, now: Date.now() });
          const design = await createDesign(organisationId, folder.scopeId, writePlain(doc));
          const name = `${where} racks`;
          await renameDesign(organisationId, design.designId, name).catch(() => undefined);
          made.designs.push({ ...design, name });
        }
      }
      const c = { sites: made.scopes.filter((s) => s.kind === 'network').length, buildings: made.scopes.filter((s) => s.kind === 'building').length };
      setDone(`Made ${plural(c.sites, 'site', 'sites')}, ${plural(c.buildings, 'building', 'buildings')} and ${plural(made.designs.length, 'design', 'designs')}. Open a design and use its Import to place the devices in these racks.`);
      setPlan(null);
    } catch (e) {
      setError(`Stopped part way: ${e instanceof Error ? e.message : 'the server refused'}. What was made is kept and listed; importing the file again skips it.`);
    }
    onImported(made);
    setBusy(null);
  }

  const counts = plan ? planCounts(plan) : null;
  return (
    <section className="estate-import" aria-label="Import from NetBox" data-testid="estate-import">
      <div className="home__section-head">
        <div className="home__label">Import from NetBox</div>
        <button type="button" className="home__btn home__btn--small" onClick={onClose} disabled={busy !== null}>
          Close
        </button>
      </div>
      <p className="home__muted">
        A NetBox rack or device export (CSV or JSON). Its sites become Sites, its locations Buildings, and each location&rsquo;s racks a
        design in a row. Every value passes the redaction gate first, and nothing is made until you accept.
      </p>
      {!plan && !busy && (
        <label className="estate-import__drop">
          <input type="file" accept=".csv,.json,.txt" onChange={(e) => void take(e.target.files?.[0])} data-testid="estate-import-file" />
          Choose a file
        </label>
      )}
      {busy && <p className="home__muted">{busy}</p>}
      {error && <p className="home__error">{error}</p>}
      {done && <p className="estate-import__done">{done}</p>}
      {plan && counts && (
        <>
          <ul className="estate-import__plan">
            {plan.sites.map((site) => (
              <li key={site.name}>
                <span className="home__scope-name">{site.name}</span> <span className="home__scope-kind">Site</span>{' '}
                <span className="estate-import__tag">{site.existing ? 'already there' : 'new'}</span>
                <ul>
                  {site.locations.map((loc) => (
                    <li key={loc.name || '(site)'}>
                      {loc.name ? (
                        <>
                          <span className="home__scope-name">{loc.name}</span> <span className="home__scope-kind">Building</span>{' '}
                          <span className="estate-import__tag">{loc.existing ? 'already there' : 'new'}</span>
                        </>
                      ) : (
                        <span className="home__muted">In the site itself</span>
                      )}
                      <span className="home__muted">
                        {' · '}
                        {loc.racks.length === 0
                          ? 'no racks'
                          : loc.hasDesign
                            ? `${plural(loc.racks.length, 'rack', 'racks')}, skipped: it already has a design`
                            : `${plural(loc.racks.length, 'rack', 'racks')} (${loc.racks.map((r) => r.name).join(', ')}) in a new design`}
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          {plan.skipped > 0 && <p className="home__muted">{plural(plan.skipped, 'row has', 'rows have')} no site and will be left out.</p>}
          <div className="estate-import__actions">
            <button
              type="button"
              className="home__btn"
              disabled={counts.sites + counts.buildings + counts.designs === 0}
              onClick={() => void accept(plan)}
            >
              Make {plural(counts.sites, 'site', 'sites')}, {plural(counts.buildings, 'building', 'buildings')} and {plural(counts.designs, 'design', 'designs')}
            </button>
            <button type="button" className="home__btn" onClick={() => setPlan(null)}>
              Choose another file
            </button>
          </div>
        </>
      )}
    </section>
  );
}
