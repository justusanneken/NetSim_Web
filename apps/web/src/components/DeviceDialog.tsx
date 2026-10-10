import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { DeviceConfig, HostIpConfig } from './DevicePanel';
import { HostIpv6 } from './PanelRouting';
import { Browser } from './PanelServices';
import { TerminalView } from './TerminalView';
import { useStore } from '../store';
import { hasCli, isEndDevice } from '../deviceKinds';
import { PhysicalTab } from './PanelPhysical';
import {
  HostFiles,
  HostFirewall,
  HostTime,
  IotMonitor,
  MailClient,
  MibBrowser,
} from './PanelServices5';
import { WifiClient } from './PanelWireless';
import { ProgramTab } from './PanelProgram';
import { AttributesTab } from '../ux/AttributesTab';
import { useFocusTrap } from '../ux/useFocusTrap';

/** Geräte-Dialog mit Tabs: Config, CLI (Router/Switch), Desktop (Hosts). */
export function DeviceDialog() {
  const { t } = useTranslation();
  const dialog = useStore((s) => s.dialog);
  const dev = useStore((s) => s.view?.devices.find((d) => d.id === s.dialog?.deviceId));
  const setTab = useStore((s) => s.setDialogTab);
  const close = useStore((s) => s.closeDialog);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, !!dialog);

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
  const end = isEndDevice(dev);
  const tabs = end
    ? ['desktop', 'config', ...(dev.p5?.iot ? ['program'] : []), 'physical', 'attributes']
    : hasCli(dev)
      ? ['config', 'cli', 'physical', 'attributes']
      : ['config', 'physical', 'attributes'];
  const apps: { id: string; label: string }[] = [
    { id: 'ip', label: 'desktop.ip' },
    { id: 'cmd', label: 'desktop.cmd' },
    { id: 'browser', label: 'desktop.browser' },
    ...(dev.p5?.wifi ? [{ id: 'wifi', label: 'desktop.wifi' }] : []),
    { id: 'mail', label: 'desktop.mail' },
    { id: 'mib', label: 'desktop.mib' },
    { id: 'iot', label: 'desktop.iot' },
    { id: 'files', label: 'desktop.files' },
    { id: 'firewall', label: 'desktop.firewall' },
  ];
  const tab = tabs.includes(dialog.tab) ? dialog.tab : (tabs[0] as string);
  const sub = dialog.tab.startsWith('desktop:') ? dialog.tab.slice(8) : 'ip';

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={dialogRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={dev.name}
        tabIndex={-1}
      >
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
          {!dev.powered && tab !== 'config' && tab !== 'physical' && tab !== 'attributes' ? (
            <p className="warn pad">{t('dev.off')}</p>
          ) : tab === 'config' ? (
            <div className="scroll">
              <DeviceConfig dev={dev} />
            </div>
          ) : tab === 'attributes' ? (
            <AttributesTab dev={dev} />
          ) : tab === 'physical' ? (
            <PhysicalTab dev={dev} />
          ) : tab === 'program' ? (
            <ProgramTab dev={dev} />
          ) : tab === 'cli' ? (
            <TerminalView key={dev.id} deviceId={dev.id} label={t('dialog.tab.cli')} />
          ) : (
            <div className="desktop">
              <div className="desktop-apps" role="toolbar" aria-label={t('desktop.apps')}>
                {apps.map((a) => (
                  <button
                    key={a.id}
                    className={sub === a.id ? 'active' : ''}
                    onClick={() => setTab(`desktop:${a.id}`)}
                  >
                    {t(a.label)}
                  </button>
                ))}
              </div>
              {sub === 'browser' ? (
                <Browser dev={dev} />
              ) : sub === 'wifi' ? (
                <WifiClient dev={dev} />
              ) : sub === 'mail' ? (
                <MailClient dev={dev} />
              ) : sub === 'mib' ? (
                <MibBrowser dev={dev} />
              ) : sub === 'iot' ? (
                <IotMonitor dev={dev} />
              ) : sub === 'files' ? (
                <HostFiles dev={dev} />
              ) : sub === 'firewall' ? (
                <HostFirewall dev={dev} />
              ) : sub === 'cmd' ? (
                <TerminalView key={dev.id} deviceId={dev.id} label={t('desktop.cmd')} />
              ) : (
                <div className="scroll pad">
                  <HostIpConfig dev={dev} />
                  <HostIpv6 dev={dev} />
                  <HostTime dev={dev} />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
