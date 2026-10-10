import { create } from 'zustand';

/** Flüchtiger Oberflächenzustand der Arbeitsfläche (nicht Teil der Datei). */
export type CtxTarget =
  | { kind: 'device'; id: string }
  | { kind: 'link'; id: string }
  | { kind: 'note'; id: string }
  | { kind: 'group'; id: string }
  | { kind: 'canvas'; wx: number; wy: number };

export interface CtxMenuState {
  /** Bildschirmposition (clientX/Y). */
  x: number;
  y: number;
  target: CtxTarget;
}

interface UxState {
  /** Mehrfachauswahl (Geräte-Ids); `store.selectedDevice` bleibt das „primäre“ Gerät. */
  selectedIds: string[];
  snap: boolean;
  gridVisible: boolean;
  minimap: boolean;
  ctx: CtxMenuState | null;
  editingNote: string | null;
  selectedNote: string | null;
  netInfoOpen: boolean;
  backgroundOpen: boolean;
  setSelected(ids: string[]): void;
  toggleSelected(id: string): void;
  toggleSnap(): void;
  toggleGrid(): void;
  toggleMinimap(): void;
  openCtx(c: CtxMenuState | null): void;
  editNote(id: string | null): void;
  setSelectedNote(id: string | null): void;
  setNetInfo(open: boolean): void;
  setBackgroundOpen(open: boolean): void;
}

function pref(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    if (v === '1') return true;
    if (v === '0') return false;
  } catch {
    /* Speicher nicht verfügbar */
  }
  return fallback;
}
function savePref(key: string, v: boolean): void {
  try {
    localStorage.setItem(key, v ? '1' : '0');
  } catch {
    /* ignorieren */
  }
}

export const useUx = create<UxState>((set, get) => ({
  selectedIds: [],
  snap: pref('netsim.snap', true),
  gridVisible: pref('netsim.grid', true),
  minimap: pref('netsim.minimap', false),
  ctx: null,
  editingNote: null,
  selectedNote: null,
  netInfoOpen: false,
  backgroundOpen: false,
  setSelected(selectedIds) {
    set({ selectedIds });
  },
  toggleSelected(id) {
    const cur = get().selectedIds;
    set({ selectedIds: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
  },
  toggleSnap() {
    const v = !get().snap;
    savePref('netsim.snap', v);
    set({ snap: v });
  },
  toggleGrid() {
    const v = !get().gridVisible;
    savePref('netsim.grid', v);
    set({ gridVisible: v });
  },
  toggleMinimap() {
    const v = !get().minimap;
    savePref('netsim.minimap', v);
    set({ minimap: v });
  },
  openCtx(ctx) {
    set({ ctx });
  },
  editNote(editingNote) {
    set({ editingNote });
  },
  setSelectedNote(selectedNote) {
    set({ selectedNote });
  },
  setNetInfo(netInfoOpen) {
    set({ netInfoOpen });
  },
  setBackgroundOpen(backgroundOpen) {
    set({ backgroundOpen });
  },
}));
