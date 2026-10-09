import { useEffect, useRef, type KeyboardEvent, type RefObject } from 'react';

/**
 * Tastaturbedienung der Menüleiste (WAI-ARIA Menubar): Pfeil runter öffnet, Pfeile wechseln Einträge
 * bzw. Menüs, Home/End, Esc schließt und gibt den Fokus an den Menütitel zurück, Tab schließt.
 */
export function useMenuKeys(
  ref: RefObject<HTMLElement>,
  open: string | null,
  setOpen: (id: string | null) => void,
): (e: KeyboardEvent) => void {
  const focusFirst = useRef(false);
  const lastOpen = useRef<string | null>(null);

  // Nach Auswahl eines Eintrags (Menü schließt, Fokus wäre verloren) zurück an den Menütitel
  useEffect(() => {
    if (open) {
      lastOpen.current = open;
      return;
    }
    const id = lastOpen.current;
    lastOpen.current = null;
    if (id && (!document.activeElement || document.activeElement === document.body))
      ref.current?.querySelector<HTMLElement>(`button[data-menu="${id}"]`)?.focus();
  }, [open, ref]);

  useEffect(() => {
    if (open && focusFirst.current) {
      focusFirst.current = false;
      ref.current
        ?.querySelector<HTMLElement>('.dropdown [role^="menuitem"]:not([disabled])')
        ?.focus();
    }
  }, [open, ref]);

  return (e) => {
    const root = ref.current;
    if (!root) return;
    const triggers = [...root.querySelectorAll<HTMLButtonElement>('button[data-menu]')];
    const items = [
      ...root.querySelectorAll<HTMLButtonElement>('.dropdown [role^="menuitem"]:not([disabled])'),
    ];
    const active = document.activeElement as HTMLElement | null;
    const onTrigger = active?.hasAttribute('data-menu') ?? false;
    const idx = onTrigger
      ? triggers.indexOf(active as HTMLButtonElement)
      : items.indexOf(active as HTMLButtonElement);
    const go = (delta: number) => {
      const t =
        triggers[
          (triggers.indexOf(active as HTMLButtonElement) + delta + triggers.length) %
            triggers.length
        ];
      if (!t) return;
      focusFirst.current = true;
      setOpen(t.dataset.menu ?? null);
      t.focus();
    };
    const currentTrigger = (): HTMLButtonElement | undefined =>
      triggers.find((t) => t.dataset.menu === open);

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (onTrigger) {
          focusFirst.current = true;
          const id = (active as HTMLElement).dataset.menu ?? null;
          if (open === id) {
            focusFirst.current = false;
            items[0]?.focus();
          } else setOpen(id);
        } else items[(idx + 1) % items.length]?.focus();
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (!onTrigger) items[(idx - 1 + items.length) % items.length]?.focus();
        break;
      case 'Home':
        if (!onTrigger && items.length) {
          e.preventDefault();
          items[0]?.focus();
        }
        break;
      case 'End':
        if (!onTrigger && items.length) {
          e.preventDefault();
          items[items.length - 1]?.focus();
        }
        break;
      case 'ArrowRight':
      case 'ArrowLeft': {
        const delta = e.key === 'ArrowRight' ? 1 : -1;
        if (onTrigger) {
          e.preventDefault();
          const t = triggers[(idx + delta + triggers.length) % triggers.length];
          if (open) go(delta);
          else t?.focus();
        } else if (open) {
          e.preventDefault();
          const cur = currentTrigger();
          if (cur) {
            const i = triggers.indexOf(cur);
            const t = triggers[(i + delta + triggers.length) % triggers.length];
            focusFirst.current = true;
            setOpen(t?.dataset.menu ?? null);
          }
        }
        break;
      }
      case 'Escape':
        if (open) {
          e.preventDefault();
          e.stopPropagation();
          const cur = currentTrigger();
          setOpen(null);
          cur?.focus();
        }
        break;
      case 'Tab':
        if (open) setOpen(null);
        break;
      default:
    }
  };
}
