import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PduProtocol } from '@netsim/engine';
import { useStore } from '../store';
import { useTeach } from './teachStore';

/** Gleiche Liste wie `PDU_PROTOCOLS` der Engine (kein Wert-Import, damit die Engine nicht im UI-Bundle landet). */
const PDU_PROTOCOLS: PduProtocol[] = [
  'icmp',
  'udp',
  'tcp',
  'http',
  'https',
  'dns',
  'telnet',
  'ssh',
  'ftp',
  'smtp',
  'pop3',
];
const DEFAULT_PORT: Partial<Record<PduProtocol, number>> = {
  udp: 53,
  tcp: 80,
  http: 80,
  https: 443,
  telnet: 23,
  ssh: 22,
  ftp: 21,
  smtp: 25,
  pop3: 110,
};
const PORT_PROTOS: PduProtocol[] = ['udp', 'tcp'];
const TEXT_PROTOS: PduProtocol[] = ['icmp', 'udp', 'dns', 'http', 'https'];

/** Complex PDU: Protokoll, Port, Quell-IP, Nutzlast, Zeitpunkt und Wiederholung. */
export function PduDialog() {
  const { t } = useTranslation();
  const open = useTeach((s) => s.pduDialog);
  const setOpen = useTeach((s) => s.openPduDialog);
  const addPdu = useTeach((s) => s.addPdu);
  const devices = useStore((s) => s.view?.devices ?? []);
  const sources = devices.filter(
    (d) => d.type !== 'hub' && d.type !== 'cloud' && d.type !== 'note' && d.powered,
  );
  const first = useRef<HTMLSelectElement>(null);
  const [src, setSrc] = useState('');
  const [protocol, setProtocol] = useState<PduProtocol>('icmp');
  const [dst, setDst] = useState('');
  const [dport, setDport] = useState('');
  const [sport, setSport] = useState('');
  const [srcIp, setSrcIp] = useState('');
  const [payload, setPayload] = useState('');
  const [delay, setDelay] = useState('0');
  const [count, setCount] = useState('1');
  const [interval, setIntervalSec] = useState('1');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  if (!open) return null;
  const srcId = src || sources[0]?.id || '';

  const submit = async (send: boolean): Promise<void> => {
    const num = (v: string): number | undefined => (v.trim() === '' ? undefined : Number(v));
    if (!srcId) return setError(t('pdu.err.noSource'));
    if (!dst.trim()) return setError(t('pdu.err.noTarget'));
    const ok = await addPdu(
      {
        protocol,
        src: srcId,
        dst: dst.trim(),
        dport: num(dport) ?? (PORT_PROTOS.includes(protocol) ? DEFAULT_PORT[protocol] : undefined),
        sport: num(sport),
        srcIp: srcIp.trim() || undefined,
        payload: payload || undefined,
        delaySec: num(delay) ?? 0,
        count: num(count) ?? 1,
        intervalSec: num(interval) ?? 1,
      },
      send,
    );
    if (ok) setOpen(false);
    else setError(t('pdu.err.invalid'));
  };

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}
    >
      <form
        className="dialog pdu-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('pdu.complex')}
        onSubmit={(e) => {
          e.preventDefault();
          void submit(true);
        }}
      >
        <div className="dialog-head">
          <strong>{t('pdu.complex')}</strong>
          <button
            type="button"
            className="icon-btn"
            aria-label={t('common.close')}
            onClick={() => setOpen(false)}
          >
            ×
          </button>
        </div>
        <div className="pdu-form">
          <label>
            {t('pdu.f.src')}
            <select ref={first} value={srcId} onChange={(e) => setSrc(e.target.value)}>
              {sources.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('pdu.f.protocol')}
            <select
              value={protocol}
              onChange={(e) => {
                const p = e.target.value as PduProtocol;
                setProtocol(p);
                setDport(DEFAULT_PORT[p] ? String(DEFAULT_PORT[p]) : '');
              }}
            >
              {PDU_PROTOCOLS.map((p) => (
                <option key={p} value={p}>
                  {p.toUpperCase()}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('pdu.f.dst')}
            <input
              value={dst}
              onChange={(e) => setDst(e.target.value)}
              list="pdu-dst-list"
              placeholder={t('pdu.f.dstHint')}
              required
            />
            <datalist id="pdu-dst-list">
              {devices
                .filter((d) => d.ip)
                .map((d) => (
                  <option key={d.id} value={d.ip}>
                    {d.name}
                  </option>
                ))}
            </datalist>
          </label>
          {PORT_PROTOS.includes(protocol) && (
            <>
              <label>
                {t('pdu.f.dport')}
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={dport}
                  onChange={(e) => setDport(e.target.value)}
                />
              </label>
              <label>
                {t('pdu.f.sport')}
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={sport}
                  placeholder={t('pdu.f.auto')}
                  onChange={(e) => setSport(e.target.value)}
                />
              </label>
            </>
          )}
          {!['http', 'https', 'dns'].includes(protocol) && (
            <label>
              {t('pdu.f.srcIp')}
              <input
                value={srcIp}
                placeholder={t('pdu.f.auto')}
                onChange={(e) => setSrcIp(e.target.value)}
              />
            </label>
          )}
          {TEXT_PROTOS.includes(protocol) && (
            <label>
              {t(`pdu.f.payload.${protocol}`)}
              <input
                value={payload}
                maxLength={1024}
                onChange={(e) => setPayload(e.target.value)}
              />
            </label>
          )}
          <fieldset>
            <legend>{t('pdu.f.schedule')}</legend>
            <label>
              {t('pdu.f.delay')}
              <input
                type="number"
                min={0}
                max={3600}
                step={0.5}
                value={delay}
                onChange={(e) => setDelay(e.target.value)}
              />
            </label>
            <label>
              {t('pdu.f.count')}
              <input
                type="number"
                min={1}
                max={100}
                value={count}
                onChange={(e) => setCount(e.target.value)}
              />
            </label>
            <label>
              {t('pdu.f.interval')}
              <input
                type="number"
                min={0.1}
                max={3600}
                step={0.1}
                value={interval}
                onChange={(e) => setIntervalSec(e.target.value)}
              />
            </label>
          </fieldset>
          {error && (
            <p className="warn" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="pdu-actions">
          <button type="submit" className="primary">
            {t('pdu.send')}
          </button>
          <button type="button" onClick={() => void submit(false)}>
            {t('pdu.addOnly')}
          </button>
          <button type="button" onClick={() => setOpen(false)}>
            {t('common.cancel')}
          </button>
        </div>
      </form>
    </div>
  );
}
