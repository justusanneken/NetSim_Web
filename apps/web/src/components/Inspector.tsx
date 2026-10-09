import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import { describeFrame, encodeFrame, hexDump } from '@netsim/protocols';
import { formatTime, translateMsg } from '../format';
import type { LogEntry } from '@netsim/engine';
import { useStore } from '../store';

const OSI = [7, 6, 5, 4, 3, 2, 1];

/** PDU-Inspektor (Phase 1: Schichtenansicht des ausgewählten Ereignisses). */
export function Inspector() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'fields' | 'hex'>('fields');
  const entry = useStore((s) =>
    s.selectedLog === null ? undefined : s.log[s.selectedLog - s.logBase],
  );
  if (!entry) return <p className="muted pad">{t('inspector.none')}</p>;
  const layers = entry.frame ? describeFrame(entry.frame) : [];
  return (
    <div className="inspector">
      <div className="muted">
        {formatTime(entry.t)} · {entry.lastDeviceName ?? '–'} → {entry.atDeviceName}
        {entry.portName ? ` (${entry.portName})` : ''}
      </div>
      <p className={`explain ${entry.status}`}>{translateMsg(t, entry.msg)}</p>
      {entry.frame && (
        <div className="insp-tabs" role="group" aria-label={t('inspector.tabs')}>
          {(['fields', 'hex'] as const).map((id) => (
            <button
              key={id}
              className={tab === id ? 'active' : ''}
              aria-pressed={tab === id}
              onClick={() => setTab(id)}
            >
              {t(`inspector.tab.${id}`)}
            </button>
          ))}
        </div>
      )}
      {tab === 'hex' && entry.frame ? <HexView frame={entry.frame} /> : <FieldsView />}
    </div>
  );

  function FieldsView() {
    return (
      <>
        <table className="osi" aria-label={t('inspector.osi')}>
          <tbody>
            {OSI.map((n) => {
              const l = layers.filter((x) => x.osi === n);
              return (
                <tr key={n} className={l.length ? 'has' : ''}>
                  <th scope="row">L{n}</th>
                  <td>{l.length ? l.map((x) => x.name).join(' / ') : t(`osi.${n}`)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {layers.map((l) => (
          <details key={l.name} open>
            <summary>
              L{l.osi} · {l.name}
            </summary>
            <table className="grid">
              <tbody>
                {l.fields.map((f) => (
                  <tr key={f.name}>
                    <th scope="row">{f.name}</th>
                    <td className="mono">{f.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        ))}
      </>
    );
  }
}

function HexView({ frame }: { frame: NonNullable<LogEntry['frame']> }) {
  const { t } = useTranslation();
  const bytes = encodeFrame(frame);
  return (
    <>
      <p className="muted">{t('inspector.hexInfo', { n: bytes.length })}</p>
      <pre className="hexview mono" aria-label={t('inspector.hex')} tabIndex={0}>
        {hexDump(bytes)}
      </pre>
    </>
  );
}
