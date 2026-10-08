import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MODULES, type DeviceView, type PhysicalTree } from '@netsim/engine';
import { DeviceIcon } from './Palette';
import { api } from '../engine/client';
import { useStore } from '../store';
import { useCall } from './util5';

/** Cloud/Modem: Port-Zuordnung (Brückengruppen). */
export function BridgePanel({ dev }: { dev: DeviceView }) {
  const { t } = useTranslation();
  const call = useCall();
  const b = dev.p5?.bridge;
  if (!b) return null;
  return (
    <>
      <h4>{t('bridge.title')}</h4>
      <p className="muted small">{b.fixed ? t('bridge.fixedHint') : t('bridge.hint')}</p>
      <table className="grid" aria-label={t('bridge.title')}>
        <thead>
          <tr>
            <th>{t('port.name')}</th>
            <th>{t('bridge.group')}</th>
          </tr>
        </thead>
        <tbody>
          {dev.ports.map((p) => (
            <tr key={p.id}>
              <td>{p.name}</td>
              <td>
                {b.fixed ? (
                  b.groups[p.id]
                ) : (
                  <select
                    aria-label={`${t('bridge.group')} ${p.name}`}
                    value={b.groups[p.id] ?? 0}
                    onChange={(e) =>
                      void call(api.setBridgeGroup(dev.id, p.id, Number(e.target.value)))
                    }
                  >
                    {[0, 1, 2, 3, 4].map((g) => (
                      <option key={g} value={g}>
                        {g === 0 ? t('bridge.none') : g}
                      </option>
                    ))}
                  </select>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/** Orte als flache Liste (`Stadt/Gebäude/Raum/Rack`). */
export function locationPaths(tree: PhysicalTree | undefined): string[] {
  const out: string[] = [];
  for (const c of tree?.cities ?? []) {
    out.push(c.name);
    for (const b of c.buildings) {
      out.push(`${c.name}/${b.name}`);
      for (const r of b.rooms) {
        out.push(`${c.name}/${b.name}/${r.name}`);
        for (const k of r.racks) out.push(`${c.name}/${b.name}/${r.name}/${k}`);
      }
    }
  }
  return out;
}

/** Physical-Tab des Geräte-Dialogs: Power-Taste, Gehäuse mit Modulen, Standort. */
export function PhysicalTab({ dev }: { dev: DeviceView }) {
  const { t } = useTranslation();
  const call = useCall();
  const tree = useStore((s) => s.view?.physical);
  const [rack, setRack] = useState(String(dev.p5?.rackPos ?? ''));
  const slots = dev.p5?.slots ?? [];
  const paths = locationPaths(tree).filter((p) => p.split('/').length >= 3);
  return (
    <div className="scroll pad">
      <div className="row">
        <button
          className={`power${dev.powered ? ' on' : ''}`}
          aria-pressed={dev.powered}
          aria-label={t('physical.power')}
          onClick={() => void api.setPower(dev.id, !dev.powered)}
        >
          ⏻ {dev.powered ? t('dev.powerOn') : t('dev.powerOff')}
        </button>
        <span className="muted">{dev.model}</span>
      </div>
      <div className="case" role="img" aria-label={t('physical.case', { model: dev.model })}>
        <div className="case-icon">
          <DeviceIcon type={dev.type} size={64} />
        </div>
        <div className="case-ports">
          {dev.ports.map((p) => (
            <span
              key={p.id}
              className={`case-port ${p.operUp ? 'up' : p.linkId ? 'down' : 'free'}`}
              title={`${p.name}${p.operUp ? '' : ''}`}
            />
          ))}
        </div>
        <div className="case-slots">
          {slots.map((s, i) => (
            <span key={i} className={`case-slot${s.module ? ' used' : ''}`}>
              {s.name}: {s.module ?? t('physical.empty')}
            </span>
          ))}
        </div>
      </div>

      <h4>{t('physical.modules')}</h4>
      {slots.length === 0 ? (
        <p className="muted small">{t('physical.noSlots')}</p>
      ) : (
        <>
          {dev.powered && <p className="warn small">{t('module.needPowerOff')}</p>}
          <table className="grid" aria-label={t('physical.modules')}>
            <tbody>
              {slots.map((s, i) => (
                <tr key={i}>
                  <td>{s.name}</td>
                  <td>
                    {s.module ? (
                      <>
                        {s.module}{' '}
                        <button
                          aria-label={`${t('physical.remove')} ${s.name}`}
                          onClick={() => void call(api.removeModule(dev.id, i))}
                        >
                          {t('physical.remove')}
                        </button>
                      </>
                    ) : (
                      <select
                        aria-label={`${t('physical.insert')} ${s.name}`}
                        value=""
                        onChange={(e) =>
                          e.target.value && void call(api.insertModule(dev.id, i, e.target.value))
                        }
                      >
                        <option value="">{t('physical.insert')} …</option>
                        {s.accepts.map((m) => (
                          <option key={m} value={m}>
                            {MODULES[m]?.name ?? m}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h4>{t('physical.location')}</h4>
      <div className="form">
        <label>
          {t('physical.room')}
          <select
            aria-label={t('physical.room')}
            value={dev.p5?.location ?? ''}
            onChange={(e) => void call(api.placeDevice(dev.id, e.target.value, undefined))}
          >
            <option value="">{t('physical.unplaced')}</option>
            {paths.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('physical.rackPos')}
          <input
            type="number"
            min={1}
            max={42}
            value={rack}
            aria-label={t('physical.rackPos')}
            onChange={(e) => setRack(e.target.value)}
            onBlur={() =>
              dev.p5?.location &&
              void call(
                api.placeDevice(dev.id, dev.p5.location, rack === '' ? undefined : Number(rack)),
              )
            }
          />
        </label>
      </div>
      {!tree?.cities.length && <p className="muted small">{t('physical.hintCreate')}</p>}
    </div>
  );
}

/** Physical View: Stadt → Gebäude → Raum → Rack mit zugeordneten Geräten (vereinfacht). */
export function PhysicalView() {
  const { t } = useTranslation();
  const call = useCall();
  const view = useStore((s) => s.view);
  const select = useStore((s) => s.selectDevice);
  const openDialog = useStore((s) => s.openDialog);
  const [path, setPath] = useState('');
  const tree = view?.physical;
  const devices = view?.devices ?? [];
  const inLoc = (loc: string): DeviceView[] =>
    devices.filter((d) => d.p5?.location === loc || d.p5?.location?.startsWith(loc + '/'));
  const direct = (loc: string): DeviceView[] => devices.filter((d) => d.p5?.location === loc);
  const unplaced = devices.filter((d) => !d.p5?.location);
  const dev = (d: DeviceView) => (
    <button
      key={d.id}
      className="phys-dev"
      onClick={() => select(d.id)}
      onDoubleClick={() => openDialog(d.id)}
      title={`${d.name} – ${d.model}`}
    >
      <DeviceIcon type={d.type} size={28} />
      <span>
        {d.name}
        {d.p5?.rackPos ? ` (U${d.p5.rackPos})` : ''}
      </span>
    </button>
  );
  return (
    <div className="physical-view" role="region" aria-label={t('physical.view')}>
      <div className="form inline">
        <input
          aria-label={t('physical.newPath')}
          placeholder={t('physical.pathPlaceholder')}
          value={path}
          onChange={(e) => setPath(e.target.value)}
        />
        <button
          onClick={() =>
            void call(api.addLocation(path.trim().replace(/\s*\/\s*/g, '/'))).then(
              (ok) => ok && setPath(''),
            )
          }
        >
          {t('common.add')}
        </button>
      </div>
      <div className="phys-tree">
        {(tree?.cities ?? []).map((c) => (
          <section key={c.name} className="phys-city">
            <h3>
              {c.name}{' '}
              <button
                aria-label={`${t('common.remove')} ${c.name}`}
                onClick={() => void call(api.deleteLocation(c.name))}
              >
                ×
              </button>
            </h3>
            {c.buildings.map((b) => (
              <section key={b.name} className="phys-building">
                <h4>
                  {b.name}{' '}
                  <span className="muted small">({inLoc(`${c.name}/${b.name}`).length})</span>{' '}
                  <button
                    aria-label={`${t('common.remove')} ${b.name}`}
                    onClick={() => void call(api.deleteLocation(`${c.name}/${b.name}`))}
                  >
                    ×
                  </button>
                </h4>
                <div className="phys-rooms">
                  {b.rooms.map((r) => {
                    const rp = `${c.name}/${b.name}/${r.name}`;
                    return (
                      <div key={r.name} className="phys-room">
                        <strong>{r.name}</strong>
                        <div className="phys-devs">{direct(rp).map(dev)}</div>
                        {r.racks.map((k) => (
                          <div key={k} className="phys-rack">
                            <span className="muted small">{k}</span>
                            {direct(`${rp}/${k}`)
                              .sort((x, y) => (x.p5?.rackPos ?? 0) - (y.p5?.rackPos ?? 0))
                              .map(dev)}
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </section>
        ))}
      </div>
      <h4>{t('physical.unplacedList')}</h4>
      <div className="phys-devs">
        {unplaced.map((d) => (
          <div key={d.id} className="phys-unplaced">
            {dev(d)}
            <select
              aria-label={`${t('physical.room')} ${d.name}`}
              value=""
              onChange={(e) => e.target.value && void call(api.placeDevice(d.id, e.target.value))}
            >
              <option value="">{t('physical.place')} …</option>
              {locationPaths(tree)
                .filter((p) => p.split('/').length >= 3)
                .map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
            </select>
          </div>
        ))}
      </div>
    </div>
  );
}
