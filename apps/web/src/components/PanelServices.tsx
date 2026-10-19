import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DeviceView, DhcpPool } from '@netsim/engine';
import { formatIpv4, isValidIpv4, maskToPrefix, parseIpv4 } from '@netsim/protocols';
import { api } from '../engine/client';
import { useStore } from '../store';

/** Server-Dienste: HTTP(S), DNS und DHCP ein-/ausschalten und einfache Inhalte pflegen. */
export function ServicesConfig({ dev }: { dev: DeviceView }) {
  const { t } = useTranslation();
  const showToast = useStore((s) => s.showToast);
  const sv = dev.services;
  const [dnsName, setDnsName] = useState('');
  const [dnsIp, setDnsIp] = useState('');
  const [page, setPage] = useState(sv?.http.pages['/'] ?? '');
  if (!sv) return null;

  const addRecord = () => {
    if (!dnsName || !dnsIp) return;
    const records = [
      ...sv.dns.records.filter((r) => r.name !== dnsName),
      { name: dnsName.trim(), type: 'A' as const, data: dnsIp.trim(), ttl: 300 },
    ];
    void api.setService(dev.id, { dns: { records } }).then((r) => {
      if (!r.ok) showToast(r.error, r.params);
    });
    setDnsName('');
    setDnsIp('');
  };

  return (
    <>
      <h4>{t('svc.title')}</h4>
      <label className="inline-check">
        <input
          type="checkbox"
          checked={sv.http.enabled}
          onChange={(e) => void api.setService(dev.id, { http: { enabled: e.target.checked } })}
        />
        HTTP
      </label>
      <label className="inline-check">
        <input
          type="checkbox"
          checked={sv.http.https}
          onChange={(e) => void api.setService(dev.id, { http: { https: e.target.checked } })}
        />
        HTTPS
      </label>
      <label>
        {t('svc.page')}
        <textarea
          rows={3}
          value={page}
          onChange={(e) => setPage(e.target.value)}
          onBlur={() =>
            void api.setService(dev.id, { http: { pages: { ...sv.http.pages, '/': page } } })
          }
        />
      </label>
      <label className="inline-check">
        <input
          type="checkbox"
          checked={sv.dns.enabled}
          onChange={(e) => void api.setService(dev.id, { dns: { enabled: e.target.checked } })}
        />
        DNS
      </label>
      <ul className="ping-list">
        {sv.dns.records.map((r) => (
          <li key={`${r.name}-${r.data}`}>
            {r.name} → {r.data}
          </li>
        ))}
      </ul>
      <div className="form inline3">
        <input
          aria-label={t('svc.dnsName')}
          placeholder="www.example.net"
          value={dnsName}
          onChange={(e) => setDnsName(e.target.value)}
        />
        <input
          aria-label={t('ip.address')}
          placeholder="10.0.0.80"
          value={dnsIp}
          onChange={(e) => setDnsIp(e.target.value)}
        />
        <span />
        <button onClick={addRecord}>{t('common.add')}</button>
      </div>
      <DhcpServerConfig dev={dev} />
    </>
  );
}

const EMPTY_POOL = {
  name: '',
  router: '',
  dns: '',
  start: '',
  mask: '255.255.255.0',
  max: '50',
  days: '1',
};

