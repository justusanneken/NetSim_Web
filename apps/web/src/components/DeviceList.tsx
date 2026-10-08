import { useTranslation } from 'react-i18next';
import type { DeviceView } from '@netsim/engine';
import { useStore } from '../store';

const NONE: DeviceView[] = [];

/** Netzwerk-Info: alle Geräte als Liste (auch Tastatur-Alternative zur Arbeitsfläche). */
export function DeviceList() {
  const { t } = useTranslation();
  const devices = useStore((s) => s.view?.devices ?? NONE);
  const selected = useStore((s) => s.selectedDevice);
  const select = useStore((s) => s.selectDevice);
  if (devices.length === 0) return <p className="muted pad">{t('netinfo.empty')}</p>;
  return (
    <ul className="device-list" aria-label={t('netinfo.title')}>
      {devices.map((d) => {
        const up = d.ports.filter((p) => p.operUp).length;
        return (
          <li key={d.id}>
            <button className={selected === d.id ? 'active' : ''} onClick={() => select(d.id)}>
              <span>{d.name}</span>
              <span className="muted">
                {d.ip ?? d.model} · {up}/{d.ports.filter((p) => p.linkId).length} {t('port.up')}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
