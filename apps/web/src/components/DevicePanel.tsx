import { useState } from 'react';
import { groupRoutes } from './routeGroups';
import { useTranslation } from 'react-i18next';
import type { DeviceView } from '@netsim/engine';
import { api } from '../engine/client';
import { formatTime } from '../format';
import { selectedDeviceView, useStore } from '../store';
import { HostIpv6, RoutingPanel } from './PanelRouting';
import { ServicesConfig } from './PanelServices';
import { SwitchConfig } from './PanelSwitch';

export function DevicePanel() {
  const dev = useStore(selectedDeviceView);
  if (!dev) return <EmptyPanel />;
  return <DeviceConfig key={dev.id} dev={dev} />;
}

function EmptyPanel() {
  const { t } = useTranslation();
  return <p className="muted pad">{t('panel.none')}</p>;
}

export function DeviceConfig({ dev }: { dev: DeviceView }) {
  const { t } = useTranslation();
  const [name, setName] = useState(dev.name);
  const openDialog = useStore((s) => s.openDialog);
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
      <div className="row">
        <span className="muted grow">{dev.model}</span>
        {dev.type !== 'hub' && (
          <button onClick={() => openDialog(dev.id)}>{t('dialog.open')}</button>
        )}
      </div>
      {dev.crashed && (
        <div className="error" role="alert">
          {t('dev.crashed')}: {dev.crashed}
        </div>
      )}

      {isHost(dev) && <HostIpConfig dev={dev} />}
      {(dev.type === 'router' || dev.type === 'switch-l3') && <RouterConfig dev={dev} />}
      {(dev.type === 'router' || dev.type === 'switch-l3') && <RoutingPanel dev={dev} />}
      {isHost(dev) && <HostIpv6 dev={dev} />}
      {(dev.type === 'switch-l2' || dev.type === 'switch-l3') && <SwitchConfig dev={dev} />}
      {dev.type === 'server' && <ServicesConfig dev={dev} />}

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

const isHost = (d: DeviceView): boolean =>
  d.type === 'pc' || d.type === 'laptop' || d.type === 'server';

export function HostIpConfig({ dev }: { dev: DeviceView }) {
  const { t } = useTranslation();
  const [ip, setIp] = useState(dev.ip ?? '');
  const [mask, setMask] = useState(dev.mask ?? '255.255.255.0');
  const [gw, setGw] = useState(dev.gateway ?? '');
  const [dns, setDns] = useState((dev.dnsServers ?? []).join(' '));
  const [dst, setDst] = useState('');
  const [count, setCount] = useState(1);
  const showToast = useStore((s) => s.showToast);
  const ping = useStore((s) => s.ping);

  const apply = async () => {
    const r = await api.setHostIp(dev.id, ip.trim(), mask.trim(), gw.trim() || undefined);
    const d = await api.setDnsServers(dev.id, dns.split(/[\s,]+/).filter(Boolean));
    if (!d.ok) return showToast(d.error, d.params);
    if (r.ok) showToast('toast.ipApplied', undefined, 'ok');
    else showToast(r.error, r.params);
  };

  return (
    <>
      <h4>{t('panel.ipConfig')}</h4>
      <label className="inline-check">
        <input
          type="checkbox"
          checked={dev.dhcp !== undefined && dev.dhcp !== 'off'}
          onChange={(e) => void api.setHostDhcp(dev.id, e.target.checked)}
        />
        {t('ip.dhcp')}
        {dev.dhcp && dev.dhcp !== 'off' && <span className="muted"> ({dev.dhcp})</span>}
      </label>
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
        <label>
          {t('ip.dns')}
          <input value={dns} onChange={(e) => setDns(e.target.value)} placeholder="8.8.8.8" />
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
                {p.dst} #{p.seq}:{' '}
                {p.note
                  ? t(p.note, { ip: p.from ?? p.dst, dst: p.dst })
                  : t(`ping.status.${p.status}`)}
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

function RouterConfig({ dev }: { dev: DeviceView }) {
  const { t } = useTranslation();
  const showToast = useStore((s) => s.showToast);
  const [route, setRoute] = useState({ prefix: '', mask: '255.255.255.0', nextHop: '' });

  const setIp = async (portId: string, ip: string, mask: string) => {
    const r = await api.setInterfaceIp(dev.id, portId, ip.trim(), mask.trim());
    if (r.ok) showToast('toast.ipApplied', undefined, 'ok');
    else showToast(r.error, r.params);
  };
  const addRoute = async () => {
    const r = await api.addStaticRoute(dev.id, {
      prefix: route.prefix.trim(),
      mask: route.mask.trim(),
      nextHop: route.nextHop.trim(),
    });
    if (!r.ok) showToast(r.error, r.params);
    else setRoute({ prefix: '', mask: '255.255.255.0', nextHop: '' });
  };

  return (
    <>
      <h4>{t('router.interfaces')}</h4>
      {dev.ports
        .filter((p) => dev.type === 'router' || dev.ifaces?.[p.id])
        .map((p) => (
          <IfaceRow
            key={`${p.id}-${dev.ifaces?.[p.id]?.ip ?? ''}`}
            dev={dev}
            portId={p.id}
            onApply={setIp}
          />
        ))}
      {dev.ifaceList
        ?.filter((i) => i.kind !== 'phys')
        .map((i) => (
          <div className="iface-row" key={`${i.id}-${i.ip ?? ''}`}>
            <strong>{i.name}</strong>{' '}
            <span className="mono">{i.ip ? `${i.ip} ${i.mask}` : t('panel.empty')}</span>
          </div>
        ))}
      <SubifAdd dev={dev} />
      <h4>{t('router.staticRoutes')}</h4>
      {dev.staticRoutes && dev.staticRoutes.length > 0 ? (
        <table className="grid">
          <tbody>
            {dev.staticRoutes.map((r, i) => (
              <tr key={i}>
                <td className="mono">
                  {r.prefix} {r.mask}
                </td>
                <td className="mono">
                  {r.nextHop ?? dev.ifaceList?.find((i) => i.id === r.outIfaceId)?.name}
                </td>
                <td>
                  <button
                    aria-label={t('common.remove')}
                    onClick={() => void api.removeStaticRoute(dev.id, r)}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted small">{t('panel.empty')}</p>
      )}
      <div className="form inline3">
        <input
          aria-label={t('router.prefix')}
          placeholder={t('router.prefix')}
          value={route.prefix}
          onChange={(e) => setRoute({ ...route, prefix: e.target.value })}
        />
        <input
          aria-label={t('ip.mask')}
          value={route.mask}
          onChange={(e) => setRoute({ ...route, mask: e.target.value })}
        />
        <input
          aria-label={t('router.nextHop')}
          placeholder={t('router.nextHop')}
          value={route.nextHop}
          onChange={(e) => setRoute({ ...route, nextHop: e.target.value })}
        />
        <button disabled={!route.prefix || !route.nextHop} onClick={() => void addRoute()}>
          {t('common.add')}
        </button>
      </div>
      <h4>{t('router.routingTable')}</h4>
      {dev.routes && dev.routes.length > 0 ? (
        <table className="grid">
          <tbody>
            {groupRoutes(dev.routes).map((g, i) => (
              <tr key={i}>
                <td>
                  {g[0]?.type}
                  {g[0]?.sub ? ` ${g[0].sub}` : ''}
                </td>
                <td className="mono">
                  {g[0]?.prefix}/{g[0]?.plen}
                </td>
                <td className="mono">
                  {g.map((r, j) => (
                    <div key={j} data-testid="route-path">
                      {r.type === 'S' ? `[${r.ad}/${r.metric}] ` : ''}
                      {r.nextHop ?? dev.ifaceList?.find((x) => x.id === r.ifaceId)?.name}
                    </div>
                  ))}
                </td>
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

function IfaceRow({
  dev,
  portId,
  onApply,
}: {
  dev: DeviceView;
  portId: string;
  onApply: (portId: string, ip: string, mask: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const port = dev.ports.find((p) => p.id === portId);
  const cur = dev.ifaces?.[portId];
  const [ip, setIp] = useState(cur?.ip ?? '');
  const [mask, setMask] = useState(cur?.mask ?? '255.255.255.0');
  if (!port) return null;
  return (
    <div className="iface-row">
      <div className="iface-head">
        <span className={port.operUp ? 'dot up' : 'dot down'} aria-hidden />
        <strong>{port.name}</strong>
        <label className="inline-check">
          <input
            type="checkbox"
            checked={port.adminUp}
            aria-label={`${port.name} ${t('port.admin')}`}
            onChange={(e) => void api.setPortAdmin(dev.id, port.id, e.target.checked)}
          />
          {t('router.on')}
        </label>
      </div>
      <div className="form inline3">
        <input
          aria-label={`${port.name} ${t('ip.address')}`}
          value={ip}
          placeholder="10.0.0.1"
          onChange={(e) => setIp(e.target.value)}
        />
        <input
          aria-label={`${port.name} ${t('ip.mask')}`}
          value={mask}
          onChange={(e) => setMask(e.target.value)}
        />
        <span />
        <button onClick={() => void onApply(portId, ip, mask)}>{t('common.apply')}</button>
      </div>
    </div>
  );
}

/** Subinterface (Router) bzw. SVI (L3-Switch) anlegen und adressieren. */
function SubifAdd({ dev }: { dev: DeviceView }) {
  const { t } = useTranslation();
  const showToast = useStore((s) => s.showToast);
  const [port, setPort] = useState(dev.ports[0]?.id ?? 'p0');
  const [vlan, setVlan] = useState(10);
  const [ip, setIp] = useState('');
  const [mask, setMask] = useState('255.255.255.0');
  const isRouter = dev.type === 'router';
  const add = async () => {
    const c = isRouter
      ? await api.createSubIface(dev.id, port, vlan)
      : await api.createSvi(dev.id, vlan);
    if (!c.ok) return showToast(c.error, c.params);
    if (ip) {
      const r = await api.setInterfaceIp(dev.id, c.value, ip.trim(), mask.trim());
      if (!r.ok) showToast(r.error, r.params);
    }
  };
  return (
    <div className="form inline3" aria-label={isRouter ? t('router.subif') : t('router.svi')}>
      {isRouter && (
        <select aria-label={t('port.name')} value={port} onChange={(e) => setPort(e.target.value)}>
          {dev.ports.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      )}
      <input
        type="number"
        min={1}
        max={4094}
        aria-label="VLAN"
        value={vlan}
        onChange={(e) => setVlan(Number(e.target.value))}
        className="narrow"
      />
      <input
        aria-label={t('ip.address')}
        placeholder="10.0.10.1"
        value={ip}
        onChange={(e) => setIp(e.target.value)}
      />
      <input aria-label={t('ip.mask')} value={mask} onChange={(e) => setMask(e.target.value)} />
      <button onClick={() => void add()}>{isRouter ? t('router.subif') : t('router.svi')}</button>
    </div>
  );
}
