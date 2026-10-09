import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DeviceView } from '@netsim/engine';
import { useStore } from '../store';
import { Modal } from './Modal';
import { useUx } from './ux';

/** IP-Adresse (mit Präfix) eines Ports, soweit bekannt. */
export function portIp(d: DeviceView, portId: string, portName: string): string {
  const fromList = d.ifaceList?.find((i) => i.name === portName || i.id === portId);
  if (fromList?.ip && fromList.mask) return `${fromList.ip} / ${fromList.mask}`;
  const fromMap = d.ifaces?.[portId];
  if (fromMap?.ip) return `${fromMap.ip} / ${fromMap.mask ?? ''}`;
  if (d.ip && d.ports[0]?.id === portId) return `${d.ip} / ${d.mask ?? ''}`;
  return '';
}

/** VLAN-/Modus-Angabe eines Switch-Ports ('' wenn nicht zutreffend). */
export function portVlan(d: DeviceView, portId: string): string {
  const sp = d.switchports?.[portId];
  if (!sp) return '';
  if (sp.routed) return 'routed';
  if (sp.operTrunk || sp.mode === 'trunk') return `trunk (native ${sp.nativeVlan})`;
  return `VLAN ${sp.accessVlan}`;
}

function routeCode(r: { type: string; sub?: string }): string {
  return r.sub ? `${r.type} ${r.sub}` : r.type;
}

/** Netzwerk-Info-Fenster: Gerät wählen → Interfaces, Routen, ARP, MAC-Tabelle als Tabellen. */
export function NetworkInfo() {
  const { t } = useTranslation();
  const open = useUx((s) => s.netInfoOpen);
  const devices = useStore((s) => s.view?.devices);
  const selected = useStore((s) => s.selectedDevice);
  const [id, setId] = useState('');
  useEffect(() => {
    if (open) setId(selected ?? devices?.[0]?.id ?? '');
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!open) return null;
  const dev = devices?.find((d) => d.id === id) ?? devices?.[0];
  const close = () => useUx.getState().setNetInfo(false);
  const nameOf = (d: DeviceView, ifaceId?: string): string =>
    d.ifaceList?.find((i) => i.id === ifaceId)?.name ??
    d.ports.find((p) => p.id === ifaceId)?.name ??
    ifaceId ??
    '';
  return (
    <Modal title={t('netinfo.window')} onClose={close} className="netinfo">
      <div className="scroll pad">
        {!dev ? (
          <p className="muted">{t('netinfo.empty')}</p>
        ) : (
          <>
            <label>
              {t('netinfo.device')}{' '}
              <select value={dev.id} onChange={(e) => setId(e.target.value)}>
                {devices?.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} ({d.model})
                  </option>
                ))}
              </select>
            </label>

            <h4>{t('netinfo.interfaces')}</h4>
            <table className="grid" aria-label={t('netinfo.interfaces')}>
              <thead>
                <tr>
                  <th scope="col">{t('port.name')}</th>
                  <th scope="col">{t('port.status')}</th>
                  <th scope="col">{t('netinfo.ip')}</th>
                  <th scope="col">{t('netinfo.vlan')}</th>
                  <th scope="col">{t('netinfo.mac')}</th>
                  <th scope="col">{t('port.speed')}</th>
                </tr>
              </thead>
              <tbody>
                {dev.ports.map((p) => (
                  <tr key={p.id}>
                    <th scope="row">{p.name}</th>
                    <td>
                      {!p.adminUp
                        ? t('netinfo.adminDown')
                        : p.operUp
                          ? t('port.up')
                          : t('port.down')}
                    </td>
                    <td className="mono">{portIp(dev, p.id, p.name)}</td>
                    <td>{portVlan(dev, p.id)}</td>
                    <td className="mono">{p.mac}</td>
                    <td>{p.operUp ? `${p.operSpeed} / ${p.operDuplex}` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {dev.routes && (
              <>
                <h4>{t('netinfo.routes')}</h4>
                <table className="grid" aria-label={t('netinfo.routes')}>
                  <thead>
                    <tr>
                      <th scope="col">{t('netinfo.code')}</th>
                      <th scope="col">{t('netinfo.prefix')}</th>
                      <th scope="col">{t('netinfo.adMetric')}</th>
                      <th scope="col">{t('netinfo.nextHop')}</th>
                      <th scope="col">{t('netinfo.iface')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dev.routes.map((r, i) => (
                      <tr key={i}>
                        <th scope="row">{routeCode(r)}</th>
                        <td className="mono">
                          {r.prefix}/{r.plen}
                        </td>
                        <td>
                          [{r.ad}/{r.metric}]
                        </td>
                        <td className="mono">{r.nextHop ?? ''}</td>
                        <td>{nameOf(dev, r.ifaceId)}</td>
                      </tr>
                    ))}
                    {dev.routes.length === 0 && (
                      <tr>
                        <td colSpan={5} className="muted">
                          {t('panel.empty')}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </>
            )}

            {dev.arpTable && (
              <>
                <h4>{t('panel.arpTable')}</h4>
                <table className="grid" aria-label={t('panel.arpTable')}>
                  <thead>
                    <tr>
                      <th scope="col">{t('netinfo.ip')}</th>
                      <th scope="col">{t('netinfo.mac')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dev.arpTable.map((a) => (
                      <tr key={a.ip}>
                        <th scope="row" className="mono">
                          {a.ip}
                        </th>
                        <td className="mono">{a.mac}</td>
                      </tr>
                    ))}
                    {dev.arpTable.length === 0 && (
                      <tr>
                        <td colSpan={2} className="muted">
                          {t('panel.empty')}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </>
            )}

            {dev.macTable && (
              <>
                <h4>{t('panel.macTable')}</h4>
                <table className="grid" aria-label={t('panel.macTable')}>
                  <thead>
                    <tr>
                      <th scope="col">{t('netinfo.mac')}</th>
                      <th scope="col">{t('port.name')}</th>
                      <th scope="col">{t('panel.age')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dev.macTable.map((m) => (
                      <tr key={m.mac}>
                        <th scope="row" className="mono">
                          {m.mac}
                        </th>
                        <td>{nameOf(dev, m.portId)}</td>
                        <td>{m.ageSec} s</td>
                      </tr>
                    ))}
                    {dev.macTable.length === 0 && (
                      <tr>
                        <td colSpan={3} className="muted">
                          {t('panel.empty')}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
