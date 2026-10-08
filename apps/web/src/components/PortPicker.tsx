import { useTranslation } from 'react-i18next';
import { useStore } from '../store';

/** Popup zur Port-Auswahl an beiden Kabelenden. */
export function PortPicker() {
  const { t } = useTranslation();
  const picker = useStore((s) => s.portPicker);
  const view = useStore((s) => s.view);
  const cableStart = useStore((s) => s.cableStart);
  const pickPort = useStore((s) => s.pickPort);
  const cancel = useStore((s) => s.cancel);
  if (!picker || !view) return null;
  const dev = view.devices.find((d) => d.id === picker.deviceId);
  if (!dev) return null;
  const style = {
    left: Math.min(picker.x, window.innerWidth - 240),
    top: Math.min(picker.y, window.innerHeight - 320),
  };
  return (
    <div className="port-picker" style={style} role="dialog" aria-label={t('picker.title')}>
      <div className="picker-head">
        <strong>{dev.name}</strong>
        <span className="muted">{cableStart?.port ? t('picker.second') : t('picker.first')}</span>
        <button className="icon-btn" aria-label={t('common.cancel')} onClick={cancel}>
          ×
        </button>
      </div>
      <ul>
        {dev.ports
          .filter((p) => p.kind !== 'wifi')
          .map((p) => (
            <li key={p.id}>
              <button disabled={!!p.linkId} onClick={() => void pickPort(p.id)}>
                <span className={p.linkId ? (p.operUp ? 'dot up' : 'dot down') : 'dot free'} />
                {p.name}
                <span className="muted">{p.linkId ? t('picker.used') : t('picker.free')}</span>
              </button>
            </li>
          ))}
      </ul>
    </div>
  );
}
