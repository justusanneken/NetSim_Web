import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Canvas } from './components/Canvas';
import { DeviceDialog } from './components/DeviceDialog';
import { DeviceList } from './components/DeviceList';
import { DevicePanel } from './components/DevicePanel';
import { Inspector } from './components/Inspector';
import { MenuBar } from './components/MenuBar';
import { Palette } from './components/Palette';
import { PhysicalView } from './components/PanelPhysical';
import { applyTheme } from './theme';
import { PortPicker } from './components/PortPicker';
import { ScriptConsole } from './components/ScriptConsole';
import { SimPanel } from './components/SimPanel';
import { Toolbar } from './components/Toolbar';
import { sim, useStore } from './store';
import { translateMsg } from './format';
import { deleteSelection, selectAll } from './ux/actions';
import { BackgroundDialog } from './ux/BackgroundDialog';
import { ContextMenu } from './ux/ContextMenu';
import { NetworkInfo } from './ux/NetworkInfo';
import { NotesPanel } from './ux/NotesPanel';
import { startUxSync } from './ux/sync';
import { useUx } from './ux/ux';

startUxSync();

function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing =
        el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA');
      if (typing) return;
      const s = useStore.getState();
      if (e.key === 'Escape') s.cancel();
      else if (e.key === 'Delete' || e.key === 'Backspace') void deleteSelection();
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        selectAll();
      } else if (e.key === ' ' && el?.tagName !== 'BUTTON') {
        e.preventDefault();
        const m = s.view?.mode;
        const running = m === 'realtime' || (m === 'simulation' && s.view?.autoCapture);
        void (running ? sim.pause() : sim.play());
      } else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        const map: Record<string, Parameters<typeof s.setTool>[0]> = {
          v: 'select',
          h: 'hand',
          c: 'cable',
          p: 'pdu',
          x: 'delete',
          n: 'note',
        };
        const tool = map[e.key.toLowerCase()];
        if (tool) s.setTool(tool);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export function App() {
  const { t } = useTranslation();
  const theme = useStore((s) => s.theme);
  const colorblind = useStore((s) => s.colorblind);
  const toast = useStore((s) => s.toast);
  const connected = useStore((s) => s.view !== null);
  const viewMode = useStore((s) => s.viewMode);
  useShortcuts();

  useEffect(() => {
    applyTheme(theme, colorblind);
  }, [theme, colorblind]);

  return (
    <div className="app">
      <MenuBar />
      <Toolbar />
      <main className="canvas-area">
        {!connected ? (
          <p className="pad">{t('common.loading')}</p>
        ) : viewMode === 'physical' ? (
          <PhysicalView />
        ) : (
          <Canvas />
        )}
        <PortPicker />
        <DeviceDialog />
        <ScriptConsole />
        <ContextMenu />
        <NetworkInfo />
        <BackgroundDialog />
        {toast && (
          <div className={`toast ${toast.kind}`} role="alert">
            {translateMsg(t, toast)}
          </div>
        )}
      </main>
      <aside className="sidebar" aria-label={t('sidebar.title')}>
        <details open>
          <summary>{t('netinfo.title')}</summary>
          <DeviceList />
          <div className="pad">
            <button onClick={() => useUx.getState().setNetInfo(true)}>{t('netinfo.open')}</button>
          </div>
        </details>
        <details>
          <summary>{t('ux.notes.title')}</summary>
          <NotesPanel />
        </details>
        <details open>
          <summary>{t('panel.title')}</summary>
          <DevicePanel />
        </details>
        <details open>
          <summary>{t('inspector.title')}</summary>
          <Inspector />
        </details>
      </aside>
      <div className="bottom">
        <Palette />
        <SimPanel />
      </div>
    </div>
  );
}
