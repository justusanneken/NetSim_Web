import { useTranslation } from 'react-i18next';
import type { DeviceView } from '@netsim/engine';
import { useStore } from '../store';
import { selectOnly } from '../ux/actions';
import { useUx } from '../ux/ux';

const NONE: DeviceView[] = [];

/**
 * Netzwerk-Info: alle Geräte als Liste. Zugleich die Tastatur-/Screenreader-Alternative zur
 * Arbeitsfläche: Eintrag aktivieren = Gerät anklicken (auswählen, Kabel legen, PDU senden, löschen je nach
 * Werkzeug), Kontextmenü-Taste öffnet das Kontextmenü, „Konfigurieren“ öffnet den Geräte-Dialog.
 */
export function DeviceList() {
  const { t } = useTranslation();
  const devices = useStore((s) => s.view?.devices ?? NONE);
  const selected = useStore((s) => s.selectedDevice);
  const selectedIds = useUx((s) => s.selectedIds);
  const deviceClicked = useStore((s) => s.deviceClicked);
  const openDialog = useStore((s) => s.openDialog);
  if (devices.length === 0) return <p className="muted pad">{t('netinfo.empty')}</p>;
  return (
    <ul className="device-list" aria-label={t('netinfo.title')}>
      {devices.map((d) => {
        const up = d.ports.filter((p) => p.operUp).length;
        const isSel = selected === d.id || selectedIds.includes(d.id);
        return (
          <li key={d.id} className="device-row">
            <button
              className={isSel ? 'active' : ''}
              aria-pressed={isSel}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                void deviceClicked(d.id, r.left, r.bottom);
                if (useStore.getState().tool === 'select') selectOnly(d.id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                selectOnly(d.id);
                useUx.getState().openCtx({
                  x: e.clientX || e.currentTarget.getBoundingClientRect().left,
                  y: e.clientY || e.currentTarget.getBoundingClientRect().bottom,
                  target: { kind: 'device', id: d.id },
                });
              }}
              onKeyDown={(e) => {
                if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
                  e.preventDefault();
                  const r = e.currentTarget.getBoundingClientRect();
                  selectOnly(d.id);
                  useUx
                    .getState()
                    .openCtx({ x: r.left + 20, y: r.bottom, target: { kind: 'device', id: d.id } });
                }
              }}
            >
              <span>{d.name}</span>
              <span className="muted">
                {d.ip ?? d.model} · {up}/{d.ports.filter((p) => p.linkId).length} {t('port.up')}
              </span>
            </button>
            {d.type !== 'hub' && (
              <button
                className="small"
                aria-label={`${t('ux.list.configure')}: ${d.name}`}
                onClick={() => openDialog(d.id)}
              >
                ⚙
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
