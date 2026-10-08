import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { DeviceView } from '@netsim/engine';
import { DeviceConfig, HostIpConfig } from './DevicePanel';
import { TerminalView } from './TerminalView';
import { useStore } from '../store';

const isHost = (d: DeviceView): boolean =>
  d.type === 'pc' || d.type === 'laptop' || d.type === 'server';

/** Geräte-Dialog mit Tabs: Config, CLI (Router/Switch), Desktop (Hosts). */
export function DeviceDialog() {
  const { t } = useTranslation();
  const dialog = useStore((s) => s.dialog);
  const dev = useStore((s) => s.view?.devices.find((d) => d.id === s.dialog?.deviceId));
  const setTab = useStore((s) => s.setDialogTab);
  const close = useStore((s) => s.closeDialog);

  useEffect(() => {
    if (!dialog) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog, close]);

  useEffect(() => {
    if (dialog && !dev) close();
  }, [dialog, dev, close]);

  if (!dialog || !dev) return null;
  const tabs = isHost(dev) ? ['desktop', 'config'] : ['config', 'cli'];
  const tab = tabs.includes(dialog.tab) ? dialog.tab : (tabs[0] as string);
  const sub = dialog.tab.startsWith('desktop:') ? dialog.tab.slice(8) : 'ip';

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={dev.name}>
        <div className="dialog-head">
          <strong>{dev.name}</strong>
          <span className="muted">{dev.model}</span>
          <div className="tabs" role="tablist">
            {tabs.map((id) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                className={tab === id ? 'active' : ''}
                onClick={() => setTab(id)}
              >
                {t(`dialog.tab.${id}`)}
              </button>
            ))}
          </div>
          <button className="icon-btn" aria-label={t('common.close')} onClick={close}>
            ×
          </button>
        </div>
        <div className="dialog-body">
          {!dev.powered && tab !== 'config' ? (
            <p className="warn pad">{t('dev.off')}</p>
          ) : tab === 'config' ? (
            <div className="scroll">
              <DeviceConfig dev={dev} />
            </div>
          ) : tab === 'cli' ? (
            <TerminalView key={dev.id} deviceId={dev.id} label={t('dialog.tab.cli')} />
          ) : (
            <div className="desktop">
              <div className="desktop-apps">
                <button
                  className={sub === 'ip' ? 'active' : ''}
                  onClick={() => setTab('desktop:ip')}
                >
                  {t('desktop.ip')}
                </button>
                <button
                  className={sub === 'cmd' ? 'active' : ''}
                  onClick={() => setTab('desktop:cmd')}
                >
                  {t('desktop.cmd')}
                </button>
              </div>
              {sub === 'cmd' ? (
                <TerminalView key={dev.id} deviceId={dev.id} label={t('desktop.cmd')} />
              ) : (
                <div className="scroll pad">
                  <HostIpConfig dev={dev} />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
