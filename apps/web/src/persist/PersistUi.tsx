import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../engine/client';
import {
  copySelection,
  discardAutosave,
  fileOpen,
  fileSave,
  loadTemplate,
  pasteClipboard,
  redo,
  restoreAutosave,
  undo,
  writeFile,
} from './actions';
import { usePersist } from './state';

type TemplateRow = Awaited<ReturnType<typeof api.listTemplates>>[number];

function useEscape(onClose: () => void): void {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [onClose]);
}

function Modal(props: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
  labelledBy: string;
}) {
  useEscape(props.onClose);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>('input, button, [tabindex]');
    el?.focus();
  }, []);
  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}
    >
      <div
        className={`dialog persist-dialog${props.wide ? ' wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={props.labelledBy}
        ref={ref}
      >
        <div className="dialog-head">
          <strong id={props.labelledBy}>{props.title}</strong>
        </div>
        {props.children}
      </div>
    </div>
  );
}

export function TemplateDialog() {
  const { t, i18n } = useTranslation();
  const open = usePersist((s) => s.templatesOpen);
  const [list, setList] = useState<TemplateRow[]>([]);
  const [sel, setSel] = useState(0);
  useEffect(() => {
    if (open) void api.listTemplates().then(setList);
  }, [open]);
  if (!open) return null;
  const lang = i18n.language === 'en' ? 'en' : 'de';
  const close = () => usePersist.setState({ templatesOpen: false });
  const cur = list[sel];
  return (
    <Modal title={t('persist.templates.title')} onClose={close} wide labelledBy="tpl-title">
      <div className="persist-tpl">
        <ul className="persist-tpl-list" aria-label={t('persist.templates.list')}>
          {list.map((x, i) => (
            <li key={x.id}>
              <button
                className={i === sel ? 'active' : ''}
                aria-pressed={i === sel}
                data-testid={`tpl-${x.id}`}
                onClick={() => setSel(i)}
              >
                {x.title[lang]}
                <span className={`lvl lvl-${x.level}`}>{t(`persist.level.${x.level}`)}</span>
              </button>
            </li>
          ))}
        </ul>
        {cur && (
          <section className="persist-tpl-detail" aria-live="polite">
            <h3>{cur.title[lang]}</h3>
            <p>{cur.summary[lang]}</p>
            <h4>{t('persist.templates.goals')}</h4>
            <ul>
              {cur.goals[lang].map((g) => (
                <li key={g}>{g}</li>
              ))}
            </ul>
            <div className="persist-actions">
              <button
                className="primary"
                aria-label={t('persist.templates.loadAria', { title: cur.title[lang] })}
                onClick={() => void loadTemplate(cur.id)}
              >
                {t('persist.templates.load')}
              </button>
              <button onClick={close}>{t('persist.cancel')}</button>
            </div>
            <p className="muted">{t('persist.templates.undoHint')}</p>
          </section>
        )}
      </div>
    </Modal>
  );
}

export function SaveAsDialog() {
  const { t } = useTranslation();
  const open = usePersist((s) => s.saveAsOpen);
  const current = usePersist((s) => s.fileName);
  const [name, setName] = useState('');
  useEffect(() => {
    if (open) setName(current || 'netsim');
  }, [open, current]);
  if (!open) return null;
  const close = () => usePersist.setState({ saveAsOpen: false });
  return (
    <Modal title={t('persist.saveAs.title')} onClose={close} labelledBy="saveas-title">
      <form
        className="persist-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void writeFile(name);
        }}
      >
        <label>
          {t('persist.saveAs.name')}
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          <span className="muted">.nsim</span>
        </label>
        <div className="persist-actions">
          <button className="primary" type="submit" disabled={!name.trim()}>
            {t('menu.save')}
          </button>
          <button type="button" onClick={close}>
            {t('persist.cancel')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function RestoreDialog() {
  const { t, i18n } = useTranslation();
  const r = usePersist((s) => s.restore);
  if (!r) return null;
  const when = new Date(r.savedAt).toLocaleString(i18n.language);
  return (
    <Modal title={t('persist.restore.title')} onClose={() => undefined} labelledBy="restore-title">
      <div className="persist-form">
        <p>{t('persist.restore.text', { when, devices: r.devices })}</p>
        <div className="persist-actions">
          <button className="primary" onClick={() => void restoreAutosave()}>
            {t('persist.restore.yes')}
          </button>
          <button onClick={() => void discardAutosave()}>{t('persist.restore.no')}</button>
        </div>
      </div>
    </Modal>
  );
}

function editable(el: EventTarget | null): boolean {
  const e = el as HTMLElement | null;
  return (
    !!e &&
    (e.tagName === 'INPUT' ||
      e.tagName === 'SELECT' ||
      e.tagName === 'TEXTAREA' ||
      e.isContentEditable)
  );
}

/** Strg+S / Strg+O / Strg+Z / Strg+Y / Strg+C / Strg+V (nicht beim Tippen in Eingabefeldern oder Terminals). */
export function usePersistShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 's') {
        e.preventDefault();
        void fileSave(e.shiftKey);
        return;
      }
      if (k === 'o') {
        e.preventDefault();
        fileOpen();
        return;
      }
      if (editable(e.target) || document.querySelector('.dialog-backdrop')) return;
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        void undo();
      } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
        e.preventDefault();
        void redo();
      } else if (k === 'c') {
        copySelection();
      } else if (k === 'v') {
        void pasteClipboard();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export function PersistUi() {
  usePersistShortcuts();
  return (
    <>
      <TemplateDialog />
      <SaveAsDialog />
      <RestoreDialog />
    </>
  );
}
