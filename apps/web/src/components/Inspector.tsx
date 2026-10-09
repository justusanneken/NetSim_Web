import { useTranslation } from 'react-i18next';
import { describeFrame } from '@netsim/protocols';
import { formatTime, translateMsg } from '../format';
import { useStore } from '../store';

const OSI = [7, 6, 5, 4, 3, 2, 1];

/** PDU-Inspektor (Phase 1: Schichtenansicht des ausgewählten Ereignisses). */
export function Inspector() {
  const { t } = useTranslation();
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
    </div>
  );
}
