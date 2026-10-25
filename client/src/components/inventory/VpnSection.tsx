// Mesh VPNs in Inventory (sign-off r16-overlay): the by-hand way in. A VPN is made with a name, a
// provider and a range, then its members are added one device at a time with their VPN address,
// whether each is an exit node, and the subnet routes each offers. Calls `document/overlays.ts`
// directly and hands the result to `applyDocChange`, as the rest of this panel does. The canvas
// draws what is here when Show › VPNs is ticked.

import { useMemo, useState } from 'react';

import { parseNodeId, type Document } from '../../document/model';
import {
  OVERLAY_PROVIDERS,
  PROVIDER_LABEL,
  addOverlay,
  listOverlays,
  removeMember,
  removeOverlay,
  setMember,
  setOverlay,
  type OverlayMemberView,
  type OverlayProvider,
  type OverlayView,
} from '../../document/overlays';
import { getSession } from '../../state/sessionState';
import './vpns.css';

function actorOpts(): { actor: string } | undefined {
  const s = getSession();
  return s ? { actor: s.accountId } : undefined;
}

/** Runs an edit; a refusal is shown, never thrown. */
function attempt(apply: () => void, setError: (e: string | null) => void): boolean {
  try {
    apply();
    setError(null);
    return true;
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e));
    return false;
  }
}

function liveDevices(doc: Document): { id: string; hostname: string }[] {
  return doc.nodes
    .filter((n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'Device')
    .map((n) => {
      const h = n.fields['Device.hostname'];
      return { id: n.id, hostname: h?.presence === 'set' && typeof h.value === 'string' && h.value !== '' ? h.value : 'unnamed device' };
    })
    .sort((a, b) => a.hostname.localeCompare(b.hostname));
}

function ProviderSelect({ value, onChange, id }: { value: OverlayProvider; onChange: (p: OverlayProvider) => void; id?: string }) {
  return (
    <select id={id} className="vpns__input" value={value} onChange={(e) => onChange(e.target.value as OverlayProvider)}>
      {OVERLAY_PROVIDERS.map((p) => (
        <option key={p} value={p}>
          {PROVIDER_LABEL[p]}
        </option>
      ))}
    </select>
  );
}

function AddVpn({ doc, applyDocChange, onMade, onClose }: { doc: Document; applyDocChange: (next: Document) => void; onMade: (id: string) => void; onClose: () => void }) {
  const [name, setName] = useState('');
  const [provider, setProvider] = useState<OverlayProvider>('tailscale');
  const [range, setRange] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="vpns__form"
      aria-label="Add VPN"
      onSubmit={(e) => {
        e.preventDefault();
        attempt(() => {
          const made = addOverlay(doc, { name, provider, range: range.trim() || undefined }, actorOpts());
          applyDocChange(made.doc);
          onMade(made.id);
        }, setError);
      }}
    >
      <label className="vpns__field">
        <span>Name</span>
        <input className="vpns__input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Home tailnet" autoFocus />
      </label>
      <label className="vpns__field">
        <span>Provider</span>
        <ProviderSelect value={provider} onChange={setProvider} />
      </label>
      <label className="vpns__field">
        <span>Range</span>
        <input className="vpns__input vpns__input--mono" value={range} onChange={(e) => setRange(e.target.value)} placeholder="100.64.0.0/10" />
      </label>
      {error != null && <p className="vpns__error">{error}</p>}
      <p className="vpns__note">Never type a key here. An auth key, a setup key or a private key is refused when the design is saved.</p>
      <div className="vpns__actions">
        <button type="submit" className="vpns__primary">
          Add VPN
        </button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function MemberRow({ doc, overlay, member, applyDocChange, canDraw }: { doc: Document; overlay: OverlayView; member: OverlayMemberView; applyDocChange: (next: Document) => void; canDraw: boolean }) {
  const [address, setAddress] = useState(member.address ?? '');
  const [routes, setRoutes] = useState(member.routes.join(', '));
  const [error, setError] = useState<string | null>(null);
  const changed = address !== (member.address ?? '') || routes !== member.routes.join(', ');
  const save = () => attempt(() => applyDocChange(setMember(doc, overlay.id, member.deviceId, { address, routes }, actorOpts())), setError);
  return (
    <li className="vpns__member" data-device-id={member.deviceId}>
      <span className="vpns__member-name">{member.hostname === '' ? 'unnamed device' : member.hostname}</span>
      <input className="vpns__input vpns__input--mono" aria-label={`${member.hostname} VPN address`} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="address" disabled={!canDraw} />
      <label className="vpns__check">
        <input
          type="checkbox"
          checked={member.exitNode}
          disabled={!canDraw}
          onChange={(e) => attempt(() => applyDocChange(setMember(doc, overlay.id, member.deviceId, { exitNode: e.target.checked }, actorOpts())), setError)}
        />
        Exit node
      </label>
      <input className="vpns__input vpns__input--mono vpns__input--wide" aria-label={`${member.hostname} subnet routes`} value={routes} onChange={(e) => setRoutes(e.target.value)} placeholder="subnet routes, e.g. 10.0.10.0/24" disabled={!canDraw} />
      {canDraw && (
        <span className="vpns__member-actions">
          <button type="button" disabled={!changed} onClick={save}>
            Save
          </button>
          <button type="button" onClick={() => applyDocChange(removeMember(doc, overlay.id, member.deviceId, actorOpts()))}>
            Take off
          </button>
        </span>
      )}
      {error != null && <p className="vpns__error">{error}</p>}
    </li>
  );
}

function VpnDetail({ doc, overlay, applyDocChange, canDraw, onRemoved }: { doc: Document; overlay: OverlayView; applyDocChange: (next: Document) => void; canDraw: boolean; onRemoved: () => void }) {
  const [name, setName] = useState(overlay.name);
  const [provider, setProvider] = useState(overlay.provider);
  const [range, setRange] = useState(overlay.range ?? '');
  const [note, setNote] = useState(overlay.note ?? '');
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState('');
  const [addAddress, setAddAddress] = useState('');
  const devices = useMemo(() => liveDevices(doc).filter((d) => !overlay.members.some((m) => m.deviceId === d.id)), [doc, overlay]);
  const changed = name !== overlay.name || provider !== overlay.provider || range !== (overlay.range ?? '') || note !== (overlay.note ?? '');
  return (
    <div className="vpns__detail">
      <div className="vpns__grid">
        <label className="vpns__field">
          <span>Name</span>
          <input className="vpns__input" value={name} onChange={(e) => setName(e.target.value)} disabled={!canDraw} />
        </label>
        <label className="vpns__field">
          <span>Provider</span>
          <ProviderSelect value={provider} onChange={setProvider} />
        </label>
        <label className="vpns__field">
          <span>Range</span>
          <input className="vpns__input vpns__input--mono" value={range} onChange={(e) => setRange(e.target.value)} placeholder="100.64.0.0/10" disabled={!canDraw} />
        </label>
        <label className="vpns__field vpns__field--wide">
          <span>Note</span>
          <input className="vpns__input" value={note} onChange={(e) => setNote(e.target.value)} disabled={!canDraw} />
        </label>
      </div>
      {canDraw && (
        <div className="vpns__actions">
          <button type="button" className="vpns__primary" disabled={!changed} onClick={() => attempt(() => applyDocChange(setOverlay(doc, overlay.id, { name, provider, range, note }, actorOpts())), setError)}>
            Save
          </button>
          <button
            type="button"
            className="vpns__danger"
            onClick={() => {
              applyDocChange(removeOverlay(doc, overlay.id, actorOpts()));
              onRemoved();
            }}
          >
            Remove VPN
          </button>
        </div>
      )}
      {error != null && <p className="vpns__error">{error}</p>}
      <h4 className="vpns__sub">Members</h4>
      {overlay.members.length === 0 ? <p className="vpns__note">No devices on it yet.</p> : null}
      <ul className="vpns__members">
        {overlay.members.map((m) => (
          <MemberRow key={`${m.edgeId}|${m.address ?? ''}|${m.routes.join(',')}`} doc={doc} overlay={overlay} member={m} applyDocChange={applyDocChange} canDraw={canDraw} />
        ))}
      </ul>
      {canDraw && devices.length > 0 && (
        <form
          className="vpns__add-member"
          aria-label="Add a device to the VPN"
          onSubmit={(e) => {
            e.preventDefault();
            if (adding === '') return;
            if (attempt(() => applyDocChange(setMember(doc, overlay.id, adding, { address: addAddress }, actorOpts())), setError)) {
              setAdding('');
              setAddAddress('');
            }
          }}
        >
          <select className="vpns__input" aria-label="Device" value={adding} onChange={(e) => setAdding(e.target.value)}>
            <option value="">Add a device…</option>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.hostname}
              </option>
            ))}
          </select>
          <input className="vpns__input vpns__input--mono" aria-label="Its VPN address" value={addAddress} onChange={(e) => setAddAddress(e.target.value)} placeholder="its VPN address" />
          <button type="submit" disabled={adding === ''}>
            Add
          </button>
        </form>
      )}
    </div>
  );
}

