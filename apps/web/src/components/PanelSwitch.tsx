import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DeviceView } from '@netsim/engine';
import { api } from '../engine/client';
import { useStore } from '../store';

/** VLAN-Datenbank, VTP, Spanning-Tree-Modus und Switchport-Konfiguration. */
export function SwitchConfig({ dev }: { dev: DeviceView }) {
  const { t } = useTranslation();
  const showToast = useStore((s) => s.showToast);
  const [vid, setVid] = useState(10);
  const [vname, setVname] = useState('');

  const report = (r: { ok: boolean; error?: string; params?: Record<string, string | number> }) => {
    if (!r.ok && r.error) showToast(r.error, r.params);
  };

  return (
    <>
      <h4>VLANs</h4>
      <table className="grid" aria-label="VLANs">
        <tbody>
          {dev.vlans?.map((v) => (
            <tr key={v.id}>
              <td>{v.id}</td>
              <td>{v.name}</td>
              <td>
                {v.id !== 1 && (v.id < 1002 || v.id > 1005) && (
                  <button
                    aria-label={`${t('common.remove')} VLAN ${v.id}`}
                    onClick={() => void api.removeVlan(dev.id, v.id).then(report)}
                  >
                    ✕
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="form inline3">
        <input
          type="number"
          min={1}
          max={4094}
          aria-label="VLAN-ID"
          value={vid}
          onChange={(e) => setVid(Number(e.target.value))}
          className="narrow"
        />
        <input
          aria-label={t('panel.name')}
          placeholder={t('panel.name')}
          value={vname}
          onChange={(e) => setVname(e.target.value)}
        />
        <span />
        <button
          onClick={() => void api.addVlan(dev.id, vid, vname.trim() || undefined).then(report)}
        >
          {t('common.add')}
        </button>
      </div>

      {dev.vtp && (
        <div className="form inline3">
          <label>
            VTP
            <select
              value={dev.vtp.mode}
              onChange={(e) =>
                void api
                  .setVtp(dev.id, { mode: e.target.value as 'server' | 'client' | 'transparent' })
                  .then(report)
              }
            >
              <option value="server">server</option>
              <option value="client">client</option>
              <option value="transparent">transparent</option>
            </select>
          </label>
          <label>
            {t('sw.domain')}
            <input
              defaultValue={dev.vtp.domain}
              onBlur={(e) => void api.setVtp(dev.id, { domain: e.target.value.trim() })}
            />
          </label>
          <span className="muted small">rev {dev.vtp.revision}</span>
          <label>
            STP
            <select
              value={dev.stpMode}
              onChange={(e) =>
                void api
                  .setStp(dev.id, { mode: e.target.value as 'pvst' | 'rapid-pvst' })
                  .then(report)
              }
            >
              <option value="pvst">PVST+</option>
              <option value="rapid-pvst">Rapid-PVST</option>
            </select>
          </label>
        </div>
      )}

      <h4>{t('sw.switchports')}</h4>
      <table className="grid" aria-label={t('sw.switchports')}>
        <thead>
          <tr>
            <th>{t('port.name')}</th>
            <th>{t('sw.mode')}</th>
            <th>VLAN</th>
            <th>STP</th>
            <th>PortFast</th>
          </tr>
        </thead>
        <tbody>
          {dev.ports
            .filter((p) => dev.switchports?.[p.id] && (p.linkId || dev.ports.length <= 4))
            .map((p) => {
              const sp = dev.switchports?.[p.id];
              if (!sp) return null;
              return (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td>
                    <select
                      aria-label={`${p.name} ${t('sw.mode')}`}
                      value={sp.mode}
                      onChange={(e) =>
                        void api
                          .setSwitchport(dev.id, p.id, {
                            mode: e.target.value as typeof sp.mode,
                          })
                          .then(report)
                      }
                    >
                      <option value="access">access</option>
                      <option value="trunk">trunk</option>
                      <option value="dynamic-auto">dynamic auto</option>
                      <option value="dynamic-desirable">dynamic desirable</option>
                    </select>
                  </td>
                  <td>
                    <input
                      type="number"
                      className="narrow"
                      min={1}
                      max={4094}
                      aria-label={`${p.name} VLAN`}
                      disabled={sp.mode !== 'access'}
                      defaultValue={sp.accessVlan}
                      onBlur={(e) =>
                        void api
                          .setSwitchport(dev.id, p.id, { accessVlan: Number(e.target.value) })
                          .then(report)
                      }
                    />
                  </td>
                  <td>
                    {sp.errdisabled ? (
                      <button onClick={() => void api.clearErrdisable(dev.id, p.id)}>
                        {t('sw.errdisabled')} ↺
                      </button>
                    ) : (
                      (sp.stp?.state ?? '–')
                    )}
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`${p.name} PortFast`}
                      checked={sp.portfast}
                      onChange={(e) =>
                        void api.setSwitchport(dev.id, p.id, { portfast: e.target.checked })
                      }
                    />
                  </td>
                </tr>
              );
            })}
        </tbody>
      </table>
    </>
  );
}
