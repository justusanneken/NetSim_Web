import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../engine/client';
import { useStore } from '../store';
import {
  addNoteAt,
  alignSelected,
  deleteSelection,
  distributeSelected,
  fitView,
  groupSelected,
  selectAll,
  selection,
  ungroupSelected,
} from './actions';
import { useDoc } from './uiDoc';
import { useUx } from './ux';

interface Entry {
  label: string;
  run?: () => void | Promise<void>;
  disabled?: boolean;
  sep?: boolean;
}

/** Kontextmenü (Rechtsklick, Kontextmenü-Taste, Umschalt+F10, langer Druck auf Touch). */
export function ContextMenu() {
  const { t } = useTranslation();
  const ctx = useUx((s) => s.ctx);
  const ref = useRef<HTMLUListElement>(null);
  const close = () => useUx.getState().openCtx(null);

  useEffect(() => {
    if (!ctx) return;
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('button:not([disabled])')?.focus();
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
      if (
        previous &&
        document.contains(previous) &&
        !document.activeElement?.closest('[role=dialog]')
      )
        previous.focus({ preventScroll: true });
    };
  }, [ctx]);

  if (!ctx) return null;
  const sel = selection();
  const multi = sel.length > 1;
  const items: Entry[] = [];
  const tg = ctx.target;
  if (tg.kind === 'device') {
    const dev = useStore.getState().view?.devices.find((d) => d.id === tg.id);
    if (dev) {
      items.push(
        {
          label: t('ux.ctx.open'),
          run: () => useStore.getState().openDialog(tg.id),
          disabled: dev.type === 'hub',
        },
        {
          label: t('ux.ctx.attributes'),
          run: () => useStore.getState().openDialog(tg.id, 'attributes'),
          disabled: dev.type === 'hub',
        },
        {
          label: dev.powered ? t('ux.ctx.powerOff') : t('ux.ctx.powerOn'),
          run: () => void api.setPower(dev.id, !dev.powered),
        },
      );
    }
    if (multi) items.push({ sep: true, label: '' }, ...arrangeEntries(t));
    items.push(
      { sep: true, label: '' },
      {
        label: multi ? t('ux.ctx.deleteMany', { n: sel.length }) : t('ux.ctx.delete'),
        run: deleteSelection,
      },
    );
  } else if (tg.kind === 'link') {
    items.push({
      label: t('ux.ctx.deleteCable'),
      run: async () => {
        await api.disconnect(tg.id);
        useStore.getState().selectLink(null);
      },
    });
  } else if (tg.kind === 'note') {
    items.push(
      { label: t('ux.ctx.editNote'), run: () => useUx.getState().editNote(tg.id) },
      { label: t('ux.ctx.deleteNote'), run: () => useDoc.getState().removeNote(tg.id) },
    );
  } else if (tg.kind === 'group') {
    items.push(
      {
        label: t('ux.ctx.renameGroup'),
        run: () => {
          const g = useDoc.getState().groups.find((x) => x.id === tg.id);
          const name = window.prompt(t('ux.group.namePrompt'), g?.name ?? '');
          if (name?.trim()) useDoc.getState().renameGroup(tg.id, name.trim());
        },
      },
      { label: t('ux.ctx.ungroup'), run: () => useDoc.getState().ungroup(tg.id) },
    );
  } else {
    items.push(
      { label: t('ux.ctx.addNote'), run: () => void addNoteAt(tg.wx, tg.wy) },
      { label: t('ux.ctx.selectAll'), run: selectAll },
      { label: t('ux.ctx.fit'), run: fitView },
    );
    if (multi) items.push({ sep: true, label: '' }, ...arrangeEntries(t));
  }

  const onKey = (e: React.KeyboardEvent) => {
    const btns = [
      ...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? []),
    ];
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      btns[(i + 1) % btns.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      btns[(i - 1 + btns.length) % btns.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      btns[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      btns[btns.length - 1]?.focus();
    } else if (e.key === 'Tab') {
      close();
    }
  };

  const style = {
    left: Math.min(ctx.x, window.innerWidth - 240),
    top: Math.min(ctx.y, window.innerHeight - 40 - items.length * 30),
  };
  return (
    <ul
      ref={ref}
      className="ctx-menu"
      role="menu"
      aria-label={t('ux.ctx.title')}
      style={style}
      onKeyDown={onKey}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) =>
        it.sep ? (
          <li key={i} role="separator" className="ctx-sep" />
        ) : (
          <li key={i} role="none">
            <button
              role="menuitem"
              disabled={it.disabled}
              onClick={() => {
                close();
                void it.run?.();
              }}
            >
              {it.label}
            </button>
          </li>
        ),
      )}
    </ul>
  );
}

function arrangeEntries(t: (k: string) => string): Entry[] {
  return [
    { label: t('ux.arrange.group'), run: () => void groupSelected() },
    { label: t('ux.arrange.ungroup'), run: ungroupSelected },
    { label: t('ux.arrange.left'), run: () => alignSelected('left') },
    { label: t('ux.arrange.hcenter'), run: () => alignSelected('hcenter') },
    { label: t('ux.arrange.right'), run: () => alignSelected('right') },
    { label: t('ux.arrange.top'), run: () => alignSelected('top') },
    { label: t('ux.arrange.vcenter'), run: () => alignSelected('vcenter') },
    { label: t('ux.arrange.bottom'), run: () => alignSelected('bottom') },
    { label: t('ux.arrange.distH'), run: () => distributeSelected('horizontal') },
    { label: t('ux.arrange.distV'), run: () => distributeSelected('vertical') },
  ];
}
