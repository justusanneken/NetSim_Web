import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PduEntry } from '@netsim/engine';
import { translateMsg } from '../format';
import { useStore } from '../store';
import { useTeach } from './teachStore';

const STATUS_SYMBOL: Record<PduEntry['status'], string> = {
  unsent: '–',
  pending: '…',
  successful: '✓',
  failed: '✗',
};

/** Szenarien (Scenario 0, 1 …) und PDU-Liste mit Status, Rerun und Delete. */
export function PduPanel() {
  const { t } = useTranslation();
  const scen = useTeach((s) => s.scen);
  const refresh = useTeach((s) => s.refreshScenarios);
  const open = useTeach((s) => s.openPduDialog);
  const select = useTeach((s) => s.selectScenario);
  const add = useTeach((s) => s.addScenario);
  const del = useTeach((s) => s.deleteScenario);
  const update = useTeach((s) => s.updateScenario);
  const rerun = useTeach((s) => s.rerunPdu);
  const remove = useTeach((s) => s.deletePdu);
  const clear = useTeach((s) => s.clearPdus);
  const view = useStore((s) => s.view);

  // Ergebnisse laufen in der virtuellen Zeit ein: Anzeige in kurzen Abständen aktualisieren
  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 400);
    return () => clearInterval(id);
  }, [refresh]);

  const active = scen?.scenarios[scen.active];
  const [desc, setDesc] = useState('');
  const [name, setName] = useState('');
  const activeKey = `${scen?.active}:${active?.id}`;
  useEffect(() => {
    setDesc(active?.description ?? '');
    setName(active?.name ?? '');
    // nur beim Wechsel des Szenarios neu laden, nicht bei jeder Aktualisierung
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);

  if (!scen || !active) return <p className="muted pad">{t('common.loading')}</p>;
  const nameOf = (ref: string): string => view?.devices.find((d) => d.id === ref)?.name ?? ref;
  const idx = scen.active;
  return (
    <div className="pdu-panel">
      <div className="pdu-row">
        <label htmlFor="scen-select">{t('scenario.select')}</label>
        <select id="scen-select" value={idx} onChange={(e) => void select(Number(e.target.value))}>
          {scen.scenarios.map((s, i) => (
            <option key={s.id} value={i}>
              {s.name}
            </option>
          ))}
        </select>
        <button onClick={() => void add()}>{t('scenario.new')}</button>
        <button
          onClick={() => void del(idx)}
          disabled={scen.scenarios.length <= 1}
          aria-label={t('scenario.delete')}
        >
          {t('scenario.delete')}
        </button>
      </div>
      <div className="pdu-row">
        <label htmlFor="scen-name">{t('scenario.name')}</label>
        <input
          id="scen-name"
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name !== active.name && void update(idx, { name })}
        />
      </div>
      <label className="pdu-block" htmlFor="scen-desc">
        {t('scenario.description')}
        <textarea
          id="scen-desc"
          rows={2}
          value={desc}
          maxLength={2000}
          onChange={(e) => setDesc(e.target.value)}
          onBlur={() => desc !== active.description && void update(idx, { description: desc })}
        />
      </label>
      <div className="pdu-row">
        <button onClick={() => open(true)}>{t('pdu.complex')}</button>
        <button onClick={() => void clear()} disabled={active.pdus.length === 0}>
          {t('pdu.clear')}
        </button>
      </div>
      {active.pdus.length === 0 ? (
        <p className="muted">{t('pdu.empty')}</p>
      ) : (
        <table className="grid pdu-list" aria-label={t('pdu.list')}>
          <thead>
            <tr>
              <th scope="col">{t('pdu.col.status')}</th>
              <th scope="col">{t('pdu.col.src')}</th>
              <th scope="col">{t('pdu.col.dst')}</th>
              <th scope="col">{t('pdu.col.type')}</th>
              <th scope="col">{t('pdu.col.time')}</th>
              <th scope="col">{t('pdu.col.num')}</th>
              <th scope="col">
                <span className="sr-only">{t('pdu.col.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {active.pdus.map((p) => (
              <tr key={p.id} data-status={p.status}>
                <td>
                  <span className={`pdu-status ${p.status}`}>
                    <span aria-hidden>{STATUS_SYMBOL[p.status]}</span> {t(`pdu.status.${p.status}`)}
                  </span>
                  {p.status === 'failed' && p.note && (
                    <div className="muted small">{translateMsg(t, { key: p.note })}</div>
                  )}
                </td>
                <td>{nameOf(p.spec.src)}</td>
                <td>{p.spec.dst}</td>
                <td>
                  {p.spec.protocol.toUpperCase()}
                  {p.spec.dport ? `:${p.spec.dport}` : ''}
                </td>
                <td>{p.spec.delaySec > 0 ? `${p.spec.delaySec} s` : '–'}</td>
                <td>
                  {p.spec.count > 1 ? `${p.okCount}/${p.spec.count}` : p.sent > 0 ? '1' : '–'}
                </td>
                <td className="nowrap">
                  <button
                    onClick={() => void rerun(p.id)}
                    aria-label={t('pdu.rerunN', { n: p.id })}
                    title={t('pdu.rerun')}
                  >
                    ↻
                  </button>{' '}
                  <button
                    onClick={() => void remove(p.id)}
                    aria-label={t('pdu.deleteN', { n: p.id })}
                    title={t('pdu.delete')}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
