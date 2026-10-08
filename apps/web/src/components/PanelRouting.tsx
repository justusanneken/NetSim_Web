import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DeviceView } from '@netsim/engine';
import { api } from '../engine/client';
import { useStore } from '../store';

/** Dynamisches Routing (lesend), Loopbacks und IPv6 für Router und L3-Switches. */
export function RoutingPanel({ dev }: { dev: DeviceView }) {
  const { t } = useTranslation();
  const info = dev.routingInfo;
  const none =
    !info ||
    (!info.rip &&
      info.ospf.length === 0 &&
      info.eigrp.length === 0 &&
      !info.bgp &&
      info.hsrp.length === 0);
  return (
    <>
      <h4>{t('panel.routing')}</h4>
      {none ? (
        <p className="muted small">{t('routing.none')}</p>
      ) : (
        <ul className="routing-list" aria-label={t('panel.routing')}>
          {info?.rip && <li>RIPv2</li>}
          {info?.ospf.map((o) => (
            <li key={`o${o.v6}${o.pid}`}>
              {o.v6 ? 'OSPFv3' : 'OSPF'} {o.pid}
              {o.rid ? ` (${o.rid})` : ''} – {t('routing.neighbors')}: {o.neighbors.length}
              {o.neighbors.map((n) => (
                <div key={`${n.rid}${n.iface}`} className="mono small">
                  {n.rid} {n.iface} {n.state}
                </div>
              ))}
            </li>
          ))}
          {info?.eigrp.map((e) => (
            <li key={`e${e.asn}`}>
              EIGRP {e.asn} – {t('routing.neighbors')}: {e.neighbors.length}
              {e.neighbors.map((n) => (
                <div key={n.ip} className="mono small">
                  {n.ip} {n.iface}
                </div>
              ))}
            </li>
          ))}
          {info?.bgp && (
            <li>
              BGP AS {info.bgp.asn}
              {info.bgp.neighbors.map((n) => (
                <div key={n.ip} className="mono small">
                  {n.ip} AS{n.asn} {n.state} ({n.prefixes})
                </div>
              ))}
            </li>
          )}
          {info?.hsrp.map((h) => (
            <li key={`h${h.iface}${h.group}`}>
              {t('routing.hsrp')} {h.iface} #{h.group}: {h.state} {h.vip ?? ''} (prio {h.priority})
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">{t('tool.debugHint')}</p>
      <LoopbackAdd dev={dev} />
      <Ipv6Router dev={dev} />
    </>
  );
}

function LoopbackAdd({ dev }: { dev: DeviceView }) {
  const showToast = useStore((s) => s.showToast);
  const [n, setN] = useState(0);
  const [ip, setIp] = useState('');
  const add = async () => {
    const r = await api.setInterfaceIp(dev.id, `lo${n}`, ip.trim(), '255.255.255.255');
    if (!r.ok) showToast(r.error, r.params);
    else setIp('');
  };
  return (
    <div className="form inline3" aria-label="Loopback">
      <input
        type="number"
        min={0}
        max={9999}
        aria-label="Loopback"
        value={n}
        onChange={(e) => setN(Number(e.target.value))}
        className="narrow"
      />
      <input
        aria-label="Loopback IP"
        placeholder="1.1.1.1"
        value={ip}
        onChange={(e) => setIp(e.target.value)}
      />
      <span />
      <button disabled={!ip} onClick={() => void add()}>
        Loopback
      </button>
    </div>
  );
}

function Ipv6Router({ dev }: { dev: DeviceView }) {
  const { t } = useTranslation();
  const showToast = useStore((s) => s.showToast);
  const [ifaceId, setIfaceId] = useState(dev.ports[0]?.id ?? 'p0');
  const [addr, setAddr] = useState('');
  const [plen, setPlen] = useState(64);
  const [route, setRoute] = useState({ prefix: '', plen: 64, nextHop: '' });
  const report = (r: { ok: boolean; error?: string; params?: Record<string, string | number> }) => {
    if (!r.ok && r.error) showToast(r.error, r.params);
  };
  return (
    <>
      <h4>{t('panel.ipv6')}</h4>
      <label className="inline-check">
        <input
          type="checkbox"
          checked={dev.ipv6Routing === true}
          onChange={(e) => void api.setIpv6Routing(dev.id, e.target.checked).then(report)}
        />
        {t('ipv6.routing')}
      </label>
      <div className="form inline3">
        <select
          aria-label={t('port.name')}
          value={ifaceId}
          onChange={(e) => setIfaceId(e.target.value)}
        >
          {(dev.ifaceList ?? []).map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
          {dev.ports
            .filter((p) => !dev.ifaceList?.some((i) => i.id === p.id))
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
        </select>
        <input
          aria-label={t('ipv6.address')}
          placeholder="2001:db8:1::1"
          value={addr}
          onChange={(e) => setAddr(e.target.value)}
        />
        <input
          type="number"
          min={1}
          max={128}
          aria-label={t('ipv6.prefix')}
          value={plen}
          onChange={(e) => setPlen(Number(e.target.value))}
          className="narrow"
        />
        <button
          disabled={!addr}
          onClick={() =>
            void api.setInterfaceIp6(dev.id, ifaceId, addr.trim(), plen).then((r) => {
              report(r);
              if (r.ok) setAddr('');
            })
          }
        >
          {t('common.add')}
        </button>
      </div>
      <ul className="routing-list" aria-label={t('panel.ipv6')}>
        {(dev.ifaceList ?? [])
          .filter((i) => i.v6 && i.v6.length > 0)
          .map((i) => (
            <li key={i.id}>
              {i.name}: <span className="mono">{i.v6?.join(', ')}</span>
            </li>
          ))}
      </ul>
      <h4>{t('router.routes6')}</h4>
      {dev.routes6 && dev.routes6.length > 0 ? (
        <table className="grid">
          <tbody>
            {dev.routes6.map((r, i) => (
              <tr key={i}>
                <td>{r.type}</td>
                <td className="mono">
                  {r.prefix}/{r.plen}
                </td>
                <td className="mono">
                  {r.nextHop ?? dev.ifaceList?.find((x) => x.id === r.ifaceId)?.name}
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
          placeholder="2001:db8:2::"
          value={route.prefix}
          onChange={(e) => setRoute({ ...route, prefix: e.target.value })}
        />
        <input
          type="number"
          min={0}
          max={128}
          aria-label={t('ipv6.prefix')}
          value={route.plen}
          onChange={(e) => setRoute({ ...route, plen: Number(e.target.value) })}
          className="narrow"
        />
        <input
          aria-label={t('router.nextHop')}
          placeholder="2001:db8:12::2"
          value={route.nextHop}
          onChange={(e) => setRoute({ ...route, nextHop: e.target.value })}
        />
        <button
          disabled={!route.prefix || !route.nextHop}
          onClick={() =>
            void api
              .addStaticRoute6(dev.id, {
                prefix: route.prefix.trim(),
                plen: route.plen,
                nextHop: route.nextHop.trim(),
              })
              .then(report)
          }
        >
          {t('common.add')}
        </button>
      </div>
    </>
  );
}

/** IPv6 am Host: statische Adresse/Gateway oder SLAAC. */
export function HostIpv6({ dev }: { dev: DeviceView }) {
  const { t } = useTranslation();
  const showToast = useStore((s) => s.showToast);
  const v = dev.hostV6;
  const [addr, setAddr] = useState(v?.addrs[0]?.addr ?? '');
  const [plen, setPlen] = useState(v?.addrs[0]?.plen ?? 64);
  const [gw, setGw] = useState(v?.gateway ?? '');
  if (!v) return null;
  const apply = async () => {
    const r = await api.setHostIpv6(dev.id, { addr: addr.trim(), plen, gateway: gw.trim() });
    if (!r.ok) showToast(r.error, r.params);
    else showToast('toast.ipApplied', undefined, 'ok');
  };
  return (
    <>
      <h4>{t('panel.ipv6')}</h4>
      <label className="inline-check">
        <input
          type="checkbox"
          checked={v.autoconfig}
          onChange={(e) => void api.setHostIpv6(dev.id, { autoconfig: e.target.checked })}
        />
        {t('ipv6.slaac')}
      </label>
      <div className="form">
        <label>
          {t('ipv6.address')}
          <input
            value={addr}
            onChange={(e) => setAddr(e.target.value)}
            placeholder="2001:db8:1::10"
          />
        </label>
        <label>
          {t('ipv6.prefix')}
          <input
            type="number"
            min={1}
            max={128}
            value={plen}
            onChange={(e) => setPlen(Number(e.target.value))}
          />
        </label>
        <label>
          {t('ipv6.gateway')}
          <input value={gw} onChange={(e) => setGw(e.target.value)} placeholder="2001:db8:1::1" />
        </label>
        <button onClick={() => void apply()}>{t('ipv6.set')}</button>
      </div>
      <p className="mono small">
        {t('ipv6.linkLocal')}: {v.linkLocal}
      </p>
      {v.slaac.map((a) => (
        <p key={a.addr} className="mono small">
          SLAAC: {a.addr}/{a.plen}
        </p>
      ))}
      {v.raGateway && <p className="mono small">RA: {v.raGateway}</p>}
    </>
  );
}