export function VpnSection({ doc, applyDocChange, canDraw, filter }: { doc: Document; applyDocChange: (next: Document) => void; canDraw: boolean; filter: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const all = useMemo(() => listOverlays(doc), [doc]);
  const f = filter.trim().toLowerCase();
  const rows = f === '' ? all : all.filter((o) => `${o.name} ${PROVIDER_LABEL[o.provider]} ${o.range ?? ''} ${o.members.map((m) => m.hostname).join(' ')}`.toLowerCase().includes(f));
  return (
    <section className="vpns" aria-label="VPNs">
      <div className="vpns__head">
        <h3 className="vpns__title">VPNs</h3>
        <span className="vpns__count">{all.length === 1 ? '1 VPN' : `${all.length} VPNs`}</span>
        <span style={{ flexGrow: 1 }} />
        {canDraw && !adding ? (
          <button type="button" onClick={() => setAdding(true)}>
            Add VPN
          </button>
        ) : null}
      </div>
      <p className="vpns__note">
        A mesh VPN such as Tailscale, NetBird or ZeroTier, or a WireGuard tunnel. Show › VPNs draws each one on the Diagram look.
      </p>
      {adding && canDraw ? (
        <AddVpn
          doc={doc}
          applyDocChange={applyDocChange}
          onMade={(id) => {
            setAdding(false);
            setOpen(id);
          }}
          onClose={() => setAdding(false)}
        />
      ) : null}
      {rows.length === 0 && !adding ? <p className="vpns__note">{all.length === 0 ? 'No VPNs yet.' : 'No VPNs match this filter.'}</p> : null}
      <ul className="vpns__list">
        {rows.map((o) => (
          <li key={o.id} className="vpns__row" data-overlay-id={o.id}>
            <button type="button" className="vpns__row-head" aria-expanded={open === o.id} onClick={() => setOpen(open === o.id ? null : o.id)}>
              <span className="vpns__row-name">{o.name}</span>
              <span>{PROVIDER_LABEL[o.provider]}</span>
              <span className="vpns__mono">{o.range ?? '—'}</span>
              <span>{o.members.length === 1 ? '1 member' : `${o.members.length} members`}</span>
            </button>
            {open === o.id ? <VpnDetail key={o.id} doc={doc} overlay={o} applyDocChange={applyDocChange} canDraw={canDraw} onRemoved={() => setOpen(null)} /> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
