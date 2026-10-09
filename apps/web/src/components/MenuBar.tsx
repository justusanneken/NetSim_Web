import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { setLang, type Lang } from '../i18n';
import { download, logToCsv } from '../format';
import { useStore } from '../store';
import { useScript } from './ScriptConsole';

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
      later('menu.open'),
      later('menu.save'),
      {
        label: t('menu.exportCsv'),
        onClick: () => download('events.csv', logToCsv(t, s.log), 'text/csv'),
        disabled: s.log.length === 0,
      },
    ],
    edit: [
      later('menu.undo'),
      later('menu.redo'),
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
    ],
    tools: [
      { label: t('menu.scriptConsole'), onClick: () => useScript.getState().setOpen(true) },
      later('menu.activities'),
    ],
    help: [{ label: t('menu.about'), onClick: () => window.alert(t('about.text')) }],
    language: (['de', 'en'] as Lang[]).map((l) => ({
      label: l === 'de' ? 'Deutsch' : 'English',
      checked: i18n.language === l,
      onClick: () => setLang(l),
    })),
  };

  return (
    <header className="menubar" ref={ref}>
      <span className="brand">NetSim Web</span>
      <nav aria-label={t('menu.aria')}>
        {Object.entries(menus).map(([id, items]) => (
          <div key={id} className="menu">
            <button
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
