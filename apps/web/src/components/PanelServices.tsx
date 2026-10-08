import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DeviceView } from '@netsim/engine';
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
    </>
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