/** DHCP-Dienst des Servers (wie Packet Tracer): Pools mit Startadresse, Maske und Anzahl. */
function DhcpServerConfig({ dev }: { dev: DeviceView }) {
  const { t } = useTranslation();
  const showToast = useStore((s) => s.showToast);
  const [f, setF] = useState(EMPTY_POOL);
  const dh = dev.services?.dhcp;
  if (!dh) return null;
  const save = (patch: Partial<typeof dh>) =>
    void api.setService(dev.id, { dhcp: patch }).then((r) => {
      if (!r.ok) showToast(r.error, r.params);
    });
  const field = (k: keyof typeof EMPTY_POOL, label: string, ph = '') => (
    <input
      aria-label={label}
      placeholder={ph || label}
      value={f[k]}
      onChange={(e) => setF({ ...f, [k]: e.target.value })}
    />
  );
  const addPool = () => {
    const plen = maskToPrefix(f.mask);
    const start = parseIpv4(f.start);
    const max = Number(f.max);
    const days = Number(f.days);
    const bad =
      !f.name.trim() ||
      plen === undefined ||
      start === undefined ||
      !Number.isInteger(max) ||
      max < 1 ||
      !(days > 0) ||
      (f.router && !isValidIpv4(f.router)) ||
      (f.dns && !isValidIpv4(f.dns));
    if (bad) {
      showToast('svc.dhcp.invalid');
      return;
    }
    const m = plen === 0 ? 0 : (0xffffffff << (32 - plen)) >>> 0;
    const net = (start & m) >>> 0;
    const bcast = (net | (~m >>> 0)) >>> 0;
    const end = Math.min(start + max - 1, bcast - 1);
    const pool: DhcpPool = {
      name: f.name.trim(),
      network: formatIpv4(net),
      mask: f.mask,
      router: f.router || undefined,
      dns: f.dns ? [f.dns] : [],
      leaseSec: Math.round(days * 86400),
      rangeStart: f.start,
      rangeEnd: formatIpv4(end),
    };
    save({ pools: [...dh.pools.filter((p) => p.name !== pool.name), pool] });
    setF(EMPTY_POOL);
  };
  const leases = Object.entries(dh.bindings).filter(([, b]) => !b.offered);
  return (
    <section aria-label={t('svc.dhcp.title')}>
      <label className="inline-check">
        <input
          type="checkbox"
          checked={dh.enabled}
          onChange={(e) => save({ enabled: e.target.checked })}
        />
        DHCP
      </label>
      <table className="small">
        <thead>
          <tr>
            <th>{t('svc.dhcp.pool')}</th>
            <th>{t('svc.dhcp.gateway')}</th>
            <th>DNS</th>
            <th>{t('svc.dhcp.range')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {dh.pools.map((p) => (
            <tr key={p.name}>
              <td>{p.name}</td>
              <td>{p.router ?? '–'}</td>
              <td>{p.dns.join(', ') || '–'}</td>
              <td>
                {p.rangeStart ?? p.network} – {p.rangeEnd ?? ''} /{maskToPrefix(p.mask)}
              </td>
              <td>
                <button
                  aria-label={`${t('svc.dhcp.remove')} ${p.name}`}
                  onClick={() => save({ pools: dh.pools.filter((x) => x.name !== p.name) })}
                >
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="form">
        {field('name', t('svc.dhcp.pool'), 'serverPool')}
        {field('router', t('svc.dhcp.gateway'), '10.0.0.1')}
        {field('dns', t('svc.dhcp.dns'), '10.0.0.10')}
        {field('start', t('svc.dhcp.start'), '10.0.0.100')}
        {field('mask', t('ip.mask'), '255.255.255.0')}
        {field('max', t('svc.dhcp.max'), '50')}
        {field('days', t('svc.dhcp.days'), '1')}
        <button onClick={addPool}>{t('svc.dhcp.save')}</button>
      </div>
      <h5>{t('svc.dhcp.leases')}</h5>
      <ul className="ping-list">
        {leases.length === 0 && <li className="muted">–</li>}
        {leases.map(([ip, b]) => (
          <li key={ip}>
            {ip} → {b.mac}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Minimaler Web-Browser (Desktop-App): URL → HTTP(S)-Abruf über die Engine. */
export function Browser({ dev }: { dev: DeviceView }) {
  const { t } = useTranslation();
  const [url, setUrl] = useState('http://');
  const showToast = useStore((s) => s.showToast);
  const go = async () => {
    const r = await api.httpGet(dev.id, url.trim());
    if (!r.ok) showToast(r.error, r.params);
  };
  const last = dev.requests?.[dev.requests.length - 1];
  return (
    <div className="pad">
      <div className="form inline">
        <input
          aria-label="URL"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void go()}
        />
        <button onClick={() => void go()}>{t('browser.go')}</button>
      </div>
      <div className="browser-view" aria-live="polite">
        {!last ? null : last.status === 'done' ? (
          <>
            <p className="muted small">
              {last.url} — {last.code}
            </p>
            <pre>{last.body}</pre>
          </>
        ) : last.status === 'failed' ? (
          <p className="error">{last.error ? t(last.error) : t('browser.failed')}</p>
        ) : (
          <p className="muted">{t('browser.loading')}</p>
        )}
      </div>
    </div>
  );
}
