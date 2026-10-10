import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { setLang, type Lang } from '../i18n';
import { download, logToCsv } from '../format';
import { useStore } from '../store';
import {
  copySelection,
  fileOpen,
  fileSave,
  openBytes,
  pasteClipboard,
  redo,
  undo,
} from '../persist/actions';
import { usePersist } from '../persist/state';
import {
  alignSelected,
  distributeSelected,
  fitView,
  groupSelected,
  selectAll,
  ungroupSelected,
} from '../ux/actions';
import { useUx } from '../ux/ux';
import { useMenuKeys } from '../ux/useMenuKeys';

interface Item {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  checked?: boolean;
}

export function MenuBar() {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const s = useStore();
  const ps = usePersist();
  const ux = useUx();
  const menuKeys = useMenuKeys(ref, open, setOpen);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(null);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const later = (key: string): Item => ({
    label: `${t(key)} (${t('menu.later')})`,
    disabled: true,
  });
  const zoom = (f: number) =>
    s.setStageView({ ...s.stageView, scale: Math.min(3, Math.max(0.25, s.stageView.scale * f)) });

  const menus: Record<string, Item[]> = {
    file: [
      { label: t('menu.new'), onClick: () => void s.newTopology() },
      { label: `${t('menu.open')} (Ctrl+O)`, onClick: fileOpen },
      { label: `${t('menu.save')} (Ctrl+S)`, onClick: () => void fileSave() },
      { label: `${t('menu.saveAs')} (Ctrl+Shift+S)`, onClick: () => void fileSave(true) },
      { label: t('menu.templates'), onClick: () => usePersist.setState({ templatesOpen: true }) },
      ...ps.recents.map((r) => ({
        label: `${t('menu.recent')}: ${r.name}`,
        onClick: () => void openBytes(r.bytes, r.name),
      })),
      {
        label: t('menu.exportCsv'),
        onClick: () => download('events.csv', logToCsv(t, s.log), 'text/csv'),
        disabled: s.log.length === 0,
      },
    ],
    edit: [
      { label: `${t('menu.undo')} (Ctrl+Z)`, onClick: () => void undo(), disabled: ps.undo === 0 },
      { label: `${t('menu.redo')} (Ctrl+Y)`, onClick: () => void redo(), disabled: ps.redo === 0 },
      {
        label: `${t('menu.copy')} (Ctrl+C)`,
        onClick: copySelection,
        disabled: !s.selectedDevice,
      },
      {
        label: `${t('menu.paste')} (Ctrl+V)`,
        onClick: () => void pasteClipboard(),
        disabled: ps.clipboard.length === 0,
      },
      {
        label: t('menu.delete'),
        onClick: () => void s.deleteSelected(),
        disabled: !s.selectedDevice && !s.selectedLink,
      },
    ],
    options: [
      { label: t('menu.portLabels'), checked: s.showPortLabels, onClick: s.togglePortLabels },
      { label: t('menu.colorblind'), checked: s.colorblind, onClick: s.toggleColorblind },
      {
        label: t('menu.dark'),
        checked: s.theme === 'dark',
        onClick: () => s.setTheme(s.theme === 'dark' ? 'light' : 'dark'),
      },
    ],
    view: [
      { label: t('view.zoomIn'), onClick: () => zoom(1.2) },
      { label: t('view.zoomOut'), onClick: () => zoom(1 / 1.2) },
      { label: t('view.zoomReset'), onClick: () => s.setStageView({ x: 0, y: 0, scale: 1 }) },
      {
        label: t('menu.logical'),
        checked: s.viewMode === 'logical',
        onClick: () => s.setViewMode('logical'),
      },
      {
        label: t('menu.physical'),
        checked: s.viewMode === 'physical',
        onClick: () => s.setViewMode('physical'),
      },
      { label: t('ux.fit'), onClick: fitView },
      { label: t('ux.minimap'), checked: ux.minimap, onClick: ux.toggleMinimap },
      { label: t('ux.grid'), checked: ux.gridVisible, onClick: ux.toggleGrid },
      { label: t('ux.snap'), checked: ux.snap, onClick: ux.toggleSnap },
      { label: t('ux.bg.menu'), onClick: () => ux.setBackgroundOpen(true) },
      { label: t('netinfo.window'), onClick: () => ux.setNetInfo(true) },
    ],
    arrange: [
      { label: t('ux.ctx.selectAll'), onClick: selectAll },
      { label: t('ux.arrange.group'), onClick: () => void groupSelected() },
      { label: t('ux.arrange.ungroup'), onClick: ungroupSelected },
      { label: t('ux.arrange.left'), onClick: () => void alignSelected('left') },
      { label: t('ux.arrange.hcenter'), onClick: () => void alignSelected('hcenter') },
      { label: t('ux.arrange.right'), onClick: () => void alignSelected('right') },
      { label: t('ux.arrange.top'), onClick: () => void alignSelected('top') },
      { label: t('ux.arrange.vcenter'), onClick: () => void alignSelected('vcenter') },
      { label: t('ux.arrange.bottom'), onClick: () => void alignSelected('bottom') },
      { label: t('ux.arrange.distH'), onClick: () => void distributeSelected('horizontal') },
      { label: t('ux.arrange.distV'), onClick: () => void distributeSelected('vertical') },
    ],
    tools: [later('menu.scripting'), later('menu.activities')],
    help: [{ label: t('menu.about'), onClick: () => window.alert(t('about.text')) }],
    language: (['de', 'en'] as Lang[]).map((l) => ({
      label: l === 'de' ? 'Deutsch' : 'English',
      checked: i18n.language === l,
      onClick: () => setLang(l),
    })),
  };

  return (
    <header className="menubar" ref={ref} onKeyDown={menuKeys}>
      <span className="brand">NetSim Web</span>
      <nav aria-label={t('menu.aria')}>
        {Object.entries(menus).map(([id, items]) => (
          <div key={id} className="menu">
            <button
              data-menu={id}
              aria-haspopup="menu"
              aria-expanded={open === id}
              className={open === id ? 'active' : ''}
              onClick={() => setOpen(open === id ? null : id)}
              onMouseEnter={() => open && setOpen(id)}
            >
              {t(`menu.${id}`)}
            </button>
            {open === id && (
              <ul className="dropdown" role="menu">
                {items.map((it, i) => (
                  <li key={i} role="none">
                    <button
                      role={it.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
                      aria-checked={it.checked}
                      disabled={it.disabled}
                      onClick={() => {
                        it.onClick?.();
                        setOpen(null);
                      }}
                    >
                      <span className="check" aria-hidden>
                        {it.checked ? '✓' : ''}
                      </span>
                      {it.label}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </nav>
    </header>
  );
}
