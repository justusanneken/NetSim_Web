import { create } from 'zustand';
import type { StoredFile } from './idb';

/** Zustand der Persistenz-Oberfläche (Dialoge, Undo-Zähler, Zwischenablage). Getrennt vom Haupt-Store. */
interface PersistState {
  undo: number;
  redo: number;
  fileName: string;
  templatesOpen: boolean;
  saveAsOpen: boolean;
  recents: StoredFile[];
  /** Nach unsauberem Beenden: Informationen zum gefundenen Autosave. */
  restore: { savedAt: number; name: string; devices: number } | null;
  clipboard: string[];
  pasteCount: number;
}

export const usePersist = create<PersistState>(() => ({
  undo: 0,
  redo: 0,
  fileName: '',
  templatesOpen: false,
  saveAsOpen: false,
  recents: [],
  restore: null,
  clipboard: [],
  pasteCount: 0,
}));
