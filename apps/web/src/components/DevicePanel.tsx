import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DeviceView } from '@netsim/engine';
import { api } from '../engine/client';
import { formatTime } from '../format';
import { selectedDeviceView, useStore } from '../store';

export function DevicePanel() {
  const dev = useStore(selectedDeviceView);
  if (!dev) return <EmptyPanel />;
  return <Panel key={dev.id} dev={dev} />;
}

function EmptyPanel() {
  const { t } = useTranslation();
  return <p className="muted pad">{t('panel.none')}</p>;
}

function Panel({ dev }: { dev: DeviceView }) {
  const { t } = useTranslation();
  const [name, setName] = useState(dev.name);
  return (
    <div className="device-panel">
      <div className="row">
        <label className="grow">
          {t('panel.name')}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() && void api.renameDevice(dev.id, name.trim())}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
        </label>
        <button
          className={`power${dev.powered ? ' on' : ''}`}
          aria-pressed={dev.powered}
          onClick={() => void api.setPower(dev.id, !dev.powered)}
        >
          ⏻ {dev.powered ? t('dev.powerOn') : t('dev.powerOff')}
        </button>
      </div>
      <div className="muted">{dev.model}</div>
      {dev.crashed && (
        <div className="error" role="alert">
          {t('dev.crashed')}: {dev.crashed}
        </div>
      )}

      {dev.type === 'pc' && <HostConfig dev={dev} />}

      <h4>{t('panel.ports')}</h4>
      <table className="grid">
        <thead>
          <tr>
            <th>{t('port.name')}</th>
            <th>{t('port.status')}</th>
            <th>{t('port.speed')}</th>
            <th>MAC</th>
            <th>{t('port.admin')}</th>
          </tr>
        </thead>
        <tbody>
          {dev.ports
            .filter((p) => p.linkId || dev.ports.length <= 4)
            .map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td>
                  <span className={p.operUp ? 'dot up' : 'dot down'} aria-hidden />
                  {p.operUp ? t('port.up') : t('port.down')}
                </td>
                <td>{p.operUp ? `${p.operSpeed} / ${p.operDuplex}` : '–'}</td>
                <td className="mono">{p.mac}</td>
                <td>
                  <input
                    type="checkbox"
                    checked={p.adminUp}
                    aria-label={`${p.name} ${t('port.admin')}`}
                    onChange={(e) => void api.setPortAdmin(dev.id, p.id, e.target.checked)}
                  />
                </td>
              </tr>
            ))}
        </tbody>
      </table>
      {dev.type !== 'hub' && dev.ports.length > 4 && (
        <p className="muted small">{t('panel.onlyConnected')}</p>
      )}

      {dev.macTable && (
        <>
          <h4>{t('panel.macTable')}</h4>
          {dev.macTable.length === 0 ? (
            <p className="muted small">{t('panel.empty')}</p>
          ) : (
            <table className="grid">
              <thead>
                <tr>
                  <th>MAC</th>
                  <th>{t('port.name')}</th>
                  <th>{t('panel.age')}</th>
                </tr>
              </thead>
              <tbody>
                {dev.macTable.map((m) => (
                  <tr key={m.mac}>
                    <td className="mono">{m.mac}</td>
                    <td>{dev.ports.find((p) => p.id === m.portId)?.name}</td>
                    <td>{m.ageSec} s</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}

function HostConfig({ dev }: { dev: DeviceView }) {
  const { t } = useTranslation();
  const [ip, setIp] = useState(dev.ip ?? '');
  const [mask, setMask] = useState(dev.mask ?? '255.255.255.0');
  const [gw, setGw] = useState(dev.gateway ?? '');
  const [dst, setDst] = useState('');
  const [count, setCount] = useState(1);
  const showToast = useStore((s) => s.showToast);
  const ping = useStore((s) => s.ping);

  const apply = async () => {
    const r = await api.setHostIp(dev.id, ip.trim(), mask.trim(), gw.trim() || undefined);
    if (r.ok) showToast('toast.ipApplied', undefined, 'ok');
    else showToast(r.error);
  };

  return (
    <>
      <h4>{t('panel.ipConfig')}</h4>
      <div className="form">
        <label>
          {t('ip.address')}
          <input value={ip} onChange={(e) => setIp(e.target.value)} placeholder="10.0.0.1" />
        </label>
        <label>
          {t('ip.mask')}
          <input value={mask} onChange={(e) => setMask(e.target.value)} />
        </label>
        <label>
          {t('ip.gateway')}
          <input value={gw} onChange={(e) => setGw(e.target.value)} />
        </label>
        <button onClick={() => void apply()}>{t('common.apply')}</button>
      </div>

      <h4>Ping</h4>
      <div className="form inline">
        <input
          aria-label={t('ping.target')}
          value={dst}
          onChange={(e) => setDst(e.target.value)}
          placeholder={t('ping.target')}
        />
        <input
          type="number"
          min={1}
          max={20}
          aria-label={t('ping.count')}
          value={count}
          onChange={(e) => setCount(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
          className="narrow"
        />
        <button disabled={!dst} onClick={() => void ping(dev.id, dst.trim(), count)}>
          {t('ping.send')}
        </button>
      </div>
      {dev.pings && dev.pings.length > 0 && (
        <ul className="ping-list" aria-label={t('ping.results')}>
          {dev.pings
            .slice()
            .reverse()
            .map((p) => (
              <li key={`${p.id}-${p.seq}`} className={`ping-${p.status}`}>
                {p.dst} #{p.seq}: {t(`ping.status.${p.status}`)}
                {p.rttUs !== undefined && ` (${formatTime(p.rttUs)})`}
              </li>
            ))}
        </ul>
      )}

      <h4>{t('panel.arpTable')}</h4>
      {dev.arpTable && dev.arpTable.length > 0 ? (
        <table className="grid">
          <tbody>
            {dev.arpTable.map((a) => (
              <tr key={a.ip}>
                <td>{a.ip}</td>
                <td className="mono">{a.mac}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted small">{t('panel.empty')}</p>
      )}
    </>
  );
}
