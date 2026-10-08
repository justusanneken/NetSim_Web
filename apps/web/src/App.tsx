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
import { PortPicker } from './components/PortPicker';
import { SimPanel } from './components/SimPanel';
import { Toolbar } from './components/Toolbar';
import { sim, useStore } from './store';
import { translateMsg } from './format';

function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing =
        el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA');
      if (typing) return;
      const s = useStore.getState();
      if (e.key === 'Escape') s.cancel();
      else if (e.key === 'Delete' || e.key === 'Backspace') void s.deleteSelected();
      else if (e.key === ' ' && el?.tagName !== 'BUTTON') {
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
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.colorblind = colorblind ? '1' : '0';
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
